/* WebGL 2.0 utility functions */

/* Compile a single GLSL shader stage.
   type: gl.VERTEX_SHADER or gl.FRAGMENT_SHADER
   src: GLSL source string ('#version 300 es' must be the first line) */
export function mkShader(gl, type, src) {
  const s = gl.createShader(type);   // allocate a shader object on the GPU
  gl.shaderSource(s, src);           // upload the GLSL source text
  gl.compileShader(s);               // compile GLSL → driver-internal IR
  /* gl.getShaderParameter(s, COMPILE_STATUS): returns true if compilation succeeded.
     On failure, gl.getShaderInfoLog(s) returns the GLSL compiler error message. */
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
    throw new Error('Shader compile:\n' + gl.getShaderInfoLog(s));
  return s;
}

/* Link a vertex + fragment shader pair into a GPU program.
   vs: GLSL vertex shader source string
   fs: GLSL fragment shader source string */
export function mkProg(gl, vs, fs) {
  const p = gl.createProgram();
  /* Attach both compiled shaders to the program object. */
  gl.attachShader(p, mkShader(gl, gl.VERTEX_SHADER,   vs));
  gl.attachShader(p, mkShader(gl, gl.FRAGMENT_SHADER, fs));
  /* linkProgram resolves attribute locations and uniform locations, and validates
     that the VS outputs match the FS inputs (varyings). */
  gl.linkProgram(p);
  /* gl.getProgramParameter(p, LINK_STATUS): true if linking succeeded.
     gl.getProgramInfoLog(p): linker error message on failure. */
  if (!gl.getProgramParameter(p, gl.LINK_STATUS))
    throw new Error('Program link:\n' + gl.getProgramInfoLog(p));
  return p;
}

/* Upload a typed array to a GPU buffer object.
   data: Float32Array (positions/normals/UVs) or Uint16Array/Uint32Array (indices)
   target: gl.ARRAY_BUFFER (vertex data) or gl.ELEMENT_ARRAY_BUFFER (index data) */
export function glBuf(gl, data, target = gl.ARRAY_BUFFER) {
  const b = gl.createBuffer();    // allocate a buffer object handle
  gl.bindBuffer(target, b);       // make this buffer the current target binding
  /* gl.bufferData(target, data, usage):
       target: which buffer slot to upload to
       data: the typed array to upload
       gl.STATIC_DRAW: hint that this data won't change after upload — driver can
       place it in fast GPU-side VRAM (vs. DYNAMIC_DRAW for frequently updated data) */
  gl.bufferData(target, data, gl.STATIC_DRAW);
  return b;
}

/* Build a Vertex Array Object (VAO) for a mesh, wiring up all vertex attributes
   to the shader's 'a_Pos', 'a_Norm', 'a_UV', 'a_UV2' attribute slots.
   prog: the compiled GPU program (used to look up attribute locations)
   mesh: { pos, norm, uv, uv2, idx, idxType } as returned by extractMeshes() */
export function makeVAO(gl, prog, mesh) {
  /* A VAO (Vertex Array Object) records all the vertex attribute pointer state
     (buffer bindings, attribute formats) so they can be restored with a single
     gl.bindVertexArray() call instead of re-issuing all the attrib calls. */
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);

  /* Wire up each attribute: [shader name, data array, components per vertex].
     If the data is null (e.g. mesh has no UV2) or the shader has no such attribute
     (loc < 0), skip it silently. */
  for (const [name, data, size] of [['a_Pos', mesh.pos, 3], ['a_Norm', mesh.norm, 3], ['a_UV', mesh.uv, 2], ['a_UV2', mesh.uv2, 2]]) {
    if (!data) continue;
    const loc = gl.getAttribLocation(prog, name);  // -1 if not used by this shader
    if (loc < 0) continue;
    gl.bindBuffer(gl.ARRAY_BUFFER, glBuf(gl, data));  // upload data + bind
    gl.enableVertexAttribArray(loc);  // enable feeding this attribute from a buffer
    /* gl.vertexAttribPointer(location, numComponents, dataType, normalise, stride, offset):
         location: shader attribute slot (from getAttribLocation)
         numComponents: floats per vertex element (3 for xyz/normal, 2 for uv)
         gl.FLOAT: each component is a 32-bit float
         false: do not normalise — data is already in the correct value range
         0: stride = 0 → tightly packed (consecutive elements, no gaps)
         0: offset = 0 → start reading from the very beginning of the buffer */
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
  }

  let drawCount, drawMode;
  if (mesh.idx) {
    /* Indexed draw: bind the index buffer to ELEMENT_ARRAY_BUFFER (recorded in the VAO).
       drawCount = number of indices; drawMode = 'el' signals gl.drawElements. */
    glBuf(gl, mesh.idx, gl.ELEMENT_ARRAY_BUFFER);
    drawCount = mesh.idx.length;
    drawMode  = 'el';
  } else {
    /* Non-indexed draw: drawCount = number of vertices.
       drawMode = 'arr' signals gl.drawArrays. */
    drawCount = mesh.pos.length / 3;  // pos is interleaved xyz so length/3 = vertex count
    drawMode  = 'arr';
  }

  gl.bindVertexArray(null);  // unbind so subsequent state changes don't corrupt this VAO
  return { vao, drawCount, drawMode, idxType: mesh.idxType };
}

