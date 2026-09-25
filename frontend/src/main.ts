import './styles.css'
import {
  fetchNet, exitApp, fmtUptime, type NetInfo,
  vpnPresets, vpnAddPreset, vpnDeletePreset, vpnStatus,
  vpnConnect, vpnDisconnect, vpnLog,
  toolsCheck, toolsInstall, sudoVerify,
  systemStatus, systemAction, getSettings, putSettings,
  type Preset, type VpnStatus,
} from './api'
import { mountScan, type ScanHandle } from './scan'
import * as overlay from './overlay'

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
      await askSudo()
      return p()
    }
    throw e
  }
}

let sudoResolver: ((ok: boolean) => void) | null = null
function askSudo(): Promise<boolean> {
  return new Promise<boolean>(res => {
    sudoResolver = res
    renderSudoModal()
  })
}

function renderSudoModal() {
  document.getElementById('sudo-modal')?.remove()
  const m = el('div', 'esc-menu open')
  m.id = 'sudo-modal'
  const box = el('div', 'box')
  box.appendChild(el('div', 'title', 'ROOT ACCESS'))
  const p = el('p', 'sub')
  p.textContent = 'Enter your sudo password to continue. It is held in memory only and auto-expires.'
  box.appendChild(p)
  const inp = el('input', 'text-input')
  inp.type = 'password'
  inp.autocomplete = 'off'
  inp.placeholder = 'password'
  box.appendChild(inp)
  const err = el('div', 'form-err')
  box.appendChild(err)
  const row = el('div', 'btn-row')
  const cancel = el('button', 'btn', 'CANCEL')
  const ok = el('button', 'btn', 'UNLOCK')
  ok.classList.add('active')
  const done = (ok: boolean) => {
    sudoResolver?.(ok)
    sudoResolver = null
    m.remove()
  }
  cancel.addEventListener('click', () => done(false))
  ok.addEventListener('click', () => {
    sudoVerify(inp.value)
      .then(() => done(true))
      .catch(() => { err.textContent = 'wrong password — try again' })
  })
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') ok.click()
    if (e.key === 'Escape') done(false)
    e.stopPropagation()
  })
  row.appendChild(ok); row.appendChild(cancel)
  box.appendChild(row)
  m.appendChild(box)
  app.appendChild(m)
  setTimeout(() => inp.focus(), 30)
}

/* ───────────────────────── header / nav ───────────────────────── */
function header(net: NetInfo | null): HTMLElement {
  const h = el('header', 'hdr')
  const logo = el('button', 'logo')
  logo.type = 'button'
  logo.title = 'Home'
  logo.innerHTML = 'ULAUNCH<span>_</span>'
  logo.style.cssText = 'background:none;border:none;cursor:pointer'
  logo.addEventListener('click', () => go('home'))
  h.appendChild(logo)
  h.appendChild(el('div', 'spacer'))
  if (net) {
    const vpn = el('div', `stat ${net.vpn.active ? 'ok' : ''}`)
    vpn.innerHTML = net.vpn.active
      ? `VPN <b>● CONNECTED</b>${net.vpn.interfaces[0] ? ` ${net.vpn.interfaces[0]}` : ''}`
      : 'VPN <b>○ OFFLINE</b>'
    h.appendChild(vpn)
    const bat = el('div', 'stat')
    bat.innerHTML = net.battery
      ? `BAT <b>${net.battery.percent}%${net.battery.charging ? ' ⚡' : ''}</b>`
      : 'BAT <b>AC</b>'
    h.appendChild(bat)
    const up = el('div', 'stat')
    up.innerHTML = `UP <b>${fmtUptime(net.uptime_s)}</b>`
    h.appendChild(up)
    const clk = el('div', 'stat'); clk.id = 'clock'
    h.appendChild(clk)
  }
  return h
}

