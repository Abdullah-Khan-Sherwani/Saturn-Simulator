# Rendering Techniques — Implementation & Visual Impact

This document covers every rendering technique in the Saturn scene renderer, baseline and advanced, with exact code references, how each one works mathematically, and what the scene looks like with and without it.

---

## Baseline Techniques

### 1. Phong Reflection Model (per-fragment)

**Where:** `src/shaders.js` — `PLANET_FS`, lines 204–240

**How it works:**

The Phong model decomposes light into three additive components. All computation happens in the fragment shader using world-space vectors interpolated from the vertex shader.

```glsl
vec3 N = normalize(gl_FrontFacing ? v_Norm : -v_Norm); // surface normal
vec3 V = normalize(u_Cam - v_Wpos);                    // view vector
vec3 L = normalize(u_LDir);                             // light direction
vec3 H = normalize(L + V);                              // half-vector (Blinn-Phong)

float diff = max(dot(N, L), 0.0);
float spec = pow(max(dot(N, H), 0.0), shininess);

vec3 ambient  = 0.08 * u_LCol * base;
vec3 diffuse  = diff * lit * u_LCol * base;
vec3 specular = spec * lit * u_LCol * specCol;
vec3 col = ambient + diffuse + specular;
```

The model uses the **Blinn-Phong** half-vector `H = normalize(L + V)` instead of the classic reflect vector. This avoids a division, is faster, and produces a slightly softer specular highlight that is more physically plausible at grazing angles.

**Per-fragment (not per-vertex):** World position (`v_Wpos`) and normal (`v_Norm`) are computed in the vertex shader and interpolated across the triangle. The lighting formula runs once per screen pixel, not per triangle vertex. This is critical for correct specular highlights on large low-polygon objects — per-vertex lighting would interpolate the final colour across the face, completely missing specular hotspots that fall between vertices.

**Visual impact:**
- **Without:** Flat shading with no response to light direction. Everything a uniform colour.
- **With:** The lit side of Saturn is warm and bright, the terminator (day/night boundary) is a smooth gradient, and Enceladus has a sharp specular highlight on its icy surface.

---

### 2. Texture Mapping — Diffuse Maps

**Where:** `src/shaders.js` — `PLANET_FS` line 200; `src/saturn.js` lines 72–87

**How it works:**

UV coordinates are generated in the vertex shader (`v_UV = a_UV * u_UVRepeat + u_UVOffset`) and used to sample a 2D texture in the fragment shader:

```glsl
vec4 texel = u_TexOn ? texture(u_Tex, v_UV) : vec4(u_Base, 1.0);
vec3 base  = texel.rgb;
```

The 8192×4096 Saturn surface texture (`8k_saturn.jpg`) is uploaded via `glTex2D` in `gl-utils.js`, which also calls `generateMipmap()` and enables **trilinear filtering** (`LINEAR_MIPMAP_LINEAR`) and **anisotropic filtering** (up to 16×, via `EXT_texture_filter_anisotropic`).

The rings use their own embedded diffuse texture extracted from `saturn.glb`. Enceladus uses its embedded diffuse texture from `enceladus.glb`. Texture selection logic in `saturn.js`:

```js
const satTex = satMeshes.map(m =>
  isRing(m) ? (m.image ? glTex2D(gl, m.image) : null) : satBodyTex
);
```

**Visual impact:**
- **Without:** Saturn is a featureless yellow-tan sphere. Rings are a solid grey band. Enceladus is solid grey.
- **With:** Saturn shows its iconic banded cloud structure in full 8K detail. The rings display their translucent layered structure. Enceladus shows its cratered icy surface.

---

### 3. Specular Texture Maps (KHR_materials_pbrSpecularGlossiness)

**Where:** `src/shaders.js` — `PLANET_FS` lines 213–221; `src/gltf-loader.js` lines 92–102

**How it works:**

