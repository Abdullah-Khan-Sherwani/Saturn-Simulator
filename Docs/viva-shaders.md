# `src/shaders.js` — Deep-Dive Viva Guide

> All GLSL ES 3.00 shader source code. Eight shader sources across five programs.
> Covers the baseline Phong model plus three advanced techniques:
> Environment Mapping (3/5), Fog (2/5), Gamma Correction (2/5).

---

## Overview: The Five Programs

| Program | VS | FS | Purpose |
|---|---|---|---|
| `skyProg` | `SKYBOX_VS` | `SKYBOX_FS` | Full-screen cubemap background **+ procedural sun disk + halo** |
| `planetProg` | `PLANET_VS` | `PLANET_FS` | Saturn, rings, Enceladus — full Phong + advanced |
| `brightProg` | `POST_VS` | `BRIGHT_FS` | Bloom pass 1: bright-region extraction |
| `blurProg` | `POST_VS` | `BLUR_FS` | Bloom pass 2–3: separable Gaussian blur |
| `compProg` | `POST_VS` | `COMPOSITE_FS` | Bloom pass 4: additive composite |

> **Note on the sun.** Earlier revisions drew the sun as a separate textured
> sphere (`sunProg` with `SUN_VS`/`SUN_FS` + an exponential tone curve). It is
> now drawn procedurally inside `SKYBOX_FS` as a bright disk plus a wide halo
> (ported from the ray-tracer branch), because a large saturated highlight
> feeds the bloom far better than a small textured sphere. The `8k_sun.jpg`
> texture and the sun sphere geometry are no longer used.

---

## Skybox Shaders

### `SKYBOX_VS` — Lines 3–9

```glsl
#version 300 es
in  vec2 a_Pos;
out vec2 v_Ndc;
void main() {
  v_Ndc       = a_Pos;
  gl_Position = vec4(a_Pos, .9999, 1.0);
}
```

The skybox is drawn as a **full-screen quad** — two triangles covering NDC
coordinates (-1,-1) to (1,1). No model or view matrix is applied.

**`gl_Position = vec4(a_Pos, .9999, 1.0)`** — Z is set to `0.9999` instead
of `1.0`. In NDC after perspective divide, z=1.0 is the far plane. With
`gl.depthFunc(gl.LEQUAL)`, fragments at exactly z=1.0 would fail the depth
test against anything else at z=1.0 (including themselves from a prior pass).
`0.9999` is just barely inside the far plane, so the skybox always passes
the depth test against empty space while being overwritten by any actual
geometry that was drawn earlier.

**Why not multiply by VP?** The skybox must surround the camera at infinite
distance. Drawing it as a full-screen quad that reconstructs ray directions
in the FS is simpler and avoids precision issues from very large geometry.

### `SKYBOX_FS` — Lines 11–33

```glsl
uniform samplerCube u_Skybox;
uniform mat4 u_InvViewProj;
uniform vec3 u_Cam;
uniform vec3 u_SunDir;   // normalised direction TOWARD the sun
uniform vec3 u_SunCol;
void main() {
  vec4 farPos = u_InvViewProj * vec4(v_Ndc, 1.0, 1.0);
  vec3 world  = farPos.xyz / max(farPos.w, 1e-6);
  vec3 dir    = normalize(world - u_Cam);
  vec3 stars  = texture(u_Skybox, dir).rgb;
  float d   = dot(dir, u_SunDir);
  vec3  sun = u_SunCol * (smoothstep(0.9994, 0.9998, d) * 6.0
                        + pow(max(d, 0.0), 900.0) * 1.5);
  outColor  = vec4(stars + pow(sun, vec3(1.0 / 2.2)), 1.0);
}
```

**Ray reconstruction from NDC:**
1. Take the fragment's NDC position `(v_Ndc.x, v_Ndc.y, 1.0, 1.0)` — this
   is a point on the far plane in clip space.
2. Multiply by the **inverse view-projection matrix** to get world space.
3. Divide by `w` (perspective divide in reverse) to get the actual world position.
4. Subtract the camera position to get a direction vector.
5. Normalise and sample the cubemap.

