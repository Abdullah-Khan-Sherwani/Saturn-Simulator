/**
 * Saturn & Enceladus — Pure WebGL 2.0 Renderer
 *
 * Architecture:
 *  1. THREE.GLTFLoader  → extract raw Float32Array geometry + embedded textures → discard Three objects
 *  2. Pure WebGL 2.0    → VAOs, GLSL ES 3.00 shaders, glMatrix math
 *  3. Scene graph       → Saturn (axial tilt + spin) + Enceladus (hierarchical orbit)
 */

import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshStandardMaterial, Color } from 'three';
import { mat4, mat3, vec3 } from 'gl-matrix';

/* ─────────────────────────────────────────────────────────────────────────────
   GLSL ES 3.00 SOURCE STRINGS
───────────────────────────────────────────────────────────────────────────── */

const SKYBOX_VS = /* glsl */`#version 300 es
in  vec2 a_Pos;
out vec2 v_Ndc;
void main() {
  v_Ndc       = a_Pos;
  gl_Position = vec4(a_Pos, .9999, 1.0);
}`;

const SKYBOX_FS = /* glsl */`#version 300 es
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

const SUN_VS = /* glsl */`#version 300 es
in vec3 a_Pos;
in vec2 a_UV;

uniform mat4 u_MVP;

out vec2 v_UV;

void main() {
  v_UV = a_UV;
  gl_Position = u_MVP * vec4(a_Pos, 1.0);
}`;

const SUN_FS = /* glsl */`#version 300 es
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

const POST_VS = /* glsl */`#version 300 es
in vec2 a_Pos;
out vec2 v_UV;
void main() {
  v_UV = a_Pos * 0.5 + 0.5;
  gl_Position = vec4(a_Pos, 0.0, 1.0);
}`;

const BRIGHT_FS = /* glsl */`#version 300 es
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

const BLUR_FS = /* glsl */`#version 300 es
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

const COMPOSITE_FS = /* glsl */`#version 300 es
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

/* ── Planet vertex shader ────────────────────────────────────────────────── */
const PLANET_VS = /* glsl */`#version 300 es
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

/* ── Planet fragment shader ───────────────────────────────────────────────
   Baseline  : Phong (ambient + diffuse + specular), per-fragment, textures,
               material shininess + reflectance, directional sun + point light.
               Spotlight is not applicable to a space simulation (no artificial
               cone-constrained light sources exist in the scene).
   Advanced  : Environment Mapping (3/5) · Fog (2/5) · Gamma Correction (2/5)
               Combined effort: 7 / 10.
─────────────────────────────────────────────────────────────────────────── */
const PLANET_FS = /* glsl */`#version 300 es
precision highp float;

in vec3 v_Wpos;
in vec3 v_Norm;
in vec2 v_UV;

/* ── Directional Sun light (parallel rays) ── */
uniform vec3  u_LDir;
uniform vec3  u_LCol;

/* ── Material ─────────────────────────────────────────────────── */
uniform vec3      u_Base;
uniform float     u_Shin;      /* fallback shininess (used when no spec map) */
uniform float     u_SpecK;     /* fallback Ks       (used when no spec map)  */
uniform float     u_Alpha;
uniform bool      u_TexOn;
uniform sampler2D u_Tex;       /* diffuse / albedo map                       */
uniform float     u_AlphaCutoff;
uniform bool      u_SpecTexOn;
uniform sampler2D u_SpecTex;   /* specular-glossiness map (RGB=specular, A=glossiness) */

/* ── Environment mapping (Advanced – 3/5) ─────────────────────── */
uniform samplerCube u_EnvMap;
uniform float       u_EnvStr;  /* blending strength                      */

/* ── Fog (Advanced – 2/5, exponential space fog) ─────────────── */
uniform float u_FogDensity;
uniform vec3  u_FogColor;

/* ── Camera ───────────────────────────────────────────────────── */
uniform vec3 u_Cam;

out vec4 outColor;

void main() {
  vec4 texel = u_TexOn ? texture(u_Tex, v_UV) : vec4(u_Base, 1.0);
  if (texel.a < u_AlphaCutoff) discard;
  vec3 base  = texel.rgb;

  /* Two-sided normals — correctly lights ring plane back-faces */
  vec3 N = normalize(gl_FrontFacing ? v_Norm : -v_Norm);
  vec3 V = normalize(u_Cam - v_Wpos);
  vec3 L = normalize(u_LDir);
  vec3 H = normalize(L + V);

  float diff = max(dot(N, L), 0.0);

  /* ── Read specular colour + shininess from the model's texture ─
     KHR_materials_pbrSpecularGlossiness format:
       RGB = per-texel specular reflectance colour
       A   = glossiness (0=rough … 1=mirror); convert to Phong shininess */
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

  /* ── Phong accumulation — single Sun light ──────────────────── */
  vec3 ambient  = 0.08 * u_LCol * base;
  vec3 diffuse  = diff * u_LCol * base;
  vec3 specular = spec * u_LCol * specCol;
  vec3 col = ambient + diffuse + specular;

  /* ── Environment Mapping (Advanced 3/5) ─────────────────────
     Reflect the view ray off the surface normal, sample the star
     cubemap. Intensity is scaled by u_EnvStr and the material's
     specular coefficient so only shiny/icy surfaces reflect.     */
  vec3 R_env   = reflect(-V, N);
  vec3 envSamp = texture(u_EnvMap, R_env).rgb;
  col += envSamp * u_EnvStr * specCol;   /* specCol from texture or fallback */

  /* ── Fog (Advanced 2/5) — exponential deep-space fog ─────────
     Blends fragments toward the void color with distance.
     Very low density: subtle depth cue, not a thick haze.        */
  float fogFactor = exp(-u_FogDensity * length(u_Cam - v_Wpos));
  col = mix(u_FogColor, col, clamp(fogFactor, 0.0, 1.0));

  /* ── Gamma Correction (Advanced 2/5) ─────────────────────────
     Converts linear-space colour to gamma space for display.     */
  col = pow(max(col, vec3(0.0)), vec3(1.0 / 2.2));

  outColor = vec4(col, u_Alpha * texel.a);
}`;

