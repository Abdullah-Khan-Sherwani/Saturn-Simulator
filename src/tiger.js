/**
 * Tiger Tank — Sunset Patrol
 * Pure WebGL 2.0 renderer.  Architecture:
 *   1. THREE.GLTFLoader  → extract Float32Arrays for pos/norm/tan/uv + matrixWorld → discard
 *   2. equirectangular panorama → 6-face TEXTURE_CUBE_MAP via Canvas 2D sampling
 *   3. Tank shaders: Normal Mapping (TBN) + IBL Environment Mapping + Phong sun
 *   4. Skybox cube, shadow-catcher plane, orbit camera
 */

import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mat4, mat3 } from 'gl-matrix';

/* ─────────────────────────────────────────────────────────────────────────────
   LOGGING
───────────────────────────────────────────────────────────────────────────── */
function uiLog(msg, isErr = false) {
  console[isErr ? 'error' : 'log'](msg);
  const el = document.getElementById('msg');
  if (el) el.textContent = msg;
  const box = document.getElementById('log-box');
  if (box) {
    const d = document.createElement('div');
    d.className = isErr ? 'le' : 'll';
    d.textContent = msg;
    box.appendChild(d);
    box.scrollTop = box.scrollHeight;
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
   GLSL ES 3.00 — SKYBOX
───────────────────────────────────────────────────────────────────────────── */
const SKYBOX_VS = /* glsl */`#version 300 es
in  vec3 a_Pos;
uniform mat4 u_VP;
out vec3 v_Dir;
void main() {
  v_Dir       = a_Pos;
  vec4 p      = u_VP * vec4(a_Pos, 1.0);
  gl_Position = p.xyww;          /* depth = w/w = 1.0 — always behind geometry */
}`;

const SKYBOX_FS = /* glsl */`#version 300 es
precision mediump float;
in  vec3        v_Dir;
uniform samplerCube u_Sky;
out vec4 outColor;
void main() {
  vec3 c  = texture(u_Sky, v_Dir).rgb;
  /* gamma-correct the HDR-ish panorama data */
  outColor = vec4(pow(max(c, vec3(0.0)), vec3(1.0 / 2.2)), 1.0);
}`;

/* ─────────────────────────────────────────────────────────────────────────────
   GLSL ES 3.00 — TANK (Normal Map + IBL + Phong)
───────────────────────────────────────────────────────────────────────────── */
const TANK_VS = /* glsl */`#version 300 es
in vec3 a_Pos;
in vec3 a_Norm;
in vec4 a_Tan;        /* xyz = tangent direction, w = handedness (+1 / -1) */
in vec2 a_UV;

uniform mat4 u_M;     /* model (world) matrix from the GLTF node */
uniform mat4 u_VP;    /* view-projection */
uniform mat3 u_N;     /* inverse-transpose of upper-left 3x3 of u_M */

out vec3  v_Wpos;
out vec2  v_UV;
out mat3  v_TBN;

void main() {
  vec4 wp = u_M * vec4(a_Pos, 1.0);
  v_Wpos  = wp.xyz;
  v_UV    = a_UV;

  vec3 N = normalize(u_N * a_Norm);
  vec3 T = normalize(u_N * a_Tan.xyz);
  T = normalize(T - dot(T, N) * N);     /* Gram-Schmidt re-orthogonalise */
  vec3 B = cross(N, T) * a_Tan.w;       /* w encodes handedness */
  v_TBN  = mat3(T, B, N);

  gl_Position = u_VP * wp;
}`;

const TANK_FS = /* glsl */`#version 300 es
precision highp float;

in vec3  v_Wpos;
in vec2  v_UV;
in mat3  v_TBN;

uniform sampler2D   u_BaseColor;
uniform sampler2D   u_NormalMap;
uniform sampler2D   u_MetRough;       /* G = roughness, B = metallic */
uniform samplerCube u_EnvMap;

uniform vec3 u_CamPos;
uniform vec3 u_Ambient;              /* deep twilight blue  (0.1, 0.15, 0.25) */
uniform vec3 u_SunDir;              /* world-space unit vector TOWARD sun */
uniform vec3 u_SunColor;            /* warm orange  (1.0, 0.6, 0.3) */

out vec4 outColor;

void main() {
  /* ── Texture samples ─────────────────────────────────────────────────── */
  vec3  base      = texture(u_BaseColor, v_UV).rgb;
  vec3  nts       = texture(u_NormalMap, v_UV).rgb * 2.0 - 1.0;
  vec4  mr        = texture(u_MetRough,  v_UV);
  float roughness = mr.g;
  float metallic  = mr.b;

  /* ── Normal mapping ──────────────────────────────────────────────────── */
  vec3 N = normalize(v_TBN * nts);
  vec3 V = normalize(u_CamPos - v_Wpos);
  vec3 L = normalize(u_SunDir);

  /* ── Phong components ────────────────────────────────────────────────── */
  vec3  ambient   = u_Ambient * base;

  float NdL       = max(dot(N, L), 0.0);
  vec3  diffuse   = NdL * u_SunColor * base;

  vec3  H         = normalize(L + V);
  float shininess = mix(4.0, 256.0, 1.0 - roughness);
  float specFact  = pow(max(dot(N, H), 0.0), shininess) * metallic;
  vec3  specular  = specFact * u_SunColor;

  /* ── Environment mapping / IBL ───────────────────────────────────────── */
  vec3 R          = reflect(-V, N);
  vec3 envSample  = texture(u_EnvMap, R).rgb;
  vec3 reflection = envSample * metallic;    /* intensity scaled by metallic (blue ch) */

  /* ── Final accumulation ──────────────────────────────────────────────── */
  /* Final = Ambient + (Diffuse * Sun) + Specular + Reflection             */
  vec3 color = ambient + diffuse + specular + reflection;

  /* ── Gamma correction — fixes banding in sunset PNG ─────────────────── */
  color = pow(max(color, vec3(0.0)), vec3(1.0 / 2.2));

  outColor = vec4(color, 1.0);
}`;

/* ─────────────────────────────────────────────────────────────────────────────
   GLSL ES 3.00 — SHADOW CATCHER (invisible plane at y = 0)
───────────────────────────────────────────────────────────────────────────── */
const SHADOW_VS = /* glsl */`#version 300 es
in  vec2 a_Pos;          /* XZ coordinates of ground plane */
uniform mat4 u_VP;
void main() {
  gl_Position = u_VP * vec4(a_Pos.x, 0.001, a_Pos.y, 1.0);
}`;

const SHADOW_FS = /* glsl */`#version 300 es
precision mediump float;
out vec4 outColor;
void main() {
  outColor = vec4(0.0, 0.0, 0.0, 0.22);   /* semi-transparent black contact shadow */
}`;

/* ─────────────────────────────────────────────────────────────────────────────
   WEBGL 2.0 UTILITIES
───────────────────────────────────────────────────────────────────────────── */
function mkShader(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(s);
    console.error('[Tiger] Shader compile error:\n', info);
    throw new Error('Shader compile:\n' + info);
  }
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

function glTex2D(gl, image, label = '') {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  if (label) console.log(`✓ Texture bound: ${label}`);
  return t;
}

function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload  = () => res(img);
    img.onerror = () => rej(new Error('Image load failed: ' + src));
    img.src = src;
  });
}

