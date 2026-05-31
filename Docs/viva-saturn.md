# `src/saturn.js` — Deep-Dive Viva Guide

> The main entry point. Orchestrates everything: asset loading, GPU object
> creation, camera control, and the 4-pass render loop. ~380 lines.

---

## Module Imports (Lines 1–7)

```js
import { mat4, mat3, vec3 } from 'gl-matrix';
import { mkProg, makeVAO, glBuf, glTex2D, glTexCubeFromImages,
         mkRenderTarget, freeRenderTarget, drawVAO, cacheUniforms, bindTex } from './gl-utils.js';
import { loadImage, loadCubemapFaces, boundsOf } from './geometry.js';
import { loadGLTF, extractMeshes } from './gltf-loader.js';
import { SKYBOX_VS, SKYBOX_FS, POST_VS,
         BRIGHT_FS, BLUR_FS, COMPOSITE_FS, PLANET_VS, PLANET_FS } from './shaders.js';
```

> `makeUvSphere` (used to build the old sun sphere) and the `SUN_VS`/`SUN_FS`
> shaders are no longer imported — the sun is now drawn in `SKYBOX_FS`.

**`gl-matrix`** — a battle-tested JS math library for 4×4 matrices and 3D vectors.
All matrix operations (`mat4.perspective`, `mat4.lookAt`, `mat4.multiply`,
`mat4.rotateX`, `mat4.rotateZ`, `mat4.scale`, `mat4.translate`, `mat4.invert`) come
from here. `mat3.normalFromMat4` computes the normal matrix.

---

## Constants (Lines 9–19)

```js
const ENC_ORBIT_R = 15;                          // Enceladus orbit radius in world units
const SUN_COL     = new Float32Array([1.0, 0.97, 0.85]);  // warm white
const SUN_DIR_RAW = [-0.6, -0.2, -0.8];          // raw direction, normalised later

const SAT_TILT = 56.73 * Math.PI / 180;   // Saturn's axial tilt in radians
const SAT_SPIN = 0.15;                    // body spin rate about its pole (radians/frame)

const isRing = m => /saturn2/.test(m.name);       // mesh name filter
```

`ENC_ORBIT_R = 15` world units — chosen so Enceladus is visually far enough
from Saturn to be distinct but close enough to be interesting in frame.

`SAT_TILT = 56.73°` — the tilt is applied via `rotateX` because in the GLB model
Saturn's pole is local +Z. Leaning the pole away from world +Y is a rotation about X.

`SAT_SPIN = 0.15` — the body rotates about its own pole (local +Z after tilt). Because
the ring disc's normal is also local +Z, spinning about Z leaves the ring plane
orientation unchanged. This means the ring shadow band stays fixed relative to the
planet's equatorial plane while Saturn's surface bands animate under it — which is
physically correct. The old `rotateY` spin was in the ring plane, which made the shadow
sweep around incorrectly.

`isRing` — Saturn's GLB file names the ring mesh something containing `"saturn2"`.
This regex tests the mesh name to separate ring geometry (transparent, no depth write)
from the body (opaque, writes depth). This distinction drives the entire render-order
architecture.

---

## `main()` — Startup Sequence

### WebGL2 Context (Lines 24–25)

```js
const gl = canvas.getContext('webgl2');
if (!gl) { msgEl.textContent = 'WebGL 2.0 not supported.'; return; }
```

`getContext('webgl2')` — requests a WebGL 2.0 context. Falls back to `null`
on unsupported browsers (Safari < 15, some mobile). WebGL 2 is required for:
- `#version 300 es` shaders
- `DEPTH_COMPONENT24` renderbuffers
- `Uint32Array` index buffers in `gl.drawElements`
- VAO support without an extension

### DPR-aware Canvas Resize (Lines 27–32)

```js
const resize = () => {
  const dpr = Math.min(window.devicePixelRatio, 2);
  canvas.width  = (canvas.clientWidth  * dpr) | 0;
  canvas.height = (canvas.clientHeight * dpr) | 0;
};
```

