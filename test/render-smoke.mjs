/**
 * Headless render smoke for client.js — no DOM, no browser, no Harness.
 *
 * The client artifact is a lazy factory that the browser module loader runs, so
 * nothing about its shape can be proven by `node --check` alone. This script
 * stands in for the loader and the slot owner: it materialises the factory
 * against a minimal React (hooks + createElement), drives `apply` through stub
 * `slots`/`locale`/`layout` services, and then renders each contribution the
 * way the owner would.
 *
 * It answers the one question a plugin UI otherwise cannot answer without a
 * screen: does the component tree build, and does each surface render a control
 * with the right label? Run it in CI, so a rename in the artifact can never ship
 * as "installed but invisible".
 */
import assert from 'node:assert/strict'

// --- the module table the browser would provide -----------------------------

let hookSlot = 0
const hooks = []

function useState(initial) {
  const index = hookSlot++
  if (hooks[index] === undefined) hooks[index] = { value: typeof initial === 'function' ? initial() : initial }
  const entry = hooks[index]
  return [entry.value, (next) => {
    entry.value = typeof next === 'function' ? next(entry.value) : next
  }]
}

function useRef(initial) {
  const index = hookSlot++
  if (hooks[index] === undefined) hooks[index] = { current: initial }
  return hooks[index]
}

function useCallback(fn) {
  hookSlot++
  return fn
}

// The stub runs an effect at render time: the smoke test needs the phase a real
// commit would have reached, and dependency arrays are not modelled here.
function useEffect(effect) {
  hookSlot++
  const cleanup = effect()
  if (typeof cleanup === 'function') cleanup()
}

function useSyncExternalStore(_subscribe, getSnapshot) {
  hookSlot++
  return getSnapshot()
}

function createElement(type, props, ...children) {
  return {
    type,
    props: props || {},
    children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false),
  }
}

class Component {
  constructor(props) {
    this.props = props
    this.state = {}
  }

  setState(patch) {
    Object.assign(this.state, patch)
  }
}

const React = {
  createElement,
  Fragment: 'fragment',
  Component,
  useState,
  useRef,
  useCallback,
  useEffect,
  useSyncExternalStore,
}

const table = new Map([['react', React]])
function requireFromTable(spec) {
  if (!table.has(spec)) throw new Error(`the frozen Client module table refuses "${spec}"`)
  return table.get(spec)
}

// --- render ------------------------------------------------------------------

function textOf(node, out = []) {
  if (typeof node === 'string' || typeof node === 'number') out.push(String(node))
  else if (node && typeof node === 'object') for (const child of node.children || []) textOf(child, out)
  return out.join(' ')
}

function collect(node, tag, out = []) {
  if (!node || typeof node !== 'object') return out
  if (node.type === tag) out.push(node)
  for (const child of node.children || []) collect(child, tag, out)
  return out
}

function render(node) {
  if (node === null || node === undefined || typeof node === 'string' || typeof node === 'number') return node
  if (typeof node.type === 'function') {
    const props = { ...node.props }
    if (node.children.length) props.children = node.children.length === 1 ? node.children[0] : node.children
    const produced = node.type.prototype instanceof Component
      ? new node.type(props).render()
      : node.type(props)
    return render(produced)
  }
  return { ...node, children: (node.children || []).map(render) }
}

// --- the harness -------------------------------------------------------------

const registered = new Map()

const slots = {
  inject(name, build) {
    build()
    return () => {}
  },
  register(spec, Component2) {
    if (!spec.name || !spec.id) throw new Error(`registration needs name + id: ${JSON.stringify(spec)}`)
    registered.set(`${spec.name}#${spec.id}`, { spec, component: Component2 })
    return () => {}
  },
}

const ctx = {
  get(name) {
    if (name === 'slots') return slots
    if (name === 'layout') return { selectPanel() {} }
    return undefined
  },
  effect(fn) {
    fn()
    return () => {}
  },
}

let loaded = null
globalThis.window = { __ModuleLoader__: { load: (record) => { loaded = record } } }
// Node already exposes a read-only `navigator`; only pin the language when the
// runtime has none, so the dictionary fallback is exercised the same way here as
// in the browser.
if (!globalThis.navigator || typeof globalThis.navigator.language !== 'string') {
  Object.defineProperty(globalThis, 'navigator', { value: { language: 'en-US' }, configurable: true })
}
globalThis.document = { addEventListener() {}, removeEventListener() {}, activeElement: null }

