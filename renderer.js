// Card markup and time formatting live in shared/render.js so the web UI
// renders identically; this file handles the Electron-only wiring.
const { timeAgo, countdownText, isEnabled, renderCard, renderSummary, esc } = window.SW;

let lastData = null;

function render(data) {
  lastData = data;
  const {
    servers, pollInterval, history = {},
    webPort = null, webError = null,
    metricsPort = null, metricsError = null,
  } = data;
  const list    = document.getElementById('servers-list');
  const summary = document.getElementById('summary');
  const pollEl  = document.getElementById('poll-label');
  const webEl   = document.getElementById('web-link');
  const metricsEl = document.getElementById('metrics-link');

  pollEl.textContent = `polling every ${pollInterval}s`;

  webEl.classList.toggle('web-error', Boolean(webError));
  if (webPort) {
    webEl.textContent = `web: :${webPort}`;
    webEl.dataset.url = `http://localhost:${webPort}/`;
  } else {
    webEl.textContent = webError ? `web dashboard off — ${webError}` : '';
    delete webEl.dataset.url;
  }

  metricsEl.classList.toggle('web-error', Boolean(metricsError));
  if (metricsPort) {
    metricsEl.textContent = `metrics: :${metricsPort}`;
    metricsEl.dataset.url = `http://localhost:${metricsPort}/metrics`;
  } else {
    metricsEl.textContent = metricsError ? `metrics off — ${metricsError}` : '';
    delete metricsEl.dataset.url;
  }

  if (!servers.length) {
    list.innerHTML = `
      <div class="state-block">
        <h2>No servers configured</h2>
        <p>Edit <code>servers.yaml</code> in the project folder, then click Reload Config.</p>
      </div>`;
    summary.innerHTML = '';
    return;
  }

  summary.innerHTML = renderSummary(servers);

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

for (const id of ['web-link', 'metrics-link']) {
  document.getElementById(id).addEventListener('click', (e) => {
    e.preventDefault();
    const url = e.currentTarget.dataset.url;
    if (url) window.api.openExternal(url);
  });
}

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
  // Disabled servers aren't being watched, so they're not candidates.
  const servers = (lastData?.servers ?? []).filter(isEnabled);
  if (!servers.length) return;
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
