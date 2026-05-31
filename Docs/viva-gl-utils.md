# `src/gl-utils.js` — Deep-Dive Viva Guide

> All raw WebGL 2.0 boilerplate: compiling shaders, linking programs,
> uploading vertex data, creating textures, managing framebuffers,
> and issuing draw calls. Every function here wraps a block of the
> WebGL state machine into a reusable call.

---

## `mkShader(gl, type, src)` — Lines 3–10

```js
export function mkShader(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
    throw new Error('Shader compile:\n' + gl.getShaderInfoLog(s));
  return s;
}
```

**The compile pipeline:**

1. `gl.createShader(type)` — allocates a GPU-side shader object.
   `type` is `gl.VERTEX_SHADER` or `gl.FRAGMENT_SHADER`.
2. `gl.shaderSource(s, src)` — uploads the GLSL source string to the GPU driver.
3. `gl.compileShader(s)` — driver invokes its GLSL compiler. This is async on the
   GPU but synchronous from JS — the driver blocks until done.
4. `gl.getShaderParameter(s, gl.COMPILE_STATUS)` — returns `true`/`false`.
5. `gl.getShaderInfoLog(s)` — the compiler's error/warning text (like a C compiler
   stderr). Essential for debugging.

---

## `mkProg(gl, vs, fs)` — Lines 12–20

```js
export function mkProg(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, mkShader(gl, gl.VERTEX_SHADER,   vs));
  gl.attachShader(p, mkShader(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS))
    throw new Error('Program link:\n' + gl.getProgramInfoLog(p));
  return p;
}
```

**Linking** connects the compiled vertex and fragment shaders. The linker:
- Matches `out` variables of the VS to `in` variables of the FS.
- Resolves `uniform` locations.
- Validates that the pair forms a complete pipeline.

A program object is what you activate with `gl.useProgram(p)`. You can
compile many shaders but only one program is active at a time.

---

## `glBuf(gl, data, target)` — Lines 22–27

```js
export function glBuf(gl, data, target = gl.ARRAY_BUFFER) {
  const b = gl.createBuffer();
  gl.bindBuffer(target, b);
  gl.bufferData(target, data, gl.STATIC_DRAW);
  return b;
}
```

**GPU buffer targets:**
- `gl.ARRAY_BUFFER` — vertex attribute data (positions, normals, UVs)
- `gl.ELEMENT_ARRAY_BUFFER` — index data

**`gl.STATIC_DRAW`** — usage hint telling the GPU driver this data will not
change after upload. Allows the driver to place it in faster VRAM rather
than shared memory. (The other hints are `DYNAMIC_DRAW` for data updated
every frame, and `STREAM_DRAW` for single-use data.)

`gl.bufferData(target, data, usage)` — the `data` argument must be a
TypedArray or `ArrayBuffer`. The driver copies the bytes into GPU memory.
After this call the CPU-side `data` variable can be garbage-collected.

---

## `makeVAO(gl, prog, mesh)` — Lines 29–54

```js
export function makeVAO(gl, prog, mesh) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);

  for (const [name, data, size] of [
    ['a_Pos', mesh.pos, 3], ['a_Norm', mesh.norm, 3], ['a_UV', mesh.uv, 2]
  ]) {
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
```

### What a VAO is

A **Vertex Array Object (VAO)** records — not the data, but the *description*
of data: which buffer lives at which attribute location, how many components,
what type. Binding a VAO restores all those attribute pointers at once.

Without VAOs you'd call `gl.vertexAttribPointer` for every attribute before
every draw call. With a VAO you call it once at setup and restore it with
one `gl.bindVertexArray(vao)`.

### `gl.vertexAttribPointer(loc, size, type, normalized, stride, offset)`

- `loc` — the attribute location in the shader (e.g. `layout(location=0) in vec3 a_Pos`)
- `size` — number of components: 3 for vec3 (x,y,z), 2 for vec2 (u,v)
- `type` — `gl.FLOAT` (32-bit float), matching `Float32Array`
- `normalized` — `false`: raw float values, not integer-to-float normalisation
- `stride` — 0 means tightly packed (same as element size)
- `offset` — 0: start from beginning of buffer

### Index buffer path

When `mesh.idx` is present, the index buffer is bound to
`gl.ELEMENT_ARRAY_BUFFER` while the VAO is active. The VAO records this
binding, so `gl.drawElements` knows which buffer to pull indices from.

### Return value

The returned object `{ vao, drawCount, drawMode, idxType }` is what
`drawVAO` uses to dispatch the right draw call.

---