`max(farPos.w, 1e-6)` — guard against divide-by-zero if w is exactly 0.

`texture(u_Skybox, dir)` — GLSL cubemap sampling. The GPU selects the correct
face based on the dominant component of `dir`, then bilinearly samples within
that face.

**Procedural sun disk + halo (the bloom source).** `d = dot(dir, u_SunDir)`
is the cosine of the angle between the view ray and the direction toward the
sun: `d → 1` when looking straight at the sun. Two terms build the sun:
- **`smoothstep(0.9994, 0.9998, d) * 6.0`** — a hard, bright disk (~2° radius).
  The value `6.0` is well above 1.0, so the core saturates to pure white.
- **`pow(max(d, 0.0), 900.0) * 1.5`** — a wide, soft halo. A high power of a
  cosine gives a smooth falloff that fades over several degrees.

`pow(sun, 1/2.2)` gamma-corrects the sun term to match the gamma applied to the
planets (the framebuffer is 8-bit, so the bright core clamps to white). Because
the disk is large and saturated and the halo grades smoothly down through the
bloom threshold, the bright-extract + blur passes turn it into a strong, soft
glow — far more convincing than the old small textured sun sphere.

> **Occlusion:** the skybox is drawn first with the depth test disabled (it
> writes no depth), so Saturn, the rings, and Enceladus — drawn afterward with
> the depth test on — correctly paint over the sun where they overlap it.

---

## Post-Processing Vertex Shader

### `POST_VS` — Lines 35–41

```glsl
in vec2 a_Pos;
out vec2 v_UV;
void main() {
  v_UV = a_Pos * 0.5 + 0.5;
  gl_Position = vec4(a_Pos, 0.0, 1.0);
}
```

Converts NDC coordinates (-1 to 1) to UV coordinates (0 to 1):
`uv = ndc * 0.5 + 0.5`. Used by all three post-processing fragment shaders
(bright, blur, composite) — they all sample from a previous pass's render target.

---

## Bloom: Bright Extraction

### `BRIGHT_FS` — Lines 43–55

```glsl
void main() {
  vec3 c = texture(u_Img, v_UV).rgb;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  vec3 b = max(c - vec3(u_Threshold), vec3(0.0));
  b *= smoothstep(u_Threshold, u_Threshold + 0.2, l);
  outColor = vec4(b, 1.0);
}
```

**Luminance** `l = dot(c, vec3(0.2126, 0.7152, 0.0722))` — the ITU-R BT.709
perceptual luminance formula. The coefficients reflect that the human eye is
most sensitive to green, less to red, least to blue.

**Threshold subtraction:** `max(c - threshold, 0)` removes all colour below
the threshold value. Only pixels brighter than `u_Threshold = 0.62` survive.

**`smoothstep(threshold, threshold + 0.2, l)`** — multiplies surviving
pixels by a smooth 0→1 ramp based on luminance. This prevents a hard cutoff
that would create a visible edge between bloomed and non-bloomed regions.
`smoothstep(a, b, x)` returns 0 when x<a, 1 when x>b, cubic Hermite
interpolation in between.

The result is a texture where only the sun and any overexposed highlights
are non-black.

---

## Bloom: Separable Gaussian Blur

### `BLUR_FS` — Lines 57–71

```glsl
uniform vec2 u_Texel;   // (1/width, 1/height)
uniform vec2 u_Dir;     // (1,0) for horizontal, (0,1) for vertical
void main() {
  vec3 s = texture(u_Img, v_UV).rgb * 0.227027;
  s += texture(u_Img, v_UV + u_Dir * u_Texel * 1.384615).rgb * 0.316216;
  s += texture(u_Img, v_UV - u_Dir * u_Texel * 1.384615).rgb * 0.316216;
  s += texture(u_Img, v_UV + u_Dir * u_Texel * 3.230769).rgb * 0.070270;
  s += texture(u_Img, v_UV - u_Dir * u_Texel * 3.230769).rgb * 0.070270;
  outColor = vec4(s, 1.0);
}
```

