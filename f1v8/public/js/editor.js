// Track editor: click to add control points, drag to move, right-click to delete.
import { buildTrack, validateTrack } from './track.js';
import { BUILTIN, generateTrackSpec, encodeSpec, decodeSpec, saveTrack } from './tracks.js';

const TEMPLATES = {
  'Oval': (R = 800) => Array.from({ length: 10 }, (_, i) => { const a = (i / 10) * Math.PI * 2; return [Math.cos(a) * R * 1.5, Math.sin(a) * R * 0.7]; }),
  'Paperclip': () => [[-900, -250], [0, -300], [900, -250], [1250, 0], [900, 250], [0, 300], [-900, 250], [-1250, 0]],
  'Kidney': () => [[-900, -300], [-200, -380], [500, -300], [1000, -100], [900, 300], [300, 450], [-300, 250], [-900, 380], [-1300, 100]],
  'Twisty': () => [[-900, 0], [-600, -350], [-200, -150], [200, -450], [700, -300], [900, 50], [600, 350], [200, 150], [-200, 400], [-650, 300]],
};

export class TrackEditor {
  constructor(root, cb) {
    this.root = root; this.cb = cb;
    root.innerHTML = `
      <div class="ed-side">
        <div class="ed-head"><button class="btn ghost small" id="ed-back">← Menu</button><h2>Track Editor</h2></div>
        <label>Name <input id="ed-name" maxlength="24"></label>
        <label>Road width <b id="ed-wv"></b><input id="ed-w" type="range" min="9" max="22" step="0.5"></label>
        <label>Style <select id="ed-style"><option value="circuit">Circuit (grass + gravel)</option><option value="street">Street (walls)</option></select></label>
        <div class="ed-row"><label>Grass <input id="ed-grass" type="number" min="0" max="20" step="1"></label><label>Gravel <input id="ed-gravel" type="number" min="0" max="30" step="1"></label></div>
        <div class="ed-stat" id="ed-stat"></div>
        <h3>Start from</h3>
        <div class="chips" id="ed-templates"></div>
        <div class="ed-row"><input id="ed-seed" placeholder="seed" value=""><button class="btn small" id="ed-rand">🎲 Random</button></div>
        <h3>Edit</h3>
        <div class="chips"><button class="btn small" id="ed-mirror">Mirror</button><button class="btn small" id="ed-rot">Rotate 15°</button><button class="btn small" id="ed-scale">Scale ±</button><button class="btn small" id="ed-clear">Clear</button></div>
        <p class="hint">Click empty space: add point. Drag a point: move it. Right-click a point: delete. Drag empty space / wheel: pan &amp; zoom. The start line is placed automatically on the longest straight.</p>
        <h3>Share</h3>
        <textarea id="ed-code" rows="3" placeholder="Track code appears here — paste a friend's code and press Import"></textarea>
        <div class="chips"><button class="btn small" id="ed-export">Copy code</button><button class="btn small" id="ed-import">Import</button></div>
        <div class="ed-actions"><button class="btn" id="ed-save">Save to My Tracks</button><button class="btn" id="ed-test">Test drive</button><button class="btn primary" id="ed-use">Use for next race</button></div>
        <div class="msg" id="ed-msg"></div>
      </div>
      <canvas id="ed-canvas"></canvas>`;
    this.q = (id) => root.querySelector('#' + id);
    this.canvas = this.q('ed-canvas'); this.ctx = this.canvas.getContext('2d');
    this.spec = { name: 'My Circuit', points: TEMPLATES.Kidney(), width: 14, style: 'circuit', grass: 6, gravel: 9 };
    this.view = { cx: 0, cy: 0, zoom: 0.35 };
    this.drag = null; this.sel = -1; this.hover = -1;
    this.track = null; this.valid = null;
    this.bindUI();
    this.bindCanvas();
    new ResizeObserver(() => this.resize()).observe(this.canvas);
  }

