// test/worker-test.js
// 使用 Miniflare 模拟 D1 + Worker，覆盖鉴权/双写/去重/限流
const { Miniflare } = require('miniflare');
const assert = require('node:assert');
const { test, before, after } = require('node:test');

const SCHEMA_STATEMENTS = [
  "CREATE TABLE IF NOT EXISTS counts (type TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0)",
  "INSERT OR IGNORE INTO counts (type, count) VALUES ('S-F-R-Re', 0),('HYBRID', 0)",
  "CREATE TABLE IF NOT EXISTS visits (key TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0, updated_at TEXT)",
  "INSERT OR IGNORE INTO visits (key, count, updated_at) VALUES ('total', 0, datetime('now'))",
  "INSERT OR IGNORE INTO visits (key, count, updated_at) VALUES ('admin_pw_version', 0, datetime('now'))",
  // events 表含 region/city 列（与 worker/schema-regions.sql 对齐）
  "CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, ts_hour TEXT NOT NULL, ts_date_bj TEXT NOT NULL, event_type TEXT NOT NULL, page TEXT NOT NULL, type TEXT, session_id TEXT, referrer TEXT, ua TEXT, country TEXT, region TEXT, city TEXT)",
  "CREATE INDEX IF NOT EXISTS idx_events_type_date ON events(event_type, ts_date_bj)",
  "CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id)",
  // 地域查询索引
  "CREATE INDEX IF NOT EXISTS idx_events_region_date ON events(region, ts_date_bj)",
  "CREATE INDEX IF NOT EXISTS idx_events_city_date ON events(city, ts_date_bj)"
];

let mf;

before(async function () {
  mf = new Miniflare({
    modules: true,
    scriptPath: 'worker/stats.js',
    script: require('fs').readFileSync('worker/stats.js', 'utf8'),
    d1Databases: ['CPTI_DB'],
    bindings: {
      ADMIN_PASSWORD: 'test-pwd-123'
    }
  });
  const db = await mf.getD1Database('CPTI_DB');
  for (const sql of SCHEMA_STATEMENTS) {
    await db.prepare(sql).run();
  }
});

after(async function () {
  if (mf) await mf.dispose();
});

async function fetch(path, opts) {
  opts = opts || {};
  const url = 'http://localhost' + path;
  return await mf.dispatchFetch(url, opts);
}

// ========== 测试 1: /api/event 写入 events 表 ==========
test('POST /api/event writes page_view to events', async function () {
  const r = await fetch('/api/event', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event_type: 'page_view', page: '/', session_id: 's_test1', referrer: '' })
  });
  assert.strictEqual(r.status, 200);
  const data = await r.json();
  assert.strictEqual(data.success, true);
  // 校验 events 表
  const db = await mf.getD1Database('CPTI_DB');
  const rows = await db.prepare("SELECT * FROM events WHERE session_id='s_test1'").all();
  assert.strictEqual(rows.results.length, 1);
  assert.strictEqual(rows.results[0].event_type, 'page_view');
  assert.strictEqual(rows.results[0].page, '/');
});

// ========== 测试 2: /api/record 双写 counts + events ==========
test('POST /api/record dual-writes counts and events', async function () {
  const r = await fetch('/api/record?type=HYBRID', { method: 'POST' });
  assert.strictEqual(r.status, 200);
  const data = await r.json();
  assert.strictEqual(data.success, true);
  assert.strictEqual(data.count, 1);
  // 校验 events 表新增 test_completed 行
  const db = await mf.getD1Database('CPTI_DB');
  const ev = await db.prepare("SELECT * FROM events WHERE event_type='test_completed' AND type='HYBRID'").all();
  assert.strictEqual(ev.results.length, 1);
  assert.strictEqual(ev.results[0].page, '/cpti/');
});

// ========== 测试 3: /api/visit 不写 events ==========
test('POST /api/visit only writes visits table, not events', async function () {
  const db = await mf.getD1Database('CPTI_DB');
  const beforeEv = await db.prepare("SELECT COUNT(*) AS c FROM events").first();
  const beforeVisit = await db.prepare("SELECT count FROM visits WHERE key='total'").first();
  const r = await fetch('/api/visit', { method: 'POST' });
  assert.strictEqual(r.status, 200);
  const afterEv = await db.prepare("SELECT COUNT(*) AS c FROM events").first();
  const afterVisit = await db.prepare("SELECT count FROM visits WHERE key='total'").first();
  // visits 表 total 行 +1（证明确实写入 visits 表）
  assert.strictEqual((afterVisit?.count || 0), (beforeVisit?.count || 0) + 1);
  // events 表行数不变（证明未双写 events）
  assert.strictEqual(beforeEv.c, afterEv.c);
});

