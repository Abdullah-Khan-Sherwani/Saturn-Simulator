# `src/gltf-loader.js` — Deep-Dive Viva Guide

> Loads a `.glb` binary file from the network, parses the GLTF scene graph,
> decodes all typed-array accessors, extracts embedded textures, and returns
> a flat array of mesh objects that `saturn.js` feeds straight to the GPU.
> Zero Three.js. Zero external parser library.

---

## Big Picture

A `.glb` file is the **binary container** form of GLTF 2.0.
It packs three things into one file:

```
┌─────────────────────────────────────────────────────┐
│  12-byte GLB header  (magic, version, total length) │
├─────────────────────────────────────────────────────┤
│  Chunk 0: JSON  (type = 0x4E4F534A = "JSON")        │
│    ↳ scene graph, mesh definitions, materials,      │
│      accessor/bufferView layout                     │
├─────────────────────────────────────────────────────┤
│  Chunk 1: BIN   (type = 0x004E4942 = "BIN\0")       │
│    ↳ raw binary: vertex positions, normals, UVs,    │
│      indices, embedded images (JPEG/PNG bytes)      │
└─────────────────────────────────────────────────────┘
```

The loader's job is to peel apart those layers, decode each accessor
into a typed JavaScript array, and decode each embedded image into an
`HTMLImageElement` that `glTex2D()` in `gl-utils.js` can upload.

---

## Constant Tables (Lines 5–11)

```js
const TYPE_COMPS  = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const COMP_CTOR   = {
  5120: Int8Array,   5121: Uint8Array,
  5122: Int16Array,  5123: Uint16Array,
  5125: Uint32Array, 5126: Float32Array,
};
const COMP_BYTES  = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
```

**`TYPE_COMPS`** — GLTF accessor `type` strings map to how many scalar
components make up one element. `VEC3` = 3 floats per vertex position.

**`COMP_CTOR`** — GLTF `componentType` is a GL enum integer (e.g. `5126` = `GL_FLOAT`).
Maps to the correct TypedArray constructor so `new Ctor(buffer)` gives the
right numeric interpretation.

**`COMP_BYTES`** — How many bytes one scalar component occupies.
Used to compute stride and slice lengths exactly.

> **Why typed arrays matter for WebGL:** `gl.bufferData()` and
> `gl.vertexAttribPointer()` expect raw binary with a specific layout.
> If you give WebGL a regular JS `Array` you get a type error.
> TypedArrays are zero-copy views over an `ArrayBuffer` — the GPU
> can DMA them directly.

---

## `readAccessor(json, bin, idx)` — Lines 13–35

```js
function readAccessor(json, bin, idx) {
  const acc      = json.accessors[idx];
  const bv       = json.bufferViews[acc.bufferView];
  const nComp    = TYPE_COMPS[acc.type];
  const Ctor     = COMP_CTOR[acc.componentType];
  const cBytes   = COMP_BYTES[acc.componentType];
  const elemBytes = nComp * cBytes;
  const stride   = bv.byteStride ?? elemBytes;
  const bvOff    = bv.byteOffset ?? 0;
  const accOff   = acc.byteOffset ?? 0;
  ...
}
```

### GLTF Memory Model

```
BIN buffer (one big ArrayBuffer)
  └─ BufferView  [byteOffset, byteLength, byteStride?]
       └─ Accessor [byteOffset, count, type, componentType]
```

**`acc.bufferView`** — index into `json.bufferViews[]`. A BufferView is a
window (offset + length) into the BIN blob.

**`bv.byteStride`** — if non-zero, elements are interleaved. A 32-byte
interleaved vertex might have positions at offset 0, normals at offset 12,
UVs at offset 24 — all in the same BufferView. If `byteStride` is absent,
the data is tightly packed (stride == element size).

**`acc.byteOffset`** — additional offset *within* the BufferView. Allows
multiple accessors to share the same BufferView at different starting points.

### Fast path (tightly packed, lines 25–27)

```js
if (stride === elemBytes) {
  const start = bvOff + accOff;
  out.set(new Ctor(bin.slice(start, start + acc.count * elemBytes)));
}
```

`bin.slice(start, end)` returns a new `ArrayBuffer` covering just those bytes.
`new Ctor(thatBuffer)` reinterprets them as the right numeric type.
`out.set(...)` copies into the pre-allocated output array.

