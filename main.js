const {
  app, BrowserWindow, Tray, Menu, nativeImage,
  Notification, ipcMain, shell,
} = require('electron');
const path = require('path');
const fs = require('fs');
const yaml = require('js-yaml');
const GameDig = require('gamedig');

// Required on Windows for toast notifications to work
if (process.platform === 'win32') {
  app.setAppUserModelId('com.serverwatcher');
}

const CONFIG_PATH = path.join(__dirname, 'servers.yaml');
const DEFAULT_POLL_INTERVAL = 30;

let mainWindow = null;
let tray = null;
let pollTimer = null;

let config = { poll_interval: DEFAULT_POLL_INTERVAL, servers: [] };
const serverStates = new Map(); // serverKey -> state object
const knownPlayers = new Map(); // serverKey -> Set<playerName>
const initialized = new Set();  // keys that have completed at least one successful poll

// ─── Config ──────────────────────────────────────────────────────────────────

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = yaml.load(raw);
    config = {
      poll_interval: Math.max(5, Number(parsed?.poll_interval) || DEFAULT_POLL_INTERVAL),
      servers: Array.isArray(parsed?.servers) ? parsed.servers : [],
    };
    return null;
  } catch (err) {
    return err.message;
  }
}

// ─── Server polling ───────────────────────────────────────────────────────────

function serverKey(cfg) {
  return `${cfg.host}:${cfg.port || 27015}`;
}

// Populate serverStates with pending placeholders so the UI shows all
// configured servers immediately, before the first poll completes.
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
      pending:  true,
      online:   false,
      lastUpdated: null,
    });
  }
}

async function queryServer(cfg) {
  // 'steam' is not a valid gamedig type; 'protocol-valve' is the generic Source handler
  let type = cfg.type || 'protocol-valve';
  if (type === 'steam') type = 'protocol-valve';

  const options = {
    type,
    host: cfg.host,
    port: Number(cfg.port) || 27015,
    maxAttempts: 2,
    socketTimeout: 5000,
    givenPortOnly: true,
  };
  if (cfg.appid) options.appid = Number(cfg.appid);

  const state = await GameDig.query(options);
  return {
    online: true,
    name: state.name || cfg.label,
    map: state.map || '',
    players: state.players.map(p => p.name).filter(n => n?.trim()),
    maxPlayers: state.maxplayers || 0,
    ping: Math.round(state.ping || 0),
  };
}

async function pollAll() {
  if (!config.servers.length) return;

  const results = await Promise.allSettled(
    config.servers.map(cfg => queryServer(cfg))
  );

  for (let i = 0; i < config.servers.length; i++) {
    const cfg = config.servers[i];
    const key = serverKey(cfg);
    const r = results[i];

    const state = r.status === 'fulfilled'
      ? r.value
      : {
          online: false,
          error: r.reason?.message || 'Query failed',
          errorDetail: [
            `Host:  ${cfg.host}:${Number(cfg.port) || 27015}`,
            `Type:  ${cfg.type || 'protocol-valve'}`,
            `Error: ${r.reason?.message || 'Query failed'}`,
          ].join('\n'),
        };

    state.key      = key;
    state.label    = cfg.label || key;
    state.host     = cfg.host;
    state.port     = Number(cfg.port) || 27015;
    state.password = cfg.password || '';
    state.pending  = false;
    state.lastUpdated = Date.now();

    serverStates.set(key, state);

    if (state.online) {
      const current = new Set(state.players);
      const previous = knownPlayers.get(key);

      // Only notify after the first successful poll establishes a baseline
      if (previous !== undefined && initialized.has(key)) {
        for (const name of current) {
          if (!previous.has(name)) {
            notify(
              `${name} joined`,
              `${state.label}  •  ${state.name || key}`
            );
          }
        }
      }

      knownPlayers.set(key, current);
      initialized.add(key);
    }
  }

  pushStateUpdate();
  updateTrayTooltip();
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollAll();
  pollTimer = setInterval(pollAll, config.poll_interval * 1000);
}

function resetAndRestart() {
  knownPlayers.clear();
  initialized.clear();
  initPendingStates();
  pushStateUpdate();    // show pending placeholders immediately
  startPolling();
}

// ─── Notifications ────────────────────────────────────────────────────────────

function notify(title, body) {
  if (!Notification.isSupported()) return;
  new Notification({ title, body }).show();
}

// ─── IPC ──────────────────────────────────────────────────────────────────────

function pushStateUpdate() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('servers-update', {
    servers: Array.from(serverStates.values()),
    pollInterval: config.poll_interval,
  });
}

ipcMain.handle('reload-config', () => {
  const err = loadConfig();
  if (err) return { error: err };
  resetAndRestart();
  return { ok: true };
});

ipcMain.handle('poll-now', async () => {
  await pollAll();
  return { ok: true };
});

ipcMain.handle('join-server', (_, url) => {
  shell.openExternal(url);
});

// ─── Tray icon (BGRA bitmap, no asset file needed) ───────────────────────────

function makeTrayIcon() {
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const r = size / 2 - 1;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      const a = d <= r ? 255 : d <= r + 1 ? Math.round(255 * (r + 1 - d)) : 0;
      const idx = (y * size + x) * 4;
      buf[idx]     = 0x71; // B  (#2ecc71 in BGRA)
      buf[idx + 1] = 0xcc; // G
      buf[idx + 2] = 0x2e; // R
      buf[idx + 3] = a;    // A
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

  const menu = Menu.buildFromTemplate([
    { label: 'Show Window', click: showWindow },
    { type: 'separator' },
    {
      label: 'Reload Config',
      click: () => {
        const err = loadConfig();
        if (err) {
          notify('Config error', err);
        } else {
          resetAndRestart();
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.isQuitting = true;
        if (pollTimer) clearInterval(pollTimer);
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(menu);
  tray.on('click', showWindow);
}

// ─── Window ───────────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 640,
    minHeight: 480,
    backgroundColor: '#0f0f1a',
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
    if (serverStates.size > 0) pushStateUpdate();
  });

  // Hide to tray instead of closing
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
}

// ─── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  const configErr = loadConfig();
  if (!configErr) initPendingStates();

  createTray();
  createWindow();

  mainWindow.webContents.once('did-finish-load', () => {
    if (configErr) {
      mainWindow.webContents.send('config-error', configErr);
    } else {
      pushStateUpdate();   // render pending placeholders right away
    }
  });

  if (!configErr) startPolling();
});

// Keep the app alive in the tray when all windows are closed
app.on('window-all-closed', (e) => e.preventDefault());
app.on('activate', showWindow);
