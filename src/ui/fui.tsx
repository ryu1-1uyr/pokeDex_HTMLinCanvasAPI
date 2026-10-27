import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { pad, useTicker } from './fuiUtils'

// Small "fictional UI" building blocks: corner micro text, live readouts and
// callout lines anchored to features found in the artwork.

/** Numbered panel heading, e.g. `01 // PROFILE`, so each screen reads at a glance. */
export function PanelHeader({ index, title, aside }: { index: string; title: string; aside?: ReactNode }) {
  return (
    <div className="panel-head">
      <b>{index}</b>
      <span>{title}</span>
      <i />
      {aside && <span className="panel-aside">{aside}</span>}
    </div>
  )
}

export function MicroText({ at, children }: { at: 'tl' | 'tr' | 'bl' | 'br'; children: ReactNode }) {
  return <span className={`micro ${at}`}>{children}</span>
}

/** Text that is rebuilt every tick; `render` receives seconds since mount. */
export function LiveReadout({
  at,
  hz = 10,
  render,
}: {
  at: 'tl' | 'tr' | 'bl' | 'br'
  hz?: number
  render: (t: number) => ReactNode
}) {
  const t = useTicker(hz)
  return <MicroText at={at}>{render(t)}</MicroText>
}

/** Pointer coordinates, updated at most once per frame. */
export function PointerReadout() {
  const [p, setP] = useState({ x: 0, y: 0 })
  useEffect(() => {
    let raf = 0
    const onMove = (e: PointerEvent) => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => setP({ x: e.clientX, y: e.clientY }))
    }
    window.addEventListener('pointermove', onMove, { passive: true })
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('pointermove', onMove)
    }
  }, [])
  return (
    <span className="hud">
      PTR {pad(p.x, 4)}·{pad(p.y, 4)}
    </span>
  )
}

const GLYPHS = 'アイウエオカキクケコサシスセソタチツテトナニヌネノ0123456789ABCDEFXYZ#%&*+=<>/'

/**
 * Text that "decodes": a revealed prefix followed by a short run of random glyphs,
 * sweeping left to right whenever `text` changes.
 */
export function Decode({ text, duration = 450 }: { text: string; duration?: number }) {
  const [shown, setShown] = useState(text)
  useEffect(() => {
    const start = performance.now()
    let raf = 0
    const tick = () => {
      const p = Math.min(1, (performance.now() - start) / duration)
      const n = Math.floor(p * text.length)
      const noise = Array.from({ length: Math.min(6, text.length - n) }, () => GLYPHS[(Math.random() * GLYPHS.length) | 0])
      setShown(text.slice(0, n) + noise.join(''))
      if (p < 1) raf = requestAnimationFrame(tick)
    }
    tick()
    return () => cancelAnimationFrame(raf)
  }, [text, duration])
  return <>{shown}</>
}

// ---------------------------------------------------------------- callouts

interface Anchors {
  apex: [number, number]
  core: [number, number]
  edge: [number, number]
  /** Bounding box of opaque pixels: x0, y0, x1, y1 (normalized). */
  box: [number, number, number, number]
}

const GRID = 64

/** Finds the top-most pixel, the centroid and the right-most pixel of the artwork. */
async function findAnchors(src: string): Promise<Anchors | null> {
  const img = new Image()
  img.crossOrigin = 'anonymous'
  img.src = src
  await img.decode()
  const canvas = new OffscreenCanvas(GRID, GRID)
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(img, 0, 0, GRID, GRID)
  const { data } = ctx.getImageData(0, 0, GRID, GRID)

  let apex: [number, number] | null = null
  let edge: [number, number] = [0, 0]
  let x0 = GRID
  let x1 = 0
  let y1 = 0
  let sx = 0
  let sy = 0
  let n = 0
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      if (data[(y * GRID + x) * 4 + 3] < 128) continue
      apex ??= [x, y]
      if (x > edge[0]) edge = [x, y]
      x0 = Math.min(x0, x)
      x1 = Math.max(x1, x)
      y1 = y
      sx += x
      sy += y
      n++
    }
  }
  if (!apex || n === 0) return null
  const norm = ([x, y]: [number, number]): [number, number] => [(x + 0.5) / GRID, (y + 0.5) / GRID]
  return {
    apex: norm(apex),
    core: norm([sx / n, sy / n]),
    edge: norm(edge),
    box: [x0 / GRID, apex[1] / GRID, (x1 + 1) / GRID, (y1 + 1) / GRID],
  }
}

