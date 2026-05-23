class Camera {
    static DEG_TO_RAD = Math.PI / 180;

    // Camera options
    MovementSpeed     = 2.5;
    MouseSensitivity  = 0.05;
    ScrollSensitivity = 0.015;
    Zoom              = 45;

    // Constructor with default parameters
    constructor({ position = glMatrix.vec3.fromValues(0, 0, 0),
                  up       = glMatrix.vec3.fromValues(0, 1, 0),
                  yaw      = -90,
                  pitch    =   0
    } = {}) {
        this.Position = glMatrix.vec3.clone(position);
        this.WorldUp  = glMatrix.vec3.clone(up);
        this.Yaw      = yaw;
        this.Pitch    = pitch;

        this.Front = glMatrix.vec3.fromValues(0, 0, -1);
        this.Up    = glMatrix.vec3.create();
        this.Right = glMatrix.vec3.create();

        this.updateCameraVectors();
    }

    getViewMatrix(view) {
        const target = glMatrix.vec3.create();
        glMatrix.vec3.add(target, this.Position, this.Front);
        glMatrix.mat4.lookAt(view, this.Position, target, this.Up);
    }

    processKeyboard(direction, deltaTime) {
        const velocity = this.MovementSpeed * deltaTime;
        if (direction === 'FORWARD')  
            glMatrix.vec3.scaleAndAdd(this.Position, this.Position, this.Front,  velocity);
        if (direction === 'BACKWARD') 
            glMatrix.vec3.scaleAndAdd(this.Position, this.Position, this.Front, -velocity);
        if (direction === 'LEFT')     
            glMatrix.vec3.scaleAndAdd(this.Position, this.Position, this.Right, -velocity);
        if (direction === 'RIGHT')    
            glMatrix.vec3.scaleAndAdd(this.Position, this.Position, this.Right,  velocity);
    }

    processMouseMovement(xoffset, yoffset, constrainPitch = true) {
        this.Yaw   += xoffset * this.MouseSensitivity;
        this.Pitch += yoffset * this.MouseSensitivity;

        // make sure that when pitch is out of bounds, screen doesn't get flipped
        if (constrainPitch) {
            if (this.Pitch >  89) this.Pitch =  89;
            if (this.Pitch < -89) this.Pitch = -89;
        }

        // update Front, Right and Up vectors using the updated Euler angles
        this.updateCameraVectors();
    }

    processMouseScroll(yoffset) {
        this.Zoom -= yoffset * this.ScrollSensitivity;
        if (this.Zoom <  1) this.Zoom =  1;
        if (this.Zoom > 45) this.Zoom = 45;
    }

    updateCameraVectors() {
        const yawR   = this.Yaw   * Camera.DEG_TO_RAD;
        const pitchR = this.Pitch * Camera.DEG_TO_RAD;

        const front = glMatrix.vec3.fromValues(
            Math.cos(yawR) * Math.cos(pitchR),
            Math.sin(pitchR),
            Math.sin(yawR) * Math.cos(pitchR)
        );
        glMatrix.vec3.normalize(this.Front, front);

        glMatrix.vec3.cross(this.Right, this.Front, this.WorldUp);
        glMatrix.vec3.normalize(this.Right, this.Right);

        glMatrix.vec3.cross(this.Up, this.Right, this.Front);
        glMatrix.vec3.normalize(this.Up, this.Up);
    }
}
