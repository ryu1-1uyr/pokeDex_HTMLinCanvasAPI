// Flat device pass: procedural Pokédex shell + DOM texture + region materials.
// Renders the untilted device into an offscreen HDR texture (premultiplied alpha).
// Lit surfaces are tonemapped to [0, 1]; emissive parts (radar lines, lens, LEDs)
// are added afterwards and may exceed 1 so the bloom pass picks them up.
//
// scene.wgsl warps it into perspective over the background.
// All positions are CSS pixels (fragment position / dpr), origin top-left.

struct Region {
  rect: vec4f,    // x, y, w, h
  params: vec4f,  // kind, radius, color index, state (hover/active)
};

struct U {
  res: vec2f,
  dpr: f32,
  time: f32,
  mouse: vec2f,
  hasDom: f32,
  regionCount: f32,
  accent: vec4f,
  stats0: vec4f,
  stats1: vec4f,            // spd, spe, voice level (cry loudness), seconds since renderer start
  accent2: vec4f,
  rot: array<vec4f, 3>,     // rows of the device tilt rotation (object -> view)
  regions: array<Region, 32>,
};

@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var repSamp: sampler;
@group(0) @binding(3) var domTex: texture_2d<f32>;
@group(0) @binding(4) var matTex: texture_2d<f32>;

const PI = 3.14159265;
const K_SCREEN = 1.0;
const K_RADAR = 2.0;
const K_HOLO = 3.0;
const K_BUTTON = 4.0;
const K_LENS = 5.0;
const K_LED = 6.0;
const K_DEVICE = 7.0;
const DEVICE_RADIUS = 28.0;
const BEZEL = 12.0;
/** FUI ink: every line/label element shares this one color. */
const INK = vec3f(0.62, 1.0, 0.92);
/** Radius of the rounded outer rim of the shell. */
const RIM = 18.0;
/** How far the LCD content sits below the glass, and the (exaggerated) depth of its inner wall. */
const SCREEN_DEPTH = 10.0;
const WALL_DEPTH = 40.0;
/** Boot sequence: screen k powers on at BOOT_START + k * BOOT_STAGGER (keep in sync with dex.css). */
const BOOT_START = 0.35;
const BOOT_STAGGER = 0.25;
const BOOT_LEN = 0.55;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

// ---------------------------------------------------------------- helpers

fn sdRoundBox(p: vec2f, b: vec2f, r: f32) -> f32 {
  let q = abs(p) - b + r;
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - r;
}

fn rotN(n: vec3f) -> vec3f {
  return normalize(vec3f(dot(u.rot[0].xyz, n), dot(u.rot[1].xyz, n), dot(u.rot[2].xyz, n)));
}

// View direction expressed in the device's own (untilted) space: R^T * (0, 0, 1).
fn viewObj() -> vec3f {
  return vec3f(u.rot[0].z, u.rot[1].z, u.rot[2].z);
}

// Screen-space shift of a point lying `depth` px below the device surface.
fn parallax(depth: f32) -> vec2f {
  let v = viewObj();
  return -v.xy / max(v.z, 0.2) * depth;
}

fn regionSd(i: u32, p: vec2f) -> f32 {
  let r = u.regions[i];
  let half = r.rect.zw * 0.5;
  return sdRoundBox(p - (r.rect.xy + half), half, min(r.params.y, min(half.x, half.y)));
}

fn palette(i: f32) -> vec3f {
  switch (u32(i)) {
    case 1u: { return u.accent.rgb; }
    case 2u: { return vec3f(0.98, 0.78, 0.12); }   // yellow
    case 3u: { return vec3f(0.15, 0.55, 0.95); }   // blue
    case 4u: { return vec3f(0.25, 0.85, 0.35); }   // green
    case 5u: { return vec3f(0.95, 0.20, 0.18); }   // red
    default: { return vec3f(0.11, 0.11, 0.13); }   // charcoal
  }
}

// Rect of the device body (region kind 7); falls back to the full viewport.
var<private> gDevice: vec4f;