  bindUI() {
    const q = this.q;
    const T = q('ed-templates');
    for (const k of Object.keys(TEMPLATES)) {
      const b = document.createElement('button'); b.className = 'btn small'; b.textContent = k;
      b.onclick = () => { this.spec.points = TEMPLATES[k](); this.fit(); this.update(); };
      T.appendChild(b);
    }
    for (const t of BUILTIN) {
      const b = document.createElement('button'); b.className = 'btn small ghost'; b.textContent = t.name.split(' ').slice(-1)[0];
      b.title = 'Copy ' + t.name;
      b.onclick = () => { this.spec = { ...JSON.parse(JSON.stringify(t)), name: t.name + ' mod' }; this.syncUI(); this.fit(); this.update(); };
      T.appendChild(b);
    }
    q('ed-name').oninput = (e) => { this.spec.name = e.target.value.slice(0, 24) || 'My Circuit'; };
    q('ed-w').oninput = (e) => { this.spec.width = +e.target.value; q('ed-wv').textContent = this.spec.width + ' m'; this.update(); };
    q('ed-style').onchange = (e) => { this.spec.style = e.target.value; this.update(); };
    q('ed-grass').oninput = (e) => { this.spec.grass = +e.target.value; this.update(); };
    q('ed-gravel').oninput = (e) => { this.spec.gravel = +e.target.value; this.update(); };
    q('ed-rand').onclick = () => {
      const seed = q('ed-seed').value.trim() || String(Math.floor(Math.random() * 99999));
      q('ed-seed').value = seed;
      const s = generateTrackSpec(seed);
      this.spec = { name: 'Random ' + seed, points: s.points, width: s.width, style: s.style, grass: s.grass, gravel: s.gravel };
      this.syncUI(); this.fit(); this.update();
    };
    q('ed-mirror').onclick = () => { this.spec.points = this.spec.points.map(([x, y]) => [-x, y]).reverse(); this.update(); };
    q('ed-rot').onclick = () => { const a = Math.PI / 12, c = Math.cos(a), s = Math.sin(a); this.spec.points = this.spec.points.map(([x, y]) => [x * c - y * s, x * s + y * c]); this.update(); };
    q('ed-scale').onclick = (e) => { const f = e.shiftKey ? 0.9 : 1.1; this.spec.points = this.spec.points.map(([x, y]) => [x * f, y * f]); this.update(); };
    q('ed-clear').onclick = () => { this.spec.points = []; this.update(); };
    q('ed-export').onclick = () => {
      if (!this.valid || !this.valid.ok) return this.msg('Fix the track first: ' + (this.valid ? this.valid.reason : ''), true);
      const code = encodeSpec(this.spec); q('ed-code').value = code;
      navigator.clipboard && navigator.clipboard.writeText(code).then(() => this.msg('Code copied to clipboard'), () => this.msg('Select the code and copy it'));
    };
    q('ed-import').onclick = () => {
      const s = decodeSpec(q('ed-code').value);
      if (!s) return this.msg('That is not a valid track code', true);
      this.spec = s; this.syncUI(); this.fit(); this.update(); this.msg('Imported ' + s.name);
    };
    q('ed-save').onclick = () => { if (!this.ok()) return; saveTrack(this.spec); this.msg('Saved. Find it under My Tracks in the lobby.'); };
    q('ed-test').onclick = () => { if (!this.ok()) return; this.cb.onTest(this.clean()); };
    q('ed-use').onclick = () => { if (!this.ok()) return; saveTrack(this.spec); this.cb.onUse(this.clean()); };
    q('ed-back').onclick = () => this.cb.onClose();
  }

  clean() { return JSON.parse(JSON.stringify(this.spec)); }
  ok() { if (!this.valid || !this.valid.ok) { this.msg(this.valid ? this.valid.reason : 'Add at least 6 points', true); return false; } return true; }
  msg(t, bad) { const m = this.q('ed-msg'); m.textContent = t; m.className = 'msg' + (bad ? ' bad' : ' good'); }

  open(spec) {
    if (spec) this.spec = JSON.parse(JSON.stringify(spec));
    this.syncUI(); this.resize(); this.fit(); this.update();
  }

  syncUI() {
    const q = this.q, s = this.spec;
    q('ed-name').value = s.name; q('ed-w').value = s.width; q('ed-wv').textContent = s.width + ' m';
    q('ed-style').value = s.style; q('ed-grass').value = s.grass ?? 6; q('ed-gravel').value = s.gravel ?? 9;
  }

