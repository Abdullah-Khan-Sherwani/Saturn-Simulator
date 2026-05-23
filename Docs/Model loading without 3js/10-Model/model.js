// usage
//const model = await Model.load(objText);

class Model {
    constructor(objText, fetchFile) {
        this.geometry = null;
        this.materials = {};
        this._fetchFile = fetchFile;
        this._ready = this._load(objText);
    }

    static async load(objText, fetchFile = (name) => fetch(name).then(r => r.text())) {
        const model = new Model(objText, fetchFile);
        await model._ready;
        return model;
    }

    async _load(objText) {
        try {
            this.parseOBJ(objText);

            if (this.geometry.materialLibraries?.length) {
                const results = await Promise.all(
                    this.geometry.materialLibraries.map(lib =>
                        this._fetchFile(lib).then(text => this.parseMTL(text))
                    )
                );
                for (const mtl of results) Object.assign(this.materials, mtl);
            }
        } catch (e) {
            console.error('Model load failed:', e);
            throw e; // re-throw so await model._ready rejects
        }
    }

    parseOBJ(text) {
        const positions = [[0, 0, 0]];
        const texcoords = [[0, 0]];
        const normals = [[0, 0, 1]];
        const colors = [[1, 1, 1]];

        const vertexMap = new Map();
        const indices = [];

        this.geometry = {
            position: [],
            texcoord: [],
            normal: [],
            color: [],
            tangent: [],
            indices: []
        };
        this.min = [Infinity, Infinity, Infinity];
        this.max = [-Infinity, -Infinity, -Infinity];

        let indexCounter = 0;
        let currentMaterial = null;
        let materialRanges = {};
        let materialLibs = [];

        function resolveIndex(i, array) {
            const idx = parseInt(i);
            return idx >= 0 ? idx : array.length + idx;
        }

        const addVertex = (vStr) => {
            const key = vStr + '|' + currentMaterial;

            if (vertexMap.has(key)) {
                indices.push(vertexMap.get(key));
                return;
            }

            const index = indexCounter++;
            vertexMap.set(key, index);
            indices.push(index);

            const parts = vStr.split('/');

            const pi = resolveIndex(parts[0], positions);
            this.geometry.position.push(...positions[pi]);
            this.geometry.color.push(...colors[pi]);

            if (parts[1]) {
                const ti = resolveIndex(parts[1], texcoords);
                this.geometry.texcoord.push(...texcoords[ti]);
            } else {
                this.geometry.texcoord.push(0, 0);
            }

            if (parts[2]) {
                const ni = resolveIndex(parts[2], normals);
                this.geometry.normal.push(...normals[ni]);
            } else {
                this.geometry.normal.push(0, 0, 1);
            }

            this.geometry.tangent.push(0, 0, 0);
        };

        const addFace = (parts) => {
            const start = indices.length;

            for (let i = 1; i < parts.length - 1; i++) {
                addVertex(parts[0]);
                addVertex(parts[i]);
                addVertex(parts[i + 1]);
            }

            if (currentMaterial) {
                if (!materialRanges[currentMaterial]) materialRanges[currentMaterial] = [];
                materialRanges[currentMaterial].push({
                    start,
                    count: indices.length - start
                });
            }
        };

        const handlers = {
            v: (parts) => {
                const vals = parts.map(v => parseFloat(v));
                positions.push(vals.slice(0, 3));
                colors.push(vals.length >= 6 ? vals.slice(3, 6) : [1, 1, 1]);

                for (let j = 0; j < 3; j++) {
                    if (vals[j] < this.min[j]) this.min[j] = vals[j];
                    if (vals[j] > this.max[j]) this.max[j] = vals[j];
                }
            },
            vt: (parts) => { texcoords.push(parts.map(v => parseFloat(v)).slice(0, 2)); },
            vn: (parts) => { normals.push(parts.map(v => parseFloat(v))); },
            f:  (parts) => { addFace(parts); },
            usemtl: (_, name) => { currentMaterial = name.trim(); },
            mtllib: (_, name) => { materialLibs.push(name.trim()); }
        };

        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();

            if (!line || line.startsWith('#')) continue;

            const [keyword, ...rest] = line.split(/\s+/);
            const handler = handlers[keyword];
            if (!handler) continue;

            try {
                handler(rest, rest.join(' '));
            } catch (e) {
                console.warn('OBJ parse error at line', i + 1, e);
            }
        }

