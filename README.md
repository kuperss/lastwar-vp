# Last War 副總統（VP）輪值表

盟友點連結就能看未來 1～2 週每天的 VP 時段、自己認領／取消，並即時統計每個人認領了幾小時。

- 正式網址：**https://mahuvp.kupers.cc**（網頁和 API 都由同一個 Cloudflare Worker 提供）
- 網頁：`docs/`（手寫 HTML/CSS/JS，不用建置），部署時當成 Worker 的靜態檔一起上傳
- 後端：`worker/`（Cloudflare Worker + D1），`/api/*` 才進程式，其他路徑直接回 `docs/` 的檔案
- 時段預設每天台灣時間 12–13、21–22、22–23，管理員可在頁面上改（從當天起生效，過去紀錄不變）

## 給盟友的使用說明（可直接貼到群組）

1. 打開連結，切換右上角語言（中／VI／EN）。
2. 第一次使用：按「登入」→「第一次使用」，填**遊戲暱稱**和**至少 8 個字的密碼**。
3. 之後換手機或清掉瀏覽器資料，只要按「登入」輸入密碼，就會認出你。
4. 預設是**週檢視**，一個畫面看完 7 天；用「‹ ›」切換上一週／下一週，右上角可切換成清單。
   金色虛線「＋」就是空缺，點一下就是你的；點自己的格子（藍框★）可以取消，點別人的格子看詳情。
   手機直拿時一天一橫列，畫面夠寬（電腦、手機橫拿）時自動變成一天一直欄。
5. 忘記密碼請找管理員重設。

## 本機開發

```bash
cd worker
npx wrangler@4 d1 execute lastwar-vp --local --file=schema.sql
npx wrangler@4 dev --local --port 8787
```

`wrangler dev` 會連網頁一起開在 http://127.0.0.1:8787 。
若想另外用 python 開前台（8792 埠時會自動連 8787 的 API）：

```bash
python -m http.server 8792 --bind 127.0.0.1 --directory docs
```

本機用的祕密放在 `worker/.dev.vars`（已排除在 git 外）：

```
ADMIN_KEY=local-admin-test-key
PW_PEPPER=local-pepper-for-dev-only
```

時段計算的單元測試：

```bash
cd worker
node --test test/slots.test.mjs
```

## 第一次部署

1. 建立資料庫，把印出來的 `database_id` 填進 `worker/wrangler.toml`：
   ```bash
   cd worker
   npx wrangler@4 d1 create lastwar-vp
   ```
2. 建表：
   ```bash
   npx wrangler@4 d1 execute lastwar-vp --remote --file=schema.sql
   ```
3. 設定兩個祕密（指令會請你輸入值）：
   - `ADMIN_KEY`：管理密碼，自己決定，交給要管理的 R4/R5。
   - `PW_PEPPER`：用來把盟友密碼變成雜湊的祕密，隨機一長串就好。**設了之後不能改**，改了所有人的密碼都會失效。
   ```bash
   npx wrangler@4 secret put ADMIN_KEY
   npx wrangler@4 secret put PW_PEPPER
   ```
4. 部署（網頁和 API 一起上去，綁 `mahuvp.kupers.cc`）：
   ```bash
   npx wrangler@4 deploy
   ```
   之後改了網頁或 API，都只要在 `worker/` 再跑一次 `npx wrangler@4 deploy`。
   換網址的話，改 `wrangler.toml` 的 `routes` 和 `ALLOWED_ORIGINS`。

## 設計重點

- **一格 = 開始時間的 UTC 秒數**，資料庫以此為主鍵：兩人同時搶同一格只會有一個成功，另一個會看到「剛被 ○○ 認領」。
- **時段規則保留歷史**（`slot_rules`）：改時段只影響當天以後；已認領但不在新時段裡的格子會標「非常規時段」，由管理員決定要不要清掉。
- **只打密碼登入**：密碼存成 `HMAC-SHA256(PW_PEPPER, 密碼)`，同一個密碼永遠算出同一個值才查得到人。
  撞到別人的密碼只回「此密碼無法使用」，而且算一次失敗；同一來源 10 分鐘錯 10 次會暫停 10 分鐘。
  限制：知道別人密碼就能用他的名義 —— 所有認領／取消都記在操作紀錄裡，管理員可修正。
- **即時**：頁面開著時每 20 秒更新、切回分頁立刻更新。
- 統計的「已擔任」= 已結束的格；「已排定」= 還沒結束的格。

## API

見 `worker/src/worker.js` 檔頭。錯誤一律回 `{ "error": "<代碼>" }`，前台依代碼顯示三種語言的訊息（`docs/i18n.js` 的 `err_*`）。
