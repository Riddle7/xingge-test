'use strict';
const API_BASE = '';
const REFRESH_INTERVAL = 30 * 1000;
const API_TIMEOUT = 15000; // 单请求 15 秒超时,避免 Worker 冷启动 / D1 慢查询时无限挂起
let refreshTimer = null;
let lastUpdateTime = 0;
let countdownTimer = null;
let countdown = REFRESH_INTERVAL / 1000;
const charts = {};

// 在途请求跟踪:页面卸载 / tab 切换时统一 abort,避免浏览器抛 "Failed to fetch"
const inflight = new Set();
function abortAllInflight() {
  inflight.forEach(function (c) { try { c.abort(); } catch (e) {} });
  inflight.clear();
}
// 识别瞬时网络错误:fetch 网络层失败抛 TypeError("Failed to fetch"),
// 超时 / 卸载 abort 抛 AbortError —— 这些都不应弹 toast 打扰用户
function isTransientNetworkError(e) {
  if (e && e.name === 'AbortError') return true;
  if (e instanceof TypeError && /fetch|network|load/i.test(e.message || '')) return true;
  return false;
}

// ===== Chart.js 全局浅色主题配置 =====
(function configureChartDefaults() {
  if (typeof Chart === 'undefined') {
    setTimeout(configureChartDefaults, 50);
    return;
  }
  Chart.defaults.set({
    color: '#475569',
    borderColor: 'rgba(15, 23, 42, 0.08)',
    font: { family: "'Inter', sans-serif", size: 12, weight: '500' },
    plugins: {
      tooltip: {
        backgroundColor: 'rgba(255, 255, 255, 0.98)',
        titleColor: '#0F172A',
        bodyColor: '#475569',
        borderColor: 'rgba(15, 23, 42, 0.08)',
        borderWidth: 1,
        cornerRadius: 12,
        padding: 14,
        displayColors: true,
        boxPadding: 6,
        titleFont: { family: "'Space Grotesk', sans-serif", size: 13, weight: '700' },
        bodyFont: { family: "'Inter', sans-serif", size: 12, weight: '500' },
        boxWidth: 8,
        boxHeight: 8
      },
      legend: {
        labels: { usePointStyle: true, padding: 18, boxWidth: 8, boxHeight: 8, color: '#475569', font: { family: "'Inter', sans-serif", size: 12, weight: '500' } }
      }
    },
    scale: {
      grid: { color: 'rgba(15, 23, 42, 0.04)' },
      ticks: { color: '#94A3B8', font: { weight: '500' } },
      border: { display: false }
    }
  });
})();

// ===== 人格代号 → 中文名映射（17 种） =====
const TYPE_LABELS = {
  'S-F-R-E': '法条灭霸',
  'S-F-R-Re': '立法者の忠犬',
  'S-F-P-E': '预防性洁癖',
  'S-F-P-Re': '依法从宽の神',
  'S-M-R-E': '穿透法条的复仇之眼',
  'S-M-R-Re': '持刀哲学家',
  'S-M-P-E': '刑法工具人',
  'S-M-P-Re': '被告人的天使',
  'O-F-R-E': '结果导向暴君',
  'O-F-R-Re': '法条打印机',
  'O-F-P-E': '杀鸡儆猴推广大使',
  'O-F-P-Re': '教育刑の循吏',
  'O-M-R-E': '结果归责复仇者',
  'O-M-R-Re': '自由原教旨',
  'O-M-P-E': '安全乌托邦织网者',
  'O-M-P-Re': '谦抑性玫瑰',
  'HYBRID': '终极缝合怪'
};

// 数据可视化颜色：莫兰迪色系（提亮版），低饱和高级灰调
// 整体明度提升 6-8%，饱和度微升 2-5%，保持柔和质感，与白底有更清晰视觉分离
const DATA_COLORS = [
  '#7E8FA3', // 莫兰迪蓝灰（主色）
  '#C7B292', // 莫兰迪驼
  '#9CAD8E', // 莫兰迪橄榄
  '#C99489', // 莫兰迪陶土
  '#8E9EAE', // 莫兰迪烟青
  '#D6C5AC', // 莫兰迪浅驼
  '#AD9D8C', // 莫兰迪棕灰
  '#8EAC9F', // 莫兰迪灰绿
  '#B8958F', // 莫兰迪玫瑰
  '#7E9CAC', // 莫兰迪钢蓝
  '#B8A895', // 莫兰迪卡其
  '#9D8CA7', // 莫兰迪灰紫
  '#8EA898', // 莫兰迪青绿
  '#C8A995', // 莫兰迪沙粉
  '#AD8C93', // 莫兰迪暗玫瑰
  '#7E9C8F', // 莫兰迪墨绿
  '#BAAB94'  // 莫兰迪灰金
];