**Why separable?** A 2D Gaussian blur requires an N×N kernel — O(N²) samples
per pixel. A separable Gaussian can be split into a horizontal 1D pass then
a vertical 1D pass — O(2N) samples per pixel. Mathematically identical result.

**The kernel weights** (0.227027, 0.316216×2, 0.070270×2 = ≈1.0) come from
a 5-tap approximation of a Gaussian curve. The offsets (1.384615, 3.230769
pixels) are optimised sample positions that exploit GPU bilinear interpolation
to effectively sample a 9-tap kernel with only 5 texture fetches (a technique
called *linear sampling* or *GPU optimised Gaussian*).

**6 ping-pong passes in `saturn.js`:**
```js
for (let i = 0; i < 6; i++) {
  const horiz = (i % 2) === 0, writeRT = horiz ? bloomB : bloomA;
  ...
  gl.uniform2f(BlurU.u_Dir, horiz ? 1 : 0, horiz ? 0 : 1);
}
```
3 horizontal + 3 vertical passes. More passes = wider, softer glow.

---

## Bloom: Composite

### `COMPOSITE_FS` — Lines 73–84

```glsl
void main() {
  vec3 scene = texture(u_Scene, v_UV).rgb;
  vec3 bloom = texture(u_Bloom, v_UV).rgb;
  outColor = vec4(scene + bloom * u_Strength, 1.0);
}
```

**Additive blending** in the shader: `scene + bloom * strength`. This is
equivalent to `gl.blendFunc(SRC_ALPHA, ONE)` but done in shader space,
giving more control. `u_Strength = 1.05` — slightly over 1.0 so the bloom
contribution is visually noticeable.

---

## Planet Vertex Shader (`PLANET_VS`) — Lines 86–99

```glsl
in vec3 a_Pos;
in vec3 a_Norm;
in vec2 a_UV;

uniform mat4 u_MVP;
uniform mat4 u_M;
uniform mat3 u_N;
uniform vec2 u_UVRepeat;
uniform vec2 u_UVOffset;

out vec3 v_Wpos;
out vec3 v_Norm;
out vec2 v_UV;

void main() {
  vec4 wp = u_M * vec4(a_Pos, 1.0);
  v_Wpos  = wp.xyz;
  v_Norm  = normalize(u_N * a_Norm);
  v_UV    = a_UV * u_UVRepeat + u_UVOffset;
  gl_Position = u_MVP * vec4(a_Pos, 1.0);
}
```

**Three transform matrices:**
- `u_M` (4×4 model matrix) — transforms from object space to world space.
  Used for lighting: we need the world-space position `v_Wpos` to compute
  light direction and view direction in the FS.
- `u_MVP` (4×4 model-view-projection) — takes object space to clip space.
  Used for `gl_Position`.
- `u_N` (3×3 normal matrix) — transforms normals. **Cannot use `u_M` directly**
  for normals because if the model is non-uniformly scaled, normals would
  point in the wrong direction. The normal matrix is the **transpose of the
  inverse of the upper-left 3×3 of the model matrix** (`mat3.normalFromMat4`
  in `gl-utils.js`). For uniform scale, it equals the 3×3 of `u_M`.

**`vec4(a_Pos, 1.0)`** — homogeneous coordinates: positions have w=1.
**`vec4(a_Norm, 0.0)`** would be used for directions (translations have no
effect on directions), but here we extract only the 3×3 normal matrix, so
the normal vector is implicitly treated as a direction.

**`v_UV = a_UV * u_UVRepeat + u_UVOffset`** — UV tiling. Saturn's rings use
this to tile their texture radially. Default is `uvRepeat=[1,1], uvOffset=[0,0]`.

---

## Planet Fragment Shader (`PLANET_FS`) — Lines 115–255

This is the most complex shader. **Baseline + 3 advanced techniques.**

### Inputs and Uniforms

