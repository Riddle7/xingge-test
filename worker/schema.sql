-- CPTI 统计表：单行 per type，原子 UPDATE 累加
-- 相比 KV 读-改-写，D1 的 UPDATE 是 SQL 原子操作，高并发下不丢数据
DROP TABLE IF EXISTS counts;

CREATE TABLE counts (
  type  TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0
);

-- 初始化 17 种类型（16 标准 + HYBRID）
INSERT INTO counts (type, count) VALUES
  ('S-F-R-Re', 0),
  ('S-F-R-E',  0),
  ('S-F-P-Re', 0),
  ('S-F-P-E',  0),
  ('S-M-R-Re', 0),
  ('S-M-R-E',  0),
  ('S-M-P-Re', 0),
  ('S-M-P-E',  0),
  ('O-F-R-Re', 0),
  ('O-F-R-E',  0),
  ('O-F-P-Re', 0),
  ('O-F-P-E',  0),
  ('O-M-R-Re', 0),
  ('O-M-R-E',  0),
  ('O-M-P-Re', 0),
  ('O-M-P-E',  0),
  ('HYBRID',   0);

-- 元信息表（可选，存部署时间等）
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
INSERT OR REPLACE INTO meta (key, value) VALUES ('migrated_at', datetime('now'));
