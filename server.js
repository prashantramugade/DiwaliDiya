// Live Diya Wall server. No dependencies.
// Run:  node server.js
// Options:  --port=3000   --ip=192.168.1.50 (force the address shown in the QR code)   --fresh (ignore saved diyas)
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
}));
const PORT = Number(args.port || process.env.PORT || 3000);
const FORCE_IP = String(args.ip || process.env.HOST_IP || '');
// PIN for the wall and admin. Set it with the WALL_PIN environment variable (or --pin=1234).
// It is never stored in the code (the repo is public). If unset, a random PIN is made and printed at start.
let PIN = String(args.pin === true ? '' : (args.pin || process.env.WALL_PIN || '')).trim().replace(/^["']|["']$/g, '').trim();
let PIN_GENERATED = false;
if (!PIN) { PIN = String(crypto.randomInt(0, 10000)).padStart(4, '0'); PIN_GENERATED = true; }
const AUTH_KEY = crypto.createHash('sha256').update('diya-wall:' + PIN).digest();
const TOKEN = crypto.createHmac('sha256', AUTH_KEY).update('wall-ok-v1').digest('hex');
const DATA_FILE = path.join(__dirname, 'wishes.json');
const MAX_WISHES = 2000;

let epoch = Date.now();   // changes when the wall is cleared, so screens know to rebuild
let seq = 0;
let wishes = [];
const clients = new Set();
const recent = new Map(); // ip|name|text -> time, to ignore accidental double submits

// ---------- persistence (survives a crash/restart within 6 hours) ----------
function save() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify({ epoch, seq, wishes })); } catch (e) { /* never crash on disk problems */ }
}
try {
  if (!args.fresh && fs.existsSync(DATA_FILE) && Date.now() - fs.statSync(DATA_FILE).mtimeMs < 6 * 3600e3) {
    const j = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (j && Array.isArray(j.wishes)) {
      wishes = j.wishes.filter(w => w && typeof w.name === 'string').slice(-MAX_WISHES);
      epoch = j.epoch || epoch;
      seq = Math.max(j.seq || 0, ...wishes.map(w => w.id || 0));
      if (wishes.length) console.log(`Restored ${wishes.length} diyas from the earlier run (start with --fresh to clear).`);
    }
  }
} catch (e) { console.warn('Could not restore saved diyas:', e.message); }

// ---------- network addresses ----------
function addresses() {
  const found = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const i of list || []) {
      if ((i.family !== 'IPv4' && i.family !== 4) || i.internal) continue;
      let score = 0;
      if (/^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(i.address)) score += 2;
      if (/^169\.254\./.test(i.address)) score -= 5;
      if (/(docker|veth|br-|vmnet|vbox|virtual|vethernet|tailscale|utun|tun\d|zt|wsl|hyper-v|bridge|vpn)/i.test(name)) score -= 3;
      if (/^(en\d|eth|wlan|wl|wi-?fi|ethernet)/i.test(name)) score += 1;
      found.push({ ip: i.address, score });
    }
  }
  found.sort((a, b) => b.score - a.score);
  const ips = found.map(f => f.ip);
  if (FORCE_IP) ips.unshift(FORCE_IP);
  const uniq = [...new Set(ips)];
  return uniq.length ? uniq : ['localhost'];
}

// ---------- helpers ----------
const clean = (s, max) => String(s == null ? '' : s)
  .replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

