import './styles.css'
import {
  fetchNet, exitApp, fmtUptime, type NetInfo,
  vpnPresets, vpnAddPreset, vpnDeletePreset, vpnStatus,
  vpnConnect, vpnDisconnect, vpnLog,
  toolsCheck, toolsInstall,
  systemStatus, systemAction, getSettings, putSettings,
  type Preset, type VpnStatus,
} from './api'
import { mountScan, type ScanHandle } from './scan'
import * as overlay from './overlay'
import { askSudo } from './sudo'

type Screen = 'home' | 'vpn' | 'scan' | 'system' | 'settings'

const TILES: { id: Screen; label: string; ico: string; accent: string }[] = [
  { id: 'vpn', label: 'VPN', ico: '⛨', accent: 'green' },
  { id: 'scan', label: 'SCAN', ico: '⌖', accent: 'magenta' },
  { id: 'system', label: 'SYSTEM', ico: '⏻', accent: 'amber' },
  { id: 'settings', label: 'SETTINGS', ico: '⚙', accent: '' },
]
const ORDER: Screen[] = ['home', 'vpn', 'scan', 'system', 'settings']

const app = document.getElementById('app')!
let screen: Screen = 'home'
let escOpen = false
let preEscFk: string | undefined = undefined
let lastNet: NetInfo | null = null

/* vpn screen state */
let vpnPresetsCache: Preset[] = []
let vpnActive: VpnStatus | null = null
let vpnOpenvpnInstalled: boolean | null = null
let vpnLogTimer: number | null = null
let scanHandle: ScanHandle | null = null

/* ───────────────────────── helpers ───────────────────────── */
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, text?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}

async function api<T = any>(p: () => Promise<T>, retryOnSudo: boolean = true): Promise<T> {
  try {
    return await p()
  } catch (e: any) {
    if (retryOnSudo && e?.status === 401) {
      if (await askSudo()) return p()
      throw new Error('cancelled (sudo required)')
    }
    throw e
  }
}

/* ───────────────────────── header / nav ───────────────────────── */
function header(net: NetInfo | null): HTMLElement {
  const h = el('header', 'hdr')
  const logo = el('button', 'logo')
  logo.type = 'button'
  logo.title = 'Home'
  logo.dataset.fk = 'logo'
  logo.innerHTML = 'ULAUNCH<span>_</span>'
  logo.style.cssText = 'background:none;border:none;cursor:pointer'
  logo.addEventListener('click', () => go('home'))
  h.appendChild(logo)
  h.appendChild(el('div', 'spacer'))
  if (net) {
    const vpn = el('div', `stat ${net.vpn.active ? 'ok' : ''}`)
    vpn.dataset.fk = 'stat:vpn'
    vpn.innerHTML = net.vpn.active
      ? `VPN <b>● CONNECTED</b>${net.vpn.interfaces[0] ? ` ${net.vpn.interfaces[0]}` : ''}`
      : 'VPN <b>○ OFFLINE</b>'
    h.appendChild(vpn)
    const bat = el('div', 'stat')
    bat.dataset.fk = 'stat:bat'
    bat.innerHTML = net.battery
      ? `BAT <b>${net.battery.percent}%${net.battery.charging ? ' ⚡' : ''}</b>`
      : 'BAT <b>AC</b>'
    h.appendChild(bat)
    const up = el('div', 'stat')
    up.dataset.fk = 'stat:up'
    up.innerHTML = `UP <b>${fmtUptime(net.uptime_s)}</b>`
    h.appendChild(up)
    const clk = el('div', 'stat'); clk.id = 'clock'
    h.appendChild(clk)
  }
  return h
}

function nav(): HTMLElement {
  const n = el('nav', `nav${screen !== 'home' ? ' has-active' : ''}`)
  for (const t of TILES) {
    const d = el('button', `tile ${screen === t.id ? 'active' : ''}`)
    d.dataset.accent = t.accent
    d.dataset.screen = t.id
    d.dataset.fk = `tile:${t.id}`
    d.tabIndex = 0
    d.innerHTML = `<span class="ico">${t.ico}</span>${t.label}`
    d.addEventListener('click', () => go(t.id))
    n.appendChild(d)
  }
  return n
}

