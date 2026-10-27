// Screen pass: blurred grass-field backdrop + the tilted device.
// The flat device (composite.wgsl output) is mapped onto a perspective-projected plane
// via an inverse homography. The side walls are the extrusion of the device outline:
// for each pixel the depth along the wall is found by bisection, then lit as 3D.

struct S {
  res: vec2f,
  dpr: f32,
  time: f32,
  mouse: vec2f,
  _pad: vec2f,
  device: vec4f,    // flat device rect (x, y, w, h)
  shadow: vec4f,    // shadow offset xy, thickness, _
  hFront: array<vec4f, 3>,  // rows of inverse homography: screen -> flat (front face)
  hBack: array<vec4f, 3>,   // same for the back face
  hFwd: array<vec4f, 3>,    // rows of forward homography: flat (z = 0) -> screen
  zCol: vec4f,              // d(third column)/dz of the forward homography
  rot: array<vec4f, 3>,     // rows of the tilt rotation (object -> view)
};

@group(0) @binding(0) var<uniform> u: S;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var flatTex: texture_2d<f32>;

const DEVICE_RADIUS = 28.0;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

fn sdRoundBox(p: vec2f, b: vec2f, r: f32) -> f32 {
  let q = abs(p) - b + r;
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - r;
}

fn deviceSd(p: vec2f) -> f32 {
  let half = u.device.zw * 0.5;
  return sdRoundBox(p - (u.device.xy + half), half, DEVICE_RADIUS);
}

fn unproject(h: array<vec4f, 3>, s: vec2f) -> vec2f {
  let v = vec3f(s, 1.0);
  let q = vec3f(dot(h[0].xyz, v), dot(h[1].xyz, v), dot(h[2].xyz, v));
  return q.xy / q.z;
}

// Screen -> flat point on the plane at depth z (CSS z; negative is away from the viewer).
fn unprojectZ(z: f32, s: vec2f) -> vec2f {
  let a = u.hFwd[0].xyz + vec3f(0.0, 0.0, z * u.zCol.x);
  let b = u.hFwd[1].xyz + vec3f(0.0, 0.0, z * u.zCol.y);
  let c = u.hFwd[2].xyz + vec3f(0.0, 0.0, z * u.zCol.z);
  // Adjugate * (s, 1); the determinant cancels in the perspective divide.
  let q = cross(b, c) * s.x + cross(c, a) * s.y + cross(a, b);
  return q.xy / q.z;
}

fn rotN(n: vec3f) -> vec3f {
  return normalize(vec3f(dot(u.rot[0].xyz, n), dot(u.rot[1].xyz, n), dot(u.rot[2].xyz, n)));
}

// Lit side wall at the given depth / outline point.
fn sideWall(pm: vec2f, depth: f32) -> vec3f {
  let thickness = u.shadow.z;
  let e = 1.0;
  let g = normalize(vec2f(
    deviceSd(pm + vec2f(e, 0.0)) - deviceSd(pm - vec2f(e, 0.0)),
    deviceSd(pm + vec2f(0.0, e)) - deviceSd(pm - vec2f(0.0, e)),
  ) + 1e-5);
  // Slight roll-off toward the back edge so it doesn't end in a hard line.
  let back = smoothstep(thickness * 0.75, thickness, depth);
  let n = rotN(normalize(vec3f(g, -back * 0.8)));

  let key = normalize(vec3f(-0.5, -0.7, 0.8));
  let diffuse = max(dot(n, key), 0.0) * 0.8 + 0.12;
  let r = reflect(vec3f(0.0, 0.0, -1.0), n);
  let spec = pow(max(dot(r, key), 0.0), 40.0) * 0.6;
  // Glossy streak from the overhead softbox
  let env = smoothstep(0.2, 0.7, -r.y) * 0.25;

  var albedo = vec3f(0.62, 0.05, 0.08);
  // Clamshell parting line in the middle of the wall
  let seam = abs(depth - thickness * 0.5);
  albedo *= 1.0 - smoothstep(1.4, 0.4, seam) * 0.7;
  albedo *= select(1.0, 0.85, depth > thickness * 0.5);
  return albedo * diffuse + vec3f(spec + env * (1.0 - back));
}

fn hash11(x: f32) -> f32 {
  return fract(sin(x * 127.1) * 43758.5453);
}

fn hash21(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(12.9898, 78.233))) * 43758.5453);
}

// ---------------------------------------------------------------- grass field

fn groundLine(x: f32, baseY: f32, scale: f32, seed: f32) -> f32 {
  return baseY + sin(x * 0.004 + seed) * 18.0 * scale + sin(x * 0.011 + seed * 2.0) * 8.0 * scale;
}

