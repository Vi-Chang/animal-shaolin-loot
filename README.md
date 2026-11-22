# 動物少林寺 · 戰利品分配主控台

家族戰利品分配系統。前端為單一 `index.html`（部署於 GitHub Pages），後端為 Supabase Edge Function（直連 Postgres 的 `loot` schema）。

## 架構
- **前端**：`index.html`，純靜態網頁。所有資料透過後端 function 讀寫，約每 6 秒輪詢更新。
- **後端**：`supabase/functions/loot/index.ts`
  - 讀取（`state`）與成員許願（`wishes`）公開。
  - 其餘寫入與 OCR 需委託人密碼。
  - OCR 以 Anthropic API 辨識截圖，自動排除非家族成員。

## 使用
- **成員**：打開網址 → 在「③ 分配」頁用「我要許願」選名字與物品。
- **委託人**：點右上角「委託人登入」輸入密碼 → 可建立分配期、上傳截圖辨識、分配、產生清單。

## 後端密鑰（在 Supabase 後台 Edge Functions → Secrets 設定）
| 密鑰 | 說明 |
|---|---|
| `MANAGER_PASS` | 委託人密碼（族長／副族長用） |
| `ANTHROPIC_API_KEY` | 截圖辨識用的 Anthropic API 金鑰 |
| `OCR_MODEL` | （選填）預設 `claude-sonnet-5-5` |

`SUPABASE_DB_URL` 由 Supabase 自動提供，不需手動設定。

## 部署
- 前端：推到 GitHub 後由 GitHub Pages 服務。
- 後端：`supabase functions deploy loot`（或透過 Supabase 後台）。