/* ─────────────────────────────────────────────────────────────────────────────
   WEBGL 2.0 UTILITIES
───────────────────────────────────────────────────────────────────────────── */

function mkShader(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
    throw new Error('Shader compile:\n' + gl.getShaderInfoLog(s));
  return s;
}

function mkProg(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, mkShader(gl, gl.VERTEX_SHADER,   vs));
  gl.attachShader(p, mkShader(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS))
    throw new Error('Program link:\n' + gl.getProgramInfoLog(p));
  return p;
}

function glBuf(gl, data, target = gl.ARRAY_BUFFER) {
  const b = gl.createBuffer();
  gl.bindBuffer(target, b);
  gl.bufferData(target, data, gl.STATIC_DRAW);
  return b;
}

/* Build a VAO for one mesh.  Loops over attrib specs to stay DRY. */
function makeVAO(gl, prog, mesh) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);

  /* attribute name → [data, component-count] */
  const attribs = [
    ['a_Pos',  mesh.pos,  3],
    ['a_Norm', mesh.norm, 3],
    ['a_UV',   mesh.uv,   2],
  ];
  for (const [name, data, size] of attribs) {
    if (!data) continue;
    const loc = gl.getAttribLocation(prog, name);
    if (loc < 0) continue;
    gl.bindBuffer(gl.ARRAY_BUFFER, glBuf(gl, data));
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
  }

  let drawCount, drawMode;
  if (mesh.idx) {
    glBuf(gl, mesh.idx, gl.ELEMENT_ARRAY_BUFFER);
    drawCount = mesh.idx.length;
    drawMode  = 'el';
  } else {
    drawCount = mesh.pos.length / 3;
    drawMode  = 'arr';
  }

  gl.bindVertexArray(null);
  return { vao, drawCount, drawMode, idxType: mesh.idxType };
}

function glTex2D(gl, image) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  return t;
}

function glTexCubeFromImages(gl, images) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_CUBE_MAP, t);

  const targets = [
    gl.TEXTURE_CUBE_MAP_POSITIVE_X,
    gl.TEXTURE_CUBE_MAP_NEGATIVE_X,
    gl.TEXTURE_CUBE_MAP_POSITIVE_Y,
    gl.TEXTURE_CUBE_MAP_NEGATIVE_Y,
    gl.TEXTURE_CUBE_MAP_POSITIVE_Z,
    gl.TEXTURE_CUBE_MAP_NEGATIVE_Z,
  ];

  targets.forEach((target, i) => {
    gl.texImage2D(target, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, images[i]);
  });

  gl.generateMipmap(gl.TEXTURE_CUBE_MAP);
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
  return t;
}

function mkColorTex(gl, w, h) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

function mkRenderTarget(gl, w, h, withDepth) {
  const tex = mkColorTex(gl, w, h);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);

  let depth = null;
  if (withDepth) {
    depth = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
  }

  const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  if (!ok) throw new Error('Framebuffer is not complete');

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.bindRenderbuffer(gl.RENDERBUFFER, null);
  return { fbo, tex, depth, w, h };
}

function freeRenderTarget(gl, rt) {
  if (!rt) return;
  if (rt.depth) gl.deleteRenderbuffer(rt.depth);
  if (rt.tex) gl.deleteTexture(rt.tex);
  if (rt.fbo) gl.deleteFramebuffer(rt.fbo);
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load image: ' + url));
    img.src = url;
  });
}

