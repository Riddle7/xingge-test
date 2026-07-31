'use strict';
// 验证 card_civil / card_past / card_prof 三张卡的修复
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'law-exam-week', 'index.html'), 'utf8');
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
let jsCode = scriptMatch[1];
const rendererIdx = jsCode.indexOf('class Renderer');
jsCode = jsCode.slice(0, rendererIdx);
jsCode += '\n;globalThis.__exports = { GameState, GameEngine, EVENTS, CARDS, ENDINGS, RES_META, RARITY_CLS };';

const sandbox = {
  console, Math, Date, Set, Map, Array, Object, JSON, Number, String, Boolean, RegExp, Error, Symbol, Promise,
  parseInt, parseFloat, isNaN, isFinite,
  setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
  requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
  localStorage: { _store: {}, getItem(k) { return this._store[k] ?? null; }, setItem(k, v) { this._store[k] = String(v); }, removeItem(k) { delete this._store[k]; } },
  document: { getElementById: () => null, createElement: () => ({ innerHTML: '', content: { firstChild: null } }), body: { appendChild: () => {} } },
  window: {}, AudioContext: function() { return { close: () => {} }; }, webkitAudioContext: function() { return { close: () => {} }; },
  navigator: { userAgent: 'node' }, location: { href: '' },
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(jsCode, sandbox, { filename: 'game.js' });
const { GameState, GameEngine, EVENTS } = sandbox.__exports;

function findEvent(id) { return EVENTS.find(e => e.id === id); }
function handStr(h) { return '[' + h.join(', ') + ']'; }
function notesStr(n) { return (n || []).join(' | '); }

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { console.log('  PASS ' + name); pass++; }
  else { console.log('  FAIL ' + name + ' — ' + detail); fail++; }
}

console.log('============================================================');
console.log('验证：card_civil / card_past / card_prof 三张卡修复');
console.log('============================================================');

// ============ card_civil 验证 ============
console.log('\n【card_civil 请求权基础】GPA 增加 +5；civil 事件额外 +5');

// 测试1：非 civil 事件 + GPA 增加 → +5
console.log('\n[1.1] 非 civil 事件 + GPA 增加 -> +5');
{
  const game = new GameState();
  const engine = new GameEngine(game);
  const evt = findEvent('EVT_002'); // 室友失恋 tags:['social']
  game.hand = ['card_civil'];
  const before = game.resources.gpa;
  const r = engine.applyEffects({ gpa: 10 }, evt);
  const bonus = game.resources.gpa - before;
  console.log('  事件: ' + evt.title + ' (social), 选项 gpa:+10');
  console.log('  notes: ' + notesStr(r.notes));
  console.log('  gpa 实际增加: ' + bonus + ' (期望 15 = 10选项 + 5卡牌)');
  assert('非civil事件 GPA增加时 +5', bonus === 15, '实际 +' + bonus);
}

// 测试2：civil 事件 + GPA 增加 → +10 (5+5)
console.log('\n[1.2] civil 事件 + GPA 增加 -> +10 (5+5叠加)');
{
  const game = new GameState();
  const engine = new GameEngine(game);
  const evt = findEvent('EVT_001'); // 民法划重点 tags:['civil','class']
  game.hand = ['card_civil'];
  const before = game.resources.gpa;
  const r = engine.applyEffects({ gpa: 10 }, evt);
  const bonus = game.resources.gpa - before;
  console.log('  事件: ' + evt.title + ' (civil), 选项 gpa:+10');
  console.log('  notes: ' + notesStr(r.notes));
  console.log('  gpa 实际增加: ' + bonus + ' (期望 20 = 10选项 + 5 + 5)');
  assert('civil事件 GPA增加时 +5+5=+10', bonus === 20, '实际 +' + bonus);
}

// 测试3：civil 事件 + GPA 不增加 → +5 (仅 civil 联动)
console.log('\n[1.3] civil 事件 + GPA 不增加 -> +5 (仅civil联动)');
{
  const game = new GameState();
  const engine = new GameEngine(game);
  const evt = findEvent('EVT_001'); // 民法划重点
  game.hand = ['card_civil'];
  const before = game.resources.gpa;
  const r = engine.applyEffects({ san: 5 }, evt); // 无 gpa
  const bonus = game.resources.gpa - before;
  console.log('  事件: ' + evt.title + ' (civil), 选项 san:+5 (无gpa)');
  console.log('  notes: ' + notesStr(r.notes));
  console.log('  gpa 实际增加: ' + bonus + ' (期望 5 = 仅civil联动)');
  assert('civil事件 GPA不增加时 +5', bonus === 5, '实际 +' + bonus);
}

// 测试4：非 civil 事件 + GPA 不增加 → 0
console.log('\n[1.4] 非 civil 事件 + GPA 不增加 -> 0');
{
  const game = new GameState();
  const engine = new GameEngine(game);
  const evt = findEvent('EVT_002');
  game.hand = ['card_civil'];
  const before = game.resources.gpa;
  const r = engine.applyEffects({ san: 5 }, evt);
  const bonus = game.resources.gpa - before;
  console.log('  gpa 变化: ' + bonus);
  assert('非civil且GPA不增加时不触发', bonus === 0, '实际 +' + bonus);
}

