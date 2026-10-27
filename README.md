# Pokédex GPU

A Pokédex built with React and [PokéAPI](https://pokeapi.co/), rendered through a custom WebGPU
pipeline and styled as a fictional UI (FUI). The React DOM can be captured into a GPU texture via the
experimental [HTML-in-Canvas API](https://github.com/WICG/html-in-canvas) and post-processed in WGSL.

**Demo:** https://ryu1-1uyr.github.io/pokeDex_-HTMLinCanvasAPI/

## Features

- **Physical device**: procedural plastic shell with a baked micro-texture, rounded rim, extruded side
  walls and recessed screens, tilting toward the pointer over a blurred grass backdrop.
- **Screens**: LCD backplane, scanlines, glass reflections, a shader-drawn stat radar and thin-film
  holographic foil, rendered in HDR with bloom.
- **Transitions**: artwork dissolves into GPU particles and re-assembles into the next Pokémon;
  screens boot CRT-style; text decodes from random glyphs.
- **FUI layers**: panel headings, micro text, live readouts, callout lines and a lock-on reticle,
  separated into depth layers that parallax with the tilt.
- **Cries**: played through Web Audio; the lens glows with the cry's loudness envelope.
- **HTML-in-Canvas only**: the DOM's own pixels feed the shaders, so screen text glows, leaves a CRT
  phosphor afterglow, and reflects on the bezel and in the lens.

## Run

```bash
npm install
npm run dev
```

Requires a browser with WebGPU. The rendering mode is shown in the chip at the top right:

| Mode | Requirement | Behavior |
| --- | --- | --- |
| `HTML-IN-CANVAS` | Chrome Canary with `chrome://flags/#canvas-draw-element` and `#enable-experimental-web-platform-features` | The DOM is drawn into a texture and composited by the shader |
| `DOM OVERLAY` | WebGPU | The DOM is layered on top of the WebGPU canvas |
| `NO WEBGPU` | — | Plain CSS fallback |

## How it works

Each frame renders in a few passes:

1. **Flat device** (`composite.wgsl`): the untilted device into an HDR offscreen texture. React
   registers DOM elements as shader regions (`useRegion`), and their layout rects drive the materials.
2. **Particles and bloom** (`particles.wgsl`, `bloom.wgsl`): the artwork morph is drawn into the same
   texture, then a dual-filter bloom extracts emissive parts.
3. **Background** (`scene.wgsl` `fsBg`): the grass field at half CSS resolution.
4. **Scene** (`scene.wgsl` `fs`): warps the flat device onto the tilted plane with a homography,
   lights the side walls, and composites background, shadow and bloom.

The same tilt matrix is applied to the DOM (CSS `matrix3d`, or `updateElementGeometry` in
HTML-in-Canvas mode) so hit-testing stays aligned. Rendering is capped at 60fps and never queues a
frame while the previous one is still on the GPU.

## Structure

```
src/
  api/pokeapi.ts            PokéAPI client with a persistent response cache
  fx/
    fxStore.ts              Mutable bridge from React to the renderer
    useRegion.ts            Registers a DOM element as a shader region
    cry.ts                  Cry playback and loudness envelope
  gpu/
    Renderer.ts             WebGPU setup, tilt, DOM texture upload, frame loop
    ArtMorph.ts             Artwork particle transition
    Bloom.ts                Dual-filter bloom
    shaders/
      composite.wgsl        Shell, LCD glass, radar, holo foil, boot sequence
      scene.wgsl            Background, perspective warp, side walls
      material.wgsl         Baked plastic micro-texture
      particleSeed.wgsl     Pairs source and target pixels for the morph
      particles.wgsl        Animates the morph particles
      bloom.wgsl            Bloom prefilter, downsample, upsample
  ui/
    Dex.tsx                 Pokédex UI
    fui.tsx, fuiUtils.ts    FUI building blocks (headings, readouts, callouts, decode)
    fui-tokens.css          FUI design tokens
docs/fui/                   FUI knowledge base: principles, grammar, patterns, checklist
```

## FUI notes

[docs/fui](docs/fui/README.md) records why the interface reads as an FUI and how to reproduce it:
principles with sources, a token-based visual grammar, a pattern catalog and a review checklist.

## Notes

- `canvasTransform` for `updateElementGeometry` is assumed to be in CSS pixels, following the
  official WebGPU example; the spec does not state the coordinate space yet.
- Barrel distortion is kept small and the DOM layer stays on the glass so hit-testing matches the
  drawn UI.

## Data, credits and fair use

- Data comes from [PokéAPI](https://pokeapi.co/). Per its
  [fair use policy](https://pokeapi.co/docs/v2#fairuse), every response is cached locally
  (Cache Storage, `pokeapi-v1`), so each resource is fetched at most once per browser, and
  background requests for Japanese names run with low concurrency.
- Artwork and cries are loaded at runtime from the [PokeAPI/sprites](https://github.com/PokeAPI/sprites)
  and [PokeAPI/cries](https://github.com/PokeAPI/cries) repositories and are not bundled here.
  Their contents are copyright The Pokémon Company.
- Pokémon and Pokémon character names are trademarks of Nintendo.
- This is an unofficial, non-commercial fan project, not affiliated with or endorsed by Nintendo,
  Creatures, GAME FREAK or The Pokémon Company.