fn findDevice() -> vec4f {
  let n = u32(u.regionCount);
  for (var i = 0u; i < n; i++) {
    if (u.regions[i].params.x == K_DEVICE) { return u.regions[i].rect; }
  }
  return vec4f(0.0, 0.0, u.res);
}

fn deviceSd(p: vec2f) -> f32 {
  let half = gDevice.zw * 0.5;
  return sdRoundBox(p - (gDevice.xy + half), half, DEVICE_RADIUS);
}

fn aces(c: vec3f) -> vec3f {
  return clamp((c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14), vec3f(0.0), vec3f(1.0));
}

fn uvOf(p: vec2f) -> vec2f { return p / u.res; }

fn sampleMat(p: vec2f) -> vec4f {
  return textureSampleLevel(matTex, repSamp, p / 512.0, 0.0);
}

// ---------------------------------------------------------------- thin film

// Airy reflectance of a thin dielectric film (air / film / substrate) at one wavelength.
fn filmReflectance(thicknessNm: f32, cosI: f32, lambda: f32, nFilm: f32, nSub: f32) -> f32 {
  let sinT2 = (1.0 - cosI * cosI) / (nFilm * nFilm);
  let cosT = sqrt(max(0.0, 1.0 - sinT2));
  let r1 = (1.0 - nFilm) / (1.0 + nFilm);
  let r2 = (nFilm - nSub) / (nFilm + nSub);
  let delta = 4.0 * PI * nFilm * thicknessNm * cosT / lambda;
  let c = cos(delta);
  let num = r1 * r1 + r2 * r2 + 2.0 * r1 * r2 * c;
  let den = 1.0 + r1 * r1 * r2 * r2 + 2.0 * r1 * r2 * c;
  return num / den;
}

fn thinFilm(thicknessNm: f32, cosI: f32) -> vec3f {
  return vec3f(
    filmReflectance(thicknessNm, cosI, 650.0, 1.38, 1.8),
    filmReflectance(thicknessNm, cosI, 532.0, 1.38, 1.8),
    filmReflectance(thicknessNm, cosI, 450.0, 1.38, 1.8),
  );
}

// ---------------------------------------------------------------- shell height field

// Height in px-ish units. Screens are sunken behind a bezel, buttons raised, lenses domed.
fn shellHeight(p: vec2f) -> f32 {
  // Outer rim: quarter-circle profile so the silhouette reads as rounded thick plastic.
  let x = clamp(-deviceSd(p) / RIM, 0.0, 1.0);
  var h = sqrt(1.0 - (1.0 - x) * (1.0 - x)) * RIM * 0.6;

  let n = u32(u.regionCount);
  for (var i = 0u; i < n; i++) {
    let kind = u.regions[i].params.x;
    let d = regionSd(i, p);
    if (kind == K_SCREEN) {
      // Raised bezel lip, then drop into the glass.
      let lip = smoothstep(BEZEL + 8.0, BEZEL, d) * smoothstep(-1.0, 3.0, d);
      h += lip * 3.0;
      h -= smoothstep(1.5, -1.5, d) * 6.0;
    } else if (kind == K_BUTTON) {
      let pressed = select(1.0, 0.35, u.regions[i].params.w >= 2.0);
      h += smoothstep(2.0, -8.0, d) * 7.0 * pressed;
      h -= smoothstep(4.0, 1.0, d) * smoothstep(-1.0, 1.0, d) * 1.5; // parting gap
    } else if (kind == K_LENS || kind == K_LED) {
      let r = u.regions[i].rect;
      let c = r.xy + r.zw * 0.5;
      let rad = min(r.z, r.w) * 0.5;
      let x = clamp(length(p - c) / rad, 0.0, 1.0);
      h += sqrt(1.0 - x * x) * rad * 0.35 * step(d, 0.0);
      // Chrome ring around lens
      h += smoothstep(10.0, 6.0, d) * smoothstep(0.0, 3.0, d) * 4.0 * select(0.4, 1.0, kind == K_LENS);
    }
  }
  return h;
}

fn shellNormal(p: vec2f) -> vec3f {
  // Forward differences: 3 height evaluations instead of 4 (each loops all regions).
  let e = 1.0;
  let h0 = shellHeight(p);
  let hx = shellHeight(p + vec2f(e, 0.0)) - h0;
  let hy = shellHeight(p + vec2f(0.0, e)) - h0;
  return normalize(vec3f(-hx, -hy, e));
}

