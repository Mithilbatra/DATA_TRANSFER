// Self-check: node test.js
const assert = require('assert/strict');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PORT = 3999, base = `http://127.0.0.1:${PORT}`;
const srv = spawn(process.execPath, [__dirname + '/server.js'], { env: { ...process.env, PORT, UDP_PORT: 41999 }, stdio: ['ignore', 'pipe', 'inherit'] });

// status of a request whose Host header claims to be another site (DNS rebinding)
const rebound = () => new Promise(resolve => http.request({ port: PORT, method: 'POST', path: '/api/share', headers: { host: 'evil.example' } }, r => resolve(r.statusCode)).end());

const statusFrom = (localAddress, path) => new Promise((resolve, reject) =>
  http.get({ port: PORT, host: '127.0.0.1', path, localAddress, agent: false }, r => { r.resume(); resolve(r.statusCode); }).on('error', reject));

srv.stdout.once('data', async () => {
  try {
    const { code } = await (await fetch(base + '/api/share', { method: 'POST' })).json();
    assert.match(code, /^\d{6}$/);
    assert.equal(await rebound(), 403);

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

    const wrong = String((+code + 1) % 1e6).padStart(6, '0');
    assert.equal((await fetch(`${base}/api/find/${wrong}`)).status, 404); // counts as 1 wrong attempt
    for (let k = 0; k < 4; k++) assert.equal((await fetch(`${base}/share/${wrong}`)).status, 404);
    assert.equal((await fetch(`${base}/share/${code}`)).status, 429); // locked out, even with the right code

    if (process.platform === 'linux') { // only Linux answers on all of 127.0.0.0/8, giving us extra "devices"
      for (const n of [2, 3, 4]) for (let k = 0; k < 5; k++) assert.equal(await statusFrom(`127.0.0.${n}`, `/share/${wrong}`), 404);
      assert.equal(await statusFrom('127.0.0.5', `/share/${code}`), 429); // 20 wrong in total locks everyone out
    }
    console.log('all checks passed');
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  }
  srv.kill();
});