## `glTex2D(gl, image)` — Lines 56–68

```js
export function glTex2D(gl, image) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  const ext = gl.getExtension('EXT_texture_filter_anisotropic');
  if (ext) gl.texParameterf(gl.TEXTURE_2D, ext.TEXTURE_MAX_ANISOTROPY_EXT,
    Math.min(16, gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
  return t;
}
```

**`gl.texImage2D`** — uploads the decoded image to GPU memory. Passing an
`HTMLImageElement` directly lets the driver do format conversion internally.
Internal format `gl.RGBA`, source format `gl.RGBA`, type `gl.UNSIGNED_BYTE`:
4 bytes per pixel, one per channel.

**Mipmaps** — `gl.generateMipmap` automatically builds the mip chain:
half-resolution copies down to 1×1. Required for `LINEAR_MIPMAP_LINEAR`
(trilinear filtering). Without mipmaps, sampling a distant surface aliases
badly (shimmering at oblique angles).

**`LINEAR_MIPMAP_LINEAR`** — selects between two adjacent mip levels and
bilinearly interpolates within each. This is *trilinear filtering*.

**Anisotropic filtering (`EXT_texture_filter_anisotropic`)** — standard
trilinear filtering uses square sample footprints, causing blur when a
surface is viewed at a shallow angle (like Saturn's rings from the side).
Anisotropic filtering uses an elongated footprint aligned to the surface
slope, sharply preserving detail. `MAX_TEXTURE_MAX_ANISOTROPY_EXT` queries
the GPU's hardware limit (commonly 16×). The comment in the source says
exactly this: *"reduces mip-level shimmer on oblique surfaces (rings)"*.

---

## `glTexCubeFromImages(gl, images)` — Lines 70–87

```js
export function glTexCubeFromImages(gl, images) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_CUBE_MAP, t);
  const targets = [
    gl.TEXTURE_CUBE_MAP_POSITIVE_X, gl.TEXTURE_CUBE_MAP_NEGATIVE_X,
    gl.TEXTURE_CUBE_MAP_POSITIVE_Y, gl.TEXTURE_CUBE_MAP_NEGATIVE_Y,
    gl.TEXTURE_CUBE_MAP_POSITIVE_Z, gl.TEXTURE_CUBE_MAP_NEGATIVE_Z,
  ];
  targets.forEach((target, i) =>
    gl.texImage2D(target, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, images[i]));
  gl.generateMipmap(gl.TEXTURE_CUBE_MAP);
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
  return t;
}
```

A cubemap is a texture with 6 faces. The GPU samples it using a 3D direction
vector (`samplerCube` in GLSL → `texture(cubemap, dir)`).

**`CLAMP_TO_EDGE` on all three axes** — cubemaps have a third wrap axis R
(the depth axis for 3D coordinates). All three must be clamped so texels
at face seams don't bleed across edges, preventing the visible "cross" seam
artifact common in naive cubemap implementations.

Used for: the star skybox, and the environment map for reflections on planets.

---

## `mkRenderTarget(gl, w, h, withDepth)` — Lines 100–117

```js
export function mkRenderTarget(gl, w, h, withDepth) {
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
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
    throw new Error('Framebuffer incomplete');
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { fbo, tex, depth, w, h };
}
```

### What a Framebuffer Object (FBO) is

By default, WebGL renders to the canvas (the *default framebuffer*). An FBO
is an off-screen render target — rendering goes to a texture instead of the screen.

**Structure:**
```
FBO
├─ COLOR_ATTACHMENT0 → 2D texture (color pixels, readable later)
└─ DEPTH_ATTACHMENT  → Renderbuffer (depth values, not readable as texture)
```

**Texture vs Renderbuffer:** The colour attachment is a *texture* so it can be
sampled in subsequent shader passes (e.g. the bloom passes read the scene
texture). The depth attachment is a *renderbuffer* — depth values are never
sampled, just used for depth testing, so a renderbuffer is cheaper.

**`gl.DEPTH_COMPONENT24`** — 24 bits of depth precision, matching the
precision of a typical hardware depth buffer.

**`FRAMEBUFFER_COMPLETE`** — validation check. The FBO is "complete" when all
attachments have matching dimensions and compatible formats. Incomplete FBOs
silently produce black output, so throwing here catches setup errors early.

**`withDepth = false`** for bloom buffers — the bloom passes only do
full-screen quad operations; no 3D geometry is drawn, so depth testing
is not needed. This saves GPU memory.

### Helper: `mkColorTex(gl, w, h)` — Lines 89–98

```js
function mkColorTex(gl, w, h) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  ...
}
```

Passing `null` as the last argument to `gl.texImage2D` allocates GPU memory
for a `w × h` texture without uploading any pixel data. The texture starts
uninitialised — that's fine because the FBO will write it before it's read.

`gl.RGBA8` is the *sized internal format* (8 bits per channel, explicit).
`gl.RGBA` (unsized) is the *external format* (how the data is laid out in
memory). WebGL 2 requires both.

---

## `freeRenderTarget(gl, rt)` — Lines 119–124

```js
export function freeRenderTarget(gl, rt) {
  if (!rt) return;
  if (rt.depth) gl.deleteRenderbuffer(rt.depth);
  if (rt.tex)   gl.deleteTexture(rt.tex);
  if (rt.fbo)   gl.deleteFramebuffer(rt.fbo);
}
```

GPU resources are not garbage-collected by the JS GC — they live in the
driver's memory until explicitly deleted. Called in `ensureTargets` in
`saturn.js` when the canvas is resized, to release old-sized buffers before
allocating new ones.

---

## `cacheUniforms(gl, prog, keys)` — Lines 126–128

```js
export function cacheUniforms(gl, prog, keys) {
  return Object.fromEntries(keys.map(k => [k, gl.getUniformLocation(prog, k)]));
}
```

`gl.getUniformLocation(prog, name)` returns an opaque location object.
Calling it every frame would be slow (it's a driver lookup by string).
This function calls it once at startup for all uniform names and stores
the results in a plain object, so `U.u_MVP` is a pre-cached location.

---

## `bindTex(gl, unit, type, tex, loc, slot)` — Lines 130–134

```js
export function bindTex(gl, unit, type, tex, loc, slot) {
  gl.activeTexture(unit);
  gl.bindTexture(type, tex);
  gl.uniform1i(loc, slot);
}
```

WebGL has a fixed number of **texture units** (at least 8, often 16–32).
To use multiple textures in one draw call, each must be bound to a different unit.

- `gl.activeTexture(gl.TEXTURE0 + n)` — selects unit `n` as the active target.
- `gl.bindTexture(type, tex)` — binds `tex` to the currently active unit.
- `gl.uniform1i(loc, slot)` — tells the shader sampler uniform which unit
  to sample from (an integer 0–15, not the `gl.TEXTURE0` enum value).

`slot` (e.g. `0`) is the sampler integer; `unit` (e.g. `gl.TEXTURE0`) is
the GL constant (`gl.TEXTURE0 = 33984`, `gl.TEXTURE1 = 33985`, etc.).

---

## `drawVAO(gl, g)` — Lines 136–142

```js
export function drawVAO(gl, g) {
  gl.bindVertexArray(g.vao);
  if (g.drawMode === 'el')
    gl.drawElements(gl.TRIANGLES, g.drawCount, g.idxType, 0);
  else
    gl.drawArrays(gl.TRIANGLES, 0, g.drawCount);
}
```

**`gl.drawElements`** — uses the index buffer. Vertices are fetched
in the order specified by the indices, allowing index reuse.
Parameters: `(mode, count, type, offset)`.

**`gl.drawArrays`** — draws sequentially without indices.
Used when the mesh has no index buffer (non-indexed geometry).

Both use `gl.TRIANGLES` — every 3 indices/vertices form one triangle.

---

## Key Concepts Summary for Viva

| Concept | Function | Why |
|---|---|---|
| Shader compile → link pipeline | `mkShader`, `mkProg` | Two-stage GPU compilation; link resolves inter-shader interface |
| `gl.STATIC_DRAW` usage hint | `glBuf` | Driver placement optimisation |
| VAO records attribute layout | `makeVAO` | One bind restores all attribute pointers |
| `gl.vertexAttribPointer` params | `makeVAO` | loc, size, type, normalised, stride, offset |
| Mipmap + trilinear filtering | `glTex2D` | Avoids aliasing at distance |
| Anisotropic filtering extension | `glTex2D` | Sharpens oblique surfaces (rings) |
| Cubemap CLAMP_TO_EDGE | `glTexCubeFromImages` | Prevents seam bleeding on 3 axes |
| FBO = off-screen render target | `mkRenderTarget` | Required for multi-pass post-processing |
| Texture vs Renderbuffer | `mkRenderTarget` | Texture is readable; Renderbuffer is faster when not needed |
| Texture unit slots vs GL constants | `bindTex` | `slot` integer vs `gl.TEXTURE0` enum |
| `drawElements` vs `drawArrays` | `drawVAO` | Indexed vs non-indexed draw |
