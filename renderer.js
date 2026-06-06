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

function pingClass(ms) {
  if (ms < 50)  return 'ping-good';
  if (ms < 120) return 'ping-ok';
  return 'ping-bad';
}

function steamUrl(s) {
  const base = `steam://connect/${s.host}:${s.port}`;
  return s.password ? `${base}/${s.password}` : base;
}

function renderCard(s) {
  const cls     = s.pending ? 'pending' : s.online ? 'online' : 'offline';
  const players = s.players ?? [];

  // ── Badge ──
  let badge;
  if (s.pending) {
    badge = `<span class="player-badge">—</span>`;
  } else if (s.online) {
    badge = `<span class="player-badge">${players.length} / ${s.maxPlayers}</span>`;
  } else {
    badge = `<span class="player-badge">OFFLINE</span>`;
  }

  // ── Join button (disabled when not online) ──
  const joinUrl  = steamUrl(s);
  const joinBtn  = `<button class="join-btn" data-url="${esc(joinUrl)}">Join Game</button>`;

  // ── Sub-row: real server name + map + ping ──
  let subRow = '';
  if (s.online) {
    const parts = [];
    if (s.name && s.name !== s.label) parts.push(`<span class="card-sub-name" title="${esc(s.name)}">${esc(s.name)}</span>`);
    if (s.map)  parts.push(`<span class="tag" title="${esc(s.map)}">${esc(s.map)}</span>`);
    if (s.ping != null) parts.push(`<span class="tag ${pingClass(s.ping)}">${s.ping}&thinsp;ms</span>`);
    if (parts.length) subRow = `<div class="card-sub">${parts.join('')}</div>`;
  }

  // ── Player section ──
  let playerSection;
  if (s.pending) {
    playerSection = `<p class="pending-note">Querying&hellip;</p>`;
  } else if (s.online) {
    const chips = players.length === 0
      ? '<span class="no-players">No players online</span>'
      : players.map(p => `<span class="chip">${esc(p)}</span>`).join('');
    playerSection = `
      <div class="players-section">
        <div class="players-heading">Players</div>
        <div class="player-chips">${chips}</div>
      </div>`;
  } else {
    playerSection = `
      <details class="error-details">
        <summary class="error-summary">${esc(s.error || 'Server unreachable')}</summary>
        <pre class="error-detail-body">${esc(s.errorDetail || s.error || 'No additional details')}</pre>
      </details>`;
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
        ${playerSection}
        ${footer}
      </div>
    </div>`;
}

function render(data) {
  lastData = data;
  const { servers, pollInterval } = data;
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

  const online  = servers.filter(s => s.online).length;
  const total   = servers.length;
  summary.innerHTML =
    `<span class="count-online">${online}</span> / ${total} online`;

  list.innerHTML = servers.map(renderCard).join('');
}

function showConfigError(err) {
  document.getElementById('servers-list').innerHTML = `
    <div class="error-block">
      <strong>Could not load servers.yaml</strong>
      <pre>${esc(err)}</pre>
    </div>`;
  document.getElementById('summary').innerHTML = '';
}

// Refresh "Updated Xs ago" footers in place without a full re-render
setInterval(() => {
  if (!lastData) return;
  document.querySelectorAll('.server-card').forEach(card => {
    const state = lastData.servers.find(s => s.key === card.dataset.key);
    if (!state) return;
    const footer = card.querySelector('.card-footer');
    if (footer) footer.textContent = `Updated ${timeAgo(state.lastUpdated)}`;
  });
}, 15_000);

// ── Event delegation for Join buttons ────────────────────────────────────────
document.getElementById('servers-list').addEventListener('click', (e) => {
  const btn = e.target.closest('.join-btn');
  if (btn?.dataset.url) window.api.joinServer(btn.dataset.url);
});

// ── IPC wiring ────────────────────────────────────────────────────────────────
window.api.onServersUpdate(render);
window.api.onConfigError(showConfigError);

// ── Refresh button (immediate re-poll) ───────────────────────────────────────
document.getElementById('refresh-btn').addEventListener('click', async () => {
  const btn = document.getElementById('refresh-btn');
  btn.classList.add('spinning');
  btn.textContent = 'Refreshing';
  btn.disabled = true;

  await window.api.pollNow();

  btn.classList.remove('spinning');
  btn.textContent = 'Refresh';
  btn.disabled = false;
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
