-- events 表扩列：region 和 city
-- 老数据这两列为 NULL，聚合时用 region IS NOT NULL 过滤
ALTER TABLE events ADD COLUMN region TEXT;
ALTER TABLE events ADD COLUMN city TEXT;

-- 地域查询索引
CREATE INDEX IF NOT EXISTS idx_events_region_date ON events(region, ts_date_bj);
CREATE INDEX IF NOT EXISTS idx_events_city_date   ON events(city, ts_date_bj);
