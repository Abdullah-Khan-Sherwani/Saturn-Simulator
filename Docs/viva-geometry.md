# `src/geometry.js` — Deep-Dive Viva Guide

> Provides three utilities: async image loading, UV sphere generation,
> and AABB bounding-box computation. Pure JavaScript — no GPU calls.

---

## `loadImage(url)` — Lines 3–10

```js
export function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload  = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load image: ' + url));
    img.src = url;
  });
}
```

Wraps the browser's native image decoder in a Promise so it can be
`await`-ed. Setting `img.src` starts an HTTP GET; the browser fires
`onload` when the JPEG/PNG is fully decoded into an `HTMLImageElement`.

`saturn.js` calls this for the 8K Saturn and Sun textures:
```js
const [satBodyImg, sunImg] = await Promise.all([
  loadImage('/8k_saturn.jpg'), loadImage('/8k_sun.jpg'),
]);
```
`Promise.all` fires both requests simultaneously — no serial waiting.

---

## `loadCubemapFaces(basePath)` — Lines 12–15

```js
export async function loadCubemapFaces(basePath) {
  const faces = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];
  return Promise.all(faces.map(face => loadImage(`${basePath}/${face}.png`)));
}
```

A cubemap has six square faces. OpenGL's face naming convention:

| Suffix | Meaning | GL constant |
|---|---|---|
| `px` | Positive X (+X axis face) | `TEXTURE_CUBE_MAP_POSITIVE_X` |
| `nx` | Negative X | `TEXTURE_CUBE_MAP_NEGATIVE_X` |
| `py` | Positive Y (top) | `TEXTURE_CUBE_MAP_POSITIVE_Y` |
| `ny` | Negative Y (bottom) | `TEXTURE_CUBE_MAP_NEGATIVE_Y` |
| `pz` | Positive Z | `TEXTURE_CUBE_MAP_POSITIVE_Z` |
| `nz` | Negative Z | `TEXTURE_CUBE_MAP_NEGATIVE_Z` |

All six are loaded in parallel. The returned array order matches the order
`glTexCubeFromImages` in `gl-utils.js` uploads them using `targets[i]`.

---

## `makeUvSphere(radius, latBands, lonBands)` — Lines 17–48

This generates the procedural geometry for the **Sun** visual (a glowing sphere).
Called with `makeUvSphere(1.0, 24, 48)` — radius 1, 24 latitude bands,
48 longitude bands.

### Conceptual model

A UV sphere is parameterised by two angles:
- **θ (theta)** — polar angle, 0 at north pole to π at south pole (latitude)
- **φ (phi)** — azimuthal angle, 0 to 2π around the equator (longitude)

Each vertex sits at:
```
x = r · cos(φ) · sin(θ)
y = r · cos(θ)
z = r · sin(φ) · sin(θ)
```
The normal at any point on a unit sphere equals the position vector, so
`norm = (nx, ny, nz)` is computed from the same formula with `r = 1`.

### Vertex generation (lines 20–29)

```js
for (let y = 0; y <= latBands; y++) {
  const v = y / latBands, theta = v * Math.PI;
  const st = Math.sin(theta), ct = Math.cos(theta);
  for (let x = 0; x <= lonBands; x++) {
    const u = x / lonBands, phi = u * Math.PI * 2.0;
    const nx = Math.cos(phi) * st, ny = ct, nz = Math.sin(phi) * st;
    norm.push(nx, ny, nz);
    pos.push(radius * nx, radius * ny, radius * nz);
    uv.push(1.0 - u, v);
  }
}
```

**Why `<= latBands`?** We need `latBands + 1` rings of vertices (including
both poles) to form `latBands` rows of quads. Same logic for longitude:
`lonBands + 1` columns to form `lonBands` columns of quads. The first and
last longitude column share the same spatial position (the seam) but have
different UV coordinates (u=0 and u=1) so textures wrap correctly.

**`uv.push(1.0 - u, v)`** — u is flipped (`1 - u`) so the texture isn't
mirrored. This is a standard convention: without flipping, the texture would
appear east-west reversed because the parameterisation wraps in the opposite
direction to most image coordinate systems.

### Index generation (lines 32–37)

