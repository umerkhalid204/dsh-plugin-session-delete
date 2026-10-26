# dsh-plugin-session-delete

A DeepSeek Harness plugin that adds a **real, permanent delete** for sessions
(chats). Core only archives — it hides a row while the conversation log stays on
disk forever, and the persistence seam says so in its own limitations
(“Nothing deletes session files”). This plugin does the durable removal:

- a **trash button in the conversation header** that opens a confirm dialog;
- a **`session_delete` agent tool** running the exact same operation;
- on confirm it removes the **session log directory**, the **projection-cache
  row** and the **workspace accounting** for that id, and detaches the sidebar
  row through the workspace registry, so it disappears without a page reload.

> ⚠️ Irreversible. There is no undo and no trash: the log is gone.

Works in the Web profile and in the desktop client (same Web composition).

```
browser                              host (Node)
──────                               ───────────
conversation.session.header.actions  POST /session-delete/api/delete
  trash button ─ confirm dialog ────────►  { sessionId, confirm: true }
  (own controls, --dsw-alias-* tokens) │
                                       ├─ agents.get(id) → cancel, wait idle
                                       ├─ sessionPersistence.flush()
                                       ├─ workspaceRegistry.archiveSession(id)
                                       ├─ rm <root>/<project>/<session id>/  (twice + verify)
                                       ├─ storageDomain session_projcache → delete row
                                       ├─ storageDomain workspace → strip leftovers
                                       └─ sessionQuery.listSessions() → confirm it is gone
```

## Install

From GitHub, into any profile (this is how you put it on your other computers):

```sh
dsh plugin --profile <profile> add github:umerkhalid204/dsh-plugin-session-delete
```

`dsh plugin` forwards to `pnpm` inside the profile directory, and the package
ships plain JavaScript with no dependencies and no build step, so nothing has to
compile. The bundle's own `cordis.patch.yml` inserts the Loader row — you do not
have to edit your profile patch at all. Restart the profile afterwards:

```sh
dsh web --profile <profile>      # or relaunch the desktop app
```

In the running app you can also install it from **Settings → Plugins**, or use
the Plugin Manager tool from an agent session. From a checkout:

```sh
dsh plugin --profile <profile> add file:/absolute/path/to/dsh-plugin-session-delete
```

To pin a version, use the tag: `github:umerkhalid204/dsh-plugin-session-delete#v1.0.0`.

## Use

1. Open a session. A trash icon appears next to the header title actions.
2. Click it → **Delete permanently**.
3. The dialog shows *Session deleted*; the row leaves the sidebar immediately.

Agents can do the same thing:

```
session_delete { "sessionId": "session-14849223-bbde-4677-97ca-01b72328d774" }
```

A session may not delete itself (the tool call would be appended to a log that
is being removed), so the call is refused with a clear message.

## Configuration

All knobs are plain row config — override them in Settings → Plugins →
Session Delete → Configure, or in your profile's `cordis.patch.yml`:

```yaml
- id: session-delete
  name: 'dsh-plugin-session-delete'
  config:
    sessionRoot: '~/.dsh/sessions'   # extra root to search; empty = auto-discover
    stopAgent: true                  # wait for a running agent to settle first
    idleMs: 20000                    # cap on that wait
    sweepMs: 500                     # settle delay before the verifying re-sweep
```

No `Config` schema is declared on purpose: a plugin that declares one must hand
the Loader a validator object, and the row then fails to activate on any
Harness version whose validator shape differs. Unknown or missing values simply
fall back to the defaults above.

## Session roots

The plugin never recomputes the on-disk encoding. It searches, in order:

1. `config.sessionRoot` and `$DSH_SESSION_ROOT`;
2. the root the Loader actually gave
   `@deepseek-ai/dsh-session-persistence-jsonl` (through `configEditor`, when
   that row is live);
3. `$DSH_HOME/sessions`, then `$DSH_HOME/profiles/<profile>/sessions`.

Inside every root it walks `<root>/<project>/<session dir>` and matches the
directory name against both id spellings (`session-<uuid>` and the bare uuid),
decoding the backend's `~XXXX` escapes. A directory is only removed when it sits
directly under a project directory of a resolved root, is a real directory (never
a symlink), and contains a `session*.jsonl` generation or `session.lock`.

## Why the original plugin did nothing

The upstream `dsh-plugin-session-delete` (Geralt4) is a sound sketch, but three
of its assumptions do not hold against the current Harness:

| Its assumption | Reality in the installed build |
|---|---|
| `sessionPersistence.inspect(id).path` gives the log path | `sessionPersistence` exposes `create/open/stat/list/flush` only; `inspect` does not exist, so the route always deleted *nothing* (`removedFiles: false`) |
| `require('@deepseek-ai/dsh-client-ui-primitives')` and `dsh-client-runtime/client` from the client bundle | the frozen Client module table refuses those specifiers, the factory throws, and the slot entry never renders |
| the header-actions slot injects `request` / `confirm` / `useSessionDelete` / `t` props | that slot hands components its **standard session props** (`sessionId`, `useSession`, …) only; the component dereferenced `t(...)`, threw, and the cell went blank |
| it needed a manual `insert:` row in your profile patch | a bundle declares its own `dsh.bundle.patch`, so the row arrives with the package; without one the plugin was installed but never activated |

This package keeps the design (host-side durable delete + one header action) and
rebuilds both halves against the APIs this Harness actually serves, and adds the
parts the sketch was missing: quiescence before removal, a verified re-sweep so a
teardown race cannot re-create the log, projection-cache and workspace cleanup so
no ghost “Ungrouped” row survives, and an agent tool for the same operation.

## Layout

```
dsh-plugin-session-delete/
  package.json        # exports + dsh.bundle.patch + dsh.client declaration
  cordis.patch.yml    # the Loader row this bundle contributes (id: session-delete)
  index.js            # Host half: delete chain + HTTP route + session_delete tool
  client.js           # Client half: __ModuleLoader__ factory, header cell + dialog
  locale/{en,zh}.json # Plugin Manager title/description
  icon.svg            # plugin artwork
```

## Verification

```sh
curl -s -X POST http://127.0.0.1:<port>/session-delete/api/delete \
  -H 'content-type: application/json' \
  -d '{"sessionId":"session-<id-you-are-willing-to-lose>","confirm":true}'
```

It answers with what it removed, for example:

```json
{ "ok": true, "sessionId": "session-…", "logRemoved": true,
  "projectionCacheRemoved": true, "workspaceAccountingRemoved": true,
  "stoppedAgent": false, "stillListed": false }
```

## Limitations

- **Live sessions.** The target agent is cancelled and the session flushed, then
  the sweep runs twice with a settle delay and fails loudly if anything
  reappeared. A driver that outlives `idleMs` can still re-create the directory;
  raise `idleMs`, stop the session from the UI, or re-run the delete.
- **Descendants.** Subagent children of a deleted session are not cascaded; they
  keep their own logs (they remain reachable only through their own rows).
- **Search index.** Rows the session-query backend keeps for a deleted id are
  dropped by its own reconciliation once the log is gone; the plugin deletes no
  index it does not own.
- **No undo.** Consider archiving (the stock behaviour) if you only want the row
  out of the way.

## License

MIT — see [LICENSE](LICENSE).
