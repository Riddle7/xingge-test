// CPTI 统计 Worker - 单文件后端
// 后端存储：Cloudflare D1（SQL 数据库，原子 UPDATE，免费 100k writes/day）
// 缓存层：  Cloudflare Cache API（边缘节点共享 L2，5 分钟 TTL）
// 部署：wrangler deploy

// 16 种合法人格代码（白名单） + 第 17 类 HYBRID（终极缝合怪）
const TYPES = [
  'S-F-R-Re','S-F-R-E','S-F-P-Re','S-F-P-E',
  'S-M-R-Re','S-M-R-E','S-M-P-Re','S-M-P-E',
  'O-F-R-Re','O-F-R-E','O-F-P-Re','O-F-P-E',
  'O-M-R-Re','O-M-R-E','O-M-P-Re','O-M-P-E',
  'HYBRID'
];

// 兼容无分隔符写法（SOFE 等）
const COMPACT_MAP = {
  'SFRRe':'S-F-R-Re','SFRE':'S-F-R-E','SFPRe':'S-F-P-Re','SFPE':'S-F-P-E',
  'SMRRe':'S-M-R-Re','SMRE':'S-M-R-E','SMPRe':'S-M-P-Re','SMPE':'S-M-P-E',
  'OFRRe':'O-F-R-Re','OFRE':'O-F-R-E','OFPRe':'O-F-P-Re','OFPE':'O-F-P-E',
  'OMRRe':'O-M-R-Re','OMRE':'O-M-R-E','OMPRe':'O-M-P-Re','OMPE':'O-M-P-E'
};

// CORS 头
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400'
};

// ============ 时间工具：北京时间桶 ============
// UTC 存储 ts，但 KPI 按北京日显示，预存桶字段避免 strftime 转换
function bjDateNow() {
  // 北京时间 = UTC+8；toISOString 返回 UTC，加 8 小时得北京
  const bj = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return bj.toISOString().slice(0, 10); // 'YYYY-MM-DD'
}
function bjHourNow() {
  const bj = new Date(Date.now() + 8 * 60 * 60 * 1000);
  // 'YYYY-MM-DDTHH'，注意 toISOString 返回 'YYYY-MM-DDTHH:MM:SS.xxxZ'，截到小时
  return bj.toISOString().slice(0, 13);
}
function bjDateFromIso(isoTs) {
  // 把任意 UTC ISO 时间转成北京日期
  const d = new Date(isoTs);
  const bj = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  return bj.toISOString().slice(0, 10);
}
function bjHourFromIso(isoTs) {
  const d = new Date(isoTs);
  const bj = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  return bj.toISOString().slice(0, 13);
}

// ============ events 表写入辅助 ============
// 写入一条事件到 events 表；调用方负责事务/缓存失效
async function insertEvent(env, ctx, payload) {
  // payload: { event_type, page, type?, session_id?, referrer?, ua?, country? }
  const now = new Date();
  const ts = now.toISOString();
  const tsHour = bjHourFromIso(ts);
  const tsDateBj = bjDateFromIso(ts);
  await env.CPTI_DB.prepare(
    'INSERT INTO events (ts, ts_hour, ts_date_bj, event_type, page, type, session_id, referrer, ua, country) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(
    ts, tsHour, tsDateBj,
    payload.event_type,
    payload.page,
    payload.type || null,
    payload.session_id || null,
    payload.referrer || null,
    payload.ua || null,
    payload.country || null
  ).run();
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS }
  });
}

// 归一化用户传入的 type 为标准 code
function normalizeType(raw) {
  if (!raw) return null;
  const t = raw.trim();
  if (TYPES.includes(t)) return t;
  if (COMPACT_MAP[t]) return COMPACT_MAP[t];
  // 带斜杠的复合代号（如 S/O-F/M-R/P-E/Re）归一化为 HYBRID
  if (t.includes('/')) return 'HYBRID';
  return null;
}

// ============ 单层缓存：L2 Cache API（边缘节点共享） ============
// Worker 免费版实例频繁回收，模块级内存缓存（L1）跨请求不稳定，
// 且 POST 后无法跨实例失效，会导致用户测完看不到自己的票。
// 因此只用 L2 Cache API：边缘节点共享，ctx.waitUntil(cache.delete) 可跨实例失效。
const STATS_CACHE_TTL = 5 * 60 * 1000; // 5 分钟
const CACHE_KEY_URL = 'https://cpti-stats.local/api/stats-cache';

