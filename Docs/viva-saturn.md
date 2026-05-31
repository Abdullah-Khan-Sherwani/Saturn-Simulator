# `src/saturn.js` — Deep-Dive Viva Guide

> The main entry point. Orchestrates everything: asset loading, GPU object
> creation, camera control, and the 4-pass render loop. ~330 lines.

---

## Module Imports (Lines 1–7)

```js
import { mat4, mat3, vec3 } from 'gl-matrix';
import { mkProg, makeVAO, glBuf, glTex2D, glTexCubeFromImages,
         mkRenderTarget, freeRenderTarget, drawVAO, cacheUniforms, bindTex } from './gl-utils.js';
import { loadImage, loadCubemapFaces, boundsOf } from './geometry.js';
import { loadGLTF, extractMeshes } from './gltf-loader.js';
import { SKYBOX_VS, SKYBOX_FS, ... } from './shaders.js';
```

> `makeUvSphere` (used to build the old sun sphere) and the `SUN_VS`/`SUN_FS`
> shaders are no longer imported — the sun is now drawn in `SKYBOX_FS`.

**`gl-matrix`** — a battle-tested JS math library for 4×4 matrices and 3D vectors.
All matrix operations (`mat4.perspective`, `mat4.lookAt`, `mat4.multiply`,
`mat4.rotateY`, `mat4.scale`, `mat4.translate`, `mat4.invert`) come from here.
`mat3.normalFromMat4` computes the normal matrix.

---

## Constants (Lines 9–13)

```js
const ENC_ORBIT_R = 15;                          // Enceladus orbit radius in world units
const SUN_COL     = new Float32Array([1.0, 0.97, 0.85]);  // warm white
const SUN_DIR_RAW = [-0.6, -0.2, -0.8];          // raw direction, normalised later
const isRing = m => /saturn2/.test(m.name);       // mesh name filter
```

`ENC_ORBIT_R = 15` world units — chosen so Enceladus is visually far enough
from Saturn to be distinct but close enough to be interesting in frame.

`isRing` — Saturn's GLB file names the ring mesh something containing `"saturn2"`.
This regex tests the mesh name to separate ring geometry (transparent, no depth write)
from the body (opaque, writes depth). This distinction drives the entire render-order
architecture.

---

## `main()` — Startup Sequence

### WebGL2 Context (Lines 18–20)

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

### DPR-aware Canvas Resize (Lines 21–26)

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

### Parallel Asset Loading (Lines 35–38)

```js
const [satGLTF, encGLTF] = await Promise.all([
  loadGLTF('/saturn.glb',    e => { ... }),
  loadGLTF('/enceladus.glb', e => { ... }),
]);
```

`Promise.all` fires both XHR requests simultaneously. The total load time
is `max(sat_time, enc_time)` instead of `sat_time + enc_time`.
The progress callbacks update the loading message live.

### Mesh Filtering (Lines 42–45)

```js
const satMeshes = extractMeshes(satGLTF).filter(m => !/(mimas|enceladus)/.test(m.name));
```

The Saturn GLB was downloaded from an online source and includes Mimas and
Enceladus as child objects — at wrong scale and position for this scene.
The regex filter strips them out, keeping only Saturn body and rings.

---

## Program Compilation (Lines 49–53)

```js
const skyProg    = mkProg(gl, SKYBOX_VS,  SKYBOX_FS);
const planetProg = mkProg(gl, PLANET_VS,  PLANET_FS);
const brightProg = mkProg(gl, POST_VS,    BRIGHT_FS);
const blurProg   = mkProg(gl, POST_VS,    BLUR_FS);
const compProg   = mkProg(gl, POST_VS,    COMPOSITE_FS);
```