/* ───────────────────────── HOME ───────────────────────── */
function ifaceCard(i: NetInfo['interfaces'][number]): HTMLElement {
  const c = el('div', 'card')
  const typeCls = !i.up ? 'down' : i.type
  const head = el('div', 'c-head')
  head.appendChild(el('span', 'dot ' + (i.up ? 'on' : '')))
  head.appendChild(el('span', 'c-name', i.name))
  head.appendChild(el('span', `c-type ${typeCls}`, !i.up ? 'DOWN' : i.type))
  c.appendChild(head)
  if (i.type === 'wifi' && i.up) {
    const sub = el('div', 'c-sub')
    sub.innerHTML = i.ssid ? `SSID <b>${i.ssid}</b>${i.signal !== null ? ` · ${i.signal}%` : ''}` : 'connected'
    c.appendChild(sub)
  }
  if (i.ipv4) {
    const ip = el('div', 'c-sub'); ip.innerHTML = `IP <b>${i.ipv4.addr}</b>`
    const netd = el('div', 'c-sub'); netd.innerHTML = `NET <b>${i.ipv4.subnet}</b>`
    c.appendChild(ip)
    c.appendChild(netd)
  } else if (i.up) {
    c.appendChild(el('div', 'c-sub', 'no IPv4 address'))
  }
  c.appendChild(el('div', 'c-sub', `STATE ${i.state}`))
  return c
}

function homeContent(net: NetInfo | null): HTMLElement {
  const c = el('div', 'content')
  if (!net) { c.appendChild(el('div', 'soon', 'connecting…')); return c }
  c.appendChild(el('div', 'section-title', 'INTERFACES'))
  const cards = el('div', 'cards')
  for (const i of net.interfaces) cards.appendChild(ifaceCard(i))
  c.appendChild(cards)
  if (net.vpn.active) {
    c.appendChild(el('div', 'section-title', 'VPN'))
    const vc = el('div', 'cards')
    const card = el('div', 'card active')
    const head = el('div', 'c-head')
    head.appendChild(el('span', 'dot on'))
    head.appendChild(el('span', 'c-name', 'TUNNEL'))
    head.appendChild(el('span', 'c-type vpn', 'CONNECTED'))
    card.appendChild(head)
    card.appendChild(el('div', 'c-sub', net.vpn.interfaces.join(', ')))
    vc.appendChild(card)
    c.appendChild(vc)
  }
  return c
}

/* ───────────────────────── VPN ───────────────────────── */
function vpnRow(p: Preset, active: boolean): HTMLElement {
  const row = el('div', `vpn-row ${active ? 'active' : ''}`)
  const info = el('div', 'vpn-row-info')
  info.appendChild(el('div', 'vpn-row-name'))
  info.querySelector('.vpn-row-name')!.innerHTML =
    `<span class="dot ${active ? 'on' : ''}"></span> ${p.name}`
  const meta = el('div', 'vpn-row-meta')
  meta.textContent = [p.proto || 'udp (default)', p.server, p.last_connected ? `last ${p.last_connected}` : 'never connected']
    .filter(Boolean).join(' · ')
  info.appendChild(meta)
  row.appendChild(info)

  const btns = el('div', 'btn-row')
  const act = el('button', `btn ${active ? 'danger' : ''}`)
  act.textContent = active ? 'DISCONNECT' : 'CONNECT'
  act.tabIndex = 0
  act.dataset.fk = `vpn:${p.name}:act`
  act.addEventListener('click', () => {
    act.disabled = true
    act.textContent = '…'
    api(() => active ? vpnDisconnect() : vpnConnect(p.name))
      .then(refreshVpn)
      .catch(e => { act.textContent = active ? 'DISCONNECT' : 'CONNECT'; alert(String(e.message || e)) })
      .finally(() => { act.disabled = false })
  })
  btns.appendChild(act)
  const del = el('button', 'btn small', '✕')
  del.tabIndex = 0
  del.dataset.fk = `vpn:${p.name}:del`
  del.title = 'delete preset'
  del.addEventListener('click', () => {
    if (!confirm(`Delete preset "${p.name}"?`)) return
    vpnDeletePreset(p.name).then(refreshVpn).catch(e => alert(String(e.message || e)))
  })
  btns.appendChild(del)
  row.appendChild(btns)
  return row
}

