'use strict';
const API_BASE = '';
const REFRESH_INTERVAL = 30 * 1000;
let refreshTimer = null;
let lastUpdateTime = 0;
let countdownTimer = null;
let countdown = REFRESH_INTERVAL / 1000;
const charts = {};

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
  const r = await fetch(API_BASE + path);
  if (r.status === 401) {
    showLogin(); throw new Error('unauthorized');
  }
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
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
    if (e.message !== 'unauthorized') toast('加载失败: ' + e.message, true);
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

function renderTypesTodayChart(data) {
  const ctx = document.getElementById('chart-types-today');
  if (charts.typesToday) charts.typesToday.destroy();
  const dist = data.distribution || [];
  const todayTotal = (data.total || 0) || dist.reduce(function (s, d) { return s + d.count; }, 0);
  charts.typesToday = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: dist.map(function (d) { return formatTypeLabel(d.type); }),
      datasets: [{
        data: dist.map(function (d) { return d.count; }),
        backgroundColor: palette(dist.length),
        borderWidth: 2,
        borderColor: '#F4F4F1',
        hoverOffset: 8
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '58%',
      plugins: {
        legend: {
          position: 'bottom',
          labels: { font: { size: 11, weight: '500' }, padding: 14, usePointStyle: true }
        },
        tooltip: {
          callbacks: {
            label: function (ctx) {
              const c = ctx.parsed;
              const pct = todayTotal > 0 ? (Math.round(c / todayTotal * 1000) / 10) : 0;
              return ' ' + fmt(c) + ' 人 · ' + pct + '%';
            }
          }
        }
      }
    }
  });
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
  } catch (e) { if (e.message !== 'unauthorized') toast('加载失败: ' + e.message, true); }
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
  } catch (e) { if (e.message !== 'unauthorized') toast('加载失败: ' + e.message, true); }
}

// ===== Types Tab =====
function buildTypesBarOptions(total) {
  return {
    indexAxis: 'y',
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          label: function (ctx) {
            const c = ctx.parsed.x;
            const pct = total > 0 ? (Math.round(c / total * 1000) / 10) : 0;
            return ' ' + fmt(c) + ' 人 · ' + pct + '%';
          }
        }
      }
    },
    scales: {
      x: { beginAtZero: true, grid: { borderDash: [4, 4] } },
      y: { grid: { display: false } }
    }
  };
}
async function loadTypesTab() {
  try {
    const data = await api('/api/admin/types?date=today');
    const cumulTotal = data.cumulative_total || 0;
    const todayTotal = data.total || 0;

    const ctx1 = document.getElementById('chart-types-cumulative');
    if (charts.typesCumul) charts.typesCumul.destroy();
    const cumul = data.cumulative || [];
    charts.typesCumul = new Chart(ctx1, {
      type: 'bar',
      data: {
        labels: cumul.map(function (d) { return formatTypeLabel(d.type); }),
        datasets: [{
          label: '累计',
          data: cumul.map(function (d) { return d.count; }),
          backgroundColor: palette(cumul.length),
          borderRadius: 6,
          barPercentage: 0.62
        }]
      },
      options: buildTypesBarOptions(cumulTotal)
    });

    const ctx2 = document.getElementById('chart-types-today-bar');
    if (charts.typesTodayBar) charts.typesTodayBar.destroy();
    const today = data.distribution || [];
    charts.typesTodayBar = new Chart(ctx2, {
      type: 'bar',
      data: {
        labels: today.map(function (d) { return formatTypeLabel(d.type); }),
        datasets: [{
          label: '今日',
          data: today.map(function (d) { return d.count; }),
          backgroundColor: palette(today.length),
          borderRadius: 6,
          barPercentage: 0.62
        }]
      },
      options: buildTypesBarOptions(todayTotal)
    });
    updateLastUpdate();
  } catch (e) { if (e.message !== 'unauthorized') toast('加载失败: ' + e.message, true); }
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
  } catch (e) { if (e.message !== 'unauthorized') toast('加载失败: ' + e.message, true); }
}

// ===== Heatmap Tab =====
let heatDays = 7;
async function loadHeatmapTab() {
  try {
    const data = await api('/api/admin/heatmap?days=' + heatDays);
    renderHeatmap(data);
    updateLastUpdate();
  } catch (e) { if (e.message !== 'unauthorized') toast('加载失败: ' + e.message, true); }
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

// ===== 初始化：检查是否已登录 =====
(async function init() {
  try {
    await api('/api/admin/overview');
    showDashboard();
  } catch (e) {
    showLogin();
  }
})();
