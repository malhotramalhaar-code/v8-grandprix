// AI driver: follows the track's minimum-curvature racing line at a speed profile derived from
// the same grip/aero/power numbers the physics uses. Produces ordinary driver inputs.
import { CAR, G, wingCl, wingCd, placeCar, tyreGrip } from './physics.js';

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const wrapPi = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };

export function buildSpeedProfile(track, skill = 1, wing = 0.5) {
  const rl = track.racingLine();
  const n = track.n;
  const m = CAR.massDry + 30;
  const kA = 0.5 * 1.2 * wingCl(wing);
  const cdA = wingCd(wing);
  // Lateral grip measured from the car model: ay_max[g] ~ 1.69 + 0.00037 v^2, scaled by skill and a safety margin.
  const f = 0.93 * skill;
  const A = G * f * 1.69, B = G * f * 0.00037;
  const vTop = 91 * (0.97 + 0.03 * skill);
  const v2 = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const k = Math.max(Math.abs(rl.k[i]), 0.75 * Math.abs(track.curv[i]));
    let v = k > B + 1e-6 ? Math.sqrt(A / (k - B)) : Infinity;
    v = Math.min(v, vTop);
    v2[i] = v * v;
  }
  const accel = (v) => Math.max(0.3, Math.min(9.5, 520e3 / (m * Math.max(v, 12)) - (0.5 * 1.2 * cdA * v * v) / m));
  const brake = (v) => Math.min(1.25 * skill * (G + (kA * v * v) / m), 36) + (0.5 * 1.2 * cdA * v * v) / m * 0.6;
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < n; i++) {   // forward: acceleration limit
      const j = (i + 1) % n;
      const v = Math.sqrt(v2[i]);
      const lim = v2[i] + 2 * accel(v) * rl.seg[i];
      if (v2[j] > lim) v2[j] = lim;
    }
    for (let i = n - 1; i >= -n; i--) { // backward: braking limit (wraps)
      const a = ((i % n) + n) % n, b = (a + 1) % n;
      const v = Math.sqrt(v2[b]);
      const lim = v2[b] + 2 * brake(v) * rl.seg[a];
      if (v2[a] > lim) v2[a] = lim;
    }
  }
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sqrt(v2[i]);
  return out;
}

export class AIDriver {
  constructor(track, skill = 0.9, seed = 1) {
    this.track = track;
    this.skill = skill;
    this.prof = buildSpeedProfile(track, skill);
    this.rl = track.racingLine();
    this.off = 0;           // lateral offset from racing line
    this.passT = 0; this.passDir = 0;
    this.offTarget = 0;
    this.stuck = 0;
    this.noise = 0.97 + ((seed * 9301 + 49297) % 233280) / 233280 * 0.06;
    this.inp = { steer: 0, throttle: 0, brake: 0, auto: true, abs: 1, tc: 1, steerAssist: 0.8, shift: 0, boost: false, drs: false };
    this.idx = -1;
  }