function vpnAddForm(): HTMLElement {
  const wrap = el('div', 'vpn-add')
  const title = el('div', 'section-title', 'ADD PRESET')
  wrap.appendChild(title)
  const name = el('input', 'text-input')
  name.type = 'text'; name.placeholder = 'preset name (e.g. work)'
  name.dataset.fk = 'vpnadd:name'
  name.tabIndex = 0
  wrap.appendChild(name)
  const cfg = el('textarea', 'text-input config-ta')
  cfg.placeholder = 'paste the full OpenVPN config (.ovpn) here…'
  cfg.dataset.fk = 'vpnadd:cfg'
  cfg.tabIndex = 0
  wrap.appendChild(cfg)
  const row = el('div', 'btn-row')
  const err = el('div', 'form-err')
  const save = el('button', 'btn active', 'SAVE')
  save.tabIndex = 0
  save.dataset.fk = 'vpnadd:save'
  save.addEventListener('click', () => {
    err.textContent = ''
    if (!name.value.trim()) { err.textContent = 'name required'; return }
    vpnAddPreset(name.value.trim(), cfg.value)
      .then(() => { name.value = ''; cfg.value = ''; refreshVpn() })
      .catch(e => { err.textContent = String(e.message || e) })
  })
  row.appendChild(save)
  wrap.appendChild(row)
  wrap.appendChild(err)
  return wrap
}

function vpnLogPanel(name: string | null): HTMLElement {
  const p = el('div', 'vpn-log')
  if (!name) { p.textContent = '— no log (not connected) —'; return p }
  p.textContent = 'loading…'
  const load = () => vpnLog(name, 60)
    .then(t => { if (document.body.contains(p)) p.textContent = t || '— empty log —' })
    .catch(() => { if (document.body.contains(p)) p.textContent = '— log unavailable —' })
  load()
  return p
}

function vpnContent(): HTMLElement {
  const c = el('div', 'content')
  const banner = el('div', 'section-title')
  banner.textContent = 'OPENVPN'
  c.appendChild(banner)

  if (vpnOpenvpnInstalled === false) {
    const tb = el('div', 'tool-banner')
    tb.innerHTML = `<span>⚠ openvpn not installed</span>`
    const inst = el('button', 'btn active', 'INSTALL')
    inst.tabIndex = 0
    inst.dataset.fk = 'openvpn:install'
    inst.addEventListener('click', () => {
      inst.disabled = true; inst.textContent = 'installing…'
      api(() => toolsInstall('openvpn'))
        .then(() => { vpnOpenvpnInstalled = true; refreshVpn() })
        .catch(e => { inst.disabled = false; inst.textContent = 'INSTALL'; alert(String(e.message || e)) })
    })
    tb.appendChild(inst)
    c.appendChild(tb)
  }

  c.appendChild(el('div', 'section-title', 'PRESETS'))
  if (vpnPresetsCache.length === 0) {
    c.appendChild(el('div', 'empty', 'no presets yet — add one below'))
  } else {
    const list = el('div', 'vpn-list')
    for (const p of vpnPresetsCache) list.appendChild(vpnRow(p, vpnActive?.preset === p.name))
    c.appendChild(list)
  }

  c.appendChild(vpnAddForm())
  c.appendChild(el('div', 'section-title', 'LIVE LOG'))
  c.appendChild(vpnLogPanel(vpnActive?.preset ?? null))
  return c
}

async function refreshVpn() {
  try {
    vpnPresetsCache = await vpnPresets()
  } catch { /* keep old */ }
  try { vpnActive = await vpnStatus() } catch { vpnActive = { connected: false, preset: null } }
  if (screen === 'vpn') render()
}

function startLogPoll() {
  stopLogPoll()
  vpnLogTimer = window.setInterval(() => {
    if (screen !== 'vpn') return
    const p = vpnActive?.preset
    if (p) vpnLog(p, 60).then(t => {
      const box = document.querySelector('.vpn-log')
      if (box) box.textContent = t || '— empty log —'
    }).catch(() => {})
    vpnStatus().then(s => { vpnActive = s }).catch(() => {})
  }, 2500)
}
function stopLogPoll() { if (vpnLogTimer) { clearInterval(vpnLogTimer); vpnLogTimer = null } }

/* ───────────────────────── SCAN / SYSTEM / SETTINGS ───────────────────────── */
function systemContent(): HTMLElement {
  const c = el('div', 'content')
  c.appendChild(el('div', 'section-title', 'POWER'))
  const g = el('div', 'sys-grid')
  const items: [string, string, string, string][] = [
    ['suspend', 'SUSPEND', '⏸', 'amber'], ['reboot', 'RESTART', '↻', 'amber'],
    ['shutdown', 'SHUTDOWN', '⏻', 'danger'], ['poweroff', 'POWER OFF', '⊘', 'danger'],
  ]
  for (const [action, label, ico, cls] of items) {
    const b = el('button', `sys-btn ${cls}`)
    b.tabIndex = 0
    b.dataset.fk = `sys:${action}`
    b.innerHTML = `<span class="ico">${ico}</span>${label}`
    b.addEventListener('click', () => doPower(action, label, b))
    g.appendChild(b)
  }
  c.appendChild(g)
  const s = el('div', 'sys-info')
  s.textContent = 'Power actions need root. Each is confirmed before it runs.'
  c.appendChild(s)
  systemStatus().then(st => {
    if (!st.has_systemd) s.textContent = '⚠ systemd not found on this system — power actions unavailable.'
  }).catch(() => {})
  return c
}

