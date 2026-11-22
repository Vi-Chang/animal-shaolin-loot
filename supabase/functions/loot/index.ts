// 動物少林寺 戰利品分配 — 後端 Edge Function
// 直連 Postgres（service role 等級），只碰 loot schema；不經 PostgREST，不動商業 API 設定。
// 讀取(state)與成員許願(wishes)公開；其餘寫入與 OCR 需委託人密碼（存於 loot.app_kv 'secret'）。
import postgres from "npm:postgres@3.4.5";

const DB = Deno.env.get("SUPABASE_DB_URL")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const OCR_MODEL = Deno.env.get("OCR_MODEL") ?? "claude-sonnet-5-5";

const sql = postgres(DB, { prepare: false, ssl: "require", idle_timeout: 20, max: 4 });

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

async function auth(body: any): Promise<boolean> {
  const r = await sql`select v from loot.app_kv where k='secret'`;
  const s: any = (r[0]?.v) || {};
  return !!s.pass && body.pass === s.pass;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
  const a = body?.action;

  try {
    if (a === "state") {
      const [members, kv, rounds, wishes, allocs] = await Promise.all([
        sql`select name,role,status from loot.members order by ord`,
        sql`select v from loot.app_kv where k='config'`,
        sql`select id,name,date,status,loot,contributions,activities,activity_list from loot.rounds`,
        sql`select id,round_id,member,item from loot.wishes order by id`,
        sql`select id,round_id,member,item,qty from loot.allocations order by id`,
      ]);
      const roundsMap: Record<string, unknown> = {};
      for (const r of rounds) roundsMap[r.id] = {
        name: r.name, date: r.date, status: r.status,
        loot: r.loot, contributions: r.contributions, activities: r.activities, activityList: r.activity_list,
      };
      return json({
        roster: members.map((m) => ({ name: m.name, role: m.role, status: m.status })),
        config: kv[0]?.v ?? { activeRoundId: null },
        rounds: roundsMap,
        wishes: wishes.map((w) => ({ id: String(w.id), roundId: w.round_id, member: w.member, item: w.item })),
        allocs: allocs.map((a) => ({ id: String(a.id), roundId: a.round_id, member: a.member, item: a.item, qty: a.qty })),
      });
    }

    if (a === "checkPass") return json({ ok: await auth(body) });

    if (a === "addDoc") {
      const { coll, data } = body;
      if (coll === "wishes") {
        await sql`insert into loot.wishes(round_id,member,item) values(${data.roundId},${data.member},${data.item})`;
        return json({ ok: true });
      }
      if (!(await auth(body))) return json({ error: "unauthorized" }, 401);
      if (coll === "allocations") {
        await sql`insert into loot.allocations(round_id,member,item,qty) values(${data.roundId},${data.member},${data.item},${data.qty || 1})`;
        return json({ ok: true });
      }
      return json({ error: "bad_coll" }, 400);
    }

    if (a === "delDoc") {
      const parts = String(body.path || "").split("/");
      const coll = parts[0], id = parts[1];
      if (coll === "wishes") { await sql`delete from loot.wishes where id=${id}`; return json({ ok: true }); }
      if (!(await auth(body))) return json({ error: "unauthorized" }, 401);
      if (coll === "allocations") { await sql`delete from loot.allocations where id=${id}`; return json({ ok: true }); }
      return json({ error: "bad_path" }, 400);
    }

    if (a === "setDoc") {
      if (!(await auth(body))) return json({ error: "unauthorized" }, 401);
      const { path, data } = body;
      if (path === "app/roster") {
        const members = data.members || [];
        await sql.begin(async (tx) => {
          for (let i = 0; i < members.length; i++) {
            const m = members[i];
            await tx`insert into loot.members(name,role,status,ord) values(${m.name},${m.role || "普通成員"},${m.status || "正常"},${i + 1})
                     on conflict(name) do update set role=excluded.role,status=excluded.status,ord=excluded.ord`;
          }
        });
        return json({ ok: true });
      }
      if (path === "app/config") {
        await sql`insert into loot.app_kv(k,v) values('config',${sql.json(data)}) on conflict(k) do update set v=excluded.v`;
        return json({ ok: true });
      }
      const p = String(path).split("/");
      if (p[0] === "rounds") {
        const id = p[1]; const r = data;
        await sql`insert into loot.rounds(id,name,date,status,loot,contributions,activities,activity_list)
          values(${id},${r.name || ""},${r.date ?? null},${r.status || "進行中"},${sql.json(r.loot ?? [])},${sql.json(r.contributions ?? {})},${sql.json(r.activities ?? {})},${sql.json(r.activityList ?? [])})
          on conflict(id) do update set name=excluded.name,date=excluded.date,status=excluded.status,loot=excluded.loot,contributions=excluded.contributions,activities=excluded.activities,activity_list=excluded.activity_list`;
        return json({ ok: true });
      }
      return json({ error: "bad_path" }, 400);
    }

    if (a === "ocr") {
      if (!(await auth(body))) return json({ error: "unauthorized" }, 401);
      if (!ANTHROPIC_API_KEY) return json({ error: "no_key" }, 500);
      const { mode, images } = body;
      const prompt = mode === "rank"
        ? '這是一張手遊活動排名截圖，可能含多個不同家族的玩家。請由上到下、依名次順序擷取每一位玩家的暱稱，回傳一個 JSON 字串陣列（只有暱稱文字，不要名次數字或分數）。只回傳 JSON。'
        : '這是一張手遊家族成員貢獻截圖。請擷取每位成員的暱稱與其「周貢獻」數字，回傳一個 JSON 陣列，每筆為 {"name":"暱稱","score":數字}（score 只要整數、不要逗號）。只回傳 JSON。';
      const content: unknown[] = [];
      for (const im of (images || [])) {
        content.push({ type: "image", source: { type: "base64", media_type: im.media_type || "image/jpeg", data: im.data } });
      }
      content.push({ type: "text", text: prompt });
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: OCR_MODEL, max_tokens: 2000, messages: [{ role: "user", content }] }),
      });
      if (!resp.ok) return json({ error: "anthropic", detail: (await resp.text()).slice(0, 400) }, 502);
      const data = await resp.json();
      const text = (data.content || []).map((c: any) => c.text || "").join("");
      return json({ text });
    }

    return json({ error: "unknown_action", action: a }, 400);
  } catch (e) {
    return json({ error: "server", detail: String(e).slice(0, 400) }, 500);
  }
});
