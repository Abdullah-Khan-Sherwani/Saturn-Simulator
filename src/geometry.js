/* Procedural geometry + image loading helpers */

/* Load a single image from a URL, returning a Promise<HTMLImageElement>.
   The promise resolves when the browser finishes decoding the image,
   at which point the image can be uploaded to the GPU via gl.texImage2D. */
export function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload  = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load image: ' + url));
    img.src = url;  // triggers the browser fetch; onload/onerror fire asynchronously
  });
}

/* Load the 6 faces of a cubemap from a directory.
   basePath: directory containing px.png, nx.png, py.png, ny.png, pz.png, nz.png
   Returns a Promise<HTMLImageElement[]> in [+X, -X, +Y, -Y, +Z, -Z] order,
   matching the order expected by glTexCubeFromImages(). */
export async function loadCubemapFaces(basePath) {
  const faces = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];
  /* Promise.all: fetch all 6 face images in parallel — total time = max of 6, not sum. */
  return Promise.all(faces.map(face => loadImage(`${basePath}/${face}.png`)));
}

/* Generate a UV-mapped sphere mesh procedurally.
   radius: sphere radius in model units
   latBands: number of horizontal rings (latitude divisions)
   lonBands: number of vertical slices (longitude divisions)

   Returns a mesh descriptor { pos, norm, uv, idx, idxType, ... } in the
   same format as extractMeshes(), ready for makeVAO(). */
export function makeUvSphere(radius = 1.0, latBands = 24, lonBands = 48) {
  const pos = [], norm = [], uv = [], idx = [];

  /* Iterate over a grid of (latBands+1) × (lonBands+1) vertices.
     Each vertex is placed at spherical coordinates (theta, phi):
       theta (polar/latitude angle): 0 at the north pole → π at the south pole
       phi (azimuthal/longitude angle): 0 → 2π around the equator */
  for (let y = 0; y <= latBands; y++) {
    const v     = y / latBands;          // normalised latitude [0,1]
    const theta = v * Math.PI;           // polar angle: 0 = north pole, π = south pole
    const st    = Math.sin(theta);       // sin(θ) — used for the XZ radius at this latitude
    const ct    = Math.cos(theta);       // cos(θ) — used for the Y (up/down) component
    for (let x = 0; x <= lonBands; x++) {
      const u   = x / lonBands;          // normalised longitude [0,1]
      const phi = u * Math.PI * 2.0;    // azimuthal angle: 0 → 2π

      /* Spherical coordinates → Cartesian unit normal (= point on unit sphere):
           nx = cos(φ) · sin(θ)   (X: east/west)
           ny = cos(θ)            (Y: north/south — +1 at north pole, -1 at south)
           nz = sin(φ) · sin(θ)   (Z: forward/back)
         Because this is a unit sphere, the normal equals the position divided by radius. */
      const nx = Math.cos(phi) * st, ny = ct, nz = Math.sin(phi) * st;
      norm.push(nx, ny, nz);
      pos.push(radius * nx, radius * ny, radius * nz);  // scale unit normal by radius
      /* UV: u is flipped (1-u) so the texture reads left→right as longitude increases.
         v is kept as-is: 0 at north pole, 1 at south pole. */
      uv.push(1.0 - u, v);
    }
  }

  /* Build triangle indices. Each lat/lon cell is two triangles (a quad split diagonally).
     stride = lonBands+1 because we have one extra vertex column for seam closure.
     For cell (y, x):
       i0 = top-left, i1 = top-right, i2 = bottom-left, i3 = bottom-right
     Two triangles: (i0,i2,i1) and (i1,i2,i3) */
  const stride = lonBands + 1;
  for (let y = 0; y < latBands; y++)
    for (let x = 0; x < lonBands; x++) {
      const i0 = y * stride + x, i1 = i0 + 1, i2 = i0 + stride, i3 = i2 + 1;
      idx.push(i0, i2, i1, i1, i2, i3);
    }

  /* Choose 16-bit or 32-bit index buffer based on vertex count.
     Uint16Array can address at most 65535 vertices; if we have more, use Uint32Array. */
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

/* Compute the axis-aligned bounding box (AABB) of a mesh's vertex positions.
   pos: flat Float32Array of interleaved xyz values: [x0,y0,z0, x1,y1,z1, ...]

   Returns { cx, cy, cz, r } where:
     cx/cy/cz = geometric centre (midpoint of the AABB on each axis)
     r = bounding radius = half the longest axis extent — used as:
       1. The occluder sphere radius in the analytical shadow test
       2. The denominator in the scale factor sS = 3.2 / r (fits body to world units) */
export function boundsOf(pos) {
  /* Initialise extremes to opposite infinities so the first vertex always
     updates them regardless of its value. */
  let mnX = Infinity, mxX = -Infinity;
  let mnY = Infinity, mxY = -Infinity;
  let mnZ = Infinity, mxZ = -Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    mnX = Math.min(mnX, pos[i]);   mxX = Math.max(mxX, pos[i]);
    mnY = Math.min(mnY, pos[i+1]); mxY = Math.max(mxY, pos[i+1]);
    mnZ = Math.min(mnZ, pos[i+2]); mxZ = Math.max(mxZ, pos[i+2]);
  }
  return {
    cx: (mnX + mxX) * .5,   // midpoint X: (min + max) / 2
    cy: (mnY + mxY) * .5,   // midpoint Y
    cz: (mnZ + mxZ) * .5,   // midpoint Z
    /* r = half the longest side of the AABB.
       Math.max picks the worst axis; * 0.5 converts full-extent to radius.
       This is a conservative bound (not the smallest enclosing sphere), but
       good enough for our analytical shadow occluder. */
    r:  Math.max(mxX - mnX, mxY - mnY, mxZ - mnZ) * .5,
  };
}
