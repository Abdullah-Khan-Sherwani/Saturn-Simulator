/* GLSL ES 3.00 shader sources — exported for use by saturn.js */

/* ── Skybox vertex shader ────────────────────────────────────────────────────
   Draws a full-screen quad; the fragment shader reconstructs world-space ray
   directions from each pixel's NDC position.
─────────────────────────────────────────────────────────────────────────── */
export const SKYBOX_VS = /* glsl */`#version 300 es
in  vec2 a_Pos;   // NDC xy from the full-screen quad: each vertex is in [-1,1]x[-1,1]
out vec2 v_Ndc;   // pass NDC position to fragment shader for ray reconstruction
void main() {
  v_Ndc       = a_Pos;

  /* Z = 0.9999 instead of 1.0:
     With gl.depthFunc(LEQUAL), z=1.0 would fail against itself if the depth
     buffer already has 1.0 from a cleared state. 0.9999 is just below the far
     plane so the skybox always passes the depth test against empty space, but
     any actual geometry drawn later (with depth test ON) will overwrite it. */
  gl_Position = vec4(a_Pos, .9999, 1.0);
  /* w=1.0: after the GPU's automatic perspective divide (z/w), z stays 0.9999. */
}`;

/* ── Skybox fragment shader ──────────────────────────────────────────────────
   Reconstructs a world-space ray per pixel, samples the star cubemap, then
   draws a procedural sun disk + soft halo in that direction.
─────────────────────────────────────────────────────────────────────────── */
export const SKYBOX_FS = /* glsl */`#version 300 es
precision highp float;
in  vec2 v_Ndc;
uniform samplerCube u_Skybox;       // star-field cubemap (6 faces)
uniform mat4        u_InvViewProj;  // inverse of (projection * view) — unprojects NDC → world
uniform vec3        u_Cam;          // camera world position (eye point)
uniform vec3        u_SunDir;       // unit vector pointing FROM the scene TOWARD the sun
uniform vec3        u_SunCol;       // sun light colour, e.g. (1.0, 0.97, 0.85) warm white
out vec4 outColor;
void main() {
  /* ── Ray reconstruction from screen position ──────────────────────────── */

  /* Place the NDC fragment on the far plane in clip space: (x, y, 1.0, 1.0).
     z=1.0 is the far plane, w=1.0 is the homogeneous coordinate before divide. */
  vec4 farPos = u_InvViewProj * vec4(v_Ndc, 1.0, 1.0);

  /* Manual perspective divide: clip → world.
     The projection matrix encodes depth as a ratio, leaving a non-trivial w.
     Dividing xyz by w reverses that encoding and yields the actual world position.
     max(w, 1e-6) guards against divide-by-zero if w rounds to exactly 0.0. */
  vec3 world  = farPos.xyz / max(farPos.w, 1e-6);

  /* Direction from the camera to this point on the far plane.
     normalize(v) = v / length(v), where length = sqrt(x²+y²+z²).
     Result is a unit-length direction vector suitable for cubemap sampling. */
  vec3 dir    = normalize(world - u_Cam);

  /* texture(samplerCube, vec3 dir): sample the cubemap in direction dir.
     The GPU selects the face whose dominant axis matches dir, then bilinearly
     interpolates within that face. .rgb discards the alpha channel. */
  vec3 stars  = texture(u_Skybox, dir).rgb;

  /* ── Procedural sun disk + halo ──────────────────────────────────────────
     Ported from the ray-tracer branch. A large pure-white disk + wide falloff
     feeds the bloom pipeline far better than a small textured sphere. */

  /* d = dot(dir, u_SunDir) = cos(θ) where θ is the angle between the view ray
     and the direction toward the sun. dot(a,b) = a.x*b.x + a.y*b.y + a.z*b.z.
     d → 1.0 when looking straight at the sun; d → -1 when looking away. */
  float d   = dot(dir, u_SunDir);

  vec3  sun = u_SunCol * (
    /* Hard disk: smoothstep(edge0, edge1, x) returns 0 when x≤edge0, 1 when
       x≥edge1, and a cubic Hermite (3t²-2t³) in between.
       The range [0.9994, 0.9998] corresponds to a viewing angle of ~2° from
       the sun centre. Multiplied by 6.0 → saturates to pure white (intentionally
       overexposed) so the bright-extract pass produces a large bloom input. */
    smoothstep(0.9994, 0.9998, d) * 6.0
    /* Soft halo: pow(cos θ, n) gives a peak at θ=0 with a smooth falloff.
       Exponent 900 creates a relatively narrow peak, but the tail still extends
       several degrees, producing the glow. max(d,0.0) is required because
       pow(negative, non-integer) is undefined in GLSL — clamp to 0 first. */
  + pow(max(d, 0.0), 900.0) * 1.5);

  /* pow(sun, vec3(1.0/2.2)): per-component gamma correction (sRGB encoding).
     The monitor applies γ=2.2 to every displayed value (it outputs voltage^2.2).
     Pre-encoding with 1/2.2 ≈ 0.4545 cancels this: (x^0.4545)^2.2 = x^1.0.
     Applied to the sun term so its brightness matches the gamma-corrected planets. */
  outColor  = vec4(stars + pow(sun, vec3(1.0 / 2.2)), 1.0);
}`;

