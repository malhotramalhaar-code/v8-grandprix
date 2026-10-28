// A race session: fixed-step physics for local cars (you + hosted bots), smoothed remote cars,
// start sequence, lap timing, cameras, effects, audio, and state sync.
import * as THREE from 'three';
import { createCar, placeCar, stepCar, collideWalls, collideCars, slipstream, CAR, G } from './physics.js';
import { AIDriver, buildSpeedProfile } from './ai.js';
import { buildCarModel, makeNameTag, disposeModel } from './carmodel.js';

const H = 1 / 240;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const wrapPi = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
const CAMS = ['Chase', 'Far chase', 'Nose cam', 'T-cam'];

export class Race {
  constructor({ world, hud, audio, input, net, track, msg, me, prefs, onResults, local }) {
    this.world = world; this.hud = hud; this.audio = audio; this.input = input; this.net = net;
    this.track = track; this.msg = msg; this.me = me; this.prefs = prefs; this.onResults = onResults;
    this.local = !!local;
    this.isHost = local || (net && msg.host === net.id);
    this.laps = msg.laps;
    this.settings = msg.settings || {};
    this.ents = new Map();
    this.simT = 0; this.acc = 0;
    this.started = false; this.finishedAll = false;
    this.paused = false;
    this.camMode = prefs.cam ?? 0;
    this.camPos = new THREE.Vector3(); this.camYaw = 0; this.camInit = false;
    this.driver = { steer: 0, throttle: 0, brake: 0, shift: 0, auto: prefs.auto !== false, abs: prefs.abs ? 1 : 0, tc: prefs.tc ?? 0, steerAssist: prefs.steerAssist ?? 0.5, boost: false, drs: false };
    this.hudT = 0; this.sendT = 0; this.mmT = 0;
    this.lastShown = {};
    this.wrongWayT = 0;
    this.profile = null;
    this.standings = new Map();
    this.finishCount = 0;
    this.destroyed = false;
    this.resultsShown = false;
    this.bestTrace = null; this.curTrace = [];

    const km = track.length / 1000;
    const fuelFor = clamp(this.laps * km * 0.74 + 2.5, 8, 150);

    const sorted = [...msg.cars].sort((a, b) => msg.grid[a.id] - msg.grid[b.id]);
    for (const c of sorted) {
      const slot = msg.grid[c.id];
      const isMe = c.id === me.id;
      const simulated = isMe || (c.bot && this.isHost);
      const setup = isMe ? me.setup : c.setup || {};
      const e = {
        id: c.id, name: c.name, color: c.color, num: c.num, bot: !!c.bot, slot, isMe, simulated,
        lap: 0, best: null, last: null, lapStart: 0, finished: false, finPos: 0, finTime: null,
        prog: 0, lastFi: 0, speed: 0, rpm: 5000, gear: 1, thr: 0, brk: 0, steer: 0, flags: 0,
        wheelAngle: 0, wearAvg: 0, gap: 0, damage: 0, drsOk: false, drsOpen: false,
        remote: null, disp: null, lastWheel: null,
      };
      const g = track.gridSlot(slot);
      e.model = buildCarModel(c.color, c.num, setup.compound || 'medium');
      world.carGroup.add(e.model);
      if (!isMe) {
        e.tag = makeNameTag(c.name, c.color); e.tag.position.set(0, 2.0, 0); e.model.add(e.tag);
      }
      e.model.traverse((o) => { if (o.isMesh) o.castShadow = true; });
      if (simulated) {
        e.phys = createCar({ fuel: fuelFor, wing: setup.wing ?? 0.5, bias: setup.bias ?? 0.58, compound: setup.compound || 'medium', wearRate: this.settings.wear ?? 1 });
        placeCar(e.phys, g.x, g.y, g.psi, 0);
        e.phys.hold = true; e.phys.idx = g.idx;
        e.disp = e.phys;
        if (e.bot) {
          e.ai = new AIDriver(track, clamp((this.settings.aiSkill ?? 0.9) - 0.07 * (slot / 20) + (((c.num * 37) % 7) - 3) * 0.01, 0.5, 1), c.num);
          e.phys.wing = 0.5;
        }
      } else {
        e.disp = { x: g.x, y: g.y, psi: g.psi, u: 0, v: 0, r: 0, steer: 0, rpm: 5000, gear: 1, thr: 0, brk: 0 };
      }
      e.prog = g.fi * track.ds;
      const loc = track.locate(g.x, g.y, g.idx); e.lastFi = loc.fi; e.idx = loc.i;
      this.ents.set(c.id, e);
      this.standings.set(c.id, { laps: 0, best: null });
    }
    this.meEnt = this.ents.get(me.id);
    this.env = {
      surface: (c, i, wx, wy) => { const l = track.locate(wx, wy, c.idx >= 0 ? c.idx : 0); return track.surface(l.i, l.d); },
    };
    if (this.prefs.line) this.toggleLine(true);

    // net handlers
    if (net) {
      this._h = {
        snap: (m) => this.onSnap(m), lap: (m) => this.onLap(m), results: (m) => this.finish(m.list),
        left: (m) => this.onLeft(m), bots_gone: () => this.onBotsGone(),
      };
      for (const k in this._h) net.on(k, this._h[k]);
    }
    // time base: server clock when networked, local otherwise
    this.now = () => (net ? net.serverNow() : Date.now());

    this.hud.setTrack(track);
    this.hud.setLaps(this.laps);
    this.hud.reset();
    this.audio.ensure();
    this.lightsShown = -1;
    this.camera = world.camera;
  }