**DPR (Device Pixel Ratio)** — on a Retina display, `devicePixelRatio = 2`,
meaning 2 physical pixels per CSS pixel. Without DPR scaling, WebGL renders
at CSS resolution and the OS upscales it, producing blurry output.

By setting `canvas.width = clientWidth * dpr`, we render at full physical
pixel resolution. `| 0` truncates to integer (bitwise OR with 0 = fast floor).

`Math.min(..., 2)` — caps at 2×. On phones with DPR=3, rendering at 3× costs
9× the fill rate of 1×; 2× gives excellent quality with manageable cost.

### Parallel Asset Loading (Lines 41–44)

```js
const [satGLTF, encGLTF] = await Promise.all([
  loadGLTF('/saturn.glb',    e => { ... }),
  loadGLTF('/enceladus.glb', e => { ... }),
]);
```

`Promise.all` fires both XHR requests simultaneously. The total load time
is `max(sat_time, enc_time)` instead of `sat_time + enc_time`.
The progress callbacks update the loading message live.

### Mesh Filtering (Lines 48–51)

```js
const satMeshes = extractMeshes(satGLTF).filter(m => !/(mimas|enceladus)/.test(m.name));
```

The Saturn GLB was downloaded from an online source and includes Mimas and
Enceladus as child objects — at wrong scale and position for this scene.
The regex filter strips them out, keeping only Saturn body and rings.

---

## Program Compilation (Lines 55–59)

```js
const skyProg    = mkProg(gl, SKYBOX_VS,  SKYBOX_FS);
const planetProg = mkProg(gl, PLANET_VS,  PLANET_FS);
const brightProg = mkProg(gl, POST_VS,    BRIGHT_FS);
const blurProg   = mkProg(gl, POST_VS,    BLUR_FS);
const compProg   = mkProg(gl, POST_VS,    COMPOSITE_FS);
```

Five programs. Note `POST_VS` is reused by `brightProg`, `blurProg`, and `compProg` —
all post-processing passes use the same full-screen quad vertex shader. There is
no longer a separate sun program; the sun is part of `skyProg`'s `SKYBOX_FS`.

---

## Full-Screen Quad VAO (Lines 62–69)

```js
const quadVAO = gl.createVertexArray();
gl.bindVertexArray(quadVAO);
const qBuf = glBuf(gl, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]));
gl.bindBuffer(gl.ARRAY_BUFFER, qBuf);
const qLoc = gl.getAttribLocation(skyProg, 'a_Pos');
gl.enableVertexAttribArray(qLoc);
gl.vertexAttribPointer(qLoc, 2, gl.FLOAT, false, 0, 0);
gl.bindVertexArray(null);
```

Four 2D NDC vertices forming a **triangle strip** quad covering the screen.
`gl.TRIANGLE_STRIP` with 4 vertices: (v0,v1,v2) then (v1,v2,v3) = 2 triangles.
Vertex order:
```
(-1,+1)---(+1,+1)
   |      /  |
   |    /    |
(-1,-1)---(+1,-1)
```

The VAO is manually built here (not via `makeVAO`) because this quad is
used with `skyProg`'s attribute locations, and `makeVAO` is designed for
the 3-attribute `planetProg` layout.

---

## Texture Upload (Lines 72–87)

```js
const satBodyImg = await loadImage('/8k_saturn.jpg');
const satBodyTex = glTex2D(gl, satBodyImg);

/* Radial ring-opacity strip (8192×500 RGBA): alpha = ring opacity from inner
   to outer edge — drives the translucent ring shadow on Saturn & Enceladus. */
const ringAlphaImg = await loadImage('/8k_saturn_ring_alpha.png');
const ringAlphaTex = glTex2D(gl, ringAlphaImg);

const satGPU     = satMeshes.map(m => makeVAO(gl, planetProg, m));
const satTex     = satMeshes.map(m =>
  isRing(m) ? (m.image ? glTex2D(gl, m.image) : null) : satBodyTex
);
```

