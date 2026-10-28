// Planar vehicle dynamics for a 2006-2013 era F1 car: 2.4 L V8, 18 000 rpm, 7-speed seamless box.
// Pure module (no DOM) so it runs in the browser and in headless tests.
//
// Frame: X east, Y north, yaw psi counter-clockwise from +X. Body frame: u forward, v left, r yaw rate.
// Four wheels, each with its own spin state, load, slip and a combined-slip tyre model.

export const G = 9.81;
const RHO = 1.2;
const RPM2RAD = Math.PI / 30;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

export const CAR = {
  massDry: 620,          // kg incl. driver
  wf: 0.46,              // static front weight fraction
  L: 3.1, hcg: 0.28, tf: 1.45, tr: 1.40, Iz: 1100,
  rWheel: 0.335, Iw: 1.3, Ieng: 0.045, eff: 0.93,
  gears: [19.0, 14.6, 11.8, 9.9, 8.5, 7.5, 6.75], reverse: 16,
  maxRpm: 18000, idleRpm: 4500, upshiftRpm: 17350,
  engineMap: [[0, 0], [3000, 120], [5000, 190], [7000, 225], [9000, 255], [11000, 285],
    [13000, 305], [15000, 318], [16500, 320], [17500, 312], [18000, 300], [19000, 260]],
  rsf: 0.50,             // share of lateral load transfer taken by the front axle
  cdLat: 3.0,
  maxSteer: 0.34, steerV0: 38, steerRate: 2.6,
  brakeTorque: 10800,
  relax: 0.35,           // tyre relaxation length (m)
  rearGrip: 1.12,        // wider rear slicks (380 mm vs 305 mm)
  length: 5.2, width: 1.9,
};
CAR.b = CAR.wf * CAR.L;          // CG to rear axle
CAR.a = CAR.L - CAR.b;           // CG to front axle

// tyre
const MU0 = 1.72, LS = 0.08, FZ0 = 1600;
const KP = 0.11, AP = 0.13;       // slip ratio / slip tangent at peak grip
const MF_C = 1.33, MF_B = Math.tan(Math.PI / (2 * MF_C));
const WEAR_J = 16e6;
const TYRE_CTH = 3600;            // thermal mass (J per degC, scaled)
const KERS_KW = 60e3, KERS_J = 400e3;              // sliding energy (J) that fully wears a medium tyre

export const SURFACES = {
  asphalt: { grip: 1.0, roll: 0.012 },
  kerb: { grip: 0.93, roll: 0.02 },
  grass: { grip: 0.55, roll: 0.07 },
  gravel: { grip: 0.42, roll: 0.30 },
};
export const COMPOUNDS = {
  soft: { name: 'Soft', grip: 1.05, wear: 1.7, color: '#ff3b3b', opt: 82 },
  medium: { name: 'Medium', grip: 1.0, wear: 1.0, color: '#ffd33b', opt: 88 },
  hard: { name: 'Hard', grip: 0.955, wear: 0.6, color: '#f2f2f2', opt: 94 },
};

// current grip level of the tyres relative to a warm medium (used by the AI to stay realistic)
export function tyreGrip(c) {
  const comp = COMPOUNDS[c.compound] || COMPOUNDS.medium;
  let g = 0;
  for (let i = 0; i < 4; i++) { const tz = (c.tyreT[i] - comp.opt) / 40; g += clamp(1 - 0.085 * tz * tz, 0.76, 1) * (1 - 0.3 * c.wear[i] * c.wear[i]); }
  return (g / 4) * comp.grip;
}
export const wingCl = (w) => 3.0 + 1.6 * w;
export const wingCd = (w) => 0.82 + 0.40 * w;

function mf(s) { return Math.sin(MF_C * Math.atan(MF_B * s)); }

