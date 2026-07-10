/* Tank Toys — isometric two-player tank battle. Vanilla web component <tank-game>. */
(function () {
  'use strict';
  if (customElements.get('tank-game')) return;

  const TILE_W = 64, TILE_H = 32, HSTEP = 20;

  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  /* ---------- connect-code codec ---------- */
  function b64(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function unb64(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const bin = atob(s), u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }
  async function encodeCode(obj) {
    const json = JSON.stringify(obj);
    try {
      const cs = new CompressionStream('deflate-raw');
      const buf = await new Response(new Blob([json]).stream().pipeThrough(cs)).arrayBuffer();
      return 'T1.' + b64(new Uint8Array(buf));
    } catch (e) {
      return 'T0.' + b64(new TextEncoder().encode(json));
    }
  }
  async function decodeCode(str) {
    str = (str || '').trim().replace(/\s+/g, '');
    const i = str.indexOf('.');
    if (i < 0) throw new Error('bad code');
    const tag = str.slice(0, i), bytes = unb64(str.slice(i + 1));
    let text;
    if (tag === 'T1') {
      const ds = new DecompressionStream('deflate-raw');
      const buf = await new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer();
      text = new TextDecoder().decode(buf);
    } else {
      text = new TextDecoder().decode(bytes);
    }
    return JSON.parse(text);
  }

  /* ---------- WebRTC manual-signaling link ---------- */
  class NetLink {
    constructor(onMsg, onState) {
      this.onMsg = onMsg; this.onState = onState; this.ch = null;
      this.pc = new RTCPeerConnection({
        iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }]
      });
      this.pc.onconnectionstatechange = () => this.onState(this.pc.connectionState);
    }
    _wire(ch) {
      this.ch = ch;
      ch.onopen = () => this.onState('open');
      ch.onclose = () => this.onState('closed');
      ch.onmessage = (e) => { try { this.onMsg(JSON.parse(e.data)); } catch (_) {} };
    }
    _gather() {
      return new Promise((res) => {
        if (this.pc.iceGatheringState === 'complete') return res();
        const t = setTimeout(res, 4000);
        this.pc.addEventListener('icegatheringstatechange', () => {
          if (this.pc.iceGatheringState === 'complete') { clearTimeout(t); res(); }
        });
      });
    }
    async host() {
      this._wire(this.pc.createDataChannel('game'));
      await this.pc.setLocalDescription(await this.pc.createOffer());
      await this._gather();
      return encodeCode(this.pc.localDescription);
    }
    async acceptAnswer(code) {
      await this.pc.setRemoteDescription(await decodeCode(code));
    }
    async join(code) {
      this.pc.ondatachannel = (e) => this._wire(e.channel);
      await this.pc.setRemoteDescription(await decodeCode(code));
      await this.pc.setLocalDescription(await this.pc.createAnswer());
      await this._gather();
      return encodeCode(this.pc.localDescription);
    }
    send(o) { if (this.ch && this.ch.readyState === 'open') this.ch.send(JSON.stringify(o)); }
    close() { try { this.pc.close(); } catch (_) {} }
  }

  /* ---------- sound ---------- */
  class Sfx {
    _c() {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      if (!this.ctx) this.ctx = new AC();
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return this.ctx;
    }
    blip(f0, f1, dur, type, vol) {
      try {
        const c = this._c(); if (!c) return;
        const o = c.createOscillator(), g = c.createGain();
        o.type = type || 'square';
        o.frequency.setValueAtTime(f0, c.currentTime);
        o.frequency.exponentialRampToValueAtTime(Math.max(25, f1), c.currentTime + dur);
        g.gain.setValueAtTime(vol || 0.12, c.currentTime);
        g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + dur);
        o.connect(g); g.connect(c.destination);
        o.start(); o.stop(c.currentTime + dur);
      } catch (e) {}
    }
    shoot() { this.blip(320, 90, 0.11, 'square', 0.09); }
    thunk() { this.blip(170, 60, 0.13, 'sawtooth', 0.12); }
    boom() { this.blip(120, 28, 0.5, 'sawtooth', 0.2); this.blip(70, 22, 0.6, 'triangle', 0.2); }
    pick() { this.blip(520, 980, 0.16, 'sine', 0.12); }
    win() { this.blip(400, 800, 0.4, 'triangle', 0.15); }
  }

  /* ---------- map ---------- */
  function genMap(seed, N) {
    const rnd = mulberry32(seed);
    const F = new Float32Array(N * N);
    const hills = Math.round(N * N / 45) + 3;
    for (let i = 0; i < hills; i++) {
      const cx = 2 + rnd() * (N - 4), cy = 2 + rnd() * (N - 4);
      const r = 1.8 + rnd() * 3.2, amp = 1.1 + rnd() * 2.5;
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        const d2 = ((x - cx) * (x - cx) + (y - cy) * (y - cy)) / (r * r);
        F[y * N + x] += amp * Math.exp(-d2 * 2.2);
      }
    }
    const h = new Int8Array(N * N);
    for (let i = 0; i < N * N; i++) h[i] = Math.max(0, Math.min(3, Math.floor(F[i])));
    const obst = new Array(N * N).fill(null);
    const count = Math.round(N * N * 0.075);
    for (let i = 0; i < count; i++) {
      const x = 1 + Math.floor(rnd() * (N - 2)), y = 1 + Math.floor(rnd() * (N - 2));
      if (obst[y * N + x]) continue;
      const r = rnd();
      obst[y * N + x] = r < 0.45 ? { k: 'tree', hp: 2 } : r < 0.8 ? { k: 'crate', hp: 1 } : { k: 'rock', hp: 1e9 };
    }
    const spawns = [{ x: 2.5, y: 2.5 }, { x: N - 2.5, y: N - 2.5 }];
    for (const s of spawns) {
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        const d = Math.hypot(x + 0.5 - s.x, y + 0.5 - s.y);
        if (d < 3.2) { h[y * N + x] = 0; obst[y * N + x] = null; }
      }
    }
    // deterministic per-tile tint noise
    const tint = new Float32Array(N * N);
    for (let i = 0; i < N * N; i++) tint[i] = rnd();
    return { N, h, obst, spawns, tint, seed };
  }
  function mapH(map, tx, ty) {
    if (tx < 0 || ty < 0 || tx >= map.N || ty >= map.N) return 99;
    return map.h[ty * map.N + tx];
  }
  function mapOb(map, tx, ty) {
    if (tx < 0 || ty < 0 || tx >= map.N || ty >= map.N) return null;
    return map.obst[ty * map.N + tx];
  }

  const PU_KINDS = ['speed', 'shield', 'rapid'];
  const PU_COLOR = { speed: '#f5a623', shield: '#37c8e0', rapid: '#e84fa0' };

  /* ---------- component ---------- */
  class TankGame extends HTMLElement {
    connectedCallback() {
      if (this._init) { this._startLoop(); return; }
      this._init = true;
      this.cfgN = Math.max(12, Math.min(40, parseInt(this.getAttribute('map-size') || this.getAttribute('mapsize') || '20', 10) || 20));
      this.winScore = Math.max(1, Math.min(20, parseInt(this.getAttribute('win-score') || this.getAttribute('winscore') || '5', 10) || 5));
      this.sfx = new Sfx();
      this._buildDom();
      this.keys = {};
      this.state = 'menu';         // menu | host | join | play | over
      this.mode = 'local';         // local | net
      this.myIdx = 0;
      this.net = null;
      this.bullets = [];
      this.parts = [];
      this.pus = [];
      this.puNext = 5;
      this.puId = 1;
      this.sendT = 0;
      this.time = 0;
      this.map = genMap((Math.random() * 1e9) | 0, this.cfgN);   // backdrop map
      this.tanks = [];
      this._bind();
      this._show('menu');
      this._startLoop();
    }
    _startLoop() {
      if (this._looping) return;
      this._looping = true;
      this._last = performance.now();
      const loop = (now) => {
        if (!this.isConnected) { this._looping = false; return; }
        const dt = Math.min(0.05, (now - this._last) / 1000);
        this._last = now;
        this.time += dt;
        this._update(dt);
        this._render();
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    }
    disconnectedCallback() {
      // React may briefly detach/reattach on remount — only tear down if still detached
      setTimeout(() => { if (!this.isConnected && this.net) this.net.close(); }, 0);
    }

    /* ----- DOM ----- */
    _buildDom() {
      const sh = this.attachShadow({ mode: 'open' });
      sh.innerHTML = `
<style>
  :host{display:block;width:100%;height:100%;position:relative;font-family:'Nunito','Trebuchet MS',sans-serif;-webkit-user-select:none;user-select:none}
  canvas{position:absolute;inset:0;width:100%;height:100%;display:block}
  .screen{position:absolute;inset:0;display:none;align-items:center;justify-content:center;background:rgba(31,63,29,0.34);backdrop-filter:blur(3px)}
  .screen.on{display:flex}
  .card{background:#f6f2e3;border-radius:26px;padding:30px 34px;box-shadow:0 12px 0 rgba(58,92,44,0.45),0 24px 60px rgba(20,40,15,0.35);max-width:520px;width:min(92vw,520px);text-align:center;color:#2c4022}
  h1{margin:0 0 4px;font-size:44px;font-weight:900;letter-spacing:-1px;color:#2f7d32}
  h1 .r{color:#e84c3d}h1 .b{color:#3a7bd5}
  h2{margin:0 0 14px;font-size:24px;font-weight:900;color:#2c4022}
  p{margin:6px 0 16px;font-size:15px;font-weight:700;color:#5c6e4d;line-height:1.45}
  .btn{display:block;width:100%;box-sizing:border-box;margin:10px 0 0;padding:14px 18px;font:900 19px 'Nunito','Trebuchet MS',sans-serif;color:#fff;background:#4caf50;border:none;border-radius:16px;cursor:pointer;box-shadow:0 5px 0 #33803a;transition:transform .06s}
  .btn:hover{filter:brightness(1.06)}
  .btn:active{transform:translateY(4px);box-shadow:0 1px 0 #33803a}
  .btn.red{background:#e84c3d;box-shadow:0 5px 0 #b03225}
  .btn.red:active{box-shadow:0 1px 0 #b03225}
  .btn.blue{background:#3a7bd5;box-shadow:0 5px 0 #2757a0}
  .btn.blue:active{box-shadow:0 1px 0 #2757a0}
  .btn.ghost{background:#d8d2bd;color:#5c6e4d;box-shadow:0 5px 0 #b3ac93}
  .btn.ghost:active{box-shadow:0 1px 0 #b3ac93}
  textarea{width:100%;box-sizing:border-box;height:84px;resize:none;border-radius:12px;border:3px solid #cfe3c2;background:#fff;padding:10px;font:700 11px ui-monospace,Menlo,monospace;color:#2c4022;outline:none}
  textarea:focus{border-color:#4caf50}
  .steplab{display:flex;align-items:center;gap:8px;margin:16px 0 6px;font-size:14px;font-weight:900;color:#2c4022;text-align:left}
  .steplab .n{display:flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;background:#4caf50;color:#fff;font-size:13px;flex-shrink:0}
  .status{margin-top:14px;font-size:14px;font-weight:900;color:#8a7f5c;min-height:18px}
  .status.ok{color:#2f7d32}.status.err{color:#c0392b}
  .hud{position:absolute;top:0;left:0;right:0;display:none;justify-content:space-between;align-items:flex-start;padding:14px 18px;pointer-events:none}
  .hud.on{display:flex}
  .pcard{display:flex;flex-direction:column;gap:5px;background:rgba(246,242,227,0.92);border-radius:16px;padding:10px 14px;box-shadow:0 4px 0 rgba(58,92,44,0.35);min-width:170px}
  .prow{display:flex;align-items:center;gap:8px}
  .dot{width:14px;height:14px;border-radius:50%;flex-shrink:0}
  .pname{font-size:15px;font-weight:900;color:#2c4022}
  .score{margin-left:auto;font-size:19px;font-weight:900;color:#2c4022}
  .hpbar{display:flex;gap:3px}
  .hp{width:24px;height:9px;border-radius:4px;background:#d8d2bd}
  .hp.f0{background:#e84c3d}.hp.f1{background:#3a7bd5}
  .buffs{display:flex;gap:5px;min-height:14px}
  .buff{padding:1px 7px;border-radius:8px;font-size:10px;font-weight:900;color:#fff}
  .mid{background:rgba(246,242,227,0.92);border-radius:14px;padding:8px 16px;font-size:14px;font-weight:900;color:#5c6e4d;box-shadow:0 4px 0 rgba(58,92,44,0.35)}
  .hint{position:absolute;left:50%;bottom:12px;transform:translateX(-50%);background:rgba(31,63,29,0.55);color:#e9f5dc;border-radius:12px;padding:6px 16px;font-size:13px;font-weight:800;display:none;white-space:nowrap}
  .hint.on{display:block}
  .toast{position:absolute;top:70px;left:50%;transform:translateX(-50%);background:#2c4022;color:#fff;border-radius:12px;padding:8px 18px;font-size:15px;font-weight:900;opacity:0;transition:opacity .25s;pointer-events:none}
  .toast.on{opacity:1}
  .rowbtns{display:flex;gap:10px}
  .rowbtns .btn{flex:1}
  .bigwin{font-size:38px;font-weight:900;margin:0 0 6px}
  .winscore{font-size:22px;font-weight:900;color:#2c4022;margin:2px 0 16px;letter-spacing:.3px}
  .winscore .r{color:#e84c3d}.winscore .b{color:#3a7bd5}
</style>
<canvas></canvas>
<div class="hud">
  <div class="pcard" id="pc0">
    <div class="prow"><span class="dot" style="background:#e84c3d"></span><span class="pname">Red</span><span class="score">0</span></div>
    <div class="hpbar"></div><div class="buffs"></div>
  </div>
  <div class="mid" id="mid">first to ${'${WIN}'}</div>
  <div class="pcard" id="pc1">
    <div class="prow"><span class="dot" style="background:#3a7bd5"></span><span class="pname">Blue</span><span class="score">0</span></div>
    <div class="hpbar"></div><div class="buffs"></div>
  </div>
</div>
<div class="hint" id="hint"></div>
<div class="toast" id="toast"></div>

<div class="screen on" id="scr-menu"><div class="card">
  <h1><span class="r">TANK</span> <span class="b">TOYS</span></h1>
  <p>Toy tanks, big hills, tiny explosions.<br>Isometric battle for two.</p>
  <button class="btn red" id="b-host">Host a game</button>
  <button class="btn blue" id="b-join">Join with a code</button>
  <button class="btn" id="b-local">Local &mdash; both on this keyboard</button>
</div></div>

<div class="screen" id="scr-host"><div class="card">
  <h2>Host a game</h2>
  <div class="steplab"><span class="n">1</span>Send this invite code to your friend</div>
  <textarea id="host-code" readonly placeholder="Creating code&hellip;"></textarea>
  <button class="btn ghost" id="b-copy-host">Copy invite code</button>
  <div class="steplab"><span class="n">2</span>Paste their reply code here</div>
  <textarea id="host-answer" placeholder="Paste reply code&hellip;"></textarea>
  <button class="btn" id="b-connect">Connect</button>
  <div class="status" id="host-status"></div>
  <button class="btn ghost" id="b-back1">Back</button>
</div></div>

<div class="screen" id="scr-join"><div class="card">
  <h2>Join a game</h2>
  <div class="steplab"><span class="n">1</span>Paste the host&rsquo;s invite code</div>
  <textarea id="join-code" placeholder="Paste invite code&hellip;"></textarea>
  <button class="btn" id="b-reply">Create reply code</button>
  <div class="steplab"><span class="n">2</span>Send this reply code back to the host</div>
  <textarea id="join-answer" readonly></textarea>
  <button class="btn ghost" id="b-copy-join">Copy reply code</button>
  <div class="status" id="join-status"></div>
  <button class="btn ghost" id="b-back2">Back</button>
</div></div>

<div class="screen" id="scr-over"><div class="card">
  <div class="bigwin" id="win-title">Red wins!</div>
  <div class="winscore" id="win-score"></div>
  <p id="win-sub"></p>
  <div class="rowbtns">
    <button class="btn" id="b-rematch">Rematch</button>
    <button class="btn ghost" id="b-menu">Menu</button>
  </div>
</div></div>`;
      this.$ = (s) => sh.querySelector(s);
      this.canvas = this.$('canvas');
      this.ctx = this.canvas.getContext('2d');
      this.$('#mid').textContent = 'first to ' + this.winScore;
    }

    _bind() {
      const $ = this.$;
      $('#b-local').onclick = () => { this.mode = 'local'; this._startMatch((Math.random() * 1e9) | 0); };
      $('#b-host').onclick = () => this._hostFlow();
      $('#b-join').onclick = () => this._show('join');
      $('#b-back1').onclick = () => this._abortNet();
      $('#b-back2').onclick = () => this._abortNet();
      $('#b-menu').onclick = () => { this._abortNet(); };
      $('#b-copy-host').onclick = () => this._copy($('#host-code').value, $('#b-copy-host'));
      $('#b-copy-join').onclick = () => this._copy($('#join-answer').value, $('#b-copy-join'));
      $('#b-connect').onclick = () => this._hostAccept();
      $('#b-reply').onclick = () => this._joinFlow();
      $('#b-rematch').onclick = () => {
        if (this.mode === 'net') {
          const seed = (Math.random() * 1e9) | 0;
          this.net.send({ t: 're', seed });
          this._startMatch(seed);
        } else this._startMatch((Math.random() * 1e9) | 0);
      };
      window.addEventListener('keydown', (e) => {
        const t = e.composedPath ? e.composedPath()[0] : e.target;
        if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) return;
        this.keys[e.code] = true;
        if (['Space', 'Enter', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code) && this.state === 'play') e.preventDefault();
        this.sfx._c && this.sfx._c();
      });
      window.addEventListener('keyup', (e) => { this.keys[e.code] = false; });
      window.addEventListener('blur', () => { this.keys = {}; });
    }

    _copy(text, btn) {
      if (!text) return;
      const done = () => { const o = btn.textContent; btn.textContent = 'Copied!'; setTimeout(() => { btn.textContent = o; }, 1200); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, done);
      else done();
    }

    _show(name) {
      for (const n of ['menu', 'host', 'join', 'over']) this.$('#scr-' + n).classList.toggle('on', n === name);
      this.$('.hud').classList.toggle('on', name === 'over' || this.state === 'play');
      this.$('#hint').classList.toggle('on', false);
    }

    _toast(msg) {
      const t = this.$('#toast');
      t.textContent = msg; t.classList.add('on');
      clearTimeout(this._toastT);
      this._toastT = setTimeout(() => t.classList.remove('on'), 2200);
    }

    /* ----- net flows ----- */
    _newLink() {
      if (this.net) this.net.close();
      this.net = new NetLink((m) => this._onMsg(m), (s) => this._onNetState(s));
    }
    async _hostFlow() {
      this._show('host');
      this.$('#host-code').value = '';
      this.$('#host-status').textContent = 'Creating invite code…';
      this._newLink();
      this.myIdx = 0;
      try {
        this.$('#host-code').value = await this.net.host();
        this.$('#host-status').textContent = 'Waiting for the reply code…';
      } catch (e) {
        this.$('#host-status').textContent = 'Could not create code: ' + e.message;
        this.$('#host-status').className = 'status err';
      }
    }
    async _hostAccept() {
      const st = this.$('#host-status');
      try {
        st.className = 'status'; st.textContent = 'Connecting…';
        await this.net.acceptAnswer(this.$('#host-answer').value);
      } catch (e) { st.className = 'status err'; st.textContent = 'That code didn’t parse — paste the full reply code.'; }
    }
    async _joinFlow() {
      const st = this.$('#join-status');
      this._newLink();
      this.myIdx = 1;
      try {
        st.className = 'status'; st.textContent = 'Creating reply code…';
        this.$('#join-answer').value = await this.net.join(this.$('#join-code').value);
        st.textContent = 'Send the reply code to the host, then wait…';
      } catch (e) { st.className = 'status err'; st.textContent = 'That code didn’t parse — paste the full invite code.'; }
    }
    _abortNet() {
      if (this.net) { this.net.close(); this.net = null; }
      this.state = 'menu'; this.mode = 'local';
      this._show('menu');
      this.$('.hud').classList.remove('on');
      this.$('#hint').classList.remove('on');
    }
    _onNetState(s) {
      if (s === 'open') {
        this.mode = 'net';
        if (this.myIdx === 0) {
          const seed = (Math.random() * 1e9) | 0;
          this.net.send({ t: 'map', seed });
          this._startMatch(seed);
        } else {
          const st = this.$('#join-status');
          st.className = 'status ok'; st.textContent = 'Connected! Starting…';
        }
      } else if (s === 'failed' || s === 'disconnected' || s === 'closed') {
        if (this.state === 'play' || this.state === 'over') {
          this._toast('Connection lost');
          this._abortNet();
        }
      }
    }
    _onMsg(m) {
      const rt = this.tanks && this.tanks[1 - this.myIdx];
      switch (m.t) {
        case 'map': this._startMatch(m.seed); break;
        case 're': this._startMatch(m.seed); break;
        case 's':
          if (!rt) break;
          rt.net = { x: m.x, y: m.y, a: m.a };
          rt.hp = m.hp; rt.score = m.sc; rt.inv = m.inv; rt.shield = m.sh;
          if (rt.alive && !m.al) this._explodeTank(rt);
          rt.alive = m.al;
          this._checkWin();
          break;
        case 'f':
          this.bullets.push({ x: m.x, y: m.y, dx: m.dx, dy: m.dy, h: m.h, owner: 1 - this.myIdx, life: 3 });
          this.sfx.shoot();
          break;
        case 'd':
          if (this.tanks[this.myIdx]) { this.tanks[this.myIdx].score++; this._checkWin(); }
          break;
        case 'ob': this._destroyObstacle(m.x, m.y, false); break;
        case 'pu': this.pus.push({ id: m.id, x: m.x, y: m.y, k: m.k }); break;
        case 'pug': {
          const i = this.pus.findIndex(p => p.id === m.id);
          if (i >= 0) this.pus.splice(i, 1);
          break;
        }
      }
    }

    /* ----- match ----- */
    _startMatch(seed) {
      this.map = genMap(seed, this.cfgN);
      this.bullets = []; this.parts = []; this.pus = [];
      this.puNext = 6; this.puId = 1;
      const mk = (i) => {
        const s = this.map.spawns[i];
        const a = Math.atan2(this.map.N / 2 - s.y, this.map.N / 2 - s.x);
        return { i, x: s.x, y: s.y, a, hp: 5, alive: true, respawn: 0, inv: 2, cool: 0, score: 0, vh: 0, shield: 0, speed: 0, rapid: 0, net: null, anim: 0 };
      };
      this.tanks = [mk(0), mk(1)];
      this.state = 'play';
      this._show('none');
      this.$('.hud').classList.add('on');
      const hint = this.$('#hint');
      hint.classList.add('on');
      hint.textContent = this.mode === 'local'
        ? 'Red: WASD + Space · Blue: Arrows + Enter'
        : (this.myIdx === 0 ? 'You are RED · ' : 'You are BLUE · ') + 'WASD or Arrows to drive · Space to fire';
      this._toast(this.mode === 'net' ? 'Linked up! Battle!' : 'Battle!');
    }

    _checkWin() {
      if (this.state !== 'play') return;
      const w = this.tanks.findIndex(t => t.score >= this.winScore);
      if (w < 0) return;
      this.state = 'over';
      this._updateHud();                 // freeze the corner HUD on the true final score
      this._show('over');
      this.$('.hud').classList.add('on');
      const names = ['Red', 'Blue'], colors = ['#e84c3d', '#3a7bd5'];
      const el = this.$('#win-title');
      if (this.mode === 'net') {
        const iWon = w === this.myIdx;
        el.textContent = iWon ? 'You win!' : 'You lose';
        el.style.color = iWon ? colors[this.myIdx] : '#8a7f5c';
        this.$('#win-sub').textContent = iWon ? 'You take the battlefield!' : 'Better luck next round.';
      } else {
        el.textContent = names[w] + ' wins!';
        el.style.color = colors[w];
        this.$('#win-sub').textContent = 'Great match!';
      }
      // Score is shown identically on both peers' end screens.
      this.$('#win-score').innerHTML = '<span class="r">Red ' + this.tanks[0].score + '</span> — <span class="b">' + this.tanks[1].score + ' Blue</span>';
      this.sfx.win();
    }

    /* ----- gameplay ----- */
    _controlOf(idx) {
      const k = this.keys;
      if (this.mode === 'local') {
        if (idx === 0) return { f: k.KeyW, b: k.KeyS, l: k.KeyA, r: k.KeyD, fire: k.Space };
        return { f: k.ArrowUp, b: k.ArrowDown, l: k.ArrowLeft, r: k.ArrowRight, fire: k.Enter };
      }
      return {
        f: k.KeyW || k.ArrowUp, b: k.KeyS || k.ArrowDown,
        l: k.KeyA || k.ArrowLeft, r: k.KeyD || k.ArrowRight,
        fire: k.Space || k.Enter
      };
    }

    _tileBlocked(tx, ty, fromH) {
      if (tx < 0 || ty < 0 || tx >= this.map.N || ty >= this.map.N) return true;
      if (mapOb(this.map, tx, ty)) return true;
      return mapH(this.map, tx, ty) - fromH > 1;
    }

    _moveTank(t, c, dt) {
      const turn = (c.r ? 1 : 0) - (c.l ? 1 : 0);
      t.a += turn * dt * 2.7;
      const thr = (c.f ? 1 : 0) - (c.b ? 0.6 : 0);
      if (thr !== 0 || turn !== 0) t.anim += dt * Math.abs(thr || 0.5);
      const spd = 3.1 * (t.speed > 0 ? 1.65 : 1) * thr;
      if (spd !== 0) {
        const nx = t.x + Math.cos(t.a) * spd * dt;
        const ny = t.y + Math.sin(t.a) * spd * dt;
        const curH = mapH(this.map, Math.floor(t.x), Math.floor(t.y));
        const r = 0.32;
        const okX = !this._tileBlocked(Math.floor(nx + Math.sign(Math.cos(t.a)) * r), Math.floor(t.y), curH);
        const okY = !this._tileBlocked(Math.floor(t.x), Math.floor(ny + Math.sign(Math.sin(t.a)) * r), curH);
        if (okX) t.x = Math.max(0.4, Math.min(this.map.N - 0.4, nx));
        if (okY) t.y = Math.max(0.4, Math.min(this.map.N - 0.4, ny));
      }
      if (c.fire && t.cool <= 0 && t.alive) {
        t.cool = t.rapid > 0 ? 0.18 : 0.55;
        const h = mapH(this.map, Math.floor(t.x), Math.floor(t.y)) + 0.7;
        const b = { x: t.x + Math.cos(t.a) * 0.5, y: t.y + Math.sin(t.a) * 0.5, dx: Math.cos(t.a) * 8.5, dy: Math.sin(t.a) * 8.5, h, owner: t.i, life: 3 };
        this.bullets.push(b);
        this.sfx.shoot();
        if (this.mode === 'net') this.net.send({ t: 'f', x: b.x, y: b.y, dx: b.dx, dy: b.dy, h: b.h });
      }
    }

    _destroyObstacle(tx, ty, broadcast) {
      const ob = mapOb(this.map, tx, ty);
      if (!ob) return;
      this.map.obst[ty * this.map.N + tx] = null;
      const h = mapH(this.map, tx, ty);
      const col = ob.k === 'tree' ? '#3f9b3f' : '#e0a437';
      for (let i = 0; i < 14; i++) this._spark(tx + 0.5, ty + 0.5, h + 0.5, col);
      this.sfx.thunk();
      if (broadcast && this.mode === 'net') this.net.send({ t: 'ob', x: tx, y: ty });
    }

    _spark(x, y, h, color) {
      const a = Math.random() * Math.PI * 2, sp = 1 + Math.random() * 3;
      this.parts.push({ x, y, h, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, vh: 1.5 + Math.random() * 3, life: 0.5 + Math.random() * 0.5, t: 0, color, size: 2.5 + Math.random() * 3.5 });
    }
    _explodeTank(t) {
      const h = mapH(this.map, Math.floor(t.x), Math.floor(t.y));
      const cols = [t.i === 0 ? '#e84c3d' : '#3a7bd5', '#f5a623', '#57402a'];
      for (let i = 0; i < 30; i++) this._spark(t.x, t.y, h + 0.5, cols[i % 3]);
      this.sfx.boom();
    }

    _damageMe(t) {
      if (t.inv > 0 || !t.alive) return;
      if (t.shield > 0) { this.sfx.thunk(); return; }
      t.hp--;
      this.sfx.thunk();
      if (t.hp <= 0) {
        t.alive = false;
        t.respawn = 2.4;
        this._explodeTank(t);
        // Credit the kill to the other tank locally on BOTH peers so the losing
        // peer also detects game-over (the winner stops syncing once it hits
        // 'over', so the loser can't rely on a score sync arriving). The killer's
        // authoritative score sync SETS the same value, so this never double-counts.
        this.tanks[1 - t.i].score++;
        if (this.mode === 'net') this.net.send({ t: 'd' });
        this._checkWin();
      }
    }

    _respawn(t) {
      const s = this.map.spawns[t.i];
      t.x = s.x; t.y = s.y;
      t.a = Math.atan2(this.map.N / 2 - s.y, this.map.N / 2 - s.x);
      t.hp = 5; t.alive = true; t.inv = 2.2;
      t.shield = 0; t.speed = 0; t.rapid = 0;
    }

    _spawnPu() {
      for (let tries = 0; tries < 30; tries++) {
        const x = 1 + Math.floor(Math.random() * (this.map.N - 2));
        const y = 1 + Math.floor(Math.random() * (this.map.N - 2));
        if (mapOb(this.map, x, y)) continue;
        if (this.map.spawns.some(s => Math.hypot(x + 0.5 - s.x, y + 0.5 - s.y) < 3)) continue;
        const pu = { id: this.puId++, x: x + 0.5, y: y + 0.5, k: PU_KINDS[(Math.random() * 3) | 0] };
        this.pus.push(pu);
        if (this.mode === 'net') this.net.send({ t: 'pu', id: pu.id, x: pu.x, y: pu.y, k: pu.k });
        return;
      }
    }

    _update(dt) {
      if (this.state !== 'play') {
        // let particles finish on the game-over screen
        this._updParts(dt);
        return;
      }
      const localIdxs = this.mode === 'local' ? [0, 1] : [this.myIdx];
      for (const t of this.tanks) {
        t.cool -= dt; t.inv = Math.max(0, t.inv - dt);
        for (const b of ['shield', 'speed', 'rapid']) if (typeof t[b] === 'number') t[b] = Math.max(0, t[b] - dt);
        const targetH = mapH(this.map, Math.floor(t.x), Math.floor(t.y));
        t.vh += (targetH - t.vh) * Math.min(1, dt * 10);
        if (localIdxs.includes(t.i)) {
          if (t.alive) this._moveTank(t, this._controlOf(t.i), dt);
          else { t.respawn -= dt; if (t.respawn <= 0) this._respawn(t); }
        } else if (t.net) {
          const k = Math.min(1, dt * 12);
          t.x += (t.net.x - t.x) * k; t.y += (t.net.y - t.y) * k;
          let da = t.net.a - t.a;
          while (da > Math.PI) da -= Math.PI * 2;
          while (da < -Math.PI) da += Math.PI * 2;
          t.a += da * k;
          t.anim += dt * (Math.hypot(t.net.x - t.x, t.net.y - t.y) > 0.01 ? 1 : 0);
        }
      }

      /* bullets */
      for (let i = this.bullets.length - 1; i >= 0; i--) {
        const b = this.bullets[i];
        b.x += b.dx * dt; b.y += b.dy * dt;
        b.h -= 0.55 * dt;   // gentle drop so hill-top shots reach the valley
        b.life -= dt;
        let dead = b.life <= 0 || b.x < 0 || b.y < 0 || b.x >= this.map.N || b.y >= this.map.N;
        if (!dead) {
          const tx = Math.floor(b.x), ty = Math.floor(b.y);
          const ob = mapOb(this.map, tx, ty);
          if (ob) {
            dead = true;
            if (ob.k !== 'rock') {
              ob.hp--;
              if (ob.hp <= 0) this._destroyObstacle(tx, ty, localIdxs.includes(b.owner));
              else { this._spark(b.x, b.y, b.h, '#c8b98a'); this.sfx.thunk(); }
            } else { this._spark(b.x, b.y, b.h, '#9aa0a6'); }
          } else if (mapH(this.map, tx, ty) > b.h) {
            dead = true;
            for (let s = 0; s < 5; s++) this._spark(b.x, b.y, mapH(this.map, tx, ty), '#7cba58');
          }
        }
        if (!dead) {
          for (const t of this.tanks) {
            if (!t.alive || t.i === b.owner) continue;
            const th = mapH(this.map, Math.floor(t.x), Math.floor(t.y));
            if (Math.hypot(t.x - b.x, t.y - b.y) < 0.45 && b.h > th - 0.2 && b.h < th + 1.2) {
              dead = true;
              for (let s = 0; s < 6; s++) this._spark(b.x, b.y, b.h, '#ffd76e');
              const mine = this.mode === 'local' || t.i === this.myIdx;
              if (mine) this._damageMe(t);
              break;
            }
          }
        }
        if (dead) this.bullets.splice(i, 1);
      }

      /* power-ups */
      const spawner = this.mode === 'local' || this.myIdx === 0;
      if (spawner) {
        this.puNext -= dt;
        if (this.puNext <= 0 && this.pus.length < 3) { this._spawnPu(); this.puNext = 8 + Math.random() * 5; }
      }
      for (let i = this.pus.length - 1; i >= 0; i--) {
        const p = this.pus[i];
        for (const idx of localIdxs) {
          const t = this.tanks[idx];
          if (t.alive && Math.hypot(t.x - p.x, t.y - p.y) < 0.55) {
            if (p.k === 'speed') t.speed = 8;
            if (p.k === 'shield') t.shield = 6;
            if (p.k === 'rapid') t.rapid = 8;
            this.sfx.pick();
            this._toast((idx === 0 ? 'Red' : 'Blue') + ' got ' + (p.k === 'speed' ? 'Speed!' : p.k === 'shield' ? 'Shield!' : 'Rapid fire!'));
            this.pus.splice(i, 1);
            if (this.mode === 'net') this.net.send({ t: 'pug', id: p.id });
            break;
          }
        }
      }

      this._updParts(dt);

      /* net state broadcast */
      if (this.mode === 'net') {
        this.sendT -= dt;
        if (this.sendT <= 0) {
          this.sendT = 1 / 15;
          const t = this.tanks[this.myIdx];
          this.net.send({ t: 's', x: +t.x.toFixed(3), y: +t.y.toFixed(3), a: +t.a.toFixed(3), hp: t.hp, al: t.alive, sc: t.score, inv: t.inv, sh: t.shield });
        }
      }

      this._updateHud();
    }

    _updParts(dt) {
      for (let i = this.parts.length - 1; i >= 0; i--) {
        const p = this.parts[i];
        p.t += dt;
        if (p.t >= p.life) { this.parts.splice(i, 1); continue; }
        p.x += p.vx * dt; p.y += p.vy * dt;
        p.vh -= 9 * dt; p.h += p.vh * dt;
        if (p.h < 0) { p.h = 0; p.vh *= -0.4; }
      }
    }

    _updateHud() {
      for (let i = 0; i < 2; i++) {
        const t = this.tanks[i], card = this.$('#pc' + i);
        card.querySelector('.score').textContent = t.score;
        const bar = card.querySelector('.hpbar');
        if (bar.children.length !== 5) {
          bar.innerHTML = '';
          for (let j = 0; j < 5; j++) { const d = document.createElement('span'); d.className = 'hp'; bar.appendChild(d); }
        }
        for (let j = 0; j < 5; j++) bar.children[j].className = 'hp' + (t.alive && j < t.hp ? ' f' + i : '');
        const buffs = [];
        if (t.speed > 0) buffs.push(['SPEED', PU_COLOR.speed]);
        if (t.shield > 0) buffs.push(['SHIELD', PU_COLOR.shield]);
        if (t.rapid > 0) buffs.push(['RAPID', PU_COLOR.rapid]);
        if (!t.alive) buffs.push(['REBUILDING…', '#8a7f5c']);
        const bhtml = buffs.map(b => `<span class="buff" style="background:${b[1]}">${b[0]}</span>`).join('');
        const bel = card.querySelector('.buffs');
        if (bel.innerHTML !== bhtml) bel.innerHTML = bhtml;
      }
    }

    /* ----- rendering ----- */
    _render() {
      const cv = this.canvas, dpr = Math.min(2, window.devicePixelRatio || 1);
      const W = this.clientWidth || 800, H = this.clientHeight || 600;
      if (cv.width !== W * dpr || cv.height !== H * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
      const ctx = this.ctx;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // play-table backdrop
      const g = ctx.createRadialGradient(W / 2, H * 0.35, 60, W / 2, H / 2, Math.max(W, H) * 0.8);
      g.addColorStop(0, '#b8dfa0');
      g.addColorStop(1, '#7fb56b');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);

      const N = this.map.N;
      const mapW = N * TILE_W + 40, mapHt = N * TILE_H + HSTEP * 3 + 120;
      const scale = Math.min(W * 0.94 / mapW, (H - 90) * 0.96 / mapHt);
      ctx.save();
      ctx.translate(W / 2, 70 + ((H - 90) - (N * TILE_H + HSTEP * 3) * scale) / 2 + HSTEP * 3 * scale);
      ctx.scale(scale, scale);

      const iso = (x, y, h) => [(x - y) * TILE_W / 2, (x + y) * TILE_H / 2 - h * HSTEP];

      // soft drop shadow under the whole diorama slab
      ctx.save();
      const [sx0, sy0] = iso(N / 2, N / 2, 0);
      ctx.translate(sx0, sy0 + 26);
      ctx.scale(1, 0.5);
      ctx.fillStyle = 'rgba(35,70,30,0.28)';
      ctx.beginPath();
      ctx.arc(0, 0, N * TILE_W / 2 * 0.78, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // collect entities keyed by depth row
      const ents = [];
      for (let ty = 0; ty < N; ty++) for (let tx = 0; tx < N; tx++) {
        const ob = this.map.obst[ty * N + tx];
        if (ob) ents.push({ d: tx + ty, z: tx + ty, kind: 'ob', tx, ty, ob });
      }
      if (this.state === 'play' || this.state === 'over') {
        for (const t of this.tanks) if (t.alive) ents.push({ d: Math.floor(t.x) + Math.floor(t.y), z: t.x + t.y, kind: 'tank', t });
      }
      for (const b of this.bullets) ents.push({ d: Math.floor(b.x) + Math.floor(b.y), z: b.x + b.y, kind: 'bullet', b });
      for (const p of this.pus) ents.push({ d: Math.floor(p.x) + Math.floor(p.y), z: p.x + p.y, kind: 'pu', p });
      for (const p of this.parts) ents.push({ d: Math.floor(p.x) + Math.floor(p.y), z: p.x + p.y, kind: 'part', p });
      ents.sort((a, b2) => a.d - b2.d || a.z - b2.z);
      let ei = 0;

      for (let d = 0; d <= (N - 1) * 2; d++) {
        for (let tx = Math.max(0, d - N + 1); tx <= Math.min(N - 1, d); tx++) {
          const ty = d - tx;
          this._drawTile(ctx, iso, tx, ty);
        }
        while (ei < ents.length && ents[ei].d === d) { this._drawEnt(ctx, iso, ents[ei]); ei++; }
      }
      while (ei < ents.length) { this._drawEnt(ctx, iso, ents[ei]); ei++; }

      ctx.restore();
    }

    _drawTile(ctx, iso, tx, ty) {
      const map = this.map, N = map.N;
      const h = map.h[ty * N + tx];
      const tint = map.tint[ty * N + tx];
      const a = iso(tx, ty, h), b = iso(tx + 1, ty, h), c = iso(tx + 1, ty + 1, h), dd = iso(tx, ty + 1, h);
      // top face — lush plastic grass, checker + tint
      const base = 96 + h * 9 + ((tx + ty) % 2 ? 4 : 0);
      const light = 40 + h * 5 + ((tx + ty) % 2 ? 3 : 0) + tint * 4;
      ctx.fillStyle = `hsl(${118 - h * 6 - tint * 8}, ${52 + h * 4}%, ${light}%)`;
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.lineTo(c[0], c[1]); ctx.lineTo(dd[0], dd[1]);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.09)';
      ctx.lineWidth = 1;
      ctx.stroke();
      // side faces (toy diorama soil)
      const edge = -0.7;
      const hR = tx + 1 >= N ? edge : map.h[ty * N + tx + 1];
      const hD = ty + 1 >= N ? edge : map.h[(ty + 1) * N + tx];
      if (h > hR) {
        const b2 = iso(tx + 1, ty, hR), c2 = iso(tx + 1, ty + 1, hR);
        ctx.fillStyle = `hsl(${95 - h * 4}, 38%, ${30 + h * 3}%)`;
        ctx.beginPath();
        ctx.moveTo(b[0], b[1]); ctx.lineTo(c[0], c[1]); ctx.lineTo(c2[0], c2[1]); ctx.lineTo(b2[0], b2[1]);
        ctx.closePath(); ctx.fill();
      }
      if (h > hD) {
        const c2 = iso(tx + 1, ty + 1, hD), d2 = iso(tx, ty + 1, hD);
        ctx.fillStyle = `hsl(${30}, 34%, ${26 + h * 3}%)`;
        ctx.beginPath();
        ctx.moveTo(dd[0], dd[1]); ctx.lineTo(c[0], c[1]); ctx.lineTo(c2[0], c2[1]); ctx.lineTo(d2[0], d2[1]);
        ctx.closePath(); ctx.fill();
      }
    }

    _drawEnt(ctx, iso, e) {
      if (e.kind === 'ob') this._drawOb(ctx, iso, e);
      else if (e.kind === 'tank') this._drawTank(ctx, iso, e.t);
      else if (e.kind === 'bullet') this._drawBullet(ctx, iso, e.b);
      else if (e.kind === 'pu') this._drawPu(ctx, iso, e.p);
      else if (e.kind === 'part') this._drawPart(ctx, iso, e.p);
    }

    _shadow(ctx, x, y, r) {
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(1, 0.5);
      ctx.fillStyle = 'rgba(30,55,25,0.3)';
      ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    _gloss(ctx, x, y, r) {
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.beginPath();
      ctx.ellipse(x - r * 0.3, y - r * 0.35, r * 0.32, r * 0.2, -0.6, 0, Math.PI * 2);
      ctx.fill();
    }

    _drawOb(ctx, iso, e) {
      const h = mapH(this.map, e.tx, e.ty);
      const [px, py] = iso(e.tx + 0.5, e.ty + 0.5, h);
      const k = e.ob.k;
      if (k === 'tree') {
        this._shadow(ctx, px, py, 16);
        ctx.fillStyle = '#8a5a33';
        ctx.fillRect(px - 3.5, py - 18, 7, 18);
        const grad = ctx.createRadialGradient(px - 6, py - 34, 3, px, py - 28, 20);
        grad.addColorStop(0, '#7ed957');
        grad.addColorStop(1, e.ob.hp > 1 ? '#2e8b3a' : '#6b8b2e');
        ctx.fillStyle = grad;
        ctx.beginPath(); ctx.arc(px, py - 28, 17, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(px - 9, py - 20, 11, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(px + 9, py - 21, 11, 0, Math.PI * 2); ctx.fill();
        this._gloss(ctx, px, py - 30, 14);
      } else if (k === 'crate') {
        const s = 15, top = e.ob.hp > 0 ? '#f2b13c' : '#b98a2e';
        this._shadow(ctx, px, py, 17);
        // iso cube
        ctx.fillStyle = top;
        ctx.beginPath();
        ctx.moveTo(px, py - 24); ctx.lineTo(px + s, py - 24 + s / 2); ctx.lineTo(px, py - 24 + s); ctx.lineTo(px - s, py - 24 + s / 2);
        ctx.closePath(); ctx.fill();
        ctx.fillStyle = '#d68f2b';
        ctx.beginPath();
        ctx.moveTo(px - s, py - 24 + s / 2); ctx.lineTo(px, py - 24 + s); ctx.lineTo(px, py); ctx.lineTo(px - s, py - s / 2);
        ctx.closePath(); ctx.fill();
        ctx.fillStyle = '#b06f1e';
        ctx.beginPath();
        ctx.moveTo(px + s, py - 24 + s / 2); ctx.lineTo(px, py - 24 + s); ctx.lineTo(px, py); ctx.lineTo(px + s, py - s / 2);
        ctx.closePath(); ctx.fill();
        ctx.strokeStyle = 'rgba(120,70,10,0.5)';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(px - s * 0.55, py - 20, s * 1.1, 0.001);
        this._gloss(ctx, px + 2, py - 20, 10);
      } else { // rock
        this._shadow(ctx, px, py, 18);
        const grad = ctx.createRadialGradient(px - 6, py - 14, 3, px, py - 8, 22);
        grad.addColorStop(0, '#c7cdd4');
        grad.addColorStop(1, '#7c8590');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.ellipse(px, py - 8, 19, 13, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.ellipse(px + 8, py - 14, 9, 7, 0.3, 0, Math.PI * 2);
        ctx.fill();
        this._gloss(ctx, px - 4, py - 12, 12);
      }
    }

    _drawTank(ctx, iso, t) {
      const [px, py] = iso(t.x, t.y, t.vh);
      const col = t.i === 0
        ? { body: '#e84c3d', dark: '#b03225', track: '#5a2a22' }
        : { body: '#3a7bd5', dark: '#2757a0', track: '#22344f' };
      if (t.inv > 0 && Math.floor(this.time * 8) % 2 === 0) ctx.globalAlpha = 0.35;
      this._shadow(ctx, px, py + 4, 20);
      // screen-space heading
      const vx = (Math.cos(t.a) - Math.sin(t.a)) * TILE_W / 2;
      const vy = (Math.cos(t.a) + Math.sin(t.a)) * TILE_H / 2;
      const sa = Math.atan2(vy, vx);
      ctx.save();
      ctx.translate(px, py - 8);
      ctx.scale(1, 0.78);
      ctx.rotate(sa);
      // tracks
      const bob = Math.sin(t.anim * 14) * 0.8;
      ctx.fillStyle = col.track;
      this._rr(ctx, -19, -16 + bob * 0.3, 38, 9, 4.5); ctx.fill();
      this._rr(ctx, -19, 7 - bob * 0.3, 38, 9, 4.5); ctx.fill();
      // body
      const bg = ctx.createLinearGradient(0, -14, 0, 14);
      bg.addColorStop(0, col.body);
      bg.addColorStop(1, col.dark);
      ctx.fillStyle = bg;
      this._rr(ctx, -17, -12, 34, 24, 8); ctx.fill();
      // barrel
      ctx.fillStyle = col.dark;
      this._rr(ctx, 6, -3.2, 24, 6.4, 3); ctx.fill();
      ctx.fillStyle = '#333';
      ctx.beginPath(); ctx.arc(30, 0, 3.4, 0, Math.PI * 2); ctx.fill();
      // turret dome
      const tg = ctx.createRadialGradient(-3, -4, 2, 0, 0, 12);
      tg.addColorStop(0, '#ffffff');
      tg.addColorStop(0.25, col.body);
      tg.addColorStop(1, col.dark);
      ctx.fillStyle = tg;
      ctx.beginPath(); ctx.arc(0, 0, 10.5, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      // shield bubble
      if (t.shield > 0) {
        ctx.strokeStyle = 'rgba(90,220,240,0.85)';
        ctx.fillStyle = 'rgba(120,225,240,0.18)';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.ellipse(px, py - 10, 30, 24, 0, 0, Math.PI * 2);
        ctx.fill(); ctx.stroke();
      }
      ctx.globalAlpha = 1;
      // hp pips
      const w = 34, x0 = px - w / 2;
      ctx.fillStyle = 'rgba(20,40,15,0.4)';
      this._rr(ctx, x0 - 2, py - 42, w + 4, 8, 4); ctx.fill();
      for (let j = 0; j < 5; j++) {
        ctx.fillStyle = j < t.hp ? (t.i === 0 ? '#ff6f61' : '#6fa8ff') : 'rgba(255,255,255,0.25)';
        this._rr(ctx, x0 + j * (w / 5) + 0.5, py - 40.5, w / 5 - 2, 5, 2.5); ctx.fill();
      }
    }

    _rr(ctx, x, y, w, h, r) {
      ctx.beginPath();
      if (ctx.roundRect) { ctx.roundRect(x, y, w, h, r); return; }
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }

    _drawBullet(ctx, iso, b) {
      const [px, py] = iso(b.x, b.y, 0);
      this._shadow(ctx, px, py, 5);
      const [bx, by] = iso(b.x, b.y, b.h);
      const grad = ctx.createRadialGradient(bx - 1.5, by - 1.5, 0.5, bx, by, 6);
      grad.addColorStop(0, '#fff3c4');
      grad.addColorStop(1, b.owner === 0 ? '#e8632f' : '#3a7bd5');
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.arc(bx, by, 5.5, 0, Math.PI * 2); ctx.fill();
    }

    _drawPu(ctx, iso, p) {
      const h = mapH(this.map, Math.floor(p.x), Math.floor(p.y));
      const bobb = Math.sin(this.time * 3 + p.id) * 4;
      const [px, py] = iso(p.x, p.y, h);
      this._shadow(ctx, px, py, 10);
      const cy = py - 26 + bobb;
      const grad = ctx.createRadialGradient(px - 4, cy - 5, 2, px, cy, 15);
      grad.addColorStop(0, '#ffffff');
      grad.addColorStop(0.3, PU_COLOR[p.k]);
      grad.addColorStop(1, PU_COLOR[p.k]);
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.arc(px, cy, 13, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      if (p.k === 'speed') {          // double chevron
        ctx.beginPath();
        ctx.moveTo(px - 6, cy - 5); ctx.lineTo(px - 1, cy); ctx.lineTo(px - 6, cy + 5);
        ctx.moveTo(px + 1, cy - 5); ctx.lineTo(px + 6, cy); ctx.lineTo(px + 1, cy + 5);
        ctx.stroke();
      } else if (p.k === 'shield') {  // ring
        ctx.beginPath(); ctx.arc(px, cy, 5.5, 0, Math.PI * 2); ctx.stroke();
      } else {                        // rapid: three dots
        for (let i = -1; i <= 1; i++) { ctx.beginPath(); ctx.arc(px + i * 5.5, cy, 2.2, 0, Math.PI * 2); ctx.fill(); }
      }
    }

    _drawPart(ctx, iso, p) {
      const [px, py] = iso(p.x, p.y, p.h);
      const k = 1 - p.t / p.life;
      ctx.globalAlpha = Math.max(0, k);
      ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(px, py, p.size * k + 1, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  customElements.define('tank-game', TankGame);
})();
