# Changelog

## v1.0.1

Found in the desktop app (macOS): the row was registered in the page, yet there was
nothing to click and the endpoint did not exist.

- **Host: the route is registered through `ctx.inject(['webServer'], …)`.** v1.0.0 read
  `ctx.get('webServer')` while activating. That is invisible after a live install — the
  carrier is already up — and broken on every **cold boot**, where this row activates
  before the Web carrier exists: nothing registered, so the button talked to the SPA
  fallback (GET 404; POST 405 with an empty body). `tools` is now a hard `inject` too, so
  the agent tool exists from the first boot instead of by luck of ordering.
- **Client: two entry points, one dialog.** A labeled **Delete session** pill in the
  conversation header *and* a **Delete session** row in every session row’s **“…” menu**
  (`sidebar.workspaces.session.menu.item`, order 500, below the shipped
  `pin`/`rename`/`fork`/`archive`/`session-id` rows), so a session can be deleted without
  opening it. The confirm dialog moved to `shell.overlay`, the frame-wide floating layer: a
  menu unmounts its own row the moment it is clicked, so a dialog owned by that row would
  have vanished with it. The row title appears in the dialog, and deleting from the header
  also leaves the open panel.
- **Client: an error boundary owns every contribution.** A render crash used to leave an
  empty entry with no trace; the header cell now shows an amber **Delete session
  (unavailable)** pill whose tooltip carries the reason, and the console gets a
  `[dsh-plugin-session-delete]` line — “not installed” and “crashed” are no longer the same
  symptom.
- **Client: props are only the documented ones** — `sessionId`, plus `displayTitle` in the
  row menu. Nothing is invented: the original dereferenced `request`/`confirm`/
  `useSessionDelete` props no slot ever passes, which blanked its cell.
- **Client: a fallback-server answer is explained** — a 404 or an empty 405 now says the
  Host route is absent and the profile needs a restart, instead of a bare status code.
- **Test: `test/render-smoke.mjs`** materialises the client factory against a minimal React
  and stub `slots`/`locale` services, then renders each contribution and asserts that the
  pill, the `role="menuitem"` row, the confirmation dialog, and the crash fallback all
  appear. CI runs it, so an artifact that installs but shows nothing cannot ship.
- Docs: desktop-app install and restart guidance (the app has no dev-server watcher, so
  both halves change only on an app restart), plus a troubleshooting table.

## v1.0.0

First working edition, rebuilt against the Harness APIs this build actually
serves (the upstream out-of-tree sketch never rendered and never deleted
anything):

- Host: the delete chain now resolves the real on-disk layout instead of calling
  the non-existent `sessionPersistence.inspect(id).path` — roots are discovered
  from the Loader config, `$DSH_HOME/sessions` and `config.sessionRoot`; every
  removal is path-validated (root/project/session-dir shape, no symlinks, must
  contain a session log or `session.lock`).
- Host: cancels the live agent and waits (time-boxed) for quiescence, flushes
  persistence, then sweeps the log directory twice with a settle delay and fails
  loudly if it reappears, so a teardown race cannot resurrect the log.
- Host: drops the projection-cache row through the live storage domain (with a
  file-level fallback) and strips residual workspace accounting twice, so no
  ghost “Ungrouped” or archived row survives.
- Host: detaches the sidebar row through `workspaceRegistry.archiveSession()`, so
  the row disappears without a page reload.
- Host: `session_delete` agent tool runs the same operation as the button; a
  session deleting itself is refused.
- Client: the artifact is a lazy `__ModuleLoader__.load` factory that requires
  only `react`. The old build required `@deepseek-ai/dsh-client-ui-primitives`
  and `@deepseek-ai/dsh-client-runtime/client`, which the frozen Client module
  table refuses — the factory threw and the slot entry never appeared. Controls
  are now the plugin's own, styled with `--dsw-alias-*` theme tokens.
- Client: registration reads the slot's real props (`sessionId`) instead of
  invented `request`/`confirm`/`useSessionDelete`/`t` props the
  `conversation.session.header.actions` slot never passes.
- Bundle: ships `dsh.bundle.patch`, so installing the package inserts the
  `session-delete` Loader row; the previous design required hand-editing the
  profile patch, and without it the plugin was installed but never activated.
- Packaging: plain JavaScript, zero dependencies, no build script — so
  `dsh plugin add github:umerkhalid204/dsh-plugin-session-delete` works as-is on
  any machine.
- Assets: localized Plugin Manager title/description (`locale/en.json`,
  `locale/zh.json`) and an original `icon.svg`.