// The artifact is a plain browser script: importing it only runs the loader
// registration, which is exactly what the shell's module system does.
await import(new URL('../client.js', import.meta.url).href)

assert.ok(loaded, 'client.js never registered itself with window.__ModuleLoader__.load')
assert.equal(loaded.id, 'dsh-plugin-session-delete', 'the module id must be the package name')

const exportsFromFactory = loaded.factory(requireFromTable)
assert.deepEqual(exportsFromFactory.inject, ['slots'], 'the client half must hard-inject only slots')
exportsFromFactory.apply(ctx)

// --- header pill -------------------------------------------------------------

const header = registered.get('conversation.session.header.actions#session-delete')
assert.ok(header, 'no contribution in conversation.session.header.actions')
hookSlot = 0
const headerTree = render(header.component({ sessionId: 'session-1111' }))
const headerButtons = collect(headerTree, 'button')
assert.equal(headerButtons.length, 1, 'the header cell must render exactly one button')
assert.match(textOf(headerButtons[0]), /Delete session/, 'the header control must be labeled, not icon-only')
assert.ok(collect(headerTree, 'svg').length === 1, 'the header control carries the trash glyph')

// --- session row "..." menu row ---------------------------------------------

const menu = registered.get('sidebar.workspaces.session.menu.item#dsh-plugin-session-delete.delete')
assert.ok(menu, 'no contribution in sidebar.workspaces.session.menu.item')
hookSlot = 0
const menuTree = render(menu.component({ sessionId: 'session-2222', displayTitle: 'Old chat' }))
const menuButtons = collect(menuTree, 'button')
assert.equal(menuButtons.length, 1, 'the menu cell must render exactly one row')
assert.equal(menuButtons[0].props.role, 'menuitem', 'a menu row must be role=menuitem so the owner keeps keyboard order')
assert.match(textOf(menuButtons[0]), /Delete session/)

// --- the shared confirm dialog lives in the frame-wide overlay ---------------

const overlay = registered.get('shell.overlay#session-delete-dialog')
assert.ok(overlay, 'no contribution in shell.overlay')

// No request yet: the overlay renders nothing.
hookSlot = 0
assert.equal(render(overlay.component({})), null, 'the overlay must be inert without a request')

// The header pill raises a request. The first pass is the commit that reaches the
// confirmation step; the second pass reads the state that step left behind.
headerButtons[0].props.onClick()
hookSlot = 0
render(overlay.component({}))
hookSlot = 0
let overlayTree = render(overlay.component({}))
const dialog = collect(overlayTree, 'div').find((node) => node.props.role === 'alertdialog')
assert.ok(dialog, 'the overlay must own the confirm dialog after a request')
assert.match(textOf(dialog), /Delete this session\?/)
assert.match(textOf(dialog), /session-1111/, 'the dialog names the exact Session it will remove')
const actions = collect(dialog, 'button')
assert.equal(actions.length, 2, 'confirm offers Cancel and Delete permanently')
assert.match(textOf(actions[0]), /Cancel/)
assert.match(textOf(actions[1]), /Delete permanently/)
assert.ok(String(actions[1].props.className).includes('sd-action--danger'), 'the destructive action reads as destructive')

// A menu request carries the row title instead.
menuButtons[0].props.onClick()
hookSlot = 0
render(overlay.component({}))
hookSlot = 0
overlayTree = render(overlay.component({}))
const second = collect(overlayTree, 'div').find((node) => node.props.role === 'alertdialog')
assert.match(textOf(second), /Old chat/, 'a row-menu request keeps the row title in the dialog')

// --- a crashing contribution must stay visible -------------------------------

const boundary = header.component({ sessionId: 'session-3333' })
assert.equal(boundary.type.name, 'ContributionBoundary', 'the header cell must sit inside the error boundary')
const crashed = new boundary.type({ t: (key) => (key === 'action.delete.unavailable' ? 'Delete session (unavailable)' : key), children: null })
crashed.state = { failure: 'boom' }
const fallback = render(crashed.render())
assert.match(textOf(fallback), /Delete session \(unavailable\)/, 'a crashed cell must degrade to a labeled control, not an empty slot')
assert.equal(crashed.render().props.title, 'session-delete: boom', 'the reason must be readable from the control')

console.log('client render smoke: header pill, row-menu row, shared overlay, and the crash fallback all render as expected')
