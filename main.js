const {
  app, BrowserWindow, Tray, Menu, nativeImage,
  Notification, ipcMain, shell,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const yaml = require('js-yaml');
const GameDig = require('gamedig');
const factorio = require('./factorio');
const webserver = require('./webserver');
const metrics = require('./metrics');

if (process.platform === 'win32') {
  // A custom AUMID only works once the app has a matching Start Menu shortcut
  // (i.e. after packaging/installing). While running unpackaged in development,
  // process.execPath (the electron.exe) is already registered with Windows and
  // is the reliable choice. Use it unconditionally for now; swap to a proper
  // AUMID if/when you build an installer.
  app.setAppUserModelId(process.execPath);
}

// Hot-reload in dev: renderer files trigger a soft reload, main/preload trigger
// a full restart.  electron-reload is a devDependency so this is a no-op in prod.
if (process.env.NODE_ENV === 'development') {
  require('electron-reload')(__dirname, {
    electron: process.execPath,
    hardResetMethod: 'exit',
    ignored: /node_modules|\.git|servers\.yaml|history\.yaml/,
  });
}

const CONFIG_PATH  = path.join(__dirname, 'servers.yaml');
const HISTORY_PATH = path.join(__dirname, 'history.yaml');
const DEFAULT_POLL_INTERVAL = 30;
const RETRY_DELAY_MS = 5_000;
// Extra attempts (RETRY_DELAY_MS apart) before a server that was up is declared down.
const DOWN_CONFIRM_RETRIES = 2;
const DEFAULT_WEB_PORT = 3030;
// Prometheus scrape endpoint. Separate from the dashboard port so the two can be
// turned on, off and firewalled independently.
const DEFAULT_METRICS_PORT = 3031;
// How long a player keeps reporting a 0 in the metrics after logging off, so the
// per-player timeline draws a "not playing" line instead of a gap.
const DEFAULT_METRICS_PLAYER_WINDOW_HOURS = 24;
// How often to re-nudge you when a `self` server has players and you're not on it.
const DEFAULT_SELF_REMINDER_MINUTES = 10;

let mainWindow = null;
let tray = null;

// Default: the generic Windows system notification sound.
const DEFAULT_SOUND = path.join(
  process.env.SystemRoot || 'C:\\Windows',
  'Media', 'Windows Notify System Generic.wav'
);

let config = {
  poll_interval: DEFAULT_POLL_INTERVAL,
  servers: [],
  notification_sound: null,
  web_port: DEFAULT_WEB_PORT,
  metrics_port: DEFAULT_METRICS_PORT,
  metrics_player_window_hours: DEFAULT_METRICS_PLAYER_WINDOW_HOURS,
  self_reminder_minutes: DEFAULT_SELF_REMINDER_MINUTES,
};
const serverStates  = new Map(); // key -> state object
const knownPlayers  = new Map(); // key -> Set<playerName>
const initialized   = new Set(); // keys with at least one successful baseline poll
const serverTimers  = new Map(); // key -> timeoutId
// key -> Map<playerName, { lastSeen: number, sessionStart: number }>
const playerHistory = new Map();
// key -> timestamp of the next "players online without you" reminder
const selfReminders = new Map();

// ─── Helpers ──────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function serverPort(cfg) {
  return Number(cfg.port) || (cfg.type === 'factorio' ? factorio.DEFAULT_PORT : 27015);
}

function serverKey(cfg) {
  const port = cfg.type === 'factorio' ? serverPort(cfg) : cfg.port || 27015;
  return `${cfg.host}:${port}`;
}

// A server is polled and counted unless it was explicitly disabled.
function isEnabled(cfg) {
  return cfg?.enabled !== false;
}

function enabledStates() {
  return Array.from(serverStates.values()).filter(isEnabled);
}

