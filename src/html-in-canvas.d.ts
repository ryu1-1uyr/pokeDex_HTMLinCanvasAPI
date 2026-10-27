// Type declarations for the experimental HTML-in-Canvas API (WICG/html-in-canvas).
// Chrome Canary: enable chrome://flags/#canvas-draw-element

import 'react'

declare module 'react' {
  interface HTMLAttributes<T> {
    drawable?: '' | boolean
  }
  interface CanvasHTMLAttributes<T> {
    content?: 'drawable' | 'fallback'
    layoutsubtree?: ''
  }
}

declare global {
  interface UpdateElementGeometryOptions {
    preserveHitTestOrder?: boolean
    canvasClip?: DOMRectInit
    canvasTransform?: DOMMatrixInit
  }

  interface HTMLCanvasElement {
    requestPaint?(): void
    updateElementGeometry?(element: Element, options?: UpdateElementGeometryOptions): void
  }

  interface GPUDrawElementImageSource {
    source: Element
    sourceX?: number
    sourceY?: number
    sourceWidth?: number
    sourceHeight?: number
  }

  interface GPUDrawElementImageDestination {
    texture: GPUTexture
    size?: GPUExtent3DStrict
  }

  interface GPUQueue {
    drawElementImageToTexture?(src: GPUDrawElementImageSource, dst: GPUDrawElementImageDestination): void
    /** Legacy name used by earlier Canary builds. */
    copyElementImageToTexture?(...args: unknown[]): void
  }
}