function formatTypeLabel(type) {
  const name = TYPE_LABELS[type];
  return name ? type + ' · ' + name : type;
}

// ===== 工具 =====
function fmt(n) {
  return String(n || 0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function fmtDuration(sec) {
  if (sec < 60) return sec + 's';
  const m = Math.floor(sec / 60); const s = sec % 60;
  if (m < 60) return m + 'm ' + s + 's';
  const h = Math.floor(m / 60); return h + 'h ' + (m % 60) + 'm';
}
function fmtTime(iso) {
  try { return new Date(iso).toLocaleString('zh-CN', { hour12: false }); } catch (e) { return iso; }
}
function toast(msg, isErr) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show' + (isErr ? ' error' : '');
  setTimeout(function () { el.className = 'toast'; }, 3000);
}
async function api(path) {
  const ctrl = new AbortController();
  inflight.add(ctrl);
  const timer = setTimeout(function () { ctrl.abort(); }, API_TIMEOUT);
  try {
    const r = await fetch(API_BASE + path, { signal: ctrl.signal });
    if (r.status === 401) {
      showLogin(); throw new Error('unauthorized');
    }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally {
    clearTimeout(timer);
    inflight.delete(ctrl);
  }
}

// ===== Login =====
function showLogin() {
  stopRefresh();
  document.getElementById('dashboard').hidden = true;
  document.getElementById('login-view').hidden = false;
  document.getElementById('password-input').focus();
}
function showDashboard() {
  document.getElementById('login-view').hidden = true;
  document.getElementById('dashboard').hidden = false;
  startRefresh();
  loadOverview();
}
async function doLogin() {
  const pwd = document.getElementById('password-input').value;
  const errEl = document.getElementById('login-error');
  errEl.textContent = '';
  try {
    const r = await fetch(API_BASE + '/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pwd })
    });
    const data = await r.json();
    if (r.ok && data.success) {
      showDashboard();
    } else if (r.status === 429) {
      errEl.textContent = data.error || '尝试过多，请稍后再试';
    } else {
      errEl.textContent = data.error || '密码错误';
    }
  } catch (e) {
    errEl.textContent = '网络错误';
  }
}
async function doLogout() {
  try { await fetch(API_BASE + '/api/admin/logout', { method: 'POST' }); } catch (e) {}
  stopRefresh();
  showLogin();
}

// ===== Tab 切换 =====
document.getElementById('nav-tabs').addEventListener('click', function (e) {
  const btn = e.target.closest('.nav-tab');
  if (!btn) return;
  const tab = btn.dataset.tab;
  document.querySelectorAll('.nav-tab').forEach(function (t) { t.classList.remove('active'); });
  btn.classList.add('active');
  document.querySelectorAll('.tab-content').forEach(function (s) { s.classList.remove('active'); });
  document.getElementById('tab-' + tab).classList.add('active');
  if (tab === 'visits') loadVisitsTab();
  else if (tab === 'tests') loadTestsTab();
  else if (tab === 'types') loadTypesTab();
  else if (tab === 'sessions') loadSessionsTab();
  else if (tab === 'heatmap') loadHeatmapTab();
  else if (tab === 'regions') loadRegionsTab();
});

// ===== Overview =====
async function loadOverview() {
  try {
    const data = await api('/api/admin/overview');
    renderOverviewKPIs(data);
    renderTrendChart(data.trend_30d || []);
    const [hourly, types, pages] = await Promise.all([
      api('/api/admin/hourly?date=today'),
      api('/api/admin/types?date=today'),
      api('/api/admin/pages?days=30&limit=10')
    ]);
    renderHourlyChart(hourly);
    renderTypesTodayChart(types);
    renderTopPages(pages, 'top-pages-body');
    updateLastUpdate();
  } catch (e) {
    if (e && e.message === 'unauthorized') return;
    if (isTransientNetworkError(e)) return; // 网络抖动 / 超时 / 页面卸载:静默降级,不打扰用户
    toast('加载失败: ' + (e && e.message ? e.message : e), true);
  }
}
function renderOverviewKPIs(data) {
  const today = data.today || {};
  const y = data.yesterday || {};
  const total = data.total || {};
  function delta(now, prev) {
    if (!prev) return { text: '-', cls: 'flat' };
    const d = now - prev;
    if (d === 0) return { text: '持平', cls: 'flat' };
    const pct = Math.round(d / prev * 100);
    return { text: (d > 0 ? '▲ ' : '▼ ') + Math.abs(pct) + '%', cls: d > 0 ? 'up' : 'down' };
  }
  const dv = delta(today.visits, y.visits);
  const dt = delta(today.tests, y.tests);
  document.getElementById('overview-kpis').innerHTML = [
    kpiCard('今日访问', fmt(today.visits), dv, 'visits'),
    kpiCard('今日测试', fmt(today.tests), dt, 'tests'),
    kpiCard('累计访问', fmt(total.visits), null, 'visits'),
    kpiCard('累计测试', fmt(total.tests), null, 'tests')
  ].join('');
}
const KPI_ICONS = {
  visits: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
  tests: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>',
  conversion: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>',
  sessions: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  duration: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
  pages: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
  bounce: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>'
};

function kpiCard(label, value, delta, iconKey) {
  const icon = iconKey && KPI_ICONS[iconKey] ? '<span class="kpi-icon">' + KPI_ICONS[iconKey] + '</span>' : '';
  const d = delta ? '<div class="kpi-delta ' + delta.cls + '">' + delta.text + '</div>' : '';
  return '<div class="kpi-card"><div class="kpi-label">' + icon + label + '</div><div class="kpi-value">' + value + '</div>' + d + '</div>';
}

function lineDataset(label, data, color, fill) {
  return {
    label: label,
    data: data,
    borderColor: color,
    backgroundColor: fill ? hexToRgba(color, 0.10) : 'transparent',
    borderWidth: 2,
    tension: 0.4,
    fill: !!fill,
    pointRadius: 0,
    pointHoverRadius: 5,
    pointHoverBackgroundColor: color,
    pointHoverBorderColor: '#FFFFFF',
    pointHoverBorderWidth: 2
  };
}

function renderTrendChart(points) {
  const ctx = document.getElementById('chart-trend');
  if (charts.trend) charts.trend.destroy();
  charts.trend = new Chart(ctx, {
    type: 'line',
    data: {
      labels: points.map(function (p) { return p.date.slice(5); }),
      datasets: [
        lineDataset('访问', points.map(function (p) { return p.visits; }), '#7E8FA3', true),
        lineDataset('测试', points.map(function (p) { return p.tests; }), '#C7B292', true)
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { position: 'top', align: 'end' } },
      scales: { y: { beginAtZero: true, grid: { borderDash: [4, 4] } } }
    }
  });
}

function renderHourlyChart(data) {
  const ctx = document.getElementById('chart-hourly');
  if (charts.hourly) charts.hourly.destroy();
  charts.hourly = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: data.hours,
      datasets: [
        { label: '访问', data: data.visits, backgroundColor: '#7E8FA3', borderRadius: 6, barPercentage: 0.58 },
        { label: '测试', data: data.tests, backgroundColor: '#C7B292', borderRadius: 6, barPercentage: 0.58 }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { position: 'top', align: 'end' } },
      scales: {
        x: { title: { display: true, text: '北京时间', color: '#A09A93' }, grid: { display: false } },
        y: { beginAtZero: true, grid: { borderDash: [4, 4] } }
      }
    }
  });
}