/* ─────────────────────────────────────────────────────────────────────────────
   EQUIRECTANGULAR PANORAMA → TEXTURE_CUBE_MAP  (GPU path)
   The image is uploaded directly to a WebGL TEXTURE_2D.  A minimal conversion
   shader renders each of the 6 faces into a framebuffer — no Canvas 2D, no
   getImageData, no ~128 MB CPU buffer required for large panoramas.
───────────────────────────────────────────────────────────────────────────── */

/* Conversion shaders: fullscreen quad → equirectangular UV lookup per face */
const CONV_VS = /* glsl */`#version 300 es
in  vec2 a_Pos;
out vec2 v_UV;
void main() { v_UV = a_Pos * 0.5 + 0.5; gl_Position = vec4(a_Pos, 0.0, 1.0); }`;

const CONV_FS = /* glsl */`#version 300 es
precision highp float;
in  vec2 v_UV;
uniform sampler2D u_Equi;
uniform int       u_Face;   /* 0=+X 1=-X 2=+Y 3=-Y 4=+Z 5=-Z */
out vec4 outColor;

const float PI = 3.14159265359;

/* Returns the world-space direction for this face's (u,v) in NDC [−1,1]² */
vec3 faceDir(int face, vec2 uv) {
  float u = uv.x, v = uv.y;
  if (face == 0) return vec3( 1.0,  -v, -u);   /* +X */
  if (face == 1) return vec3(-1.0,  -v,  u);   /* -X */
  if (face == 2) return vec3(   u, 1.0,  v);   /* +Y */
  if (face == 3) return vec3(   u,-1.0, -v);   /* -Y */
  if (face == 4) return vec3(   u,  -v, 1.0);  /* +Z */
                 return vec3(  -u,  -v,-1.0);  /* -Z */
}

void main() {
  vec2  ndc   = v_UV * 2.0 - 1.0;
  vec3  dir   = normalize(faceDir(u_Face, ndc));
  float phi   = atan(dir.x, -dir.z);            /* azimuth  [−π, π]    */
  float theta = asin(dir.y);                    /* elevation[−π/2,π/2] */
  float eu    = phi   / (2.0 * PI) + 0.5;       /* [0, 1]              */
  float ev    = 0.5 - theta / PI;               /* [0, 1]  y+ = top    */
  outColor    = texture(u_Equi, vec2(eu, ev));
}`;