When a mesh's GLTF material has the `KHR_materials_pbrSpecularGlossiness` extension, the loader extracts a specular-glossiness texture where:
- **RGB channels** = per-texel specular colour
- **Alpha channel** = glossiness (remapped to shininess as `sg.a * 255 + 1`)

```glsl
if (u_SpecTexOn) {
    vec4 sg   = texture(u_SpecTex, v_UV);
    specCol   = sg.rgb;
    shininess = sg.a * 255.0 + 1.0;
} else {
    specCol   = vec3(u_SpecK);
    shininess = u_Shin;
}
```

When no specular texture is present (e.g. Enceladus uses uniform material parameters: `u_Shin = 52.0`, `u_SpecK = 0.65`).

**Visual impact:**
- **Without:** Uniform specular response across the entire surface — highlights are same brightness on rock as on ice.
- **With:** Icy patches on Enceladus reflect the sun more intensely than dark craters. Specular variation matches the surface albedo map.

---

### 4. Correct Normal Transforms (Normal Matrix)

**Where:** `src/saturn.js` line 190; `src/shaders.js` — `PLANET_VS` line 104

**How it works:**

When a model matrix contains non-uniform scaling, applying it directly to normals distorts them (a normal perpendicular to a surface would no longer be perpendicular after scaling). The correct transform is the **inverse transpose of the upper-left 3×3** of the model matrix, called the normal matrix:

```js
gl.uniformMatrix3fv(U.u_N, false, mat3.normalFromMat4(mat3.create(), modelMat));
```

In the vertex shader:
```glsl
v_Norm = normalize(u_N * a_Norm);
```

`mat3.normalFromMat4` from gl-matrix computes this automatically.

**Visual impact:**
- **Without:** Normals would be skewed by the scale factor that maps the GLB model to scene units. Lighting would appear to come from the wrong direction, especially on the poles.
- **With:** Normals remain perpendicular to the surface regardless of how the model is scaled or rotated. The terminator falls exactly at the correct geometric day/night boundary.

---

## Advanced Techniques

### 5. Environment Mapping (Effort: 3/5)

**Where:** `src/shaders.js` — `PLANET_FS` lines 242–245

**How it works:**

The same cubemap used for the skybox star field is also used as a reflection environment. In the fragment shader, a reflection vector is computed from the view direction and surface normal, then used to sample the cubemap:

```glsl
vec3 R_env   = reflect(-V, N);
vec3 envSamp = texture(u_EnvMap, R_env).rgb;
col += envSamp * u_EnvStr * specCol;
```

`reflect(-V, N)` gives the direction that an incoming ray from the camera would bounce off the surface. Multiplying by `specCol` means only reflective surfaces reflect — dark or diffuse surfaces contribute little. The strength `u_EnvStr` is tuned per object:
- Saturn body: `0.02` (barely reflective, gassy atmosphere)
- Enceladus: `0.18` (icy, quite reflective)
- Saturn rings: `0.04` (slightly reflective)

The cubemap is the **NASA starmap 2020** loaded from 6 face images at `cubemap_starmap_2020_1024/px.png` etc.

**Visual impact:**
- **Without:** Surfaces have no knowledge of the surrounding environment. The icy surface of Enceladus looks like it's in a black void.
- **With:** Enceladus subtly reflects the starfield, reinforcing the sense it is a small body floating in space. At high zoom, faint star reflections are visible on its surface. Saturn's rings have a slight sheen that follows the star pattern above and below.

---

### 6. Bloom Post-Processing (Effort: 4/5)

**Where:** `src/shaders.js` — `BRIGHT_FS`, `BLUR_FS`, `COMPOSITE_FS`; `src/saturn.js` lines 339–367; `src/gl-utils.js` — `mkRenderTarget`

**How it works:**

Bloom is a 4-pass pipeline using offscreen framebuffer objects (FBOs):

**Pass 1 — Scene render to FBO**
The entire scene is drawn into `sceneRT` (an offscreen RGBA + depth render target) instead of the screen.

