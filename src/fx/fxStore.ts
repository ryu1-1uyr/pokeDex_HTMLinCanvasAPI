// Mutable bridge between React (writes) and the WebGPU renderer (reads every frame).
// Kept outside React state on purpose: the renderer polls it at 60fps.

export const REGION_KIND = {
  screen: 1,
  radar: 2,
  holo: 3,
  button: 4,
  lens: 5,
  led: 6,
} as const

export type RegionKind = keyof typeof REGION_KIND

export interface Region {
  el: HTMLElement
  kind: RegionKind
  radius: number
  /** Palette index for buttons / LEDs (see shader `palette`). */
  color: number
}

export interface Splat {
  /** Position in CSS px. */
  x: number
  y: number
  /** Velocity in CSS px / s. */
  vx: number
  vy: number
  color: [number, number, number]
  radius: number
}

export const MAX_REGIONS = 32
export const MAX_SPLATS = 8

export const fx = {
  regions: new Set<Region>(),
  /** Normalized base stats: hp, atk, def, spa, spd, spe. */
  stats: [0, 0, 0, 0, 0, 0],
  accent: [0.9, 0.2, 0.2] as [number, number, number],
  accent2: [0.2, 0.5, 0.9] as [number, number, number],
  splats: [] as Splat[],

  burst(x: number, y: number, colors: [number, number, number][]) {
    const n = 7
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.4
      const speed = 900 + Math.random() * 500
      fx.splats.push({
        x: x + Math.cos(a) * 30,
        y: y + Math.sin(a) * 30,
        vx: Math.cos(a) * speed,
        vy: Math.sin(a) * speed,
        color: colors[i % colors.length],
        radius: 0.0025,
      })
    }
  },
}