Five programs. Note `POST_VS` is reused by `brightProg`, `blurProg`, and `compProg` —
all post-processing passes use the same full-screen quad vertex shader. (There is
no longer a separate sun program; the sun is part of `skyProg`'s `SKYBOX_FS`.)

---

## Full-Screen Quad VAO (Lines 56–63)

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

## Texture Upload (Lines 66–76)

```js
const satBodyImg = await loadImage('/8k_saturn.jpg');
const satBodyTex = glTex2D(gl, satBodyImg);

const satGPU     = satMeshes.map(m => makeVAO(gl, planetProg, m));
const satTex     = satMeshes.map(m =>
  isRing(m) ? (m.image ? glTex2D(gl, m.image) : null) : satBodyTex
);
```

Only the Saturn body texture (`8k_saturn.jpg`) is loaded here now — the sun is
procedural so `8k_sun.jpg` is no longer fetched. Ring meshes use their own
embedded GLB texture (`m.image`); body meshes all share the single `satBodyTex`
(the 8K Saturn photo). This is a texture atlas strategy: one 8K image for all
non-ring geometry.

---

## Opaque/Transparent Pre-split (Lines 81–87)

```js
const satBodyIdx  = satMeshes.map((_, i) => i).filter(i => !isRing(satMeshes[i]));
const satRingIdx  = satMeshes.map((_, i) => i).filter(i =>  isRing(satMeshes[i]));
const satBodyGPU   = satBodyIdx.map(i => satGPU[i]);
const satRingGPU   = satRingIdx.map(i => satGPU[i]);
// etc.
```

At startup, Saturn's meshes are split into body-only and ring-only lists.
The comment explains why:

> *"draw all opaques before any transparent rings, keeping Enceladus correctly
>  depth-sorted against the rings regardless of camera angle."*

This is the **depth-sorting / painter's algorithm** concern for alpha-blended
geometry. If rings were drawn before Enceladus:
- Rings write colour but not depth (depthMask=false)
- Enceladus drawn after would appear in front of rings even when behind them

By drawing Enceladus (opaque → depth written) before rings (transparent →
reads depth but doesn't write), the GPU's depth test naturally handles occlusion.

---

## Uniform Location Cache (Lines 89–95)

```js
const U = cacheUniforms(gl, planetProg, [
  'u_MVP','u_M','u_N','u_LDir','u_LCol','u_Base','u_Cam',
  'u_Shin','u_SpecK','u_Alpha','u_TexOn','u_Tex','u_AlphaCutoff',
  'u_SpecTexOn','u_SpecTex','u_UVRepeat','u_UVOffset',
  'u_EnvMap','u_EnvStr','u_FogDensity','u_FogColor','u_OccluderCenter','u_OccluderR',
  'u_Occluder2Center','u_Occluder2R',
]);
```

24 uniforms for the planet shader cached at startup (the last two are the second
shadow-occluder slot, used so the rings can be eclipsed by Saturn's body **and**
Enceladus at once). Every frame that calls `gl.uniform*()` uses these pre-fetched
locations — no string lookups per frame.

---

## Scene Constants (Lines 102–111)

```js
const spaceCubemap = glTexCubeFromImages(gl, await loadCubemapFaces('/cubemap_starmap_2020_1024'));

const satBodyMesh = satMeshes.find(m => !isRing(m)) ?? satMeshes[0];
const eB = boundsOf(encMeshes[0].pos);
const sB = boundsOf(satBodyMesh.pos);
const sS = 3.2  / sB.r;    // Saturn scale factor
const eS = 0.42 / eB.r;    // Enceladus scale factor
const satBodyRadius = sS * sB.r;  // = 3.2 world units
```

`satBodyRadius = sS * sB.r = sS * (sB.r)`. Since `sS = 3.2 / sB.r`:
`satBodyRadius = (3.2 / sB.r) * sB.r = 3.2`. It's always exactly 3.2.
This is used as the occluder radius for the analytical shadow test.

```js
const SUN_DIR = vec3.normalize(vec3.create(), SUN_DIR_RAW);
```

The sun direction `SUN_DIR` is used both by the lighting shader (the sun is a
directional light — infinitely far, so only direction matters for shading) and
now by `SKYBOX_FS`, which draws the procedural sun disk/halo in that direction.
There is no longer a sun-sphere GPU object or a `SUN_POS` world position.

---

## Camera System (Lines 114–143)

### View Mode Toggle (Lines 114–121)

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

### Arcball Orbit (Lines 124–142)

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

Camera position in the render loop:
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

### Scroll Zoom (Lines 139–143)

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

## Render Targets: Lazy Resize (Lines 147–156)

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

## `renderGroup()` — Lines 159–204

```js
function renderGroup(gpuList, meshList, texList, specTexList, modelMat, envStrength) {
  gl.uniformMatrix4fv(U.u_MVP, false, mat4.multiply(mat4.create(), vp, modelMat));
  gl.uniformMatrix4fv(U.u_M,   false, modelMat);
  gl.uniformMatrix3fv(U.u_N,   false, mat3.normalFromMat4(mat3.create(), modelMat));
  ...
```

Sets the three transform matrices for an entire body (Saturn, Enceladus).
Then iterates all meshes in the group, setting per-mesh uniforms and drawing.

### Ring vs Body Render State (Lines 172–180)

```glsl
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

### Draw Order Within `renderGroup` (Lines 200–203)

```js
gpuList.forEach((g, i) => { if (!isRing(meshList[i])) drawMesh(..., false); });
gpuList.forEach((g, i) => { if ( isRing(meshList[i])) drawMesh(..., true);  });
```

Body meshes are drawn first (write depth), then ring meshes (read depth only).
Two passes over the same array, filtering by type. This ensures that the
planet body's depth values are in the buffer when rings are drawn, so rings
behind the planet body are correctly occluded.

---

## Render Loop — `frame()` — Lines 208–326

### Time and Orbits (Lines 209–216)

```js
t += 0.004;
const encAngle = t * 0.70;
const encWorld = [ENC_ORBIT_R * Math.cos(encAngle), 0, -ENC_ORBIT_R * Math.sin(encAngle)];
```

`t` is a frame counter (not wall-clock time). Enceladus orbits at `0.70 * t`
radians, giving it a smooth circular orbit in the XZ plane. World position:
`x = R·cos(θ), z = -R·sin(θ)` (negative Z so the orbit goes the right way visually).

### View/Projection Matrices (Lines 226–229)

```js
mat4.perspective(proj, Math.PI / 4, W / H, 0.1, 8000.0);
mat4.lookAt(view, camPos, ctr, [0, 1, 0]);
mat4.multiply(vp, proj, view);
mat4.invert(invVP, vp);
```

**Perspective matrix** — FOV = 45° (`π/4`), aspect = canvas width/height,
near = 0.1, far = 8000. The generous far plane keeps distant geometry within
the frustum; near = 0.1 for the Enceladus close-up view. (The sun no longer
needs the far plane — it is drawn at infinity in the skybox shader.)

**`mat4.lookAt(view, eye, center, up)`** — constructs a view matrix that
positions the camera at `camPos`, looking at `ctr`, with `+Y` as up.

**`invVP`** — the inverse of the VP matrix. Passed to `SKYBOX_FS` to
reconstruct world-space rays from NDC fragment positions.

### Pass 1: 3D Scene (Lines 231–290)

**Skybox + sun** — depth test disabled, full-screen quad. Drawn first so
subsequent geometry overwrites it where it covers the skybox. `SKYBOX_FS` now
also draws the procedural sun disk + halo (given `u_SunDir` and `u_SunCol`),
so there is no separate sun draw call. Because the skybox writes no depth, the
planets and rings drawn afterward correctly paint over the sun where they
overlap it.

**Planet rendering order** (each line sets its shadow occluder(s) before drawing):

```
1. Saturn body    (opaque)      → writes depth; occluder = Enceladus
2. Enceladus      (opaque)      → writes depth (occluded by Saturn body depth); occluder = Saturn body
3. Saturn rings   (transparent) → reads depth (occluded by 1 & 2), alpha blended;
                                   occluders = Saturn body (slot 1) + Enceladus (slot 2)
```

At step 3:
```js
gl.depthMask(true); /* rings leave depthMask=false; restore so next frame's gl.clear works */
```
Important: `gl.clear(gl.DEPTH_BUFFER_BIT)` at the start of the next frame
requires `depthMask(true)`. If forgotten, the depth buffer wouldn't clear
and the next frame's depth test would be wrong.

### Saturn Model Matrix (Lines 255–259)

```js
const satM = mat4.create();
mat4.rotateZ (satM, satM, 26.7 * Math.PI / 180);  // axial tilt
mat4.rotateY (satM, satM, t * 0.15);               // self-rotation
mat4.scale   (satM, satM, [sS, sS, sS]);           // fit to world units
mat4.translate(satM, satM, [-sB.cx, -sB.cy, -sB.cz]); // centre at origin
```

**Transform order matters.** Matrix multiplications are applied in reverse
order relative to the code (right-to-left multiplication):
1. **Translate** — move geometric centre to origin
2. **Scale** — fit to world size
3. **RotateY** — animate self-rotation (slow, realistic)
4. **RotateZ** — apply Saturn's 26.7° axial tilt

`26.7°` is Saturn's real axial tilt (compared to Earth's 23.5°).

### Enceladus Model Matrix (Lines 261–267)

```js
const encM = mat4.create();
mat4.rotateY (encM, encM, t * 0.70);          // orbital motion (matches encWorld)
mat4.rotateX (encM, encM, 0.09);              // slight orbital inclination
mat4.translate(encM, encM, [ENC_ORBIT_R, 0, 0]); // move to orbit radius
mat4.rotateY (encM, encM, t * 2.2);           // tidal locking self-spin
mat4.scale   (encM, encM, [eS, eS, eS]);      // scale to world size
mat4.translate(encM, encM, [-eB.cx, -eB.cy, -eB.cz]); // centre
```

**Two `rotateY` operations — orbital + tidal lock:**
- Inner `rotateY(t * 2.2)` — self-rotation (fast)
- `translate([ENC_ORBIT_R, 0, 0])` — offset to orbit radius
- Outer `rotateY(t * 0.70)` — orbits the whole thing around the origin

This creates tidal locking: Enceladus spins at `2.2/0.70 ≈ 3.1×` the orbital
rate, so it doesn't always face the same side toward Saturn (simplified model;
real tidal locking would have the same rate, but this is aesthetically better).

`encWorld` (the JS-side orbit position) uses the same angle `t * 0.70` and
the same radius, so it exactly matches where the matrix places Enceladus.
`encWorld` is fed as the occluder centre both when shading the Saturn body
(Enceladus eclipsing Saturn) and as the rings' *second* occluder (Enceladus
casting its small shadow onto the rings).

### Pass 2: Bright Extraction (Lines 292–298)

```js
gl.bindFramebuffer(gl.FRAMEBUFFER, bloomA.fbo);
gl.useProgram(brightProg);
bindTex(gl, gl.TEXTURE0, gl.TEXTURE_2D, sceneRT.tex, BrightU.u_Img, 0);
gl.uniform1f(BrightU.u_Threshold, 0.62);
gl.bindVertexArray(quadVAO); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
```

Renders to `bloomA`. Source: `sceneRT.tex` (the 3D scene). Keeps only pixels
brighter than 0.62.

### Pass 3: Gaussian Blur (Lines 300–311)

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

### Pass 4: Composite (Lines 313–320)

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

### Animation Loop (Line 322)

```js
requestAnimationFrame(frame);
```

`requestAnimationFrame` schedules `frame` to be called before the browser's
next repaint (~16ms at 60fps). This is the correct way to animate WebGL —
it syncs to the display refresh rate, pauses when the tab is backgrounded,
and gives the browser time to composite the canvas onto the page.

---

## Key Concepts Summary for Viva

| Concept | Lines | Why |
|---|---|---|
| DPR-aware canvas sizing | 21–26 | Physical pixel rendering on HiDPI screens |
| `Promise.all` parallel loading | 35–38, 67–69 | Network requests in parallel |
| Mesh name filter for rings | 13, 42 | Separate opaque/transparent geometry |
| Pre-split body/ring arrays | 83–90 | Guarantee correct draw order every frame |
| Spherical coordinate camera | 226–230 | Arcball orbit: `sin/cos(yaw) * cos(pitch)` |
| Lazy render target resize | 155–162 | Recreate FBOs only when canvas size changes |
| Transform matrix order | 267–279 | Right-to-left: translate → scale → rotate |
| 26.7° axial tilt | 268 | Saturn's real-world axial tilt |
| Draw order: body → Enceladus → rings | 285–298 | Correct depth sorting, avoid depthMask artifacts |
| `depthMask(true)` restore | 299 | Rings leave it false; must restore for next frame clear |
| Ping-pong Gaussian blur | 309–320 | 6 passes alternating horizontal/vertical |
| `bindFramebuffer(null)` | 323 | Restore default framebuffer (canvas) for final output |
| `requestAnimationFrame` | 331 | Sync to display refresh, pause when hidden |
