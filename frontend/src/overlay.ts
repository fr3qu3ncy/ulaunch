/** Idle overlay. Created once on <body> so it survives app re-renders.
 *  Phase 1 (idle): matrix rain, ~30fps, animated STANDBY text — battery
 *  hungry on purpose, only while the user is actually around.
 *  Phase 2 (dim, after idleDimS more idle): static black + faint
 *  "ULAUNCH_" + a one-shot "SCAN COMPLETE" flash in neon blue for 30s
 *  when a scan finished just before. No rAF, no CSS animation — near-zero
 *  CPU.
 *  Scan state (light /api/scan/status poll, 5s) drives the big text:
 *  running → SCANNING in the scan tile's magenta; done → SCAN COMPLETE
 *  neon blue for 30s; else STANDBY green. Same text in both phases.
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
let completeUntil = 0
let cols: number[] = []       // per-column row position (in glyph units)
let colSpeeds: number[] = []
let lastFrame = 0

const GLYPHS = 'アカサタナハマヤラワ0123456789ABCDEF<>/\\|=+*^-;:[]{}$#@%&'
const GLYPH = 16
/* big-text palette — same values as the CSS vars (overlay text is styled
   in JS so it can change per state; keep in sync with styles.css) */
const C_GREEN = 'rgb(61, 255, 158)'
const C_MAGENTA = 'rgb(255, 46, 196)'
const C_CYAN = 'rgb(0, 245, 255)'

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

/* Big-text state: running scan wins (SCANNING, scan-tile magenta), then a
   fresh completion (SCAN COMPLETE, neon blue, 30s), then STANDBY green. */
function paintStatus() {
  if (!big || !sub) return
  sub.textContent = 'PRESS ANY KEY'
  if (scanRunning) {
    big.textContent = 'SCANNING'
    big.style.color = C_MAGENTA
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

/* Lightweight scan state — no job bodies (that would be heavy on a
   running deep scan). A job that finished within the last 30s shows
   SCAN COMPLETE; a live job shows SCANNING. */
function pollScan() {
  if (document.hidden) return
  fetch('/api/scan/status', { cache: 'no-store' })
    .then(r => r.ok ? r.json() : null)
    .then((st: { running: boolean; last_finished: number } | null) => {
      if (!st) return
      const now = Date.now() / 1000
      const running = st.running
      const fresh = !running && st.last_finished > 0 && (now - st.last_finished) < COMPLETE_S
      if (!running && fresh) completeUntil = st.last_finished * 1000 + COMPLETE_S * 1000
      scanRunning = running
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
    visible, dimmed, timeoutS, dimS, scanRunning,
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
