// Load model using webgl-obj-loader
// https://github.com/frenchtoast747/webgl-obj-loader

// FPS Camera

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
        
        // setting up camera
        this.camera = new Camera({ 
            position: glMatrix.vec3.fromValues(0, 0, 5)
        });

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
        const [objResponse, mtlResponse] = await Promise.all([
            fetch(this.modelPath+'survival_guitar_backpack.obj'),
            fetch(this.modelPath+'survival_guitar_backpack.mtl')
        ]);

        const [objText, mtlText] = await Promise.all([
            objResponse.text(),
            mtlResponse.text()
        ]);

        // parse .obj and .mtl files
        this.mesh = new OBJ.Mesh(objText);
        this.materials = new OBJ.MaterialLibrary(mtlText);
        console.log(this.mesh);

        // each mesh group has a materialName
        // for (const groupName in this.mesh.materialsByIndex) {
        //     const matName = this.mesh.materialsByIndex[groupName];
        //     const mat = this.materials.materials[matName];
        //     console.log(mat);  // has Kd, Ks, Ka, map_Kd etc
        // }        

        this.VAO = gl.createVertexArray(); 
        gl.bindVertexArray(this.VAO);
        OBJ.initMeshBuffers(gl, this.mesh);
        console.log('Vertices: ' + this.mesh.vertices.length);
        console.log('Textures: ' + this.mesh.tex);
        console.log('Normals: ' + this.mesh.normalBuffer.numItems);
        console.log('Indices: ' + this.mesh.indexBuffer.numItems);

        // calculate world dimensions
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        const v = this.mesh.vertices;
        for (let i = 0; i < v.length; i += 3) {
            if (v[i]   < minX) minX = v[i];
            if (v[i]   > maxX) maxX = v[i];
            if (v[i+1] < minY) minY = v[i+1];
            if (v[i+1] > maxY) maxY = v[i+1];
            if (v[i+2] < minZ) minZ = v[i+2];
            if (v[i+2] > maxZ) maxZ = v[i+2];
        }
        this.dim = {
            min: [minX, minY, minZ],
            max: [maxX, maxY, maxZ],
            size: [maxX - minX, maxY - minY, maxZ - minZ],
            center: [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2],
        };

        const aPos = gl.getAttribLocation(this.shader.ID, "aPos");
        gl.enableVertexAttribArray(aPos);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.mesh.vertexBuffer);
        gl.vertexAttribPointer(aPos, this.mesh.vertexBuffer.itemSize, gl.FLOAT, false, 0, 0);

        const aTexCoord = gl.getAttribLocation(this.shader.ID, "aTexCoord");
        gl.enableVertexAttribArray(aTexCoord);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.mesh.textureBuffer);
        gl.vertexAttribPointer(aTexCoord, this.mesh.textureBuffer.itemSize, gl.FLOAT, false, 0, 0);

        const aNormal = gl.getAttribLocation(this.shader.ID, "aNormal");
        gl.enableVertexAttribArray(aNormal);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.mesh.normalBuffer);
        gl.vertexAttribPointer(aNormal, this.mesh.normalBuffer.itemSize, gl.FLOAT, false, 0, 0);

        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.mesh.indexBuffer);

        //clear VAO
        gl.bindVertexArray(null); 
    }

    initTextures() {
        const gl = this.gl;

        const mat = Object.values(this.materials.materials)[0];
        const hasDiffuse  = mat.mapDiffuse  && mat.mapDiffuse.filename;
        const hasSpecular = mat.mapSpecular && mat.mapSpecular.filename;
        console.log('diffuse map:', hasDiffuse  ? mat.mapDiffuse.filename  : 'none');
        console.log('specular map:', hasSpecular ? mat.mapSpecular.filename : 'none');

        // new Texture create 1x1 texture if filename is empty
        this.shader.use();
        let diffuseMapFile = '';
        if(hasDiffuse) diffuseMapFile = this.modelPath+mat.mapDiffuse.filename;
        this.diffuseMap =  new Texture(gl, gl.TEXTURE0, diffuseMapFile, {placeholderColor: [0, 255, 0, 255] });
        this.diffuseMap.setSamplerUniform(this.shader, 'material.diffuse');

        let specularMapFile = ''; 
        if(hasSpecular) specularMapFile = this.modelPath+mat.mapSpecular.filename;
        this.specularMap =  new Texture(gl, gl.TEXTURE1, specularMapFile, {placeholderColor: [0, 0, 0, 255] });
        this.specularMap.setSamplerUniform(this.shader, 'material.specular');
    }

    // setup model matrix once here, as it won't get update in rendering loo[]
    initUniforms() {        
        this.shader.use();

        const [sx, sy, sz] = this.dim.size;
        const scale = 2.0 / Math.max(sx, sy, sz);
        glMatrix.mat4.fromScaling(this.model, [scale, scale, scale]);
        glMatrix.mat4.translate(this.model, this.model, [
            -this.dim.center[0],
            -this.dim.center[1],
            -this.dim.center[2]
        ]);
        this.shader.setMat4('model', this.model);

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

        // process keyboard input for camera movement
        if (this.keys['w']) this.camera.processKeyboard('FORWARD', deltaTime); 
        if (this.keys['s']) this.camera.processKeyboard('BACKWARD', deltaTime); 
        if (this.keys['a']) this.camera.processKeyboard('LEFT', deltaTime); 
        if (this.keys['d']) this.camera.processKeyboard('RIGHT', deltaTime); 

        // clear color and depth buffers
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        // activate the shader program and VAO, bind texture 
        this.shader.use();
        gl.bindVertexArray(this.VAO);
        this.diffuseMap.bind();
        this.specularMap.bind();
        
        // update transformation matrices
        glMatrix.mat4.perspective(this.projection,
            glMatrix.glMatrix.toRadian(this.camera.Zoom),   // field of view
            gl.canvas.clientWidth / gl.canvas.clientHeight, // aspect ratio 
            0.1,                                       // near plane
            100.0                                      // far plane
        );    
        this.camera.getViewMatrix(this.view);

        // update uniforms
        this.shader.setMat4('view', this.view);
        this.shader.setMat4('projection', this.projection);
        this.shader.setVec3v('light.position', this.camera.Position);
        this.shader.setVec3v('viewPos', this.camera.Position);

        // draw
        gl.drawElements(gl.TRIANGLES, this.mesh.indexBuffer.numItems, gl.UNSIGNED_SHORT, 0);
        
        // const err = gl.getError();
        // if (err !== gl.NO_ERROR) console.error('GL error:', err);

        gl.bindVertexArray(null);

        requestAnimationFrame((now) => this.render(now));
    }

    setupEventListeners() {
        window.addEventListener('keydown', e => this.keys[e.key] = true);
        window.addEventListener('keyup',   e => this.keys[e.key] = false);

        // Request pointer lock on click 
        this.canvas.addEventListener('click', () => { this.canvas.requestPointerLock(); });    
        // ---- Mouse move handling for camera rotation ----
        document.addEventListener('mousemove', (e) => {
            if (document.pointerLockElement !== this.canvas) return;
            this.camera.processMouseMovement(e.movementX, -e.movementY);
        });    

        // set up mouse wheel handling for zooming
        this.canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            this.camera.processMouseScroll(e.deltaY);
        }, { passive: false });
    }

}

// Initialize the application when the page loads
window.addEventListener('DOMContentLoaded', () => {
    new MainApp();
});