// ---------- admin page: clear the wall from any device (no key needed) ----------
const ADMIN_HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Diya Wall admin</title><style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px;background:#021815;color:#F9BD20;font-family:'Segoe UI',Helvetica,Arial,sans-serif}
main{width:min(100%,380px);text-align:center}h1{font-size:1.5rem}p{color:#d6f3ef}
button{width:100%;padding:15px;border:0;border-radius:12px;font-size:1.05rem;font-weight:700;background:#d93025;color:#fff;margin-top:6px}
button:disabled{opacity:.6}#msg{min-height:1.4em;margin-top:12px;color:#8fe3da}</style></head><body><main>
<h1>Diya Wall admin</h1><p id="count">&nbsp;</p>
<button id="b">Clear all diyas</button><div id="msg"></div></main><script>
const $=i=>document.getElementById(i);
async function count(){try{const t=await (await fetch('/health')).text();$('count').textContent=t.replace('ok ','')+' diyas on the wall'}catch(e){}}
count();
$('b').onclick=async()=>{
 if(!confirm('Clear ALL diyas from the wall?'))return;
 $('b').disabled=true;
 try{const r=await fetch('/admin/clear',{method:'POST'});
  $('msg').textContent=r.ok?'Cleared. The wall is empty.':'Could not clear. Try again.';count()}
 catch(e){$('msg').textContent='Could not reach the server.'}
 $('b').disabled=false};
</script></body></html>`;

function send(res, code, type, body) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}
function broadcast(obj) {
  const msg = 'data: ' + JSON.stringify(obj) + '\n\n';
  for (const c of [...clients]) {
    try { c.write(msg); } catch (e) { clients.delete(c); }
  }
}
setInterval(() => broadcast({ ping: 1 }), 15000); // keeps connections alive through proxies/Wi-Fi

// ---------- PIN gate ----------
const safeEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
function authed(req) {
  const m = /(?:^|;\s*)dw=([0-9a-f]+)/.exec(req.headers.cookie || '');
  return !!m && safeEq(m[1], TOKEN);
}
function clientIp(req) { // behind Render's proxy the last X-Forwarded-For entry is the one the proxy added
  const xf = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
  return xf.length ? xf[xf.length - 1] : req.socket.remoteAddress;
}
const fails = new Map();           // ip -> { n, until }
let gFails = [], gLockUntil = 0;   // global brute-force cap
function lockLeft(ip) {
  const now = Date.now();
  if (now < gLockUntil) return gLockUntil - now;
  const f = fails.get(ip);
  return f && f.until > now ? f.until - now : 0;
}
function noteFail(ip) {
  const now = Date.now();
  const f = fails.get(ip) || { n: 0, until: 0 };
  if (f.until && f.until <= now) { f.n = 0; f.until = 0; }
  if (++f.n >= 5) f.until = now + 15 * 60e3;
  fails.set(ip, f);
  gFails = gFails.filter(t => now - t < 10 * 60e3); gFails.push(now);
  if (gFails.length >= 60) { gLockUntil = now + 5 * 60e3; gFails = []; }
  if (fails.size > 2000) for (const [k, v] of fails) if (v.until < now) fails.delete(k);
}
function handlePin(req, res) {
  let body = '';
  req.on('data', d => { body += d; if (body.length > 200) req.destroy(); });
  req.on('end', () => {
    const ip = clientIp(req);
    const left = lockLeft(ip);
    if (left > 0) return send(res, 429, 'application/json', JSON.stringify({ wait: Math.ceil(left / 60000) }));
    let pin = '';
    try { pin = String(JSON.parse(body).pin || ''); } catch (e) { /* ignore */ }
    if (safeEq(pin, PIN)) {
      fails.delete(ip);
      const secure = String(req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : '';
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store',
        'Set-Cookie': `dw=${TOKEN}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secure}` });
      return res.end('ok');
    }
    noteFail(ip);
    const l2 = lockLeft(ip);
    if (l2 > 0) return send(res, 429, 'application/json', JSON.stringify({ wait: Math.ceil(l2 / 60000) }));
    send(res, 403, 'text/plain', 'wrong');
  });
}
const PIN_HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"><meta name="color-scheme" content="dark">
<title>ABN AMRO Diwali 2026</title><style>
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent;touch-action:manipulation;-webkit-user-select:none;user-select:none}
html,body{overflow:hidden;overscroll-behavior:none}
body{margin:0;min-height:100vh;min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:16px;
background:radial-gradient(circle at 50% 100%,#0c5a53,#021815 74%);color:#F9BD20;font-family:'Segoe UI','Helvetica Neue',Helvetica,Arial,sans-serif;text-align:center}
main{width:min(100%,320px)}
.brand{display:inline-block;background:#009488;color:#fff;font-weight:700;padding:.15em .6em;border-radius:.3em;letter-spacing:.02em}
.d{font-size:3rem;margin:.1em 0}h1{font-size:1.4rem;margin:.1em 0 .2em}p{margin:0 0 14px;color:#d6f3ef}
.dots{display:flex;justify-content:center;gap:14px;margin:6px 0 10px}
.dots i{width:16px;height:16px;border-radius:50%;border:2px solid #F9BD20;transition:.12s}.dots i.on{background:#F9BD20;box-shadow:0 0 10px #F9BD20}
.pad{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
.pad button{padding:15px 0;font-size:1.4rem;font-weight:700;border:1px solid #F9BD2055;border-radius:14px;background:#ffffff12;color:#fff;font-family:inherit}
.pad button:active{background:#009488}.pad .x{visibility:hidden}
#msg{min-height:1.5em;margin-top:12px;color:#ff9b9b}
.shake{animation:sh .35s}@keyframes sh{25%{transform:translateX(-8px)}75%{transform:translateX(8px)}}
</style></head><body><main>
<div class="brand">ABN AMRO</div><div class="d">🪔</div><h1>Diwali 2026</h1><p>Enter PIN to open the wall</p>
<div class="dots" id="dots"><i></i><i></i><i></i><i></i></div>
<div class="pad" id="pad"></div><div id="msg" role="alert"></div></main><script>
const $=i=>document.getElementById(i);let v='',busy=false;
const keys=['1','2','3','4','5','6','7','8','9','x','0','⌫'];
keys.forEach(k=>{const b=document.createElement('button');b.type='button';b.textContent=k==='x'?'':k;
 if(k==='x')b.className='x';else b.onclick=()=>press(k);$('pad').appendChild(b)});
function draw(){[...$('dots').children].forEach((d,i)=>d.className=i<v.length?'on':'')}
function press(k){if(busy)return;$('msg').textContent='';
 if(k==='⌫')v=v.slice(0,-1);else if(v.length<4)v+=k;draw();if(v.length===4)go()}
document.addEventListener('keydown',e=>{if(/^[0-9]$/.test(e.key))press(e.key);else if(e.key==='Backspace')press('⌫')});
async function go(){busy=true;
 try{const r=await fetch('/pin',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin:v})});
  if(r.ok){location.reload();return}
  if(r.status===429){const j=await r.json();$('msg').textContent='Too many tries. Wait '+j.wait+' min.'}
  else $('msg').textContent='Wrong PIN';
  $('dots').classList.remove('shake');void $('dots').offsetWidth;$('dots').classList.add('shake')}
 catch(e){$('msg').textContent='Cannot reach the server'}
 v='';draw();busy=false}
</script></body></html>`;

const PAGES = { '/': 'join.html', '/join': 'join.html', '/wall': 'wall.html', '/wall/': 'wall.html' };
const DENY = res => send(res, 401, 'text/plain', 'PIN required');

const server = http.createServer((req, res) => {
  req.on('error', () => {});
  res.on('error', () => {});
  const url = req.url.split('?')[0];

  try {
    if (url === '/pin' && req.method === 'POST') return handlePin(req, res);

    if (url === '/events') {
      if (!authed(req)) return DENY(res);
      req.socket.setTimeout(0);
      req.socket.setNoDelay(true);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive', 'X-Accel-Buffering': 'no'
      });
      res.write('retry: 2000\n');
      res.write('data: ' + JSON.stringify({ init: wishes, epoch }) + '\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (url === '/wish' && req.method === 'POST') {
      let body = '';
      req.on('data', d => { body += d; if (body.length > 4000) req.destroy(); });
      req.on('end', () => {
        try {
          const j = JSON.parse(body);
          const name = clean(j.name, 24), text = clean(j.text, 120);
          if (!name) return send(res, 400, 'text/plain', 'name required');
          const key = req.socket.remoteAddress + '|' + name + '|' + text;
          const now = Date.now();
          if (recent.has(key) && now - recent.get(key) < 15000) return send(res, 200, 'text/plain', 'ok'); // duplicate tap
          recent.set(key, now);
          if (recent.size > 500) for (const [k, t] of recent) if (now - t > 15000) recent.delete(k);
          const wish = { id: ++seq, name, text, t: now };
          wishes.push(wish);
          if (wishes.length > MAX_WISHES) wishes.shift();
          save();
          broadcast({ wish });
          send(res, 200, 'text/plain', 'ok');
        } catch (e) { send(res, 400, 'text/plain', 'bad request'); }
      });
      return;
    }

    if (url === '/admin' && req.method === 'GET') {
      return send(res, 200, 'text/html; charset=utf-8', authed(req) ? ADMIN_HTML : PIN_HTML);
    }

    if (url === '/admin/clear' && req.method === 'POST') {
      if (!authed(req)) { req.resume(); return DENY(res); }
      req.resume();
      wishes = []; seq = 0; epoch = Date.now(); recent.clear(); save();
      broadcast({ init: [], epoch });
      return send(res, 200, 'text/plain', 'cleared');
    }

    if (url === '/info') {
      if (!authed(req)) return DENY(res);
      const list = addresses().map(ip => `http://${ip}:${PORT}/`);
      return send(res, 200, 'application/json', JSON.stringify({ candidates: list, join: list[0], count: wishes.length }));
    }
    if (url === '/health') return authed(req) ? send(res, 200, 'text/plain', 'ok ' + wishes.length) : DENY(res);
    if (url === '/favicon.ico') { res.writeHead(204); return res.end(); }

    const file = PAGES[url];
    if (!file) return send(res, 404, 'text/plain', 'Not found');
    if (file === 'wall.html' && !authed(req)) return send(res, 200, 'text/html; charset=utf-8', PIN_HTML);
    fs.readFile(path.join(__dirname, file), (err, data) => {
      if (err) return send(res, 500, 'text/plain', 'Missing ' + file + ' next to server.js');
      send(res, 200, 'text/html; charset=utf-8', data);
    });
  } catch (e) {
    try { send(res, 500, 'text/plain', 'error'); } catch (_) { /* ignore */ }
  }
});

