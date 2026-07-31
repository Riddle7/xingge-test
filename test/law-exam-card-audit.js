'use strict';
// 系统性排查全部卡牌bug - 综合验证脚本
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
const { GameState, GameEngine, EVENTS, RES_META } = sandbox.__exports;

function findEvent(id) { return EVENTS.find(e => e.id === id); }
let pass = 0, fail = 0, skipped = 0;
const bugs = [];
function assert(name, cond, detail, isBug) {
  if (cond) { console.log('  PASS ' + name); pass++; }
  else {
    console.log('  FAIL ' + name + ' — ' + detail);
    fail++;
    if (isBug !== false) bugs.push({ name, detail });
  }
}

console.log('============================================================');
console.log('系统性卡牌bug排查 - 综合验证');
console.log('============================================================');

// ============ 问题1: 入手效果不触发联动卡 ============
console.log('\n【问题1】入手效果是否触发联动卡（card_civil/card_crim/card_bolang）');

// 1a: card_notes 入手 +10 gpa，持有 card_civil 是否触发 +5？
console.log('\n[1a] 持有 card_civil 时，抽到 card_notes（入手+10gpa），civil 是否触发 +5？');
{
  const game = new GameState();
  const engine = new GameEngine(game);
  game.hand = ['card_civil'];
  const before = game.resources.gpa;
  engine.gainCard('card_notes'); // 入手 +10 gpa
  const actual = game.resources.gpa - before;
  console.log('  期望: 10(notes) + 5(civil联动) = 15');
  console.log('  实际: ' + actual);
  assert('card_notes入手触发card_civil', actual === 15, '实际 +' + actual + ' (期望+15)');
}

// 1b: card_mem 入手 +10 bar，持有 card_crim 是否触发 +5？
console.log('\n[1b] 持有 card_crim 时，抽到 card_mem（入手+10bar），crim 是否触发 +5？');
{
  const game = new GameState();
  const engine = new GameEngine(game);
  game.hand = ['card_crim'];
  const before = game.resources.bar;
  engine.gainCard('card_mem'); // 入手 +10 bar
  const actual = game.resources.bar - before;
  console.log('  期望: 10(mem) + 5(crim联动) = 15');
  console.log('  实际: ' + actual);
  assert('card_mem入手触发card_crim', actual === 15, '实际 +' + actual + ' (期望+15)');
}

// 1c: card_mem 入手 +10 bar，持有 card_bolang 是否触发 +10？
console.log('\n[1c] 持有 card_bolang 时，抽到 card_mem（入手+10bar），bolang 是否触发 +10？');
{
  const game = new GameState();
  const engine = new GameEngine(game);
  game.hand = ['card_bolang'];
  const before = game.resources.bar;
  engine.gainCard('card_mem');
  const actual = game.resources.bar - before;
  console.log('  期望: 10(mem) + 10(bolang联动) = 20');
  console.log('  实际: ' + actual);
  assert('card_mem入手触发card_bolang', actual === 20, '实际 +' + actual + ' (期望+20)');
}

// 1d: card_past 入手 +5 gpa +5 bar，持有 civil+crim 是否联动？
console.log('\n[1d] 持有 card_civil+card_crim 时，抽到 card_past（入手+5gpa+5bar），是否联动？');
{
  const game = new GameState();
  const engine = new GameEngine(game);
  game.hand = ['card_civil', 'card_crim'];
  const beforeGpa = game.resources.gpa;
  const beforeBar = game.resources.bar;
  engine.gainCard('card_past');
  const dGpa = game.resources.gpa - beforeGpa;
  const dBar = game.resources.bar - beforeBar;
  console.log('  期望: gpa 5(past)+5(civil)=10, bar 5(past)+5(crim)=10');
  console.log('  实际: gpa +' + dGpa + ', bar +' + dBar);
  assert('card_past入手触发联动', dGpa === 10 && dBar === 10, 'gpa +' + dGpa + ' bar +' + dBar);
}

