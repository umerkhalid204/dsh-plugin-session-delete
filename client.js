/**
 * dsh-plugin-session-delete — Client half.
 *
 * Two entry points, one shared confirm dialog:
 *   - a **Delete session pill** in `conversation.session.header.actions`
 *     (title-adjacent, the Session that is open);
 *   - a row in every session row's **“…” menu**
 *     (`sidebar.workspaces.session.menu.item`, order 500, after the shipped
 *     `pin`/`rename`/`fork`/`archive`/`session-id` rows), which carries
 *     `sessionId` and `displayTitle` as owner props, so a session can be
 *     deleted without opening it;
 *   - the dialog itself is mounted once in `shell.overlay` — the frame-wide
 *     floating layer — because a menu unmounts the moment its item is clicked,
 *     so a dialog owned by the menu item would disappear with it.
 *
 * Both surfaces just raise a request in a tiny external store; the overlay owns
 * the whole confirmation lifecycle and calls this package's Host route, which
 * removes the log, the projection-cache row and the workspace row, and detaches
 * the sidebar row through the registry, so it vanishes without a page reload.
 *
 * Rules this half follows — and why the previous out-of-tree version never
 * rendered anything:
 *   - the artifact is a lazy factory registered through `__ModuleLoader__.load`,
 *     so the shell's frozen module table answers every `require`;
 *   - only `react` is required. Harness Client packages
 *     (`@deepseek-ai/dsh-client-ui-primitives`, `@deepseek-ai/dsh-client-runtime/client`)
 *     are not requirable from a plugin: the module table refuses them, the
 *     factory throws, and the slot entry disappears. Every control below is this
 *     plugin's own, styled with `--dsw-alias-*` theme tokens;
 *   - props come only from what each slot documents: `sessionId` (and
 *     `displayTitle` in the row menu). Nothing is invented — the original
 *     dereferenced `request`/`useSessionDelete` props no slot passes, and the
 *     cell went blank;
 *   - no node is ever appended to `document.body`: the overlay is React DOM
 *     rendered by a slot entry, and styles ride in a component-local `<style>`
 *     element so unmounting removes them;
 *   - each contribution is wrapped in an error boundary, so a crash leaves a
 *     visible amber control that states the reason instead of an empty cell;
 *   - text goes through the Client locale service when the Host provides one,
 *     with the plugin's own dictionaries as the floor.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-session-delete',
  factory(require) {
    const React = require('react')
    const { useCallback, useEffect, useRef, useState, useSyncExternalStore } = React
    const h = React.createElement

    const NS = 'session-delete'
    const ENDPOINT = '/session-delete/api/delete'

    const DICT = {
      en: {
        'action.delete': 'Delete session',
        'action.delete.unavailable': 'Delete session (unavailable)',
        'dialog.title': 'Delete this session?',
        'dialog.body': 'The conversation log, its projection cache and its workspace row are removed from disk. This cannot be undone.',
        'dialog.running': 'A running agent on this session is stopped first.',
        'dialog.confirm': 'Delete permanently',
        'dialog.cancel': 'Cancel',
        'dialog.close': 'Close',
        'status.deleting': 'Deleting…',
        'status.done': 'Session deleted',
        'status.stopped': 'The running agent was stopped first.',
        'status.error': 'Delete failed',
        'status.noRoute': 'This Harness has no Host route for the plugin, so nothing was deleted. Restart the profile (the cold-boot registration order was fixed in v1.0.1).',
      },
      zh: {
        'action.delete': '删除会话',
        'action.delete.unavailable': '删除会话（不可用）',
        'dialog.title': '确定删除此会话？',
        'dialog.body': '将从磁盘删除该会话的对话记录、投影缓存与工作区条目，此操作不可撤销。',
        'dialog.running': '如该会话有正在运行的 Agent，将先停止它。',
        'dialog.confirm': '永久删除',
        'dialog.cancel': '取消',
        'dialog.close': '关闭',
        'status.deleting': '正在删除…',
        'status.done': '会话已删除',
        'status.stopped': '已先停止运行中的 Agent。',
        'status.error': '删除失败',
        'status.noRoute': '此 Harness 未注册该插件的 Host 路由，未删除任何内容。请重启 profile（v1.0.1 修复了冷启动注册顺序）。',
      },
    }

    const CSS = `
.sd-pill { display:inline-flex; align-items:center; gap:6px; height:28px; padding:0 10px;
  border:1px solid var(--dsw-alias-border-l1); border-radius:999px; background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-secondary); font-family:inherit; font-size:12.5px; line-height:1;
  cursor:pointer; white-space:nowrap; }
.sd-pill:hover { color:var(--dsw-alias-state-error-primary); border-color:var(--dsw-alias-state-error-primary);
  background:var(--dsw-alias-bg-layer-2); }
.sd-pill:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:1px; }
.sd-pill[disabled] { opacity:.45; cursor:wait; }
.sd-pill--unavailable { color:var(--dsw-alias-state-warn-primary); cursor:not-allowed; }
.sd-menuitem { display:flex; align-items:center; gap:8px; width:100%; min-height:28px; padding:6px 10px;
  border:0; border-radius:8px; background:transparent; color:var(--dsw-alias-label-primary);
  font-family:inherit; font-size:12.5px; text-align:left; cursor:pointer; }
.sd-menuitem:hover { background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-state-error-primary); }
.sd-menuitem:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:-2px; }
.sd-backdrop { position:fixed; inset:0; z-index:1000; display:flex; align-items:center; justify-content:center;
  padding:24px; background:rgba(12,14,18,.46); }
.sd-dialog { width:min(440px,100%); display:flex; flex-direction:column; gap:10px; padding:18px;
  background:var(--dsw-alias-bg-overlay); border:1px solid var(--dsw-alias-border-l2); border-radius:12px;
  box-shadow:0 18px 48px rgba(12,14,18,.35); color:var(--dsw-alias-label-primary); font-size:13px; line-height:1.55; }
.sd-title { font-size:15px; font-weight:600; }
.sd-subtitle { color:var(--dsw-alias-label-secondary); font-size:12.5px; }
.sd-body { color:var(--dsw-alias-label-secondary); }
.sd-warn { color:var(--dsw-alias-state-warn-primary); }
.sd-error { color:var(--dsw-alias-state-error-primary); }
.sd-id { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:11.5px;
  color:var(--dsw-alias-label-secondary); word-break:break-all; }
.sd-actions { display:flex; justify-content:flex-end; gap:8px; margin-top:4px; }
.sd-action { border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-primary); border-radius:8px; padding:6px 12px; font-size:12.5px; cursor:pointer; }
.sd-action:hover { background:var(--dsw-alias-bg-layer-2); }
.sd-action--danger { border-color:var(--dsw-alias-state-error-primary);
  background:var(--dsw-alias-state-error-primary); color:var(--dsw-alias-bg-base); }
.sd-action--danger:hover { background:var(--dsw-alias-state-error-primary); filter:brightness(1.08); }
.sd-action[disabled] { opacity:.5; cursor:wait; }
.sd-action:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:1px; }
`

    // --- the one request store ------------------------------------------------
    // A request is raised from any surface; only the overlay owns the lifecycle.
    // A menu item that owned its own dialog would unmount with the menu.

    let pending = null
    const listeners = new Set()

    function emit() {
      for (const listener of listeners) {
        try {
          listener()
        } catch {
          /* one broken subscriber never stops the others */
        }
      }
    }

    function subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }

    function getSnapshot() {
      return pending
    }

    function requestDelete(request) {
      pending = request
      emit()
    }

    function clearRequest() {
      if (pending === null) return
      pending = null
      emit()
    }

    // --- locale ---------------------------------------------------------------

    function languageOf(locale) {
      const snapshot = typeof locale?.getSnapshot === 'function'
        ? locale.getSnapshot()
        : typeof locale?.getLocale === 'function' ? locale.getLocale() : null
      const id = snapshot ? snapshot.locale || snapshot.language || snapshot.id || '' : ''
      if (String(id).toLowerCase().startsWith('zh')) return 'zh'
      const browser = String((typeof navigator !== 'undefined' && navigator.language) || '').toLowerCase()
      return browser.startsWith('zh') ? 'zh' : 'en'
    }

    function dictionary(locale) {
      return DICT[languageOf(locale)] || DICT.en
    }

    /** Translate through the Client locale service when present; the plugin dictionary is the floor. */
    function translatorFor(locale) {
      const bound = typeof locale?.bind === 'function' ? safeBind(locale) : null
      return function translate(key) {
        if (bound) {
          try {
            const value = bound(key)
            if (typeof value === 'string' && value !== key) return value
          } catch {
            /* locale service vocabulary moved: the dictionary below still answers */
          }
        }
        const dict = dictionary(locale)
        return dict[key] || DICT.en[key] || key
      }
    }

    function safeBind(locale) {
      try {
        return locale.bind(NS)
      } catch {
        return null
      }
    }

    /**
     * A 404 or an empty 405 is the SPA fallback answering, not this plugin: the
     * Host half registered no route, so say what to do instead of a bare status.
     */
    function explainFailure(status) {
      if (status !== 404 && status !== 405) return `HTTP ${status}`
      return dictionary(null)['status.noRoute']
    }

    function registerDictionaries(locale) {
      if (!locale || typeof locale.register !== 'function') return
      try {
        locale.register(NS, 'en', DICT.en)
        locale.register(NS, 'zh', DICT.zh)
      } catch {
        try {
          locale.register(NS, { en: DICT.en, zh: DICT.zh })
        } catch {
          /* no locale vocabulary for this build: the plugin dictionary answers */
        }
      }
    }

    // --- controls -------------------------------------------------------------

    function TrashGlyph() {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: 15,
          height: 15,
          'aria-hidden': 'true',
          focusable: 'false',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        },
        h('path', { d: 'M2.6 4.3h10.8' }),
        h('path', { d: 'M6.4 2.4h3.2' }),
        h('path', { d: 'M4 4.3l.62 8.1a1.1 1.1 0 0 0 1.1 1.02h4.56a1.1 1.1 0 0 0 1.1-1.02L12 4.3' }),
        h('path', { d: 'M6.6 6.6v5.1' }),
        h('path', { d: 'M9.4 6.6v5.1' }),
      )
    }

    /** `conversation.session.header.actions` cell: the Session that is open. */
    function HeaderPill({ sessionId, t }) {
      const onClick = useCallback(() => {
        requestDelete({ sessionId, source: 'header' })
      }, [sessionId])

      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        return h(
          'span',
          { className: 'sd-pill sd-pill--unavailable', title: 'session-delete: no Session id in the slot props' },
          TrashGlyph(),
          h('span', null, t('action.delete')),
        )
      }

      return h(
        'button',
        {
          type: 'button',
          className: 'sd-pill',
          'aria-label': t('action.delete'),
          title: t('action.delete'),
          onClick,
        },
        TrashGlyph(),
        h('span', null, t('action.delete')),
      )
    }

    /** `sidebar.workspaces.session.menu.item` row: any listed Session, opened or not. */
    function MenuDeleteItem({ sessionId, displayTitle, t }) {
      const onClick = useCallback(() => {
        requestDelete({ sessionId, displayTitle, source: 'menu' })
      }, [sessionId, displayTitle])

      if (typeof sessionId !== 'string' || sessionId.length === 0) return null

      return h(
        'button',
        {
          type: 'button',
          role: 'menuitem',
          className: 'sd-menuitem',
          'aria-label': `${t('action.delete')} — ${displayTitle || sessionId}`,
          onClick,
        },
        TrashGlyph(),
        h('span', null, t('action.delete')),
      )
    }

    /**
     * `shell.overlay` entry: the only dialog in the composition, so a closed
     * menu never takes the confirmation with it.
     */
    function DeleteOverlay({ locale, t }) {
      const request = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
      const [phase, setPhase] = useState('idle')
      const [error, setError] = useState(null)
      const [result, setResult] = useState(null)
      const [localeTick, setLocaleTick] = useState(0)
      const closeTimerRef = useRef(null)
      const sessionId = request && request.sessionId

      useEffect(() => {
        if (typeof locale?.subscribe !== 'function') return undefined
        return locale.subscribe(() => setLocaleTick((value) => value + 1))
      }, [locale])

      // A fresh request always starts at the confirmation step.
      useEffect(() => {
        clearTimeout(closeTimerRef.current)
        setError(null)
        setResult(null)
        setPhase(request ? 'confirm' : 'idle')
      }, [request])

      useEffect(() => () => clearTimeout(closeTimerRef.current), [])

      const dismiss = useCallback(() => {
        clearTimeout(closeTimerRef.current)
        setPhase('idle')
        clearRequest()
      }, [])

      const confirm = useCallback(async () => {
        if (typeof sessionId !== 'string' || sessionId.length === 0) return
        setPhase('deleting')
        try {
          const response = await fetch(ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId, confirm: true }),
          })
          const body = await response.json().catch(() => null)
          if (!response.ok || !body || body.ok !== true) {
            throw new Error((body && body.error) || explainFailure(response.status))
          }
          setResult(body)
          setPhase('done')
          // The Host detached the row through the workspace registry, so the
          // list updates on its own; only an open panel has to be left.
          if (request.source === 'header' && typeof closeOpenPanel === 'function') {
            try {
              closeOpenPanel()
            } catch {
              /* panel teardown is owned by the Host when the session is gone */
            }
          }
          closeTimerRef.current = setTimeout(dismiss, 2000)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
          setPhase('error')
        }
      }, [sessionId, request, dismiss])

      // localeTick participates through `t`, which re-reads the active language.
      void localeTick

      if (!request || typeof sessionId !== 'string' || sessionId.length === 0) return null

      return h(
        React.Fragment,
        null,
        h('style', null, CSS),
        h(DeleteDialog, { sessionId, displayTitle: request.displayTitle, phase, error, result, t, onCancel: dismiss, onConfirm: confirm }),
      )
    }

    function DeleteDialog({ sessionId, displayTitle, phase, error, result, t, onCancel, onConfirm }) {
      const confirmRef = useRef(null)
      const restoreRef = useRef(null)
      const busy = phase === 'deleting'

      useEffect(() => {
        restoreRef.current = document.activeElement
        if (phase === 'confirm') confirmRef.current?.focus?.()
        return () => {
          if (restoreRef.current && typeof restoreRef.current.focus === 'function') restoreRef.current.focus()
        }
      }, [phase])

      useEffect(() => {
        const onKey = (event) => {
          if (event.key !== 'Escape' || busy) return
          onCancel()
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [busy, onCancel])

      const heading =
        phase === 'deleting' ? t('status.deleting')
          : phase === 'done' ? t('status.done')
            : phase === 'error' ? t('status.error')
              : t('dialog.title')

      return h(
        'div',
        {
          className: 'sd-backdrop',
          onMouseDown: (event) => {
            if (event.target === event.currentTarget && !busy) onCancel()
          },
        },
        h(
          'div',
          { className: 'sd-dialog', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': heading },
          h('div', { className: 'sd-title' }, heading),
          displayTitle ? h('div', { className: 'sd-subtitle' }, displayTitle) : null,
          phase === 'confirm'
            ? h(React.Fragment, null,
              h('div', { className: 'sd-body' }, t('dialog.body')),
              h('div', { className: 'sd-warn' }, t('dialog.running')))
            : null,
          phase === 'done'
            ? h('div', { className: 'sd-body' }, result?.stoppedAgent ? `${t('status.done')} · ${t('status.stopped')}` : t('status.done'))
            : null,
          phase === 'error' ? h('div', { className: 'sd-error' }, error || t('status.error')) : null,
          h('div', { className: 'sd-id' }, String(sessionId)),
          h(
            'div',
            { className: 'sd-actions' },
            phase === 'confirm'
              ? [
                  h('button', { key: 'cancel', type: 'button', className: 'sd-action', onClick: onCancel }, t('dialog.cancel')),
                  h(
                    'button',
                    { key: 'confirm', ref: confirmRef, type: 'button', className: 'sd-action sd-action--danger', onClick: onConfirm },
                    t('dialog.confirm'),
                  ),
                ]
              : h(
                  'button',
                  { key: 'close', type: 'button', className: 'sd-action', disabled: busy, onClick: onCancel },
                  busy ? t('status.deleting') : t('dialog.close'),
                ),
          ),
        ),
      )
    }

    /**
     * A contribution that throws must still leave a control the user can see and
     * a reason they can read — an empty slot cell is indistinguishable from a
     * plugin that is not installed at all.
     */
    class ContributionBoundary extends React.Component {
      constructor(componentProps) {
        super(componentProps)
        this.state = { failure: null }
      }

      static getDerivedStateFromError(error) {
        return { failure: error instanceof Error ? error.message : String(error) }
      }

      componentDidCatch(error) {
        try {
          console.error('[dsh-plugin-session-delete] slot entry crashed:', error)
        } catch {
          /* no console binding in this context */
        }
      }

      render() {
        if (this.state.failure === null) return this.props.children
        if (this.props.silent) return null
        return h(
          'span',
          { className: 'sd-pill sd-pill--unavailable', title: `session-delete: ${this.state.failure}` },
          TrashGlyph(),
          h('span', null, this.props.t ? this.props.t('action.delete.unavailable') : 'Delete session'),
        )
      }
    }

    let closeOpenPanel = null

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = ctx.get('slots')
        if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return

        const locale = ctx.get('locale') ?? null
        registerDictionaries(locale)
        const t = translatorFor(locale)

        const layout = ctx.get('layout')
        if (layout && typeof layout.selectPanel === 'function') {
          closeOpenPanel = () => layout.selectPanel(null)
        }

        ctx.effect(
          () => slots.inject('conversation.session.header.actions', () =>
            slots.register(
              {
                name: 'conversation.session.header.actions',
                id: 'session-delete',
                order: 60,
                label: () => dictionary(locale)['action.delete'],
              },
              (props) => h(ContributionBoundary, { t }, h(HeaderPill, { ...props, t })),
            ),
          ),
          'session-delete: header pill',
        )

        ctx.effect(
          () => slots.inject('sidebar.workspaces.session.menu.item', () =>
            slots.register(
              {
                name: 'sidebar.workspaces.session.menu.item',
                id: 'dsh-plugin-session-delete.delete',
                order: 500,
                label: () => dictionary(locale)['action.delete'],
              },
              (props) => h(ContributionBoundary, { t, silent: true }, h(MenuDeleteItem, { ...props, t })),
            ),
          ),
          'session-delete: session row menu row',
        )

        ctx.effect(
          () => slots.inject('shell.overlay', () =>
            slots.register(
              {
                name: 'shell.overlay',
                id: 'session-delete-dialog',
                order: 900,
              },
              (props) => h(ContributionBoundary, { t, silent: true }, h(DeleteOverlay, { ...props, locale, t })),
            ),
          ),
          'session-delete: confirm overlay',
        )
      },
    }
  },
})
