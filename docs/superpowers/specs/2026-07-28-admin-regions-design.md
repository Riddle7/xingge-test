# Admin Dashboard 地域排行功能设计

**Date:** 2026-07-28
**Status:** Approved (pending implementation)
**Depends on:** [2026-07-25-admin-dashboard-design.md](./2026-07-25-admin-dashboard-design.md)

## 目标

在现有 admin dashboard 上新增「地域」Tab，展示当日访问地区排行与累计访问地区排行。**不采集 IP**，仅利用 Cloudflare Workers 运行时 `request.cf` 对象提供的地理信息（country / region / city）。

- 国内访问显示「省 + 城市」两级粒度
- 海外访问显示「国家 + region」
- 提供中国地图热力图（按省份着色）+ 城市排行表 + 海外排行表

## 范围

**In scope:**
- `events` 表扩 2 列（region, city）+ 索引
- Worker 内置中国省份英文→中文映射表（约 2KB）
- 新增 1 个 admin API：`GET /api/admin/regions`
- 新增第 7 个 Tab「地域」：echarts 中国地图 + 3 张排行表
- 单元测试扩展

**Out of scope:**
- 不采集也不存储原始 IP
- 不做世界地图热力图（海外仅表格）
- 不做历史 region 数据回填（老 events 行 region/city 为 NULL，归入"未知"）
- 不做独立物化表 region_stats（暂不需要）

## 架构

```
浏览器 ──> tracking.js ──POST /api/event──> Worker
                                          │
                                          ├── request.cf.country  (CN)
                                          ├── request.cf.region   (Guangdong)
                                          └── request.cf.city     (Shenzhen)
                                                  │
                                          insertEvent() ──> D1 events 表
                                                  │ (region 映射为中文后写入)
                                                  ▼
admin ──GET /api/admin/regions──> Worker
                                          │
                                          ├── SQL GROUP BY province  (国内省)
                                          ├── SQL GROUP BY province, city (国内市)
                                          └── SQL GROUP BY country, region (海外)
                                                  │
                                                  ▼
admin.html「地域」Tab
   ├── echarts 中国地图热力图 (按 province 着色)
   ├── 国内省份 Top 20 表
   ├── 国内城市 Top 30 表
   └── 海外国家/地区 Top 20 表
```

## 数据模型

### Schema 变更

新文件 `worker/schema-regions.sql`：

```sql
-- events 表扩列：region 和 city
-- 老数据这两列为 NULL，聚合时用 region IS NOT NULL 过滤
ALTER TABLE events ADD COLUMN region TEXT;
ALTER TABLE events ADD COLUMN city TEXT;

-- 地域查询索引
CREATE INDEX IF NOT EXISTS idx_events_region_date ON events(region, ts_date_bj);
CREATE INDEX IF NOT EXISTS idx_events_city_date   ON events(city, ts_date_bj);
```

### 字段语义

| 列 | 来源 | 国内示例 | 海外示例 |
|---|---|---|---|
| `country` | `request.cf.country` | `CN` | `US` |
| `region` | `request.cf.region` 经中文映射 | `广东` | `California` |
| `city` | `request.cf.city` | `深圳` | `San Francisco` |

**注意**：Cloudflare 的 `request.cf.region` 对中国返回的是 ISO 3166-2:CN 子division code 或拼音英文名（实测以英文 region 名为主，如 "Guangdong", "Beijing", "Shanghai"），需在 Worker 内置映射表归一化为中文省名。

### 省份英文→中文映射表

Worker 内置常量 `REGION_CN_MAP`（约 30 条），覆盖 34 个省级行政区（含港澳台）：

```javascript
const REGION_CN_MAP = {
  'Beijing': '北京', 'Tianjin': '天津', 'Shanghai': '上海', 'Chongqing': '重庆',
  'Guangdong': '广东', 'Jiangsu': '江苏', 'Zhejiang': '浙江', 'Shandong': '山东',
  'Henan': '河南', 'Sichuan': '四川', 'Hubei': '湖北', 'Hunan': '湖南',
  'Hebei': '河北', 'Fujian': '福建', 'Anhui': '安徽', 'Jiangxi': '江西',
  'Shaanxi': '陕西', 'Shanxi': '山西', 'Liaoning': '辽宁', 'Jilin': '吉林',
  'Heilongjiang': '黑龙江', 'Yunnan': '云南', 'Guizhou': '贵州', 'Gansu': '甘肃',
  'Qinghai': '青海', 'Hainan': '海南', 'Taiwan': '台湾',
  'Inner Mongolia': '内蒙古', 'Guangxi': '广西', 'Tibet': '西藏',
  'Ningxia': '宁夏', 'Xinjiang': '新疆',
  'Hong Kong': '香港', 'Macau': '澳门'
};
```

