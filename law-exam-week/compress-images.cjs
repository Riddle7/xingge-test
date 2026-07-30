// 图片压缩脚本 - 复用本地全局 sharp
// 目标：单张 < 150KB，尽量保留画质（无 alpha 的照片用 mozjpeg JPEG 最佳）
// 运行：node compress-images.cjs
const sharp = require('C:/Users/xf/AppData/Roaming/npm/node_modules/sharp');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DIRS = ['assets/endings', 'assets/events'];
const TARGET_KB = 150;        // 硬上限
const SAFE_KB = 145;          // 安全余量，确保稳定低于 150KB
const SAFE_BYTES = SAFE_KB * 1024;

// 候选参数：按画质从高到低尝试，命中即停
// 维度从 1600 起（原图 2560，显示容器最大约 420px，1600 足够覆盖 retina）
const CANDIDATES = [
  { width: 1600, quality: 82 },
  { width: 1600, quality: 80 },
  { width: 1600, quality: 78 },
  { width: 1400, quality: 80 },
  { width: 1400, quality: 76 },
  { width: 1280, quality: 80 },
  { width: 1280, quality: 75 },
  { width: 1100, quality: 78 },
  { width: 1100, quality: 72 },
  { width: 1000, quality: 72 },
  { width: 900, quality: 72 },
  { width: 900, quality: 65 },
  { width: 800, quality: 68 },
  { width: 800, quality: 60 },
];

async function compressOne(srcPng, dstJpg) {
  const origSize = fs.statSync(srcPng).size;
  let best = null;
  for (const c of CANDIDATES) {
    const buf = await sharp(srcPng)
      .resize({ width: c.width, withoutEnlargement: true })
      .jpeg({ quality: c.quality, mozjpeg: true, chromaSubsampling: '4:4:4' })
      .toBuffer();
    if (!best || buf.length < best.length) best = buf;
    if (buf.length <= SAFE_BYTES) {
      best = buf;
      break;
    }
  }
  // 若所有候选仍超目标，best 已是其中最小者；写入选最接近目标且质量最高可接受
  fs.writeFileSync(dstJpg, best);
  return { origSize, newSize: best.length };
}

(async () => {
  console.log('sharp version:', require('C:/Users/xf/AppData/Roaming/npm/node_modules/sharp/package.json').version);
  let totalOrig = 0, totalNew = 0, count = 0, over = 0;
  const report = [];
  for (const rel of DIRS) {
    const dir = path.join(ROOT, rel);
    const pngs = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.png'));
    for (const f of pngs) {
      const src = path.join(dir, f);
      const dst = path.join(dir, f.replace(/\.png$/i, '.jpg'));
      const { origSize, newSize } = await compressOne(src, dst);
      totalOrig += origSize;
      totalNew += newSize;
      count++;
      if (newSize > TARGET_KB * 1024) over++;
      report.push({ file: `${rel}/${f}`, origKB: (origSize/1024).toFixed(1), newKB: (newSize/1024).toFixed(1), ok: newSize <= TARGET_KB*1024 });
    }
  }
  for (const r of report) {
    console.log(`${r.ok?'OK ':'OVER'} ${r.file}  ${r.origKB}KB -> ${r.newKB}KB`);
  }
  console.log('----');
  console.log(`图片数: ${count}`);
  console.log(`原始总计: ${(totalOrig/1024).toFixed(1)} KB (${(totalOrig/1024/1024).toFixed(2)} MB)`);
  console.log(`压缩总计: ${(totalNew/1024).toFixed(1)} KB (${(totalNew/1024/1024).toFixed(2)} MB)`);
  console.log(`节省: ${(100*(1-totalNew/totalOrig)).toFixed(1)}%`);
  console.log(`超过 150KB 的图片数: ${over}`);
})().catch(e => { console.error(e); process.exit(1); });
