import panelsWGSL from './shaders/panels.wgsl?raw'

type Mat3 = [number, number, number, number, number, number, number, number, number]
type Rect = [x: number, y: number, w: number, h: number]

const MAX_PANELS = 3
const FORMAT: GPUTextureFormat = 'rgba8unorm'
/** How far a focused panel floats toward the viewer (CSS px). */
const LIFT = 28
const UNIFORM_FLOATS = 4 + MAX_PANELS * 20

export interface PanelPair {
  /** Empty placeholder in the UI layout; gives the panel its position (and shader region). */
  slot: HTMLElement
  /** Portaled content, an immediate child of the canvas; snapshotted and hit-tested. */
  panel: HTMLElement
}

interface PanelState extends PanelPair {
  tex: GPUTexture | null
  lift: number
  geometry: string
}

export interface PanelsDeps {
  /** Copies an element's snapshot into a texture (HTML-in-Canvas). */
  copyElement: (el: Element, tex: GPUTexture) => void
  layoutRect: (el: HTMLElement) => Rect
  planeHomography: (m: DOMMatrix) => Mat3
  invert3: (m: Mat3) => Mat3
}

function mul3(a: Mat3, b: Mat3): Mat3 {
  const r = new Array(9).fill(0) as Mat3
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j]
  return r
}

/**
 * HTML-in-Canvas only. Each screen is a nested `drawable`, so the browser snapshots it
 * separately from the root. A focused panel floats toward the viewer: its hit-testing
 * geometry gets the lifted 3D transform, and the compose pass draws it with the exact
 * matching homography, then layers the root snapshot on top. The output replaces the
 * plain DOM texture for every later effect (glow, afterglow, reflections).
 */
export class Panels {
  private device: GPUDevice
  private canvas: HTMLCanvasElement
  private deps: PanelsDeps
  private pipeline: GPURenderPipeline
  private sampler: GPUSampler
  private uniform: GPUBuffer
  private data = new Float32Array(UNIFORM_FLOATS)
  private placeholder: GPUTexture
  private panels: PanelState[] = []
  private bindGroup: GPUBindGroup | null = null
  private rootTex: GPUTexture | null = null
  output!: GPUTexture

  constructor(device: GPUDevice, canvas: HTMLCanvasElement, deps: PanelsDeps) {
    this.device = device
    this.canvas = canvas
    this.deps = deps
    const module = device.createShaderModule({ label: 'panels', code: panelsWGSL })
    this.pipeline = device.createRenderPipeline({
      label: 'panels',
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: FORMAT }] },
      primitive: { topology: 'triangle-list' },
    })
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' })
    this.uniform = device.createBuffer({ size: UNIFORM_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    this.placeholder = this.texture(1, 1, 'panel-placeholder')
    this.resize(1, 1)
  }

  private texture(w: number, h: number, label: string) {
    return this.device.createTexture({
      label,
      size: [Math.max(1, w), Math.max(1, h)],
      format: FORMAT,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    })
  }

  resize(w: number, h: number) {
    this.output?.destroy()
    this.output = this.texture(w, h, 'panels-composed')
    this.bindGroup = null
  }

  /** Panels in the same order as the shader's screen regions. */
  /** Returns true when the set changed (the caller should request a paint). */
  setElements(pairs: PanelPair[]) {
    const next = pairs.slice(0, MAX_PANELS)
    const same =
      next.length === this.panels.length &&
      next.every((p, i) => p.slot === this.panels[i].slot && p.panel === this.panels[i].panel)
    if (same) return false
    this.panels.forEach((p) => p.tex?.destroy())
    this.panels = next.map((p) => ({ ...p, tex: null, lift: 0, geometry: '' }))
    this.bindGroup = null
    return true
  }

  /** Called from the canvas `paint` event: snapshot every panel into its texture. */
  paint(dpr: number) {
    for (const p of this.panels) {
      // Prefer the browser's own snapshot size; otherwise assume CSS size x devicePixelRatio.
      const native = this.canvas.getElementImageDefaultSize?.(p.panel)
      const [, , w, h] = this.deps.layoutRect(p.panel)
      const tw = Math.max(1, Math.round(native?.width ?? w * dpr))
      const th = Math.max(1, Math.round(native?.height ?? h * dpr))
      if (!p.tex || p.tex.width !== tw || p.tex.height !== th) {
        p.tex?.destroy()
        p.tex = this.texture(tw, th, 'panel')
        this.bindGroup = null
      }
      this.deps.copyElement(p.panel, p.tex)
      p.geometry = '' // a new snapshot needs its geometry re-applied
    }
  }

  /**
   * Eases each panel's lift toward hover/focus and syncs hit-testing geometry.
   * `rootMoved` re-applies all panels so they stay above the root in hit-test order.
   */
  update(dt: number, tilt: DOMMatrix, res: [number, number], dpr: number, rootMoved: boolean) {
    const k = 1 - Math.exp(-dt * 10)
    for (const p of this.panels) {
      const target = p.panel.matches(':hover') || p.panel.matches(':focus-within') ? 1 : 0
      p.lift += (target - p.lift) * k
      if (Math.abs(target - p.lift) < 0.002) p.lift = target
    }
    const maxLift = Math.max(0, ...this.panels.map((p) => p.lift))

    const d = this.data
    d.fill(0)
    d.set([res[0], res[1], dpr, this.panels.length], 0)
    const flatToScreen = this.deps.planeHomography(tilt)
    const forceGeometry = rootMoved
    this.panels.forEach((p, i) => {
      const rect = this.deps.layoutRect(p.slot)
      const lifted = tilt.translate(0, 0, LIFT * p.lift)
      const toPanel = mul3(this.deps.invert3(this.deps.planeHomography(lifted)), flatToScreen)
      const o = 4 + i * 20
      d.set(rect, o)
      for (let row = 0; row < 3; row++) d.set([...toPanel.slice(row * 3, row * 3 + 3), 0], o + 4 + row * 4)
      d.set([p.lift, maxLift - p.lift, 0, 0], o + 16)

      // Hit-testing: element-local border box -> lifted plane -> canvas.
      const geometry = lifted.translate(rect[0], rect[1])
      const key = geometry.toString()
      if (forceGeometry || key !== p.geometry) {
        p.geometry = key
        this.canvas.updateElementGeometry?.(p.panel, { canvasTransform: geometry })
      }
    })
    this.device.queue.writeBuffer(this.uniform, 0, d)
  }

  encode(encoder: GPUCommandEncoder, rootTex: GPUTexture) {
    if (rootTex !== this.rootTex) {
      this.rootTex = rootTex
      this.bindGroup = null
    }
    this.bindGroup ??= this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniform } },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: rootTex.createView() },
        ...[0, 1, 2].map((i) => ({
          binding: 3 + i,
          resource: (this.panels[i]?.tex ?? this.placeholder).createView(),
        })),
      ],
    })
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        { view: this.output.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } },
      ],
    })
    pass.setPipeline(this.pipeline)
    pass.setBindGroup(0, this.bindGroup)
    pass.draw(3)
    pass.end()
  }

  destroy() {
    this.panels.forEach((p) => p.tex?.destroy())
    this.placeholder.destroy()
    this.output.destroy()
  }
}