        // --- Tangent computation ---
        const tan = this.geometry.tangent;
        const pos = this.geometry.position;
        const uv = this.geometry.texcoord;

        for (let i = 0; i < indices.length; i += 3) {
            const i0 = indices[i] * 3;
            const i1 = indices[i + 1] * 3;
            const i2 = indices[i + 2] * 3;

            const uv0 = indices[i] * 2;
            const uv1 = indices[i + 1] * 2;
            const uv2 = indices[i + 2] * 2;

            const p0 = pos.slice(i0, i0 + 3);
            const p1 = pos.slice(i1, i1 + 3);
            const p2 = pos.slice(i2, i2 + 3);

            const t0 = uv.slice(uv0, uv0 + 2);
            const t1 = uv.slice(uv1, uv1 + 2);
            const t2 = uv.slice(uv2, uv2 + 2);

            const edge1 = p1.map((v, j) => v - p0[j]);
            const edge2 = p2.map((v, j) => v - p0[j]);

            const duv1 = [t1[0] - t0[0], t1[1] - t0[1]];
            const duv2 = [t2[0] - t0[0], t2[1] - t0[1]];

            const f = 1.0 / (duv1[0] * duv2[1] - duv2[0] * duv1[1] || 1.0);

            const tangent = [
                f * (duv2[1] * edge1[0] - duv1[1] * edge2[0]),
                f * (duv2[1] * edge1[1] - duv1[1] * edge2[1]),
                f * (duv2[1] * edge1[2] - duv1[1] * edge2[2])
            ];

            for (const idx of [indices[i], indices[i + 1], indices[i + 2]]) {
                const ti = idx * 3;
                tan[ti]     += tangent[0];
                tan[ti + 1] += tangent[1];
                tan[ti + 2] += tangent[2];
            }
        }

        this.geometry.indices = indices;
        if (Object.keys(materialRanges).length) this.geometry.materialRanges = materialRanges;
        if (materialLibs.length) this.geometry.materialLibraries = materialLibs;
    }


    parseMTL(text) {
        this.materials = {};
        let currentMaterial = null;

        const toFloatArray = (str) => str.split(/\s+/).map(v => parseFloat(v));

        for (const line of text.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;

            const match = trimmed.match(/^(\w+)\s+(.+)$/);
            if (!match) continue;

            const [, keyword, value] = match;

            if (keyword === 'newmtl') {
                currentMaterial = value.trim();
                this.materials[currentMaterial] = {
                    name: currentMaterial,
                    Ka: [1, 1, 1],
                    Kd: [1, 1, 1],
                    Ks: [0, 0, 0],
                    Ke: [0, 0, 0],
                    Ns: 0,
                    Ni: 1,
                    d: 1,
                    Tr: 0,
                    illum: 2,
                    albedo: null,
                    normal: null,
                    specular: null,
                    emission: null,
                    opacity: null,
                    height: null,
                    ao: null,
                    metallic: null,
                    roughness: null
                };
                continue;
            }

            if (!currentMaterial) continue;

            const mat = this.materials[currentMaterial];

            switch (keyword) {
                case 'Ka': mat.Ka = toFloatArray(value); break;
                case 'Kd': mat.Kd = toFloatArray(value); break;
                case 'Ks': mat.Ks = toFloatArray(value); break;
                case 'Ke': mat.Ke = toFloatArray(value); break;

                case 'Ns':    mat.Ns    = parseFloat(value); break;
                case 'Ni':    mat.Ni    = parseFloat(value); break;
                case 'd':     mat.d     = parseFloat(value); break;
                case 'Tr':    mat.Tr    = parseFloat(value); break;
                case 'illum': mat.illum = parseInt(value);   break;

                case 'map_Kd': mat.albedo    = value.trim(); break;
                case 'map_Ks': mat.specular  = value.trim(); break;
                case 'map_Ke': mat.emission  = value.trim(); break;
                case 'map_d':  mat.opacity   = value.trim(); break;
                case 'map_Ka': mat.ao        = value.trim(); break;
                case 'map_Pm': mat.metallic  = value.trim(); break;
                case 'map_Pr': mat.roughness = value.trim(); break;

                case 'bump':
                case 'map_Bump':
                case 'norm': mat.normal = value.trim(); break;

                case 'disp':
                case 'map_D': mat.height = value.trim(); break;
            }
        }
    }

}