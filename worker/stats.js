// CPTI 统计 Worker - 单文件后端
// 部署：wrangler deploy
// KV 绑定：CPTI_STATS（在 wrangler.toml 中配置）

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

  // 未命中：读 KV
  const pairs = await Promise.all(TYPES.map(async (t) => {
    const v = await env.CPTI_STATS.get('count_' + t);
    return [t, v ? parseInt(v, 10) : 0];
  }));
  const counts = {};
  let total = 0;
  for (const [t, c] of pairs) {
    counts[t] = c;
    total += c;
  }
  const stats = {};
  for (const t of TYPES) {
    const c = counts[t];
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

  return { total, stats, source: 'KV' };
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

  const key = 'count_' + type;
  // KV 读-改-写：高并发下可能少许丢失，统计场景可接受
  const cur = parseInt(await env.CPTI_STATS.get(key) || '0', 10);
  const next = cur + 1;
  await env.CPTI_STATS.put(key, String(next));
  // 失效 L1 + L2：让下一次 GET /api/stats 重新读 KV
  invalidateStatsCache(ctx);
  return json({ success: true, count: next, type: type });
}

// GET /api/stats
async function handleStats(env, ctx) {
  const result = await getStatsCached(env, ctx);
  const body = JSON.stringify({ total: result.total, stats: result.stats });
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Cache-Source': result.source, // L2 / KV
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

    // 根路径返回简单状态信息
    if (url.pathname === '/' || url.pathname === '') {
      return json({
        name: 'cpti-stats',
        endpoints: ['/api/record', '/api/stats'],
        version: '1.0.0'
      });
    }

    return json({ error: 'not found' }, 404);
  }
};