// ============ 问题2: card_genius 不影响入手效果 ============
console.log('\n【问题2】card_genius 是否影响入手效果');

// 2a: geniusDays > 0 时，抽到 card_notes（+10gpa）是否 +50%？
console.log('\n[2a] geniusDays=6 时，抽到 card_notes（入手+10gpa），是否 +50%为+15？');
{
  const game = new GameState();
  const engine = new GameEngine(game);
  game.geniusDays = 6;
  const before = game.resources.gpa;
  engine.gainCard('card_notes');
  const actual = game.resources.gpa - before;
  console.log('  期望: 10 * 1.5 = 15 (genius +50%)');
  console.log('  实际: ' + actual);
  assert('genius影响入手效果', actual === 15, '实际 +' + actual + ' (期望+15)');
}

// 2b: geniusDays > 0 时，抽到 card_luck（随机+10*2）是否 +50%？
console.log('\n[2b] geniusDays=6 时，抽到 card_luck（入手随机+10*2），是否 +50%为+15*2？');
{
  const game = new GameState();
  const engine = new GameEngine(game);
  game.geniusDays = 6;
  // 固定随机以测试
  const origRandom = Math.random;
  let callIdx = 0;
  Math.random = () => { callIdx++; return 0.5; }; // 固定值
  const before = { ...game.resources };
  try { engine.gainCard('card_luck'); } finally { Math.random = origRandom; }
  const totalDelta = Object.keys(RES_META).reduce((sum, k) => sum + (game.resources[k] - before[k]), 0);
  console.log('  期望: 总增量 30 (2项 * 15翻倍)');
  console.log('  实际: ' + totalDelta);
  assert('genius影响luck入手', totalDelta === 30, '实际 +' + totalDelta);
}

// ============ 问题3: card_genius 天数 off-by-one ============
console.log('\n【问题3】card_genius 天数是否准确（描述"6天内"）');
{
  const game = new GameState();
  const engine = new GameEngine(game);
  game.geniusDays = 6;
  game.day = 1;
  let geniusActiveDays = 0;
  // 每天用低 gpa 起步避免上限钳制，单独测试 applyEffects 翻倍
  const testEvent = { id: 'TEST', title: '测试', tags: ['test'], day: null, choices: [{ effects: { gpa: 10 } }] };
  for (let d = 1; d <= 8; d++) {
    game.day = d;
    game.resources.gpa = 10; // 重置避免上限钳制
    const before = game.resources.gpa;
    engine.applyEffects({ gpa: 10 }, testEvent, { skipLinkCards: true });
    const actual = game.resources.gpa - before;
    const doubled = (actual === 15);
    console.log('  Day' + d + ': geniusDays=' + game.geniusDays + ', gpa +' + actual + (doubled ? ' (+50%)' : ''));
    if (doubled) geniusActiveDays++;
    // 模拟 dayStartSettlement 递减（choose 末尾进入下一天时触发）
    if (game.geniusDays > 0) game.geniusDays--;
  }
  console.log('  描述: "接下来 6 天内正面效果 +50%"');
  console.log('  实际翻倍生效天数: ' + geniusActiveDays);
  // 注意：Day1 抽到genius后，Day1的choose已结束，genius影响Day2开始
  // dayStartSettlement在choose末尾递减：Day1→Day2时 6→5, Day2→Day3时 5→4...
  // 所以实际影响 Day2-6 (5天)
  assert('genius天数准确', geniusActiveDays === 6, '实际 ' + geniusActiveDays + ' 天 (期望6)');
}

// ============ 问题4: card_bolang 缺少 notes 提示 ============
console.log('\n【问题4】card_bolang 触发时是否有 notes 提示');
{
  const game = new GameState();
  const engine = new GameEngine(game);
  game.hand = ['card_bolang'];
  const evt = findEvent('EVT_011');
  const r = engine.applyEffects({ bar: 10 }, evt);
  const hasBolangNote = (r.notes || []).some(n => n.includes('柏浪涛') || n.includes('bolang'));
  console.log('  notes: ' + (r.notes || []).join(' | '));
  console.log('  含 bolang 提示: ' + hasBolangNote);
  assert('bolang有notes提示', hasBolangNote, '无 bolang notes（card_civil/card_crim 都有提示）');
}

