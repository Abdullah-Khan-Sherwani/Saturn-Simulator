class Shader {
    constructor(gl, vsSource, fsSource) {
        this.gl = gl;
        this.ID = this.initShaderProgram(vsSource, fsSource);
        this._locs = {};
    }

    _loc(name) {
        if (!(name in this._locs))
            this._locs[name] = this.gl.getUniformLocation(this.ID, name);
        return this._locs[name];
    }

    use()                          { this.gl.useProgram(this.ID); }

    setBool(name, value)           { this.gl.uniform1i(this._loc(name), value ? 1 : 0); }
    setInt(name, value)            { this.gl.uniform1i(this._loc(name), value); }
    setFloat(name, value)          { this.gl.uniform1f(this._loc(name), value); }

    setVec2(name, x, y)           { this.gl.uniform2f(this._loc(name), x, y); }
    setVec2v(name, value)          { this.gl.uniform2fv(this._loc(name), value); }

    setVec3(name, x, y, z)        { this.gl.uniform3f(this._loc(name), x, y, z); }
    setVec3v(name, value)          { this.gl.uniform3fv(this._loc(name), value); }

    setVec4(name, x, y, z, w)     { this.gl.uniform4f(this._loc(name), x, y, z, w); }
    setVec4v(name, value)          { this.gl.uniform4fv(this._loc(name), value); }

    setMat2(name, mat)             { this.gl.uniformMatrix2fv(this._loc(name), false, mat); }
    setMat3(name, mat)             { this.gl.uniformMatrix3fv(this._loc(name), false, mat); }
    setMat4(name, mat)             { this.gl.uniformMatrix4fv(this._loc(name), false, mat); }

    initShaderProgram(vsSource, fsSource) {
        const gl = this.gl;
        // load and compile vertex shader
        const vertexShader = gl.createShader(gl.VERTEX_SHADER);
        gl.shaderSource(vertexShader, vsSource.trim());
        gl.compileShader(vertexShader);
        if (!gl.getShaderParameter(vertexShader, gl.COMPILE_STATUS))
            console.log(gl.getShaderInfoLog(vertexShader));

        // load and compile fragment shader
        const fragmentShader = gl.createShader(gl.FRAGMENT_SHADER);
        gl.shaderSource(fragmentShader, fsSource.trim());
        gl.compileShader(fragmentShader);
        if (!gl.getShaderParameter(fragmentShader, gl.COMPILE_STATUS))
            console.log(gl.getShaderInfoLog(fragmentShader));

        // attach shaders to program and link
        const program = gl.createProgram();
        gl.attachShader(program, vertexShader);
        gl.attachShader(program, fragmentShader);
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS))
            console.log(gl.getProgramInfoLog(program));

        // delete once linked
        gl.deleteShader(vertexShader);
        gl.deleteShader(fragmentShader);

        return program;
    }
}

