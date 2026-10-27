import bloomWGSL from './shaders/bloom.wgsl?raw'

const FORMAT: GPUTextureFormat = 'rgba16float'
const LEVELS = 5

/**
 * Dual-filter bloom: a bright pass into half resolution, a chain of 2x downsamples,
 * then tent upsamples added back level by level. `output` holds the result at half
 * the source resolution.
 */
export class Bloom {
  private device: GPUDevice
  private sampler: GPUSampler
  private prefilter: GPURenderPipeline
  private down: GPURenderPipeline
  private up: GPURenderPipeline
  private levels: GPUTexture[] = []
  private passes: { pipeline: GPURenderPipeline; target: GPUTextureView; bindGroup: GPUBindGroup; load: boolean }[] = []

  constructor(device: GPUDevice) {
    this.device = device
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' })
    const module = device.createShaderModule({ label: 'bloom', code: bloomWGSL })
    const pipeline = (entryPoint: string, additive: boolean) =>
      device.createRenderPipeline({
        label: `bloom-${entryPoint}`,
        layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        fragment: {
          module,
          entryPoint,
          targets: [
            {
              format: FORMAT,
              blend: additive
                ? {
                    color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
                    alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
                  }
                : undefined,
            },
          ],
        },
        primitive: { topology: 'triangle-list' },
      })
    this.prefilter = pipeline('fsPrefilter', false)
    this.down = pipeline('fsDown', false)
    this.up = pipeline('fsUp', true)
  }

  get output() {
    return this.levels[0]
  }

  /** (Re)creates the mip chain for a source texture; call whenever the source changes. */
  resize(source: GPUTexture) {
    this.levels.forEach((t) => t.destroy())
    this.levels = []
    let w = source.width
    let h = source.height
    for (let i = 0; i < LEVELS; i++) {
      w = Math.max(1, Math.floor(w / 2))
      h = Math.max(1, Math.floor(h / 2))
      this.levels.push(
        this.device.createTexture({
          label: `bloom-${i}`,
          size: [w, h],
          format: FORMAT,
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
        }),
      )
    }

    const bind = (pipeline: GPURenderPipeline, src: GPUTexture) =>
      this.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.sampler },
          { binding: 1, resource: src.createView() },
        ],
      })
    const L = this.levels
    this.passes = [{ pipeline: this.prefilter, target: L[0].createView(), bindGroup: bind(this.prefilter, source), load: false }]
    for (let i = 1; i < LEVELS; i++) {
      this.passes.push({ pipeline: this.down, target: L[i].createView(), bindGroup: bind(this.down, L[i - 1]), load: false })
    }
    for (let i = LEVELS - 1; i > 0; i--) {
      this.passes.push({ pipeline: this.up, target: L[i - 1].createView(), bindGroup: bind(this.up, L[i]), load: true })
    }
  }

  encode(encoder: GPUCommandEncoder) {
    for (const p of this.passes) {
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: p.target,
            loadOp: p.load ? 'load' : 'clear',
            storeOp: 'store',
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
          },
        ],
      })
      pass.setPipeline(p.pipeline)
      pass.setBindGroup(0, p.bindGroup)
      pass.draw(3)
      pass.end()
    }
  }

  destroy() {
    this.levels.forEach((t) => t.destroy())
  }
}