async function getStatsCached(env, ctx) {
  // L2: Cache API（边缘节点共享）
  const cache = caches.default;
  const cacheReq = new Request(CACHE_KEY_URL);
  const cachedResp = await cache.match(cacheReq);
  if (cachedResp) {
    const data = await cachedResp.json();
    return { total: data.total, stats: data.stats, source: 'L2' };
  }

  // 未命中：读 D1（一次 SELECT 拿全部 17 行）
  const { results } = await env.CPTI_DB.prepare(
    'SELECT type, count FROM counts'
  ).all();

  const counts = {};
  let total = 0;
  for (const row of results) {
    counts[row.type] = row.count;
    total += row.count;
  }
  const stats = {};
  for (const t of TYPES) {
    const c = counts[t] || 0;
    const percent = total > 0 ? ((c / total) * 100).toFixed(1) : '0.0';
    stats[t] = { count: c, percent: percent };
  }

  // 写入 L2
  const respToCache = new Response(JSON.stringify({ total, stats }), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'max-age=300'
    }
  });
  ctx.waitUntil(cache.put(cacheReq, respToCache.clone()));

  return { total, stats, source: 'D1' };
}

// 写入后立即失效 L2：保证刚提交的用户能看到自己那一票
function invalidateStatsCache(ctx) {
  if (ctx && ctx.waitUntil) {
    const cache = caches.default;
    ctx.waitUntil(cache.delete(new Request(CACHE_KEY_URL)));
  }
}

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
  // session_id 从 query 读取（可选，cpti 页面如未传则为 null）
  const sessionId = url.searchParams.get('sid') || null;
  const referrer = request.headers.get('Referer') || null;
  const ua = request.headers.get('User-Agent') || null;
  const country = request.cf && request.cf.country ? request.cf.country : null;
  ctx.waitUntil(
    insertEvent(env, ctx, {
      event_type: 'test_completed',
      page: '/cpti/',
      type: type,
      session_id: sessionId,
      referrer: referrer,
      ua: ua,
      country: country
    }).catch(function (e) {
      console.error('events insert failed (test_completed):', e);
      // 静默失败：不影响用户主流程
    })
  );

  // 3. 失效 L2 缓存（counts 表）
  invalidateStatsCache(ctx);
  return json({ success: true, count: newCount, type: type });
}

// ============ 访客计数（总访问量 + 今日访问量） ============
// 数据模型：visits 表，单行 per key
//   'total'                 -> 累计总访问量
//   'today_<YYYY-MM-DD>'    -> 当日访问量（UTC 日期；每天一个新行，历史行保留不删）
// 缓存策略：与 stats 不同，访客数容忍短时不一致，使用 60 秒 L2 缓存

const VISITS_CACHE_TTL = 60 * 1000; // 60 秒
const VISITS_CACHE_URL = 'https://cpti-stats.local/api/visits-cache';

function getTodayUtcKey() {
  // UTC 日期作为 today key：UTC 00:00 切换（北京 08:00）
  return 'today_' + new Date().toISOString().slice(0, 10);
}

async function getVisitsCached(env, ctx) {
  const cache = caches.default;
  const cacheReq = new Request(VISITS_CACHE_URL);
  const cachedResp = await cache.match(cacheReq);
  if (cachedResp) {
    const data = await cachedResp.json();
    return { total: data.total, today: data.today, source: 'L2' };
  }

  const todayKey = getTodayUtcKey();
  // 并发查 total + today
  const [totalRow, todayRow] = await Promise.all([
    env.CPTI_DB.prepare("SELECT count FROM visits WHERE key = 'total'").first(),
    env.CPTI_DB.prepare('SELECT count FROM visits WHERE key = ?').bind(todayKey).first()
  ]);
  const total = totalRow ? totalRow.count : 0;
  const today = todayRow ? todayRow.count : 0;

  // 写入 L2（60s TTL）
  const respToCache = new Response(JSON.stringify({ total, today }), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'max-age=60'
    }
  });
  ctx.waitUntil(cache.put(cacheReq, respToCache.clone()));

  return { total, today, source: 'D1' };
}

function invalidateVisitsCache(ctx) {
  if (ctx && ctx.waitUntil) {
    const cache = caches.default;
    ctx.waitUntil(cache.delete(new Request(VISITS_CACHE_URL)));
  }
}