```glsl
in vec3 v_Wpos;   // world-space position (from VS)
in vec3 v_Norm;   // world-space normal (from VS)
in vec2 v_UV;     // texture coordinates

uniform vec3  u_LDir;        // sun direction (normalised, pointing toward sun)
uniform vec3  u_LCol;        // sun colour (warm white: 1.0, 0.97, 0.85)
uniform vec3  u_Cam;         // camera world position
uniform vec3  u_Base;        // fallback colour if no texture
uniform float u_Shin;        // Phong shininess exponent
uniform float u_SpecK;       // scalar specular coefficient
uniform float u_Alpha;       // opacity
uniform bool  u_TexOn;       // use diffuse texture?
uniform sampler2D u_Tex;     // diffuse texture
uniform float u_AlphaCutoff; // discard threshold (unused here, 0.0)
uniform bool  u_SpecTexOn;   // use specular texture?
uniform sampler2D u_SpecTex; // specular-glossiness texture
uniform samplerCube u_EnvMap; // cubemap for reflections
uniform float u_EnvStr;      // reflection strength
uniform float u_FogDensity;  // fog density coefficient
uniform vec3  u_FogColor;    // deep space fog colour
uniform vec3  u_OccluderCenter;  // shadow occluder sphere #1 center
uniform float u_OccluderR;       // occluder #1 radius (0=disabled)
uniform vec3  u_Occluder2Center; // shadow occluder sphere #2 center
uniform float u_Occluder2R;      // occluder #2 radius (0=disabled)

/* Ring shadow uniforms */
uniform float     u_RingShadowOn;  // 1=receive ring shadow (body/moon), 0=the rings themselves
uniform vec3      u_RingNormal;    // world-space unit normal of the ring plane
uniform vec3      u_RingCenter;    // world-space ring centre (= Saturn centre)
uniform float     u_RingInner;     // world-space inner radius of the ring annulus
uniform float     u_RingOuter;     // world-space outer radius of the ring annulus
uniform sampler2D u_RingAlphaTex;  // radial opacity strip (alpha channel = ring opacity vs radius)
uniform float     u_RingShadowStr; // overall shadow strength (0..1)
```

### Diffuse Texture Fetch + Alpha Discard (lines 200–202)

```glsl
vec4 texel = u_TexOn ? texture(u_Tex, v_UV) : vec4(u_Base, 1.0);
if (texel.a < u_AlphaCutoff) discard;
vec3 base = texel.rgb;
```

`discard` — terminates the fragment shader without writing to any buffer.
Equivalent to setting the fragment as fully transparent. Used for alpha-tested
geometry (ring transparency is handled differently via blending, not discard).

### Phong Lighting Vectors (lines 204–207)

```glsl
vec3 N = normalize(gl_FrontFacing ? v_Norm : -v_Norm);
vec3 V = normalize(u_Cam - v_Wpos);   // view vector
vec3 L = normalize(u_LDir);            // light direction
vec3 H = normalize(L + V);             // half-vector (Blinn-Phong)
```

**`gl_FrontFacing`** — built-in boolean, true when the rasteriser determines
the triangle is front-facing (positive signed area after projection). For
double-sided geometry (rings, planet when viewed from inside), the back face
has its winding reversed, so `v_Norm` points inward — we flip it.

**Blinn-Phong half-vector `H`:** Instead of computing the reflection vector
`R = reflect(-L, N)` and doing `dot(R, V)`, Blinn-Phong uses `dot(N, H)`.
It's an approximation but cheaper and produces a more physically plausible
highlight shape. The two give the same result when the view and light are
coplanar with the normal.

### Phong Diffuse (line 209)

```glsl
float diff = max(dot(N, L), 0.0);
```

Lambert's cosine law: light intensity is proportional to `cos(θ)` where θ
is the angle between the surface normal and the light direction.
`max(..., 0.0)` clamps to zero when the light is behind the surface (θ > 90°).

### Specular Texture / Scalar Specular (lines 213–223)