Only the Saturn body texture (`8k_saturn.jpg`) is loaded for the planet — the sun is
procedural so `8k_sun.jpg` is no longer fetched. Ring meshes use their own embedded
GLB texture (`m.image`); body meshes all share `satBodyTex`.

`ringAlphaTex` is used exclusively for the ring shadow calculation. It is a wide image
whose **alpha channel encodes the ring's radial opacity** from the inner edge (left) to
the outer edge (right). When the shader needs to know how much shadow a point on
Saturn's surface receives from the rings, it projects that point toward the sun, hits
the ring plane, converts the hit radius to a 0–1 UV, and samples this texture.
This means the shadow naturally replicates the actual ring structure (dense B-ring,
sparse Cassini Division, etc.) without any additional geometry.

---

## Opaque/Transparent Pre-split (Lines 92–97)

```js
const satBodyIdx  = satMeshes.map((_, i) => i).filter(i => !isRing(satMeshes[i]));
const satRingIdx  = satMeshes.map((_, i) => i).filter(i =>  isRing(satMeshes[i]));
const satBodyGPU   = satBodyIdx.map(i => satGPU[i]);
const satRingGPU   = satRingIdx.map(i => satGPU[i]);
// etc.
```

At startup, Saturn's meshes are split into body-only and ring-only lists.

This is the **depth-sorting / painter's algorithm** concern for alpha-blended
geometry. If rings were drawn before Enceladus:
- Rings write colour but not depth (`depthMask=false`)
- Enceladus drawn after would appear in front of rings even when behind them