// POST /api/visit  -> 计一次访问（total +1, today +1，原子 UPSERT）
async function handleVisit(env, ctx) {
  const todayKey = getTodayUtcKey();
  const now = new Date().toISOString();

  // 批量原子 UPSERT：D1 batch 保证两个语句在同一事务里
  // total 行：已存在则 +1，不存在则插入 1
  // today 行：当天第一次访问时插入，之后 +1
  const stmts = [
    env.CPTI_DB.prepare(
      "INSERT INTO visits (key, count, updated_at) VALUES ('total', 1, ?) ON CONFLICT(key) DO UPDATE SET count = count + 1, updated_at = ?"
    ).bind(now, now),
    env.CPTI_DB.prepare(
      'INSERT INTO visits (key, count, updated_at) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = count + 1, updated_at = ?'
    ).bind(todayKey, now, now)
  ];
  await env.CPTI_DB.batch(stmts);

  // 失效 L2 缓存
  invalidateVisitsCache(ctx);
  return json({ success: true });
}

// GET /api/visits  -> { total, today }
async function handleVisits(env, ctx) {
  const result = await getVisitsCached(env, ctx);
  const body = JSON.stringify({ total: result.total, today: result.today });
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Cache-Source': result.source, // L2 / D1
      ...CORS_HEADERS
    }
  });
}

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
  const country = request.cf && request.cf.country ? request.cf.country : null;
  try {
    await insertEvent(env, ctx, {
      event_type: 'page_view',
      page: body.page,
      session_id: body.session_id || null,
      referrer: body.referrer || null,
      ua: ua,
      country: country
    });
  } catch (e) {
    console.error('events insert failed (page_view):', e);
    // 静默失败：tracking.js 不阻塞用户
    return json({ success: false, error: 'db error', code: 'DB_ERROR' }, 500);
  }
  return json({ success: true });
}

// GET /api/stats
async function handleStats(env, ctx) {
  const result = await getStatsCached(env, ctx);
  const body = JSON.stringify({ total: result.total, stats: result.stats });
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Cache-Source': result.source, // L2 / D1
      ...CORS_HEADERS
    }
  });
}

// ============ 鉴权中间件 ============
// Cookie 名：admin_session
// Session 存储：visits 表 key='admin_session_<uuid>', count=<pw_version>, updated_at=<last_access>
// 密码版本：visits 表 key='admin_pw_version', count=<整数>，改密码时 +1，使所有旧 session 失效
// 限流：visits 表 key='login_fail_<ip>', count=<失败次数>, updated_at=<首次失败时间>

const SESSION_COOKIE = 'admin_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天
const LOGIN_FAIL_LIMIT = 5;
const LOGIN_FAIL_WINDOW_MS = 15 * 60 * 1000; // 15 分钟

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  header.split(';').forEach(function (p) {
    const eq = p.indexOf('=');
    if (eq < 0) return;
    const k = p.slice(0, eq).trim();
    const v = p.slice(eq + 1).trim();
    out[k] = v;
  });
  return out;
}

function getClientIp(request) {
  return request.headers.get('cf-connecting-ip') ||
         request.headers.get('x-forwarded-for') ||
         'unknown';
}

// 校验 cookie 是否有效：session 存在 + 未过期 + pw_version 匹配
// 返回 { ok: true, token } 或 { ok: false }
async function verifySession(env, request) {
  const cookies = parseCookies(request.headers.get('Cookie'));
  const token = cookies[SESSION_COOKIE];
  if (!token) return { ok: false };

  const sessionKey = 'admin_session_' + token;
  const [sessionRow, pwVersionRow] = await Promise.all([
    env.CPTI_DB.prepare('SELECT count, updated_at FROM visits WHERE key = ?').bind(sessionKey).first(),
    env.CPTI_DB.prepare("SELECT count FROM visits WHERE key = 'admin_pw_version'").first()
  ]);
  if (!sessionRow || !pwVersionRow) return { ok: false };

  // 校验密码版本
  if (sessionRow.count !== pwVersionRow.count) return { ok: false };

  // 校验过期
  const updated = new Date(sessionRow.updated_at).getTime();
  if (Date.now() - updated > SESSION_TTL_MS) return { ok: false };

  // 续期（不阻塞响应）
  await env.CPTI_DB.prepare('UPDATE visits SET updated_at = ? WHERE key = ?')
    .bind(new Date().toISOString(), sessionKey).run();

  return { ok: true, token: token };
}