  // ------------------------------------------------------------------ network in
  onSnap(m) {
    const t = performance.now();
    for (const id in m.c) {
      const e = this.ents.get(id);
      if (!e || e.simulated) continue;
      e.remote = { s: m.c[id], at: t };
      const s = m.c[id];
      e.prog = s[11]; e.lap = Math.max(e.lap, s[12] | 0); e.flags = s[13] | 0; e.damage = s[14] || 0;
    }
  }

  onLap(m) {
    const e = this.ents.get(m.id);
    if (!e) return;
    e.best = m.best; e.last = m.time; e.lap = Math.max(e.lap, m.lap);
    if (m.fin) { e.finished = true; e.finPos = m.pos; e.finTime = m.total; }
    if (e.isMe && m.fin) this.hud.message(`FINISHED  P${m.pos}`, 6000, 'good');
    else if (m.fin && !e.isMe) this.hud.toast(`${e.name} finished P${m.pos}`);
  }

  onLeft(m) {
    const e = this.ents.get(m.id);
    if (!e) return;
    this.hud.toast(`${e.name} left the race`);
    this.removeEnt(e);
  }

  onBotsGone() {
    for (const e of [...this.ents.values()]) if (e.bot && !e.simulated) this.removeEnt(e);
  }

  removeEnt(e) {
    this.world.carGroup.remove(e.model); disposeModel(e.model);
    this.audio.dropVoice(e.id);
    this.ents.delete(e.id);
  }

  finish(list) {
    if (this.resultsShown) return;
    this.resultsShown = true;
    this.onResults && this.onResults(list);
  }

  // ------------------------------------------------------------------ simulation
  goNow() {
    this.started = true;
    for (const e of this.ents.values()) if (e.phys) { e.phys.hold = false; e.lapStart = 0; }
    this.simT = 0;
    this.hud.setLights(0);
    this.hud.message('GO!', 1400, 'go');
  }

  othersFor(e) {
    const out = [];
    for (const o of this.ents.values()) if (o !== e) out.push(o.disp);
    return out;
  }

