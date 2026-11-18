'use strict';

// Dependency-free, interactive Mercator map. Street tiles are opt-in and fetched
// directly by the browser from OpenStreetMap; game pings never go to a tile host.
const FieldMap = (() => {
  const SIZE = 256;
  const R = 6371000;
  const MAX_LAT = 85.05112878;
  let viewport = null, tilesEl = null, shapesEl = null, markersEl = null, emptyEl = null;
  let tileNodes = new Map();
  let currentState = null, currentGps = null;
  let center = null, zoom = 14, moved = false, gameCode = null, streetsOn = false;
  let drag = null;
  const esc = text => String(text ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const bounds = (v, a, b) => Math.max(a, Math.min(b, v));
  const sizeAt = z => SIZE * 2 ** z;
  function project(lat, lng, z = zoom) {
    const latitude = bounds(lat, -MAX_LAT, MAX_LAT) * Math.PI / 180;
    const side = sizeAt(z);
    return { x: (lng + 180) / 360 * side,
      y: (1 - Math.log(Math.tan(latitude) + 1 / Math.cos(latitude)) / Math.PI) / 2 * side };
  }
  function unproject(x, y, z = zoom) {
    const side = sizeAt(z);
    const yy = bounds(y / side, 0.001, 0.999);
    return { lat: Math.atan(Math.sinh(Math.PI * (1 - 2 * yy))) * 180 / Math.PI,
      lng: ((x / side * 360 + 180) % 360 + 360) % 360 - 180 };
  }
  function screenPoint(lat, lng, w, h) {
    const p = project(lat, lng), o = project(center.lat, center.lng), side = sizeAt(zoom);
    let deltaX = p.x - o.x;
    if (deltaX > side / 2) deltaX -= side;
    if (deltaX < -side / 2) deltaX += side;
    return { x: w / 2 + deltaX, y: h / 2 + p.y - o.y };
  }
  function radiusPixels(meters, lat) {
    return meters / (2 * Math.PI * R * Math.max(0.01, Math.cos(lat * Math.PI / 180)) / sizeAt(zoom));
  }
  function defaultCenter(state, gps) {
    if (state.settings.centerLat != null && state.settings.centerLng != null)
      return { lat: state.settings.centerLat, lng: state.settings.centerLng };
    if (state.locationPings?.length) return { lat: state.locationPings[0].lat, lng: state.locationPings[0].lng };
    if (gps?.lat != null && gps?.lng != null) return { lat: gps.lat, lng: gps.lng };
    return null;
  }
  function startingZoom(lat, radius, w, h) {
    const span = Math.max(160, Math.min(w, h));
    const metresPerPixelAtZero = 2 * Math.PI * R * Math.cos(lat * Math.PI / 180) / SIZE;
    return bounds(Math.round(Math.log2(metresPerPixelAtZero * span / (radius * 2.6))), 3, 18);
  }
  function mount(state, gps) {
    currentState = state; currentGps = gps;
    viewport = document.getElementById('field-map-viewport');
    if (!viewport) return;
    tilesEl = viewport.querySelector('#field-map-tiles');
    shapesEl = viewport.querySelector('#field-map-shapes');
    markersEl = viewport.querySelector('#field-map-markers');
    emptyEl = viewport.querySelector('#field-map-empty');
    tileNodes = new Map(); drag = null;
    const freshGame = gameCode !== state.code;
    if (freshGame) { center = null; moved = false; gameCode = state.code; streetsOn = false; }
    if (!center) {
      center = defaultCenter(state, gps);
      if (center) zoom = startingZoom(center.lat, state.settings.radiusMeters || 1500,
        viewport.clientWidth || 600, viewport.clientHeight || 420);
    }
    viewport.addEventListener('pointerdown', ev => {
      if (!center || (ev.pointerType === 'mouse' && ev.button !== 0)) return;
      drag = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, origin: project(center.lat, center.lng) };
      viewport.setPointerCapture(ev.pointerId);
      viewport.classList.add('is-dragging');
    });
    viewport.addEventListener('pointermove', ev => {
      if (!drag || drag.id !== ev.pointerId) return;
      const pos = unproject(drag.origin.x - (ev.clientX - drag.x), drag.origin.y - (ev.clientY - drag.y));
      center = pos; moved = true; paint();
    });
    const stopDrag = ev => {
      if (!drag || drag.id !== ev.pointerId) return;
      drag = null; viewport.classList.remove('is-dragging');
    };
    viewport.addEventListener('pointerup', stopDrag);
    viewport.addEventListener('pointercancel', stopDrag);
    viewport.addEventListener('wheel', ev => {
      if (!center) return;
      ev.preventDefault(); changeZoom(ev.deltaY < 0 ? 1 : -1);
    }, { passive: false });
    viewport.addEventListener('keydown', ev => {
      if (ev.key === '+' || ev.key === '=') { ev.preventDefault(); changeZoom(1); }
      if (ev.key === '-') { ev.preventDefault(); changeZoom(-1); }
      if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(ev.key) && center) {
        ev.preventDefault(); const o = project(center.lat, center.lng);
        center = unproject(o.x + (ev.key==='ArrowRight'?80:ev.key==='ArrowLeft'?-80:0),
          o.y + (ev.key==='ArrowDown'?80:ev.key==='ArrowUp'?-80:0));
        moved = true; paint();
      }
    });
    paint();
  }
  function refresh(state, gps) {
    if (state) currentState = state;
    if (gps) currentGps = gps;
    if (!viewport || !viewport.isConnected || !currentState) return;
    if (!center && !moved) {
      center = defaultCenter(currentState, currentGps);
      if (center) zoom = startingZoom(center.lat, currentState.settings.radiusMeters || 1500,
        viewport.clientWidth || 600, viewport.clientHeight || 420);
    }
    paint();
  }
  function changeZoom(delta) {
    if (!center) return;
    zoom = bounds(zoom + delta, 3, 18);
    moved = true; paint();
  }
  function reset() {
    if (!currentState) return;
    center = defaultCenter(currentState, currentGps); moved = false;
    if (center && viewport) zoom = startingZoom(center.lat, currentState.settings.radiusMeters || 1500,
      viewport.clientWidth || 600, viewport.clientHeight || 420);
    paint();
  }
  function toggleStreets() { streetsOn = !streetsOn; paint(); return streetsOn; }
  function paint() {
    if (!viewport || !viewport.isConnected || !currentState) return;
    const w = viewport.clientWidth, h = viewport.clientHeight;
    if (!w || !h) return;
    const status = document.getElementById('map-streets-state');
    if (status) status.textContent = streetsOn ? 'HIDE STREETS' : 'LOAD STREETS (ONLINE)';
    const attribution = document.getElementById('map-attribution');
    if (attribution) attribution.hidden = !streetsOn;
    if (!center) {
      emptyEl.hidden = false;
      shapesEl.innerHTML = ''; markersEl.innerHTML = '';
      tilesEl.replaceChildren(); tileNodes.clear();
      return;
    }
    emptyEl.hidden = true;
    // Keep existing tile elements while panning so drag does not redownload tiles.
    const needed = new Set();
    if (streetsOn) {
      const origin = project(center.lat, center.lng), sideTiles = 2 ** zoom;
      const x0 = Math.floor((origin.x - w / 2) / SIZE), x1 = Math.floor((origin.x + w / 2) / SIZE);
      const y0 = Math.floor((origin.y - h / 2) / SIZE), y1 = Math.floor((origin.y + h / 2) / SIZE);
      for (let yy = Math.max(0, y0); yy <= Math.min(sideTiles - 1, y1); yy++) {
        for (let xx = x0; xx <= x1; xx++) {
          const x = ((xx % sideTiles) + sideTiles) % sideTiles;
          const key = `${zoom}/${x}/${yy}`;
          needed.add(key);
          let img = tileNodes.get(key);
          if (!img) {
            img = document.createElement('img'); img.className = 'street-tile'; img.alt = '';
            img.draggable = false; img.decoding = 'async';
            img.src = `https://tile.openstreetmap.org/${zoom}/${x}/${yy}.png`;
            tilesEl.appendChild(img); tileNodes.set(key, img);
          }
          img.style.left = `${Math.round(xx * SIZE - origin.x + w / 2)}px`;
          img.style.top = `${Math.round(yy * SIZE - origin.y + h / 2)}px`;
        }
      }
    }
    for (const [key, img] of tileNodes) if (!needed.has(key)) { img.remove(); tileNodes.delete(key); }
    const s = currentState.settings;
    if (s.centerLat != null && s.centerLng != null) {
      const pin = screenPoint(s.centerLat, s.centerLng, w, h);
      const r = radiusPixels(s.radiusMeters, s.centerLat);
      shapesEl.innerHTML = `<circle cx="${pin.x}" cy="${pin.y}" r="${r}" fill="rgba(197,245,111,.065)" stroke="#c5f56f" stroke-width="2" stroke-dasharray="8 6"/><path d="M${pin.x-9} ${pin.y}h18 M${pin.x} ${pin.y-9}v18" stroke="#c5f56f" stroke-width="2"/>`;
    } else shapesEl.innerHTML = '';
    const pins = [];
    if (currentState.me?.team === 'runner' && !currentState.me.captured && currentGps?.lat != null && currentGps?.lng != null) {
      pins.push({ lat: currentGps.lat, lng: currentGps.lng, name: 'YOU · LOCAL ONLY', kind: 'self' });
    }
    if (currentState.me?.activeTeam === 'hunter' && currentState.status === 'running') {
      for (const ping of currentState.locationPings || []) {
        const age = Math.max(0, Math.floor(((Date.now() - (currentState._timeOffset || 0)) - ping.at) / 60000));
        pins.push({ lat: ping.lat, lng: ping.lng, name: `${ping.name} · ${age}m ago · ±${ping.accuracy}m`, kind: 'runner' });
      }
    }
    markersEl.innerHTML = pins.map(pin => {
      const pos = screenPoint(pin.lat, pin.lng, w, h);
      if (pos.x < -90 || pos.x > w+90 || pos.y < -90 || pos.y > h+90) return '';
      return `<div class="field-pin ${pin.kind}" style="left:${pos.x}px;top:${pos.y}px"><span class="pin-center"></span><span class="pin-label">${esc(pin.name)}</span></div>`;
    }).join('');
  }
  return { mount, refresh, changeZoom, reset, toggleStreets };
})();
