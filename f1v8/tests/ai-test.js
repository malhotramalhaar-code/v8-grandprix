import { createCar, placeCar, stepCar, collideWalls } from '../public/js/physics.js';
import { buildTrack } from '../public/js/track.js';
import { BUILTIN, generateTrackSpec } from '../public/js/tracks.js';
import { AIDriver } from '../public/js/ai.js';

const DT = 1/240;
function runTrack(spec, laps, skill) {
  const tr = buildTrack(spec);
  const c = createCar({ fuel: 30, wing: 0.5 });
  const g = tr.gridSlot(0);
  placeCar(c, g.x, g.y, g.psi, 0);
  c.hold = false; c.idx = g.idx;
  const ai = new AIDriver(tr, skill, 1);
  const env = { surface(car, i, wx, wy) { const l = tr.locate(wx, wy, car.idx); return tr.surface(l.i, l.d); } };
  let prog = g.fi * tr.ds, lastFi = null;       // unwrapped progress in metres
  let lapStart = 0, lapsDone = 0, lapTimes = [];
  let offTime = 0, wallHits = 0, maxV = 0, maxLat = 0, t = 0;
  let spinTime = 0;
  const maxT = laps * 200 + 20;
  while (lapsDone < laps && t < maxT) {
    const loc = tr.locate(c.x, c.y, c.idx); c.idx = loc.i;
    const fi = loc.fi;
    if (lastFi !== null) { let d = fi - lastFi; if (d > tr.n/2) d -= tr.n; if (d < -tr.n/2) d += tr.n; prog += d * tr.ds; }
    lastFi = fi;
    if (prog >= (lapsDone + 1) * tr.length) { lapsDone++; lapTimes.push(t - lapStart); lapStart = t; }
    const inp = ai.update(c, DT, []);
    if (t < 0.5) inp.throttle = 0;   // lights
    for (let s = 0; s < 1; s++) stepCar(c, inp, env, DT);
    const imp = collideWalls(c, tr);
    if (imp > 3) wallHits++;
    if (Math.abs(loc.d) > tr.hw[loc.i]) offTime += DT;
    maxV = Math.max(maxV, c.speed); maxLat = Math.max(maxLat, Math.abs(c.gLat));
    t += DT;
  }
  const fmt = (s) => `${Math.floor(s/60)}:${(s%60).toFixed(2).padStart(5,'0')}`;
  print(`${(spec.name||'').padEnd(20)} len ${(tr.length/1000).toFixed(2)}km laps ${lapsDone}/${laps} times [${lapTimes.map(fmt).join(' ')}] off=${offTime.toFixed(1)}s wallHits=${wallHits} vmax=${(maxV*3.6).toFixed(0)}km/h maxLat=${maxLat.toFixed(1)}g wear=${c.wear.map(w=>w.toFixed(2)).join('/')} fuel=${c.fuel.toFixed(1)}`);
}
const only = (typeof arguments !== 'undefined' && arguments[0]) || null;
for (const spec of BUILTIN) { if (!only || spec.id === only) runTrack(spec, 3, 0.9); }
