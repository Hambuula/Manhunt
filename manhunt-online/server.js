'use strict';

/** MANHUNT — deployable multiplayer server with persistent storage. Requires Node.js 20+. */
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
// Railway mounts its persistent disk at RAILWAY_VOLUME_MOUNT_PATH. Never allow a
// production Railway deployment to silently use ephemeral container storage.
if (process.env.RAILWAY_ENVIRONMENT_ID && !process.env.RAILWAY_VOLUME_MOUNT_PATH) {
  throw new Error('Persistent storage missing. Attach a Railway volume at /data before starting Manhunt.');
}
if (process.env.NODE_ENV === 'production' && !process.env.DATA_FILE && !process.env.RAILWAY_VOLUME_MOUNT_PATH) {
  throw new Error('Production requires DATA_FILE on a persistent disk or RAILWAY_VOLUME_MOUNT_PATH.');
}
const DATA_FILE = process.env.DATA_FILE || path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(ROOT, 'data'), 'games.json');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_PLAYERS = 60;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const sessions = new Map(); // game code -> Set<http.ServerResponse>
const games = new Map();
// Location consent and the latest ping are intentionally RAM-only. Neither is saved to disk.
// Keyed by player UUID, never exposed to other players except authorized Hunter ping views.
const locationState = new Map();
const MAX_PING_AGE_MS = 60 * 60 * 1000;
const LOCATION_PRESENCE_MS = 90 * 1000;
const rateBuckets = new Map();
function limited(req, scope, max, periodMs) {
  // Trust the forwarded client IP only behind explicitly trusted platforms.
  const forwarded = process.env.RAILWAY_ENVIRONMENT_ID || process.env.TRUST_PROXY === '1';
  const raw = forwarded ? req.headers['x-forwarded-for'] : undefined;
  const ip = String((typeof raw === 'string' && raw.split(',')[0].trim()) || req.socket.remoteAddress || 'unknown').slice(0, 96);
  const key = `${scope}:${ip}`;
  const now = Date.now();
  let entry = rateBuckets.get(key);
  if (!entry || now - entry.start >= periodMs) entry = { start: now, hits: 0 };
  entry.hits++;
  rateBuckets.set(key, entry);
  if (entry.hits > max) failure('Too many attempts. Please try again later.', 429);
}
setInterval(() => {
  const cutoff = Date.now() - 3600000;
  for (const [key, entry] of rateBuckets) if (entry.start < cutoff) rateBuckets.delete(key);
}, 3600000).unref();
function dropLocation(playerId, revoke = true) {
  if (revoke) locationState.delete(playerId);
  else {
    const state = locationState.get(playerId);
    if (state) { state.ping = null; state.lastPingAt = 0; }
  }
}
function wipeGameLocations(game, revoke = true) {
  for (const p of game.players) dropLocation(p.id, revoke);
}


function readExistingGames() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    for (const game of raw.games || []) {
      if (game && /^[A-Z2-9]{6}$/.test(game.code) && Array.isArray(game.players)) {
        // Older games stored on disk get a recovery secret the next time saved.
        for (const player of game.players) if (!player.recoveryKey) player.recoveryKey = newRecoveryKey();
        games.set(game.code, game);
      }
    }
    console.log(`Restored ${games.size} game(s) from disk.`);
  } catch (error) {
    // Refuse to start rather than accidentally overwrite damaged or unreadable data.
    if (error.code !== 'ENOENT') throw new Error(`Unable to load saved games at ${DATA_FILE}: ${error.message}`);
  }
}
readExistingGames();

