// ===== 提取 getTypeKey 核心逻辑测试 =====
var DIM_INFER_WEIGHTS = [
  [0,1,1,1],[1,0,1,1],[1,1,0,1],[1,1,1,0]
];
var DIM_PRIORS = [null,null,null,null];
var ACQ_WEIGHT = 1.3;

function weightedVote(detailArr) {
  var w = 0;
  for (var i = 0; i < detailArr.length; i++) {
    var weight = detailArr[i].raw < 0 ? ACQ_WEIGHT : 1;
    w += detailArr[i].c * weight;
  }
  if (w > 0) return 'pro';
  if (w < 0) return 'con';
  return null;
}
function inferFromMeasured(letters, dimIdx, measured) {
  var campA = ['O','M','P','E'];
  var s = 0;
  for (var k = 0; k < 4; k++) {
    if (k === dimIdx || !measured[k]) continue;
    var v = (campA.indexOf(letters[k]) >= 0) ? 1 : -1;
    s += DIM_INFER_WEIGHTS[dimIdx][k] * v;
  }
  if (s > 0) return 'pro';
  if (s < 0) return 'con';
  return null;
}
function priorVote(dimIdx) {
  var p = DIM_PRIORS[dimIdx];
  if (p === null) return Math.random() < 0.5 ? 'pro' : 'con';
  return Math.random() < p ? 'pro' : 'con';
}

function getTypeKey(scoresObj) {
  var scores = scoresObj.total;
  var detail = scoresObj.detail;
  var dims = [
    { name: 'so', neg: 'S', pos: 'O' },
    { name: 'fe', neg: 'F', pos: 'M' },
    { name: 'rp', neg: 'R', pos: 'P' },
    { name: 'exre', neg: 'E', pos: 'Re' }
  ];
  var letters = [null,null,null,null];
  var measured = [false,false,false,false];
  var confidence = [null,null,null,null];
  var tied = [];
  for (var i = 0; i < 4; i++) {
    if (scores[i] < 0) { letters[i] = dims[i].neg; measured[i] = true; confidence[i] = 'measured'; }
    else if (scores[i] > 0) { letters[i] = dims[i].pos; measured[i] = true; confidence[i] = 'measured'; }
    else tied.push(i);
  }

  // ===== 2 维平分时：阵营一致性联合破平 =====
  if (tied.length === 2) {
    var CAMP_A = ['O','M','P','E'];
    var campScore = 0;
    for (var k = 0; k < 4; k++) {
      if (measured[k]) campScore += (CAMP_A.indexOf(letters[k]) >= 0) ? 1 : -1;
    }
    if (campScore !== 0) {
      var targetCamp = campScore > 0 ? 'A' : 'B';
      for (var t = 0; t < tied.length; t++) {
        var idx = tied[t];
        var posLetter = dims[idx].pos;
        var negLetter = dims[idx].neg;
        var isPosCampA = CAMP_A.indexOf(posLetter) >= 0;
        letters[idx] = (targetCamp === 'A')
          ? (isPosCampA ? posLetter : negLetter)
          : (isPosCampA ? negLetter : posLetter);
        confidence[idx] = 'camp-infer';
      }
      return { key: letters.join('-'), confidence: confidence };
    }
  }
  if (tied.length >= 3) return { key: 'HYBRID', confidence: confidence };

  var remain1 = [];
  for (var t = 0; t < tied.length; t++) {
    var idx = tied[t];
    var v1 = weightedVote(detail[dims[idx].name]);
    if (v1) { letters[idx] = (v1 === 'pro') ? dims[idx].pos : dims[idx].neg; confidence[idx] = 'vote'; }
    else remain1.push(idx);
  }
  var remain2 = [];
  for (var t2 = 0; t2 < remain1.length; t2++) {
    var idx2 = remain1[t2];
    var v2 = inferFromMeasured(letters, idx2, measured);
    if (v2) { letters[idx2] = (v2 === 'pro') ? dims[idx2].pos : dims[idx2].neg; confidence[idx2] = 'inferred'; }
    else remain2.push(idx2);
  }
  for (var t3 = 0; t3 < remain2.length; t3++) {
    var idx3 = remain2[t3];
    var v3 = priorVote(idx3);
    letters[idx3] = (v3 === 'pro') ? dims[idx3].pos : dims[idx3].neg;
    confidence[idx3] = 'prior';
  }
  return { key: letters.join('-'), confidence: confidence };
}

