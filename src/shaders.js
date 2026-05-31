/* GLSL ES 3.00 shader sources — exported for use by saturn.js */

export const SKYBOX_VS = /* glsl */`#version 300 es
in  vec2 a_Pos;
out vec2 v_Ndc;
void main() {
  v_Ndc       = a_Pos;
  gl_Position = vec4(a_Pos, .9999, 1.0);
}`;

export const SKYBOX_FS = /* glsl */`#version 300 es
precision highp float;
in  vec2 v_Ndc;
uniform samplerCube u_Skybox;
uniform mat4 u_InvViewProj;
uniform vec3 u_Cam;
uniform vec3 u_SunDir;   // normalised direction TOWARD the sun
uniform vec3 u_SunCol;
out vec4 outColor;
void main() {
  vec4 farPos = u_InvViewProj * vec4(v_Ndc, 1.0, 1.0);
  vec3 world  = farPos.xyz / max(farPos.w, 1e-6);
  vec3 dir    = normalize(world - u_Cam);
  vec3 stars  = texture(u_Skybox, dir).rgb;
  /* Procedural sun disk + soft halo (ported from the ray-tracer branch).
     A large pure-white disk plus a wide falloff feeds the bloom far better
     than a small textured sphere. Gamma-corrected to match the rest of the
     scene before it lands in the (8-bit) framebuffer. */
  float d   = dot(dir, u_SunDir);
  vec3  sun = u_SunCol * (smoothstep(0.9994, 0.9998, d) * 6.0
                        + pow(max(d, 0.0), 900.0) * 1.5);
  outColor  = vec4(stars + pow(sun, vec3(1.0 / 2.2)), 1.0);
}`;

export const POST_VS = /* glsl */`#version 300 es
in vec2 a_Pos;
out vec2 v_UV;
void main() {
  v_UV = a_Pos * 0.5 + 0.5;
  gl_Position = vec4(a_Pos, 0.0, 1.0);
}`;

export const BRIGHT_FS = /* glsl */`#version 300 es
precision highp float;
in vec2 v_UV;
uniform sampler2D u_Img;
uniform float u_Threshold;
out vec4 outColor;
void main() {
  vec3 c = texture(u_Img, v_UV).rgb;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  vec3 b = max(c - vec3(u_Threshold), vec3(0.0));
  b *= smoothstep(u_Threshold, u_Threshold + 0.2, l);
  outColor = vec4(b, 1.0);
}`;

export const BLUR_FS = /* glsl */`#version 300 es
precision highp float;
in vec2 v_UV;
uniform sampler2D u_Img;
uniform vec2 u_Texel;
uniform vec2 u_Dir;
out vec4 outColor;
void main() {
  vec3 s = texture(u_Img, v_UV).rgb * 0.227027;
  s += texture(u_Img, v_UV + u_Dir * u_Texel * 1.384615).rgb * 0.316216;
  s += texture(u_Img, v_UV - u_Dir * u_Texel * 1.384615).rgb * 0.316216;
  s += texture(u_Img, v_UV + u_Dir * u_Texel * 3.230769).rgb * 0.070270;
  s += texture(u_Img, v_UV - u_Dir * u_Texel * 3.230769).rgb * 0.070270;
  outColor = vec4(s, 1.0);
}`;

export const COMPOSITE_FS = /* glsl */`#version 300 es
precision highp float;
in vec2 v_UV;
uniform sampler2D u_Scene;
uniform sampler2D u_Bloom;
uniform float u_Strength;
out vec4 outColor;
void main() {
  vec3 scene = texture(u_Scene, v_UV).rgb;
  vec3 bloom = texture(u_Bloom, v_UV).rgb;
  outColor = vec4(scene + bloom * u_Strength, 1.0);
}`;

export const PLANET_VS = /* glsl */`#version 300 es
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
}`;