// Studio environment: soft top light box + floor bounce, sampled by reflection vector.
fn envLight(r: vec3f) -> vec3f {
  let up = -r.y;
  var c = mix(vec3f(0.05, 0.05, 0.07), vec3f(0.22, 0.22, 0.26), smoothstep(-0.4, 0.6, up));
  // Two softbox strips
  c += vec3f(1.6) * smoothstep(0.06, 0.0, abs(r.x + 0.35 - up * 0.2)) * smoothstep(0.1, 0.5, up);
  c += vec3f(0.8, 0.85, 1.0) * smoothstep(0.04, 0.0, abs(r.x - 0.55)) * smoothstep(0.2, 0.6, up);
  return c;
}

struct Lit { diffuse: f32, spec: f32, fresnel: f32, refl: vec3f };

fn lightAt(p: vec2f, n: vec3f, roughness: f32) -> Lit {
  let viewDir = vec3f(0.0, 0.0, 1.0);
  // Pointer acts as a movable point light hovering above the device.
  let lp = vec3f(u.mouse, 380.0);
  let l = normalize(lp - vec3f(p, 0.0));
  let key = normalize(vec3f(-0.5, -0.7, 0.8));
  let hv = normalize(l + viewDir);
  let hk = normalize(key + viewDir);
  let shininess = mix(220.0, 18.0, roughness);
  var o: Lit;
  o.diffuse = max(dot(n, key), 0.0) * 0.7 + max(dot(n, l), 0.0) * 0.45 + 0.18;
  o.spec = pow(max(dot(n, hv), 0.0), shininess) * 1.2 + pow(max(dot(n, hk), 0.0), shininess) * 0.6;
  o.fresnel = 0.04 + 0.96 * pow(1.0 - max(n.z, 0.0), 5.0);
  o.refl = envLight(reflect(-viewDir, n));
  return o;
}

// Front fill: a large, dim softbox just above the viewer. A perspective view vector
// turns its reflection into a broad band fading from the top of the device downward,
// and an exaggerated micro normal makes the molded texture, flakes and scratches read
// inside that band.
fn frontFill(p: vec2f, baseN: vec3f, micro: vec3f, roughness: f32, mat: vec4f) -> vec3f {
  let fineN = rotN(normalize(baseN + micro * 1.4));
  let dc = gDevice.xy + gDevice.zw * 0.5;
  let viewP = normalize(vec3f((dc - p) / 1600.0, 1.0));
  let r = reflect(-viewP, fineN);
  let box = normalize(vec3f(0.0, -0.3, 1.0));
  let d = max(dot(r, box), 0.0);
  let band = pow(d, 30.0) * 0.28 * (1.0 - roughness * 0.6);
  // Scratches and flakes glint where the band falls
  let glints = (mat.b * 0.6 + mat.g * 0.5) * pow(d, 10.0) * 0.2;
  return vec3f(1.0, 0.97, 0.94) * (band + glints);
}

// The surroundings in front of the device, as seen in the screen glass. Uses one perspective
// view vector over the whole device, so each panel shows a different part of the same
// reflection instead of repeating a per-panel pattern. Each pane is also tilted by a
// tiny per-screen amount, like real glass that is never perfectly coplanar.
fn glassReflection(p: vec2f, idx: u32) -> vec3f {
  let dc = gDevice.xy + gDevice.zw * 0.5;
  let viewP = normalize(vec3f((dc - p) / 1600.0, 1.0));
  let r0 = u.regions[idx].rect;
  let jitter = vec2f(fract(sin(r0.x * 12.9898 + r0.y * 78.233) * 43758.5453), fract(sin(r0.x * 39.346 + r0.y * 11.135) * 23421.631)) - 0.5;
  let n = rotN(normalize(vec3f(jitter * 0.03, 1.0)));
  let r = reflect(-viewP, n);
  let q = r.xy / r.z;

  // Everything is edge-less on purpose: hard shapes read as "a window" and draw the eye.
  // Brighter toward the ceiling.
  var env = smoothstep(0.15, -0.4, q.y + q.x * 0.25) * 0.035;
  // A large, distant diffuse light pooling toward the upper left.
  let pool = q - vec2f(-0.18, -0.3);
  env += exp(-dot(pool, pool) / 0.035) * 0.07;
  // One wide, faint band crossing the whole device, continuous from panel to panel.
  let t = dot(q, normalize(vec2f(1.0, 0.55))) - 0.06;
  env += exp(-(t * t) / 0.004) * 0.035;
  return vec3f(0.92, 0.97, 1.0) * env;
}

