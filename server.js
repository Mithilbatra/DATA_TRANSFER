// Data Transfer: share files on the local network with a short code. No dependencies.
const http = require('http');
const dgram = require('dgram');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream');

const PORT = +process.env.PORT || 3000;
const TTL = +process.env.TTL_MS || 15 * 60e3; // since the last upload
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'data-transfer-'));
const shares = new Map(); // 6-digit secret (end of the code) -> { dir, n, busy, timer, files: [{ name, size, file }] }
const fails = new Map(); // ip -> { n, t }: wrong codes per minute

process.on('exit', () => fs.rmSync(ROOT, { recursive: true, force: true }));
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit());

const ipv4 = () => Object.values(os.networkInterfaces()).flat().filter(i => i.family === 'IPv4');
const lan = () => ipv4().filter(i => !i.internal);
const nets = () => lan().length ? lan() : ipv4(); // loopback only when offline, so one laptop alone still works
const toInt = ip => ip.split('.').reduce((n, b) => n * 256 + +b, 0);
const toIp = n => [3, 2, 1, 0].map(k => Math.floor(n / 256 ** k) % 256).join('.');
const span = i => 2 ** 32 - toInt(i.netmask); // how many addresses that network has

// This laptop's networks, the one its default route uses first (so Wi-Fi beats Docker or VM networks).
// Connecting a UDP socket only asks the OS for the route; it sends nothing.
const myNets = () => new Promise(resolve => {
  const s = dgram.createSocket('udp4');
  s.connect(9, '1.1.1.1', err => {
    const ip = err ? null : s.address().address;
    s.close();
    resolve(nets().sort((a, b) => (b.address === ip) - (a.address === ip)));
  });
});

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const blocked = (key, max = 5) => { const f = fails.get(key); return f && Date.now() - f.t < 60e3 && f.n >= max; };
function fail(ip) {
  const f = fails.get(ip);
  if (!f || Date.now() - f.t >= 60e3) fails.set(ip, { n: 1, t: Date.now() });
  else f.n++;
}
setInterval(() => { for (const [ip, f] of fails) if (Date.now() - f.t >= 60e3) fails.delete(ip); }, 60e3).unref();

// The share for a code typed by someone on the network, or undefined after sending the error.
function lookup(req, res, code) {
  const ip = req.socket.remoteAddress;
  // '*' caps guesses from all addresses together: one device can hold many IPv6 addresses
  if (blocked(ip) || blocked('*', 20)) return send(res, 429, { error: 'Too many wrong codes, wait a minute' });
  const s = shares.get(code);
  if (!s) { fail(ip); fail('*'); return send(res, 404, { error: 'No share with that code' }); }
  return s;
}

function touch(code) {
  const s = shares.get(code);
  clearTimeout(s.timer);
  s.timer = setTimeout(() => drop(code), TTL);
}

function drop(code) {
  const s = shares.get(code);
  if (s.busy) return touch(code); // never delete a share while a file is still arriving
  try { fs.rmSync(s.dir, { recursive: true, force: true }); } catch {} // a file may still be open on Windows
  shares.delete(code);
}

// RFC 5987 filename*, so any name (unicode, quotes) survives the header
const encodeName = name => encodeURIComponent(name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

// The code starts with the sender's place in the network (42 for 192.168.1.42 on home Wi-Fi). Only that
// address is asked, never the whole network: on the main network first, others only if nobody answers there.
async function find(prefix, secret, host) {
  if (host && !/^[\w.-]+(:\d+)?$/.test(host)) return [400, { error: 'Sender address looks like 192.168.1.5:3000' }];
  if (host && !host.includes(':')) host += ':' + PORT;
  const hosts = host ? [host] : (await myNets()).filter(i => prefix < span(i))
    .map(i => `${toIp(toInt(i.address) - toInt(i.address) % span(i) + prefix)}:${PORT}`);
  for (const h of hosts) {
    const r = await fetch(`http://${h}/share/${secret}`, { signal: AbortSignal.timeout(3000), redirect: 'error' }).catch(() => null);
    if (!r) continue; // nobody there: try this laptop's next network
    const body = await r.json().catch(() => null);
    if (r.ok && Array.isArray(body)) return [200, { host: h, files: body }];
    return [r.ok ? 502 : r.status, body?.error ? body : { error: `${h} isn't running Data Transfer` }];
  }
  return [404, { error: 'No sender found. Check the code, or open "Sender not found?" and enter the address shown on the other laptop.' }];
}

const server = http.createServer(async (req, res) => {
  const { pathname, searchParams } = new URL(req.url, 'http://x');
  // /api is the UI's own backend: this computer only, not via a rebinding hostname, not from other sites' pages
  const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)
    && /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(req.headers.host || '')
    && [undefined, 'same-origin'].includes(req.headers['sec-fetch-site']);
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
      shares.set(code, { dir, n: 0, busy: 0, files: [] });
      touch(code);
      const [i] = await myNets();
      return send(res, 200, { code: `${toInt(i.address) % span(i)}-${code}`, addrs: lan().map(i => `${i.address}:${PORT}`) });
    }

    if (req.method === 'PUT' && (m = /^\/api\/share\/(\d{6})$/.exec(pathname))) {
      const s = shares.get(m[1]);
      if (!s) return send(res, 404, { error: 'Share expired' });
      // stored under a number, so the name can't reach the disk path
      // shortcut: the browser can't hand over a file path, so each file is copied (needs free space equal to its size); upgrade to a desktop app if that matters
      const file = path.join(s.dir, String(s.n++));
      const name = path.basename(searchParams.get('name') || '') || 'file';
      const out = fs.createWriteStream(file);
      const code = m[1];
      s.busy++;
      return pipeline(req, out, err => {
        s.busy--;
        touch(code);
        if (err) { fs.rm(file, { force: true }, () => {}); return send(res, 500, { error: 'Upload failed' }); }
        s.files.push({ name, size: out.bytesWritten, file });
        send(res, 200, { ok: true });
      });
    }

    if (req.method === 'GET' && (m = /^\/api\/find\/(\d{1,10})(\d{6})$/.exec(pathname))) { // code digits, dash removed
      const [status, body] = await find(+m[1], m[2], searchParams.get('host')?.trim());
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

server.requestTimeout = 0; // big files can take longer than Node's 5-minute default to upload
server.on('error', e => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is busy. Try: PORT=4000 node server.js` : e.message);
  process.exit(1);
});
server.listen(PORT, () => {
  console.log(`Data Transfer running. Open http://localhost:${PORT}`);
  console.log(`Address on the network: ${lan().map(i => `${i.address}:${PORT}`).join(', ') || 'none found'}`);
});
