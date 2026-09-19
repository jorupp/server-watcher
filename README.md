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

Mostly written by Claude Code w/ Sonnet 4.6.
