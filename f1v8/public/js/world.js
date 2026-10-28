// Three.js world: renderer, sky, lights, track geometry, scenery, and effects (skids, smoke, sparks).
// Sim (X east, Y north) maps to three (x = X, z = -Y, y = height).
import * as THREE from 'three';
import { mulberry32 } from './tracks.js';

const MAX_SKID = 9000;

function canvasTex(w, h, draw, repeat = true) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}
function speckle(g, w, h, n, alpha, light = true) {
  for (let i = 0; i < n; i++) {
    const v = light ? 120 + Math.random() * 120 : Math.random() * 60;
    g.fillStyle = `rgba(${v},${v},${v},${alpha * Math.random()})`;
    g.fillRect(Math.random() * w, Math.random() * h, 1 + Math.random() * 2, 1 + Math.random() * 2);
  }
}

const PRESETS = {
  day: { top: 0x3f7fd6, horizon: 0xcfe3f5, fog: 0xbfd6ec, sun: 0xfff1d6, sunI: 3.0, hemiSky: 0xbcd6ff, hemiGround: 0x4a5a3a, hemiI: 1.05, sunDir: [0.5, 0.78, 0.35], exposure: 1.0 },
  golden: { top: 0x3a4f8f, horizon: 0xffc58a, fog: 0xe8b98d, sun: 0xffb36b, sunI: 3.4, hemiSky: 0xffd2a8, hemiGround: 0x3d3326, hemiI: 0.9, sunDir: [0.85, 0.32, 0.25], exposure: 1.0 },
  overcast: { top: 0x7d8794, horizon: 0xc9ced4, fog: 0xbcc2c8, sun: 0xe6ebf2, sunI: 1.6, hemiSky: 0xd7dde6, hemiGround: 0x4b5545, hemiI: 1.35, sunDir: [0.3, 0.8, 0.4], exposure: 1.0 },
};

class Particles {
  constructor(max, additive, color, tex) {
    this.max = max; this.n = 0; this.head = 0;
    this.pos = new Float32Array(max * 3); this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max); this.maxLife = new Float32Array(max);
    this.size = new Float32Array(max); this.size0 = new Float32Array(max); this.alpha = new Float32Array(max); this.a0 = new Float32Array(max);
    this.grow = new Float32Array(max);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('size', new THREE.BufferAttribute(this.size, 1));
    g.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1));
    this.rise = 0.4; this.drag = 1.2;
    const m = new THREE.ShaderMaterial({
      uniforms: { map: { value: tex }, color: { value: new THREE.Color(color) }, scale: { value: 500 } },
      vertexShader: `attribute float size; attribute float alpha; varying float vA; uniform float scale;
        void main(){ vA=alpha; vec4 mv=modelViewMatrix*vec4(position,1.0); gl_PointSize=size*scale/max(1.0,-mv.z); gl_Position=projectionMatrix*mv; }`,
      fragmentShader: `uniform sampler2D map; uniform vec3 color; varying float vA;
        void main(){ vec4 t=texture2D(map,gl_PointCoord); gl_FragColor=vec4(color,t.a*vA); }`,
      transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(g, m);
    this.points.frustumCulled = false;
    this.additive = additive;
    for (let i = 0; i < max; i++) this.pos[i * 3 + 1] = -1000;
  }
  emit(x, y, z, vx, vy, vz, life, size, alpha, grow = 3) {
    const i = this.head; this.head = (this.head + 1) % this.max;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.life[i] = this.maxLife[i] = life; this.size0[i] = size; this.a0[i] = alpha; this.grow[i] = grow;
  }
  update(dt, gravity = 0) {
    const k = Math.exp(-this.drag * dt);
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) { this.alpha[i] = 0; continue; }
      this.life[i] -= dt;
      const t = 1 - Math.max(0, this.life[i]) / this.maxLife[i];
      const o = i * 3;
      this.vel[o] *= k; this.vel[o + 2] *= k; this.vel[o + 1] = this.vel[o + 1] * k + (this.rise - gravity) * dt;
      this.pos[o] += this.vel[o] * dt; this.pos[o + 1] += this.vel[o + 1] * dt; this.pos[o + 2] += this.vel[o + 2] * dt;
      if (this.pos[o + 1] < 0.02 && gravity > 0) { this.pos[o + 1] = 0.02; this.vel[o + 1] *= -0.3; }
      this.size[i] = this.size0[i] * (1 + this.grow[i] * t);
      this.alpha[i] = this.a0[i] * (1 - t) * (t < 0.1 ? t * 10 : 1);
    }
    const g = this.points.geometry;
    g.attributes.position.needsUpdate = true; g.attributes.size.needsUpdate = true; g.attributes.alpha.needsUpdate = true;
  }
}

