// Dual-filter bloom over the HDR flat device texture.
//   fsPrefilter: soft-knee bright pass + first 2x downsample
//   fsDown:      2x downsample (5 taps)
//   fsUp:        2x upsample (tent, 8 taps), additively blended onto the larger level

@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var src: texture_2d<f32>;

const THRESHOLD = 0.85;
const KNEE = 0.35;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

fn uvAt(frag: vec4f) -> vec2f {
  // Output targets are exactly half/double the source, so derive UV from the source size.
  return frag.xy / (vec2f(textureDimensions(src)) * 0.5);
}

fn down(uv: vec2f) -> vec3f {
  let t = 1.0 / vec2f(textureDimensions(src));
  var c = textureSampleLevel(src, samp, uv, 0.0).rgb * 4.0;
  c += textureSampleLevel(src, samp, uv + vec2f(-t.x, -t.y), 0.0).rgb;
  c += textureSampleLevel(src, samp, uv + vec2f(t.x, -t.y), 0.0).rgb;
  c += textureSampleLevel(src, samp, uv + vec2f(-t.x, t.y), 0.0).rgb;
  c += textureSampleLevel(src, samp, uv + vec2f(t.x, t.y), 0.0).rgb;
  return c / 8.0;
}

@fragment
fn fsPrefilter(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let c = down(uvAt(frag));
  let b = max(c.r, max(c.g, c.b));
  // Soft knee: ramps in around the threshold instead of a hard cut.
  var soft = clamp(b - THRESHOLD + KNEE, 0.0, 2.0 * KNEE);
  soft = soft * soft / (4.0 * KNEE + 1e-4);
  let contrib = max(soft, b - THRESHOLD) / max(b, 1e-4);
  return vec4f(c * contrib, 1.0);
}

@fragment
fn fsDown(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  return vec4f(down(uvAt(frag)), 1.0);
}

@fragment
fn fsUp(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  // Target is twice the source here.
  let uv = frag.xy / (vec2f(textureDimensions(src)) * 2.0);
  let t = 1.0 / vec2f(textureDimensions(src));
  var c = textureSampleLevel(src, samp, uv + vec2f(-t.x * 2.0, 0.0), 0.0).rgb;
  c += textureSampleLevel(src, samp, uv + vec2f(t.x * 2.0, 0.0), 0.0).rgb;
  c += textureSampleLevel(src, samp, uv + vec2f(0.0, -t.y * 2.0), 0.0).rgb;
  c += textureSampleLevel(src, samp, uv + vec2f(0.0, t.y * 2.0), 0.0).rgb;
  c += textureSampleLevel(src, samp, uv + vec2f(-t.x, -t.y), 0.0).rgb * 2.0;
  c += textureSampleLevel(src, samp, uv + vec2f(t.x, -t.y), 0.0).rgb * 2.0;
  c += textureSampleLevel(src, samp, uv + vec2f(-t.x, t.y), 0.0).rgb * 2.0;
  c += textureSampleLevel(src, samp, uv + vec2f(t.x, t.y), 0.0).rgb * 2.0;
  return vec4f(c / 12.0, 1.0);
}
