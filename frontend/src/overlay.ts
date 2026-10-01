/** Idle overlay. Created once on <body> so it survives app re-renders.
 *  Phase 1 (idle): matrix rain, ~30fps, animated STANDBY text — battery
 *  hungry on purpose, only while the user is actually around.
 *  Phase 2 (dim, after idleDimS more idle): static black + faint
 *  "ULAUNCH_" — no rAF, no CSS animation, near-zero CPU.
 *  Scan state (light status polls, 5s) drives the big text, in the
 *  matching tool-tile colour:
 *    wifi scan running  → WIFI SCANNING in the wifi tile's violet
 *    bt scan running    → BT SCANNING in the bt tile's red
 *    nmap job running   → SCANNING in the scan tile's magenta
 *    nmap job done (30s)→ SCAN COMPLETE in neon blue
 *    nothing            → STANDBY green
 *  Same text in both phases.
 *  Any key/mouse/touch input wakes it (the waking input is swallowed). */

const DEFAULT_TIMEOUT_S = 60
const DEFAULT_DIM_S = 120
const COMPLETE_S = 30        // SCAN COMPLETE display duration (both phases)
const SCAN_POLL_MS = 5000

let overlay: HTMLDivElement | null = null
let canvas: HTMLCanvasElement | null = null
let ctx: CanvasRenderingContext2D | null = null
let big: HTMLDivElement | null = null
let sub: HTMLDivElement | null = null
let raf = 0
let visible = false
let dimmed = false
let timeoutS = DEFAULT_TIMEOUT_S
let dimS = DEFAULT_DIM_S
let lastActivity = Date.now()
let scanRunning = false
let wifiScanning = false
let btScanning = false
let completeUntil = 0
let cols: number[] = []       // per-column row position (in glyph units)
let colSpeeds: number[] = []
let lastFrame = 0

const GLYPHS = 'アカサタナハマヤラワ0123456789ABCDEF<>/\\|=+*^-;:[]{}$#@%&'
const GLYPH = 16
/* big-text palette — same values as the CSS vars (overlay text is styled
   in JS so it can change per state; keep in sync with styles.css). Each
   scanner uses its tool tile's accent colour. */
const C_GREEN = 'rgb(61, 255, 158)'
const C_MAGENTA = 'rgb(255, 46, 196)'   // scan tile (nmap)
const C_CYAN = 'rgb(0, 245, 255)'       // SCAN COMPLETE
const C_VIOLET = 'rgb(163, 94, 255)'    // wifi tile
const C_RED = 'rgb(255, 59, 92)'        // bt tile

function makeOverlay(): HTMLDivElement {
  const o = document.createElement('div')
  o.className = 'overlay'
  o.id = 'overlay'
  o.setAttribute('aria-hidden', 'true')
  const cv = document.createElement('canvas')
  o.appendChild(cv)
  const s = document.createElement('div')
  s.className = 'standby'
  const b = document.createElement('div')
  b.className = 's1'
  b.textContent = 'STANDBY'
  const s2 = document.createElement('div')
  s2.className = 's2'
  s2.textContent = 'PRESS ANY KEY'
  s.appendChild(b); s.appendChild(s2)
  o.appendChild(s)
  const d = document.createElement('div')
  d.className = 'dim'
  d.textContent = 'ULAUNCH_'
  o.appendChild(d)
  document.body.appendChild(o)
  return o
}

function sizeCanvas() {
  if (!canvas || !ctx) return
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  canvas.width = Math.floor(window.innerWidth * dpr)
  canvas.height = Math.floor(window.innerHeight * dpr)
  canvas.style.width = window.innerWidth + 'px'
  canvas.style.height = window.innerHeight + 'px'
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  const n = Math.ceil(window.innerWidth / GLYPH)
  if (cols.length !== n) {
    cols = new Array(n).fill(0).map(() => Math.floor(Math.random() * -40))
    colSpeeds = new Array(n).fill(0).map(() => 0.4 + Math.random() * 1.2)
  }
}

