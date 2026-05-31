# Saturn Simulator — Viva Preparation Guide

> WebGL 2.0 · GLSL ES 3.00 · Vite · gl-matrix  
> All source code lives in `src/` (5 files). Entry point: `saturn.js`.

---

## 1. Project at a Glance

A real-time 3D simulation of Saturn, its rings, and the moon Enceladus rendered entirely in the browser using raw WebGL 2.0 — no Three.js or other rendering libraries. The scene demonstrates a multi-pass rendering pipeline with post-processing.

### What you can interact with
| Input | Effect |
|---|---|
| Mouse drag / touch | Orbit camera around Saturn or Enceladus |
| Scroll wheel | Zoom in / out |
| `E` key | Toggle focus between Saturn view and Enceladus view |

---

## 2. File Map

```
src/
  saturn.js       — Main entry point. Loads assets, builds GPU objects,
                    runs the render loop.
  shaders.js      — All GLSL shader source strings exported as JS constants.
  gl-utils.js     — WebGL helper functions (compile shaders, create VAOs,
                    textures, framebuffers).
  geometry.js     — Procedural UV sphere generator + image loader +
                    bounding-box helper.
  gltf-loader.js  — Pure WebGL GLB/GLTF binary parser. No Three.js.
```

---

## 3. Startup Sequence (saturn.js)

```
1. Get WebGL2 context from <canvas>
2. Load GLB models in parallel:
      /saturn.glb       → Saturn body + rings (+ bundled moons, filtered out)
      /enceladus.glb    → Enceladus moon
3. Compile all 5 shader programs
4. Load the Saturn body texture:
      /8k_saturn.jpg         → Saturn body diffuse
      (the sun is procedural now — no /8k_sun.jpg)
5. Upload mesh data to GPU (VAOs)
6. Load cubemap skybox (6 face PNGs)
7. Create framebuffer render targets (sceneRT, bloomA, bloomB)
8. Start requestAnimationFrame loop
```

### Why parallel loading?
`Promise.all([...])` fires all network requests simultaneously. Models and textures are large — sequential loading would take 3× longer.

---

## 4. The 4-Pass Render Pipeline

Every frame executes four distinct GPU passes. This is what makes bloom possible.

```
┌─────────────────────────────────────────────────────────┐
│  PASS 1 — Scene to offscreen FBO (sceneRT)              │
│    • Skybox + procedural sun disk/halo (full-screen quad)│
│    • Saturn body (opaque, Phong + env map + fog)        │
│    • Enceladus   (opaque, Phong + env map + fog)        │
│    • Saturn rings (transparent, alpha-blended)          │
└────────────────────┬────────────────────────────────────┘
                     │ sceneRT.tex
┌────────────────────▼────────────────────────────────────┐
│  PASS 2 — Bright extraction → bloomA FBO                │
│    Extract pixels whose luminance > threshold (0.62)    │
└────────────────────┬────────────────────────────────────┘
                     │ bloomA.tex
┌────────────────────▼────────────────────────────────────┐
│  PASS 3 — Separable Gaussian blur (6 ping-pong passes)  │
│    Alternates: horizontal blur → bloomB                 │
│                vertical blur   → bloomA   (×3 each)     │
└────────────────────┬────────────────────────────────────┘
                     │ final blurred tex
┌────────────────────▼────────────────────────────────────┐
│  PASS 4 — Composite to screen (default framebuffer)     │
│    scene + blurred_bloom × 1.05                         │
└─────────────────────────────────────────────────────────┘
```

### Why render to a texture first (Pass 1)?
The screen framebuffer can only be read/written once per frame. Post-processing needs to read the rendered scene as a texture input, which requires an intermediate FBO (Framebuffer Object).

---

## 5. Shaders — What Each One Does

