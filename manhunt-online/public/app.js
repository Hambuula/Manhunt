'use strict';

const app = document.getElementById('app');
const toastEl = document.getElementById('toast');
const savedInviteCode = new URLSearchParams(window.location.search).get('game') || '';
const BASE_QUESTS = [
  { title: 'Reach a chosen checkpoint', points: 25 },
  { title: 'Complete a team photo challenge', points: 40 },
  { title: 'Find the secret landmark', points: 50 }
];
const BASE_SETTINGS = {
  durationMinutes: 45, headStartMinutes: 5, radiusMeters: 1500,
  capturePoints: 100, survivalPoints: 75, convertCaptured: true,
  centerLat: '', centerLng: '', pingIntervalMinutes: 5
};
let createDraft = { title: 'Neighborhood Manhunt', name: '', team: 'hunter',
  settings: { ...BASE_SETTINGS }, quests: BASE_QUESTS.map(q => ({ ...q })) };
let editDraft = null;
let editOpen = false;
let session = null;
let game = null;
let stream = null;
let timeOffset = 0;
let refreshing = false;
let watchId = null;
let gps = { status: 'off', lat: null, lng: null, accuracy: null, error: '' };
let toastTimeout;
let shareSessionActive = false;
let sendingPing = false;
let lastMapAgeUpdate = 0;
let restoring = false;
let reconnectTimer = null;
let recoveryRevealed = false;
let initialPageRestore = true;
let lastPresenceSent = 0;
let presenceSending = false;

