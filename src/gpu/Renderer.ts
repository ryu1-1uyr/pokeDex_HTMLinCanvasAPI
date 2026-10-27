import { fx, MAX_REGIONS, noMorph, REGION_KIND } from '../fx/fxStore'
import { Afterglow } from './Afterglow'
import { ArtMorph } from './ArtMorph'
import { Bloom } from './Bloom'
import { Panels } from './Panels'
import compositeWGSL from './shaders/composite.wgsl?raw'
import materialWGSL from './shaders/material.wgsl?raw'
import sceneWGSL from './shaders/scene.wgsl?raw'

const REGION_OFFSET = 36
const UNIFORM_FLOATS = REGION_OFFSET + MAX_REGIONS * 8
const SCENE_UNIFORM_FLOATS = 68
const MATERIAL_SIZE = 1024
/** HDR so emissive parts can exceed 1 and feed the bloom. */
const FLAT_FORMAT: GPUTextureFormat = 'rgba16float'
const BG_FORMAT: GPUTextureFormat = 'rgba8unorm'
/** Background resolution relative to CSS px (it is blurred anyway). */
const BG_SCALE = 0.5
/** Frame cap; avoids saturating the GPU on 120Hz displays. */
const MIN_FRAME_MS = 1000 / 60 - 1.5
/** Phone layout (same breakpoint as dex.css): full-bleed device, no backdrop, no tilt. */
const COMPACT_QUERY = '(max-width: 860px)'
/** Degrees of phone tilt (from where it was first held) that move the light across the screen. */
const ORIENTATION_RANGE = 25

/** Perspective distance (CSS px) and max tilt (deg) of the device. */
const PERSPECTIVE = 1800
const TILT_X = 7
const TILT_Y = 10
/** Depth of the extruded body (CSS px). */
const THICKNESS = 36

type Rect = [x: number, y: number, w: number, h: number]
type Mat3 = [number, number, number, number, number, number, number, number, number]

export function supportsHtmlInCanvas() {
  return (
    typeof HTMLCanvasElement !== 'undefined' &&
    'requestPaint' in HTMLCanvasElement.prototype &&
    typeof GPUQueue !== 'undefined' &&
    ('drawElementImageToTexture' in GPUQueue.prototype || 'copyElementImageToTexture' in GPUQueue.prototype)
  )
}

/**
 * Layout rect relative to the viewport, ignoring CSS transforms. Region geometry must be
 * flat (untilted) because the shader applies the tilt itself; getBoundingClientRect would
 * return the transformed bounding box in overlay mode.
 */
function layoutRect(el: HTMLElement): Rect {
  let x = 0
  let y = 0
  let e: HTMLElement | null = el
  while (e) {
    x += e.offsetLeft
    y += e.offsetTop
    const op = e.offsetParent as HTMLElement | null
    for (let a: HTMLElement | null = e.parentElement; a && a !== op; a = a.parentElement) {
      x -= a.scrollLeft
      y -= a.scrollTop
    }
    if (op) {
      x += op.clientLeft - op.scrollLeft
      y += op.clientTop - op.scrollTop
    }
    e = op
  }
  return [x, y, el.offsetWidth, el.offsetHeight]
}

/** Homography (row-major 3x3) of the z=0 plane under a 4x4 DOMMatrix. */
function planeHomography(m: DOMMatrix): Mat3 {
  return [m.m11, m.m21, m.m41, m.m12, m.m22, m.m42, m.m14, m.m24, m.m44]
}

function invert3([a, b, c, d, e, f, g, h, i]: Mat3): Mat3 {
  const A = e * i - f * h
  const B = -(d * i - f * g)
  const C = d * h - e * g
  const det = a * A + b * B + c * C
  const k = 1 / det
  return [
    A * k, -(b * i - c * h) * k, (b * f - c * e) * k,
    B * k, (a * i - c * g) * k, -(a * f - c * d) * k,
    C * k, -(a * h - b * g) * k, (a * e - b * d) * k,
  ]
}

function applyH(h: Mat3, x: number, y: number) {
  const w = h[6] * x + h[7] * y + h[8]
  return { x: (h[0] * x + h[1] * y + h[2]) / w, y: (h[3] * x + h[4] * y + h[5]) / w }
}

export interface RendererOptions {
  /** HTML-in-Canvas: capturing the screen panels failed; render them in place instead. */
  onPanelsFailed?: () => void
}