  simStep() {
    const T = this.track;
    for (const e of this.ents.values()) {
      if (!e.phys) continue;
      const c = e.phys;
      let inp;
      if (e.ai) inp = e.ai.inp;
      else if (e.isMe && !e.finished) inp = this.driver;
      else inp = e.cool || this.driver;
      c.idx = e.idx;
      stepCar(c, inp, this.env, H);
      const imp = collideWalls(c, T);
      let imp2 = 0;
      if (!c.hold) imp2 = collideCars(c, this.othersFor(e));
      const hit = Math.max(imp, imp2);
      if (hit > 2.5) this.onImpact(e, hit);
      // progress
      const loc = T.locate(c.x, c.y, c.idx);
      c.idx = e.idx = loc.i;
      let d = loc.fi - e.lastFi;
      if (d > T.n / 2) d -= T.n; else if (d < -T.n / 2) d += T.n;
      e.lastFi = loc.fi < 0 ? loc.fi + T.n : loc.fi;
      e.prog += d * T.ds;
      e.off = loc.d;
      if (this.started) {
        if (e.prog >= (e.lap + 1) * T.length && !e.finished) this.onLapCross(e);
      }
    }
    if (this.started) this.simT += H;
  }

  onImpact(e, hit) {
    const c = e.phys;
    if (hit > 6 && this.settings.damage !== false) c.damage = Math.min(1, c.damage + clamp((hit - 6) / 45, 0, 0.35));
    if (e.isMe) {
      this.audio.impact(hit);
      this.shake = Math.min(1, hit / 25);
    }
    for (let i = 0; i < Math.min(14, hit * 1.2); i++) this.world.addSpark(c.x + Math.cos(c.psi) * 1.5, c.y + Math.sin(c.psi) * 1.5, 0.3, c.u * Math.cos(c.psi), c.u * Math.sin(c.psi));
  }

  onLapCross(e) {
    e.lap++;
    const lt = this.simT - e.lapStart;
    e.lapStart = this.simT;
    if (e.best === null || lt < e.best) e.best = lt;
    e.last = lt;
    const fin = e.lap >= this.laps;
    if (fin) {
      e.finished = true; e.finTime = this.simT;
      if (!e.bot) { e.coolAI = new AIDriver(this.track, 0.6, 3); e.cool = e.coolAI.inp; }
    }
    if (e.isMe) {
      const isBest = e.best === lt;
      this.hud.message(`LAP ${e.lap}   ${fmt(lt)}${isBest ? '   BEST' : ''}`, 3500, isBest ? 'good' : '');
      if (!this.bestTrace || lt <= e.best) this.bestTrace = this.curTrace;
      this.curTrace = [];
    }
    const ev = { t: 'lap', id: e.bot ? e.id : undefined, lap: e.lap, time: lt, total: this.simT };
    if (this.net) this.net.send(ev);
    else this.localLap({ ...ev, id: e.id });
  }

  // offline referee (mirrors the server)
  localLap(m) {
    const st = this.standings.get(m.id);
    const e = this.ents.get(m.id);
    if (!st || !e) return;
    st.laps = m.lap; if (st.best === null || m.time < st.best) st.best = m.time;
    const ev = { t: 'lap', id: m.id, lap: m.lap, time: m.time, best: st.best, total: m.total };
    if (m.lap >= this.laps) { ev.fin = true; ev.pos = ++this.finishCount; st.total = m.total; st.finished = true; }
    this.onLap(ev);
    if (ev.fin && e.isMe) {
      setTimeout(() => {
        if (this.destroyed) return;
        const list = [...this.ents.values()].map((x) => {
          const s = this.standings.get(x.id);
          return { id: x.id, name: x.name, color: x.color, num: x.num, bot: x.bot, laps: s.laps, total: s.total ?? null, best: s.best, finished: !!s.finished };
        });
        list.sort((a, b) => b.laps - a.laps || (a.total ?? 1e9) - (b.total ?? 1e9));
        this.finish(list);
      }, 4500);
    }
  }