function equiToCubemap(gl, eqImg, faceSize = 512) {
  /* ── Upload panorama as a plain 2D texture ─────────────────────────── */
  const eqTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, eqTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, eqImg);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  console.log(`✓ Panorama uploaded to GPU (${eqImg.naturalWidth}×${eqImg.naturalHeight})`);

  /* ── Allocate the cubemap faces (empty, faceSize×faceSize each) ──── */
  const cubeTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_CUBE_MAP, cubeTex);
  const targets = [
    gl.TEXTURE_CUBE_MAP_POSITIVE_X, gl.TEXTURE_CUBE_MAP_NEGATIVE_X,
    gl.TEXTURE_CUBE_MAP_POSITIVE_Y, gl.TEXTURE_CUBE_MAP_NEGATIVE_Y,
    gl.TEXTURE_CUBE_MAP_POSITIVE_Z, gl.TEXTURE_CUBE_MAP_NEGATIVE_Z,
  ];
  for (const tgt of targets)
    gl.texImage2D(tgt, 0, gl.RGBA, faceSize, faceSize, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

  /* ── Compile the conversion program ─────────────────────────────── */
  const convProg = mkProg(gl, CONV_VS, CONV_FS);
  const uEqui    = gl.getUniformLocation(convProg, 'u_Equi');
  const uFace    = gl.getUniformLocation(convProg, 'u_Face');

  /* ── Fullscreen quad VAO ─────────────────────────────────────────── */
  const quadVerts = new Float32Array([-1,-1, 1,-1, 1,1,  -1,-1, 1,1, -1,1]);
  const quadVAO   = gl.createVertexArray();
  gl.bindVertexArray(quadVAO);
  gl.bindBuffer(gl.ARRAY_BUFFER, glBuf(gl, quadVerts));
  const aPos = gl.getAttribLocation(convProg, 'a_Pos');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  /* ── Framebuffer: render each face ──────────────────────────────── */
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.useProgram(convProg);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, eqTex);
  gl.uniform1i(uEqui, 0);
  gl.viewport(0, 0, faceSize, faceSize);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.CULL_FACE);

  const faceNames = ['+X', '-X', '+Y', '-Y', '+Z', '-Z'];
  for (let fi = 0; fi < 6; fi++) {
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, targets[fi], cubeTex, 0);
    gl.uniform1i(uFace, fi);
    gl.bindVertexArray(quadVAO);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    console.log(`✓ Cubemap face ${faceNames[fi]} (${fi + 1}/6) rendered on GPU`);
  }

  /* ── Restore GL state ────────────────────────────────────────────── */
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.enable(gl.DEPTH_TEST);
  gl.enable(gl.CULL_FACE);
  gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);

  /* ── Cubemap filtering ───────────────────────────────────────────── */
  gl.bindTexture(gl.TEXTURE_CUBE_MAP, cubeTex);
  gl.generateMipmap(gl.TEXTURE_CUBE_MAP);
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);

  /* ── Cleanup temporaries ─────────────────────────────────────────── */
  gl.deleteTexture(eqTex);
  gl.deleteFramebuffer(fb);
  gl.deleteProgram(convProg);

  return cubeTex;
}