/* Upload an HTMLImageElement to a 2D GPU texture with full mipmap chain
   and anisotropic filtering. */
export function glTex2D(gl, image) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);

  /* gl.texImage2D(target, mipLevel, internalFormat, format, dataType, source):
       target: gl.TEXTURE_2D — a flat 2D texture
       mipLevel=0: upload to the base (full-resolution) mip level
       internalFormat=gl.RGBA: how the GPU stores the texel data (4 channels, 8-bit each)
       format=gl.RGBA: layout of the source pixel data (same as internal)
       gl.UNSIGNED_BYTE: each channel is an 8-bit value (0–255)
       image: HTMLImageElement — the GPU reads pixels directly from it */
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);

  /* generateMipmap: auto-generates the full mip chain (½, ¼, ⅛, … resolution).
     Required for LINEAR_MIPMAP_LINEAR filtering; without it, the texture appears
     black when it's minified (sampled at smaller than base-level size). */
  gl.generateMipmap(gl.TEXTURE_2D);

  /* TEXTURE_MIN_FILTER: how to sample when the texture is smaller on screen than in memory.
     LINEAR_MIPMAP_LINEAR = trilinear filtering: bilinearly sample from two adjacent
     mip levels, then linearly blend between them. Eliminates "popping" when the
     camera moves and the mip level would otherwise switch abruptly. */
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);

  /* TEXTURE_MAG_FILTER: how to sample when the texture is larger on screen.
     LINEAR = bilinear interpolation between the 4 nearest texels.
     Mipmaps don't apply when magnifying — only the base level is used. */
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

  /* Anisotropic filtering: reduces the mipmap "shimmer" that appears when a texture
     is viewed at a steep angle (e.g. the rings seen from a shallow angle).
     Standard bilinear/trilinear picks the mip level based on the worst-case axis;
     anisotropic filtering uses more samples along the stretch axis.
     EXT_texture_filter_anisotropic: optional WebGL extension — check before using.
     TEXTURE_MAX_ANISOTROPY_EXT: number of aniso samples; capped at the HW maximum
     (typically 16) and at our own cap of 16. */
  const ext = gl.getExtension('EXT_texture_filter_anisotropic');
  if (ext) gl.texParameterf(gl.TEXTURE_2D, ext.TEXTURE_MAX_ANISOTROPY_EXT,
    Math.min(16, gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
  return t;
}

/* Upload 6 face images into a cubemap texture (used for the star-field skybox and
   for environment mapping). images must be in [+X, -X, +Y, -Y, +Z, -Z] order. */
export function glTexCubeFromImages(gl, images) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_CUBE_MAP, t);
  const targets = [
    gl.TEXTURE_CUBE_MAP_POSITIVE_X, gl.TEXTURE_CUBE_MAP_NEGATIVE_X,
    gl.TEXTURE_CUBE_MAP_POSITIVE_Y, gl.TEXTURE_CUBE_MAP_NEGATIVE_Y,
    gl.TEXTURE_CUBE_MAP_POSITIVE_Z, gl.TEXTURE_CUBE_MAP_NEGATIVE_Z,
  ];
  /* Upload each face individually — same texImage2D call as glTex2D but with a
     per-face target instead of TEXTURE_2D. */
  targets.forEach((target, i) =>
    gl.texImage2D(target, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, images[i]));
  gl.generateMipmap(gl.TEXTURE_CUBE_MAP);
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  /* CLAMP_TO_EDGE on all three axes (S=U, T=V, R=W for cubemaps):
     prevents seam artefacts at face boundaries where texels from adjacent faces
     would otherwise be averaged with the opposite-edge texel. */
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
  return t;
}