// ========== 测试 4: login 密码正确下发 cookie ==========
test('POST /api/admin/login with correct password sets cookie', async function () {
  const r = await fetch('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'test-pwd-123' })
  });
  assert.strictEqual(r.status, 200);
  const data = await r.json();
  assert.strictEqual(data.success, true);
  const setCookie = r.headers.get('Set-Cookie');
  assert.ok(setCookie && setCookie.includes('admin_session='));
  assert.ok(setCookie.includes('HttpOnly'));
  assert.ok(setCookie.includes('Secure'));
});

// ========== 测试 5: login 密码错误返回 401 ==========
test('POST /api/admin/login with wrong password returns 401', async function () {
  const r = await fetch('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'wrong' })
  });
  assert.strictEqual(r.status, 401);
  const data = await r.json();
  assert.strictEqual(data.success, false);
  assert.strictEqual(data.code, 'INVALID_PASSWORD');
});

// ========== 测试 6: login 失败 5 次后第 6 次 429 ==========
test('login rate limit: 6th attempt returns 429', async function () {
  for (let i = 0; i < 5; i++) {
    await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' },
      body: JSON.stringify({ password: 'wrong' })
    });
  }
  const r6 = await fetch('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' },
    body: JSON.stringify({ password: 'wrong' })
  });
  assert.strictEqual(r6.status, 429);
});

// ========== 测试 7: admin API 无 cookie 返回 401 ==========
test('GET /api/admin/overview without cookie returns 401', async function () {
  const r = await fetch('/api/admin/overview');
  assert.strictEqual(r.status, 401);
});

// ========== 测试 8: admin API 有效 cookie 返回数据 ==========
test('GET /api/admin/overview with valid cookie returns data', async function () {
  // 用独立 IP（5.6.7.8）避开测试 6 残留的限流累积
  const loginR = await fetch('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '5.6.7.8' },
    body: JSON.stringify({ password: 'test-pwd-123' })
  });
  const setCookie = loginR.headers.get('Set-Cookie');
  const cookieMatch = setCookie.match(/admin_session=([^;]+)/);
  const token = cookieMatch[1];
  // 用 cookie 调 overview
  const r = await fetch('/api/admin/overview', {
    headers: { 'Cookie': 'admin_session=' + token }
  });
  assert.strictEqual(r.status, 200);
  const data = await r.json();
  assert.ok(data.today);
  assert.ok(data.total);
  assert.ok(Array.isArray(data.trend_30d));
});

// ========== 测试 9: /api/event 缺字段返回 400 ==========
test('POST /api/event with missing fields returns 400', async function () {
  const r = await fetch('/api/event', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });
  assert.strictEqual(r.status, 400);
  const data = await r.json();
  assert.strictEqual(data.code, 'INVALID_PARAMS');
});

// ========== 测试 10: /api/record 无效 type 返回 400 ==========
test('POST /api/record with invalid type returns 400', async function () {
  const r = await fetch('/api/record?type=INVALID', { method: 'POST' });
  assert.strictEqual(r.status, 400);
});

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
  assert.strictEqual(rows.results[0].region, '广东省');  // 映射后带后缀
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
  // 清空 events，避免此前测试写入的 CN/US 事件影响 summary 计数
  const db = await mf.getD1Database('CPTI_DB');
  await db.prepare("DELETE FROM events").run();
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
  // 清空 events，确保本测试的省份排行结果可预测
  const db = await mf.getD1Database('CPTI_DB');
  await db.prepare("DELETE FROM events").run();
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
  assert.strictEqual(data.provinces[0].region, '北京市');
  assert.strictEqual(data.provinces[0].visits, 2);
});

// ========== 测试 16: session 去重 - 同 session 多次访问只算 1 次 ==========
test('regions ranking deduplicates by session_id', async function () {
  // 清空 events，确保只有本测试的 s_dedup 影响 天津市 计数
  const db = await mf.getD1Database('CPTI_DB');
  await db.prepare("DELETE FROM events").run();
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
  const tj = data.provinces.find(function (p) { return p.region === '天津市'; });
  assert.ok(tj, 'should have 天津市 in provinces');
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
  // Miniflare v4 即使不传 cf 也会注入默认的 request.cf（country='CN' 等），
  // 这里显式传空字符串模拟 cf 字段缺失；worker 用 truthy 判定，空串会被归一化为 NULL
  const r = await fetch('/api/event', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event_type: 'page_view', page: '/', session_id: 's_nocf', referrer: '' }),
    cf: { country: '', region: '', city: '' }
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
  // 清空 events，确保 unknown_total 主要来自本测试写入的 NULL country 事件
  const db = await mf.getD1Database('CPTI_DB');
  await db.prepare("DELETE FROM events").run();
  // 显式传空字符串 cf 模拟 country 缺失（Miniflare 默认会注入 'CN'）
  await fetch('/api/event', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event_type: 'page_view', page: '/', session_id: 's_unknown_country', referrer: '' }),
    cf: { country: '', region: '', city: '' }
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
  assert.strictEqual(last.region, '浙江省');
  assert.strictEqual(last.city, 'Hangzhou');
});
