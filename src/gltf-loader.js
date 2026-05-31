/* Pure WebGL 2.0 GLB loader — no Three.js dependency.
   Parses the GLB binary container, walks the GLTF scene graph, and returns
   the same mesh array shape that saturn.js expects. */

/* GLTF accessor type → number of scalar components per element.
   SCALAR=1 float, VEC2=2 floats, VEC3=3 floats, etc. */
const TYPE_COMPS  = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

/* GLTF componentType integer code → JavaScript TypedArray constructor.
   These are OpenGL enum values embedded in the GLTF JSON. */
const COMP_CTOR   = {
  5120: Int8Array,    // GL_BYTE
  5121: Uint8Array,   // GL_UNSIGNED_BYTE
  5122: Int16Array,   // GL_SHORT
  5123: Uint16Array,  // GL_UNSIGNED_SHORT
  5125: Uint32Array,  // GL_UNSIGNED_INT
  5126: Float32Array, // GL_FLOAT
};

/* Byte size of each component type (used to stride through the binary buffer). */
const COMP_BYTES  = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };

/* Read a GLTF accessor into a flat TypedArray.
   json: parsed GLTF JSON chunk
   bin: the raw binary buffer (ArrayBuffer) from the GLB BIN chunk
   idx: index into json.accessors[]

   GLTF data model:
     accessor → bufferView → buffer (the bin ArrayBuffer)
   An accessor describes an array of typed elements (e.g. 100 VEC3 floats).
   A bufferView is a byte-range window into the binary buffer.
   byteStride: if non-zero, vertices are interleaved; stride is the byte gap
               between consecutive elements (e.g. pos/norm/uv packed together). */
function readAccessor(json, bin, idx) {
  const acc      = json.accessors[idx];         // e.g. { type:"VEC3", count:100, componentType:5126 }
  const bv       = json.bufferViews[acc.bufferView]; // byte range in bin
  const nComp    = TYPE_COMPS[acc.type];        // components per element (e.g. 3 for VEC3)
  const Ctor     = COMP_CTOR[acc.componentType];// TypedArray class (e.g. Float32Array)
  const cBytes   = COMP_BYTES[acc.componentType];// bytes per scalar component
  const elemBytes = nComp * cBytes;             // bytes per complete element (e.g. 3*4=12 for VEC3 float)
  /* byteStride: explicit interleave gap, or fall back to tightly packed (= elemBytes). */
  const stride   = bv.byteStride ?? elemBytes;
  const bvOff    = bv.byteOffset ?? 0;          // byte offset of the buffer view within bin
  const accOff   = acc.byteOffset ?? 0;         // additional offset within the buffer view

  const out = new Ctor(acc.count * nComp);      // allocate flat output array

  if (stride === elemBytes) {
    /* Tightly packed: copy in one slice — fast path. */
    const start = bvOff + accOff;
    out.set(new Ctor(bin.slice(start, start + acc.count * elemBytes)));
  } else {
    /* Interleaved: copy one element at a time, hopping by stride bytes. */
    for (let i = 0; i < acc.count; i++) {
      const start = bvOff + accOff + i * stride;
      out.set(new Ctor(bin.slice(start, start + elemBytes)), i * nComp);
    }
  }
  return out;
}

/* Decode an embedded image from the GLB binary buffer into an HTMLImageElement.
   The image bytes live in a bufferView; we wrap them in a Blob, create a
   temporary object URL, and let the browser decode it as a normal image. */
function loadEmbeddedImage(bin, json, imgIdx) {
  const def   = json.images[imgIdx];
  const bv    = json.bufferViews[def.bufferView];
  /* bin.slice(start, end): extract the image's raw bytes as a new ArrayBuffer. */
  const slice = bin.slice(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength);
  /* Blob: wraps the bytes with a declared MIME type (e.g. "image/jpeg" or "image/png"). */
  const url   = URL.createObjectURL(new Blob([slice], { type: def.mimeType }));
  return new Promise((resolve, reject) => {
    const img = new Image();
    /* Revoke the object URL immediately after loading to free the browser-side memory. */
    img.onload  = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image ' + imgIdx + ' failed')); };
    img.src = url;
  });
}

/* Walk the GLTF scene graph and extract all mesh primitives into a flat array.
   Returns an array of mesh descriptors compatible with makeVAO() in gl-utils.js.

   { json, bin, images } as returned by loadGLTF(). */