async function doPower(action: string, label: string, btn: HTMLButtonElement) {
  const ok = window.confirm(`Really ${label.toLowerCase()} the uConsole?`)
  if (!ok) return
  btn.disabled = true
  btn.classList.add('busy')
  try {
    await api(() => systemAction(action))
    btn.innerHTML = `<span class="ico">✓</span>${label} SENDING…`
    /* the device goes down; show it for a moment if it doesn't */
    setTimeout(() => { btn.disabled = false; btn.classList.remove('busy') }, 8000)
  } catch (e: any) {
    btn.disabled = false
    btn.classList.remove('busy')
    window.alert(`${label} failed: ${e?.message || e}`)
  }
}

function settingsContent(): HTMLElement {
  const c = el('div', 'content')
  c.appendChild(el('div', 'section-title', 'SCREENSAVER'))
  const idleRow = el('div', 'setting-row')
  idleRow.appendChild(el('span', 'setting-label', 'IDLE TIMEOUT'))
  const sel = el('select', 'select-input')
  sel.tabIndex = 0
  sel.dataset.fk = 'set:idle'
  for (const s of [15, 30, 60, 120, 300, 600]) {
    const o = el('option'); o.value = String(s); o.textContent = s < 60 ? `${s} seconds` : `${Math.round(s / 60)} minute${s >= 120 ? 's' : ''}`
    sel.appendChild(o)
  }
  sel.addEventListener('change', async () => {
    try {
      const st = await putSettings({ idle_timeout: Number(sel.value) })
      overlay.setIdleTimeout(st.idle_timeout)
      flashSaved(c)
    } catch (e: any) { window.alert(String(e?.message || e)) }
  })
  idleRow.appendChild(sel)
  c.appendChild(idleRow)

  c.appendChild(el('div', 'section-title', 'SCAN DEFAULTS'))
  const flagLabels: [string, string][] = [
    ['deep', 'Deep scan (versions + scripts)'],
    ['udp', 'UDP top-100'],
    ['full_tcp', 'Full TCP 1-65535'],
  ]
  for (const [key, label] of flagLabels) {
    const row = el('div', 'setting-row')
    const cb = el('input', 'check-input')
    cb.type = 'checkbox'
    cb.id = `flag-${key}`
    cb.dataset.fk = `set:${key}`
    cb.tabIndex = 0
    cb.addEventListener('change', async () => {
      try {
        await putSettings({ scan_flags: { [key]: cb.checked } })
        flashSaved(c)
      } catch (e: any) { window.alert(String(e?.message || e)) }
    })
    const lb = el('label', 'setting-label')
    lb.htmlFor = cb.id
    lb.textContent = label
    row.appendChild(cb); row.appendChild(lb)
    c.appendChild(row)
  }

  c.appendChild(el('div', 'section-title', 'ABOUT'))
  const ab = el('div', 'about')
  ab.innerHTML = 'ULAUNCH · network &amp; system launcher<br>uConsole 1280×720 · local only (127.0.0.1)'
  c.appendChild(ab)

  /* load current values (once per page session — re-renders must not
     overwrite a value the user just changed, and a stale in-flight GET
     must not clobber a change the user just made) */
  if (!settingsLoaded) {
    settingsLoaded = true
    getSettings().then(st => {
      if (sel.isConnected) sel.value = String(st.idle_timeout)
      const f = st.scan_flags || {}
      for (const [key] of flagLabels) {
        const cb = document.getElementById(`flag-${key}`) as HTMLInputElement | null
        if (cb) cb.checked = Boolean(f[key])
      }
    }).catch(() => {})
  }
  return c
}

let settingsLoaded = false

let savedFlashTimer: number | null = null
function flashSaved(c: HTMLElement) {
  c.querySelector('.saved-flash')?.remove()
  const f = el('div', 'saved-flash', '✓ SAVED')
  c.appendChild(f)
  if (savedFlashTimer) clearTimeout(savedFlashTimer)
  savedFlashTimer = window.setTimeout(() => f.remove(), 1500)
}