// ===== 测试用例 =====
var pass = 0, fail = 0;
function assert(name, actual, expected) {
  if (actual === expected) { console.log('  PASS: ' + name + ' => ' + actual); pass++; }
  else { console.log('  FAIL: ' + name + ' => got ' + actual + ', expected ' + expected); fail++; }
}

console.log('--- 测试 1: 用户示例 O,M 实测 + rp,exre 平分 -> O-M-P-E ---');
var r1 = getTypeKey({ total: [5, 5, 0, 0], detail: { so:[], fe:[], rp:[], exre:[] } });
assert('用户示例', r1.key, 'O-M-P-E');
assert('confidence[2] camp-infer', r1.confidence[2], 'camp-infer');
assert('confidence[3] camp-infer', r1.confidence[3], 'camp-infer');

console.log('--- 测试 2: S,F 实测(camp B) + rp,exre 平分 -> S-F-R-Re ---');
// exre 维度反向：neg=E(campA), pos=Re(campB)。campB target -> Re
var r2 = getTypeKey({ total: [-5, -5, 0, 0], detail: { so:[], fe:[], rp:[], exre:[] } });
assert('阵营 B 联合破平', r2.key, 'S-F-R-Re');
assert('rp->R camp-infer', r2.confidence[2], 'camp-infer');
assert('exre->Re camp-infer', r2.confidence[3], 'camp-infer');

console.log('--- 测试 3: O,E 实测(均campA) + fe,rp 平分 -> 联合破平 ---');
// scores[3]<0 -> letters[3]='E'(campA)。O+E 均 campA -> campScore=+2 -> targetCamp A
var r3 = getTypeKey({ total: [5, 0, 0, -5], detail: { so:[], fe:[], rp:[], exre:[] } });
assert('O,E 联合破平', r3.key, 'O-M-P-E');
assert('fe camp-infer', r3.confidence[1], 'camp-infer');

console.log('--- 测试 4: 3 维平分仍 HYBRID ---');
var r4 = getTypeKey({ total: [5, 0, 0, 0], detail: { so:[], fe:[], rp:[], exre:[] } });
assert('3 维平分 HYBRID', r4.key, 'HYBRID');

console.log('--- 测试 5: 4 维全平分仍 HYBRID ---');
var r5 = getTypeKey({ total: [0, 0, 0, 0], detail: { so:[], fe:[], rp:[], exre:[] } });
assert('4 维平分 HYBRID', r5.key, 'HYBRID');

console.log('--- 测试 6: 1 维平分仍走单维裁决链 ---');
// O,M,E 实测(均campA) + rp 平分。tied.length===1 不进 camp 块
// inferFromMeasured: O+M+E = +3 -> 'pro' -> P
var r6 = getTypeKey({ total: [5, 5, 0, -5], detail: { so:[], fe:[], rp:[], exre:[] } });
assert('1 维平分走单维 inferred', r6.key, 'O-M-P-E');
assert('rp inferred', r6.confidence[2], 'inferred');

console.log('--- 测试 7: M,P 实测(campA) + so,exre 平分 -> O-M-P-E ---');
var r7 = getTypeKey({ total: [0, 5, 5, 0], detail: { so:[], fe:[], rp:[], exre:[] } });
assert('M,P 实测联合破平', r7.key, 'O-M-P-E');

console.log('--- 测试 8: O,Re 实测(campA+campB 抵消) + fe,rp 平分 -> 单维 ---');
// O(campA+1), Re(campB-1) -> campScore=0 -> 单维
var r8 = getTypeKey({ total: [5, 0, 0, 5], detail: { so:[], fe:[], rp:[], exre:[] } });
console.log('  O,Re 抵消结果: ' + r8.key + ' confidence: ' + r8.confidence.join(','));
assert('O,Re 抵消非 HYBRID', r8.key !== 'HYBRID', true);

console.log('');
console.log('===== 结果: ' + pass + ' passed, ' + fail + ' failed =====');
