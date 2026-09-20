// Prometheus exporter for the watcher's current state.
//
// Runs on its own port (3031 by default) rather than sharing the LAN dashboard's
// port: the dashboard is something you point a phone at, this is something a
// scraper hits every few seconds, and they want to be enabled and firewalled
// separately.
//
// Everything here is rendered straight from the live state on each scrape — no
// accumulator. A series exists if and only if it is true right now, so a server
// that goes unreachable stops reporting player counts instead of freezing them
// at the last value and drawing a flat line through an outage.
const http = require('http');

const CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

let server      = null;
let activePort  = null;
let stateSource = () => ({});
let onReady     = null;
let lastError   = null;

const startedAt = Date.now();

// ─── Exposition format ────────────────────────────────────────────────────────

function escapeLabel(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
}

function formatValue(v) {
  if (Number.isNaN(v)) return 'NaN';
  if (!Number.isFinite(v)) return v > 0 ? '+Inf' : '-Inf';
  return String(v);
}

// A metric family accumulates its samples so all of them can be printed under a
// single HELP/TYPE header, which is what the exposition format requires.
class Families {
  constructor() {
    this.order  = [];
    this.byName = new Map();
  }

  declare(name, kind, help) {
    if (this.byName.has(name)) return;
    this.byName.set(name, { name, kind, help, samples: [] });
    this.order.push(name);
  }

  add(name, labels, value) {
    if (value == null || !Number.isFinite(value)) return;
    this.byName.get(name).samples.push({ labels, value });
  }

  render() {
    const lines = [];
    for (const name of this.order) {
      const fam = this.byName.get(name);
      if (!fam.samples.length) continue;   // empty families are omitted entirely
      lines.push(`# HELP ${fam.name} ${fam.help}`);
      lines.push(`# TYPE ${fam.name} ${fam.kind}`);
      for (const { labels, value } of fam.samples) {
        const pairs = Object.entries(labels)
          .filter(([, v]) => v != null && v !== '')
          .map(([k, v]) => `${k}="${escapeLabel(v)}"`)
          .join(',');
        lines.push(`${fam.name}${pairs ? '{' + pairs + '}' : ''} ${formatValue(value)}`);
      }
    }
    return lines.join('\n') + '\n';
  }
}

// ─── Rendering ────────────────────────────────────────────────────────────────

// How long a player stays in the exposition at 0 after they log off. Without
// this their series would simply vanish, which draws a gap rather than a "not
// playing" line — the 1/0-per-player timeline needs those zeros to be real.
const DEFAULT_PLAYER_WINDOW_HOURS = 24;

/**
 * Renders the whole exposition from a state payload — the same shape the web
 * dashboard gets from main.js: { servers, pollInterval, history, ... }.
 */
