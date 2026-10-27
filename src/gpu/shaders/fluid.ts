// Stable-fluids (Stam) compute passes. Grid units: velocity is in cells / second.
// Each pass is its own module so `layout: 'auto'` stays unambiguous.

const header = /* wgsl */ `
struct Params {
  size: vec2f,
  texel: vec2f,
  dt: f32,
  dissipation: f32,
  curlStrength: f32,
  _pad: f32,
};
@group(0) @binding(0) var<uniform> P: Params;

fn clampCoord(c: vec2i) -> vec2i {
  return clamp(c, vec2i(0), vec2i(P.size) - 1);
}
`

export const advectWGSL = header + /* wgsl */ `
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var vel: texture_2d<f32>;
@group(0) @binding(3) var src: texture_2d<f32>;
@group(0) @binding(4) var dst: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (any(vec2f(id.xy) >= P.size)) { return; }
  let uv = (vec2f(id.xy) + 0.5) * P.texel;
  let v = textureSampleLevel(vel, samp, uv, 0.0).xy;
  let back = uv - P.dt * v * P.texel;
  let decay = 1.0 / (1.0 + P.dissipation * P.dt);
  textureStore(dst, id.xy, textureSampleLevel(src, samp, back, 0.0) * decay);
}
`

export const splatWGSL = /* wgsl */ `
struct Splats {
  info: vec4f,              // count, aspect, _, _
  pts: array<vec4f, 8>,     // uv.xy, radius, _
  vals: array<vec4f, 8>,
};
@group(0) @binding(0) var<uniform> S: Splats;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var dst: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = vec2u(textureDimensions(src));
  if (any(id.xy >= size)) { return; }
  let uv = (vec2f(id.xy) + 0.5) / vec2f(size);
  var c = textureLoad(src, id.xy, 0);
  let n = u32(S.info.x);
  for (var i = 0u; i < n; i++) {
    var d = uv - S.pts[i].xy;
    d.x *= S.info.y;
    c += S.vals[i] * exp(-dot(d, d) / S.pts[i].z);
  }
  textureStore(dst, id.xy, c);
}
`

export const curlWGSL = header + /* wgsl */ `
@group(0) @binding(1) var vel: texture_2d<f32>;
@group(0) @binding(2) var dst: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (any(vec2f(id.xy) >= P.size)) { return; }
  let c = vec2i(id.xy);
  let l = textureLoad(vel, clampCoord(c - vec2i(1, 0)), 0).y;
  let r = textureLoad(vel, clampCoord(c + vec2i(1, 0)), 0).y;
  let b = textureLoad(vel, clampCoord(c - vec2i(0, 1)), 0).x;
  let t = textureLoad(vel, clampCoord(c + vec2i(0, 1)), 0).x;
  textureStore(dst, id.xy, vec4f(0.5 * ((r - l) - (t - b)), 0.0, 0.0, 1.0));
}
`

export const vorticityWGSL = header + /* wgsl */ `
@group(0) @binding(1) var vel: texture_2d<f32>;
@group(0) @binding(2) var curl: texture_2d<f32>;
@group(0) @binding(3) var dst: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (any(vec2f(id.xy) >= P.size)) { return; }
  let c = vec2i(id.xy);
  let l = textureLoad(curl, clampCoord(c - vec2i(1, 0)), 0).x;
  let r = textureLoad(curl, clampCoord(c + vec2i(1, 0)), 0).x;
  let b = textureLoad(curl, clampCoord(c - vec2i(0, 1)), 0).x;
  let t = textureLoad(curl, clampCoord(c + vec2i(0, 1)), 0).x;
  let w = textureLoad(curl, c, 0).x;
  var f = vec2f(abs(t) - abs(b), abs(r) - abs(l));
  f = f / (length(f) + 1e-5) * P.curlStrength * w * vec2f(1.0, -1.0);
  let v = textureLoad(vel, c, 0).xy + f * P.dt;
  textureStore(dst, id.xy, vec4f(clamp(v, vec2f(-2000.0), vec2f(2000.0)), 0.0, 1.0));
}
`

export const divergenceWGSL = header + /* wgsl */ `
@group(0) @binding(1) var vel: texture_2d<f32>;
@group(0) @binding(2) var dst: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (any(vec2f(id.xy) >= P.size)) { return; }
  let c = vec2i(id.xy);
  let hi = vec2i(P.size) - 1;
  var l = textureLoad(vel, clampCoord(c - vec2i(1, 0)), 0).x;
  var r = textureLoad(vel, clampCoord(c + vec2i(1, 0)), 0).x;
  var b = textureLoad(vel, clampCoord(c - vec2i(0, 1)), 0).y;
  var t = textureLoad(vel, clampCoord(c + vec2i(0, 1)), 0).y;
  let v = textureLoad(vel, c, 0).xy;
  // Free-slip walls: reflect the normal component at the borders.
  if (c.x == 0) { l = -v.x; }
  if (c.x == hi.x) { r = -v.x; }
  if (c.y == 0) { b = -v.y; }
  if (c.y == hi.y) { t = -v.y; }
  textureStore(dst, id.xy, vec4f(0.5 * (r - l + t - b), 0.0, 0.0, 1.0));
}
`

export const pressureWGSL = header + /* wgsl */ `
@group(0) @binding(1) var pressure: texture_2d<f32>;
@group(0) @binding(2) var divergence: texture_2d<f32>;
@group(0) @binding(3) var dst: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (any(vec2f(id.xy) >= P.size)) { return; }
  let c = vec2i(id.xy);
  let l = textureLoad(pressure, clampCoord(c - vec2i(1, 0)), 0).x;
  let r = textureLoad(pressure, clampCoord(c + vec2i(1, 0)), 0).x;
  let b = textureLoad(pressure, clampCoord(c - vec2i(0, 1)), 0).x;
  let t = textureLoad(pressure, clampCoord(c + vec2i(0, 1)), 0).x;
  let d = textureLoad(divergence, c, 0).x;
  textureStore(dst, id.xy, vec4f((l + r + b + t - d) * 0.25, 0.0, 0.0, 1.0));
}
`

export const gradientWGSL = header + /* wgsl */ `
@group(0) @binding(1) var pressure: texture_2d<f32>;
@group(0) @binding(2) var vel: texture_2d<f32>;
@group(0) @binding(3) var dst: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (any(vec2f(id.xy) >= P.size)) { return; }
  let c = vec2i(id.xy);
  let l = textureLoad(pressure, clampCoord(c - vec2i(1, 0)), 0).x;
  let r = textureLoad(pressure, clampCoord(c + vec2i(1, 0)), 0).x;
  let b = textureLoad(pressure, clampCoord(c - vec2i(0, 1)), 0).x;
  let t = textureLoad(pressure, clampCoord(c + vec2i(0, 1)), 0).x;
  let v = textureLoad(vel, c, 0).xy - 0.5 * vec2f(r - l, t - b);
  textureStore(dst, id.xy, vec4f(v, 0.0, 1.0));
}
`

/** Fills a texture with a constant (used to fade pressure between frames). */
export const scaleWGSL = header + /* wgsl */ `
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var dst: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (any(vec2f(id.xy) >= P.size)) { return; }
  textureStore(dst, id.xy, textureLoad(src, id.xy, 0) * P.dissipation);
}
`
