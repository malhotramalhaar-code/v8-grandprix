// Procedural 2006-2013 style F1 car. Model space: +x forward, +y up, +z to the car's right.
import * as THREE from 'three';
import { CAR, COMPOUNDS } from './physics.js';

const tyreMat = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.92, metalness: 0 });
const rimMat = new THREE.MeshStandardMaterial({ color: 0xbfc3c8, roughness: 0.35, metalness: 0.8 });
const carbon = new THREE.MeshStandardMaterial({ color: 0x1a1a1c, roughness: 0.55, metalness: 0.3 });
const steel = new THREE.MeshStandardMaterial({ color: 0x555a60, roughness: 0.4, metalness: 0.8 });

function box(w, h, d, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z); m.castShadow = true;
  return m;
}

function numberTexture(num, color) {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(255,255,255,0.92)'; g.beginPath(); g.arc(64, 64, 58, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#111'; g.font = 'bold 76px Arial Narrow, Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(String(num), 64, 68);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

export function buildCarModel(color = '#e10600', num = 1, compound = 'medium') {
  const root = new THREE.Group();
  const body = new THREE.Group();   // pitches / rolls with load transfer
  root.add(body);
  const col = new THREE.Color(color);
  const lum = col.r * 0.3 + col.g * 0.59 + col.b * 0.11;
  const accentCol = lum > 0.55 ? new THREE.Color(0x101010) : new THREE.Color(0xf2f2f2);
  const paint = new THREE.MeshStandardMaterial({ color: col, roughness: 0.28, metalness: 0.35 });
  const accent = new THREE.MeshStandardMaterial({ color: accentCol, roughness: 0.4, metalness: 0.2 });

  // floor + diffuser
  body.add(box(3.6, 0.05, 1.28, carbon, 0.05, 0.1, 0));
  const diff = box(0.7, 0.18, 1.0, carbon, -2.05, 0.2, 0); diff.rotation.z = -0.28; body.add(diff);

  // tub
  const tub = box(2.3, 0.42, 0.64, paint, 0.15, 0.36, 0); body.add(tub);
  // nose
  const nose = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.3, 2.0, 14), paint);
  nose.rotation.z = Math.PI / 2; nose.position.set(1.95, 0.27, 0); nose.scale.set(1, 1, 1); nose.castShadow = true;
  nose.scale.z = 0.8;
  body.add(nose);
  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.1, 12, 8), paint); tip.position.set(2.95, 0.24, 0); body.add(tip);
  // shoulders / cockpit surround
  body.add(box(1.0, 0.16, 0.7, paint, 0.35, 0.62, 0));
  const cockpit = box(0.62, 0.12, 0.34, new THREE.MeshStandardMaterial({ color: 0x050505, roughness: 0.9 }), 0.35, 0.7, 0);
  body.add(cockpit);
  // driver
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.15, 16, 12), new THREE.MeshStandardMaterial({ color: col.clone().lerp(new THREE.Color(0xffffff), 0.35), roughness: 0.2, metalness: 0.2 }));
  helmet.position.set(0.28, 0.82, 0); helmet.castShadow = true; body.add(helmet);
  const visor = box(0.1, 0.07, 0.22, new THREE.MeshStandardMaterial({ color: 0x0a0a14, roughness: 0.1, metalness: 0.6 }), 0.4, 0.83, 0); body.add(visor);
  // sidepods (tapered)
  for (const s of [-1, 1]) {
    const pod = box(1.7, 0.4, 0.5, paint, -0.55, 0.37, s * 0.58);
    pod.scale.set(1, 1, 1); body.add(pod);
    const inlet = box(0.12, 0.28, 0.4, carbon, 0.35, 0.42, s * 0.58); body.add(inlet);
    const tail = box(0.9, 0.24, 0.3, paint, -1.5, 0.32, s * 0.4); tail.rotation.y = s * 0.05; body.add(tail);
  }
  // engine cover + airbox
  body.add(box(1.7, 0.34, 0.46, paint, -1.0, 0.7, 0));
  const air = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.26, 0.5, 14), accent);
  air.position.set(-0.05, 0.98, 0); air.castShadow = true; body.add(air);
  const airHole = new THREE.Mesh(new THREE.CircleGeometry(0.16, 14), new THREE.MeshBasicMaterial({ color: 0x050505 }));
  airHole.position.set(0.19, 1.0, 0); airHole.rotation.y = Math.PI / 2; airHole.scale.set(1, 1, 1);
  body.add(airHole);
  const fin = box(1.1, 0.4, 0.04, paint, -1.6, 0.95, 0); body.add(fin);
  // exhaust
  for (const s of [-1, 1]) { const ex = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 0.4, 8), steel); ex.rotation.z = Math.PI / 2; ex.position.set(-2.1, 0.5, s * 0.1); body.add(ex); }

  // front wing (grouped so damage can bend it)
  const fw = new THREE.Group(); body.add(fw);
  fw.add(box(0.36, 0.035, 1.72, carbon, 2.75, 0.1, 0));
  const fwFlap = box(0.3, 0.035, 1.6, paint, 2.6, 0.18, 0); fw.add(fwFlap);
  fw.add(box(0.26, 0.03, 1.4, accent, 2.5, 0.25, 0));
  const fwPlates = [-1, 1].map((s) => { const m = box(0.62, 0.24, 0.03, paint, 2.65, 0.19, s * 0.88); fw.add(m); return m; });

  // rear wing, with a DRS flap that opens
  body.add(box(0.34, 0.035, 1.06, carbon, -2.28, 1.0, 0));
  const drsFlap = new THREE.Group(); drsFlap.position.set(-2.18, 1.13, 0);
  const flapMesh = box(0.28, 0.035, 1.06, paint, -0.12, 0.02, 0); drsFlap.add(flapMesh); body.add(drsFlap);
  for (const s of [-1, 1]) body.add(box(0.7, 0.5, 0.025, paint, -2.28, 1.05, s * 0.54));
  body.add(box(0.1, 0.5, 0.05, carbon, -2.1, 0.78, 0));
  const beam = box(0.3, 0.03, 0.9, carbon, -2.3, 0.45, 0); body.add(beam);

  // rear brake light
  const lightMat = new THREE.MeshStandardMaterial({ color: 0x300000, emissive: 0xff0000, emissiveIntensity: 0.1 });
  const light = box(0.04, 0.12, 0.14, lightMat, -2.46, 0.82, 0); body.add(light);

  // number + stripe
  const numTex = numberTexture(num);
  const numMat = new THREE.MeshBasicMaterial({ map: numTex, transparent: true });
  const numPlane = new THREE.Mesh(new THREE.PlaneGeometry(0.36, 0.36), numMat);
  numPlane.position.set(2.0, 0.405, 0); numPlane.rotation.x = -Math.PI / 2; numPlane.rotation.z = -Math.PI / 2; body.add(numPlane);
  const numSide = [-1, 1].map((s) => { const p = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.3), numMat); p.position.set(-0.55, 0.45, s * 0.835); p.rotation.y = s > 0 ? 0 : Math.PI; return p; });
  numSide.forEach((p) => body.add(p));
  const stripe = box(2.4, 0.01, 0.1, accent, 0.4, 0.571, 0); body.add(stripe);

  // suspension arms
  for (const x of [CAR.a, -CAR.b]) for (const s of [-1, 1]) {
    const w = (x > 0 ? CAR.tf : CAR.tr) / 2;
    for (const dy of [0.18, 0.05]) {
      const arm = box(0.04, 0.025, w - 0.28, carbon, x, 0.25 + dy * 0.2, s * (w + 0.28) * 0.5);
      body.add(arm);
    }
  }

  // wheels
  const wheels = [];
  const compCol = new THREE.Color(COMPOUNDS[compound]?.color || '#ffd33b');
  const stripeMat = new THREE.MeshBasicMaterial({ color: compCol });
  for (let i = 0; i < 4; i++) {
    const front = i < 2;
    const left = i % 2 === 0;
    const wWidth = front ? 0.31 : 0.4;
    const pivot = new THREE.Group();
    const spin = new THREE.Group();
    const tyre = new THREE.Mesh(new THREE.CylinderGeometry(CAR.rWheel, CAR.rWheel, wWidth, 24), tyreMat);
    tyre.rotation.x = Math.PI / 2; tyre.castShadow = true; spin.add(tyre);
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, wWidth + 0.01, 16), rimMat);
    rim.rotation.x = Math.PI / 2; spin.add(rim);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(CAR.rWheel - 0.045, 0.014, 6, 24), stripeMat);
    ring.position.z = (left ? -1 : 1) * (wWidth / 2 + 0.002);
    spin.add(ring);
    // a spoke so rotation is visible
    const spoke = box(0.03, 0.36, wWidth + 0.02, steel); spin.add(spoke);
    pivot.add(spin);
    const track = (front ? CAR.tf : CAR.tr) / 2;
    pivot.position.set(front ? CAR.a : -CAR.b, CAR.rWheel, (left ? -1 : 1) * track);
    root.add(pivot);
    wheels.push({ pivot, spin, ring });
  }

  root.userData = { body, wheels, lightMat, paint, stripeMat, spinAngle: 0, numPlane, fw, fwFlap, fwPlates, drsFlap, drsAngle: 0 };
  return root;
}

export function setCompound(model, compound) {
  model.userData.stripeMat.color.set(COMPOUNDS[compound]?.color || '#ffd33b');
}

export function disposeModel(model) {
  model.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
  });
}

export function makeNameTag(name, color) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(10,10,14,0.72)'; g.beginPath(); g.roundRect ? g.roundRect(6, 8, 244, 48, 10) : g.rect(6, 8, 244, 48); g.fill();
  g.fillStyle = color; g.fillRect(6, 8, 8, 48);
  g.fillStyle = '#fff'; g.font = '600 28px "Barlow Condensed", Arial Narrow, Arial, sans-serif'; g.textBaseline = 'middle';
  g.fillText(name.toUpperCase(), 26, 33);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false }));
  s.scale.set(3.4, 0.85, 1);
  return s;
}