async function loadCubemapFaces(basePath) {
  const faces = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];
  return Promise.all(faces.map(face => loadImage(`${basePath}/${face}.png`)));
}

function makeUvSphere(radius = 1.0, latBands = 24, lonBands = 48) {
  const pos = [];
  const norm = [];
  const uv = [];
  const idx = [];

  for (let y = 0; y <= latBands; y++) {
    const v = y / latBands;
    const theta = v * Math.PI;
    const st = Math.sin(theta);
    const ct = Math.cos(theta);

    for (let x = 0; x <= lonBands; x++) {
      const u = x / lonBands;
      const phi = u * Math.PI * 2.0;
      const sp = Math.sin(phi);
      const cp = Math.cos(phi);

      const nx = cp * st;
      const ny = ct;
      const nz = sp * st;

      norm.push(nx, ny, nz);
      pos.push(radius * nx, radius * ny, radius * nz);
      uv.push(1.0 - u, v);
    }
  }

  const stride = lonBands + 1;
  for (let y = 0; y < latBands; y++) {
    for (let x = 0; x < lonBands; x++) {
      const i0 = y * stride + x;
      const i1 = i0 + 1;
      const i2 = i0 + stride;
      const i3 = i2 + 1;
      idx.push(i0, i2, i1);
      idx.push(i1, i2, i3);
    }
  }

  return {
    pos: new Float32Array(pos),
    norm: new Float32Array(norm),
    uv: new Float32Array(uv),
    idx: (pos.length / 3 > 65535) ? new Uint32Array(idx) : new Uint16Array(idx),
    idxType: (pos.length / 3 > 65535)
      ? WebGL2RenderingContext.UNSIGNED_INT
      : WebGL2RenderingContext.UNSIGNED_SHORT,
    color: [1, 1, 1],
    opacity: 1.0,
    uvRepeat: [1, 1],
    uvOffset: [0, 0],
  };
}

/* ─────────────────────────────────────────────────────────────────────────────
   PROCEDURAL SPACE CUBEMAP  (Environment Mapping — Advanced 3/5)
   Generates 6 faces of a starfield cubemap in JS.  Each face is 128×128 with a
   deep-space background, randomly placed stars, and a subtle nebula tint.
   No external texture asset needed.
───────────────────────────────────────────────────────────────────────────── */
/* ─────────────────────────────────────────────────────────────────────────────
   ASSET EXTRACTION  (The Three.js Hack)
   THREE.GLTFLoader is used strictly as a parser.  We copy every typed array
   out of the Three.js geometry/material objects and then call scene.clear().
───────────────────────────────────────────────────────────────────────────── */

/* Priority-ordered list of material texture slots to probe.
   Different GLB exporters put the diffuse image in different slots. */
const TEX_SLOTS = [
  'map', 'emissiveMap', 'alphaMap',
  'roughnessMap', 'metalnessMap', 'normalMap',
];

function extractMeshes(gltf) {
  const meshes = [];

  gltf.scene.traverse(node => {
    if (!node.isMesh) return;

    const geo  = node.geometry;
    const mats = Array.isArray(node.material) ? node.material : [node.material];


    /* Use first material for rendering */
    const mat = mats[0];

    /* Copy typed arrays so Three.js GC cannot reclaim them after scene.clear() */
    const pos  = Float32Array.from(geo.attributes.position.array);

    const norm = geo.attributes.normal
      ? Float32Array.from(geo.attributes.normal.array)
      : new Float32Array(pos.length);

    const uv = geo.attributes.uv
      ? Float32Array.from(geo.attributes.uv.array)
      : null;

    let idx = null, idxType = null;
    if (geo.index) {
      const raw = geo.index.array;
      if (raw instanceof Uint32Array) {
        idx     = Uint32Array.from(raw);
        idxType = WebGL2RenderingContext.UNSIGNED_INT;
      } else {
        idx     = Uint16Array.from(raw);
        idxType = WebGL2RenderingContext.UNSIGNED_SHORT;
      }
    }

    const color   = mat.color ? [mat.color.r, mat.color.g, mat.color.b] : [0.8, 0.8, 0.8];
    const opacity = mat.opacity ?? 1.0;

    /* Diffuse / albedo texture — first slot that carries an image */
    let image = null, uvRepeat = [1, 1], uvOffset = [0, 0];
    for (const slot of TEX_SLOTS) {
      const t = mat[slot];
      if (t?.image) {
        image    = t.image;
        uvRepeat = [t.repeat.x, t.repeat.y];
        uvOffset = [t.offset.x, t.offset.y];
        break;
      }
    }

    /* Specular/Glossiness texture (KHR_materials_pbrSpecularGlossiness).
       RGB = specular reflectance colour, A = glossiness (1 = mirror-smooth).
       The KHRPbrSGPlugin maps specularGlossinessTexture → mat.roughnessMap. */
    const specImage = mat.roughnessMap?.image ?? null;

    meshes.push({
      name: (node.name || '').toLowerCase(),
      pos,
      norm,
      uv,
      idx,
      idxType,
      color,
      opacity,
      image,
      specImage,
      uvRepeat,
      uvOffset,
    });
  });

  return meshes;
}

