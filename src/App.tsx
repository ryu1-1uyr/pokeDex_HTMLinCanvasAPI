import { useCallback, useEffect, useRef, useState } from 'react'
import { Renderer, supportsHtmlInCanvas } from './gpu/Renderer'
import { Dex } from './ui/Dex'

const drawable = supportsHtmlInCanvas()
const hasWebGPU = typeof navigator !== 'undefined' && 'gpu' in navigator

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const uiRef = useRef<HTMLDivElement>(null)
  const [gpuError, setGpuError] = useState<string | null>(null)
  // HTML-in-Canvas: the canvas hosts the screen panels (see ui/Screen.tsx).
  const [canvasEl, setCanvasEl] = useState<HTMLCanvasElement | null>(null)
  const [panelsOn, setPanelsOn] = useState(true)
  const canvasCallback = useCallback((el: HTMLCanvasElement | null) => {
    canvasRef.current = el
    setCanvasEl(el)
  }, [])

  useEffect(() => {
    if (!hasWebGPU) return
    let renderer: Renderer | undefined
    let disposed = false
    Renderer.create(canvasRef.current!, uiRef.current!, drawable, {
      // If this browser can't capture the panels, render the screens in place instead.
      onPanelsFailed: () => setPanelsOn(false),
    })
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
      <Dex mode={mode} panelHost={drawable && panelsOn ? canvasEl : null} />
      <footer className="credits">
        UNOFFICIAL FAN PROJECT · DATA{' '}
        <a href="https://pokeapi.co/" target="_blank" rel="noreferrer">
          PokéAPI
        </a>{' '}
        · Pokémon and Pokémon character names are trademarks of Nintendo. Images and cries © The Pokémon Company.
      </footer>
    </div>
  )

  // With HTML-in-Canvas the UI lives inside the canvas and reaches the screen only
  // through the shader. Otherwise the DOM is layered on top of the WebGPU canvas.
  return drawable ? (
    <canvas ref={canvasCallback} className="stage" content="drawable" layoutsubtree="">
      {ui}
    </canvas>
  ) : (
    <>
      <canvas ref={canvasCallback} className="stage" />
      {ui}
    </>
  )
}
