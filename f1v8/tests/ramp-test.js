import { createCar, placeCar, stepCar, CAR } from '../public/js/physics.js';
const DT = 1/240;
for (const kmh of [60, 100, 150, 220, 300]) {
  const c = createCar({ fuel: 40 }); c.hold = false;
  placeCar(c, 0, 0, 0, kmh/3.6);
  let line = [];
  const T = 14;
  let peak = 0, peakT = 0, peakAng = 0;
  for (let k = 0; k < T/DT; k++) {
    const t = k*DT;
    // direct steering angle ramp (bypass speed limit by scaling input)
    const ang = Math.min(0.20, 0.004 + 0.012*t);        // rad, road wheel angle
    const lim = CAR.maxSteer/(1+(c.speed/CAR.steerV0)**2);
    const err = kmh/3.6 - c.speed;
    stepCar(c, { steer: Math.min(1, ang/lim), throttle: Math.max(0, Math.min(1, 0.15 + err*0.3)), brake: Math.max(0, Math.min(1, -err*0.2)), auto: true, tc: 0, abs: 0 }, {}, DT);
    if (Math.abs(c.gLat) > peak) { peak = Math.abs(c.gLat); peakT = t; peakAng = c.steer; }
    if (k % 480 === 0) line.push(`t=${t.toFixed(1)} steer=${(c.steer*57.3).toFixed(1)}° ay=${c.gLat.toFixed(2)}g yaw=${(c.r*57.3).toFixed(0)}°/s slipB=${(Math.atan2(c.v,c.u)*57.3).toFixed(1)}° v=${(c.speed*3.6).toFixed(0)}`);
  }
  print(`== ${kmh} km/h  peak ay ${peak.toFixed(2)} g at steer ${(peakAng*57.3).toFixed(1)}° (t=${peakT.toFixed(1)})`);
  print(line.join('\n'));
}
