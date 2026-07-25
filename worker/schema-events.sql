-- events 表：全站事件明细（page_view / test_completed）
-- 冗余 ts_hour / ts_date_bj 避免 strftime 时区转换，查询走索引最快
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT NOT NULL,           -- ISO 8601 UTC，例 '2026-07-25T12:34:56.789Z'
  ts_hour     TEXT NOT NULL,           -- 北京小时桶 'YYYY-MM-DDTHH'（UTC+8）
  ts_date_bj  TEXT NOT NULL,           -- 北京日期 'YYYY-MM-DD'
  event_type  TEXT NOT NULL,           -- 'page_view' | 'test_completed'
  page        TEXT NOT NULL,           -- 归一化路径 '/cpti/' '/'
  type        TEXT,                    -- 仅 test_completed：人格代码（S-F-R-Re 等）
  session_id  TEXT,                    -- 浏览器会话 ID（tracking.js 生成）
  referrer    TEXT,                    -- 来源 URL
  ua          TEXT,                    -- User-Agent 简化
  country     TEXT                     -- 国家代码（Worker cf.country 填）
);

CREATE INDEX IF NOT EXISTS idx_events_type_date ON events(event_type, ts_date_bj);
CREATE INDEX IF NOT EXISTS idx_events_page_date ON events(page, ts_date_bj);
CREATE INDEX IF NOT EXISTS idx_events_hour      ON events(ts_hour);
CREATE INDEX IF NOT EXISTS idx_events_session   ON events(session_id);

-- 初始化密码版本行（用于 session 失效机制）
INSERT OR IGNORE INTO visits (key, count, updated_at) VALUES ('admin_pw_version', 0, datetime('now'));