// 检查 login 失败限流；返回 { allowed: bool, retryAfterSec: int }
async function checkLoginRateLimit(env, ip) {
  const key = 'login_fail_' + ip;
  const row = await env.CPTI_DB.prepare('SELECT count, updated_at FROM visits WHERE key = ?').bind(key).first();
  if (!row) return { allowed: true };
  const firstFail = new Date(row.updated_at).getTime();
  if (Date.now() - firstFail > LOGIN_FAIL_WINDOW_MS) {
    // 窗口已过，重置
    await env.CPTI_DB.prepare('DELETE FROM visits WHERE key = ?').bind(key).run();
    return { allowed: true };
  }
  if (row.count >= LOGIN_FAIL_LIMIT) {
    const retryAfterSec = Math.ceil((LOGIN_FAIL_WINDOW_MS - (Date.now() - firstFail)) / 1000);
    return { allowed: false, retryAfterSec: retryAfterSec };
  }
  return { allowed: true };
}

// POST /api/admin/login { password }
async function handleLogin(request, env, ctx) {
  let body;
  try { body = await request.json(); } catch (e) {
    return json({ success: false, error: 'invalid json', code: 'INVALID_PARAMS' }, 400);
  }
  if (!body || typeof body.password !== 'string') {
    return json({ success: false, error: 'missing password', code: 'INVALID_PARAMS' }, 400);
  }

  const ip = getClientIp(request);

  // 检查限流
  const rl = await checkLoginRateLimit(env, ip);
  if (!rl.allowed) {
    return new Response(JSON.stringify({
      success: false,
      error: 'too many attempts, retry after ' + rl.retryAfterSec + 's',
      code: 'RATE_LIMITED'
    }), {
      status: 429,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Retry-After': String(rl.retryAfterSec)
      }
    });
  }

  // 校验密码
  const expected = env.ADMIN_PASSWORD;
  if (!expected || body.password !== expected) {
    // 记录失败
    const key = 'login_fail_' + ip;
    await env.CPTI_DB.prepare(
      "INSERT INTO visits (key, count, updated_at) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = count + 1, updated_at = ?"
    ).bind(key, new Date().toISOString(), new Date().toISOString()).run();
    return json({ success: false, error: 'invalid password', code: 'INVALID_PASSWORD' }, 401);
  }

  // 校验通过：生成 session
  const token = crypto.randomUUID();
  const pwVersionRow = await env.CPTI_DB.prepare("SELECT count FROM visits WHERE key = 'admin_pw_version'").first();
  const pwVersion = pwVersionRow ? pwVersionRow.count : 0;
  const now = new Date().toISOString();
  await env.CPTI_DB.prepare(
    "INSERT INTO visits (key, count, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET count = ?, updated_at = ?"
  ).bind('admin_session_' + token, pwVersion, now, pwVersion, now).run();

  // 清除该 IP 的失败计数
  await env.CPTI_DB.prepare('DELETE FROM visits WHERE key = ?').bind('login_fail_' + ip).run();

  const respBody = JSON.stringify({ success: true });
  return new Response(respBody, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': SESSION_COOKIE + '=' + token + '; HttpOnly; Secure; SameSite=Strict; Max-Age=604800; Path=/'
    }
  });
}

// POST /api/admin/logout
async function handleLogout(request, env, ctx) {
  const cookies = parseCookies(request.headers.get('Cookie'));
  const token = cookies[SESSION_COOKIE];
  if (token) {
    await env.CPTI_DB.prepare('DELETE FROM visits WHERE key = ?').bind('admin_session_' + token).run();
  }
  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': SESSION_COOKIE + '=; Max-Age=0; Path=/'
    }
  });
}

// 包装 admin handler：先校验 session，再调业务逻辑
async function withAuth(request, env, ctx, handler) {
  const session = await verifySession(env, request);
  if (!session.ok) {
    return json({ success: false, error: 'unauthorized', code: 'UNAUTHORIZED' }, 401);
  }
  return handler(request, env, ctx);
}

// ============ Admin API Handlers ============