  // ------------------------------------------------------------------ per frame
  frame(dtReal) {
    if (this.destroyed) return;
    const dt = Math.min(dtReal, 0.1);
    const perf = performance.now();
    const me = this.meEnt;
    const poll = this.input.poll(dt, me && me.phys ? me.phys.speed : 0);
    if (poll.camera) { this.camMode = (this.camMode + 1) % CAMS.length; this.hud.toast('Camera: ' + CAMS[this.camMode]); this.prefs.cam = this.camMode; }
    if (poll.mute) { this.audio.setMuted(!this.audio.muted); this.hud.toast(this.audio.muted ? 'Sound off' : 'Sound on'); }
    if (poll.toggleAuto) { this.driver.auto = !this.driver.auto; this.prefs.auto = this.driver.auto; this.hud.toast(this.driver.auto ? 'Automatic gearbox' : 'Manual gearbox (Q / E)'); }
    if (poll.toggleLine) this.toggleLine();
    if (poll.pause && this.local) { this.paused = !this.paused; this.hud.setPaused(this.paused); }
    if (poll.pause && !this.local) this.hud.togglePause();
    if (this.paused) { this.render(0, perf); return; }

    // driver input
    this.driver.steer = poll.steer; this.driver.throttle = poll.throttle; this.driver.brake = poll.brake; this.driver.shift = poll.shift;
    this.driver.boost = poll.boost; this.driver.drs = poll.drs && !!(me && me.drsOk);
    this.driver.abs = this.prefs.abs ? 1 : 0; this.driver.tc = this.prefs.tc ?? 0; this.driver.steerAssist = this.prefs.steerAssist ?? 0.5;

    // start sequence (server clock)
    const now = this.now();
    if (!this.started) {
      const el = now - this.msg.lights0;
      const count = el < 0 ? 0 : clamp(Math.floor(el / 1000) + 1, 1, 5);
      if (count !== this.lightsShown) {
        this.lightsShown = count; this.hud.setLights(count);
        if (count > 0) this.audio.beep(660, 0.16, 0.18);
      }
      if (now >= this.msg.go) { this.audio.beep(1320, 0.4, 0.22); this.goNow(); }
    }
    this.hud.setCountdown(!this.started && now < this.msg.lights0 ? Math.ceil((this.msg.lights0 - now) / 1000) : null);

    this.updateDrs();

    // AI at frame rate
    for (const e of this.ents.values()) {
      if (e.ai && e.phys) {
        const others = this.othersFor(e);
        e.ai.update(e.phys, dt, others);
        e.ai.inp.drs = e.drsOk;
      }
      if (e.coolAI && e.phys) { e.coolAI.update(e.phys, dt, []); e.cool = e.coolAI.inp; }
    }
    // slipstream
    for (const e of this.ents.values()) if (e.phys) slipstream(e.phys, this.othersFor(e));

    // manual recovery
    if (me && me.phys && poll.resetHeld > 0.7 && this.started) { this.resetCar(me); this.input.resetHeld = 0; this.input.keys.delete('KeyR'); }

    // fixed-step physics
    this.acc += dt;
    let n = 0;
    while (this.acc >= H && n < 12) { this.simStep(); this.acc -= H; n++; }
    if (n >= 12) this.acc = 0;
    if (me && me.phys && this.started && !me.finished) {
      const tr = this.track;
      const bucket = Math.floor(((me.prog % tr.length) / tr.length) * 200);
      if (bucket >= 0 && bucket < 200 && this.curTrace[bucket] === undefined) this.curTrace[bucket] = this.simT - me.lapStart;
    }

    this.updateRemotes(dt);
    this.net && this.sendState(perf);
    this.visuals(dt, perf);
    this.updateCamera(dt);
    this.updateAudio(dt);
    this.updateHud(dt, perf, poll);
    this.render(dt, perf);
  }

  render(dt) {
    this.world.updateEffects(dt);
    const me = this.meEnt;
    const f = me ? me.disp : { x: 0, y: 0 };
    this.world.follow(f.x, f.y);
    this.world.render();
  }

  resetCar(e) {
    const T = this.track, c = e.phys;
    const loc = T.locate(c.x, c.y, c.idx);
    const lat = clamp(loc.d, -T.hw[loc.i] * 0.5, T.hw[loc.i] * 0.5);
    const p = T.pointAt(loc.i + 3, lat);
    placeCar(c, p.x, p.y, p.psi, 0);
    c.hold = false; c.gear = 1; c.idx = loc.i;
    this.hud.toast('Car reset to track');
  }