server.keepAliveTimeout = 65000;
server.on('clientError', (err, socket) => { try { socket.destroy(); } catch (e) { /* ignore */ } });
server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} is already in use (is the wall already running in another terminal?).`);
    console.error(`Stop the other one, or use another port:  node server.js --port=${PORT + 1}\n`);
  } else console.error('Server error:', err.message);
  process.exit(1);
});

// keep running whatever happens
process.on('uncaughtException', e => console.error('Recovered from error:', e && e.message));
process.on('unhandledRejection', e => console.error('Recovered from rejection:', e && e.message));
process.on('SIGINT', () => { save(); process.exit(0); });

server.listen(PORT, '0.0.0.0', () => {
  const ips = addresses();
  console.log('\n🪔  Diya Wall is running');
  console.log(PIN_GENERATED ? `   PIN (random, none was set): ${PIN}   (set your own with WALL_PIN or --pin=)` : `   PIN protection: on (${PIN.length} characters, from ${args.pin ? '--pin' : 'WALL_PIN'})`);
  console.log(`   Big screen : http://localhost:${PORT}/wall   (press F for fullscreen)`);
  console.log(`   Guests join: http://${ips[0]}:${PORT}/   (the QR code on the wall points here)`);
  if (ips.length > 1) {
    console.log(`\n   Several network addresses found: ${ips.join(', ')}`);
    console.log('   If the QR code does not open on your phone: press N on the wall to try the next address,');
    console.log('   or restart with  node server.js --ip=<your Wi-Fi address>');
  }
  console.log('\n   On the wall:  T = add a test diya   N = next address   Shift+R = clear all   F = fullscreen');
  console.log('   Clear from any device: open /admin\n');
});
