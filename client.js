/**
 * dsh-plugin-session-delete — Client half.
 *
 * Contributes one cell to the session header actions slot
 * (`conversation.session.header.actions`, scope: session): a trash button that
 * opens a confirm dialog. On confirm it calls this package's Host route, which
 * removes the session log, its projection-cache row and its workspace row; the
 * registry detach the Host performs makes the sidebar row disappear without a
 * page reload.
 *
 * Rules this half follows — and why the previous out-of-tree version never
 * rendered anything:
 *   - the artifact is a lazy factory registered through `__ModuleLoader__.load`,
 *     so the shell's frozen module table answers every `require`;
 *   - only `react` is required. Harness Client packages
 *     (`@deepseek-ai/dsh-client-ui-primitives`, `@deepseek-ai/dsh-client-runtime/client`)
 *     are not requirable from a plugin: the module table refuses them, the
 *     factory throws, and the slot entry disappears. The controls below are this
 *     plugin's own, styled with `--dsw-alias-*` theme tokens;
 *   - no invented registration props: the slot hands components its standard
 *     session props, so `sessionId` comes from props and everything else is
 *     component state (the old version asked the slot for `request`/`confirm`/
 *     `useSessionDelete` props the slot never passes, which crashed the cell);
 *   - the dialog is React DOM owned by this component (fixed positioning), never
 *     a node appended to `document.body`; styles ride in a component-local
 *     `<style>` element so unmounting removes them;
 *   - text goes through the Client locale service when the Host provides one,
 *     with the plugin's own dictionaries as the floor.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-session-delete',
  factory(require) {
    const React = require('react')
    const { useCallback, useEffect, useRef, useState } = React
    const h = React.createElement

    const NS = 'session-delete'
    const ENDPOINT = '/session-delete/api/delete'

    const DICT = {
      en: {
        'action.delete': 'Delete session',
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
      },
      zh: {
        'action.delete': '删除会话',
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
      },
    }

    const CSS = `
.sd-btn { display:inline-flex; align-items:center; justify-content:center; width:28px; height:28px;
  padding:0; border:1px solid transparent; border-radius:8px; background:transparent;
  color:var(--dsw-alias-label-secondary); cursor:pointer; }
.sd-btn:hover { color:var(--dsw-alias-state-error-primary); background:var(--dsw-alias-bg-layer-2);
  border-color:var(--dsw-alias-border-l1); }
.sd-btn:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:1px; }
.sd-btn[disabled] { opacity:.45; cursor:wait; }
.sd-backdrop { position:fixed; inset:0; z-index:1000; display:flex; align-items:center; justify-content:center;
  padding:24px; background:rgba(12,14,18,.46); }
.sd-dialog { width:min(440px,100%); display:flex; flex-direction:column; gap:10px; padding:18px;
  background:var(--dsw-alias-bg-overlay); border:1px solid var(--dsw-alias-border-l2); border-radius:12px;
  box-shadow:0 18px 48px rgba(12,14,18,.35); color:var(--dsw-alias-label-primary); font-size:13px; line-height:1.55; }
.sd-title { font-size:15px; font-weight:600; }
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

    function languageOf(locale) {
      const snapshot = typeof locale?.getSnapshot === 'function'
        ? locale.getSnapshot()
        : typeof locale?.getLocale === 'function' ? locale.getLocale() : null
      const id = snapshot ? snapshot.locale || snapshot.language || snapshot.id || '' : ''
      return String(id).toLowerCase().startsWith('zh') ? 'zh' : 'en'
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

    function registerDictionaries(locale) {
      if (!locale || typeof locale.register !== 'function') return
      try {
        locale.register(NS, 'en', DICT.en)
        locale.register(NS, 'zh', DICT.zh)
      } catch {
        try {
          locale.register(NS, { en: DICT.en, zh: DICT.zh })
        } catch {
          /* no locale service vocabulary for this build: the plugin dictionary answers */
        }
      }
    }

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

    /** Confirm, then the Host's outcome — one dialog, four phases. */
    function DeleteDialog({ sessionId, phase, error, result, t, onCancel, onConfirm }) {
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

    /** The slot cell: icon button plus the dialog it owns. */
    function SessionDeleteAction({ sessionId, locale, t }) {
      const [phase, setPhase] = useState('idle')
      const [error, setError] = useState(null)
      const [result, setResult] = useState(null)
      const [localeTick, setLocaleTick] = useState(0)
      const closeTimerRef = useRef(null)

      useEffect(() => {
        if (typeof locale?.subscribe !== 'function') return undefined
        return locale.subscribe(() => setLocaleTick((value) => value + 1))
      }, [locale])

      useEffect(() => () => clearTimeout(closeTimerRef.current), [])

      const close = useCallback(() => {
        clearTimeout(closeTimerRef.current)
        setPhase('idle')
      }, [])

      const open = useCallback(() => {
        clearTimeout(closeTimerRef.current)
        setError(null)
        setResult(null)
        setPhase('confirm')
      }, [])

      const confirm = useCallback(async () => {
        setPhase('deleting')
        try {
          const response = await fetch(ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId, confirm: true }),
          })
          const body = await response.json().catch(() => null)
          if (!response.ok || !body || body.ok !== true) {
            throw new Error((body && body.error) || `HTTP ${response.status}`)
          }
          setResult(body)
          setPhase('done')
          closeTimerRef.current = setTimeout(close, 1800)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
          setPhase('error')
        }
      }, [sessionId, close])

      if (sessionId === undefined || sessionId === null) return null

      // localeTick participates through `t`, which re-reads the active language.
      void localeTick

      return h(
        React.Fragment,
        null,
        h('style', null, CSS),
        h(
          'button',
          {
            type: 'button',
            className: 'sd-btn',
            'aria-label': t('action.delete'),
            title: t('action.delete'),
            disabled: phase === 'deleting',
            onClick: open,
          },
          TrashGlyph(),
        ),
        phase === 'idle'
          ? null
          : h(DeleteDialog, { sessionId, phase, error, result, t, onCancel: close, onConfirm: confirm }),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = ctx.get('slots')
        if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return

        const locale = ctx.get('locale') ?? null
        registerDictionaries(locale)
        const t = translatorFor(locale)

        ctx.effect(
          () => slots.inject('conversation.session.header.actions', () =>
            slots.register(
              {
                name: 'conversation.session.header.actions',
                id: 'session-delete',
                order: 60,
                label: () => dictionary(locale)['action.delete'],
              },
              (props) => h(SessionDeleteAction, { ...props, locale, t }),
            ),
          ),
          'session-delete: header action',
        )
      },
    }
  },
})
