import { fx, MAX_REGIONS, noMorph, REGION_KIND } from '../fx/fxStore'
import { ArtMorph } from './ArtMorph'
import compositeWGSL from './shaders/composite.wgsl?raw'
import materialWGSL from './shaders/material.wgsl?raw'
import sceneWGSL from './shaders/scene.wgsl?raw'

const REGION_OFFSET = 36
const UNIFORM_FLOATS = REGION_OFFSET + MAX_REGIONS * 8
const SCENE_UNIFORM_FLOATS = 68
const MATERIAL_SIZE = 1024
const FLAT_FORMAT: GPUTextureFormat = 'rgba8unorm'

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

export class Renderer {
  private device: GPUDevice
  private canvas: HTMLCanvasElement
  private context: GPUCanvasContext
  private format: GPUTextureFormat
  private ui: HTMLElement
  private drawable: boolean
  private flatPipeline: GPURenderPipeline
  private scenePipeline: GPURenderPipeline
  private uniform: GPUBuffer
  private uniformData = new Float32Array(UNIFORM_FLOATS)
  private sceneUniform: GPUBuffer
  private sceneData = new Float32Array(SCENE_UNIFORM_FLOATS)
  private linear: GPUSampler
  private repeat: GPUSampler
  private material: GPUTexture
  private domTex: GPUTexture
  private flatTex!: GPUTexture
  private hasDom = false
  private artMorph: ArtMorph
  private morphCard: () => HTMLElement | null = () => null