function render(payload) {
  const f   = new Families();
  const now = Date.now();

  const servers  = Array.isArray(payload?.servers) ? payload.servers : [];
  const history  = payload?.history ?? {};
  const windowMs = (Number(payload?.metricsPlayerWindowHours) || DEFAULT_PLAYER_WINDOW_HOURS)
    * 3600 * 1000;

  f.declare('gameserver_watcher_up', 'gauge',
    'Always 1 while Server Watcher is answering scrapes.');
  f.declare('gameserver_watcher_start_time_seconds', 'gauge',
    'Unix timestamp of when the watcher process started.');
  f.declare('gameserver_watcher_poll_interval_seconds', 'gauge',
    'Configured seconds between queries of each server.');
  f.declare('gameserver_watcher_servers', 'gauge',
    'Number of servers the watcher is actively polling.');

  f.declare('gameserver_info', 'gauge',
    'Static labels for a watched server; always 1.');
  f.declare('gameserver_up', 'gauge',
    '1 if the last query of this server succeeded, 0 if it failed.');
  f.declare('gameserver_up_since_timestamp_seconds', 'gauge',
    'Unix timestamp of when the current unbroken run of successful queries began. Resets when the watcher restarts.');
  f.declare('gameserver_last_poll_timestamp_seconds', 'gauge',
    'Unix timestamp of the last completed query, successful or not.');
  f.declare('gameserver_query_ping_seconds', 'gauge',
    'Round-trip time of the last successful status query.');
  f.declare('gameserver_players', 'gauge',
    'Players currently on the server. Absent while the server is unreachable — the count is unknown then, not zero.');
  f.declare('gameserver_max_players', 'gauge',
    'Player slots the server reports.');
  f.declare('gameserver_self_online', 'gauge',
    '1 when the configured `self` player is on this server, 0 when they are not. Only for servers with `self` set.');
  f.declare('gameserver_version_info', 'gauge',
    'Server name, map and reported version as labels; always 1.');

  f.declare('gameserver_player_online', 'gauge',
    '1 while a player is on the server, 0 once they log off. Players leave the exposition entirely after the player window elapses.');
  f.declare('gameserver_player_session_seconds', 'gauge',
    'How long the current session of an online player has lasted. Uses the server\'s own connection time when it reports one, otherwise the watcher\'s observation.');
  f.declare('gameserver_player_last_seen_timestamp_seconds', 'gauge',
    'Unix timestamp this player was last observed on the server.');

  f.add('gameserver_watcher_up', {}, 1);
  f.add('gameserver_watcher_start_time_seconds', {}, Math.round(startedAt / 1000));
  f.add('gameserver_watcher_poll_interval_seconds', {}, Number(payload?.pollInterval) || 0);

  // Disabled servers are never queried, so reporting anything for them would be
  // inventing data.
  const watched = servers.filter(s => s.enabled !== false);
  f.add('gameserver_watcher_servers', {}, watched.length);

  for (const s of watched) {
    const server = { server: s.label || s.key };
    f.add('gameserver_info', {
      ...server,
      host:  s.host,
      port:  s.port != null ? String(s.port) : '',
      appid: s.appid != null ? String(s.appid) : '',
    }, 1);

    // Nothing is known about a server until its first poll lands.
    if (s.pending) continue;

    f.add('gameserver_up', server, s.online ? 1 : 0);
    if (s.lastUpdated) f.add('gameserver_last_poll_timestamp_seconds', server, s.lastUpdated / 1000);
    if (s.onlineSince) f.add('gameserver_up_since_timestamp_seconds', server, s.onlineSince / 1000);

    const players   = Array.isArray(s.players) ? s.players : [];
    const onlineNow = new Set(s.online ? players : []);

    if (s.online) {
      f.add('gameserver_players', server, players.length);
      if (s.maxPlayers) f.add('gameserver_max_players', server, s.maxPlayers);
      if (Number.isFinite(s.ping)) f.add('gameserver_query_ping_seconds', server, s.ping / 1000);
      if (s.self) f.add('gameserver_self_online', server, onlineNow.has(s.self) ? 1 : 0);
      f.add('gameserver_version_info', {
        ...server,
        name:    s.name    || '',
        map:     s.map     || '',
        version: s.version || '',
      }, 1);
    }

    // Per-player series come from the history map, which is the only place a
    // logged-off player still exists. While the server is unreachable we cannot
    // tell who is on it, so nobody is reported as either online or offline.
    const seen  = history[s.key] ?? {};
    const names = new Set([...Object.keys(seen), ...onlineNow]);

    for (const name of names) {
      const entry    = seen[name];
      const lastSeen = onlineNow.has(name) ? now : (entry?.lastSeen ?? 0);
      if (!lastSeen) continue;

      const labels = { ...server, player: name };
      f.add('gameserver_player_last_seen_timestamp_seconds', labels, lastSeen / 1000);

      if (!s.online) continue;
      if (onlineNow.has(name)) {
        f.add('gameserver_player_online', labels, 1);
        const start = entry?.sessionStart ?? now;
        f.add('gameserver_player_session_seconds', labels, Math.max(0, (now - start) / 1000));
      } else if (now - lastSeen <= windowMs) {
        f.add('gameserver_player_online', labels, 0);
      }
    }
  }

  return f.render();
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────

function handle(req, res) {
  const urlPath = (req.url || '/').split('?')[0];

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    return res.end('Method Not Allowed');
  }

  if (urlPath === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('server-watcher — metrics at /metrics\n');
  }

  if (urlPath !== '/metrics') {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Not Found');
  }

  const body = render(stateSource());
  res.writeHead(200, {
    'Content-Type': CONTENT_TYPE,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

// getState() → the same payload the web dashboard serves.
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
      console.error('[metrics] Request failed:', err);
      if (!res.headersSent) res.writeHead(500);
      res.end('Internal Server Error');
    }
  });

  server.on('error', (err) => {
    console.error(`[metrics] Could not listen on port ${port}:`, err.message);
    lastError = err.code === 'EADDRINUSE' ? `port ${port} already in use` : err.message;
    server = null;
    activePort = null;
    if (onReady) onReady(null);
  });

  server.listen(port, () => {
    activePort = port;
    lastError = null;
    console.log(`[metrics] Prometheus endpoint on http://localhost:${port}/metrics`);
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
function getPort()  { return activePort; }

// Why the exporter isn't up, for the desktop header. Null when all is well.
function getError() { return lastError; }

module.exports = { start, stop, getPort, getError, render };
