// In-memory static file server with precompressed brotli/gzip variants and ETags.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOUNTS = [['/', path.join(root, 'public')], ['/shared/', path.join(root, 'shared')]];

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.webmanifest', '.svg']);

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'",
};

const files = new Map();

function walk(dir, urlBase) {
  if (!fs.existsSync(dir)) return;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) { walk(full, urlBase + ent.name + '/'); continue; }
    const ext = path.extname(ent.name);
    if (!TYPES[ext]) continue;
    const body = fs.readFileSync(full);
    const entry = {
      type: TYPES[ext],
      body,
      etag: '"' + crypto.createHash('sha1').update(body).digest('base64url').slice(0, 16) + '"',
    };
    if (COMPRESSIBLE.has(ext) && body.length > 512) {
      entry.br = zlib.brotliCompressSync(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });
      entry.gzip = zlib.gzipSync(body, { level: 9 });
    }
    files.set(urlBase + ent.name, entry);
  }
}
for (const [base, dir] of MOUNTS) walk(dir, base);

export function serveStatic(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    return res.end();
  }
  let url = req.url.split('?')[0];
  if (url === '/' || !path.extname(url)) url = '/index.html'; // SPA fallback (e.g. /?room=ABCD)
  const f = files.get(url);
  if (!f) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }
  // Files have no hashed names, so always revalidate; the ETag makes that a cheap 304.
  const headers = { ...SECURITY_HEADERS, 'Content-Type': f.type, ETag: f.etag, 'Cache-Control': 'no-cache', Vary: 'Accept-Encoding' };
  if (req.headers['if-none-match'] === f.etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  const ae = req.headers['accept-encoding'] || '';
  let body = f.body;
  if (f.br && /\bbr\b/.test(ae)) { body = f.br; headers['Content-Encoding'] = 'br'; }
  else if (f.gzip && /\bgzip\b/.test(ae)) { body = f.gzip; headers['Content-Encoding'] = 'gzip'; }
  headers['Content-Length'] = body.length;
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
}