/* ─────────────────────────────────────────────────────────────────────────────
   GLTF MESH EXTRACTION
   THREE.GLTFLoader is used ONLY as a parser.  We copy typed arrays out and
   store the node's matrixWorld so the GPU receives correct world-space geometry.
───────────────────────────────────────────────────────────────────────────── */
function extractTankMeshes(gltf) {
  const meshes = [];
  gltf.scene.updateMatrixWorld(true);

  gltf.scene.traverse(node => {
    if (!node.isMesh) return;

    const geo = node.geometry;

    const pos  = Float32Array.from(geo.attributes.position.array);
    const norm = geo.attributes.normal
      ? Float32Array.from(geo.attributes.normal.array)
      : new Float32Array(pos.length); // zero fallback

    const uv = geo.attributes.uv
      ? Float32Array.from(geo.attributes.uv.array)
      : new Float32Array(pos.length / 3 * 2);

    /* GLTF TANGENT is VEC4: xyz = tangent direction, w = handedness */
    let tan = geo.attributes.tangent
      ? Float32Array.from(geo.attributes.tangent.array)
      : null;

    /* Fallback tangents (all pointing +X) when the GLTF omits them */
    if (!tan) {
      tan = new Float32Array(pos.length / 3 * 4);
      for (let i = 0; i < pos.length / 3; i++) {
        tan[i*4]   = 1; tan[i*4+1] = 0; tan[i*4+2] = 0; tan[i*4+3] = 1;
      }
    }

    let idx = null, idxType = null;
    if (geo.index) {
      const raw = geo.index.array;
      if (raw instanceof Uint32Array) {
        idx = Uint32Array.from(raw);
        idxType = WebGL2RenderingContext.UNSIGNED_INT;
      } else {
        idx = Uint16Array.from(raw);
        idxType = WebGL2RenderingContext.UNSIGNED_SHORT;
      }
    }

    /* node.matrixWorld is column-major Float64, same layout as gl-matrix mat4 */
    const modelMatrix = new Float32Array(node.matrixWorld.elements);

    /* Derive texture set from material name (tracks / hull / turret) */
    const matName = Array.isArray(node.material)
      ? node.material[0]?.name ?? ''
      : node.material?.name ?? '';
    const texSet = matName.includes('turret') ? 'turret'
                 : matName.includes('track')  ? 'tracks'
                 : 'hull';

    meshes.push({ pos, norm, uv, tan, idx, idxType, modelMatrix, texSet });
  });

  return meshes;
}

/* ─────────────────────────────────────────────────────────────────────────────
   GROUND THE TANK
   Iterates every vertex through its model matrix to find the lowest world-space
   Y, then shifts every model matrix's translation row so that point is y = 0.
   This is automatic — no manual tuning needed regardless of model scale/rotation.
───────────────────────────────────────────────────────────────────────────── */
function groundTankMeshes(meshes) {
  let minY = Infinity;

  for (const m of meshes) {
    const mat = m.modelMatrix; // column-major Float32Array[16]
    const pos = m.pos;
    /* Column-major mat4: worldY = mat[1]*x + mat[5]*y + mat[9]*z + mat[13] */
    for (let i = 0; i < pos.length; i += 3) {
      const wy = mat[1]*pos[i] + mat[5]*pos[i+1] + mat[9]*pos[i+2] + mat[13];
      if (wy < minY) minY = wy;
    }
  }

  console.log(`[Tiger] Track world-space floor at y = ${minY.toFixed(4)} — shifting to 0`);

  /* Shift translation Y in every model matrix so bottom of tracks = y 0 */
  for (const m of meshes) m.modelMatrix[13] -= minY;

  /* Return the tank's approximate centre height for the camera target */
  let maxY = -Infinity;
  for (const m of meshes) {
    const mat = m.modelMatrix;
    const pos = m.pos;
    for (let i = 0; i < pos.length; i += 3) {
      const wy = mat[1]*pos[i] + mat[5]*pos[i+1] + mat[9]*pos[i+2] + mat[13];
      if (wy > maxY) maxY = wy;
    }
  }
  return maxY * 0.45; // ~45 % of tank height → nice orbit target
}

