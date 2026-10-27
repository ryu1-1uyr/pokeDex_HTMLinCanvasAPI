import { useEffect, useRef, useState } from 'react'
import { Renderer, supportsHtmlInCanvas } from './gpu/Renderer'
import { Dex } from './ui/Dex'

const drawable = supportsHtmlInCanvas()
const hasWebGPU = typeof navigator !== 'undefined' && 'gpu' in navigator

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const uiRef = useRef<HTMLDivElement>(null)
  const [gpuError, setGpuError] = useState<string | null>(null)

  useEffect(() => {
    if (!hasWebGPU) return
    let renderer: Renderer | undefined
    let disposed = false
    Renderer.create(canvasRef.current!, uiRef.current!, drawable)
      .then((r) => (disposed ? r.dispose() : (renderer = r)))
      .catch((e) => setGpuError(String(e)))
    return () => {
      disposed = true
      renderer?.dispose()
    }
  }, [])

  const gpu = hasWebGPU && !gpuError
  const mode = !gpu ? 'NO WEBGPU' : drawable ? 'HTML-IN-CANVAS' : 'DOM OVERLAY'

  const ui = (
    <div ref={uiRef} className={'dex' + (gpu ? '' : ' no-gpu')} drawable="">
      <Dex mode={mode} />
    </div>
  )

  // With HTML-in-Canvas the UI lives inside the canvas and reaches the screen only
  // through the shader. Otherwise the DOM is layered on top of the WebGPU canvas.
  return drawable ? (
    <canvas ref={canvasRef} className="stage" content="drawable" layoutsubtree="">
      {ui}
    </canvas>
  ) : (
    <>
      <canvas ref={canvasRef} className="stage" />
      {ui}
    </>
  )
}
