// Load model using our own loader (model.js)

// Arcball Camera

"use strict";
const FLOAT_SIZE = Float32Array.BYTES_PER_ELEMENT;

// Main Application Class
class MainApp {
    constructor() {
        this.canvas = document.getElementById('glCanvas');
        this.gl = this.canvas.getContext('webgl2');
        
        if (!this.gl) {
            alert('WebGL2 not supported!');
            return;
        }

        this.keys = {}; // object to keep track of pressed keys
        this.previousTime = 0; // for calculating delta time in render loop
        
        this.arcball = {
            isDragging: false,
            startPos: [0, 0, 0],
            baseRotation: glMatrix.quat.create(),
            rotation: glMatrix.quat.create(),
            sensitivity: 2.5,
        };

        this.model = glMatrix.mat4.create();
        this.view = glMatrix.mat4.create();
        this.projection = glMatrix.mat4.create();

        this.setupEventListeners();
        
        this.initWebGL()
            .then(() => requestAnimationFrame((now) => this.render(now)))
            .catch(err => console.error('Initialization failed:', err));    
    }

    async initWebGL() {
        const gl = this.gl;
        
        try {
            const [vsResp, fsResp] = await Promise.all([
                fetch('1-vs.glsl'),
                fetch('1-fs.glsl')
            ]);

            if (!vsResp.ok) throw new Error(`VS fetch failed: ${vsResp.status}`);
            if (!fsResp.ok) throw new Error(`FS fetch failed: ${fsResp.status}`);

            const [vsSource, fsSource] = await Promise.all([
                vsResp.text(), fsResp.text()
            ]);
            this.shader = new Shader(gl, vsSource, fsSource);
        } catch (err) {
            console.error('Failed to load shader file:', err.message);
            throw err; // stop further initialization
        }        
        
        await this.initVAO(); // Load model and prepare VAO

        this.initTextures(); // Load textures 
        this.initUniforms(); // Set up shader uniforms that won't change in the render loop
                
        gl.enable(gl.DEPTH_TEST); // Enable depth testing
        gl.clearColor(0.1, 0.1, 0.1, 1.0); // Set clear color
        gl.viewport(0, 0, this.canvas.clientWidth, this.canvas.clientHeight);
    }