/* ─────────────────────────────────────────────────────────────────────────────
   VAO BUILDERS
───────────────────────────────────────────────────────────────────────────── */
function makeSkyboxVAO(gl, prog) {
  /* Unit cube — 36 vertices, no index buffer, clockwise winding face-inward */
  const v = new Float32Array([
    -1,-1,-1,  1,-1,-1,  1, 1,-1,   1, 1,-1, -1, 1,-1, -1,-1,-1, // -Z
    -1,-1, 1,  1,-1, 1,  1, 1, 1,   1, 1, 1, -1, 1, 1, -1,-1, 1, // +Z (reversed)
    -1, 1, 1, -1, 1,-1, -1,-1,-1,  -1,-1,-1, -1,-1, 1, -1, 1, 1, // -X
     1, 1, 1,  1, 1,-1,  1,-1,-1,   1,-1,-1,  1,-1, 1,  1, 1, 1, // +X
    -1,-1,-1,  1,-1,-1,  1,-1, 1,   1,-1, 1, -1,-1, 1, -1,-1,-1, // -Y
    -1, 1,-1,  1, 1,-1,  1, 1, 1,   1, 1, 1, -1, 1, 1, -1, 1,-1, // +Y
  ]);
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, glBuf(gl, v));
  const loc = gl.getAttribLocation(prog, 'a_Pos');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  return { vao, count: 36 };
}

function makeTankVAO(gl, prog, mesh) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);

  const attribs = [
    ['a_Pos',  mesh.pos,  3],
    ['a_Norm', mesh.norm, 3],
    ['a_Tan',  mesh.tan,  4],
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

function makeShadowVAO(gl, prog, halfSize = 20) {
  /* Flat XZ quad, centre at origin, y = 0 handled in the vertex shader */
  const s = halfSize;
  const v = new Float32Array([
    -s,-s,  s,-s,  s,s,
    -s,-s,  s, s, -s,s,
  ]);
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, glBuf(gl, v));
  const loc = gl.getAttribLocation(prog, 'a_Pos');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  return { vao, count: 6 };
}

/* ─────────────────────────────────────────────────────────────────────────────
   ORBIT CAMERA  (drag to rotate, scroll to zoom)
───────────────────────────────────────────────────────────────────────────── */
function makeOrbitCamera(canvas, targetY = 1.5) {
  const s = {
    theta: 0.35,          // start slightly off-front for a 3/4 hero angle
    phi:   0.12,          // low angle to match the panorama's eye level
    dist:  13,
    target: [0, targetY, 0],
    drag: false, lx: 0, ly: 0,
  };

  canvas.addEventListener('mousedown', e => { s.drag = true; s.lx = e.clientX; s.ly = e.clientY; });
  window.addEventListener('mouseup',   () => { s.drag = false; });
  window.addEventListener('mousemove', e => {
    if (!s.drag) return;
    s.theta -= (e.clientX - s.lx) * 0.005;
    /* phi: clamp so camera stays above ground and below top-down.          */
    /* 0.05 rad minimum keeps the eye-point above y=0 at any zoom distance. */
    s.phi = Math.max(0.05, Math.min(0.78, s.phi - (e.clientY - s.ly) * 0.005));
    s.lx = e.clientX; s.ly = e.clientY;
  });
  canvas.addEventListener('wheel', e => {
    s.dist = Math.max(4, Math.min(60, s.dist * (1 + e.deltaY * 0.001)));
    e.preventDefault();
  }, { passive: false });

  return {
    getView(outView) {
      const cx = s.dist * Math.cos(s.phi) * Math.sin(s.theta) + s.target[0];
      const cy = s.dist * Math.sin(s.phi)                     + s.target[1];
      const cz = s.dist * Math.cos(s.phi) * Math.cos(s.theta) + s.target[2];
      mat4.lookAt(outView, [cx, cy, cz], s.target, [0, 1, 0]);
      return [cx, cy, cz];
    },
  };
}