function renderDistWidget(containerId, title, subtitle, items, total) {
  const el = document.getElementById(containerId);
  if (!el) return;

  const sorted = items.slice().sort(function (a, b) { return b.count - a.count; });
  const maxCount = sorted.length > 0 ? sorted[0].count : 1;

  let rowsHtml = '';
  sorted.forEach(function (item, idx) {
    const type = item.type;
    const count = item.count;
    const percent = (item.percent != null && !isNaN(item.percent)) ? item.percent : 0;

    let groupClass = '';
    if (type === 'HYBRID') groupClass = 'hybrid';
    else if (type.startsWith('S-')) groupClass = 's-group';
    else if (type.startsWith('O-')) groupClass = 'o-group';

    const isFocal = idx === 0;
    const widthPct = maxCount > 0 ? (count / maxCount * 100) : 0;

    const cnName = TYPE_LABELS[type] || '';
    let labelText = type;
    let hybridTag = '';
    if (type === 'HYBRID') {
      hybridTag = '<span class="hybrid-tag">缝合怪</span>';
    }

    rowsHtml += '<div class="dist-row">' +
      '<div class="row-label' + (isFocal ? ' focal' : '') + '">' +
        '<span class="row-label-code">' + labelText + hybridTag + '</span>' +
        (cnName ? '<span class="row-label-cn">' + cnName + '</span>' : '') +
      '</div>' +
      '<div class="bar-track"><div class="bar-fill ' + groupClass + (isFocal ? ' focal' : '') + '" style="width: ' + widthPct + '%"></div></div>' +
      '<div class="row-value' + (isFocal ? ' focal' : '') + '">' + fmt(count) + '<span class="pct">' + percent.toFixed(1) + '%</span></div>' +
    '</div>';
  });

  const totalLabel = title === '今日分布' ? '今日测试' : '累计测试';

  el.innerHTML =
    '<div class="dist-header">' +
      '<div class="dist-title">' + title + '</div>' +
      '<div class="dist-total">' + totalLabel + ' <strong>' + fmt(total) + '</strong> 次</div>' +
    '</div>' +
    '<div class="dist-sub">' + subtitle + '</div>' +
    '<div class="dist-legend">' +
      '<span class="legend-item"><span class="legend-dot legend-s"></span>主观主义阵营 (S)</span>' +
      '<span class="legend-item"><span class="legend-dot legend-o"></span>客观主义阵营 (O)</span>' +
      '<span class="legend-item"><span class="legend-dot legend-h"></span>HYBRID 缝合怪</span>' +
    '</div>' +
    '<div class="dist-rows">' + rowsHtml + '</div>' +
    '<div class="dist-footer">' +
      '<span>四维代号：S/O · F/M · R/P · E/Re</span>' +
      '<span>占比 ≈ 计数 / ' + fmt(total) + '</span>' +
    '</div>';
}

