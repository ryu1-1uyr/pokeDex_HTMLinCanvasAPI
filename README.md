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

## Deploy (GitHub Pages)

`.github/workflows/deploy.yml` builds and deploys on every push to `main`.

1. Push the repository to GitHub.
2. In **Settings → Pages**, set **Source** to **GitHub Actions** (one-time).
3. The site is published at `https://<user>.github.io/<repo>/`.

`vite.config.ts` uses `base: './'`, so the build works under any repository name.
GitHub Pages serves over HTTPS, which WebGPU and Cache Storage require.

## Structure

```
src/
  api/pokeapi.ts          PokeAPI client, lazy Japanese name cache (localStorage)
  fx/fxStore.ts           Mutable bridge from React to the renderer (regions, stats, accent colors)
  fx/useRegion.ts         Registers a DOM element as a shader region
  gpu/Renderer.ts         WebGPU setup, DOM texture upload, frame loop
  gpu/shaders/
    material.wgsl         Baked tileable plastic detail texture
    composite.wgsl        Shell lighting, LCD glass, radar chart, thin-film holo
  ui/Dex.tsx              Pokédex UI
```

## Notes

- `canvasTransform` for `updateElementGeometry` is assumed to be in CSS pixels (following the
  official WebGPU example); the spec does not state the coordinate space yet.
- Barrel distortion is kept small so hit-testing stays aligned with the drawn UI.

## Data, credits and fair use

- Data comes from [PokéAPI](https://pokeapi.co/). Per its
  [fair use policy](https://pokeapi.co/docs/v2#fairuse), every response is cached locally
  (Cache Storage, `pokeapi-v1`), so each resource is fetched at most once per browser, and
  background requests for Japanese names run with low concurrency.
- Artwork and cries are loaded from the [PokeAPI/sprites](https://github.com/PokeAPI/sprites) and
  [PokeAPI/cries](https://github.com/PokeAPI/cries) repositories at runtime; they are not bundled
  in this repository. Their contents are copyright The Pokémon Company.
- Pokémon and Pokémon character names are trademarks of Nintendo.
- This is an unofficial, non-commercial fan project, not affiliated with or endorsed by Nintendo,
  Creatures, GAME FREAK or The Pokémon Company.
