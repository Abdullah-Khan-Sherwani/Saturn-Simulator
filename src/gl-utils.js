/* WebGL 2.0 utility functions */

export function mkShader(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
    throw new Error('Shader compile:\n' + gl.getShaderInfoLog(s));
  return s;
}

export function mkProg(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, mkShader(gl, gl.VERTEX_SHADER,   vs));
  gl.attachShader(p, mkShader(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS))
    throw new Error('Program link:\n' + gl.getProgramInfoLog(p));
  return p;
}

export function glBuf(gl, data, target = gl.ARRAY_BUFFER) {
  const b = gl.createBuffer();
  gl.bindBuffer(target, b);
  gl.bufferData(target, data, gl.STATIC_DRAW);
  return b;
}

export function makeVAO(gl, prog, mesh) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);

  for (const [name, data, size] of [['a_Pos', mesh.pos, 3], ['a_Norm', mesh.norm, 3], ['a_UV', mesh.uv, 2]]) {
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

export function glTex2D(gl, image) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  return t;
}

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
  gl.bindRenderbuffer(gl.RENDERBUFFER, null);
  return { fbo, tex, depth, w, h };
}

export function freeRenderTarget(gl, rt) {
  if (!rt) return;
  if (rt.depth) gl.deleteRenderbuffer(rt.depth);
  if (rt.tex)   gl.deleteTexture(rt.tex);
  if (rt.fbo)   gl.deleteFramebuffer(rt.fbo);
}

export function drawVAO(gl, g) {
  gl.bindVertexArray(g.vao);
  if (g.drawMode === 'el')
    gl.drawElements(gl.TRIANGLES, g.drawCount, g.idxType, 0);
  else
    gl.drawArrays(gl.TRIANGLES, 0, g.drawCount);
}
