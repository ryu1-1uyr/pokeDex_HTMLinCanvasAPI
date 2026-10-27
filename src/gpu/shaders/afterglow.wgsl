// Phosphor persistence for the DOM texture: each pixel keeps the brighter of the
// current DOM and its own previous value decayed over time, like a CRT's afterglow.

@group(0) @binding(0) var current: texture_2d<f32>;
@group(0) @binding(1) var previous: texture_2d<f32>;
@group(0) @binding(2) var<uniform> decay: vec4f;  // x: per-frame decay factor

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let c = vec2i(frag.xy);
  return max(textureLoad(current, c, 0), textureLoad(previous, c, 0) * decay.x);
}
