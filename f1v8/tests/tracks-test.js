import { BUILTIN, generateTrackSpec } from '../public/js/tracks.js';
import { buildTrack, validateTrack } from '../public/js/track.js';
const rows = [];
for (const spec of [...BUILTIN, generateTrackSpec('hello'), generateTrackSpec(1234), generateTrackSpec('monza2')]) {
  const t = buildTrack(spec);
  const v = validateTrack(t);
  print(`${(spec.name||'').padEnd(22)} len=${(t.length/1000).toFixed(2)}km n=${t.n} minR=${v.minR.toFixed(0)}m sep=${v.minSep.toFixed(0)} ok=${v.ok} ${v.reason||''}`);
  // svg path
  let d = ''; for (let i = 0; i < t.n; i += 3) d += (i ? 'L' : 'M') + (t.x[i]/10).toFixed(1) + ',' + (-t.y[i]/10).toFixed(1);
  rows.push({ name: spec.name, d: d + 'Z', sx: t.x[0]/10, sy: -t.y[0]/10, b: t.bounds });
}
let svg = '<html><body style="background:#111;color:#ddd;font:12px sans-serif;display:grid;grid-template-columns:repeat(3,1fr);gap:8px">';
for (const r of rows) {
  const pad = 30, w = (r.b.maxx - r.b.minx)/10 + pad*2, h = (r.b.maxy - r.b.miny)/10 + pad*2;
  svg += `<div><div>${r.name}</div><svg viewBox="${r.b.minx/10-pad} ${-r.b.maxy/10-pad} ${w} ${h}" style="width:100%;background:#1b1b1b"><path d="${r.d}" fill="none" stroke="#ddd" stroke-width="3"/><circle cx="${r.sx}" cy="${r.sy}" r="7" fill="red"/></svg></div>`;
}
svg += '</body></html>';
print('@@SVG@@' + svg);