| Program | Vertex shader | Fragment shader | Purpose |
|---|---|---|---|
| `skyProg` | `SKYBOX_VS` | `SKYBOX_FS` | Full-screen quad, unprojected to world ray, samples cubemap **+ draws the procedural sun disk + halo** |
| `planetProg` | `PLANET_VS` | `PLANET_FS` | All planets/rings: Phong + env map + fog + gamma |
| `brightProg` | `POST_VS` | `BRIGHT_FS` | Extract bright regions for bloom |
| `blurProg` | `POST_VS` | `BLUR_FS` | Single-pass 1D Gaussian blur |
| `compProg` | `POST_VS` | `COMPOSITE_FS` | Add bloom on top of scene |

---

## 6. Baseline: Phong Reflection Model (per-fragment)

### The formula
```
color = ambient + (diffuse + specular) × shadowFactor
```

### In the fragment shader (shaders.js — PLANET_FS)

```glsl
vec3 N = normalize(gl_FrontFacing ? v_Norm : -v_Norm); // surface normal
vec3 V = normalize(u_Cam - v_Wpos);                    // vector to camera
vec3 L = normalize(u_LDir);                            // vector to sun
vec3 H = normalize(L + V);                             // half-vector (Blinn-Phong)

float diff = max(dot(N, L), 0.0);                      // lambertian term
float spec = pow(max(dot(N, H), 0.0), shininess);      // specular term

vec3 ambient  = 0.08 * u_LCol * base;
vec3 diffuse  = diff * shadowFactor * u_LCol * base;
vec3 specular = spec * shadowFactor * u_LCol * specCol;
vec3 col = ambient + diffuse + specular;
```

### Why Blinn-Phong and not classic Phong?
Classic Phong uses `dot(reflect(-L, N), V)`. Blinn-Phong uses the **half-vector** `H = normalize(L + V)` and `dot(N, H)` instead. Blinn-Phong is:
- Faster (one normalize instead of a reflect)
- More physically plausible at grazing angles
- The standard in real-time rendering

### Why per-fragment (not per-vertex)?
Computing lighting per-vertex (Gouraud shading) interpolates the final colour across the triangle. Specular highlights can be missed entirely if the highlight peak falls between vertices. Per-fragment (Phong shading) computes lighting at every pixel, giving smooth, correct highlights regardless of polygon count.

### Material properties
| Uniform | Saturn body | Enceladus | saturn2_B haze |
|---|---|---|---|
| `u_Shin` (shininess) | 20.0 | 52.0 | 12.0 |
| `u_SpecK` (spec coeff) | 0.10 | 0.65 | 0.45 |

These uniforms are the **fallback** — they only apply when `u_SpecTexOn = false` (no spec map loaded). The Saturn body and rings both carry spec-gloss maps from the GLB, so they use the texture path instead.

Enceladus is more specular — it's an icy moon, very reflective.

---

## 7. Normal Matrix — Why It's Not Just the Model Matrix

The normal vector must stay perpendicular to the surface after transformation. A plain model matrix (containing scale/rotation/translation) would distort normals under non-uniform scale.

The correct transform is the **inverse-transpose** of the model matrix's upper-left 3×3:

```js
// saturn.js — inside renderGroup()
gl.uniformMatrix3fv(U.u_N, false, mat3.normalFromMat4(mat3.create(), modelMat));
```

```glsl
// vertex shader
v_Norm = normalize(u_N * a_Norm);
```

`mat3.normalFromMat4` in gl-matrix computes exactly the inverse-transpose 3×3.

---

## 8. Texture Mapping

### What each object uses

| Object | Diffuse map | Format | Spec-gloss map | Format | UV set |
|---|---|---|---|---|---|
| **Saturn body** | `/8k_saturn.jpg` (external) | 2048² RGB JPEG | img[1] in `saturn.glb` | 1024² **RGBA** PNG | diff=UV0, **spec=UV1** |
| **Rings (saturn2_A)** | img[3] in `saturn.glb` | 1024² RGB PNG | img[4] in `saturn.glb` | 256² **GRAY** PNG | diff=UV0, **spec=UV1** |
| **saturn2_B (haze ring)** | img[2] in `saturn.glb` | 1024² RGBA PNG | none | — | UV0 |
| **Enceladus** | img[2] in `enceladus.glb` | 2048×1024 JPEG | none | — | UV0 |

