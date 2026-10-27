import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * A device screen. Rendered in place, except in HTML-in-Canvas mode with a `host`
 * (the canvas): then only an empty slot stays in the layout and the content is
 * portaled to be an immediate child of the canvas. The WebGPU entry point can only
 * snapshot direct canvas children, and a separate snapshot lets the panel float on
 * its own (see gpu/Panels.ts).
 *
 * `sizing` decides who owns the size: 'slot' panels take the slot's layout size,
 * 'content' panels keep their natural height and the slot follows it.
 */
export function Screen({
  id,
  className,
  regionRef,
  host,
  sizing,
  children,
}: {
  id: string
  className: string
  regionRef: (el: HTMLDivElement | null) => void
  host: HTMLElement | null
  sizing: 'slot' | 'content'
  children: ReactNode
}) {
  const slotEl = useRef<HTMLDivElement | null>(null)
  const panelEl = useRef<HTMLDivElement | null>(null)
  const [slotSize, setSlotSize] = useState<{ w: number; h: number } | null>(null)
  const [contentHeight, setContentHeight] = useState<number | null>(null)

  // Stable ref: a new callback each render would re-register the region and reorder screens.
  const slotRef = useCallback(
    (el: HTMLDivElement | null) => {
      slotEl.current = el
      regionRef(el)
    },
    [regionRef],
  )

  useLayoutEffect(() => {
    const slot = slotEl.current
    const panel = panelEl.current
    if (!host || !slot || !panel) return
    const observer = new ResizeObserver(() => {
      setSlotSize({ w: slot.offsetWidth, h: slot.offsetHeight })
      if (sizing === 'content') setContentHeight(panel.offsetHeight)
    })
    observer.observe(slot)
    observer.observe(panel)
    return () => observer.disconnect()
  }, [host, sizing])

  if (!host) {
    return (
      <div ref={regionRef} className={className}>
        {children}
      </div>
    )
  }

  return (
    <>
      <div
        ref={slotRef}
        className={`${className} screen-slot`}
        data-panel-id={id}
        style={sizing === 'content' && contentHeight != null ? { height: contentHeight } : undefined}
      />
      {createPortal(
        <div
          ref={panelEl}
          drawable=""
          className={`${className} dex-panel`}
          data-panel-for={id}
          style={{ width: slotSize?.w, height: sizing === 'slot' ? slotSize?.h : undefined }}
        >
          {children}
        </div>,
        host,
      )}
    </>
  )
}