/* ── Planet fragment shader ─────────────────────────────────────────────────
   Baseline  : Phong (ambient + diffuse + specular), per-fragment, textures,
               material shininess + reflectance, directional sun + point light.
   Advanced  : Environment Mapping (3/5) · Fog (2/5) · Gamma Correction (2/5)
               Combined effort: 7 / 10.
──────────────────────────────────────────────────────────────────────────── */
export const PLANET_FS = /* glsl */`#version 300 es
precision highp float;

in vec3 v_Wpos;
in vec3 v_Norm;
in vec2 v_UV;

uniform vec3  u_LDir;
uniform vec3  u_LCol;

uniform vec3      u_Base;
uniform float     u_Shin;
uniform float     u_SpecK;
uniform float     u_Alpha;
uniform bool      u_TexOn;
uniform sampler2D u_Tex;
uniform float     u_AlphaCutoff;
uniform bool      u_SpecTexOn;
uniform sampler2D u_SpecTex;

/* Environment Mapping (Advanced 3/5) */
uniform samplerCube u_EnvMap;
uniform float       u_EnvStr;

/* Fog (Advanced 2/5) */
uniform float u_FogDensity;
uniform vec3  u_FogColor;

/* Analytical planetary shadow — up to two occluder spheres (center + radius).
   Saturn shadowing Enceladus: center=origin, R=satBodyRadius.
   Enceladus shadowing Saturn: center=encWorldPos, R=encRadius.
   The rings use both slots: Saturn's body (broad shadow band) + Enceladus
   (small shadow dot). R=0 disables that slot. */
uniform vec3  u_OccluderCenter;
uniform float u_OccluderR;
uniform vec3  u_Occluder2Center;
uniform float u_Occluder2R;

/* Translucent ring shadow — the rings are a thin annulus in Saturn's
   equatorial plane and partly block sunlight, casting a soft banded shadow
   onto Saturn's body and (occasionally) onto Enceladus. We project the
   fragment toward the sun onto the ring plane and look up the ring's radial
   opacity. u_RingNormal is the plane normal in WORLD space (derived from the
   model matrix's local +Z axis, so it stays correct as Saturn spins/tilts —
   this is what previously fell 90° off when the spin axis was used instead). */
uniform float     u_RingShadowOn;   // 1 = receive ring shadow (body/moon), 0 = the rings themselves
uniform vec3      u_RingNormal;      // world-space unit normal of the ring plane
uniform vec3      u_RingCenter;      // world-space ring centre (= Saturn centre)
uniform float     u_RingInner;       // world-space inner radius of the ring annulus
uniform float     u_RingOuter;       // world-space outer radius of the ring annulus
uniform sampler2D u_RingAlphaTex;    // radial opacity strip (alpha = ring opacity vs radius)
uniform float     u_RingShadowStr;   // overall shadow strength (0..1)

uniform vec3 u_Cam;
out vec4 outColor;

/* Ray-sphere occlusion: cast a ray from the fragment toward the sun (dir L).
   In shadow if that ray hits the sphere and the sphere lies between the
   fragment and the sun. R<=0 disables (an unused occluder slot). */
bool inShadowOf(vec3 p, vec3 L, vec3 center, float r) {
  if (r <= 0.0) return false;
  vec3  oc   = p - center;
  float b    = dot(oc, L);
  float c    = dot(oc, oc) - r * r;
  float disc = b * b - c;
  return b < 0.0 && c > 0.0 && disc >= 0.0;
}

/* Ray-plane ring shadow: intersect the ray fragment->sun with the ring plane.
   If the hit lands inside the annulus, return the ring opacity at that radius
   (0 = no shadow). s<=0 means the ring plane lies behind the fragment relative
   to the sun, so it cannot occlude — no shadow. */
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

void main() {
  vec4 texel = u_TexOn ? texture(u_Tex, v_UV) : vec4(u_Base, 1.0);
  if (texel.a < u_AlphaCutoff) discard;
  vec3 base = texel.rgb;

  vec3 N = normalize(gl_FrontFacing ? v_Norm : -v_Norm);
  vec3 V = normalize(u_Cam - v_Wpos);
  vec3 L = normalize(u_LDir);
  vec3 H = normalize(L + V);

  float diff = max(dot(N, L), 0.0);

  /* KHR_materials_pbrSpecularGlossiness: RGB=specular, A=glossiness */
  vec3  specCol;
  float shininess;
  if (u_SpecTexOn) {
    vec4 sg   = texture(u_SpecTex, v_UV);
    specCol   = sg.rgb;
    shininess = sg.a * 255.0 + 1.0;
  } else {
    specCol   = vec3(u_SpecK);
    shininess = u_Shin;
  }

  float spec = pow(max(dot(N, H), 0.0), shininess);

  /* Analytical ray-sphere shadow test against up to two occluders (e.g. the
     rings are eclipsed by both Saturn's body and Enceladus). Ambient is kept
     so eclipsed regions stay faintly lit by starlight. */
  float shadowFactor =
    (inShadowOf(v_Wpos, L, u_OccluderCenter,  u_OccluderR) ||
     inShadowOf(v_Wpos, L, u_Occluder2Center, u_Occluder2R)) ? 0.0 : 1.0;

  /* Translucent ring shadow attenuates the direct light (ambient survives, so
     shadowed regions stay faintly lit by starlight). */
  float ringLit = 1.0 - ringShadow(v_Wpos, L) * u_RingShadowStr;
  float lit     = shadowFactor * ringLit;

  vec3 ambient  = 0.08 * u_LCol * base;
  vec3 diffuse  = diff * lit * u_LCol * base;
  vec3 specular = spec * lit * u_LCol * specCol;
  vec3 col = ambient + diffuse + specular;

  /* Environment Mapping (Advanced 3/5) — star cubemap reflections */
  vec3 R_env   = reflect(-V, N);
  vec3 envSamp = texture(u_EnvMap, R_env).rgb;
  col += envSamp * u_EnvStr * specCol;

  /* Fog (Advanced 2/5) — exponential deep-space fog */
  float fogFactor = exp(-u_FogDensity * length(u_Cam - v_Wpos));
  col = mix(u_FogColor, col, clamp(fogFactor, 0.0, 1.0));

  /* Gamma Correction (Advanced 2/5) */
  col = pow(max(col, vec3(0.0)), vec3(1.0 / 2.2));

  outColor = vec4(col, u_Alpha * texel.a);
}`;
