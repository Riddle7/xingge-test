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
  "CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, ts_hour TEXT NOT NULL, ts_date_bj TEXT NOT NULL, event_type TEXT NOT NULL, page TEXT NOT NULL, type TEXT, session_id TEXT, referrer TEXT, ua TEXT, country TEXT)",
  "CREATE INDEX IF NOT EXISTS idx_events_type_date ON events(event_type, ts_date_bj)",
  "CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id)"
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
  const beforeEv = await (await mf.getD1Database('CPTI_DB')).prepare("SELECT COUNT(*) AS c FROM events WHERE event_type='page_view' AND page='/'").first();
  const r = await fetch('/api/visit', { method: 'POST' });
  assert.strictEqual(r.status, 200);
  const afterEv = await (await mf.getD1Database('CPTI_DB')).prepare("SELECT COUNT(*) AS c FROM events WHERE event_type='page_view' AND page='/'").first();
  // events 表中 page='/' 的行数不变（除非 tracking.js 调用 /api/event）
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
  // 先登录拿 cookie
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