// ─── Config ───────────────────────────────────────────────────────────────────

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = yaml.load(raw);
    config = {
      poll_interval: Math.max(5, Number(parsed?.poll_interval) || DEFAULT_POLL_INTERVAL),
      notification_sound: parsed?.notification_sound || null,
      // web_port: false / 0 turns the dashboard off entirely.
      web_port: parsed?.web_port === false ? null
              : Number(parsed?.web_port) || DEFAULT_WEB_PORT,
      // metrics_port: false / 0 turns the Prometheus endpoint off entirely.
      metrics_port: parsed?.metrics_port === false ? null
              : Number(parsed?.metrics_port) || DEFAULT_METRICS_PORT,
      metrics_player_window_hours:
              Math.max(1, Number(parsed?.metrics_player_window_hours)
                          || DEFAULT_METRICS_PLAYER_WINDOW_HOURS),
      self_reminder_minutes: parsed?.self_reminder_minutes === false ? null
              : Math.max(1, Number(parsed?.self_reminder_minutes) || DEFAULT_SELF_REMINDER_MINUTES),
      servers: Array.isArray(parsed?.servers) ? parsed.servers : [],
    };
    return null;
  } catch (err) {
    return err.message;
  }
}

function initPendingStates() {
  serverStates.clear();
  for (const cfg of config.servers) {
    const key = serverKey(cfg);
    serverStates.set(key, {
      key,
      label:    cfg.label || key,
      host:     cfg.host,
      port:     serverPort(cfg),
      type:     cfg.type,
      password: cfg.password || '',
      joinPort: cfg.joinPort ? Number(cfg.joinPort) : null,
      appid:    cfg.appid    ? Number(cfg.appid)    : null,
      self:     cfg.self || null,
      enabled:  isEnabled(cfg),
      // Disabled servers are never queried, so they're not "pending" either.
      pending:  isEnabled(cfg),
      online:   false,
      retrying: false,
      retryAt:  null,
      // { attempt, of, retryAt } while rechecking a server that just missed a poll.
      confirming: null,
      lastUpdated: null,
    });
  }
}

// ─── Querying ─────────────────────────────────────────────────────────────────

// Single attempt only — caller decides whether to retry.
async function querySingle(cfg) {
  let type = cfg.type || 'protocol-valve';
  if (type === 'steam') type = 'protocol-valve';

  const options = {
    type,
    host: cfg.host,
    port: serverPort(cfg),
    maxAttempts: 1,
    socketTimeout: 5000,
    givenPortOnly: true,
  };
  if (cfg.appid) options.appid = Number(cfg.appid);

  try {
    const s = type === 'factorio'
      ? await factorio.query({
        host: options.host,
        port: options.port,
        timeout: options.socketTimeout,
        rconPort: cfg.rcon_port,
        rconPassword: cfg.rcon_password,
      })
      : await GameDig.query(options);

    // Valve's player records carry how many seconds each player has been
    // connected. That's the server's own count, so it survives watcher restarts
    // and beats anything we can infer from polling. Not every game fills it in.
    const playerTimes = {};
    for (const p of s.players) {
      const secs = Number(p.raw?.time);
      if (p.name?.trim() && Number.isFinite(secs) && secs > 0) playerTimes[p.name] = secs;
    }

    return {
      online:     true,
      name:       s.name || cfg.label,
      map:        s.map  || '',
      version:    s.raw?.version || '',
      players:    s.players.map(p => p.name).filter(n => n?.trim()),
      playerTimes,
      maxPlayers: s.maxplayers || 0,
      ping:       type === 'factorio' ? null : Math.round(s.ping || 0),
    };
  } catch (err) {
    return {
      online: false,
      error:  err.message || 'Query failed',
      errorDetail: [
        `Host:  ${cfg.host}:${options.port}`,
        `Type:  ${type}`,
        `Error: ${err.message || 'Query failed'}`,
      ].join('\n'),
    };
  }
}