  // DRS: open from lap 2 on straights when within a second of the car ahead
  updateDrs() {
    const T = this.track, list = [...this.ents.values()];
    for (const e of list) {
      if (!e.phys) continue;
      let nearest = Infinity;
      for (const o of list) {
        if (o === e) continue;
        const d = o.prog - e.prog;
        if (d > 0 && d < nearest) nearest = d;
      }
      const gapT = nearest / Math.max(40, e.phys.speed);
      const i = e.idx;
      let straight = true;
      for (let k = 0; k < 14; k += 3) if (Math.abs(T.curv[(i + k) % T.n]) > 0.0011) { straight = false; break; }
      e.drsOk = this.started && e.lap >= 1 && !e.finished && gapT < 1.0 && straight;
    }
  }

  updateRemotes(dt) {
    const perf = performance.now();
    for (const e of this.ents.values()) {
      if (e.simulated || !e.remote) continue;
      const s = e.remote.s;
      const age = Math.min(0.25, (perf - e.remote.at) / 1000);
      const psi = s[2], u = s[3], v = s[4], r = s[5];
      const vx = u * Math.cos(psi) - v * Math.sin(psi), vy = u * Math.sin(psi) + v * Math.cos(psi);
      const tx = s[0] + vx * age, ty = s[1] + vy * age, tp = psi + r * age;
      const d = e.disp;
      const k = 1 - Math.exp(-dt * 16);
      const dist = Math.hypot(tx - d.x, ty - d.y);
      if (dist > 25) { d.x = tx; d.y = ty; d.psi = tp; } else {
        d.x += (tx - d.x) * k; d.y += (ty - d.y) * k; d.psi += wrapPi(tp - d.psi) * k;
      }
      d.u = u; d.v = v; d.r = r; d.steer = s[6]; d.rpm = s[7]; d.gear = s[8]; d.thr = s[9]; d.brk = s[10];
      e.speed = u;
    }
  }

  sendState(perf) {
    if (perf - this.sendT < 33) return;
    this.sendT = perf;
    const enc = (e) => {
      const c = e.phys;
      const flags = (c.squeal > 1.5 ? 1 : 0) | (c.lock ? 2 : 0) | (c.rumble ? 4 : 0) | (e.finished ? 8 : 0) | (c.drs ? 16 : 0) | (c.boosting ? 32 : 0);
      return [r2(c.x), r2(c.y), r3(c.psi), r2(c.u), r2(c.v), r3(c.r), r3(c.steer), Math.round(c.rpm), c.gear, r2(c.thr), r2(c.brk), r2(e.prog), e.lap, flags, r2(c.damage)];
    };
    if (this.meEnt && this.meEnt.phys) this.net.send({ t: 'st', s: enc(this.meEnt) });
    if (this.isHost) {
      const cs = {};
      for (const e of this.ents.values()) if (e.bot && e.phys) cs[e.id] = enc(e);
      if (Object.keys(cs).length) this.net.send({ t: 'bots', c: cs });
    }
  }