export class Renderer {
  private device: GPUDevice
  private canvas: HTMLCanvasElement
  private context: GPUCanvasContext
  private format: GPUTextureFormat
  private ui: HTMLElement
  private drawable: boolean
  private flatPipeline: GPURenderPipeline
  private scenePipeline: GPURenderPipeline
  private bgPipeline: GPURenderPipeline
  private uniform: GPUBuffer
  private uniformData = new Float32Array(UNIFORM_FLOATS)
  private sceneUniform: GPUBuffer
  private sceneData = new Float32Array(SCENE_UNIFORM_FLOATS)
  private linear: GPUSampler
  private repeat: GPUSampler
  private material: GPUTexture
  private domTex: GPUTexture
  private flatTex!: GPUTexture
  private bgTex!: GPUTexture
  /** Cached bind groups; reset whenever a texture they reference is recreated. */
  private bindGroups: { scene?: GPUBindGroup; bg?: GPUBindGroup } = {}
  /** Flat-pass bind groups keyed by the afterglow target they read (it ping-pongs). */
  private flatBindGroups = new Map<GPUTexture, GPUBindGroup>()
  private afterglow: Afterglow
  private panels: Panels
  /** Set when the root's hit-testing geometry changed this frame. */
  private rootMoved = false
  private compact = false
  /** Phone tilt relative to the first reading, -1..1 per axis; null until a reading arrives. */
  private orientation: { x: number; y: number } | null = null
  private orientationBase: { beta: number; gamma: number } | null = null
  private options: RendererOptions
  private panelsDisabled = false
  /** True while the previous frame's GPU work is still in flight. */
  private gpuBusy = false
  private lastRender = 0
  private disposed = false
  private hasDom = false
  private artMorph: ArtMorph
  private bloom: Bloom
  private morphCard: () => HTMLElement | null = () => null

