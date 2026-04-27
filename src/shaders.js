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
out vec4 outColor;
void main() {
  vec4 farPos = u_InvViewProj * vec4(v_Ndc, 1.0, 1.0);
  vec3 world  = farPos.xyz / max(farPos.w, 1e-6);
  vec3 dir    = normalize(world - u_Cam);
  outColor    = vec4(texture(u_Skybox, dir).rgb, 1.0);
}`;

export const SUN_VS = /* glsl */`#version 300 es
in vec3 a_Pos;
in vec2 a_UV;
uniform mat4 u_MVP;
out vec2 v_UV;
void main() {
  v_UV = a_UV;
  gl_Position = u_MVP * vec4(a_Pos, 1.0);
}`;

export const SUN_FS = /* glsl */`#version 300 es
precision highp float;
in vec2 v_UV;
uniform sampler2D u_Tex;
uniform float     u_Intensity;
out vec4 outColor;
void main() {
  vec3 tex = texture(u_Tex, v_UV).rgb;
  vec3 col = vec3(1.0) - exp(-tex * u_Intensity);
  outColor = vec4(col, 1.0);
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

/* Analytical planetary shadow — occluder sphere (center + radius).
   Saturn shadowing Enceladus: center=origin, R=satBodyRadius.
   Enceladus shadowing Saturn: center=encWorldPos, R=encRadius.
   R=0 disables the test. */
uniform vec3  u_OccluderCenter;
uniform float u_OccluderR;

uniform vec3 u_Cam;
out vec4 outColor;

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

  /* Saturn occults the sun — analytical ray-sphere shadow test.
     Cast a ray from the fragment toward the sun (direction L).
     If it intersects Saturn's sphere (center = origin, radius = u_OccluderR)
     and the sphere lies between the fragment and the sun, the fragment is in shadow.
     Ambient is kept so eclipsed regions stay faintly lit by starlight. */
  float shadowFactor = 1.0;
  if (u_OccluderR > 0.0) {
    vec3  oc   = v_Wpos - u_OccluderCenter;
    float b    = dot(oc, L);
    float c    = dot(oc, oc) - u_OccluderR * u_OccluderR;
    float disc = b * b - c;
    if (b < 0.0 && c > 0.0 && disc >= 0.0) shadowFactor = 0.0;
  }

  vec3 ambient  = 0.08 * u_LCol * base;
  vec3 diffuse  = diff * shadowFactor * u_LCol * base;
  vec3 specular = spec * shadowFactor * u_LCol * specCol;
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
