import './styles.css'
import { fetchNet, exitApp, fmtUptime, type NetInfo } from './api'

type Screen = 'home' | 'vpn' | 'scan' | 'system' | 'settings'

const TILES: { id: Screen; label: string; ico: string; accent: string }[] = [
  { id: 'vpn', label: 'VPN', ico: '⛨', accent: 'green' },
  { id: 'scan', label: 'SCAN', ico: '⌖', accent: 'magenta' },
  { id: 'system', label: 'SYSTEM', ico: '⏻', accent: 'amber' },
  { id: 'settings', label: 'SETTINGS', ico: '⚙', accent: '' },
]

const app = document.getElementById('app')!
let screen: Screen = 'home'
let escOpen = false
let lastNet: NetInfo | null = null
const ORDER: Screen[] = ['home', 'vpn', 'scan', 'system', 'settings']

/* ────────────────────────── rendering ────────────────────────── */

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, text?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}

function header(net: NetInfo | null): HTMLElement {
  const h = el('header', 'hdr')
  const logo = el('button', 'logo')
  logo.type = 'button'
  logo.title = 'Home'
  logo.innerHTML = 'ULAUNCH<span>_</span>'
  logo.style.background = 'none'
  logo.style.border = 'none'
  logo.style.cursor = 'pointer'
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

    const clk = el('div', 'stat')
    clk.id = 'clock'
    h.appendChild(clk)
  }
  return h
}

function nav(active: Screen): HTMLElement {
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
    sub.innerHTML = i.ssid
      ? `SSID <b>${i.ssid}</b>${i.signal !== null ? ` · ${i.signal}%` : ''}`
      : 'connected'
    c.appendChild(sub)
  }
  if (i.ipv4) {
    const sub = el('div', 'c-sub')
    sub.innerHTML = `IP <b>${i.ipv4.addr}</b>`
    c.appendChild(sub)
    const sub2 = el('div', 'c-sub')
    sub2.innerHTML = `NET <b>${i.ipv4.subnet}</b>`
    c.appendChild(sub2)
  } else if (i.up) {
    c.appendChild(el('div', 'c-sub', 'no IPv4 address'))
  }
  const st = el('div', 'c-sub')
  st.textContent = `STATE ${i.state}`
  c.appendChild(st)
  return c
}

function homeContent(net: NetInfo | null): HTMLElement {
  const c = el('div', 'content')
  if (!net) {
    c.appendChild(el('div', 'soon', 'connecting…'))
    return c
  }
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

function soonContent(name: string): HTMLElement {
  const c = el('div', 'content')
  const s = el('div', 'soon')
  s.innerHTML = `<div class="big">${name} <em>OFFLINE</em></div>arrives in the next milestone`
  c.appendChild(s)
  return c
}

function systemContent(): HTMLElement {
  const c = el('div', 'content')
  c.appendChild(el('div', 'section-title', 'POWER'))
  const g = el('div', 'sys-grid')
  const items: [string, string, string][] = [
    ['SUSPEND', '⏸', 'amber'],
    ['RESTART', '↻', 'amber'],
    ['SHUTDOWN', '⏻', 'danger'],
    ['POWER OFF', '⊘', 'danger'],
  ]
  for (const [label, ico, cls] of items) {
    const b = el('button', `sys-btn ${cls}`)
    b.tabIndex = 0
    b.innerHTML = `<span class="ico">${ico}</span>${label}`
    b.title = 'wired in M4'
    g.appendChild(b)
  }
  c.appendChild(g)
  const s = el('div', 'soon')
  s.innerHTML = `<div class="big">POWER <em>OFFLINE</em></div>wired in the next milestone`
  s.style.flex = '0'
  s.style.padding = '1em 0 0'
  c.appendChild(s)
  return c
}

function footer(): HTMLElement {
  const f = el('footer', 'foot')
  f.innerHTML =
    '<span><kbd>←→</kbd>switch</span>' +
    '<span><kbd>Enter</kbd>open</span>' +
    '<span><kbd>Esc</kbd>menu</span>'
  return f
}

function escMenu(): HTMLElement {
  const m = el('div', 'esc-menu')
  m.id = 'esc-menu'
  const box = el('div', 'box')
  box.appendChild(el('div', 'title', 'STANDBY MENU'))
  const mk = (label: string, action: 'desktop' | 'hide' | 'exit', cls = '') => {
    const b = el('button', `btn ${cls}`)
    b.tabIndex = 0
    b.textContent = label
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

function overlay(): HTMLElement {
  const o = el('div', 'overlay')
  o.id = 'overlay'
  const cv = document.createElement('canvas')
  o.appendChild(cv)
  const s = el('div', 'standby')
  s.innerHTML = '<div class="s1">STANDBY</div><div class="s2">PRESS ANY KEY</div>'
  o.appendChild(s)
  return o
}

function render() {
  app.innerHTML = ''
  app.appendChild(header(lastNet))
  app.appendChild(nav(screen))
  if (screen === 'home') app.appendChild(homeContent(lastNet))
  else if (screen === 'vpn') app.appendChild(soonContent('VPN'))
  else if (screen === 'scan') app.appendChild(soonContent('SCAN'))
  else if (screen === 'system') app.appendChild(systemContent())
  else app.appendChild(soonContent('SETTINGS'))
  app.appendChild(footer())
  app.appendChild(escMenu())
  app.appendChild(overlay())
  if (escOpen) {
    const m = document.getElementById('esc-menu')!
    m.classList.add('open')
    ;(m.querySelector('button') as HTMLButtonElement)?.focus()
  }
}

/* ────────────────────────── state ────────────────────────── */

function go(s: Screen) {
  screen = s
  render()
}

async function doExit(action: 'desktop' | 'hide' | 'exit') {
  await exitApp(action)
  /* browser closes within moments; leave a farewell frame */
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
}

/* ────────────────────────── keyboard ────────────────────────── */

function focusFirstInteractive(root: HTMLElement): void {
  const first = root.querySelector<HTMLElement>(
    'button, [tabindex="0"], a',
  )
  first?.focus()
}

document.addEventListener('keydown', (e: KeyboardEvent) => {
  if (escOpen) {
    if (e.key === 'Escape') {
      e.preventDefault()
      toggleEsc(false)
    }
    return
  }
  if (e.key === 'Escape') {
    e.preventDefault()
    toggleEsc(true)
    return
  }
  const t = e.target as HTMLElement | null
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
    return /* text entry wins over nav */
  }
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    e.preventDefault()
    const d = e.key === 'ArrowRight' ? 1 : -1
    go(ORDER[(ORDER.indexOf(screen) + d + ORDER.length) % ORDER.length])
    focusFirstInteractive(app)
  }
})

/* ────────────────────────── data loop ────────────────────────── */

async function refresh() {
  try {
    const net = await fetchNet()
    const first = !lastNet
    lastNet = net
    render()
    if (first) focusFirstInteractive(app)
  } catch {
    /* backend still booting; retry next tick */
  }
}

function tickClock() {
  const c = document.getElementById('clock')
  if (!c) return
  const d = new Date()
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  c.innerHTML = `TIME <b>${hh}:${mm}</b>`
}

/* ────────────────────────── boot ────────────────────────── */

render()
refresh()
setInterval(refresh, 15_000)
setInterval(tickClock, 5_000)
tickClock()
