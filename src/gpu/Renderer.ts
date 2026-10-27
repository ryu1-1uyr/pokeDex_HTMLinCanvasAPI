import { fx, MAX_REGIONS, REGION_KIND } from '../fx/fxStore'
import { FluidSim } from './FluidSim'
import compositeWGSL from './shaders/composite.wgsl?raw'
import materialWGSL from './shaders/material.wgsl?raw'

const UNIFORM_FLOATS = 24 + MAX_REGIONS * 8
const MATERIAL_SIZE = 1024

export type DomMode = 'drawable' | 'overlay'

export function supportsHtmlInCanvas() {
  return (
    typeof HTMLCanvasElement !== 'undefined' &&
    'requestPaint' in HTMLCanvasElement.prototype &&
    typeof GPUQueue !== 'undefined' &&
    ('drawElementImageToTexture' in GPUQueue.prototype || 'copyElementImageToTexture' in GPUQueue.prototype)
  )
}

export class Renderer {
  private device: GPUDevice
  private canvas: HTMLCanvasElement
  private context: GPUCanvasContext
  private format: GPUTextureFormat
  private ui: HTMLElement | null
  private fluid: FluidSim
  private pipeline: GPURenderPipeline
  private uniform: GPUBuffer
  private uniformData = new Float32Array(UNIFORM_FLOATS)
  private linear: GPUSampler
  private repeat: GPUSampler
  private material: GPUTexture
  private domTex: GPUTexture
  private hasDom = false

  private cssW = 1
  private cssH = 1
  private dpr = 1
  private raf = 0
  private lastT = 0
  private stats = [0, 0, 0, 0, 0, 0]
  private mouse = { x: 0, y: 0 }
  private light = { x: 0, y: 0 }
  private pointerDelta = { x: 0, y: 0, moved: false }
  private resizeObserver: ResizeObserver
  private disposers: (() => void)[] = []

  static async create(canvas: HTMLCanvasElement, ui: HTMLElement | null) {
    const adapter = await navigator.gpu?.requestAdapter()
    if (!adapter) throw new Error('WebGPU adapter not available')
    const device = await adapter.requestDevice()
    return new Renderer(device, canvas, ui)
  }

  private constructor(device: GPUDevice, canvas: HTMLCanvasElement, ui: HTMLElement | null) {
    this.device = device
    this.canvas = canvas
    this.ui = ui
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
    this.uniform = device.createBuffer({
      size: UNIFORM_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })

    const module = device.createShaderModule({ label: 'composite', code: compositeWGSL })
    this.pipeline = device.createRenderPipeline({
      label: 'composite',
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list' },
    })

    this.material = this.bakeMaterial()
    this.domTex = this.createDomTexture(1, 1)
    this.fluid = new FluidSim(device)

    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(canvas)
    this.resize()

    if (ui) this.attachHtmlInCanvas(ui)
    this.attachPointer()
    this.raf = requestAnimationFrame(this.frame)
  }

  dispose() {
    cancelAnimationFrame(this.raf)
    this.resizeObserver.disconnect()
    this.disposers.forEach((d) => d())
    this.fluid.destroy()
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
    this.fluid.resize(this.cssW, this.cssH)
    if (this.ui) {
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
      // The UI is drawn 1:1 at the canvas origin, so hit-testing uses an identity transform.
      if (this.canvas.updateElementGeometry) {
        this.canvas.updateElementGeometry(ui, { canvasTransform: new DOMMatrix() })
      }
    }
    this.canvas.addEventListener('paint', onPaint)
    this.disposers.push(() => this.canvas.removeEventListener('paint', onPaint))
    this.canvas.requestPaint?.()
  }

  private attachPointer() {
    const onMove = (e: PointerEvent) => {
      if (this.pointerDelta.moved || this.mouse.x || this.mouse.y) {
        this.pointerDelta.x += e.clientX - this.mouse.x
        this.pointerDelta.y += e.clientY - this.mouse.y
      }
      this.pointerDelta.moved = true
      this.mouse.x = e.clientX
      this.mouse.y = e.clientY
    }
    window.addEventListener('pointermove', onMove, { passive: true })
    this.disposers.push(() => window.removeEventListener('pointermove', onMove))
    this.mouse = { x: innerWidth * 0.5, y: innerHeight * 0.3 }
    this.light = { ...this.mouse }
  }

  // ------------------------------------------------------------ frame

  private frame = (t: number) => {
    this.raf = requestAnimationFrame(this.frame)
    const dt = Math.min(1 / 30, this.lastT ? (t - this.lastT) / 1000 : 1 / 60)
    this.lastT = t

    // Pointer drag -> fluid splat
    if (this.pointerDelta.moved && dt > 0) {
      const vx = this.pointerDelta.x / dt
      const vy = this.pointerDelta.y / dt
      if (Math.hypot(this.pointerDelta.x, this.pointerDelta.y) > 0.5) {
        fx.splats.push({
          x: this.mouse.x,
          y: this.mouse.y,
          vx: vx * 0.6,
          vy: vy * 0.6,
          color: fx.accent.map((c) => c * 0.35) as [number, number, number],
          radius: 0.0006,
        })
      }
      this.pointerDelta = { x: 0, y: 0, moved: false }
    }

    // Ease light toward pointer and stats toward target
    const k = 1 - Math.exp(-dt * 8)
    this.light.x += (this.mouse.x - this.light.x) * k
    this.light.y += (this.mouse.y - this.light.y) * k
    const ks = 1 - Math.exp(-dt * 6)
    for (let i = 0; i < 6; i++) this.stats[i] += (fx.stats[i] - this.stats[i]) * ks

    this.writeUniforms(t / 1000)

    const encoder = this.device.createCommandEncoder()
    const splats = fx.splats.splice(0, fx.splats.length)
    this.fluid.step(encoder, dt, splats)

    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
    })
    pass.setPipeline(this.pipeline)
    pass.setBindGroup(
      0,
      this.device.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.uniform } },
          { binding: 1, resource: this.linear },
          { binding: 2, resource: this.repeat },
          { binding: 3, resource: this.domTex.createView() },
          { binding: 4, resource: this.fluid.velocity.read.createView() },
          { binding: 5, resource: this.fluid.dye.read.createView() },
          { binding: 6, resource: this.material.createView() },
        ],
      }),
    )
    pass.draw(3)
    pass.end()
    this.device.queue.submit([encoder.finish()])
  }

  private writeUniforms(time: number) {
    const d = this.uniformData
    d.fill(0)
    d.set([this.cssW, this.cssH, this.dpr, time], 0)
    d.set([this.light.x, this.light.y, this.hasDom ? 1 : 0, 0], 4)
    d.set([...fx.accent, 1], 8)
    d.set(this.stats.slice(0, 4), 12)
    d.set([this.stats[4], this.stats[5], 0, 0], 16)
    d.set([...fx.accent2, 1], 20)

    let n = 0
    for (const r of fx.regions) {
      if (n >= MAX_REGIONS) break
      const b = r.el.getBoundingClientRect()
      if (b.width === 0 || b.height === 0) continue
      const state = r.el.matches(':active') ? 2 : r.el.matches(':hover') ? 1 : 0
      d.set([b.x, b.y, b.width, b.height, REGION_KIND[r.kind], r.radius, r.color, state], 24 + n * 8)
      n++
    }
    d[7] = n
    this.device.queue.writeBuffer(this.uniform, 0, d)
  }
}