function e(value) { return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch])); }
function n(value, fallback = 0) { const v = Number(value); return Number.isFinite(v) ? v : fallback; }
function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
function num(value) { return Number(value || 0).toLocaleString(); }
function toast(message, error = false) {
  clearTimeout(toastTimeout);
  toastEl.textContent = message;
  toastEl.className = `toast shown${error ? ' error' : ''}`;
  toastTimeout = setTimeout(() => { toastEl.className = 'toast'; }, 4500);
}
async function request(path, payload = null) {
  const options = payload ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) } : {};
  let response;
  try { response = await fetch(path, options); }
  catch {
    const error = new Error('Cannot reach the game server. Reconnection will be automatic.');
    error.offline = true;
    throw error;
  }
  let data;
  try { data = await response.json(); } catch { throw new Error('Unexpected server response.'); }
  if (!response.ok) {
    const error = new Error(data.error || 'Action failed.');
    error.httpStatus = response.status;
    throw error;
  }
  return data;
}
function setConnectivity(connected) {
  const banner = document.getElementById('connection-banner');
  if (!banner) return;
  banner.hidden = connected;
  if (!connected) banner.textContent = 'CONNECTION LOST — your game and player are saved. Reconnecting automatically…';
}
function scheduleReconnect() {
  if (reconnectTimer || !session) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (game) refreshState(); else restoreSession();
  }, 4000);
}
function clearReconnect() { clearTimeout(reconnectTimer); reconnectTimer = null; }
function savedRooms() {
  try { return Object.keys(localStorage).filter(k => /^manhunt:[A-Z2-9]{6}$/.test(k) && localStorage.getItem(k)).map(k => k.slice(8)).slice(0, 8); }
  catch { return []; }
}
function renderReconnecting() {
  app.innerHTML = `<section class="panel recovery-wait"><div class="eyebrow">REJOINING GAME / ${e(session?.code || '')}</div>
    <h1>Reconnecting to your game</h1><p>Your player is still registered. The server may be restarting or your phone may be offline. We will keep trying.</p>
    <div class="btn-bar"><button class="btn btn-primary" data-action="retry-restore">RETRY NOW</button><button class="btn btn-quiet" data-action="switch-room">OTHER GAME</button></div>
  </section>`;
  setConnectivity(false);
}
function settingsInput(label, name, value, min, max, hint = '') {
  return `<div class="field"><label for="field-${e(name)}">${e(label)}</label><input class="input" type="number" name="${e(name)}" id="field-${e(name)}" value="${e(value)}" min="${min}" max="${max}" step="1" required>${hint ? `<span class="helper">${e(hint)}</span>` : ''}</div>`;
}
function settingsFields(settings) {
  return `<div class="form-section-title">MATCH PARAMETERS</div>
    <div class="form-grid">
      ${settingsInput('Duration / minutes', 'durationMinutes', settings.durationMinutes, 5, 240)}
      ${settingsInput('Runner head start / min', 'headStartMinutes', settings.headStartMinutes, 0, 60)}
      ${settingsInput('Play radius / meters', 'radiusMeters', settings.radiusMeters, 100, 20000)}
      ${settingsInput('Points per capture', 'capturePoints', settings.capturePoints, 0, 2000)}
      ${settingsInput('Survival bonus / runner', 'survivalPoints', settings.survivalPoints, 0, 2000)}
      ${settingsInput('Location ping interval / min', 'pingIntervalMinutes', settings.pingIntervalMinutes ?? 5, 1, 30, 'Runners must explicitly opt in. Pings are for Hunters only, after the head start.')}
      <div class="field"><label>POINTS SYSTEM</label><div class="input" style="display:flex;align-items:center;color:var(--acid);font-family:var(--mono);font-size:11px;">HIGHEST SCORE WINS</div></div>
    </div>
    <label class="checkbox-row"><input type="checkbox" name="convertCaptured" ${settings.convertCaptured ? 'checked' : ''}>Tagged runners can join the Hunters (their original team still counts for victory)</label>
    <div class="form-section-title">PLAY AREA / OPTIONAL GPS CENTER</div>
    <div class="form-grid">
      <div class="field"><label>Center latitude</label><input class="input" type="number" name="centerLat" placeholder="e.g. 51.432" min="-90" max="90" step="any" value="${e(settings.centerLat ?? '')}"></div>
      <div class="field"><label>Center longitude</label><input class="input" type="number" name="centerLng" placeholder="e.g. 6.762" min="-180" max="180" step="any" value="${e(settings.centerLng ?? '')}"></div>
    </div>
    <div class="btn-bar" style="margin-top:10px;"><button type="button" class="btn btn-sm btn-quiet" data-action="set-center-gps">◎ Use my location as center</button></div>
    <p class="helper">The center defines the map's play-area circle. GPS zone checks stay on each phone. Opted-in Runners separately share a single timed location ping with Hunters.</p>`;
}
function questFields(quests) {
  return `<div class="form-section-title">RUNNER QUESTS <span class="muted">/ MAX 12</span></div>
    <div class="quest-form-list">${quests.map((q, index) => `<div class="quest-form-row" data-quest-row>
      <input class="input" type="text" name="quest-title-${index}" aria-label="Quest ${index+1} name" maxlength="60" minlength="2" value="${e(q.title)}" required placeholder="Quest description">
      <input class="input" type="number" name="quest-points-${index}" aria-label="Quest ${index+1} points" value="${e(q.points)}" min="1" max="1000" required>
      <button type="button" class="icon-button" aria-label="Remove quest" data-action="remove-quest" data-index="${index}">×</button>
    </div>`).join('')}</div>
    <button type="button" class="btn btn-sm btn-quiet" data-action="add-quest" ${quests.length >= 12 ? 'disabled' : ''}>+ ADD QUEST</button>
    <p class="helper">Runners self-report quests. Each runner can earn each quest once.</p>`;
}
function formData(form) {
  const f = new FormData(form);
  return {
    settings: {
      durationMinutes: f.get('durationMinutes'), headStartMinutes: f.get('headStartMinutes'),
      radiusMeters: f.get('radiusMeters'), capturePoints: f.get('capturePoints'),
      survivalPoints: f.get('survivalPoints'), pingIntervalMinutes: f.get('pingIntervalMinutes'), convertCaptured: f.has('convertCaptured'),
      centerLat: f.get('centerLat') || null, centerLng: f.get('centerLng') || null
    },
    quests: [...form.querySelectorAll('[data-quest-row]')].map((row) => ({
      title: row.querySelector('input[type="text"]').value,
      points: row.querySelector('input[type="number"]').value
    }))
  };
}
function syncDraftFromForm(form) {
  if (!form) return;
  const result = formData(form);
  if (form.id === 'create-form') {
    createDraft = { title: form.elements.title.value, name: form.elements.name.value,
      team: form.elements.team.value, ...result };
  } else if (form.id === 'edit-form') editDraft = result;
}
function renderHome() {
  game = null;
  const previous = savedRooms();
  app.innerHTML = `
    <section class="hero">
      <div>
        <div class="eyebrow">◆ PLAY OUTSIDE THE SCREEN / SEASON 01</div>
        <h1 class="hero-title">THE CITY<br><span class="stroked">IS YOUR</span><br><span class="highlight">GAME.</span></h1>
        <p class="hero-summary">Turn your neighborhood into a live game of Manhunt. Make the rules, split into Hunters and Runners, finish quests, collect points, and see who makes it out.</p>
        <div class="hero-facts"><div class="hero-fact"><span class="fact-icon">◎</span> CUSTOM GAME AREA</div><div class="hero-fact"><span class="fact-icon">⌁</span> LIVE TEAM SCORING</div><div class="hero-fact"><span class="fact-icon">⌑</span> PRIVATE LOBBY</div></div>
      </div>
      <div class="hero-visual" aria-hidden="true">
        <span class="hero-visual-label top">AREA SCAN / LIVE FIELD</span>
        <div class="radar-cross-x"></div><div class="radar-cross-y"></div>
        <div class="ring ring-1"></div><div class="ring ring-2"></div><div class="ring ring-3"></div>
        <span class="hero-center-dot"></span><span class="hero-pin"></span><span class="hero-pin secondary"></span>
        <span class="hero-visual-label bottom">LIVE ONLINE. YOUR RULES. [01]</span>
      </div>
    </section>
    <div class="home-actions" id="setup">
      <section class="panel">
        <div class="panel-heading"><div><div class="eyebrow">01 / CREATE</div><h2 class="panel-title">Host a new game</h2><p class="panel-description">You control the rules. Your friends join with a code.</p></div><div class="panel-numeral">01</div></div>
        <form id="create-form">
          <div class="form-grid">
            <div class="field full"><label>Game name</label><input class="input" type="text" name="title" minlength="2" maxlength="24" value="${e(createDraft.title)}" required></div>
            <div class="field"><label>Your player name</label><input class="input" type="text" name="name" minlength="2" maxlength="24" placeholder="Your nickname" value="${e(createDraft.name)}" required></div>
            <div class="field"><label>Your team</label><select class="select" name="team"><option value="hunter" ${createDraft.team==='hunter'?'selected':''}>Hunters</option><option value="runner" ${createDraft.team==='runner'?'selected':''}>Runners</option></select></div>
          </div>
          ${settingsFields(createDraft.settings)}
          ${questFields(createDraft.quests)}
          <div class="section-divider"></div>
          <button class="btn btn-primary btn-wide" type="submit">CREATE PRIVATE LOBBY <span aria-hidden="true">↗</span></button>
        </form>
      </section>
      <div class="join-aside">
        ${previous.length ? `<section class="panel resume-panel"><div class="eyebrow">SAVED ON THIS DEVICE</div><h2 class="card-title" style="margin:10px 0">Resume your player</h2>
          <p class="panel-description">Reopen a game with your original player, points, team and quests.</p>
          <div class="btn-bar" style="margin-top:12px">${previous.map(code => `<button type="button" class="btn btn-sm" data-action="resume-saved" data-code="${e(code)}">RESUME ${e(code)}</button>`).join('')}</div></section>` : ''}
        <section class="panel join-panel">
          <div class="panel-heading"><div><div class="eyebrow">02 / CONNECT</div><h2 class="panel-title">Join your crew</h2><p class="panel-description">Got a game code? Get in on the action.</p></div><div class="panel-numeral">02</div></div>
          <form id="join-form"><div class="field"><label>Six-character invite code</label><input class="input code-input" name="code" placeholder="ABC123" value="${e(savedInviteCode.toUpperCase().slice(0,6))}" minlength="6" maxlength="6" autocomplete="off" spellcheck="false" required></div>
          <div class="form-grid" style="margin-top:15px"><div class="field"><label>Your player name</label><input class="input" name="name" type="text" placeholder="Your nickname" minlength="2" maxlength="24" required></div>
          <div class="field"><label>Choose team</label><select class="select" name="team"><option value="runner">Runners</option><option value="hunter">Hunters</option></select></div></div>
          <button class="btn btn-wide" type="submit" style="margin-top:19px">JOIN GAME <span aria-hidden="true">→</span></button></form>
        </section>
        <details class="panel restore-panel"><summary>LOST YOUR SESSION? RECOVER PLAYER</summary>
          <p class="panel-description" style="margin:12px 0">Enter your game code and private recovery key to reclaim your original player, even during a running match.</p>
          <form id="recover-form">
            <div class="field"><label>Game code</label><input class="input code-input" name="code" minlength="6" maxlength="6" required value="${e(savedInviteCode.toUpperCase().slice(0,6))}" placeholder="ABC123" autocomplete="off"></div>
            <div class="field" style="margin-top:12px"><label>Private recovery key</label><input class="input" name="recoveryKey" type="text" required autocomplete="off" spellcheck="false" placeholder="Key saved from your player panel"></div>
            <button type="submit" class="btn btn-primary btn-wide" style="margin-top:14px">RECOVER MY PLAYER</button>
          </form>
          <p class="helper">Recovery signs out the previous device. Keep your key private.</p>
        </details>
        <section class="panel info-panel"><div class="eyebrow">THE FIELD GUIDE</div><h3 class="info-title" style="margin-top:13px">How the hunt works</h3>
          <p>A private game made for real people and real streets. Hosted online. Everyone plays from their own phone, on mobile data or Wi-Fi.</p>
          <div class="info-list"><div class="info-item"><b>01</b> &nbsp; Runners get a head start and complete quests for points.</div><div class="info-item"><b>02</b> &nbsp; Hunters find runners and enter their personal tag code after catching them.</div><div class="info-item"><b>03</b> &nbsp; At time-up, survivors score a bonus. Most points wins.</div></div>
        </section>
        <section class="panel info-panel"><div class="micro lime">PRIVACY NOTE</div><p style="margin-top:11px">GPS is optional. Runner locations are OFF until that Runner opts in. Only timed pings go to Hunters; each Runner can stop sharing and remove their last ping at any time. The online server temporarily processes shared pings in memory.</p></section>
      </div>
    </div>`;
}
function statusFlag(status) {
  const labels = { lobby: 'LOBBY OPEN', running: 'GAME LIVE', paused: 'ON HOLD', ended: 'MATCH ENDED' };
  return `<span class="flag flag-${status}">${labels[status] || 'UNKNOWN'}</span>`;
}
function scoreCard(team, value, people, percent) {
  const hunter = team === 'hunter';
  return `<article class="score-card ${hunter ? 'hunter-card' : 'runner-card'}">
    <div class="score-card-top"><span class="score-name ${hunter ? 'hunter-text' : 'runner-text'}">${hunter ? '◈ HUNTERS' : '◎ RUNNERS'}</span><span class="micro">TEAM SCORE</span></div>
    <div class="score-total">${num(value)}</div>
    <div class="score-caption"><span>${people} ${people===1 ? 'PLAYER' : 'PLAYERS'}</span><span>PTS</span></div>
    <div class="score-track"><div class="score-fill" style="width:${clamp(percent, 2, 100)}%"></div></div>
  </article>`;
}
function formatTime(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}
function currentClock() {
  if (!game || !game.startedAt) return { left: 0, headStart: 0, elapsed: 0 };
  const now = game.status === 'paused' ? game.pausedAt : Date.now() - timeOffset;
  const elapsed = Math.max(0, now - game.startedAt - game.totalPausedMs);
  return {
    elapsed,
    left: Math.max(0, game.settings.durationMinutes * 60000 - elapsed),
    headStart: Math.max(0, game.settings.headStartMinutes * 60000 - elapsed)
  };
}
function updateClock() {
  if (!game) return;
  const data = currentClock();
  const clock = document.getElementById('timer-value');
  const sub = document.getElementById('timer-sub');
  if (!clock || !sub) return;
  clock.textContent = game.status === 'lobby' ? '--:--' : formatTime(data.left);
  if (game.status === 'lobby') sub.textContent = 'Waiting for the host to begin';
  else if (game.status === 'paused') sub.textContent = 'The clock is paused';
  else if (game.status === 'ended') sub.textContent = 'Final score is locked';
  else if (data.headStart > 0) sub.textContent = `Hunters unlock in ${formatTime(data.headStart)}`;
  else sub.textContent = 'Hunters released. Stay sharp.';
  const huntLock = document.getElementById('hunt-lock');
  if (huntLock) huntLock.textContent = data.headStart > 0 ? `HUNTERS LOCKED · ${formatTime(data.headStart)} LEFT` : 'HUNTERS RELEASED';
  for (const button of document.querySelectorAll('[data-capture-button]')) button.disabled = data.headStart > 0 || game.status !== 'running';
}
function winnerBlock() {
  if (!game || game.status !== 'ended') return '';
  const winner = game.winner === 'draw' ? 'DRAW GAME' : `${game.winner.toUpperCase()} WIN`;
  const reason = game.finishedReason === 'all-captured' ? 'Every runner was caught.' : game.finishedReason === 'host' ? 'Host ended the round.' : 'Time expired.';
  return `<div class="end-result"><div class="micro lime">ROUND COMPLETE / FINAL RESULT</div><div class="winner">${e(winner)}</div><div class="small-print">${e(reason)}</div></div>`;
}
function rosterSection(team) {
  const target = game.players.filter(p => p.team === team);
  return `<div class="roster-section-title ${team==='hunter' ? 'hunter-text' : 'runner-text'}">${team==='hunter'?'◈ HUNTERS':'◎ RUNNERS'} <span class="micro">${target.length}</span></div>
    ${target.length ? target.map(p => `<div class="roster-member">
      <div class="roster-member-name"><span class="avatar ${team === 'hunter' ? 'hunter' : ''}">${e(p.name.slice(0,1).toUpperCase())}</span><span class="overflow-text">${e(p.name)} ${p.isHost ? '<span class="micro lime">HOST</span>' : ''}${p.id===game.me.id?' <span class="micro">YOU</span>':''}</span></div>
      <div style="text-align:right">${p.captured ? `<span class="roster-note caught">${game.settings.convertCaptured ? 'CONVERTED' : 'CAUGHT'}</span>` : `<span class="roster-note">${p.completedCount} QUEST${p.completedCount===1?'':'S'}</span>`}
      ${game.me.isHost && game.status==='lobby' && !p.isHost ? `<div><button class="btn btn-quiet btn-sm" type="button" data-action="remove-player" data-target="${e(p.id)}" aria-label="Remove ${e(p.name)}">REMOVE</button></div>` : ''}</div>
    </div>`).join('') : '<div class="empty-state">No players yet.</div>'}`;
}
function rosterPanel() {
  return `<section class="panel"><div class="card-title-row"><h2 class="card-title">The roster</h2><span class="card-kicker">${game.players.length} REGISTERED</span></div>
    <div class="roster">${rosterSection('hunter')}${rosterSection('runner')}</div>
    ${game.status==='lobby' ? `<div class="section-divider"></div><div class="micro">YOUR TEAM / SWITCH BEFORE START</div>
      <div class="team-picker" style="margin-top:11px"><button class="team-option hunter ${game.me.team==='hunter'?'selected':''}" data-action="switch-team" data-team="hunter" ${game.me.team==='hunter'?'disabled':''}>◈ HUNTERS</button><button class="team-option runner ${game.me.team==='runner'?'selected':''}" data-action="switch-team" data-team="runner" ${game.me.team==='runner'?'disabled':''}>◎ RUNNERS</button></div>` : ''}
  </section>`;
}
function hostPanel() {
  return `<section class="panel"><div class="card-title-row"><h2 class="card-title">Match control</h2><span class="card-kicker">${game.me.isHost ? 'HOST ACCESS' : 'PLAYER VIEW'}</span></div>
    ${game.me.isHost ? `<div class="small-print">You are the host. All changes sync with players online, even on different networks.</div>
      <div class="controls-group">
      ${game.status==='lobby' ? `<button class="btn btn-primary" data-action="start">▶ START GAME</button><button class="btn" data-action="toggle-edit">⚙ EDIT RULES</button>` : ''}
      ${game.status==='running' ? `<button class="btn" data-action="pause">Ⅱ PAUSE</button><button class="btn btn-danger" data-action="end">END GAME</button>` : ''}
      ${game.status==='paused' ? `<button class="btn btn-primary" data-action="resume">▶ RESUME</button><button class="btn btn-danger" data-action="end">END GAME</button>` : ''}
      ${game.status==='ended' ? `<button class="btn btn-primary" data-action="rematch">↻ START REMATCH</button>` : ''}
      </div>
      ${game.status==='lobby' ? '<p class="helper">Starting requires at least one player on each team.</p>' : ''}`
      : '<p class="small-print">Your host can start, pause, and end the round. You can close this page and resume your saved player later.</p>'}
  </section>`;
}
function recoveryPanel() {
  return `<section class="panel"><div class="card-title-row"><h2 class="card-title">Stay in the game</h2><span class="card-kicker">AUTO REJOIN</span></div>
    <p class="panel-description">Your player is saved on the server. This browser automatically resumes your team, captures, and quest progress after a restart.</p>
    <div class="rejoin-actions"><button class="btn btn-sm btn-primary" type="button" data-action="copy-recovery">COPY PRIVATE RECOVERY KEY</button>
      <button class="btn btn-sm btn-quiet" type="button" data-action="toggle-recovery">${recoveryRevealed ? 'HIDE KEY' : 'SHOW KEY'}</button></div>
    ${recoveryRevealed ? `<div class="recovery-key" role="status">${e(game.me.recoveryKey || 'Not available')}</div>` : ''}
    <p class="helper">Keep this key somewhere private. If you change phones or clear browser data, open the site, choose “Recover player”, and enter the game code and this key. It will sign out your old device.</p>
  </section>`;
}
function rulesPanel() {
  const s = game.settings;
  return `<section class="panel"><div class="card-title-row"><h2 class="card-title">Game rules</h2><span class="card-kicker">CUSTOM MATCH</span></div>
    <div class="rules-table">
      <div class="rule-row"><span>ROUND LENGTH</span><strong>${s.durationMinutes} MIN</strong></div>
      <div class="rule-row"><span>HEAD START</span><strong>${s.headStartMinutes} MIN</strong></div>
      <div class="rule-row"><span>PLAY RADIUS</span><strong>${num(s.radiusMeters)} M</strong></div>
      <div class="rule-row"><span>TAG REWARD</span><strong>+${num(s.capturePoints)} PTS</strong></div>
      <div class="rule-row"><span>SURVIVAL / RUNNER</span><strong>+${num(s.survivalPoints)} PTS</strong></div>
      <div class="rule-row"><span>TAGGED RUNNERS</span><strong>${s.convertCaptured ? 'JOIN HUNTERS' : 'SPECTATE'}</strong></div>
      <div class="rule-row"><span>GPS ZONE</span><strong>${s.centerLat===null ? 'NOT SET' : 'ENABLED'}</strong></div>
      <div class="rule-row"><span>RUNNER PINGS</span><strong>EVERY ${s.pingIntervalMinutes || 5} MIN / OPT-IN</strong></div>
      <div class="rule-row"><span>WIN CONDITION</span><strong>MOST POINTS</strong></div>
    </div>
  </section>`;
}
function zonePanel() {
  return `<section class="panel"><div class="card-title-row"><h2 class="card-title">Play zone</h2><span class="card-kicker">LOCAL GPS</span></div>
    <div class="zone-map"><div class="zone-ring"></div><div class="zone-origin"></div><div class="zone-player-dot" id="zone-player-dot"></div><span class="zone-map-tag">RADIUS / ADVISORY</span><span class="zone-scale">R = ${num(game.settings.radiusMeters)} M</span></div>
    <div id="zone-status" class="zone-status">CHECK YOUR POSITION</div><div id="zone-detail" class="zone-detail">Position checks are optional and stay on your device.</div>
    <div class="btn-bar" style="margin-top:15px">${watchId === null ? `<button class="btn btn-sm" data-action="gps-start">◎ CHECK MY LOCATION</button>` : `<button class="btn btn-sm btn-quiet" data-action="gps-stop">STOP GPS</button>`}</div>
    <p class="helper">This is a relative radar, not a street map. Stay in safe, permitted areas.</p>
  </section>`;
}
function pingAge(timestamp) {
  const seconds = Math.max(0, Math.floor((Date.now() - timeOffset - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.floor(seconds / 60)}m ago`;
}
function mapPanel() {
  const hunter = game.me.activeTeam === 'hunter';
  const activeRunner = game.me.team === 'runner' && !game.me.captured;
  const enabled = Boolean(game.locationSharing?.enabled);
  const activeGame = game.status === 'running';
  const pings = game.locationPings || [];
  return `<section class="panel field-map-panel">
    <div class="card-title-row"><div><div class="eyebrow">FIELD INTELLIGENCE / CONSENT-BASED</div><h2 class="card-title map-title">Live field map</h2></div><span class="card-kicker">${game.settings.pingIntervalMinutes || 5} MIN PINGS</span></div>
    <div class="map-layout">
      <div class="map-main">
        <div class="field-map-frame">
          <div id="field-map-viewport" class="field-map-viewport" tabindex="0" role="region" aria-label="Interactive map of the play area. Drag to pan. Use plus and minus buttons or arrow keys to move.">
            <div class="field-map-tiles" id="field-map-tiles"></div>
            <svg class="field-map-shapes" id="field-map-shapes" aria-hidden="true"></svg>
            <div class="field-map-markers" id="field-map-markers"></div>
            <div id="field-map-empty" class="field-map-empty" hidden>No map center yet. Set a zone center in lobby rules, or wait for an available location.</div>
          </div>
          <div class="map-zoom-buttons"><button type="button" class="map-tool" data-action="map-zoom-in" aria-label="Zoom in">+</button><button type="button" class="map-tool" data-action="map-zoom-out" aria-label="Zoom out">−</button></div>
          <span class="map-top-label">${game.settings.centerLat===null ? 'CENTER UNSET' : `PLAY ZONE · ${num(game.settings.radiusMeters)} M`}</span>
          <div id="map-attribution" class="map-attribution" hidden>© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a></div>
        </div>
        <div class="map-toolbar"><button type="button" class="btn btn-sm btn-quiet" data-action="map-reset">⌖ RECENTER</button><button type="button" class="btn btn-sm btn-quiet" data-action="map-streets-toggle" id="map-streets-state">LOAD STREETS (ONLINE)</button></div>
        <p class="helper">Street tiles are optional and require internet. Loading them sends the viewed map area to OpenStreetMap, not game pings. Without tiles, the relative map remains usable.</p>
      </div>
      <div class="map-sidebar">
      ${activeRunner ? `<div class="sharing-panel"><div class="sharing-eyebrow">YOUR RUNNER POSITION</div>
          <div class="sharing-status-line"><span class="sharing-led ${enabled ? 'on' : ''}"></span><strong id="sharing-status">${enabled ? 'SHARING ENABLED' : 'SHARING OFF'}</strong></div>
          <p>Opt-in only. When enabled, this visible tab gets one fresh GPS fix per ${game.settings.pingIntervalMinutes || 5} minute${game.settings.pingIntervalMinutes === 1 ? '' : 's'} and sends it to the online game server. Only Hunters see the latest ping, its age, and GPS accuracy, after their head start. No movement history is kept.</p>
          <div id="sharing-next" class="sharing-next">${enabled ? 'Next ping is scheduled.' : 'Nothing is being sent.'}</div>
          ${enabled ? '<button type="button" data-action="share-stop" class="btn btn-danger btn-wide">STOP SHARING & CLEAR PING</button>' : `<button type="button" data-action="share-start" class="btn btn-primary btn-wide" ${!activeGame ? 'disabled' : ''}>ENABLE LOCATION PINGS</button>`}
          <p class="helper">You can revoke at any time. Stopping removes your last ping from the server for future viewers; it cannot retract positions someone already saw. Sharing ends when the round ends.</p>
        </div>` : `<div class="sharing-panel"><div class="sharing-eyebrow">${hunter ? 'HUNTER RADAR' : 'LOCATION VISIBILITY'}</div>
          <div class="sharing-status-line"><span class="sharing-led ${pings.length ? 'on' : ''}"></span><strong>${hunter ? `${pings.length} ACTIVE PING${pings.length === 1 ? '' : 'S'}` : 'SHARING UNAVAILABLE'}</strong></div>
          <p>${hunter ? 'Markers show the last timed ping of each opted-in active Runner, not their real-time path. A missing marker means no visible recent ping.' : 'Only uncaptured Runners can choose to share periodic location pings.'}</p>
        </div>`}
        ${hunter ? `<div class="map-ping-list"><div class="sharing-eyebrow">LATEST REPORTED POSITIONS</div>
          ${pings.length ? pings.map(p => `<div class="map-ping-row"><span class="map-ping-dot"></span><div><strong>${e(p.name)}</strong><span class="helper" data-ping-time="${p.at}">${pingAge(p.at)} · ±${num(p.accuracy)} m GPS</span></div></div>`).join('') : `<p class="small-print">${game.status !== 'running' ? 'Pings are only shown during an active round.' : currentClock().headStart > 0 ? 'Hunter release has not started. Pings stay hidden until then.' : 'Waiting for Runners to opt in and transmit their first ping.'}</p>`}
        </div>` : ''}
        <div class="map-legend"><span><i class="legend-zone"></i> Play boundary</span><span><i class="legend-me"></i> Your location (local)</span><span><i class="legend-ping"></i> Last known Runner ping</span></div>
      </div>
    </div>
  </section>`;
}
function feedPanel() {
  return `<section class="panel"><div class="card-title-row"><h2 class="card-title">Activity feed</h2><span class="card-kicker">LATEST EVENTS</span></div>
    <div class="feed">${game.events.slice(0,8).map(event => `<div class="feed-event ${e(event.kind)}"><span class="feed-time">${new Date(event.at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</span><span class="feed-copy">${e(event.text)}</span></div>`).join('') || '<div class="empty-state">Match events will appear here.</div>'}</div>
  </section>`;
}
function questPanel() {
  const canClaim = game.me.team === 'runner' && !game.me.captured && game.status === 'running';
  return `<section class="panel"><div class="card-title-row"><h2 class="card-title">Runner quests</h2><span class="card-kicker">${game.quests.length} OBJECTIVES</span></div>
    <p class="panel-description" style="margin-bottom:18px">Complete missions to earn points for the Runner team.</p>
    ${game.quests.length ? `<div class="quest-list">${game.quests.map((q,i) => {
      const done = game.me.completedQuests.includes(q.id);
      return `<div class="quest-item ${done ? 'done' : ''}"><span class="quest-check">${done ? '✓' : String(i+1).padStart(2,'0')}</span>
        <div class="quest-body"><div class="quest-name">${e(q.title)}</div><div class="quest-note">${done ? 'COMPLETED · POINTS AWARDED' : 'RUNNER MISSION / ONCE PER PLAYER'}</div>
        ${canClaim && !done ? `<button class="btn btn-sm btn-quiet" data-action="claim-quest" data-quest="${e(q.id)}">MARK COMPLETE ↗</button>` : ''}</div>
        <span class="quest-point">+${num(q.points)}</span></div>`;
    }).join('')}</div>` : '<div class="empty-state">No quests for this game. The Runner team can earn survival points at time-up.</div>'}
  </section>`;
}
function tagPanel() {
  if (game.me.team === 'runner' && !game.me.captured && game.status !== 'ended') {
    return `<section class="panel"><div class="card-title-row"><h2 class="card-title">Your tag code</h2><span class="card-kicker">KEEP PRIVATE</span></div><div class="tag-code-wrap"><div class="micro lime">RUNNER IDENTIFICATION</div><div class="tag-code">${e(game.me.tagCode)}</div><div class="tag-help">Only reveal these four digits after a Hunter physically tags you. They enter the code to confirm the capture.</div></div></section>`;
  }
  if (game.me.captured) {
    return `<section class="panel"><div class="card-title-row"><h2 class="card-title">Capture status</h2><span class="card-kicker">RUNNER TAGGED</span></div><div class="notice warning">You were captured. ${game.settings.convertCaptured ? 'You can now hunt other runners with the Hunters.' : 'You are out for this round; watch the scoreboard.'}</div></section>`;
  }
  return '';
}
function targetsPanel() {
  const activeHunter = game.me.activeTeam === 'hunter';
  const targets = game.players.filter(p => p.team === 'runner');
  const clock = currentClock();
  return `<section class="panel"><div class="card-title-row"><h2 class="card-title">Capture board</h2><span class="card-kicker">TAG VERIFICATION</span></div>
    <p class="panel-description" style="margin-bottom:13px">After a real-world tag, ask the runner for their private code and enter it here.</p>
    ${game.status==='running' && clock.headStart > 0 ? '<div class="notice warning" id="hunt-lock">HUNTERS LOCKED</div>' : game.status==='running' ? '<div class="notice" id="hunt-lock">HUNTERS RELEASED</div>' : ''}
    ${!activeHunter ? '<div class="notice">Only active Hunters can record captures.</div>' : ''}
    ${targets.length ? `<div class="target-list">${targets.map(p => `<div class="target-card"><div class="target-head"><strong>◎ ${e(p.name)}</strong>${p.captured ? '<span class="captured-tag">TAGGED ✓</span>' : '<span class="micro">AT LARGE</span>'}</div>
      ${p.captured ? '<div class="small-print">This runner has already been captured.</div>' : `<form data-tag-target="${e(p.id)}" class="target-input-row"><input class="input" name="pin" type="text" inputmode="numeric" pattern="[0-9]{4}" minlength="4" maxlength="4" placeholder="4-DIGIT CODE" aria-label="Tag code for ${e(p.name)}" autocomplete="off" required ${!activeHunter || game.status!=='running' ? 'disabled' : ''}>
      <button class="btn btn-sm" data-capture-button type="submit" ${!activeHunter || game.status!=='running' || clock.headStart>0 ? 'disabled':''}>TAG +${num(game.settings.capturePoints)}</button></form>`}</div>`).join('')}</div>` : '<div class="empty-state">No runners in this match.</div>'}
  </section>`;
}
function editPanel() {
  if (!editOpen || !game.me.isHost || game.status !== 'lobby') return '';
  if (!editDraft) editDraft = { settings: { ...game.settings }, quests: game.quests.map(q=>({ ...q })) };
  return `<section class="panel host-edit"><div class="card-title-row"><h2 class="card-title">Edit match settings</h2><button class="btn btn-sm btn-quiet" data-action="toggle-edit">CLOSE ×</button></div>
    <form id="edit-form">${settingsFields(editDraft.settings)}${questFields(editDraft.quests)}<div class="btn-bar" style="margin-top:20px"><button class="btn btn-primary" type="submit">SAVE RULES</button></div></form></section>`;
}
function renderGame() {
  if (!game) return;
  const scoreMax = Math.max(game.scores.hunters, game.scores.runners, 1);
  const totalHunters = game.players.filter(p => p.activeTeam === 'hunter').length;
  const totalRunners = game.players.filter(p => p.team === 'runner' && !p.captured).length;
  const personal = game.me.captured ? 'CAPTURED' : game.me.activeTeam==='hunter' ? 'HUNTER' : 'RUNNER';
  app.innerHTML = `<div class="game-page">
    <div class="game-head"><div><div class="eyebrow">◆ OPERATION ACTIVE / ${e(game.code)}</div><h1>${e(game.title)}</h1><div class="game-meta">Playing as <strong>${e(game.me.name)}</strong> · ${personal} ${game.me.isHost ? '· HOST' : ''} · ${game.players.length} players in room</div></div>
      <div class="game-head-right">${statusFlag(game.status)}<div class="room-code"><span class="room-code-label">ROOM<br>CODE</span><strong>${e(game.code)}</strong></div><button class="btn btn-sm" data-action="copy-link">COPY INVITE ↗</button><button class="btn btn-sm btn-quiet" data-action="leave">SWITCH ROOM</button></div>
    </div>
    ${winnerBlock()}${editPanel()}
    <section class="summary-row">
      ${scoreCard('hunter',game.scores.hunters,totalHunters,game.scores.hunters / scoreMax * 100)}
      <div class="timer-card"><div><div class="timer-title">${game.status==='ended' ? 'FINAL TIME' : 'TIME REMAINING'}</div><div id="timer-value" class="timer-value">--:--</div><div id="timer-sub" class="timer-sub">Match timer</div></div><span class="timer-glyph" aria-hidden="true">◷</span></div>
      ${scoreCard('runner',game.scores.runners,totalRunners,game.scores.runners / scoreMax * 100)}
    </section>
    ${mapPanel()}
    <div class="game-grid">
      <div class="stack">${zonePanel()}${feedPanel()}</div>
      <div class="stack">${tagPanel()}${targetsPanel()}${questPanel()}</div>
      <div class="stack">${rosterPanel()}${hostPanel()}${recoveryPanel()}${rulesPanel()}</div>
    </div>
    ${game.status==='lobby' ? `<div class="notice" style="margin-top:18px">Invite friends using the code <strong>${e(game.code)}</strong>. The host starts the game when both teams are ready.</div>` : ''}
  </div>`;
  updateClock();
  updateZoneUI();
  FieldMap.mount(game, gps);
  updateSharingUI();
}
function distanceMeters(lat1, lng1, lat2, lng2) {
  const r = 6371000, toRad = x => x * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const h = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng/2)**2;
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(h)));
}
function updateZoneUI() {
  if (!game) return;
  const status = document.getElementById('zone-status');
  const detail = document.getElementById('zone-detail');
  const marker = document.getElementById('zone-player-dot');
  if (!status || !detail || !marker) return;
  marker.style.display = 'none';
  if (game.settings.centerLat === null || game.settings.centerLng === null) {
    status.textContent = 'ZONE CENTER NOT SET';
    detail.textContent = 'Host can add GPS coordinates in the lobby rules.';
    return;
  }
  if (gps.status === 'error') { status.textContent = 'LOCATION UNAVAILABLE'; detail.textContent = gps.error; return; }
  if (gps.status === 'loading') { status.textContent = 'FINDING YOUR POSITION'; detail.textContent = 'Grant location permission if prompted.'; return; }
  if (gps.lat === null || gps.lng === null) {
    status.textContent = 'LOCATION NOT CHECKED';
    detail.textContent = 'Tap “Check my location” to see your distance from the zone center.';
    return;
  }
  const s = game.settings;
  const d = distanceMeters(s.centerLat, s.centerLng, gps.lat, gps.lng);
  const approximate = gps.accuracy !== null && Math.abs(d-s.radiusMeters) <= gps.accuracy;
  const inside = d <= s.radiusMeters;
  status.textContent = approximate ? 'NEAR ZONE BOUNDARY' : inside ? 'INSIDE PLAY AREA' : 'OUTSIDE PLAY AREA';
  status.style.color = approximate ? '#ffd696' : inside ? 'var(--acid)' : 'var(--danger)';
  detail.textContent = `${Math.round(d).toLocaleString()} m from center · GPS ±${Math.round(gps.accuracy || 0)} m · advisory only`;
  const metersEast = (gps.lng - s.centerLng) * 111320 * Math.cos(s.centerLat * Math.PI / 180);
  const metersNorth = (gps.lat - s.centerLat) * 111320;
  marker.style.left = `${clamp(50 + (metersEast/s.radiusMeters)*37.5, 3, 97)}%`;
  marker.style.top = `${clamp(50 - (metersNorth/s.radiusMeters)*37.5, 3, 97)}%`;
  marker.classList.toggle('outside', !inside);
  marker.style.display = 'block';
}
function stopGPS() {
  if (watchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  gps = { status: 'off', lat: null, lng: null, accuracy: null, error: '' };
  FieldMap.refresh(game, gps);
}
function checkSecureLocation() {
  if (!navigator.geolocation) { toast('Your browser does not support location services.', true); return false; }
  if (!window.isSecureContext) { toast('GPS needs HTTPS. Use the public https:// link from your hosting provider.', true); return false; }
  return true;
}
function startGPS() {
  if (!checkSecureLocation()) return;
  gps.status = 'loading';
  updateZoneUI();
  watchId = navigator.geolocation.watchPosition(pos => {
    gps = { status: 'ready', lat: pos.coords.latitude, lng: pos.coords.longitude,
      accuracy: pos.coords.accuracy, error: '' };
    updateZoneUI();
    FieldMap.refresh(game, gps);
  }, err => {
    gps.status = 'error';
    gps.error = err.code === 1 ? 'Location permission denied. Enable it in your browser.' : err.message || 'No GPS fix available.';
    stopGPS();
    updateZoneUI();
    toast(gps.error, true);
  }, { enableHighAccuracy: true, maximumAge: 6000, timeout: 15000 });
  renderGame();
}
function centerFromLocation(form) {
  if (!checkSecureLocation()) return;
  toast('Requesting location for zone center…');
  navigator.geolocation.getCurrentPosition(pos => {
    form.elements.centerLat.value = pos.coords.latitude.toFixed(6);
    form.elements.centerLng.value = pos.coords.longitude.toFixed(6);
    syncDraftFromForm(form);
    toast(`Play area centered here (±${Math.round(pos.coords.accuracy)} m).`);
  }, err => toast(err.message || 'Could not get GPS position.', true),
  { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 });
}
function saveSession(code, token) {
  session = { code, token };
  try {
    localStorage.setItem(`manhunt:${code}`, token);
    localStorage.setItem('manhunt:last', code);
  } catch {
    toast('Browser storage is blocked. Save your private recovery key before closing this page.', true);
  }
  history.replaceState(null, '', `/?game=${encodeURIComponent(code)}`);
}
function forgetSession(discard = false) {
  revokeLocationOnExit();
  try {
    if (session && discard) localStorage.removeItem(`manhunt:${session.code}`);
    localStorage.removeItem('manhunt:last');
  } catch { /* Private browsers may deny localStorage. */ }
  clearReconnect();
  if (stream) stream.close();
  stream = null;
  stopGPS();
  session = null;
  game = null;
  editDraft = null;
  editOpen = false;
  shareSessionActive = false;
  recoveryRevealed = false;
  initialPageRestore = true;
  setConnectivity(true);
  history.replaceState(null, '', '/');
  renderHome();
}
function setGame(next) {
  game = next;
  timeOffset = Date.now() - game.serverNow;
  game._timeOffset = timeOffset;
  setConnectivity(true);
  clearReconnect();
  if (game.status !== 'lobby') { editOpen = false; editDraft = null; }
  if (game.status === 'ended' || game.me.captured || !game.locationSharing?.enabled) shareSessionActive = false;
  renderGame();
}
async function restoreSession() {
  if (!session || restoring) return;
  restoring = true;
  try {
    let state = await request(`/api/state?code=${encodeURIComponent(session.code)}&token=${encodeURIComponent(session.token)}`);
    if (initialPageRestore && state.locationSharing?.enabled) {
      // A browser restart never silently resumes GPS sharing.
      try { state = await request('/api/action', { code: session.code, token: session.token,
        type: 'location-consent', enabled: false }); }
      catch { toast('Could not clear the previous location ping. Stop sharing again when connected.', true); }
    }
    initialPageRestore = false;
    setGame(state);
    connectStream();
  } catch (error) {
    if (error.httpStatus === 401 || error.httpStatus === 404) {
      forgetSession(true);
      toast('Your saved login is no longer valid. Use your recovery key or ask the host.', true);
    } else {
      if (!game) renderReconnecting();
      else setConnectivity(false);
      scheduleReconnect();
    }
  } finally { restoring = false; }
}
async function refreshState() {
  if (!session || refreshing) return;
  refreshing = true;
  try {
    const state = await request(`/api/state?code=${encodeURIComponent(session.code)}&token=${encodeURIComponent(session.token)}`);
    if (!game || state.version !== game.version ||
        JSON.stringify(state.locationPings) !== JSON.stringify(game.locationPings) ||
        JSON.stringify(state.locationSharing) !== JSON.stringify(game.locationSharing)) setGame(state);
    else { game.serverNow = state.serverNow; timeOffset = Date.now() - state.serverNow; game._timeOffset = timeOffset; setConnectivity(true); clearReconnect(); }
  } catch (error) {
    if (error.httpStatus === 401 || error.httpStatus === 404) {
      forgetSession(true);
      toast('Your session was removed or replaced. You can recover it with your private key.', true);
    } else { setConnectivity(false); scheduleReconnect(); }
  } finally { refreshing = false; }
}
function connectStream() {
  if (stream) stream.close();
  if (!session) return;
  stream = new EventSource(`/api/stream?code=${encodeURIComponent(session.code)}&token=${encodeURIComponent(session.token)}`);
  stream.addEventListener('open', () => { setConnectivity(true); refreshState(); });
  stream.addEventListener('error', () => { if (session) { setConnectivity(false); scheduleReconnect(); } });
  stream.addEventListener('sync', event => {
    try {
      const incoming = JSON.parse(event.data);
      if (!game || incoming.version !== game.version) refreshState();
    } catch { refreshState(); }
  });
}
async function gameAction(type, extras = {}) {
  if (!session) return;
  const state = await request('/api/action', { code: session.code, token: session.token, type, ...extras });
  setGame(state);
  return state;
}
function revokeLocationOnExit() {
  if (!session || !game?.locationSharing?.enabled) return;
  shareSessionActive = false;
  const payload = JSON.stringify({ code: session.code, token: session.token,
    type: 'location-consent', enabled: false });
  // Fire-and-forget on page exit. On the next open the app retries revocation.
  try {
    if (navigator.sendBeacon) {
      navigator.sendBeacon('/api/action', new Blob([payload], { type: 'application/json' }));
    } else fetch('/api/action', { method: 'POST', body: payload,
      headers: { 'Content-Type':'application/json' }, keepalive: true }).catch(() => {});
  } catch { /* Phone may already be offline; old pings expire automatically. */ }
}
async function enableSharing() {
  if (!game || game.status !== 'running' || game.me.team !== 'runner' || game.me.captured) return;
  if (!checkSecureLocation()) return;
  if (!confirm(`Share one GPS location with all Hunters every ${game.settings.pingIntervalMinutes || 5} minute(s) while this tab is open and visible? Your last point, time and GPS accuracy will be visible. You can stop sharing at any time.`)) return;
  shareSessionActive = true;
  lastPresenceSent = Date.now();
  try {
    await gameAction('location-consent', { enabled: true });
    toast('Location sharing enabled. Your browser may ask for GPS permission.');
    maybeSendLocationPing();
  } catch (error) { shareSessionActive = false; throw error; }
}
async function disableSharing() {
  shareSessionActive = false;
  if (!session) return;
  // Do not wait for the network before stopping any new GPS requests.
  try { await gameAction('location-consent', { enabled: false }); toast('Sharing stopped. Your last ping was cleared.'); }
  catch (error) { toast(`Couldn't clear the server ping: ${error.message}. Reconnect and stop sharing again.`, true); }
}
function maybeHeartbeatLocation() {
  if (!shareSessionActive || !session || !game?.locationSharing?.enabled ||
    game.status !== 'running' || document.hidden || presenceSending || Date.now() - lastPresenceSent < 30000) return;
  lastPresenceSent = Date.now();
  presenceSending = true;
  request('/api/action', { code: session.code, token: session.token, type: 'location-heartbeat' })
    .catch(error => { if (error.offline) { setConnectivity(false); scheduleReconnect(); } })
    .finally(() => { presenceSending = false; });
}
function updateSharingUI() {
  if (!game) return;
  const label = document.getElementById('sharing-status');
  const next = document.getElementById('sharing-next');
  if (label && next) {
    const enabled = Boolean(game.locationSharing?.enabled);
    const headStart = currentClock().headStart;
    if (!enabled) { label.textContent = 'SHARING OFF'; next.textContent = 'No coordinates are being sent.'; }
    else if (!shareSessionActive) { label.textContent = 'SHARING PAUSED'; next.textContent = 'Re-enable sharing in this browser. An existing ping may be visible until you stop sharing.'; }
    else if (game.status !== 'running') { label.textContent = 'SHARING PAUSED'; next.textContent = 'No pings during a paused or finished game.'; }
    else if (headStart > 0) { label.textContent = 'ARMED · WAITING'; next.textContent = `Hunters unlock in ${formatTime(headStart)}; no pings sent before then.`; }
    else if (document.hidden) { label.textContent = 'PAUSED IN BACKGROUND'; next.textContent = 'Return to this tab to continue sending scheduled pings.'; }
    else {
      label.textContent = 'SHARING WITH HUNTERS';
      const lastAt = game.locationSharing.lastPingAt;
      const nextAt = game.locationSharing.nextAllowedAt;
      const nextMs = Math.max(0, (nextAt || 0) - (Date.now() - timeOffset));
      next.textContent = !lastAt ? 'First location ping is due now.' : `Last ping ${pingAge(lastAt)} · next in ${formatTime(nextMs)}`;
    }
  }
  for (const el of document.querySelectorAll('[data-ping-time]')) {
    const at = Number(el.dataset.pingTime);
    if (Number.isFinite(at)) el.textContent = `${pingAge(at)} · ±${Number(el.textContent.match(/±([\d,]+) m/)?.[1]?.replaceAll(',','') || 0).toLocaleString()} m GPS`;
  }
  // Update map marker age without interrupting pointer dragging each second.
  if (Date.now() - lastMapAgeUpdate > 15000) { FieldMap.refresh(game, gps); lastMapAgeUpdate = Date.now(); }
}
function maybeSendLocationPing() {
  if (!shareSessionActive || !session || !game?.locationSharing?.enabled ||
      game.me.team !== 'runner' || game.me.captured || game.status !== 'running' ||
      document.hidden || currentClock().headStart > 0 || sendingPing) return;
  if (game.locationSharing.nextAllowedAt &&
      Date.now() - timeOffset < game.locationSharing.nextAllowedAt) return;
  if (!checkLocationSupportedSilently()) return;
  sendingPing = true;
  // Request a NEW reading only when the scheduled ping is due; do not upload a GPS trail.
  navigator.geolocation.getCurrentPosition(async pos => {
    try {
      if (!shareSessionActive || !session || document.hidden) return;
      gps = { status: 'ready', lat: pos.coords.latitude, lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy, error: '' };
      updateZoneUI(); FieldMap.refresh(game, gps);
      const state = await request('/api/ping', { code: session.code, token: session.token,
        lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy });
      if (shareSessionActive) setGame(state);
    } catch (error) {
      if (!/next location ping is not due yet/i.test(error.message)) toast(`Location ping failed: ${error.message}`, true);
    } finally { sendingPing = false; }
  }, async err => {
    sendingPing = false;
    toast(err.code === 1 ? 'Location permission denied. Sharing will be turned off.' :
      `Could not get a GPS fix: ${err.message || 'unknown error'}`, true);
    if (err.code === 1) await disableSharing();
  }, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
}
function checkLocationSupportedSilently() {
  return Boolean(navigator.geolocation && window.isSecureContext);
}
async function copyText(value) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const helper = document.createElement('textarea');
  helper.value = value; helper.style.position = 'fixed'; helper.style.opacity = '0';
  document.body.appendChild(helper); helper.select();
  const ok = document.execCommand('copy');
  helper.remove();
  if (!ok) throw new Error('Could not copy. Share the room code manually.');
}
app.addEventListener('click', async event => {
  const button = event.target.closest('[data-action]');
  if (!button || button.disabled) return;
  const actionType = button.dataset.action;
  try {
    if (actionType === 'add-quest' || actionType === 'remove-quest') {
      const form = button.closest('form');
      syncDraftFromForm(form);
      const draft = form.id === 'edit-form' ? editDraft : createDraft;
      if (actionType === 'add-quest' && draft.quests.length < 12) draft.quests.push({ title: '', points: 25 });
      if (actionType === 'remove-quest') draft.quests.splice(Number(button.dataset.index), 1);
      if (form.id === 'edit-form') renderGame(); else renderHome();
      return;
    }
    if (actionType === 'set-center-gps') { centerFromLocation(button.closest('form')); return; }
    if (actionType === 'gps-start') { startGPS(); return; }
    if (actionType === 'gps-stop') { stopGPS(); renderGame(); return; }
    if (actionType === 'share-start') { await enableSharing(); return; }
    if (actionType === 'share-stop') { await disableSharing(); return; }
    if (actionType === 'map-reset') { FieldMap.reset(); return; }
    if (actionType === 'map-zoom-in') { FieldMap.changeZoom(1); return; }
    if (actionType === 'map-zoom-out') { FieldMap.changeZoom(-1); return; }
    if (actionType === 'map-streets-toggle') { FieldMap.toggleStreets(); return; }
    if (actionType === 'copy-link') {
      await copyText(`${location.origin}/?game=${encodeURIComponent(game.code)}`);
      toast('Invite link copied. Friends can join from any network.');
      return;
    }
    if (actionType === 'leave' || actionType === 'switch-room') {
      if (game && !confirm('Switch to the home screen? Your player stays saved. You can resume this game later.')) return;
      forgetSession(false); return;
    }
    if (actionType === 'retry-restore') { restoreSession(); return; }
    if (actionType === 'resume-saved') {
      const code = button.dataset.code;
      const token = localStorage.getItem(`manhunt:${code}`);
      if (!token) { toast('Saved login missing. Use your recovery key.', true); return; }
      session = { code, token }; initialPageRestore = true;
      localStorage.setItem('manhunt:last', code);
      history.replaceState(null, '', `/?game=${encodeURIComponent(code)}`);
      renderReconnecting(); restoreSession(); return;
    }
    if (actionType === 'copy-recovery') { await copyText(game.me.recoveryKey); toast('Private recovery key copied. Keep it secure.'); return; }
    if (actionType === 'toggle-recovery') { recoveryRevealed = !recoveryRevealed; renderGame(); return; }
    if (actionType === 'toggle-edit') {
      if (editOpen) { editOpen = false; editDraft = null; }
      else { editOpen = true; editDraft = { settings: { ...game.settings }, quests: game.quests.map(q => ({ ...q })) }; }
      renderGame(); return;
    }
    if (actionType === 'switch-team') { await gameAction('set-team', { team: button.dataset.team }); return; }
    if (actionType === 'claim-quest') { await gameAction('claim-quest', { questId: button.dataset.quest }); toast('Quest complete. Runner points added.'); return; }
    if (actionType === 'remove-player') {
      if (!confirm('Remove this player from the lobby?')) return;
      await gameAction('remove-player', { targetId: button.dataset.target }); return;
    }
    if (actionType === 'start') { await gameAction('start'); toast('Game started. Runners, go!'); return; }
    if (actionType === 'pause') { await gameAction('pause'); return; }
    if (actionType === 'resume') { await gameAction('resume'); return; }
    if (actionType === 'end') {
      if (!confirm('End this round and lock the scores?')) return;
      await gameAction('end'); return;
    }
    if (actionType === 'rematch') { await gameAction('rematch'); toast('Rematch lobby created.'); return; }
  } catch (error) { toast(error.message, true); }
});
app.addEventListener('submit', async event => {
  const form = event.target;
  if (!['create-form','join-form','edit-form','recover-form'].includes(form.id) && !form.matches('[data-tag-target]')) return;
  event.preventDefault();
  const submit = form.querySelector('[type="submit"]');
  if (submit) submit.disabled = true;
  try {
    if (form.id === 'create-form') {
      syncDraftFromForm(form);
      const data = await request('/api/create', {
        title: createDraft.title, name: createDraft.name, team: createDraft.team,
        settings: createDraft.settings, quests: createDraft.quests
      });
      saveSession(data.code, data.token);
      setGame(data.state);
      connectStream();
      toast('Lobby created. Share your invite code.');
    } else if (form.id === 'join-form') {
      const f = new FormData(form);
      const data = await request('/api/join', {
        code: String(f.get('code') || '').toUpperCase().replace(/\s/g,''), name: f.get('name'), team: f.get('team')
      });
      saveSession(data.code, data.token);
      setGame(data.state);
      connectStream();
      toast(`Joined game ${data.code}.`);
    } else if (form.id === 'recover-form') {
      const f = new FormData(form);
      const data = await request('/api/recover', { code: String(f.get('code') || '').trim().toUpperCase(),
        recoveryKey: String(f.get('recoveryKey') || '').trim() });
      saveSession(data.code, data.token);
      setGame(data.state);
      connectStream();
      toast(`Recovered your original player in ${data.code}.`);
    } else if (form.id === 'edit-form') {
      syncDraftFromForm(form);
      await gameAction('update-settings', editDraft);
      editOpen = false;
      editDraft = null;
      renderGame();
      toast('Match rules saved for everyone.');
    } else if (form.matches('[data-tag-target]')) {
      const pin = String(new FormData(form).get('pin') || '').trim();
      await gameAction('capture', { targetId: form.dataset.tagTarget, pin });
      toast('Tag confirmed. Hunter points awarded.');
    }
  } catch (error) { toast(error.message, true); }
  finally { if (submit && document.contains(submit)) submit.disabled = false; }
});
app.addEventListener('input', event => {
  const form = event.target.closest('form');
  if (form && (form.id === 'create-form' || form.id === 'edit-form')) syncDraftFromForm(form);
});
app.addEventListener('change', event => {
  const form = event.target.closest('form');
  if (form && (form.id === 'create-form' || form.id === 'edit-form')) syncDraftFromForm(form);
});

async function boot() {
  let code = savedInviteCode.toUpperCase();
  let token = '';
  try {
    code = code || (localStorage.getItem('manhunt:last') || '').toUpperCase();
    token = code ? localStorage.getItem(`manhunt:${code}`) : '';
  } catch { /* The homepage still works if storage is disabled. */ }
  if (!code || !token) { renderHome(); return; }
  session = { code, token };
  renderReconnecting();
  await restoreSession();
}
setInterval(() => { updateClock(); updateSharingUI(); maybeSendLocationPing(); maybeHeartbeatLocation(); }, 1000);
// Fallback for dropped SSE connections, mobile radios sleeping, and server restarts.
setInterval(() => { if (session && game && !refreshing) refreshState(); }, 20000);
window.addEventListener('online', () => { if (!session) return; if (game) refreshState(); else restoreSession(); });
window.addEventListener('pagehide', () => { revokeLocationOnExit(); stopGPS(); });
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    if (session && game) refreshState();
    updateSharingUI(); maybeSendLocationPing(); maybeHeartbeatLocation();
  }
});
boot();
