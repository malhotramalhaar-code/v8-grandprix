// Built-in circuits (original layouts, loosely modelled on classic track types) and a seeded generator.
// Control points are in units of 100 m and scaled on build.
import { buildTrack, validateTrack } from './track.js';

const S = 100;
const scale = (pts) => pts.map(([x, y]) => [x * S, y * S]);

export const BUILTIN = [
  {
    id: 'veloce', name: 'Autodromo Veloce', blurb: 'Temple of speed. Long straights, tight chicanes, a big final turn.',
    style: 'circuit', width: 15, grass: 7, gravel: 12,
    points: scale([
      [-4, 0], [0, 0], [4, 0], [8, 0], [9.0, 0.05], [9.7, -0.55], [10.4, -0.1], [11.6, -0.1],
      [12.6, -0.3], [13.6, -0.9], [14.3, -2.1], [14.5, -3.6], [14.5, -4.6], [14.9, -5.2], [14.5, -5.9],
      [14.0, -6.6], [13.0, -7.1], [12.0, -7.2], [11.0, -7.2], [10.0, -7.5], [9.0, -8.3], [8.2, -9.2],
      [6.0, -9.8], [3.0, -9.9], [0.5, -9.9], [-0.6, -9.95], [-1.4, -10.35], [-2.2, -9.95], [-3.1, -10.0],
      [-6.0, -10.0], [-8.5, -9.7], [-10.6, -8.8], [-11.6, -6.8], [-11.3, -4.4], [-9.8, -2.2], [-7.6, -0.7], [-5.5, -0.1],
    ]),
  },
  {
    id: 'principato', name: 'Principato Streets', blurb: 'Tight street circuit between the barriers. No room for error.',
    style: 'street', width: 10.5,
    points: scale([
      [0, 0], [2.5, 0], [4.5, 0.1], [5.6, 0.6], [6.2, 1.4], [6.2, 2.4], [5.6, 3.2], [4.4, 3.5],
      [3.5, 4.4], [3.8, 5.4], [3.0, 6.2], [1.6, 6.3], [0.6, 5.5], [0.6, 4.3], [1.6, 3.4], [1.9, 2.4],
      [1.3, 1.5], [0.2, 1.2], [-1.0, 0.9], [-1.7, 0.4], [-1.1, -0.1],
    ]),
  },
  {
    id: 'ardennes', name: 'Ardennes Ring', blurb: 'Epic forest road course: a hairpin, a flat-out climb and fast sweepers.',
    style: 'circuit', width: 14, grass: 6, gravel: 10,
    points: scale([
      [0, 0], [-2.5, 0], [-4.8, 0.2], [-5.9, 0.9], [-5.8, 1.9], [-4.8, 2.3], [-3.8, 1.8], [-2.8, 2.0],
      [-1.4, 3.2], [0.6, 4.6], [2.8, 6.0], [5.2, 7.6], [7.4, 9.4], [8.9, 10.3], [10.0, 10.1],
      [10.5, 9.2], [11.6, 8.8], [12.4, 8.0], [12.2, 7.0], [13.3, 6.3], [14.6, 6.0], [16.0, 5.0],
      [16.6, 3.6], [16.0, 2.2], [14.6, 1.6], [13.2, 2.2], [12.2, 3.2], [11.4, 3.0], [10.8, 1.8],
      [9.4, 0.6], [7.6, 0.2], [5.4, 0.3], [3.0, 0.2],
    ]),
  },
  {
    id: 'sakura', name: 'Sakura Circuit', blurb: 'Technical flowing track: esses, a long fast curve and a stop-start finale.',
    style: 'circuit', width: 13, grass: 6, gravel: 9,
    points: scale([
      [0, 0], [3, 0], [5.5, 0.1], [7.2, 0.9], [7.9, 2.2], [7.2, 3.5], [5.8, 3.8], [4.8, 4.8], [5.4, 6.0],
      [6.8, 6.6], [7.4, 7.8], [6.4, 8.9], [4.6, 9.2], [3.2, 8.6], [2.0, 9.4], [0.4, 9.6], [-1.2, 8.8],
      [-1.8, 7.2], [-3.0, 6.4], [-4.6, 6.6], [-5.6, 5.4], [-5.4, 3.6], [-4.0, 2.6], [-3.4, 1.4],
      [-2.4, 0.6], [-1.2, 0.2],
    ]),
  },
  {
    id: 'harbour', name: 'Harbour Speedway', blurb: 'A wide, fast flowing coastal track that rewards a smooth line.',
    style: 'circuit', width: 16, grass: 8, gravel: 12,
    points: scale([
      [0, 0], [3, 0], [6, -0.2], [8.6, -1.2], [10.0, -3.0], [10.0, -5.0], [8.6, -6.6], [6.4, -7.2],
      [4.6, -6.6], [3.8, -5.2], [2.4, -4.2], [0.6, -4.6], [-0.8, -5.8], [-2.8, -6.2], [-4.8, -5.2],
      [-5.8, -3.2], [-5.2, -1.2], [-3.4, -0.2],
    ]),
  },
];

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Random circuit from a seed: Fourier-perturbed ring + a few forced straights, retried until valid.
export function generateTrackSpec(seed) {
  let s = (typeof seed === 'number' ? seed : hashStr(String(seed))) >>> 0;
  for (let attempt = 0; attempt < 60; attempt++) {
    const rnd = mulberry32(s + attempt * 7919);
    const R = 650 + rnd() * 450;
    const stretch = 1.1 + rnd() * 0.7;
    const harm = [0, 1, 2, 3].map((k) => ({ a: (0.10 + rnd() * 0.22) / (1 + k * 0.45), ph: rnd() * Math.PI * 2 }));
    const count = 18 + Math.floor(rnd() * 8);
    const pts = [];
    for (let i = 0; i < count; i++) {
      const th = (i / count) * Math.PI * 2 + (rnd() - 0.5) * 0.12;
      let r = 1;
      harm.forEach((h, k) => { r += h.a * Math.cos((k + 2) * th + h.ph); });
      r += (rnd() - 0.5) * 0.16;
      pts.push([Math.cos(th) * R * r * stretch, Math.sin(th) * R * r]);
    }
    const street = rnd() < 0.18;
    const spec = {
      name: `Random ${String(seed).slice(0, 12)}`, points: pts,
      width: street ? 11 : 13 + rnd() * 3, style: street ? 'street' : 'circuit', grass: 6, gravel: 9, seed,
    };
    const tr = buildTrack(spec);
    const v = validateTrack(tr);
    if (v.ok && tr.length > 2200 && tr.length < 8500) return spec;
  }
  return { ...BUILTIN[0] };
}

