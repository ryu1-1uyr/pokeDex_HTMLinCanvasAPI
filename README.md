# Pokédex GPU

A Pokédex built with React and [PokeAPI](https://pokeapi.co/), rendered through a custom WebGPU pipeline.
The React DOM is captured into a GPU texture via the experimental
[HTML-in-Canvas API](https://github.com/WICG/html-in-canvas) and post-processed in WGSL.

## Run

```bash
npm install
npm run dev
```

### Rendering modes

The mode is shown in the chip at the top right.

| Mode | Requirement | Behavior |
| --- | --- | --- |
| `HTML-IN-CANVAS` | Chrome Canary with `chrome://flags/#canvas-draw-element` and `#enable-experimental-web-platform-features` | DOM is drawn into a texture and composited by the shader |
| `DOM OVERLAY` | WebGPU | DOM is layered on top of the WebGPU canvas |
| `NO WEBGPU` | — | Plain CSS fallback |

## Structure

```
src/
  api/pokeapi.ts          PokeAPI client, lazy Japanese name cache (localStorage)
  fx/fxStore.ts           Mutable bridge from React to the renderer (regions, stats, splats)
  fx/useRegion.ts         Registers a DOM element as a shader region
  gpu/Renderer.ts         WebGPU setup, DOM texture upload, frame loop
  gpu/FluidSim.ts         Stable-fluids simulation (compute)
  gpu/shaders/
    fluid.ts              Advect / splat / curl / vorticity / pressure passes
    material.wgsl         Baked tileable plastic detail texture
    composite.wgsl        Shell lighting, LCD glass, radar chart, thin-film holo
  ui/Dex.tsx              Pokédex UI
```

## Notes

- `canvasTransform` for `updateElementGeometry` is assumed to be in CSS pixels (following the
  official WebGPU example); the spec does not state the coordinate space yet.
- Barrel distortion and fluid refraction are kept small so hit-testing stays aligned with the drawn UI.
