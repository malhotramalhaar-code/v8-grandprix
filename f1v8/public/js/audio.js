// Procedural audio: screaming 18 000 rpm V8, tyre squeal, wind, kerbs, impacts, start beeps. All synthesised.
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

export class GameAudio {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.voices = new Map();
    this.master = null;
  }

  ensure() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.7;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 6;
    this.master.connect(comp); comp.connect(ctx.destination);

    // shared noise buffer
    const len = ctx.sampleRate * 2;
    const nb = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = nb.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = nb;

    // harmonic table for the V8 firing note
    const N = 40;
    const real = new Float32Array(N), imag = new Float32Array(N);
    for (let n = 1; n < N; n++) {
      const even = n % 2 === 0 ? 1.25 : 0.85;
      imag[n] = (even / Math.pow(n, 0.78)) * (n > 18 ? Math.max(0, 1 - (n - 18) / 22) : 1);
      real[n] = 0;
    }
    this.wave = ctx.createPeriodicWave(real, imag);

    // waveshaper for rasp
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) { const x = (i / 512) - 1; curve[i] = Math.tanh(x * 2.4); }
    this.shaper = curve;

    // player-only effects
    this.fx = {};
    this.fx.squeal = this._noiseVoice(1400, 5, 'bandpass');
    this.fx.wind = this._noiseVoice(500, 0.5, 'lowpass');
    this.fx.rumble = this._noiseVoice(110, 2, 'lowpass');
    this.fx.gravel = this._noiseVoice(2500, 0.7, 'highpass');
  }

  _noiseVoice(freq, q, type) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource(); src.buffer = this.noiseBuf; src.loop = true;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = ctx.createGain(); g.gain.value = 0;
    src.connect(f); f.connect(g); g.connect(this.master);
    src.start();
    return { f, g };
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : 0.7, this.ctx.currentTime, 0.05);
  }

  makeEngine(isPlayer) {
    const ctx = this.ctx;
    const o1 = ctx.createOscillator(); o1.setPeriodicWave(this.wave);
    const o2 = ctx.createOscillator(); o2.setPeriodicWave(this.wave);
    const sub = ctx.createOscillator(); sub.type = 'triangle';
    const sh = ctx.createWaveShaper(); sh.curve = this.shaper; sh.oversample = '2x';
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 1.4;
    const bp = ctx.createBiquadFilter(); bp.type = 'peaking'; bp.Q.value = 1.2; bp.gain.value = 7;
    const mix = ctx.createGain(); mix.gain.value = 0.5;
    const subg = ctx.createGain(); subg.gain.value = 0.0;
    const out = ctx.createGain(); out.gain.value = 0;
    const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    o1.connect(mix); o2.connect(mix); mix.connect(sh); sh.connect(lp); lp.connect(bp);
    sub.connect(subg); subg.connect(lp);
    bp.connect(out);
    if (pan) { out.connect(pan); pan.connect(this.master); } else out.connect(this.master);
    // intake / exhaust hiss
    const ns = ctx.createBufferSource(); ns.buffer = this.noiseBuf; ns.loop = true;
    const nf = ctx.createBiquadFilter(); nf.type = 'bandpass'; nf.Q.value = 0.8; nf.frequency.value = 3000;
    const ng = ctx.createGain(); ng.gain.value = 0;
    ns.connect(nf); nf.connect(ng); ng.connect(out);
    o1.start(); o2.start(); sub.start(); ns.start();
    return { o1, o2, sub, lp, bp, mix, subg, out, pan, ng, nf, lastThr: 0, popT: 0 };
  }

  getVoice(id, isPlayer) {
    if (!this.ctx) return null;
    let v = this.voices.get(id);
    if (!v) { v = this.makeEngine(isPlayer); this.voices.set(id, v); }
    return v;
  }

  dropVoice(id) {
    const v = this.voices.get(id);
    if (!v) return;
    try { v.o1.stop(); v.o2.stop(); v.sub.stop(); } catch {}
    try { v.out.disconnect(); } catch {}
    this.voices.delete(id);
  }

  // rpm, thr 0..1, vol 0..1, pan -1..1, pitch multiplier (doppler)
  engine(id, rpm, thr, vol, pan = 0, pitch = 1, isPlayer = false) {
    if (!this.ctx) return;
    const v = this.getVoice(id, isPlayer);
    const t = this.ctx.currentTime;
    const f0 = (rpm / 60) * 4 * pitch;          // V8: four firing events per revolution
    const tc = 0.025;
    v.o1.frequency.setTargetAtTime(f0, t, tc);
    v.o2.frequency.setTargetAtTime(f0 * 1.004, t, tc);
    v.sub.frequency.setTargetAtTime(f0 * 0.5, t, tc);
    const load = 0.35 + 0.65 * thr;
    const rn = rpm / 18000;
    v.lp.frequency.setTargetAtTime((900 + rn * 5200) * (0.55 + 0.45 * thr) * pitch, t, 0.04);
    v.bp.frequency.setTargetAtTime(1800 + rn * 3500, t, 0.05);
    v.subg.gain.setTargetAtTime((1 - rn) * 0.7 * load, t, 0.05);
    v.mix.gain.setTargetAtTime(0.32 + 0.2 * load, t, 0.04);
    v.out.gain.setTargetAtTime(vol * (0.2 + 0.8 * load) * (isPlayer ? 0.55 : 0.5), t, 0.05);
    if (v.pan) v.pan.pan.setTargetAtTime(pan, t, 0.05);
    v.nf.frequency.setTargetAtTime(2500 + rn * 4000, t, 0.1);
    v.ng.gain.setTargetAtTime(thr * rn * 0.18, t, 0.05);
    // overrun crackle when the throttle is snapped shut at high revs
    if (isPlayer) {
      if (v.lastThr > 0.6 && thr < 0.1 && rpm > 9000) v.popT = t + 0.5;
      v.lastThr = thr;
      if (t < v.popT && Math.random() < 0.35) {
        v.ng.gain.setValueAtTime(0.5, t); v.ng.gain.setTargetAtTime(0, t + 0.01, 0.03);
      }
    }
  }

  // continuous player effects
  effects(speed, squeal, rumble, offroad, vol = 1) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.fx.wind.g.gain.setTargetAtTime(clamp((speed / 90) ** 2, 0, 1) * 0.35 * vol, t, 0.1);
    this.fx.wind.f.frequency.setTargetAtTime(300 + speed * 6, t, 0.1);
    this.fx.squeal.g.gain.setTargetAtTime(clamp((squeal - 0.9) * 0.35, 0, 0.3) * vol, t, 0.04);
    this.fx.squeal.f.frequency.setTargetAtTime(1000 + squeal * 220 + speed * 3, t, 0.05);
    this.fx.rumble.g.gain.setTargetAtTime(rumble * clamp(speed / 40, 0, 1) * 0.55 * vol, t, 0.04);
    this.fx.rumble.f.frequency.setTargetAtTime(70 + speed * 1.3, t, 0.05);
    this.fx.gravel.g.gain.setTargetAtTime(offroad * clamp(speed / 30, 0, 1) * 0.25 * vol, t, 0.08);
  }

  impact(strength) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource(); src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 900 + strength * 80;
    const g = ctx.createGain();
    g.gain.setValueAtTime(clamp(strength / 20, 0.1, 1) * 0.9, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    src.connect(f); f.connect(g); g.connect(this.master);
    src.start(t, Math.random()); src.stop(t + 0.4);
  }

  beep(freq = 880, dur = 0.18, vol = 0.25) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.01);
    g.gain.setTargetAtTime(0, t + dur, 0.03);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + dur + 0.2);
  }

  silenceAll() {
    if (!this.ctx) return;
    for (const id of [...this.voices.keys()]) this.dropVoice(id);
    const t = this.ctx.currentTime;
    for (const k of Object.keys(this.fx)) this.fx[k].g.gain.setTargetAtTime(0, t, 0.05);
  }
}