export function extractMeshes({ json, bin, images }) {
  const meshes    = [];
  /* Start from the root nodes of the active scene (default scene = json.scene ?? 0). */
  const sceneNodes = json.scenes?.[json.scene ?? 0]?.nodes ?? [];
  /* Iterative DFS traversal: queue starts with the scene's root node indices,
     expanding children as we visit each node. */
  const queue     = [...sceneNodes];
  const visited   = new Set();  // prevent infinite loops if the graph has cycles

  while (queue.length) {
    const nIdx = queue.pop();
    if (visited.has(nIdx)) continue;
    visited.add(nIdx);
    const node = json.nodes[nIdx];
    /* Push child node indices onto the queue for further traversal. */
    if (node.children) queue.push(...node.children);
    /* Skip nodes that don't have geometry. */
    if (node.mesh == null) continue;

    const meshDef  = json.meshes[node.mesh];
    /* nodeName: used by isRing() in saturn.js to identify ring vs body meshes. */
    const nodeName = (node.name ?? meshDef.name ?? '').toLowerCase();

    /* A GLTF mesh can have multiple primitives (e.g. different materials within
       one logical mesh object). Each primitive is an independent draw call. */
    for (const prim of meshDef.primitives) {
      const attrs = prim.attributes;  // { POSITION: accIdx, NORMAL: accIdx, ... }

      /* POSITION: required. Float32Array of interleaved xyz. */
      const pos  = Float32Array.from(readAccessor(json, bin, attrs.POSITION));
      /* NORMAL: optional. If absent (e.g. some ring chunks), fill with zeros —
         the shader will get zero normals, but at least it won't crash. */
      const norm = attrs.NORMAL != null
        ? Float32Array.from(readAccessor(json, bin, attrs.NORMAL))
        : new Float32Array(pos.length);
      /* TEXCOORD_0: primary UV set (diffuse texture). */
      const uv   = attrs.TEXCOORD_0 != null
        ? Float32Array.from(readAccessor(json, bin, attrs.TEXCOORD_0))
        : null;
      /* TEXCOORD_1: secondary UV set. Saturn's specular maps are authored against
         this set (confirmed by auditing the GLB material references). */
      const uv2  = attrs.TEXCOORD_1 != null
        ? Float32Array.from(readAccessor(json, bin, attrs.TEXCOORD_1))
        : null;

      /* Index buffer: optional. If present, readAccessor returns Uint16 or Uint32.
         We normalise everything to Uint16 (more GPU-compatible) unless the vertex
         count requires Uint32 (> 65535 vertices). */
      let idx = null, idxType = null;
      if (prim.indices != null) {
        const raw = readAccessor(json, bin, prim.indices);
        if (raw instanceof Uint32Array) {
          idx = raw; idxType = WebGL2RenderingContext.UNSIGNED_INT;
        } else {
          idx = Uint16Array.from(raw); idxType = WebGL2RenderingContext.UNSIGNED_SHORT;
        }
      }

      /* Extract material properties. Two material models are supported:
         1. KHR_materials_pbrSpecularGlossiness (extension): specular/gloss workflow.
            - diffuseFactor: RGBA base colour multiplier
            - specularFactor: RGB specular colour multiplier
            - glossinessFactor: scalar glossiness multiplier
            - diffuseTexture: index into json.textures → image
            - specularGlossinessTexture: packed specular(RGB) + glossiness(A) map
         2. pbrMetallicRoughness (core GLTF): metallic/roughness workflow.
            - baseColorFactor: RGBA colour
            - baseColorTexture: diffuse image */
      let color = [0.8, 0.8, 0.8], opacity = 1.0, image = null, specImage = null;
      /* KHR_materials_pbrSpecularGlossiness factors (defaults per the spec) and
         the UV set the spec map is authored against (these assets use UV1). */
      let specFactor = [1, 1, 1], glossFactor = 1.0, specUV = 0;

      if (prim.material != null) {
        const mat   = json.materials[prim.material];
        /* Check for the specular-gloss extension first (Saturn/ring assets use it). */
        const khrSG = mat.extensions?.KHR_materials_pbrSpecularGlossiness;

        if (khrSG) {
          if (khrSG.diffuseFactor) {
            /* Destructure RGBA; default a=1 if only RGB is present. */
            const [r, g, b, a = 1] = khrSG.diffuseFactor;
            color = [r, g, b]; opacity = a;
          }
          if (khrSG.specularFactor)            specFactor  = khrSG.specularFactor;
          if (khrSG.glossinessFactor != null)  glossFactor = khrSG.glossinessFactor;
          /* Resolve texture reference: texture index → source image index → decoded image. */
          if (khrSG.diffuseTexture != null)
            image = images[json.textures[khrSG.diffuseTexture.index].source] ?? null;
          if (khrSG.specularGlossinessTexture != null) {
            specImage = images[json.textures[khrSG.specularGlossinessTexture.index].source] ?? null;
            /* texCoord: which UV set this texture was baked against (0=UV0, 1=UV1).
               Stored per-texture in the GLTF extension object. */
            specUV    = khrSG.specularGlossinessTexture.texCoord ?? 0;
          }
        } else {
          /* Fallback: core PBR metallic-roughness (Enceladus uses this path). */
          const pbr = mat.pbrMetallicRoughness ?? {};
          if (pbr.baseColorFactor) {
            const [r, g, b, a = 1] = pbr.baseColorFactor;
            color = [r, g, b]; opacity = a;
          }
          if (pbr.baseColorTexture != null)
            image = images[json.textures[pbr.baseColorTexture.index].source] ?? null;
        }
      }

      /* Push a mesh descriptor. saturn.js expects exactly these fields. */
      meshes.push({
        name: nodeName, pos, norm, uv, uv2, idx, idxType,
        color, opacity, image, specImage, specUV, specFactor, glossFactor,
        uvRepeat: [1, 1], uvOffset: [0, 0],
      });
    }
  }
  return meshes;
}

