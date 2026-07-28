# Admin Dashboard 地域排行功能实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 admin dashboard 上新增「地域」Tab，展示当日/累计访问地区排行，包括中国地图热力图（按省着色）+ 国内省份排行表 + 国内城市排行表 + 海外排行表。不采集 IP，仅利用 Cloudflare `request.cf` 提供的 country/region/city。

**Architecture:** 在现有 `cpti-stats` Worker 上扩展：events 表 ALTER 加 region/city 两列 + 索引；Worker 内置 30+ 条省份英文→中文映射；`insertEvent` / `handleEvent` / `handleRecord` 从 `request.cf` 读取并写入；新增 1 个 admin API `GET /api/admin/regions` 走 SQL GROUP BY 聚合；admin.html 新增第 7 个 Tab「地域」，自托管 china.json + echarts CDN 渲染地图。

**Tech Stack:** Cloudflare Workers + D1（SQLite）+ Cache API；前端 echarts 5.5.0（CDN）+ 中国地图 GeoJSON（自托管）+ 原生 JS；测试 Miniflare + node:test。

**Spec:** [docs/superpowers/specs/2026-07-28-admin-regions-design.md](file:///d:/trae/docs/superpowers/specs/2026-07-28-admin-regions-design.md)

---

## 文件结构

```
d:\trae\
├── worker\
│   ├── stats.js                # 修改：扩 insertEvent + handleEvent + handleRecord，新增 normalizeRegion + REGION_CN_MAP + handleAdminRegions + 路由
│   ├── schema-regions.sql       # 新建：ALTER TABLE + 索引
│   └── assets\
│       ├── admin.html          # 修改：新增「地域」Tab + UI + echarts 加载
│       └── china.json          # 新建：中国地图 GeoJSON（约 80KB，由实施者从 echarts 官方下载）
└── test\
    └── worker-test.js          # 修改：扩展 9 个新测试用例
```

---

### Task 1: 新建 schema-regions.sql（events 表扩列 + 索引）

**Files:**
- Create: `worker/schema-regions.sql`

- [ ] **Step 1: 编写 schema-regions.sql**

创建 `d:\trae\worker\schema-regions.sql`，内容：

```sql
-- events 表扩列：region 和 city
-- 老数据这两列为 NULL，聚合时用 region IS NOT NULL 过滤
ALTER TABLE events ADD COLUMN region TEXT;
ALTER TABLE events ADD COLUMN city TEXT;

-- 地域查询索引
CREATE INDEX IF NOT EXISTS idx_events_region_date ON events(region, ts_date_bj);
CREATE INDEX IF NOT EXISTS idx_events_city_date   ON events(city, ts_date_bj);
```

- [ ] **Step 2: 本地校验 SQL 语法（可选）**

Run: `cd d:\trae\worker && npx wrangler d1 execute cpti-stats-db --local --file=schema-regions.sql`
Expected: 输出 "Executed N queries" 无错误（如本地无 wrangler 环境，跳过此步，部署时再验证）

- [ ] **Step 3: Commit**

```bash
git add worker/schema-regions.sql
git commit -m "feat(worker): add region/city columns to events table schema"
```

---

### Task 2: 在 stats.js 顶部加省份英文→中文映射表 REGION_CN_MAP

**Files:**
- Modify: `worker/stats.js`（在第 21 行 `COMPACT_MAP` 常量之后插入）

- [ ] **Step 1: 在 COMPACT_MAP 之后插入 REGION_CN_MAP 常量**

在 `worker/stats.js` 第 21 行 `};` 之后（COMPACT_MAP 闭合括号后）插入：

```javascript
// 中国省份英文→中文映射表（Cloudflare request.cf.region 对中国返回英文/拼音）
// 映射失败兜底：保留原英文值（地图可能渲染为该省"未匹配"，但表格照常显示）
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

// 国内 country code 集合（含港澳台，与 echarts 中国地图范围一致）
const DOMESTIC_COUNTRIES = ['CN', 'HK', 'TW', 'MO'];

// 把 request.cf.region 归一化：
// - 国内（CN/HK/TW/MO）：尝试中文映射，失败兜底原值
// - 海外：保留英文原值
function normalizeRegion(rawRegion, country) {
  if (!rawRegion) return null;
  if (DOMESTIC_COUNTRIES.includes(country)) {
    return REGION_CN_MAP[rawRegion] || rawRegion;
  }
  return rawRegion;
}
```

- [ ] **Step 2: 验证语法**

Run: `cd d:\trae\worker && node -c stats.js`
Expected: 无输出（语法正确）

- [ ] **Step 3: Commit**

```bash
git add worker/stats.js
git commit -m "feat(worker): add REGION_CN_MAP and normalizeRegion helper"
```

---

### Task 3: 扩展 insertEvent 写入 region/city 字段

**Files:**
- Modify: `worker/stats.js`（`insertEvent` 函数，约第 57-75 行）

- [ ] **Step 1: 修改 insertEvent 函数**

把 `worker/stats.js` 中的 `insertEvent` 函数（约第 57-75 行）整体替换为：

```javascript
// ============ events 表写入辅助 ============
// 写入一条事件到 events 表；调用方负责事务/缓存失效
// payload: { event_type, page, type?, session_id?, referrer?, ua?, country?, region?, city? }
async function insertEvent(env, ctx, payload) {
  const now = new Date();
  const ts = now.toISOString();
  const tsHour = bjHourFromIso(ts);
  const tsDateBj = bjDateFromIso(ts);
  await env.CPTI_DB.prepare(
    'INSERT INTO events (ts, ts_hour, ts_date_bj, event_type, page, type, session_id, referrer, ua, country, region, city) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(
    ts, tsHour, tsDateBj,
    payload.event_type,
    payload.page,
    payload.type || null,
    payload.session_id || null,
    payload.referrer || null,
    payload.ua || null,
    payload.country || null,
    payload.region || null,
    payload.city || null
  ).run();
}
```

- [ ] **Step 2: 验证语法**

Run: `cd d:\trae\worker && node -c stats.js`
Expected: 无输出

- [ ] **Step 3: Commit**

```bash
git add worker/stats.js
git commit -m "feat(worker): extend insertEvent to write region/city"
```

---

### Task 4: 修改 handleEvent 从 request.cf 读 region/city

**Files:**
- Modify: `worker/stats.js`（`handleEvent` 函数，约第 282-313 行）

- [ ] **Step 1: 修改 handleEvent 函数**

把 `worker/stats.js` 中 `handleEvent` 函数（约第 282-313 行）整体替换为：

```javascript
// POST /api/event
// Body: { event_type: 'page_view', page, session_id, referrer }
// 写入 events 表，供后台分析
async function handleEvent(request, env, ctx) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ success: false, error: 'invalid json', code: 'INVALID_PARAMS' }, 400);
  }
  if (!body || body.event_type !== 'page_view' || !body.page) {
    return json({ success: false, error: 'missing required fields', code: 'INVALID_PARAMS' }, 400);
  }
  // page 白名单校验：仅允许以 / 开头的路径
  if (typeof body.page !== 'string' || !body.page.startsWith('/')) {
    return json({ success: false, error: 'invalid page', code: 'INVALID_PARAMS' }, 400);
  }
  const ua = request.headers.get('User-Agent') || null;
  const country = (request.cf && request.cf.country) ? request.cf.country : null;
  const region = (request.cf && request.cf.region)
    ? normalizeRegion(request.cf.region, country)
    : null;
  const city = (request.cf && request.cf.city) ? request.cf.city : null;
  try {
    await insertEvent(env, ctx, {
      event_type: 'page_view',
      page: body.page,
      session_id: body.session_id || null,
      referrer: body.referrer || null,
      ua: ua,
      country: country,
      region: region,
      city: city
    });
  } catch (e) {
    console.error('events insert failed (page_view):', e);
    // 静默失败：tracking.js 不阻塞用户
    return json({ success: false, error: 'db error', code: 'DB_ERROR' }, 500);
  }
  return json({ success: true });
}
```

- [ ] **Step 2: 验证语法**

Run: `cd d:\trae\worker && node -c stats.js`
Expected: 无输出

- [ ] **Step 3: Commit**

```bash
git add worker/stats.js
git commit -m "feat(worker): handleEvent reads region/city from request.cf"
```

---

### Task 5: 修改 handleRecord 从 request.cf 读 region/city

**Files:**
- Modify: `worker/stats.js`（`handleRecord` 函数，约第 152-189 行）

- [ ] **Step 1: 修改 handleRecord 函数**

把 `worker/stats.js` 中 `handleRecord` 函数（约第 152-189 行）整体替换为：

```javascript
// POST /api/record?type=XXX
// 双写：counts 表 +1（兼容 /api/stats）且 events 表新增 test_completed 行（后台分析）
async function handleRecord(request, env, ctx) {
  const url = new URL(request.url);
  const rawType = url.searchParams.get('type');
  const type = normalizeType(rawType);
  if (!type) return json({ success: false, error: 'invalid type' }, 400);

  // 1. counts 表原子 UPDATE（RETURNING 拿最新 count）
  const stmt = env.CPTI_DB.prepare(
    'UPDATE counts SET count = count + 1 WHERE type = ? RETURNING count'
  ).bind(type);
  const result = await stmt.first();
  const newCount = result ? result.count : 0;

  // 2. events 表追加 test_completed 行（后台分析用）
  const sessionId = url.searchParams.get('sid') || null;
  const referrer = request.headers.get('Referer') || null;
  const ua = request.headers.get('User-Agent') || null;
  const country = (request.cf && request.cf.country) ? request.cf.country : null;
  const region = (request.cf && request.cf.region)
    ? normalizeRegion(request.cf.region, country)
    : null;
  const city = (request.cf && request.cf.city) ? request.cf.city : null;
  ctx.waitUntil(
    insertEvent(env, ctx, {
      event_type: 'test_completed',
      page: '/cpti/',
      type: type,
      session_id: sessionId,
      referrer: referrer,
      ua: ua,
      country: country,
      region: region,
      city: city
    }).catch(function (e) {
      console.error('events insert failed (test_completed):', e);
      // 静默失败：不影响用户主流程
    })
  );

  // 3. 失效 L2 缓存（counts 表）
  invalidateStatsCache(ctx);
  return json({ success: true, count: newCount, type: type });
}
```

- [ ] **Step 2: 验证语法**

Run: `cd d:\trae\worker && node -c stats.js`
Expected: 无输出

- [ ] **Step 3: Commit**

```bash
git add worker/stats.js
git commit -m "feat(worker): handleRecord reads region/city from request.cf"
```

---

### Task 6: 新增 handleAdminRegions API handler

**Files:**
- Modify: `worker/stats.js`（在 `handleAdminReferrers` 函数之后，`serveAdminHtml` 之前插入）

- [ ] **Step 1: 在 handleAdminReferrers 之后插入 handleAdminRegions 函数**

在 `worker/stats.js` 中找到 `handleAdminReferrers` 函数的结尾（约第 788 行 `return json({ referrers: ... })`），在该函数之后、`// 静态资源：通过 env.STATIC_ASSETS 读取` 注释之前插入：

```javascript
// GET /api/admin/regions?scope=today|cumulative&days=30
// 返回国内省份/国内城市/海外三组排行 + 总数 summary
// 统计口径：COUNT(DISTINCT session_id)，与 /api/admin/pages 一致
async function handleAdminRegions(request, env, ctx) {
  const url = new URL(request.url);
  const scope = url.searchParams.get('scope') === 'cumulative' ? 'cumulative' : 'today';
  const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '30', 10), 1), 90);

  const today = bjDateNow();
  let dateFrom, dateTo;
  if (scope === 'today') {
    dateFrom = today;
    dateTo = today;
  } else {
    dateFrom = bjDateFromIso(new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString());
    dateTo = today;
  }

  const domesticList = DOMESTIC_COUNTRIES.map(function (c) { return "'" + c + "'"; }).join(',');

  const [provRows, cityRows, overseasRows, summaryRow] = await Promise.all([
    // 国内省份
    env.CPTI_DB.prepare(
      "SELECT region, COUNT(DISTINCT session_id) AS v FROM events WHERE event_type='page_view' AND session_id IS NOT NULL AND country IN (" + domesticList + ") AND region IS NOT NULL AND ts_date_bj >= ? AND ts_date_bj <= ? GROUP BY region ORDER BY v DESC LIMIT 50"
    ).bind(dateFrom, dateTo).all(),
    // 国内城市
    env.CPTI_DB.prepare(
      "SELECT region, city, COUNT(DISTINCT session_id) AS v FROM events WHERE event_type='page_view' AND session_id IS NOT NULL AND country IN (" + domesticList + ") AND city IS NOT NULL AND ts_date_bj >= ? AND ts_date_bj <= ? GROUP BY region, city ORDER BY v DESC LIMIT 100"
    ).bind(dateFrom, dateTo).all(),
    // 海外
    env.CPTI_DB.prepare(
      "SELECT country, region, COUNT(DISTINCT session_id) AS v FROM events WHERE event_type='page_view' AND session_id IS NOT NULL AND country NOT IN (" + domesticList + ") AND country IS NOT NULL AND ts_date_bj >= ? AND ts_date_bj <= ? GROUP BY country, region ORDER BY v DESC LIMIT 50"
    ).bind(dateFrom, dateTo).all(),
    // 总数（用于 summary）
    env.CPTI_DB.prepare(
      "SELECT " +
      "SUM(CASE WHEN country IN (" + domesticList + ") THEN 1 ELSE 0 END) AS domestic, " +
      "SUM(CASE WHEN country NOT IN (" + domesticList + ") AND country IS NOT NULL THEN 1 ELSE 0 END) AS overseas, " +
      "SUM(CASE WHEN country IS NULL OR session_id IS NULL THEN 1 ELSE 0 END) AS unknown " +
      "FROM events WHERE event_type='page_view' AND ts_date_bj >= ? AND ts_date_bj <= ?"
    ).bind(dateFrom, dateTo).first()
  ]);

  const domesticTotal = summaryRow?.domestic || 0;
  const overseasTotal = summaryRow?.overseas || 0;
  const knownTotal = domesticTotal + overseasTotal;  // 排除 unknown

  const pct = function (v) {
    return knownTotal > 0 ? Math.round((v / knownTotal) * 1000) / 10 : 0;
  };

  const provinces = (provRows.results || []).map(function (r) {
    return { region: r.region, visits: r.v, percent: pct(r.v) };
  });
  const cities = (cityRows.results || []).map(function (r) {
    return { region: r.region, city: r.city, visits: r.v, percent: pct(r.v) };
  });
  const overseas = (overseasRows.results || []).map(function (r) {
    return { country: r.country, region: r.region, visits: r.v, percent: pct(r.v) };
  });

  return json({
    scope: scope,
    date: today,
    date_range: [dateFrom, dateTo],
    provinces: provinces,
    cities: cities,
    overseas: overseas,
    summary: {
      domestic_total: domesticTotal,
      overseas_total: overseasTotal,
      unknown_total: summaryRow?.unknown || 0
    }
  });
}
```

- [ ] **Step 2: 验证语法**

Run: `cd d:\trae\worker && node -c stats.js`
Expected: 无输出

- [ ] **Step 3: Commit**

```bash
git add worker/stats.js
git commit -m "feat(worker): add handleAdminRegions API for region ranking"
```

---

### Task 7: 在 fetch 函数注册 /api/admin/regions 路由

**Files:**
- Modify: `worker/stats.js`（`fetch` 函数的 admin API 区块）

- [ ] **Step 1: 在 fetch 函数中注册新路由**

在 `worker/stats.js` 的 `fetch` 函数中找到 `/api/admin/referrers` 路由（约第 887-889 行）：

```javascript
    if (url.pathname === '/api/admin/referrers' && request.method === 'GET') {
      return withAuth(request, env, ctx, handleAdminReferrers);
    }
```

在该路由之后插入：

```javascript
    if (url.pathname === '/api/admin/regions' && request.method === 'GET') {
      return withAuth(request, env, ctx, handleAdminRegions);
    }
```

- [ ] **Step 2: 验证语法**

Run: `cd d:\trae\worker && node -c stats.js`
Expected: 无输出

- [ ] **Step 3: Commit**

```bash
git add worker/stats.js
git commit -m "feat(worker): register /api/admin/regions route"
```

---

### Task 8: 下载 china.json 到 worker/assets/

**Files:**
- Create: `worker/assets/china.json`

- [ ] **Step 1: 下载 echarts 官方中国地图 GeoJSON**

Run: `curl -L -o d:\trae\worker\assets\china.json https://raw.githubusercontent.com/apache/echarts/5.5.0/map/json/china.json`
Expected: 文件大小约 80KB，JSON 格式，包含 34 个省级行政区的 features 数组

如 curl 失败（网络问题），可手动从浏览器下载并保存到 `d:\trae\worker\assets\china.json`：
- URL: https://raw.githubusercontent.com/apache/echarts/5.5.0/map/json/china.json
- 验证：JSON 顶层有 `type: "FeatureCollection"` 和 `features` 数组，每个 feature 的 `properties.name` 是中文省名（如 "广东"、"北京"）

- [ ] **Step 2: 验证 JSON 有效性**

Run: `node -e "const fs=require('fs');const g=JSON.parse(fs.readFileSync('d:/trae/worker/assets/china.json','utf8'));console.log('features:', g.features.length);console.log('sample:', g.features[0].properties.name);"`
Expected: 输出 `features: 34` 和某个中文省名（如 `sample: 广东` 或 `sample: 北京`）

- [ ] **Step 3: Commit**

```bash
git add worker/assets/china.json
git commit -m "feat(admin): add self-hosted china geojson for echarts map"
```

---

### Task 9: 在 stats.js 加 /china.json 静态资源路由

**Files:**
- Modify: `worker/stats.js`（`serveTrackingJs` 函数之后，新增 `serveChinaJson` 函数；并在 `fetch` 函数注册路由）

- [ ] **Step 1: 在 serveTrackingJs 函数之后新增 serveChinaJson 函数**

在 `worker/stats.js` 中找到 `serveTrackingJs` 函数（约第 819-831 行），在该函数之后插入：

```javascript
async function serveChinaJson(env) {
  const obj = await env.STATIC_ASSETS.fetch(new Request('https://internal/china.json'));
  if (!obj.ok) return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
  const js = await obj.text();
  return new Response(js, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',  // 24 小时
      'Access-Control-Allow-Origin': '*'
    }
  });
}
```

- [ ] **Step 2: 在 fetch 函数中注册 /china.json 路由**

在 `worker/stats.js` 的 `fetch` 函数中找到 `/tracking.js` 路由（约第 898-900 行）：

```javascript
    if (url.pathname === '/tracking.js') {
      return serveTrackingJs(env);
    }
```

在该路由之后插入：

```javascript
    if (url.pathname === '/china.json') {
      return serveChinaJson(env);
    }
```

- [ ] **Step 3: 验证语法**

Run: `cd d:\trae\worker && node -c stats.js`
Expected: 无输出

- [ ] **Step 4: Commit**

```bash
git add worker/stats.js
git commit -m "feat(worker): serve self-hosted china.json at /china.json"
```

---

### Task 10: 在 admin.html 引入 echarts CDN + 新增「地域」Tab 导航

**Files:**
- Modify: `worker/assets/admin.html`

- [ ] **Step 1: 在 admin.html 的 <head> 中引入 echarts**

在 `worker/assets/admin.html` 的 `<head>` 区域，找到现有的 Chart.js 引入：

```html
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
```

在该行之前（确保 echarts 在 Chart.js 之前加载）插入：

```html
  <script src="https://cdn.jsdelivr.net/npm/echarts@5.5.0/dist/echarts.min.js"></script>
```

- [ ] **Step 2: 更新 admin.html 的 Content-Security-Policy**

在 `worker/stats.js` 的 `serveAdminHtml` 函数中找到 CSP 头（约第 800 行）：

```javascript
      'Content-Security-Policy': "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' https://fonts.googleapis.com 'unsafe-inline'; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:;"
```

替换为（增加 `connect-src 'self'` 允许 fetch /china.json）：

```javascript
      'Content-Security-Policy': "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' https://fonts.googleapis.com 'unsafe-inline'; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self';"
```

- [ ] **Step 3: 在导航栏中新增「地域」Tab 按钮**

在 `worker/assets/admin.html` 中找到导航 tabs（约第 1364 行）：

```html
        <nav class="nav-tabs" id="nav-tabs">
          <button class="nav-tab active" data-tab="overview">概览</button>
          <button class="nav-tab" data-tab="visits">访问</button>
          <button class="nav-tab" data-tab="tests">测试</button>
          <button class="nav-tab" data-tab="types">人格</button>
          <button class="nav-tab" data-tab="sessions">会话</button>
          <button class="nav-tab" data-tab="heatmap">热力图</button>
        </nav>
```

在 `热力图` 按钮之后插入：

```html
          <button class="nav-tab" data-tab="regions">地域</button>
```

- [ ] **Step 4: Commit**

```bash
git add worker/assets/admin.html worker/stats.js
git commit -m "feat(admin): add echarts CDN + regions tab nav button"
```

---

### Task 11: 在 admin.html 加「地域」Tab 内容区 HTML 结构

**Files:**
- Modify: `worker/assets/admin.html`

- [ ] **Step 1: 在 heatmap Tab 之后插入 regions Tab 内容区**

在 `worker/assets/admin.html` 中找到 heatmap Tab 的闭合 `</section>`（约第 1479 行附近）：

```html
      <!-- Heatmap Tab -->
      <section id="tab-heatmap" class="tab-content">
        <div class="chart-card">
          <div class="chart-title">访问热力图（7 天 × 24 小时）
            <div class="controls">
              <button data-heat-days="7" class="active">7 天</button>
              <button data-heat-days="14">14 天</button>
              <button data-heat-days="30">30 天</button>
            </div>
          </div>
          <div class="heatmap-wrap" id="heatmap-wrap"></div>
        </div>
      </section>
```

在该 `</section>` 之后插入：

```html
      <!-- Regions Tab -->
      <section id="tab-regions" class="tab-content">
        <div class="kpi-grid" id="regions-kpis"></div>
        <div class="chart-card" style="margin-bottom:16px">
          <div class="chart-title">访问地域分布
            <div class="controls">
              <button data-regions-scope="today" class="active">今日</button>
              <button data-regions-scope="cumulative">累计（30 天）</button>
            </div>
          </div>
          <div class="regions-layout">
            <div class="china-map-wrap"><div id="china-map" style="width:100%;height:520px"></div></div>
            <div class="region-table-wrap">
              <div class="chart-title" style="font-size:13px">国内省份 Top 20</div>
              <table><thead><tr><th>省份</th><th>访问</th><th>占比</th></tr></thead>
                <tbody id="regions-provinces-body"></tbody></table>
            </div>
          </div>
        </div>
        <div class="table-card" style="margin-top:16px">
          <div class="chart-title">国内城市 Top 30</div>
          <table><thead><tr><th>省·市</th><th>访问</th><th>占比</th></tr></thead>
            <tbody id="regions-cities-body"></tbody></table>
        </div>
        <div class="table-card" style="margin-top:16px">
          <div class="chart-title">海外国家/地区 Top 20</div>
          <table><thead><tr><th>国家·地区</th><th>访问</th><th>占比</th></tr></thead>
            <tbody id="regions-overseas-body"></tbody></table>
        </div>
      </section>
```

- [ ] **Step 2: 在 <style> 区域新增地域 Tab 样式**

在 `worker/assets/admin.html` 的 `<style>` 区域末尾（在 `.toast.error { background: var(--color-danger); }` 之后）插入：

```css
    /* Regions Tab */
    .regions-layout {
      display: grid; grid-template-columns: 1.4fr 1fr;
      gap: 16px; align-items: start;
    }
    @media (max-width: 768px) {
      .regions-layout { grid-template-columns: 1fr; }
    }
    .china-map-wrap {
      background: var(--color-background-100);
      border-radius: 8px; padding: 8px;
      min-height: 520px;
    }
    .region-table-wrap { max-height: 520px; overflow-y: auto; }
    .region-table-wrap table { font-size: 12px; }
    .region-table-wrap th, .region-table-wrap td { padding: 6px 8px; }
```

- [ ] **Step 3: 验证 HTML 结构**

Run: `cd d:\trae\worker\assets && node -e "const fs=require('fs');const h=fs.readFileSync('admin.html','utf8');const o=(h.match(/<section/g)||[]).length;const c=(h.match(/<\/section>/g)||[]).length;console.log('section open:',o,'close:',c, o===c?'OK':'MISMATCH');"`
Expected: `section open: 7 close: 7 OK`

- [ ] **Step 4: Commit**

```bash
git add worker/assets/admin.html
git commit -m "feat(admin): add regions tab HTML structure and styles"
```

---

### Task 12: 在 admin.html 加「地域」Tab JS 逻辑

**Files:**
- Modify: `worker/assets/admin.html`（在 `<script>` 区域末尾、`init` 函数之前插入）

- [ ] **Step 1: 在 admin.html 的 script 末尾插入 regions Tab 的 JS 逻辑**

在 `worker/assets/admin.html` 的 `<script>` 区域，找到 `// ===== 初始化：检查是否已登录 =====` 注释（约第 1897 行附近），在该注释之前插入：

```javascript
    // ===== Regions Tab =====
    let regionsScope = 'today';
    let regionsDays = 30;
    let chinaMapRegistered = false;
    let chinaMapChart = null;

    async function ensureChinaMap() {
      if (chinaMapRegistered) return true;
      try {
        const r = await fetch('/china.json');
        if (!r.ok) {
          console.warn('china.json fetch failed:', r.status);
          return false;
        }
        const geo = await r.json();
        echarts.registerMap('china', geo);
        chinaMapRegistered = true;
        return true;
      } catch (e) {
        console.warn('china.json load error:', e);
        return false;
      }
    }

    async function loadRegionsTab() {
      try {
        const params = '?scope=' + regionsScope + (regionsScope === 'cumulative' ? '&days=' + regionsDays : '');
        const data = await api('/api/admin/regions' + params);
        // KPI
        const s = data.summary || {};
        document.getElementById('regions-kpis').innerHTML = [
          kpiCard('国内访问', fmt(s.domestic_total), null),
          kpiCard('海外访问', fmt(s.overseas_total), null),
          kpiCard('未知地域', fmt(s.unknown_total), null)
        ].join('');
        // 表格
        renderRegionTables(data);
        // 地图
        const ok = await ensureChinaMap();
        if (ok) {
          renderChinaMap(data);
        } else {
          const el = document.getElementById('china-map');
          if (el) el.innerHTML = '<div style="padding:40px;text-align:center;color:var(--color-muted)">地图加载失败，请查看下方表格</div>';
        }
        updateLastUpdate();
      } catch (e) {
        if (e.message !== 'unauthorized') toast('加载失败: ' + e.message, true);
      }
    }

    function renderRegionTables(data) {
      const total = (data.summary?.domestic_total || 0) + (data.summary?.overseas_total || 0) || 1;
      // 国内省份
      const provTb = document.getElementById('regions-provinces-body');
      provTb.innerHTML = (data.provinces || []).slice(0, 20).map(function (r) {
        const w = Math.max(2, (r.visits / total) * 100);
        return '<tr><td>' + escapeHtml(r.region) + '</td><td>' + fmt(r.visits) + '</td><td><div class="bar-cell"><div class="bar" style="width:' + w + '%"></div><span>' + r.percent + '%</span></div></td></tr>';
      }).join('') || '<tr><td colspan="3" class="muted" style="text-align:center;padding:20px">暂无数据</td></tr>';
      // 国内城市
      const cityTb = document.getElementById('regions-cities-body');
      cityTb.innerHTML = (data.cities || []).slice(0, 30).map(function (r) {
        const w = Math.max(2, (r.visits / total) * 100);
        return '<tr><td class="mono">' + escapeHtml(r.region) + '·' + escapeHtml(r.city) + '</td><td>' + fmt(r.visits) + '</td><td><div class="bar-cell"><div class="bar" style="width:' + w + '%"></div><span>' + r.percent + '%</span></div></td></tr>';
      }).join('') || '<tr><td colspan="3" class="muted" style="text-align:center;padding:20px">暂无数据</td></tr>';
      // 海外
      const ovrTb = document.getElementById('regions-overseas-body');
      ovrTb.innerHTML = (data.overseas || []).slice(0, 20).map(function (r) {
        const w = Math.max(2, (r.visits / total) * 100);
        const label = escapeHtml(r.country) + '·' + escapeHtml(r.region || '—');
        return '<tr><td class="mono">' + label + '</td><td>' + fmt(r.visits) + '</td><td><div class="bar-cell"><div class="bar" style="width:' + w + '%"></div><span>' + r.percent + '%</span></div></td></tr>';
      }).join('') || '<tr><td colspan="3" class="muted" style="text-align:center;padding:20px">暂无数据</td></tr>';
    }

    function renderChinaMap(data) {
      const el = document.getElementById('china-map');
      if (!el) return;
      if (!chinaMapChart) {
        chinaMapChart = echarts.init(el);
      }
      const provinces = data.provinces || [];
      const maxVisits = provinces.length > 0 ? provinces[0].visits : 1;
      chinaMapChart.setOption({
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
          data: provinces.map(function (p) {
            return { name: p.region, value: p.visits };
          })
        }]
      });
    }

    // scope 切换按钮
    document.addEventListener('click', function (e) {
      if (e.target.dataset.regionsScope) {
        regionsScope = e.target.dataset.regionsScope;
        document.querySelectorAll('[data-regions-scope]').forEach(function (b) { b.classList.remove('active'); });
        e.target.classList.add('active');
        loadRegionsTab();
      }
    });

```

- [ ] **Step 2: 在 nav-tabs 的 click 事件里加 regions 懒加载**

在 `worker/assets/admin.html` 中找到 nav-tabs 的 click 监听（约第 1565-1579 行）：

```javascript
    document.getElementById('nav-tabs').addEventListener('click', function (e) {
      const btn = e.target.closest('.nav-tab');
      if (!btn) return;
      const tab = btn.dataset.tab;
      document.querySelectorAll('.nav-tab').forEach(function (t) { t.classList.remove('active'); });
      btn.classList.add('active');
      document.querySelectorAll('.tab-content').forEach(function (s) { s.classList.remove('active'); });
      document.getElementById('tab-' + tab).classList.add('active');
      // 懒加载
      if (tab === 'visits') loadVisitsTab();
      else if (tab === 'tests') loadTestsTab();
      else if (tab === 'types') loadTypesTab();
      else if (tab === 'sessions') loadSessionsTab();
      else if (tab === 'heatmap') loadHeatmapTab();
    });
```

在 `else if (tab === 'heatmap') loadHeatmapTab();` 之后插入：

```javascript
      else if (tab === 'regions') loadRegionsTab();
```

- [ ] **Step 3: 在 startRefresh 函数里加 regions 自动刷新**

在 `worker/assets/admin.html` 中找到 `startRefresh` 函数（约第 1854-1873 行）：

```javascript
    function startRefresh() {
      stopRefresh();
      refreshTimer = setInterval(function () {
        const active = document.querySelector('.tab-content.active');
        if (!active) return;
        const id = active.id.replace('tab-', '');
        if (id === 'overview') loadOverview();
        else if (id === 'visits') loadVisitsTab();
        else if (id === 'tests') loadTestsTab();
        else if (id === 'types') loadTypesTab();
        else if (id === 'sessions') loadSessionsTab();
        else if (id === 'heatmap') loadHeatmapTab();
      }, REFRESH_INTERVAL);
```

在 `else if (id === 'heatmap') loadHeatmapTab();` 之后插入：

```javascript
        else if (id === 'regions') loadRegionsTab();
```

- [ ] **Step 4: 在 refresh-btn 的 click 事件里加 regions**

在 `worker/assets/admin.html` 中找到 refresh-btn 的 click 监听（约第 1884-1895 行）：

```javascript
    document.getElementById('refresh-btn').addEventListener('click', function () {
      const active = document.querySelector('.tab-content.active');
      if (!active) return;
      const id = active.id.replace('tab-', '');
      if (id === 'overview') loadOverview();
      else if (id === 'visits') loadVisitsTab();
      else if (id === 'tests') loadTestsTab();
      else if (id === 'types') loadTypesTab();
      else if (id === 'sessions') loadSessionsTab();
      else if (id === 'heatmap') loadHeatmapTab();
      toast('已刷新');
    });
```

在 `else if (id === 'heatmap') loadHeatmapTab();` 之后插入：

```javascript
      else if (id === 'regions') loadRegionsTab();
```

- [ ] **Step 5: 验证 HTML 结构**

Run: `cd d:\trae\worker\assets && node -e "const fs=require('fs');const h=fs.readFileSync('admin.html','utf8');const o=(h.match(/<div/g)||[]).length;const c=(h.match(/<\/div>/g)||[]).length;console.log('div open:',o,'close:',c, o===c?'OK':'MISMATCH');"`
Expected: `div open: N close: N OK`

- [ ] **Step 6: Commit**

```bash
git add worker/assets/admin.html
git commit -m "feat(admin): implement regions tab JS logic with echarts map"
```

---

### Task 13: 扩展 test/worker-test.js 加 schema + 9 个新测试用例

**Files:**
- Modify: `test/worker-test.js`

- [ ] **Step 1: 在 SCHEMA 常量里加 region/city 列**

在 `test/worker-test.js` 中找到 `SCHEMA` 常量定义（约第 1944-1958 行）：

```javascript
const SCHEMA = `
CREATE TABLE IF NOT EXISTS counts (type TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0);
INSERT OR IGNORE INTO counts (type, count) VALUES ('S-F-R-Re', 0),('HYBRID', 0);
CREATE TABLE IF NOT EXISTS visits (key TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0, updated_at TEXT);
INSERT OR IGNORE INTO visits (key, count, updated_at) VALUES ('total', 0, datetime('now'));
INSERT OR IGNORE INTO visits (key, count, updated_at) VALUES ('admin_pw_version', 0, datetime('now'));
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL, ts_hour TEXT NOT NULL, ts_date_bj TEXT NOT NULL,
  event_type TEXT NOT NULL, page TEXT NOT NULL, type TEXT,
  session_id TEXT, referrer TEXT, ua TEXT, country TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_type_date ON events(event_type, ts_date_bj);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
`;
```

整体替换为：

```javascript
const SCHEMA = `
CREATE TABLE IF NOT EXISTS counts (type TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0);
INSERT OR IGNORE INTO counts (type, count) VALUES ('S-F-R-Re', 0),('HYBRID', 0);
CREATE TABLE IF NOT EXISTS visits (key TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0, updated_at TEXT);
INSERT OR IGNORE INTO visits (key, count, updated_at) VALUES ('total', 0, datetime('now'));
INSERT OR IGNORE INTO visits (key, count, updated_at) VALUES ('admin_pw_version', 0, datetime('now'));
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL, ts_hour TEXT NOT NULL, ts_date_bj TEXT NOT NULL,
  event_type TEXT NOT NULL, page TEXT NOT NULL, type TEXT,
  session_id TEXT, referrer TEXT, ua TEXT, country TEXT,
  region TEXT, city TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_type_date ON events(event_type, ts_date_bj);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
CREATE INDEX IF NOT EXISTS idx_events_region_date ON events(region, ts_date_bj);
CREATE INDEX IF NOT EXISTS idx_events_city_date ON events(city, ts_date_bj);
`;
```

- [ ] **Step 2: 在文件末尾追加 9 个新测试用例**

在 `test/worker-test.js` 文件末尾追加：

```javascript
// ========== 测试 11: /api/event 带 cf 写入 region/city ==========
test('POST /api/event with cf writes region/city', async function () {
  const r = await fetch('/api/event', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event_type: 'page_view', page: '/', session_id: 's_region1', referrer: '' }),
    cf: { country: 'CN', region: 'Guangdong', city: 'Shenzhen' }
  });
  assert.strictEqual(r.status, 200);
  const db = await mf.getD1Database('CPTI_DB');
  const rows = await db.prepare("SELECT country, region, city FROM events WHERE session_id='s_region1'").all();
  assert.strictEqual(rows.results.length, 1);
  assert.strictEqual(rows.results[0].country, 'CN');
  assert.strictEqual(rows.results[0].region, '广东');  // 映射后中文
  assert.strictEqual(rows.results[0].city, 'Shenzhen');
});

// ========== 测试 12: 中文映射失败兜底 ==========
test('POST /api/event with unknown CN region falls back to raw', async function () {
  const r = await fetch('/api/event', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event_type: 'page_view', page: '/', session_id: 's_region2', referrer: '' }),
    cf: { country: 'CN', region: 'UnknownProvince', city: 'TestCity' }
  });
  assert.strictEqual(r.status, 200);
  const db = await mf.getD1Database('CPTI_DB');
  const rows = await db.prepare("SELECT region FROM events WHERE session_id='s_region2'").all();
  assert.strictEqual(rows.results.length, 1);
  assert.strictEqual(rows.results[0].region, 'UnknownProvince');  // 兜底原值
});

// ========== 测试 13: 海外 region 不映射 ==========
test('POST /api/event with US region keeps English', async function () {
  const r = await fetch('/api/event', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event_type: 'page_view', page: '/', session_id: 's_region3', referrer: '' }),
    cf: { country: 'US', region: 'California', city: 'San Francisco' }
  });
  assert.strictEqual(r.status, 200);
  const db = await mf.getD1Database('CPTI_DB');
  const rows = await db.prepare("SELECT region, city FROM events WHERE session_id='s_region3'").all();
  assert.strictEqual(rows.results.length, 1);
  assert.strictEqual(rows.results[0].region, 'California');
  assert.strictEqual(rows.results[0].city, 'San Francisco');
});

// ========== 测试 14: 港澳台计入国内分组 ==========
test('POST /api/event with HK country treated as domestic', async function () {
  await fetch('/api/event', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event_type: 'page_view', page: '/', session_id: 's_hk', referrer: '' }),
    cf: { country: 'HK', region: 'Hong Kong', city: 'Hong Kong' }
  });
  // 登录拿 cookie
  const loginR = await fetch('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '9.9.9.9' },
    body: JSON.stringify({ password: 'test-pwd-123' })
  });
  const token = loginR.headers.get('Set-Cookie').match(/admin_session=([^;]+)/)[1];
  const r = await fetch('/api/admin/regions?scope=today', {
    headers: { 'Cookie': 'admin_session=' + token }
  });
  assert.strictEqual(r.status, 200);
  const data = await r.json();
  assert.strictEqual(data.summary.domestic_total, 1);  // HK 计入国内
  assert.strictEqual(data.summary.overseas_total, 0);
});

// ========== 测试 15: /api/admin/regions 返回结构正确 ==========
test('GET /api/admin/regions?scope=today returns correct structure', async function () {
  // 先准备数据：3 个国内 session + 1 个海外 session
  await fetch('/api/event', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event_type: 'page_view', page: '/', session_id: 's_a', referrer: '' }),
    cf: { country: 'CN', region: 'Beijing', city: 'Beijing' }
  });
  await fetch('/api/event', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event_type: 'page_view', page: '/', session_id: 's_b', referrer: '' }),
    cf: { country: 'CN', region: 'Beijing', city: 'Beijing' }
  });
  await fetch('/api/event', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event_type: 'page_view', page: '/', session_id: 's_c', referrer: '' }),
    cf: { country: 'CN', region: 'Shanghai', city: 'Shanghai' }
  });
  await fetch('/api/event', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event_type: 'page_view', page: '/', session_id: 's_d', referrer: '' }),
    cf: { country: 'US', region: 'California', city: 'San Francisco' }
  });
  // 登录
  const loginR = await fetch('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '8.8.8.8' },
    body: JSON.stringify({ password: 'test-pwd-123' })
  });
  const token = loginR.headers.get('Set-Cookie').match(/admin_session=([^;]+)/)[1];
  const r = await fetch('/api/admin/regions?scope=today', {
    headers: { 'Cookie': 'admin_session=' + token }
  });
  assert.strictEqual(r.status, 200);
  const data = await r.json();
  assert.strictEqual(data.scope, 'today');
  assert.ok(Array.isArray(data.provinces));
  assert.ok(Array.isArray(data.cities));
  assert.ok(Array.isArray(data.overseas));
  assert.ok(data.summary);
  // 北京应排第一（2 个 session）
  assert.strictEqual(data.provinces[0].region, '北京');
  assert.strictEqual(data.provinces[0].visits, 2);
});

// ========== 测试 16: session 去重 - 同 session 多次访问只算 1 次 ==========
test('regions ranking deduplicates by session_id', async function () {
  // 同一 session 发 3 次 page_view
  for (let i = 0; i < 3; i++) {
    await fetch('/api/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event_type: 'page_view', page: '/page' + i, session_id: 's_dedup', referrer: '' }),
      cf: { country: 'CN', region: 'Tianjin', city: 'Tianjin' }
    });
  }
  const loginR = await fetch('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '7.7.7.7' },
    body: JSON.stringify({ password: 'test-pwd-123' })
  });
  const token = loginR.headers.get('Set-Cookie').match(/admin_session=([^;]+)/)[1];
  const r = await fetch('/api/admin/regions?scope=today', {
    headers: { 'Cookie': 'admin_session=' + token }
  });
  const data = await r.json();
  const tj = data.provinces.find(function (p) { return p.region === '天津'; });
  assert.ok(tj, 'should have 天津 in provinces');
  assert.strictEqual(tj.visits, 1, 'should count as 1 despite 3 page_views');  // 去重
});

// ========== 测试 17: scope=cumulative&days=7 范围正确 ==========
test('GET /api/admin/regions?scope=cumulative&days=7 returns range', async function () {
  const loginR = await fetch('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '6.6.6.6' },
    body: JSON.stringify({ password: 'test-pwd-123' })
  });
  const token = loginR.headers.get('Set-Cookie').match(/admin_session=([^;]+)/)[1];
  const r = await fetch('/api/admin/regions?scope=cumulative&days=7', {
    headers: { 'Cookie': 'admin_session=' + token }
  });
  assert.strictEqual(r.status, 200);
  const data = await r.json();
  assert.strictEqual(data.scope, 'cumulative');
  assert.ok(Array.isArray(data.date_range));
  assert.strictEqual(data.date_range.length, 2);
});

// ========== 测试 18: 无 cf 对象时 region/city 为 NULL ==========
test('POST /api/event without cf writes NULL region/city', async function () {
  const r = await fetch('/api/event', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event_type: 'page_view', page: '/', session_id: 's_nocf', referrer: '' })
    // 故意不传 cf
  });
  assert.strictEqual(r.status, 200);
  const db = await mf.getD1Database('CPTI_DB');
  const rows = await db.prepare("SELECT country, region, city FROM events WHERE session_id='s_nocf'").all();
  assert.strictEqual(rows.results.length, 1);
  assert.strictEqual(rows.results[0].country, null);
  assert.strictEqual(rows.results[0].region, null);
  assert.strictEqual(rows.results[0].city, null);
});

// ========== 测试 19: NULL country 计入 unknown_total ==========
test('events with NULL country counted in unknown_total', async function () {
  // 写一条无 cf 的（country 为 NULL）
  await fetch('/api/event', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event_type: 'page_view', page: '/', session_id: 's_unknown_country', referrer: '' })
  });
  const loginR = await fetch('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '5.5.5.5' },
    body: JSON.stringify({ password: 'test-pwd-123' })
  });
  const token = loginR.headers.get('Set-Cookie').match(/admin_session=([^;]+)/)[1];
  const r = await fetch('/api/admin/regions?scope=today', {
    headers: { 'Cookie': 'admin_session=' + token }
  });
  const data = await r.json();
  assert.ok(data.summary.unknown_total >= 1, 'unknown_total should be >= 1');
});

// ========== 测试 20: /api/record 也写入 region/city ==========
test('POST /api/record writes region/city to events', async function () {
  const r = await fetch('/api/record?type=HYBRID', {
    method: 'POST',
    cf: { country: 'CN', region: 'Zhejiang', city: 'Hangzhou' }
  });
  assert.strictEqual(r.status, 200);
  const db = await mf.getD1Database('CPTI_DB');
  const rows = await db.prepare("SELECT country, region, city FROM events WHERE event_type='test_completed' AND type='HYBRID' AND region IS NOT NULL ORDER BY id DESC LIMIT 1").all();
  assert.ok(rows.results.length >= 1);
  const last = rows.results[0];
  assert.strictEqual(last.country, 'CN');
  assert.strictEqual(last.region, '浙江');
  assert.strictEqual(last.city, 'Hangzhou');
});
```

- [ ] **Step 3: 运行所有测试**

Run: `cd d:\trae && node --test test/worker-test.js`
Expected: 20 个测试全部 PASS（原 10 个 + 新 10 个）

如果某些测试因 Miniflare 版本差异失败（如 cf 入参传递方式不同），检查 Miniflare 文档调整 `dispatchFetch` 调用方式，但保持断言不变。

- [ ] **Step 4: Commit**

```bash
git add test/worker-test.js
git commit -m "test(worker): add 10 region-related test cases"
```

---

### Task 14: 部署到 Cloudflare 并验证

**Files:**
- 无（部署 + 验证步骤）

- [ ] **Step 1: 执行 D1 schema 迁移**

Run: `cd d:\trae\worker && npx wrangler d1 execute cpti-stats-db --remote --file=schema-regions.sql`
Expected: 输出 "Executed N queries" 无错误；events 表新增 region 和 city 列

- [ ] **Step 2: 部署 Worker**

Run: `cd d:\trae\worker && npx wrangler deploy`
Expected: 显示部署成功 + URL `https://stats.generative-jurisprudence.top`

- [ ] **Step 3: 验证 /china.json 可访问**

浏览器打开 `https://stats.generative-jurisprudence.top/china.json`
Expected: 返回 JSON，Content-Type: application/json，包含 34 个 features

- [ ] **Step 4: 验证 admin dashboard「地域」Tab**

浏览器打开 `https://stats.generative-jurisprudence.top/admin` → 登录 → 切到「地域」Tab
Expected:
- 显示 KPI 卡（国内访问 / 海外访问 / 未知地域）
- 显示中国地图热力图（按省份着色）
- 显示三张表格（国内省份 Top 20 / 国内城市 Top 30 / 海外国家/地区 Top 20）
- "今日"/"累计（30 天）"切换按钮可正常切换

- [ ] **Step 5: 验证新数据写入**

访问主站 `https://generative-jurisprudence.top/` 几次后，回到 admin dashboard 刷新「地域」Tab
Expected: 今日访问数 +1，国内省份/城市排行出现新数据

- [ ] **Step 6: 验证老数据兼容**

确认 events 表中 ALTER 之前的老行 region/city=NULL，不影响 admin 其他 Tab 功能
Expected: 现有 6 个 Tab 数据显示正常

- [ ] **Step 7: Commit 最终状态**

```bash
git add -A
git commit -m "chore: deploy admin regions feature v3.1"
```

---

## Self-Review 检查

### 1. Spec 覆盖

| Spec 章节 | 覆盖任务 |
|---|---|
| 数据模型 - schema-regions.sql | Task 1 ✓ |
| 数据模型 - REGION_CN_MAP + normalizeRegion | Task 2 ✓ |
| 后端 API - insertEvent 扩列 | Task 3 ✓ |
| 后端 API - handleEvent 读 request.cf | Task 4 ✓ |
| 后端 API - handleRecord 读 request.cf | Task 5 ✓ |
| 后端 API - handleAdminRegions handler | Task 6 ✓ |
| 后端 API - 路由注册 | Task 7 ✓ |
| 数据模型 - china.json 资源 | Task 8 ✓ |
| 后端 API - serveChinaJson | Task 9 ✓ |
| 前端 UI - echarts CDN + 导航按钮 | Task 10 ✓ |
| 前端 UI - Tab 内容区 HTML + CSS | Task 11 ✓ |
| 前端 UI - JS 逻辑 + 懒加载 + 自动刷新 | Task 12 ✓ |
| 测试策略 - 9 个新测试用例 | Task 13 ✓ |
| 部署步骤 | Task 14 ✓ |
| 错误处理 | Task 4/5（NULL 兜底）+ Task 9（china.json 404）+ Task 12（地图加载失败） ✓ |
| 兼容性 | Task 1（ALTER 加列不破坏老数据）+ Task 14 Step 6（验证老数据） ✓ |

### 2. 占位符扫描

- Task 8 china.json 来源是真实 URL（echarts 官方 GitHub raw），无 TBD
- Task 11/12 的 HTML/JS 都包含完整代码，无 "类似 Task N"
- Task 13 测试代码完整，无 "add appropriate assertions"
- 无 "TODO" / "稍后实现" 残留

### 3. 类型一致性

- `REGION_CN_MAP` 在 Task 2 定义，Task 2 的 `normalizeRegion` 调用 ✓
- `normalizeRegion(rawRegion, country)` 在 Task 2 定义，Task 4/5 调用 ✓
- `DOMESTIC_COUNTRIES` 在 Task 2 定义，Task 6 调用 ✓
- `insertEvent(env, ctx, payload)` 在 Task 3 扩展，Task 4/5 调用，参数名一致（`region`, `city`） ✓
- `handleAdminRegions(request, env, ctx)` 在 Task 6 定义，Task 7 路由注册 ✓
- `serveChinaJson(env)` 在 Task 9 定义，Task 9 路由注册 ✓
- 前端 `loadRegionsTab()` 在 Task 12 定义，Task 12 懒加载/自动刷新/手动刷新三处调用 ✓
- `renderChinaMap(data)` / `renderRegionTables(data)` 在 Task 12 定义并调用 ✓
- `ensureChinaMap()` 在 Task 12 定义并调用 ✓

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-07-28-admin-regions.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
