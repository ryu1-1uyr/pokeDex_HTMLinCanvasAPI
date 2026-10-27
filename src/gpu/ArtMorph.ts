import type { MorphHandle } from '../fx/fxStore'
import particleSeedWGSL from './shaders/particleSeed.wgsl?raw'
import particlesWGSL from './shaders/particles.wgsl?raw'

const N = 128
const COUNT = N * N
const PARTICLE_BYTES = 64
/** Total morph length (s); matches END in particles.wgsl. */
const DURATION = 1.45
/** When the real <img> starts fading back in (s). */
const REVEAL = DURATION - 0.3

/**
 * Particle transition between two artworks. The previous artwork's pixels fly to
 * random pixels of the next one and re-assemble top to bottom.
 */
export class ArtMorph {
  private device: GPUDevice
  private fromTex: GPUTexture
  private toTex: GPUTexture
  private particles: GPUBuffer
  private seedParams: GPUBuffer
  private drawParams: GPUBuffer
  private seedPipeline: GPUComputePipeline
  private drawPipeline: GPURenderPipeline
  private hasFrom = false
  private startedAt = -1
  private generation = 0

  constructor(device: GPUDevice, format: GPUTextureFormat) {
    this.device = device
    const tex = (label: string) =>
      device.createTexture({
        label,
        size: [N, N],
        format: 'rgba8unorm',
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.COPY_SRC |
          GPUTextureUsage.RENDER_ATTACHMENT,
      })
    this.fromTex = tex('art-from')
    this.toTex = tex('art-to')
    this.particles = device.createBuffer({ size: COUNT * PARTICLE_BYTES, usage: GPUBufferUsage.STORAGE })
    this.seedParams = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    this.drawParams = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })

    this.seedPipeline = device.createComputePipeline({
      label: 'particle-seed',
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: particleSeedWGSL }), entryPoint: 'seed' },
    })
    const module = device.createShaderModule({ label: 'particles', code: particlesWGSL })
    const additive: GPUBlendComponent = { srcFactor: 'one', dstFactor: 'one', operation: 'add' }
    this.drawPipeline = device.createRenderPipeline({
      label: 'particles',
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format, blend: { color: additive, alpha: additive } }] },
      primitive: { topology: 'triangle-list' },
    })
  }

  get active() {
    return this.startedAt >= 0
  }

  start(url: string): MorphHandle {
    const gen = ++this.generation
    let resolveDone!: () => void
    const done = new Promise<void>((r) => (resolveDone = r))

    const started = (async () => {
      const blob = await fetch(url).then((r) => r.blob())
      const bitmap = await createImageBitmap(blob, { resizeWidth: N, resizeHeight: N, resizeQuality: 'high' })
      if (gen !== this.generation) return

      // An interrupted morph continues from wherever it was headed.
      if (this.active) this.promoteTarget()
      this.device.queue.copyExternalImageToTexture({ source: bitmap }, { texture: this.toTex }, [N, N])
      this.seed()
      this.startedAt = performance.now()

      setTimeout(() => gen === this.generation && resolveDone(), REVEAL * 1000)
      setTimeout(() => {
        if (gen !== this.generation) return
        this.promoteTarget()
        this.startedAt = -1
      }, DURATION * 1000)
    })()
    // If loading fails, fall back to showing the image directly.
    started.catch(() => resolveDone())
    return { started, done }
  }

  /** Makes the current target the source of the next morph. */
  private promoteTarget() {
    const encoder = this.device.createCommandEncoder()
    encoder.copyTextureToTexture({ texture: this.toTex }, { texture: this.fromTex }, [N, N])
    this.device.queue.submit([encoder.finish()])
    this.hasFrom = true
  }

  private seed() {
    this.device.queue.writeBuffer(this.seedParams, 0, new Float32Array([this.hasFrom ? 1 : 0, Math.floor(Math.random() * COUNT), 0, 0]))
    const encoder = this.device.createCommandEncoder()
    const pass = encoder.beginComputePass()
    pass.setPipeline(this.seedPipeline)
    pass.setBindGroup(
      0,
      this.device.createBindGroup({
        layout: this.seedPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.fromTex.createView() },
          { binding: 1, resource: this.toTex.createView() },
          { binding: 2, resource: { buffer: this.particles } },
          { binding: 3, resource: { buffer: this.seedParams } },
        ],
      }),
    )
    pass.dispatchWorkgroups(N / 8, N / 8)
    pass.end()
    this.device.queue.submit([encoder.finish()])
  }

  /** Draws the particles additively into an open render pass (flat device space). */
  draw(
    pass: GPURenderPassEncoder,
    rect: [number, number, number, number],
    res: [number, number],
    dpr: number,
    accent: [number, number, number],
  ) {
    if (!this.active) return
    const t = (performance.now() - this.startedAt) / 1000
    this.device.queue.writeBuffer(this.drawParams, 0, new Float32Array([...rect, ...res, dpr, t, ...accent, 1]))
    pass.setPipeline(this.drawPipeline)
    pass.setBindGroup(
      0,
      this.device.createBindGroup({
        layout: this.drawPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.particles } },
          { binding: 1, resource: { buffer: this.drawParams } },
        ],
      }),
    )
    pass.draw(6, COUNT)
  }

  destroy() {
    this.fromTex.destroy()
    this.toTex.destroy()
    this.particles.destroy()
  }
}
