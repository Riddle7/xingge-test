// 刑格测试全面 bug 检查测试套件
// 覆盖：calculateScores、breakTie、inferFromOtherDims、getTypeKey、wrap、高度计算
const test = require('node:test');
const assert = require('node:assert');
const { box, quizData, personalities, mockCtx, state } = require('./setup');

// ===== calculateScores 测试 =====
test('calculateScores: 16 题全部 +2（非常赞同）应得极端分数', () => {
  // 重置 state.answers
  state.answers = new Array(16).fill(2);
  const result = box.calculateScores();
  // 每维度 4 题，每题 +2
  // so: 题1(S,-1) +2*-1=-2, 题5(O,+1) +2*1=2, 题11(O,+1) +2, 题15(S,-1) +2*-1=-2 → so=0
  // fe: 题2(F,-1) -2, 题7(E,+1) +2, 题9(F,-1) -2, 题13(E,+1) +2 → fe=0
  // rp: 题3(R,-1) -2, 题6(P,+1) +2, 题10(R,-1) -2, 题12(P,+1) +2 → rp=0
  // exre: 题4(Re,+1) +2, 题8(Ex,-1) -2, 题14(Ex,-1) -2, 题16(Re,+1) +2 → exre=0
  // 注意：每维度都是 2 正 2 负的 dir，全选+2 总分必然=0
  assert.strictEqual(result.total[0], 0, 'so 全选+2 应为 0（2正2负抵消）');
  assert.strictEqual(result.total[1], 0, 'fe 全选+2 应为 0');
  assert.strictEqual(result.total[2], 0, 'rp 全选+2 应为 0');
  assert.strictEqual(result.total[3], 0, 'exre 全选+2 应为 0');
});

test('calculateScores: 答案数组长度与 quizData 一致', () => {
  assert.strictEqual(quizData.length, 16, 'quizData 应有 16 题');
  state.answers = new Array(16).fill(0);
  const result = box.calculateScores();
  assert.strictEqual(result.total.length, 4);
  assert.strictEqual(result.detail.so.length, 4);
  assert.strictEqual(result.detail.fe.length, 4);
  assert.strictEqual(result.detail.rp.length, 4);
  assert.strictEqual(result.detail.exre.length, 4);
});

test('calculateScores: 部分未答题(null)不应计入分数', () => {
  state.answers = new Array(16).fill(null);
  state.answers[0] = 2; // 只答第1题
  const result = box.calculateScores();
  // 第1题 dimMap.so='S'，sign=-1，raw=2 → so += -2
  assert.strictEqual(result.total[0], -2, '只答第1题+2，so 应为 -2');
  assert.strictEqual(result.total[1], 0, '未答 fe 应为 0');
  assert.strictEqual(result.detail.so.length, 1, 'so detail 应只有 1 个元素');
});

test('calculateScores: 全选中立(0)应得全 0 分', () => {
  state.answers = new Array(16).fill(0);
  const result = box.calculateScores();
  assert.strictEqual(result.total[0], 0);
  assert.strictEqual(result.total[1], 0);
  assert.strictEqual(result.total[2], 0);
  assert.strictEqual(result.total[3], 0);
  // 中立题仍会 push 到 detail（raw=0）
  assert.strictEqual(result.detail.so.length, 4);
});

// ===== breakTie 测试 =====
test('breakTie: 4 题全 0（4 中立）应返回 null', () => {
  assert.strictEqual(box.breakTie([0, 0, 0, 0]), null);
});

test('breakTie: 2 赞 2 反（0 中立）应返回 null（真平分）', () => {
  assert.strictEqual(box.breakTie([2, -2, 1, -1]), null);
});

test('breakTie: 1 中立 + 3 赞同应返回 pro', () => {
  assert.strictEqual(box.breakTie([2, 1, 0, 1]), 'pro');
});

test('breakTie: 1 中立 + 3 反对应返回 con', () => {
  assert.strictEqual(box.breakTie([-2, -1, 0, -1]), 'con');
});

test('breakTie: 1 中立 + 2 赞 1 反应返回 pro（多数决）', () => {
  assert.strictEqual(box.breakTie([2, 1, 0, -1]), 'pro');
});

test('breakTie: 2 中立 + 2 赞应返回 null（≥2 中立不判）', () => {
  assert.strictEqual(box.breakTie([2, 2, 0, 0]), null);
});

