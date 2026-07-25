'use strict';
const API_BASE = '';
const REFRESH_INTERVAL = 30 * 1000;
let refreshTimer = null;
let lastUpdateTime = 0;
let countdownTimer = null;
let countdown = REFRESH_INTERVAL / 1000;
const charts = {};

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
  stopRefresh();  // 停止自动刷新，避免 session 过期后继续发请求
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
  // 懒加载
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
    // 并发拉 hourly + types + pages
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
    if (!prev) return { text: '—', cls: 'flat' };
    const d = now - prev;
    if (d === 0) return { text: '持平', cls: 'flat' };
    const pct = Math.round(d / prev * 100);
    return { text: (d > 0 ? '▲ ' : '▼ ') + Math.abs(pct) + '%', cls: d > 0 ? 'up' : 'down' };
  }
  const dv = delta(today.visits, y.visits);
  const dt = delta(today.tests, y.tests);
  document.getElementById('overview-kpis').innerHTML = [
    kpiCard('今日访问', fmt(today.visits), dv),
    kpiCard('今日测试', fmt(today.tests), dt),
    kpiCard('累计访问', fmt(total.visits), null),
    kpiCard('累计测试', fmt(total.tests), null)
  ].join('');
}
function kpiCard(label, value, delta) {
  const d = delta ? '<div class="kpi-delta ' + delta.cls + '">' + delta.text + '</div>' : '';
  return '<div class="kpi-card"><div class="kpi-label">' + label + '</div><div class="kpi-value">' + value + '</div>' + d + '</div>';
}

function renderTrendChart(points) {
  const ctx = document.getElementById('chart-trend');
  if (charts.trend) charts.trend.destroy();
  charts.trend = new Chart(ctx, {
    type: 'line',
    data: {
      labels: points.map(function (p) { return p.date.slice(5); }),
      datasets: [
        { label: '访问', data: points.map(function (p) { return p.visits; }), borderColor: '#007aff', backgroundColor: 'rgba(0,122,255,0.1)', tension: 0.3, fill: true },
        { label: '测试', data: points.map(function (p) { return p.tests; }), borderColor: '#ff9500', backgroundColor: 'rgba(255,149,0,0.1)', tension: 0.3, fill: true }
      ]
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'top' } }, scales: { y: { beginAtZero: true } } }
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
        { label: '访问', data: data.visits, backgroundColor: 'rgba(0,122,255,0.6)' },
        { label: '测试', data: data.tests, backgroundColor: 'rgba(255,149,0,0.6)' }
      ]
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'top' } }, scales: { x: { title: { text: '北京时间', display: true } }, y: { beginAtZero: true } } }
  });
}

function renderTypesTodayChart(data) {
  const ctx = document.getElementById('chart-types-today');
  if (charts.typesToday) charts.typesToday.destroy();
  const dist = data.distribution || [];
  charts.typesToday = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: dist.map(function (d) { return d.type; }),
      datasets: [{ data: dist.map(function (d) { return d.count; }), backgroundColor: palette(dist.length) }]
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right', labels: { font: { family: 'JetBrains Mono', size: 11 } } } } }
  });
}

