'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'manhunt-test-'));
process.env.DATA_FILE = path.join(temp, 'rooms.json');
const { server, games } = require('../server');
let base;

async function api(route, payload = undefined, status = 200) {
  const res = await fetch(base + route, payload === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  });
  const body = await res.json();
  assert.equal(res.status, status, `Expected ${status}, got ${res.status}: ${JSON.stringify(body)}`);
  return body;
}
const config = { durationMinutes: 5, headStartMinutes: 0, radiusMeters: 900,
  capturePoints: 100, survivalPoints: 75, convertCaptured: true, centerLat: 51.432, centerLng: 6.762 };
const quests = [{ title: 'Find a checkpoint', points: 25 }, { title: 'Take a team photo', points: 45 }];

test('Host, join, quest, validated capture, rematch, timers and authentication', async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  try {
    const health = await api('/api/health');
    assert.equal(health.ok, true);
    const created = await api('/api/create', { name: 'Alice', title: 'Park Chase', team: 'runner', settings: config, quests }, 201);
    assert.match(created.code, /^[A-Z2-9]{6}$/);
    assert.equal(created.state.me.tagCode.length, 4);
    assert.equal(created.state.settings.radiusMeters, 900);
    const code = created.code, alice = created.token;
    // A connected client receives an SSE event when another player joins.
    const streamController = new AbortController();
    const streamResponse = await fetch(`${base}/api/stream?code=${code}&token=${alice}`, { signal: streamController.signal });
    assert.equal(streamResponse.status, 200);
    assert.match(streamResponse.headers.get('content-type'), /text\/event-stream/);
    const reader = streamResponse.body.getReader();
    const firstChunk = await reader.read();
    assert.match(new TextDecoder().decode(firstChunk.value), /event: sync/);
    const bobJoin = await api('/api/join', { code, name: 'Bob', team: 'hunter' }, 201);
    const bob = bobJoin.token;
    const nextChunk = await reader.read();
    assert.match(new TextDecoder().decode(nextChunk.value), /event: sync/);
    streamController.abort();
    const caraJoin = await api('/api/join', { code, name: 'Cara', team: 'runner' }, 201);
    const cara = caraJoin.token;
    assert.equal(caraJoin.state.players.length, 3);
    assert.equal(caraJoin.state.me.tagCode.length, 4);
    assert.equal(bobJoin.state.me.tagCode, null);

    await api('/api/join', { code, name: 'Alice', team: 'runner' }, 400);
    await api(`/api/state?code=${code}&token=nope`, undefined, 401);
    await api('/api/action', { code, token: bob, type: 'start' }, 403);
    await api('/api/action', { code, token: alice, type: 'claim-quest', questId: created.state.quests[0].id }, 400);

    const start = await api('/api/action', { code, token: alice, type: 'start' });
    assert.equal(start.status, 'running');
    const completed = await api('/api/action', { code, token: alice, type: 'claim-quest', questId: created.state.quests[0].id });
    assert.equal(completed.scores.runners, 25);
    await api('/api/action', { code, token: alice, type: 'claim-quest', questId: created.state.quests[0].id }, 400);
    const aliceId = start.me.id;
    const caraId = caraJoin.state.me.id;
    await api('/api/action', { code, token: bob, type: 'capture', targetId: aliceId, pin: 'wrong' }, 400);
    const captured = await api('/api/action', { code, token: bob, type: 'capture', targetId: aliceId, pin: created.state.me.tagCode });
    assert.equal(captured.scores.hunters, 100);
    assert.equal(captured.status, 'running');
    const converted = await api(`/api/state?code=${code}&token=${alice}`);
    assert.equal(converted.me.captured, true);
    assert.equal(converted.me.activeTeam, 'hunter');
    await api('/api/action', { code, token: alice, type: 'claim-quest', questId: created.state.quests[1].id }, 400);
    const ended = await api('/api/action', { code, token: bob, type: 'capture', targetId: caraId, pin: caraJoin.state.me.tagCode });
    assert.equal(ended.status, 'ended');
    assert.equal(ended.winner, 'hunters');
    assert.equal(ended.scores.hunters, 200);
    assert.equal(ended.scores.runners, 25);
    assert.equal(ended.finishedReason, 'all-captured');
    await api('/api/action', { code, token: bob, type: 'rematch' }, 403);
    const rematch = await api('/api/action', { code, token: alice, type: 'rematch' });
    assert.equal(rematch.status, 'lobby');
    assert.deepEqual(rematch.scores, { hunters: 0, runners: 0 });
    assert.equal(rematch.players.every(p => !p.captured), true);
    const changed = await api('/api/action', { code, token: alice, type: 'update-settings',
      settings: { ...config, convertCaptured: false }, quests: [{ title: 'Reach the fountain', points: 50 }] });
    assert.equal(changed.quests.length, 1);
    await api('/api/action', { code, token: alice, type: 'start' });
    // Simulate an elapsed round to test the timed finish and survival bonus.
    const internal = games.get(code);
    internal.startedAt = Date.now() - (config.durationMinutes * 60000 + 1000);
    const timed = await api(`/api/state?code=${code}&token=${alice}`);
    assert.equal(timed.status, 'ended');
    assert.equal(timed.winner, 'runners');
    assert.equal(timed.scores.runners, 150); // 2 survivors x 75
    assert.ok(fs.existsSync(process.env.DATA_FILE));
    assert.equal(timed.players.length, 3);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('Configuration rejects out-of-range and partially specified locations', () => {
  const { validateConfig } = require('../server');
  assert.throws(() => validateConfig({ ...config, radiusMeters: 50 }, quests), /Radius/);
  assert.throws(() => validateConfig({ ...config, centerLng: '' }, quests), /both center/);
  assert.throws(() => validateConfig({ ...config, headStartMinutes: 6 }, quests), /Head start/);
  assert.throws(() => validateConfig(config, [{ title: 'A', points: 10 }]), /2–60/);
  assert.equal(validateConfig(config, [{ title: 'Complete a team photo challenge', points: 40 }]).quests[0].title,
    'Complete a team photo challenge');
});
