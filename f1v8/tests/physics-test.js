// Run with: /System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc -m tests/physics-test.js
import { createCar, placeCar, stepCar, G } from '../public/js/physics.js';

const DT = 1 / 240;
const CARL = 3.1;
const out = (...a) => print(a.join(' '));
const kmh = (v) => (v * 3.6).toFixed(1);

function sim(c, inpFn, secs, cb) {
  const n = Math.round(secs / DT);
  for (let k = 0; k < n; k++) {
    const t = k * DT;
    stepCar(c, inpFn(t, c), {}, DT);
    if (cb && cb(t, c) === false) return t;
  }
  return secs;
}

// --- 0-100 and 0-200, top speed
{
  const c = createCar({ fuel: 40, wing: 0.5 }); c.hold = false;
  let t100 = 0, t200 = 0, t300 = 0, dist = 0;
  sim(c, () => ({ steer: 0, throttle: 1, brake: 0, auto: true, tc: 1, abs: 1 }), 40, (t, c) => {
    if (!t100 && c.u * 3.6 >= 100) t100 = t;
    if (!t200 && c.u * 3.6 >= 200) t200 = t;
    if (!t300 && c.u * 3.6 >= 300) t300 = t;
  });
  out('ACCEL  0-100:', t100.toFixed(2), 's  0-200:', t200.toFixed(2), 's  0-300:', t300.toFixed(2), 's  vmax@40s:', kmh(c.u), 'km/h gear', c.gear, 'rpm', c.rpm.toFixed(0));
}

// --- braking from 300 km/h
{
  const c = createCar({ fuel: 40 }); c.hold = false;
  placeCar(c, 0, 0, 0, 300 / 3.6); c.gear = 7;
  let peak = 0, dist = 0, tEnd = 0;
  const x0 = c.x;
  tEnd = sim(c, () => ({ steer: 0, throttle: 0, brake: 1, auto: true, abs: 1 }), 12, (t, c) => {
    peak = Math.max(peak, -c.gLong);
    if (c.u < 1) return false;
  });
  out('BRAKE 300->0: time', tEnd.toFixed(2), 's dist', (c.x - x0).toFixed(0), 'm  peak decel', peak.toFixed(2), 'g');
  // 200 -> 80
  const d = createCar({ fuel: 40 }); d.hold = false; placeCar(d, 0, 0, 0, 200 / 3.6); d.gear = 5;
  let pk = 0; const x1 = d.x;
  sim(d, () => ({ steer: 0, throttle: 0, brake: 1, auto: true, abs: 1 }), 12, (t, c) => { pk = Math.max(pk, -c.gLong); if (c.u < 80 / 3.6) return false; });
  out('BRAKE 200->80: dist', (d.x - x1).toFixed(0), 'm peak', pk.toFixed(2), 'g');
}

// --- steady-state cornering: constant radius circle at increasing speed, find the max lateral g
for (const [R, speeds] of [[40, [60, 80, 100, 120]], [100, [120, 160, 190, 210]], [250, [200, 250, 280, 300]]]) {
  let best = 0, bestV = 0;
  for (const sp of speeds) {
    const c = createCar({ fuel: 40 }); c.hold = false;
    placeCar(c, R, 0, Math.PI / 2, sp / 3.6); c.gear = Math.min(7, Math.max(1, Math.round(sp / 3.6 / 13)));
    // simple controller holding radius: steer ~ L/R + feedback on radius error
    let ok = true; let maxAy = 0;
    sim(c, (t, c) => {
      const rad = Math.hypot(c.x, c.y);
      const err = rad - R;
      const lim = 0.34 / (1 + (c.speed / 38) ** 2);
      let st = (CARL / R + 0.0 - 0.0) ;
      st += 0.006 * err;
      // speed hold
      const thr = c.speed * 3.6 < sp ? 0.6 : 0.0;
      return { steer: Math.max(-1, Math.min(1, st / lim)), throttle: thr, brake: 0, auto: false, shift: 0, tc: 1 };
    }, 12, (t, c) => {
      const rad = Math.hypot(c.x, c.y);
      if (Math.abs(rad - R) > 12) { ok = false; return false; }
      if (t > 8) maxAy = Math.max(maxAy, Math.abs(c.gLat));
    });
    if (ok && maxAy > best) { best = maxAy; bestV = sp; }
    out('  skidpad R=' + R, 'v=' + sp + 'km/h', ok ? 'held' : 'LOST', 'ay=' + maxAy.toFixed(2) + 'g', 'speed now', kmh(c.speed));
  }
  out('CORNER R=' + R, 'best sustained', best.toFixed(2), 'g at', bestV, 'km/h');
}