function renderTopPages(data, tbodyId) {
  const tb = document.getElementById(tbodyId);
  const total = data.total_visits || 1;
  tb.innerHTML = (data.pages || []).map(function (p) {
    const w = Math.max(2, (p.visits / total) * 100);
    return '<tr><td class="mono">' + escapeHtml(p.page) + '</td><td>' + fmt(p.visits) + '</td><td><div class="bar-cell"><div class="bar" style="width:' + w + '%"></div><span>' + p.percent + '%</span></div></td></tr>';
  }).join('');
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function (c) { return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]; });
}
function palette(n) {
  const colors = ['#007aff','#ff9500','#34c759','#af52de','#ff2d55','#5856d6','#5ac8fa','#ffd60a','#30b0c7','#bf5af2','#ff3b30','#a2845e','#8e8e93','#004fad','#ff6480','#8967e8','#f06292'];
  const out = []; for (let i = 0; i < n; i++) out.push(colors[i % colors.length]); return out;
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
    data: { labels: pts.map(function (p) { return p.date.slice(5); }), datasets: [{ label: '访问', data: pts.map(function (p) { return p.visits; }), borderColor: '#007aff', backgroundColor: 'rgba(0,122,255,0.1)', tension: 0.3, fill: true }] },
    options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true } } }
  });
}
function renderReferrers(data) {
  const tb = document.getElementById('referrers-body');
  const total = data.total_visits || 1;
  tb.innerHTML = (data.referrers || []).map(function (r) {
    const w = Math.max(2, (r.visits / total) * 100);
    return '<tr><td>' + escapeHtml(r.referrer) + '</td><td>' + fmt(r.visits) + '</td><td><div class="bar-cell"><div class="bar" style="width:' + w + '%"></div><span>' + r.percent + '%</span></div></td></tr>';
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
    const [ts, today] = await Promise.all([
      api('/api/admin/timeseries?days=30&metric=tests'),
      api('/api/admin/types?date=today')
    ]);
    const total = today.cumulative_total || 0;
    const todayTotal = today.total || 0;
    document.getElementById('tests-kpis').innerHTML = [
      kpiCard('今日完成', fmt(todayTotal), null),
      kpiCard('累计完成', fmt(total), null),
      kpiCard('转化率（今日）', todayTotal > 0 && charts.hourly ? (Math.round(todayTotal / (charts.hourly.data.datasets[0].data.reduce((a,b)=>a+b,0)) * 1000) / 10) + '%' : '—', null)
    ].join('');
    const ctx = document.getElementById('chart-tests-trend');
    if (charts.testsTrend) charts.testsTrend.destroy();
    const pts = ts.points || [];
    charts.testsTrend = new Chart(ctx, {
      type: 'line',
      data: { labels: pts.map(function (p) { return p.date.slice(5); }), datasets: [{ label: '测试完成', data: pts.map(function (p) { return p.tests; }), borderColor: '#ff9500', backgroundColor: 'rgba(255,149,0,0.1)', tension: 0.3, fill: true }] },
      options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true } } }
    });
    updateLastUpdate();
  } catch (e) { if (e.message !== 'unauthorized') toast('加载失败: ' + e.message, true); }
}

// ===== Types Tab =====
async function loadTypesTab() {
  try {
    const data = await api('/api/admin/types?date=today');
    // 累计横向柱状
    const ctx1 = document.getElementById('chart-types-cumulative');
    if (charts.typesCumul) charts.typesCumul.destroy();
    const cumul = data.cumulative || [];
    charts.typesCumul = new Chart(ctx1, {
      type: 'bar',
      data: { labels: cumul.map(function (d) { return d.type; }), datasets: [{ label: '累计', data: cumul.map(function (d) { return d.count; }), backgroundColor: 'rgba(0,122,255,0.6)' }] },
      options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true } } }
    });
    // 今日横向柱状
    const ctx2 = document.getElementById('chart-types-today-bar');
    if (charts.typesTodayBar) charts.typesTodayBar.destroy();
    const today = data.distribution || [];
    charts.typesTodayBar = new Chart(ctx2, {
      type: 'bar',
      data: { labels: today.map(function (d) { return d.type; }), datasets: [{ label: '今日', data: today.map(function (d) { return d.count; }), backgroundColor: 'rgba(255,149,0,0.6)' }] },
      options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true } } }
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
      kpiCard('总会话数', fmt(s.total_sessions), null),
      kpiCard('平均时长', fmtDuration(s.avg_duration_sec || 0), null),
      kpiCard('平均页数', s.avg_page_count || 0, null),
      kpiCard('跳出率', Math.round((s.bounce_rate || 0) * 100) + '%', null)
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
  // 生成表头：空格 + 24 个小时
  let html = '<div class="heatmap-grid"><div></div>';
  for (let h = 0; h < 24; h++) html += '<div class="heatmap-label" style="text-align:center">' + h + '</div>';
  // 每行：日期标签 + 24 个格子
  data.matrix.forEach(function (row, i) {
    const daysAgo = data.matrix.length - 1 - i;
    const d = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
    const label = (d.getMonth()+1) + '/' + d.getDate();
    html += '<div class="heatmap-label">' + label + '</div>';
    row.forEach(function (v) {
      const intensity = v / max;
      const bg = v === 0 ? 'var(--color-background-100)' : 'rgba(0,122,255,' + (0.15 + intensity * 0.85) + ')';
      html += '<div class="heatmap-cell" style="background:' + bg + '" title="' + v + ' 次">' + v + '</div>';
    });
  });
  html += '</div>';
  wrap.innerHTML = html;
}
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
    document.getElementById('last-update').textContent = '最后更新：' + Math.round((Date.now() - lastUpdateTime) / 1000) + ' 秒前  ·  下次刷新：' + countdown + 's';
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