  update(c, dt, others) {
    const tr = this.track, rl = this.rl, n = tr.n, ds = tr.ds;
    const loc = tr.locate(c.x, c.y, this.idx >= 0 ? this.idx : c.idx >= 0 ? c.idx : 0);
    const i = loc.i;
    this.idx = i;
    const v = Math.max(c.u, 0);

    // --- traffic: find the nearest car ahead in (roughly) our lane
    let best = null, bestGap = 55;
    const cp = Math.cos(c.psi), sp = Math.sin(c.psi);
    for (const o of others) {
      const dx = o.x - c.x, dy = o.y - c.y;
      const fwd = dx * cp + dy * sp;
      if (fwd < 1 || fwd > bestGap) continue;
      const lat = -dx * sp + dy * cp;
      if (Math.abs(lat) > 2.3) continue;
      best = { fwd, lat, u: o.u, gap: fwd - CAR.length };
      bestGap = fwd;
    }
    // lateral offset from the racing line: start in the grid lane, then ease onto the line
    if (this.startOff === undefined) {
      this.startOff = loc.d - this.rl.off[i];
      this.startOff = clamp(this.startOff, -tr.hw[i] + 2.5, tr.hw[i] - 2.5);
      this.off = this.startOff;
    }
    this.startOff -= Math.sign(this.startOff) * Math.min(Math.abs(this.startOff), dt * 0.45);
    this.passT = Math.max(0, this.passT - dt);
    if (this.passT <= 0 && best && best.gap < 14 && c.speed > 30 && this.started !== false) {
      // commit to a side for a couple of seconds: the one with more room and no car alongside
      let side = best.lat > 0 ? -1 : 1;
      const room = tr.hw[i] - 2.4;
      const blocked = (sd) => others.some((o) => {
        const dx = o.x - c.x, dy = o.y - c.y;
        const f = dx * cp + dy * sp, l = (-dx * sp + dy * cp) * sd;
        return Math.abs(f) < 9 && l > 1.2 && l < 5.5;
      });
      if (blocked(side) || Math.abs(this.startOff + side * 3) > room + 0.5) side = -side;
      if (!blocked(side)) { this.passDir = side; this.passT = 2.4; }
    }
    this.offTarget = this.passT > 0 ? clamp(this.startOff + this.passDir * 3.0, -(tr.hw[i] - 2.4), tr.hw[i] - 2.4) : this.startOff;
    this.off += (this.offTarget - this.off) * Math.min(1, dt * 1.4);

    // --- steering: pure pursuit on the racing line
    const Ld = clamp(6 + 0.2 * v + 0.55 * Math.max(0, v - 30), 7, 62);
    const k = Math.max(1, Math.round(Ld / ds));
    const j = (i + k) % n;
    const tx = rl.x[j] + tr.nx[j] * this.off, ty = rl.y[j] + tr.ny[j] * this.off;
    const beta = Math.atan2(c.v, Math.max(c.u, 3));
    const eta = wrapPi(Math.atan2(ty - c.y, tx - c.x) - (c.psi + beta * 0.8));
    const dist = Math.hypot(tx - c.x, ty - c.y);
    const delta = Math.atan2(2 * CAR.L * Math.sin(eta), Math.max(dist, 4));
    const lim = CAR.maxSteer / (1 + (c.speed / CAR.steerV0) ** 2);
    this.inp.steer = clamp(delta / lim, -1, 1);

    // --- speed
    const look = Math.max(2, Math.ceil((v * 0.2) / ds));
    let vt = Infinity;
    for (let q = 0; q <= look; q++) vt = Math.min(vt, this.prof[(i + q) % n]);
    vt *= this.noise;
    if (vt < 84) {
      vt *= Math.pow(Math.min(1.0, tyreGrip(c) / 0.97), 0.85);
      const tAvg = (c.tyreT[0] + c.tyreT[1] + c.tyreT[2] + c.tyreT[3]) / 4;
      const opt = { soft: 82, medium: 88, hard: 94 }[c.compound] || 88;
      vt *= 1 - clamp((tAvg - opt - 12) / 70, 0, 0.18);   // lift off when the tyres cook, like a driver would
    }
    // keep clear of the car in front
    if (best) {
      const want = 3 + v * 0.16;
      if (best.gap < want * 2.2) vt = Math.min(vt, Math.max(4, best.u + (best.gap - want) * 1.2));
    }
    // off-track: slow down and rejoin
    if (Math.abs(loc.d) > tr.hw[i] + 1) vt = Math.min(vt, 30);

    const e = vt - v;
    if (e < -1.5) { this.inp.throttle = 0; this.inp.brake = clamp((-e - 1.5) / 7, 0, 1); }
    else {
      this.inp.brake = 0; this.inp.throttle = clamp(0.35 + e / 4, 0, 1);
      // at moderate speed the engine alone nearly saturates the rear tyres: lift while steering
      if (v < 100) this.inp.throttle *= 1 - 0.55 * clamp((Math.abs(this.inp.steer) - 0.15) * 1.4, 0, 1);
    }

    this.inp.boost = c.kers > 0.35 && this.inp.throttle > 0.95 && Math.abs(this.inp.steer) < 0.15;

    // --- recovery
    if (c.speed < 1.5 && !c.hold) this.stuck += dt; else this.stuck = Math.max(0, this.stuck - dt);
    if (Math.abs(loc.d) > tr.hw[i] + 2 && c.speed < 22) this.offT = (this.offT || 0) + dt; else this.offT = 0;
    if (this.stuck > 3 || this.offT > 3 || Math.abs(loc.d) > tr.wall[i] - 0.5) {
      this.offT = 0;
      this.stuck = 0;
      const p = tr.pointAt(i + 2, this.rl.off[i]);
      placeCar(c, p.x, p.y, p.psi, 15);
      c.gear = 2;
    }
    return this.inp;
  }
}