const _tf = { fx: 0, fy: 0, sig: 0 };
function tyre(kappa, sy, fz, gripMul) {
  const mu = clamp(MU0 * (1 - LS * (fz / FZ0 - 1)), 0.6 * MU0, 1.3 * MU0);
  const fmax = mu * fz * gripMul;
  const sx = kappa / KP, sa = sy / AP;
  const sig = Math.hypot(sx, sa);
  _tf.sig = sig;
  if (sig < 1e-6) { _tf.fx = 0; _tf.fy = 0; return _tf; }
  const f = (mf(sig) * fmax) / sig;
  _tf.fx = f * sx; _tf.fy = f * sa;
  return _tf;
}

export function engineTorque(rpm, thr, demand = thr) {
  const m = CAR.engineMap;
  let tmax = 0;
  if (rpm >= m[m.length - 1][0]) tmax = m[m.length - 1][1];
  else for (let i = 1; i < m.length; i++) {
    if (rpm <= m[i][0]) { const t = (rpm - m[i - 1][0]) / (m[i][0] - m[i - 1][0]); tmax = m[i - 1][1] + t * (m[i][1] - m[i - 1][1]); break; }
  }
  const lim = clamp((CAR.maxRpm + 250 - rpm) / 250, 0, 1);
  const eb = -(18 + 42 * (rpm / CAR.maxRpm));
  return eb * (1 - demand) + tmax * lim * thr;
}

export function createCar(setup = {}) {
  const c = {
    x: 0, y: 0, psi: 0, u: 0, v: 0, r: 0, ax: 0, ay: 0,
    steer: 0, gear: 1, rpm: CAR.idleRpm, shiftT: 0, shiftCool: 0, revT: 0, fwdT: 0,
    fuel: setup.fuel ?? 60, wing: setup.wing ?? 0.5, bias: setup.bias ?? 0.58,
    compound: setup.compound || 'medium', wearRate: setup.wearRate ?? 1, aeroBal: setup.aeroBal ?? 0.49,
    wear: [0, 0, 0, 0],
    wh: [0, 1, 2, 3].map(() => ({ w: 0, sy: 0, fz: 1500, fx: 0, fy: 0, kappa: 0, sig: 0, pw: 0, surf: 'asphalt' })),
    hold: true, thr: 0, brk: 0,
    dragMul: 1, dfMul: 1,
    speed: 0, gLat: 0, gLong: 0, downforce: 0, squeal: 0, lock: 0, onSurf: 'asphalt', rumble: 0,
    idx: -1, damage: 0, kers: 1, boosting: false, drs: false, tyreT: [62, 62, 62, 62],
  };
  return c;
}

export function placeCar(c, x, y, psi, speed = 0) {
  c.x = x; c.y = y; c.psi = psi; c.u = speed; c.v = 0; c.r = 0; c.ax = 0; c.ay = 0; c.steer = 0;
  for (const w of c.wh) { w.w = speed / CAR.rWheel; w.sy = 0; w.kappa = 0; w.sig = 0; w.pw = 0; }
  if (speed > 1) c.gear = Math.min(7, Math.max(1, Math.round(speed / 13)));
  else c.gear = 1;
  c.shiftT = 0;
}

export function carMass(c) { return CAR.massDry + c.fuel; }