  // ------------------------------------------------------------------ visuals
  visuals(dt, perf) {
    const world = this.world;
    const camPos = this.camera.position;
    for (const e of this.ents.values()) {
      const d = e.disp, m = e.model;
      m.position.set(d.x, 0, -d.y);
      m.rotation.y = d.psi;
      const ud = m.userData;
      if (e.phys) {
        ud.body.rotation.x += (clamp(e.phys.gLat * 0.012, -0.05, 0.05) - ud.body.rotation.x) * 0.2;
        ud.body.rotation.z += (clamp(e.phys.gLong * 0.01, -0.05, 0.04) - ud.body.rotation.z) * 0.2;
        e.speed = e.phys.speed;
        e.rpm = e.phys.rpm; e.gear = e.phys.gear;
        const wr = e.phys.wear; e.wearAvg = (wr[0] + wr[1] + wr[2] + wr[3]) / 4;
      }
      const spd = d.u || 0;
      ud.spinAngle -= (spd / CAR.rWheel) * dt;
      for (let i = 0; i < 4; i++) {
        const w = ud.wheels[i];
        w.spin.rotation.z = ud.spinAngle;
        if (i < 2) w.pivot.rotation.y = d.steer || 0;
      }
      ud.lightMat.emissiveIntensity = 0.1 + 2.6 * (d.brk || 0);
      const open = e.phys ? e.phys.drs : !!(e.flags & 16);
      e.drsOpen = open;
      ud.drsAngle += ((open ? -0.5 : 0) - ud.drsAngle) * Math.min(1, dt * 14);
      ud.drsFlap.rotation.z = ud.drsAngle;
      const dmg = e.phys ? e.phys.damage : e.damage;
      ud.fw.rotation.z = -0.07 * dmg; ud.fw.position.y = -0.04 * dmg;
      ud.fwPlates[0].visible = dmg < 0.35; ud.fwFlap.visible = dmg < 0.7;
      if (e.tag) { const dist = Math.hypot(camPos.x - d.x, camPos.z + d.y); e.tag.visible = dist < 260 && dist > 6; const s = clamp(dist / 40, 0.8, 3.2); e.tag.scale.set(3.4 * s * 0.6, 0.85 * s * 0.6, 1); }

      // tyre marks and smoke
      const sq = e.phys ? e.phys.squeal : e.flags & 1 ? 2 : 0;
      const lock = e.phys ? e.phys.lock : e.flags & 2;
      const spdAbs = Math.abs(d.u || 0);
      const cp = Math.cos(d.psi), sp = Math.sin(d.psi);
      if (!e.lastWheel) e.lastWheel = [null, null];
      for (let k = 0; k < 2; k++) {
        const wi = 2 + k;
        const side = k === 0 ? 1 : -1;
        const wx = d.x - CAR.b * cp - side * CAR.tr * 0.5 * sp, wy = d.y - CAR.b * sp + side * CAR.tr * 0.5 * cp;
        const slipping = (sq > 1.35 || lock) && spdAbs > 6;
        if (slipping && (!e.phys || e.phys.wh[wi].surf !== 'grass')) {
          const lw = e.lastWheel[k];
          if (lw) world.addSkid(lw[0], lw[1], wx, wy);
          e.lastWheel[k] = [wx, wy];
          if (Math.random() < Math.min(1, dt * 40) * 0.7) world.addSmoke(wx, wy, (d.u || 0) * cp * 0.15, (d.u || 0) * sp * 0.15, 1.1 + Math.min(1.5, sq * 0.3), 0.32);
        } else e.lastWheel[k] = null;
        if (e.phys && (e.phys.wh[wi].surf === 'gravel' || e.phys.wh[wi].surf === 'grass') && spdAbs > 18 && Math.random() < dt * 22) {
          world.addSmoke(wx, wy, (d.u || 0) * cp * 0.2, (d.u || 0) * sp * 0.2, 1.6, e.phys.wh[wi].surf === 'gravel' ? 0.3 : 0.22);
        }
      }
      // sparks from the plank at high downforce loads / kerbs
      if (e.phys && e.phys.speed > 55 && (e.phys.rumble || (e.phys.downforce > 17000 && Math.abs(e.phys.gLong) > 1.5)) && Math.random() < dt * 30) {
        world.addSpark(d.x - 1.3 * cp, d.y - 1.3 * sp, 0.1, -(d.u || 0) * cp * 0.25, -(d.u || 0) * sp * 0.25);
      }
    }
  }