```glsl
if (u_SpecTexOn) {
  vec4 sg   = texture(u_SpecTex, v_UV);
  specCol   = sg.rgb;          // per-texel specular colour
  shininess = sg.a * 255.0 + 1.0;  // glossiness → shininess exponent
} else {
  specCol   = vec3(u_SpecK);
  shininess = u_Shin;
}
float spec = pow(max(dot(N, H), 0.0), shininess);
```

**`KHR_materials_pbrSpecularGlossiness`** packs RGB specular colour and A
glossiness in one texture. Glossiness is stored as 0–1 normalised; multiplying
by 255 and adding 1 converts to a usable shininess exponent (1 to 256).

`pow(dot(N,H), shininess)` — the Phong specular term. Larger shininess =
tighter, shinier highlight (metals). Smaller = broad, diffuse-like highlight.

### Analytical Planetary Shadow (helper at lines 174–181, test at lines 228–230)

The ray-sphere test lives in a reusable helper so a fragment can be tested
against **two** occluders:

```glsl
bool inShadowOf(vec3 p, vec3 L, vec3 center, float r) {
  if (r <= 0.0) return false;            // unused occluder slot
  vec3  oc   = p - center;
  float b    = dot(oc, L);
  float c    = dot(oc, oc) - r * r;
  float disc = b * b - c;
  return b < 0.0 && c > 0.0 && disc >= 0.0;
}
...
float shadowFactor =
  (inShadowOf(v_Wpos, L, u_OccluderCenter,  u_OccluderR) ||
   inShadowOf(v_Wpos, L, u_Occluder2Center, u_Occluder2R)) ? 0.0 : 1.0;
```

**Ray-sphere intersection test — hardcoded shadow.** This is not shadow
mapping; it's an analytical test: "does the ray from this fragment toward
the sun intersect the occluder sphere?"

The ray is `P(t) = p + t * L`. Substituting into the sphere equation
`|P - center|² = R²` gives a quadratic in `t`:

```
|oc + t*L|² = R²
t² + 2t·dot(oc,L) + dot(oc,oc) - R² = 0
  where oc = p - center
```

Using the quadratic formula with `a=1` (because L is normalised, `dot(L,L)=1`):
- `b = dot(oc, L)` (half coefficient — the full formula has `2b`)
- `c = dot(oc,oc) - R²`
- `disc = b² - c` (discriminant, using `a=1`)

**Three conditions for shadow:**
1. `disc >= 0` — the ray actually intersects the sphere (not a miss)
2. `b < 0.0` — the intersection is in the direction of the light (not behind)
3. `c > 0.0` — the fragment is outside the sphere (it's not inside the occluder)

If either occluder satisfies all three: `shadowFactor = 0.0` → no direct light.
Ambient is kept (`0.08 * u_LCol * base`) so shadowed regions stay faintly lit.

**Why two occluders?** `PLANET_FS` only supports an analytical shadow from a
single sphere per draw call, but the rings need to be eclipsed by **both**
Saturn's body (its broad shadow band across the rings) **and** Enceladus (a
small shadow dot tracking across the rings as it orbits). `saturn.js` therefore
fills slot #1 with Saturn's body and slot #2 with Enceladus for the ring draw;
the Saturn-body and Enceladus draws use only slot #1 and disable slot #2 with
`R = 0`. (A previous revision had a single slot and could show only one of the
two shadows at a time.)

### Translucent Ring Shadow — `ringShadow()` helper

```glsl
float ringShadow(vec3 p, vec3 L) {
  if (u_RingShadowOn < 0.5) return 0.0;
  float denom = dot(L, u_RingNormal);
  if (abs(denom) < 1e-4) return 0.0;                       // ray parallel to ring plane
  float s = dot(u_RingCenter - p, u_RingNormal) / denom;
  if (s <= 0.0) return 0.0;                                // plane is away from the sun
  float rho = length((p + s * L) - u_RingCenter);
  if (rho < u_RingInner || rho > u_RingOuter) return 0.0;  // misses the annulus
  float u = (rho - u_RingInner) / (u_RingOuter - u_RingInner);
  return texture(u_RingAlphaTex, vec2(u, 0.5)).a;
}
```