/* ── Post-processing vertex shader ───────────────────────────────────────────
   Shared by all three post-processing passes (bright-extract, blur, composite).
   Draws the same full-screen quad but outputs UV [0,1] instead of NDC.
─────────────────────────────────────────────────────────────────────────── */
export const POST_VS = /* glsl */`#version 300 es
in vec2 a_Pos;   // NDC quad vertices in [-1,1]x[-1,1]
out vec2 v_UV;   // texture coordinates in [0,1]x[0,1] for sampling the previous pass
void main() {
  /* Convert NDC [-1,1] → UV [0,1]: uv = ndc * 0.5 + 0.5
     texture() expects UV in [0,1]; the quad is defined in NDC [-1,1]. */
  v_UV = a_Pos * 0.5 + 0.5;

  /* Z=0 places this quad in the middle of the depth range; depth test is
     disabled for all post passes so the value doesn't matter. */
  gl_Position = vec4(a_Pos, 0.0, 1.0);
}`;

/* ── Bloom pass 1: bright-region extraction ──────────────────────────────────
   Keeps only pixels brighter than u_Threshold; everything else goes black.
   Result feeds the blur pass.
─────────────────────────────────────────────────────────────────────────── */
export const BRIGHT_FS = /* glsl */`#version 300 es
precision highp float;
in vec2 v_UV;
uniform sampler2D u_Img;        // scene render target (output of pass 1)
uniform float     u_Threshold;  // luminance cutoff — set to 0.62 in saturn.js
out vec4 outColor;
void main() {
  /* texture(sampler2D, vec2 uv): bilinearly sample u_Img at position v_UV.
     Returns a vec4 (r,g,b,a); .rgb drops the alpha. */
  vec3 c = texture(u_Img, v_UV).rgb;

  /* Perceptual luminance — ITU-R BT.709 formula:
       L = 0.2126·R + 0.7152·G + 0.0722·B
     dot(c, vec3(...)): c.r*0.2126 + c.g*0.7152 + c.b*0.0722.
     Coefficients reflect the human eye's spectral sensitivity (most sensitive
     to green, moderate to red, least to blue). */
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));

  /* Threshold subtraction: keep only the amount by which each channel exceeds
     the threshold. max(x, 0.0) component-wise clamps negatives to zero. */
  vec3 b = max(c - vec3(u_Threshold), vec3(0.0));

  /* Soft gate: smoothstep(edge0, edge1, x) = cubic Hermite 0→1 in [edge0,edge1].
     Multiplying surviving brightness by this ramp prevents a hard visible edge
     at exactly the threshold value (hard cutoff would alias as a halo boundary). */
  b *= smoothstep(u_Threshold, u_Threshold + 0.2, l);

  outColor = vec4(b, 1.0);
}`;