  private cssW = 1
  private cssH = 1
  private dpr = 1
  private raf = 0
  private lastT = 0
  private stats = [0, 0, 0, 0, 0, 0]
  private mouse = { x: 0, y: 0 }
  private light = { x: 0, y: 0 }
  /** Current tilt in degrees (x: rotateX, y: rotateY). */
  private tilt = { x: 0, y: 0 }
  private tiltMatrix = new DOMMatrix()
  /** Rotation part of the tilt, as 3 rows (object -> view). */
  private rotRows: number[] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]
  private appliedTransform = ''
  private resizeObserver: ResizeObserver
  private disposers: (() => void)[] = []

  static async create(canvas: HTMLCanvasElement, ui: HTMLElement, drawable: boolean) {
    const adapter = await navigator.gpu?.requestAdapter()
    if (!adapter) throw new Error('WebGPU adapter not available')
    const device = await adapter.requestDevice()
    return new Renderer(device, canvas, ui, drawable)
  }

  private constructor(device: GPUDevice, canvas: HTMLCanvasElement, ui: HTMLElement, drawable: boolean) {
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

    const pipeline = (label: string, code: string, format: GPUTextureFormat) => {
      const module = device.createShaderModule({ label, code })
      return device.createRenderPipeline({
        label,
        layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format }] },
        primitive: { topology: 'triangle-list' },
      })
    }
    this.flatPipeline = pipeline('composite', compositeWGSL, FLAT_FORMAT)
    this.scenePipeline = pipeline('scene', sceneWGSL, this.format)

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

  dispose() {
    cancelAnimationFrame(this.raf)
    this.resizeObserver.disconnect()
    this.disposers.forEach((d) => d())
    if (!this.drawable) this.ui.style.transform = ''
    this.artMorph.destroy()
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
    this.dpr = Math.min(window.devicePixelRatio || 1, 2)
    this.cssW = Math.max(1, rect.width)
    this.cssH = Math.max(1, rect.height)
    const w = Math.round(this.cssW * this.dpr)
    const h = Math.round(this.cssH * this.dpr)
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w
      this.canvas.height = h
    }
    this.flatTex?.destroy()
    this.flatTex = this.device.createTexture({
      label: 'flat-device',
      size: [w, h],
      format: FLAT_FORMAT,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    })
    if (this.drawable) {
      this.domTex.destroy()
      this.domTex = this.createDomTexture(w, h)
      this.hasDom = false
      this.canvas.requestPaint?.()
    }
  }

  /** Wires the HTML-in-Canvas `paint` event to a DOM -> GPU texture copy. */
  private attachHtmlInCanvas(ui: HTMLElement) {
    const onPaint = () => {
      const { width, height } = this.domTex
      const queue = this.device.queue
      try {
        queue.drawElementImageToTexture!({ source: ui }, { texture: this.domTex, size: { width, height } })
      } catch {
        // Older Canary builds shipped `copyElementImageToTexture` with a different signature.
        try {
          queue.copyElementImageToTexture!({ source: ui }, { destination: { texture: this.domTex }, width, height })
        } catch {
          queue.copyElementImageToTexture!(ui, width, height, { texture: this.domTex })
        }
      }
      this.hasDom = true
      this.appliedTransform = ''
    }
    this.canvas.addEventListener('paint', onPaint)
    this.disposers.push(() => this.canvas.removeEventListener('paint', onPaint))
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
  }

  // ------------------------------------------------------------ tilt

  private updateTilt(dev: Rect, dt: number) {
    const [x, y, w, h] = dev
    const cx = x + w / 2
    const cy = y + h / 2
    const clamp = (v: number) => Math.max(-1, Math.min(1, v))
    const nx = clamp((this.mouse.x - cx) / (w / 2))
    const ny = clamp((this.mouse.y - cy) / (h / 2))
    // The side nearest the pointer sinks away from the viewer.
    const k = 1 - Math.exp(-dt * 5)
    this.tilt.x += (-ny * TILT_X - this.tilt.x) * k
    this.tilt.y += (nx * TILT_Y - this.tilt.y) * k

    const rot = new DOMMatrix().rotate(this.tilt.x, this.tilt.y, 0)
    this.rotRows = [rot.m11, rot.m21, rot.m31, 0, rot.m12, rot.m22, rot.m32, 0, rot.m13, rot.m23, rot.m33, 0]
    const persp = new DOMMatrix()
    persp.m34 = -1 / PERSPECTIVE
    this.tiltMatrix = new DOMMatrix().translate(cx, cy).multiply(persp).multiply(rot).translate(-cx, -cy)

    // Keep the real DOM (hit-testing, and pixels in overlay mode) in sync with the shader.
    const css = this.tiltMatrix.toString()
    if (css !== this.appliedTransform) {
      this.appliedTransform = css
      if (this.drawable) {
        this.canvas.updateElementGeometry?.(this.ui, { canvasTransform: this.tiltMatrix })
      } else {
        this.ui.style.transformOrigin = '0 0'
        this.ui.style.transform = css
      }
    }
  }

  // ------------------------------------------------------------ frame

  private frame = (t: number) => {
    this.raf = requestAnimationFrame(this.frame)
    const dt = Math.min(1 / 30, this.lastT ? (t - this.lastT) / 1000 : 1 / 60)
    this.lastT = t

    const ks = 1 - Math.exp(-dt * 6)
    for (let i = 0; i < 6; i++) this.stats[i] += (fx.stats[i] - this.stats[i]) * ks

    const dev = this.writeRegions()
    this.updateTilt(dev, dt)

    const front = planeHomography(this.tiltMatrix)
    const back = planeHomography(this.tiltMatrix.translate(0, 0, -THICKNESS))
    const frontInv = invert3(front)
    const backInv = invert3(back)

    // Light follows the pointer, expressed in the flat device space.
    const flatMouse = applyH(frontInv, this.mouse.x, this.mouse.y)
    const kl = 1 - Math.exp(-dt * 8)
    this.light.x += (flatMouse.x - this.light.x) * kl
    this.light.y += (flatMouse.y - this.light.y) * kl

    this.writeUniforms(t / 1000)
    this.writeSceneUniforms(t / 1000, dev, front, frontInv, backInv)

    const encoder = this.device.createCommandEncoder()
    this.drawPass(encoder, this.flatTex.createView(), this.flatPipeline, [
      { binding: 0, resource: { buffer: this.uniform } },
      { binding: 1, resource: this.linear },
      { binding: 2, resource: this.repeat },
      { binding: 3, resource: this.domTex.createView() },
      { binding: 4, resource: this.material.createView() },
    ], (pass) => this.drawMorph(pass))
    this.drawPass(encoder, this.context.getCurrentTexture().createView(), this.scenePipeline, [
      { binding: 0, resource: { buffer: this.sceneUniform } },
      { binding: 1, resource: this.linear },
      { binding: 2, resource: this.flatTex.createView() },
    ])
    this.device.queue.submit([encoder.finish()])
  }

  private drawPass(
    encoder: GPUCommandEncoder,
    view: GPUTextureView,
    pipeline: GPURenderPipeline,
    entries: GPUBindGroupEntry[],
    after?: (pass: GPURenderPassEncoder) => void,
  ) {
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
    })
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, this.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries }))
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
    let n = 0
    for (const r of fx.regions) {
      if (n >= MAX_REGIONS) break
      const rect = layoutRect(r.el)
      if (rect[2] === 0 || rect[3] === 0) continue
      if (r.kind === 'device') dev = rect
      const state = r.el.matches(':active') ? 2 : r.el.matches(':hover') ? 1 : 0
      d.set([...rect, REGION_KIND[r.kind], r.radius, r.color, state], REGION_OFFSET + n * 8)
      n++
    }
    d.fill(0, REGION_OFFSET + n * 8)
    d[7] = n
    return dev
  }

  private writeUniforms(time: number) {
    const d = this.uniformData
    d.set([this.cssW, this.cssH, this.dpr, time], 0)
    d.set([this.light.x, this.light.y, this.hasDom ? 1 : 0], 4)
    d.set([...fx.accent, 1], 8)
    d.set(this.stats.slice(0, 4), 12)
    d.set([this.stats[4], this.stats[5], fx.voice, 0], 16)
    d.set([...fx.accent2, 1], 20)
    d.set(this.rotRows, 24)
    this.device.queue.writeBuffer(this.uniform, 0, d)
  }

  private writeSceneUniforms(time: number, dev: Rect, front: Mat3, frontInv: Mat3, backInv: Mat3) {
    const d = this.sceneData
    d.set([this.cssW, this.cssH, this.dpr, time], 0)
    d.set([this.mouse.x, this.mouse.y, 0, 0], 4)
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