// The holo card is 3:4 and the artwork is a centered square 92% of its width (see CSS).
const VB_W = 300
const VB_H = 400
const ART = VB_W * 0.92
const ART_X = (VB_W - ART) / 2
const ART_Y = (VB_H - ART) / 2
/** Callouts start once the lock-on reticle has settled (s); see .lock in dex.css. */
const LOCK_TIME = 0.55
const toCard = ([u, v]: [number, number]) => [ART_X + u * ART, ART_Y + v * ART] as const

export function Callouts({
  src,
  target,
  labels,
}: {
  src: string
  target: string
  labels: { apex: string; core: string; edge: string }
}) {
  const [anchors, setAnchors] = useState<{ src: string; a: Anchors } | null>(null)

  useEffect(() => {
    let cancelled = false
    findAnchors(src)
      .then((a) => !cancelled && a && setAnchors({ src, a }))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [src])

  if (!anchors || anchors.src !== src) return null
  const { apex, core, edge, box } = anchors.a
  const [bx0, by0] = toCard([box[0], box[1]])
  const [bx1, by1] = toCard([box[2], box[3]])
  const arm = 16
  // Corner brackets of the lock-on reticle, snapped to the artwork's bounding box.
  const corners = [
    `M${bx0},${by0 + arm} L${bx0},${by0} L${bx0 + arm},${by0}`,
    `M${bx1 - arm},${by0} L${bx1},${by0} L${bx1},${by0 + arm}`,
    `M${bx0},${by1 - arm} L${bx0},${by1} L${bx0 + arm},${by1}`,
    `M${bx1 - arm},${by1} L${bx1},${by1} L${bx1},${by1 - arm}`,
  ]

  // Each callout: anchor dot -> diagonal -> horizontal run -> label.
  const lines = [
    { key: 'apex', p: toCard(apex), label: labels.apex, end: [VB_W - 14, 34] as const, align: 'end' as const },
    { key: 'core', p: toCard(core), label: labels.core, end: [14, VB_H - 30] as const, align: 'start' as const },
    { key: 'edge', p: toCard(edge), label: labels.edge, end: [VB_W - 14, VB_H - 64] as const, align: 'end' as const },
  ]

  return (
    <svg className="callouts" viewBox={`0 0 ${VB_W} ${VB_H}`} key={src}>
      <g className="lock">
        {corners.map((d) => (
          <path key={d} d={d} className="lock-bracket" />
        ))}
      </g>
      <text x={bx0} y={by0 - 8} className="lock-text">
        TARGET LOCKED // {target}
      </text>
      {lines.map(({ key, p, label, end, align }, i) => {
        const [x0, y0] = p
        const [x2, y2] = end
        // Elbow: go diagonally until level with the label, then run horizontally.
        const dy = y2 - y0
        const x1 = x2 > x0 ? Math.min(x2 - 40, x0 + Math.abs(dy)) : Math.max(x2 + 40, x0 - Math.abs(dy))
        const d = `M${x0},${y0} L${x1},${y2} L${x2},${y2}`
        return (
          <g key={key} style={{ '--d': `${LOCK_TIME + 0.15 * i}s` } as CSSProperties} className="callout">
            <circle cx={x0} cy={y0} r={5} className="callout-ring" />
            <circle cx={x0} cy={y0} r={1.6} className="callout-dot" />
            <path d={d} pathLength={1} className="callout-line" />
            <text x={x2} y={y2 - 6} textAnchor={align} className="callout-text">
              {label}
            </text>
          </g>
        )
      })}
    </svg>
  )
}