映射失败兜底：使用英文原值（地图可能渲染为该省"未匹配"，但表格照常显示）。

### 中国地图 GeoJSON 资源

新文件 `worker/assets/china.json`（约 80KB，自托管）：
- 通过 STATIC_ASSETS binding 提供，路径 `/china.json`
- 在 admin.html 里 fetch 后传给 `echarts.registerMap('china', geoJson)`
- 来源：echarts 官方 `echarts@5.5.0/map/json/china.json` 或社区维护版本
- 省名采用中文（"广东""北京""上海"），与映射后的 `region` 字段直接匹配

**为何自托管**：与 admin.html 同源加载，避免 CSP 调整；CDN 偶尔有版本漂移导致省名错配。

## 后端 API 设计

### 修改 `insertEvent`

在 `worker/stats.js` 的 `insertEvent` 函数里多读 2 个 payload 字段：

```javascript
async function insertEvent(env, ctx, payload) {
  // payload: { event_type, page, type?, session_id?, referrer?, ua?, country?, region?, city? }
  // ...
  await env.CPTI_DB.prepare(
    'INSERT INTO events (ts, ts_hour, ts_date_bj, event_type, page, type, session_id, referrer, ua, country, region, city) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(
    ts, tsHour, tsDateBj,
    payload.event_type, payload.page, payload.type || null,
    payload.session_id || null, payload.referrer || null,
    payload.ua || null, payload.country || null,
    payload.region || null, payload.city || null
  ).run();
}
```

### 修改 `handleEvent` 和 `handleRecord`

两处都从 `request.cf` 读 region/city：

```javascript
const country = request.cf && request.cf.country ? request.cf.country : null;
const region  = (request.cf && request.cf.region)
  ? normalizeRegion(request.cf.region, country)
  : null;
const city    = (request.cf && request.cf.city) ? request.cf.city : null;
```

**新增工具函数** `normalizeRegion(rawRegion, country)`：

```javascript
function normalizeRegion(rawRegion, country) {
  if (!rawRegion) return null;
  if (country === 'CN' || country === 'HK' || country === 'TW' || country === 'MO') {
    return REGION_CN_MAP[rawRegion] || rawRegion;  // 国内：中文映射，失败兜底原值
  }
  return rawRegion;  // 海外：保留英文
}
```

### 新增 `GET /api/admin/regions`

**路径**: `/api/admin/regions`
**鉴权**: 与其他 admin API 一致（withAuth + cookie session）
**Query 参数**:

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `scope` | `today` \| `cumulative` | `today` | 时间范围 |
| `days` | int (1-90) | 30 | 仅 scope=cumulative 时生效 |

**响应**:

```json
{
  "scope": "today",
  "date": "2026-07-28",
  "date_range": ["2026-06-28", "2026-07-28"],
  "provinces": [
    {"region": "广东", "visits": 142, "percent": 28.4},
    {"region": "北京", "visits": 88,  "percent": 17.6}
  ],
  "cities": [
    {"region": "广东", "city": "深圳", "visits": 78, "percent": 15.6},
    {"region": "上海", "city": "上海", "visits": 45, "percent": 9.0}
  ],
  "overseas": [
    {"country": "United States", "region": "California", "visits": 12, "percent": 2.4}
  ],
  "summary": {
    "domestic_total": 500,
    "overseas_total": 18,
    "unknown_total": 7
  }
}
```

**统计口径**：所有排行按 `COUNT(DISTINCT session_id)` 去重（与现有 `/api/admin/pages`、`/api/admin/referrers` 一致）。`session_id IS NULL` 的访问不计入任何排行，只计入 `unknown_total`。

**SQL 查询**（3 个并发 Promise.all）：

```sql
-- 国内省份
SELECT region, COUNT(DISTINCT session_id) AS v
FROM events
WHERE event_type='page_view'
  AND session_id IS NOT NULL
  AND country IN ('CN','HK','TW','MO')
  AND region IS NOT NULL
  AND ts_date_bj >= ?   -- scope=today: today; scope=cumulative: daysAgo
  AND ts_date_bj <= ?
GROUP BY region ORDER BY v DESC LIMIT 50;

-- 国内城市
SELECT region, city, COUNT(DISTINCT session_id) AS v
FROM events
WHERE event_type='page_view'
  AND session_id IS NOT NULL
  AND country IN ('CN','HK','TW','MO')
  AND city IS NOT NULL
  AND ts_date_bj >= ? AND ts_date_bj <= ?
GROUP BY region, city ORDER BY v DESC LIMIT 100;

-- 海外
SELECT country, region, COUNT(DISTINCT session_id) AS v
FROM events
WHERE event_type='page_view'
  AND session_id IS NOT NULL
  AND country NOT IN ('CN','HK','TW','MO')
  AND country IS NOT NULL
  AND ts_date_bj >= ? AND ts_date_bj <= ?
GROUP BY country, region ORDER BY v DESC LIMIT 50;

-- 总数（用于 summary）
SELECT
  SUM(CASE WHEN country IN ('CN','HK','TW','MO') THEN 1 ELSE 0 END) AS domestic,
  SUM(CASE WHEN country NOT IN ('CN','HK','TW','MO') AND country IS NOT NULL THEN 1 ELSE 0 END) AS overseas,
  SUM(CASE WHEN country IS NULL OR session_id IS NULL THEN 1 ELSE 0 END) AS unknown
FROM events
WHERE event_type='page_view'
  AND ts_date_bj >= ? AND ts_date_bj <= ?;
```