**Key detail — two UV sets:** every primitive in `saturn.glb` carries both `TEXCOORD_0` (diffuse UVs) and `TEXCOORD_1` (specular UVs). The `KHR_materials_pbrSpecularGlossiness` material declares `texCoord: 1` for both the body and ring spec maps, meaning they are authored against the second UV set. The loader reads `TEXCOORD_1` into `mesh.uv2`; the vertex shader passes it as `v_UV2`; the fragment shader selects `v_UV2` or `v_UV` via `u_SpecUV`.

**Key detail — material factors:** every material also specifies `specularFactor` (RGB multiplier on the spec map's colour) and `glossinessFactor` (multiplier on the map's alpha before it becomes shininess). These are read from the GLB and passed as `u_SpecFactor` / `u_GlossFactor`:

| Material | specularFactor | glossinessFactor | → shininess at max alpha |
|---|---|---|---|
| Saturn body (`saturn1_A`) | 0.23, 0.23, 0.23 | 1.0 | `1×1×255+1 = 256` |
| Rings (`saturn2_A`) | 1.0, 1.0, 1.0 | **0.5** | `1×0.5×255+1 ≈ 129` |

### Why does Enceladus have no specular map?
`enceladus.glb` uses the standard **PBR metallic-roughness** workflow, not `KHR_materials_pbrSpecularGlossiness`. The loader only extracts `specImage` from the KHR path. The PBR path extracts only `baseColorTexture`. So Enceladus's `specImage` is always `null` and the flat `u_SpecK = 0.65` uniform drives its specular.

### KHR_materials_pbrSpecularGlossiness (used by Saturn body and rings)
```glsl
// shaders.js — PLANET_FS, when u_SpecTexOn = true
vec2 sUV    = (u_SpecUV > 0.5) ? v_UV2 : v_UV;   // UV1 for body+ring, UV0 for others
vec4 sg     = texture(u_SpecTex, sUV);
specCol     = sg.rgb * u_SpecFactor;               // RGB × specularFactor from GLB
shininess   = sg.a * u_GlossFactor * 255.0 + 1.0; // A × glossinessFactor → exponent
```

- **RGB** — per-texel specular colour, multiplied by the material's `specularFactor`.
- **Alpha** — per-texel glossiness, multiplied by `glossinessFactor`, mapped to a Blinn-Phong shininess exponent (0→1, 255+1).
- **`u_SpecUV`** — selects which UV set to sample; the body and ring spec maps declare `texCoord: 1`, so they use `v_UV2`.

The ring's spec map (img4, 256² grayscale) has **no alpha channel** — the browser uploads it as RGBA with `alpha = 1`. This means `shininess = 1×glossFactor×255+1`. Without the `glossinessFactor`, the alpha pins shininess to 256 (a mirror-tight lobe invisible on the flat disc); the `glossinessFactor = 0.5` halves it to ~129, which is the value the asset author intended.

### Texture quality settings (gl-utils.js)
```js
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); // trilinear
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
// Anisotropic filtering — reduces shimmer on oblique surfaces (rings)
const ext = gl.getExtension('EXT_texture_filter_anisotropic');
if (ext) gl.texParameterf(..., Math.min(16, maxAniso));
```

**Trilinear filtering** = bilinear within a mip level + linear blend between two mip levels. Smoothest texture quality at no visible seams.  
**Anisotropic filtering** = samples the texture along the surface's actual angle of incidence rather than a square footprint. Critical for the rings viewed at oblique angles.

---

## 9. Advanced Technique: Environment Mapping (Effort 3/5)

Simulates mirror-like reflections of the surrounding space environment on planetary surfaces.

```glsl
// shaders.js — PLANET_FS
vec3 R_env   = reflect(-V, N);              // reflection of view vector about normal
vec3 envSamp = texture(u_EnvMap, R_env).rgb; // sample the star cubemap
col += envSamp * u_EnvStr * specCol;         // add to final colour, gated by specularity
```

