import { fx } from './fxStore'

// Plays a Pokémon cry through Web Audio and publishes its loudness envelope to
// `fx.voice` every frame, so the shader can pulse the lens in sync.
//
// Cries are heavily compressed (RMS mostly 0.15-0.5), so a fixed gain would pin the
// light at full. Instead the RMS envelope is precomputed per cry, normalized to its
// own peak and contrast-expanded.

const WINDOW = 512
const CONTRAST = 1.8

interface Cry {
  buffer: AudioBuffer
  envelope: Float32Array
}

let ctx: AudioContext | null = null
let current: AudioBufferSourceNode | null = null
let raf = 0
const cache = new Map<string, Promise<Cry>>()

function envelopeOf(buffer: AudioBuffer) {
  const data = buffer.getChannelData(0)
  const env = new Float32Array(Math.ceil(data.length / WINDOW))
  let peak = 1e-6
  for (let w = 0; w < env.length; w++) {
    let sum = 0
    const end = Math.min(data.length, (w + 1) * WINDOW)
    for (let i = w * WINDOW; i < end; i++) sum += data[i] * data[i]
    env[w] = Math.sqrt(sum / (end - w * WINDOW))
    peak = Math.max(peak, env[w])
  }
  for (let w = 0; w < env.length; w++) env[w] = Math.pow(env[w] / peak, CONTRAST)
  return env
}

function load(url: string, audio: AudioContext) {
  let p = cache.get(url)
  if (!p) {
    p = fetch(url)
      .then((r) => r.arrayBuffer())
      .then((data) => audio.decodeAudioData(data))
      .then((buffer) => ({ buffer, envelope: envelopeOf(buffer) }))
    p.catch(() => cache.delete(url))
    cache.set(url, p)
  }
  return p
}

export async function playCry(url: string) {
  ctx ??= new AudioContext()
  const audio = ctx
  if (audio.state === 'suspended') await audio.resume()

  let cry: Cry
  try {
    cry = await load(url, audio)
  } catch {
    // Decoding failed (e.g. no Ogg support): play without the visualization.
    new Audio(url).play().catch(() => {})
    return
  }

  current?.stop()
  const source = audio.createBufferSource()
  source.buffer = cry.buffer
  source.connect(audio.destination)
  current = source
  const startedAt = audio.currentTime
  const windowSec = WINDOW / cry.buffer.sampleRate

  cancelAnimationFrame(raf)
  const tick = () => {
    const w = Math.floor((audio.currentTime - startedAt) / windowSec)
    const playing = current === source && w < cry.envelope.length
    const target = playing ? cry.envelope[Math.max(0, w)] : 0
    // Fast attack, slower release so the light follows syllables without strobing.
    const k = target > fx.voice ? 0.6 : 0.2
    fx.voice += (target - fx.voice) * k
    if (playing || fx.voice > 0.002) raf = requestAnimationFrame(tick)
    else fx.voice = 0
  }
  source.onended = () => {
    if (current === source) current = null
  }
  source.start()
  raf = requestAnimationFrame(tick)
}
