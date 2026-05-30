/* GLSL ES 3.00 shader sources — exported for use by saturn.js
 *
 * The scene is drawn by ONE full-screen quad whose fragment shader casts a
 * ray per pixel into an analytically-defined scene (two spheres + a ring
 * plane). That is GPU ray tracing: no scene triangles are rasterised, only
 * the quad that carries the framebuffer. Passes 2–4 (bloom) are unchanged
 * post-processing on the ray-traced image.
 */

/* ── Full-screen quad: pass NDC straight through ──────────────────────────── */
export const RT_VS = /* glsl */`#version 300 es
in  vec2 a_Pos;
out vec2 v_Ndc;
void main() {
  v_Ndc       = a_Pos;
  gl_Position = vec4(a_Pos, 0.0, 1.0);
}`;

/* ── The ray tracer ──────────────────────────────────────────────────────────
   Baseline : per-pixel Phong (ambient + diffuse + specular), material
              shininess/reflectance, diffuse + texture-driven specular maps,
              directional sun light, correct normals.
   Advanced : Environment Mapping (3/5) · Fog (2/5) · Gamma Correction (2/5).
              Bloom (4/5) is the separate post pass. Combined effort 11/10.
   Ray-traced extras: hard shadows by shadow rays (ring shadow on Saturn,
              Saturn shadow on rings, mutual planet/moon eclipses) and
              semi-transparent rings whose density comes from a texture.
──────────────────────────────────────────────────────────────────────────── */
export const RT_FS = /* glsl */`#version 300 es
precision highp float;

in  vec2 v_Ndc;
out vec4 outColor;

uniform mat4 u_InvVP;   // inverse(proj*view) — unprojects a pixel to a world ray
uniform vec3 u_Cam;     // camera (ray origin)
uniform float u_Time;   // seconds, drives Saturn spin

uniform vec3 u_SunDir;  // normalised direction TOWARD the sun
uniform vec3 u_SunCol;

uniform vec3  u_EncCenter;  // Enceladus centre (orbits, so it is a uniform)

uniform sampler2D   u_SatTex;   // 4096x2048 equirectangular Saturn body (diffuse map)
uniform sampler2D   u_SatSpecTex;// Saturn KHR spec/gloss map (rgb = specular, a = gloss) from saturn.glb
uniform sampler2D   u_EncTex;   // equirectangular Enceladus surface (diffuse map)
uniform sampler2D   u_RingTex;  // 8192x500 ring strip: rgb = colour, a = density
uniform samplerCube u_Env;      // Milky-Way starfield cubemap

uniform vec3  u_FogColor;
uniform float u_FogDensity;

/* Fixed scene geometry (world units) */
const float SAT_R    = 3.2;                              // Saturn radius
const float ENC_R    = 0.42;                             // Enceladus radius
const float RING_IN  = 3.9;                              // ring inner radius
const float RING_OUT = 7.6;                              // ring outer radius
const vec3  RING_AXIS = vec3(-0.44932, 0.89337, 0.0);    // +Y tilted 26.7° about Z
const float PI  = 3.14159265;
const float EPS = 1e-3;

/* ── Intersections ──────────────────────────────────────────────────────── */
// Nearest positive ray-sphere hit, or -1.0 for a miss.
float hitSphere(vec3 ro, vec3 rd, vec3 ce, float r) {
  vec3  oc = ro - ce;
  float b  = dot(oc, rd);
  float c  = dot(oc, oc) - r * r;
  float h  = b * b - c;
  if (h < 0.0) return -1.0;
  h = sqrt(h);
  float t = -b - h;
  if (t > EPS) return t;
  t = -b + h;
  return t > EPS ? t : -1.0;
}

// Ray vs ring annulus (plane through origin, normal = RING_AXIS).
// Returns t and the radial fraction across the ring [0,1].
float hitRing(vec3 ro, vec3 rd, out float radFrac, out vec3 p) {
  float dn = dot(rd, RING_AXIS);
  if (abs(dn) < 1e-6) return -1.0;            // ray parallel to ring plane
  float t = -dot(ro, RING_AXIS) / dn;
  if (t <= EPS) return -1.0;
  p = ro + t * rd;
  float r = length(p);
  if (r < RING_IN || r > RING_OUT) return -1.0;
  radFrac = (r - RING_IN) / (RING_OUT - RING_IN);
  return t;
}

// rgb = ring colour, a = density (0 = empty gap, 1 = dense band).
vec4 ringSample(float radFrac) { return texture(u_RingTex, vec2(radFrac, 0.5)); }

/* ── Shadow ray: light transmittance toward the sun in [0,1] ─────────────── */
float shadow(vec3 p) {
  vec3 L = u_SunDir;
  if (hitSphere(p, L, vec3(0.0),    SAT_R) > 0.0) return 0.0;  // Saturn occludes
  float t = 1.0;
  if (hitSphere(p, L, u_EncCenter,  ENC_R) > 0.0) t = 0.0;     // Enceladus occludes
  float rf; vec3 rp;                                           // rings partially occlude
  if (hitRing(p, L, rf, rp) > 0.0) t *= 1.0 - ringSample(rf).a;
  return t;
}

/* ── Equirectangular UV from a surface normal around a given pole axis.
      'spin' scrolls longitude over time to animate the body self-rotation. ── */
vec2 sphereUV(vec3 n, vec3 axis, float spin) {
  float lat = acos(clamp(dot(n, axis), -1.0, 1.0));        // 0 at north pole .. PI
  vec3  e1  = normalize(cross(axis, vec3(0.0, 0.0, 1.0)));
  vec3  e2  = cross(axis, e1);
  float lon = atan(dot(n, e2), dot(n, e1));
  return vec2((lon + PI) / (2.0 * PI) + spin, lat / PI);
}

/* ── Shared Phong + shadow + environment reflection + fog ─────────────────────
   specColor is the specular reflectance (from a specular map or a constant) and
   shininess the Blinn-Phong exponent — together the material's "reflectance". ── */
vec3 surface(vec3 p, vec3 N, vec3 rd, vec3 albedo,
             vec3 specColor, float shininess, float envStr) {
  vec3  L = u_SunDir;
  vec3  V = -rd;
  vec3  H = normalize(L + V);
  float sh   = shadow(p + N * EPS);
  float diff = max(dot(N, L), 0.0);
  float spec = pow(max(dot(N, H), 0.0), shininess);

  vec3 col = 0.06 * albedo                                    // ambient
           + sh * diff * albedo   * u_SunCol                  // diffuse
           + sh * spec * specColor * u_SunCol;                // specular

  col += texture(u_Env, reflect(rd, N)).rgb * envStr;         // Environment Mapping

  float f = exp(-u_FogDensity * length(p - u_Cam));           // Fog
  return mix(u_FogColor, col, clamp(f, 0.0, 1.0));
}

/* ── Per-body shading ─────────────────────────────────────────────────────── */
vec3 shadeSaturn(vec3 p, vec3 N, vec3 rd) {
  vec2 uv = sphereUV(N, RING_AXIS, u_Time * 0.06);            // longitude scroll = spin
  vec3 albedo = texture(u_SatTex, uv).rgb;                    // diffuse map
  vec4 sg     = texture(u_SatSpecTex, uv);                    // specular/glossiness map
  vec3 specColor  = sg.rgb * 1.6;                             // KHR specular colour (lifted to read)
  float shininess = sg.a * 255.0 + 1.0;                       // gloss → Blinn-Phong exponent
  return surface(p, N, rd, albedo, specColor, shininess, 0.04);
}

vec3 shadeEnceladus(vec3 p, vec3 N, vec3 rd) {
  vec3 albedo = texture(u_EncTex, sphereUV(N, vec3(0.0, 1.0, 0.0), u_Time * 0.15)).rgb * 0.92;
  return surface(p, N, rd, albedo, vec3(0.30), 55.0, 0.12);  // icy, no spec map → constant
}

vec3 shadeRing(vec3 p, vec3 rgb, vec3 rd) {
  float sh  = shadow(p + RING_AXIS * EPS);                    // Saturn's shadow band
  float lit = 0.22 + 0.78 * sh;                              // dust scatter + direct sun
  vec3  col = rgb * lit * u_SunCol;
  float f   = exp(-u_FogDensity * length(p - u_Cam));
  return mix(u_FogColor, col, clamp(f, 0.0, 1.0));
}

/* ── Background: starfield cubemap + a bright sun disk (fuels bloom) ───────── */
vec3 background(vec3 rd) {
  vec3  stars = texture(u_Env, rd).rgb * 0.40;   // dim deep space so it reads black
  float d     = dot(rd, u_SunDir);
  vec3  sun   = u_SunCol * (smoothstep(0.9994, 0.9998, d) * 6.0   // disk
                          + pow(max(d, 0.0), 900.0) * 1.5);        // halo
  return stars + sun;
}

void main() {
  /* Primary ray: unproject the far plane at this pixel (same maths as a skybox) */
  vec4 far = u_InvVP * vec4(v_Ndc, 1.0, 1.0);
  vec3 ro  = u_Cam;
  vec3 rd  = normalize(far.xyz / far.w - u_Cam);

  /* Nearest opaque hit among {Saturn, Enceladus, background} */
  float tSat = hitSphere(ro, rd, vec3(0.0),   SAT_R);
  float tEnc = hitSphere(ro, rd, u_EncCenter, ENC_R);
  float t    = 1e30;
  vec3  col  = background(rd);
  if (tSat > 0.0 && tSat < t) {
    t = tSat; vec3 p = ro + t * rd; col = shadeSaturn(p, normalize(p), rd);
  }
  if (tEnc > 0.0 && tEnc < t) {
    t = tEnc; vec3 p = ro + t * rd; col = shadeEnceladus(p, normalize(p - u_EncCenter), rd);
  }

  /* Composite the semi-transparent ring if it sits in front of that hit */
  float rf; vec3 rp;
  float tRing = hitRing(ro, rd, rf, rp);
  if (tRing > 0.0 && tRing < t) {
    vec4 rs = ringSample(rf);
    col = mix(col, shadeRing(rp, rs.rgb, rd), rs.a);   // a = local ring density
  }

  /* Gamma Correction (linear → display) */
  outColor = vec4(pow(max(col, vec3(0.0)), vec3(1.0 / 2.2)), 1.0);
}`;

/* ── Post-processing (unchanged from the rasteriser) ──────────────────────── */
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