// GET /api/admin/overview
async function handleAdminOverview(request, env, ctx) {
  const today = bjDateNow();
  const yesterday = bjDateFromIso(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
  const sevenDaysAgo = bjDateFromIso(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());
  const thirtyDaysAgo = bjDateFromIso(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());

  const [todayPV, todayTests, todaySessions, todayBounce,
         yesterdayPV, yesterdayTests,
         legacyVisits, countsSum,
         trend7d, trend30d] = await Promise.all([
    env.CPTI_DB.prepare(
      "SELECT COUNT(*) AS c FROM (SELECT DISTINCT session_id FROM events WHERE event_type='page_view' AND ts_date_bj=? AND session_id IS NOT NULL) UNION ALL SELECT COUNT(*) AS c FROM events WHERE event_type='page_view' AND ts_date_bj=? AND session_id IS NULL"
    ).bind(today, today).all(),
    env.CPTI_DB.prepare("SELECT COUNT(*) AS c FROM events WHERE event_type='test_completed' AND ts_date_bj=?").bind(today).first(),
    env.CPTI_DB.prepare("SELECT COUNT(DISTINCT session_id) AS c FROM events WHERE ts_date_bj=? AND session_id IS NOT NULL").bind(today).first(),
    env.CPTI_DB.prepare(
      "SELECT AVG(CASE WHEN cnt=1 THEN 1.0 ELSE 0.0 END) AS r FROM (SELECT session_id, COUNT(*) AS cnt FROM events WHERE ts_date_bj=? AND session_id IS NOT NULL GROUP BY session_id)"
    ).bind(today).first(),
    env.CPTI_DB.prepare(
      "SELECT (SELECT COUNT(*) FROM (SELECT DISTINCT session_id FROM events WHERE event_type='page_view' AND ts_date_bj=? AND session_id IS NOT NULL) UNION ALL SELECT COUNT(*) FROM events WHERE event_type='page_view' AND ts_date_bj=? AND session_id IS NULL) AS c"
    ).bind(yesterday, yesterday).first(),
    env.CPTI_DB.prepare("SELECT COUNT(*) AS c FROM events WHERE event_type='test_completed' AND ts_date_bj=?").bind(yesterday).first(),
    env.CPTI_DB.prepare("SELECT count FROM visits WHERE key='total'").first(),
    env.CPTI_DB.prepare("SELECT SUM(count) AS c FROM counts").first(),
    env.CPTI_DB.prepare(
      "SELECT ts_date_bj AS d, SUM(CASE WHEN event_type='page_view' THEN 1 ELSE 0 END) AS v, SUM(CASE WHEN event_type='test_completed' THEN 1 ELSE 0 END) AS t FROM events WHERE ts_date_bj >= ? GROUP BY ts_date_bj ORDER BY ts_date_bj"
    ).bind(sevenDaysAgo).all(),
    env.CPTI_DB.prepare(
      "SELECT ts_date_bj AS d, SUM(CASE WHEN event_type='page_view' THEN 1 ELSE 0 END) AS v, SUM(CASE WHEN event_type='test_completed' THEN 1 ELSE 0 END) AS t FROM events WHERE ts_date_bj >= ? GROUP BY ts_date_bj ORDER BY ts_date_bj"
    ).bind(thirtyDaysAgo).all()
  ]);

  const todayVisits = (todayPV.results[0]?.c || 0) + (todayPV.results[1]?.c || 0);
  const todayTestsN = todayTests?.c || 0;
  const todaySess = todaySessions?.c || 0;
  const bounce = todayBounce?.r || 0;
  const yesterdayVisits = yesterdayPV?.c || 0;
  const yesterdayTestsN = yesterdayTests?.c || 0;
  const totalVisits = legacyVisits?.count || 0;
  const totalTests = countsSum?.c || 0;

  const fmtTrend = function (rows) {
    return (rows.results || []).map(function (r) {
      return { date: r.d, visits: r.v, tests: r.t };
    });
  };

  return json({
    today: {
      date: today,
      visits: todayVisits,
      tests: todayTestsN,
      unique_sessions: todaySess,
      bounce_rate: Math.round(bounce * 100) / 100
    },
    yesterday: {
      date: yesterday,
      visits: yesterdayVisits,
      tests: yesterdayTestsN
    },
    total: {
      visits: totalVisits,
      tests: totalTests,
      legacy_visits: totalVisits,
      legacy_tests: totalTests
    },
    trend_7d: fmtTrend(trend7d),
    trend_30d: fmtTrend(trend30d)
  });
}

// GET /api/admin/timeseries?days=30&metric=both
async function handleAdminTimeseries(request, env, ctx) {
  const url = new URL(request.url);
  const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '30', 10), 1), 90);
  const metric = url.searchParams.get('metric') || 'both';
  const sinceDate = bjDateFromIso(new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString());

  const { results } = await env.CPTI_DB.prepare(
    "SELECT ts_date_bj AS d, SUM(CASE WHEN event_type='page_view' THEN 1 ELSE 0 END) AS v, SUM(CASE WHEN event_type='test_completed' THEN 1 ELSE 0 END) AS t FROM events WHERE ts_date_bj >= ? GROUP BY ts_date_bj ORDER BY ts_date_bj"
  ).bind(sinceDate).all();

  const points = (results || []).map(function (r) {
    const p = { date: r.d };
    if (metric === 'visits' || metric === 'both') p.visits = r.v;
    if (metric === 'tests' || metric === 'both') p.tests = r.t;
    return p;
  });
  return json({ days: days, points: points });
}

