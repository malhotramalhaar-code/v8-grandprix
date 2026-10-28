// Track geometry: closed centripetal Catmull-Rom spline, resampled at constant arc-length spacing.
// Pure module (no DOM). Spec: { name, points: [[x,y],...] (metres), width, style: 'circuit'|'street', grass, gravel }

const TAU = Math.PI * 2;
const DS_TARGET = 3.0;
const wrapPi = (a) => { while (a > Math.PI) a -= TAU; while (a < -Math.PI) a += TAU; return a; };

function crPoint(p0, p1, p2, p3, t) {
  // centripetal Catmull-Rom (Barry-Goldman), alpha = 0.5
  const d01 = Math.max(Math.hypot(p1[0] - p0[0], p1[1] - p0[1]), 1e-3) ** 0.5;
  const d12 = Math.max(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]), 1e-3) ** 0.5;
  const d23 = Math.max(Math.hypot(p3[0] - p2[0], p3[1] - p2[1]), 1e-3) ** 0.5;
  const t0 = 0, t1 = d01, t2 = d01 + d12, t3 = d01 + d12 + d23;
  const tt = t1 + (t2 - t1) * t;
  const lerp = (a, b, ta, tb) => [a[0] + (b[0] - a[0]) * ((tt - ta) / (tb - ta)), a[1] + (b[1] - a[1]) * ((tt - ta) / (tb - ta))];
  const A1 = lerp(p0, p1, t0, t1), A2 = lerp(p1, p2, t1, t2), A3 = lerp(p2, p3, t2, t3);
  const B1 = lerp(A1, A2, t0, t2), B2 = lerp(A2, A3, t1, t3);
  return lerp(B1, B2, t1, t2);
}