function draw(t: number) {
  raf = 0
  if (!visible || dimmed) return
  if (t - lastFrame < 33) { raf = requestAnimationFrame(draw); return }  // ~30fps cap
  lastFrame = t
  if (!ctx || !canvas) return
  const w = window.innerWidth, h = window.innerHeight
  // fade previous frame
  ctx.fillStyle = 'rgba(0, 0, 0, 0.12)'
  ctx.fillRect(0, 0, w, h)
  ctx.font = `${GLYPH}px monospace`
  const n = cols.length
  for (let i = 0; i < n; i++) {
    const y = cols[i] * GLYPH
    const ch = GLYPHS[Math.floor(Math.random() * GLYPHS.length)]
    // head glyph bright, tail green
    ctx.fillStyle = '#eaffea'
    ctx.fillText(ch, i * GLYPH, y)
    ctx.fillStyle = 'rgba(61, 255, 158, 0.75)'
    const ch2 = GLYPHS[Math.floor(Math.random() * GLYPHS.length)]
    ctx.fillText(ch2, i * GLYPH, y - GLYPH)
    cols[i] += colSpeeds[i]
    if (y > h && Math.random() > 0.975) {
      cols[i] = Math.floor(Math.random() * -20)
      colSpeeds[i] = 0.4 + Math.random() * 1.2
    }
  }
  raf = requestAnimationFrame(draw)
}

/* Big-text state: a running scanner wins, each in its tool tile's colour.
   Fixed priority (nmap first — preserves M30's SCANNING, then the wireless
   scanners): the overlay only knows each scanner's running flag (kept
   lightweight), so it can't pick "most recently started" — a stable order
   means a live nmap job always shows, and once it ends the still-running
   wifi/bt session surfaces. Then a fresh nmap completion (SCAN COMPLETE,
   neon blue, 30s); then STANDBY green. */
function paintStatus() {
  if (!big || !sub) return
  sub.textContent = 'PRESS ANY KEY'
  if (scanRunning) {
    big.textContent = 'SCANNING'
    big.style.color = C_MAGENTA
  } else if (wifiScanning) {
    big.textContent = 'WIFI SCANNING'
    big.style.color = C_VIOLET
  } else if (btScanning) {
    big.textContent = 'BT SCANNING'
    big.style.color = C_RED
  } else if (Date.now() < completeUntil) {
    big.textContent = 'SCAN COMPLETE'
    big.style.color = C_CYAN
  } else {
    big.textContent = 'STANDBY'
    big.style.color = C_GREEN
  }
}

function show() {
  if (visible) return
  visible = true
  dimmed = false
  overlay?.classList.add('on')
  sizeCanvas()
  if (ctx) {
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, window.innerWidth, window.innerHeight)
  }
  paintStatus()
  raf = requestAnimationFrame(draw)
}

/* Phase 2: stop the rAF loop entirely — a static black screen with a
   faint "ULAUNCH_" is all the battery needs. The SCAN COMPLETE flash is
   still honoured here, for 30s from dim time. */
function dimNow() {
  if (!visible || dimmed) return
  dimmed = true
  overlay?.classList.add('dim')
  if (raf) { cancelAnimationFrame(raf); raf = 0 }
  paintStatus()
}

export function hide(): void {
  if (!visible) return
  visible = false
  dimmed = false
  overlay?.classList.remove('on', 'dim')
  if (raf) { cancelAnimationFrame(raf); raf = 0 }
}

export function isOn(): boolean {
  return visible
}

export function wake(): void {
  lastActivity = Date.now()
  hide()
}

export function setIdleTimeout(s: number): void {
  timeoutS = Math.max(10, Math.min(3600, s))
  /* if we're idle longer than the new timeout, kick in immediately */
  if (Date.now() - lastActivity > timeoutS * 1000) show()
}

export function setIdleDimTimeout(s: number): void {
  dimS = Math.max(10, Math.min(3600, s))
  /* already past the dim point? dim right now */
  if (visible && !dimmed && Date.now() - lastActivity > (timeoutS + dimS) * 1000) dimNow()
}

/* One lightweight poll covering all three scanners (flags + finish time,
   never the cell/device/job bodies — heavy while a scan is live). A nmap
   job finished within the last 30s shows SCAN COMPLETE; a live scanner
   shows its SCANNING state. */
function pollScan() {
  if (document.hidden) return
  fetch('/api/overlay/status', { cache: 'no-store' })
    .then(r => r.ok ? r.json() : null)
    .then((st: { scan: { running: boolean; last_finished: number };
                 wifi: { scanning: boolean };
                 ble: { scanning: boolean } } | null) => {
      if (!st) return
      const now = Date.now() / 1000
      const running = st.scan.running
      const fresh = !running && st.scan.last_finished > 0 && (now - st.scan.last_finished) < COMPLETE_S
      if (!running && fresh) completeUntil = st.scan.last_finished * 1000 + COMPLETE_S * 1000
      scanRunning = running
      wifiScanning = st.wifi.scanning
      btScanning = st.ble.scanning
      if (visible) paintStatus()
    })
    .catch(() => {})
}

