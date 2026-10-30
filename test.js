// Self-check: node test.js
const assert = require('assert/strict');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PORT = 3999, SHORT = 3998, base = `http://127.0.0.1:${PORT}`, sbase = `http://127.0.0.1:${SHORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const servers = [];
process.on('exit', () => servers.forEach(p => p.kill())); // even when a check crashes the test
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(1));
const start = (port, env = {}) => new Promise((resolve, reject) => {
  const p = spawn(process.execPath, [__dirname + '/server.js'], { env: { ...process.env, PORT: port, UDP_PORT: port + 38000, ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
  servers.push(p);
  p.stdout.once('data', () => resolve(p));
  p.once('exit', () => reject(new Error(`server on port ${port} did not start`)));
});

// status of POST /api/share with extra headers (a rebinding Host, or a page from another site)
const postShare = headers => new Promise(resolve => http.request({ port: PORT, method: 'POST', path: '/api/share', headers }, r => { r.resume(); resolve(r.statusCode); }).end());

const statusFrom = (localAddress, path) => new Promise((resolve, reject) =>
  http.get({ port: PORT, host: '127.0.0.1', path, localAddress, agent: false }, r => { r.resume(); resolve(r.statusCode); }).on('error', reject));

(async () => {
  try {
    await Promise.all([start(PORT), start(SHORT, { TTL_MS: 1500 })]);
    const { code } = await (await fetch(base + '/api/share', { method: 'POST' })).json();
    assert.match(code, /^\d{6}$/);
    assert.equal(await postShare({ host: 'evil.example' }), 403);
    assert.equal(await postShare({ 'sec-fetch-site': 'cross-site' }), 403);
    assert.equal(await postShare({ 'sec-fetch-site': 'same-origin' }), 200);

    const data = crypto.randomBytes(300_000);
    const put = await fetch(`${base}/api/share/${code}?name=${encodeURIComponent('../../ü (1).bin')}`, { method: 'PUT', body: data });
    assert.equal(put.status, 200);

    const found = await (await fetch(`${base}/api/find/${code}`)).json(); // UDP discovery
    assert.equal(found.host, `127.0.0.1:${PORT}`);
    assert.deepEqual(found.files, [{ i: 0, name: 'ü (1).bin', size: data.length }]);
    assert.equal((await (await fetch(`${base}/api/find/${code}?host=127.0.0.1:${PORT}`)).json()).files.length, 1);

    const dl = await fetch(`http://${found.host}/dl/${code}/0`);
    assert.equal(dl.headers.get('content-disposition'), "attachment; filename*=UTF-8''%C3%BC%20%281%29.bin");
    assert.ok(Buffer.from(await dl.arrayBuffer()).equals(data));
    assert.equal((await fetch(`${base}/dl/${code}/5`)).status, 404);

    // a fake sender that redirects to the real share must not be followed
    const fake = http.createServer((q, r) => { r.writeHead(302, { location: `${base}/share/${code}` }); r.end(); });
    await new Promise(r => fake.listen(3997, r));
    assert.equal((await fetch(`${base}/api/find/${code}?host=127.0.0.1:3997`)).status, 404);
    fake.close();

    const wrong = String((+code + 1) % 1e6).padStart(6, '0');
    assert.equal((await fetch(`${base}/api/find/${wrong}`)).status, 404); // counts as 1 wrong attempt
    for (let k = 0; k < 4; k++) assert.equal((await fetch(`${base}/share/${wrong}`)).status, 404);
    assert.equal((await fetch(`${base}/share/${code}`)).status, 429); // locked out, even with the right code

    if (process.platform === 'linux') { // only Linux answers on all of 127.0.0.0/8, giving us extra "devices"
      for (const n of [2, 3, 4]) for (let k = 0; k < 5; k++) assert.equal(await statusFrom(`127.0.0.${n}`, `/share/${wrong}`), 404);
      assert.equal(await statusFrom('127.0.0.5', `/share/${code}`), 429); // 20 wrong in total locks everyone out
    }

    // expiry (1.5 s here) restarts on every upload and never hits a share mid-upload
    const { code: sc } = await (await fetch(sbase + '/api/share', { method: 'POST' })).json();
    await sleep(1000);
    assert.equal((await fetch(`${sbase}/api/share/${sc}?name=a`, { method: 'PUT', body: 'a' })).status, 200);
    await sleep(1000);
    assert.equal((await fetch(`${sbase}/share/${sc}`)).status, 200); // 2 s after creation, still there
    const slow = http.request({ port: SHORT, method: 'PUT', path: `/api/share/${sc}?name=slow` });
    const slowStatus = new Promise((r, j) => slow.on('response', res => r(res.statusCode)).on('error', j));
    slow.write('x');
    await sleep(2000); // longer than the expiry, while the upload is still running
    slow.end('y');
    assert.equal(await slowStatus, 200);
    assert.equal((await (await fetch(`${sbase}/share/${sc}`)).json()).length, 2);
    await sleep(2000);
    assert.equal((await fetch(`${sbase}/share/${sc}`)).status, 404); // idle longer than the expiry: gone
    console.log('all checks passed');
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  }
  process.exit(); // a failed check can leave sockets open; don't hang
})();
