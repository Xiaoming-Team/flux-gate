const express = require('express');
const httpProxy = require('http-proxy');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = 8080;
const CONFIG_FILE = path.join(__dirname, 'config.json');
const AUTH_FILE = path.join(__dirname, 'auth.json');

// ── Helpers ─────────────────────────────────────────────────

function loadAuth() {
  try { return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')); }
  catch { return { username: 'admin', password_hash: '' }; }
}

function saveAuth(auth) {
  fs.writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2));
}

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

function ensureDefaultAuth() {
  const auth = loadAuth();
  if (!auth.password_hash) {
    auth.username = 'admin';
    auth.password_hash = hashPassword('admin');
    saveAuth(auth);
    console.log('[!] Default credentials: admin / admin');
  }
}

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch { return { routes: [] }; }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

function getSubdomain(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  const parts = host.split('.');
  return parts.length >= 3 ? parts[0] : null;
}

function verifyBasicAuth(req) {
  const auth = loadAuth();
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Basic ')) return false;
  try {
    const [user, pass] = Buffer.from(header.slice(6), 'base64').toString().split(':');
    return user === auth.username && hashPassword(pass) === auth.password_hash;
  } catch { return false; }
}

function sendBasicChallenge(res) {
  res.setHeader('WWW-Authenticate', 'Basic realm="iplab.cc"');
  res.status(401).send('Unauthorized');
}

// ── Proxy setup ─────────────────────────────────────────────

const httpProxyInstance = httpProxy.createProxyServer({ ws: true, changeOrigin: true });
httpProxyInstance.on('error', (err, req, res) => {
  console.error('[proxy error]', err.message);
  if (res.writeHead) res.writeHead(502);
  if (res.end) res.end('Proxy error: ' + err.message);
});

// ── Express ─────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set('view engine', 'ejs');
app.set('views', __dirname);

// ── All requests: unified handler ───────────────────────────

app.use((req, res, next) => {
  const subdomain = getSubdomain(req);

  // ── Subdomain: proxy to target ──
  if (subdomain) {
    const config = loadConfig();
    const route = config.routes.find(r => r.subdomain === subdomain);

    if (!route) {
      res.status(404).send(`子域名 <strong>${subdomain}</strong> 未配置`);
      return;
    }

    if (!verifyBasicAuth(req)) { sendBasicChallenge(res); return; }

    const target = `http://${route.ip}:${route.port}`;
    console.log(`[→] ${subdomain}.iplab.cc ${req.method} ${req.path} → ${target}`);

    httpProxyInstance.web(req, res, { target });
    return;
  }

  // ── Main domain: Basic Auth + management UI ──
  if (!verifyBasicAuth(req)) { sendBasicChallenge(res); return; }
  next();
});

app.on('upgrade', (req, socket, head) => {
  const subdomain = getSubdomain(req);
  if (!subdomain) return;
  const route = loadConfig().routes.find(r => r.subdomain === subdomain);
  if (!route) return;
  if (!verifyBasicAuth(req)) { socket.destroy(); return; }
  httpProxyInstance.ws(req, socket, head, { target: `http://${route.ip}:${route.port}` });
});

// ── Management UI routes (main domain only) ─────────────────

app.get('/', (req, res) => {
  res.render('index.ejs', { baseDomain: 'iplab.cc', routes: loadConfig().routes || [] });
});

app.get('/settings', (req, res) => {
  res.render('settings.ejs', { error: null, success: null });
});

app.post('/settings/password', (req, res) => {
  const { current, new_pass, confirm } = req.body;
  const auth = loadAuth();
  if (hashPassword(current) !== auth.password_hash) {
    return res.render('settings.ejs', { error: '当前密码错误', success: null });
  }
  if (new_pass !== confirm) {
    return res.render('settings.ejs', { error: '两次新密码不一致', success: null });
  }
  if (new_pass.length < 4) {
    return res.render('settings.ejs', { error: '新密码至少4位', success: null });
  }
  auth.password_hash = hashPassword(new_pass);
  saveAuth(auth);
  res.render('settings.ejs', { error: null, success: '密码修改成功' });
});

// ── API ────────────────────────────────────────────────────

app.get('/api/routes', (req, res) => {
  if (!verifyBasicAuth(req)) { sendBasicChallenge(res); return; }
  res.json(loadConfig().routes);
});

app.post('/api/routes', (req, res) => {
  if (!verifyBasicAuth(req)) { sendBasicChallenge(res); return; }
  const { subdomain, ip, port, description } = req.body;
  if (!subdomain || !ip || !port) return res.status(400).json({ error: '字段不能为空' });
  const cleanSub = subdomain.toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (!cleanSub) return res.status(400).json({ error: '子域名格式无效' });

  const config = loadConfig();
  const idx = config.routes.findIndex(r => r.subdomain === cleanSub);
  const entry = { subdomain: cleanSub, ip, port, description: description || '' };
  if (idx >= 0) config.routes[idx] = entry;
  else config.routes.push(entry);
  saveConfig(config);
  res.json({ ok: true, routes: config.routes });
});

app.delete('/api/routes/:subdomain', (req, res) => {
  if (!verifyBasicAuth(req)) { sendBasicChallenge(res); return; }
  const config = loadConfig();
  config.routes = config.routes.filter(r => r.subdomain !== req.params.subdomain);
  saveConfig(config);
  res.json({ ok: true, routes: config.routes });
});

// ── Start ──────────────────────────────────────────────────

ensureDefaultAuth();
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Proxy server running at http://localhost:${PORT}`);
});