// ---------------------------------------------------------------- radar chart

fn statAt(i: i32) -> f32 {
  switch (i % 6) {
    case 0: { return u.stats0.x; }
    case 1: { return u.stats0.y; }
    case 2: { return u.stats0.z; }
    case 3: { return u.stats0.w; }
    case 4: { return u.stats1.x; }
    default: { return u.stats1.y; }
  }
}

fn axisDir(i: i32) -> vec2f {
  let a = -PI * 0.5 + f32(i % 6) * PI / 3.0;
  return vec2f(cos(a), sin(a));
}

// Radius of the polygon boundary along direction `dir`, between axes i and i+1.
fn polyRadius(dir: vec2f, a: vec2f, b: vec2f) -> f32 {
  let e = b - a;
  let den = dir.x * e.y - dir.y * e.x;
  return (a.x * b.y - a.y * b.x) / den;
}

fn radar(p: vec2f, rect: vec4f, base: vec3f) -> vec3f {
  let c = rect.xy + rect.zw * 0.5;
  let R = min(rect.z, rect.w) * 0.36;
  let q = p - c;
  let dist = length(q);
  let dir = q / max(dist, 1e-4);
  var ang = atan2(q.y, q.x) + PI * 0.5;
  ang = ang - floor(ang / (2.0 * PI)) * 2.0 * PI;
  let sector = i32(floor(ang / (PI / 3.0)));
  let da = axisDir(sector);
  let db = axisDir(sector + 1);

  var col = base;

  // Grid hexagons
  let hexR = polyRadius(dir, da, db);
  for (var k = 1; k <= 4; k++) {
    let rr = hexR * R * f32(k) * 0.25;
    let line = smoothstep(1.0, 0.0, abs(dist - rr));
    col += INK * line * select(0.08, 0.22, k == 4);
  }
  // Axis spokes
  for (var k = 0; k < 6; k++) {
    let ad = axisDir(k);
    let t = clamp(dot(q, ad), 0.0, R);
    let d = length(q - ad * t);
    col += INK * smoothstep(0.9, 0.0, d) * 0.1;
  }

  // Graduated outer ring: minor tick every 10°, major every 30°.
  let ringR = R * 1.1;
  col += INK * smoothstep(0.9, 0.0, abs(dist - ringR)) * 0.22;
  let step10 = PI / 18.0;
  let k10 = round(ang / step10);
  let tickLen = select(3.5, 7.0, i32(k10) % 3 == 0);
  let tickArc = abs(ang - k10 * step10) * dist;
  let inBand = step(ringR, dist) * step(dist, ringR + tickLen);
  col += INK * smoothstep(0.8, 0.2, tickArc) * inBand * 0.35;

  // Stat polygon
  let pa = da * max(statAt(sector), 0.02) * R;
  let pb = db * max(statAt(sector + 1), 0.02) * R;
  let pr = polyRadius(dir, pa, pb);
  let edge = dist - pr;
  let inside = smoothstep(0.8, -0.8, edge);
  let accent = u.accent.rgb;
  let fill = mix(accent * 0.35, mix(accent, u.accent2.rgb, 0.5) * 0.9, dist / max(pr, 1.0));
  col = mix(col, col * 0.4 + fill, inside * 0.85);
  // Glowing outline in the shared ink; the type color only tints the fill.
  let outline = mix(INK, accent, 0.25);
  col += outline * (exp(-abs(edge) * 0.7) * 0.9 + exp(-abs(edge) * 0.08) * 0.12);

  // Vertex dots
  for (var k = 0; k < 6; k++) {
    let vp = axisDir(k) * max(statAt(k), 0.02) * R;
    let d = length(q - vp);
    col += vec3f(1.0) * smoothstep(3.0, 1.5, d) + INK * exp(-d * 0.3) * 0.35;
  }

  // Rotating sweep beam, like an old radar scope
  let sweep = fract(u.time * 0.18);
  var rel = ang / (2.0 * PI) - sweep;
  rel = rel - floor(rel);
  let beam = pow(1.0 - rel, 14.0) * smoothstep(R * 1.05, R * 0.9, dist);
  col += vec3f(0.3, 1.0, 0.8) * beam * 0.25;

  return col;
}

