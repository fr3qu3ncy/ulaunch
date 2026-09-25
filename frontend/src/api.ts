export interface Ipv4 {
  addr: string
  prefix: number
  subnet: string
}

export interface NetInfo {
  hostname: string
  uptime_s: number
  battery: { percent: number; charging: boolean } | null
  vpn: {
    active: boolean
    interfaces: string[]
    processes: string[]
  }
  interfaces: {
    name: string
    type: 'eth' | 'wifi' | 'vpn' | 'virtual' | string
    up: boolean
    state: string
    ipv4: Ipv4 | null
    ipv6_count: number
    ssid: string | null
    signal: number | null
  }[]
}

async function getJSON<T>(path: string): Promise<T> {
  const r = await fetch(path, { cache: 'no-store' })
  if (!r.ok) throw new Error(`${path} -> ${r.status}`)
  return (await r.json()) as T
}

export function fetchNet(): Promise<NetInfo> {
  return getJSON<NetInfo>('/api/net')
}

export type ExitAction = 'desktop' | 'hide' | 'exit'

export async function exitApp(action: ExitAction): Promise<void> {
  await fetch('/api/exit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  }).catch(() => {
    /* server may already be gone */
  })
}

export function fmtUptime(s: number): string {
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}