/* Internal helper: allocate a plain RGBA8 colour texture for use as a render-target
   attachment. No mips (render targets are always sampled at base level).
   CLAMP_TO_EDGE prevents the post-processing blur from reading off-screen at edges. */
function mkColorTex(gl, w, h) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  /* texImage2D with null data: allocate GPU memory of size w×h without initialising
     its contents. The internal format gl.RGBA8 is the sRGB-like 8-bit RGBA used for
     the default framebuffer — matching it keeps colour arithmetic consistent. */
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

/* Create a Framebuffer Object (FBO) — an off-screen render target.
   All gl.draw*() calls while this FBO is bound write to tex instead of the canvas.
   withDepth: if true, attach a 24-bit depth renderbuffer (needed for the 3D scene pass;
              not needed for the 2D post-processing blur passes). */
export function mkRenderTarget(gl, w, h, withDepth) {
  const tex = mkColorTex(gl, w, h);   // colour attachment
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  /* gl.framebufferTexture2D(target, attachment, texTarget, texture, mipLevel):
       COLOR_ATTACHMENT0: the first (and in our case only) colour output buffer.
       mipLevel=0: render into the base mip level of tex. */
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  let depth = null;
  if (withDepth) {
    depth = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    /* DEPTH_COMPONENT24: 24-bit depth precision — 16.7 million depth steps, sufficient
       for the Saturn scene's depth range of ~0.1 to ~8000 world units. */
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
    /* Attach the depth renderbuffer so depth testing works when rendering to this FBO. */
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
  }
  /* Verify the FBO is complete (all attachments have compatible sizes and formats).
     Throws if the driver rejected the configuration. */
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
    throw new Error('Framebuffer incomplete');
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);   // unbind — restore default framebuffer
  gl.bindRenderbuffer(gl.RENDERBUFFER, null);
  return { fbo, tex, depth, w, h };
}

/* Free all GPU resources belonging to a render target.
   Called when the canvas is resized so old-size textures don't accumulate. */
export function freeRenderTarget(gl, rt) {
  if (!rt) return;
  if (rt.depth) gl.deleteRenderbuffer(rt.depth);
  if (rt.tex)   gl.deleteTexture(rt.tex);
  if (rt.fbo)   gl.deleteFramebuffer(rt.fbo);
}

/* Pre-fetch and cache uniform locations for a program.
   gl.getUniformLocation is called at startup once per name — the returned
   WebGLUniformLocation objects are then used for all subsequent gl.uniform*() calls,
   avoiding per-frame string lookups in the driver.
   Returns an object: { 'u_MVP': location, 'u_M': location, ... } */
export function cacheUniforms(gl, prog, keys) {
  return Object.fromEntries(keys.map(k => [k, gl.getUniformLocation(prog, k)]));
}

/* Activate a texture unit, bind a texture to it, and set the corresponding sampler uniform.
   unit: gl.TEXTURE0, gl.TEXTURE1, etc. — which texture slot to use
   type: gl.TEXTURE_2D or gl.TEXTURE_CUBE_MAP
   tex: the WebGLTexture object to bind
   loc: the WebGLUniformLocation of the sampler uniform in the shader
   slot: the integer slot index (0, 1, 2, …) sent to the sampler uniform
   The shader's sampler reads from whichever texture unit its uniform integer points to. */
export function bindTex(gl, unit, type, tex, loc, slot) {
  gl.activeTexture(unit);    // select the texture unit: TEXTURE0+slot
  gl.bindTexture(type, tex); // bind tex to that unit's target
  gl.uniform1i(loc, slot);   // tell the shader sampler "read from unit slot"
}

/* Issue a draw call for a VAO produced by makeVAO().
   Chooses between indexed (drawElements) and non-indexed (drawArrays) based on
   which mode was recorded when the VAO was built.

   g: { vao, drawCount, drawMode, idxType } from makeVAO()
   gl.drawElements(mode, count, type, offset):
       mode: gl.TRIANGLES — every 3 indices form a triangle
       count: total number of indices to read
       type: gl.UNSIGNED_SHORT or gl.UNSIGNED_INT (index buffer data type)
       offset=0: start from the first index in the buffer
   gl.drawArrays(mode, first, count):
       mode: gl.TRIANGLES
       first=0: start from vertex 0
       count: total vertex count */
export function drawVAO(gl, g) {
  gl.bindVertexArray(g.vao);
  if (g.drawMode === 'el')
    gl.drawElements(gl.TRIANGLES, g.drawCount, g.idxType, 0);
  else
    gl.drawArrays(gl.TRIANGLES, 0, g.drawCount);
}
