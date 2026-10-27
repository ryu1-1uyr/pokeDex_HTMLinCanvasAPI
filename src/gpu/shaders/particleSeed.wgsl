// Artwork morph, step 1: builds one particle per cell of the 128x128 artwork grid,
// pairing each source pixel of the previous artwork with a target pixel of the next.

const N = 128u;

struct Particle {
  src: vec4f,    // uv.xy, alpha, random
  dst: vec4f,    // uv.xy, alpha, random
  cFrom: vec4f,
  cTo: vec4f,
};

struct SeedParams {
  hasFrom: f32,
  seed: f32,
  _pad: vec2f,
};

@group(0) @binding(0) var fromTex: texture_2d<f32>;
@group(0) @binding(1) var toTex: texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> seedOut: array<Particle>;
@group(0) @binding(3) var<uniform> S: SeedParams;

fn hash1(n: u32) -> f32 {
  var x = n * 747796405u + 2891336453u;
  x = ((x >> ((x >> 28u) + 4u)) ^ x) * 277803737u;
  return f32((x >> 22u) ^ x) / 4294967295.0;
}

@compute @workgroup_size(8, 8)
fn seed(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= N || id.y >= N) { return; }
  let i = id.x + id.y * N;
  // Odd multiplier mod 2^14 is a bijection: every target cell gets exactly one particle.
  let j = (i * 7919u + u32(S.seed)) % (N * N);
  let fromCell = id.xy;
  let toCell = vec2u(j % N, j / N);

  let cf = textureLoad(fromTex, fromCell, 0) * S.hasFrom;
  let ct = textureLoad(toTex, toCell, 0);
  let r1 = hash1(i);
  let r2 = hash1(i + 91731u);
  let r3 = hash1(i + 52011u);

  var fromUv = (vec2f(fromCell) + 0.5) / f32(N);
  var toUv = (vec2f(toCell) + 0.5) / f32(N);
  let jitter = (vec2f(r1, r2) - 0.5);

  // Particles without a source pixel materialize out of noise near their target;
  // those without a target pixel drift away and fade.
  if (cf.a < 0.4) { fromUv = toUv + jitter * 0.6; }
  if (ct.a < 0.4) { toUv = fromUv + jitter * 0.5; }

  var p: Particle;
  p.src = vec4f(fromUv, select(0.0, 1.0, cf.a >= 0.4), r1);
  p.dst = vec4f(toUv, select(0.0, 1.0, ct.a >= 0.4), r3);
  // Textures are uploaded with straight (non-premultiplied) alpha.
  p.cFrom = vec4f(cf.rgb, 1.0);
  p.cTo = vec4f(ct.rgb, 1.0);
  seedOut[i] = p;
}