export class World {
  constructor(canvas) {
    this.canvas = canvas;
    const r = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    r.shadowMap.enabled = true; r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(65, 1, 0.4, 9000);
    this.scene.add(this.camera);

    this.hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera; sc.left = -70; sc.right = 70; sc.top = 70; sc.bottom = -70; sc.near = 1; sc.far = 400;
    this.sun.shadow.bias = -0.0004; this.sun.shadow.normalBias = 0.04;
    this.scene.add(this.sun, this.sun.target);

    // sky dome
    this.skyMat = new THREE.ShaderMaterial({
      uniforms: { top: { value: new THREE.Color() }, horizon: { value: new THREE.Color() }, sunDir: { value: new THREE.Vector3(0.5, 0.7, 0.3) }, sunCol: { value: new THREE.Color() } },
      vertexShader: 'varying vec3 vD; void main(){ vD=normalize(position); gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
      fragmentShader: `uniform vec3 top; uniform vec3 horizon; uniform vec3 sunDir; uniform vec3 sunCol; varying vec3 vD;
        void main(){ float h=clamp(vD.y,0.0,1.0); vec3 c=mix(horizon,top,pow(h,0.55));
          float s=max(dot(normalize(vD),normalize(sunDir)),0.0); c+=sunCol*(pow(s,600.0)*2.0+pow(s,8.0)*0.25);
          gl_FragColor=vec4(c,1.0);}`,
      side: THREE.BackSide, depthWrite: false, fog: false,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(5000, 24, 16), this.skyMat);
    this.sky.renderOrder = -10; this.sky.frustumCulled = false;
    this.scene.add(this.sky);

    this.scene.fog = new THREE.Fog(0xbfd6ec, 500, 3200);

    // ground
    this.grassTex = canvasTex(256, 256, (g, w, h) => {
      g.fillStyle = '#3d6b2a'; g.fillRect(0, 0, w, h);
      for (let i = 0; i < 2600; i++) { const v = Math.random(); g.fillStyle = `rgba(${40 + v * 40},${90 + v * 60},${30 + v * 20},0.35)`; g.fillRect(Math.random() * w, Math.random() * h, 2, 2 + Math.random() * 4); }
    });
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(40000, 40000), new THREE.MeshStandardMaterial({ map: this.grassTex, roughness: 1 }));
    this.ground.rotation.x = -Math.PI / 2; this.ground.position.y = -0.08; this.ground.receiveShadow = true;
    this.grassTex.repeat.set(40000 / 14, 40000 / 14);
    this.scene.add(this.ground);

    this.asphaltTex = canvasTex(256, 256, (g, w, h) => {
      g.fillStyle = '#3b3c40'; g.fillRect(0, 0, w, h);
      speckle(g, w, h, 4500, 0.22, true); speckle(g, w, h, 2500, 0.25, false);
    });
    this.gravelTex = canvasTex(128, 128, (g, w, h) => {
      g.fillStyle = '#b7a57b'; g.fillRect(0, 0, w, h);
      speckle(g, w, h, 2500, 0.5, true); speckle(g, w, h, 1200, 0.4, false);
    });
    this.crowdTex = canvasTex(256, 64, (g, w, h) => {
      g.fillStyle = '#24262c'; g.fillRect(0, 0, w, h);
      const cols = ['#e63946', '#f1faee', '#457b9d', '#ffd166', '#06d6a0', '#ef476f', '#118ab2', '#ffffff'];
      for (let i = 0; i < 1800; i++) { g.fillStyle = cols[(Math.random() * cols.length) | 0]; g.fillRect(Math.random() * w, Math.random() * h, 2, 2); }
    });
    this.checkerTex = canvasTex(128, 32, (g, w, h) => {
      const s = 16;
      for (let y = 0; y < h / s; y++) for (let x = 0; x < w / s; x++) { g.fillStyle = (x + y) % 2 ? '#fff' : '#111'; g.fillRect(x * s, y * s, s, s); }
    });

    this.trackGroup = new THREE.Group();
    this.scene.add(this.trackGroup);
    this.carGroup = new THREE.Group();
    this.scene.add(this.carGroup);

    // effects
    const dot = canvasTex(64, 64, (g, w, h) => {
      const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.5, 'rgba(255,255,255,0.45)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr; g.fillRect(0, 0, w, h);
    }, false);
    this.smoke = new Particles(500, false, 0xdddddd, dot); this.smoke.rise = 0.6; this.smoke.drag = 1.1;
    this.sparks = new Particles(300, true, 0xffa040, dot); this.sparks.rise = 0; this.sparks.drag = 0.6;
    this.scene.add(this.smoke.points, this.sparks.points);

    const sg = new THREE.BufferGeometry();
    this.skidPos = new Float32Array(MAX_SKID * 4 * 3);
    sg.setAttribute('position', new THREE.BufferAttribute(this.skidPos, 3));
    const idx = new Uint32Array(MAX_SKID * 6);
    for (let i = 0; i < MAX_SKID; i++) { const b = i * 4; idx.set([b, b + 1, b + 2, b + 1, b + 3, b + 2], i * 6); }
    sg.setIndex(new THREE.BufferAttribute(idx, 1));
    sg.setDrawRange(0, 0);
    this.skidMesh = new THREE.Mesh(sg, new THREE.MeshBasicMaterial({ color: 0x050505, transparent: true, opacity: 0.38, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }));
    this.skidMesh.frustumCulled = false;
    this.skidHead = 0; this.skidCount = 0;
    this.scene.add(this.skidMesh);

    this.showroom = null;
    this.setPreset('day');
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  setPreset(name) {
    const p = PRESETS[name] || PRESETS.day;
    this.preset = p;
    this.skyMat.uniforms.top.value.set(p.top);
    this.skyMat.uniforms.horizon.value.set(p.horizon);
    this.skyMat.uniforms.sunCol.value.set(p.sun).multiplyScalar(0.7);
    const d = new THREE.Vector3(...p.sunDir).normalize();
    this.sunDir = d;
    this.skyMat.uniforms.sunDir.value.copy(d);
    this.scene.fog.color.set(p.fog);
    this.sun.color.set(p.sun); this.sun.intensity = p.sunI;
    this.hemi.color.set(p.hemiSky); this.hemi.groundColor.set(p.hemiGround); this.hemi.intensity = p.hemiI;
    this.renderer.toneMappingExposure = p.exposure;
  }

  resize() {
    const w = this.canvas.clientWidth || innerWidth, h = this.canvas.clientHeight || innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    const s = h / 2 / Math.tan((this.camera.fov * Math.PI) / 360);
    this.smoke.points.material.uniforms.scale.value = s; this.sparks.points.material.uniforms.scale.value = s;
  }

  clearTrack() {
    this.trackGroup.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    this.trackGroup.clear();
    this.rlMesh = null;
    this.skidCount = 0; this.skidHead = 0; this.skidMesh.geometry.setDrawRange(0, 0);
  }

  // ------------------------------------------------------------------ track geometry
  setTrack(track, seedForLook = 0) {
    this.clearTrack();
    this.track = track;
    const looks = ['day', 'day', 'golden', 'overcast'];
    this.setPreset(looks[Math.abs(seedForLook | 0) % looks.length]);
    const T = track, n = T.n, g = this.trackGroup;
    const P = (i, off, h) => [T.x[i] + T.nx[i] * off, h, -(T.y[i] + T.ny[i] * off)];

    // generic ribbon between two offset functions; indices [i0..i1) in the circular array
    const ribbon = ({ a, b, y, uvU = 1, uvV = 1 / 6, colors, only }) => {
      const pos = [], uv = [], col = [], idx = [];
            for (let i = 0; i <= n; i++) {
        const k = i % n;
        const [ax, ay, az] = P(k, a(k), y), [bx, by, bz] = P(k, b(k), y);
        pos.push(ax, ay, az, bx, by, bz);
        const v = i * T.ds * uvV;
        uv.push(0, v, uvU, v);
        if (colors) { const c = colors(k, i); col.push(c[0], c[1], c[2], c[0], c[1], c[2]); }
        if (i > 0) {
          const include = only ? only((i - 1) % n) && only(k) : true;
          if (include) { const p = (i - 1) * 2; idx.push(p, p + 1, p + 2, p + 1, p + 3, p + 2); }
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      if (colors) geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      return geo;
    };
    const decalMat = (extra) => new THREE.MeshStandardMaterial({ roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, ...extra });

    // asphalt
    const aTex = this.asphaltTex.clone(); aTex.needsUpdate = true;
    aTex.repeat.set(T.spec.width ? T.spec.width / 6 : 2.5, 1);
    const asphalt = new THREE.Mesh(ribbon({ a: (i) => T.hw[i], b: (i) => -T.hw[i], y: 0.02, uvU: 1, uvV: 1 }),
      new THREE.MeshStandardMaterial({ map: aTex, roughness: 0.93 }));
    // v coordinate in metres so texture repeats every 6 m
    {
      const uv = asphalt.geometry.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setY(i, uv.getY(i) / 6);
    }
    asphalt.receiveShadow = true; g.add(asphalt);

    // gravel trap (circuits) or tarmac run-off (streets)
    if (!T.street) {
      const gt = this.gravelTex.clone(); gt.needsUpdate = true; gt.repeat.set(1, 1);
      for (const s of [1, -1]) {
        const geo = ribbon({ a: (i) => s * (T.hw[i] + T.grassW), b: (i) => s * (T.hw[i] + T.grassW + T.gravelW), y: 0.01, uvU: 4, uvV: 1 / 5 });
        const m = new THREE.Mesh(geo, decalMat({ map: gt, side: THREE.DoubleSide, roughness: 1 }));
        m.receiveShadow = true; g.add(m);
      }
    } else {
      for (const s of [1, -1]) {
        const geo = ribbon({ a: (i) => s * T.hw[i], b: (i) => s * (T.wall[i]), y: 0.015, uvU: 1, uvV: 1 });
        const uv = geo.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setY(i, uv.getY(i) / 6);
        const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: aTex, color: 0x9a9a9a, roughness: 0.95, side: THREE.DoubleSide }));
        m.receiveShadow = true; g.add(m);
      }
    }

    // white edge lines
    for (const s of [1, -1]) {
      const geo = ribbon({ a: (i) => s * (T.hw[i] - 0.2), b: (i) => s * (T.hw[i] - 0.5), y: 0.032, uvU: 1, uvV: 1 });
      g.add(new THREE.Mesh(geo, decalMat({ color: 0xe8e8e8, side: THREE.DoubleSide })));
    }
    // kerbs
    for (const [bit, s] of [[1, 1], [2, -1]]) {
      const geo = ribbon({
        a: (i) => s * (T.hw[i] - 0.1), b: (i) => s * (T.hw[i] + T.kerbW), y: 0.045, uvU: 1, uvV: 1,
        only: (i) => (T.kerb[i] & bit) !== 0,
        colors: (k, i) => (Math.floor((i * T.ds) / 1.5) % 2 ? [0.85, 0.08, 0.08] : [0.95, 0.95, 0.95]),
      });
      g.add(new THREE.Mesh(geo, decalMat({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.7 })));
    }

    // barriers
    const wallH = T.street ? 1.35 : 1.0;
    const wallGeo = (s) => {
      const pos = [], col = [], idx = [];
      for (let i = 0; i <= n; i++) {
        const k = i % n, off = s * T.wall[k];
        const b = P(k, off, 0), t = P(k, off, wallH);
        pos.push(...b, ...t);
        const alt = Math.floor((i * T.ds) / 4) % 2;
        const c = T.street ? (alt ? [0.82, 0.82, 0.84] : [0.62, 0.64, 0.68]) : (alt ? [0.9, 0.1, 0.1] : [0.92, 0.92, 0.92]);
        col.push(...c, ...c);
        if (i > 0) { const p = (i - 1) * 2; idx.push(p, p + 1, p + 2, p + 1, p + 3, p + 2); }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      geo.setIndex(idx); geo.computeVertexNormals();
      return geo;
    };
    for (const s of [1, -1]) {
      const m = new THREE.Mesh(wallGeo(s), new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.8 }));
      m.castShadow = true; m.receiveShadow = true; g.add(m);
    }