function renderTypesTodayChart(data) {
  const dist = data.distribution || [];
  const todayTotal = (data.total || 0) || dist.reduce(function (s, d) { return s + d.count; }, 0);
  renderDistWidget('dist-overview-today', '当日人格分布', '数据源：当日测试记录（实时）', dist, todayTotal);
}

function renderTopPages(data, tbodyId) {
  const tb = document.getElementById(tbodyId);
  const total = data.total_visits || 1;
  tb.innerHTML = (data.pages || []).map(function (p) {
    const w = Math.max(2, (p.visits / total) * 100);
    return '<tr><td class="mono">' + escapeHtml(p.page) + '</td><td>' + fmt(p.visits) + '</td><td><div class="bar-cell"><div class="bar-track"><div class="bar" style="width:' + w + '%"></div></div><span>' + p.percent + '%</span></div></td></tr>';
  }).join('');
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function (c) { return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]; });
}
function palette(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(DATA_COLORS[i % DATA_COLORS.length]);
  return out;
}
function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
}

// ===== Visits Tab =====
let visitsDays = 30;
async function loadVisitsTab() {
  try {
    const [ts, pages, refs] = await Promise.all([
      api('/api/admin/timeseries?days=' + visitsDays + '&metric=visits'),
      api('/api/admin/pages?days=' + visitsDays + '&limit=20'),
      api('/api/admin/referrers?days=' + visitsDays + '&limit=20')
    ]);
    renderVisitsTrend(ts);
    renderTopPages(pages, 'visits-pages-body');
    renderReferrers(refs);
    updateLastUpdate();
  } catch (e) {
    if (e && e.message === 'unauthorized') return;
    if (isTransientNetworkError(e)) return; // 网络抖动 / 超时 / 页面卸载:静默降级,不打扰用户
    toast('加载失败: ' + (e && e.message ? e.message : e), true);
  }
}
function renderVisitsTrend(data) {
  const ctx = document.getElementById('chart-visits-trend');
  if (charts.visitsTrend) charts.visitsTrend.destroy();
  const pts = data.points || [];
  charts.visitsTrend = new Chart(ctx, {
    type: 'line',
    data: {
      labels: pts.map(function (p) { return p.date.slice(5); }),
      datasets: [lineDataset('访问', pts.map(function (p) { return p.visits; }), '#7E8FA3', true)]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true, grid: { borderDash: [4, 4] } } }
    }
  });
}
function renderReferrers(data) {
  const tb = document.getElementById('referrers-body');
  const total = data.total_visits || 1;
  tb.innerHTML = (data.referrers || []).map(function (r) {
    const w = Math.max(2, (r.visits / total) * 100);
    return '<tr><td>' + escapeHtml(r.referrer) + '</td><td>' + fmt(r.visits) + '</td><td><div class="bar-cell"><div class="bar-track"><div class="bar" style="width:' + w + '%"></div></div><span>' + r.percent + '%</span></div></td></tr>';
  }).join('');
}
document.addEventListener('click', function (e) {
  if (e.target.dataset.visitsDays) {
    visitsDays = parseInt(e.target.dataset.visitsDays, 10);
    document.querySelectorAll('[data-visits-days]').forEach(function (b) { b.classList.remove('active'); });
    e.target.classList.add('active');
    loadVisitsTab();
  }
});