// ---------------------------------------------------------------- main

@fragment
fn fs(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let p = frag.xy / u.dpr;
  let uv = uvOf(p);
  let mat = sampleMat(p);
  let n = u32(u.regionCount);
  gDevice = findDevice();
  let devD = deviceSd(p);

  // Find the screen (and inner regions) under this pixel.
  var screenIdx = -1;
  var screenD = 1e9;
  var screenOrder = 0.0;
  var screensSeen = 0.0;
  for (var i = 0u; i < n; i++) {
    if (u.regions[i].params.x == K_SCREEN) {
      let d = regionSd(i, p);
      if (d < screenD) { screenD = d; screenIdx = i32(i); screenOrder = screensSeen; }
      screensSeen += 1.0;
    }
  }

  var col: vec3f;
  var alpha = 1.0;

  if (screenIdx >= 0 && screenD < 0.0) {
    // ============ LCD glass ============
    let sr = u.regions[screenIdx].rect;
    let sc = sr.xy + sr.zw * 0.5;
    let local = (p - sc) / (sr.zw * 0.5);

    // Barrel distortion + depth parallax (the panel sits below the glass).
    // Both are kept small so hit-testing stays aligned.
    let dp = local * dot(local, local) * 0.006 * sr.zw * 0.5 + parallax(SCREEN_DEPTH);

    // LCD backplane: deep teal with a dot-matrix pattern.
    let cell = fract(p / 3.0) - 0.5;
    let dotMask = smoothstep(0.5, 0.3, length(cell));
    var bg = mix(vec3f(0.02, 0.06, 0.07), vec3f(0.03, 0.10, 0.11), 0.5 + 0.5 * local.y);
    bg += vec3f(0.02, 0.05, 0.05) * dotMask;
    bg += u.accent.rgb * 0.06 * (1.0 - length(local) * 0.5);

    col = aces(bg);

    // Region materials living under the DOM text (emissive, so after tonemapping).
    for (var i = 0u; i < n; i++) {
      let kind = u.regions[i].params.x;
      if (kind == K_RADAR && regionSd(i, p) < 0.0) {
        col = radar(p + dp, u.regions[i].rect, col);
      }
    }
    if (u.hasDom > 0.5) {
      // Lens-like chromatic aberration toward the screen edges.
      let ca = normalize(local + 1e-4) * 0.24;
      let dr = textureSampleLevel(domTex, samp, uvOf(p + dp + ca), 0.0);
      let dg = textureSampleLevel(domTex, samp, uvOf(p + dp), 0.0);
      let db = textureSampleLevel(domTex, samp, uvOf(p + dp - ca), 0.0);
      let dom = vec4f(dr.r, dg.g, db.b, dg.a);
      col = mix(col, dom.rgb, dom.a);
    }

    // Holographic foil over artwork cards
    for (var i = 0u; i < n; i++) {
      if (u.regions[i].params.x != K_HOLO) { continue; }
      let d = regionSd(i, p);
      if (d < 0.0) {
        let r = u.regions[i].rect;
        let cc = r.xy + r.zw * 0.5;
        // Fake tilt: view vector leans toward the pointer.
        let tilt = clamp((u.mouse - cc) / (r.zw * 1.5), vec2f(-1.0), vec2f(1.0));
        let viewN = normalize(vec3f(tilt * 0.8 + (p - cc) / r.zw * 0.6, 1.0));
        let thick = 380.0 + 260.0 * mat.a + 120.0 * sin((p.x + p.y) * 0.03 + u.time * 0.6) + 80.0 * mat.r;
        let film = thinFilm(thick, viewN.z);
        let foil = film * 2.6;
        let sparkle = mat.g * pow(max(0.0, sin(dot(p, vec2f(0.3, 0.2)) + u.time * 3.0 + mat.r * 20.0)), 8.0);
        let edgeGlow = smoothstep(-14.0, 0.0, d);
        col += foil * (0.35 + 0.5 * edgeGlow) + vec3f(sparkle) * 1.2;
      }
    }

    // CRT/LCD finishing: scanlines, subpixel mask, vignette and inner shadow.
    let scan = 0.92 + 0.08 * sin(frag.y * PI * 0.5 + u.time * 4.0);
    let sub = fract(frag.x / 3.0);
    let mask = vec3f(
      0.9 + 0.1 * smoothstep(0.33, 0.0, abs(sub - 0.16)),
      0.9 + 0.1 * smoothstep(0.33, 0.0, abs(sub - 0.5)),
      0.9 + 0.1 * smoothstep(0.33, 0.0, abs(sub - 0.83)),
    );
    col *= scan * mask;
    col *= 1.0 - 0.45 * pow(length(local) * 0.75, 3.0);
    col *= mix(0.35, 1.0, smoothstep(0.0, -18.0, screenD));

    // Inner bezel wall: when tilted, the wall on the far side of the recess becomes
    // visible and occludes the panel edge.
    let wallD = regionSd(u32(screenIdx), p + parallax(WALL_DEPTH));
    let wall = smoothstep(-1.0, 1.0, wallD);
    let wallShade = vec3f(0.035, 0.035, 0.045) + vec3f(0.03) * smoothstep(0.0, 10.0, wallD);
    col = mix(col, wallShade, wall);

    // Registration crosshairs in each corner of the glass.
    let cq = abs(p - sc) - (sr.zw * 0.5 - vec2f(8.0));
    let arm = 4.5;
    let cross = max(
      smoothstep(0.8, 0.2, abs(cq.x)) * step(abs(cq.y), arm),
      smoothstep(0.8, 0.2, abs(cq.y)) * step(abs(cq.x), arm),
    );
    col += INK * cross * 0.45;

    // Glass reflections: the room in front of the device + pointer glint.
    let glint = exp(-length(p - u.mouse) * 0.02) * 0.12;
    col += glassReflection(p, u32(screenIdx)) + vec3f(glint);

    // Boot: CRT-style power on. A bright scanline appears at the center and opens up.
    let bt = (u.stats1.w - BOOT_START - screenOrder * BOOT_STAGGER) / BOOT_LEN;
    if (bt < 1.0) {
      let open = smoothstep(0.0, 1.0, bt);
      let dy = abs(p.y - sc.y);
      let halfOpen = mix(1.0, sr.w * 0.5, open * open);
      let lit = step(dy, halfOpen) * step(0.0, bt);
      let line = exp(-max(dy - halfOpen, 0.0) / 2.0) * exp(-abs(dy - halfOpen) / 3.0) * (1.0 - open);
      col = col * lit * (1.0 + (1.0 - open) * 1.5) + vec3f(0.55, 1.0, 0.9) * line * 2.0 * step(0.0, bt);
      col = max(col, vec3f(0.008, 0.012, 0.014));
    }
  } else if (devD > 1.0) {
    return vec4f(0.0);
  } else {
    // ============ Plastic shell ============
    let baseN = shellNormal(p);
    // Micro normal from the baked orange-peel height
    let e = 1.0;
    let mx = sampleMat(p + vec2f(e, 0.0)).r - sampleMat(p - vec2f(e, 0.0)).r;
    let my = sampleMat(p + vec2f(0.0, e)).r - sampleMat(p - vec2f(0.0, e)).r;
    let micro = vec3f(-mx, -my, 0.0);
    // Light in view space so reflections slide across the body as it tilts.
    let nrm = rotN(normalize(baseN + micro * 0.45));

    var albedo = vec3f(0.78, 0.06, 0.09) * (0.92 + 0.12 * mat.a);
    var roughness = 0.35 + mat.a * 0.25 - mat.b * 0.2;
    var metal = 0.0;
    var emissive = vec3f(0.0);

    // Bezel around screens: dark satin plastic.
    if (screenIdx >= 0 && screenD < BEZEL) {
      albedo = vec3f(0.06, 0.06, 0.07);
      roughness = 0.5;
    }

    for (var i = 0u; i < n; i++) {
      let kind = u.regions[i].params.x;
      let d = regionSd(i, p);
      let r = u.regions[i].rect;
      if (kind == K_BUTTON && d < 0.0) {
        albedo = palette(u.regions[i].params.z);
        roughness = 0.28;
        if (u.regions[i].params.w >= 1.0) { emissive += albedo * 0.18; }
      } else if ((kind == K_LENS || kind == K_LED) && d < 10.0) {
        let c = r.xy + r.zw * 0.5;
        let rad = min(r.z, r.w) * 0.5;
        let x = length(p - c) / rad;
        if (d < 0.0) {
          // Glass dome: dark core, bright inner rim, refracted light pool.
          var glass = select(palette(u.regions[i].params.z), vec3f(0.1, 0.55, 1.0), kind == K_LENS);
          var pulse = 0.75 + 0.25 * sin(u.time * select(5.0, 2.0, kind == K_LENS) + f32(i));
          if (kind == K_LENS) {
            // Lights up with the cry's loudness
            pulse = mix(pulse, 1.0, u.stats1.z) + u.stats1.z * 3.5;
            emissive += vec3f(0.6, 0.85, 1.0) * u.stats1.z * u.stats1.z * smoothstep(0.7, 0.0, x) * 2.0;
          }
          let pool = exp(-length(p - c + (u.mouse - c) * 0.08 + vec2f(rad * 0.25)) / rad * 2.2);
          albedo = glass * 0.25;
          emissive += glass * (pool * 1.6 + smoothstep(0.6, 1.0, x) * 0.6) * pulse;
          roughness = 0.05;
          if (kind == K_LENS) {
            let film = thinFilm(300.0 + 500.0 * x * x + 60.0 * sin(u.time), sqrt(max(0.0, 1.0 - x * x)));
            emissive += film * 0.9 * smoothstep(0.5, 1.0, x);
          }
        } else {
          // Brushed chrome ring
          albedo = vec3f(0.85, 0.86, 0.9);
          metal = 1.0;
          roughness = 0.2 + mat.b * 0.3;
        }
      }
    }

    // Blue light spilling from the lens onto the surrounding shell while it glows.
    for (var i = 0u; i < n; i++) {
      if (u.regions[i].params.x != K_LENS) { continue; }
      let d = regionSd(i, p);
      if (d > 0.0) {
        emissive += vec3f(0.15, 0.5, 1.0) * exp(-d / 22.0) * u.stats1.z * 1.4;
      }
    }

    let lit = lightAt(p, nrm, roughness);
    let dielectric = albedo * lit.diffuse + vec3f(lit.spec) * (1.0 - roughness) + lit.refl * lit.fresnel * (1.0 - roughness);
    let metallic = albedo * (lit.refl * 0.8 + vec3f(lit.spec)) ;
    col = mix(dielectric, metallic, metal);
    // Flake sparkle catching the pointer light
    col += vec3f(1.0, 0.9, 0.85) * mat.g * pow(lit.spec, 0.5) * 0.6;
    col += frontFill(p, baseN, micro, roughness, mat) * (1.0 - metal * 0.5);
    col = aces(col) + emissive * 1.4;

    // DOM content drawn on the shell (labels, button captions)
    if (u.hasDom > 0.5) {
      let dom = textureSampleLevel(domTex, samp, uv, 0.0);
      // Slight emboss: captions look printed onto the plastic.
      col = mix(col, dom.rgb * (0.85 + 0.3 * lit.diffuse), dom.a);
    }
    // Anti-aliased silhouette
    alpha = 1.0 - smoothstep(-0.75, 0.75, devD);
  }

  return vec4f(max(col, vec3f(0.0)) * alpha, alpha);
}