// GET /api/admin/hourly?date=today
async function handleAdminHourly(request, env, ctx) {
  const url = new URL(request.url);
  const dateParam = url.searchParams.get('date') || 'today';
  let date;
  if (dateParam === 'today') date = bjDateNow();
  else if (dateParam === 'yesterday') date = bjDateFromIso(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
  else date = dateParam;

  const { results } = await env.CPTI_DB.prepare(
    "SELECT substr(ts_hour, 12, 2) AS h, event_type, COUNT(*) AS c FROM events WHERE ts_date_bj=? GROUP BY h, event_type"
  ).bind(date).all();

  const visits = new Array(24).fill(0);
  const tests = new Array(24).fill(0);
  (results || []).forEach(function (r) {
    const idx = parseInt(r.h, 10);
    if (idx >= 0 && idx < 24) {
      if (r.event_type === 'page_view') visits[idx] = r.c;
      else if (r.event_type === 'test_completed') tests[idx] = r.c;
    }
  });
  return json({
    date: date,
    hours: Array.from({ length: 24 }, function (_, i) { return i; }),
    visits: visits,
    tests: tests
  });
}

// GET /api/admin/pages?days=30&limit=20
async function handleAdminPages(request, env, ctx) {
  const url = new URL(request.url);
  const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '30', 10), 1), 90);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '20', 10), 1), 100);
  const sinceDate = bjDateFromIso(new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString());

  const { results } = await env.CPTI_DB.prepare(
    "SELECT page, COUNT(DISTINCT session_id) AS v FROM events WHERE event_type='page_view' AND ts_date_bj >= ? AND session_id IS NOT NULL GROUP BY page ORDER BY v DESC LIMIT ?"
  ).bind(sinceDate, limit).all();

  const totalVisits = (results || []).reduce(function (s, r) { return s + r.v; }, 0);
  const pages = (results || []).map(function (r) {
    return {
      page: r.page,
      visits: r.v,
      percent: totalVisits > 0 ? Math.round((r.v / totalVisits) * 1000) / 10 : 0
    };
  });
  return json({ pages: pages, total_visits: totalVisits });
}

// GET /api/admin/types?date=today
async function handleAdminTypes(request, env, ctx) {
  const url = new URL(request.url);
  const dateParam = url.searchParams.get('date') || 'today';
  let date;
  if (dateParam === 'today') date = bjDateNow();
  else if (dateParam === 'yesterday') date = bjDateFromIso(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
  else date = dateParam;

  const [todayRows, cumulRows] = await Promise.all([
    env.CPTI_DB.prepare(
      "SELECT type, COUNT(*) AS c FROM events WHERE event_type='test_completed' AND ts_date_bj=? GROUP BY type ORDER BY c DESC"
    ).bind(date).all(),
    env.CPTI_DB.prepare("SELECT type, count FROM counts").all()
  ]);

  const todayTotal = (todayRows.results || []).reduce(function (s, r) { return s + r.c; }, 0);
  const cumulTotal = (cumulRows.results || []).reduce(function (s, r) { return s + r.count; }, 0);

  const distribution = (todayRows.results || []).map(function (r) {
    return {
      type: r.type,
      count: r.c,
      percent: todayTotal > 0 ? Math.round((r.c / todayTotal) * 1000) / 10 : 0
    };
  });
  const cumulative = (cumulRows.results || []).map(function (r) {
    return {
      type: r.type,
      count: r.count,
      percent: cumulTotal > 0 ? Math.round((r.count / cumulTotal) * 1000) / 10 : 0
    };
  }).sort(function (a, b) { return b.count - a.count; });

  return json({
    date: date,
    total: todayTotal,
    distribution: distribution,
    cumulative: cumulative,
    cumulative_total: cumulTotal
  });
}

// GET /api/admin/heatmap?days=7
async function handleAdminHeatmap(request, env, ctx) {
  const url = new URL(request.url);
  const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '7', 10), 1), 30);
  const sinceDate = bjDateFromIso(new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString());

  const { results } = await env.CPTI_DB.prepare(
    "SELECT ts_date_bj AS d, substr(ts_hour, 12, 2) AS h, COUNT(*) AS c FROM events WHERE event_type='page_view' AND ts_date_bj >= ? GROUP BY d, h"
  ).bind(sinceDate).all();

  const matrix = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = bjDateFromIso(new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString());
    const row = new Array(24).fill(0);
    (results || []).forEach(function (r) {
      if (r.d === d) {
        const idx = parseInt(r.h, 10);
        if (idx >= 0 && idx < 24) row[idx] = r.c;
      }
    });
    matrix.push(row);
  }
  const max = matrix.reduce(function (m, row) {
    return Math.max(m, row.reduce(function (mr, v) { return Math.max(mr, v); }, 0));
  }, 0);
  return json({ days: days, matrix: matrix, max: max });
}