// Merge a query result into the stored state for a server.
function applyResult(key, cfg, result, extra = {}) {
  const prev = serverStates.get(key) ?? {};
  // Start of the current unbroken run of successful queries. A failed query
  // clears it, so this is uptime as the watcher saw it — it also resets when the
  // app restarts, since we have no idea what happened while it was closed.
  const onlineSince = result.online
    ? (prev.online ? (prev.onlineSince ?? Date.now()) : Date.now())
    : null;
  serverStates.set(key, {
    ...prev,
    onlineSince,
    key,
    label:    cfg.label || key,
    host:     cfg.host,
    port:     serverPort(cfg),
    password: cfg.password || '',
    joinPort: cfg.joinPort ? Number(cfg.joinPort) : null,
    self:     cfg.self || null,
    enabled:  isEnabled(cfg),
    pending:  false,
    retrying: false,
    retryAt:  null,
    confirming: null,
    ...result,
    ...extra,
    lastUpdated: Date.now(),
  });
}

// Merge only a partial update without touching lastUpdated.
function patchState(key, patch) {
  const s = serverStates.get(key);
  if (s) serverStates.set(key, { ...s, ...patch });
}

// ─── Player history ───────────────────────────────────────────────────────────

function loadHistory() {
  try {
    if (!fs.existsSync(HISTORY_PATH)) return;
    const parsed = yaml.load(fs.readFileSync(HISTORY_PATH, 'utf8'));
    if (!parsed?.servers) return;
    for (const [key, serverData] of Object.entries(parsed.servers ?? {})) {
      const playerMap = new Map();
      for (const [name, d] of Object.entries(serverData?.players ?? {})) {
        const lastSeen     = d.last_seen     ? new Date(d.last_seen).getTime()     : 0;
        // Backward compat: old history files may not have session_start; fall back to lastSeen.
        const sessionStart = d.session_start ? new Date(d.session_start).getTime() : lastSeen;
        playerMap.set(name, { lastSeen, sessionStart });
      }
      playerHistory.set(key, playerMap);
    }
  } catch (err) {
    console.error('[history] Failed to load:', err);
  }
}

function saveHistory() {
  const out = { servers: {} };
  for (const [key, players] of playerHistory) {
    const entries = {};
    for (const [name, d] of players) {
      entries[name] = {
        last_seen:     new Date(d.lastSeen).toISOString(),
        session_start: new Date(d.sessionStart).toISOString(),
      };
    }
    out.servers[key] = { players: entries };
  }
  fs.writeFile(
    HISTORY_PATH,
    '# Auto-generated by Server Watcher — do not edit manually\n' + yaml.dump(out),
    'utf8',
    (err) => { if (err) console.error('[history] Failed to save:', err); }
  );
}

// Returns the history for all servers as a plain object suitable for IPC.
function historyForIPC() {
  const out = {};
  for (const [key, players] of playerHistory) {
    out[key] = {};
    for (const [name, d] of players) {
      out[key][name] = { lastSeen: d.lastSeen, sessionStart: d.sessionStart };
    }
  }
  return out;
}

// ─── Player join detection ────────────────────────────────────────────────────

// Periodic nudge for `self` servers: people are playing and you aren't there.
// Armed when that becomes true, then repeats on the configured interval; cleared
// as soon as you join or the server empties, so it fires promptly next time.
function checkSelfReminder(key, cfg, current, now) {
  const self = cfg.self;
  const intervalMin = config.self_reminder_minutes;
  if (!self || !intervalMin) return;

  const othersPlaying = current.size > 0 && !current.has(self);
  if (!othersPlaying) {
    selfReminders.delete(key);
    return;
  }

  const intervalMs = intervalMin * 60 * 1000;
  const dueAt = selfReminders.get(key);
  if (dueAt == null) {
    selfReminders.set(key, now + intervalMs);
    return;
  }
  if (now < dueAt) return;

  selfReminders.set(key, now + intervalMs);
  const label = serverStates.get(key)?.label ?? key;
  const names = Array.from(current).join(', ');
  notify(
    `${current.size} player${current.size === 1 ? '' : 's'} on ${label}`,
    names,
    cfg.notification_sound
  );
}

