import { createCar, placeCar, stepCar, collideWalls } from '../public/js/physics.js';
import { buildTrack } from '../public/js/track.js';
import { BUILTIN } from '../public/js/tracks.js';
import { AIDriver } from '../public/js/ai.js';
const DT=1/240;
for (const id of ['sakura','veloce','ardennes']) {
 for (const comp of ['soft','medium','hard']) {
  const tr = buildTrack(BUILTIN.find(b=>b.id===id));
  const c = createCar({fuel:40, compound: comp}); const g = tr.gridSlot(0); placeCar(c,g.x,g.y,g.psi,0); c.hold=false; c.idx=g.idx;
  const ai = new AIDriver(tr,0.9,1);
  const env={surface(car,i,wx,wy){const l=tr.locate(wx,wy,car.idx);return tr.surface(l.i,l.d);}};
  let prog=g.fi*tr.ds,last=null,laps=0,ls=0,times=[],t=0,tmax=0,tmin=999,kmin=1,boostT=0,drsT=0;
  while(laps<4&&t<600){const loc=tr.locate(c.x,c.y,c.idx);c.idx=loc.i;if(last!==null){let d=loc.fi-last;if(d>tr.n/2)d-=tr.n;if(d<-tr.n/2)d+=tr.n;prog+=d*tr.ds;}last=loc.fi;
   if(prog>=(laps+1)*tr.length){laps++;times.push((t-ls).toFixed(1));ls=t;}
   const inp=ai.update(c,DT,[]); if(t<.5)inp.throttle=0; inp.drs = Math.abs(inp.steer)<0.05 && inp.throttle>0.9 && (t%40>30);
   stepCar(c,inp,env,DT);collideWalls(c,tr);t+=DT; if(laps>=1){tmax=Math.max(tmax,...c.tyreT);tmin=Math.min(tmin,...c.tyreT);} if(c.boosting)boostT+=DT; if(c.drs)drsT+=DT;}
  print(`${id} ${comp.padEnd(6)} laps ${times.join(' ')} tyreT ${tmin.toFixed(0)}..${tmax.toFixed(0)} end ${c.tyreT.map(x=>x.toFixed(0)).join('/')} wear ${c.wear.map(w=>w.toFixed(2)).join('/')} kers=${c.kers.toFixed(2)} boost ${boostT.toFixed(0)}s drs ${drsT.toFixed(0)}s`);
 }
}