  resize() {
    const r = this.canvas.getBoundingClientRect(), d = Math.min(devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(10, r.width * d); this.canvas.height = Math.max(10, r.height * d);
    this.dpr = d; this.draw();
  }

  fit() {
    const p = this.spec.points;
    if (!p.length) { this.view = { cx: 0, cy: 0, zoom: 0.3 }; return; }
    let a = 1e9, b = -1e9, c = 1e9, d = -1e9;
    p.forEach(([x, y]) => { a = Math.min(a, x); b = Math.max(b, x); c = Math.min(c, y); d = Math.max(d, y); });
    const w = this.canvas.width / this.dpr, h = this.canvas.height / this.dpr;
    this.view = { cx: (a + b) / 2, cy: (c + d) / 2, zoom: Math.min(w / (b - a + 500), h / (d - c + 500)) };
  }

  update() {
    const q = this.q('ed-stat');
    this.track = null; this.valid = null;
    if (this.spec.points.length >= 6) {
      try {
        this.track = buildTrack(this.spec);
        this.valid = validateTrack(this.track);
        q.className = 'ed-stat ' + (this.valid.ok ? 'good' : 'bad');
        q.innerHTML = this.valid.ok
          ? `<b>${(this.track.length / 1000).toFixed(2)} km</b> · tightest corner ${this.valid.minR.toFixed(0)} m · ${this.spec.points.length} points`
          : `<b>${this.valid.reason}</b>`;
      } catch (e) { this.track = null; q.className = 'ed-stat bad'; q.textContent = 'Invalid layout'; this.valid = { ok: false, reason: 'Invalid layout' }; }
    } else {
      q.className = 'ed-stat'; q.textContent = `Add ${6 - this.spec.points.length} more point(s) to form a circuit`;
      this.valid = { ok: false, reason: 'Needs at least 6 points' };
    }
    this.draw();
  }

  toScreen(x, y) { const w = this.canvas.width / this.dpr, h = this.canvas.height / this.dpr; return [(x - this.view.cx) * this.view.zoom + w / 2, (this.view.cy - y) * this.view.zoom + h / 2]; }
  toWorld(sx, sy) { const w = this.canvas.width / this.dpr, h = this.canvas.height / this.dpr; return [(sx - w / 2) / this.view.zoom + this.view.cx, this.view.cy - (sy - h / 2) / this.view.zoom]; }

  pick(sx, sy) {
    let best = -1, bd = 14;
    this.spec.points.forEach(([x, y], i) => { const [px, py] = this.toScreen(x, y); const d = Math.hypot(px - sx, py - sy); if (d < bd) { bd = d; best = i; } });
    return best;
  }

  insertIndex(wx, wy) {
    const p = this.spec.points; if (p.length < 3) return p.length;
    let best = 0, bd = Infinity;
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i + 1) % p.length];
      const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((wx - a[0]) * dx + (wy - a[1]) * dy) / l2));
      const d = Math.hypot(wx - (a[0] + dx * t), wy - (a[1] + dy * t));
      if (d < bd) { bd = d; best = i; }
    }
    return best + 1;
  }

  bindCanvas() {
    const c = this.canvas;
    const pos = (e) => { const r = c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('mousedown', (e) => {
      const [sx, sy] = pos(e);
      const i = this.pick(sx, sy);
      if (e.button === 2) { if (i >= 0) { this.spec.points.splice(i, 1); this.update(); } return; }
      if (i >= 0) { this.drag = { type: 'pt', i }; this.sel = i; return; }
      this.drag = { type: 'pan', sx, sy, cx: this.view.cx, cy: this.view.cy, moved: false };
    });
    addEventListener('mousemove', (e) => {
      if (!this.root.offsetParent) return;
      const [sx, sy] = pos(e);
      if (!this.drag) { const h = this.pick(sx, sy); if (h !== this.hover) { this.hover = h; this.draw(); } return; }
      if (this.drag.type === 'pt') {
        const [wx, wy] = this.toWorld(sx, sy);
        this.spec.points[this.drag.i] = [Math.round(wx), Math.round(wy)];
        if (!this._raf) this._raf = requestAnimationFrame(() => { this._raf = 0; this.update(); });
      } else {
        const dx = sx - this.drag.sx, dy = sy - this.drag.sy;
        if (Math.hypot(dx, dy) > 4) this.drag.moved = true;
        this.view.cx = this.drag.cx - dx / this.view.zoom; this.view.cy = this.drag.cy + dy / this.view.zoom;
        this.draw();
      }
    });
    addEventListener('mouseup', (e) => {
      if (!this.drag) return;
      const d = this.drag; this.drag = null;
      if (d.type === 'pan' && !d.moved) {
        const [sx, sy] = pos(e); const [wx, wy] = this.toWorld(sx, sy);
        const idx = this.insertIndex(wx, wy);
        this.spec.points.splice(idx, 0, [Math.round(wx), Math.round(wy)]);
        this.sel = idx; this.update();
      }
    });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const [sx, sy] = pos(e); const [wx, wy] = this.toWorld(sx, sy);
      const f = Math.exp(-e.deltaY * 0.0012);
      this.view.zoom = Math.max(0.03, Math.min(4, this.view.zoom * f));
      const [nx, ny] = this.toWorld(sx, sy);
      this.view.cx += wx - nx; this.view.cy += wy - ny;
      this.draw();
    }, { passive: false });
    addEventListener('keydown', (e) => {
      if (!this.root.offsetParent || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && this.sel >= 0) { this.spec.points.splice(this.sel, 1); this.sel = -1; this.update(); }
    });
  }

  draw() {
    const g = this.ctx, d = this.dpr || 1;
    const w = this.canvas.width / d, h = this.canvas.height / d;
    g.setTransform(d, 0, 0, d, 0, 0);
    g.fillStyle = '#10151c'; g.fillRect(0, 0, w, h);
    // grid
    const step = this.view.zoom > 0.25 ? 100 : this.view.zoom > 0.08 ? 500 : 1000;
    g.lineWidth = 1;
    const [x0, y1] = this.toWorld(0, 0), [x1, y0] = this.toWorld(w, h);
    g.strokeStyle = 'rgba(255,255,255,0.05)';
    for (let x = Math.floor(x0 / step) * step; x <= x1; x += step) { const [sx] = this.toScreen(x, 0); g.beginPath(); g.moveTo(sx, 0); g.lineTo(sx, h); g.stroke(); }
    for (let y = Math.floor(y0 / step) * step; y <= y1; y += step) { const [, sy] = this.toScreen(0, y); g.beginPath(); g.moveTo(0, sy); g.lineTo(w, sy); g.stroke(); }
    g.fillStyle = 'rgba(255,255,255,0.35)'; g.font = '11px Barlow, sans-serif';
    g.fillText(`grid ${step} m`, 12, h - 12);

    const T = this.track;
    if (T) {
      const z = this.view.zoom;
      const line = (w2, col, minPx = 1) => {
        g.lineWidth = Math.max(minPx, w2 * z); g.strokeStyle = col; g.lineJoin = 'round'; g.lineCap = 'round';
        g.beginPath();
        for (let i = 0; i <= T.n; i += 2) { const k = i % T.n; const [sx, sy] = this.toScreen(T.x[k], T.y[k]); i ? g.lineTo(sx, sy) : g.moveTo(sx, sy); }
        g.closePath(); g.stroke();
      };
      if (!T.street) line(T.hw[0] * 2 + 2 * (T.grassW + T.gravelW), 'rgba(184,165,120,0.28)');
      if (!T.street) line(T.hw[0] * 2 + 2 * T.grassW, 'rgba(61,107,42,0.45)');
      line(T.hw[0] * 2 + 2.4, this.valid && this.valid.ok ? '#d8dbe2' : '#ff5d5d', 8);
      line(T.hw[0] * 2, '#3b3c40', 5);
      g.setLineDash([8, 10]); line(0.6, 'rgba(255,255,255,0.35)'); g.setLineDash([]);
      // kerbs
      g.fillStyle = '#e63232';
      for (let i = 0; i < T.n; i += 6) {
        for (const [bit, s] of [[1, 1], [2, -1]]) {
          if (!(T.kerb[i] & bit)) continue;
          const [sx, sy] = this.toScreen(T.x[i] + T.nx[i] * s * (T.hw[i] + 0.4), T.y[i] + T.ny[i] * s * (T.hw[i] + 0.4));
          g.fillRect(sx - 1.5, sy - 1.5, 3, 3);
        }
      }
      // start line + direction arrows
      const [sx, sy] = this.toScreen(T.x[0], T.y[0]);
      const ang = -T.th[0];
      g.save(); g.translate(sx, sy); g.rotate(ang);
      g.fillStyle = '#fff'; g.fillRect(-3, -T.hw[0] * z, 6, T.hw[0] * 2 * z);
      g.fillStyle = '#e10600'; g.font = 'bold 12px Barlow, sans-serif'; g.fillText('START', 8, -T.hw[0] * z - 4);
      g.restore();
      g.fillStyle = 'rgba(255,255,255,0.8)';
      for (let i = 40; i < T.n; i += 90) {
        const [ax, ay] = this.toScreen(T.x[i], T.y[i]);
        g.save(); g.translate(ax, ay); g.rotate(-T.th[i]);
        g.beginPath(); g.moveTo(7, 0); g.lineTo(-5, -5); g.lineTo(-5, 5); g.closePath(); g.fill(); g.restore();
      }
    } else if (this.spec.points.length > 1) {
      g.strokeStyle = 'rgba(255,255,255,0.35)'; g.setLineDash([6, 6]); g.beginPath();
      this.spec.points.forEach(([x, y], i) => { const [sx, sy] = this.toScreen(x, y); i ? g.lineTo(sx, sy) : g.moveTo(sx, sy); });
      g.stroke(); g.setLineDash([]);
    }
    // control points
    this.spec.points.forEach(([x, y], i) => {
      const [sx, sy] = this.toScreen(x, y);
      g.beginPath(); g.arc(sx, sy, i === this.hover || i === this.sel ? 8 : 6, 0, 6.3);
      g.fillStyle = i === this.sel ? '#e10600' : '#ffffff'; g.fill();
      g.lineWidth = 2; g.strokeStyle = '#000'; g.stroke();
    });
  }
}