### Interleaved path (lines 29–33)

```js
for (let i = 0; i < acc.count; i++) {
  const start = bvOff + accOff + i * stride;
  out.set(new Ctor(bin.slice(start, start + elemBytes)), i * nComp);
}
```

Walks element-by-element, jumping by `stride` bytes each time, picking out
only the relevant component bytes and packing them contiguously into `out`.
This de-interleaves the data so each attribute becomes a plain float array.

---

## `loadEmbeddedImage(bin, json, imgIdx)` — Lines 37–48

```js
function loadEmbeddedImage(bin, json, imgIdx) {
  const def   = json.images[imgIdx];
  const bv    = json.bufferViews[def.bufferView];
  const slice = bin.slice(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength);
  const url   = URL.createObjectURL(new Blob([slice], { type: def.mimeType }));
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload  = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(...); };
    img.src = url;
  });
}
```

**Why `createObjectURL`?** The raw JPEG/PNG bytes are inside the BIN blob.
We can't pass raw bytes to `<img>`. We wrap them in a `Blob` (a browser-side
file), get a temporary `blob://` URL for it, set that as `img.src`, and the
browser's image decoder does the rest. `revokeObjectURL` cleans up the
in-memory URL once the image is decoded — prevents a memory leak.

**`def.mimeType`** — usually `"image/jpeg"` or `"image/png"`. Tells `Blob`
how to present the data so the image decoder picks the right codec.

---

## `extractMeshes({ json, bin, images })` — Lines 50–122