// ===== Tests Tab =====
async function loadTestsTab() {
  try {
    const [ts, today, hourly] = await Promise.all([
      api('/api/admin/timeseries?days=30&metric=tests'),
      api('/api/admin/types?date=today'),
      api('/api/admin/hourly?date=today')
    ]);
    const total = today.cumulative_total || 0;
    const todayTotal = today.total || 0;
    const todayVisits = (hourly && Array.isArray(hourly.visits)) ? hourly.visits.reduce(function (a, b) { return a + b; }, 0) : 0;
    const conversion = (todayTotal > 0 && todayVisits > 0) ? (Math.round(todayTotal / todayVisits * 1000) / 10) + '%' : '-';
    document.getElementById('tests-kpis').innerHTML = [
      kpiCard('今日完成', fmt(todayTotal), null, 'tests'),
      kpiCard('累计完成', fmt(total), null, 'tests'),
      kpiCard('转化率（今日）', conversion, null, 'conversion')
    ].join('');
    const ctx = document.getElementById('chart-tests-trend');
    if (charts.testsTrend) charts.testsTrend.destroy();
    const pts = ts.points || [];
    charts.testsTrend = new Chart(ctx, {
      type: 'line',
      data: {
        labels: pts.map(function (p) { return p.date.slice(5); }),
        datasets: [lineDataset('测试完成', pts.map(function (p) { return p.tests; }), '#C7B292', true)]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { display: false } },
        scales: { y: { beginAtZero: true, grid: { borderDash: [4, 4] } } }
      }
    });
    updateLastUpdate();
  } catch (e) {
    if (e && e.message === 'unauthorized') return;
    if (isTransientNetworkError(e)) return; // 网络抖动 / 超时 / 页面卸载:静默降级,不打扰用户
    toast('加载失败: ' + (e && e.message ? e.message : e), true);
  }
}

// ===== Types Tab =====
async function loadTypesTab() {
  try {
    const data = await api('/api/admin/types?date=today');
    const cumulTotal = data.cumulative_total || 0;
    const todayTotal = data.total || 0;

    const cumul = data.cumulative || [];
    const today = data.distribution || [];

    renderDistWidget('dist-types-cumulative', '累计分布', '数据源：counts 表（全历史累计）', cumul, cumulTotal);
    renderDistWidget('dist-types-today', '今日分布', '数据源：当日测试记录（实时）', today, todayTotal);

    updateLastUpdate();
  } catch (e) {
    if (e && e.message === 'unauthorized') return;
    if (isTransientNetworkError(e)) return; // 网络抖动 / 超时 / 页面卸载:静默降级,不打扰用户
    toast('加载失败: ' + (e && e.message ? e.message : e), true);
  }
}

// ===== Sessions Tab =====
async function loadSessionsTab() {
  try {
    const data = await api('/api/admin/sessions?days=7&limit=100');
    const s = data.summary || {};
    document.getElementById('sessions-kpis').innerHTML = [
      kpiCard('总会话数', fmt(s.total_sessions), null, 'sessions'),
      kpiCard('平均时长', fmtDuration(s.avg_duration_sec || 0), null, 'duration'),
      kpiCard('平均页数', s.avg_page_count || 0, null, 'pages'),
      kpiCard('跳出率', Math.round((s.bounce_rate || 0) * 100) + '%', null, 'bounce')
    ].join('');
    const tb = document.getElementById('sessions-body');
    tb.innerHTML = (data.sessions || []).map(function (x) {
      return '<tr><td class="mono">' + escapeHtml(x.session_id.slice(0, 16)) + '…</td><td>' + fmtTime(x.first_seen) + '</td><td>' + fmtTime(x.last_seen) + '</td><td>' + fmtDuration(x.duration_sec) + '</td><td>' + x.page_count + '</td></tr>';
    }).join('');
    updateLastUpdate();
  } catch (e) {
    if (e && e.message === 'unauthorized') return;
    if (isTransientNetworkError(e)) return; // 网络抖动 / 超时 / 页面卸载:静默降级,不打扰用户
    toast('加载失败: ' + (e && e.message ? e.message : e), true);
  }
}

