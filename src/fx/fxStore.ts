// Mutable bridge between React (writes) and the WebGPU renderer (reads every frame).
// Kept outside React state on purpose: the renderer polls it at 60fps.

export const REGION_KIND = {
  screen: 1,
  radar: 2,
  holo: 3,
  button: 4,
  lens: 5,
  led: 6,
  device: 7,
} as const

export type RegionKind = keyof typeof REGION_KIND

export interface Region {
  el: HTMLElement
  kind: RegionKind
  radius: number
  /** Palette index for buttons / LEDs (see shader `palette`). */
  color: number
}

export const MAX_REGIONS = 32

export const fx = {
  regions: new Set<Region>(),
  /** Normalized base stats: hp, atk, def, spa, spd, spe. */
  stats: [0, 0, 0, 0, 0, 0],
  accent: [0.9, 0.2, 0.2] as [number, number, number],
  accent2: [0.2, 0.5, 0.9] as [number, number, number],
  /** Loudness envelope (0..1) of the cry currently playing. */
  voice: 0,
}