### How `reflect()` works
`reflect(I, N)` = `I - 2 * dot(N, I) * N`. It mirrors the incident vector `I` about the normal `N`.  
We pass `-V` (incident direction from camera toward surface) so we get the reflection going away from the surface.

### The cubemap
Six 1024×1024 PNG faces (`px, nx, py, ny, pz, nz`) loaded into a `TEXTURE_CUBE_MAP`. The same cubemap is used for the skybox background AND the environment reflection — so what you see behind the planet is the same star field that reflects off its surface.

### Why multiply by `specCol`?
Reflectivity should match specularity — a perfectly diffuse (non-shiny) surface shouldn't reflect its environment. Multiplying by `specCol` gates the reflection by the surface's specular properties.

| Object | `u_EnvStr` | Effect |
|---|---|---|
| Saturn body | 0.02 | Very subtle star shimmer |
| Enceladus | 0.18 | Visible icy reflections |
| Rings | 0.04 | Slight sparkle |

---

## 10. Advanced Technique: Fog (Effort 2/5)

```glsl
// shaders.js — PLANET_FS
float fogFactor = exp(-u_FogDensity * length(u_Cam - v_Wpos));
col = mix(u_FogColor, col, clamp(fogFactor, 0.0, 1.0));
```

**Exponential fog model**: `f = e^(-density × distance)`.  
- When distance = 0 → f = 1 → pure object colour (no fog)  
- As distance → ∞ → f → 0 → pure fog colour

`mix(fogColor, col, f)` = `fogColor × (1-f) + col × f`

Fog color is `[0, 0, 0.018]` — a near-black deep-space blue. Density = `0.013`.

**Order matters**: fog is applied before gamma correction (in linear light space). This is physically correct — fog mixes linear radiance values, not gamma-encoded display values.

---

## 11. Advanced Technique: Gamma Correction (Effort 2/5)

```glsl
// shaders.js — PLANET_FS (last step before output)
col = pow(max(col, vec3(0.0)), vec3(1.0 / 2.2));
```

### Why this is needed
Computer monitors apply a gamma curve (approximately `x^2.2`) to convert stored values to light output. If we store linear light values directly, the display brightens them, making the image look washed out. We pre-correct by applying `x^(1/2.2)` so the monitor's `^2.2` cancels it out.

### The `max(..., 0)` guard
`pow()` of a negative base is undefined in GLSL. Environment mapping, fog blending, or floating-point rounding can produce tiny negative channel values. The clamp prevents NaN artifacts.

### No double-encoding
The scene framebuffer (`sceneRT`) is `RGBA8` (plain linear, not `SRGB8`). WebGL's automatic sRGB conversion is not enabled. Gamma is applied exactly once, in this shader line.

---

## 12. Advanced Technique: Bloom (Effort 4/5)

Bloom makes bright objects (sun, Enceladus specular) glow by spreading their light into surrounding pixels.

### Pass 2 — Bright extraction (BRIGHT_FS)
```glsl
vec3 c = texture(u_Img, v_UV).rgb;
float l = dot(c, vec3(0.2126, 0.7152, 0.0722));  // Rec.709 luminance
vec3 b  = max(c - vec3(u_Threshold), vec3(0.0)); // subtract threshold
b      *= smoothstep(u_Threshold, u_Threshold + 0.2, l); // soft knee
outColor = vec4(b, 1.0);
```

`0.2126, 0.7152, 0.0722` are the **Rec.709 luminance coefficients** (human eye sensitivity to R/G/B). This computes perceptual brightness rather than just average channel value.

The `smoothstep` soft knee avoids a hard cutoff that would create flickering halos when pixels cross the threshold.

### Pass 3 — Separable Gaussian blur (BLUR_FS)
A 2D Gaussian blur is mathematically separable — you get the same result doing horizontal then vertical as doing the full 2D kernel in one pass.

```glsl
// 5-tap bilinear-optimized Gaussian kernel
vec3 s = texture(u_Img, v_UV).rgb * 0.227027;
s += texture(u_Img, v_UV + u_Dir * u_Texel * 1.384615).rgb * 0.316216;
s += texture(u_Img, v_UV - u_Dir * u_Texel * 1.384615).rgb * 0.316216;
s += texture(u_Img, v_UV + u_Dir * u_Texel * 3.230769).rgb * 0.070270;
s += texture(u_Img, v_UV - u_Dir * u_Texel * 3.230769).rgb * 0.070270;
```