    // start / finish line + grid boxes
    {
      const across = new THREE.Vector3(T.nx[0], 0, -T.ny[0]);
      const fwd = new THREE.Vector3(T.tx[0], 0, -T.ty[0]);
      const L = new THREE.Mesh(new THREE.PlaneGeometry(T.hw[0] * 2, 2.4), decalMat({ map: this.checkerTex, side: THREE.DoubleSide }));
      // plane: local x across the track, local y along it, normal up (across x -fwd = +y)
      L.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(across, fwd.clone().negate(), new THREE.Vector3(0, 1, 0)));
      L.position.set(T.x[0], 0.05, -T.y[0]);
      g.add(L);

      const hx = 2.0, hz = 0.75, t = 0.08, verts = [];
      const quad = (x0, z0, x1, z1) => { verts.push(x0, 0, z0, x1, 0, z0, x0, 0, z1, x1, 0, z0, x1, 0, z1, x0, 0, z1); };
      quad(-hx, -hz, hx, -hz + t); quad(-hx, hz - t, hx, hz); quad(-hx, -hz, -hx + t, hz);
      const boxGeo = new THREE.BufferGeometry();
      boxGeo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3)); boxGeo.computeVertexNormals();
      const boxMat = decalMat({ color: 0xf2f2f2, side: THREE.DoubleSide });
      for (let k = 0; k < 22; k++) {
        const s = T.gridSlot(k);
        const mk = new THREE.Mesh(boxGeo, boxMat);
        mk.position.set(s.x, 0.048, -s.y); mk.rotation.y = s.psi;
        g.add(mk);
      }
    }

    this._buildScenery(T, g);
    this.fitShadow();
  }

  _buildScenery(T, g) {
    const rnd = mulberry32(Math.floor(T.length * 13) + T.n);
    const n = T.n;
    const toThree = (x, y, h = 0) => new THREE.Vector3(x, h, -y);

    // start gantry
    {
      const hw = T.hw[0] + 1.6;
      const mat = new THREE.MeshStandardMaterial({ color: 0x23262d, roughness: 0.6, metalness: 0.4 });
      const red = new THREE.MeshStandardMaterial({ color: 0xe10600, roughness: 0.5 });
      const grp = new THREE.Group();
      for (const s of [-1, 1]) { const p = new THREE.Mesh(new THREE.BoxGeometry(0.8, 8, 0.8), mat); p.position.set(0, 4, s * hw); p.castShadow = true; grp.add(p); }
      const beam = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.6, hw * 2 + 0.8), mat); beam.position.set(0, 8.4, 0); beam.castShadow = true; grp.add(beam);
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(2.25, 0.3, hw * 2 + 0.85), red); stripe.position.set(0, 7.5, 0); grp.add(stripe);
      for (let k = 0; k < 5; k++) { const l = new THREE.Mesh(new THREE.CircleGeometry(0.28, 14), new THREE.MeshBasicMaterial({ color: 0x300000 })); l.position.set(1.12, 8.4, (k - 2) * 1.0); l.rotation.y = Math.PI / 2; grp.add(l); }
      grp.position.set(T.x[0], 0, -T.y[0]);
      grp.rotation.y = Math.atan2(T.ty[0], T.tx[0]);
      g.add(grp);
    }

    // grandstands along the start straight
    {
      const roofMat = new THREE.MeshStandardMaterial({ color: 0xdadde3, roughness: 0.6 });
      const stand = (fi, side, len) => {
        const p = T.pointAt(fi, side * (T.wall[0] + 9));
        const grp = new THREE.Group();
        const mat = new THREE.MeshStandardMaterial({ map: this.crowdTex.clone(), roughness: 0.9 });
        mat.map.needsUpdate = true; mat.map.repeat.set(len / 12, 1);
        for (let r = 0; r < 4; r++) {
          const h = 2 * (r + 1);
          const step = new THREE.Mesh(new THREE.BoxGeometry(len, h, 3.2), mat);
          step.position.set(0, h / 2, r * 3.2);
          step.castShadow = true; step.receiveShadow = true;
          grp.add(step);
        }
        const roof = new THREE.Mesh(new THREE.BoxGeometry(len + 2, 0.4, 14), roofMat);
        roof.position.set(0, 11, 5); roof.castShadow = true; grp.add(roof);
        // local +z points away from the track
        const t3 = new THREE.Vector3(Math.cos(p.psi), 0, -Math.sin(p.psi));
        const x = side > 0 ? t3.clone().negate() : t3.clone();
        const basis = new THREE.Matrix4().makeBasis(x, new THREE.Vector3(0, 1, 0), new THREE.Vector3().crossVectors(x, new THREE.Vector3(0, 1, 0)));
        grp.quaternion.setFromRotationMatrix(basis);
        grp.position.set(p.x, 0, -p.y);
        g.add(grp);
      };
      for (const f of [-70, -30, 10, 50]) { stand(f / T.ds, 1, 34); stand(f / T.ds, -1, 34); }
    }

    // advertising boards along the barriers
    {
      const names = ['VELOCE', 'ARDENT OIL', 'NOVA TYRES', 'TURBINE', 'HELIX', 'APEX'];
      const cols = ['#e10600', '#0a58ca', '#ffd100', '#10a37f', '#7c3aed', '#f97316'];
      const tex = names.map((nm, i) => canvasTex(512, 96, (c, w, h) => {
        c.fillStyle = cols[i]; c.fillRect(0, 0, w, h);
        c.fillStyle = i === 2 ? '#111' : '#fff'; c.font = '700 64px Arial Narrow, Arial, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
        c.fillText(nm, w / 2, h / 2 + 3);
      }, false));
      const geo = new THREE.PlaneGeometry(8, 1.1);
      const buckets = names.map(() => []);
      const step = Math.round(36 / T.ds);
      let c = 0;
      for (let i = 4; i < n; i += step) {
        for (const s of [1, -1]) {
          const off = s * (T.wall[i] - 0.06);
          const px = T.x[i] + T.nx[i] * off, pz = -(T.y[i] + T.ny[i] * off);
          const t3 = new THREE.Vector3(T.tx[i], 0, -T.ty[i]), l3 = new THREE.Vector3(T.nx[i], 0, -T.ny[i]);
          const x = s > 0 ? t3.clone() : t3.clone().negate();
          const z = s > 0 ? l3.clone().negate() : l3.clone();
          const y = new THREE.Vector3(0, 1, 0);
          const m = new THREE.Matrix4().makeBasis(x, y, z);
          m.setPosition(px, (T.street ? 0.75 : 0.55), pz);
          buckets[(c++ + (s > 0 ? 3 : 0)) % names.length].push(m);
        }
      }
      buckets.forEach((arr, i) => {
        if (!arr.length) return;
        const im = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ map: tex[i], side: THREE.DoubleSide, fog: true }), arr.length);
        arr.forEach((m, k) => im.setMatrixAt(k, m));
        g.add(im);
      });
    }

    // trees and distant hills
    {
      const cand = [];
      const b = T.bounds, pad = 700;
      const stride = 4;
      const near = (x, y) => {
        let best = Infinity;
        for (let i = 0; i < n; i += stride) {
          const dx = x - T.x[i], dy = y - T.y[i];
          const d2 = dx * dx + dy * dy;
          if (d2 < best) best = d2;
        }
        return Math.sqrt(best);
      };
      const want = T.street ? 220 : 1100;
      let tries = 0;
      while (cand.length < want && tries < want * 6) {
        tries++;
        const x = b.minx - pad + rnd() * (b.maxx - b.minx + pad * 2), y = b.miny - pad + rnd() * (b.maxy - b.miny + pad * 2);
        const d = near(x, y);
        const minD = (T.street ? 30 : T.wall[0] + 14);
        if (d > minD && d < 520) cand.push([x, y, 0.7 + rnd() * 0.9, rnd()]);
      }
      const trunkGeo = new THREE.CylinderGeometry(0.3, 0.45, 3, 6); trunkGeo.translate(0, 1.5, 0);
      const crownGeo = new THREE.ConeGeometry(2.6, 8, 7); crownGeo.translate(0, 6.5, 0);
      const crown2 = new THREE.ConeGeometry(2.0, 6, 7); crown2.translate(0, 10, 0);
      const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshStandardMaterial({ color: 0x4a3322, roughness: 1 }), cand.length);
      const crowns = new THREE.InstancedMesh(crownGeo, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1 }), cand.length);
      const crowns2 = new THREE.InstancedMesh(crown2, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1 }), cand.length);
      const m = new THREE.Matrix4(), col = new THREE.Color();
      cand.forEach(([x, y, s, r], i) => {
        m.compose(new THREE.Vector3(x, 0, -y), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, r * 6.28, 0)), new THREE.Vector3(s, s * (0.9 + r * 0.4), s));
        trunks.setMatrixAt(i, m); crowns.setMatrixAt(i, m); crowns2.setMatrixAt(i, m);
        col.setHSL(0.27 + r * 0.08, 0.45, 0.18 + r * 0.1); crowns.setColorAt(i, col); crowns2.setColorAt(i, col);
      });
      trunks.castShadow = crowns.castShadow = crowns2.castShadow = false;
      g.add(trunks, crowns, crowns2);

      // distant hills
      const hills = new THREE.Group();
      const hm = new THREE.MeshStandardMaterial({ color: 0x5a6f55, roughness: 1, flatShading: true });
      const cx = (b.minx + b.maxx) / 2, cy = (b.miny + b.maxy) / 2;
      const R = Math.max(b.maxx - b.minx, b.maxy - b.miny) * 0.5 + 1700;
      for (let i = 0; i < 46; i++) {
        const a = rnd() * Math.PI * 2, r = R + rnd() * 700;
        const h = 120 + rnd() * 380, w = 260 + rnd() * 420;
        const cone = new THREE.Mesh(new THREE.ConeGeometry(w, h, 6 + ((rnd() * 3) | 0)), hm);
        cone.position.set(cx + Math.cos(a) * r, h / 2 - 8, -(cy + Math.sin(a) * r));
        hills.add(cone);
      }
      g.add(hills);
    }
  }

  // racing line overlay (green = on throttle, yellow = lift, red = brake)
  setRacingLine(visible, profile) {
    if (!this.track) return;
    if (!visible) { if (this.rlMesh) this.rlMesh.visible = false; return; }
    if (!this.rlMesh && profile) {
      const T = this.track, n = T.n, rl = T.racingLine();
      const pos = [], col = [], idx = [];
      for (let i = 0; i <= n; i++) {
        const k = i % n;
        const nx = rl.x[(k + 1) % n] - rl.x[(k + n - 1) % n], ny = rl.y[(k + 1) % n] - rl.y[(k + n - 1) % n];
        const l = Math.hypot(nx, ny) || 1;
        const sx = -ny / l * 0.45, sy = nx / l * 0.45;
        pos.push(rl.x[k] + sx, 0.07, -(rl.y[k] + sy), rl.x[k] - sx, 0.07, -(rl.y[k] - sy));
        const ahead = profile[(k + 8) % n] - profile[k];
        const c = ahead < -1.2 ? [1, 0.15, 0.1] : ahead < 0.6 && profile[k] < 85 ? [1, 0.85, 0.15] : [0.1, 0.9, 0.35];
        col.push(...c, ...c);
        if (i > 0) { const p = (i - 1) * 2; idx.push(p, p + 1, p + 2, p + 1, p + 3, p + 2); }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      geo.setIndex(idx);
      this.rlMesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6 }));
      this.trackGroup.add(this.rlMesh);
    }
    if (this.rlMesh) this.rlMesh.visible = true;
  }

  fitShadow() {}

  // ------------------------------------------------------------------ effects
  addSkid(x0, y0, x1, y1, width = 0.38) {
    const dx = x1 - x0, dy = y1 - y0;
    const l = Math.hypot(dx, dy);
    if (l < 0.02 || l > 12) return;
    const nx = (-dy / l) * width * 0.5, ny = (dx / l) * width * 0.5;
    const o = this.skidHead * 12;
    const p = this.skidPos;
    p[o] = x0 + nx; p[o + 1] = 0.06; p[o + 2] = -(y0 + ny);
    p[o + 3] = x0 - nx; p[o + 4] = 0.06; p[o + 5] = -(y0 - ny);
    p[o + 6] = x1 + nx; p[o + 7] = 0.06; p[o + 8] = -(y1 + ny);
    p[o + 9] = x1 - nx; p[o + 10] = 0.06; p[o + 11] = -(y1 - ny);
    this.skidHead = (this.skidHead + 1) % MAX_SKID;
    this.skidCount = Math.min(MAX_SKID, this.skidCount + 1);
    this._skidDirty = true;
  }

  addSmoke(x, y, vx, vy, size = 1.2, alpha = 0.35) {
    this.smoke.emit(x, 0.25, -y, vx * 0.6 + (Math.random() - 0.5) * 1.2, 0.8 + Math.random() * 0.6, -vy * 0.6 + (Math.random() - 0.5) * 1.2, 1.1 + Math.random() * 0.8, size, alpha, 4);
  }

  addSpark(x, y, h, vx, vy) {
    const sp = 6 + Math.random() * 8;
    this.sparks.emit(x, h, -y, vx * 0.3 + (Math.random() - 0.5) * sp, 1.5 + Math.random() * 3, -vy * 0.3 + (Math.random() - 0.5) * sp, 0.25 + Math.random() * 0.4, 0.28, 1, 0.1);
  }

  updateEffects(dt) {
    this.smoke.update(dt, 0);
    this.sparks.update(dt, 9);
    if (this._skidDirty) {
      const g = this.skidMesh.geometry;
      g.attributes.position.needsUpdate = true;
      g.setDrawRange(0, this.skidCount * 6);
      this._skidDirty = false;
    }
  }

  // keep the shadow frustum centred on the action and the sky on the camera
  follow(x, y) {
    const d = this.sunDir;
    this.sun.position.set(x + d.x * 150, d.y * 150, -y + d.z * 150);
    this.sun.target.position.set(x, 0, -y);
    this.sun.target.updateMatrixWorld();
    this.sky.position.copy(this.camera.position);
  }

  render() { this.renderer.render(this.scene, this.camera); }

  // ------------------------------------------------------------------ showroom (menu background)
  setShowroom(on, model) {
    if (this.showroom) { this.scene.remove(this.showroom.group); this.showroom = null; }
    this.ground.visible = true;
    if (!on) return;
    const group = new THREE.Group();
    const floor = new THREE.Mesh(new THREE.CircleGeometry(60, 64), new THREE.MeshStandardMaterial({ color: 0x15161a, roughness: 0.35, metalness: 0.6 }));
    floor.rotation.x = -Math.PI / 2; floor.position.y = 0.01; floor.receiveShadow = true; group.add(floor);
    const ring = new THREE.Mesh(new THREE.RingGeometry(5.5, 5.7, 64), new THREE.MeshBasicMaterial({ color: 0xe10600, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.02; group.add(ring);
    group.position.set(0, 0, 0);
    if (model) { model.position.set(0, 0, 0); group.add(model); }
    this.scene.add(group);
    this.showroom = { group, model };
    this.ground.visible = false;
    this.setPreset('overcast');
    this.scene.background = new THREE.Color(0x0b0c10);
    this.scene.fog.color.set(0x0b0c10); this.scene.fog.near = 60; this.scene.fog.far = 220;
    this.sky.visible = false;
  }
  endShowroom() {
    this.setShowroom(false);
    this.scene.background = null; this.sky.visible = true; this.ground.visible = true;
    this.scene.fog.near = 500; this.scene.fog.far = 3200;
  }
}
