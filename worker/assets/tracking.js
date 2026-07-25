// Generative Jurisprudence 全站埋点脚本
// 部署在 stats.generative-jurisprudence.top/tracking.js
// 各页面 <script src="https://stats.generative-jurisprudence.top/tracking.js" defer></script>
// 行为：本会话首次访问某 page 时发 POST /api/event，去重存 sessionStorage
(function () {
  var API = 'https://stats.generative-jurisprudence.top/api/event';
  var SESSION_KEY = 'gj_sid';
  var SESSION_TS_KEY = 'gj_sid_ts';
  var SENT_KEY = 'gj_sent_v1';
  var SESSION_TTL = 30 * 60 * 1000; // 30 分钟无活动刷新会话

  // 读取/生成会话 ID
  var sid = null;
  try {
    sid = localStorage.getItem(SESSION_KEY);
    var lastTs = parseInt(localStorage.getItem(SESSION_TS_KEY) || '0', 10);
    if (!sid || Date.now() - lastTs > SESSION_TTL) {
      sid = 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      localStorage.setItem(SESSION_KEY, sid);
    }
    localStorage.setItem(SESSION_TS_KEY, String(Date.now()));
  } catch (e) {
    sid = null; // localStorage 禁用时降级
  }

  // 读取本会话已发过的 page 集合
  var sent = {};
  try {
    sent = JSON.parse(sessionStorage.getItem(SENT_KEY) || '{}');
  } catch (e) {}

  // 归一化 page：/cpti/index.html → /cpti/，/ → /，/cpti → /cpti/
  var page = location.pathname || '/';
  page = page.replace(/index\.html$/, '');
  if (page.length > 1 && page.endsWith('/')) {
    page = page.slice(0, -1);
  }
  if (page === '') page = '/';

  // 本会话已发过该 page，跳过
  if (sent[page]) return;
  sent[page] = 1;
  try {
    sessionStorage.setItem(SENT_KEY, JSON.stringify(sent));
  } catch (e) {}

  var payload = {
    event_type: 'page_view',
    page: page,
    session_id: sid,
    referrer: document.referrer || ''
  };
  var body = JSON.stringify(payload);

  // sendBeacon 优先（不阻塞页面卸载），降级 fetch keepalive
  if (navigator.sendBeacon) {
    try {
      navigator.sendBeacon(API, body);
      return;
    } catch (e) {}
  }
  try {
    fetch(API, { method: 'POST', body: body, headers: { 'Content-Type': 'application/json' }, keepalive: true }).catch(function () {});
  } catch (e) {}
})();
