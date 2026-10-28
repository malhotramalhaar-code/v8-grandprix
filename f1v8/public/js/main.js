// App controller: menu, lobby, editor and race flow, for both online rooms and offline (solo) play.
import { World } from './world.js';
import { HUD } from './hud.js';
import { GameAudio } from './audio.js';
import { Input } from './input.js';
import { Net } from './net.js';
import { Race } from './race.js';
import { TrackEditor } from './editor.js';
import { BUILTIN, trackFromDescriptor, specFromDescriptor, decodeSpec, loadSavedTracks, deleteSavedTrack } from './tracks.js';
import { buildTrack } from './track.js';
import { buildCarModel } from './carmodel.js';

const $ = (s) => document.querySelector(s);
const load = (k, d) => { try { return { ...d, ...JSON.parse(localStorage.getItem(k) || '{}') }; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

const COLORS = ['#e10600', '#ff6a00', '#ffd100', '#84cc16', '#10b981', '#06b6d4', '#2563eb', '#7c3aed', '#ec4899', '#f8fafc', '#6b7280', '#1e293b', '#b91c1c', '#0e7490', '#4338ca', '#a16207'];
const BOTS = [['Rossi', '#1e41ff'], ['Hartmann', '#ff8000'], ['Delacroix', '#00d2be'], ['Tanaka', '#dc0000'], ['Okafor', '#006f62'], ['Lindqvist', '#2b4562'], ['Moreau', '#ffffff'], ['Barros', '#b6babd'], ['Kowalski', '#900000'], ['Ferrante', '#0090ff'], ['Nakamura', '#ffcc00'], ['Duval', '#7d3cff'], ['Santos', '#ff66b2'], ['Holm', '#2dd36f'], ['Bianchi', '#ff5e00'], ['Varga', '#9bd1ff'], ['Eriksen', '#bbb04a'], ['Costa', '#4cc3ff'], ['Weber', '#c4421a']];

const profile = load('v8gp.profile', { name: 'Driver' + Math.floor(Math.random() * 90 + 10), color: COLORS[0], num: 1 + Math.floor(Math.random() * 98) });
const prefs = load('v8gp.prefs', { abs: true, tc: 0.5, steerAssist: 0.5, auto: true, line: false, cam: 0 });
const setup = load('v8gp.setup', { compound: 'medium', wing: 0.5, bias: 0.58 });

const world = new World($('#gl'));
const hud = new HUD($('#race'));
const audio = new GameAudio();
const input = new Input();

const S = {
  screen: 'menu', net: null, room: null, local: false, myId: 'me', race: null,
  localSettings: { track: { type: 'builtin', id: 'veloce' }, laps: 3, ai: 11, aiSkill: 0.9, wear: 1, grid: 'random', public: false },
  edFrom: 'menu', model: null, ready: false,
};

addEventListener('pointerdown', () => audio.ensure(), { once: true });
addEventListener('keydown', () => audio.ensure(), { once: true });

// ---------------------------------------------------------------- screens
function show(name) {
  S.screen = name;
  for (const id of ['menu', 'lobby', 'editor', 'race']) $('#' + id).classList.toggle('active', id === name);
  input.enabled = name === 'race';
  if (name === 'menu' || name === 'lobby') ensureShowroom();
}

function ensureShowroom() {
  if (S.race) return;
  if (!world.showroom) { S.model = buildCarModel(profile.color, profile.num, setup.compound); world.setShowroom(true, S.model); world.camera.fov = 42; world.camera.updateProjectionMatrix(); }
}
function refreshModel() {
  if (!world.showroom) return;
  world.showroom.group.remove(S.model);
  S.model = buildCarModel(profile.color, profile.num, setup.compound);
  world.showroom.group.add(S.model);
}

function banner(text, ms = 3500) {
  const b = $('#banner'); b.textContent = text; b.classList.remove('hidden');
  clearTimeout(banner.t); banner.t = setTimeout(() => b.classList.add('hidden'), ms);
}
function menuMsg(text, bad) { const m = $('#menu-msg'); m.textContent = text || ''; m.className = 'msg' + (bad ? ' bad' : ''); }

// ---------------------------------------------------------------- menu
{
  const sw = $('#swatches');
  COLORS.forEach((c) => {
    const i = document.createElement('i'); i.style.background = c; i.dataset.c = c;
    i.onclick = () => { profile.color = c; save('v8gp.profile', profile); markSwatch(); refreshModel(); pushProfile(); };
    sw.appendChild(i);
  });
  const markSwatch = () => sw.querySelectorAll('i').forEach((i) => i.classList.toggle('on', i.dataset.c === profile.color));
  markSwatch();
  $('#in-name').value = profile.name;
  $('#in-num').value = profile.num;
  $('#in-name').oninput = (e) => { profile.name = e.target.value.slice(0, 16); save('v8gp.profile', profile); };
  $('#in-name').onchange = () => pushProfile();
  $('#in-num').onchange = (e) => { profile.num = Math.max(1, Math.min(99, parseInt(e.target.value) || 1)); e.target.value = profile.num; save('v8gp.profile', profile); refreshModel(); pushProfile(); };
}

$('#btn-help').onclick = () => $('#help').classList.remove('hidden');
$('#help-close').onclick = () => $('#help').classList.add('hidden');
$('#btn-solo').onclick = () => {
  S.local = true; S.myId = 'me'; S.ready = false;
  S.room = localRoom();
  show('lobby'); renderLobby();
};
$('#btn-create').onclick = async () => { if (await connectNet()) S.net.send({ t: 'create', settings: { track: S.localSettings.track, laps: 5, ai: 0 } }); };
$('#btn-join').onclick = () => joinCode($('#in-code').value);
$('#in-code').onkeydown = (e) => { if (e.key === 'Enter') joinCode(e.target.value); };
$('#in-code').oninput = (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, ''); };
$('#btn-quick').onclick = async () => { if (await connectNet()) S.net.send({ t: 'quick' }); };
$('#btn-refresh').onclick = async () => { if (await connectNet(true)) S.net.send({ t: 'rooms' }); };
$('#btn-editor').onclick = () => openEditor('menu');

async function joinCode(code) {
  code = (code || '').trim().toUpperCase();
  if (code.length !== 4) return menuMsg('Enter the 4-letter room code', true);
  if (await connectNet()) S.net.send({ t: 'join', code });
}

function localRoom() {
  return { code: 'SOLO', host: 'me', state: 'lobby', settings: S.localSettings, players: [{ id: 'me', name: profile.name, color: profile.color, num: profile.num, ready: true, setup }] };
}

// ---------------------------------------------------------------- networking
async function connectNet(quiet) {
  if (S.net && S.net.open) return S.net;
  const net = new Net();
  wireNet(net);
  try {
    await net.connect({ name: profile.name, color: profile.color, num: profile.num });
  } catch (e) {
    if (!quiet) menuMsg('Cannot reach the game server. Is server.py running?', true);
    $('#net-status').textContent = 'Offline — solo play still works.';
    return null;
  }
  S.net = net; S.myId = net.id; S.local = false;
  $('#net-status').textContent = 'Connected';
  menuMsg('');
  return net;
}

function pushProfile() {
  if (S.net && S.net.open && S.room && !S.local) S.net.send({ t: 'profile', name: profile.name, color: profile.color, num: profile.num, setup });
}

function wireNet(net) {
  net.on('rooms', (m) => renderRooms(m.list));
  net.on('joined', (m) => {
    S.local = false; S.room = m; S.myId = m.you; S.ready = false;
    $('#chat-log').innerHTML = '';
    pushProfile();
    show('lobby'); renderLobby();
    history.replaceState(null, '', '?room=' + m.code);
  });
  net.on('room', (m) => { S.room = m; if (S.screen === 'lobby') renderLobby(); });
  net.on('left_room', () => { S.room = null; history.replaceState(null, '', location.pathname); });
  net.on('err', (m) => { if (S.screen === 'menu') menuMsg(m.msg, true); else banner(m.msg); });
  net.on('chat', (m) => addChat(m.name, m.text));
  net.on('race', (m) => startRace(m));
  net.on('lobby', () => { if (S.race) toLobby(); });
  net.on('close', () => {
    banner('Connection to the server was lost', 6000);
    S.net = null;
    if (S.race) { S.race.destroy(); S.race = null; world.clearTrack(); }
    S.room = null; S.local = false;
    show('menu'); ensureShowroom();
  });
}

function renderRooms(list) {
  const el = $('#room-list');
  if (!list.length) { el.innerHTML = '<p class="muted">No public rooms right now. Host one!</p>'; return; }
  el.innerHTML = '';
  for (const r of list) {
    const d = document.createElement('div'); d.className = 'room';
    d.innerHTML = `<div><b>${r.code}</b><span>${esc(r.host)}'s race · ${esc(r.track)} · ${r.laps} laps</span></div><span>${r.players}/${r.max}</span>`;
    d.onclick = () => joinCode(r.code);
    el.appendChild(d);
  }
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------------------------------------------------------------- lobby
const thumbCache = new Map();
function thumb(spec, key) {
  if (thumbCache.has(key)) return thumbCache.get(key);
  const c = document.createElement('canvas'); c.width = 260; c.height = 200;
  try {
    const T = buildTrack(spec), g = c.getContext('2d'), b = T.bounds, pad = 20;
    const sc = Math.min((260 - pad * 2) / (b.maxx - b.minx), (200 - pad * 2) / (b.maxy - b.miny));
    const ox = (260 - (b.maxx - b.minx) * sc) / 2 - b.minx * sc, oy = (200 - (b.maxy - b.miny) * sc) / 2 + b.maxy * sc;
    g.lineJoin = g.lineCap = 'round';
    const path = () => { g.beginPath(); for (let i = 0; i <= T.n; i += 3) { const k = i % T.n; const x = T.x[k] * sc + ox, y = oy - T.y[k] * sc; i ? g.lineTo(x, y) : g.moveTo(x, y); } g.closePath(); };
    g.strokeStyle = 'rgba(0,0,0,0.6)'; g.lineWidth = 10; path(); g.stroke();
    g.strokeStyle = T.street ? '#c9ccd4' : '#e8eaf0'; g.lineWidth = 5; path(); g.stroke();
    g.fillStyle = '#e10600'; g.beginPath(); g.arc(T.x[0] * sc + ox, oy - T.y[0] * sc, 6, 0, 6.3); g.fill();
    c.dataset.len = (T.length / 1000).toFixed(2);
  } catch { c.dataset.len = '?'; }
  thumbCache.set(key, c);
  return c;
}

const isHost = () => S.local || (S.room && S.room.host === S.myId);
const settings = () => (S.local ? S.localSettings : S.room.settings);

function descKey(d) { return d.type === 'builtin' ? 'b:' + d.id : d.type === 'seed' ? 's:' + d.seed : 'c:' + (d.spec && d.spec.name) + ':' + (d.spec && d.spec.points.length); }
function sameDesc(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

function changeSetting(patch) {
  if (!isHost()) return;
  if (S.local) { Object.assign(S.localSettings, patch); save('v8gp.local', S.localSettings); renderLobby(); } else S.net.send({ t: 'settings', s: patch });
}

function addTrackCard(grid, desc, spec, title, sub, on, canDel) {
  const d = document.createElement('div'); d.className = 'tcard' + (on ? ' on' : '');
  const c = thumb(spec, descKey(desc));
  const cv = document.createElement('canvas'); cv.width = 260; cv.height = 200; cv.getContext('2d').drawImage(c, 0, 0);
  d.appendChild(cv);
  d.insertAdjacentHTML('beforeend', `<b>${esc(title)}</b><span>${c.dataset.len} km · ${esc(sub)}</span>`);
  if (canDel) { const x = document.createElement('div'); x.className = 'del'; x.textContent = '×'; x.onclick = (e) => { e.stopPropagation(); deleteSavedTrack(spec.name); renderLobby(); }; d.appendChild(x); }
  d.onclick = () => changeSetting({ track: desc });
  grid.appendChild(d);
}

let lobbyTrackKey = '';
function renderLobby() {
  const R = S.room; if (!R) return;
  const st = settings();
  const host = isHost();
  $('#lb-code').textContent = R.code;
  $('#btn-copy').style.display = S.local ? 'none' : '';
  $('#chat').style.display = S.local ? 'none' : '';
  $('#lb-state').textContent = R.state === 'finished' ? 'Race finished — waiting for the host' : '';

  // players
  const pl = $('#lb-players');
  pl.innerHTML = R.players.map((p) => `
    <div class="pl${p.id === S.myId ? ' me' : ''}"><i style="background:${esc(p.color)}"></i><span class="num">${p.num}</span><span class="nm">${esc(p.name)}</span>
    ${p.id === R.host ? '<span class="tag2 host">HOST</span>' : p.ready ? '<span class="tag2 rdy">READY</span>' : ''}</div>`).join('')
    + (st.ai ? `<div class="pl"><i style="background:#555"></i><span class="num">AI</span><span class="nm">${st.ai} computer driver${st.ai > 1 ? 's' : ''}</span></div>` : '');
  $('#lb-count').textContent = S.local ? '' : `${R.players.length}/20`;

  // track picker
  const grid = $('#track-grid');
  const saved = loadSavedTracks();
  const key = JSON.stringify([st.track, saved.length, host]);
  if (key !== lobbyTrackKey) {
    lobbyTrackKey = key;
    grid.innerHTML = '';
    for (const b of BUILTIN) addTrackCard(grid, { type: 'builtin', id: b.id }, b, b.name, b.style === 'street' ? 'street' : 'circuit', sameDesc(st.track, { type: 'builtin', id: b.id }));
    if (st.track.type === 'seed') addTrackCard(grid, st.track, specFromDescriptor(st.track), 'Random: ' + st.track.seed, 'generated', true);
    if (st.track.type === 'custom' && !saved.some((s) => s.name === st.track.spec.name)) addTrackCard(grid, st.track, st.track.spec, st.track.spec.name, 'custom', true);
    $('#my-tracks').innerHTML = '';
    for (const s of saved) addTrackCard($('#my-tracks'), { type: 'custom', spec: s }, s, s.name, 'my track', st.track.type === 'custom' && st.track.spec.name === s.name, true);
    $('#my-tracks').style.display = saved.length ? 'grid' : 'none';
    $('#my-tracks').className = 'trackgrid mytracks';
  }
  const tn = st.track.type === 'builtin' ? (BUILTIN.find((b) => b.id === st.track.id) || BUILTIN[0]).name : st.track.type === 'seed' ? 'Random ' + st.track.seed : st.track.spec.name;
  $('#lb-trackname').textContent = tn;
  $('#track-grid').parentElement.classList.toggle('locked', !host);

  // race settings
  const set = (id, v, label) => { const el = $(id); if (document.activeElement !== el) el.value = v; if (label) $(label).textContent = ''; };
  set('#s-laps', st.laps); $('#v-laps').textContent = st.laps;
  set('#s-ai', st.ai); $('#v-ai').textContent = st.ai;
  set('#s-skill', Math.round(st.aiSkill * 100)); $('#v-skill').textContent = Math.round(st.aiSkill * 100) + '%';
  set('#s-wear', String(Math.round(st.wear))); set('#s-grid', st.grid);
  $('#s-public').checked = !!st.public;
  $('#settings').classList.toggle('locked', !host);
  $('#s-public').parentElement.style.display = S.local ? 'none' : '';

  // actions
  $('#btn-start').classList.toggle('hidden', !host);
  $('#btn-ready').classList.toggle('hidden', host);
  const me = R.players.find((p) => p.id === S.myId);
  $('#btn-ready').textContent = me && me.ready ? 'Not ready' : "I'm ready";
  const ready = R.players.filter((p) => p.ready || p.id === R.host).length;
  $('#lb-hint').textContent = host ? (S.local ? '' : `${ready}/${R.players.length} ready · share the code or invite link`) : 'Waiting for the host to start…';
  $('#btn-start').disabled = R.state === 'racing';
}

$('#btn-leave').onclick = () => { if (S.net && S.room && !S.local) S.net.send({ t: 'leave' }); S.room = null; S.local = false; show('menu'); };
$('#btn-copy').onclick = () => {
  const url = `${location.origin}/?room=${S.room.code}`;
  (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject()).then(() => banner('Invite link copied: ' + url), () => banner(url, 8000));
};
$('#btn-ready').onclick = () => { const me = S.room.players.find((p) => p.id === S.myId); S.net.send({ t: 'ready', ready: !(me && me.ready) }); };
$('#btn-start').onclick = () => { if (S.local) startLocal(); else S.net.send({ t: 'start' }); };

$('#s-laps').oninput = (e) => changeSetting({ laps: +e.target.value });
$('#s-ai').oninput = (e) => changeSetting({ ai: +e.target.value });
$('#s-skill').oninput = (e) => changeSetting({ aiSkill: +e.target.value / 100 });
$('#s-wear').onchange = (e) => changeSetting({ wear: +e.target.value });
$('#s-grid').onchange = (e) => changeSetting({ grid: e.target.value });
$('#s-public').onchange = (e) => changeSetting({ public: e.target.checked });
$('#btn-seed').onclick = () => {
  const seed = $('#in-seed').value.trim() || String(Math.floor(Math.random() * 100000));
  $('#in-seed').value = seed;
  changeSetting({ track: { type: 'seed', seed } });
};
$('#btn-import').onclick = () => {
  const spec = decodeSpec($('#in-import').value);
  if (!spec) return banner('That track code is not valid');
  $('#in-import').value = '';
  changeSetting({ track: { type: 'custom', spec } });
};

$('#chat-form').onsubmit = (e) => {
  e.preventDefault();
  const v = $('#chat-in').value.trim();
  if (v && S.net) S.net.send({ t: 'chat', text: v });
  $('#chat-in').value = '';
};
function addChat(name, text) {
  const log = $('#chat-log');
  log.insertAdjacentHTML('beforeend', `<p><b>${esc(name)}</b> ${esc(text)}</p>`);
  log.scrollTop = log.scrollHeight;
}

// garage + aids
{
  const markComp = () => { document.querySelectorAll('#g-comp button').forEach((b) => b.classList.toggle('on', b.dataset.v === setup.compound)); $('#g-comp-hint').textContent = { soft: 'Most grip, wears quickly.', medium: 'Balanced.', hard: 'Lasts longest, less grip.' }[setup.compound]; };
  document.querySelectorAll('#g-comp button').forEach((b) => { b.onclick = () => { setup.compound = b.dataset.v; save('v8gp.setup', setup); markComp(); refreshModel(); pushProfile(); }; });
  markComp();
  const w = $('#g-wing'); w.value = Math.round(setup.wing * 100); $('#v-wing').textContent = w.value + '%';
  w.oninput = () => { setup.wing = w.value / 100; $('#v-wing').textContent = w.value + '%'; save('v8gp.setup', setup); };
  w.onchange = pushProfile;
  const b = $('#g-bias'); b.value = Math.round(setup.bias * 100); $('#v-bias').textContent = b.value + '% front';
  b.oninput = () => { setup.bias = b.value / 100; $('#v-bias').textContent = b.value + '% front'; save('v8gp.setup', setup); };
  b.onchange = pushProfile;
  $('#a-abs').checked = prefs.abs; $('#a-abs').onchange = (e) => { prefs.abs = e.target.checked; save('v8gp.prefs', prefs); };
  $('#a-tc').value = String(prefs.tc); $('#a-tc').onchange = (e) => { prefs.tc = +e.target.value; save('v8gp.prefs', prefs); };
  const ss = $('#a-steer'); ss.value = Math.round(prefs.steerAssist * 100); $('#v-steer').textContent = ss.value + '%';
  ss.oninput = () => { prefs.steerAssist = ss.value / 100; $('#v-steer').textContent = ss.value + '%'; save('v8gp.prefs', prefs); };
  $('#a-auto').checked = prefs.auto; $('#a-auto').onchange = (e) => { prefs.auto = e.target.checked; save('v8gp.prefs', prefs); };
  $('#a-line').checked = prefs.line; $('#a-line').onchange = (e) => { prefs.line = e.target.checked; save('v8gp.prefs', prefs); };
}
Object.assign(S.localSettings, load('v8gp.local', {}));

// ---------------------------------------------------------------- editor
const editor = new TrackEditor($('#editor'), {
  onClose: () => { if (S.edFrom === 'lobby' && S.room) { show('lobby'); renderLobby(); } else show('menu'); },
  onUse: (spec) => {
    if (S.room && isHost()) { show('lobby'); changeSetting({ track: { type: 'custom', spec } }); }
    else if (S.room) { show('lobby'); banner('Only the host can pick the circuit — send them your track code from the editor'); }
    else { S.local = true; S.myId = 'me'; S.localSettings.track = { type: 'custom', spec }; S.room = localRoom(); show('lobby'); renderLobby(); }
  },
  onTest: (spec) => {
    S.local = true; S.myId = 'me';
    S.localSettings = { ...S.localSettings, track: { type: 'custom', spec }, laps: 3, ai: 5 };
    S.room = localRoom();
    startLocal();
  },
});
function openEditor(from) {
  S.edFrom = from;
  const st = S.room ? settings() : null;
  const spec = st && st.track.type === 'custom' ? st.track.spec : st && st.track.type !== 'custom' ? { ...specFromDescriptor(st.track), name: 'My ' + specFromDescriptor(st.track).name } : undefined;
  show('editor'); editor.open(spec);
}

// ---------------------------------------------------------------- race flow
function startLocal() {
  const st = S.localSettings;
  const n = st.ai;
  const order = Array.from({ length: n + 1 }, (_, i) => i);
  let mySlot = st.grid === 'reverse' ? n : st.grid === 'random' ? Math.floor(Math.random() * (n + 1)) : 0;
  const cars = [], grid = {};
  const bots = [...BOTS].sort(() => Math.random() - 0.5).slice(0, n);
  let bi = 0;
  for (let s = 0; s <= n; s++) {
    if (s === mySlot) { cars.push({ id: 'me', name: profile.name, color: profile.color, num: profile.num, bot: false }); grid.me = s; }
    else { const [nm, col] = bots[bi]; const id = 'b' + (bi + 1); cars.push({ id, name: nm, color: col, num: 20 + bi, bot: true }); grid[id] = s; bi++; }
  }
  const now = Date.now();
  startRace({ raceId: String(now), track: st.track, laps: st.laps, grid, cars, lights0: now + 3000, go: now + 8000 + 700 + Math.random() * 1500, settings: st, host: 'me' });
}

function startRace(msg) {
  if (S.race) { S.race.destroy(); S.race = null; }
  const track = trackFromDescriptor(msg.track);
  world.endShowroom();
  let h = 0; for (const ch of track.spec.name || '') h = (h * 31 + ch.charCodeAt(0)) | 0;
  world.setTrack(track, h);
  world.camera.fov = 65; world.camera.updateProjectionMatrix();
  show('race');
  hud.setPaused(false);
  hud.onLeave = leaveRace;
  hud.onResume = () => { if (S.race) S.race.paused = false; };
  S.race = new Race({
    world, hud, audio, input, net: S.local ? null : S.net, track, msg, me: { id: S.myId, setup: { ...setup } }, prefs, local: S.local,
    onResults: (list) => hud.showResults(list, S.myId, { isHost: isHost(), local: S.local, onLobby: backToLobby, onMenu: leaveRace }),
  });
}

function backToLobby() {
  if (!S.local && S.net && isHost()) S.net.send({ t: 'lobby' });   // everyone follows via the 'lobby' message
  else toLobby();
}

function toLobby() {
  if (S.race) { S.race.destroy(); S.race = null; }
  world.clearTrack();
  world.setShowroom(false);
  show('lobby'); renderLobby();
  if (S.local) S.room = localRoom();
}

function leaveRace() {
  if (S.race) { S.race.destroy(); S.race = null; }
  world.clearTrack();
  if (S.net && S.room && !S.local) S.net.send({ t: 'leave' });
  S.room = null; S.local = false;
  show('menu');
}

// ---------------------------------------------------------------- main loop
let last = performance.now();
function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  if (S.race) { S.race.frame(dt); return; }
  input.clearPressed();
  if (S.screen === 'editor') return;
  if (world.showroom) {
    const t = now / 1000 * 0.22, cam = world.camera;
    cam.position.set(Math.cos(t) * 9.2, 2.6, Math.sin(t) * 9.2);
    cam.lookAt(0.2, 0.55, 0);
    world.follow(0, 0);
  }
  world.render();
}
requestAnimationFrame(loop);

// ---------------------------------------------------------------- boot
(async function boot() {
  show('menu');
  const roomParam = new URLSearchParams(location.search).get('room');
  const net = await connectNet(true);
  if (net) {
    net.send({ t: 'rooms' });
    if (roomParam && /^[A-Za-z]{4}$/.test(roomParam)) { $('#in-code').value = roomParam.toUpperCase(); net.send({ t: 'join', code: roomParam.toUpperCase() }); }
  } else $('#net-status').textContent = 'Server not reachable — solo play still works.';
  setInterval(() => { if (S.screen === 'menu' && S.net && S.net.open) S.net.send({ t: 'rooms' }); }, 4000);
})();

window.__v8 = { S, world, hud, audio, input, startLocal, prefs, setup };
