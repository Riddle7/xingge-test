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
async function handleRecord(request, env, ctx) {
  const url = new URL(request.url);
  const rawType = url.searchParams.get('type');
  const type = normalizeType(rawType);
  if (!type) return json({ success: false, error: 'invalid type' }, 400);

  // D1 原子 UPDATE：高并发下不会丢数据（相比 KV 读-改-写）
  // RETURNING 让我们直接拿到最新 count，无需二次查询
  const stmt = env.CPTI_DB.prepare(
    'UPDATE counts SET count = count + 1 WHERE type = ? RETURNING count'
  ).bind(type);
  const result = await stmt.first();
  const newCount = result ? result.count : 0;

  // 失效 L2：让下一次 GET /api/stats 重新读 D1
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
