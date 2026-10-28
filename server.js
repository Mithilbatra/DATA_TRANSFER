// Data Transfer: share files on the local network with a 6-digit code. No dependencies.
const http = require('http');
const dgram = require('dgram');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream');

const PORT = +process.env.PORT || 3000;
const UDP_PORT = +process.env.UDP_PORT || 41234;
const TTL = 15 * 60e3;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'data-transfer-'));
const shares = new Map(); // code -> { dir, n, files: [{ name, size, file }] }
const fails = new Map(); // ip -> { n, t }: wrong codes per minute

process.on('exit', () => fs.rmSync(ROOT, { recursive: true, force: true }));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit());

const lan = () => Object.values(os.networkInterfaces()).flat().filter(i => i.family === 'IPv4' && !i.internal);

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const blocked = ip => { const f = fails.get(ip); return f && Date.now() - f.t < 60e3 && f.n >= 5; };
function fail(ip) {
  const f = fails.get(ip);
  if (!f || Date.now() - f.t >= 60e3) fails.set(ip, { n: 1, t: Date.now() });
  else f.n++;
}
setInterval(() => { for (const [ip, f] of fails) if (Date.now() - f.t >= 60e3) fails.delete(ip); }, 60e3).unref();

// The share for a code typed by someone on the network, or undefined after sending the error.
function lookup(req, res, code) {
  const ip = req.socket.remoteAddress;
  if (blocked(ip)) return send(res, 429, { error: 'Too many wrong codes, wait a minute' });
  const s = shares.get(code);
  if (!s) { fail(ip); return send(res, 404, { error: 'No share with that code' }); }
  return s;
}

function drop(code) {
  try { fs.rmSync(shares.get(code).dir, { recursive: true, force: true }); } catch {} // a file may still be open on Windows
  shares.delete(code);
}

// RFC 5987 filename*, so any name (unicode, quotes) survives the header
const encodeName = name => encodeURIComponent(name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

// Ask every copy of this app on the LAN for its HTTP address. The code never goes over UDP.
function discover() {
  const self = new Set(['127.0.0.1', ...lan().map(i => i.address)]);
  const targets = ['255.255.255.255', '127.0.0.1', ...lan().map(i => {
    const mask = i.netmask.split('.');
    return i.address.split('.').map((b, k) => (b | ~mask[k]) & 255).join('.');
  })];
  return new Promise(resolve => {
    const s = dgram.createSocket('udp4'), hosts = new Set();
    s.on('error', () => {});
    s.on('message', (msg, r) => {
      const m = /^HERE (\d+)$/.exec(String(msg));
      // this machine answers on several addresses; count it once
      if (m) hosts.add(self.has(r.address) && +m[1] === PORT ? `127.0.0.1:${PORT}` : `${r.address}:${m[1]}`);
    });
    s.bind(() => {
      s.setBroadcast(true);
      for (const a of targets) s.send('FIND', UDP_PORT, a, () => {});
    });
    setTimeout(() => { s.close(); resolve([...hosts]); }, 800);
  });
}

async function find(code, host) {
  if (host && !/^[\w.-]+(:\d+)?$/.test(host)) return [400, { error: 'Sender address looks like 192.168.1.5:3000' }];
  if (host && !host.includes(':')) host += ':' + PORT;
  const hosts = host ? [host] : await discover();
  const results = await Promise.all(hosts.map(h =>
    fetch(`http://${h}/share/${code}`, { signal: AbortSignal.timeout(3000) })
      .then(async r => ({ h, status: r.status, body: await r.json() }))
      .catch(() => null)));
  const hit = results.find(r => r && r.status === 200);
  if (hit) return [200, { host: hit.h, files: hit.body }];
  const locked = results.find(r => r && r.status === 429);
  if (locked) return [429, locked.body];
  return [404, { error: results.some(Boolean) ? 'No share with that code' : 'No sender found. Enter the sender address shown on the other laptop.' }];
}

const server = http.createServer(async (req, res) => {
  const { pathname, searchParams } = new URL(req.url, 'http://x');
  // /api is the UI's own backend: this computer only, and not via a rebinding hostname
  const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)
    && /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(req.headers.host || '');
  let m;
  try {
    if (req.method === 'GET' && pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
    }
    if (pathname.startsWith('/api/') && !local) return send(res, 403, { error: 'Open the app on this computer at http://localhost:' + PORT });

    if (req.method === 'POST' && pathname === '/api/share') {
      let code;
      do code = String(crypto.randomInt(1e6)).padStart(6, '0'); while (shares.has(code));
      const dir = path.join(ROOT, code);
      fs.mkdirSync(dir);
      shares.set(code, { dir, n: 0, files: [] });
      setTimeout(() => drop(code), TTL);
      return send(res, 200, { code, addrs: lan().map(i => `${i.address}:${PORT}`) });
    }

    if (req.method === 'PUT' && (m = /^\/api\/share\/(\d{6})$/.exec(pathname))) {
      const s = shares.get(m[1]);
      if (!s) return send(res, 404, { error: 'Share expired' });
      // stored under a number, so the name can't reach the disk path
      const file = path.join(s.dir, String(s.n++));
      const name = path.basename(searchParams.get('name') || '') || 'file';
      const out = fs.createWriteStream(file);
      return pipeline(req, out, err => {
        if (err) { fs.rm(file, { force: true }, () => {}); return send(res, 500, { error: 'Upload failed' }); }
        s.files.push({ name, size: out.bytesWritten, file });
        send(res, 200, { ok: true });
      });
    }

    if (req.method === 'GET' && (m = /^\/api\/find\/(\d{6})$/.exec(pathname))) {
      const [status, body] = await find(m[1], searchParams.get('host')?.trim());
      return send(res, status, body);
    }

    if (req.method === 'GET' && (m = /^\/share\/(\d{6})$/.exec(pathname))) {
      const s = lookup(req, res, m[1]);
      return s && send(res, 200, s.files.map((f, i) => ({ i, name: f.name, size: f.size })));
    }

    if (req.method === 'GET' && (m = /^\/dl\/(\d{6})\/(\d+)$/.exec(pathname))) {
      const s = lookup(req, res, m[1]);
      if (!s) return;
      const f = s.files[m[2]];
      if (!f) return send(res, 404, { error: 'No such file' });
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': f.size,
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeName(f.name)}`,
      });
      return pipeline(fs.createReadStream(f.file), res, () => {});
    }

    send(res, 404, { error: 'Not found' });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: 'Server error' });
  }
});

// Answer "FIND" broadcasts so receivers can locate this computer
const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
udp.on('message', (msg, r) => { if (String(msg) === 'FIND') udp.send(`HERE ${PORT}`, r.port, r.address, () => {}); });
udp.on('error', e => console.error('Discovery off (receivers must type this computer\'s address):', e.message));
udp.bind(UDP_PORT);

server.listen(PORT, () => {
  console.log(`Data Transfer running. Open http://localhost:${PORT}`);
  console.log(`Address on the network: ${lan().map(i => `${i.address}:${PORT}`).join(', ') || 'none found'}`);
});