  private cssW = 1
  private cssH = 1
  private dpr = 1
  private raf = 0
  private lastT = 0
  private startedAt = performance.now()
  private stats = [0, 0, 0, 0, 0, 0]
  private mouse = { x: 0, y: 0 }
  private light = { x: 0, y: 0 }
  /** Current tilt in degrees (x: rotateX, y: rotateY). */
  private tilt = { x: 0, y: 0 }
  private tiltMatrix = new DOMMatrix()
  /** Rotation part of the tilt, as 3 rows (object -> view). */
  private rotRows: number[] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]
  private appliedTransform = ''
  private appliedParallax = ''
  private resizeObserver: ResizeObserver
  private disposers: (() => void)[] = []

  static async create(canvas: HTMLCanvasElement, ui: HTMLElement, drawable: boolean, options: RendererOptions = {}) {
    const adapter = await navigator.gpu?.requestAdapter()
    if (!adapter) throw new Error('WebGPU adapter not available')
    const device = await adapter.requestDevice()
    return new Renderer(device, canvas, ui, drawable, options)
  }

  private constructor(
    device: GPUDevice,
    canvas: HTMLCanvasElement,
    ui: HTMLElement,
    drawable: boolean,
    options: RendererOptions,
  ) {
    this.options = options
    this.device = device
    this.canvas = canvas
    this.ui = ui
    this.drawable = drawable
    this.context = canvas.getContext('webgpu')!
    this.format = navigator.gpu.getPreferredCanvasFormat()
    this.context.configure({ device, format: this.format, alphaMode: 'opaque' })

    this.linear = device.createSampler({ magFilter: 'linear', minFilter: 'linear' })
    this.repeat = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
    })
    const ubo = (floats: number) =>
      device.createBuffer({ size: floats * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    this.uniform = ubo(UNIFORM_FLOATS)
    this.sceneUniform = ubo(SCENE_UNIFORM_FLOATS)

    const pipeline = (label: string, module: GPUShaderModule, format: GPUTextureFormat, entryPoint = 'fs') =>
      device.createRenderPipeline({
        label,
        layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint, targets: [{ format }] },
        primitive: { topology: 'triangle-list' },
      })
    const sceneModule = device.createShaderModule({ label: 'scene', code: sceneWGSL })
    this.flatPipeline = pipeline('composite', device.createShaderModule({ label: 'composite', code: compositeWGSL }), FLAT_FORMAT)
    this.scenePipeline = pipeline('scene', sceneModule, this.format)
    this.bgPipeline = pipeline('background', sceneModule, BG_FORMAT, 'fsBg')
    this.bloom = new Bloom(device)
    this.afterglow = new Afterglow(device)
    this.panels = new Panels(device, canvas, {
      copyElement: (el, tex) => this.copyElement(el, tex),
      layoutRect,
      planeHomography,
      invert3,
    })

    device.lost.then((info) => {
      if (info.reason === 'destroyed') return
      // Stop issuing work on a dead device instead of spamming errors every frame.
      console.warn('WebGPU device lost:', info.message)
      cancelAnimationFrame(this.raf)
    })
    const onPageHide = () => this.dispose()
    window.addEventListener('pagehide', onPageHide)
    this.disposers.push(() => window.removeEventListener('pagehide', onPageHide))

    this.material = this.bakeMaterial()
    this.artMorph = new ArtMorph(device, FLAT_FORMAT)
    const morph: typeof fx.morph = (url, card) => {
      this.morphCard = card
      return this.artMorph.start(url)
    }
    fx.morph = morph
    // StrictMode can dispose an older renderer after a newer one attached; only detach our own.
    this.disposers.push(() => {
      if (fx.morph === morph) fx.morph = noMorph
    })
    this.domTex = this.createDomTexture(1, 1)

    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(canvas)
    this.resize()

    if (drawable) this.attachHtmlInCanvas(ui)
    this.attachPointer()
    this.raf = requestAnimationFrame(this.frame)
  }

  /** Releases the GPU device explicitly (also on pagehide) so a reload starts clean. */
  dispose() {
    if (this.disposed) return
    this.disposed = true
    cancelAnimationFrame(this.raf)
    this.resizeObserver.disconnect()
    this.disposers.forEach((d) => d())
    if (!this.drawable) this.ui.style.transform = ''
    this.artMorph.destroy()
    this.bloom.destroy()
    this.afterglow.destroy()
    this.panels.destroy()
    this.device.destroy()
  }

  // ------------------------------------------------------------ setup

  private bakeMaterial() {
    const tex = this.device.createTexture({
      label: 'material',
      size: [MATERIAL_SIZE, MATERIAL_SIZE],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
    })
    const pipeline = this.device.createComputePipeline({
      label: 'material-bake',
      layout: 'auto',
      compute: { module: this.device.createShaderModule({ code: materialWGSL }), entryPoint: 'main' },
    })
    const encoder = this.device.createCommandEncoder()
    const pass = encoder.beginComputePass()
    pass.setPipeline(pipeline)
    pass.setBindGroup(
      0,
      this.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: tex.createView() }],
      }),
    )
    pass.dispatchWorkgroups(MATERIAL_SIZE / 8, MATERIAL_SIZE / 8)
    pass.end()
    this.device.queue.submit([encoder.finish()])
    return tex
  }

  private createDomTexture(w: number, h: number) {
    return this.device.createTexture({
      label: 'dom',
      size: [w, h],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    })
  }

  private resize() {
    const rect = this.canvas.getBoundingClientRect()
    this.compact = window.matchMedia(COMPACT_QUERY).matches
    this.dpr = Math.min(window.devicePixelRatio || 1, 2)
    this.cssW = Math.max(1, rect.width)
    this.cssH = Math.max(1, rect.height)
    const w = Math.round(this.cssW * this.dpr)
    const h = Math.round(this.cssH * this.dpr)
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w
      this.canvas.height = h
    }
    const target = (label: string, tw: number, th: number, format: GPUTextureFormat) =>
      this.device.createTexture({
        label,
        size: [Math.max(1, tw), Math.max(1, th)],
        format,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
      })
    this.flatTex?.destroy()
    this.flatTex = target('flat-device', w, h, FLAT_FORMAT)
    this.bgTex?.destroy()
    this.bgTex = target('background', Math.ceil(this.cssW * BG_SCALE), Math.ceil(this.cssH * BG_SCALE), BG_FORMAT)
    this.bloom.resize(this.flatTex)
    this.bindGroups = {}
    this.flatBindGroups.clear()
    if (this.drawable) {
      this.domTex.destroy()
      this.domTex = this.createDomTexture(w, h)
      this.afterglow.resize(w, h)
      this.panels.resize(w, h)
      this.hasDom = false
      this.canvas.requestPaint?.()
    }
  }

  /** Wires the HTML-in-Canvas `paint` event to a DOM -> GPU texture copy. */
  private attachHtmlInCanvas(ui: HTMLElement) {
    const onPaint = () => {
      this.copyElement(ui, this.domTex)
      this.hasDom = true
      this.appliedTransform = ''
      // Screens are nested drawables, excluded from the root snapshot and captured separately.
      // If this build can't capture them, fall back to drawing everything through the root.
      if (!this.panelsDisabled) {
        try {
          this.panels.paint(this.dpr)
        } catch (error) {
          this.disablePanels(error)
        }
      }
    }
    this.canvas.addEventListener('paint', onPaint)
    this.disposers.push(() => this.canvas.removeEventListener('paint', onPaint))
    this.canvas.requestPaint?.()
  }

  /** Copies an element's current snapshot into a texture of the same size. */
  /**
   * The WebGPU entry point changed across Chrome releases: Chrome 155+ has
   * drawElementImageToTexture(source, { texture, size }); 150-154 has
   * copyElementImageToTexture({ source }, { destination, width, height }); earlier builds
   * took (element, width, height, destination). Pick by feature detection so a failure
   * surfaces its real error instead of the last fallback's.
   */
  private copyElement(el: Element, texture: GPUTexture) {
    const { width, height } = texture
    const queue = this.device.queue
    if (queue.drawElementImageToTexture) {
      queue.drawElementImageToTexture({ source: el }, { texture, size: { width, height } })
      return
    }
    try {
      queue.copyElementImageToTexture!({ source: el }, { destination: { texture }, width, height })
    } catch (error) {
      if (!(error instanceof TypeError)) throw error
      // Pre-150 positional signature; if that fails too, report both errors.
      try {
        queue.copyElementImageToTexture!(el, width, height, { texture })
      } catch (legacyError) {
        throw new AggregateError([error, legacyError], 'copyElementImageToTexture failed with both signatures')
      }
    }
  }

  /** Turns the floating panels off and lets the root snapshot include the screens again. */
  /** Turns the floating panels off; the UI re-renders the screens inside the root. */
  private disablePanels(error: unknown) {
    this.panelsDisabled = true
    const panels = [...this.canvas.querySelectorAll<HTMLElement>('[data-panel-for]')]
    console.warn('[pokedex-gpu] Floating panels disabled: capturing a screen panel failed.', {
      error,
      panels: panels.map((el) => {
        const [, , w, h] = layoutRect(el)
        return { id: el.dataset.panelFor, cssSize: [w, h], defaultSize: this.canvas.getElementImageDefaultSize?.(el) }
      }),
      dpr: this.dpr,
    })
    this.panels.setElements([])
    this.options.onPanelsFailed?.()
    this.canvas.requestPaint?.()
  }

  private attachPointer() {
    const onMove = (e: PointerEvent) => {
      this.mouse.x = e.clientX
      this.mouse.y = e.clientY
    }
    window.addEventListener('pointermove', onMove, { passive: true })
    this.disposers.push(() => window.removeEventListener('pointermove', onMove))
    this.mouse = { x: innerWidth * 0.5, y: innerHeight * 0.5 }
    this.light = { ...this.mouse }
    this.attachOrientation()
  }

  /** Phones: tilting the device moves the light source. */
  private attachOrientation() {
    const clamp = (v: number) => Math.max(-1, Math.min(1, v))
    const onOrientation = (e: DeviceOrientationEvent) => {
      if (e.beta == null || e.gamma == null) return
      // Relative to how the phone was held at first, so any holding angle works.
      this.orientationBase ??= { beta: e.beta, gamma: e.gamma }
      const gx = (e.gamma - this.orientationBase.gamma) / ORIENTATION_RANGE
      const gy = (e.beta - this.orientationBase.beta) / ORIENTATION_RANGE
      // Device axes are fixed to the hardware; rotate them into the current screen orientation.
      const a = ((screen.orientation?.angle ?? 0) * Math.PI) / 180
      this.orientation = {
        x: clamp(gx * Math.cos(a) + gy * Math.sin(a)),
        y: clamp(-gx * Math.sin(a) + gy * Math.cos(a)),
      }
    }
    window.addEventListener('deviceorientation', onOrientation)
    this.disposers.push(() => window.removeEventListener('deviceorientation', onOrientation))

    // iOS Safari only delivers orientation after a permission prompt triggered by a user gesture.
    const DOE = window.DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> } | undefined
    if (typeof DOE?.requestPermission === 'function') {
      const ask = () => {
        DOE.requestPermission!().catch(() => {})
      }
      window.addEventListener('pointerdown', ask, { once: true })
      this.disposers.push(() => window.removeEventListener('pointerdown', ask))
    }
    const onOrientationChange = () => (this.orientationBase = null)
    screen.orientation?.addEventListener('change', onOrientationChange)
    this.disposers.push(() => screen.orientation?.removeEventListener('change', onOrientationChange))
  }

  /** Where the light should be: the pointer, or on phones the device tilt. */
  private lightTarget() {
    if (this.compact && this.orientation) {
      return {
        x: this.cssW * (0.5 + this.orientation.x * 0.7),
        y: this.cssH * (0.35 + this.orientation.y * 0.7),
      }
    }
    return this.mouse
  }

  // ------------------------------------------------------------ tilt

  private updateTilt(dev: Rect, dt: number) {
    const [x, y, w, h] = dev
    const cx = x + w / 2
    const cy = y + h / 2
    const clamp = (v: number) => Math.max(-1, Math.min(1, v))
    // Phones keep the device flat: there's no pointer to tilt toward and the DOM must stay put.
    const nx = this.compact ? 0 : clamp((this.mouse.x - cx) / (w / 2))
    const ny = this.compact ? 0 : clamp((this.mouse.y - cy) / (h / 2))
    // The side nearest the pointer sinks away from the viewer.
    const k = 1 - Math.exp(-dt * 5)
    this.tilt.x += (-ny * TILT_X - this.tilt.x) * k
    this.tilt.y += (nx * TILT_Y - this.tilt.y) * k

    const rot = new DOMMatrix().rotate(this.tilt.x, this.tilt.y, 0)
    this.rotRows = [rot.m11, rot.m21, rot.m31, 0, rot.m12, rot.m22, rot.m32, 0, rot.m13, rot.m23, rot.m33, 0]

    // Screen-space shift per px of depth below the glass (same as parallax() in the shader).
    // DOM layers that float above the glass use it with a negative depth.
    const px = (-rot.m31 / rot.m33).toFixed(4)
    const py = (-rot.m32 / rot.m33).toFixed(4)
    const parallax = `${px},${py}`
    if (parallax !== this.appliedParallax) {
      this.appliedParallax = parallax
      // On the canvas too: HTML-in-Canvas panels are canvas children outside the UI root.
      for (const el of [this.ui, this.canvas]) {
        el.style.setProperty('--fui-px', px)
        el.style.setProperty('--fui-py', py)
      }
    }
    const persp = new DOMMatrix()
    persp.m34 = -1 / PERSPECTIVE
    this.tiltMatrix = new DOMMatrix().translate(cx, cy).multiply(persp).multiply(rot).translate(-cx, -cy)

    // Keep the real DOM (hit-testing, and pixels in overlay mode) in sync with the shader.
    const css = this.tiltMatrix.toString()
    if (css !== this.appliedTransform) {
      this.appliedTransform = css
      if (this.drawable) {
        this.canvas.updateElementGeometry?.(this.ui, { canvasTransform: this.tiltMatrix })
        this.rootMoved = true
      } else {
        this.ui.style.transformOrigin = '0 0'
        this.ui.style.transform = css
      }
    }
  }

  // ------------------------------------------------------------ frame

  private frame = (t: number) => {
    this.raf = requestAnimationFrame(this.frame)
    // Backpressure: never queue a frame while the previous one is still on the GPU,
    // otherwise work piles up when the GPU slows down (e.g. thermal throttling).
    if (this.gpuBusy || t - this.lastRender < MIN_FRAME_MS) return
    this.lastRender = t
    const dt = Math.min(1 / 30, this.lastT ? (t - this.lastT) / 1000 : 1 / 60)
    this.lastT = t

    const ks = 1 - Math.exp(-dt * 6)
    for (let i = 0; i < 6; i++) this.stats[i] += (fx.stats[i] - this.stats[i]) * ks

    const dev = this.writeRegions()
    this.updateTilt(dev, dt)
    if (this.drawable) {
      // Panels re-apply their geometry after the root so they stay above it in hit-test order.
      this.panels.update(dt, this.tiltMatrix, [this.cssW, this.cssH], this.dpr, this.rootMoved)
      this.rootMoved = false
    }

    const front = planeHomography(this.tiltMatrix)
    const back = planeHomography(this.tiltMatrix.translate(0, 0, -THICKNESS))
    const frontInv = invert3(front)
    const backInv = invert3(back)

    // Light follows the pointer, expressed in the flat device space.
    const target = this.lightTarget()
    const flatMouse = applyH(frontInv, target.x, target.y)
    const kl = 1 - Math.exp(-dt * 8)
    this.light.x += (flatMouse.x - this.light.x) * kl
    this.light.y += (flatMouse.y - this.light.y) * kl

    this.writeUniforms(t / 1000)
    this.writeSceneUniforms(t / 1000, dev, front, frontInv, backInv)

    const encoder = this.device.createCommandEncoder()
    // HTML-in-Canvas only: phosphor persistence of the DOM texture.
    // HTML-in-Canvas only: compose root + lifted panels, then phosphor persistence.
    const screenDom = this.drawable ? this.panels.output : this.domTex
    if (this.drawable && this.hasDom) {
      this.panels.encode(encoder, this.domTex)
      this.afterglow.encode(encoder, screenDom, dt)
    }
    const trail = this.afterglow.output
    let flatGroup = this.flatBindGroups.get(trail)
    if (!flatGroup) {
      flatGroup = this.bindGroup(this.flatPipeline, [
        { buffer: this.uniform },
        this.linear,
        this.repeat,
        screenDom.createView(),
        this.material.createView(),
        trail.createView(),
      ])
      this.flatBindGroups.set(trail, flatGroup)
    }

    const bg = this.bindGroups
    bg.bg ??= this.bindGroup(this.bgPipeline, [{ buffer: this.sceneUniform }])
    bg.scene ??= this.bindGroup(this.scenePipeline, [
      { buffer: this.sceneUniform },
      this.linear,
      this.flatTex.createView(),
      this.bgTex.createView(),
      this.bloom.output.createView(),
    ])

    // The flat device only covers the device body: scissor away the rest.
    const pad = 4
    const sx = Math.max(0, Math.floor((dev[0] - pad) * this.dpr))
    const sy = Math.max(0, Math.floor((dev[1] - pad) * this.dpr))
    const sw = Math.min(this.flatTex.width, Math.ceil((dev[0] + dev[2] + pad) * this.dpr)) - sx
    const sh = Math.min(this.flatTex.height, Math.ceil((dev[1] + dev[3] + pad) * this.dpr)) - sy
    this.drawPass(encoder, this.flatTex.createView(), this.flatPipeline, flatGroup, (pass) => {
      if (sw > 0 && sh > 0) pass.setScissorRect(sx, sy, sw, sh)
    }, (pass) => this.drawMorph(pass))
    this.bloom.encode(encoder)
    if (this.compact) {
      // No backdrop on phones: just keep the target black.
      encoder.beginRenderPass({ colorAttachments: [{ view: this.bgTex.createView(), loadOp: 'clear', storeOp: 'store' }] }).end()
    } else {
      this.drawPass(encoder, this.bgTex.createView(), this.bgPipeline, bg.bg)
    }
    this.drawPass(encoder, this.context.getCurrentTexture().createView(), this.scenePipeline, bg.scene)
    this.device.queue.submit([encoder.finish()])

    this.gpuBusy = true
    this.device.queue.onSubmittedWorkDone().then(
      () => (this.gpuBusy = false),
      () => {},
    )
  }

  private bindGroup(pipeline: GPURenderPipeline, resources: GPUBindingResource[]) {
    return this.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: resources.map((resource, binding) => ({ binding, resource })),
    })
  }

  private drawPass(
    encoder: GPUCommandEncoder,
    view: GPUTextureView,
    pipeline: GPURenderPipeline,
    bindGroup: GPUBindGroup,
    before?: (pass: GPURenderPassEncoder) => void,
    after?: (pass: GPURenderPassEncoder) => void,
  ) {
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
    })
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, bindGroup)
    before?.(pass)
    pass.draw(3)
    after?.(pass)
    pass.end()
  }

  /** Artwork particles, drawn into the flat device so they tilt with it. */
  private drawMorph(pass: GPURenderPassEncoder) {
    const card = this.morphCard()
    if (!card || !this.artMorph.active) return
    // Matches the CSS: the artwork is a square 92% of the card width, centered.
    const [x, y, w, h] = layoutRect(card)
    const s = w * 0.92
    this.artMorph.draw(pass, [x + (w - s) / 2, y + (h - s) / 2, s, s], [this.cssW, this.cssH], this.dpr, fx.accent)
  }

  /** Writes region rects into the flat-pass uniforms and returns the device rect. */
  private writeRegions(): Rect {
    const d = this.uniformData
    let dev: Rect = [0, 0, this.cssW, this.cssH]
    const slots: HTMLElement[] = []
    let n = 0
    for (const r of fx.regions) {
      if (n >= MAX_REGIONS) break
      const rect = this.regionRect(r.el)
      if (rect[2] === 0 || rect[3] === 0) continue
      if (r.kind === 'device') dev = rect
      if (r.kind === 'screen') slots.push(r.el)
      const state = r.el.matches(':active') ? 2 : r.el.matches(':hover') ? 1 : 0
      d.set([...rect, REGION_KIND[r.kind], r.radius, r.color, state], REGION_OFFSET + n * 8)
      n++
    }
    d.fill(0, REGION_OFFSET + n * 8)
    d[7] = n
    // HTML-in-Canvas: pair each screen slot with its portaled panel (ui/Screen.tsx).
    if (this.drawable && !this.panelsDisabled) {
      const pairs = slots.flatMap((slot) => {
        const panel = this.panelFor(slot)
        return panel ? [{ slot, panel }] : []
      })
      if (this.panels.setElements(pairs)) this.canvas.requestPaint?.()
    }
    return dev
  }

  private panelFor(slot: HTMLElement) {
    const id = slot.dataset.panelId
    return id ? this.canvas.querySelector<HTMLElement>(`[data-panel-for="${id}"]`) : null
  }

  /**
   * Layout rect in device space. Elements inside a portaled panel are laid out where the
   * panel sits among the canvas children, so they are moved into the panel's slot.
   */
  private regionRect(el: HTMLElement): Rect {
    const rect = layoutRect(el)
    const panel = this.drawable ? el.closest<HTMLElement>('[data-panel-for]') : null
    const slot = panel && this.ui.querySelector<HTMLElement>(`[data-panel-id="${panel.dataset.panelFor}"]`)
    if (!panel || !slot) return rect
    const p = layoutRect(panel)
    const s = layoutRect(slot)
    return [rect[0] - p[0] + s[0], rect[1] - p[1] + s[1], rect[2], rect[3]]
  }

  private writeUniforms(time: number) {
    const d = this.uniformData
    d.set([this.cssW, this.cssH, this.dpr, time], 0)
    d.set([this.light.x, this.light.y, this.hasDom ? 1 : 0], 4)
    d.set([...fx.accent, 1], 8)
    d.set(this.stats.slice(0, 4), 12)
    d.set([this.stats[4], this.stats[5], fx.voice, (performance.now() - this.startedAt) / 1000], 16)
    d.set([...fx.accent2, 1], 20)
    d.set(this.rotRows, 24)
    this.device.queue.writeBuffer(this.uniform, 0, d)
  }

  private writeSceneUniforms(time: number, dev: Rect, front: Mat3, frontInv: Mat3, backInv: Mat3) {
    const d = this.sceneData
    d.set([this.cssW, this.cssH, this.dpr, time], 0)
    d.set([this.mouse.x, this.mouse.y, BG_SCALE, 0], 4)
    d.set(dev, 8)
    d.set([-this.tilt.y * 3, 26 + this.tilt.x * 2, THICKNESS, 0], 12)
    for (let row = 0; row < 3; row++) {
      d.set([...frontInv.slice(row * 3, row * 3 + 3), 0], 16 + row * 4)
      d.set([...backInv.slice(row * 3, row * 3 + 3), 0], 28 + row * 4)
      d.set([...front.slice(row * 3, row * 3 + 3), 0], 40 + row * 4)
    }
    const m = this.tiltMatrix
    d.set([m.m31, m.m32, m.m34, 0], 52)
    d.set(this.rotRows, 56)
    this.device.queue.writeBuffer(this.sceneUniform, 0, d)
  }
}
