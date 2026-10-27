import { useCallback, useRef } from 'react'
import { fx, type Region, type RegionKind } from './fxStore'

/**
 * Registers a DOM element as a shader region. The renderer reads its
 * bounding rect every frame and applies the material for `kind`.
 */
export function useRegion<T extends HTMLElement>(kind: RegionKind, radius = 12, color = 0) {
  const entry = useRef<Region | null>(null)

  return useCallback(
    (el: T | null) => {
      if (entry.current) fx.regions.delete(entry.current)
      entry.current = null
      if (el) {
        entry.current = { el, kind, radius, color }
        fx.regions.add(entry.current)
      }
    },
    [kind, radius, color],
  )
}
