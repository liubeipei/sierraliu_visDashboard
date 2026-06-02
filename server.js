const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readState() {
  ensureDataDir();
  if (!fs.existsSync(STATE_FILE)) {
    return {
      version: 1,
      updatedAt: null,
      state: {
        parsed: { t2i: null, i2i: null },
        projectName: { t2i: '', i2i: '' },
        reports: [],
      },
    };
  }
  const raw = fs.readFileSync(STATE_FILE, 'utf8');
  return JSON.parse(raw);
}

function writeState(nextState) {
  ensureDataDir();
  const payload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    state: nextState,
  };
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
  fs.renameSync(tmp, STATE_FILE);
  return payload;
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function safeResolvePath(urlPathname) {
  const pathname = decodeURIComponent(urlPathname.split('?')[0]);
  const relative = pathname === '/' ? '/index.html' : pathname;
  const target = path.resolve(ROOT_DIR, `.${relative}`);
  if (!target.startsWith(ROOT_DIR)) return null;
  return target;
}

function serveStatic(req, res, pathname) {
  const filePath = safeResolvePath(pathname);
  if (!filePath) {
    sendJson(res, 403, { error: 'Forbidden path' });
    return;
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = reqUrl;

  if (pathname === '/api/health' && req.method === 'GET') {
    sendJson(res, 200, { ok: true, serverTime: new Date().toISOString() });
    return;
  }

  if (pathname === '/api/state' && req.method === 'GET') {
    try {
      const payload = readState();
      sendJson(res, 200, payload);
    } catch (e) {
      sendJson(res, 500, { error: `Read failed: ${e.message}` });
    }
    return;
  }

  if (pathname === '/api/state' && req.method === 'PUT') {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
      if (body.length > 30 * 1024 * 1024) {
        req.destroy(new Error('Payload too large'));
      }
    });
    req.on('error', () => {
      sendJson(res, 400, { error: 'Invalid request stream' });
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body || '{}');
        if (!parsed || typeof parsed !== 'object' || !parsed.state) {
          sendJson(res, 400, { error: 'Invalid payload: missing state' });
          return;
        }
        const saved = writeState(parsed.state);
        sendJson(res, 200, { ok: true, updatedAt: saved.updatedAt });
      } catch (e) {
        sendJson(res, 400, { error: `Save failed: ${e.message}` });
      }
    });
    return;
  }

  if (req.method !== 'GET' && !pathname.startsWith('/api/')) {
    sendJson(res, 405, { error: 'Method Not Allowed' });
    return;
  }

  serveStatic(req, res, pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`[promptviz-server] running at http://${HOST}:${PORT}`);
});