// env.surface(c, wheelIndex, wx, wy) -> key of SURFACES
// inp: { steer -1..1 (left +), throttle 0..1, brake 0..1, auto, shift (+1/-1/0), abs, tc, steerAssist }
export function stepCar(c, inp, env, dt) {
  const P = CAR, W = c.wh;
  const m = P.massDry + c.fuel;

  if (c.hold) {
    c.u = c.v = c.r = 0;
    for (const w of W) { w.w = 0; w.sy = 0; w.kappa = 0; w.sig = 0; w.fx = 0; w.fy = 0; }
    const tgt = P.idleRpm + inp.throttle * 9000;
    c.rpm += (tgt - c.rpm) * (1 - Math.exp(-dt * 12));
    c.speed = 0;
    return;
  }

  // ---- reverse / forward selection
  const stopped = Math.abs(c.u) < 1.2;
  if (c.gear > 0 && stopped && inp.brake > 0.4 && inp.throttle < 0.1) c.revT += dt; else c.revT = 0;
  if (c.gear < 0 && stopped && inp.throttle > 0.4 && inp.brake < 0.1) c.fwdT += dt; else c.fwdT = 0;
  if (c.revT > 0.4) { c.gear = -1; c.revT = 0; }
  if (c.fwdT > 0.3) { c.gear = 1; c.fwdT = 0; }
  const rev = c.gear < 0;
  const thrIn = clamp(rev ? inp.brake : inp.throttle, 0, 1);
  const brkIn = clamp(rev ? inp.throttle : inp.brake, 0, 1);

  c.drs = !!inp.drs && brkIn < 0.05 && thrIn > 0.6 && c.gear > 0 && Math.abs(c.steer) < 0.06;

  // ---- steering
  const vs = Math.hypot(c.u, c.v);
  const lim = P.maxSteer / (1 + (vs / P.steerV0) * (vs / P.steerV0));
  let target = inp.steer * lim;
  const assist = inp.steerAssist ?? 0;
  if (assist > 0) {
    const zero = Math.atan2(c.v + P.a * c.r, Math.max(Math.abs(c.u), 4));
    const l2 = AP * (1 + (1 - assist) * 2.5) + Math.max(0, 16 - Math.abs(c.u)) * 0.03;
    target = clamp(target, zero - l2, zero + l2);
  }
  const maxd = P.steerRate * dt;
  c.steer += clamp(target - c.steer, -maxd, maxd);

  // ---- gearbox
  c.shiftCool -= dt; c.shiftT -= dt;
  const ratioAbs = rev ? P.reverse : P.gears[c.gear - 1];
  const wRear = (W[2].w + W[3].w) * 0.5;
  const rpmW = Math.abs(wRear) * ratioAbs / RPM2RAD;
  if (!rev && c.shiftCool <= 0) {
    let want = 0;
    if (inp.auto) {
      if (c.gear < 7 && rpmW > P.upshiftRpm) want = 1;
      else if (c.gear > 1 && rpmW < (brkIn > 0.2 ? 11800 : 8600)) want = -1;
    } else if (inp.shift) {
      want = inp.shift;
      if (want > 0 && c.gear >= 7) want = 0;
      if (want < 0 && (c.gear <= 1 || rpmW * P.gears[c.gear - 2] / P.gears[c.gear - 1] > 18600)) want = 0;
    }
    if (want) { c.gear += want; c.shiftT = 0.03; c.shiftCool = 0.25; }
  }
  const ratio = rev ? -P.reverse : P.gears[c.gear - 1];

  // ---- engine / traction control
  let thr = thrIn;
  if (c.fuel <= 0) thr *= 0.4;
  const tc = inp.tc ?? 0;
  if (tc > 0 && thr > 0) {
    const k = Math.max(W[2].kappa, W[3].kappa, 0);
    const sg = Math.max(W[2].sig, W[3].sig);
    const cut = Math.max(clamp((k - 0.07) / 0.07, 0, 0.95), clamp((sg - 0.72) / 0.6, 0, 0.95));
    thr *= 1 - tc * cut;
  }
  const rpmEng = Math.max(rpmW, P.idleRpm + (thr > 0.05 ? 5000 * thr : 0));
  let Te = engineTorque(rpmEng, thr, thrIn);
  c.boosting = !!inp.boost && c.kers > 0.001 && thr > 0.5 && c.gear > 0 && c.shiftT <= 0 && W[2].sig < 0.9 && W[3].sig < 0.9;
  if (c.boosting) { Te += Math.min(70, KERS_KW / (rpmEng * RPM2RAD)) * thr; c.kers = Math.max(0, c.kers - (KERS_KW * dt) / KERS_J); }
  else c.kers = Math.min(1, c.kers + (0.012 + brkIn * (vs / 85) * 0.16) * dt);
  if (c.shiftT > 0) Te = 0;
  const Tw = Te * ratio * P.eff;
  const Tcap = 120 + 0.35 * Math.abs(Tw);
  const tb = clamp(40 * (W[2].w - W[3].w), -Tcap, Tcap);
  const Tdrive = [0, 0, Tw / 2 - tb, Tw / 2 + tb];
  const Ire = 0.5 * P.Ieng * ratioAbs * ratioAbs;
  c.thr = thr; c.brk = brkIn;
  c.fuel = Math.max(0, c.fuel - (0.0012 + 0.056 * thr * (rpmEng / P.maxRpm)) * dt);
  c.rpm += (rpmEng - c.rpm) * (1 - Math.exp(-dt * 40));

  // ---- aero + loads
  const u2 = c.u * c.u;
  const q = 0.5 * RHO;
  const dmg = c.damage;
  const clA = wingCl(c.wing) * c.dfMul * (c.drs ? 0.84 : 1) * (1 - 0.12 * dmg);
  const cdA = wingCd(c.wing) * c.dragMul * (c.drs ? 0.76 : 1) * (1 + 0.05 * dmg);
  const down = q * clA * u2;
  c.downforce = down;
  const bal = c.aeroBal - 0.12 * dmg;
  const dfF = down * bal, dfR = down - dfF;
  const dLong = (m * c.ax * P.hcg) / P.L;
  const fzF = m * G * P.wf + dfF - dLong;
  const fzR = m * G * (1 - P.wf) + dfR + dLong;
  const dWf = (P.rsf * m * c.ay * P.hcg) / P.tf;
  const dWr = ((1 - P.rsf) * m * c.ay * P.hcg) / P.tr;
  const fz = [fzF / 2 - dWf, fzF / 2 + dWf, fzR / 2 - dWr, fzR / 2 + dWr];

  // ---- wheels
  const comp = COMPOUNDS[c.compound] || COMPOUNDS.medium;
  const cp = Math.cos(c.psi), sp = Math.sin(c.psi);
  const bt = P.brakeTorque * brkIn;
  const absOn = (inp.abs ?? 0) > 0;
  let Fx = 0, Fy = 0, Mz = 0, squeal = 0, lock = 0, rumble = 0;
  for (let i = 0; i < 4; i++) {
    const w = W[i];
    const front = i < 2;
    const xw = front ? P.a : -P.b;
    const yw = (front ? P.tf : P.tr) * 0.5 * (i & 1 ? -1 : 1);
    const delta = front ? c.steer : 0;
    const sd = Math.sin(delta), cd = Math.cos(delta);
    const vxw = c.u - c.r * yw, vyw = c.v + c.r * xw;
    const vl = vxw * cd + vyw * sd;
    const vt = -vxw * sd + vyw * cd;
    const vd = Math.max(Math.abs(vl), 2.5);
    const kappa = (w.w * P.rWheel - vl) / vd;
    const rl = 1 - Math.exp((-vd * dt) / P.relax);
    w.sy += (-vt / vd - w.sy) * rl;
    w.kappa = kappa;

    const wx = c.x + xw * cp - yw * sp, wy = c.y + xw * sp + yw * cp;
    const sk = env.surface ? env.surface(c, i, wx, wy) : 'asphalt';
    w.surf = sk;
    const sf = SURFACES[sk] || SURFACES.asphalt;
    const wr = c.wear[i];
    const tz = (c.tyreT[i] - comp.opt) / 40;
    const gripMul = sf.grip * comp.grip * (1 - 0.3 * wr * wr) * (front ? 1 : P.rearGrip) * clamp(1 - 0.085 * tz * tz, 0.76, 1);
    w.fz = Math.max(60, fz[i]);

    let t = tyre(kappa, w.sy, w.fz, gripMul);
    const fx = t.fx, fy = t.fy; w.sig = t.sig;
    t = tyre(kappa + 0.02, w.sy, w.fz, gripMul);
    const K = Math.max(0, (t.fx - fx) / 0.02);
    const roll = sf.roll * w.fz * Math.tanh(vl * 1.5);
    w.fx = fx; w.fy = fy;

    const I = P.Iw + (i >= 2 ? Ire : 0);
    const denom = I + (dt * P.rWheel * P.rWheel * K) / vd;
    let w1 = w.w + (dt * (Tdrive[i] - P.rWheel * fx)) / denom;
    let tbrake = (front ? c.bias : 1 - c.bias) * 0.5 * bt;
    if (absOn && tbrake > 0 && kappa < -0.115) tbrake *= clamp(1 - (-kappa - 0.115) * 10, 0.15, 1);
    const db = (tbrake * dt) / I;
    if (Math.abs(w1) <= db) w1 = 0; else w1 -= Math.sign(w1) * db;
    w.w = w1;

    const fxw = fx - roll;
    const fxb = fxw * cd - fy * sd, fyb = fxw * sd + fy * cd;
    Fx += fxb; Fy += fyb; Mz += xw * fyb - yw * fxb;

    w.pw = Math.abs(fx * (w1 * P.rWheel - vl)) + Math.abs(fy * vt);
    const hot = 1 + Math.max(0, (c.tyreT[i] - comp.opt - 15) / 30) * 1.6;
    c.wear[i] = Math.min(1, wr + (w.pw * dt * comp.wear * c.wearRate * hot) / WEAR_J);
    const heat = Math.abs(fx * (w1 * P.rWheel - vl)) * 0.35 + Math.abs(fy * vt) * 0.8;
    c.tyreT[i] += ((Math.min(heat, 30000) + 1000 + 170 * Math.abs(vl)) / TYRE_CTH - (c.tyreT[i] - 28) * (0.012 + 0.0009 * Math.abs(vl))) * dt;
    if (w.sig > squeal) squeal = w.sig;
    if (kappa < -0.5 && Math.abs(vl) > 8) lock = 1;
    if (sk === 'kerb') rumble = 1;
  }
  Fx -= q * cdA * Math.abs(c.u) * c.u;
  Fy -= q * P.cdLat * Math.abs(c.v) * c.v;

  const ax = Fx / m, ay = Fy / m;
  const f = 1 - Math.exp(-dt / 0.05);
  c.ax += (ax - c.ax) * f; c.ay += (ay - c.ay) * f;
  c.u += (ax + c.v * c.r) * dt;
  c.v += (ay - c.u * c.r) * dt;
  c.r += (Mz / P.Iz) * dt;
  if (Math.abs(c.u) < 0.05 && thrIn < 0.05 && brkIn > 0.1 && Math.abs(c.v) < 0.3) { c.u = 0; c.v = 0; c.r = 0; }

  c.x += (c.u * cp - c.v * sp) * dt;
  c.y += (c.u * sp + c.v * cp) * dt;
  c.psi += c.r * dt;
  if (c.psi > Math.PI) c.psi -= 2 * Math.PI; else if (c.psi < -Math.PI) c.psi += 2 * Math.PI;

  c.speed = Math.hypot(c.u, c.v);
  c.gLat = c.ay / G; c.gLong = c.ax / G;
  c.squeal = squeal; c.lock = lock; c.rumble = rumble;
  c.onSurf = W[2].surf;
}

