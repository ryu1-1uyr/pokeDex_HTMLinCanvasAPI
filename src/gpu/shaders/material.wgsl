// Bakes a tileable "injection-molded plastic" detail texture.
//   r: orange-peel micro height
//   g: metallic flake sparkle mask
//   b: fine scratches (anisotropic)
//   a: large-scale smudge / wear

@group(0) @binding(0) var dst: texture_storage_2d<rgba8unorm, write>;

const SIZE = 1024.0;

fn hash2(p: vec2f) -> vec2f {
  var q = vec2f(dot(p, vec2f(127.1, 311.7)), dot(p, vec2f(269.5, 183.3)));
  return fract(sin(q) * 43758.5453) * 2.0 - 1.0;
}

fn hash1(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(12.9898, 78.233))) * 43758.5453);
}

// Periodic gradient noise: lattice wraps at `period` so the result tiles.
fn pnoise(p: vec2f, period: f32) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  let w = vec2f(period);
  let a = dot(hash2((i + vec2f(0, 0)) % w), f - vec2f(0, 0));
  let b = dot(hash2((i + vec2f(1, 0)) % w), f - vec2f(1, 0));
  let c = dot(hash2((i + vec2f(0, 1)) % w), f - vec2f(0, 1));
  let d = dot(hash2((i + vec2f(1, 1)) % w), f - vec2f(1, 1));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

fn fbm(uv: vec2f, basePeriod: f32, octaves: i32) -> f32 {
  var sum = 0.0;
  var amp = 0.5;
  var period = basePeriod;
  for (var i = 0; i < octaves; i++) {
    sum += amp * pnoise(uv * period, period);
    period *= 2.0;
    amp *= 0.5;
  }
  return sum;
}

// Sparse flakes: one candidate per cell, tiny bright dot.
fn flakes(uv: vec2f, cells: f32) -> f32 {
  let p = uv * cells;
  let i = floor(p);
  var best = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let cell = i + vec2f(f32(x), f32(y));
      let wrapped = (cell + cells) % cells;
      let o = hash2(wrapped) * 0.5 + 0.5;
      let d = length(p - (cell + o));
      let on = step(0.72, hash1(wrapped + 3.7));
      best = max(best, on * smoothstep(0.18, 0.0, d));
    }
  }
  return best;
}

// Short random scratches oriented mostly horizontally (like a pocket device rubbed in a bag).
fn scratches(uv: vec2f, cells: f32) -> f32 {
  let p = uv * cells;
  let i = floor(p);
  var s = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let cell = i + vec2f(f32(x), f32(y));
      let wrapped = (cell + cells) % cells;
      let h = hash2(wrapped);
      if (hash1(wrapped + 9.1) < 0.55) { continue; }
      let center = cell + 0.5 + h * 0.4;
      let ang = h.x * 0.6;
      let dir = vec2f(cos(ang), sin(ang));
      let len = 0.6 + 0.8 * abs(h.y);
      let q = p - center;
      let t = clamp(dot(q, dir), -len, len);
      let d = length(q - dir * t);
      let fade = 1.0 - abs(t) / len;
      s = max(s, smoothstep(0.035, 0.0, d) * fade);
    }
  }
  return s;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (any(vec2f(id.xy) >= vec2f(SIZE))) { return; }
  let uv = (vec2f(id.xy) + 0.5) / SIZE;

  let peel = fbm(uv, 64.0, 4) * 0.5 + 0.5;
  let flake = flakes(uv, 180.0);
  let scr = scratches(uv, 14.0) * (0.5 + 0.5 * fbm(uv, 4.0, 2));
  let smudge = fbm(uv + 0.37, 3.0, 5) * 0.5 + 0.5;

  textureStore(dst, id.xy, vec4f(peel, flake, scr, smudge));
}
