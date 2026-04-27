# Planetary Orbit Visualization — WebGL 2.0

**Name:** Abdullah Khan Sherwani
**Course:** Computer Graphics

---

## Project Direction

**Scene Rendering System** — a visually rich 3D space scene with multiple celestial bodies, physically motivated lighting, and interactive camera control.

---

## Idea Description

The application renders a gas giant planet and its icy moon in real time using pure WebGL 2.0. The planet features an axial tilt, slow self-rotation, and a ring system with alpha-transparent dust. The moon orbits the planet hierarchically and casts an analytical shadow on the planet surface during transits; the planet likewise occludes sunlight from the moon during eclipse passes. The user can orbit the scene freely with mouse/touch controls and toggle focus between the planet and the moon.

---

## Baseline Techniques

| Technique | Status |
|---|---|
| Phong reflection model (ambient + diffuse + specular) | ✓ Applied — computed per-fragment in GLSL |
| Material properties (shininess, reflectance coefficients) | ✓ Per-mesh uniforms; specular/glossiness read from texture when available |
| Texture mapping — diffuse maps | ✓ 8K planet body, ring alpha, moon surface textures |
| Texture mapping — specular maps | ✓ KHR specular/glossiness texture (RGB = specular colour, A = glossiness → shininess) |
| Per-fragment lighting | ✓ All lighting computed in fragment shader |
| Directional light | ✓ Distant sun modelled as parallel-ray directional light |
| Point lights | — Not applicable: no artificial point-source lights exist in a space scene |
| Spotlights | — Not applicable: no cone-constrained light sources in the scene |
| GLSL shaders with uniform management | ✓ Full uniform caching; normal matrix computed and uploaded each frame |
| Correct transformation & surface normals | ✓ Normal matrix (`transpose(inverse(M))`) applied to normals in vertex shader |

---

## Advanced Techniques

| Technique | Effort | Notes |
|---|---|---|
| **Bloom** | 4/5 | Bright-region extract → 6-pass separable Gaussian blur (ping-pong FBOs) → additive composite onto scene |
| **Environment Mapping** | 3/5 | Star-field cubemap sampled via reflected view ray per-fragment; intensity scaled by surface specular coefficient |
| **Fog** | 2/5 | Exponential deep-space fog; blends fragments toward void colour with camera distance |
| **Gamma Correction** | 2/5 | Linear → gamma (pow 1/2.2) applied at end of fragment shader |

**Combined effort: 11 / 10** ✓

---

## Inspiration Images

<!-- Paste 2–3 reference images here before converting to PDF -->
<!-- Suggested: Cassini photograph of Saturn, NASA Enceladus plume image, real-time WebGL space demo -->

1. *(Cassini — Saturn with ring shadow)*
2. *(Cassini — Enceladus backlit by Sun)*
3. *(NASA Hubble — gas giant true colour)*

---

## Implementation Plan

1. **Week 1** — Set up WebGL 2.0 context, VAO/VBO pipeline, GLSL Phong shader with directional sun light and texture mapping.
2. **Week 2** — Load planet and moon GLB assets via GLTFLoader (parser only); normalise geometry into scene units; build hierarchical orbit transform.
3. **Week 3** — Add cubemap skybox and environment mapping (reflection sampling in fragment shader).
4. **Week 4** — Implement bloom post-process (FBO pipeline: bright extract → Gaussian blur → composite); add fog and gamma correction.
5. **Week 5** — Analytical inter-body shadows (ray-sphere test in fragment shader); interactive camera toggle between planet and moon focus.
6. **Week 6** — Polish: ring alpha cutout, specular glossiness textures, axial tilt, performance pass.

---

## External Assets

| Asset | Source | Licence |
|---|---|---|
| Planet GLB model | Sketchfab / BlendSwap | CC-BY |
| Moon GLB model | Sketchfab / BlendSwap | CC-BY |
| 8K planet surface texture | [Solarsystemscope.com](https://www.solarsystemscope.com/textures/) | CC-BY |
| Ring alpha texture | Solarsystemscope.com | CC-BY |
| 8K sun texture | Solarsystemscope.com | CC-BY |
| Milky Way starmap (cubemap) | NASA/STScI — Gaia DR2 sky map | Public domain |
| gl-matrix | npmjs.com/package/gl-matrix | MIT |
| Three.js GLTFLoader | threejs.org (used as GLB parser only) | MIT |
