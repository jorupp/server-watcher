// A tiny read-only HTTP dashboard. The Electron app does all the polling;
// this just hands out the current state so a phone on the LAN can see it.
const http = require('http');
const fs   = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
};

let server      = null;
let activePort  = null;
let stateSource = () => ({});
let onReady     = null;
let lastError   = null;

// Only web/ and shared/ are reachable — never the rest of the app directory
// (servers.yaml holds passwords).
function resolveStatic(urlPath) {
  const rel = urlPath === '/' ? 'web/index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  if (!/^(web|shared)\/[\w.\-/]+$/.test(rel) || rel.includes('..')) return null;

  const abs  = path.resolve(__dirname, rel);
  const root = path.resolve(__dirname);
  if (!abs.startsWith(root + path.sep)) return null;
  return abs;
}

function sendJson(res, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(200, {
    'Content-Type': MIME['.json'],
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function handle(req, res) {
  const urlPath = (req.url || '/').split('?')[0];

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    return res.end('Method Not Allowed');
  }

  if (urlPath === '/api/state') return sendJson(res, stateSource());

  const file = resolveStatic(urlPath);
  if (!file) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Not Found');
  }

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not Found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

// getState() → the payload served at /api/state.
// ready() fires once the socket is actually listening, so the UI can show the port.
function start(port, getState, ready) {
  stateSource = getState;
  onReady     = ready || null;

  // Config reloads call this on every change; only rebuild if the port moved.
  if (server && activePort === port) return;

  stop();
  if (!port) return;

  server = http.createServer((req, res) => {
    try {
      handle(req, res);
    } catch (err) {
      console.error('[web] Request failed:', err);
      if (!res.headersSent) res.writeHead(500);
      res.end('Internal Server Error');
    }
  });

  server.on('error', (err) => {
    console.error(`[web] Could not listen on port ${port}:`, err.message);
    lastError = err.code === 'EADDRINUSE'
      ? `port ${port} already in use`
      : err.message;
    server = null;
    activePort = null;
    if (onReady) onReady(null);
  });

  server.listen(port, () => {
    activePort = port;
    lastError = null;
    console.log(`[web] Dashboard on http://localhost:${port}/`);
    if (onReady) onReady(port);
  });
}

function stop() {
  if (server) {
    server.close();
    server = null;
  }
  activePort = null;
}

// Null until listen() actually succeeds, so the UI never advertises a dead port.
function getPort() {
  return activePort;
}

// Why the dashboard isn't up, for the desktop header. Null when all is well.
function getError() {
  return lastError;
}

module.exports = { start, stop, getPort, getError };
