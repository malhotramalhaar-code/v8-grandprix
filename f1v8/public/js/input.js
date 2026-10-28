// Keyboard + gamepad driver input with analog smoothing for keys.
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

export class Input {
  constructor() {
    this.keys = new Set();
    this.steer = 0; this.throttle = 0; this.brake = 0;
    this.shift = 0;          // one-shot +1/-1
    this.pressed = new Set(); // one-shot key presses since last poll
    this.padIndex = -1;
    this.usingPad = false;
    this.resetHeld = 0;
    this.enabled = true;
    addEventListener('keydown', (e) => {
      if (!this.enabled) return;
      if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
      if (!e.repeat) this.pressed.add(e.code);
      this.keys.add(e.code);
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
    addEventListener('gamepadconnected', (e) => { this.padIndex = e.gamepad.index; });
    addEventListener('gamepaddisconnected', () => { this.padIndex = -1; });
  }

  was(code) { const had = this.pressed.has(code); return had; }
  clearPressed() { this.pressed.clear(); }

  has(...codes) { return codes.some((c) => this.keys.has(c)); }

  // dt in seconds, speed in m/s. Returns { steer, throttle, brake, shift, reset, camera, pause }
  poll(dt, speed) {
    const k = this.keys;
    let steerT = 0, thrT = 0, brkT = 0;
    if (k.has('ArrowLeft') || k.has('KeyA')) steerT += 1;
    if (k.has('ArrowRight') || k.has('KeyD')) steerT -= 1;
    if (k.has('ArrowUp') || k.has('KeyW')) thrT = 1;
    if (k.has('ArrowDown') || k.has('KeyS')) brkT = 1;

    let padSteer = null, padThr = 0, padBrk = 0, padShift = 0, padReset = false, padCam = false, padPause = false, padBoost = false, padDrs = false;
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const pad = pads && (this.padIndex >= 0 ? pads[this.padIndex] : Array.from(pads).find(Boolean));
    if (pad) {
      let ax = pad.axes[0] || 0;
      if (Math.abs(ax) < 0.07) ax = 0;
      ax = Math.sign(ax) * Math.pow(Math.abs(ax), 1.3);
      const rt = pad.buttons[7] ? pad.buttons[7].value : 0;
      const lt = pad.buttons[6] ? pad.buttons[6].value : 0;
      if (Math.abs(ax) > 0.02 || rt > 0.05 || lt > 0.05) this.usingPad = true;
      padSteer = -ax; padThr = rt; padBrk = lt;
      const b = (i) => pad.buttons[i] && pad.buttons[i].pressed;
      this._padPrev = this._padPrev || {};
      const edge = (i) => { const v = b(i); const r = v && !this._padPrev[i]; this._padPrev[i] = v; return r; };
      if (edge(5)) padShift += 1;
      if (edge(4)) padShift -= 1;
      padCam = edge(3);
      padPause = edge(9);
      padReset = b(1); padBoost = b(0); padDrs = b(2);
    }

    // keyboard smoothing: quicker at low speed, gentler when fast
    const rateIn = 3.4 + 2.6 / (1 + speed / 25), rateOut = 6.5;
    const move = (v, t, up, down) => {
      const d = t - v;
      const r = Math.abs(t) > Math.abs(v) || Math.sign(t) !== Math.sign(v) ? up : down;
      return v + clamp(d, -r * dt, r * dt);
    };
    this.kSteer = move(this.kSteer || 0, steerT, rateIn * 1.2, rateOut);
    this.kThr = move(this.kThr || 0, thrT, 5.5, 9);
    this.kBrk = move(this.kBrk || 0, brkT, 4.5, 10);

    if (padSteer !== null && this.usingPad && (Math.abs(padSteer) > 0.02 || padThr > 0.05 || padBrk > 0.05)) {
      this.steer = padSteer; this.throttle = Math.max(padThr, this.kThr); this.brake = Math.max(padBrk, this.kBrk);
      if (steerT !== 0) this.steer = this.kSteer;
    } else {
      this.steer = this.kSteer; this.throttle = this.kThr; this.brake = this.kBrk;
    }

    let shift = padShift;
    if (this.pressed.has('KeyE') || this.pressed.has('ShiftRight') || this.pressed.has('ShiftLeft')) shift += 1;
    if (this.pressed.has('KeyQ') || this.pressed.has('ControlLeft')) shift -= 1;
    const reset = k.has('KeyR') || padReset;
    this.resetHeld = reset ? this.resetHeld + dt : 0;
    const out = {
      steer: this.steer, throttle: this.throttle, brake: this.brake, shift: clamp(shift, -1, 1),
      resetHeld: this.resetHeld,
      camera: this.pressed.has('KeyC') || padCam,
      pause: this.pressed.has('Escape') || padPause,
      boost: k.has('Space') || padBoost,
      drs: k.has('KeyX') || padDrs,
      mute: this.pressed.has('KeyM'),
      toggleAuto: this.pressed.has('KeyG'),
      toggleLine: this.pressed.has('KeyL'),
    };
    this.pressed.clear();
    return out;
  }
}