Weights sum to ≈ 1.0: `0.227027 + 2×0.316216 + 2×0.070270 = 0.999999`.  
Offsets `1.384615` and `3.230769` are the **bilinear-optimised Gaussian offsets** — they use GPU hardware bilinear filtering to sample between two Gaussian sample points in a single texture fetch (doubles effective kernel width at no extra cost).

6 ping-pong passes (saturn.js): H→V→H→V→H→V. The blur writes to `bloomB`, then `bloomA`, alternating.

### Pass 4 — Composite (COMPOSITE_FS)
```glsl
outColor = vec4(scene + bloom * u_Strength, 1.0); // u_Strength = 1.05
```

Additive blending: bloom is added on top. Bright regions appear to glow outward.

---

## 13. Shadow System — Analytical Ray-Sphere Intersection

No shadow maps. Shadows are computed analytically by casting a ray from each fragment toward the sun and testing whether an occluder sphere blocks it.

```glsl
// shaders.js — PLANET_FS
float shadowFactor = 1.0;
if (u_OccluderR > 0.0) {
  vec3  oc   = v_Wpos - u_OccluderCenter;  // fragment relative to sphere center
  float b    = dot(oc, L);                 // project onto light direction
  float c    = dot(oc, oc) - u_OccluderR * u_OccluderR; // outside sphere: c > 0
  float disc = b * b - c;                  // discriminant

  // Shadow if all three conditions hold:
  // disc >= 0  →  ray line intersects sphere
  // c    >  0  →  fragment is outside sphere (not self-shadowing)
  // b    <  0  →  sphere center is ahead of fragment along L (between frag and sun)
  if (b < 0.0 && c > 0.0 && disc >= 0.0) shadowFactor = 0.0;
}

vec3 diffuse  = diff * shadowFactor * u_LCol * base;  // shadow kills diffuse
vec3 specular = spec * shadowFactor * u_LCol * specCol;// and specular
// ambient is NOT multiplied — shadowed regions stay faintly lit
```

### The quadratic derivation
Ray: `P(t) = v_Wpos + t·L`  
Sphere: `|P - center|² = R²`  
Substituting: `t² + 2bt + c = 0` where `b = dot(oc, L)`, `c = dot(oc,oc) - R²`  
Discriminant: `disc = b² - c` (note: simplified because `|L|=1`)  
Real solutions exist when `disc ≥ 0`.

The condition `b < 0` ensures the intersection `t = -b ± √disc` is positive (sphere is ahead of the fragment along the light direction, i.e., between the fragment and the sun).

### Who shadows whom
| Draw call | `u_OccluderCenter` | `u_OccluderR` |
|---|---|---|
| Saturn body | Enceladus world pos | 0.42 |
| Enceladus | `[0,0,0]` (Saturn) | `satBodyRadius` (3.2) |
| Rings | `[0,0,0]` (Saturn) | `satBodyRadius` (3.2) |

Each draw tests exactly one occluder. The shader has no loop — it's a hardcoded single test.

### Why analytical and not shadow mapping?
Shadow mapping renders the scene from the sun's point of view into a depth buffer, then compares depth values. It works for any geometry but requires an extra render pass per light, has resolution-dependent artifacts (shadow acne, aliasing), and needs bias tuning. For a solar system with perfectly spherical bodies, analytical ray-sphere intersection is exact, zero-artifact, and costs one dot product per fragment.

---

## 14. Transparency and Depth Sorting (Rings)

Alpha blending requires objects to be drawn back-to-front. Incorrect draw order causes see-through artifacts.

### The draw order (saturn.js render loop)
```
1. Saturn body   — opaque,      depthMask = true
2. Enceladus     — opaque,      depthMask = true
3. Saturn rings  — transparent, depthMask = false
```

