# Server Watcher

Local Electron app that monitors game servers and sends notifications when someone joins.

Configure it by copying `servers-example.yaml` to `servers.yaml` — that file documents
every option, including per-server `self` (mute other players' join alerts while
you're online) and `enabled: false` (keep a server listed but stop watching it).
Add `hidden: true` alongside `enabled: false` to hide that server entirely from
the desktop and web dashboards. `hidden` is ignored for enabled servers.

## Factorio

Set `type: factorio` and use the game's UDP port (34197 by default). For publicly
listed servers, the watcher gets the player list from Factorio matchmaking by
the server's public address. This also works for games with a join password.

For unlisted or LAN-only servers, enable Factorio's TCP RCON with `--rcon-port`
or `--rcon-bind`, plus `--rcon-password`. Set `rcon_port` and `rcon_password` in
the watcher's server entry. Keep RCON on a trusted network. The watcher uses
`/players online` to get the player list.

### Find the address of a game from the public browser

Factorio's **Browse public games** details pane shows the game's name, access
and other details. To get the IP and port, join the game and search for the most
recent `Joining game` line in `factorio-current.log`. On Windows, the log is
usually at `%APPDATA%\Factorio\factorio-current.log`. [Factorio log locations](https://wiki.factorio.com/Application_directory)

For example, if the log says `Joining game IP ADDR:({203.0.113.10:34200})`, set
`host: "203.0.113.10"` and `port: 34200` in `servers.yaml`. Use the browser name
as `label` if you like. You can use the same address in Factorio's **Connect to
address** menu.

If you only select the game, look for a recent `get-game-details/<game_id>` URL
in the log. Open that URL, check that the `name` matches the game you selected,
and use the `host_address` from the JSON response. Save the address in the
watcher, since a game ID can change when the host restarts. [Factorio matchmaking API](https://wiki.factorio.com/Matchmaking_API)

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
