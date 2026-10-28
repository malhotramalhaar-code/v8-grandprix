// DOM heads-up display for the race view.
import { COMPOUNDS } from './physics.js';

const fmt = (t) => {
  if (t == null || !isFinite(t)) return '-:--.---';
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ordinal = (n) => n + (['th', 'st', 'nd', 'rd'][(n % 100 > 10 && n % 100 < 14) ? 0 : n % 10 < 4 ? n % 10 : 0]);

export class HUD {
  constructor(root) {
    this.root = root;
    root.innerHTML = `
      <div id="h-tower"></div>
      <div id="h-top">
        <div class="pill"><span class="k">POS</span><b id="h-pos">1</b><small id="h-postot">/ 1</small></div>
        <div class="pill"><span class="k">LAP</span><b id="h-lap">1</b><small id="h-laps">/ 5</small></div>
        <div class="pill wide"><span class="k">TIME</span><b id="h-cur">0:00.000</b></div>
        <div class="pill wide"><span class="k">BEST</span><b id="h-best">-:--.---</b></div>
        <div class="pill"><span class="k">DELTA</span><b id="h-delta">--</b></div>
      </div>
      <div id="h-lights"><div class="gantry">${[0, 1, 2, 3, 4].map(() => '<div class="lamp"><i></i><i></i></div>').join('')}</div><div id="h-count"></div></div>
      <div id="h-msg"></div>
      <div id="h-toasts"></div>
      <div id="h-warn"></div>
      <canvas id="h-map" width="260" height="260"></canvas>
      <div id="h-dash">
        <div class="leds" id="h-leds">${'<i></i>'.repeat(15)}</div>
        <div class="dashrow">
          <div class="pedals"><div class="bar brk"><i id="h-brk"></i></div><div class="bar thr"><i id="h-thr"></i></div></div>
          <div class="gear"><b id="h-gear">N</b><small id="h-rpm">0 rpm</small></div>
          <div class="speed"><b id="h-speed">0</b><small>km/h</small></div>
        </div>
      </div>
      <div id="h-side">
        <div class="tyres" id="h-tyres"><div class="tyre" data-i="0"></div><div class="tyre" data-i="1"></div><div class="tyre" data-i="2"></div><div class="tyre" data-i="3"></div></div>
        <div class="kv"><span id="h-comp">MEDIUM</span><span id="h-fuel">0.0 kg</span></div>
        <div class="kers"><span>KERS</span><div class="kbar"><i id="h-kers"></i></div><b id="h-drs">DRS</b></div>
        <div class="kv small"><span>Damage</span><span id="h-dmg">0%</span></div>
        <div class="gmeter"><div class="ring"></div><i id="h-gdot"></i><small id="h-gtxt">0.0 G</small></div>
        <div class="kv small"><span id="h-cam">Chase</span><span id="h-ping"></span></div>
        <div class="kv small"><span id="h-gb">AUTO</span><span class="hint">C cam · L line · G gearbox · R reset</span></div>
      </div>
      <div id="h-pause" class="overlay hidden">
        <div class="box"><h2>PAUSED</h2><p id="h-pausetxt">The race keeps running for everyone else.</p>
        <div class="row"><button class="btn primary" id="h-resume">Resume</button><button class="btn" id="h-leave">Leave race</button></div></div>
      </div>
      <div id="h-results" class="overlay hidden"></div>`;
    this.q = (id) => root.querySelector('#' + id);
    this.el = {};
    ['h-tower', 'h-pos', 'h-postot', 'h-lap', 'h-laps', 'h-cur', 'h-best', 'h-delta', 'h-lights', 'h-count', 'h-msg', 'h-toasts', 'h-warn', 'h-map',
      'h-leds', 'h-brk', 'h-thr', 'h-gear', 'h-rpm', 'h-speed', 'h-tyres', 'h-comp', 'h-fuel', 'h-gdot', 'h-gtxt', 'h-cam', 'h-ping', 'h-gb', 'h-kers', 'h-drs', 'h-dmg', 'h-pause', 'h-pausetxt', 'h-results', 'h-resume', 'h-leave']
      .forEach((id) => { this.el[id] = this.q(id); });
    this.leds = [...this.el['h-leds'].children];
    this.lamps = [...root.querySelectorAll('.lamp')];
    this.tyres = [...root.querySelectorAll('.tyre')];
    this.mapCtx = this.el['h-map'].getContext('2d');
    this.msgTimer = null;
    this.el['h-resume'].onclick = () => this.setPaused(false, true);
    this.onResume = null; this.onLeave = null;
    this.el['h-leave'].onclick = () => this.onLeave && this.onLeave();
  }

  setTrack(track) {
    const c = document.createElement('canvas'); c.width = c.height = 260;
    const g = c.getContext('2d');
    const b = track.bounds, pad = 22;
    const sc = Math.min((260 - pad * 2) / (b.maxx - b.minx), (260 - pad * 2) / (b.maxy - b.miny));
    const ox = (260 - (b.maxx - b.minx) * sc) / 2 - b.minx * sc, oy = (260 - (b.maxy - b.miny) * sc) / 2 + b.maxy * sc;
    this.map = { sc, ox, oy };
    g.lineJoin = 'round'; g.lineCap = 'round';
    const path = () => { g.beginPath(); for (let i = 0; i <= track.n; i += 3) { const k = i % track.n; const px = track.x[k] * sc + ox, py = oy - track.y[k] * sc; i ? g.lineTo(px, py) : g.moveTo(px, py); } g.closePath(); };
    g.strokeStyle = 'rgba(0,0,0,0.65)'; g.lineWidth = 9; path(); g.stroke();
    g.strokeStyle = '#d9dce3'; g.lineWidth = 4.5; path(); g.stroke();
    g.fillStyle = '#fff'; g.fillRect(track.x[0] * sc + ox - 6, oy - track.y[0] * sc - 2, 12, 4);
    this.mapBase = c;
  }

  setLaps(n) { this.el['h-laps'].textContent = '/ ' + n; }
  reset() {
    this.el['h-results'].classList.add('hidden'); this.el['h-pause'].classList.add('hidden');
    this.el['h-msg'].textContent = ''; this.el['h-toasts'].innerHTML = '';
    this.setLights(0, true);
  }

  setLights(count, show = false) {
    const box = this.el['h-lights'];
    this.lamps.forEach((l, i) => l.classList.toggle('on', i < count));
    box.classList.toggle('show', count > 0 || show);
    if (count === 0 && !show) setTimeout(() => box.classList.remove('show'), 700);
  }
  setCountdown(sec) {
    const el = this.el['h-count'];
    if (sec == null) { el.textContent = ''; this.el['h-lights'].classList.toggle('show', this.lamps.some((l) => l.classList.contains('on'))); return; }
    this.el['h-lights'].classList.add('show');
    el.textContent = sec > 0 ? `Race starts in ${sec}` : '';
  }

  message(text, ms = 2200, cls = '') {
    const m = this.el['h-msg'];
    m.className = cls; m.textContent = text; m.style.opacity = 1;
    clearTimeout(this.msgTimer);
    this.msgTimer = setTimeout(() => { m.style.opacity = 0; }, ms);
  }

  toast(text) {
    const d = document.createElement('div');
    d.className = 'toast'; d.textContent = text;
    this.el['h-toasts'].appendChild(d);
    setTimeout(() => d.classList.add('out'), 2600);
    setTimeout(() => d.remove(), 3200);
    while (this.el['h-toasts'].children.length > 4) this.el['h-toasts'].firstChild.remove();
  }

  setPaused(p, fromBtn) {
    this.el['h-pause'].classList.toggle('hidden', !p);
    this.el['h-pausetxt'].textContent = 'Race paused.';
    if (!p && fromBtn && this.onResume) this.onResume();
  }
  togglePause() {
    const hid = this.el['h-pause'].classList.contains('hidden');
    this.el['h-pause'].classList.toggle('hidden', !hid);
    this.el['h-pausetxt'].textContent = 'The race keeps running for everyone else.';
  }

  update(s) {
    const E = this.el;
    E['h-speed'].textContent = Math.round(s.speed);
    E['h-gear'].textContent = s.gear < 0 ? 'R' : s.speed < 3 && s.thr < 0.05 && s.gear === 1 ? 'N' : s.gear;
    E['h-rpm'].textContent = Math.round(s.rpm / 10) * 10 + ' rpm';
    E['h-thr'].style.height = Math.round(s.thr * 100) + '%';
    E['h-brk'].style.height = Math.round(s.brk * 100) + '%';
    const f = Math.min(1, Math.max(0, (s.rpm - 9500) / (18000 - 9500)));
    const lit = Math.round(f * 15);
    for (let i = 0; i < 15; i++) {
      const on = i < lit;
      const col = i < 5 ? '#27d46b' : i < 10 ? '#ff2d2d' : '#3a7bff';
      const l = this.leds[i];
      l.style.background = on ? col : 'rgba(255,255,255,0.08)';
      l.style.boxShadow = on ? `0 0 8px ${col}` : 'none';
    }
    E['h-pos'].textContent = s.pos; E['h-postot'].textContent = '/ ' + s.total;
    E['h-lap'].textContent = s.lap;
    E['h-cur'].textContent = fmt(s.curLap);
    E['h-best'].textContent = fmt(s.best);
    if (s.delta == null) { E['h-delta'].textContent = '--'; E['h-delta'].className = ''; } else {
      E['h-delta'].textContent = (s.delta > 0 ? '+' : '−') + Math.abs(s.delta).toFixed(2);
      E['h-delta'].className = s.delta > 0 ? 'slow' : 'fast';
    }
    // tower
    const rows = s.order.slice(0, 10);
    const meIdx = s.order.findIndex((o) => o.isMe);
    if (meIdx >= 10) rows.push(s.order[meIdx]);
    E['h-tower'].innerHTML = rows.map((o) => {
      const p = s.order.indexOf(o) + 1;
      return `<div class="trow${o.isMe ? ' me' : ''}"><span class="p">${p}</span><i style="background:${esc(o.color)}"></i><span class="n">${esc(o.name)}</span><span class="g">${o.finished && p === 1 ? 'FIN' : p === 1 ? 'LEADER' : esc(o.gap)}</span></div>`;
    }).join('');
    // tyres, fuel
    const opt = { soft: 82, medium: 88, hard: 94 }[s.compound] || 88;
    this.tyres.forEach((t, i) => {
      const life = Math.max(0, 1 - s.wear[i]), T = s.tyreT[i];
      const dv = T - opt;
      const hue = dv < -12 ? 210 : dv < 14 ? 125 : Math.max(0, 125 - (dv - 14) * 3.2);
      const lit = dv < -12 ? 58 : 44;
      t.style.background = `hsl(${Math.round(hue)},70%,${lit}%)`;
      t.style.boxShadow = `inset 0 -4px 0 rgba(0,0,0,0.45)`;
      t.innerHTML = `${Math.round(T)}°<small>${Math.round(life * 100)}%</small>`;
    });
    E['h-kers'].style.width = Math.round(s.kers * 100) + '%';
    E['h-kers'].style.background = s.boosting ? '#3a7bff' : '#9fb4e8';
    E['h-drs'].className = s.drs === 2 ? 'on' : s.drs === 1 ? 'ready' : '';
    E['h-dmg'].textContent = Math.round(s.damage * 100) + '%';
    E['h-dmg'].style.color = s.damage > 0.5 ? '#ff5d5d' : s.damage > 0.15 ? '#ffd33b' : '';
    E['h-comp'].textContent = (COMPOUNDS[s.compound] || COMPOUNDS.medium).name.toUpperCase();
    E['h-comp'].style.color = (COMPOUNDS[s.compound] || COMPOUNDS.medium).color;
    E['h-fuel'].textContent = s.fuel.toFixed(1) + ' kg';
    const gx = Math.max(-1, Math.min(1, s.gLat / 5)), gy = Math.max(-1, Math.min(1, s.gLong / 5));
    E['h-gdot'].style.transform = `translate(${(-gx * 32).toFixed(1)}px, ${(gy * 32).toFixed(1)}px)`;
    E['h-gtxt'].textContent = Math.hypot(s.gLat, s.gLong).toFixed(1) + ' G';
    E['h-cam'].textContent = s.cam;
    E['h-ping'].textContent = s.ping ? Math.round(s.ping) + ' ms' : '';
    E['h-gb'].textContent = s.auto ? 'AUTO' : 'MANUAL';
    // warnings
    let warn = '';
    if (s.wrongWay) warn = 'WRONG WAY';
    else if (s.stuck) warn = 'Hold R to return to track';
    else if (s.offTrack) warn = 'OFF TRACK';
    E['h-warn'].textContent = warn;
    E['h-warn'].classList.toggle('show', !!warn);
    // minimap
    const g = this.mapCtx;
    g.clearRect(0, 0, 260, 260);
    if (this.mapBase) g.drawImage(this.mapBase, 0, 0);
    const { sc, ox, oy } = this.map || { sc: 1, ox: 0, oy: 0 };
    for (const c of s.cars) {
      if (c.me) continue;
      g.fillStyle = c.color; g.strokeStyle = '#000'; g.lineWidth = 1.5;
      g.beginPath(); g.arc(c.x * sc + ox, oy - c.y * sc, 4.5, 0, 6.3); g.fill(); g.stroke();
    }
    const me = s.cars.find((c) => c.me);
    if (me) {
      g.fillStyle = '#fff'; g.strokeStyle = '#e10600'; g.lineWidth = 3;
      g.beginPath(); g.arc(me.x * sc + ox, oy - me.y * sc, 6, 0, 6.3); g.fill(); g.stroke();
    }
  }

  showResults(list, meId, opts) {
    const el = this.el['h-results'];
    const myPos = list.findIndex((r) => r.id === meId) + 1;
    const rows = list.map((r, i) => `
      <tr class="${r.id === meId ? 'me' : ''}"><td>${i + 1}</td><td><i style="background:${esc(r.color)}"></i>${esc(r.name)}${r.bot ? ' <em>AI</em>' : ''}</td>
      <td>${r.finished ? fmt(r.total) : r.laps + ' laps'}</td><td>${fmt(r.best)}</td></tr>`).join('');
    el.innerHTML = `<div class="box wide">
      <div class="kicker">RACE CLASSIFICATION</div>
      <h2>${myPos === 1 ? 'VICTORY' : myPos ? ordinal(myPos) + ' PLACE' : 'RESULTS'}</h2>
      <div class="tablewrap"><table class="results"><thead><tr><th>#</th><th>Driver</th><th>Race time</th><th>Best lap</th></tr></thead><tbody>${rows}</tbody></table></div>
      <div class="row">${opts.isHost ? '<button class="btn primary" id="r-again">Back to lobby</button>' : '<button class="btn primary" id="r-lobby">Back to lobby</button>'}<button class="btn" id="r-menu">Main menu</button></div>
      ${opts.isHost || opts.local ? '' : '<p class="muted">Waiting for the host to start the next race…</p>'}
    </div>`;
    el.classList.remove('hidden');
    const again = el.querySelector('#r-again'), lob = el.querySelector('#r-lobby'), menu = el.querySelector('#r-menu');
    if (again) again.onclick = opts.onLobby;
    if (lob) lob.onclick = opts.onLobby;
    menu.onclick = opts.onMenu;
  }
}