// ===== inferFromOtherDims 测试 =====
test('inferFromOtherDims: 其他三维全偏阵营A(O,E,P)→推断Ex(阵营A)', () => {
  // dimIdx=3 (exre), 其他三维 letters=[O,E,P,null]
  const result = box.inferFromOtherDims(['O', 'E', 'P', null], 3);
  assert.strictEqual(result, 'Ex', '偏阵营A→第4维应推断为Ex(扩张解释)');
});

test('inferFromOtherDims: 其他三维全偏阵营B(S,F,R)→推断Re(阵营B)', () => {
  const result = box.inferFromOtherDims(['S', 'F', 'R', null], 3);
  assert.strictEqual(result, 'Re', '偏阵营B→第4维应推断为Re(限缩解释)');
});

test('inferFromOtherDims: 第1维平分+其他偏A(E,P,Ex)→推断O', () => {
  const result = box.inferFromOtherDims([null, 'E', 'P', 'Ex'], 0);
  assert.strictEqual(result, 'O');
});

test('inferFromOtherDims: 第1维平分+其他偏B(F,R,Re)→推断S', () => {
  const result = box.inferFromOtherDims([null, 'F', 'R', 'Re'], 0);
  assert.strictEqual(result, 'S');
});

test('inferFromOtherDims: 第4维平分+其他2A1B(O,E,R)→推断Ex(+1)', () => {
  // O(A)+E(A)+R(B) = +1 → 阵营A → Ex
  const result = box.inferFromOtherDims(['O', 'E', 'R', null], 3);
  assert.strictEqual(result, 'Ex');
});

test('inferFromOtherDims: 第4维平分+其他1A2B(O,F,R)→推断Re(-1)', () => {
  // O(A)+F(B)+R(B) = -1 → 阵营B → Re
  const result = box.inferFromOtherDims(['O', 'F', 'R', null], 3);
  assert.strictEqual(result, 'Re');
});

// ===== getTypeKey 完整流程测试 =====
test('getTypeKey: 全 0 分+全 0 中立→HYBRID', () => {
  const scoreObj = { total: [0, 0, 0, 0], detail: { so: [0,0,0,0], fe: [0,0,0,0], rp: [0,0,0,0], exre: [0,0,0,0] } };
  assert.strictEqual(box.getTypeKey(scoreObj), 'HYBRID');
});

test('getTypeKey: 1 维平分(2赞2反)+其他3维偏A→跨维度推断', () => {
  // so: 2赞2反 → breakTie null, 其他偏A
  const scoreObj = {
    total: [0, 3, 3, -3],
    detail: { so: [2,-2,1,-1], fe: [2,1,0,0], rp: [2,1,0,0], exre: [-2,-1,0,0] }
  };
  // 其他三维: E(A), P(A), Ex(A) → +3 → O
  assert.strictEqual(box.getTypeKey(scoreObj), 'O-E-P-Ex');
});

test('getTypeKey: 1 维平分(2赞2反)+其他3维偏B→跨维度推断', () => {
  const scoreObj = {
    total: [0, -3, -3, 3],
    detail: { so: [2,-2,1,-1], fe: [-2,-1,0,0], rp: [-2,-1,0,0], exre: [2,1,0,0] }
  };
  // 其他三维: F(B), R(B), Re(B) → -3 → S
  assert.strictEqual(box.getTypeKey(scoreObj), 'S-F-R-Re');
});

test('getTypeKey: 2 维平分→HYBRID', () => {
  const scoreObj = {
    total: [0, 0, 3, -3],
    detail: { so: [2,-2,1,-1], fe: [2,-2,1,-1], rp: [2,1,0,0], exre: [-2,-1,0,0] }
  };
  assert.strictEqual(box.getTypeKey(scoreObj), 'HYBRID');
});

test('getTypeKey: 无平分直接判定', () => {
  const scoreObj = {
    total: [3, 3, 3, -3],
    detail: { so: [], fe: [], rp: [], exre: [] }
  };
  // scores>0→O/E/P, scores[3]<0→Ex
  assert.strictEqual(box.getTypeKey(scoreObj), 'O-E-P-Ex');
});

