-- 副總統輪值排班表
-- 重複執行不會出事：全部是 IF NOT EXISTS，預設資料也只在表是空的時候才放。

-- 盟友。pw_hash = HMAC-SHA256(PW_PEPPER, 密碼)，同一個密碼永遠算出同一個值，
-- 所以「只打密碼」就查得到人。管理員代建、還沒設密碼的成員 pw_hash 是 NULL。
CREATE TABLE IF NOT EXISTS members (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  nickname   TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pw_hash    TEXT UNIQUE,
  created_at INTEGER NOT NULL,           -- UTC 秒數
  disabled   INTEGER NOT NULL DEFAULT 0
);

-- 登入狀態。只存憑證的 SHA-256，憑證本身只在使用者手機上。
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  member_id  INTEGER NOT NULL REFERENCES members (id),
  created_at INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_member ON sessions (member_id);

-- 認領。主鍵是「那一格開始的 UTC 秒數」，一格只能有一個人，兩人同時搶也不會重複。
CREATE TABLE IF NOT EXISTS claims (
  slot_start INTEGER PRIMARY KEY,
  member_id  INTEGER NOT NULL REFERENCES members (id),
  created_at INTEGER NOT NULL,
  by_admin   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_claims_member ON claims (member_id);

-- 每天有哪幾格（台灣時間整點），保留歷史：某一天適用「生效日 <= 那天」裡最新的一條。
-- 管理員改時段 = 新增一條從今天起生效的規則，過去的日子仍照舊規則計算。
CREATE TABLE IF NOT EXISTS slot_rules (
  effective_from TEXT PRIMARY KEY,       -- 台灣日期 'YYYY-MM-DD'
  hours          TEXT NOT NULL           -- JSON 陣列，例如 [12,21,22]
);

INSERT INTO slot_rules (effective_from, hours)
SELECT date('now', '+8 hours'), '[12,21,22]'
WHERE NOT EXISTS (SELECT 1 FROM slot_rules);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO settings (key, value) VALUES ('booking_days', '14');

-- 操作紀錄：誰在什麼時候認領、取消、被管理員改
CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         INTEGER NOT NULL,
  actor      TEXT NOT NULL,              -- 'member:<id>' 或 'admin'
  action     TEXT NOT NULL,              -- claim / unclaim / assign / clear / settings / member
  slot_start INTEGER,
  member_id  INTEGER,
  detail     TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log (at);

-- 擋暴力猜密碼：同一來源（IP 雜湊）每 10 分鐘一個計數窗
CREATE TABLE IF NOT EXISTS login_fail (
  ip_hash      TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ip_hash, window_start)
);