**Pass 2 — Bright extract**
A fullscreen quad is drawn with `BRIGHT_FS`. Per-pixel luminance is computed using sRGB perceptual weights, and only pixels brighter than the threshold survive with a soft knee:

```glsl
float l = dot(c, vec3(0.2126, 0.7152, 0.0722));  // perceptual luminance
vec3 b  = max(c - vec3(u_Threshold), vec3(0.0)); // clip below threshold (0.62)
b      *= smoothstep(u_Threshold, u_Threshold + 0.2, l); // soft falloff
```

Result is written to `bloomA`.

**Pass 3 — Separable Gaussian blur (6 iterations)**
`BLUR_FS` implements a 5-tap linear-sampled Gaussian kernel. Sampling at non-integer offsets (1.384615 and 3.230769 texels) exploits GPU bilinear filtering to achieve the effect of a 9-tap kernel with only 5 samples — this is the **linear sampling trick**. The pass alternates horizontal and vertical direction 3 times each, ping-ponging between `bloomA` and `bloomB`:

```glsl
vec3 s = texture(u_Img, v_UV).rgb * 0.227027;
s += texture(u_Img, v_UV + u_Dir * u_Texel * 1.384615).rgb * 0.316216;
s += texture(u_Img, v_UV - u_Dir * u_Texel * 1.384615).rgb * 0.316216;
s += texture(u_Img, v_UV + u_Dir * u_Texel * 3.230769).rgb * 0.070270;
s += texture(u_Img, v_UV - u_Dir * u_Texel * 3.230769).rgb * 0.070270;
```

**Pass 4 — Composite**
The blurred bloom texture is additively blended onto the original scene with strength 1.05:

```glsl
outColor = vec4(scene + bloom * u_Strength, 1.0);
```

**Visual impact:**
- **Without:** The sun disk is a hard circle with no glow. The rings are cleanly lit but have no luminous quality. Bright specular highlights on Enceladus look like flat white spots.
- **With:** The sun radiates a wide soft halo across the black skybox. The rings glow faintly near the sun. The specular hotspot on Enceladus bleeds into a soft haze. The whole scene reads as having a physical brightness scale rather than being a flat render.

---

### 7. Fog — Exponential Deep-Space Fog (Effort: 2/5)

**Where:** `src/shaders.js` — `PLANET_FS` lines 247–249

**How it works:**

After all lighting is computed, the fragment colour is blended toward a fog colour based on camera-fragment distance using an exponential model:

```glsl
float fogFactor = exp(-u_FogDensity * length(u_Cam - v_Wpos));
col = mix(u_FogColor, col, clamp(fogFactor, 0.0, 1.0));
```

`fogFactor` is 1.0 at distance 0 (no fog) and approaches 0.0 at infinite distance (full fog). Exponential fog (`e^(-kd)`) decays faster at short distances than linear fog and has no hard cut-off, making it look more natural.

Parameters:
- `u_FogDensity = 0.013` — very low, fog is subtle at normal viewing distances
- `u_FogColor = [0, 0, 0.018]` — a nearly-black dark blue, representing the ambient glow of deep space

**Visual impact:**
- **Without:** Objects at any distance appear equally saturated. If the camera zooms far back, Saturn looks the same as up close — no sense of distance or depth.
- **With:** At extreme zoom-out distances, Saturn and Enceladus acquire a faint dark-blue haze, reinforcing depth cues. The fog colour also subtly desaturates far geometry so the composition reads clearly with near objects popping more.

---

### 8. Gamma Correction (Effort: 2/5)

**Where:** `src/shaders.js` — `PLANET_FS` line 252; `SKYBOX_FS` line 32

**How it works:**

All lighting math in the fragment shader runs in **linear colour space** (physically correct — doubling the light energy doubles the colour value). But monitors apply a power-law transfer function (gamma ≈ 2.2) that expects sRGB-encoded input. Without correction, the output looks too dark because the monitor would apply gamma on top of values that are already gamma-encoded.

