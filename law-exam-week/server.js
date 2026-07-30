// 零依赖静态服务器，支持 --port / --host 参数转发（npm run dev -- --port 7100）
const http = require('http');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
function argVal(name, fallback) {
  const i = args.indexOf(name);
  return i > -1 && args[i + 1] ? args[i + 1] : fallback;
}
const port = Number(argVal('--port', process.env.PORT || 7100));
const host = argVal('--host', process.env.HOST || '127.0.0.1');
const root = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(root, path.normalize(urlPath));
  if (!filePath.startsWith(root)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(port, host, () => {
  console.log(`法学院：期末周 → http://${host}:${port}/`);
});