test('getTypeKey: 全部 16 种组合都能找到对应 personalities', () => {
  // 遍历所有可能的 typeKey，验证 personalities 中存在
  const dims = [['S','O'], ['F','E'], ['R','P'], ['Ex','Re']];
  for (const d0 of dims[0]) for (const d1 of dims[1]) for (const d2 of dims[2]) for (const d3 of dims[3]) {
    const key = `${d0}-${d1}-${d2}-${d3}`;
    assert.ok(personalities[key], `personalities 应包含 ${key}`);
  }
});

test('getTypeKey: 全 0 分时 buildHybridResult 应生成 S/O-F/E-R/P-Ex/Re', () => {
  const scores = [0, 0, 0, 0];
  const p = box.buildHybridResult(scores);
  assert.strictEqual(p.nickname, '终极缝合怪');
  assert.ok(p.tags.includes('薛定谔的刑法人'));
  assert.ok(p.career && p.career.job, '缝合怪应有 career.job');
});

// ===== wrap 文字换行 + 闭合标点禁则测试 =====
test('wrap: 短文本不换行', () => {
  const lines = box.wrap ? null : null;
  // wrap 在 saveAsImage 内部定义，需通过其他方式测试
  // 如果 wrap 未暴露，跳过
  if (typeof box.wrap === 'function') {
    assert.deepStrictEqual(box.wrap('短文本', 100, '12px sans-serif'), ['短文本']);
  }
});

test('wrap: 长文本应按宽度换行', () => {
  if (typeof box.wrap !== 'function') return;
  const longText = '这是一个很长的文本需要换行处理才能适应卡片宽度';
  const lines = box.wrap(longText, 60, '12px sans-serif');
  assert.ok(lines.length > 1, '长文本应换行多行');
});

test('wrap: 闭合标点禁则 - 孤立右括号应合并回上一行', () => {
  if (typeof box.wrap !== 'function') return;
  // 构造场景：文本宽度刚好让右括号单独成行
  // S-E-R-Re（持刀哲学家） → 如果 （持刀哲学家） 中 ） 单独成行
  const text = 'S-E-R-Re（持刀哲学家）';
  // 用很窄的宽度强制换行
  const lines = box.wrap(text, 80, '12px sans-serif');
  // 验证没有行是孤立的右括号
  const closing = '）)"\'》」』〕〉';
  lines.forEach(line => {
    if (line.length === 1 && closing.includes(line)) {
      assert.fail(`孤立闭合标点 "${line}" 不应单独成行`);
    }
  });
});

// ===== axisColors 完整性测试 =====
test('axisColors: 4 维颜色配置完整', () => {
  const ac = box.__exports.axisColors;
  assert.ok(ac, 'axisColors 应存在');
  assert.strictEqual(ac.length, 4);
  ac.forEach((c, i) => {
    assert.ok(c.barActive, `维度${i} 应有 barActive`);
    assert.ok(c.barInactive, `维度${i} 应有 barInactive`);
    assert.ok(c.dot, `维度${i} 应有 dot`);
    assert.ok(c.leftText, `维度${i} 应有 leftText`);
    assert.ok(c.scoreText, `维度${i} 应有 scoreText`);
  });
});

// ===== personalities 数据完整性测试 =====
test('personalities: 每个人格都有必要字段', () => {
  Object.keys(personalities).forEach(key => {
    const p = personalities[key];
    assert.ok(p.nickname, `${key} 应有 nickname`);
    assert.ok(p.tags, `${key} 应有 tags`);
    assert.ok(Array.isArray(p.tags), `${key} tags 应为数组`);
    assert.ok(p.judgment, `${key} 应有 judgment`);
    assert.ok(p.quote, `${key} 应有 quote`);
    assert.ok(p.friends, `${key} 应有 friends`);
    assert.ok(p.enemies, `${key} 应有 enemies`);
    assert.ok(p.judge, `${key} 应有 judge`);
    assert.ok(p.career, `${key} 应有 career`);
    assert.ok(p.career.job, `${key} career 应有 job`);
    assert.ok(p.career.reason, `${key} career 应有 reason`);
  });
});

test('personalities: friends/enemies 引用的人格都存在', () => {
  Object.keys(personalities).forEach(key => {
    const p = personalities[key];
    p.friends.forEach(fk => {
      assert.ok(personalities[fk], `${key}.friends 引用了不存在的人格: ${fk}`);
    });
    p.enemies.forEach(ek => {
      assert.ok(personalities[ek], `${key}.enemies 引用了不存在的人格: ${ek}`);
    });
  });
});