  updateCamera(dt) {
    const me = this.meEnt;
    if (!me) return;
    const d = me.disp, cam = this.camera;
    const speed = me.phys ? me.phys.speed : Math.abs(d.u || 0);
    const heading = d.psi;
    if (!this.camInit) { this.camYaw = heading; this.camInit = true; this.camPos.set(d.x, 3, -d.y); }
    this.camYaw += wrapPi(heading - this.camYaw) * (1 - Math.exp(-dt * (this.camMode === 1 ? 5 : 8)));
    const fwd = new THREE.Vector3(Math.cos(this.camYaw), 0, -Math.sin(this.camYaw));
    const car = new THREE.Vector3(d.x, 0, -d.y);
    const shake = ((me.phys ? me.phys.rumble * 0.03 : 0) + (this.shake || 0) * 0.5) * (0.5 + Math.random());
    this.shake = (this.shake || 0) * Math.exp(-dt * 5);
    let fov = 60;
    if (this.camMode === 0 || this.camMode === 1) {
      const dist = this.camMode === 0 ? 7.2 : 12, h = this.camMode === 0 ? 2.6 : 4.4;
      const target = car.clone().addScaledVector(fwd, -dist).add(new THREE.Vector3(0, h, 0));
      this.camPos.lerp(target, 1 - Math.exp(-dt * 12));
      cam.position.copy(this.camPos).add(new THREE.Vector3(0, shake, shake * 0.6));
      cam.lookAt(car.clone().addScaledVector(fwd, 9).add(new THREE.Vector3(0, 0.8, 0)));
      fov = 62 + clamp(speed * 0.13, 0, 14);
    } else {
      const p = this.camMode === 2 ? [1.7, 0.72] : [-0.2, 1.5];
      const pos = car.clone().addScaledVector(new THREE.Vector3(Math.cos(heading), 0, -Math.sin(heading)), p[0]).add(new THREE.Vector3(0, p[1] + shake, 0));
      cam.position.copy(pos);
      const look = new THREE.Vector3(Math.cos(this.camYaw), 0, -Math.sin(this.camYaw));
      cam.lookAt(pos.clone().addScaledVector(look, 30).add(new THREE.Vector3(0, -0.5, 0)));
      fov = this.camMode === 2 ? 78 + clamp(speed * 0.1, 0, 16) : 74 + clamp(speed * 0.1, 0, 14);
      this.camPos.copy(pos);
    }
    if (Math.abs(cam.fov - fov) > 0.05) { cam.fov += (fov - cam.fov) * (1 - Math.exp(-dt * 6)); cam.updateProjectionMatrix(); }
  }

  updateAudio(dt) {
    const a = this.audio;
    if (!a.ctx) return;
    const me = this.meEnt;
    if (!me) return;
    const c = me.phys;
    if (c) {
      a.engine('me', c.rpm, this.started ? c.thr : this.driver.throttle, 1, 0, 1, true);
      const off = c.wh[2].surf === 'gravel' || c.wh[2].surf === 'grass' ? 1 : 0;
      a.effects(c.speed, c.squeal, c.rumble, off);
    }
    const cam = this.camera.position;
    const list = [];
    for (const e of this.ents.values()) {
      if (e === me) continue;
      const dx = e.disp.x - cam.x, dy = e.disp.y + cam.z;
      list.push([e, Math.hypot(dx, dy), dx, dy]);
    }
    list.sort((p, q) => p[1] - q[1]);
    const keep = new Set(['me']);
    const yaw = this.camYaw;
    list.slice(0, 6).forEach(([e, dist, dx, dy]) => {
      if (dist > 320) return;
      keep.add(e.id);
      const vol = clamp(1 / (1 + dist / 18), 0, 1) * 0.9;
      const ang = Math.atan2(dy, dx) - yaw;
      const pan = clamp(-Math.sin(ang), -1, 1);
      const rv = ((e.disp.u || 0) * Math.cos(e.disp.psi) * dx + (e.disp.u || 0) * Math.sin(e.disp.psi) * dy) / Math.max(dist, 1);
      const myv = c ? (c.u * Math.cos(c.psi) * dx + c.u * Math.sin(c.psi) * dy) / Math.max(dist, 1) : 0;
      const pitch = clamp((343 + myv) / (343 + rv), 0.85, 1.18);
      a.engine(e.id, e.disp.rpm || e.rpm, e.disp.thr || 0, vol, pan, pitch, false);
    });
    for (const id of [...a.voices.keys()]) if (!keep.has(id)) a.dropVoice(id);
  }

