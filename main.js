const {
  app, BrowserWindow, Tray, Menu, nativeImage,
  Notification, ipcMain, shell,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const yaml = require('js-yaml');
const GameDig = require('gamedig');

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

let mainWindow = null;
let tray = null;

// Default: the generic Windows system notification sound.
const DEFAULT_SOUND = path.join(
  process.env.SystemRoot || 'C:\\Windows',
  'Media', 'Windows Notify System Generic.wav'
);

let config = { poll_interval: DEFAULT_POLL_INTERVAL, servers: [], notification_sound: null };
const serverStates  = new Map(); // key -> state object
const knownPlayers  = new Map(); // key -> Set<playerName>
const initialized   = new Set(); // keys with at least one successful baseline poll
const serverTimers  = new Map(); // key -> timeoutId
// key -> Map<playerName, { lastSeen: number, sessionStart: number }>
const playerHistory = new Map();

// ─── Helpers ──────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function serverKey(cfg) {
  return `${cfg.host}:${cfg.port || 27015}`;
}

// ─── Config ───────────────────────────────────────────────────────────────────

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = yaml.load(raw);
    config = {
      poll_interval: Math.max(5, Number(parsed?.poll_interval) || DEFAULT_POLL_INTERVAL),
      notification_sound: parsed?.notification_sound || null,
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
      port:     Number(cfg.port) || 27015,
      password: cfg.password || '',
      joinPort: cfg.joinPort ? Number(cfg.joinPort) : null,
      appid:    cfg.appid    ? Number(cfg.appid)    : null,
      pending:  true,
      online:   false,
      retrying: false,
      retryAt:  null,
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
    port: Number(cfg.port) || 27015,
    maxAttempts: 1,
    socketTimeout: 5000,
    givenPortOnly: true,
  };
  if (cfg.appid) options.appid = Number(cfg.appid);

  try {
    const s = await GameDig.query(options);
    return {
      online:     true,
      name:       s.name || cfg.label,
      map:        s.map  || '',
      players:    s.players.map(p => p.name).filter(n => n?.trim()),
      maxPlayers: s.maxplayers || 0,
      ping:       Math.round(s.ping || 0),
    };
  } catch (err) {
    return {
      online: false,
      error:  err.message || 'Query failed',
      errorDetail: [
        `Host:  ${cfg.host}:${Number(cfg.port) || 27015}`,
        `Type:  ${type}`,
        `Error: ${err.message || 'Query failed'}`,
      ].join('\n'),
    };
  }
}

// Merge a query result into the stored state for a server.
function applyResult(key, cfg, result, extra = {}) {
  const prev = serverStates.get(key) ?? {};
  serverStates.set(key, {
    ...prev,
    key,
    label:    cfg.label || key,
    host:     cfg.host,
    port:     Number(cfg.port) || 27015,
    password: cfg.password || '',
    joinPort: cfg.joinPort ? Number(cfg.joinPort) : null,
    pending:  false,
    retrying: false,
    retryAt:  null,
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
        playerMap.set(name, {
          lastSeen:     new Date(d.last_seen).getTime(),
          sessionStart: new Date(d.session_start).getTime(),
        });
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

function checkJoins(key, cfg, result) {
  if (!result.online) return;
  const current  = new Set(result.players);
  const previous = knownPlayers.get(key);
  const now      = Date.now();
  const isFirst  = !initialized.has(key);

  let serverHistory = playerHistory.get(key);
  if (!serverHistory) {
    serverHistory = new Map();
    playerHistory.set(key, serverHistory);
  }

  for (const name of current) {
    const existing  = serverHistory.get(name);
    const isNewJoin = previous !== undefined && !previous.has(name);

    let sessionStart;
    if (existing && !isNewJoin) {
      // Continuing an ongoing session — preserve the start time.
      // On first poll after app restart, also preserve it if the player was
      // seen recently enough that they're likely in the same session.
      const recentEnough = (now - existing.lastSeen) < config.poll_interval * 3 * 1000;
      sessionStart = (isFirst && !recentEnough) ? now : existing.sessionStart;
    } else {
      // New join (or first time we've ever seen this player).
      sessionStart = now;
    }

    serverHistory.set(name, { lastSeen: now, sessionStart });

    // Fire join notification after the baseline is established.
    if (!isFirst && isNewJoin) {
      const label = serverStates.get(key)?.label ?? key;
      notify(`${name} joined`, `${label}  •  ${result.name || key}`, cfg.notification_sound);
    }
  }

  knownPlayers.set(key, current);
  initialized.add(key);
  saveHistory();
}

// ─── Per-server poll cycle ────────────────────────────────────────────────────

async function runServerPoll(cfg) {
  const key = serverKey(cfg);

  // ── Attempt 1 ──
  const r1 = await querySingle(cfg);
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
  for (const cfg of config.servers) scheduleServerPoll(cfg, 0);
}

function resetAndRestart() {
  knownPlayers.clear();
  initialized.clear();
  initPendingStates();
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

function pushUpdate() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('servers-update', {
    servers:      Array.from(serverStates.values()),
    pollInterval: config.poll_interval,
    history:      historyForIPC(),
  });
  updateTrayTooltip();
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

ipcMain.handle('test-notify', (_, key) => {
  const s   = serverStates.get(key);
  const cfg = config.servers.find(c => serverKey(c) === key);
  const label = s?.label ?? key;
  const name  = s?.name  ?? key;
  notify('FakePlayer joined', `${label}  •  ${name}`, cfg?.notification_sound);
});

// ─── Tray icon ────────────────────────────────────────────────────────────────

function makeTrayIcon() {
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  const cx = (size - 1) / 2, cy = (size - 1) / 2, r = size / 2 - 1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      const a = d <= r ? 255 : d <= r + 1 ? Math.round(255 * (r + 1 - d)) : 0;
      const i = (y * size + x) * 4;
      buf[i] = 0x71; buf[i+1] = 0xcc; buf[i+2] = 0x2e; buf[i+3] = a; // BGRA #2ecc71
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

function updateTrayTooltip() {
  if (!tray) return;
  const states = Array.from(serverStates.values());
  const online = states.filter(s => s.online).length;
  tray.setToolTip(`Server Watcher — ${online}/${states.length} servers online`);
}

function createTray() {
  tray = new Tray(makeTrayIcon());
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

  mainWindow.webContents.once('did-finish-load', () => {
    if (configErr) mainWindow.webContents.send('config-error', configErr);
    else pushUpdate();
  });

  if (!configErr) startPolling();
});

app.on('window-all-closed', (e) => e.preventDefault());
app.on('activate', showWindow);