/* ─────────────────────────────────────────────────────────────────────────────
   MAIN
───────────────────────────────────────────────────────────────────────────── */
async function main() {
  const canvas = document.getElementById('c');
  const gl = canvas.getContext('webgl2');
  if (!gl) { uiLog('WebGL 2.0 not supported in this browser.', true); return; }

  function resize() {
    const W = Math.round(canvas.clientWidth  * devicePixelRatio);
    const H = Math.round(canvas.clientHeight * devicePixelRatio);
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W; canvas.height = H;
      gl.viewport(0, 0, W, H);
    }
  }
  resize();
  window.addEventListener('resize', resize);

  /* ── Compile programs ──────────────────────────────────────────────── */
  uiLog('Compiling shaders…');
  let skyProg, tankProg, shadowProg;
  try {
    skyProg    = mkProg(gl, SKYBOX_VS, SKYBOX_FS);
    tankProg   = mkProg(gl, TANK_VS,   TANK_FS);
    shadowProg = mkProg(gl, SHADOW_VS, SHADOW_FS);
    console.log('✓ All 3 shader programs compiled and linked');
  } catch (e) {
    uiLog('Shader error: ' + e.message, true);
    return;
  }

  /* ── Load panorama + build cubemap ──────────────────────────────────── */
  uiLog('Loading sunset panorama (30 MB)…');
  const panorama = await loadImage('/rural_evening_road_4k.png');
  console.log(`✓ Panorama loaded: ${panorama.naturalWidth}×${panorama.naturalHeight}`);
  uiLog('Converting panorama → cubemap (GPU, 512² per face)…');
  const envTex = equiToCubemap(gl, panorama, 512);
  console.log('✓ Sunset cubemap ready — 6 faces rendered on GPU');

  /* ── Load Tiger I GLTF ───────────────────────────────────────────────── */
  uiLog('Parsing Tiger I GLTF…');
  const gltf = await new Promise((res, rej) =>
    new GLTFLoader().load('/scene.gltf', res, undefined, rej)
  );
  const rawMeshes = extractTankMeshes(gltf);
  console.log(`✓ Extracted ${rawMeshes.length} meshes (tracks, hull×2, turret)`);
  const tankCentreY = groundTankMeshes(rawMeshes); // shifts all matrices so tracks = y 0
  console.log(`✓ Tank grounded — orbit target y ≈ ${tankCentreY.toFixed(2)}`);

  /* ── Load PBR texture trios ──────────────────────────────────────────── */
  uiLog('Loading PBR textures (9 maps)…');
  const texSets = {};
  for (const name of ['hull', 'turret', 'tracks']) {
    const [bc, mr, nm] = await Promise.all([
      loadImage(`/textures/${name}_baseColor.png`),
      loadImage(`/textures/${name}_metallicRoughness.png`),
      loadImage(`/textures/${name}_normal.png`),
    ]);
    texSets[name] = {
      baseColor:     glTex2D(gl, bc, `${name}_baseColor`),
      metallicRough: glTex2D(gl, mr, `${name}_metallicRoughness`),
      normalMap:     glTex2D(gl, nm, `${name}_normal`),
    };
  }

  /* ── Build GPU geometry ──────────────────────────────────────────────── */
  const skyboxGPU = makeSkyboxVAO(gl, skyProg);
  const shadowGPU = makeShadowVAO(gl, shadowProg, 22);

  const tankGPU = rawMeshes.map(m => ({
    ...makeTankVAO(gl, tankProg, m),
    modelMatrix: m.modelMatrix,
    texSet: texSets[m.texSet],
  }));

  /* ── Uniform locations ───────────────────────────────────────────────── */
  const skyU = {
    VP:  gl.getUniformLocation(skyProg,  'u_VP'),
    Sky: gl.getUniformLocation(skyProg,  'u_Sky'),
  };
  const tankU = {
    M:       gl.getUniformLocation(tankProg, 'u_M'),
    VP:      gl.getUniformLocation(tankProg, 'u_VP'),
    N:       gl.getUniformLocation(tankProg, 'u_N'),
    Base:    gl.getUniformLocation(tankProg, 'u_BaseColor'),
    NormMap: gl.getUniformLocation(tankProg, 'u_NormalMap'),
    MR:      gl.getUniformLocation(tankProg, 'u_MetRough'),
    Env:     gl.getUniformLocation(tankProg, 'u_EnvMap'),
    Cam:     gl.getUniformLocation(tankProg, 'u_CamPos'),
    Ambient: gl.getUniformLocation(tankProg, 'u_Ambient'),
    SunDir:  gl.getUniformLocation(tankProg, 'u_SunDir'),
    SunCol:  gl.getUniformLocation(tankProg, 'u_SunColor'),
  };
  const shadowU = { VP: gl.getUniformLocation(shadowProg, 'u_VP') };

  /* ── Pre-allocate matrix temporaries ────────────────────────────────── */
  const proj       = mat4.create();
  const view       = mat4.create();
  const vp         = mat4.create();
  const skyView    = mat4.create();
  const skyVP      = mat4.create();
  const normalMat  = mat3.create();

  const cam = makeOrbitCamera(canvas, tankCentreY);

  /* ── Sun: low-angle orange from the -Z horizon (faces the sunset) ───── */
  const SUN_DIR   = new Float32Array([0.25, 0.18, -0.95]);  /* approx sunset direction */
  const SUN_COLOR = new Float32Array([1.0,  0.60,  0.30]);
  const AMBIENT   = new Float32Array([0.10, 0.15,  0.25]);  /* deep twilight blue */

  /* ── Hide loading ────────────────────────────────────────────────────── */
  document.getElementById('loading').style.display = 'none';

  /* ── Render loop ─────────────────────────────────────────────────────── */
  function draw() {
    resize();
    const W = canvas.width, H = canvas.height;

    mat4.perspective(proj, 0.8727, W / H, 0.1, 500.0); // 50° FOV
    const camPos = cam.getView(view);
    mat4.multiply(vp, proj, view);

    /* Skybox view = view without translation */
    mat4.copy(skyView, view);
    skyView[12] = skyView[13] = skyView[14] = 0;
    mat4.multiply(skyVP, proj, skyView);

    gl.clearColor(0.05, 0.04, 0.08, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);

    /* ── 1. Skybox ─────────────────────────────────────────────────────── */
    /* p.xyww puts skybox at depth exactly 1.0 (far plane). The default     */
    /* gl.LESS would reject it (1.0 < 1.0 is false). Use LEQUAL instead.   */
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.useProgram(skyProg);
    gl.uniformMatrix4fv(skyU.VP, false, skyVP);
    gl.uniform1i(skyU.Sky, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, envTex);
    gl.bindVertexArray(skyboxGPU.vao);
    gl.drawArrays(gl.TRIANGLES, 0, skyboxGPU.count);
    gl.depthMask(true);
    gl.depthFunc(gl.LESS);   /* restore standard depth test for geometry */
    gl.enable(gl.CULL_FACE);

    /* ── 2. Tank meshes ────────────────────────────────────────────────── */
    gl.useProgram(tankProg);
    gl.uniformMatrix4fv(tankU.VP, false, vp);
    gl.uniform3fv(tankU.Cam,     camPos);
    gl.uniform3fv(tankU.Ambient, AMBIENT);
    gl.uniform3fv(tankU.SunDir,  SUN_DIR);
    gl.uniform3fv(tankU.SunCol,  SUN_COLOR);

    /* Bind env cubemap once — it stays in slot 3 for all tank draws */
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, envTex);
    gl.uniform1i(tankU.Env, 3);

    gl.cullFace(gl.BACK);

    for (const gm of tankGPU) {
      /* Normal matrix = inverse-transpose of upper-left 3x3 of model matrix */
      mat3.fromMat4(normalMat, gm.modelMatrix);
      mat3.invert(normalMat, normalMat);
      mat3.transpose(normalMat, normalMat);

      gl.uniformMatrix4fv(tankU.M,  false, gm.modelMatrix);
      gl.uniformMatrix3fv(tankU.N,  false, normalMat);

      /* Bind PBR trio for this mesh's material */
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, gm.texSet.baseColor);
      gl.uniform1i(tankU.Base, 0);

      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, gm.texSet.normalMap);
      gl.uniform1i(tankU.NormMap, 1);

      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, gm.texSet.metallicRough);
      gl.uniform1i(tankU.MR, 2);

      gl.bindVertexArray(gm.vao);
      if (gm.drawMode === 'el') {
        gl.drawElements(gl.TRIANGLES, gm.drawCount, gm.idxType, 0);
      } else {
        gl.drawArrays(gl.TRIANGLES, 0, gm.drawCount);
      }
    }

    /* ── 3. Shadow catcher ─────────────────────────────────────────────── */
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.useProgram(shadowProg);
    gl.uniformMatrix4fv(shadowU.VP, false, vp);
    gl.bindVertexArray(shadowGPU.vao);
    gl.drawArrays(gl.TRIANGLES, 0, shadowGPU.count);
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    gl.enable(gl.CULL_FACE);

    requestAnimationFrame(draw);
  }

  requestAnimationFrame(draw);
}

main().catch(e => { uiLog('Fatal: ' + e.message, true); console.error(e); });