function footer(): HTMLElement {
  const f = el('footer', 'foot')
  f.innerHTML =
    '<span><kbd>←→</kbd>move</span><span><kbd>Enter</kbd>open tool</span>' +
    '<span><kbd>←→</kbd>/<kbd>Tab</kbd>in tool</span><span><kbd>⌫</kbd>/<kbd>Esc</kbd>back</span>' +
    '<span><kbd>Esc</kbd>menu</span>'
  return f
}

function escMenu(): HTMLElement {
  const m = el('div', 'esc-menu'); m.id = 'esc-menu'
  const box = el('div', 'box')
  box.appendChild(el('div', 'title', 'STANDBY MENU'))
  const mk = (label: string, action: 'desktop' | 'hide' | 'exit', cls = '') => {
    const b = el('button', `btn ${cls}`)
    b.tabIndex = 0; b.textContent = label
    b.addEventListener('click', () => doExit(action))
    return b
  }
  box.appendChild(mk('BACK TO DESKTOP', 'desktop'))
  box.appendChild(mk('MINIMISE / HIDE', 'hide'))
  box.appendChild(mk('EXIT', 'exit', 'danger'))
  box.appendChild(el('div', 'hint', 'Esc to close menu'))
  m.appendChild(box)
  return m
}

/* ───────────────────────── render ───────────────────────── */
function render() {
  /* preserve keyboard focus across the re-render: remember the focused
     control's stable data-fk and restore it afterwards. Without this,
     every async re-render (VPN refresh, net update) drops focus to the
     body and Tab restarts at the logo. */
  const ae = document.activeElement as HTMLElement | null
  const fk = ae && app.contains(ae) ? ae.dataset.fk : undefined

  app.innerHTML = ''
  app.appendChild(header(lastNet))
  app.appendChild(nav())
  if (screen === 'home') app.appendChild(homeContent(lastNet))
  else if (screen === 'vpn') app.appendChild(vpnContent())
  else if (screen === 'scan') {
    const holder = el('div', 'content scan-holder')
    app.appendChild(holder)
    scanHandle = mountScan(holder)
  }
  else if (screen === 'system') app.appendChild(systemContent())
  else app.appendChild(settingsContent())
  app.appendChild(footer())
  app.appendChild(escMenu())
  if (escOpen) document.getElementById('esc-menu')!.classList.add('open')

  if (fk) {
    const restored = app.querySelector<HTMLElement>(`[data-fk="${fk}"]`)
    if (restored && !(restored as HTMLButtonElement).disabled) restored.focus()
  }
}

/* ───────────────────────── state ───────────────────────── */
/* Keyboard model (two levels):
   TOOL ROW (logo + tiles):  ←/→ move between tools, Enter drops into the
     tool under the cursor (focus lands on its first control).
   INSIDE A TOOL:            ←/→ (and ↑/↓) cycle the tool's own controls in
     DOM order — this is how you walk the options.
                             Backspace exits the tool: focus returns to its
                             tile in the row.
                             Tab/Shift+Tab still work (same cycle, wrapping).
   Anywhere else (body after a re-render, no active control): ←/→ hop tools,
     Enter opens the active tool. */
function activeTile(): HTMLElement | null {
  return app.querySelector<HTMLElement>('.nav .tile.active')
}
function focusContentFirst(): void {
  const first = app.querySelector<HTMLElement>('.content button:not([disabled]), .content input, .content select, .content textarea, .content [tabindex="0"]')
  first?.focus()
}

async function go(s: Screen) {
  const prev = screen
  screen = s
  if (prev === 'scan') { scanHandle?.destroy(); scanHandle = null }
  render()
  if (s === 'vpn') { await refreshVpn(); startLogPoll() }
  if (prev === 'vpn') stopLogPoll()
  /* drop focus into the tool (its first control) so the user is in the
     tool they picked. For SCAN the options load async — mountScan owns
     the initial focus (focuses the first option once they arrive). */
  if (s === 'home') app.querySelector<HTMLElement>('.logo')?.focus()
  else if (s !== 'scan') focusContentFirst()
}

async function doExit(action: 'desktop' | 'hide' | 'exit') {
  await exitApp(action)
  if (action === 'hide') {
    app.innerHTML = ''
    const s = el('div', 'soon')
    s.innerHTML = '<div class="big">HIDDEN</div>server still running — reopen from the desktop'
    app.appendChild(s)
    return
  }
  app.innerHTML = ''
  const s = el('div', 'soon')
  s.innerHTML = '<div class="big">STANDBY</div>shutting down'
  app.appendChild(s)
}

