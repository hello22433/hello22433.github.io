// 로컬 개발 서버. Vercel처럼 public/ 정적 파일(cleanUrls)과 api/ 함수를 함께 띄운다.
//   IGG_MEMORY_STORE=1 node scripts/dev.mjs [port]
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PUB = path.join(ROOT, 'public');
const port = Number(process.argv[2] || process.env.PORT || 3000);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.xml': 'application/xml', '.txt': 'text/plain' };

async function exists(p) { try { return (await stat(p)).isFile(); } catch { return false; } }

async function serveStatic(pathname, res) {
  const clean = decodeURIComponent(pathname).replace(/\/+$/, '') || '/';
  const candidates = clean === '/' ? ['index.html'] : [clean.slice(1), `${clean.slice(1)}.html`, `${clean.slice(1)}/index.html`];
  for (const c of candidates) {
    const file = path.join(PUB, c);
    if (!file.startsWith(PUB)) break;
    if (await exists(file)) {
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
      res.end(await readFile(file));
      return;
    }
  }
  res.writeHead(404, { 'Content-Type': TYPES['.html'] });
  res.end(await readFile(path.join(PUB, '404.html')));
}

async function serveApi(req, res, pathname) {
  const file = path.join(ROOT, `${pathname}.js`);
  if (!file.startsWith(path.join(ROOT, 'api')) || !(await exists(file))) { res.writeHead(404); res.end(); return; }
  const mod = await import(pathToFileURL(file).href);
  const fn = mod[req.method];
  if (!fn) { res.writeHead(405); res.end(); return; }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) headers.set(k, Array.isArray(v) ? v.join(',') : v);
  headers.set('x-forwarded-for', req.socket.remoteAddress || '127.0.0.1');
  const request = new Request(`http://localhost:${port}${req.url}`, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) });
  const out = await fn(request);
  res.writeHead(out.status, Object.fromEntries(out.headers));
  res.end(Buffer.from(await out.arrayBuffer()));
}

http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  try {
    if (pathname.startsWith('/api/')) await serveApi(req, res, pathname);
    else await serveStatic(pathname, res);
  } catch (e) {
    console.error(e);
    res.writeHead(500); res.end('dev server error');
  }
}).listen(port, () => console.log(`이사갈군 dev → http://localhost:${port}`));
