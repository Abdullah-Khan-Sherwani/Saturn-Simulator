import { mat4, mat3, vec3 } from 'gl-matrix';
import { mkProg, makeVAO, glBuf, glTex2D, glTexCubeFromImages,
         mkRenderTarget, freeRenderTarget, drawVAO, cacheUniforms, bindTex } from './gl-utils.js';
import { loadImage, loadCubemapFaces, boundsOf } from './geometry.js';
import { loadGLTF, extractMeshes } from './gltf-loader.js';
import { SKYBOX_VS, SKYBOX_FS, POST_VS,
         BRIGHT_FS, BLUR_FS, COMPOSITE_FS, PLANET_VS, PLANET_FS } from './shaders.js';

/* ── Module-level constants ───────────────────────────────────────────────── */

const ENC_ORBIT_R = 15;  // Enceladus orbit radius in world units — far enough to be
                          // visually distinct from Saturn, close enough to stay in frame
const SUN_COL     = new Float32Array([1.0, 0.97, 0.85]);  // warm white sunlight
const SUN_DIR_RAW = [-0.6, -0.2, -0.8];  // un-normalised sun direction; normalised below

/* Saturn's pole (and the ring-disc normal) is local +Z. To spin the planet
   without tumbling the rings we spin about local Z and apply a FIXED tilt that
   tips the pole away from +Z. SAT_TILT is Saturn's real axial tilt (obliquity). */
const SAT_TILT = 56.73 * Math.PI / 180;  // 26.73° converted to radians: deg * π/180
const SAT_SPIN = 0.15;                   // body spin rate (radians per frame counter step)
                                         // spinning about Z leaves the ring-disc normal unchanged

/* isRing: identifies ring meshes by name in the GLB.
   The downloaded saturn.glb names ring primitives with "saturn2" in the node name.
   We use this to split opaque-body vs. transparent-ring rendering paths. */
const isRing = m => /saturn2/.test(m.name);

