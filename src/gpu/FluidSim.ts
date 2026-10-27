import { MAX_SPLATS, type Splat } from '../fx/fxStore'
import {
  advectWGSL,
  curlWGSL,
  divergenceWGSL,
  gradientWGSL,
  pressureWGSL,
  scaleWGSL,
  splatWGSL,
  vorticityWGSL,
} from './shaders/fluid'

const FORMAT: GPUTextureFormat = 'rgba16float'
const PRESSURE_ITERATIONS = 24
/** Simulation cells per CSS pixel. */
const SIM_SCALE = 0.25

class PingPong {
  read: GPUTexture
  write: GPUTexture
  constructor(device: GPUDevice, w: number, h: number, label: string) {
    const make = (suffix: string) =>
      device.createTexture({
        label: label + suffix,
        size: [w, h],
        format: FORMAT,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
      })
    this.read = make('-a')
    this.write = make('-b')
  }
  swap() {
    ;[this.read, this.write] = [this.write, this.read]
  }
  destroy() {
    this.read.destroy()
    this.write.destroy()
  }
}

export class FluidSim {
  private device: GPUDevice
  private pipelines: Record<string, GPUComputePipeline>
  private sampler: GPUSampler
  private paramsVel: GPUBuffer
  private paramsDye: GPUBuffer
  private paramsPressure: GPUBuffer
  private splatVel: GPUBuffer
  private splatDye: GPUBuffer

  width = 0
  height = 0
  private cssW = 1
  private cssH = 1
  velocity!: PingPong
  dye!: PingPong
  private pressure!: PingPong
  private divergence!: GPUTexture
  private curl!: GPUTexture

  constructor(device: GPUDevice) {
    this.device = device
    const make = (code: string, label: string) =>
      device.createComputePipeline({
        label,
        layout: 'auto',
        compute: { module: device.createShaderModule({ label, code }), entryPoint: 'main' },
      })
    this.pipelines = {
      advect: make(advectWGSL, 'advect'),
      splat: make(splatWGSL, 'splat'),
      curl: make(curlWGSL, 'curl'),
      vorticity: make(vorticityWGSL, 'vorticity'),
      divergence: make(divergenceWGSL, 'divergence'),
      pressure: make(pressureWGSL, 'pressure'),
      gradient: make(gradientWGSL, 'gradient'),
      scale: make(scaleWGSL, 'scale'),
    }
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' })
    const ubo = (size: number) =>
      device.createBuffer({ size, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    this.paramsVel = ubo(32)
    this.paramsDye = ubo(32)
    this.paramsPressure = ubo(32)
    this.splatVel = ubo(16 + 16 * MAX_SPLATS * 2)
    this.splatDye = ubo(16 + 16 * MAX_SPLATS * 2)
  }

  resize(cssW: number, cssH: number) {
    const w = Math.max(16, Math.round(cssW * SIM_SCALE))
    const h = Math.max(16, Math.round(cssH * SIM_SCALE))
    this.cssW = cssW
    this.cssH = cssH
    if (w === this.width && h === this.height) return
    this.destroy()
    this.width = w
    this.height = h
    this.velocity = new PingPong(this.device, w, h, 'velocity')
    this.dye = new PingPong(this.device, w, h, 'dye')
    this.pressure = new PingPong(this.device, w, h, 'pressure')
    const single = (label: string) =>
      this.device.createTexture({
        label,
        size: [w, h],
        format: FORMAT,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
      })
    this.divergence = single('divergence')
    this.curl = single('curl')
  }

  destroy() {
    this.velocity?.destroy()
    this.dye?.destroy()
    this.pressure?.destroy()
    this.divergence?.destroy()
    this.curl?.destroy()
  }

  private writeParams(buf: GPUBuffer, dt: number, dissipation: number, curlStrength = 0) {
    this.device.queue.writeBuffer(
      buf,
      0,
      new Float32Array([this.width, this.height, 1 / this.width, 1 / this.height, dt, dissipation, curlStrength, 0]),
    )
  }

  private writeSplats(splats: Splat[]) {
    const n = Math.min(splats.length, MAX_SPLATS)
    const vel = new Float32Array(4 + MAX_SPLATS * 8)
    const dye = new Float32Array(4 + MAX_SPLATS * 8)
    const aspect = this.width / this.height
    // CSS px/s -> cells/s
    const k = SIM_SCALE
    vel.set([n, aspect, 0, 0], 0)
    dye.set([n, aspect, 0, 0], 0)
    for (let i = 0; i < n; i++) {
      const s = splats[i]
      const pt = [s.x / this.cssW, s.y / this.cssH, s.radius, 0]
      vel.set(pt, 4 + i * 4)
      dye.set(pt, 4 + i * 4)
      vel.set([s.vx * k, s.vy * k, 0, 0], 4 + MAX_SPLATS * 4 + i * 4)
      dye.set([...s.color, 1], 4 + MAX_SPLATS * 4 + i * 4)
    }
    this.device.queue.writeBuffer(this.splatVel, 0, vel)
    this.device.queue.writeBuffer(this.splatDye, 0, dye)
    return n
  }

  private dispatch(pass: GPUComputePassEncoder, name: string, entries: (GPUBuffer | GPUSampler | GPUTexture)[]) {
    const pipeline = this.pipelines[name]
    const bindGroup = this.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: entries.map((r, binding) => ({
        binding,
        resource:
          r instanceof GPUBuffer ? { buffer: r } : r instanceof GPUTexture ? r.createView() : r,
      })),
    })
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, bindGroup)
    pass.dispatchWorkgroups(Math.ceil(this.width / 8), Math.ceil(this.height / 8))
  }

  step(encoder: GPUCommandEncoder, dt: number, splats: Splat[]) {
    this.writeParams(this.paramsVel, dt, 0.35, 28)
    this.writeParams(this.paramsDye, dt, 0.45)
    this.writeParams(this.paramsPressure, dt, 0.8)
    const nSplats = this.writeSplats(splats)

    const pass = encoder.beginComputePass({ label: 'fluid' })
    const { velocity: vel, dye, pressure } = this

    if (nSplats > 0) {
      this.dispatch(pass, 'splat', [this.splatVel, vel.read, vel.write])
      vel.swap()
      this.dispatch(pass, 'splat', [this.splatDye, dye.read, dye.write])
      dye.swap()
    }

    this.dispatch(pass, 'curl', [this.paramsVel, vel.read, this.curl])
    this.dispatch(pass, 'vorticity', [this.paramsVel, vel.read, this.curl, vel.write])
    vel.swap()

    this.dispatch(pass, 'divergence', [this.paramsVel, vel.read, this.divergence])
    this.dispatch(pass, 'scale', [this.paramsPressure, pressure.read, pressure.write])
    pressure.swap()
    for (let i = 0; i < PRESSURE_ITERATIONS; i++) {
      this.dispatch(pass, 'pressure', [this.paramsVel, pressure.read, this.divergence, pressure.write])
      pressure.swap()
    }
    this.dispatch(pass, 'gradient', [this.paramsVel, pressure.read, vel.read, vel.write])
    vel.swap()

    this.dispatch(pass, 'advect', [this.paramsVel, this.sampler, vel.read, vel.read, vel.write])
    vel.swap()
    this.dispatch(pass, 'advect', [this.paramsDye, this.sampler, vel.read, dye.read, dye.write])
    dye.swap()

    pass.end()
  }
}