  updateHud(dt, perf, poll) {
    if (perf - this.hudT < 55) return;
    this.hudT = perf;
    const T = this.track, me = this.meEnt;
    if (!me) return;
    const ents = [...this.ents.values()];
    ents.sort((a, b) => {
      if (a.finished && b.finished) return a.finPos - b.finPos;
      if (a.finished) return -1; if (b.finished) return 1;
      return b.prog - a.prog;
    });
    const lead = ents[0];
    const order = ents.map((e, i) => {
      let gap = '';
      if (i > 0) {
        const lapsDown = Math.floor(lead.prog / T.length) - Math.floor(e.prog / T.length);
        const dist = lead.prog - e.prog;
        gap = lapsDown >= 1 && dist > T.length * 0.95 ? `+${lapsDown}L` : `+${(dist / Math.max(60, Math.abs(e.speed || 0) + 30)).toFixed(1)}`;
        if (lead.finished && e.finished) gap = e.finTime != null && lead.finTime != null ? `+${(e.finTime - lead.finTime).toFixed(1)}` : '';
      }
      return { id: e.id, name: e.name, color: e.color, num: e.num, gap, isMe: e.isMe, finished: e.finished, bot: e.bot };
    });
    const c = me.phys;
    const lapDone = clamp(me.lap, 0, this.laps - 1) + 1;
    const lapNow = me.finished ? me.last || 0 : Math.max(0, this.simT - me.lapStart);
    let delta = null;
    if (this.bestTrace && this.started && !me.finished) {
      const bucket = Math.floor(((me.prog % T.length) / T.length) * 200);
      const ref = this.bestTrace[clamp(bucket, 0, 199)];
      if (ref !== undefined && this.curTrace[bucket] !== undefined) delta = this.curTrace[bucket] - ref;
    }
    // wrong way
    if (c && this.started && c.speed > 8) {
      const loc = T.locate(c.x, c.y, me.idx);
      const dot = Math.cos(c.psi) * T.tx[loc.i] + Math.sin(c.psi) * T.ty[loc.i];
      this.wrongWayT = dot < -0.4 && c.u > 0 ? this.wrongWayT + 0.055 : 0;
    }
    const pos = order.findIndex((o) => o.isMe) + 1;
    this.hud.update({
      speed: c ? c.speed * 3.6 : 0, gear: c ? c.gear : 1, rpm: c ? c.rpm : 0, thr: c ? c.thr : 0, brk: c ? c.brk : 0,
      lap: lapDone, laps: this.laps, pos, total: order.length, time: this.simT, curLap: lapNow, best: me.best, last: me.last, delta,
      order, fuel: c ? c.fuel : 0, wear: c ? c.wear : [0, 0, 0, 0], compound: c ? c.compound : 'medium',
      gLat: c ? c.gLat : 0, gLong: c ? c.gLong : 0, auto: this.driver.auto, ping: this.net ? this.net.rtt : 0,
      wrongWay: this.wrongWayT > 1.5, finished: me.finished, offTrack: c ? c.onSurf === 'grass' || c.onSurf === 'gravel' : false,
      cars: ents.map((e) => ({ x: e.disp.x, y: e.disp.y, color: e.color, me: e.isMe })), cam: CAMS[this.camMode],
      stuck: c && this.started && c.speed < 2 && !me.finished,
      kers: c ? c.kers : 0, boosting: c ? c.boosting : false, drs: me.drsOpen ? 2 : me.drsOk ? 1 : 0, tyreT: c ? c.tyreT : [0, 0, 0, 0], damage: c ? c.damage : 0,
    });
  }

  toggleLine(force) {
    if (!this.profile) this.profile = buildSpeedProfile(this.track, 1);
    const on = force !== undefined ? force : !this.lineOn;
    this.lineOn = on; this.prefs.line = on;
    this.world.setRacingLine(on, this.profile);
    if (force === undefined) this.hud.toast(on ? 'Racing line on' : 'Racing line off');
  }

  destroy() {
    this.destroyed = true;
    if (this.net && this._h) for (const k in this._h) this.net.off(k, this._h[k]);
    for (const e of this.ents.values()) { this.world.carGroup.remove(e.model); disposeModel(e.model); }
    this.ents.clear();
    this.audio.silenceAll();
    this.world.setRacingLine(false);
  }
}

const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;
export function fmt(t) {
  if (t == null || !isFinite(t)) return '--:--.---';
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}