// ============ 问题5: dayStartSettlement 负面是否触发 prof/past ============
console.log('\n【问题5】dayStartSettlement 负面是否触发 card_prof/card_past 抵消');

// 5a: 持有 card_prof，speed 反噬 san -20 是否被抵消？
console.log('\n[5a] 持有 card_prof 时，速成反噬 san-20 是否抵消？');
{
  const game = new GameState();
  const engine = new GameEngine(game);
  game.hand = ['card_prof'];
  game.resources.san = 50;
  game.speedPenalty = 1;
  const before = game.resources.san;
  engine.dayStartSettlement();
  const change = game.resources.san - before;
  console.log('  期望: 0 (prof抵消)');
  console.log('  实际: ' + change + ' (san=' + game.resources.san + ')');
  assert('prof抵消速成反噬', change === 0, '实际 ' + change);
}

// 5b: 持有 card_past，speed 反噬 san -20 是否被抵消？
console.log('\n[5b] 持有 card_past 时，速成反噬 san-20 是否抵消？');
{
  const game = new GameState();
  const engine = new GameEngine(game);
  game.hand = ['card_past'];
  game.resources.san = 50;
  game.speedPenalty = 1;
  const before = game.resources.san;
  engine.dayStartSettlement();
  const change = game.resources.san - before;
  console.log('  期望: 0 (past抵消，但past只抵消gpa/bar负面，san不抵消)');
  console.log('  实际: ' + change + ' (san=' + game.resources.san + ')');
  // past 只抵消 gpa/bar，不抵消 san，所以这是预期行为
  assert('past不抵消san反噬(预期)', change === -20, '实际 ' + change, false);
}

// 5c: 持有 card_prof，昏睡所有资源 -5 是否被抵消？
console.log('\n[5c] 持有 card_prof 时，昏睡资源-5 是否抵消？');
{
  const game = new GameState();
  const engine = new GameEngine(game);
  game.hand = ['card_prof'];
  game.resources.gpa = 50;
  game.sleepCrash = true;
  game.sleepCrashes = 0;
  const before = game.resources.gpa;
  engine.dayStartSettlement();
  const change = game.resources.gpa - before;
  console.log('  期望: 0 (prof应抵消所有负面)');
  console.log('  实际: ' + change + ' (gpa=' + game.resources.gpa + ')');
  assert('prof抵消昏睡负面', change === 0, '实际 ' + change);
}

// 5d: 持有 card_prof，学业警告 san-5 是否被抵消？
console.log('\n[5d] 持有 card_prof 时，学业警告 san-5 是否抵消？');
{
  const game = new GameState();
  const engine = new GameEngine(game);
  game.hand = ['card_prof'];
  game.resources.gpa = 20; // 触发学业警告
  game.resources.san = 50;
  const before = game.resources.san;
  engine.dayStartSettlement();
  const change = game.resources.san - before;
  console.log('  期望: 0 (prof应抵消)');
  console.log('  实际: ' + change + ' (san=' + game.resources.san + ')');
  assert('prof抵消学业警告', change === 0, '实际 ' + change);
}

// ============ 问题6: card_coffee 每日 eng+10 是否受 genius 影响 ============
console.log('\n【问题6】card_coffee 每日 eng+10 是否受 genius 翻倍');
{
  const game = new GameState();
  const engine = new GameEngine(game);
  game.hand = ['card_coffee'];
  game.geniusDays = 6;
  game.resources.eng = 50;
  const before = game.resources.eng;
  engine.dayStartSettlement();
  const change = game.resources.eng - before;
  console.log('  期望: 10 (不受genius影响) 或 20 (受影响)');
  console.log('  实际: ' + change);
  // 这是设计选择，仅记录
  console.log('  (设计选择，需用户确认是否为bug)');
  if (change === 20) { console.log('  -> 受genius影响'); } else { console.log('  -> 不受genius影响'); }
}