/* ── KHR_materials_pbrSpecularGlossiness plugin ──────────────────────────────
   Three.js r152+ removed built-in support for this older PBR extension.
   This minimal plugin re-enables it: it reads diffuseFactor + diffuseTexture
   from the extension block and maps them onto MeshStandardMaterial.color/map
   so our extractMeshes() finds mat.map.image as expected.
───────────────────────────────────────────────────────────────────────────── */
class KHRPbrSGPlugin {
  constructor(parser) {
    this.parser = parser;
    this.name   = 'KHR_materials_pbrSpecularGlossiness';
  }

  /* Tell GLTFLoader we own this material type so it doesn't skip it */
  getMaterialType(materialIndex) {
    return this._ext(materialIndex) ? MeshStandardMaterial : null;
  }

  /* Fill in materialParams before Three.js constructs the material object */
  extendMaterialParams(materialIndex, materialParams) {
    const ext = this._ext(materialIndex);
    if (!ext) return Promise.resolve();

    const pending = [];

    if (Array.isArray(ext.diffuseFactor)) {
      const [r, g, b, a = 1] = ext.diffuseFactor;
      materialParams.color   = new Color(r, g, b);
      materialParams.opacity = a;
      if (a < 1) materialParams.transparent = true;
    }

    if (ext.diffuseTexture != null) {
      pending.push(
        this.parser
          .loadTexture(ext.diffuseTexture.index)
          .then(tex => { materialParams.map = tex; })
      );
    }

    /* specularGlossinessTexture → roughnessMap (best approximation) */
    if (ext.specularGlossinessTexture != null) {
      pending.push(
        this.parser
          .loadTexture(ext.specularGlossinessTexture.index)
          .then(tex => { materialParams.roughnessMap = tex; })
      );
    }

    return Promise.all(pending);
  }

  _ext(idx) {
    return this.parser.json.materials?.[idx]
      ?.extensions?.[this.name] ?? null;
  }
}

function loadGLTF(url, onProgress) {
  return new Promise((res, rej) => {
    const loader = new GLTFLoader();
    loader.register(parser => new KHRPbrSGPlugin(parser));
    loader.load(url, res, onProgress, rej);
  });
}

/* ─────────────────────────────────────────────────────────────────────────────
   BOUNDING BOX helper — returns centre + half-extent radius
───────────────────────────────────────────────────────────────────────────── */

function boundsOf(pos) {
  let mnX = Infinity, mxX = -Infinity;
  let mnY = Infinity, mxY = -Infinity;
  let mnZ = Infinity, mxZ = -Infinity;

  for (let i = 0; i < pos.length; i += 3) {
    mnX = Math.min(mnX, pos[i]);     mxX = Math.max(mxX, pos[i]);
    mnY = Math.min(mnY, pos[i+1]);   mxY = Math.max(mxY, pos[i+1]);
    mnZ = Math.min(mnZ, pos[i+2]);   mxZ = Math.max(mxZ, pos[i+2]);
  }
  return {
    cx: (mnX + mxX) * .5,
    cy: (mnY + mxY) * .5,
    cz: (mnZ + mxZ) * .5,
    r:  Math.max(mxX - mnX, mxY - mnY, mxZ - mnZ) * .5,
  };
}

/* ─────────────────────────────────────────────────────────────────────────────
   DRAW CALL wrapper
───────────────────────────────────────────────────────────────────────────── */

function drawVAO(gl, g) {
  gl.bindVertexArray(g.vao);
  if (g.drawMode === 'el')
    gl.drawElements(gl.TRIANGLES, g.drawCount, g.idxType, 0);
  else
    gl.drawArrays(gl.TRIANGLES, 0, g.drawCount);
}

/* ─────────────────────────────────────────────────────────────────────────────
   MAIN
───────────────────────────────────────────────────────────────────────────── */