This is the scene-graph walker. GLTF scenes form a tree of **Nodes**, each
node optionally referencing a **Mesh**, each Mesh containing one or more
**Primitives** (a primitive = one draw call's worth of geometry + material).

### Scene graph traversal (lines 52–62)

```js
const sceneNodes = json.scenes?.[json.scene ?? 0]?.nodes ?? [];
const queue      = [...sceneNodes];
const visited    = new Set();
while (queue.length) {
  const nIdx = queue.pop();
  if (visited.has(nIdx)) continue;
  visited.add(nIdx);
  const node = json.nodes[nIdx];
  if (node.children) queue.push(...node.children);
  if (node.mesh == null) continue;
  ...
}
```

**Iterative DFS** (depth-first search) using a stack (`queue.pop()`).
`visited` prevents infinite loops if the GLTF has shared/instanced nodes.
Nodes without a `mesh` property (transform-only nodes) are skipped after
pushing their children.

> *Note:* This loader ignores node transforms (`node.matrix`,
> `node.translation`, `node.rotation`, `node.scale`). The Saturn and
> Enceladus GLBs are artist-exported so their geometry is already centred;
> `saturn.js` applies its own world transforms via `mat4` operations.

### Per-primitive extraction (lines 67–119)

```js
for (const prim of meshDef.primitives) {
  const attrs = prim.attributes;
  const pos  = Float32Array.from(readAccessor(json, bin, attrs.POSITION));
  const norm = attrs.NORMAL != null
    ? Float32Array.from(readAccessor(json, bin, attrs.NORMAL))
    : new Float32Array(pos.length);
  const uv   = attrs.TEXCOORD_0 != null
    ? Float32Array.from(readAccessor(json, bin, attrs.TEXCOORD_0))
    : null;
  ...
}
```

`prim.attributes` is a dictionary: `{ POSITION: 4, NORMAL: 5, TEXCOORD_0: 6 }`.
Values are accessor indices. `readAccessor` is called for each.

If a mesh has no normals (unusual but legal GLTF), a zero-filled array of the
same length is substituted — the shader will get N=(0,0,0) which is incorrect
but avoids a crash.

### Index buffer (lines 78–86)

```js
if (prim.indices != null) {
  const raw = readAccessor(json, bin, prim.indices);
  if (raw instanceof Uint32Array) {
    idx = raw; idxType = WebGL2RenderingContext.UNSIGNED_INT;
  } else {
    idx = Uint16Array.from(raw); idxType = WebGL2RenderingContext.UNSIGNED_SHORT;
  }
}
```

GLTF can use 8, 16, or 32-bit index buffers. WebGL 2 supports all three via
`gl.drawElements(mode, count, gl.UNSIGNED_SHORT/UNSIGNED_INT, 0)`.
The `idxType` is stored on the mesh so `drawVAO()` can pass the right constant.

### Material extraction (lines 88–113)

The loader handles **two** GLTF material models:

**KHR_materials_pbrSpecularGlossiness** (extension, used by the Saturn GLB):
- `diffuseFactor` → base color (RGBA)
- `diffuseTexture` → diffuse map (index into `json.textures`)
- `specularGlossinessTexture` → packed RGB=specular, A=glossiness

**pbrMetallicRoughness** (core GLTF 2.0):
- `baseColorFactor` → base color
- `baseColorTexture` → diffuse map

Both paths resolve texture indices through `json.textures[].source` (an image
index) into the pre-decoded `images[]` array, yielding an `HTMLImageElement`
stored on the mesh as `image` or `specImage`.

---

## `loadGLTF(url, onProgress)` — Lines 124–151

```js
export async function loadGLTF(url, onProgress) {
  const buf = await fetchBinary(url, onProgress);
  const dv  = new DataView(buf);

  if (dv.getUint32(0, true) !== 0x46546C67)   // "glTF" in little-endian ASCII
    throw new Error('Not a GLB file: ' + url);

  let json = null, bin = new ArrayBuffer(0);
  let offset = 12;   // skip 12-byte GLB header
  while (offset < buf.byteLength) {
    const chunkLen  = dv.getUint32(offset,     true);
    const chunkType = dv.getUint32(offset + 4, true);
    const chunkData = buf.slice(offset + 8, offset + 8 + chunkLen);
    offset += 8 + chunkLen;
    if (chunkType === 0x4E4F534A) json = JSON.parse(new TextDecoder().decode(chunkData));
    else if (chunkType === 0x004E4942) bin = chunkData;
  }
  ...
}
```

**Magic number check** — `0x46546C67` is the four bytes `g`, `l`, `T`, `F`
read as a little-endian 32-bit integer. Fails fast on corrupt files.

**Header layout:**
```
Offset 0:  uint32  magic   = 0x46546C67
Offset 4:  uint32  version = 2
Offset 8:  uint32  length  (total file size)
Offset 12: first chunk starts
```

**Chunk loop** — reads `chunkLen` then `chunkType` from each chunk header
(8 bytes), then slices `chunkLen` bytes of data. Advances `offset` by
`8 + chunkLen` to reach the next chunk. The spec guarantees chunk 0 is JSON,
chunk 1 (if present) is BIN, but the loop is written generically.

**`0x4E4F534A`** = ASCII bytes `J`, `S`, `O`, `N` (little-endian).
**`0x004E4942`** = ASCII bytes `B`, `I`, `N`, `\0`.

After parsing, embedded images are decoded in parallel via `Promise.all`,
then the whole `{ json, bin, images }` object is returned.

---

## `fetchBinary(url, onProgress)` — Lines 153–165

```js
function fetchBinary(url, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url);
    xhr.responseType = 'arraybuffer';
    if (onProgress) xhr.addEventListener('progress', onProgress);
    xhr.onload  = () => xhr.status < 400 ? resolve(xhr.response) : reject(...);
    xhr.onerror = () => reject(new Error('Network error: ' + url));
    xhr.send();
  });
}
```

Uses **XHR with `responseType = 'arraybuffer'`** rather than `fetch()`.
Why: XHR fires `progress` events with `e.loaded` and `e.total` bytes,
enabling the loading-bar display in `saturn.js`. `fetch()` requires wrapping
a `ReadableStream` to get the same effect, which is more verbose.

The resolved value is a raw `ArrayBuffer` — the exact binary content of the
file, no string conversion, no JSON parsing yet.

---

## Key Concepts Summary for Viva

| Concept | Where | Why |
|---|---|---|
| GLB binary container format | `loadGLTF` | Understand magic, chunk loop, chunk type IDs |
| GLTF accessor / bufferView indirection | `readAccessor` | How vertex data is addressed inside the BIN blob |
| Interleaved vs tightly-packed vertex data | `readAccessor` fast/slow path | stride handling |
| Typed arrays for GPU data | everywhere | `Float32Array`, `Uint16Array` — WebGL contract |
| `createObjectURL` for embedded images | `loadEmbeddedImage` | Decode JPEG/PNG bytes as HTMLImageElement |
| GLTF scene graph DFS | `extractMeshes` | Node → Mesh → Primitive hierarchy |
| KHR_materials_pbrSpecularGlossiness | material block | Extension vs core GLTF material models |