```js
// saturn.js — drawMesh() for rings
gl.enable(gl.BLEND);
gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); // standard alpha blend
gl.depthMask(false);  // rings read depth but don't write it
```

### Why depthMask = false for rings?
If transparent objects write to the depth buffer, an opaque object behind the ring (like Enceladus passing behind Saturn's rings) would be incorrectly occluded at the fragment level before alpha blending happens — making it vanish instead of showing through.

With `depthMask = false`, the ring's depth value is tested (so it won't appear in front of closer opaque objects) but not written (so objects behind the ring can still read and compare correctly).

### The depth restore
```js
gl.depthMask(true); // saturn.js line ~299
```
Rings leave `depthMask = false`. If not restored, the next frame's `gl.clear(gl.DEPTH_BUFFER_BIT)` would be masked and the depth buffer would never clear, accumulating old depth values.

---

## 15. Skybox

The skybox renders a full-screen quad at the far plane and reconstructs the world-space ray direction by un-projecting the NDC coordinates.

```glsl
// SKYBOX_VS — draw quad at z = 0.9999 (just inside far plane)
gl_Position = vec4(a_Pos, .9999, 1.0);

// SKYBOX_FS — reconstruct world direction from NDC
vec4 farPos = u_InvViewProj * vec4(v_Ndc, 1.0, 1.0);
vec3 world  = farPos.xyz / max(farPos.w, 1e-6); // perspective divide
vec3 dir    = normalize(world - u_Cam);          // ray from camera to infinity
outColor    = vec4(texture(u_Skybox, dir).rgb, 1.0);
```

`u_InvViewProj` is the inverse of `projection × view`. Multiplying it by an NDC point gives the world-space position of the far plane at that screen pixel.