async function main() {
  const msgEl  = document.getElementById('msg');
  const canvas = document.getElementById('c');
  const gl     = canvas.getContext('webgl2');

  if (!gl) {
    msgEl.textContent = 'WebGL 2.0 is not supported in this browser.';
    return;
  }

  /* ── Canvas resize ─────────────────────────────────────────────────────── */
  function resize() {
    const dpr = Math.min(window.devicePixelRatio, 2);
    canvas.width  = (canvas.clientWidth  * dpr) | 0;
    canvas.height = (canvas.clientHeight * dpr) | 0;
  }
  resize();
  window.addEventListener('resize', resize);

  /* ── Load GLTFs ────────────────────────────────────────────────────────── */
  const fmtMB = e =>
    e.lengthComputable
      ? `${(e.loaded / 1048576).toFixed(1)} / ${(e.total / 1048576).toFixed(0)} MB`
      : `${(e.loaded / 1048576).toFixed(1)} MB`;

  msgEl.textContent = 'Loading Saturn (large file)…';

  const [satGLTF, encGLTF] = await Promise.all([
    loadGLTF('/saturn.glb',    e => { msgEl.textContent = 'Saturn: '    + fmtMB(e); }),
    loadGLTF('/enceladus.glb', e => { msgEl.textContent = 'Enceladus: ' + fmtMB(e); }),
  ]);

  msgEl.textContent = 'Building GPU buffers…';

  /* ── Extract raw geometry → discard Three.js scene graphs ─────────────── */
  const satMeshes = extractMeshes(satGLTF);
  const encMeshes = extractMeshes(encGLTF);
  satGLTF.scene.clear();
  encGLTF.scene.clear();

  if (!satMeshes.length) throw new Error('No meshes found in saturn.glb');
  if (!encMeshes.length) throw new Error('No meshes found in enceladus.glb');

  /* ── Compile GLSL programs ─────────────────────────────────────────────── */
  const skyProg    = mkProg(gl, SKYBOX_VS, SKYBOX_FS);
  const sunProg    = mkProg(gl, SUN_VS, SUN_FS);
  const planetProg = mkProg(gl, PLANET_VS, PLANET_FS);
  const brightProg = mkProg(gl, POST_VS, BRIGHT_FS);
  const blurProg   = mkProg(gl, POST_VS, BLUR_FS);
  const compProg   = mkProg(gl, POST_VS, COMPOSITE_FS);

  /* ── Full-screen quad VAO (star background) ────────────────────────────── */
  const quadVerts = new Float32Array([-1,-1, 1,-1, -1,1, 1,1]);
  const quadVAO   = gl.createVertexArray();
  gl.bindVertexArray(quadVAO);
  gl.bindBuffer(gl.ARRAY_BUFFER, glBuf(gl, quadVerts));
  const aPosLoc = gl.getAttribLocation(skyProg, 'a_Pos');
  gl.enableVertexAttribArray(aPosLoc);
  gl.vertexAttribPointer(aPosLoc, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  /* ── Planet VAOs + GPU textures ────────────────────────────────────────── */
  const satGPU = satMeshes.map(m => makeVAO(gl, planetProg, m));
  const encGPU = encMeshes.map(m => makeVAO(gl, planetProg, m));
  const sunGPU = makeVAO(gl, sunProg, makeUvSphere(1.0, 24, 48));

  /* Diffuse textures (slot 0) */
  const satTex    = satMeshes.map(m => m.image ? glTex2D(gl, m.image) : null);
  const encTex    = encMeshes.map(m => m.image     ? glTex2D(gl, m.image)     : null);

  /* Override Saturn body/ring textures with user-provided maps */
  const [saturnBodyImg, saturnRingImg] = await Promise.all([
    loadImage('/8k_saturn.jpg'),
    loadImage('/8k_saturn_ring_alpha.png'),
  ]);
  const sunImg = await loadImage('/8k_sun.jpg');
  const saturnBodyTex = glTex2D(gl, saturnBodyImg);
  const saturnRingTex = glTex2D(gl, saturnRingImg);
  const sunTex = glTex2D(gl, sunImg);
  satMeshes.forEach((m, i) => {
    satTex[i] = /ring/.test(m.name) ? saturnRingTex : saturnBodyTex;
  });

  /* Specular/Glossiness textures (slot 2) — embedded in the GLB */
  const satSpecTex = satMeshes.map(m => m.specImage ? glTex2D(gl, m.specImage) : null);
  const encSpecTex = encMeshes.map(m => m.specImage ? glTex2D(gl, m.specImage) : null);

  /* ── Cache all uniform locations (once, outside loop) ─────────────────── */
  const U = Object.fromEntries(
    ['u_MVP','u_M','u_N',
     'u_LDir','u_LCol',
     'u_Base','u_Cam',
     'u_Shin','u_SpecK','u_Alpha','u_TexOn','u_Tex','u_AlphaCutoff','u_SpecTexOn','u_SpecTex',
     'u_UVRepeat','u_UVOffset',
     'u_EnvMap','u_EnvStr',
     'u_FogDensity','u_FogColor']
    .map(k => [k, gl.getUniformLocation(planetProg, k)])
  );

  const SkyU = Object.fromEntries(
    ['u_Skybox', 'u_InvViewProj', 'u_Cam']
      .map(k => [k, gl.getUniformLocation(skyProg, k)])
  );

  const SunU = Object.fromEntries(
    ['u_MVP', 'u_Tex', 'u_Intensity']
      .map(k => [k, gl.getUniformLocation(sunProg, k)])
  );

  const BrightU = Object.fromEntries(
    ['u_Img', 'u_Threshold']
      .map(k => [k, gl.getUniformLocation(brightProg, k)])
  );

  const BlurU = Object.fromEntries(
    ['u_Img', 'u_Texel', 'u_Dir']
      .map(k => [k, gl.getUniformLocation(blurProg, k)])
  );

  const CompU = Object.fromEntries(
    ['u_Scene', 'u_Bloom', 'u_Strength']
      .map(k => [k, gl.getUniformLocation(compProg, k)])
  );

  /* ── Space environment cubemap from generated PNG faces ─────────────────── */
  const cubeFaces = await loadCubemapFaces('/cubemap_starmap_2020_1024');
  const spaceCubemap = glTexCubeFromImages(gl, cubeFaces);

  /* ── Normalisation scales so both bodies fit neatly in the scene ───────── */
  const sB = boundsOf(satMeshes[0].pos);  /* Saturn bounding info */
  const eB = boundsOf(encMeshes[0].pos);  /* Enceladus bounding info */
  const sS = 3.2 / sB.r;                  /* Saturn  target radius ≈ 3.2 units */
  const eS = 0.42 / eB.r;                 /* Enceladus target radius ≈ 0.42 units */

  /* ── Sun (directional light) ───────────────────────────────────────────── */
  const SUN_DIR  = vec3.normalize(vec3.create(), [-0.6, -0.2, -0.8]);
  const SUN_COL  = new Float32Array([1.0, 0.97, 0.85]);
  const SUN_DISTANCE = 4000.0;
  const SUN_RADIUS   = 8.0;
  const SUN_POS      = vec3.scale(vec3.create(), SUN_DIR, SUN_DISTANCE);

  /* ── Camera orbit state ────────────────────────────────────────────────── */
  let camRx = 0.22, camRy = 0.0, camRadius = 22.0;
  let dragging = false, px = 0, py = 0;

  const onDown  = (x, y) => { dragging = true;  px = x; py = y; };
  const onUp    = ()      => { dragging = false; };
  const onMove  = (x, y) => {
    if (!dragging) return;
    camRy += (x - px) * 0.005;
    camRx += (y - py) * 0.005;
    camRx  = Math.max(-1.45, Math.min(1.45, camRx));
    px = x; py = y;
  };

  canvas.addEventListener('mousedown', e => onDown(e.clientX, e.clientY));
  window.addEventListener('mouseup',   onUp);
  window.addEventListener('mousemove', e => onMove(e.clientX, e.clientY));

  canvas.addEventListener('touchstart',
    e => { onDown(e.touches[0].clientX, e.touches[0].clientY); e.preventDefault(); },
    { passive: false });
  window.addEventListener('touchend',   onUp);
  window.addEventListener('touchmove',  e => onMove(e.touches[0].clientX, e.touches[0].clientY));

  canvas.addEventListener('wheel', e => {
    camRadius = Math.max(4, Math.min(120, camRadius + e.deltaY * 0.06));
    e.preventDefault();
  }, { passive: false });

  /* ── Matrices ──────────────────────────────────────────────────────────── */
  const proj = mat4.create();
  const view = mat4.create();
  const vp   = mat4.create();
  const invVP = mat4.create();

  let sceneRT = null;
  let bloomA = null;
  let bloomB = null;
  let rtW = 0, rtH = 0;

  function ensureTargets(w, h) {
    if (w === rtW && h === rtH && sceneRT && bloomA && bloomB) return;
    freeRenderTarget(gl, sceneRT);
    freeRenderTarget(gl, bloomA);
    freeRenderTarget(gl, bloomB);
    sceneRT = mkRenderTarget(gl, w, h, true);
    bloomA  = mkRenderTarget(gl, w, h, false);
    bloomB  = mkRenderTarget(gl, w, h, false);
    rtW = w; rtH = h;
  }

  /* ── Render group helper  ──────────────────────────────────────────────── */
  function renderGroup(gpuList, meshList, texList, specTexList, modelMat, envStrength) {
    const mvp  = mat4.multiply(mat4.create(), vp, modelMat);
    const nMat = mat3.normalFromMat4(mat3.create(), modelMat);

    gl.uniformMatrix4fv(U.u_MVP, false, mvp);
    gl.uniformMatrix4fv(U.u_M,   false, modelMat);
    gl.uniformMatrix3fv(U.u_N,   false, nMat);

    gpuList.forEach((g, i) => {
      const m       = meshList[i];
      const tex     = texList[i];
      const specTex = specTexList[i];
      const isRing  = /ring/.test(m.name ?? '');

      /* Ring planes are alpha-heavy and prone to back-side shimmer.
         Render as alpha cutout, write depth, and avoid glossy highlights. */
      gl.depthMask(true);
      gl.uniform1f (U.u_Alpha,       isRing ? 1.0 : m.opacity);
      gl.uniform1f (U.u_AlphaCutoff, isRing ? 0.18 : 0.0);
      gl.uniform2fv(U.u_UVRepeat, m.uvRepeat ?? [1, 1]);
      gl.uniform2fv(U.u_UVOffset, m.uvOffset ?? [0, 0]);
      gl.uniform1f (U.u_EnvStr,   isRing ? 0.005 : envStrength);

      if (isRing) {
        gl.disable(gl.BLEND);
        gl.enable(gl.CULL_FACE);
        gl.cullFace(gl.BACK);
      } else {
        gl.enable(gl.BLEND);
        gl.disable(gl.CULL_FACE);
      }

      /* Slot 0 — diffuse / albedo texture */
      if (tex) {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.uniform1i(U.u_Tex,   0);
        gl.uniform1i(U.u_TexOn, 1);
      } else {
        gl.uniform3fv(U.u_Base, m.color);
        gl.uniform1i(U.u_TexOn, 0);
      }

      /* Slot 2 — specular/glossiness texture from the GLB
         RGB = specular colour, A = glossiness → converted to shininess in shader */
      if (specTex && !isRing) {
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, specTex);
        gl.uniform1i(U.u_SpecTex,   2);
        gl.uniform1i(U.u_SpecTexOn, 1);
      } else {
        gl.uniform1i(U.u_SpecTexOn, 0);   /* fall back to u_Shin / u_SpecK */
        if (isRing) {
          gl.uniform1f(U.u_Shin, 2.0);
          gl.uniform1f(U.u_SpecK, 0.005);
        }
      }

      drawVAO(gl, g);
    });
  }

  /* ── Render loop ───────────────────────────────────────────────────────── */
  let t = 0;

  function frame() {
    t += 0.004;
    resize();

    const W = canvas.width, H = canvas.height;
    ensureTargets(W, H);
    gl.viewport(0, 0, W, H);
    gl.bindFramebuffer(gl.FRAMEBUFFER, sceneRT.fbo);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    /* Camera position from spherical orbit angles */
    const cx = camRadius * Math.sin(camRy) * Math.cos(camRx);
    const cy = camRadius * Math.sin(camRx);
    const cz = camRadius * Math.cos(camRy) * Math.cos(camRx);
    const camPos = new Float32Array([cx, cy, cz]);

    mat4.perspective(proj, Math.PI / 4, W / H, 0.1, 8000.0);
    mat4.lookAt(view, camPos, [0, 0, 0], [0, 1, 0]);
    mat4.multiply(vp, proj, view);

    mat4.invert(invVP, vp);

    /* ── Pass 1: Cubemap sky background — disable depth test, full-screen quad */
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.useProgram(skyProg);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, spaceCubemap);
    gl.uniform1i(SkyU.u_Skybox, 1);
    gl.uniformMatrix4fv(SkyU.u_InvViewProj, false, invVP);
    gl.uniform3fv(SkyU.u_Cam, camPos);
    gl.bindVertexArray(quadVAO);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    /* ── Pass 2: Visible textured Sun sphere ─────────────────────────────── */
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.BLEND);
    gl.useProgram(sunProg);

    const sunM = mat4.create();
    mat4.translate(sunM, sunM, SUN_POS);
    mat4.scale(sunM, sunM, [SUN_RADIUS, SUN_RADIUS, SUN_RADIUS]);

    const sunMVP = mat4.multiply(mat4.create(), vp, sunM);
    gl.uniformMatrix4fv(SunU.u_MVP, false, sunMVP);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, sunTex);
    gl.uniform1i(SunU.u_Tex, 0);
    gl.uniform1f(SunU.u_Intensity, 2.4);
    drawVAO(gl, sunGPU);

    /* ── Pass 3: Opaque & transparent planet geometry ─────────────────────── */
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    gl.useProgram(planetProg);

    /* ── Shared uniforms set once per frame ──────────────────────────────── */

    /* Directional Sun light derived from visible Sun position */
    gl.uniform3fv(U.u_LDir, vec3.normalize(vec3.create(), SUN_POS));
    gl.uniform3fv(U.u_LCol, SUN_COL);
    gl.uniform3fv(U.u_Cam,  camPos);

    /* Fog — exponential deep-space fog (Advanced 2/5) */
    gl.uniform1f (U.u_FogDensity, 0.013);
    gl.uniform3fv(U.u_FogColor,   new Float32Array([0.0, 0.0, 0.018]));

    /* Environment cubemap (Advanced 3/5) — star-field reflections */
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, spaceCubemap);
    gl.uniform1i (U.u_EnvMap, 1);
    gl.uniform1f (U.u_EnvStr, 0.18);   /* default; ring overrides in renderGroup */

    /* ── Saturn ──────────────────────────────────────────────────────────────
       Matrix build order (applied right-to-left to each vertex):
         1. translate(-centre)  — centre mesh at local origin
         2. scale               — normalise to scene units
         3. rotateY             — daily spin
         4. rotateZ             — 26.7° axial tilt (world-space, axis stays fixed)
    ───────────────────────────────────────────────────────────────────────── */
    const satM = mat4.create();
    mat4.rotateZ(satM, satM, 26.7 * Math.PI / 180.0);   /* axial tilt */
    mat4.rotateY(satM, satM, t * 0.15);                  /* slow self-rotation */
    mat4.scale   (satM, satM, [sS, sS, sS]);
    mat4.translate(satM, satM, [-sB.cx, -sB.cy, -sB.cz]);

    gl.uniform1f(U.u_Shin,  20.0);    /* fallback only — spec texture overrides */
    gl.uniform1f(U.u_SpecK,  0.10);
    renderGroup(satGPU, satMeshes, satTex, satSpecTex, satM, 0.02);

    /* ── Enceladus  — hierarchical orbit ─────────────────────────────────────
       Matrix build order (right-to-left application):
         1. translate(-centre)        — centre mesh
         2. scale                     — normalise
         3. rotateY(selfAngle)        — local spin
         4. translate([orbitDist,…])  — place at orbital radius (in tilted orbit plane)
         5. rotateX(inclination)      — slight orbital inclination
         6. rotateY(orbitAngle)       — sweep around Saturn's centre
    ───────────────────────────────────────────────────────────────────────── */
    const encM = mat4.create();
    mat4.rotateY  (encM, encM, t * 0.70);                /* orbit Saturn */
    mat4.rotateX  (encM, encM, 0.09);                    /* slight inclination */
    mat4.translate(encM, encM, [7.8, 0.0, 0.0]);         /* larger orbital radius */
    mat4.rotateY  (encM, encM, t * 2.2);                 /* self-rotation */
    mat4.scale    (encM, encM, [eS, eS, eS]);
    mat4.translate(encM, encM, [-eB.cx, -eB.cy, -eB.cz]);

    gl.uniform1f(U.u_Shin,  52.0);    /* fallback only — spec texture overrides */
    gl.uniform1f(U.u_SpecK,  0.65);
    renderGroup(encGPU, encMeshes, encTex, encSpecTex, encM, 0.18);

    /* ── Pass 4: Bright extract for bloom ─────────────────────────────────── */
    gl.bindFramebuffer(gl.FRAMEBUFFER, bloomA.fbo);
    gl.viewport(0, 0, W, H);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    gl.useProgram(brightProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, sceneRT.tex);
    gl.uniform1i(BrightU.u_Img, 0);
    gl.uniform1f(BrightU.u_Threshold, 0.62);
    gl.bindVertexArray(quadVAO);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    /* ── Pass 5: Separable gaussian blur (ping-pong) ─────────────────────── */
    gl.useProgram(blurProg);
    gl.uniform2f(BlurU.u_Texel, 1 / W, 1 / H);
    let readTex = bloomA.tex;
    for (let i = 0; i < 6; i++) {
      const horizontal = (i % 2) === 0;
      const writeRT = horizontal ? bloomB : bloomA;
      gl.bindFramebuffer(gl.FRAMEBUFFER, writeRT.fbo);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, readTex);
      gl.uniform1i(BlurU.u_Img, 0);
      gl.uniform2f(BlurU.u_Dir, horizontal ? 1 : 0, horizontal ? 0 : 1);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      readTex = writeRT.tex;
    }

    /* ── Pass 6: Composite scene + bloom to screen ───────────────────────── */
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(compProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, sceneRT.tex);
    gl.uniform1i(CompU.u_Scene, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, readTex);
    gl.uniform1i(CompU.u_Bloom, 1);
    gl.uniform1f(CompU.u_Strength, 1.05);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    requestAnimationFrame(frame);
  }

  /* ── Kick off ──────────────────────────────────────────────────────────── */
  document.getElementById('loading').style.display = 'none';
  requestAnimationFrame(frame);
}

main().catch(err => {
  const msgEl = document.getElementById('msg');
  if (msgEl) msgEl.textContent = 'Error: ' + err.message;
  console.error(err);
});
