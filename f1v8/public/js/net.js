// WebSocket client with clock sync and tiny event emitter.
export class Net {
  constructor() {
    this.ws = null;
    this.h = {};
    this.id = null;
    this.offset = 0;      // serverTime - localTime (ms)
    this.rtt = 0;
    this.open = false;
    this._pingTimer = null;
  }

  on(type, fn) { (this.h[type] ||= []).push(fn); return this; }
  off(type, fn) { this.h[type] = (this.h[type] || []).filter((f) => f !== fn); }
  emit(type, m) { (this.h[type] || []).forEach((f) => f(m)); }

  connect(profile) {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      let ws;
      try { ws = new WebSocket(`${proto}://${location.host}/ws`); } catch (e) { reject(e); return; }
      this.ws = ws;
      let settled = false;
      const t = setTimeout(() => { if (!settled) { settled = true; reject(new Error('timeout')); try { ws.close(); } catch {} } }, 6000);
      ws.onopen = () => { this.open = true; this.send({ t: 'hello', ...profile }); this.ping(); };
      ws.onmessage = (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.t === 'welcome') {
          this.id = m.id; this.offset = m.now - Date.now();
          if (!settled) { settled = true; clearTimeout(t); resolve(m); }
          this._pingTimer = setInterval(() => this.ping(), 2500);
        } else if (m.t === 'pong') {
          const rtt = Date.now() - m.c;
          this.rtt = this.rtt ? this.rtt * 0.7 + rtt * 0.3 : rtt;
          const off = m.s + rtt / 2 - Date.now();
          this.offset = this._offInit ? this.offset * 0.8 + off * 0.2 : off;
          this._offInit = true;
        }
        this.emit(m.t, m);
        this.emit('*', m);
      };
      ws.onclose = () => {
        this.open = false;
        clearInterval(this._pingTimer);
        if (!settled) { settled = true; clearTimeout(t); reject(new Error('closed')); }
        this.emit('close', {});
      };
      ws.onerror = () => {};
    });
  }

  ping() { this.send({ t: 'ping', c: Date.now() }); }
  send(o) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(o)); }
  serverNow() { return Date.now() + this.offset; }
  close() { clearInterval(this._pingTimer); try { this.ws && this.ws.close(); } catch {} this.open = false; }
}
