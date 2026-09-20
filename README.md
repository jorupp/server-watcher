# Server Watcher

Local Electron app used to monitor a series of Steam-based game servers and notify when someone joins.

Configure it by copying `servers-example.yaml` to `servers.yaml` — that file documents
every option, including per-server `self` (mute other players' join alerts while
you're online) and `enabled: false` (keep a server listed but stop watching it).

## Tray icon

- **green** — every watched server is up and at least one player is online
- **yellow** — every watched server is up, but nobody is playing
- **red** — at least one watched server is unreachable
- **grey** — still querying, or nothing to watch

## Web dashboard

While the app is running it also serves a read-only, phone-friendly view of the same
stats on `http://<this-machine>:3030/` (change or disable via `web_port` in
`servers.yaml`). The desktop app does all the monitoring; the page just polls
`/api/state` every few seconds. Server passwords are never sent to it.

## Prometheus metrics

A scrape endpoint runs alongside the dashboard on `http://<this-machine>:3031/metrics`
(change or disable via `metrics_port` in `servers.yaml`). It is on its own port
rather than sharing 3030 because the two get pointed at by different things — a
phone on the sofa, and a scraper hitting it every 15 seconds.

Everything is rendered from the live state on each scrape, with two conventions
that decide how the charts read:

- **Unknown is not zero.** While a server is unreachable we have no idea who is
  on it, so player counts and per-player series stop being reported instead of
  dropping to 0. Outages show up as gaps, not troughs.
- **Logged off is zero, for a while.** A player who leaves keeps reporting 0 for
  `metrics_player_window_hours` (24h) before dropping out entirely, so a
  per-player timeline draws a "not playing" line rather than a gap.

The companion Grafana dashboard lives in the [`hd-hr-monitor`](../hd-hr-monitor)
repo (`docker/grafana/dashboards/game-servers.json`), which already runs the
Prometheus/Grafana stack. Its README documents the metric set.

Note that Valve's A2S protocol only carries the server name, map, player list,
slot count and a per-player connection time. There is no save time, autosave
schedule or sim speed in it, so those cannot be exported from here.

Mostly written by Claude Code w/ Sonnet 4.6.