**percent 计算**：分母为 `domestic_total + overseas_total`（即"已知地域总访问"），排除 `unknown`。例如某省 visits=142, domestic+overseas=518，则 percent=142/518=27.4%。

**路由注册**（在 `fetch` 函数 admin API 区块加一行）：

```javascript
if (url.pathname === '/api/admin/regions' && request.method === 'GET') {
  return withAuth(request, env, ctx, handleAdminRegions);
}
```

## 前端 UI 设计

### 导航栏

在「热力图」之后插入第 7 个 Tab：

```html
<button class="nav-tab" data-tab="regions">地域</button>
```

### Tab 内容区

```
┌─────────────────────────────────────────────────────────────────┐
│  [今日] [累计]                          国内: 500 海外: 18 未知: 7│  ← scope 切换 + KPI
├─────────────────────────────────────────────────────────────────┤
│  ┌──────────────────────────┐  ┌──────────────────────────────┐│
│  │ 中国访问省份热力图       │  │ 国内省份 Top 20              ││
│  │   [echarts map]          │  │ ┌──────────────────────────┐ ││
│  │   - 浅米色 → 深陶土色    │  │ │ 广东  ████ 142 (28.4%)  │ ││
│  │   - hover 显示数值       │  │ │ 北京  ███  88  (17.6%)  │ ││
│  │   - visualMap 自动分级   │  │ │ ...                      │ ││
│  └──────────────────────────┘  └──────────────────────────────┘│
│  ┌──────────────────────────────────────────────────────────────┐│
│  │ 国内城市 Top 30                                              ││
│  │ 广东·深圳  █████ 78 (15.6%)  上海·上海  ████ 45 (9.0%)       ││
│  └──────────────────────────────────────────────────────────────┘│
│  ┌──────────────────────────────────────────────────────────────┐│
│  │ 海外国家/地区 Top 20                                         ││
│  │ United States·California  ██ 12 (2.4%)  Japan·Tokyo  █ 3     ││
│  └──────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

### 配色（莫兰迪色系 + 学术风）

- 排行横条：`#7e9bb8`（莫兰迪蓝灰）
- 地图热力色阶：`#f5f0e8`（浅米） → `#c97b4a`（莫兰迪暖陶土）
- 表格文字：默认 `--color-foreground`，percent 用 `--color-muted`
- KPI 卡：与现有 KPI 卡同色

### echarts 配置

```javascript
{
  tooltip: {
    trigger: 'item',
    formatter: function (p) {
      return p.name + ': ' + (p.value || 0) + ' 次访问';
    }
  },
  visualMap: {
    min: 0,
    max: maxVisits,
    left: 'left', top: 'bottom',
    text: ['高', '低'],
    inRange: { color: ['#f5f0e8', '#e8c5a0', '#d99860', '#c97b4a'] },
    calculable: true
  },
  series: [{
    type: 'map',
    map: 'china',
    roam: false,
    label: { show: false },
    emphasis: { label: { show: true } },
    data: provinces.map(p => ({ name: p.region, value: p.visits }))
  }]
}
```

**注意**：echarts 5.x 不再内置 china map，必须 `echarts.registerMap('china', geoJson)` 后才能用 `map: 'china'`。

### 加载逻辑

```javascript
let regionsScope = 'today';
let regionsDays = 30;

async function loadRegionsTab() {
  const params = '?scope=' + regionsScope + (regionsScope === 'cumulative' ? '&days=' + regionsDays : '');
  const data = await api('/api/admin/regions' + params);
  renderChinaMap(data);
  renderRegionTables(data);
  updateLastUpdate();
}

// 首次进入 Tab 时注册地图
let chinaMapRegistered = false;
async function ensureChinaMap() {
  if (chinaMapRegistered) return;
  const r = await fetch('/china.json');
  const geo = await r.json();
  echarts.registerMap('china', geo);
  chinaMapRegistered = true;
}
```

