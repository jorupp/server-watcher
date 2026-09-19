// Web dashboard: the Electron app does the monitoring, this just polls
// /api/state and re-renders with the same card markup the desktop UI uses.
(function () {
  'use strict';

  const { timeAgo, countdownText, renderCard, renderSummary } = window.SW;

  const REFRESH_MS = 5000;
  // Two missed refreshes before we tell the user the data may be stale.
  const STALE_AFTER_MS = REFRESH_MS * 2 + 2000;

  const listEl    = document.getElementById('servers-list');
  const summaryEl = document.getElementById('summary');
  const statusEl  = document.getElementById('status-line');

  let lastData    = null;
  let lastOkAt    = 0;
  let lastError   = null;

  function renderOfflineBanner() {
    return `
      <div class="offline-banner">
        <strong>Can't reach Server Watcher</strong>
        The desktop app does the monitoring — make sure it's still running on the
        machine hosting this page.
      </div>`;
  }

  function render() {
    if (!lastData) {
      listEl.innerHTML = lastError
        ? renderOfflineBanner()
        : `<div class="state-block"><p class="blink">Loading&hellip;</p></div>`;
      summaryEl.textContent = '';
      return;
    }

    const { servers, history = {} } = lastData;

    if (!servers.length) {
      listEl.innerHTML = `
        <div class="state-block">
          <h2>No servers configured</h2>
          <p>Add some to <code>servers.yaml</code> and reload the config.</p>
        </div>`;
      summaryEl.textContent = '';
      return;
    }

    summaryEl.innerHTML = renderSummary(servers);

    // Keep any history sections the user has expanded open across refreshes.
    const openKeys = new Set();
    listEl.querySelectorAll('.server-card').forEach(card => {
      if (card.querySelector('.history-details')?.open) openKeys.add(card.dataset.key);
    });

    const banner = lastError ? renderOfflineBanner() : '';
    // steam:// links do nothing from a phone browser, so no Join button here.
    listEl.innerHTML = banner + servers.map(s => renderCard(s, history, { join: false })).join('');

    if (openKeys.size) {
      listEl.querySelectorAll('.server-card').forEach(card => {
        if (openKeys.has(card.dataset.key)) {
          const details = card.querySelector('.history-details');
          if (details) details.open = true;
        }
      });
    }
  }

  function updateStatusLine() {
    const age = lastOkAt ? Date.now() - lastOkAt : Infinity;
    const stale = !lastOkAt || age > STALE_AFTER_MS;
    statusEl.classList.toggle('stale', stale);

    if (!lastOkAt) {
      statusEl.textContent = lastError ? 'disconnected' : 'connecting…';
    } else if (stale) {
      statusEl.textContent = `stale — last update ${timeAgo(lastOkAt)}`;
    } else {
      statusEl.textContent = `updated ${timeAgo(lastOkAt)}`;
    }
  }

  async function refresh() {
    try {
      const res = await fetch('/api/state', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      lastData  = await res.json();
      lastError = null;
      lastOkAt  = Date.now();
    } catch (err) {
      lastError = err;
    }
    render();
    updateStatusLine();
  }

  // Per-second tick for the relative timestamps, so the page feels live between
  // refreshes without re-rendering (which would collapse open <details>).
  setInterval(() => {
    updateStatusLine();
    if (!lastData) return;

    document.querySelectorAll('.server-card').forEach(card => {
      const state = lastData.servers.find(s => s.key === card.dataset.key);
      const footer = card.querySelector('.card-footer');
      if (state?.lastUpdated && footer) {
        footer.textContent = `Updated ${timeAgo(state.lastUpdated)}`;
      }
    });

    document.querySelectorAll('.countdown').forEach(el => {
      el.textContent = countdownText(Number(el.dataset.retryAt));
    });
  }, 1000);

  setInterval(refresh, REFRESH_MS);

  // Phones suspend timers while the page is backgrounded — catch up on return.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh();
  });

  refresh();
})();