function hashStr(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// A track descriptor as sent over the wire: { type: 'builtin', id } | { type: 'seed', seed } | { type: 'custom', spec }
export function specFromDescriptor(d) {
  if (!d) return BUILTIN[0];
  if (d.type === 'builtin') return BUILTIN.find((b) => b.id === d.id) || BUILTIN[0];
  if (d.type === 'seed') return generateTrackSpec(d.seed);
  if (d.type === 'custom' && d.spec) return d.spec;
  return BUILTIN[0];
}

const cache = new Map();
export function trackFromDescriptor(d) {
  const key = JSON.stringify(d);
  if (cache.has(key)) return cache.get(key);
  const t = buildTrack(specFromDescriptor(d));
  if (cache.size > 12) cache.clear();
  cache.set(key, t);
  return t;
}

// ---- share codes & local storage for custom tracks ----
export function encodeSpec(spec) {
  const o = { n: spec.name, p: spec.points.map(([x, y]) => [Math.round(x), Math.round(y)]), w: spec.width, s: spec.style === 'street' ? 1 : 0, g: spec.grass, v: spec.gravel };
  return 'V8T1.' + btoa(unescape(encodeURIComponent(JSON.stringify(o)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeSpec(code) {
  try {
    const b = String(code).trim().replace(/^V8T1\./, '').replace(/-/g, '+').replace(/_/g, '/');
    const o = JSON.parse(decodeURIComponent(escape(atob(b + '==='.slice((b.length + 3) % 4)))));
    if (!Array.isArray(o.p) || o.p.length < 6) return null;
    return { name: String(o.n || 'Imported').slice(0, 24), points: o.p.map((q) => [+q[0], +q[1]]), width: +o.w || 14, style: o.s ? 'street' : 'circuit', grass: +o.g || 6, gravel: +o.v || 9 };
  } catch { return null; }
}

const KEY = 'v8gp.tracks';
export function loadSavedTracks() {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; }
}
export function saveTrack(spec) {
  const all = loadSavedTracks().filter((t) => t.name !== spec.name);
  all.unshift(spec);
  try { localStorage.setItem(KEY, JSON.stringify(all.slice(0, 30))); } catch {}
}
export function deleteSavedTrack(name) {
  try { localStorage.setItem(KEY, JSON.stringify(loadSavedTracks().filter((t) => t.name !== name))); } catch {}
}
