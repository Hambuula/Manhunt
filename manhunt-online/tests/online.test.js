'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const root = path.resolve(__dirname, '..');
async function availablePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function waitForHealth(base, child) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (child.exitCode !== null) throw new Error('The hosted server exited unexpectedly.');
    try {
      const result = await fetch(`${base}/api/health`);
      if (result.ok) return;
    } catch { /* The server is still starting. */ }
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error('Server did not become healthy in time.');
}
function spawnServer(dataFile, port) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, NODE_ENV: 'production', DATA_FILE: dataFile, PORT: String(port), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stderr.on('data', data => process.stderr.write(`[server] ${data}`));
  return child;
}
async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await exited;
}
const settings = { durationMinutes: 20, headStartMinutes: 0, radiusMeters: 2000,
  capturePoints: 100, survivalPoints: 45, pingIntervalMinutes: 2, convertCaptured: false,
  centerLat: 51.4, centerLng: 6.7 };

// This uses separate Node processes, so it verifies *real* disk restoration.
test('Cloud-style restart retains identities, mid-game progress, timers and recovery keys; GPS consent resets', { timeout: 40000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'manhunt-online-test-'));
  const file = path.join(temp, 'persistent-volume', 'games.json');
  const port = await availablePort();
  const base = `http://127.0.0.1:${port}`;
  let child;
  async function api(endpoint, payload, status = 200) {
    const res = await fetch(base + endpoint, payload === undefined ? undefined : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
    const parsed = await res.json();
    assert.equal(res.status, status, `${endpoint}: ${JSON.stringify(parsed)}`);
    return parsed;
  }
  try {
    child = spawnServer(file, port);
    await waitForHealth(base, child);
    const created = await api('/api/create', { title: 'Internet Hunt', name: 'Runner One', team: 'runner',
      settings, quests: [{ title: 'Reach river bridge', points: 60 }] }, 201);
    const code = created.code, firstToken = created.token, key = created.state.me.recoveryKey;
    assert.equal(key.length, 24);
    const hunter = await api('/api/join', { code, name: 'Hunter Two', team: 'hunter' }, 201);
    const runner2 = await api('/api/join', { code, name: 'Runner Three', team: 'runner' }, 201);
    const host = { code, token: firstToken }, adversary = { code, token: hunter.token };
    const match = await api('/api/action', { ...host, type: 'start' });
    const startedAt = match.startedAt;
    await api('/api/action', { ...host, type: 'claim-quest', questId: created.state.quests[0].id });
    await api('/api/ping', { ...host, lat: 51.4, lng: 6.7, accuracy: 8 }, 403);
    const consent = await api('/api/action', { ...host, type: 'location-consent', enabled: true });
    assert.equal(consent.locationSharing.enabled, true);
    await api('/api/ping', { ...host, lat: 51.40025, lng: 6.70015, accuracy: 9 });
    const view = await api(`/api/state?code=${code}&token=${hunter.token}`);
    assert.equal(view.locationPings.length, 1);
    assert.equal(view.locationPings[0].name, 'Runner One');
    const runnerView = await api(`/api/state?code=${code}&token=${runner2.token}`);
    assert.deepEqual(runnerView.locationPings, []);
    await api('/api/ping', { ...host, lat: 51.4, lng: 6.7, accuracy: 9 }, 429);
    await api('/api/action', { ...host, type: 'location-heartbeat' });
    await api('/api/action', { ...adversary, type: 'capture', targetId: runner2.state.me.id,
      pin: runner2.state.me.tagCode });
    assert.equal((await api(`/api/state?code=${code}&token=${firstToken}`)).scores.hunters, 100);
    assert.equal(fs.existsSync(file), true);
    const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(disk.games.length, 1);
    assert.equal(disk.games[0].players.length, 3);
    assert.equal(JSON.stringify(disk).includes('51.40025'), false, 'No location ping in persistent game data');
    await stopServer(child); child = null;

    child = spawnServer(file, port);
    await waitForHealth(base, child);
    const restored = await api(`/api/state?code=${code}&token=${firstToken}`);
    assert.equal(restored.me.name, 'Runner One');
    assert.equal(restored.me.isHost, true);
    assert.equal(restored.me.recoveryKey, key);
    assert.deepEqual(restored.me.completedQuests, [created.state.quests[0].id]);
    assert.deepEqual(restored.scores, { hunters: 100, runners: 60 });
    assert.equal(restored.status, 'running');
    assert.equal(restored.startedAt, startedAt);
    assert.equal(restored.players.find(p => p.name === 'Runner Three').captured, true);
    assert.equal(restored.locationSharing.enabled, false, 'Consent cannot be preserved over a server restart');
    assert.deepEqual((await api(`/api/state?code=${code}&token=${hunter.token}`)).locationPings, []);
    await api('/api/recover', { code, recoveryKey: 'invalid' }, 401);
    const recovered = await api('/api/recover', { code, recoveryKey: key });
    assert.equal(recovered.state.me.id, created.state.me.id);
    assert.notEqual(recovered.token, firstToken);
    assert.equal(recovered.state.me.isHost, true);
    assert.deepEqual(recovered.state.me.completedQuests, [created.state.quests[0].id]);
    await api(`/api/state?code=${code}&token=${firstToken}`, undefined, 401);
    await api('/api/action', { code, token: recovered.token, type: 'pause' });
    await stopServer(child); child = null;
    child = spawnServer(file, port);
    await waitForHealth(base, child);
    const paused = await api(`/api/state?code=${code}&token=${recovered.token}`);
    assert.equal(paused.status, 'paused');
    assert.ok(paused.pausedAt);
    await api('/api/action', { code, token: recovered.token, type: 'resume' });
    const resumed = await api(`/api/state?code=${code}&token=${recovered.token}`);
    assert.equal(resumed.status, 'running');
    assert.ok(resumed.totalPausedMs > 0);
  } finally {
    await stopServer(child);
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