function toggleEsc(force?: boolean) {
  escOpen = force ?? !escOpen
  overlay.wake()
  if (escOpen) {
    /* remember where focus was (tiles/logo/content controls all carry
       data-fk) so closing the menu puts it back */
    const ae = document.activeElement as HTMLElement | null
    preEscFk = ae && app.contains(ae) ? ae.dataset.fk : undefined
    render()
    document.querySelector<HTMLElement>('#esc-menu .box .btn')?.focus()
  } else {
    render()
    const fk = preEscFk
    preEscFk = undefined
    if (fk) {
      const back = app.querySelector<HTMLElement>(`[data-fk="${fk}"]`)
      if (back && !(back as HTMLButtonElement).disabled) { back.focus(); return }
    }
    activeTile()?.focus() || app.querySelector<HTMLElement>('.logo')?.focus()
  }
}

/* ───────────────────────── keyboard ───────────────────────── */
function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input, select, textarea, a, [tabindex="0"]',
  ))
}
/* Text-entry fields that own the arrow keys and Backspace natively
   (caret movement, value changes, editing). Navigation must not eat
   those keystrokes. Buttons, checkboxes, selects and [tabindex]
   controls do NOT own arrows/Backspace the same way, so the app
   drives them. */
function isTextInput(t: HTMLElement | null): boolean {
  if (!t) return false
  if (t.tagName === 'TEXTAREA' || t.isContentEditable) return true
  if (t.tagName === 'INPUT') {
    const ty = ((t as HTMLInputElement).type || 'text').toLowerCase()
    return !['checkbox', 'radio'].includes(ty)
  }
  return false
}

/* the tool row: logo first, then the four tiles, in order */
function rowEl(): HTMLElement[] {
  return [
    app.querySelector<HTMLElement>('.logo')!,
    ...Array.from(app.querySelectorAll<HTMLElement>('.nav .tile')),
  ]
}
function onRow(t: HTMLElement | null): number {
  if (!t) return -1
  return rowEl().indexOf(t)
}
/* cycle focus within the tool's content: idx + dir, wrapping. Returns the
   element that got focus (null if content is empty). */
function stepInContent(dir: 1 | -1): HTMLElement | null {
  const content = app.querySelector<HTMLElement>('.content')
  if (!content) return null
  const list = focusables(content)
  if (!list.length) return null
  const ae = document.activeElement as HTMLElement | null
  const idx = ae ? list.indexOf(ae) : -1
  const next = idx < 0
    ? (dir === 1 ? 0 : list.length - 1)
    : (idx + dir + list.length) % list.length
  list[next].focus()
  return list[next]
}
/* Enter on the tool row: drop into the tool under the cursor. */
function enterTool(t: HTMLElement): void {
  if (t.classList.contains('logo')) { void go('home'); return }
  const s = t.dataset.screen as Screen
  if (s && s !== screen) void go(s)
  else focusContentFirst()
}

/* ── results-list scrolling ──────────────────────────────── */
/* One arrow press = a few lines (~4 port rows) of scrolling while the
   focused host card overflows the results pane (deep scans produce tall
   cards); once the card no longer overflows the pressed edge, focus jumps
   to the neighbouring card. ↓ past the LAST card falls through to the
   NEW SCAN button (handled by the caller). Returns true when the key was
   handled (scrolled, jumped, or clamped), false for the caller to act on. */