function persist() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const temp = `${DATA_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ games: [...games.values()] }, null, 2), { mode: 0o600 });
  fs.renameSync(temp, DATA_FILE);
}
function newId() { return crypto.randomUUID(); }
function newToken() { return crypto.randomBytes(24).toString('base64url'); }
function newRecoveryKey() { return crypto.randomBytes(18).toString('base64url'); }
function newPin() { return String(crypto.randomInt(1000, 10000)); }
function newCode() {
  let code;
  do {
    code = Array.from({ length: 6 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('');
  } while (games.has(code));
  return code;
}
function failure(message, status = 400) { const e = new Error(message); e.status = status; throw e; }
function cleanedName(name, label = 'Name', maxLength = 24) {
  if (typeof name !== 'string') failure(`${label} is required.`);
  const cleaned = name.trim().replace(/\s+/g, ' ');
  if (cleaned.length < 2 || cleaned.length > maxLength || /[\x00-\x1f\x7f]/.test(cleaned))
    failure(`${label} must be 2–${maxLength} characters.`);
  return cleaned;
}
function isValidTeam(team) { return team === 'hunter' || team === 'runner'; }
function numeric(v, name, min, max, integer = true) {
  if (v === '' || v === null || v === undefined || !Number.isFinite(Number(v))) failure(`${name} is required.`);
  const n = Number(v);
  if ((integer && !Number.isInteger(n)) || n < min || n > max) failure(`${name} must be between ${min} and ${max}.`);
  return n;
}
function validateConfig(raw = {}, rawQuests = []) {
  const durationMinutes = numeric(raw.durationMinutes, 'Duration', 5, 240);
  const headStartMinutes = numeric(raw.headStartMinutes, 'Head start', 0, Math.min(60, durationMinutes - 1));
  const radiusMeters = numeric(raw.radiusMeters, 'Radius', 100, 20000);
  const capturePoints = numeric(raw.capturePoints, 'Capture points', 0, 2000);
  const survivalPoints = numeric(raw.survivalPoints, 'Survival points', 0, 2000);
  // Missing on older saved games, so the default keeps prior matches compatible.
  const pingIntervalMinutes = numeric(raw.pingIntervalMinutes ?? 5, 'Ping interval', 1, 30);
  let centerLat = null;
  let centerLng = null;
  const hasLat = raw.centerLat !== null && raw.centerLat !== undefined && String(raw.centerLat).trim() !== '';
  const hasLng = raw.centerLng !== null && raw.centerLng !== undefined && String(raw.centerLng).trim() !== '';
  if (hasLat !== hasLng) failure('Provide both center latitude and longitude, or leave both blank.');
  if (hasLat) {
    centerLat = numeric(raw.centerLat, 'Latitude', -90, 90, false);
    centerLng = numeric(raw.centerLng, 'Longitude', -180, 180, false);
  }
  if (!Array.isArray(rawQuests) || rawQuests.length > 12) failure('Add up to 12 quests.');
  const quests = rawQuests.map((q, index) => {
    const title = cleanedName(q?.title, `Quest ${index + 1}`, 60);
    const points = numeric(q?.points, 'Quest points', 1, 1000);
    return { id: newId(), title, points };
  });
  return {
    settings: { durationMinutes, headStartMinutes, radiusMeters, capturePoints, survivalPoints,
      convertCaptured: Boolean(raw.convertCaptured), centerLat, centerLng, pingIntervalMinutes },
    quests
  };
}
function getGameAndPlayer(code, token) {
  const game = games.get(String(code || '').toUpperCase());
  if (!game) failure('Game not found. Check the invite code.', 404);
  const player = game.players.find(p => p.token === token);
  if (!player) failure('Session not found. Rejoin from this device.', 401);
  return { game, player };
}
function addEvent(game, text, kind = 'info') {
  game.events.unshift({ id: newId(), text, kind, at: Date.now() });
  game.events = game.events.slice(0, 25);
}
function playerTeam(game, p) {
  return p.team === 'runner' && p.captured && game.settings.convertCaptured ? 'hunter' : p.team;
}
function scores(game) {
  return {
    hunters: game.scores.hunters,
    runners: game.scores.runners
  };
}
function elapsedMs(game, now = Date.now()) {
  if (!game.startedAt) return 0;
  const stop = game.status === 'paused' ? game.pausedAt : now;
  return Math.max(0, stop - game.startedAt - game.totalPausedMs);
}
function runningHunters(game) {
  return elapsedMs(game) >= game.settings.headStartMinutes * 60000;
}
function finish(game, reason) {
  if (game.status === 'ended') return;
  wipeGameLocations(game);
  game.status = 'ended';
  game.finishedAt = Date.now();
  game.finishedReason = reason;
  const surviving = game.players.filter(p => p.team === 'runner' && !p.captured);
  const bonus = surviving.length * game.settings.survivalPoints;
  game.scores.runners += bonus;
  if (bonus) addEvent(game, `${surviving.length} runner${surviving.length === 1 ? '' : 's'} survived: +${bonus} runner points.`, 'score');
  if (reason === 'all-captured') game.winner = 'hunters';
  else if (game.scores.hunters === game.scores.runners) game.winner = 'draw';
  else game.winner = game.scores.hunters > game.scores.runners ? 'hunters' : 'runners';
  addEvent(game, `Game over: ${game.winner === 'draw' ? 'draw' : game.winner + ' win'}.`, 'finish');
}
function checkTimer(game) {
  if (game.status === 'running' && elapsedMs(game) >= game.settings.durationMinutes * 60000) {
    finish(game, 'time');
    updated(game);
  }
}
function visibleState(game, player) {
  const now = Date.now();
  const sharing = locationState.get(player.id);
  const intervalMs = (game.settings.pingIntervalMinutes || 5) * 60000;
  const hunterAccess = playerTeam(game, player) === 'hunter' &&
    game.status === 'running' && runningHunters(game);
  const locationPings = hunterAccess ? game.players.flatMap(target => {
    if (target.team !== 'runner' || target.captured) return [];
    const track = locationState.get(target.id);
    if (!track?.enabled || !track.ping || now - (track.lastSeenAt || 0) > LOCATION_PRESENCE_MS) return [];
    // Expire stale pings automatically; older fixes never return to clients.
    if (now - track.ping.at > Math.min(MAX_PING_AGE_MS, intervalMs * 2)) return [];
    return [{ id: target.id, name: target.name, ...track.ping }];
  }) : [];
  return {
    code: game.code,
    title: game.title,
    status: game.status,
    settings: game.settings,
    quests: game.quests,
    startedAt: game.startedAt,
    pausedAt: game.pausedAt,
    totalPausedMs: game.totalPausedMs,
    finishedReason: game.finishedReason || null,
    winner: game.winner || null,
    serverNow: Date.now(),
    scores: scores(game),
    version: game.version,
    players: game.players.map(p => ({
      id: p.id, name: p.name, team: p.team, activeTeam: playerTeam(game, p),
      isHost: p.id === game.hostId, captured: p.captured,
      completedCount: p.completedQuests.length
    })),
    me: {
      id: player.id, name: player.name, team: player.team, activeTeam: playerTeam(game, player),
      captured: player.captured, isHost: player.id === game.hostId,
      tagCode: player.team === 'runner' && !player.captured ? player.tagCode : null,
      recoveryKey: player.recoveryKey, completedQuests: player.completedQuests
    },
    locationPings,
    locationSharing: {
      enabled: Boolean(sharing?.enabled),
      lastPingAt: sharing?.ping?.at ?? null,
      nextAllowedAt: sharing?.lastPingAt ? sharing.lastPingAt + intervalMs : null
    },
    events: game.events
  };
}
function broadcast(code) {
  const group = sessions.get(code);
  if (!group) return;
  const game = games.get(code);
  const event = `event: sync\ndata: ${JSON.stringify({ version: game?.version || 0 })}\n\n`;
  for (const response of group) {
    try { response.write(event); } catch { group.delete(response); }
  }
}
function updated(game) { game.version += 1; persist(); broadcast(game.code); }
function notify(game) { game.version += 1; broadcast(game.code); }
function submitLocationPing(game, player, req) {
  if (game.status !== 'running') failure('Location pings are unavailable outside a running game.');
  if (player.team !== 'runner' || player.captured) failure('Only active Runners can share their location.', 403);
  const state = locationState.get(player.id);
  if (!state?.enabled) failure('Enable location sharing first.', 403);
  if (!runningHunters(game)) failure('Pings cannot be shared during the Runner head start.');
  const now = Date.now();
  const intervalMs = (game.settings.pingIntervalMinutes || 5) * 60000;
  if (state.lastPingAt && now - state.lastPingAt < intervalMs)
    failure('The next location ping is not due yet.', 429);
  const lat = numeric(req.lat, 'Latitude', -90, 90, false);
  const lng = numeric(req.lng, 'Longitude', -180, 180, false);
  const accuracy = numeric(req.accuracy, 'GPS accuracy', 0, 5000, false);
  // No history: overwrite the previous ping, modestly quantized (~5–11m).
  state.ping = { lat: Math.round(lat * 10000) / 10000, lng: Math.round(lng * 10000) / 10000,
    accuracy: Math.round(accuracy), at: now };
  state.lastPingAt = now;
  state.lastSeenAt = now;
  notify(game);
  return visibleState(game, player);
}
function action(game, player, req) {
  const type = req.type;
  const hostOnly = ['start', 'pause', 'resume', 'end', 'update-settings', 'remove-player', 'rematch'];
  if (hostOnly.includes(type) && player.id !== game.hostId) failure('Only the host can do that.', 403);
  switch (type) {
    case 'location-consent': {
      if (req.enabled === false) {
        dropLocation(player.id);
      } else if (req.enabled === true) {
        if (game.status !== 'running' || player.team !== 'runner' || player.captured)
          failure('Only an active Runner can enable location sharing in a running game.', 403);
        // Explicit opt-in is only honored on this player's authenticated device.
        locationState.set(player.id, { enabled: true, lastPingAt: 0, ping: null, lastSeenAt: Date.now() });
      } else failure('Specify whether location sharing is enabled.');
      notify(game);
      return visibleState(game, player);
    }
    case 'location-heartbeat': {
      // This keeps an existing consent session visible while a Runner is online.
      // It uploads no GPS coordinates and is never persisted to disk.
      const state = locationState.get(player.id);
      if (!state?.enabled || game.status !== 'running' || player.team !== 'runner' || player.captured)
        failure('Location sharing is off.', 403);
      state.lastSeenAt = Date.now();
      return visibleState(game, player);
    }
    case 'set-team': {
      if (game.status !== 'lobby') failure('Teams are locked once the game starts.');
      if (!isValidTeam(req.team)) failure('Choose Hunters or Runners.');
      dropLocation(player.id);
      player.team = req.team;
      player.captured = false;
      player.completedQuests = [];
      addEvent(game, `${player.name} joined ${req.team === 'hunter' ? 'Hunters' : 'Runners'}.`);
      break;
    }
    case 'update-settings': {
      if (game.status !== 'lobby') failure('Rules can only be edited in the lobby.');
      const result = validateConfig(req.settings, req.quests);
      wipeGameLocations(game);
      game.settings = result.settings;
      game.quests = result.quests;
      for (const p of game.players) p.completedQuests = [];
      addEvent(game, 'Host updated game rules.');
      break;
    }
    case 'start': {
      if (game.status !== 'lobby') failure('Game already started.');
      if (!game.players.some(p => p.team === 'runner') || !game.players.some(p => p.team === 'hunter'))
        failure('You need at least one Hunter and one Runner.');
      game.status = 'running';
      game.startedAt = Date.now();
      game.pausedAt = null;
      game.totalPausedMs = 0;
      addEvent(game, 'Game started. Runners, move out!', 'start');
      break;
    }
    case 'pause': {
      if (game.status !== 'running') failure('The game is not running.');
      wipeGameLocations(game, false);
      game.status = 'paused';
      game.pausedAt = Date.now();
      addEvent(game, 'Host paused the game.', 'pause');
      break;
    }
    case 'resume': {
      if (game.status !== 'paused') failure('The game is not paused.');
      game.totalPausedMs += Date.now() - game.pausedAt;
      game.pausedAt = null;
      game.status = 'running';
      addEvent(game, 'Host resumed the game.', 'start');
      break;
    }
    case 'end': {
      if (game.status !== 'running' && game.status !== 'paused') failure('Game is not active.');
      finish(game, 'host');
      break;
    }
    case 'claim-quest': {
      if (game.status !== 'running') failure('Quests can only be completed while playing.');
      if (player.team !== 'runner' || player.captured) failure('Only active runners can complete quests.');
      const quest = game.quests.find(q => q.id === req.questId);
      if (!quest) failure('Quest not found.');
      if (player.completedQuests.includes(quest.id)) failure('You already completed that quest.');
      player.completedQuests.push(quest.id);
      game.scores.runners += quest.points;
      addEvent(game, `${player.name} completed “${quest.title}” (+${quest.points}).`, 'score');
      break;
    }
    case 'capture': {
      if (game.status !== 'running') failure('The hunt is not active.');
      if (playerTeam(game, player) !== 'hunter') failure('Only Hunters can tag a Runner.');
      if (!runningHunters(game)) failure('Hunters must wait until the head start ends.');
      const target = game.players.find(p => p.id === req.targetId && p.team === 'runner');
      if (!target || target.captured) failure('That runner is no longer active.');
      if (target.id === player.id) failure('You cannot tag yourself.');
      if (String(req.pin || '') !== target.tagCode) failure('Incorrect runner tag code. Ask the runner for the code after tagging them.');
      dropLocation(target.id);
      target.captured = true;
      game.scores.hunters += game.settings.capturePoints;
      addEvent(game, `${player.name} tagged ${target.name} (+${game.settings.capturePoints}).`, 'capture');
      if (!game.players.some(p => p.team === 'runner' && !p.captured)) finish(game, 'all-captured');
      break;
    }
    case 'remove-player': {
      if (game.status !== 'lobby') failure('Players can only be removed in the lobby.');
      const target = game.players.find(p => p.id === req.targetId);
      if (!target || target.id === game.hostId) failure('That player cannot be removed.');
      dropLocation(target.id);
      game.players = game.players.filter(p => p.id !== target.id);
      addEvent(game, `${target.name} was removed from the lobby.`);
      break;
    }
    case 'rematch': {
      if (game.status !== 'ended') failure('You can rematch when the round ends.');
      wipeGameLocations(game);
      game.status = 'lobby';
      game.startedAt = null;
      game.pausedAt = null;
      game.totalPausedMs = 0;
      game.finishedReason = null;
      game.finishedAt = null;
      game.winner = null;
      game.scores = { hunters: 0, runners: 0 };
      for (const p of game.players) {
        p.captured = false;
        p.completedQuests = [];
        p.tagCode = newPin();
      }
      game.events = [];
      addEvent(game, 'Rematch lobby is ready.');
      break;
    }
    default: failure('Unknown game action.');
  }
  updated(game);
  return visibleState(game, player);
}
function json(res, status, result) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(result));
}
async function body(req) {
  let value = '';
  for await (const chunk of req) {
    value += chunk.toString();
    if (value.length > 40000) failure('Request too large.', 413);
  }
  try { return JSON.parse(value); } catch { failure('Invalid JSON request.'); }
}
function urlFor(request) { return new URL(request.url || '/', 'http://localhost'); }
function serve(res, pathname) {
  const allowed = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/index.html': ['index.html', 'text/html; charset=utf-8'],
    '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
    '/field-map.js': ['field-map.js', 'text/javascript; charset=utf-8'],
    '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
    '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
  };
  const target = allowed[pathname];
  if (!target) { res.writeHead(404); res.end('Not found'); return; }
  fs.readFile(path.join(PUBLIC_DIR, target[0]), (error, buffer) => {
    if (error) { res.writeHead(500); res.end('Asset unavailable'); return; }
    res.writeHead(200, { 'Content-Type': target[1], 'X-Content-Type-Options': 'nosniff',
      'Cache-Control': target[0] === 'index.html' ? 'no-cache' : 'public, max-age=60',
      'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data: https://tile.openstreetmap.org; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      // Map tile provider requires an origin Referer. Never send full game URLs.
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': 'geolocation=(self)',
      'X-Frame-Options': 'DENY' });
    res.end(buffer);
  });
}
async function handle(req, res) {
  try {
    const url = urlFor(req);
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return json(res, 200, { ok: true, games: games.size });
    }
    if (req.method === 'POST' && url.pathname === '/api/create') {
      limited(req, 'create', 12, 3600000);
      const data = await body(req);
      const name = cleanedName(data.name, 'Your name');
      const title = cleanedName(data.title || 'Neighborhood Manhunt', 'Game title');
      if (!isValidTeam(data.team)) failure('Choose your team.');
      const { settings, quests } = validateConfig(data.settings, data.quests);
      const token = newToken();
      const player = { id: newId(), name, team: data.team, token, recoveryKey: newRecoveryKey(), tagCode: newPin(),
        captured: false, completedQuests: [] };
      const game = {
        code: newCode(), title, status: 'lobby', settings, quests, hostId: player.id,
        players: [player], scores: { hunters: 0, runners: 0 }, version: 1, events: [],
        startedAt: null, pausedAt: null, totalPausedMs: 0, winner: null, finishedReason: null,
        createdAt: Date.now()
      };
      addEvent(game, `${name} created the game.`);
      games.set(game.code, game);
      persist();
      return json(res, 201, { code: game.code, token, state: visibleState(game, player) });
    }
    if (req.method === 'POST' && url.pathname === '/api/join') {
      limited(req, 'join', 30, 5 * 60000);
      const data = await body(req);
      const code = String(data.code || '').toUpperCase().trim();
      const game = games.get(code);
      if (!game) failure('Game not found. Check the six-character code.', 404);
      if (game.status !== 'lobby') failure('That game is already underway. Ask the host to start a rematch.');
      if (game.players.length >= MAX_PLAYERS) failure('This room is full.');
      const name = cleanedName(data.name, 'Your name');
      if (game.players.some(p => p.name.toLowerCase() === name.toLowerCase())) failure('Name already taken in this room.');
      if (!isValidTeam(data.team)) failure('Choose Hunters or Runners.');
      const player = { id: newId(), name, team: data.team, token: newToken(), recoveryKey: newRecoveryKey(), tagCode: newPin(),
        captured: false, completedQuests: [] };
      game.players.push(player);
      addEvent(game, `${name} joined ${player.team === 'hunter' ? 'Hunters' : 'Runners'}.`);
      updated(game);
      return json(res, 201, { code, token: player.token, state: visibleState(game, player) });
    }
    if (req.method === 'POST' && url.pathname === '/api/recover') {
      limited(req, 'recover', 10, 10 * 60000);
      const data = await body(req);
      const code = String(data.code || '').trim().toUpperCase();
      const game = games.get(code);
      const recoveryKey = String(data.recoveryKey || '').trim();
      const player = game?.players.find(p => p.recoveryKey === recoveryKey && recoveryKey.length >= 20);
      if (!player) failure('Recovery key or game code not recognized.', 401);
      // A successful recovery invalidates the old browser's login immediately.
      dropLocation(player.id);
      player.token = newToken();
      addEvent(game, `${player.name} restored their session.`);
      updated(game);
      return json(res, 200, { code, token: player.token, state: visibleState(game, player) });
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      const { game, player } = getGameAndPlayer(url.searchParams.get('code'), url.searchParams.get('token'));
      checkTimer(game);
      return json(res, 200, visibleState(game, player));
    }
    if (req.method === 'GET' && url.pathname === '/api/stream') {
      const { game } = getGameAndPlayer(url.searchParams.get('code'), url.searchParams.get('token'));
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(`retry: 1500\nevent: sync\ndata: ${JSON.stringify({ version: game.version })}\n\n`);
      if (!sessions.has(game.code)) sessions.set(game.code, new Set());
      sessions.get(game.code).add(res);
      req.on('close', () => sessions.get(game.code)?.delete(res));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/ping') {
      const data = await body(req);
      const { game, player } = getGameAndPlayer(data.code, data.token);
      checkTimer(game);
      return json(res, 200, submitLocationPing(game, player, data));
    }
    if (req.method === 'POST' && url.pathname === '/api/action') {
      const data = await body(req);
      const { game, player } = getGameAndPlayer(data.code, data.token);
      checkTimer(game);
      if (data.type === 'capture') limited(req, `tag-${player.id}`, 12, 5 * 60000);
      return json(res, 200, action(game, player, data));
    }
    if (req.method === 'GET' || req.method === 'HEAD') return serve(res, url.pathname);
    return json(res, 405, { error: 'Method not allowed.' });
  } catch (error) {
    if (!error.status) console.error('Request failed:', error);
    if (!res.headersSent) return json(res, error.status || 500, { error: error.status ? error.message : 'Internal server error.' });
    res.end();
    if (!error.status) console.error(error);
  }
}
setInterval(() => {
  for (const game of games.values()) checkTimer(game);
  for (const group of sessions.values()) for (const res of group) { try { res.write(': keepalive\n\n'); } catch { group.delete(res); } }
}, 1000).unref();

let server;
if (process.env.TLS_KEY && process.env.TLS_CERT) {
  server = https.createServer({ key: fs.readFileSync(process.env.TLS_KEY), cert: fs.readFileSync(process.env.TLS_CERT) }, handle);
} else {
  server = http.createServer(handle);
}
if (require.main === module) {
  server.listen(PORT, HOST, () => {
    const protocol = process.env.TLS_KEY ? 'https' : 'http';
    console.log(`\nMANHUNT is live at ${protocol}://localhost:${PORT}`);
    const all = os.networkInterfaces();
    if (!process.env.RAILWAY_ENVIRONMENT_ID) {
      for (const entries of Object.values(all)) for (const entry of entries || []) {
        if (entry.family === 'IPv4' && !entry.internal) console.log(`Local network: ${protocol}://${entry.address}:${PORT}`);
      }
    }
    if (process.env.RAILWAY_PUBLIC_DOMAIN) console.log(`Public website: https://${process.env.RAILWAY_PUBLIC_DOMAIN}`);
    console.log(`Saved match data: ${DATA_FILE}\n`);
  });
}
module.exports = { server, games, locationState, validateConfig, elapsedMs };