// GET /api/admin/sessions?days=7&limit=100
async function handleAdminSessions(request, env, ctx) {
  const url = new URL(request.url);
  const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '7', 10), 1), 30);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '100', 10), 1), 500);
  const sinceDate = bjDateFromIso(new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString());

  const { results } = await env.CPTI_DB.prepare(
    "SELECT session_id, MIN(ts) AS first_seen, MAX(ts) AS last_seen, COUNT(*) AS cnt FROM events WHERE ts_date_bj >= ? AND session_id IS NOT NULL GROUP BY session_id ORDER BY last_seen DESC LIMIT ?"
  ).bind(sinceDate, limit).all();

  const sessions = (results || []).map(function (r) {
    const first = new Date(r.first_seen);
    const last = new Date(r.last_seen);
    return {
      session_id: r.session_id,
      first_seen: r.first_seen,
      last_seen: r.last_seen,
      duration_sec: Math.round((last - first) / 1000),
      page_count: r.cnt
    };
  });

  const totalSessions = sessions.length;
  const avgDuration = totalSessions > 0 ? Math.round(sessions.reduce(function (s, x) { return s + x.duration_sec; }, 0) / totalSessions) : 0;
  const avgPages = totalSessions > 0 ? Math.round(sessions.reduce(function (s, x) { return s + x.page_count; }, 0) / totalSessions * 10) / 10 : 0;
  const bounceCount = sessions.filter(function (x) { return x.page_count === 1; }).length;
  const bounceRate = totalSessions > 0 ? Math.round(bounceCount / totalSessions * 100) / 100 : 0;

  return json({
    sessions: sessions,
    summary: {
      total_sessions: totalSessions,
      avg_duration_sec: avgDuration,
      avg_page_count: avgPages,
      bounce_rate: bounceRate
    }
  });
}

// GET /api/admin/referrers?days=30&limit=20
async function handleAdminReferrers(request, env, ctx) {
  const url = new URL(request.url);
  const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '30', 10), 1), 90);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '20', 10), 1), 100);
  const sinceDate = bjDateFromIso(new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString());

  const { results } = await env.CPTI_DB.prepare(
    "SELECT referrer, COUNT(DISTINCT session_id) AS c FROM events WHERE event_type='page_view' AND ts_date_bj >= ? AND session_id IS NOT NULL GROUP BY referrer ORDER BY c DESC LIMIT ?"
  ).bind(sinceDate, limit).all();

  const total = (results || []).reduce(function (s, r) { return s + r.c; }, 0);
  const referrers = (results || []).map(function (r) {
    let label = r.referrer || '直接访问';
    if (r.referrer) {
      try {
        const u = new URL(r.referrer);
        label = u.origin + '/';
      } catch (e) {}
    }
    return {
      referrer: label,
      visits: r.c,
      percent: total > 0 ? Math.round((r.c / total) * 1000) / 10 : 0
    };
  });
  // 合并同 origin
  const merged = {};
  referrers.forEach(function (r) {
    if (merged[r.referrer]) {
      merged[r.referrer].visits += r.visits;
    } else {
      merged[r.referrer] = r;
    }
  });
  const finalList = Object.values(merged).sort(function (a, b) { return b.visits - a.visits; });
  finalList.forEach(function (r) {
    r.percent = total > 0 ? Math.round((r.visits / total) * 1000) / 10 : 0;
  });
  return json({ referrers: finalList.slice(0, limit), total_visits: total });
}