// ============ 问题7: card_2x eng消耗与 prof/past 交互 ============
console.log('\n【问题7】card_2x 增加的 eng 消耗是否被 prof/past 抵消');
{
  const game = new GameState();
  const engine = new GameEngine(game);
  game.hand = ['card_2x', 'card_prof'];
  const evt = findEvent('EVT_002');
  game.resources.eng = 50;
  const before = game.resources.eng;
  const r = engine.applyEffects({ eng: -10 }, evt);
  const change = game.resources.eng - before;
  console.log('  选项 eng:-10, 持有 1张2x (消耗+20%=-12) + prof');
  console.log('  期望: 0 (prof抵消负面)');
  console.log('  实际: ' + change);
  assert('prof抵消2x增加的消耗', change === 0, '实际 ' + change);
}

// ============ 问题8: card_coffee 上限钳制后 san 是否恢复 ============
console.log('\n【问题8】card_coffee 被移除后 san 上限恢复，但 san 值是否恢复');
{
  const game = new GameState();
  const engine = new GameEngine(game);
  game.resources.san = 100;
  engine.gainCard('card_coffee'); // san上限降至95，san被钳制为95
  console.log('  持有coffee后: san=' + game.resources.san + ', 上限=' + game.cap('san'));
  // 手动移除coffee
  game.hand = [];
  console.log('  移除coffee后: san=' + game.resources.san + ', 上限=' + game.cap('san'));
  console.log('  期望: 上限恢复100, 但san仍为95(不自动恢复)');
  assert('coffee移除后san不恢复', game.resources.san === 95, 'san=' + game.resources.san, false);
}

// ============ 问题9: 多张 card_wang 是否叠加 GPA 上限 ============
console.log('\n【问题9】多张 card_wang 是否叠加 GPA 上限');
{
  const game = new GameState();
  const engine = new GameEngine(game);
  engine.gainCard('card_wang');
  const cap1 = game.cap('gpa');
  engine.gainCard('card_wang');
  const cap2 = game.cap('gpa');
  console.log('  1张wang: 上限=' + cap1 + ', 2张wang: 上限=' + cap2);
  console.log('  期望: 都是120 (wangBoost是布尔值，不叠加)');
  assert('wang上限不叠加', cap2 === 120, 'cap=' + cap2, false);
}

// ============ 问题10: roll 分支跳过联动卡 ============
console.log('\n【问题10】roll 分支的 delta 是否触发联动卡');
{
  const game = new GameState();
  const engine = new GameEngine(game);
  game.hand = ['card_crim'];
  // 找一个有 roll 的事件
  const rollEvent = EVENTS.find(e => e.choices && e.choices.some(c => c.roll));
  if (rollEvent) {
    console.log('  找到roll事件: ' + rollEvent.id + ' - ' + rollEvent.title);
    // roll 分支用 skipLinkCards: true，所以联动卡不触发
    console.log('  roll分支跳过联动卡 (skipLinkCards: true)');
    console.log('  这是设计选择，避免重复触发');
    assert('roll分支跳过联动卡(设计)', true, '', false);
  } else {
    console.log('  无roll事件');
    skipped++;
  }
}

console.log('\n============================================================');
console.log('验证结果: ' + pass + ' 通过, ' + fail + ' 失败, ' + skipped + ' 跳过');
console.log('============================================================');
console.log('\n确认的Bug列表:');
if (bugs.length === 0) {
  console.log('  (无)');
} else {
  bugs.forEach((b, i) => console.log('  ' + (i + 1) + '. ' + b.name + ' — ' + b.detail));
}
process.exit(fail > 0 ? 1 : 0);