function resultsArrow(dir: 1 | -1, card: HTMLElement, content: HTMLElement | null): boolean {
  if (!content) return false
  const list = Array.from(content.querySelectorAll<HTMLElement>('.scan-host-card, .scan-host'))
  const i = list.indexOf(card)
  const cr = card.getBoundingClientRect()
  const vr = content.getBoundingClientRect()
  const padB = parseFloat(getComputedStyle(content).paddingBottom) || 0
  const viewH = vr.height - padB
  const top = cr.top - vr.top
  const bottom = top + cr.height
  /* ~4 port rows per press — "a few lines" */
  const line = () => Math.max(20, Math.round(((content.querySelector('.port-row') as HTMLElement | null)?.offsetHeight || 40) * 4))

  if (dir === 1) {
    /* DOWN: scroll the missing bottom edge in, a few lines per press */
    const needed = bottom - viewH
    if (needed > 0.5) {
      if (content.scrollTop >= Math.max(0, content.scrollHeight - viewH) - 0.5) {
        /* card taller than the whole pane — scroll is at its end: hand
           over to the next card (or NEW SCAN if this one is last) */
        if (i + 1 < list.length) { list[i + 1].focus({ preventScroll: true }); return true }
        return false
      }
      content.scrollTo({ top: content.scrollTop + Math.min(line(), needed), behavior: 'smooth' })
      return true
    }
    /* card bottom is at/above the pane bottom: hand over to the next card */
    if (i + 1 < list.length) {
      const n = list[i + 1].getBoundingClientRect().top - vr.top
      if (n <= viewH - 40) {
        /* next card is on screen: jump to it (its top at the pane top) */
        list[i + 1].focus({ preventScroll: true })
        content.scrollTo({ top: n + content.scrollTop, behavior: 'smooth' })
        return true
      }
      /* next card is below the pane: scroll it in a few lines */
      content.scrollTo({ top: Math.min(content.scrollTop + line(), n + content.scrollTop - 8), behavior: 'smooth' })
      return true
    }
    return false /* last card -> caller focuses NEW SCAN */
  }

  /* UP: scroll the missing top edge in, a few lines per press */
  const room = -top
  if (room > 0.5) {
    if (content.scrollTop <= 0.5) {
      /* card taller than the whole pane at the top: jump to the previous
         card (or stay clamped on the first) */
      if (i > 0) {
        list[i - 1].focus({ preventScroll: true })
        return true
      }
      return true
    }
    content.scrollTo({ top: Math.max(0, content.scrollTop - Math.min(line(), room)), behavior: 'smooth' })
    return true
  }
  /* card top is at/above the pane top: jump to the previous card */
  if (i > 0) {
    list[i - 1].focus({ preventScroll: true })
    const pb = list[i - 1].getBoundingClientRect().bottom - vr.top
    content.scrollTo({ top: Math.max(0, content.scrollTop + pb - 12), behavior: 'smooth' })
    return true
  }
  return true /* clamped at the top */
}

document.addEventListener('keydown', (e: KeyboardEvent) => {
  if (document.getElementById('sudo-modal')) return /* modal owns keys */

  /* ── standby (Esc) menu: arrows/Tab move between its buttons ── */
  if (escOpen) {
    if (e.key === 'Escape') { e.preventDefault(); toggleEsc(false); return }
    const btns = Array.from(
      document.querySelectorAll<HTMLElement>('#esc-menu .box .btn'))
    const idx = btns.indexOf(e.target as HTMLElement)
    const move = (d: number) => {
      e.preventDefault()
      if (btns.length) btns[(idx + d + btns.length) % btns.length]?.focus()
    }
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') move(1)
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') move(-1)
    else if (e.key === 'Tab') move(e.shiftKey ? -1 : 1)
    return
  }

  const t = e.target as HTMLElement | null
  const content = app.querySelector<HTMLElement>('.content')
  const inContent = t && t !== document.body && content?.contains(t)

  /* Esc: inside a tool → exit to the tool row (from any control, incl. a
     text field); on the row / home / body → open the standby menu. */
  if (e.key === 'Escape') {
    e.preventDefault()
    if (screen !== 'home' && (t === null || t === document.body || inContent)) {
      activeTile()?.focus()
    } else {
      toggleEsc(true)
    }
    return
  }

  /* Tab: next/previous control within the tool. This is also the reliable
     way OUT of a text input (arrows move the caret, Backspace edits), so
     it must work from every control type. On the tool row, Tab moves
     between tiles like the arrows. */
  if (e.key === 'Tab') {
    if (inContent) {
      e.preventDefault()
      stepInContent(e.shiftKey ? -1 : 1)
      return
    }
    const idx = onRow(t)
    if (idx >= 0) {
      e.preventDefault()
      const d = e.shiftKey ? -1 : 1
      rowEl()[(idx + d + rowEl().length) % rowEl().length]?.focus()
    }
    return
  }

  /* Backspace: exit the current tool — focus returns to its tile in the
     row. Never inside a text-entry field (it edits there). A <select> has
     no native Backspace behaviour, so exiting works there too. */
  if (e.key === 'Backspace') {
    if (screen !== 'home' &&
        (t === null || t === document.body || inContent) &&
        !isTextInput(t)) {
      e.preventDefault()
      activeTile()?.focus()
      return
    }
    return
  }

  if (e.key === 'Enter') {
    const idx = onRow(t)
    if (idx >= 0) {
      e.preventDefault()
      enterTool(t as HTMLElement)
      return
    }
    /* elsewhere: let the control's own click/activate happen natively */
    return
  }

  const isArrow = (e.key === 'ArrowRight' || e.key === 'ArrowLeft' ||
                   e.key === 'ArrowUp' || e.key === 'ArrowDown')
  if (!isArrow) return

  /* text-entry fields own the arrows natively (caret movement) */
  if (isTextInput(t)) return

  /* scan results list: ↑/↓ scroll a few LINES per press while the focused
     host card overflows the results pane (deep scans produce tall cards),
     and jump to the previous/next card once the card is fully visible.
     Past the BOTTOM ↓, focus falls through to the NEW SCAN button below
     the list. ←/→ (and Tab) keep cycling ALL controls of the tool. */
  const dir: 1 | -1 = (e.key === 'ArrowRight' || e.key === 'ArrowDown') ? 1 : -1

  if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') &&
      t && (t.classList.contains('scan-host-card') || t.classList.contains('scan-host'))) {
    e.preventDefault()
    if (resultsArrow(dir, t, content)) return
    /* not scrollable/navigable: past the last card ↓ → NEW SCAN */
    if (dir === 1) content?.querySelector<HTMLElement>('[data-fk="newscan"]')?.focus()
    return
  }

  /* <select> (settings idle timeout): ←/→ change the value natively,
     ↑/↓ navigate to the next/previous control. (While the native
     dropdown popup is open, keys go to the popup, not here.) */
  if (t?.tagName === 'SELECT') {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') return
    e.preventDefault()
    const dirSel: 1 | -1 = e.key === 'ArrowDown' ? 1 : -1
    stepInContent(dirSel)
    return
  }

  e.preventDefault()
  const idx = onRow(t)
  if (idx >= 0) {
    /* on the tool row: ←/→ move between tools (wrapping) */
    rowEl()[(idx + dir + rowEl().length) % rowEl().length]?.focus()
    return
  }

  if (screen !== 'home' && content && (t === null || t === document.body || content.contains(t))) {
    /* inside a tool: ←/→ (and ↑/↓) cycle the tool's own controls —
       this is the way to navigate a tool's options. */
    stepInContent(dir)
    return
  }

  /* anywhere else (body after a re-render, home): ←/→ hop tools */
  const target = ORDER[(ORDER.indexOf(screen) + dir + ORDER.length) % ORDER.length]
  void go(target)
})

