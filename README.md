# Saturn Simulator

> Real-time 3D space scene rendered entirely in **WebGL 2.0 / GLSL ES 3.00** — no game engine, no Three.js.

![Full pipeline render](Assets/Reference%20Pictures/Ref2.jpeg)

[![WebGL 2.0](https://img.shields.io/badge/WebGL-2.0-blue?logo=webgl)](https://www.khronos.org/webgl/)
[![GLSL ES](https://img.shields.io/badge/GLSL-ES%203.00-blue)](https://www.khronos.org/opengl/wiki/OpenGL_Shading_Language)
[![Vite](https://img.shields.io/badge/Vite-5-646CFF?logo=vite&logoColor=white)](https://vitejs.dev)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## Overview

Saturn Simulator renders Saturn and its orbiting moon Enceladus in real time using a hand-written GPU pipeline. Every byte of rendering code — from the GLB binary parser to the multi-pass bloom compositor — is written from scratch without any rendering framework.

| Scene overview | Enceladus close-up (env mapping) |
|:-:|:-:|
| ![Ref3](Assets/Reference%20Pictures/Ref3.png) | ![Ref4](Assets/Reference%20Pictures/Ref4.png) |
| Saturn · 8K texture · Phong · alpha rings · Milky Way skybox | Enceladus icy surface reflecting the star-field cubemap |

| Early render | Inter-body shadow |
|:-:|:-:|
| ![Ref1](Assets/Reference%20Pictures/Ref1.png) | ![Ref5](Assets/Reference%20Pictures/Ref5.png) |
| Ring depth-ordering + axial tilt bring-up | Analytical ray-sphere shadow: Saturn occluding Enceladus |

---

## Features

### Rendering Pipeline
- **Per-fragment Phong shading** — ambient + diffuse + specular with Blinn-Phong half-vector
- **8K texture mapping** — Saturn body, ring alpha mask, and sun surface
- **Specular / gloss maps** — `KHR_materials_pbrSpecularGlossiness` (RGB = specular, A = glossiness)
- **Normal matrix** — correct lighting under non-uniform scale transforms
- **Hierarchical transforms** — Saturn axial tilt (26.7°), self-rotation, Enceladus orbital mechanics

### Advanced Techniques
| Technique | Effort | Description |
|-----------|:------:|-------------|
| **Bloom** | 4 / 5 | Bright-region extract → 6-pass separable Gaussian blur (ping-pong FBOs) → additive composite |
| **Environment Mapping** | 3 / 5 | Milky Way star-field cubemap sampled via `reflect(-V, N)` per fragment |
| **Exponential Fog** | 2 / 5 | `exp(-density × dist)` blends fragments toward a deep-space void colour |
| **Gamma Correction** | 2 / 5 | `pow(max(col, 0.0), vec3(1.0/2.2))` at end of fragment shader |
| **Combined score** | **11 / 10** | Exceeds requirement (≥ 6, at least one ≥ 3) |

### Additional Features
- **Analytical inter-body shadows** — ray-sphere occlusion test in the fragment shader; Saturn and Enceladus mutually eclipse each other
- **Ring alpha blending** — correct depth ordering: opaque body written to depth first, rings drawn with `depthMask(false)` + `polygonOffset`
- **Anisotropic texture filtering** — `EXT_texture_filter_anisotropic` (up to 16×) to eliminate shimmer on oblique ring surfaces
- **Interactive camera** — orbit-drag (mouse + touch), scroll-to-zoom, `E` key toggles focus between Saturn and Enceladus
- **Custom GLB parser** — pure JS binary parser; supports both strided buffer views and `KHR_materials_pbrSpecularGlossiness` / PBR Metallic-Roughness material workflows

---

## Getting Started

### Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| [Node.js](https://nodejs.org/) | 18 + | `node -v` to check |
| npm | bundled with Node | `npm -v` to check |
| Browser | any current | Chrome / Firefox / Edge all support WebGL 2.0 |

---

### Step 1 — Clone and install dependencies

```bash
git clone https://github.com/Abdullah-Khan-Sherwani/Saturn-Simulator.git
cd Saturn-Simulator
npm install
```

---

### Step 2 — Asset setup

The table below lists every file the app loads at runtime, which ones are already in the repo, and what you need to provide.

| File | Served at | Included in repo | Size | Action needed |
|------|-----------|:----------------:|------|---------------|
| `Assets/saturn.glb` | `/saturn.glb` | ❌ | ~143 MB | **Must add manually — see below** |
| `Assets/enceladus.glb` | `/enceladus.glb` | ✅ | 3.5 MB | Nothing |
| `Assets/8k_saturn.jpg` | `/8k_saturn.jpg` | ✅ | — | Nothing |
| `Assets/8k_saturn_ring_alpha.png` | `/8k_saturn_ring_alpha.png` | ✅ | — | Nothing |
| `Assets/8k_sun.jpg` | `/8k_sun.jpg` | ✅ | — | Nothing |
| `Assets/cubemap_starmap_2020_1024/px.png` … `nz.png` | `/cubemap_starmap_2020_1024/` | ✅ | 6 files | Nothing |

> Vite's `publicDir` is set to `Assets/`, so every file in `Assets/` is served at the URL root automatically — no import statements needed.

#### Obtaining `saturn.glb`

`saturn.glb` exceeds GitHub's 100 MB hard limit and is therefore not tracked. You have three options depending on what you already have locally:

**Option A — You have `Assets/saturn_model_new/saturn.glb` on disk (copy it):**

```bash
# Windows
copy "Assets\saturn_model_new\saturn.glb" "Assets\saturn.glb"

# macOS / Linux
cp Assets/saturn_model_new/saturn.glb Assets/saturn.glb
```

**Option B — You have `Assets/saturn.glb.zip` on disk (extract it):**

```bash
# Windows (PowerShell)
Expand-Archive -Path "Assets\saturn.glb.zip" -DestinationPath "Assets\" -Force
# Then rename the extracted file to saturn.glb if needed

# macOS / Linux
unzip Assets/saturn.glb.zip -d Assets/
```

**Option C — Fresh download from Sketchfab:**

1. Download the Saturn with rings model (CC-BY) from [Sketchfab](https://sketchfab.com)
2. Export / download as **GLB**
3. Place the file at `Assets/saturn.glb`

After any of the three options, confirm the file is in place:

```bash
# Should print the file path
ls Assets/saturn.glb        # macOS / Linux
dir Assets\saturn.glb       # Windows
```

---

### Step 3 — Run the development server

```bash
npm run dev
```

Vite starts on port `5173` and automatically opens:

```
http://localhost:5173/saturn
```

**What you will see on load:**

```
Initialising…           ← WebGL context + shader compilation
Saturn: X.X / 143 MB   ← GLB streaming progress
Enceladus: X.X / 4 MB  ← GLB streaming progress
Building GPU buffers…   ← VAO / VBO upload
                        ← Loading overlay disappears → scene renders
```

If you see a red error message instead, check the browser console (`F12`) — the most common cause is a missing or mis-named `saturn.glb`.

---

### Step 4 — Production build (optional)

```bash
npm run build
```

Output is written to `dist/`. Serve locally with:

```bash
npx serve dist
# open http://localhost:3000/saturn
```

Or deploy the `dist/` folder to any static host (Vercel, Netlify, GitHub Pages, etc.).

---

## Controls

| Input | Action |
|-------|--------|
| Left-drag / Touch-drag | Orbit camera around the focused body |
| Scroll wheel | Zoom in / out |
| `E` key | Toggle focus: **Saturn** ↔ **Enceladus** |

---

## Project Structure

```
Saturn-Simulator/
├── src/
│   ├── saturn.js          # Scene entry point: load, GPU setup, render loop
│   ├── shaders.js         # All GLSL ES 3.00 shader sources (6 programs)
│   ├── gl-utils.js        # WebGL 2.0 helpers — VAO, textures, FBOs, uniforms
│   ├── geometry.js        # Procedural UV-sphere + image / cubemap loaders
│   └── gltf-loader.js     # Pure GLB binary parser (no Three.js)
├── Assets/
│   ├── cubemap_starmap_2020_1024/   # NASA/Gaia Milky Way cube faces (6 × PNG)
│   ├── 8k_saturn.jpg                # 8K Saturn diffuse texture
│   ├── 8k_saturn_ring_alpha.png     # Ring alpha mask
│   ├── 8k_sun.jpg                   # Sun surface texture
│   ├── enceladus.glb                # Enceladus 3D model
│   └── saturn.glb                   # Saturn 3D model (not tracked — too large)
├── Docs/
│   ├── SherwaniAbdullah_Proposal.tex / .pdf
│   └── SherwaniAbdullah_ERP_ProgressReport.tex
├── saturn.html            # HTML entry point
├── vite.config.js
└── package.json
```

---

## Render Pipeline

```
Frame N
  │
  ├─ Pass 1 ── Render to offscreen FBO  (colour + depth)
  │               Skybox          full-screen quad, cubemap unproject
  │               Sun sphere      emissive, tone-mapped
  │               Saturn body     Phong + env map + fog + gamma
  │               Saturn rings    alpha-blended, depth-tested
  │               Enceladus       Phong + env map (high specular) + fog + gamma
  │
  ├─ Pass 2 ── Bright extract → bloomA FBO
  │               Luminance threshold + smoothstep softening
  │
  ├─ Pass 3 ── 6× separable Gaussian blur  (bloomA ↔ bloomB ping-pong)
  │               3 horizontal passes + 3 vertical passes
  │
  └─ Pass 4 ── Composite to screen
                  scene + bloom × 1.05 → outColor
```

### Shader Programs

| Program | Vertex | Fragment | Purpose |
|---------|--------|----------|---------|
| `skyProg` | `SKYBOX_VS` | `SKYBOX_FS` | Full-screen cubemap skybox |
| `sunProg` | `SUN_VS` | `SUN_FS` | Emissive sun sphere |
| `planetProg` | `PLANET_VS` | `PLANET_FS` | Phong + env map + fog + gamma |
| `brightProg` | `POST_VS` | `BRIGHT_FS` | Bloom bright-region extract |
| `blurProg` | `POST_VS` | `BLUR_FS` | Separable 5-tap Gaussian blur |
| `compProg` | `POST_VS` | `COMPOSITE_FS` | Scene + bloom composite |

---

## Tech Stack

| Tool | Role |
|------|------|
| [WebGL 2.0](https://www.khronos.org/webgl/) | GPU rasterisation API |
| [GLSL ES 3.00](https://www.khronos.org/opengl/wiki/OpenGL_Shading_Language) | Shader language |
| [gl-matrix](https://github.com/toji/gl-matrix) | Vector / matrix math |
| [Vite 5](https://vitejs.dev) | Dev server + bundler |

---

## External Assets

| Asset | Source | Licence |
|-------|--------|---------|
| Saturn 3D model (`saturn.glb`) | Sketchfab | CC-BY |
| Enceladus 3D model (`enceladus.glb`) | Sketchfab | CC-BY |
| 8K planet & ring textures | [solarsystemscope.com](https://www.solarsystemscope.com/textures/) | CC-BY |
| Milky Way starmap cubemap | NASA / STScI — Gaia DR2 all-sky | Public domain |
| `gl-matrix` v3.4 | [npmjs.com](https://www.npmjs.com/package/gl-matrix) | MIT |

---

## Course

**CSE352 Computer Graphics** — Spring 2026  
Institute of Business Administration  
Abdullah Khan Sherwani

---

## License

This project is licensed under the [MIT License](LICENSE).