By drawing Enceladus (opaque → depth written) before rings (transparent →
reads depth but doesn't write), the GPU's depth test naturally handles occlusion.

---

## Uniform Location Cache (Lines 100–108)

```js
const U = cacheUniforms(gl, planetProg, [
  'u_MVP','u_M','u_N','u_LDir','u_LCol','u_Base','u_Cam',
  'u_Shin','u_SpecK','u_Alpha','u_TexOn','u_Tex','u_AlphaCutoff',
  'u_SpecTexOn','u_SpecTex','u_SpecUV','u_SpecFactor','u_GlossFactor',
  'u_UVRepeat','u_UVOffset',
  'u_EnvMap','u_EnvStr','u_FogDensity','u_FogColor','u_OccluderCenter','u_OccluderR',
  'u_Occluder2Center','u_Occluder2R',
  'u_RingShadowOn','u_RingNormal','u_RingCenter','u_RingInner','u_RingOuter',
  'u_RingAlphaTex','u_RingShadowStr',
]);
```

34 uniforms cached at startup. Every frame that calls `gl.uniform*()` uses these
pre-fetched integer locations — no string lookups per frame.

The three spec-map uniforms (`u_SpecUV`, `u_SpecFactor`, `u_GlossFactor`) are set
per-mesh inside `drawMesh`: the body uses UV1, `specularFactor=0.23`, `glossFactor=1.0`;
the ring uses UV1, `specularFactor=1.0`, `glossFactor=0.5` — all sourced directly from
the GLB material, not hard-coded.

The ring shadow uniforms (last 7):
- `u_RingShadowOn` — flag: `1.0` for bodies/moons that receive a shadow, `0.0` for
  the ring geometry itself (rings don't self-shadow).
- `u_RingNormal` — world-space unit normal of the ring plane, recalculated every frame.
- `u_RingCenter` — world-space centre of the rings (always `(0,0,0)`, Saturn's origin).
- `u_RingInner`, `u_RingOuter` — annulus radii in world units.
- `u_RingAlphaTex` — the radial opacity strip texture (bound to `TEXTURE3`, slot 3).
- `u_RingShadowStr` — overall shadow attenuation strength (set to 0.9).

Note `SkyU` (line 109) now caches two extra uniforms `u_SunDir` and `u_SunCol` compared
to the old version — needed because the skybox shader draws the procedural sun.

---

## Ring Annulus Radii (Lines 128–136)

```js
let ringInnerLocal = Infinity, ringOuterLocal = 0;
for (const m of satRingMeshes)
  for (let i = 0; i < m.pos.length; i += 3) {
    const r = Math.hypot(m.pos[i] - sB.cx, m.pos[i + 1] - sB.cy);
    if (r < ringInnerLocal) ringInnerLocal = r;
    if (r > ringOuterLocal) ringOuterLocal = r;
  }
const ringInner = sS * ringInnerLocal;
const ringOuter = sS * ringOuterLocal;
const ringNormal = vec3.create();
```

The rings lie in Saturn's equatorial plane (local XY, normal local +Z). Their inner
and outer extent in world units is needed by the ring shadow shader so it can tell
whether a projected point lands inside the annulus.

Rather than hardcoding radii, the code **measures them from the actual mesh vertex
positions**: for every vertex across all ring chunks, compute the radial distance from
Saturn's geometric centre using `Math.hypot(x - cx, y - cy)`. Track the min (inner
edge) and max (outer edge). Then multiply by `sS` (the scale factor that maps the GLB
into world units) to get world-space radii. This automatically matches whatever the
artist exported — no manual tuning.

`ringNormal` is allocated once here (as a reusable `vec3`) and filled every frame from
the model matrix.

---

## Scene Constants (Lines 115–139)

```js
const spaceCubemap = glTexCubeFromImages(gl, await loadCubemapFaces('/cubemap_starmap_2020_1024'));

const satBodyMesh = satMeshes.find(m => !isRing(m)) ?? satMeshes[0];
const eB = boundsOf(encMeshes[0].pos);
const sB = boundsOf(satBodyMesh.pos);
const sS = 3.2  / sB.r;    // Saturn scale factor
const eS = 0.42 / eB.r;    // Enceladus scale factor
const satBodyRadius = sS * sB.r;  // = 3.2 world units exactly
```

`satBodyRadius = sS * sB.r = (3.2 / sB.r) * sB.r = 3.2`. It's always exactly 3.2.
This is used as the occluder radius for the analytical sphere-shadow test.

```js
const SUN_DIR = vec3.normalize(vec3.create(), SUN_DIR_RAW);
```

`SUN_DIR` is used both by the lighting shader (directional light — infinitely far, so
only direction matters for shading) and by `SKYBOX_FS`, which draws the procedural
sun disk/halo in that direction. There is no longer a sun-sphere GPU object or a
`SUN_POS` world position.

---

## Camera System (Lines 142–171)

### View Mode Toggle (Lines 142–149)

```js
let viewMode = 'saturn', satCamR = 22.0, encCamR = 3.0;
window.addEventListener('keydown', e => {
  if (e.key !== 'e' && e.key !== 'E') return;
  viewMode = viewMode === 'saturn' ? 'enceladus' : 'saturn';
  camRx = 0.1; camRy = 0.0;
  ...
});
```

Two view modes with separate orbit radii. Pressing `E` snaps the camera
target from Saturn's origin `(0,0,0)` to Enceladus's current world position.

### Arcball Orbit (Lines 152–159)

```js
let camRx = 0.22, camRy = 0.0;
const onMove = (x, y) => {
  camRy += (x - px) * 0.005;  // horizontal → yaw
  camRx += (y - py) * 0.005;  // vertical   → pitch
  camRx = Math.max(-1.45, Math.min(1.45, camRx));  // clamp ±83°
  ...
};
```

**Arcball/spherical orbit camera:** The camera stays on a sphere of radius
`camR` centred on `ctr`. Mouse horizontal drag changes the azimuthal angle
`camRy` (yaw), vertical drag changes the polar angle `camRx` (pitch).

`camRx` clamped to ±1.45 radians (±83°) — prevents gimbal lock at the poles
where the yaw axis collapses.

Camera position in the render loop (lines 249–253):
```js
const camPos = [
  ctr[0] + camR * Math.sin(camRy) * Math.cos(camRx),
  ctr[1] + camR * Math.sin(camRx),
  ctr[2] + camR * Math.cos(camRy) * Math.cos(camRx),
];
```

This is the **spherical coordinate → Cartesian** conversion:
- X: `R · sin(yaw) · cos(pitch)`
- Y: `R · sin(pitch)`
- Z: `R · cos(yaw) · cos(pitch)`

### Scroll Zoom (Lines 167–171)

```js
canvas.addEventListener('wheel', e => {
  if (viewMode === 'saturn') satCamR = Math.max(4, Math.min(120, satCamR + e.deltaY * 0.06));
  else                       encCamR = Math.max(1.2, Math.min(15, encCamR + e.deltaY * 0.02));
  e.preventDefault();
}, { passive: false });
```

`e.deltaY` is positive for scroll-down (zoom out) and negative for scroll-up
(zoom in). Clamps enforce minimum/maximum distance. `passive: false` is
required to call `e.preventDefault()` — which stops the page from scrolling.

---

## Render Targets: Lazy Resize (Lines 177–184)

```js
let sceneRT = null, bloomA = null, bloomB = null, rtW = 0, rtH = 0;
const ensureTargets = (w, h) => {
  if (w === rtW && h === rtH && sceneRT) return;  // no resize needed
  [sceneRT, bloomA, bloomB].forEach(rt => freeRenderTarget(gl, rt));
  sceneRT = mkRenderTarget(gl, w, h, true);   // with depth buffer
  bloomA  = mkRenderTarget(gl, w, h, false);  // colour only
  bloomB  = mkRenderTarget(gl, w, h, false);  // colour only
  rtW = w; rtH = h;
};
```

Three render targets:
- `sceneRT` — full 3D scene rendered here (Pass 1). Has depth buffer.
- `bloomA`, `bloomB` — ping-ponged for the Gaussian blur (Passes 2–3).
  No depth buffer needed (full-screen 2D operations).

Called every frame before rendering. If the canvas size hasn't changed, it's
a no-op (single comparison). If size changed (window resize), old GPU textures
are freed and new ones are allocated at the new size.

---

## `renderGroup()` — Lines 187–233

```js
function renderGroup(gpuList, meshList, texList, specTexList, modelMat, envStrength) {
  gl.uniformMatrix4fv(U.u_MVP, false, mat4.multiply(mat4.create(), vp, modelMat));
  gl.uniformMatrix4fv(U.u_M,   false, modelMat);
  gl.uniformMatrix3fv(U.u_N,   false, mat3.normalFromMat4(mat3.create(), modelMat));
  ...
```

Sets the three transform matrices for an entire body (Saturn, Enceladus).
Then iterates all meshes in the group, setting per-mesh uniforms and drawing.

### Ring Shadow Flag (per-mesh, line 198)

```js
gl.uniform1f(U.u_RingShadowOn, ring ? 0.0 : 1.0);  // rings don't self-shadow
```

Set per mesh inside `renderGroup`. Ring meshes pass `0.0` so the `ringShadow()`
function in the shader immediately returns 0 — the ring geometry never casts a shadow
on itself. Body meshes and Enceladus pass `1.0` to receive the shadow.

### Ring vs Body Render State (Lines 201–209)

```js
if (ring) {
  gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.depthMask(false);
  gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(1.0, 1.0);
} else {
  gl.disable(gl.BLEND);
  gl.depthMask(true);
  gl.disable(gl.POLYGON_OFFSET_FILL);
}
```

**Opaque body:**
- No blending — fragment colour fully replaces framebuffer colour
- `depthMask(true)` — writes to depth buffer

**Transparent rings:**
- Alpha blending: `C_out = C_src·α + C_dst·(1-α)` — standard Porter-Duff over
- `depthMask(false)` — reads depth but doesn't write. If rings wrote depth,
  the transparent areas would block geometry behind them.
- `gl.polygonOffset(1.0, 1.0)` — offsets depth values slightly outward.
  The rings are flat geometry very close to Saturn's surface in model space.
  Without offset, the ring polygons that intersect the body would Z-fight
  (alternating pixels of ring and body appear randomly). Polygon offset
  pushes ring depth values slightly further, ensuring body pixels always win.

### Draw Order Within `renderGroup` (Lines 230–232)

```js
gpuList.forEach((g, i) => { if (!isRing(meshList[i])) drawMesh(..., false); });
gpuList.forEach((g, i) => { if ( isRing(meshList[i])) drawMesh(..., true);  });
```

Body meshes are drawn first (write depth), then ring meshes (read depth only).
Two passes over the same array, filtering by type. This ensures that the
planet body's depth values are in the buffer when rings are drawn, so rings
behind the planet body are correctly occluded.

---

## Render Loop — `frame()` — Lines 237–370

### Time and Orbits (Lines 238–244)

```js
t += 0.004;
const encAngle = t * 0.70;
const encWorld = [ENC_ORBIT_R * Math.cos(encAngle), 0, -ENC_ORBIT_R * Math.sin(encAngle)];
```

`t` is a frame counter (not wall-clock time). Enceladus orbits at `0.70 * t`
radians, giving it a smooth circular orbit in the XZ plane. World position:
`x = R·cos(θ), z = -R·sin(θ)` (negative Z so the orbit goes the right way visually).

### View/Projection Matrices (Lines 255–258)

```js
mat4.perspective(proj, Math.PI / 4, W / H, 0.1, 8000.0);
mat4.lookAt(view, camPos, ctr, [0, 1, 0]);
mat4.multiply(vp, proj, view);
mat4.invert(invVP, vp);
```

**Perspective matrix** — FOV = 45° (`π/4`), aspect = canvas width/height,
near = 0.1, far = 8000. The generous far plane keeps distant geometry within
the frustum; near = 0.1 for the Enceladus close-up view. The sun is drawn at
infinity in the skybox shader and doesn't need the far plane.

**`mat4.lookAt(view, eye, center, up)`** — constructs a view matrix that
positions the camera at `camPos`, looking at `ctr`, with `+Y` as up.

**`invVP`** — the inverse of the VP matrix. Passed to `SKYBOX_FS` to
reconstruct world-space rays from NDC fragment positions.

### Pass 1: 3D Scene (Lines 261–337)

**Skybox + sun** (lines 265–272) — depth test disabled, full-screen quad. Drawn first so
subsequent geometry overwrites it where it covers the skybox. `SKYBOX_FS` draws the
procedural sun disk + halo (given `u_SunDir` and `u_SunCol`), so there is no separate
sun draw call. Because the skybox writes no depth, planets drawn afterward correctly
paint over the sun where they overlap it.

**Planet rendering order** — each step sets its occluder(s) before drawing:

```
1. Saturn body    (opaque)      → writes depth; occluder slot 1 = Enceladus (line 322)
2. Enceladus      (opaque)      → writes depth; occluder slot 1 = Saturn body (line 328)
3. Saturn rings   (transparent) → reads depth, alpha blended;
                                   occluder slot 1 = Saturn body, slot 2 = Enceladus (lines 334–335)
```

At the end of step 3 (line 337):
```js
gl.depthMask(true); /* rings leave depthMask=false; restore so next frame's gl.clear works */
```
`gl.clear(gl.DEPTH_BUFFER_BIT)` at the start of the next frame requires
`depthMask(true)`. If forgotten, the depth buffer wouldn't clear and the next
frame's depth test would be wrong.

### Saturn Model Matrix (Lines 289–306)

```js
const satM = mat4.create();
mat4.rotateX (satM, satM, SAT_TILT);          // fixed axial tilt (tips pole from +Y toward +Z)
mat4.rotateZ (satM, satM, t * SAT_SPIN);      // spin about the tilted pole (local +Z)
mat4.scale   (satM, satM, [sS, sS, sS]);      // fit to world units
mat4.translate(satM, satM, [-sB.cx, -sB.cy, -sB.cz]); // centre at origin
```

**Transform order** — applied right-to-left (standard column-major OpenGL convention):
1. **Translate** — move geometric centre to origin
2. **Scale** — fit to world size
3. **RotateZ** — spin about local +Z (the model's pole axis). Spinning about Z never
   moves the +Z axis, so the ring disc normal (local +Z) is unaffected — the rings
   hold their tilt while the surface bands underneath spin.
4. **RotateX** — apply Saturn's axial tilt once (a fixed lean). This tips the pole
   away from world +Y.

**Why `rotateX` for tilt instead of `rotateZ`?** In the GLB model, Saturn's pole is
local +Z. World +Y is "up." Leaning the pole away from vertical (the tilt) is
a rotation about X. Previously the code did `rotateZ(26.7°)` (which rotated the whole
model including the ring disc) and `rotateY(t * spin)` (which swept the disc normal in
a circle, causing the ring shadow to tumble incorrectly). The current order is correct.

**Extracting the ring plane normal every frame (lines 299–306):**
```js
vec3.set(ringNormal, satM[8], satM[9], satM[10]);
vec3.normalize(ringNormal, ringNormal);
gl.uniform3fv(U.u_RingNormal, ringNormal);
gl.uniform3fv(U.u_RingCenter, [0, 0, 0]);
gl.uniform1f (U.u_RingInner,  ringInner);
gl.uniform1f (U.u_RingOuter,  ringOuter);
gl.uniform1f (U.u_RingShadowStr, 0.9);
bindTex(gl, gl.TEXTURE3, gl.TEXTURE_2D, ringAlphaTex, U.u_RingAlphaTex, 3);
```

`satM[8], satM[9], satM[10]` is the **third column** of the 4×4 model matrix in
column-major layout — this is exactly the world-space direction of local +Z after all
rotations have been applied. Because the ring disc lies in local XY (normal = local +Z),
this column gives the true ring plane normal in world space. It is recalculated every
frame (though `SAT_TILT` is fixed, so the direction is actually constant; the code
correctly handles the general case).

These uniforms are uploaded *before* drawing Saturn's body and Enceladus, so the
ring shadow is active during both those draw calls. The `ringAlphaTex` is bound to
texture unit 3 (slots 0=diffuse, 1=cubemap, 2=specular are already occupied).

### Enceladus Model Matrix (Lines 308–314)

```js
const encM = mat4.create();
mat4.rotateY (encM, encM, t * 0.70);          // orbital motion (matches encWorld angle)
mat4.rotateX (encM, encM, 0.09);              // slight orbital inclination
mat4.translate(encM, encM, [ENC_ORBIT_R, 0, 0]); // move to orbit radius
mat4.rotateY (encM, encM, t * 2.2);           // self-rotation
mat4.scale   (encM, encM, [eS, eS, eS]);      // scale to world size
mat4.translate(encM, encM, [-eB.cx, -eB.cy, -eB.cz]); // centre
```

**Two `rotateY` operations — orbital + self-rotation:**
- Inner `rotateY(t * 2.2)` — self-rotation (fast)
- `translate([ENC_ORBIT_R, 0, 0])` — offset to orbit radius
- Outer `rotateY(t * 0.70)` — orbits the whole thing around the origin

`encWorld` (the JS-side orbit position) uses the same angle `t * 0.70` and
the same radius (line 244), so it exactly matches where the matrix places Enceladus.
`encWorld` is fed as the occluder centre both when shading the Saturn body
(Enceladus eclipsing Saturn) and as the rings' *second* occluder (Enceladus
casting its small shadow onto the rings).

### Pass 2: Bright Extraction (Lines 339–345)

```js
gl.bindFramebuffer(gl.FRAMEBUFFER, bloomA.fbo);
gl.useProgram(brightProg);
bindTex(gl, gl.TEXTURE0, gl.TEXTURE_2D, sceneRT.tex, BrightU.u_Img, 0);
gl.uniform1f(BrightU.u_Threshold, 0.62);
gl.bindVertexArray(quadVAO); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
```

Renders to `bloomA`. Source: `sceneRT.tex` (the 3D scene). Keeps only pixels
brighter than 0.62.

### Pass 3: Gaussian Blur (Lines 347–358)

```js
gl.useProgram(blurProg);
gl.uniform2f(BlurU.u_Texel, 1 / W, 1 / H);
let readTex = bloomA.tex;
for (let i = 0; i < 6; i++) {
  const horiz = (i % 2) === 0, writeRT = horiz ? bloomB : bloomA;
  gl.bindFramebuffer(gl.FRAMEBUFFER, writeRT.fbo);
  bindTex(gl, gl.TEXTURE0, gl.TEXTURE_2D, readTex, BlurU.u_Img, 0);
  gl.uniform2f(BlurU.u_Dir, horiz ? 1 : 0, horiz ? 0 : 1);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  readTex = writeRT.tex;
}
```

**Ping-pong blur:**
- i=0: read `bloomA`, write `bloomB` (horizontal)
- i=1: read `bloomB`, write `bloomA` (vertical)
- i=2: read `bloomA`, write `bloomB` (horizontal)
- ...

6 passes (3 horizontal + 3 vertical). `u_Texel = (1/W, 1/H)` gives the
size of one pixel in UV space, so the blur shader can step one pixel at a time.

After the loop, `readTex` points to whichever buffer was last written.

### Pass 4: Composite (Lines 360–367)

```js
gl.bindFramebuffer(gl.FRAMEBUFFER, null);   // render to screen
gl.useProgram(compProg);
bindTex(gl, gl.TEXTURE0, gl.TEXTURE_2D, sceneRT.tex, CompU.u_Scene, 0);
bindTex(gl, gl.TEXTURE1, gl.TEXTURE_2D, readTex,     CompU.u_Bloom, 1);
gl.uniform1f(CompU.u_Strength, 1.05);
gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
```

`gl.bindFramebuffer(gl.FRAMEBUFFER, null)` — binds the *default framebuffer*
(the canvas). Now rendering goes to the screen.

Samples `sceneRT.tex` (sharp 3D scene) and `readTex` (blurred bloom).
Adds them: `scene + bloom * 1.05`. The result appears on screen.

### Animation Loop (Line 369)

```js
requestAnimationFrame(frame);
```

`requestAnimationFrame` schedules `frame` to be called before the browser's
next repaint (~16ms at 60fps). This is the correct way to animate WebGL —
it syncs to the display refresh rate, pauses when the tab is backgrounded,
and gives the browser time to composite the canvas onto the page.

---

## Key Concepts Summary for Viva

| Concept | Why |
|---|---|
| DPR-aware canvas sizing | Physical pixel rendering on HiDPI screens |
| `Promise.all` parallel loading | Network requests in parallel |
| Mesh name filter for rings | Separate opaque/transparent geometry |
| Pre-split body/ring arrays | Guarantee correct draw order every frame |
| Spherical coordinate camera | Arcball orbit: `sin/cos(yaw) * cos(pitch)` |
| Lazy render target resize | Recreate FBOs only when canvas size changes |
| Transform matrix order (right-to-left) | translate → scale → rotateZ(spin) → rotateX(tilt) |
| `rotateX(SAT_TILT)` for tilt, `rotateZ` for spin | Spin about local +Z leaves ring disc normal unchanged |
| Ring annulus radii from mesh vertices | Automatically match the exported GLB; no hardcoding |
| `satM[8,9,10]` = local +Z in world space | 3rd column of column-major model matrix = transformed +Z axis |
| Ring shadow uniforms uploaded before body draw | Saturn body and Enceladus both receive ring shadow |
| `u_RingAlphaTex` bound to TEXTURE3 (slot 3) | Slots 0/1/2 occupied by diffuse, cubemap, specular |
| `u_RingAlphaTex` radial opacity strip | Shadow replicates real ring density (Cassini division, etc.) |
| `u_RingShadowOn = 0` for ring meshes | Prevents rings from casting shadow on themselves |
| Draw order: body → Enceladus → rings | Correct depth sorting, avoid depthMask artifacts |
| `depthMask(true)` restore after rings | Rings leave it false; must restore for next frame clear |
| Ping-pong Gaussian blur (6 passes) | 3 horizontal + 3 vertical for wide, soft glow |
| `bindFramebuffer(null)` | Restore default framebuffer (canvas) for final output |
| `requestAnimationFrame` | Sync to display refresh, pause when hidden |