    async initVAO() {        
        const gl = this.gl;

        this.modelPath = "backpack/";
        const objResponse = await fetch(this.modelPath+'survival_guitar_backpack.obj');
        const objText = await objResponse.text();

        // parse .obj and .mtl files
        const model = await Model.load(objText, (name) => fetch(this.modelPath+name).then(r => r.text()));
        this.mesh = model.geometry;
        this.materials = model.materials;
        this.size = [model.max[0]-model.min[0], model.max[1]-model.min[1], model.max[2]-model.min[2] ];
        this.center = [(model.max[0]+model.min[0])/2, (model.max[1]+model.min[1])/2, (model.max[2]+model.min[2])/2];


        console.log('Vertices: ' + this.mesh.position.length / 3);
        console.log('Texture Coordinates: ' + this.mesh.texcoord.length / 2);
        console.log('Normals: ' + this.mesh.normal.length / 3);
        console.log('Triangles: ' + this.mesh.indices.length / 3);

        this.VAO = gl.createVertexArray(); 
        gl.bindVertexArray(this.VAO);

        const positionVBO = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, positionVBO);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(this.mesh.position), gl.STATIC_DRAW);
        const aPos = gl.getAttribLocation(this.shader.ID, "aPos");
        gl.enableVertexAttribArray(aPos);
        gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);

        const texcoordVBO = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, texcoordVBO);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(this.mesh.texcoord), gl.STATIC_DRAW);
        const aTexCoord = gl.getAttribLocation(this.shader.ID, "aTexCoord");
        gl.enableVertexAttribArray(aTexCoord);
        gl.vertexAttribPointer(aTexCoord, 2, gl.FLOAT, false, 0, 0);

        const normalVBO = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, normalVBO);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(this.mesh.normal), gl.STATIC_DRAW);
        const aNormal = gl.getAttribLocation(this.shader.ID, "aNormal");
        gl.enableVertexAttribArray(aNormal);
        gl.vertexAttribPointer(aNormal, 3, gl.FLOAT, false, 0, 0);

        const indexVBO = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexVBO);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(this.mesh.indices), gl.STATIC_DRAW);

        //clear VAO
        gl.bindVertexArray(null); 
    }

    initTextures() {
        const gl = this.gl;

        const mat = Object.values(this.materials)[0];
        console.log('diffuse map:',  mat?.albedo  ? mat.albedo   : 'none');
        console.log('specular map:', mat?.specular ? mat.specular : 'none');

        this.shader.use();
        const diffuseMapFile  = mat?.albedo  ? this.modelPath + mat.albedo   : '';
        const specularMapFile = mat?.specular ? this.modelPath + mat.specular : '';

        this.diffuseMap  = new Texture(gl, gl.TEXTURE0, diffuseMapFile,  { placeholderColor: [0, 255, 0, 255] });
        this.diffuseMap.setSamplerUniform(this.shader, 'material.diffuse');

        this.specularMap = new Texture(gl, gl.TEXTURE1, specularMapFile, { placeholderColor: [0, 0, 0, 255] });
        this.specularMap.setSamplerUniform(this.shader, 'material.specular');
    }

    // setup model matrix once here, as it won't get update in rendering loo[]
    initUniforms() {        
        this.shader.use();

        const scale = 2.0 / Math.max(this.size[0], this.size[1], this.size[2]);
        glMatrix.mat4.fromScaling(this.model, [scale, scale, scale]);
        glMatrix.mat4.translate(this.model, this.model, [-this.center[0], -this.center[1], -this.center[2] ]);

        glMatrix.mat4.perspective(this.projection,
            glMatrix.glMatrix.toRadian(45),   // field of view
            this.canvas.clientWidth / this.canvas.clientHeight, // aspect ratio 
            0.1,                                       // near plane
            100.0                                      // far plane
        );    

        this.shader.setMat4('model', this.model);
        this.shader.setMat4('projection', this.projection);
        this.shader.setFloat('material.shininess', 32.0);

        this.shader.setVec3v('light.position', [5.0, 5.0, 5.0]);
        this.shader.setVec3v('light.ambient',  [0.2, 0.2, 0.2]);
        this.shader.setVec3v('light.diffuse',  [0.8, 0.8, 0.8]);
        this.shader.setVec3v('light.specular', [1.0, 1.0, 1.0]);    
    }        
    
    render(timestamp) {
        const gl = this.gl;
        
        // calculate delta time for consistent movement speed
        const currentTime = timestamp / 1000.0; // convert to seconds
        const deltaTime = currentTime - this.previousTime;
        this.previousTime = currentTime;

        // clear color and depth buffers
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        // activate the shader program and VAO, bind texture 
        this.shader.use();
        gl.bindVertexArray(this.VAO);
        this.diffuseMap.bind();
        this.specularMap.bind();
        
        // update transformation matrices
        const camDistance = 3.0;
        const viewPos = [0, 0, camDistance]; // camera is at Z+
        glMatrix.mat4.lookAt(this.view, viewPos, [0, 0, 0], [0, 1, 0]);
        const rotMat = glMatrix.mat4.create();
        glMatrix.mat4.fromQuat(rotMat, this.arcball.rotation);
        glMatrix.mat4.multiply(this.view, this.view, rotMat);

        const invRot = glMatrix.mat4.create();
        glMatrix.mat4.transpose(invRot, rotMat);
        glMatrix.vec3.transformMat4(viewPos, [0, 0, camDistance], invRot);

        const lightOffset = [1.5, 1.5, 0];
        const lightPos = glMatrix.vec3.create();
        glMatrix.vec3.add(lightPos, viewPos, lightOffset);

        // update uniforms
        this.shader.setMat4('view', this.view);
        this.shader.setVec3v('light.position', lightPos);
        this.shader.setVec3v('viewPos', viewPos);

        // draw
        gl.drawElements(gl.TRIANGLES, this.mesh.indices.length, gl.UNSIGNED_SHORT, 0);
        
        // const err = gl.getError();
        // if (err !== gl.NO_ERROR) console.error('GL error:', err);

        gl.bindVertexArray(null);

        requestAnimationFrame((now) => this.render(now));
    }

    setupEventListeners() {
        this.canvas.addEventListener('mousedown', e => {
            this.arcball.isDragging = true;
            this.arcball.startPos = this.screenToArcball(e.offsetX, e.offsetY);
            glMatrix.quat.copy(this.arcball.baseRotation, this.arcball.rotation);
        });
        
        this.canvas.addEventListener('mousemove', e => {
            if (!this.arcball.isDragging) return;

            const currPos = this.screenToArcball(e.offsetX, e.offsetY);
            const axis = glMatrix.vec3.create();
            glMatrix.vec3.cross(axis, this.arcball.startPos, currPos);
            const dot = Math.min(1.0, glMatrix.vec3.dot(this.arcball.startPos, currPos));
            const angle = Math.acos(dot) * this.arcball.sensitivity;

            if (glMatrix.vec3.length(axis) > 1e-6) {
                const delta = glMatrix.quat.create();
                glMatrix.quat.setAxisAngle(delta, axis, angle);
                glMatrix.quat.normalize(delta, delta);
                // apply delta on top of the snapshot, not the accumulated rotation
                glMatrix.quat.multiply(this.arcball.rotation, delta, this.arcball.baseRotation);
            }
        });

        this.canvas.addEventListener('mouseup', () => this.arcball.isDragging = false);
        this.canvas.addEventListener('mouseleave', () => this.arcball.isDragging = false);

    }

    screenToArcball(x, y) {
        // normalize to [-1, 1]
        const nx = (2 * x) / this.canvas.clientWidth - 1;
        const ny = 1 - (2 * y) / this.canvas.clientHeight;
        const len2 = nx * nx + ny * ny;

        if (len2 <= 1.0) {
            // point is on the sphere
            return [nx, ny, Math.sqrt(1.0 - len2)];
        } else {
            // outside sphere — project onto edge
            const n = Math.sqrt(len2);
            return [nx / n, ny / n, 0];
        }    
    }
}

// Initialize the application when the page loads
window.addEventListener('DOMContentLoaded', () => {
    new MainApp();
});


