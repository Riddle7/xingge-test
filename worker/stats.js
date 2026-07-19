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

// POST /api/record?type=XXX
async function handleRecord(request, env) {
  const url = new URL(request.url);
  const rawType = url.searchParams.get('type');
  const type = normalizeType(rawType);
  if (!type) return json({ success: false, error: 'invalid type' }, 400);

  const key = 'count_' + type;
  // KV 读-改-写：高并发下可能少许丢失，统计场景可接受
  const cur = parseInt(await env.CPTI_STATS.get(key) || '0', 10);
  const next = cur + 1;
  await env.CPTI_STATS.put(key, String(next));
  return json({ success: true, count: next, type: type });
}

// GET /api/stats
async function handleStats(env) {
  const stats = {};
  let total = 0;
  // 并行读取 16 个键
  const promises = TYPES.map(async (t) => {
    const v = await env.CPTI_STATS.get('count_' + t);
    const count = v ? parseInt(v, 10) : 0;
    stats[t] = count;
    total += count;
  });
  await Promise.all(promises);

  // 组装返回结构，百分比保留 1 位小数
  const result = {};
  for (const t of TYPES) {
    const c = stats[t];
    const percent = total > 0 ? ((c / total) * 100).toFixed(1) : '0.0';
    result[t] = { count: c, percent: percent };
  }
  return json({ total: total, stats: result });
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
      return handleRecord(request, env);
    }
    if (url.pathname === '/api/stats' && request.method === 'GET') {
      return handleStats(env);
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