function onActivity(e: Event): void {
  if (visible) {
    /* swallow the waking input COMPLETELY: preventDefault stops the
       browser's native action, stopPropagation keeps it from reaching
       the app's keydown handler (the app would otherwise act on the very
       key that dismissed the screensaver). */
    if (e instanceof KeyboardEvent || e instanceof MouseEvent || e instanceof TouchEvent) {
      e.preventDefault()
      e.stopPropagation()
    }
    wake()
    return
  }
  lastActivity = Date.now()
}

export function initOverlay(initialS: number = DEFAULT_TIMEOUT_S,
                            initialDimS: number = DEFAULT_DIM_S): void {
  if (overlay) return
  timeoutS = Math.max(10, Math.min(3600, initialS))
  dimS = Math.max(10, Math.min(3600, initialDimS))
  /* on-device debugging hook */
  ;(window as any).__ulaunchOverlay = () => ({
    visible, dimmed, timeoutS, dimS, scanRunning, wifiScanning, btScanning,
    completeInS: Math.max(0, Math.round((completeUntil - Date.now()) / 1000)),
    idleS: Math.round((Date.now() - lastActivity) / 1000),
    hidden: document.hidden, cols: cols.length,
    bigText: big?.textContent, bigColor: big?.style.color,
  })
  ;(window as any).__ulaunchOverlay_setTimeout = (s: number) => setIdleTimeout(s)
  ;(window as any).__ulaunchOverlay_setDimTimeout = (s: number) => setIdleDimTimeout(s)
  ;(window as any).__ulaunchOverlay_show = () => show()
  ;(window as any).__ulaunchOverlay_setScan = (st: { running: boolean; last_finished: number }) => {
    const now = Date.now() / 1000
    const fresh = !st.running && st.last_finished > 0 && (now - st.last_finished) < COMPLETE_S
    if (!st.running && fresh) completeUntil = st.last_finished * 1000 + COMPLETE_S * 1000
    scanRunning = st.running
    if (visible) paintStatus()
  }
  /* control all three scanner states at once (harness): running flags for
     the wireless scanners + the nmap job (running/last_finished). */
  ;(window as any).__ulaunchOverlay_setScanStates = (st: {
    scan?: { running: boolean; last_finished: number }
    wifi?: { scanning: boolean }
    ble?: { scanning: boolean }
  }) => {
    if (st.scan) {
      const now = Date.now() / 1000
      const fresh = !st.scan.running && st.scan.last_finished > 0 && (now - st.scan.last_finished) < COMPLETE_S
      if (!st.scan.running && fresh) completeUntil = st.scan.last_finished * 1000 + COMPLETE_S * 1000
      scanRunning = st.scan.running
    }
    if (st.wifi) wifiScanning = st.wifi.scanning
    if (st.ble) btScanning = st.ble.scanning
    if (visible) paintStatus()
  }
  overlay = makeOverlay()
  canvas = overlay.querySelector('canvas')!
  ctx = canvas.getContext('2d')
  big = overlay.querySelector('.standby .s1')
  sub = overlay.querySelector('.standby .s2')
  sizeCanvas()
  window.addEventListener('resize', () => { if (visible && !dimmed) sizeCanvas() })
  window.addEventListener('keydown', onActivity, true)
  window.addEventListener('mousedown', onActivity, true)
  window.addEventListener('touchstart', onActivity, true)
  window.addEventListener('mousemove', onActivity, { passive: true })
  setInterval(() => {
    if (visible) {
      /* phase 2: matrix off after idleDimS more idle */
      if (!dimmed && Date.now() - lastActivity > (timeoutS + dimS) * 1000) dimNow()
      /* SCAN COMPLETE can expire while the dim phase is showing */
      else if (dimmed && completeUntil && Date.now() >= completeUntil) paintStatus()
    } else if (!document.hidden && Date.now() - lastActivity > timeoutS * 1000) {
      show()
    }
  }, 1000)
  pollScan()
  setInterval(pollScan, SCAN_POLL_MS)
}