/* ── Bloom pass 2–3: separable Gaussian blur ─────────────────────────────────
   A 2D Gaussian is separable: one horizontal + one vertical 1D pass gives the
   same result as a full 2D kernel but with O(2N) samples instead of O(N²).
   Called 6 times (3 horizontal, 3 vertical) via ping-pong in saturn.js.
─────────────────────────────────────────────────────────────────────────── */
export const BLUR_FS = /* glsl */`#version 300 es
precision highp float;
in vec2 v_UV;
uniform sampler2D u_Img;    // input from previous blur pass (or bright-extract)
uniform vec2      u_Texel;  // (1/width, 1/height) — size of one pixel in UV space
uniform vec2      u_Dir;    // blur axis: (1,0) = horizontal, (0,1) = vertical
out vec4 outColor;
void main() {
  /* 5-tap optimised Gaussian kernel.
     Weights: 0.227027 (centre), 0.316216 (±offset1), 0.070270 (±offset2).
     Sum ≈ 1.0 — energy-preserving (no brightness change from blurring).

     Non-integer offsets (1.384615, 3.230769 pixels) exploit GPU bilinear
     filtering: sampling between two pixel centres blends them in proportion
     to the fractional offset, effectively sampling a 9-tap kernel with only
     5 texture fetches (a GPU-optimised Gaussian technique).

     u_Dir * u_Texel: step vector in UV space — one pixel along the blur axis.
     Multiplied by the offset to step 1.38 or 3.23 pixels from centre. */

  vec3 s = texture(u_Img, v_UV).rgb * 0.227027;
  s += texture(u_Img, v_UV + u_Dir * u_Texel * 1.384615).rgb * 0.316216;
  s += texture(u_Img, v_UV - u_Dir * u_Texel * 1.384615).rgb * 0.316216;
  s += texture(u_Img, v_UV + u_Dir * u_Texel * 3.230769).rgb * 0.070270;
  s += texture(u_Img, v_UV - u_Dir * u_Texel * 3.230769).rgb * 0.070270;
  outColor = vec4(s, 1.0);
}`;

/* ── Bloom pass 4: additive composite ───────────────────────────────────────
   Adds the blurred bloom on top of the sharp 3D scene.
─────────────────────────────────────────────────────────────────────────── */
export const COMPOSITE_FS = /* glsl */`#version 300 es
precision highp float;
in vec2 v_UV;
uniform sampler2D u_Scene;    // sharp 3D scene from pass 1
uniform sampler2D u_Bloom;    // blurred bright regions from pass 3
uniform float     u_Strength; // bloom contribution scale — set to 1.05
out vec4 outColor;
void main() {
  vec3 scene = texture(u_Scene, v_UV).rgb;
  vec3 bloom = texture(u_Bloom, v_UV).rgb;
  /* Additive blend in shader space: scene + bloom * strength.
     u_Strength = 1.05 — slightly over 1.0 so the sun's glow is clearly visible.
     This is equivalent to gl.blendFunc(ONE, ONE) but gives per-pass control. */
  outColor = vec4(scene + bloom * u_Strength, 1.0);
}`;

