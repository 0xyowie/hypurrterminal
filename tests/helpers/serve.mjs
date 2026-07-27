// Static server that mimics Cloudflare Pages behaviour for site/:
// clean URLs (/positioning -> positioning.html), directory index, custom 404.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../site');
const PORT = Number(process.env.PORT || 4173);

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webp': 'image/webp', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.xml': 'application/xml; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
};

function resolve(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  if (clean.includes('..')) return null;
  const base = path.join(ROOT, clean);
  const candidates = clean.endsWith('/')
    ? [path.join(base, 'index.html')]
    : [base, base + '.html', path.join(base, 'index.html')];
  for (const c of candidates) {
    if (!c.startsWith(ROOT)) continue;
    try { if (fs.statSync(c).isFile()) return c; } catch {}
  }
  return null;
}

const server = http.createServer((req, res) => {
  const file = resolve(req.url);
  if (!file) {
    const nf = path.join(ROOT, '404.html');
    const body = fs.existsSync(nf) ? fs.readFileSync(nf) : 'Not found';
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(body);
  }
  const ext = path.extname(file).toLowerCase();
  const body = fs.readFileSync(file);
  res.writeHead(200, {
    'content-type': TYPES[ext] || 'application/octet-stream',
    'content-length': body.length,
    'cache-control': ext === '.json' ? 'no-store' : 'public, max-age=60',
  });
  res.end(body);
});

server.listen(PORT, '127.0.0.1', () => console.log(`serving ${ROOT} on http://127.0.0.1:${PORT}`));