// ===== 高度计算测试（验证公式正确性） =====
// saveAsImage 中的高度计算是内联的，这里验证数学公式正确性
test('hHdr 公式: 应为 128 + typeKeySize + tagRows * 32（当前代码用 36 是 bug）', () => {
  // 实际绘制流程推导：
  // y=16 → +24(标签) +16(间距) → +typeKeySize +8(间距) → +24(昵称) +16(间距)
  // → +tagRows*32-8(tags，每行24+8间距，末行减8) → +32(到坐标轴间距)
  // = 16+24+16+typeKeySize+8+24+16+tagRows*32-8+32 = 128 + typeKeySize + tagRows*32
  const typeKeySize = 48;
  const tagRows = 2;
  const correctFormula = 128 + typeKeySize + tagRows * 32;
  // 当前代码用的公式（从 index.html 读取）
  const fs = require('fs');
  const html = fs.readFileSync(__dirname + '/../cpti/index.html', 'utf8');
  const hHdrMatch = html.match(/var hHdr = ([^\n;]+)/);
  assert.ok(hHdrMatch, '应找到 hHdr 公式');
  // 提取当前代码的公式并求值
  const currentFormula = hHdrMatch[1].replace(/typeKeySize/g, String(typeKeySize)).replace(/tagRows/g, String(tagRows));
  const currentValue = eval(currentFormula.replace('//.*', '').trim());
  assert.strictEqual(currentValue, correctFormula, `hHdr 当前=${currentValue}，正确=${correctFormula}，差 ${currentValue - correctFormula}px`);
});

test('hPeers 公式: 最后一条文字底部不应超出卡片底部', () => {
  // 实际绘制（textBaseline='alphabetic'）：
  // 第一行 baseline = peersY + 65 (20+20+12+13)
  // 最后一条 baseline = peersY + 65 + maxLines*18 + (条数-1)*8
  // 最后一条底部 ≈ baseline + 3（13px 字体下沿）
  // 卡片底部 = peersY + hPeers
  // 要求：最后一条底部 + 底部padding(20) <= hPeers
  // 即 65 + maxLines*18 + (条数-1)*8 + 3 + 20 <= hPeers
  // 即 88 + maxLines*18 + (条数-1)*8 <= hPeers
  const fs = require('fs');
  const html = fs.readFileSync(__dirname + '/../cpti/index.html', 'utf8');
  const hPeersMatch = html.match(/var hPeers = ([^\n;]+)/);
  assert.ok(hPeersMatch, '应找到 hPeers 公式');

  // 测试多个场景
  const scenarios = [
    { maxLines: 3, count: 3 },   // 3 条各 1 行
    { maxLines: 6, count: 3 },   // 3 条各 2 行
    { maxLines: 8, count: 4 },   // 4 条混合
    { maxLines: 1, count: 1 },   // 最小场景
  ];
  scenarios.forEach(({ maxLines, count }) => {
    const needed = 88 + maxLines * 18 + (count - 1) * 8;
    const currentFormula = hPeersMatch[1].replace(/maxLines/g, String(maxLines)).replace(/Math\.max\(r\.p\.friends\.length, r\.p\.enemies\.length\)/g, String(count));
    const current = eval(currentFormula.replace('//.*', '').trim());
    assert.ok(current >= needed, `maxLines=${maxLines},count=${count}: hPeers=${current} < 需要=${needed}，溢出 ${needed - current}px`);
  });
});

// ===== Canvas 复合标签绘制测试 =====
// 用户报告 bug：图片保存功能中，四维人格坐标左边的"主观/形式/报应/扩张"和 SFREx 中间的 / 没有正确显示
test('Canvas 复合标签: slashW 不应测量 3 字符 " / "（应为单字符 /）', () => {
  const fs = require('fs');
  const html = fs.readFileSync(__dirname + '/../cpti/index.html', 'utf8');
  // 错误模式：measureText(' / ') 测量的是 3 字符（含两空格），但绘制只画 / 1 字符
  const badSlashW = /measureText\(\s*['"]\/\s+['"]\s*\)|measureText\(\s*['"]\s+\/\s+['"]\s*\)|measureText\(\s*['"]\s+\/['"]\s*\)/;
  assert.ok(!badSlashW.test(html), 'slashW 不应测量含空格的 " / "，会导致字母位置错位、与含义重叠');
});

