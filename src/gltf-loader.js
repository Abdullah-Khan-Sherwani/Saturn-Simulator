/* GLTF loading: THREE.GLTFLoader used as a parser only.
   Raw typed arrays are copied out; Three.js scene graphs are discarded. */

import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshStandardMaterial, Color } from 'three';

/* Priority-ordered texture slots — different GLB exporters use different slots */
const TEX_SLOTS = ['map', 'emissiveMap', 'alphaMap', 'roughnessMap', 'metalnessMap', 'normalMap'];

/* ── KHR_materials_pbrSpecularGlossiness plugin ──────────────────────────────
   Three.js r152+ removed built-in support for this older PBR extension.
   Maps diffuseTexture → mat.map and specularGlossinessTexture → mat.roughnessMap
   so extractMeshes() can find them in the standard slots.
──────────────────────────────────────────────────────────────────────────── */
class KHRPbrSGPlugin {
  constructor(parser) { this.parser = parser; this.name = 'KHR_materials_pbrSpecularGlossiness'; }

  getMaterialType(materialIndex) {
    return this._ext(materialIndex) ? MeshStandardMaterial : null;
  }

  extendMaterialParams(materialIndex, materialParams) {
    const ext = this._ext(materialIndex);
    if (!ext) return Promise.resolve();
    const pending = [];

    if (Array.isArray(ext.diffuseFactor)) {
      const [r, g, b, a = 1] = ext.diffuseFactor;
      materialParams.color   = new Color(r, g, b);
      materialParams.opacity = a;
      if (a < 1) materialParams.transparent = true;
    }
    if (ext.diffuseTexture != null)
      pending.push(this.parser.loadTexture(ext.diffuseTexture.index)
        .then(tex => { materialParams.map = tex; }));
    if (ext.specularGlossinessTexture != null)
      pending.push(this.parser.loadTexture(ext.specularGlossinessTexture.index)
        .then(tex => { materialParams.roughnessMap = tex; }));

    return Promise.all(pending);
  }

  _ext(idx) {
    return this.parser.json.materials?.[idx]?.extensions?.[this.name] ?? null;
  }
}

export function extractMeshes(gltf) {
  const meshes = [];
  gltf.scene.traverse(node => {
    if (!node.isMesh) return;
    const geo = node.geometry;
    const mat = Array.isArray(node.material) ? node.material[0] : node.material;

    const pos  = Float32Array.from(geo.attributes.position.array);
    const norm = geo.attributes.normal
      ? Float32Array.from(geo.attributes.normal.array)
      : new Float32Array(pos.length);
    const uv = geo.attributes.uv ? Float32Array.from(geo.attributes.uv.array) : null;

    let idx = null, idxType = null;
    if (geo.index) {
      const raw = geo.index.array;
      if (raw instanceof Uint32Array) { idx = Uint32Array.from(raw); idxType = WebGL2RenderingContext.UNSIGNED_INT; }
      else                            { idx = Uint16Array.from(raw); idxType = WebGL2RenderingContext.UNSIGNED_SHORT; }
    }

    const color   = mat.color ? [mat.color.r, mat.color.g, mat.color.b] : [0.8, 0.8, 0.8];
    const opacity = mat.opacity ?? 1.0;

    let image = null, uvRepeat = [1, 1], uvOffset = [0, 0];
    for (const slot of TEX_SLOTS) {
      const t = mat[slot];
      if (t?.image) { image = t.image; uvRepeat = [t.repeat.x, t.repeat.y]; uvOffset = [t.offset.x, t.offset.y]; break; }
    }

    const specImage = mat.roughnessMap?.image ?? null;
    meshes.push({ name: (node.name || '').toLowerCase(), pos, norm, uv, idx, idxType, color, opacity, image, specImage, uvRepeat, uvOffset });
  });
  return meshes;
}

export function loadGLTF(url, onProgress) {
  return new Promise((res, rej) => {
    const loader = new GLTFLoader();
    loader.register(parser => new KHRPbrSGPlugin(parser));
    loader.load(url, res, onProgress, rej);
  });
}