/* ── Planet vertex shader ────────────────────────────────────────────────────
   Transforms each vertex into clip space and interpolates per-vertex attributes
   (world position, normal, UVs) to the fragment shader.
─────────────────────────────────────────────────────────────────────────── */
export const PLANET_VS = /* glsl */`#version 300 es
in vec3 a_Pos;   // vertex position in object/model space
in vec3 a_Norm;  // vertex normal in object/model space (unit length from GLB)
in vec2 a_UV;    // primary texture coordinate (TEXCOORD_0) — diffuse maps
in vec2 a_UV2;   // second UV set (TEXCOORD_1) — spec maps are authored against this

uniform mat4 u_MVP;       // model-view-projection: object space → clip space
uniform mat4 u_M;         // model matrix: object space → world space (for lighting)
uniform mat3 u_N;         // normal matrix = transpose(inverse(upper-left 3×3 of u_M))
                          // cannot use u_M for normals: non-uniform scale would skew them
uniform vec2 u_UVRepeat;  // UV tiling multiplier (default [1,1] = no tiling)
uniform vec2 u_UVOffset;  // UV offset / scroll (default [0,0])

out vec3 v_Wpos;  // world-space position — used in FS for light/view vectors and fog
out vec3 v_Norm;  // world-space normal — used in FS for Phong shading
out vec2 v_UV;    // tiled/offset UV for diffuse sampling
out vec2 v_UV2;   // raw UV2 for specular map sampling

void main() {
  /* Transform position to world space for lighting calculations.
     vec4(a_Pos, 1.0): homogeneous coords — w=1 for a point (vs. w=0 for directions).
     u_M * p applies translation, rotation, scale. */
  vec4 wp = u_M * vec4(a_Pos, 1.0);
  v_Wpos  = wp.xyz;  // discard w (always 1 after a rigid-body transform)

  /* Transform normal to world space.
     normalize(v): scale v to unit length — v / sqrt(v.x²+v.y²+v.z²).
     u_N (normal matrix) correctly handles non-uniform scale; using u_M directly
     would skew normals so they no longer point perpendicular to the surface. */
  v_Norm  = normalize(u_N * a_Norm);

  /* Apply UV tiling + offset: uv_final = uv_model * repeat + offset.
     For example, a ring with uvRepeat=[4,1] tiles the texture 4× radially. */
  v_UV    = a_UV * u_UVRepeat + u_UVOffset;
  v_UV2   = a_UV2;  // pass through unchanged — used as-is by the spec sampler

  /* Transform to clip space. u_MVP = proj * view * model.
     gl_Position is the built-in clip-space output; the GPU auto-divides by w
     to produce NDC, then maps to the viewport. */
  gl_Position = u_MVP * vec4(a_Pos, 1.0);
}`;