**What it does:** For a given fragment world position `p` and sunlight direction
`L`, determine how much of the direct sunlight is blocked by the ring disc.

**Step by step:**
1. **`u_RingShadowOn` gate** — early return `0.0` for the ring meshes themselves
   (controlled by `saturn.js` setting the flag to 0.0 before drawing rings).

2. **Ray-plane intersection.** The ring plane is defined by its normal `u_RingNormal`
   and a point on it `u_RingCenter`. The ray is `p + s * L`. Substituting into the
   plane equation `dot(point - u_RingCenter, u_RingNormal) = 0` gives:
   ```
   s = dot(u_RingCenter - p, u_RingNormal) / dot(L, u_RingNormal)
   ```
   `denom = dot(L, u_RingNormal)` is the cosine of the angle between the sun ray and
   the ring plane normal. If near zero, the ray is nearly parallel to the ring plane
   and would never meaningfully intersect it — skip.

3. **`s <= 0` check** — if the intersection is behind the fragment relative to the sun
   direction (i.e. the ring plane is on the wrong side), no shadow.

4. **Annulus test** — compute `rho`, the radial distance from the ring centre to the
   intersection point. If it's outside `[ringInner, ringOuter]`, the ray misses the
   ring disc entirely.

5. **Opacity lookup** — normalize `rho` to `u ∈ [0, 1]` across the annulus width and
   sample the radial opacity texture. The texture's **alpha channel** encodes the ring's
   real density profile (dense B-ring, nearly transparent Cassini Division, faint A-ring
   edges). Return that alpha as the shadow strength.

**Usage in `main()`:**
```glsl
float ringLit = 1.0 - ringShadow(v_Wpos, L) * u_RingShadowStr;
float lit     = shadowFactor * ringLit;
vec3 diffuse  = diff * lit * u_LCol * base;
vec3 specular = spec * lit * u_LCol * specCol;
```

The ring shadow is multiplied into the **direct-light** factor alongside the sphere
shadow. Ambient light is intentionally left unaffected — a shadowed region still
receives a small ambient contribution from indirect starlight (the `0.08` ambient term),
so it doesn't go completely black.

This differs from the sphere shadow in that it's **translucent**: a ring opacity of 0.5
only halves the direct light (a thin part of the rings), whereas the sphere shadow is
binary (full occlude or none).

### Phong Accumulation

```glsl
vec3 ambient  = 0.08 * u_LCol * base;
vec3 diffuse  = diff * lit * u_LCol * base;
vec3 specular = spec * lit * u_LCol * specCol;
vec3 col = ambient + diffuse + specular;
```

Classic Phong: `ambient + diffuse + specular`. The combined `lit = shadowFactor * ringLit`
factor suppresses diffuse and specular without touching ambient — physically motivated
(ambient represents indirect light bouncing from everywhere, which shadow cannot block).

### Advanced Technique 1: Environment Mapping (lines 242–245)

```glsl
vec3 R_env   = reflect(-V, N);
vec3 envSamp = texture(u_EnvMap, R_env).rgb;
col += envSamp * u_EnvStr * specCol;
```

**Concept:** Sample the cubemap (which contains the star field) using the
reflection direction of the view ray off the surface normal. This simulates
the surface reflecting its surroundings.

**`reflect(-V, N)`** — GLSL built-in. `reflect(I, N) = I - 2·dot(N,I)·N`.
Here `I = -V` (the incident ray direction pointing toward the surface).
The result `R_env` is the direction the view ray bounces off the surface.