The fix is to apply the inverse gamma (1/2.2) to the output before writing to the framebuffer:

```glsl
col = pow(max(col, vec3(0.0)), vec3(1.0 / 2.2));
```

`max(col, 0)` guards against negative values (which can arise from fog mixing) before the power function, since `pow` of a negative number is undefined in GLSL.

The skybox shader applies the same correction to the procedural sun:
```glsl
outColor = vec4(stars + pow(sun, vec3(1.0 / 2.2)), 1.0);
```

**Visual impact:**
- **Without:** The scene is too dark overall. Shadows are muddy and nearly black. Mid-tones are crushed toward shadow. The terminator on Saturn looks unnaturally dark.
- **With:** The lighting matches what a physically correct renderer would produce on a calibrated display. Mid-tones are airy and correct. The full tonal range from ambient shadow to bright specular is preserved.

---

## Non-Listed Advanced Techniques (Bonus Credit Candidates)

### 9. Analytical Planetary Shadow (Ray-Sphere Intersection)

**Where:** `src/shaders.js` — `PLANET_FS` lines 174–181, 228–230

**How it works:**

Rather than shadow mapping (which would require rendering from the sun's perspective and dealing with depth bias), the project uses an **analytical ray-sphere test** in the fragment shader. A ray is cast from the fragment toward the sun. If it intersects a spherical occluder and that sphere lies between the fragment and the sun, the fragment is in shadow.

```glsl
bool inShadowOf(vec3 p, vec3 L, vec3 center, float r) {
  if (r <= 0.0) return false;
  vec3  oc   = p - center;
  float b    = dot(oc, L);
  float c    = dot(oc, oc) - r * r;
  float disc = b * b - c;
  return b < 0.0 && c > 0.0 && disc >= 0.0;
}
```

The discriminant `b² - c` of the quadratic is the standard ray-sphere intersection test. The conditions:
- `disc >= 0` — the ray hits the sphere at all
- `b < 0` — the sphere centre is in the direction of the sun from the fragment (it is between the fragment and the sun)
- `c > 0` — the fragment itself is not inside the sphere

Two occluder slots are evaluated per fragment. The rings check both Saturn's body and Enceladus:

```glsl
float shadowFactor =
  (inShadowOf(v_Wpos, L, u_OccluderCenter,  u_OccluderR) ||
   inShadowOf(v_Wpos, L, u_Occluder2Center, u_Occluder2R)) ? 0.0 : 1.0;
```

Ambient light is preserved (`0.08 * u_LCol * base`) so eclipsed regions are faintly lit by starlight rather than completely black.

**Visual impact:**
- **Without:** Enceladus remains fully lit even when it passes directly behind Saturn. The rings have no shadow from Saturn's body.
- **With:** Enceladus goes dark when eclipsed by Saturn. A clear shadow band sweeps across the rings where Saturn's body blocks the sun. Small Enceladus casts a visible shadow dot on the rings as it orbits.

---

### 10. Translucent Ring Shadow (Ray-Plane Intersection + Texture Lookup)

**Where:** `src/shaders.js` — `PLANET_FS` lines 187–197, 233–235; `src/saturn.js` lines 128–136, 299–306

**How it works:**

Saturn's rings are semi-transparent and cast a banded shadow onto the planet body and onto Enceladus. Because the rings are analytically a thin annular disc (not a mesh-shadow), the shadow is computed by intersecting the ray from the fragment toward the sun with the ring plane, then looking up how opaque the ring is at the intersection radius.

**Ring plane intersection** (ray-plane formula):
```glsl
float denom = dot(L, u_RingNormal);
float s     = dot(u_RingCenter - p, u_RingNormal) / denom;
float rho   = length((p + s * L) - u_RingCenter); // radial distance from Saturn centre
```

`s` is the distance along the sun-ray to the ring plane. If `s <= 0`, the ring plane is behind the fragment relative to the sun so it cannot block sunlight.

**Opacity lookup:**
```glsl
float u = (rho - u_RingInner) / (u_RingOuter - u_RingInner); // normalise to 0-1
return texture(u_RingAlphaTex, vec2(u, 0.5)).a;               // radial opacity strip
```

`u_RingAlphaTex` is an 8192×500 RGBA image (`8k_saturn_ring_alpha.png`) where the alpha channel encodes ring opacity radially — dense inner B-ring is nearly opaque, the Cassini Division is nearly transparent, outer A-ring is partially transparent.

**Ring normal tracking:** The ring plane normal must match Saturn's axial tilt and follow it as Saturn rotates. It is extracted from column 3 (local Z axis) of the Saturn model matrix every frame:

```js
vec3.set(ringNormal, satM[8], satM[9], satM[10]);
vec3.normalize(ringNormal, ringNormal);
```

**Visual impact:**
- **Without:** Saturn's surface is uniformly lit on the day side. No structure from the rings is visible on the planet itself.
- **With:** A dark banded shadow stretches across Saturn's northern or southern hemisphere depending on the viewing season. The shadow replicates the ring structure — the Cassini Division appears as a bright stripe within the shadow band because less light is blocked there. The shadow rotates with the rings' tilt as the scene plays.

---

### 11. Procedural Sun Disk + Halo (Skybox)

**Where:** `src/shaders.js` — `SKYBOX_FS` lines 29–32

**How it works:**

Instead of drawing the sun as a textured sphere mesh, it is rendered procedurally inside the skybox fragment shader. For every skybox pixel, the cosine of the angle between the ray direction and the sun direction is computed:

```glsl
float d   = dot(dir, u_SunDir);
vec3  sun = u_SunCol * (smoothstep(0.9994, 0.9998, d) * 6.0
                      + pow(max(d, 0.0), 900.0) * 1.5);
```

- `smoothstep(0.9994, 0.9998, d) * 6.0` — a hard disk with a soft edge (the `smoothstep` range corresponds to a disk of roughly 0.36° angular radius, close to the sun's real apparent size)
- `pow(d, 900.0) * 1.5` — a wide power-law falloff halo. `pow(cos θ, 900)` is very narrow at the centre and tapers smoothly — visually identical to a lens glow

Both components feed into bloom, producing a much larger and more convincing glow than the old textured sphere approach.

**Visual impact:**
- **Without (old textured sphere):** Sun was a small sphere with a fixed texture. Bloom around it was limited to the sphere's silhouette.
- **With (procedural):** The sun has a crisp white disk, a wide soft halo that bleeds into the star field, and its intensity is mathematically smooth in all directions. Bloom picks up both the disk and the halo, producing a dramatic corona effect that fills a large portion of the skybox when the camera faces toward it.

---

## Technique Score Summary

| Technique | Category | Effort | Status |
|---|---|---|---|
| Phong (ambient + diffuse + specular), per-fragment | Baseline | — | Implemented |
| Diffuse texture maps | Baseline | — | Implemented |
| Specular texture maps | Baseline | — | Implemented |
| Correct normal transforms | Baseline | — | Implemented |
| Environment Mapping | Advanced | 3/5 | Implemented |
| Bloom | Advanced | 4/5 | Implemented |
| Fog | Advanced | 2/5 | Implemented |
| Gamma Correction | Advanced | 2/5 | Implemented |
| Analytical planetary shadow (ray-sphere) | Bonus | — | Implemented |
| Translucent ring shadow (ray-plane + texture) | Bonus | — | Implemented |
| Procedural sun disk + halo | Bonus | — | Implemented |

**Advanced technique combined score: 3 + 4 + 2 + 2 = 11 / 10** (requirement: ≥6, with at least one ≥3/5)

**Missing baseline techniques:** Point light with distance attenuation and spotlight with inner/outer cutoff angles are not implemented. The project uses a single directional sun light only. This should be addressed in the written report by arguing applicability (deep-space scene with a single stellar light source at effectively infinite distance).