Depth test must be **disabled** before drawing the skybox (it's at depth 0.9999, but `gl.depthFunc(LEQUAL)` would still fail if anything is at that depth from a previous frame). Skybox is drawn first before enabling depth test.

---

## 16. GLB/GLTF Loading (gltf-loader.js)

The GLB binary format:
```
[12 byte header] [4 byte chunk length] [4 byte chunk type "JSON"] [JSON bytes]
                 [4 byte chunk length] [4 byte chunk type "BIN\0"] [binary bytes]
```

```js
// gltf-loader.js
if (dv.getUint32(0, true) !== 0x46546C67) throw new Error('Not a GLB');
// 0x46546C67 = "glTF" in little-endian ASCII
```

The parser walks the GLTF scene graph (nodes → meshes → primitives → accessors → bufferViews → binary buffer), extracts `POSITION`, `NORMAL`, `TEXCOORD_0`, and `indices` arrays, and loads embedded images into `<img>` elements via `Blob` URLs.

**Why no Three.js?** Using a custom loader demonstrates understanding of the underlying format and avoids a 600KB dependency just for asset loading.

---

## 17. VAO and Buffer Setup (gl-utils.js)

A **Vertex Array Object (VAO)** stores the binding configuration of vertex buffers — which attribute slot gets which buffer, stride, offset, and type. After creating a VAO once, a single `gl.bindVertexArray(vao)` restores the entire configuration for drawing.

```js
// gl-utils.js — makeVAO()
for (const [name, data, size] of [
    ['a_Pos', mesh.pos, 3],
    ['a_Norm', mesh.norm, 3],
    ['a_UV', mesh.uv, 2]
]) {
  const loc = gl.getAttribLocation(prog, name);
  gl.bindBuffer(gl.ARRAY_BUFFER, glBuf(gl, data));
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
}
```

`gl.vertexAttribPointer(loc, size, type, normalized, stride, offset)`:
- `loc` — shader attribute location
- `size` — components per vertex (3 for position/normal, 2 for UV)
- `stride = 0` — data is tightly packed
- `offset = 0` — starts at beginning of buffer

---

## 18. Transformation Pipeline

Every vertex goes through three transforms:

```
object space → [Model matrix M] → world space
world space  → [View matrix V]  → camera space
camera space → [Projection P]   → clip space → NDC (after perspective divide)
```

```glsl
// PLANET_VS
vec4 wp = u_M * vec4(a_Pos, 1.0);    // world position (for lighting)
v_Wpos  = wp.xyz;
v_Norm  = normalize(u_N * a_Norm);   // normal in world space
gl_Position = u_MVP * vec4(a_Pos, 1.0); // MVP = P × V × M
```

`u_MVP` is pre-multiplied on the CPU:
```js
// saturn.js — renderGroup()
gl.uniformMatrix4fv(U.u_MVP, false, mat4.multiply(mat4.create(), vp, modelMat));
// vp = proj × view, already computed once per frame
```

### Saturn's model matrix construction
```js
mat4.rotateZ(satM, satM, 26.7 * Math.PI / 180); // axial tilt
mat4.rotateY(satM, satM, t * 0.15);              // spin (animated)
mat4.scale   (satM, satM, [sS, sS, sS]);          // scale to world units
mat4.translate(satM, satM, [-sB.cx, -sB.cy, -sB.cz]); // centre the mesh
```

Operations are **right-multiplied** (gl-matrix convention), so read right-to-left for the actual transform order applied to vertices: centre → scale → spin → tilt.

### Enceladus orbit
```js
mat4.rotateY (encM, encM, t * 0.70);         // orbit around Saturn
mat4.rotateX (encM, encM, 0.09);             // slight orbital inclination
mat4.translate(encM, encM, [ENC_ORBIT_R, 0, 0]); // place at orbital radius (15 units)
mat4.rotateY (encM, encM, t * 2.2);          // self-rotation
mat4.scale   (encM, encM, [eS, eS, eS]);
mat4.translate(encM, encM, [-eB.cx, -eB.cy, -eB.cz]);
```

---

## 19. Camera System

Spherical coordinates — the camera orbits a target point at a fixed radius.

```js
// saturn.js
camPos = [
  ctr[0] + camR * sin(camRy) * cos(camRx),  // X
  ctr[1] + camR * sin(camRx),                // Y (elevation)
  ctr[2] + camR * cos(camRy) * cos(camRx),  // Z
];
mat4.lookAt(view, camPos, ctr, [0, 1, 0]);
```

- `camRy` — azimuth (horizontal rotation), updated by mouse X drag
- `camRx` — elevation (vertical angle), clamped to ±1.45 rad to prevent flipping
- `camR` — radius, updated by scroll wheel (zoom)

`mat4.lookAt(eye, center, up)` builds the view matrix from three world-space points.

---

## 20. Uniform Management

```js
// gl-utils.js — cacheUniforms()
export function cacheUniforms(gl, prog, keys) {
  return Object.fromEntries(keys.map(k => [k, gl.getUniformLocation(prog, k)]));
}
```

`gl.getUniformLocation` is a relatively slow call that queries the linked program. Caching all locations once at startup and referencing them by name via the returned object avoids repeating this lookup every frame.

```js
// Usage
gl.uniform3fv(U.u_LDir, SUN_DIR); // U is the cached object
```

If a key doesn't exist in the shader (e.g., you query a uniform that was optimised away), `getUniformLocation` returns `null`. Calls to `gl.uniform*` with a `null` location are silently ignored by WebGL — safe but invisible errors.

---

## 21. Framebuffer Objects (FBOs) for Post-Processing

```js
// gl-utils.js — mkRenderTarget()
const tex = mkColorTex(gl, w, h);        // RGBA8 colour attachment
const fbo = gl.createFramebuffer();
gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
// Optional depth renderbuffer:
const depth = gl.createRenderbuffer();
gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
```

`sceneRT` has a depth buffer (needed for depth testing during 3D scene rendering).  
`bloomA` and `bloomB` have no depth buffer (post-processing passes are 2D, no depth test needed).

### Resize handling
```js
// saturn.js — ensureTargets()
if (w === rtW && h === rtH && sceneRT) return; // already correct size
[sceneRT, bloomA, bloomB].forEach(rt => freeRenderTarget(gl, rt)); // delete old
sceneRT = mkRenderTarget(gl, w, h, true);   // recreate at new size
```

FBO textures are fixed resolution. On window resize, old targets are deleted and new ones created at the new canvas size.

---

## 22. Procedural UV Sphere (geometry.js)

`makeUvSphere` builds a UV sphere from scratch (no GLB). It used to build the
sun's VAO; the sun is now a procedural disk in the skybox shader, so this is no
longer called at runtime, but it stays as a textbook example of the technique.

```js
// geometry.js — makeUvSphere(radius, latBands, lonBands)
for (y in latBands) {           // latitude rings
  theta = y/latBands * PI;      // 0 → π (north pole to south pole)
  for (x in lonBands) {
    phi = x/lonBands * 2π;      // longitude
    nx = cos(phi) * sin(theta);
    ny = cos(theta);
    nz = sin(phi) * sin(theta);
    // normal == position on unit sphere
    uv = [1 - x/lonBands, y/latBands];
  }
}
// Indices: two triangles per quad formed by adjacent rings
```

Normals equal the normalised position vector for a unit sphere — a sphere's surface normal at any point is just the outward radial direction.

---

## 23. Commonly Asked Viva Questions

**Q: What is a VAO and why use one?**  
A Vertex Array Object stores the vertex attribute configuration. Without it you'd rebind every buffer and re-specify every attribute pointer on every draw call. With a VAO, one `bindVertexArray()` call restores everything.

**Q: What is the difference between a VBO and a VAO?**  
A VBO (Vertex Buffer Object) is a raw GPU buffer containing raw data (positions, normals, UVs). A VAO describes how to interpret those buffers — which attributes map to which buffer, and how they're laid out.

**Q: Why does the normal matrix use the inverse-transpose?**  
To keep normals perpendicular to the surface under non-uniform scale. If you scale an object by (2, 1, 1), a normal pointing in X should stay perpendicular — but applying the model matrix directly would scale it too, pointing it in the wrong direction. The inverse-transpose corrects this.

**Q: What is the difference between Gouraud and Phong shading?**  
Gouraud shading computes lighting at each vertex and interpolates colour across the triangle (in the vertex shader). Phong shading interpolates the normal across the triangle and computes lighting at every pixel (in the fragment shader). Phong is more expensive but gives correct specular highlights.

**Q: Why do you multiply the projection and view matrices on the CPU?**  
`proj × view` (the VP matrix) is constant for all objects in a frame. Computing it once on the CPU and passing it as a uniform costs one matrix multiply per frame. Computing it per-vertex in the shader would cost one matrix multiply per vertex per frame.

**Q: How does the bloom threshold work?**  
Pixels with luminance below the threshold are zeroed out (no contribution to bloom). Pixels above are kept with the excess brightness. The smoothstep soft knee prevents hard flickering when pixels hover near the threshold value.

**Q: Why does transparency require a specific draw order?**  
Alpha blending mixes the transparent object's colour with whatever is already in the framebuffer (destination). If an opaque object is drawn after a transparent one, the opaque object correctly overwrites. But the transparent object needs the opaque objects behind it to already exist in the framebuffer for the blend to look correct. Hence: draw all opaques first, then transparents.

**Q: What is the difference between `shadowFactor = 0.0` and full black?**  
When `shadowFactor = 0`, diffuse and specular go to zero but ambient (0.08 × lightColor × baseColor) remains. This simulates indirect/scattered starlight reaching even the shadowed side. Full black would look unrealistically dark.

**Q: How does the skybox avoid z-fighting with scene geometry?**  
The skybox quad is placed at `z = 0.9999` in NDC (just inside the far plane). It's drawn first with depth testing **disabled**, so it never depth-tests against anything. Scene geometry is drawn afterward with depth testing enabled, and since any fragment closer than 0.9999 will pass the depth test, the skybox is correctly occluded everywhere.

**Q: What is an FBO?**  
A Framebuffer Object is an off-screen render target. Instead of drawing to the screen's default framebuffer, you bind an FBO and draw into a texture. That texture can then be used as input to subsequent shader passes — enabling multi-pass effects like bloom, blur, and compositing.
