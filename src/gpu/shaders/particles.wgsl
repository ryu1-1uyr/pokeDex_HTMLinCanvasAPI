// Artwork morph, step 2: the previous artwork dissolves into particles that swirl and
// re-assemble into the next one, top to bottom like a scan. Positions are computed
// analytically from the elapsed time, so there is no per-frame simulation state.

struct Particle {
  src: vec4f,    // uv.xy, alpha, random
  dst: vec4f,    // uv.xy, alpha, random
  cFrom: vec4f,
  cTo: vec4f,
};

struct DrawParams {
  rect: vec4f,     // artwork rect in flat CSS px
  res: vec2f,
  dpr: f32,
  t: f32,          // seconds since the morph started
  accent: vec4f,
};


@group(0) @binding(0) var<storage, read> parts: array<Particle>;
@group(0) @binding(1) var<uniform> D: DrawParams;

/** Morph timing (seconds). Keep in sync with ArtMorph.ts. */
const START = 0.12;
const SCAN = 0.55;
const FLIGHT = 0.7;
const END = 1.45;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) local: vec2f,
  @location(1) color: vec4f,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  let p = parts[ii];
  let corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
  );
  let corner = corners[vi];

  // Re-assemble top to bottom, with a little per-particle scatter in timing.
  let delay = START + p.dst.y * SCAN + p.src.w * 0.12;
  let lt = clamp((D.t - delay) / FLIGHT, 0.0, 1.0);
  let e = lt * lt * (3.0 - 2.0 * lt);
  let mid = sin(lt * 3.14159265);

  // Swirl: bow the path sideways, direction and strength per particle.
  let travel = p.dst.xy - p.src.xy;
  let perp = normalize(vec2f(-travel.y, travel.x) + 1e-4);
  let bow = perp * mid * (0.1 + 0.25 * p.dst.w) * select(-1.0, 1.0, p.src.w > 0.5);
  let uv = mix(p.src.xy, p.dst.xy, e) + bow;

  var alpha = mix(p.src.z, p.dst.z, e);
  // Hand over to the real <img> at the end.
  alpha *= 1.0 - smoothstep(END - 0.3, END, D.t);
  // Thin out mid-flight so overlapping additive particles don't blow out to white.
  alpha *= 1.0 - mid * 0.7;

  // In flight, particles glow in the UI's cyan; at rest they keep the artwork colors.
  let base = mix(p.cFrom.rgb, p.cTo.rgb, e);
  let tint = mix(vec3f(0.45, 1.0, 0.92), D.accent.rgb, 0.25);
  // HDR target: overlapping additive particles already sum past 1 and bloom,
  // so individual particles stay close to their base brightness.
  let color = mix(base, tint, mid * 0.85) * (1.0 + mid * 0.25);

  let size = 1.1 + mid * 1.4;
  let css = D.rect.xy + uv * D.rect.zw + corner * size;
  let ndc = css / D.res * 2.0 - 1.0;

  var o: VOut;
  o.pos = vec4f(ndc.x, -ndc.y, 0.0, 1.0);
  o.local = corner;
  o.color = vec4f(color, alpha);
  return o;
}

@fragment
fn fs(in: VOut) -> @location(0) vec4f {
  let a = smoothstep(1.0, 0.2, length(in.local)) * in.color.a;
  // Additive, premultiplied
  return vec4f(in.color.rgb * a, a);
}
