// Pure HTML-building helpers shared by the Electron renderer and the web UI.
// No DOM mutation, no IPC — just strings in, strings out, so both front-ends
// stay in sync when the card layout changes.
(function (global) {
  'use strict';

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

  // A server is counted (and polled) unless it was explicitly disabled.
  function isEnabled(s) {
    return s?.enabled !== false;
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
      const isSelf        = s.self && e.name === s.self;

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
          <span class="history-name${isSelf ? ' history-self' : ''}">${esc(e.name)}</span>
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

  // Disabled servers collapse to a single greyed-out line — no status, no polling.
  function renderDisabledCard(s) {
    return `
      <div class="server-card disabled" data-key="${esc(s.key)}">
        <div class="disabled-row">
          <span class="dot"></span>
          <span class="server-label" title="${esc(s.label)}">${esc(s.label)}</span>
          <span class="disabled-tag">disabled</span>
        </div>
      </div>`;
  }

  // opts.join — render the Steam "Join Game" button (desktop app only; a
  // steam:// link is useless from a phone browser).
  function renderCard(s, history, opts = {}) {
    if (!isEnabled(s)) return renderDisabledCard(s);

    const showJoin = opts.join !== false;
    const cls      = s.pending ? 'pending' : s.online ? 'online' : 'offline';
    const players  = s.players ?? [];
    // Extra modifier when the server is reachable but has nobody on it.
    const emptyOnline = s.online && players.length === 0;

    // Status-bar colour: red = unreachable, yellow = online but empty, green = has players
    let barCls;
    if      (s.pending)    barCls = 'bar-pending';
    else if (!s.online)    barCls = 'bar-red';
    else if (emptyOnline)  barCls = 'bar-yellow';
    else                   barCls = 'bar-green';

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
    let joinBtn = '';
    if (showJoin) {
      joinBtn = portsMatch(s)
        ? `<button class="join-btn" data-url="${esc(steamUrl(s))}">Join Game</button>`
        : `<span class="server-browser-note">Use Steam server browser</span>`;
    }

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
        ? '<span class="no-players-note">No players online</span>'
        : players.map(p =>
            `<span class="chip${s.self && p === s.self ? ' chip-self' : ''}">${esc(p)}</span>`
          ).join('');
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
      <div class="server-card ${cls}${emptyOnline ? ' no-players' : ''}" data-key="${esc(s.key)}">
        <div class="status-bar ${barCls}"></div>
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

  // "<online> / <total> online", counting only enabled servers.
  function renderSummary(servers) {
    const active = servers.filter(isEnabled);
    const online = active.filter(s => s.online).length;
    return `<span class="count-online">${online}</span> / ${active.length} online`;
  }

  global.SW = {
    esc, timeAgo, timeAgoLong, pingClass, steamUrl, portsMatch,
    countdownText, isEnabled, renderHistorySection, renderCard, renderSummary,
  };
})(typeof window !== 'undefined' ? window : globalThis);