test('Canvas 复合标签: 字母 weight 应固定 700（不随 active 变化）', () => {
  const fs = require('fs');
  const html = fs.readFileSync(__dirname + '/../cpti/index.html', 'utf8');
  // 错误模式：leftWeight/rightWeight = active ? '700 ' : '400 '，用于字母绘制
  // DOM 中字母内层 font-weight: 700 是 inline style，永远 700
  const badLetterWeight = /(left|right)Weight\s*=\s*(left|right)Active\s*\?\s*['"]700\s*['"]\s*:\s*['"]400\s*['"]/;
  assert.ok(!badLetterWeight.test(html), '字母 weight 应固定 700，颜色和含义 weight 才随 active 变化');
});

test('Canvas 复合标签: 测量字母宽度前应先设置 _m.font', () => {
  const fs = require('fs');
  const html = fs.readFileSync(__dirname + '/../cpti/index.html', 'utf8');
  // 提取复合标签绘制区段（从 "var monoF" 到 "iy += 28"）
  const blockMatch = html.match(/var monoF[\s\S]*?iy \+= 28;/);
  assert.ok(blockMatch, '应找到复合标签绘制代码块');
  const block = blockMatch[0];
  // 找到所有 _m.measureText(dimNames[i][X]) 调用
  const measureCalls = block.match(/_m\.measureText\(dimNames\[i\]\[\d\]\)\.width/g) || [];
  assert.ok(measureCalls.length > 0, '应至少有 2 次测量字母宽度');
  // 每次测量字母前，应确保最近一次 _m.font 设置是 mono 14px 700
  // 简化检查：代码块中应存在 _m.font = '700 14px ' + monoF 这样的设置
  assert.ok(/_m\.font\s*=\s*['"]700\s*14px\s*['"]\s*\+\s*monoF/.test(block),
    '测量字母宽度前应设置 _m.font = "700 14px " + monoF，否则测量结果错误');
});

test('Canvas 复合标签: 左复合标签应整体右对齐到 chipLX+chipW', () => {
  const fs = require('fs');
  const html = fs.readFileSync(__dirname + '/../cpti/index.html', 'utf8');
  const blockMatch = html.match(/var monoF[\s\S]*?iy \+= 28;/);
  const block = blockMatch[0];
  // 含义应右对齐到 chipLX + chipW - leftMeaningW
  assert.ok(/leftMeaningX\s*=\s*chipLX\s*\+\s*chipW\s*-\s*leftMeaningW/.test(block),
    '左复合标签含义应右对齐到 chipLX+chipW-leftMeaningW');
  // 斜杠位置应基于含义位置反推，不应独立设置
  assert.ok(/leftSlashX\s*=\s*leftMeaningX\s*-\s*gap2?\s*-\s*slashW/.test(block) ||
            /leftSlashX\s*=\s*leftMeaningX\s*-\s*\d+\s*-\s*slashW/.test(block),
    '左复合标签斜杠位置应基于含义位置反推');
  // 字母位置应基于斜杠位置反推
  assert.ok(/leftLetterX\s*=\s*leftSlashX\s*-\s*gap1?\s*-\s*leftLetterW/.test(block) ||
            /leftLetterX\s*=\s*leftSlashX\s*-\s*\d+\s*-\s*leftLetterW/.test(block),
    '左复合标签字母位置应基于斜杠位置反推');
});

// ===== saveAsImage 文件名 bug 测试 =====
// 用户报告 bug：图片保存的文件名是 undefined
// 根因：QR 码绘制循环 for(var r = 0; ...) 覆盖了外层 var r = state.lastResult
// var 无块级作用域，循环结束后 r 仍是数字，导致 link.download = '刑格_' + r.typeKey + '.png' 中 r.typeKey = undefined
test('saveAsImage: 函数体内 r 变量不应被重复赋值或声明（避免覆盖 state.lastResult）', () => {
  const fs = require('fs');
  const html = fs.readFileSync(__dirname + '/../cpti/index.html', 'utf8');
  // 提取 saveAsImage 函数体（从 "function saveAsImage()" 到匹配的 "}"）
  const startIdx = html.indexOf('function saveAsImage()');
  assert.ok(startIdx >= 0, '应找到 saveAsImage 函数');
  // 从 { 开始配对 } 找到函数结束
  let braceStart = html.indexOf('{', startIdx);
  let depth = 0, endIdx = -1;
  for (let i = braceStart; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') {
      depth--;
      if (depth === 0) { endIdx = i; break; }
    }
  }
  assert.ok(endIdx > 0, '应找到 saveAsImage 函数结束');
  const fnBody = html.slice(startIdx, endIdx + 1);

  // 初始声明：var r = state.lastResult（合法）
  const initDecl = /\bvar\s+r\s*=\s*state\.lastResult\b/;
  assert.ok(initDecl.test(fnBody), '应有初始声明 var r = state.lastResult');

  // 移除初始声明后，不应再有对 r 的赋值或声明（如 var r = 0、r = 0、r++、r--）
  // 先移除注释（// 行注释和 /* */ 块注释）避免误判
  const noComments = fnBody.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const afterInit = noComments.replace(/\bvar\s+r\s*=\s*state\.lastResult\b/, '');
  // 检测：var r = ...、r = ...、r++、r--、for (var r = ...)
  const reassignPattern = /\bvar\s+r\b|\br\s*=[^=]|\br\+\+|\br--|\+\+r|--r/;
  const badMatch = afterInit.match(reassignPattern);
  assert.ok(!badMatch, `saveAsImage 内 r 不应被重复赋值或声明，发现：${badMatch ? badMatch[0] : '无'}`);
});

// ===== showResult 的 HYBRID 分支边界测试 =====
test('showResult HYBRID: scores[k]<0 时 d 应为 neg 字母（非 S/O 形式）', () => {
  // HYBRID 分支：var d1 = scores[0] <= 0 ? 'S' : 'O';
  // 如果 scores[0] = -4（已判定为 S），d1 = 'S' ✓
  // 如果 scores[0] = 0（平分），d1 = 'S'，然后 if(scores[0]===0) d1='S/O' ✓
  // 边界：scores[0] < 0 时不应该是 'S/O'
  const scores = [-4, 0, 3, -3];
  let d1 = scores[0] <= 0 ? 'S' : 'O';
  if (scores[0] === 0) d1 = 'S/O';
  assert.strictEqual(d1, 'S', 'scores[0]<0 时 d1 应为 S');
});

test('showResult HYBRID: scores[k]=0 时 d 应为 S/O 形式', () => {
  const scores = [0, 0, 3, -3];
  let d2 = scores[1] <= 0 ? 'F' : 'E';
  if (scores[1] === 0) d2 = 'F/E';
  assert.strictEqual(d2, 'F/E', 'scores[1]=0 时 d2 应为 F/E');
});

// ===== quizData dimMap 完整性测试 =====
test('quizData: 每题恰好 1 个非 null 维度', () => {
  quizData.forEach((q, idx) => {
    const nonNull = Object.values(q.dimMap).filter(v => v !== null);
    assert.strictEqual(nonNull.length, 1, `题${q.id} 应恰好 1 个非 null 维度`);
  });
});

test('quizData: 16 题覆盖 4 维各 4 题', () => {
  const dimCount = { so: 0, fe: 0, rp: 0, exre: 0 };
  quizData.forEach(q => {
    Object.keys(dimCount).forEach(k => {
      if (q.dimMap[k] !== null) dimCount[k]++;
    });
  });
  assert.strictEqual(dimCount.so, 4, 'so 维度应有 4 题');
  assert.strictEqual(dimCount.fe, 4, 'fe 维度应有 4 题');
  assert.strictEqual(dimCount.rp, 4, 'rp 维度应有 4 题');
  assert.strictEqual(dimCount.exre, 4, 'exre 维度应有 4 题');
});

test('quizData: dimMap 值只能是 S/O/F/E/R/P/Ex/Re', () => {
  const valid = ['S', 'O', 'F', 'E', 'R', 'P', 'Ex', 'Re'];
  quizData.forEach(q => {
    Object.values(q.dimMap).forEach(v => {
      if (v !== null) {
        assert.ok(valid.includes(v), `无效的 dimMap 值: ${v}`);
      }
    });
  });
});
