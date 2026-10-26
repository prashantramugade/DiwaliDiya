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

// ---------- admin key (needed to clear the wall) ----------
// Set your own with the ADMIN_KEY environment variable (or --key=...). Otherwise a random one is printed at startup.
const KEY_FROM_ENV = Boolean(args.key || process.env.ADMIN_KEY);
const ADMIN_KEY = String(args.key || process.env.ADMIN_KEY || crypto.randomBytes(5).toString('hex'));
let badTries = 0, lockUntil = 0;
function keyOk(k) {
  const a = Buffer.from(String(k == null ? '' : k)), b = Buffer.from(ADMIN_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const ADMIN_HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Diya Wall admin</title><style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px;background:#021815;color:#F9BD20;font-family:'Segoe UI',Helvetica,Arial,sans-serif}
main{width:min(100%,380px);text-align:center}h1{font-size:1.5rem}p{color:#d6f3ef}
input{width:100%;padding:14px;border-radius:12px;border:1px solid #ffffff44;background:#ffffff14;color:#fff;font-size:16px;margin:8px 0}
button{width:100%;padding:15px;border:0;border-radius:12px;font-size:1.05rem;font-weight:700;background:#d93025;color:#fff;margin-top:6px}
#msg{min-height:1.4em;margin-top:12px;color:#8fe3da}</style></head><body><main>
<h1>Diya Wall admin</h1><p id="count">&nbsp;</p>
<input id="k" type="password" placeholder="Admin key" autocomplete="off">
<button id="b">Clear all diyas</button><div id="msg"></div></main><script>
const $=i=>document.getElementById(i);
async function count(){try{const t=await (await fetch('/health')).text();$('count').textContent=t.replace('ok ','')+' diyas on the wall'}catch(e){}}
count();
$('b').onclick=async()=>{const key=$('k').value.trim();if(!key){$('msg').textContent='Enter the admin key';return}
 if(!confirm('Clear ALL diyas from the wall?'))return;
 try{const r=await fetch('/admin/clear',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key})});
  $('msg').textContent=r.ok?'Cleared. The wall is empty.':(r.status===429?'Too many tries, wait a minute.':'Wrong key.');count()}
 catch(e){$('msg').textContent='Could not reach the server.'}};
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

const PAGES = { '/': 'join.html', '/join': 'join.html', '/wall': 'wall.html', '/wall/': 'wall.html' };

const server = http.createServer((req, res) => {
  req.on('error', () => {});
  res.on('error', () => {});
  const url = req.url.split('?')[0];

  try {
    if (url === '/events') {
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

    if (url === '/admin' && req.method === 'GET') return send(res, 200, 'text/html; charset=utf-8', ADMIN_HTML);

    if (url === '/admin/clear' && req.method === 'POST') {
      let body = '';
      req.on('data', d => { body += d; if (body.length > 1000) req.destroy(); });
      req.on('end', () => {
        const now = Date.now();
        if (now < lockUntil) return send(res, 429, 'text/plain', 'too many tries');
        let key = '';
        try { key = JSON.parse(body).key; } catch (e) { /* treated as wrong key */ }
        if (!keyOk(key)) {
          if (++badTries >= 8) { lockUntil = now + 60000; badTries = 0; }
          return send(res, 403, 'text/plain', 'wrong key');
        }
        badTries = 0;
        wishes = []; seq = 0; epoch = Date.now(); recent.clear(); save();
        broadcast({ init: [], epoch });
        send(res, 200, 'text/plain', 'cleared');
      });
      return;
    }

    if (url === '/info') {
      const list = addresses().map(ip => `http://${ip}:${PORT}/`);
      return send(res, 200, 'application/json', JSON.stringify({ candidates: list, join: list[0], count: wishes.length }));
    }
    if (url === '/health') return send(res, 200, 'text/plain', 'ok ' + wishes.length);
    if (url === '/favicon.ico') { res.writeHead(204); return res.end(); }

    const file = PAGES[url];
    if (!file) return send(res, 404, 'text/plain', 'Not found');
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
  console.log(`   Big screen : http://localhost:${PORT}/wall   (press F for fullscreen)`);
  console.log(`   Guests join: http://${ips[0]}:${PORT}/   (the QR code on the wall points here)`);
  if (ips.length > 1) {
    console.log(`\n   Several network addresses found: ${ips.join(', ')}`);
    console.log('   If the QR code does not open on your phone: press N on the wall to try the next address,');
    console.log('   or restart with  node server.js --ip=<your Wi-Fi address>');
  }
  console.log('\n   On the wall:  T = add a test diya   N = next address   Shift+R = clear all   F = fullscreen');
  console.log(`   Clear from any device: open /admin  (key: ${KEY_FROM_ENV ? 'the ADMIN_KEY you set' : ADMIN_KEY})\n`);
});
