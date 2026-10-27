// HTML-in-Canvas only: composes the root DOM snapshot with the per-screen panel
// snapshots (nested drawables) into one flat-space DOM texture. Each panel can be
// lifted toward the viewer; `toPanel` is the exact homography from a flat-space
// point to the point on the lifted panel plane that projects onto the same pixel,
// so what is drawn matches the hit-testing geometry given to the browser.

struct Panel {
  rect: vec4f,                  // layout rect in CSS px
  toPanel: array<vec4f, 3>,     // rows of the 3x3 homography flat -> panel plane
  info: vec4f,                  // lift 0..1, dim 0..1, _, _
};

struct C {
  res: vec2f,
  dpr: f32,
  count: f32,
  panels: array<Panel, 3>,
};

@group(0) @binding(0) var<uniform> c: C;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var rootTex: texture_2d<f32>;
@group(0) @binding(3) var panel0: texture_2d<f32>;
@group(0) @binding(4) var panel1: texture_2d<f32>;
@group(0) @binding(5) var panel2: texture_2d<f32>;

/** Shadow of a lifted panel: offset away from the top-left key light, softened. */
const SHADOW_OFFSET = vec2f(7.0, 10.0);
const SHADOW_ALPHA = 0.5;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

fn project(k: u32, p: vec2f) -> vec2f {
  let h = c.panels[k].toPanel;
  let v = vec3f(p, 1.0);
  let q = vec3f(dot(h[0].xyz, v), dot(h[1].xyz, v), dot(h[2].xyz, v));
  return q.xy / q.z;
}

fn panelSample(t: texture_2d<f32>, k: u32, p: vec2f) -> vec4f {
  let r = c.panels[k].rect;
  let uv = (project(k, p) - r.xy) / r.zw;
  if (any(uv < vec2f(0.0)) || any(uv > vec2f(1.0))) { return vec4f(0.0); }
  return textureSampleLevel(t, samp, uv, 0.0);
}

fn panelAt(k: u32, p: vec2f) -> vec4f {
  switch (k) {
    case 0u: { return panelSample(panel0, 0u, p); }
    case 1u: { return panelSample(panel1, 1u, p); }
    default: { return panelSample(panel2, 2u, p); }
  }
}

// Straight-alpha "over".
fn over(top: vec4f, bottom: vec4f) -> vec4f {
  let a = top.a + bottom.a * (1.0 - top.a);
  if (a <= 1e-5) { return vec4f(0.0); }
  return vec4f((top.rgb * top.a + bottom.rgb * bottom.a * (1.0 - top.a)) / a, a);
}

@fragment
fn fs(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let p = frag.xy / c.dpr;
  var out = vec4f(0.0);
  let n = u32(c.count);

  for (var k = 0u; k < n; k++) {
    let lift = c.panels[k].info.x;
    // Soft drop shadow on the backplane under a lifted panel (black, straight alpha).
    if (lift > 0.01) {
      let o = SHADOW_OFFSET * lift;
      var a = 0.0;
      a += panelAt(k, p - o + vec2f(-2.0, -2.0)).a;
      a += panelAt(k, p - o + vec2f(2.0, -2.0)).a;
      a += panelAt(k, p - o + vec2f(-2.0, 2.0)).a;
      a += panelAt(k, p - o + vec2f(2.0, 2.0)).a;
      out = over(vec4f(0.0, 0.0, 0.0, a * 0.25 * SHADOW_ALPHA * lift), out);
    }
    var s = panelAt(k, p);
    // Panels that are not in focus recede a little; the lifted one brightens slightly.
    s = vec4f(s.rgb * (1.0 - c.panels[k].info.y * 0.3) * (1.0 + lift * 0.12), s.a);
    out = over(s, out);
  }

  return over(textureSampleLevel(rootTex, samp, p * c.dpr / vec2f(textureDimensions(rootTex)), 0.0), out);
}