export function buildTrack(spec) {
  const pts = spec.points;
  const np = pts.length;
  const widthAt = (k) => (Array.isArray(spec.widths) ? spec.widths[k % np] : spec.width ?? 14);

  // dense polyline
  const dx = [], dy = [], dw = [];
  for (let k = 0; k < np; k++) {
    const p0 = pts[(k - 1 + np) % np], p1 = pts[k], p2 = pts[(k + 1) % np], p3 = pts[(k + 2) % np];
    const steps = Math.max(8, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / 4));
    const w1 = widthAt(k), w2 = widthAt(k + 1);
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      const q = crPoint(p0, p1, p2, p3, t);
      dx.push(q[0]); dy.push(q[1]);
      const e = t * t * (3 - 2 * t);
      dw.push(w1 + (w2 - w1) * e);
    }
  }
  const nd = dx.length;
  const cum = new Float64Array(nd + 1);
  for (let i = 0; i < nd; i++) {
    const j = (i + 1) % nd;
    cum[i + 1] = cum[i] + Math.hypot(dx[j] - dx[i], dy[j] - dy[i]);
  }
  const length0 = cum[nd];
  const n = Math.max(24, Math.round(length0 / DS_TARGET));
  const ds = length0 / n;

  let x = new Float64Array(n), y = new Float64Array(n), hw = new Float64Array(n);
  {
    let seg = 0;
    for (let i = 0; i < n; i++) {
      const s = i * ds;
      while (seg < nd - 1 && cum[seg + 1] < s) seg++;
      const j = (seg + 1) % nd;
      const l = cum[seg + 1] - cum[seg] || 1e-9;
      const t = (s - cum[seg]) / l;
      x[i] = dx[seg] + (dx[j] - dx[seg]) * t;
      y[i] = dy[seg] + (dy[j] - dy[seg]) * t;
      hw[i] = (dw[seg] + (dw[j] - dw[seg]) * t) * 0.5;
    }
  }

  // headings & curvature
  const heading = (xs, ys, i) => {
    const a = (i - 1 + n) % n, b = (i + 1) % n;
    return Math.atan2(ys[b] - ys[a], xs[b] - xs[a]);
  };
  const buildDerived = () => {
    const th = new Float64Array(n);
    for (let i = 0; i < n; i++) th[i] = heading(x, y, i);
    const curv = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const a = (i - 1 + n) % n, b = (i + 1) % n;
      curv[i] = wrapPi(th[b] - th[a]) / (2 * ds);
    }
    const sm = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let acc = 0;
      for (let k = -2; k <= 2; k++) acc += curv[(i + k + n) % n];
      sm[i] = acc / 5;
    }
    return { th, curv: sm };
  };
  let { th, curv } = buildDerived();

  // choose the start/finish: centre of the straightest stretch with room for a grid behind it
  let i0 = 0;
  if (spec.start != null) {
    i0 = Math.floor(spec.start * n) % n;
  } else {
    const back = Math.round(150 / ds), fwd = Math.round(60 / ds);
    let bestCost = Infinity;
    const ac = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) ac[i + 1] = ac[i] + Math.abs(curv[i]);
    const sumRange = (a, b) => { // inclusive a..b on circular array, b-a < n
      let s = 0; for (let k = a; k <= b; k++) s += Math.abs(curv[((k % n) + n) % n]); return s;
    };
    for (let i = 0; i < n; i += 2) {
      const cost = sumRange(i - back, i + fwd);
      if (cost < bestCost) { bestCost = cost; i0 = i; }
    }
  }
  const rot = (arr) => { const o = new Float64Array(n); for (let i = 0; i < n; i++) o[i] = arr[(i + i0) % n]; return o; };
  x = rot(x); y = rot(y); hw = rot(hw);
  ({ th, curv } = buildDerived());

  const tx = new Float64Array(n), ty = new Float64Array(n), nx = new Float64Array(n), ny = new Float64Array(n);
  for (let i = 0; i < n; i++) { tx[i] = Math.cos(th[i]); ty[i] = Math.sin(th[i]); nx[i] = -ty[i]; ny[i] = tx[i]; }

  const street = spec.style === 'street';
  const grassW = street ? 0 : spec.grass ?? 6;
  const gravelW = street ? 0 : spec.gravel ?? 9;
  const wall = new Float64Array(n);
  for (let i = 0; i < n; i++) wall[i] = hw[i] + (street ? 1.4 : grassW + gravelW);

  // kerbs: bit 1 = left side, bit 2 = right side
  const kerb = new Uint8Array(n);
  {
    const inner = 0.0042, outer = 0.0115;
    for (let i = 0; i < n; i++) {
      const c = curv[i];
      if (c > inner) kerb[i] |= 1; else if (c < -inner) kerb[i] |= 2;
      if (c > outer) kerb[i] |= 2; else if (c < -outer) kerb[i] |= 1;
    }
    for (const bit of [1, 2]) {
      // drop short runs, pad the rest
      const flag = new Uint8Array(n);
      for (let i = 0; i < n; i++) flag[i] = kerb[i] & bit ? 1 : 0;
      const out = new Uint8Array(n);
      let i = 0;
      while (i < n) {
        if (!flag[i]) { i++; continue; }
        let j = i; while (j < n && flag[j]) j++;
        if (j - i >= 5) for (let k = i - 3; k < j + 3; k++) out[(k + n) % n] = 1;
        i = j;
      }
      for (let k = 0; k < n; k++) kerb[k] = (kerb[k] & ~bit) | (out[k] ? bit : 0);
    }
  }

  let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
  for (let i = 0; i < n; i++) { minx = Math.min(minx, x[i]); maxx = Math.max(maxx, x[i]); miny = Math.min(miny, y[i]); maxy = Math.max(maxy, y[i]); }

  const loc = { i: 0, fi: 0, d: 0, dist: 0 };
  const track = {
    name: spec.name || 'Custom', spec, n, ds, length: n * ds, x, y, tx, ty, nx, ny, th, curv, hw, wall, kerb,
    street, grassW, gravelW, kerbW: 1.3, bounds: { minx, maxx, miny, maxy },

    // nearest sample search near a hint index; returns a shared scratch object
    locate(px, py, hint) {
      let c = hint;
      if (c < 0 || c >= n) c = this._brute(px, py);
      for (let pass = 0; pass < 60; pass++) {
        let best = c, bd = Infinity, bk = 0;
        for (let k = -12; k <= 12; k++) {
          const i = (c + k + n * 4) % n;
          const ex = px - x[i], ey = py - y[i];
          const d2 = ex * ex + ey * ey;
          if (d2 < bd) { bd = d2; best = i; bk = k; }
        }
        c = best;
        if (Math.abs(bk) < 12) break;
      }
      if (Math.hypot(px - x[c], py - y[c]) > 90) c = this._brute(px, py);
      const ex = px - x[c], ey = py - y[c];
      const along = ex * tx[c] + ey * ty[c];
      loc.i = c;
      loc.fi = c + Math.max(-1, Math.min(1, along / ds));
      loc.d = ex * nx[c] + ey * ny[c];
      loc.dist = Math.hypot(ex, ey);
      return loc;
    },
    _brute(px, py) {
      let best = 0, bd = Infinity;
      for (let i = 0; i < n; i++) { const ex = px - x[i], ey = py - y[i]; const d2 = ex * ex + ey * ey; if (d2 < bd) { bd = d2; best = i; } }
      return best;
    },
    surface(i, d) {
      const ad = Math.abs(d), h = hw[i];
      if (ad <= h) return 'asphalt';
      if (kerb[i] & (d > 0 ? 1 : 2) && ad <= h + this.kerbW) return 'kerb';
      if (street) return 'asphalt';
      if (ad <= h + grassW) return 'grass';
      return 'gravel';
    },
    pointAt(fi, lat = 0) {
      let f = fi % n; if (f < 0) f += n;
      const i = Math.floor(f), j = (i + 1) % n, t = f - i;
      const px = x[i] + (x[j] - x[i]) * t, py = y[i] + (y[j] - y[i]) * t;
      const ax = nx[i] + (nx[j] - nx[i]) * t, ay = ny[i] + (ny[j] - ny[i]) * t;
      const l = Math.hypot(ax, ay) || 1;
      const psi = Math.atan2(ty[i] + (ty[j] - ty[i]) * t, tx[i] + (tx[j] - tx[i]) * t);
      return { x: px + (ax / l) * lat, y: py + (ay / l) * lat, psi, i };
    },
    // k-th grid slot, k = 0 is pole position
    gridSlot(k) {
      const sBack = 8 + 8.5 * k;
      const fi = -sBack / ds;
      const side = k % 2 === 0 ? 1 : -1;
      const lat = side * Math.min(3.0, hw[0] * 0.38);
      const p = this.pointAt(fi, lat);
      p.idx = ((Math.round(fi) % n) + n) % n;
      p.fi = fi;
      return p;
    },
    // minimum-curvature racing line (lazy)
    racingLine() {
      if (this._rl) return this._rl;
      const margin = 2.8;
      const off = new Float64Array(n);
      const rx = new Float64Array(n), ry = new Float64Array(n);
      for (let i = 0; i < n; i++) { rx[i] = x[i]; ry[i] = y[i]; }
      for (let it = 0; it < 900; it++) {
        for (let i = 0; i < n; i++) {
          const a = (i - 1 + n) % n, b = (i + 1) % n;
          const mx = (rx[a] + rx[b]) * 0.5, my = (ry[a] + ry[b]) * 0.5;
          const want = (mx - x[i]) * nx[i] + (my - y[i]) * ny[i];
          const lim = Math.max(0.5, hw[i] - margin);
          let o = off[i] + (want - off[i]) * 0.6;
          o = Math.max(-lim, Math.min(lim, o));
          off[i] = o; rx[i] = x[i] + nx[i] * o; ry[i] = y[i] + ny[i] * o;
        }
      }
      // smooth a little for a clean pursuit target
      for (let it = 0; it < 6; it++) for (let i = 0; i < n; i++) {
        const a = (i - 1 + n) % n, b = (i + 1) % n;
        off[i] = (off[a] + 2 * off[i] + off[b]) * 0.25;
      }
      for (let i = 0; i < n; i++) { rx[i] = x[i] + nx[i] * off[i]; ry[i] = y[i] + ny[i] * off[i]; }
      const seg = new Float64Array(n), k = new Float64Array(n);
      for (let i = 0; i < n; i++) { const b = (i + 1) % n; seg[i] = Math.hypot(rx[b] - rx[i], ry[b] - ry[i]); }
      for (let i = 0; i < n; i++) {
        const a = (i - 2 + n) % n, b = (i + 2) % n;
        const ax = rx[i] - rx[a], ay = ry[i] - ry[a], bx = rx[b] - rx[i], by = ry[b] - ry[i];
        const cross = ax * by - ay * bx;
        const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by), lc = Math.hypot(rx[b] - rx[a], ry[b] - ry[a]);
        k[i] = (2 * cross) / Math.max(1e-6, la * lb * lc);
      }
      this._rl = { off, x: rx, y: ry, seg, k };
      return this._rl;
    },
  };
  return track;
}

// Checks the layout is drivable: no self-overlap and no impossibly tight corners.
export function validateTrack(track) {
  const { n, x, y, hw, curv, ds } = track;
  let minR = Infinity;
  for (let i = 0; i < n; i++) { const c = Math.abs(curv[i]); if (c > 1e-6) minR = Math.min(minR, 1 / c); }
  const skip = Math.round(60 / ds);
  let minSep = Infinity;
  for (let i = 0; i < n; i += 2) {
    for (let j = i + skip; j < n; j += 2) {
      if (n - (j - i) < skip) continue;
      const d = Math.hypot(x[i] - x[j], y[i] - y[j]) - (hw[i] + hw[j]) - 2 * (track.street ? 1.4 : 6);
      if (d < minSep) minSep = d;
    }
  }
  if (minR < 13) return { ok: false, reason: `Corner too tight (radius ${minR.toFixed(0)} m)`, minR, minSep };
  if (minSep < 2) return { ok: false, reason: 'Track overlaps or runs too close to itself', minR, minSep };
  if (track.length < 800) return { ok: false, reason: 'Track too short', minR, minSep };
  if (track.length > 12000) return { ok: false, reason: 'Track too long', minR, minSep };
  return { ok: true, minR, minSep };
}
