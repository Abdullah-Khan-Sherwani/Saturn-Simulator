/* Pure WebGL 2.0 GLB loader — no Three.js dependency.
   Parses the GLB binary container, walks the GLTF scene graph, and returns
   the same mesh array shape that saturn.js expects. */

const TYPE_COMPS  = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const COMP_CTOR   = {
  5120: Int8Array,   5121: Uint8Array,
  5122: Int16Array,  5123: Uint16Array,
  5125: Uint32Array, 5126: Float32Array,
};
const COMP_BYTES  = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };

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
  const out      = new Ctor(acc.count * nComp);

  if (stride === elemBytes) {
    const start = bvOff + accOff;
    out.set(new Ctor(bin.slice(start, start + acc.count * elemBytes)));
  } else {
    for (let i = 0; i < acc.count; i++) {
      const start = bvOff + accOff + i * stride;
      out.set(new Ctor(bin.slice(start, start + elemBytes)), i * nComp);
    }
  }
  return out;
}

function loadEmbeddedImage(bin, json, imgIdx) {
  const def   = json.images[imgIdx];
  const bv    = json.bufferViews[def.bufferView];
  const slice = bin.slice(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength);
  const url   = URL.createObjectURL(new Blob([slice], { type: def.mimeType }));
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload  = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image ' + imgIdx + ' failed')); };
    img.src = url;
  });
}

export function extractMeshes({ json, bin, images }) {
  const meshes    = [];
  const sceneNodes = json.scenes?.[json.scene ?? 0]?.nodes ?? [];
  const queue     = [...sceneNodes];
  const visited   = new Set();

  while (queue.length) {
    const nIdx = queue.pop();
    if (visited.has(nIdx)) continue;
    visited.add(nIdx);
    const node = json.nodes[nIdx];
    if (node.children) queue.push(...node.children);
    if (node.mesh == null) continue;

    const meshDef  = json.meshes[node.mesh];
    const nodeName = (node.name ?? meshDef.name ?? '').toLowerCase();

    for (const prim of meshDef.primitives) {
      const attrs = prim.attributes;

      const pos  = Float32Array.from(readAccessor(json, bin, attrs.POSITION));
      const norm = attrs.NORMAL != null
        ? Float32Array.from(readAccessor(json, bin, attrs.NORMAL))
        : new Float32Array(pos.length);
      const uv   = attrs.TEXCOORD_0 != null
        ? Float32Array.from(readAccessor(json, bin, attrs.TEXCOORD_0))
        : null;

      let idx = null, idxType = null;
      if (prim.indices != null) {
        const raw = readAccessor(json, bin, prim.indices);
        if (raw instanceof Uint32Array) {
          idx = raw; idxType = WebGL2RenderingContext.UNSIGNED_INT;
        } else {
          idx = Uint16Array.from(raw); idxType = WebGL2RenderingContext.UNSIGNED_SHORT;
        }
      }

      let color = [0.8, 0.8, 0.8], opacity = 1.0, image = null, specImage = null;

      if (prim.material != null) {
        const mat   = json.materials[prim.material];
        const khrSG = mat.extensions?.KHR_materials_pbrSpecularGlossiness;

        if (khrSG) {
          if (khrSG.diffuseFactor) {
            const [r, g, b, a = 1] = khrSG.diffuseFactor;
            color = [r, g, b]; opacity = a;
          }
          if (khrSG.diffuseTexture != null)
            image = images[json.textures[khrSG.diffuseTexture.index].source] ?? null;
          if (khrSG.specularGlossinessTexture != null)
            specImage = images[json.textures[khrSG.specularGlossinessTexture.index].source] ?? null;
        } else {
          const pbr = mat.pbrMetallicRoughness ?? {};
          if (pbr.baseColorFactor) {
            const [r, g, b, a = 1] = pbr.baseColorFactor;
            color = [r, g, b]; opacity = a;
          }
          if (pbr.baseColorTexture != null)
            image = images[json.textures[pbr.baseColorTexture.index].source] ?? null;
        }
      }

      meshes.push({
        name: nodeName, pos, norm, uv, idx, idxType,
        color, opacity, image, specImage,
        uvRepeat: [1, 1], uvOffset: [0, 0],
      });
    }
  }
  return meshes;
}

export async function loadGLTF(url, onProgress) {
  const buf = await fetchBinary(url, onProgress);
  const dv  = new DataView(buf);

  if (dv.getUint32(0, true) !== 0x46546C67)
    throw new Error('Not a GLB file: ' + url);

  let json = null, bin = new ArrayBuffer(0);
  let offset = 12;
  while (offset < buf.byteLength) {
    const chunkLen  = dv.getUint32(offset,     true);
    const chunkType = dv.getUint32(offset + 4, true);
    const chunkData = buf.slice(offset + 8, offset + 8 + chunkLen);
    offset += 8 + chunkLen;
    if (chunkType === 0x4E4F534A) json = JSON.parse(new TextDecoder().decode(chunkData));
    else if (chunkType === 0x004E4942) bin = chunkData;
  }
  if (!json) throw new Error('No JSON chunk in GLB: ' + url);

  const imageDefs = json.images ?? [];
  const images    = await Promise.all(
    imageDefs.map((def, i) =>
      def.bufferView != null ? loadEmbeddedImage(bin, json, i) : Promise.resolve(null)
    )
  );

  return { json, bin, images };
}

function fetchBinary(url, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url);
    xhr.responseType = 'arraybuffer';
    if (onProgress) xhr.addEventListener('progress', onProgress);
    xhr.onload  = () => xhr.status < 400
      ? resolve(xhr.response)
      : reject(new Error(`HttpError: fetch for "${url}" responded with ${xhr.status}: ${xhr.statusText}`));
    xhr.onerror = () => reject(new Error('Network error: ' + url));
    xhr.send();
  });
}