// Coverage of one layer of grass blades. `blur` widens every edge to fake depth of field.
fn grassLayer(p: vec2f, baseY: f32, scale: f32, blur: f32, seed: f32) -> f32 {
  let w = 14.0 * scale;
  let i = floor(p.x / w);
  var cov = smoothstep(-blur, blur, p.y - groundLine(p.x, baseY, scale, seed));

  for (var k = -4; k <= 4; k++) {
    let cell = i + f32(k);
    let h1 = hash11(cell + seed * 17.3);
    let h2 = hash11(cell * 1.7 + seed);
    let h3 = hash11(cell * 2.3 + seed * 5.1);
    let bx = (cell + h1) * w;
    let gy = groundLine(bx, baseY, scale, seed);
    let height = (50.0 + 110.0 * h2) * scale;
    let tRaw = (gy - p.y) / height;
    if (tRaw < -0.05 || tRaw > 1.0 + blur / height) { continue; }
    let t = clamp(tRaw, 0.0, 1.0);
    let lean = (h3 - 0.5) * 0.5;
    let sway = sin(u.time * 1.2 + bx * 0.01 + seed) * 0.06 + sin(u.time * 2.3 + bx * 0.03) * 0.02;
    let cx = bx + (lean + sway) * height * t * t;
    let halfW = 4.5 * scale * (1.0 - t) + 0.3;
    let d = abs(p.x - cx) - halfW;
    let tip = smoothstep(1.0 + blur / height, 1.0 - blur / height, tRaw);
    cov = max(cov, smoothstep(blur, -blur, d) * tip);
  }
  return cov;
}

// Soft out-of-focus light discs floating above the field.
fn bokeh(p: vec2f) -> f32 {
  let cellSize = 110.0;
  let cell = floor(p / cellSize);
  var acc = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let c = cell + vec2f(f32(x), f32(y));
      let h = hash21(c);
      if (h < 0.55) { continue; }
      let center = (c + vec2f(hash21(c + 1.3), hash21(c + 7.1))) * cellSize;
      let r = 8.0 + 26.0 * hash21(c + 3.7);
      let d = length(p - center);
      acc += smoothstep(r, r - 6.0, d) * (0.5 + 0.5 * smoothstep(r - 6.0, r - 2.0, d)) * (h - 0.55);
    }
  }
  return acc;
}

fn background(s: vec2f) -> vec3f {
  let res = u.res;
  let par = (u.mouse - res * 0.5);
  let yn = s.y / res.y;

  // Sky: pale blue overhead fading to a warm haze at the horizon, with a soft sun.
  var col = mix(vec3f(0.55, 0.74, 0.9), vec3f(0.93, 0.92, 0.8), smoothstep(0.0, 0.55, yn));
  let sun = vec2f(res.x * 0.78, res.y * 0.12) - par * 0.01;
  col += vec3f(1.0, 0.9, 0.7) * exp(-length(s - sun) / 220.0) * 0.5;
  col += vec3f(1.0, 0.97, 0.88) * bokeh(s - par * 0.015) * 0.5 * (1.0 - smoothstep(0.3, 0.8, yn));

  // Layers back to front: further layers are hazier, smaller and shift less with the pointer.
  let l0 = grassLayer(s - par * 0.01, res.y * 0.48, 0.55, 4.0, 1.0);
  col = mix(col, vec3f(0.58, 0.74, 0.6), l0);
  let l1 = grassLayer(s - par * 0.02, res.y * 0.6, 0.8, 3.5, 2.0);
  col = mix(col, vec3f(0.38, 0.6, 0.35) * (0.9 + 0.15 * yn), l1);
  let l2 = grassLayer(s - par * 0.035, res.y * 0.74, 1.1, 3.0, 3.0);
  col = mix(col, vec3f(0.22, 0.44, 0.2), l2);
  let l3 = grassLayer(s - par * 0.06, res.y * 0.92, 1.7, 9.0, 4.0);
  col = mix(col, vec3f(0.1, 0.23, 0.09), l3);

  // Calm it down so the device stays the focus.
  let vig = length((s - res * 0.5) / res);
  col *= 0.82 * (1.0 - vig * 0.55);
  return col;
}

// ---------------------------------------------------------------- main

@fragment
fn fs(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let s = frag.xy / u.dpr;
  var col = background(s);

  // Soft drop shadow cast by the floating device (from its back silhouette).
  let ds = deviceSd(unproject(u.hBack, s - u.shadow.xy));
  col *= 1.0 - exp(-max(ds, 0.0) / 45.0) * 0.65;
  // Tight contact darkening right around the body
  col *= 1.0 - exp(-max(deviceSd(unproject(u.hBack, s)), 0.0) / 6.0) * 0.35;

  // Side walls: pixels inside the back silhouette but outside the front face.
  let backCov = smoothstep(0.75, -0.75, deviceSd(unproject(u.hBack, s)));
  let frontD = deviceSd(unproject(u.hFront, s));
  if (backCov > 0.0 && frontD > -1.0) {
    var lo = 0.0;
    var hi = u.shadow.z;
    for (var i = 0; i < 10; i++) {
      let mid = (lo + hi) * 0.5;
      if (deviceSd(unprojectZ(-mid, s)) > 0.0) { lo = mid; } else { hi = mid; }
    }
    let depth = (lo + hi) * 0.5;
    col = mix(col, sideWall(unprojectZ(-depth, s), depth), backCov);
  }

  // Front face from the flat pass (premultiplied alpha).
  let pf = unproject(u.hFront, s);
  let front = textureSampleLevel(flatTex, samp, pf / u.res, 0.0);
  col = col * (1.0 - front.a) + front.rgb;

  // Grain to kill banding
  col += (hash21(frag.xy + fract(u.time) * 100.0) - 0.5) / 255.0 * 2.0;
  return vec4f(clamp(col, vec3f(0.0), vec3f(1.0)), 1.0);
}