### Tab 切换按钮逻辑

```javascript
document.addEventListener('click', function (e) {
  if (e.target.dataset.regionsScope) {
    regionsScope = e.target.dataset.regionsScope;
    document.querySelectorAll('[data-regions-scope]').forEach(b => b.classList.remove('active'));
    e.target.classList.add('active');
    loadRegionsTab();
  }
});
```

加入 `startRefresh()` 自动刷新列表里。

## 错误处理

| 场景 | 处理 |
|---|---|
| `request.cf` 为 null（dev / Miniflare） | region/city 写 NULL，聚合时归入"未知"分组 |
| `request.cf.region` 拼音不在 `REGION_CN_MAP` | 用原英文值，前端表格照常显示；地图上该省不亮色 |
| `request.cf.country` 为 null | 不计入任何排行，计入 `unknown_total` |
| D1 写入失败 | 沿用现有"静默失败"策略（`console.error` + 不阻塞用户主流程） |
| `china.json` 加载失败 | echarts 显示空白，表格照常显示，控制台 warn |
| echarts CDN 加载失败 | 整个 Tab 显示"图表加载失败"，表格照常显示 |
|港澳台 country code | `HK`/`TW`/`MO` 计入国内分组（CN 同组），与 echarts 中国地图包含这些 region 一致 |

## 兼容性

- `ALTER TABLE ADD COLUMN` 不破坏老数据；老行 region/city=NULL
- 老版本 `tracking.js` 不传 region/city 也不影响 — Worker 自己从 `request.cf` 读，前端无感知
- 现有 6 个 Tab 不受影响
- 现有 admin API 不受影响

## 测试策略

扩展 `test/worker-test.js`：

1. **写入测试**：`POST /api/event` 带 `CF-Connecting-IP` 和模拟 `cf` 对象，验证 events 表 region/city 字段写入正确
2. **中文映射测试**：`request.cf.region='Guangdong'` + `country='CN'` → events.region='广东'
3. **映射失败兜底**：`request.cf.region='Unknown'` + `country='CN'` → events.region='Unknown'
4. **海外不映射**：`request.cf.region='California'` + `country='US'` → events.region='California'
5. **API 结构**：`GET /api/admin/regions?scope=today` 返回三组数据 + summary
6. **scope 切换**：`scope=cumulative&days=7` 范围正确
7. **session 去重**：同 session 多次 page_view 在排行里只算 1 次
8. **国内/海外分组**：CN/HK/TW/MO 计入 domestic；其他计入 overseas
9. **NULL 兜底**：无 region/country 的访问计入 unknown_total，不进任何排行

Miniflare `dispatchFetch` 支持 `cf` 入参：

```javascript
await mf.dispatchFetch('http://localhost/api/event', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ event_type: 'page_view', page: '/', session_id: 's1' }),
  cf: { country: 'CN', region: 'Guangdong', city: 'Shenzhen' }
});
```

## 部署步骤

1. **DB schema 迁移**（一次性）：
   ```bash
   cd d:\trae\worker
   npx wrangler d1 execute cpti-stats-db --remote --file=schema-regions.sql
   ```
2. **放置 china.json**：从 echarts 仓库下载 `china.json` 到 `worker/assets/china.json`
3. **部署 Worker**：
   ```bash
   cd d:\trae\worker
   npx wrangler deploy
   ```
4. **验证**：
   - 浏览器访问 `/admin` → 切到「地域」Tab → 显示中国地图 + 3 张表格
   - 用 `curl` 或 Postman 调 `/api/admin/regions?scope=today`，验证响应结构
5. **不需要清缓存**：新写入立即有 region/city；老数据继续显示 NULL（归入"未知"分组）

## 文件结构

```
d:\trae\
├── worker\
│   ├── stats.js                # 修改：扩 insertEvent + handleEvent + handleRecord，新增 normalizeRegion + REGION_CN_MAP + handleAdminRegions + 路由
│   ├── schema-regions.sql      # 新建：ALTER TABLE + 索引
│   └── assets\
│       ├── admin.html          # 修改：新增「地域」Tab + UI + echarts 加载
│       └── china.json          # 新建：中国地图 GeoJSON（约 80KB）
└── test\
    └── worker-test.js          # 修改：扩展 9 个新测试用例
```

## 未决策的细节（实现阶段决定）

- 国内城市排行显示 Top 30 还是 Top 50（取决于实际数据量）
- 海外排行是否合并同 country（如美国多个州合并为"美国"一项，再点开看州细分）— 当前设计不合并，每行 = country + region
- 城市排行里是否显示"省·市"复合标签，还是只显示市 — 设计稿按"省·市"复合标签
- visualMap 分级数（4 / 5 / 7 段）— 实现时按数据分布调
