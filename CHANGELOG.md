# Changelog

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