// ---------- collisions ----------

const _r = { impact: 0 };

// Walls: track.locate(px,py,hint) gives lateral offset d; track.wall[i] is the wall distance from the centre line.
export function collideWalls(c, track) {
  const P = CAR;
  const hl = P.length * 0.5, hw = P.width * 0.5;
  const cp = Math.cos(c.psi), sp = Math.sin(c.psi);
  const corners = [[hl, hw], [hl, -hw], [-hl, hw], [-hl, -hw]];
  let impact = 0;
  for (const [lx, ly] of corners) {
    const px = c.x + lx * cp - ly * sp, py = c.y + lx * sp + ly * cp;
    const loc = track.locate(px, py, c.idx >= 0 ? c.idx : 0);
    const W = track.wall[loc.i];
    const ad = Math.abs(loc.d);
    if (ad <= W) continue;
    const pen = ad - W;
    const sgn = loc.d > 0 ? -1 : 1;
    const nx = track.nx[loc.i] * sgn, ny = track.ny[loc.i] * sgn;
    c.x += nx * pen; c.y += ny * pen;
    const rx = px - c.x, ry = py - c.y;
    const vwx = c.u * cp - c.v * sp, vwy = c.u * sp + c.v * cp;
    const vcx = vwx - c.r * ry, vcy = vwy + c.r * rx;
    const vn = vcx * nx + vcy * ny;
    if (vn >= 0) continue;
    const m = carMass(c);
    const rxn = rx * ny - ry * nx;
    const J = (-(1 + 0.18) * vn) / (1 / m + (rxn * rxn) / P.Iz);
    const tx = -ny, ty = nx;
    const vt = vcx * tx + vcy * ty;
    const Jt = clamp(-vt * m * 0.6, -0.4 * J, 0.4 * J);
    const ix = J * nx + Jt * tx, iy = J * ny + Jt * ty;
    const nvx = vwx + ix / m, nvy = vwy + iy / m;
    c.r += (rx * iy - ry * ix) / P.Iz;
    c.u = nvx * cp + nvy * sp; c.v = -nvx * sp + nvy * cp;
    impact = Math.max(impact, -vn);
  }
  _r.impact = impact;
  return impact;
}

