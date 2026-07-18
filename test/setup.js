// 测试基础设施：从 cpti/index.html 提取核心逻辑到 Node 沙箱
// 用法：const { box } = require('./setup'); box.getTypeKey(...)
const fs = require('fs');
const vm = require('vm');

const html = fs.readFileSync(__dirname + '/../cpti/index.html', 'utf8');

// 提取 <script> 中内联的 JS 代码（非 src 引用）
const scriptMatches = html.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g) || [];
const inlineCode = scriptMatches
  .map(s => s.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, ''))
  .join('\n;\n');

// 构造沙箱：mock document、window、localStorage 等 DOM 依赖
const sandbox = {
  document: {
    createElement: () => ({ getContext: () => mockCtx }),
    getElementById: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {}
  },
  window: { scrollTo: () => {}, addEventListener: () => {} },
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  setTimeout, clearTimeout, setInterval, clearInterval,
  console,
  navigator: { userAgent: 'node' },
  location: { href: '', hash: '' },
  history: { pushState: () => {} },
  // mock Canvas 2d context（用于 wrap 的 measureText）
  mockCtx: null
};

const mockCtx = {
  _font: '12px sans-serif',
  set font(v) { this._font = v; },
  get font() { return this._font; },
  measureText: (s) => {
    // 粗略模拟：中文 1 字宽 = 字号 px，英文 1 字符 ≈ 字号 * 0.55
    const sizeMatch = (mockCtx._font || '').match(/(\d+)px/);
    const size = sizeMatch ? parseInt(sizeMatch[1]) : 12;
    let w = 0;
    for (const ch of s) {
      if (/[\u4e00-\u9fff（）]/.test(ch)) w += size;
      else w += size * 0.55;
    }
    return { width: w };
  },
  fillText: () => {}, fillRect: () => {}, strokeRect: () => {},
  beginPath: () => {}, closePath: () => {}, moveTo: () => {}, lineTo: () => {},
  arc: () => {}, arcTo: () => {}, fill: () => {}, stroke: () => {},
  save: () => {}, restore: () => {}, scale: () => {}, translate: () => {},
  createLinearGradient: () => ({ addColorStop: () => {} })
};
sandbox.mockCtx = mockCtx;
sandbox.document.createElement = () => ({ getContext: () => mockCtx, width: 0, height: 0 });

vm.createContext(sandbox);
// 注入导出对象，用于收集 const 声明的变量
sandbox.__exports = {};
vm.runInContext(inlineCode + '\n;(function(){try{__exports.quizData=quizData}catch(e){}try{__exports.personalities=personalities}catch(e){}try{__exports.axisColors=axisColors}catch(e){}try{__exports.state=state}catch(e){}try{__exports.dimNames=typeof dimNames!=="undefined"?dimNames:null}catch(e){}try{__exports.dimMeanings=typeof dimMeanings!=="undefined"?dimMeanings:null}catch(e){}})();', sandbox);

// 导出沙箱中的核心函数
module.exports = {
  box: sandbox,
  mockCtx,
  quizData: sandbox.__exports.quizData,
  personalities: sandbox.__exports.personalities,
  axisColors: sandbox.__exports.axisColors,
  state: sandbox.__exports.state
};