// 静态资源：通过 env.STATIC_ASSETS 读取
async function serveAdminHtml(env) {
  const obj = await env.STATIC_ASSETS.fetch(new Request('https://internal/admin.html'));
  if (!obj.ok) return new Response('admin.html not found', { status: 404 });
  const html = await obj.text();
  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Content-Security-Policy': "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' https://fonts.googleapis.com 'unsafe-inline'; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:;"
    }
  });
}

async function serveAdminJs(env) {
  const obj = await env.STATIC_ASSETS.fetch(new Request('https://internal/admin.js'));
  if (!obj.ok) return new Response('// admin.js not found', { status: 404, headers: { 'Content-Type': 'application/javascript; charset=utf-8' } });
  const js = await obj.text();
  return new Response(js, {
    status: 200,
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

async function serveTrackingJs(env) {
  const obj = await env.STATIC_ASSETS.fetch(new Request('https://internal/tracking.js'));
  if (!obj.ok) return new Response('// tracking.js not found', { status: 404, headers: { 'Content-Type': 'application/javascript; charset=utf-8' } });
  const js = await obj.text();
  return new Response(js, {
    status: 200,
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

export default {
  async fetch(request, env, ctx) {
    // CORS 预检
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    // 路由
    if (url.pathname === '/api/record' && request.method === 'POST') {
      return handleRecord(request, env, ctx);
    }
    if (url.pathname === '/api/stats' && request.method === 'GET') {
      return handleStats(env, ctx);
    }
    if (url.pathname === '/api/visit' && request.method === 'POST') {
      return handleVisit(env, ctx);
    }
    if (url.pathname === '/api/visits' && request.method === 'GET') {
      return handleVisits(env, ctx);
    }
    if (url.pathname === '/api/event' && request.method === 'POST') {
      return handleEvent(request, env, ctx);
    }

    // ===== Admin API =====
    if (url.pathname === '/api/admin/login' && request.method === 'POST') {
      return handleLogin(request, env, ctx);
    }
    if (url.pathname === '/api/admin/logout' && request.method === 'POST') {
      return handleLogout(request, env, ctx);
    }
    if (url.pathname === '/api/admin/overview' && request.method === 'GET') {
      return withAuth(request, env, ctx, handleAdminOverview);
    }
    if (url.pathname === '/api/admin/timeseries' && request.method === 'GET') {
      return withAuth(request, env, ctx, handleAdminTimeseries);
    }
    if (url.pathname === '/api/admin/hourly' && request.method === 'GET') {
      return withAuth(request, env, ctx, handleAdminHourly);
    }
    if (url.pathname === '/api/admin/pages' && request.method === 'GET') {
      return withAuth(request, env, ctx, handleAdminPages);
    }
    if (url.pathname === '/api/admin/types' && request.method === 'GET') {
      return withAuth(request, env, ctx, handleAdminTypes);
    }
    if (url.pathname === '/api/admin/heatmap' && request.method === 'GET') {
      return withAuth(request, env, ctx, handleAdminHeatmap);
    }
    if (url.pathname === '/api/admin/sessions' && request.method === 'GET') {
      return withAuth(request, env, ctx, handleAdminSessions);
    }
    if (url.pathname === '/api/admin/referrers' && request.method === 'GET') {
      return withAuth(request, env, ctx, handleAdminReferrers);
    }

    // ===== Admin UI + 静态资源 =====
    if (url.pathname === '/admin' || url.pathname === '/admin/') {
      return serveAdminHtml(env);
    }
    if (url.pathname === '/admin.js') {
      return serveAdminJs(env);
    }
    if (url.pathname === '/tracking.js') {
      return serveTrackingJs(env);
    }

    // 根路径返回简单状态信息
    if (url.pathname === '/' || url.pathname === '') {
      return json({
        name: 'cpti-stats',
        endpoints: ['/api/record', '/api/stats', '/api/visit', '/api/visits'],
        version: '2.1.0',
        storage: 'D1'
      });
    }

    return json({ error: 'not found' }, 404);
  }
};
