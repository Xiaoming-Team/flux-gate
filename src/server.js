const express = require('express');
const httpProxy = require('http-proxy');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONFIG_FILE = path.join(__dirname, '..', 'config.json');

// ── Helpers ─────────────────────────────────────────────────

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch { return { port: 8080, baseDomain: 'localhost', auth: { username: 'admin', password_hash: '' }, routes: [] }; }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

function ensureDefaultAuth() {
  const config = loadConfig();
  if (!config.auth.password_hash) {
    config.auth.username = 'admin';
    config.auth.password_hash = hashPassword('admin');
    saveConfig(config);
    console.log('[!] Default credentials: admin / admin');
  }
}

function getSubdomain(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  const parts = host.split('.');
  return parts.length >= 3 ? parts[0] : null;
}

function verifyBasicAuth(req) {
  const config = loadConfig();
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Basic ')) return false;
  try {
    const [user, pass] = Buffer.from(header.slice(6), 'base64').toString().split(':');
    return user === config.auth.username && hashPassword(pass) === config.auth.password_hash;
  } catch { return false; }
}

function sendBasicChallenge(res, realm) {
  res.setHeader('WWW-Authenticate', `Basic realm="${realm}"`);
  res.status(401).send('Unauthorized');
}

// ── Load config ─────────────────────────────────────────────

let config = loadConfig();
const PORT = config.port || 8080;
const BASE_DOMAIN = config.baseDomain || 'localhost';

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
  const currentConfig = loadConfig(); // ✅ Always use latest config
  const subdomain = getSubdomain(req);

  // ── Subdomain: proxy to target ──
  if (subdomain) {
    const route = currentConfig.routes.find(r => r.subdomain === subdomain);

    if (!route) {
      res.status(404).send(`子域名 <strong>${subdomain}</strong> 未配置`);
      return;
    }

    if (!verifyBasicAuth(req)) { sendBasicChallenge(res, BASE_DOMAIN); return; }

    const target = `http://${route.ip}:${route.port}`;
    console.log(`[→] ${subdomain}.${BASE_DOMAIN} ${req.method} ${req.path} → ${target}`);

    httpProxyInstance.web(req, res, { target });
    return;
  }

  // ── Main domain: Basic Auth + management UI ──
  if (!verifyBasicAuth(req)) { sendBasicChallenge(res, BASE_DOMAIN); return; }
  next();
});

app.on('upgrade', (req, socket, head) => {
  const currentConfig = loadConfig(); // ✅ Always use latest config
  const subdomain = getSubdomain(req);
  if (!subdomain) return;
  const route = currentConfig.routes.find(r => r.subdomain === subdomain);
  if (!route) return;
  if (!verifyBasicAuth(req)) { socket.destroy(); return; }
  httpProxyInstance.ws(req, socket, head, { target: `http://${route.ip}:${route.port}` });
});

// ── Management UI routes (main domain only) ─────────────────

app.get('/', (req, res) => {
  const currentConfig = loadConfig(); // ✅ Always use latest config
  res.render('index.ejs', { baseDomain: BASE_DOMAIN, routes: currentConfig.routes || [] });
});

app.get('/settings', (req, res) => {
  res.render('settings.ejs', { error: null, success: null });
});

app.post('/settings/password', (req, res) => {
  const { current, new_pass, confirm } = req.body;
  const cfg = loadConfig();
  if (hashPassword(current) !== cfg.auth.password_hash) {
    return res.render('settings.ejs', { error: '当前密码错误', success: null });
  }
  if (new_pass !== confirm) {
    return res.render('settings.ejs', { error: '两次新密码不一致', success: null });
  }
  if (new_pass.length < 4) {
    return res.render('settings.ejs', { error: '新密码至少4位', success: null });
  }
  cfg.auth.password_hash = hashPassword(new_pass);
  saveConfig(cfg);
  res.render('settings.ejs', { error: null, success: '密码修改成功' });
});

// ── API ────────────────────────────────────────────────────

app.get('/api/routes', (req, res) => {
  if (!verifyBasicAuth(req)) { sendBasicChallenge(res, BASE_DOMAIN); return; }
  const currentConfig = loadConfig(); // ✅ Always use latest config
  res.json(currentConfig.routes);
});

app.post('/api/routes', (req, res) => {
  if (!verifyBasicAuth(req)) { sendBasicChallenge(res, BASE_DOMAIN); return; }
  const { subdomain, ip, port, description } = req.body;
  if (!subdomain || !ip || !port) return res.status(400).json({ error: '字段不能为空' });
  const cleanSub = subdomain.toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (!cleanSub) return res.status(400).json({ error: '子域名格式无效' });

  const cfg = loadConfig();
  const idx = cfg.routes.findIndex(r => r.subdomain === cleanSub);
  const entry = { subdomain: cleanSub, ip, port, description: description || '' };
  if (idx >= 0) cfg.routes[idx] = entry;
  else cfg.routes.push(entry);
  saveConfig(cfg);
  res.json({ ok: true, routes: cfg.routes });
});

app.delete('/api/routes/:subdomain', (req, res) => {
  if (!verifyBasicAuth(req)) { sendBasicChallenge(res, BASE_DOMAIN); return; }
  const cfg = loadConfig();
  cfg.routes = cfg.routes.filter(r => r.subdomain !== req.params.subdomain);
  saveConfig(cfg);
  res.json({ ok: true, routes: cfg.routes });
});

// ── Start ──────────────────────────────────────────────────

ensureDefaultAuth();
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✓ Proxy server running at http://localhost:${PORT}`);
  console.log(`✓ Base domain: ${BASE_DOMAIN}`);
  console.log(`✓ Routes configured: ${config.routes.length}`);
});