/* Load and parse a GLB file from a URL.
   Returns { json, bin, images } where:
     json: parsed GLTF scene descriptor
     bin: raw binary ArrayBuffer (vertex/index/image data)
     images: array of decoded HTMLImageElement (one per json.images entry)

   GLB binary format:
     bytes 0-3:   magic = 0x46546C67 ("glTF" little-endian)
     bytes 4-7:   version = 2
     bytes 8-11:  total file length
     followed by chunks, each:
       [4 bytes] chunk data length
       [4 bytes] chunk type: 0x4E4F534A = JSON, 0x004E4942 = BIN
       [n bytes] chunk data */
export async function loadGLTF(url, onProgress) {
  const buf = await fetchBinary(url, onProgress);
  const dv  = new DataView(buf);  // DataView: read multi-byte integers from an ArrayBuffer

  /* Validate magic number: getUint32(offset, littleEndian).
     0x46546C67 = 'g','l','T','F' in little-endian ASCII. */
  if (dv.getUint32(0, true) !== 0x46546C67)
    throw new Error('Not a GLB file: ' + url);

  let json = null, bin = new ArrayBuffer(0);
  let offset = 12;  // skip the 12-byte header (magic + version + length)
  while (offset < buf.byteLength) {
    const chunkLen  = dv.getUint32(offset,     true);  // length of this chunk's data
    const chunkType = dv.getUint32(offset + 4, true);  // type identifier
    const chunkData = buf.slice(offset + 8, offset + 8 + chunkLen);  // chunk bytes
    offset += 8 + chunkLen;  // advance past this chunk (8-byte header + data)

    if      (chunkType === 0x4E4F534A)  // "JSON" — the scene descriptor
      json = JSON.parse(new TextDecoder().decode(chunkData));  // TextDecoder: ArrayBuffer → UTF-8 string
    else if (chunkType === 0x004E4942)  // "BIN\0" — vertex/image binary data
      bin = chunkData;
  }
  if (!json) throw new Error('No JSON chunk in GLB: ' + url);

  /* Decode all embedded images in parallel (they're stored as JPEG/PNG bytes in bin). */
  const imageDefs = json.images ?? [];
  const images    = await Promise.all(
    imageDefs.map((def, i) =>
      /* Only decode images that have a bufferView (embedded in the GLB).
         External image references (def.uri) are not used by these assets. */
      def.bufferView != null ? loadEmbeddedImage(bin, json, i) : Promise.resolve(null)
    )
  );

  return { json, bin, images };
}

/* Fetch a binary file (arraybuffer) via XHR with optional progress reporting.
   onProgress: callback receiving the XHR ProgressEvent (has .loaded and .total). */
function fetchBinary(url, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url);
    xhr.responseType = 'arraybuffer';  // tells the browser to give us raw bytes
    if (onProgress) xhr.addEventListener('progress', onProgress);
    xhr.onload  = () => xhr.status < 400
      ? resolve(xhr.response)  // xhr.response: the ArrayBuffer
      : reject(new Error(`HttpError: fetch for "${url}" responded with ${xhr.status}: ${xhr.statusText}`));
    xhr.onerror = () => reject(new Error('Network error: ' + url));
    xhr.send();
  });
}