**`col += envSamp * u_EnvStr * specCol`** — weighted by specular colour and
strength. Specular colour is used as a mask: shiny regions reflect more.
- Saturn body: `u_EnvStr = 0.02` (barely visible — it's not mirror-like)
- Enceladus: `u_EnvStr = 0.18` (icy surface, more reflective)
- Rings: `u_EnvStr = 0.04` (subtle sparkle)

### Advanced Technique 2: Fog (lines 247–249)

```glsl
float fogFactor = exp(-u_FogDensity * length(u_Cam - v_Wpos));
col = mix(u_FogColor, col, clamp(fogFactor, 0.0, 1.0));
```

**Exponential fog model:** `fogFactor = e^(-density * distance)`.
- At distance 0: `e^0 = 1` → fully visible (no fog)
- At large distance: `e^(-∞) → 0` → fully fog colour

**`mix(a, b, t)`** — GLSL built-in linear interpolation: `a*(1-t) + b*t`.
So: `mix(fogColor, col, fogFactor)` = at fogFactor=1 (near), use `col`;
at fogFactor=0 (far), use `fogColor`.

`u_FogColor = (0, 0, 0.018)` — a very dark blue, matching the deep-space
ambient colour, so far objects fade into the void rather than a white mist.
`u_FogDensity = 0.013` — very low, so fog only affects very distant objects
(Enceladus at 15 units from Saturn gets mild fog contribution).

### Advanced Technique 3: Gamma Correction (lines 251–252)

```glsl
col = pow(max(col, vec3(0.0)), vec3(1.0 / 2.2));
```

**The problem:** Monitors apply a gamma of ~2.2: they display `voltage^2.2`.
Linear shading computations produce linear intensity values. If you display
linear values directly, the image appears too dark (perceptually speaking).

**The fix:** Apply the inverse gamma (`1/2.2 ≈ 0.4545`) before output.
The monitor then applies `(x^0.4545)^2.2 = x^1.0` — back to linear. The
viewer sees correct brightness.

`max(col, vec3(0.0))` — `pow` of a negative number is undefined in GLSL.
Clamp to 0 before the power operation.

This converts from **linear colour space** to **sRGB display space**.

---

## Key Concepts Summary for Viva

| Concept | Shader | Key line(s) |
|---|---|---|
| Full-screen quad skybox, Z=0.9999 trick | `SKYBOX_VS` | `gl_Position = vec4(a_Pos, .9999, 1.0)` |
| Inverse VP ray reconstruction | `SKYBOX_FS` | `u_InvViewProj * ndc → world → dir` |
| Procedural sun disk + halo (bloom source) | `SKYBOX_FS` | `smoothstep` disk + `pow(d,900)` halo |
| NDC to UV conversion | `POST_VS` | `uv = pos * 0.5 + 0.5` |
| Luminance with BT.709 coefficients | `BRIGHT_FS` | `dot(c, vec3(0.2126, 0.7152, 0.0722))` |
| `smoothstep` soft threshold | `BRIGHT_FS` | Avoids hard bloom cutoff edge |
| Separable Gaussian blur | `BLUR_FS` | `u_Dir` ping-pong, 5-tap weights |
| Normal matrix (not model matrix) | `PLANET_VS` | `u_N = transpose(inverse(M_3x3))` |
| `gl_FrontFacing` for double-sided normals | `PLANET_FS` | Ring and interior rendering |
| Blinn-Phong half-vector | `PLANET_FS` | `H = normalize(L + V)` |
| Analytical ray-sphere shadow (two occluders) | `PLANET_FS` | `inShadowOf()`, `b < 0 && c > 0 && disc ≥ 0` |
| Translucent ring shadow (ray-plane) | `PLANET_FS` | `ringShadow()`: intersect ray→sun with ring plane, sample radial opacity |
| Ring shadow gate (`u_RingShadowOn`) | `PLANET_FS` | 0.0 for ring meshes prevents self-shadowing |
| `lit = shadowFactor * ringLit` | `PLANET_FS` | Both hard sphere shadow and soft ring shadow combined before Phong |
| Environment mapping with `reflect()` | `PLANET_FS` | `reflect(-V, N)` → cubemap sample |
| Exponential fog | `PLANET_FS` | `exp(-density * dist)`, `mix()` |
| Gamma correction | `PLANET_FS` | `pow(col, 1/2.2)` → sRGB output |