const CIRCLES = [1.65, 0, -1.65];
// others: array of { x, y, psi, u, v, r } (world-space snapshot of the other cars)
export function collideCars(c, others) {
  const P = CAR;
  const cp = Math.cos(c.psi), sp = Math.sin(c.psi);
  let impact = 0;
  const m = carMass(c);
  for (const o of others) {
    const dx0 = o.x - c.x, dy0 = o.y - c.y;
    if (dx0 * dx0 + dy0 * dy0 > 36) continue;
    const ocp = Math.cos(o.psi), osp = Math.sin(o.psi);
    const ovx = o.u * ocp - (o.v || 0) * osp, ovy = o.u * osp + (o.v || 0) * ocp;
    for (const a of CIRCLES) {
      for (const b of CIRCLES) {
        const ax = c.x + a * cp, ay = c.y + a * sp;
        const bx = o.x + b * ocp, by = o.y + b * osp;
        let nx = ax - bx, ny = ay - by;
        const d = Math.hypot(nx, ny);
        const rr = 1.8;
        if (d >= rr || d < 1e-4) continue;
        nx /= d; ny /= d;
        const pen = rr - d;
        c.x += nx * pen * 0.5; c.y += ny * pen * 0.5;
        const rx = ax - c.x, ry = ay - c.y;
        const vwx = c.u * cp - c.v * sp, vwy = c.u * sp + c.v * cp;
        const vcx = vwx - c.r * ry, vcy = vwy + c.r * rx;
        const vn = (vcx - ovx) * nx + (vcy - ovy) * ny;
        if (vn >= 0) continue;
        const rxn = rx * ny - ry * nx;
        const J = (-(1.05) * vn) / (2 / m + (rxn * rxn) / P.Iz);
        const nvx = vwx + (J * nx) / m, nvy = vwy + (J * ny) / m;
        c.r += (rxn * J) / P.Iz;
        c.u = nvx * cp + nvy * sp; c.v = -nvx * sp + nvy * cp;
        impact = Math.max(impact, -vn);
      }
    }
  }
  return impact;
}

// slipstream: reduces drag and (a little) downforce when tucked behind another car
export function slipstream(c, others) {
  let drag = 1, df = 1;
  const cp = Math.cos(c.psi), sp = Math.sin(c.psi);
  for (const o of others) {
    const dx = o.x - c.x, dy = o.y - c.y;
    const fwd = dx * cp + dy * sp;
    if (fwd < 3 || fwd > 55) continue;
    const lat = Math.abs(-dx * sp + dy * cp);
    if (lat > 2.4) continue;
    const k = (1 - fwd / 55) * (1 - lat / 2.4);
    drag = Math.min(drag, 1 - 0.30 * k);
    df = Math.min(df, 1 - 0.20 * k);
  }
  c.dragMul = drag; c.dfMul = df;
}