function checkJoins(key, cfg, result) {
  if (!result.online) return;
  const current  = new Set(result.players);
  const previous = knownPlayers.get(key);
  const now      = Date.now();
  const isFirst  = !initialized.has(key);
  const self     = cfg.self || null;
  // While you're on the server yourself you can already see who comes and goes,
  // so other players' join notifications are muted.
  const selfPresent = self ? current.has(self) : false;

  let serverHistory = playerHistory.get(key);
  if (!serverHistory) {
    serverHistory = new Map();
    playerHistory.set(key, serverHistory);
  }

  for (const name of current) {
    const existing  = serverHistory.get(name);
    const isNewJoin = previous !== undefined && !previous.has(name);

    // Valve servers report how long each player has been connected, which knows
    // about time the watcher was closed for. Only used to *establish* a session
    // start, never to keep re-deriving one — the reported value drifts by a
    // second between polls and that would jitter every chart built on it.
    const reported = Number(result.playerTimes?.[name]);
    const reportedStart = Number.isFinite(reported) ? now - reported * 1000 : null;

    let sessionStart;
    if (existing && !isNewJoin) {
      // Continuing an ongoing session — preserve the start time.
      // On first poll after app restart, also preserve it if the player was
      // seen recently enough that they're likely in the same session.
      const recentEnough = (now - existing.lastSeen) < config.poll_interval * 3 * 1000;
      sessionStart = (isFirst && !recentEnough) ? (reportedStart ?? now) : existing.sessionStart;
    } else {
      // New join (or first time we've ever seen this player).
      sessionStart = reportedStart ?? now;
    }

    serverHistory.set(name, { lastSeen: now, sessionStart });

    // Fire join notification after the baseline is established.
    if (!isFirst && isNewJoin && (!selfPresent || name === self)) {
      const label = serverStates.get(key)?.label ?? key;
      notify(`${name} joined`, `${label}  •  ${result.name || key}`, cfg.notification_sound);
    }
  }

  // Leaving is only announced for `self` — that's the one you asked about.
  if (self && !isFirst && previous?.has(self) && !current.has(self)) {
    const label = serverStates.get(key)?.label ?? key;
    notify(`${self} left`, `${label}  •  ${result.name || key}`, cfg.notification_sound);
  }

  checkSelfReminder(key, cfg, current, now);

  knownPlayers.set(key, current);
  initialized.add(key);
  saveHistory();
}

// ─── Per-server poll cycle ────────────────────────────────────────────────────

async function runServerPoll(cfg) {
  const key = serverKey(cfg);
  const wasOnline = serverStates.get(key)?.online === true;

  // ── Attempt 1 ──
  const r1 = await querySingle(cfg);

  // A single dropped UDP query is common and doesn't mean the server went down.
  // If it was up, recheck a few times before believing it — and until then leave
  // the state (online, players, lastUpdated) exactly as it was, so the UI, the
  // join/leave tracking and Prometheus all keep reporting the last good poll.
  if (!r1.online && wasOnline) {
    let last = r1;
    for (let attempt = 1; attempt <= DOWN_CONFIRM_RETRIES; attempt++) {
      patchState(key, {
        confirming: { attempt, of: DOWN_CONFIRM_RETRIES, retryAt: Date.now() + RETRY_DELAY_MS },
      });
      pushUpdate();
      await sleep(RETRY_DELAY_MS);

      last = await querySingle(cfg);
      if (last.online) break;
    }
    applyResult(key, cfg, last);
    pushUpdate();
    if (last.online) checkJoins(key, cfg, last);
    return;
  }

  applyResult(key, cfg, r1);
  pushUpdate();

  if (r1.online) {
    checkJoins(key, cfg, r1);
    return;
  }

  // ── Attempt 1 failed: show error + countdown ──
  const retryAt = Date.now() + RETRY_DELAY_MS;
  patchState(key, { retryAt });
  pushUpdate();

  await sleep(RETRY_DELAY_MS);

  // ── Attempt 2 ──
  patchState(key, { retrying: true, retryAt: null });
  pushUpdate();

  const r2 = await querySingle(cfg);
  applyResult(key, cfg, r2);
  pushUpdate();

  if (r2.online) checkJoins(key, cfg, r2);
}