/* ───────────────────────── data loop ───────────────────────── */
/* In-place update of the live header stats (VPN / BAT / UP) without
   touching the content area — the content of the VPN and SCAN screens
   updates itself (log poller / WebSocket) and must never be re-rendered
   from here: that would wipe typed config or the live scan and steal
   keyboard focus. */
function refreshHeaderStats(net: NetInfo) {
  const vpn = app.querySelector<HTMLElement>('[data-fk="stat:vpn"]')
  if (vpn) {
    vpn.classList.toggle('ok', net.vpn.active)
    vpn.innerHTML = net.vpn.active
      ? `VPN <b>● CONNECTED</b>${net.vpn.interfaces[0] ? ` ${net.vpn.interfaces[0]}` : ''}`
      : 'VPN <b>○ OFFLINE</b>'
  }
  const bat = app.querySelector<HTMLElement>('[data-fk="stat:bat"]')
  if (bat) bat.innerHTML = net.battery
    ? `BAT <b>${net.battery.percent}%${net.battery.charging ? ' ⚡' : ''}</b>`
    : 'BAT <b>AC</b>'
  const up = app.querySelector<HTMLElement>('[data-fk="stat:up"]')
  if (up) up.innerHTML = `UP <b>${fmtUptime(net.uptime_s)}</b>`
}

async function refresh() {
  try {
    const net = await fetchNet()
    const first = !lastNet
    lastNet = net
    if (screen === 'vpn' || screen === 'scan') {
      /* update only the items that need it — the live header stats. The
         tool's own content is handled by its poller/WebSocket. */
      refreshHeaderStats(net)
    } else {
      render()
    }
    if (first) {
      const first = app.querySelector<HTMLElement>('.nav .tile')
      first?.focus()
      toolsCheck().then(t => { vpnOpenvpnInstalled = t?.openvpn?.installed ?? null })
        .catch(() => { vpnOpenvpnInstalled = null })
    }
  } catch { /* backend still booting */ }
}

function tickClock() {
  const c = document.getElementById('clock')
  if (!c) return
  const d = new Date()
  c.innerHTML = `TIME <b>${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}</b>`
}

render()
refresh()
setInterval(refresh, 15_000)
setInterval(tickClock, 5_000)
tickClock()

/* idle screensaver — timeout comes from settings */
overlay.initOverlay(60)
getSettings().then(st => overlay.setIdleTimeout(st.idle_timeout)).catch(() => {})