async function main() {
  const msgEl  = document.getElementById('msg');
  const canvas = document.getElementById('c');

  /* WebGL 2.0 context — required for:
       #version 300 es shaders, Uint32 index buffers, DEPTH_COMPONENT24,
       VAO support without an extension, TEXTURE_WRAP_R for cubemaps. */
  const gl = canvas.getContext('webgl2');
  if (!gl) { msgEl.textContent = 'WebGL 2.0 not supported.'; return; }

  /* ── DPR-aware canvas resize ──────────────────────────────────────────── */
  const resize = () => {
    /* window.devicePixelRatio: physical pixels per CSS pixel.
       On a Retina display this is 2; without DPR scaling the OS would upscale
       the framebuffer, producing blurry output.
       Math.min(..., 2): cap at 2× — DPR=3 phones would cost 9× fill rate for
       marginal quality gain.
       | 0: bitwise-OR with 0 truncates to integer (fast floor). */
    const dpr = Math.min(window.devicePixelRatio, 2);
    canvas.width  = (canvas.clientWidth  * dpr) | 0;
    canvas.height = (canvas.clientHeight * dpr) | 0;
  };
  resize();
  window.addEventListener('resize', resize);

  /* ── Load models ───────────────────────────────────────────────────────── */
  const fmtMB = e => e.lengthComputable
    ? `${(e.loaded/1048576).toFixed(1)} / ${(e.total/1048576).toFixed(0)} MB`
    : `${(e.loaded/1048576).toFixed(1)} MB`;

  msgEl.textContent = 'Loading Saturn…';
  /* Promise.all: fires both XHR requests in parallel.
     Total wait = max(satTime, encTime) instead of satTime + encTime. */
  const [satGLTF, encGLTF] = await Promise.all([
    loadGLTF('/saturn.glb',    e => { msgEl.textContent = 'Saturn: '    + fmtMB(e); }),
    loadGLTF('/enceladus.glb', e => { msgEl.textContent = 'Enceladus: ' + fmtMB(e); }),
  ]);

  msgEl.textContent = 'Building GPU buffers…';
  /* The downloaded saturn.glb bundles Mimas and Enceladus as child nodes at the
     wrong scale and position for this scene — filter them out by name. */
  const satMeshes = extractMeshes(satGLTF).filter(m => !/(mimas|enceladus)/.test(m.name));
  const encMeshes = extractMeshes(encGLTF);
  if (!satMeshes.length) throw new Error('No meshes in saturn.glb');
  if (!encMeshes.length) throw new Error('No meshes in enceladus.glb');


  /* ── Programs ──────────────────────────────────────────────────────────── */
  /* mkProg compiles and links a vertex + fragment shader pair into a GPU program.
     POST_VS is reused for all three post-processing passes — they all draw the
     same full-screen quad and only differ in their fragment shaders. */
  const skyProg    = mkProg(gl, SKYBOX_VS,  SKYBOX_FS);   // skybox + procedural sun
  const planetProg = mkProg(gl, PLANET_VS,  PLANET_FS);   // Saturn, rings, Enceladus
  const brightProg = mkProg(gl, POST_VS,    BRIGHT_FS);   // bloom pass 1: extract brights
  const blurProg   = mkProg(gl, POST_VS,    BLUR_FS);     // bloom pass 2-3: Gaussian blur
  const compProg   = mkProg(gl, POST_VS,    COMPOSITE_FS);// bloom pass 4: additive composite

  /* ── Full-screen quad VAO (skybox + post passes) ──────────────────────── */
  /* Manually built because the quad only needs the 'a_Pos' attribute (2D NDC)
     and is used with skyProg's layout — makeVAO() is for the 3-attribute planetProg. */
  const quadVAO = gl.createVertexArray();
  gl.bindVertexArray(quadVAO);
  /* Four 2D NDC vertices: bottom-left, bottom-right, top-left, top-right.
     Drawn as TRIANGLE_STRIP: (v0,v1,v2) + (v1,v2,v3) = two triangles = full quad. */
  const qBuf = glBuf(gl, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]));
  gl.bindBuffer(gl.ARRAY_BUFFER, qBuf);
  const qLoc = gl.getAttribLocation(skyProg, 'a_Pos');
  gl.enableVertexAttribArray(qLoc);
  /* gl.vertexAttribPointer(location, numComponents, dataType, normalise, stride, offset)
       location=qLoc: shader attribute slot for 'a_Pos'
       numComponents=2: each vertex is an (x,y) pair
       gl.FLOAT: 32-bit float
       false: do not normalise (already in [-1,1])
       stride=0: tightly packed (next vertex immediately follows)
       offset=0: start at byte 0 of the buffer */
  gl.vertexAttribPointer(qLoc, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  /* ── Textures ──────────────────────────────────────────────────────────── */
  const satBodyImg = await loadImage('/8k_saturn.jpg');
  const satBodyTex = glTex2D(gl, satBodyImg);  // 8K Saturn surface photo (shared by all body meshes)

  /* Radial ring-opacity strip (8192×500 RGBA): alpha = ring opacity from inner
     to outer edge — drives the translucent ring shadow on Saturn & Enceladus.
     The alpha channel encodes real ring density (dense B-ring, Cassini Division, etc.). */
  const ringAlphaImg = await loadImage('/8k_saturn_ring_alpha.png');
  const ringAlphaTex = glTex2D(gl, ringAlphaImg);

  /* Ring meshes use their embedded GLB texture (m.image); body meshes share satBodyTex.
     This is a texture-atlas strategy: one 8K image for all non-ring geometry. */
  const satGPU     = satMeshes.map(m => makeVAO(gl, planetProg, m));
  const satTex     = satMeshes.map(m =>
    isRing(m) ? (m.image ? glTex2D(gl, m.image) : null) : satBodyTex
  );
  const satSpecTex = satMeshes.map(m => m.specImage ? glTex2D(gl, m.specImage) : null);
  const encGPU     = encMeshes.map(m => makeVAO(gl, planetProg, m));
  const encTex     = encMeshes.map(m => m.image    ? glTex2D(gl, m.image)     : null);
  const encSpecTex = encMeshes.map(m => m.specImage ? glTex2D(gl, m.specImage) : null);

  /* Pre-split Saturn into body-only and ring-only lists so the render loop can
     draw all opaques before any transparent rings, keeping Enceladus correctly
     depth-sorted against the rings regardless of camera angle.
     Body meshes write to the depth buffer; ring meshes only read it (depthMask=false). */
  const satBodyIdx  = satMeshes.map((_, i) => i).filter(i => !isRing(satMeshes[i]));
  const satRingIdx  = satMeshes.map((_, i) => i).filter(i =>  isRing(satMeshes[i]));
  const satBodyGPU   = satBodyIdx.map(i => satGPU[i]),     satRingGPU   = satRingIdx.map(i => satGPU[i]);
  const satBodyMeshes = satBodyIdx.map(i => satMeshes[i]), satRingMeshes = satRingIdx.map(i => satMeshes[i]);
  const satBdyTex    = satBodyIdx.map(i => satTex[i]),     satRingTex   = satRingIdx.map(i => satTex[i]);
  const satBodySpec  = satBodyIdx.map(i => satSpecTex[i]), satRingSpec  = satRingIdx.map(i => satSpecTex[i]);

  /* ── Uniform locations ─────────────────────────────────────────────────── */
  /* cacheUniforms calls gl.getUniformLocation once per name at startup, storing
     the WebGLUniformLocation objects. Every gl.uniform*() call in the render loop
     uses these cached locations — avoids string lookups per frame. */
  const U = cacheUniforms(gl, planetProg, [
    'u_MVP','u_M','u_N','u_LDir','u_LCol','u_Base','u_Cam',
    'u_Shin','u_SpecK','u_Alpha','u_TexOn','u_Tex','u_AlphaCutoff',
    'u_SpecTexOn','u_SpecTex','u_SpecUV','u_SpecFactor','u_GlossFactor','u_UVRepeat','u_UVOffset',
    'u_EnvMap','u_EnvStr','u_FogDensity','u_FogColor','u_OccluderCenter','u_OccluderR',
    'u_Occluder2Center','u_Occluder2R',
    'u_RingShadowOn','u_RingNormal','u_RingCenter','u_RingInner','u_RingOuter',
    'u_RingAlphaTex','u_RingShadowStr',
  ]);
  const SkyU   = cacheUniforms(gl, skyProg,    ['u_Skybox','u_InvViewProj','u_Cam','u_SunDir','u_SunCol']);
  const BrightU = cacheUniforms(gl, brightProg, ['u_Img','u_Threshold']);
  const BlurU   = cacheUniforms(gl, blurProg,   ['u_Img','u_Texel','u_Dir']);
  const CompU   = cacheUniforms(gl, compProg,   ['u_Scene','u_Bloom','u_Strength']);

  /* ── Scene constants ───────────────────────────────────────────────────── */
  const spaceCubemap = glTexCubeFromImages(gl, await loadCubemapFaces('/cubemap_starmap_2020_1024'));

  /* boundsOf returns the AABB centre (cx,cy,cz) and bounding radius r of a mesh.
     r = half the longest axis extent — used as the occluder sphere radius and to
     compute the uniform scale factor sS/eS that fits the model into world units. */
  const satBodyMesh   = satMeshes.find(m => !isRing(m)) ?? satMeshes[0];
  const eB = boundsOf(encMeshes[0].pos);  // Enceladus bounding box
  const sB = boundsOf(satBodyMesh.pos);   // Saturn body bounding box

  /* Scale factors: sS = 3.2 / sB.r → after scaling, Saturn's radius = 3.2 world units.
     satBodyRadius = sS * sB.r = (3.2 / sB.r) * sB.r = exactly 3.2 — used as the
     occluder sphere radius in the analytical shadow test. */
  const sS = 3.2  / sB.r;
  const eS = 0.42 / eB.r;
  const satBodyRadius = sS * sB.r;  // = 3.2 world units (exact)

  /* Ring annulus radii (world units). The rings lie in Saturn's equatorial
     plane — local XY, normal local +Z (confirmed across all ring chunks) — and
     are concentric with the body, so radius = hypot(x,y) about the body centre,
     scaled by the same factor that maps the body into the scene.
     We measure directly from the GLB vertex positions so the shader's annulus
     test matches the actual geometry, regardless of the artist's export scale. */
  let ringInnerLocal = Infinity, ringOuterLocal = 0;
  for (const m of satRingMeshes)
    for (let i = 0; i < m.pos.length; i += 3) {
      /* Math.hypot(dx, dy) = sqrt(dx² + dy²): Euclidean distance in the XY plane.
         We subtract the body centre (sB.cx/cy) because the GLB mesh origin may not
         be at the geometric centre. */
      const r = Math.hypot(m.pos[i] - sB.cx, m.pos[i + 1] - sB.cy);
      if (r < ringInnerLocal) ringInnerLocal = r;
      if (r > ringOuterLocal) ringOuterLocal = r;
    }
  const ringInner = sS * ringInnerLocal;  // scale from model units to world units
  const ringOuter = sS * ringOuterLocal;
  const ringNormal = vec3.create();  // reused buffer; filled each frame from the model matrix

  /* Normalise the sun direction once. vec3.normalize(out, a): out = a / |a|.
     The result is a unit vector used for both directional lighting and sun-disk rendering. */
  const SUN_DIR = vec3.normalize(vec3.create(), SUN_DIR_RAW);

  /* ── View mode ─────────────────────────────────────────────────────────── */
  let viewMode = 'saturn', satCamR = 22.0, encCamR = 3.0;
  const modeEl = document.getElementById('view-mode');
  window.addEventListener('keydown', e => {
    if (e.key !== 'e' && e.key !== 'E') return;
    viewMode = viewMode === 'saturn' ? 'enceladus' : 'saturn';
    /* Reset camera angles when switching targets so the new target is
       shown from a clean front-facing view rather than an arbitrary angle. */
    camRx = 0.1; camRy = 0.0;
    if (modeEl) modeEl.textContent = viewMode === 'enceladus' ? 'VIEW: ENCELADUS' : 'VIEW: SATURN';
  });

  /* ── Camera (mouse + touch + scroll) ──────────────────────────────────── */
  /* camRx = pitch (vertical orbit angle), camRy = yaw (horizontal orbit angle).
     Both are in radians. Initial camRx=0.22 tilts slightly downward from equator
     so the rings are visible at the start. */
  let camRx = 0.22, camRy = 0.0, dragging = false, px = 0, py = 0;
  const onDown = (x, y) => { dragging = true; px = x; py = y; };
  const onUp   = ()      => { dragging = false; };
  const onMove = (x, y) => {
    if (!dragging) return;
    /* 0.005 rad/pixel — converts pixel drag distance to angle change.
       Horizontal drag (x) maps to yaw; vertical (y) maps to pitch. */
    camRy += (x - px) * 0.005; camRx += (y - py) * 0.005;
    /* Clamp pitch to ±1.45 rad (≈±83°). At exactly ±π/2 the yaw axis collapses
       (gimbal lock) and the camera flips; clamping just short prevents this. */
    camRx = Math.max(-1.45, Math.min(1.45, camRx));
    px = x; py = y;
  };
  canvas.addEventListener('mousedown',  e => onDown(e.clientX, e.clientY));
  window.addEventListener('mouseup',    onUp);
  window.addEventListener('mousemove',  e => onMove(e.clientX, e.clientY));
  canvas.addEventListener('touchstart', e => { onDown(e.touches[0].clientX, e.touches[0].clientY); e.preventDefault(); }, { passive: false });
  window.addEventListener('touchend',   onUp);
  window.addEventListener('touchmove',  e => onMove(e.touches[0].clientX, e.touches[0].clientY));
  canvas.addEventListener('wheel', e => {
    /* e.deltaY > 0 = scroll down = zoom out (increase radius).
       Separate clamp ranges for each view: Saturn [4, 120], Enceladus [1.2, 15]. */
    if (viewMode === 'saturn') satCamR = Math.max(4,   Math.min(120, satCamR + e.deltaY * 0.06));
    else                       encCamR = Math.max(1.2, Math.min(15,  encCamR + e.deltaY * 0.02));
    /* preventDefault stops the page from scrolling while the user zooms. */
    e.preventDefault();
  }, { passive: false });  // passive:false required to call preventDefault inside a wheel handler

  /* ── Render targets (lazy resize) ──────────────────────────────────────── */
  /* proj/view/vp/invVP are pre-allocated mat4 objects and reused each frame
     to avoid garbage-collecting a new Float32Array every frame. */
  const proj = mat4.create(), view = mat4.create(), vp = mat4.create(), invVP = mat4.create();
  let sceneRT = null, bloomA = null, bloomB = null, rtW = 0, rtH = 0;

  const ensureTargets = (w, h) => {
    /* No-op if size hasn't changed — avoids reallocating GPU textures every frame. */
    if (w === rtW && h === rtH && sceneRT) return;
    /* Free old GPU resources before allocating new ones to prevent memory leaks. */
    [sceneRT, bloomA, bloomB].forEach(rt => freeRenderTarget(gl, rt));
    /* sceneRT: has a depth buffer (withDepth=true) for the 3D geometry pass.
       bloomA/bloomB: colour-only FBOs, ping-ponged during the blur passes. */
    sceneRT = mkRenderTarget(gl, w, h, true);
    bloomA  = mkRenderTarget(gl, w, h, false);
    bloomB  = mkRenderTarget(gl, w, h, false);
    rtW = w; rtH = h;
  };

  /* ── Draw one body ─────────────────────────────────────────────────────── */
  /* renderGroup draws a list of meshes (all belonging to one body, e.g. Saturn
     or Enceladus) using a shared model matrix. Body meshes are drawn before ring
     meshes within the same call so depth is written first.

     Parameters:
       gpuList     — array of VAO objects (from makeVAO)
       meshList    — array of mesh descriptor objects (name, material props, etc.)
       texList     — array of WebGL diffuse texture objects (or null)
       specTexList — array of WebGL specular texture objects (or null)
       modelMat    — mat4 model matrix for this body
       envStrength — environment reflection strength for this body */
  function renderGroup(gpuList, meshList, texList, specTexList, modelMat, envStrength) {
    /* u_MVP = vp * modelMat: transforms object space → clip space.
       mat4.multiply(out, a, b): out = a * b. */
    gl.uniformMatrix4fv(U.u_MVP, false, mat4.multiply(mat4.create(), vp, modelMat));
    gl.uniformMatrix4fv(U.u_M,   false, modelMat);
    /* Normal matrix = transpose(inverse(upper-left 3×3 of modelMat)).
       mat3.normalFromMat4(out, mat4): computes this in one call.
       Required because using the model matrix directly for normals would skew
       them under non-uniform scale. */
    gl.uniformMatrix3fv(U.u_N,   false, mat3.normalFromMat4(mat3.create(), modelMat));

    const drawMesh = (g, m, tex, specTex, ring) => {
      gl.uniform1f (U.u_Alpha,       ring ? 1.0 : m.opacity);  // rings: full alpha (blending handles transparency)
      gl.uniform1f (U.u_AlphaCutoff, 0.0);     // 0 = no alpha-test discard
      gl.uniform2fv(U.u_UVRepeat,    m.uvRepeat ?? [1, 1]);
      gl.uniform2fv(U.u_UVOffset,    m.uvOffset ?? [0, 0]);
      gl.uniform1f (U.u_EnvStr,      ring ? 0.04 : envStrength);
      /* Rings pass 0.0 so ringShadow() returns immediately — prevents the ring
         geometry from casting a shadow on itself. */
      gl.uniform1f (U.u_RingShadowOn, ring ? 0.0 : 1.0);

      /* No backface culling: rings are viewed from both sides (above and below
         the ring plane); planet interiors are sometimes visible in close-up. */
      gl.disable(gl.CULL_FACE);
      if (ring) {
        /* Alpha blending: C_out = C_src*α + C_dst*(1-α) — Porter-Duff "over" composite.
           SRC_ALPHA: source factor = fragment alpha.
           ONE_MINUS_SRC_ALPHA: destination factor = (1 - fragment alpha). */
        gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        /* depthMask(false): rings read the depth buffer (for correct occlusion by Saturn
           and Enceladus) but do NOT write to it. If rings wrote depth, their transparent
           regions would block geometry behind them from being drawn later. */
        gl.depthMask(false);
        /* Polygon offset: shifts ring depth values slightly further from the camera.
           The rings are flat geometry nearly coplanar with Saturn's body surface;
           without offset the overlapping polys Z-fight (randomly win/lose the depth test).
           polygonOffset(factor=1.0, units=1.0): depth += factor*dSlope + units*r
           where dSlope is the polygon's depth gradient and r is the smallest depth value
           the hardware can resolve. Effect: ring pixels always lose to body pixels. */
        gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(1.0, 1.0);
      } else {
        gl.disable(gl.BLEND);    // opaque geometry: source colour fully replaces framebuffer
        gl.depthMask(true);      // write depth so subsequent geometry can be depth-tested against this
        gl.disable(gl.POLYGON_OFFSET_FILL);
      }

      if (tex) {
        /* bindTex activates a texture unit, binds the texture, and sets the sampler uniform.
           TEXTURE0 = slot 0 for the diffuse texture (u_Tex in the shader). */
        bindTex(gl, gl.TEXTURE0, gl.TEXTURE_2D, tex, U.u_Tex, 0);
        gl.uniform1i(U.u_TexOn, 1);  // tell the shader to sample u_Tex
      } else {
        gl.uniform3fv(U.u_Base, m.color); gl.uniform1i(U.u_TexOn, 0);  // flat colour fallback
      }

      /* Spec map (body → img1 with UV1; ring saturn2_A → img4 with UV1). RGB is
         the specular colour, alpha the glossiness, both scaled by the material's
         specular/glossiness factors and sampled with the map's authored UV set.
         Meshes without a spec map (saturn2_B, Enceladus) keep the flat u_SpecK /
         u_Shin fallback. */
      if (specTex) {
        bindTex(gl, gl.TEXTURE2, gl.TEXTURE_2D, specTex, U.u_SpecTex, 2);  // slot 2
        gl.uniform1i (U.u_SpecTexOn,  1);
        gl.uniform1f (U.u_SpecUV,     m.specUV ?? 0);       // 0=UV0, 1=UV1
        gl.uniform3fv(U.u_SpecFactor, m.specFactor ?? [1, 1, 1]);
        gl.uniform1f (U.u_GlossFactor, m.glossFactor ?? 1.0);
      } else {
        gl.uniform1i(U.u_SpecTexOn, 0);
        /* Flat scalar specular for ring segments without a spec map. */
        if (ring) { gl.uniform1f(U.u_Shin, 12.0); gl.uniform1f(U.u_SpecK, 0.45); }
      }

      drawVAO(gl, g);  // bind VAO and issue the draw call (drawElements or drawArrays)
    };

    /* Body meshes first — writes depth so rings behind planet are correctly clipped. */
    gpuList.forEach((g, i) => { if (!isRing(meshList[i])) drawMesh(g, meshList[i], texList[i], specTexList[i], false); });
    /* Ring meshes second — depth-tested against body, no depth write, alpha blended. */
    gpuList.forEach((g, i) => { if ( isRing(meshList[i])) drawMesh(g, meshList[i], texList[i], specTexList[i], true);  });
  }

  /* ── Render loop ───────────────────────────────────────────────────────── */
  let t = 0;  // frame counter — used as a time proxy for animations
  function frame() {
    t += 0.004;  // advance time (not wall-clock — consistent regardless of frame rate)
    resize();
    const W = canvas.width, H = canvas.height;
    ensureTargets(W, H);  // reallocate FBOs only if canvas size changed

    /* ── Enceladus orbit position ─────────────────────────────────────────
       Circular orbit in the XZ plane at radius ENC_ORBIT_R.
       encAngle = t * 0.70 radians — orbital angular velocity.
       x = R·cos(θ): horizontal position
       z = -R·sin(θ): depth position (negative so the orbit goes the right way visually)
       y = 0: Enceladus orbits in the equatorial plane (slight X-tilt added in the model matrix). */
    const encAngle = t * 0.70;
    const encWorld = [ENC_ORBIT_R * Math.cos(encAngle), 0, -ENC_ORBIT_R * Math.sin(encAngle)];

    /* ── Arcball orbit camera ─────────────────────────────────────────────
       Camera sits on a sphere of radius camR centred on ctr.
       Spherical → Cartesian conversion:
         x = R · sin(yaw) · cos(pitch)   (right/left)
         y = R · sin(pitch)              (up/down)
         z = R · cos(yaw) · cos(pitch)   (forward/back)
       camRy = yaw (horizontal drag), camRx = pitch (vertical drag). */
    const isEnc  = viewMode === 'enceladus';
    const ctr    = isEnc ? encWorld : [0, 0, 0];  // orbit target: Enceladus or Saturn origin
    const camR   = isEnc ? encCamR  : satCamR;
    const camPos = new Float32Array([
      ctr[0] + camR * Math.sin(camRy) * Math.cos(camRx),
      ctr[1] + camR * Math.sin(camRx),
      ctr[2] + camR * Math.cos(camRy) * Math.cos(camRx),
    ]);

    /* ── View and projection matrices ─────────────────────────────────────
       mat4.perspective(out, fovY_rad, aspect, near, far):
         fovY = π/4 rad = 45° vertical field of view
         aspect = W/H = canvas width ÷ height
         near = 0.1, far = 8000 (generous far plane for distant geometry)
       mat4.lookAt(out, eye, center, up):
         Constructs a view matrix placing the camera at camPos, looking at ctr,
         with +Y as the up direction. */
    mat4.perspective(proj, Math.PI / 4, W / H, 0.1, 8000.0);
    mat4.lookAt(view, camPos, ctr, [0, 1, 0]);
    /* vp = proj * view: combined view-projection matrix.
       mat4.multiply(out, a, b): out = a * b */
    mat4.multiply(vp, proj, view);
    /* invVP: inverse of the VP matrix. Passed to SKYBOX_FS to unproject NDC
       fragment positions back to world-space ray directions. */
    mat4.invert(invVP, vp);

    /* ════════════════════════════════════════════════════════════════════
       PASS 1 — render the full 3D scene to the offscreen FBO (sceneRT)
       ════════════════════════════════════════════════════════════════════ */
    gl.viewport(0, 0, W, H);
    gl.bindFramebuffer(gl.FRAMEBUFFER, sceneRT.fbo);  // redirect output to sceneRT instead of the canvas
    gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    /* ── Skybox (drawn first, depth test OFF) ───────────────────────────── */
    /* No depth test so the skybox never clips against anything. Since it writes
       z=0.9999 but the clear puts z=1 in the buffer, LEQUAL would pass anyway —
       disabling the test is just a safe defensive measure. */
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);
    gl.useProgram(skyProg);
    /* TEXTURE1 for the cubemap (TEXTURE0 will be used by the planet diffuse map).
       bindTex(gl, textureUnit, target, texture, uniformLocation, samplerSlot) */
    bindTex(gl, gl.TEXTURE1, gl.TEXTURE_CUBE_MAP, spaceCubemap, SkyU.u_Skybox, 1);
    gl.uniformMatrix4fv(SkyU.u_InvViewProj, false, invVP);
    gl.uniform3fv(SkyU.u_Cam,    camPos);
    gl.uniform3fv(SkyU.u_SunDir, SUN_DIR);   // sun disk + halo are drawn inside SKYBOX_FS
    gl.uniform3fv(SkyU.u_SunCol, SUN_COL);
    gl.bindVertexArray(quadVAO); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    /* ── Planet objects ─────────────────────────────────────────────────── */
    gl.enable(gl.DEPTH_TEST);
    /* LEQUAL instead of LESS: allows z=0.9999 skybox fragments to pass against
       the cleared depth of 1.0 without fighting. Also allows equal-depth redraws
       (polygon offset handles the near-coplanar ring case more precisely). */
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(planetProg);
    /* Shared per-frame uniforms — same sun light and camera for all objects. */
    gl.uniform3fv(U.u_LDir, SUN_DIR);
    gl.uniform3fv(U.u_LCol, SUN_COL);
    gl.uniform3fv(U.u_Cam,  camPos);
    gl.uniform1f (U.u_FogDensity, 0.013);  // e^(-0.013 * d): noticeable at d > ~50 world units
    gl.uniform3fv(U.u_FogColor, new Float32Array([0, 0, 0.018]));  // near-black deep blue
    /* Env map bound to TEXTURE1 — same slot for all planet draws. */
    bindTex(gl, gl.TEXTURE1, gl.TEXTURE_CUBE_MAP, spaceCubemap, U.u_EnvMap, 1);

    /* ── Saturn model matrix ──────────────────────────────────────────────
       Transform order (applied right-to-left in column-major convention):
         1. Translate: move model origin to the body's geometric centre
         2. Scale: fit from GLB model units to world units (radius = 3.2)
         3. RotateZ: spin about local +Z (the pole axis). Spinning about Z
            does NOT change the +Z axis direction, so the ring disc normal
            stays fixed — the surface bands animate but the shadow stays put.
         4. RotateX: apply the fixed axial tilt (tips the pole away from +Y).
            Using rotateX because Saturn's pole is local +Z; leaning it from
            vertical is a rotation about X. (Old code used rotateZ for tilt +
            rotateY for spin, which swept the ring normal in a circle.)

       mat4.rotateX(out, a, rad): out = a * Rx(rad)
       mat4.rotateZ(out, a, rad): out = a * Rz(rad)
       mat4.scale(out, a, [x,y,z]): out = a * Scale(x,y,z)
       mat4.translate(out, a, [x,y,z]): out = a * T(x,y,z) */
    const satM = mat4.create();
    mat4.rotateX (satM, satM, SAT_TILT);          // fixed lean: pole tips from +Y
    mat4.rotateZ (satM, satM, t * SAT_SPIN);       // spin about the tilted pole
    mat4.scale   (satM, satM, [sS, sS, sS]);       // uniform scale: model units → world units
    mat4.translate(satM, satM, [-sB.cx, -sB.cy, -sB.cz]);  // centre the body at local origin

    /* ── Ring plane normal from model matrix ──────────────────────────────
       The ring disc lies in local XY (normal = local +Z).
       In a column-major 4×4 matrix the columns are the transformed basis axes:
         column 0 (indices [0,1,2])  = transformed local +X
         column 1 (indices [4,5,6])  = transformed local +Y
         column 2 (indices [8,9,10]) = transformed local +Z  ← ring normal
       vec3.set(out, x, y, z): set the three components.
       vec3.normalize(out, a): out = a / |a| — make unit length. */
    vec3.set(ringNormal, satM[8], satM[9], satM[10]);
    vec3.normalize(ringNormal, ringNormal);
    /* Upload ring shadow parameters once — shared by Saturn body + Enceladus draws. */
    gl.uniform3fv(U.u_RingNormal, ringNormal);
    gl.uniform3fv(U.u_RingCenter, [0, 0, 0]);   // Saturn always at world origin
    gl.uniform1f (U.u_RingInner,  ringInner);
    gl.uniform1f (U.u_RingOuter,  ringOuter);
    gl.uniform1f (U.u_RingShadowStr, 0.9);       // 90% attenuation under dense ring
    bindTex(gl, gl.TEXTURE3, gl.TEXTURE_2D, ringAlphaTex, U.u_RingAlphaTex, 3);  // slot 3

    /* ── Enceladus model matrix ───────────────────────────────────────────
       Two rotateY calls implement orbit + tidal-lock-like spin:
         (innermost) translate + scale + rotateY(spin) = Enceladus spins on axis
         (outermost) rotateX(inclination) + rotateY(orbit) = entire thing orbits Saturn
       The world position encWorld uses the same angle (t*0.70) and radius,
       so it exactly matches where the matrix places Enceladus for the shadow test. */
    const encM = mat4.create();
    mat4.rotateY (encM, encM, t * 0.70);           // orbital rotation about Saturn
    mat4.rotateX (encM, encM, 0.09);               // slight orbital inclination (≈5°)
    mat4.translate(encM, encM, [ENC_ORBIT_R, 0, 0]);  // move to orbit radius along +X
    mat4.rotateY (encM, encM, t * 2.2);            // self-rotation (faster than orbit)
    mat4.scale   (encM, encM, [eS, eS, eS]);
    mat4.translate(encM, encM, [-eB.cx, -eB.cy, -eB.cz]);

    /* ── Draw order: opaques first, rings last ────────────────────────────
       1. Saturn body — opaque, depth written, eclipsed by Enceladus.
       2. Enceladus — opaque, depth written before rings are drawn, eclipsed by Saturn.
       3. Saturn rings — transparent, reads depth from 1&2, alpha blended,
          shadowed by both Saturn (broad band) and Enceladus (small dot). */

    /* 1. Saturn body — opaque, eclipsed by Enceladus */
    gl.uniform1f(U.u_Shin, 20.0); gl.uniform1f(U.u_SpecK, 0.10);
    /* Occluder = Enceladus (0.42 world-unit radius) — casts shadow on Saturn's surface. */
    gl.uniform3fv(U.u_OccluderCenter, encWorld); gl.uniform1f(U.u_OccluderR, 0.42);
    gl.uniform1f(U.u_Occluder2R, 0.0);                                          // 2nd slot unused
    renderGroup(satBodyGPU, satBodyMeshes, satBdyTex, satBodySpec, satM, 0.02);  // envStr=0.02: faint reflections

    /* 2. Enceladus — opaque, depth written before rings are drawn, eclipsed by Saturn */
    gl.uniform1f(U.u_Shin, 52.0); gl.uniform1f(U.u_SpecK, 0.65);  // icy surface: high gloss
    /* Occluder = Saturn body (3.2 world-unit radius). */
    gl.uniform3fv(U.u_OccluderCenter, [0, 0, 0]); gl.uniform1f(U.u_OccluderR, satBodyRadius);
    gl.uniform1f(U.u_Occluder2R, 0.0);                                          // 2nd slot unused
    renderGroup(encGPU, encMeshes, encTex, encSpecTex, encM, 0.18);  // envStr=0.18: icy reflections

    /* 3. Saturn rings — shadowed by BOTH Saturn's body (broad band) and Enceladus (small dot) */
    gl.uniform1f(U.u_Shin, 20.0); gl.uniform1f(U.u_SpecK, 0.10);
    gl.uniform3fv(U.u_OccluderCenter,  [0, 0, 0]); gl.uniform1f(U.u_OccluderR,  satBodyRadius);  // slot 1: Saturn
    gl.uniform3fv(U.u_Occluder2Center, encWorld);  gl.uniform1f(U.u_Occluder2R, 0.42);           // slot 2: Enceladus
    renderGroup(satRingGPU, satRingMeshes, satRingTex, satRingSpec, satM, 0.02);
    /* Rings leave depthMask=false. Restore it now so gl.clear(DEPTH_BUFFER_BIT)
       at the start of the next frame actually clears the depth buffer. */
    gl.depthMask(true);

    /* ════════════════════════════════════════════════════════════════════
       PASS 2 — bright-region extraction into bloomA
       ════════════════════════════════════════════════════════════════════ */
    gl.bindFramebuffer(gl.FRAMEBUFFER, bloomA.fbo);
    gl.viewport(0, 0, W, H); gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
    gl.useProgram(brightProg);
    /* Source: the 3D scene texture from pass 1. */
    bindTex(gl, gl.TEXTURE0, gl.TEXTURE_2D, sceneRT.tex, BrightU.u_Img, 0);
    gl.uniform1f(BrightU.u_Threshold, 0.62);  // discard pixels below luminance 0.62
    gl.bindVertexArray(quadVAO); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    /* ════════════════════════════════════════════════════════════════════
       PASS 3 — separable Gaussian blur: 6 ping-pong passes
       H→V→H→V→H→V = 3 horizontal + 3 vertical = wide, soft glow
       ════════════════════════════════════════════════════════════════════ */
    gl.useProgram(blurProg);
    /* u_Texel = (1/W, 1/H): the UV-space size of one pixel, so the shader
       steps exactly one pixel per offset unit regardless of resolution. */
    gl.uniform2f(BlurU.u_Texel, 1 / W, 1 / H);
    let readTex = bloomA.tex;
    for (let i = 0; i < 6; i++) {
      /* Even passes (0,2,4) = horizontal; odd passes (1,3,5) = vertical.
         Alternate writing to bloomB and bloomA (ping-pong). */
      const horiz = (i % 2) === 0, writeRT = horiz ? bloomB : bloomA;
      gl.bindFramebuffer(gl.FRAMEBUFFER, writeRT.fbo);
      bindTex(gl, gl.TEXTURE0, gl.TEXTURE_2D, readTex, BlurU.u_Img, 0);
      /* u_Dir: (1,0) = horizontal, (0,1) = vertical.
         The blur shader multiplies u_Dir * u_Texel * offset to step pixels. */
      gl.uniform2f(BlurU.u_Dir, horiz ? 1 : 0, horiz ? 0 : 1);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      readTex = writeRT.tex;  // the just-written texture becomes the next pass's source
    }

    /* ════════════════════════════════════════════════════════════════════
       PASS 4 — composite: scene + bloom → default framebuffer (canvas)
       ════════════════════════════════════════════════════════════════════ */
    /* bindFramebuffer(FRAMEBUFFER, null): restore the default framebuffer.
       Subsequent draw calls now render directly to the canvas (the screen). */
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(compProg);
    bindTex(gl, gl.TEXTURE0, gl.TEXTURE_2D, sceneRT.tex, CompU.u_Scene, 0);  // sharp 3D scene
    bindTex(gl, gl.TEXTURE1, gl.TEXTURE_2D, readTex,     CompU.u_Bloom, 1);  // blurred bloom
    gl.uniform1f(CompU.u_Strength, 1.05);  // bloom intensity: >1 ensures the glow is visible
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    /* Schedule the next frame. requestAnimationFrame(callback):
       - Calls callback just before the browser's next repaint (~16ms at 60fps)
       - Automatically pauses when the tab is backgrounded (saves GPU power)
       - Syncs to the display refresh rate (no tearing) */
    requestAnimationFrame(frame);
  }

  document.getElementById('loading').style.display = 'none';
  requestAnimationFrame(frame);  // kick off the animation loop
}

main().catch(err => {
  const msgEl = document.getElementById('msg');
  if (msgEl) msgEl.textContent = 'Error: ' + err.message;
  console.error(err);
});
