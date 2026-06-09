let lastData = null;

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function timeAgo(ts) {
  if (!ts) return '—';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 5)  return 'just now';
  if (s < 60) return `${s}s ago`;
  return `${Math.round(s / 60)}m ago`;
}

// Extended format used in the Last Seen history section.
function timeAgoLong(ts) {
  if (!ts) return '—';
  const ms    = Date.now() - ts;
  const secs  = Math.floor(ms / 1000);
  const mins  = Math.floor(ms / 60_000);
  const hours = ms / 3_600_000;
  const days  = ms / 86_400_000;
  if (days  >= 2) return `${days.toFixed(1)}d ago`;
  if (hours >= 2) return `${hours.toFixed(1)}h ago`;
  if (mins  >= 1) return `${mins}m ago`;
  if (secs  <  5) return 'just now';
  return `${secs}s ago`;
}

function pingClass(ms) {
  if (ms < 50)  return 'ping-good';
  if (ms < 120) return 'ping-ok';
  return 'ping-bad';
}

function steamUrl(s) {
  const base = `steam://connect/${s.host}:${s.port}`;
  const withPassword = s.password ? `${base}/${s.password}` : base;
  return s.appid ? `${withPassword}?appid=${s.appid}` : withPassword;
}

function portsMatch(s) {
  return !s.joinPort || s.joinPort === s.port;
}

function countdownText(retryAt) {
  const secs = Math.max(0, Math.round((retryAt - Date.now()) / 1000));
  return secs > 0 ? `Retrying in ${secs}s…` : 'Retrying…';
}

function renderHistorySection(s, history) {
  const serverHistory = history?.[s.key];
  if (!serverHistory || Object.keys(serverHistory).length === 0) return '';

  const currentPlayers = new Set(s.players ?? []);
  const entries = Object.entries(serverHistory)
    .map(([name, d]) => ({ name, ...d, isOnline: currentPlayers.has(name) }))
    .sort((a, b) => {
      if (a.isOnline !== b.isOnline) return a.isOnline ? -1 : 1;
      return b.lastSeen - a.lastSeen;
    });

  const rows = entries.map(e => {
    const lastSeenTitle = e.lastSeen     ? new Date(e.lastSeen).toLocaleString()     : '';
    const joinedTitle   = e.sessionStart ? new Date(e.sessionStart).toLocaleString() : '';

    let timeCells;
    if (e.isOnline) {
      // Online: show "Online since X" (joined time). Last-seen is essentially right now.
      timeCells = `<span class="history-time" title="${esc(joinedTitle)}">Online since ${timeAgoLong(e.sessionStart)}</span>`;
    } else {
      // Offline: show last-seen (primary) + joined/first-seen (secondary) when they differ.
      timeCells = `<span class="history-time" title="${esc(lastSeenTitle)}">Last seen ${timeAgoLong(e.lastSeen)}</span>`;
      if (e.sessionStart && e.sessionStart !== e.lastSeen) {
        timeCells += `<span class="history-time history-joined" title="${esc(joinedTitle)}">Joined ${timeAgoLong(e.sessionStart)}</span>`;
      }
    }

    return `
      <div class="history-row${e.isOnline ? ' history-online' : ''}">
        <span class="history-name">${esc(e.name)}</span>
        <span class="history-times">${timeCells}</span>
      </div>`;
  }).join('');

  const label = `Last Seen (${entries.length} player${entries.length === 1 ? '' : 's'})`;
  return `
    <details class="history-details">
      <summary class="history-summary">${label}</summary>
      <div class="history-list">${rows}</div>
    </details>`;
}

function renderCard(s, history) {
  const cls     = s.pending ? 'pending' : s.online ? 'online' : 'offline';
  const players = s.players ?? [];

  // ── Badge ──
  let badge;
  if (s.pending) {
    badge = `<span class="player-badge">&mdash;</span>`;
  } else if (s.online) {
    badge = `<span class="player-badge">${players.length} / ${s.maxPlayers}</span>`;
  } else {
    badge = `<span class="player-badge">OFFLINE</span>`;
  }

  // ── Join button ──
  const joinBtn = portsMatch(s)
    ? `<button class="join-btn" data-url="${esc(steamUrl(s))}">Join Game</button>`
    : `<span class="server-browser-note">Use Steam server browser</span>`;

  // ── Sub-row ──
  let subRow = '';
  if (s.online) {
    const parts = [];
    if (s.name && s.name !== s.label) parts.push(`<span class="card-sub-name" title="${esc(s.name)}">${esc(s.name)}</span>`);
    if (s.map)       parts.push(`<span class="tag" title="${esc(s.map)}">${esc(s.map)}</span>`);
    if (s.ping != null) parts.push(`<span class="tag ${pingClass(s.ping)}">${s.ping}&thinsp;ms</span>`);
    if (parts.length) subRow = `<div class="card-sub">${parts.join('')}</div>`;
  }

  // ── Player / status section ──
  let body;
  if (s.pending) {
    body = `<p class="status-note muted">Querying&hellip;</p>`;
  } else if (s.online) {
    const chips = players.length === 0
      ? '<span class="no-players">No players online</span>'
      : players.map(p => `<span class="chip">${esc(p)}</span>`).join('');
    body = `
      <div class="players-section">
        <div class="players-heading">Players</div>
        <div class="player-chips">${chips}</div>
      </div>`;
  } else {
    // Error + optional retry state
    let retryLine = '';
    if (s.retrying) {
      retryLine = `<p class="status-note retrying">Retrying&hellip;</p>`;
    } else if (s.retryAt) {
      retryLine = `<p class="status-note countdown" data-retry-at="${s.retryAt}">${esc(countdownText(s.retryAt))}</p>`;
    }
    body = `
      <details class="error-details">
        <summary class="error-summary">${esc(s.error || 'Server unreachable')}</summary>
        <pre class="error-detail-body">${esc(s.errorDetail || s.error || 'No additional details')}</pre>
      </details>
      ${retryLine}`;
  }

  const footer = s.lastUpdated
    ? `<div class="card-footer">Updated ${timeAgo(s.lastUpdated)}</div>`
    : '';

  return `
    <div class="server-card ${cls}" data-key="${esc(s.key)}">
      <div class="status-bar"></div>
      <div class="card-body">
        <div class="card-top">
          <span class="dot"></span>
          <span class="server-label" title="${esc(s.label)}">${esc(s.label)}</span>
          <div class="card-controls">
            ${badge}
            ${joinBtn}
          </div>
        </div>
        ${subRow}
        ${body}
        ${renderHistorySection(s, history)}
        ${footer}
      </div>
    </div>`;
}

