import afterglowWGSL from './shaders/afterglow.wgsl?raw'

/** 16-bit float so slow decay reaches zero instead of stalling at 8-bit quantization steps. */
const FORMAT: GPUTextureFormat = 'rgba16float'
/** Seconds for the afterglow to fall to ~37%. */
const TAU = 0.15

/**
 * CRT-style phosphor persistence of the DOM texture (HTML-in-Canvas mode only).
 * Ping-pongs between two targets; `output` is the latest persisted image.
 */
export class Afterglow {
  private device: GPUDevice
  private pipeline: GPURenderPipeline
  private uniform: GPUBuffer
  private targets: GPUTexture[] = []
  private bindGroups: GPUBindGroup[] = []
  private source: GPUTexture | null = null
  private index = 0

  constructor(device: GPUDevice) {
    this.device = device
    const module = device.createShaderModule({ label: 'afterglow', code: afterglowWGSL })
    this.pipeline = device.createRenderPipeline({
      label: 'afterglow',
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: FORMAT }] },
      primitive: { topology: 'triangle-list' },
    })
    this.uniform = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    this.resize(1, 1)
  }

  get output() {
    return this.targets[this.index]
  }

  resize(w: number, h: number) {
    this.targets.forEach((t) => t.destroy())
    const make = (i: number) =>
      this.device.createTexture({
        label: `afterglow-${i}`,
        size: [w, h],
        format: FORMAT,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
      })
    this.targets = [make(0), make(1)]
    this.bindGroups = []
    this.source = null
    this.index = 0
  }

  /** Persists `source` (the DOM texture) into the next target. */
  encode(encoder: GPUCommandEncoder, source: GPUTexture, dt: number) {
    if (source !== this.source) {
      // Bind group i reads target i as "previous" and writes the other one.
      this.source = source
      this.bindGroups = this.targets.map((prev) =>
        this.device.createBindGroup({
          layout: this.pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: source.createView() },
            { binding: 1, resource: prev.createView() },
            { binding: 2, resource: { buffer: this.uniform } },
          ],
        }),
      )
    }
    this.device.queue.writeBuffer(this.uniform, 0, new Float32Array([Math.exp(-dt / TAU), 0, 0, 0]))
    const next = 1 - this.index
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: this.targets[next].createView(), loadOp: 'clear', storeOp: 'store' }],
    })
    pass.setPipeline(this.pipeline)
    pass.setBindGroup(0, this.bindGroups[this.index])
    pass.draw(3)
    pass.end()
    this.index = next
  }

  destroy() {
    this.targets.forEach((t) => t.destroy())
  }
}