/* ── Planet fragment shader ─────────────────────────────────────────────────
   Baseline  : Phong (ambient + diffuse + specular), per-fragment, textures,
               material shininess + reflectance, directional sun + point light.
   Advanced  : Environment Mapping (3/5) · Fog (2/5) · Gamma Correction (2/5)
               Combined effort: 7 / 10.
──────────────────────────────────────────────────────────────────────────── */
export const PLANET_FS = /* glsl */`#version 300 es
precision highp float;

in vec3 v_Wpos;  // world-space fragment position (interpolated from VS)
in vec3 v_Norm;  // world-space normal (interpolated, may need re-normalising)
in vec2 v_UV;    // tiled UV for diffuse texture
in vec2 v_UV2;   // raw UV2 for specular texture

uniform vec3  u_LDir;  // unit direction vector FROM the scene TOWARD the sun (directional light)
uniform vec3  u_LCol;  // sun colour — (1.0, 0.97, 0.85) warm white

uniform vec3      u_Base;         // fallback diffuse colour if no texture
uniform float     u_Shin;         // Phong shininess exponent n (large n = tight highlight)
uniform float     u_SpecK;        // scalar specular coefficient (used when no spec map)
uniform float     u_Alpha;        // overall opacity of this mesh
uniform bool      u_TexOn;        // true = sample u_Tex; false = use u_Base colour
uniform sampler2D u_Tex;          // diffuse (albedo) texture
uniform float     u_AlphaCutoff;  // alpha-test threshold: discard if texel.a < this
uniform bool      u_SpecTexOn;    // true = sample spec map; false = use scalar u_SpecK/u_Shin
uniform sampler2D u_SpecTex;      // KHR_materials_pbrSpecularGlossiness specular-gloss map
                                  //   RGB = specular colour, A = glossiness (0=matte, 1=mirror)
uniform float     u_SpecUV;       // which UV set to sample the spec map with: 0=v_UV, 1=v_UV2
uniform vec3      u_SpecFactor;   // material specularFactor — multiplied into spec map RGB
uniform float     u_GlossFactor;  // material glossinessFactor — multiplied into spec map A

/* Environment Mapping (Advanced 3/5) — reflects the star cubemap off shiny surfaces */
uniform samplerCube u_EnvMap;  // the same star-field cubemap used for the skybox
uniform float       u_EnvStr;  // reflection strength: 0.02 (Saturn body), 0.18 (Enceladus icy), 0.04 (rings)

/* Fog (Advanced 2/5) — exponential deep-space fog */
uniform float u_FogDensity;  // density coefficient k in e^(-k*d): 0.013 for this scene
uniform vec3  u_FogColor;    // fog colour — (0, 0, 0.018) very dark blue (deep space void)

/* Analytical planetary shadow — up to two occluder spheres (center + radius).
   Saturn shadowing Enceladus: center=origin, R=satBodyRadius.
   Enceladus shadowing Saturn: center=encWorldPos, R=encRadius.
   The rings use both slots: Saturn's body (broad shadow band) + Enceladus
   (small shadow dot). R=0 disables that slot. */
uniform vec3  u_OccluderCenter;   // world-space centre of occluder sphere #1
uniform float u_OccluderR;        // radius of occluder #1 (0 = disabled)
uniform vec3  u_Occluder2Center;  // world-space centre of occluder sphere #2
uniform float u_Occluder2R;       // radius of occluder #2 (0 = disabled)

/* Translucent ring shadow — the rings are a thin annulus in Saturn's
   equatorial plane and partly block sunlight, casting a soft banded shadow
   onto Saturn's body and (occasionally) onto Enceladus. We project the
   fragment toward the sun onto the ring plane and look up the ring's radial
   opacity. u_RingNormal is the plane normal in WORLD space (derived from the
   model matrix's local +Z axis, so it stays correct as Saturn spins/tilts —
   this is what previously fell 90° off when the spin axis was used instead). */
uniform float     u_RingShadowOn;   // 1.0 = this mesh receives ring shadow; 0.0 = it IS the ring (no self-shadow)
uniform vec3      u_RingNormal;     // world-space unit normal of the ring plane (= transformed local +Z)
uniform vec3      u_RingCenter;     // world-space ring centre (= Saturn's centre, at the world origin)
uniform float     u_RingInner;      // world-space inner radius of the ring annulus (smallest ring vertex radius)
uniform float     u_RingOuter;      // world-space outer radius of the ring annulus (largest ring vertex radius)
uniform sampler2D u_RingAlphaTex;   // radial opacity strip — alpha = ring opacity at that radius
uniform float     u_RingShadowStr;  // master shadow strength multiplier (0..1), set to 0.9

uniform vec3 u_Cam;   // camera world position — used for V (view vector) and fog distance
out vec4 outColor;

/* ── Helper: analytical ray-sphere shadow ────────────────────────────────────
   Determines whether the point p is in the shadow of a sphere.
   Casts a ray p → sun (direction L) and checks if it hits the sphere.

   Derivation — ray: P(t) = p + t*L; sphere: |X - center|² = r²
   Substitute and expand:
     |oc + t*L|² = r²,  where oc = p - center
     t² + 2t·(oc·L) + (|oc|² - r²) = 0
     a=1 (L is unit), b_half = dot(oc,L), c = dot(oc,oc) - r²
     discriminant = b_half² - c

   Parameters:
     p      — world-space fragment position
     L      — unit vector toward the sun
     center — world-space centre of the occluder sphere
     r      — radius of the occluder sphere (r≤0 disables the test)
─────────────────────────────────────────────────────────────────────────── */
bool inShadowOf(vec3 p, vec3 L, vec3 center, float r) {
  if (r <= 0.0) return false;  // radius=0 → occluder slot unused

  vec3  oc   = p - center;
  /* b = dot(oc, L): signed projection of (fragment-to-centre) onto the sun direction.
     dot(a,b) = a.x*b.x + a.y*b.y + a.z*b.z.
     b < 0 means the sphere centre lies in the sun-direction hemisphere from p
     (the sphere is between p and the sun), which is required for a shadow. */
  float b    = dot(oc, L);

  /* c = |oc|² - r²: >0 means p is outside the sphere (we only shadow exterior points).
     dot(oc,oc) = |oc|² = the squared distance from p to the sphere centre. */
  float c    = dot(oc, oc) - r * r;

  /* discriminant = b² - c (with a=1 because L is a unit vector, so a=dot(L,L)=1).
     disc < 0 → ray misses the sphere entirely (no intersection).
     disc ≥ 0 → ray hits the sphere → potential shadow. */
  float disc = b * b - c;

  /* All three conditions must hold:
     b < 0    → sphere is ahead of p in the light direction (not behind)
     c > 0    → p is outside the sphere (not inside it)
     disc ≥ 0 → ray actually intersects the sphere */
  return b < 0.0 && c > 0.0 && disc >= 0.0;
}

/* ── Helper: translucent ring shadow ─────────────────────────────────────────
   Finds where the ray from p toward the sun pierces the ring plane, then
   looks up the ring's radial opacity to determine how much direct light is
   blocked. Returns 0 (no shadow) to 1 (fully blocked by dense ring).

   Ring plane equation: dot(X - u_RingCenter, u_RingNormal) = 0
   Ray:                 X(s) = p + s * L
   Solving for s: dot(p + s*L - u_RingCenter, u_RingNormal) = 0
                  s = dot(u_RingCenter - p, u_RingNormal) / dot(L, u_RingNormal)

   Parameters:
     p — world-space fragment position
     L — unit vector toward the sun
─────────────────────────────────────────────────────────────────────────── */
float ringShadow(vec3 p, vec3 L) {
  /* u_RingShadowOn < 0.5 means this mesh IS the ring — skip self-shadow. */
  if (u_RingShadowOn < 0.5) return 0.0;

  /* denom = dot(L, u_RingNormal): cosine of angle between the sun ray and
     the ring plane normal. Near 0 → ray nearly parallel to the ring plane
     (would intersect far away or not meaningfully) → no shadow. */
  float denom = dot(L, u_RingNormal);
  if (abs(denom) < 1e-4) return 0.0;

  /* s: the ray parameter at the ring plane intersection.
     s > 0 means the ring plane is ahead of p in the sun direction (correct).
     s ≤ 0 means the ring is on the far side of p from the sun — no shadow. */
  float s = dot(u_RingCenter - p, u_RingNormal) / denom;
  if (s <= 0.0) return 0.0;

  /* rho: Euclidean distance from Saturn's centre to the intersection point,
     measured in the ring plane.
     length(v) = sqrt(v.x²+v.y²+v.z²) — the radial distance.
     p + s*L: the world-space point where the ray hits the ring plane. */
  float rho = length((p + s * L) - u_RingCenter);

  /* If the intersection falls outside the ring annulus, there is no ring
     material here — no shadow. */
  if (rho < u_RingInner || rho > u_RingOuter) return 0.0;

  /* Normalise rho to [0,1] across the annulus width.
     u=0 at the inner edge, u=1 at the outer edge. */
  float u = (rho - u_RingInner) / (u_RingOuter - u_RingInner);

  /* texture(sampler2D, vec2 uv): bilinearly sample the 2D opacity strip.
     The alpha channel encodes the ring's real radial opacity profile:
     dense B-ring, near-zero Cassini Division gap, partial A-ring, etc.
     v=0.5 samples the centre row (the strip is vertically uniform). */
  return texture(u_RingAlphaTex, vec2(u, 0.5)).a;
}

void main() {
  /* ── Surface colour ───────────────────────────────────────────────────── */

  /* texture(sampler2D, vec2): sample the diffuse texture at the tiled UV.
     If no texture, use the uniform base colour as a solid-colour vec4. */
  vec4 texel = u_TexOn ? texture(u_Tex, v_UV) : vec4(u_Base, 1.0);

  /* Alpha test: discard kills the fragment entirely (no colour or depth write).
     Used for geometry with hard cutout transparency (u_AlphaCutoff=0 → disabled). */
  if (texel.a < u_AlphaCutoff) discard;
  vec3 base = texel.rgb;  // surface albedo (colour without lighting)

  /* ── Lighting vectors ─────────────────────────────────────────────────── */

  /* gl_FrontFacing: GLSL built-in bool — true when this fragment's triangle
     has positive signed area after projection (front face, normal points toward camera).
     For double-sided geometry (rings viewed from below, planet interior), the back
     face has reversed winding → v_Norm points inward. Flip it so N always faces outward.
     normalize(v): scale to unit length so all dot products give exact cosines. */
  vec3 N = normalize(gl_FrontFacing ? v_Norm : -v_Norm);

  /* V = view vector: unit direction from the surface fragment toward the camera.
     normalize(u_Cam - v_Wpos): (camera - fragment) gives a vector pointing toward
     the camera, then normalised to unit length. */
  vec3 V = normalize(u_Cam - v_Wpos);

  /* L = light direction: unit vector pointing toward the sun.
     Already normalised from JS but normalize() is free on the GPU. */
  vec3 L = normalize(u_LDir);

  /* H = Blinn-Phong half-vector: halfway between L and V.
     Formula: H = normalize(L + V).
     dot(N, H) approximates dot(R, V) where R = reflect(-L, N), but is cheaper
     to compute and produces a more physically plausible highlight shape. */
  vec3 H = normalize(L + V);

  /* ── Phong diffuse term ───────────────────────────────────────────────── */

  /* Lambert's cosine law: diffuse intensity ∝ cos(θ_L) = N·L
     dot(N, L): N.x*L.x + N.y*L.y + N.z*L.z. Result is cos(θ) because both are unit.
     max(..., 0.0): clamp negative values (back-lit surfaces) to zero — they receive
     no direct light, not negative light. */
  float diff = max(dot(N, L), 0.0);

  /* ── Specular colour + shininess from spec map ───────────────────────── */

  /* KHR_materials_pbrSpecularGlossiness format:
       RGB = specular colour (tints the highlight)
       A   = glossiness in [0,1] → 0 = perfectly matte, 1 = mirror-like
     Scaled by the material's specFactor and glossFactor (from the GLB file).
     The spec map is sampled with its own authored UV set (u_SpecUV selects
     v_UV2 for these assets since they were baked to TEXCOORD_1). */
  vec3  specCol;
  float shininess;
  if (u_SpecTexOn) {
    /* Select UV set: u_SpecUV > 0.5 → use UV2 (TEXCOORD_1). */
    vec2 sUV  = (u_SpecUV > 0.5) ? v_UV2 : v_UV;
    vec4 sg   = texture(u_SpecTex, sUV);
    specCol   = sg.rgb * u_SpecFactor;   // per-texel specular colour × material factor
    /* Convert glossiness to Phong shininess: gloss * glossFactor * 255 + 1.
       Multiplying by 255 maps [0,1] to [0,255]; +1 ensures shininess ≥ 1
       (pow(x, 0) would be 1 everywhere — no highlight). */
    shininess = sg.a * u_GlossFactor * 255.0 + 1.0;
  } else {
    specCol   = vec3(u_SpecK);  // scalar grey specular for non-spec-mapped meshes
    shininess = u_Shin;         // uniform shininess from JS (e.g. 52 for Enceladus)
  }

  /* Blinn-Phong specular highlight: spec = max(N·H, 0)^shininess
     pow(base, exp): base^exp. Larger shininess → specular lobe narrows → shinier.
     max(dot(N,H), 0.0): clamp negative (back-lit) — can't have negative highlights. */
  float spec = pow(max(dot(N, H), 0.0), shininess);

  /* ── Analytical sphere shadow ─────────────────────────────────────────── */

  /* Test against up to two occluder spheres. Either one in shadow → shadowFactor=0.
     Ambient is preserved (0.08 factor below) so shadowed regions are faintly lit
     by scattered starlight rather than going completely black. */
  float shadowFactor =
    (inShadowOf(v_Wpos, L, u_OccluderCenter,  u_OccluderR) ||
     inShadowOf(v_Wpos, L, u_Occluder2Center, u_Occluder2R)) ? 0.0 : 1.0;

  /* ── Translucent ring shadow ──────────────────────────────────────────── */

  /* ringLit: fraction of direct light surviving the ring shadow.
     ringShadow returns 0 (no ring) to 1 (dense ring).
     1.0 - opacity*strength: opacity=0 → ringLit=1 (no shadow);
                             opacity=1, strength=0.9 → ringLit=0.1 (mostly shadowed). */
  float ringLit = 1.0 - ringShadow(v_Wpos, L) * u_RingShadowStr;

  /* Combined direct-light factor: both hard sphere shadow and soft ring shadow. */
  float lit     = shadowFactor * ringLit;

  /* ── Phong illumination model ─────────────────────────────────────────── */

  /* Ambient: constant low-level fill light (no direction, no shadow).
     0.08 = ambient coefficient Ka. Provides a base brightness in shadow. */
  vec3 ambient  = 0.08 * u_LCol * base;

  /* Diffuse: Kd * (N·L) * LightColour * SurfaceColour * shadowAttenuation
     lit attenuates both sphere shadow (hard) and ring shadow (soft). */
  vec3 diffuse  = diff * lit * u_LCol * base;

  /* Specular: Ks * (N·H)^n * LightColour * SpecularColour * shadowAttenuation
     specCol acts as a colour mask: metallic/shiny areas reflect the light colour,
     matte areas reflect less. */
  vec3 specular = spec * lit * u_LCol * specCol;

  vec3 col = ambient + diffuse + specular;

  /* ── Advanced 1/3: Environment Mapping ───────────────────────────────── */

  /* reflect(I, N): GLSL built-in.
     Formula: reflect(I, N) = I - 2 * dot(N, I) * N
     I = incident ray direction = -V (pointing TOWARD the surface from the camera).
     Result R_env: the direction the view ray bounces off the surface.
     This direction is used to sample the cubemap → mirror-like star reflections. */
  vec3 R_env   = reflect(-V, N);

  /* texture(samplerCube, vec3): sample the environment cubemap with the reflection dir.
     Multiplied by u_EnvStr (reflection intensity) and specCol (shiny parts reflect more). */
  vec3 envSamp = texture(u_EnvMap, R_env).rgb;
  col += envSamp * u_EnvStr * specCol;

  /* ── Advanced 2/3: Fog ────────────────────────────────────────────────── */

  /* Exponential fog: fogFactor = e^(-density * distance)
     length(u_Cam - v_Wpos): Euclidean distance from camera to this fragment.
     exp(-k * d): at d=0 → e^0=1 (no fog, full colour); d→∞ → 0 (full fog colour).
     u_FogDensity=0.013: very low, only noticeably affects objects ~50+ units away. */
  float fogFactor = exp(-u_FogDensity * length(u_Cam - v_Wpos));

  /* mix(a, b, t): GLSL built-in linear interpolation: a*(1-t) + b*t.
     mix(fogColor, col, fogFactor): fogFactor=1 (near) → col; fogFactor=0 (far) → fogColor.
     clamp(x, 0.0, 1.0): prevent under/overshoot from floating-point rounding. */
  col = mix(u_FogColor, col, clamp(fogFactor, 0.0, 1.0));

  /* ── Advanced 3/3: Gamma Correction ──────────────────────────────────── */

  /* Convert linear light values to sRGB display encoding.
     Monitors apply γ=2.2 (display ∝ voltage^2.2). All shading above is done
     in linear space (physically correct). Without correction the image looks
     too dark. Encoding with 1/2.2 ≈ 0.4545 compensates: (x^0.4545)^2.2 = x.
     pow(vec3, vec3): component-wise power — each channel independently corrected.
     max(col, 0.0): pow() of a negative is undefined in GLSL → clamp first. */
  col = pow(max(col, vec3(0.0)), vec3(1.0 / 2.2));

  /* Final colour: RGB from shading + original texture alpha (ring transparency). */
  outColor = vec4(col, u_Alpha * texel.a);
}`;
