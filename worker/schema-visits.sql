-- 访客计数表：单行 per key
-- key 取值：
--   'total'                 -> 累计总访问量
--   'today_<YYYY-MM-DD>'    -> 当日访问量（UTC 日期，每天一个新行；历史行保留不删，便于后续审计）
-- 原子 UPSERT：INSERT ... ON CONFLICT DO UPDATE SET count = count + 1
CREATE TABLE IF NOT EXISTS visits (
  key   TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT
);

-- 初始化 total 行
INSERT OR IGNORE INTO visits (key, count, updated_at) VALUES ('total', 0, datetime('now'));

-- 索引：按 updated_at 排序查今日行（备用，当前不查询）
CREATE INDEX IF NOT EXISTS idx_visits_updated ON visits(updated_at);