```js
const stride = lonBands + 1;
for (let y = 0; y < latBands; y++)
  for (let x = 0; x < lonBands; x++) {
    const i0 = y * stride + x, i1 = i0 + 1, i2 = i0 + stride, i3 = i2 + 1;
    idx.push(i0, i2, i1, i1, i2, i3);
  }
```

Each quad (i0, i1, i2, i3) is split into two triangles:
```
i0 --- i1
|  \   |
|   \  |
i2 --- i3
```
Triangle 1: `i0, i2, i1` (counter-clockwise = front-facing in OpenGL default)
Triangle 2: `i1, i2, i3`

`stride = lonBands + 1` because there are `lonBands + 1` vertices per latitude ring.

### Index type selection (lines 39–41)

```js
const big = pos.length / 3 > 65535;
return {
  idx:     big ? new Uint32Array(idx) : new Uint16Array(idx),
  idxType: big ? WebGL2RenderingContext.UNSIGNED_INT : WebGL2RenderingContext.UNSIGNED_SHORT,
```

`Uint16Array` max index = 65535. A 24×48 sphere has (25 × 49) = 1225 vertices,
well below the limit, so `Uint16Array` is used. The branch exists for safety
if the function is called with very high tessellation.

---

## `boundsOf(pos)` — Lines 50–65

```js
export function boundsOf(pos) {
  let mnX = Infinity, mxX = -Infinity;
  ...
  for (let i = 0; i < pos.length; i += 3) {
    mnX = Math.min(mnX, pos[i]);   mxX = Math.max(mxX, pos[i]);
    mnY = Math.min(mnY, pos[i+1]); mxY = Math.max(mxY, pos[i+1]);
    mnZ = Math.min(mnZ, pos[i+2]); mxZ = Math.max(mxZ, pos[i+2]);
  }
  return {
    cx: (mnX + mxX) * .5,
    cy: (mnY + mxY) * .5,
    cz: (mnZ + mxZ) * .5,
    r:  Math.max(mxX - mnX, mxY - mnY, mxZ - mnZ) * .5,
  };
}
```

Computes an **axis-aligned bounding box (AABB)** by scanning all vertices.
Returns the centroid `(cx, cy, cz)` and a scalar `r` = half the longest
axis extent.

`saturn.js` uses this for two purposes:

**1. Auto-scaling to world units:**
```js
const sS = 3.2  / sB.r;   // Saturn: fit into radius 3.2 world units
const eS = 0.42 / eB.r;   // Enceladus: fit into radius 0.42 world units
```
The GLB models come in arbitrary artist units. Dividing the desired world
radius by `sB.r` gives a scale factor that makes Saturn exactly 3.2 units
in its longest dimension.

**2. Centring the model at the origin:**
```js
mat4.translate(satM, satM, [-sB.cx, -sB.cy, -sB.cz]);
```
GLB models are often not centred at (0,0,0). Translating by negative centroid
before scaling places the model's geometric centre at the world origin, so
all subsequent rotations spin it in place rather than orbiting off-axis.

**Why `r = max(dx, dy, dz) * 0.5`?** This is the circumscribed-sphere radius
for the bounding box. Using the longest axis ensures the scale factor is
conservative — the model always fits within the target radius regardless
of which axis is longest.

---

## Key Concepts Summary for Viva

| Concept | Where | Why |
|---|---|---|
| Promise wrapping async I/O | `loadImage` | Browser image decode is event-driven; Promise = await-able |
| Cubemap face naming convention | `loadCubemapFaces` | px/nx/py/ny/pz/nz → 6 GL targets |
| UV sphere parameterisation | `makeUvSphere` | θ/φ angles, sin/cos mapping to XYZ |
| Normal = position on unit sphere | vertex gen loop | Sphere normals are trivially the normalised position |
| UV seam duplication | `1.0 - u` flip | Texture wrapping requires extra column; flip prevents mirror |
| Triangle winding from quad | index gen | CCW winding for front-face culling |
| Uint16 vs Uint32 index buffer | type selection | 65535 vertex limit for 16-bit indices |
| AABB centroid + radius | `boundsOf` | Auto-scale and centre arbitrary GLB models |