// ===== Heatmap Tab =====
let heatDays = 7;
async function loadHeatmapTab() {
  try {
    const data = await api('/api/admin/heatmap?days=' + heatDays);
    renderHeatmap(data);
    updateLastUpdate();
  } catch (e) {
    if (e && e.message === 'unauthorized') return;
    if (isTransientNetworkError(e)) return; // 网络抖动 / 超时 / 页面卸载:静默降级,不打扰用户
    toast('加载失败: ' + (e && e.message ? e.message : e), true);
  }
}
function renderHeatmap(data) {
  const wrap = document.getElementById('heatmap-wrap');
  const max = data.max || 1;
  // 三段渐变：浅暖米 → 中青 → 深青蓝（FT/Bloomberg 风格，辨识度高）
  const stops = [
    [248, 244, 237],  // #F8F4ED 浅暖米（低值）
    [109, 168, 201],  // #6DA8C9 中青（中值）
    [12, 74, 110]     // #0C4A6E 深青蓝（峰值）
  ];
  // 移动端：转置布局（24 小时为行 × N 天为列）+ 洞察摘要
  if (window.matchMedia('(max-width: 768px)').matches) {
    renderHeatmapMobile(wrap, data, max, stops);
    return;
  }
  let html = '<div class="heatmap-grid"><div></div>';
  for (let h = 0; h < 24; h++) {
    html += '<div class="heatmap-label" style="text-align:center">' + h + '</div>';
  }
  data.matrix.forEach(function (row, i) {
    const daysAgo = data.matrix.length - 1 - i;
    const d = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
    const label = (d.getMonth() + 1) + '/' + d.getDate();
    html += '<div class="heatmap-label">' + label + '</div>';
    row.forEach(function (v) {
      const intensity = max > 0 ? v / max : 0;
      const bg = v === 0 ? 'var(--border-subtle)' : heatmapColor(stops, intensity);
      html += '<div class="heatmap-cell" style="background:' + bg + '" title="' + v + ' 次">' + v + '</div>';
    });
  });
  html += '</div>';
  wrap.innerHTML = html;
}