function render(data) {
  lastData = data;
  const { servers, pollInterval, history = {} } = data;
  const list    = document.getElementById('servers-list');
  const summary = document.getElementById('summary');
  const pollEl  = document.getElementById('poll-label');

  pollEl.textContent = `polling every ${pollInterval}s`;

  if (!servers.length) {
    list.innerHTML = `
      <div class="state-block">
        <h2>No servers configured</h2>
        <p>Edit <code>servers.yaml</code> in the project folder, then click Reload Config.</p>
      </div>`;
    summary.innerHTML = '';
    return;
  }

  const online = servers.filter(s => s.online).length;
  summary.innerHTML = `<span class="count-online">${online}</span> / ${servers.length} online`;

  // Capture which history <details> are currently open before re-rendering.
  const openHistoryKeys = new Set();
  list.querySelectorAll('.server-card').forEach(card => {
    const details = card.querySelector('.history-details');
    if (details?.open) openHistoryKeys.add(card.dataset.key);
  });

  list.innerHTML = servers.map(s => renderCard(s, history)).join('');

  // Restore open state for history sections.
  if (openHistoryKeys.size) {
    list.querySelectorAll('.server-card').forEach(card => {
      if (openHistoryKeys.has(card.dataset.key)) {
        const details = card.querySelector('.history-details');
        if (details) details.open = true;
      }
    });
  }
}

function showConfigError(err) {
  document.getElementById('servers-list').innerHTML = `
    <div class="error-block">
      <strong>Could not load servers.yaml</strong>
      <pre>${esc(err)}</pre>
    </div>`;
  document.getElementById('summary').innerHTML = '';
}

// Tick every second: refresh "Updated Xs ago" footers and retry countdowns
// without triggering a full re-render (which would collapse open <details>).
setInterval(() => {
  if (!lastData) return;

  document.querySelectorAll('.server-card').forEach(card => {
    const state = lastData.servers.find(s => s.key === card.dataset.key);
    if (!state) return;

    const footer = card.querySelector('.card-footer');
    if (footer && state.lastUpdated) {
      footer.textContent = `Updated ${timeAgo(state.lastUpdated)}`;
    }
  });

  document.querySelectorAll('.countdown').forEach(el => {
    const retryAt = Number(el.dataset.retryAt);
    el.textContent = countdownText(retryAt);
  });
}, 1000);

// ── Event delegation ──────────────────────────────────────────────────────────
document.getElementById('servers-list').addEventListener('click', (e) => {
  const joinBtn = e.target.closest('.join-btn');
  if (joinBtn?.dataset.url) window.api.joinServer(joinBtn.dataset.url);

});

// ── IPC wiring ────────────────────────────────────────────────────────────────
window.api.onServersUpdate(render);
window.api.onConfigError(showConfigError);

// ── Refresh button ────────────────────────────────────────────────────────────
document.getElementById('refresh-btn').addEventListener('click', async () => {
  const btn = document.getElementById('refresh-btn');
  btn.classList.add('spinning');
  btn.textContent = 'Refreshing';
  btn.disabled = true;

  await window.api.pollNow();

  // Re-enable after a moment; actual updates arrive via IPC as polls complete
  setTimeout(() => {
    btn.classList.remove('spinning');
    btn.textContent = 'Refresh';
    btn.disabled = false;
  }, 1500);
});

// ── Test Notification button ──────────────────────────────────────────────────
document.getElementById('test-notify-btn').addEventListener('click', () => {
  if (!lastData?.servers?.length) return;
  const servers = lastData.servers;
  const pick = servers[Math.floor(Math.random() * servers.length)];
  window.api.testNotify(pick.key);
});

// ── Reload Config button ──────────────────────────────────────────────────────
document.getElementById('reload-btn').addEventListener('click', async () => {
  const btn = document.getElementById('reload-btn');
  btn.textContent = 'Reloading…';
  btn.disabled = true;

  const result = await window.api.reloadConfig();
  if (result?.error) showConfigError(result.error);

  btn.textContent = 'Reload Config';
  btn.disabled = false;
});