function nav(): HTMLElement {
  const n = el('nav', 'nav')
  for (const t of TILES) {
    const d = el('button', `tile ${screen === t.id ? 'active' : ''}`)
    d.dataset.accent = t.accent
    d.dataset.screen = t.id
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
  meta.textContent = [p.proto, p.server, p.last_connected ? `last ${p.last_connected}` : 'never connected']
    .filter(Boolean).join(' · ')
  info.appendChild(meta)
  row.appendChild(info)

  const btns = el('div', 'btn-row')
  const act = el('button', `btn ${active ? 'danger' : ''}`)
  act.textContent = active ? 'DISCONNECT' : 'CONNECT'
  act.tabIndex = 0
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
  wrap.appendChild(name)
  const cfg = el('textarea', 'text-input config-ta')
  cfg.placeholder = 'paste the full OpenVPN config (.ovpn) here…'
  wrap.appendChild(cfg)
  const row = el('div', 'btn-row')
  const err = el('div', 'form-err')
  const save = el('button', 'btn active', 'SAVE')
  save.tabIndex = 0
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
    '<span><kbd>←→</kbd>switch</span><span><kbd>Tab</kbd>focus</span>' +
    '<span><kbd>Enter</kbd>open</span><span><kbd>Esc</kbd>menu</span>'
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
}

function focusFirst(which: 'nav' | 'vpn') {
  const root = which === 'nav' ? app.querySelector('.nav') : app.querySelector('.content')
  const first = root?.querySelector<HTMLElement>('button, input, textarea, [tabindex="0"]')
  first?.focus()
}

/* ───────────────────────── state ───────────────────────── */
function go(s: Screen) {
  const prev = screen
  screen = s
  if (prev === 'scan') { scanHandle?.destroy(); scanHandle = null }
  render()
  if (s === 'vpn') { refreshVpn(); startLogPoll(); focusFirst('vpn') }
  if (prev === 'vpn') stopLogPoll()
  if (s === 'system' || s === 'settings') {
    const first = app.querySelector<HTMLElement>('.content button, .content [tabindex="0"]')
    first?.focus()
  }
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
  render()
  if (escOpen) {
    const b = document.querySelector<HTMLElement>('#esc-menu .box .btn')
    b?.focus()
  }
}

/* ───────────────────────── keyboard ───────────────────────── */
function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input, textarea, a, [tabindex="0"]',
  ))
}

document.addEventListener('keydown', (e: KeyboardEvent) => {
  if (document.getElementById('sudo-modal')) return /* modal owns keys */
  if (escOpen) {
    if (e.key === 'Escape') { e.preventDefault(); toggleEsc(false) }
    return
  }
  if (e.key === 'Escape') { e.preventDefault(); toggleEsc(true); return }

  const t = e.target as HTMLElement | null
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
    return /* typing wins */
  }

  /* arrow nav: if a control is focused, move between controls in the screen */
  if ((e.key === 'ArrowRight' || e.key === 'ArrowDown' ||
       e.key === 'ArrowLeft' || e.key === 'ArrowUp') && t && t !== document.body) {
    const list = focusables(app)
    const idx = list.indexOf(t)
    if (idx !== -1) {
      e.preventDefault()
      const dir = (e.key === 'ArrowRight' || e.key === 'ArrowDown') ? 1 : -1
      const next = list[idx + dir] ?? list[0]
      ;(list[(idx + dir + list.length) % list.length] ?? next)?.focus()
      return
    }
  }

  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    e.preventDefault()
    const d = e.key === 'ArrowRight' ? 1 : -1
    go(ORDER[(ORDER.indexOf(screen) + d + ORDER.length) % ORDER.length])
  }
})

/* ───────────────────────── data loop ───────────────────────── */
async function refresh() {
  try {
    const net = await fetchNet()
    const first = !lastNet
    lastNet = net
    /* don't re-render while the user is on the VPN screen — the 2.5s
       log poller updates that view in place; a full re-render would
       wipe typed config text and steal focus */
    if (screen !== 'vpn') render()
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