// 移动端热力图：转置矩阵 + 洞察摘要 + tap 交互
function renderHeatmapMobile(wrap, data, max, stops) {
  const matrix = data.matrix;
  const days = matrix.length;

  // 1. 计算洞察：峰值时段、谷值时段、最活跃日、日均访问
  const hourSums = new Array(24).fill(0);
  const daySums = new Array(days).fill(0);
  let totalSum = 0;
  matrix.forEach(function (row, d) {
    row.forEach(function (v, h) {
      hourSums[h] += v;
      daySums[d] += v;
      totalSum += v;
    });
  });
  let peakHour = 0, peakHourV = -1;
  let valleyHour = 0, valleyHourV = Infinity;
  for (let h = 0; h < 24; h++) {
    if (hourSums[h] > peakHourV) { peakHourV = hourSums[h]; peakHour = h; }
    if (hourSums[h] < valleyHourV) { valleyHourV = hourSums[h]; valleyHour = h; }
  }
  let peakDay = 0, peakDayV = -1;
  for (let d = 0; d < days; d++) {
    if (daySums[d] > peakDayV) { peakDayV = daySums[d]; peakDay = d; }
  }
  const peakDate = new Date(Date.now() - (days - 1 - peakDay) * 86400000);
  const peakDateLabel = (peakDate.getMonth() + 1) + '/' + peakDate.getDate();
  const avgPerDay = days > 0 ? Math.round(totalSum / days) : 0;

  // 2. 渲染洞察摘要卡片
  let html = '<div class="heat-insight">' +
    '<div class="heat-insight-item">' +
      '<div class="heat-insight-label">峰值时段</div>' +
      '<div class="heat-insight-value">' + peakHour + ':00</div>' +
    '</div>' +
    '<div class="heat-insight-item">' +
      '<div class="heat-insight-label">谷值时段</div>' +
      '<div class="heat-insight-value">' + valleyHour + ':00</div>' +
    '</div>' +
    '<div class="heat-insight-item">' +
      '<div class="heat-insight-label">最活跃日</div>' +
      '<div class="heat-insight-value">' + peakDateLabel + '</div>' +
    '</div>' +
    '<div class="heat-insight-item">' +
      '<div class="heat-insight-label">日均访问</div>' +
      '<div class="heat-insight-value">' + fmt(avgPerDay) + '</div>' +
    '</div>' +
  '</div>';

  // 3. 渲染转置热力图（24 行 × N 列）
  const labelCol = days <= 7 ? '36px' : '30px';
  html += '<div class="heatmap-grid mobile" style="grid-template-columns:' + labelCol + ' repeat(' + days + ', 1fr)">';

  // 表头：空角 + 日期标签（智能间隔）
  html += '<div class="heat-corner"></div>';
  const dayLabelStep = days <= 7 ? 1 : (days <= 14 ? 2 : 5);
  const weekdayNames = ['日', '一', '二', '三', '四', '五', '六'];
  for (let d = 0; d < days; d++) {
    const daysAgo = days - 1 - d;
    const date = new Date(Date.now() - daysAgo * 86400000);
    const showLabel = d % dayLabelStep === 0;
    let label = '';
    if (showLabel) {
      if (days <= 7) {
        label = '周' + weekdayNames[date.getDay()];
      } else {
        label = (date.getMonth() + 1) + '/' + date.getDate();
      }
    }
    html += '<div class="heat-day-label"' + (showLabel ? '' : ' aria-hidden="true"') + '>' + label + '</div>';
  }

  // 24 行：时间标签（每 3 小时显示）+ N 个 cell
  for (let h = 0; h < 24; h++) {
    const showHourLabel = h % 3 === 0;
    html += '<div class="heat-hour-label"' + (showHourLabel ? '' : ' aria-hidden="true"') + '>' +
      (showHourLabel ? h + ':00' : '') + '</div>';
    for (let d = 0; d < days; d++) {
      const v = matrix[d][h];
      const intensity = max > 0 ? v / max : 0;
      const bg = v === 0 ? 'var(--border-subtle)' : heatmapColor(stops, intensity);
      const daysAgo = days - 1 - d;
      const date = new Date(Date.now() - daysAgo * 86400000);
      const dateStr = (date.getMonth() + 1) + '/' + date.getDate();
      const cellLabel = dateStr + ' ' + h + ':00 · ' + v + ' 次';
      html += '<div class="heat-cell" style="background:' + bg + '" data-label="' + cellLabel + '"' +
        (v > 0 ? '' : ' aria-hidden="true"') + '></div>';
    }
  }

  html += '</div>';

  // 4. tap tooltip 提示条
  html += '<div class="heat-tooltip" id="heat-tooltip" role="status" aria-live="polite"></div>';

  wrap.innerHTML = html;

  // 5. 绑定 tap 交互（移动端无 hover）
  bindHeatTooltip();
}

// 移动端热力图 tap 交互：点击 cell 显示信息条
let heatTooltipTimer = null;
function bindHeatTooltip() {
  const grid = document.querySelector('.heatmap-grid.mobile');
  if (!grid) return;
  const tooltip = document.getElementById('heat-tooltip');
  grid.addEventListener('click', function (e) {
    const cell = e.target.closest('.heat-cell');
    if (!cell || !cell.dataset.label) return;
    if (tooltip) {
      tooltip.textContent = cell.dataset.label;
      tooltip.classList.add('show');
      clearTimeout(heatTooltipTimer);
      heatTooltipTimer = setTimeout(function () {
        tooltip.classList.remove('show');
      }, 2200);
    }
  });
}
// 三段插值：低值偏暖、高值偏冷，层次分明
function heatmapColor(stops, t) {
  if (t <= 0) return rgbStr(stops[0]);
  if (t >= 1) return rgbStr(stops[2]);
  let a, b, k;
  if (t < 0.5) { a = stops[0]; b = stops[1]; k = t / 0.5; }
  else { a = stops[1]; b = stops[2]; k = (t - 0.5) / 0.5; }
  return rgbStr([
    Math.round(a[0] + (b[0] - a[0]) * k),
    Math.round(a[1] + (b[1] - a[1]) * k),
    Math.round(a[2] + (b[2] - a[2]) * k)
  ]);
}
function rgbStr(c) { return 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')'; }
document.addEventListener('click', function (e) {
  if (e.target.dataset.heatDays) {
    heatDays = parseInt(e.target.dataset.heatDays, 10);
    document.querySelectorAll('[data-heat-days]').forEach(function (b) { b.classList.remove('active'); });
    e.target.classList.add('active');
    loadHeatmapTab();
  }
});

