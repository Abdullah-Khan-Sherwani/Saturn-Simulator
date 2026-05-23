class Texture {
    constructor(gl, textureUnit, imgSrc, {
        flipY       = true,
        placeholderColor = [0, 0, 0, 255],
        minFilter   = gl.NEAREST_MIPMAP_LINEAR,
        magFilter   = gl.LINEAR,
        wrapS       = gl.REPEAT,
        wrapT       = gl.REPEAT,
    } = {}) {
        this.gl          = gl;
        this.textureUnit = textureUnit;

        // create texture
        this.ID = gl.createTexture();
        this.bind();

        // set texture filtering parameters
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, minFilter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, magFilter);

        // fill the texture with a 1x1 pixel of the specified placeholder color
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(placeholderColor));

        // set texture wrapping parameters
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrapS);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrapT);

        // asynchronously load an image
        if(imgSrc != '') {
            const img = new Image();
            img.src = imgSrc;
            img.addEventListener('load', () => {
                this.bind();
                gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, flipY);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
                gl.generateMipmap(gl.TEXTURE_2D);
            });        
        }
    }

    // bind the texture to its texture unit
    bind() {
        this.gl.activeTexture(this.textureUnit);
        this.gl.bindTexture(this.gl.TEXTURE_2D, this.ID);
    }

    // set the corresponding sampler uniform on a shader
    setSamplerUniform(shader, uniformName) {
        const unitIndex = this.textureUnit - this.gl.TEXTURE0;
        shader.setInt(uniformName, unitIndex);
    }
}