// 测试5：两张 card_civil 叠加
console.log('\n[1.5] 两张 card_civil + civil事件 + GPA增加 -> +20 (2*(5+5))');
{
  const game = new GameState();
  const engine = new GameEngine(game);
  const evt = findEvent('EVT_001');
  game.hand = ['card_civil', 'card_civil'];
  const before = game.resources.gpa;
  const r = engine.applyEffects({ gpa: 5 }, evt);
  const bonus = game.resources.gpa - before;
  console.log('  手牌: ' + handStr(game.hand));
  console.log('  notes: ' + notesStr(r.notes));
  console.log('  gpa 实际增加: ' + bonus + ' (期望 25 = 5选项 + 2*5 + 2*5)');
  assert('两张civil叠加 +20', bonus === 25, '实际 +' + bonus);
}

// ============ card_past 验证 ============
console.log('\n【card_past 往年真题】入手即 GPA+5、BAR+5；保留抵消负面效果');

// 测试6：入手即加 GPA 和 BAR
console.log('\n[2.1] 入手即 GPA+5, BAR+5');
{
  const game = new GameState();
  const engine = new GameEngine(game);
  const beforeGpa = game.resources.gpa;
  const beforeBar = game.resources.bar;
  engine.gainCard('card_past');
  const dGpa = game.resources.gpa - beforeGpa;
  const dBar = game.resources.bar - beforeBar;
  console.log('  入手前 gpa=' + beforeGpa + ', bar=' + beforeBar);
  console.log('  入手后 gpa=' + game.resources.gpa + ', bar=' + game.resources.bar);
  console.log('  gpa +' + dGpa + ', bar +' + dBar);
  assert('入手 GPA +5', dGpa === 5, '实际 +' + dGpa);
  assert('入手 BAR +5', dBar === 5, '实际 +' + dBar);
  assert('手牌中有 card_past', game.hasCard('card_past'), '手牌缺失');
}

// 测试7：保留原抵消负面效果
console.log('\n[2.2] 持有时抵消 GPA/BAR 负面 (消耗)');
{
  const game = new GameState();
  const engine = new GameEngine(game);
  const evt = findEvent('EVT_002');
  game.hand = ['card_past'];
  game.resources.gpa = 50;
  const before = game.resources.gpa;
  const r = engine.applyEffects({ gpa: -10 }, evt);
  const change = game.resources.gpa - before;
  console.log('  持有 card_past, 选项 gpa:-10');
  console.log('  notes: ' + notesStr(r.notes));
  console.log('  gpa 变化: ' + change + ' (期望 0, 抵消)');
  console.log('  手牌中 card_past: ' + (game.hasCard('card_past') ? '已消耗' : '消耗'));
  assert('抵消 GPA 负面', change === 0, '实际 ' + change);
  assert('card_past 已消耗', !game.hasCard('card_past'), '未消耗');
}

// ============ card_prof 验证 ============
console.log('\n【card_prof 老师的好感】任意事件负面消失');

// 测试8：非 class 事件负面消失
console.log('\n[3.1] 非 class 事件负面消失');
{
  const game = new GameState();
  const engine = new GameEngine(game);
  const evt = findEvent('EVT_002'); // tags:['social']
  game.hand = ['card_prof'];
  game.resources.gpa = 50;
  game.resources.san = 50;
  const beforeGpa = game.resources.gpa;
  const beforeSan = game.resources.san;
  const r = engine.applyEffects({ gpa: -10, san: -5 }, evt);
  console.log('  事件: ' + evt.title + ' (social, 非 class)');
  console.log('  选项 gpa:-10, san:-5');
  console.log('  gpa 变化: ' + (game.resources.gpa - beforeGpa) + ' (期望 0, 抵消)');
  console.log('  san 变化: ' + (game.resources.san - beforeSan) + ' (期望 0, 抵消)');
  assert('非class事件 gpa负面消失', game.resources.gpa - beforeGpa === 0, '实际 ' + (game.resources.gpa - beforeGpa));
  assert('非class事件 san负面消失', game.resources.san - beforeSan === 0, '实际 ' + (game.resources.san - beforeSan));
}

// 测试9：class 事件负面消失（保持原行为）
console.log('\n[3.2] class 事件负面消失 (保持原行为)');
{
  const game = new GameState();
  const engine = new GameEngine(game);
  const evt = findEvent('EVT_011'); // tags:['crim','class']
  game.hand = ['card_prof'];
  game.resources.gpa = 50;
  const before = game.resources.gpa;
  const r = engine.applyEffects({ gpa: -10 }, evt);
  console.log('  事件: ' + evt.title + ' (class), 选项 gpa:-10');
  console.log('  gpa 变化: ' + (game.resources.gpa - before) + ' (期望 0)');
  assert('class事件负面消失', game.resources.gpa - before === 0, '实际 ' + (game.resources.gpa - before));
}

// 测试10：正面效果不受影响
console.log('\n[3.3] 正面效果不受影响');
{
  const game = new GameState();
  const engine = new GameEngine(game);
  const evt = findEvent('EVT_002');
  game.hand = ['card_prof'];
  const before = game.resources.gpa;
  const r = engine.applyEffects({ gpa: 10 }, evt);
  console.log('  选项 gpa:+10, gpa 变化: ' + (game.resources.gpa - before));
  assert('正面效果保留', game.resources.gpa - before === 10, '实际 ' + (game.resources.gpa - before));
}

console.log('\n============================================================');
console.log('验证结果: ' + pass + ' 通过, ' + fail + ' 失败');
console.log('============================================================');
process.exit(fail > 0 ? 1 : 0);