// 趋势图天数切换
document.addEventListener('click', function (e) {
  if (e.target.dataset.trendDays) {
    const days = parseInt(e.target.dataset.trendDays, 10);
    document.querySelectorAll('[data-trend-days]').forEach(function (b) { b.classList.remove('active'); });
    e.target.classList.add('active');
    api('/api/admin/timeseries?days=' + days + '&metric=both').then(function (ts) {
      renderTrendChart(ts.points || []);
    }).catch(function () {});
  }
});

// ===== 刷新逻辑 =====
function reloadActiveTab() {
  const active = document.querySelector('.tab-content.active');
  if (!active) return;
  const id = active.id.replace('tab-', '');
  if (id === 'overview') loadOverview();
  else if (id === 'visits') loadVisitsTab();
  else if (id === 'tests') loadTestsTab();
  else if (id === 'types') loadTypesTab();
  else if (id === 'sessions') loadSessionsTab();
  else if (id === 'heatmap') loadHeatmapTab();
  else if (id === 'regions') loadRegionsTab();
}
function startRefresh() {
  stopRefresh();
  refreshTimer = setInterval(reloadActiveTab, REFRESH_INTERVAL);
  countdown = REFRESH_INTERVAL / 1000;
  countdownTimer = setInterval(function () {
    countdown--;
    if (countdown < 0) countdown = REFRESH_INTERVAL / 1000;
    document.getElementById('last-update').textContent = '最后更新：' + Math.round((Date.now() - lastUpdateTime) / 1000) + ' 秒前 · 下次刷新：' + countdown + 's';
  }, 1000);
}
function stopRefresh() {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
}
function updateLastUpdate() { lastUpdateTime = Date.now(); }

// ===== 事件绑定 =====
document.getElementById('login-btn').addEventListener('click', doLogin);
document.getElementById('password-input').addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(); });
document.getElementById('logout-btn').addEventListener('click', doLogout);
document.getElementById('refresh-btn').addEventListener('click', function () {
  reloadActiveTab();
  toast('已刷新');
});

// 页面可见性:隐藏时停止 30 秒轮询(避免后台 tab 累积请求 / 浏览器节流导致连接中止),
// 重新可见时恢复轮询并立即刷新一次,保证数据新鲜
document.addEventListener('visibilitychange', function () {
  if (document.hidden) {
    stopRefresh();
  } else if (!document.getElementById('dashboard').hidden) {
    startRefresh();
    reloadActiveTab();
  }
});
// 页面卸载 / 刷新:中止所有在途请求,避免浏览器抛 "Failed to fetch" 被 catch 块捕获后弹 toast
// pagehide 比 beforeunload 更可靠(覆盖移动端切换、bfcache 等),同时监听作为兜底
window.addEventListener('pagehide', abortAllInflight);
window.addEventListener('beforeunload', abortAllInflight);

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
    const s = data.summary || {};
    document.getElementById('regions-kpis').innerHTML = [
      kpiCard('国内访问', fmt(s.domestic_total), null),
      kpiCard('海外访问', fmt(s.overseas_total), null),
      kpiCard('未知地域', fmt(s.unknown_total), null)
    ].join('');
    renderRegionTables(data);
    const ok = await ensureChinaMap();
    if (ok) {
      renderChinaMap(data);
    } else {
      const el = document.getElementById('china-map');
      if (el) el.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-tertiary)">地图加载失败，请查看下方表格</div>';
    }
    updateLastUpdate();
  } catch (e) {
    if (e.message !== 'unauthorized') toast('加载失败: ' + e.message, true);
  }
}

function renderRegionTables(data) {
  const total = (data.summary && data.summary.domestic_total || 0) + (data.summary && data.summary.overseas_total || 0) || 1;
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

// ===== 初始化：检查是否已登录 =====
(async function init() {
  try {
    await api('/api/admin/overview');
    showDashboard();
  } catch (e) {
    showLogin();
  }
})();
