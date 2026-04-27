/* Procedural geometry + image loading helpers */

export function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload  = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load image: ' + url));
    img.src = url;
  });
}

export async function loadCubemapFaces(basePath) {
  const faces = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];
  return Promise.all(faces.map(face => loadImage(`${basePath}/${face}.png`)));
}

export function makeUvSphere(radius = 1.0, latBands = 24, lonBands = 48) {
  const pos = [], norm = [], uv = [], idx = [];

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

  const stride = lonBands + 1;
  for (let y = 0; y < latBands; y++)
    for (let x = 0; x < lonBands; x++) {
      const i0 = y * stride + x, i1 = i0 + 1, i2 = i0 + stride, i3 = i2 + 1;
      idx.push(i0, i2, i1, i1, i2, i3);
    }

  const big = pos.length / 3 > 65535;
  return {
    pos:     new Float32Array(pos),
    norm:    new Float32Array(norm),
    uv:      new Float32Array(uv),
    idx:     big ? new Uint32Array(idx) : new Uint16Array(idx),
    idxType: big ? WebGL2RenderingContext.UNSIGNED_INT : WebGL2RenderingContext.UNSIGNED_SHORT,
    color: [1, 1, 1], opacity: 1.0, uvRepeat: [1, 1], uvOffset: [0, 0],
  };
}

export function boundsOf(pos) {
  let mnX = Infinity, mxX = -Infinity;
  let mnY = Infinity, mxY = -Infinity;
  let mnZ = Infinity, mxZ = -Infinity;
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