function scheduleServerPoll(cfg, delayMs = 0) {
  const key = serverKey(cfg);
  const prev = serverTimers.get(key);
  if (prev != null) clearTimeout(prev);

  const id = setTimeout(async () => {
    await runServerPoll(cfg);
    scheduleServerPoll(cfg, config.poll_interval * 1000);
  }, delayMs);

  serverTimers.set(key, id);
}

function startPolling() {
  for (const id of serverTimers.values()) clearTimeout(id);
  serverTimers.clear();
  for (const cfg of config.servers) {
    if (isEnabled(cfg)) scheduleServerPoll(cfg, 0);
  }
}

function resetAndRestart() {
  knownPlayers.clear();
  initialized.clear();
  selfReminders.clear();
  initPendingStates();
  startWebserver();
  startMetricsServer();
  pushUpdate();
  startPolling();
}

// ─── Notifications ────────────────────────────────────────────────────────────

// serverSound: per-server override → global config → Windows default
function resolveSound(serverSound) {
  return serverSound || config.notification_sound || DEFAULT_SOUND;
}

function playSound(serverSound) {
  const soundPath = resolveSound(serverSound);
  if (!fs.existsSync(soundPath)) {
    console.warn('[sound] File not found:', soundPath);
    return;
  }
  // PowerShell's SoundPlayer is the lightest built-in option on Windows.
  const escaped = soundPath.replace(/'/g, "''");
  exec(`powershell -NoProfile -c "(New-Object Media.SoundPlayer '${escaped}').PlaySync()"`);
}

function notify(title, body, serverSound) {
  if (!Notification.isSupported()) {
    console.warn('[notify] Notifications not supported on this system');
    return;
  }
  try {
    // Play sound ourselves so the path is configurable; silence the toast's
    // built-in sound to avoid a double-beep.
    playSound(serverSound);
    new Notification({ title, body, silent: true }).show();
  } catch (err) {
    console.error('[notify] Failed to show notification:', err);
  }
}

// ─── IPC ──────────────────────────────────────────────────────────────────────

function statePayload() {
  return {
    servers:      Array.from(serverStates.values()),
    pollInterval: config.poll_interval,
    history:      historyForIPC(),
    webPort:      webserver.getPort(),
    webError:     webserver.getError(),
    metricsPort:  metrics.getPort(),
    metricsError: metrics.getError(),
    metricsPlayerWindowHours: config.metrics_player_window_hours,
  };
}

// Same shape, minus the Steam passwords — the web UI has no Join button and the
// dashboard is reachable by anything on the LAN.
function webPayload() {
  const p = statePayload();
  p.servers = p.servers.map(({ password, ...rest }) => rest);
  p.generatedAt = Date.now();
  return p;
}

function startWebserver() {
  // pushUpdate on ready so the header can advertise the port once it's live.
  webserver.start(config.web_port, webPayload, () => pushUpdate());
}

function startMetricsServer() {
  // Same payload the dashboard gets — passwords stripped. Prometheus is no more
  // trusted than a phone on the LAN.
  metrics.start(config.metrics_port, webPayload, () => pushUpdate());
}

function pushUpdate() {
  updateTray();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('servers-update', statePayload());
}

ipcMain.handle('reload-config', () => {
  const err = loadConfig();
  if (err) return { error: err };
  resetAndRestart();
  return { ok: true };
});

ipcMain.handle('poll-now', () => {
  startPolling();   // cancel in-progress timers and restart all cycles immediately
  return { ok: true };
});

ipcMain.handle('join-server', (_, url) => shell.openExternal(url));

// Only ever used for the local web dashboard link in the header.
ipcMain.handle('open-external', (_, url) => {
  const ok = url.startsWith('http://') || url.startsWith('https://');
  if (ok) shell.openExternal(url);
});

ipcMain.handle('test-notify', (_, key) => {
  const s   = serverStates.get(key);
  const cfg = config.servers.find(c => serverKey(c) === key);
  const label = s?.label ?? key;
  const name  = s?.name  ?? key;
  notify('FakePlayer joined', `${label}  •  ${name}`, cfg?.notification_sound);
});

// ─── Tray icon ────────────────────────────────────────────────────────────────

const TRAY_COLORS = {
  grey:   '#95a5a6',   // nothing known yet (all pending / no servers)
  red:    '#e74c3c',   // at least one server unreachable
  yellow: '#f1c40f',   // everything up, but nobody playing
  green:  '#2ecc71',   // everything up and at least one player online
};

let trayColor = null;   // currently-drawn colour, to skip redundant redraws

function makeTrayIcon(hex) {
  const size = 16;
  const r8 = parseInt(hex.slice(1, 3), 16);
  const g8 = parseInt(hex.slice(3, 5), 16);
  const b8 = parseInt(hex.slice(5, 7), 16);
  const buf = Buffer.alloc(size * size * 4);
  const cx = (size - 1) / 2, cy = (size - 1) / 2, r = size / 2 - 1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      const a = d <= r ? 255 : d <= r + 1 ? Math.round(255 * (r + 1 - d)) : 0;
      const i = (y * size + x) * 4;
      buf[i] = b8; buf[i+1] = g8; buf[i+2] = r8; buf[i+3] = a;   // BGRA
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

// Disabled servers don't count either way.
function trayStatusColor() {
  const states = enabledStates();
  if (!states.length) return 'grey';
  if (states.some(s => !s.pending && !s.online)) return 'red';
  if (states.some(s => s.pending)) return 'grey';
  const players = states.reduce((n, s) => n + (s.players?.length ?? 0), 0);
  return players > 0 ? 'green' : 'yellow';
}

function updateTray() {
  if (!tray) return;

  const name = trayStatusColor();
  if (name !== trayColor) {
    trayColor = name;
    tray.setImage(makeTrayIcon(TRAY_COLORS[name]));
  }

  const states = enabledStates();
  const online = states.filter(s => s.online).length;
  const players = states.reduce((n, s) => n + (s.players?.length ?? 0), 0);
  tray.setToolTip(
    `Server Watcher — ${online}/${states.length} servers online, ${players} player${players === 1 ? '' : 's'}`
  );
}

function createTray() {
  tray = new Tray(makeTrayIcon(TRAY_COLORS.grey));
  trayColor = 'grey';
  tray.setToolTip('Server Watcher');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show Window', click: showWindow },
    { type: 'separator' },
    {
      label: 'Reload Config',
      click: () => {
        const err = loadConfig();
        err ? notify('Config error', err) : resetAndRestart();
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.isQuitting = true;
        for (const id of serverTimers.values()) clearTimeout(id);
        app.quit();
      },
    },
  ]));
  tray.on('click', showWindow);
}

// ─── Window ───────────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100, height: 720, minWidth: 640, minHeight: 480,
    backgroundColor: '#f1f5f9',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: 'Server Watcher',
    show: false,
  });
  mainWindow.loadFile('index.html');
  mainWindow.setMenu(null);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (serverStates.size > 0) pushUpdate();
  });
  mainWindow.on('close', (e) => { if (!app.isQuitting) { e.preventDefault(); mainWindow.hide(); } });
  mainWindow.on('closed', () => { mainWindow = null; });
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  else { mainWindow.show(); mainWindow.focus(); }
}

// ─── App lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  const configErr = loadConfig();
  loadHistory();
  if (!configErr) initPendingStates();

  createTray();
  createWindow();
  startWebserver();
  startMetricsServer();

  mainWindow.webContents.once('did-finish-load', () => {
    if (configErr) mainWindow.webContents.send('config-error', configErr);
    else pushUpdate();
  });

  if (!configErr) startPolling();
});

app.on('window-all-closed', (e) => e.preventDefault());
app.on('activate', showWindow);
app.on('before-quit', () => { webserver.stop(); metrics.stop(); });
