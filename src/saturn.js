import { mat4, mat3, vec3 } from 'gl-matrix';
import { mkProg, makeVAO, glBuf, glTex2D, glTexCubeFromImages,
         mkRenderTarget, freeRenderTarget, drawVAO, cacheUniforms, bindTex } from './gl-utils.js';
import { loadImage, loadCubemapFaces, makeUvSphere, boundsOf } from './geometry.js';
import { loadGLTF, extractMeshes } from './gltf-loader.js';
import { SKYBOX_VS, SKYBOX_FS, SUN_VS, SUN_FS, POST_VS,
         BRIGHT_FS, BLUR_FS, COMPOSITE_FS, PLANET_VS, PLANET_FS } from './shaders.js';

const ENC_ORBIT_R = 15;
const SUN_COL     = new Float32Array([1.0, 0.97, 0.85]);
const SUN_DIR_RAW = [-0.6, -0.2, -0.8];

const isRing = m => /saturn2/.test(m.name);

async function main() {
  const msgEl  = document.getElementById('msg');
  const canvas = document.getElementById('c');
  const gl     = canvas.getContext('webgl2');
  if (!gl) { msgEl.textContent = 'WebGL 2.0 not supported.'; return; }

  const resize = () => {
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
  const [satGLTF, encGLTF] = await Promise.all([
    loadGLTF('/saturn.glb',    e => { msgEl.textContent = 'Saturn: '    + fmtMB(e); }),
    loadGLTF('/enceladus.glb', e => { msgEl.textContent = 'Enceladus: ' + fmtMB(e); }),
  ]);

  msgEl.textContent = 'Building GPU buffers…';
  // Strip bundled moons (Mimas, Enceladus) from saturn.glb — wrong scale/position for our scene
  const satMeshes = extractMeshes(satGLTF).filter(m => !/(mimas|enceladus)/.test(m.name));
  const encMeshes = extractMeshes(encGLTF);
  if (!satMeshes.length) throw new Error('No meshes in saturn.glb');
  if (!encMeshes.length) throw new Error('No meshes in enceladus.glb');


  /* ── Programs ──────────────────────────────────────────────────────────── */
  const skyProg    = mkProg(gl, SKYBOX_VS,  SKYBOX_FS);
  const sunProg    = mkProg(gl, SUN_VS,     SUN_FS);
  const planetProg = mkProg(gl, PLANET_VS,  PLANET_FS);
  const brightProg = mkProg(gl, POST_VS,    BRIGHT_FS);
  const blurProg   = mkProg(gl, POST_VS,    BLUR_FS);
  const compProg   = mkProg(gl, POST_VS,    COMPOSITE_FS);

  /* ── Full-screen quad (skybox + post passes) ───────────────────────────── */
  const quadVAO = gl.createVertexArray();
  gl.bindVertexArray(quadVAO);
  const qBuf = glBuf(gl, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]));
  gl.bindBuffer(gl.ARRAY_BUFFER, qBuf);
  const qLoc = gl.getAttribLocation(skyProg, 'a_Pos');
  gl.enableVertexAttribArray(qLoc);
  gl.vertexAttribPointer(qLoc, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  /* ── Textures ──────────────────────────────────────────────────────────── */
  const [satBodyImg, sunImg] = await Promise.all([
    loadImage('/8k_saturn.jpg'), loadImage('/8k_sun.jpg'),
  ]);
  const satBodyTex = glTex2D(gl, satBodyImg);
  const sunTex     = glTex2D(gl, sunImg);

  const satGPU     = satMeshes.map(m => makeVAO(gl, planetProg, m));
  const satTex     = satMeshes.map(m =>
    isRing(m) ? (m.image ? glTex2D(gl, m.image) : null) : satBodyTex
  );
  const satSpecTex = satMeshes.map(m => m.specImage ? glTex2D(gl, m.specImage) : null);
  const encGPU     = encMeshes.map(m => makeVAO(gl, planetProg, m));
  const encTex     = encMeshes.map(m => m.image    ? glTex2D(gl, m.image)     : null);
  const encSpecTex = encMeshes.map(m => m.specImage ? glTex2D(gl, m.specImage) : null);

  /* ── Uniform locations ─────────────────────────────────────────────────── */
  const U = cacheUniforms(gl, planetProg, [
    'u_MVP','u_M','u_N','u_LDir','u_LCol','u_Base','u_Cam',
    'u_Shin','u_SpecK','u_Alpha','u_TexOn','u_Tex','u_AlphaCutoff',
    'u_SpecTexOn','u_SpecTex','u_UVRepeat','u_UVOffset',
    'u_EnvMap','u_EnvStr','u_FogDensity','u_FogColor','u_OccluderCenter','u_OccluderR',
  ]);
  const SkyU   = cacheUniforms(gl, skyProg,    ['u_Skybox','u_InvViewProj','u_Cam']);
  const SunU   = cacheUniforms(gl, sunProg,    ['u_MVP','u_Tex','u_Intensity']);
  const BrightU = cacheUniforms(gl, brightProg, ['u_Img','u_Threshold']);
  const BlurU   = cacheUniforms(gl, blurProg,   ['u_Img','u_Texel','u_Dir']);
  const CompU   = cacheUniforms(gl, compProg,   ['u_Scene','u_Bloom','u_Strength']);

  /* ── Scene constants ───────────────────────────────────────────────────── */
  const spaceCubemap = glTexCubeFromImages(gl, await loadCubemapFaces('/cubemap_starmap_2020_1024'));
  const sunGPU = makeVAO(gl, sunProg, makeUvSphere(1.0, 24, 48));

  const satBodyMesh   = satMeshes.find(m => !isRing(m)) ?? satMeshes[0];
  const eB = boundsOf(encMeshes[0].pos);
  const sB = boundsOf(satBodyMesh.pos);
  const sS = 3.2  / sB.r;
  const eS = 0.42 / eB.r;
  const satBodyRadius = sS * sB.r;

  const SUN_DIR = vec3.normalize(vec3.create(), SUN_DIR_RAW);
  const SUN_POS = vec3.scale(vec3.create(), SUN_DIR, 4000.0);

  /* ── View mode ─────────────────────────────────────────────────────────── */
  let viewMode = 'saturn', satCamR = 22.0, encCamR = 3.0;
  const modeEl = document.getElementById('view-mode');
  window.addEventListener('keydown', e => {
    if (e.key !== 'e' && e.key !== 'E') return;
    viewMode = viewMode === 'saturn' ? 'enceladus' : 'saturn';
    camRx = 0.1; camRy = 0.0;
    if (modeEl) modeEl.textContent = viewMode === 'enceladus' ? 'VIEW: ENCELADUS' : 'VIEW: SATURN';
  });

  /* ── Camera (mouse + touch + scroll) ──────────────────────────────────── */
  let camRx = 0.22, camRy = 0.0, dragging = false, px = 0, py = 0;
  const onDown = (x, y) => { dragging = true; px = x; py = y; };
  const onUp   = ()      => { dragging = false; };
  const onMove = (x, y) => {
    if (!dragging) return;
    camRy += (x - px) * 0.005; camRx += (y - py) * 0.005;
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
    if (viewMode === 'saturn') satCamR = Math.max(4,   Math.min(120, satCamR + e.deltaY * 0.06));
    else                       encCamR = Math.max(1.2, Math.min(15,  encCamR + e.deltaY * 0.02));
    e.preventDefault();
  }, { passive: false });

  /* ── Render targets (lazy resize) ──────────────────────────────────────── */
  const proj = mat4.create(), view = mat4.create(), vp = mat4.create(), invVP = mat4.create();
  let sceneRT = null, bloomA = null, bloomB = null, rtW = 0, rtH = 0;

  const ensureTargets = (w, h) => {
    if (w === rtW && h === rtH && sceneRT) return;
    [sceneRT, bloomA, bloomB].forEach(rt => freeRenderTarget(gl, rt));
    sceneRT = mkRenderTarget(gl, w, h, true);
    bloomA  = mkRenderTarget(gl, w, h, false);
    bloomB  = mkRenderTarget(gl, w, h, false);
    rtW = w; rtH = h;
  };

  /* ── Draw one body ─────────────────────────────────────────────────────── */
  function renderGroup(gpuList, meshList, texList, specTexList, modelMat, envStrength) {
    gl.uniformMatrix4fv(U.u_MVP, false, mat4.multiply(mat4.create(), vp, modelMat));
    gl.uniformMatrix4fv(U.u_M,   false, modelMat);
    gl.uniformMatrix3fv(U.u_N,   false, mat3.normalFromMat4(mat3.create(), modelMat));

    const drawMesh = (g, m, tex, specTex, ring) => {
      gl.uniform1f (U.u_Alpha,       ring ? 1.0 : m.opacity);
      gl.uniform1f (U.u_AlphaCutoff, 0.0);
      gl.uniform2fv(U.u_UVRepeat,    m.uvRepeat ?? [1, 1]);
      gl.uniform2fv(U.u_UVOffset,    m.uvOffset ?? [0, 0]);
      gl.uniform1f (U.u_EnvStr,      ring ? 0.005 : envStrength);

      gl.disable(gl.CULL_FACE);
      if (ring) {
        gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.depthMask(false);
        gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(1.0, 1.0);
      } else {
        gl.disable(gl.BLEND);
        gl.depthMask(true);
        gl.disable(gl.POLYGON_OFFSET_FILL);
      }

      if (tex) {
        bindTex(gl, gl.TEXTURE0, gl.TEXTURE_2D, tex, U.u_Tex, 0);
        gl.uniform1i(U.u_TexOn, 1);
      } else {
        gl.uniform3fv(U.u_Base, m.color); gl.uniform1i(U.u_TexOn, 0);
      }

      if (specTex) {
        bindTex(gl, gl.TEXTURE2, gl.TEXTURE_2D, specTex, U.u_SpecTex, 2);
        gl.uniform1i(U.u_SpecTexOn, 1);
      } else {
        gl.uniform1i(U.u_SpecTexOn, 0);
        if (ring) { gl.uniform1f(U.u_Shin, 8.0); gl.uniform1f(U.u_SpecK, 0.05); }
      }

      drawVAO(gl, g);
    };

    /* Body meshes first — writes depth so rings behind planet are correctly clipped. */
    gpuList.forEach((g, i) => { if (!isRing(meshList[i])) drawMesh(g, meshList[i], texList[i], specTexList[i], false); });
    /* Ring meshes second — depth-tested against body, no depth write, alpha blended. */
    gpuList.forEach((g, i) => { if ( isRing(meshList[i])) drawMesh(g, meshList[i], texList[i], specTexList[i], true);  });
  }

  /* ── Render loop ───────────────────────────────────────────────────────── */
  let t = 0;
  function frame() {
    t += 0.004;
    resize();
    const W = canvas.width, H = canvas.height;
    ensureTargets(W, H);

    const encAngle = t * 0.70;
    const encWorld = [ENC_ORBIT_R * Math.cos(encAngle), 0, -ENC_ORBIT_R * Math.sin(encAngle)];

    const isEnc  = viewMode === 'enceladus';
    const ctr    = isEnc ? encWorld : [0, 0, 0];
    const camR   = isEnc ? encCamR  : satCamR;
    const camPos = new Float32Array([
      ctr[0] + camR * Math.sin(camRy) * Math.cos(camRx),
      ctr[1] + camR * Math.sin(camRx),
      ctr[2] + camR * Math.cos(camRy) * Math.cos(camRx),
    ]);

    mat4.perspective(proj, Math.PI / 4, W / H, 0.1, 8000.0);
    mat4.lookAt(view, camPos, ctr, [0, 1, 0]);
    mat4.multiply(vp, proj, view);
    mat4.invert(invVP, vp);

    /* Pass 1 — scene to offscreen FBO */
    gl.viewport(0, 0, W, H);
    gl.bindFramebuffer(gl.FRAMEBUFFER, sceneRT.fbo);
    gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);
    gl.useProgram(skyProg);
    bindTex(gl, gl.TEXTURE1, gl.TEXTURE_CUBE_MAP, spaceCubemap, SkyU.u_Skybox, 1);
    gl.uniformMatrix4fv(SkyU.u_InvViewProj, false, invVP);
    gl.uniform3fv(SkyU.u_Cam, camPos);
    gl.bindVertexArray(quadVAO); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.disable(gl.BLEND);
    gl.useProgram(sunProg);
    const sunM = mat4.create();
    mat4.translate(sunM, sunM, SUN_POS); mat4.scale(sunM, sunM, [8, 8, 8]);
    gl.uniformMatrix4fv(SunU.u_MVP, false, mat4.multiply(mat4.create(), vp, sunM));
    bindTex(gl, gl.TEXTURE0, gl.TEXTURE_2D, sunTex, SunU.u_Tex, 0);
    gl.uniform1f(SunU.u_Intensity, 2.4);
    drawVAO(gl, sunGPU);

    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(planetProg);
    gl.uniform3fv(U.u_LDir, SUN_DIR);
    gl.uniform3fv(U.u_LCol, SUN_COL);
    gl.uniform3fv(U.u_Cam,  camPos);
    gl.uniform1f (U.u_FogDensity, 0.013);
    gl.uniform3fv(U.u_FogColor, new Float32Array([0, 0, 0.018]));
    bindTex(gl, gl.TEXTURE1, gl.TEXTURE_CUBE_MAP, spaceCubemap, U.u_EnvMap, 1);

    gl.uniform3fv(U.u_OccluderCenter, encWorld); gl.uniform1f(U.u_OccluderR, 0.42);

    const satM = mat4.create();
    mat4.rotateZ (satM, satM, 26.7 * Math.PI / 180);
    mat4.rotateY (satM, satM, t * 0.15);
    mat4.scale   (satM, satM, [sS, sS, sS]);
    mat4.translate(satM, satM, [-sB.cx, -sB.cy, -sB.cz]);
    gl.uniform1f(U.u_Shin, 20.0); gl.uniform1f(U.u_SpecK, 0.10);
    renderGroup(satGPU, satMeshes, satTex, satSpecTex, satM, 0.02);
    gl.depthMask(true);

    const encM = mat4.create();
    mat4.rotateY (encM, encM, t * 0.70);
    mat4.rotateX (encM, encM, 0.09);
    mat4.translate(encM, encM, [ENC_ORBIT_R, 0, 0]);
    mat4.rotateY (encM, encM, t * 2.2);
    mat4.scale   (encM, encM, [eS, eS, eS]);
    mat4.translate(encM, encM, [-eB.cx, -eB.cy, -eB.cz]);
    gl.uniform1f(U.u_Shin, 52.0); gl.uniform1f(U.u_SpecK, 0.65);
    gl.uniform3fv(U.u_OccluderCenter, [0, 0, 0]); gl.uniform1f(U.u_OccluderR, satBodyRadius);
    renderGroup(encGPU, encMeshes, encTex, encSpecTex, encM, 0.18);

    /* Pass 2 — bright extract */
    gl.bindFramebuffer(gl.FRAMEBUFFER, bloomA.fbo);
    gl.viewport(0, 0, W, H); gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
    gl.useProgram(brightProg);
    bindTex(gl, gl.TEXTURE0, gl.TEXTURE_2D, sceneRT.tex, BrightU.u_Img, 0);
    gl.uniform1f(BrightU.u_Threshold, 0.62);
    gl.bindVertexArray(quadVAO); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    /* Pass 3 — separable Gaussian blur (6 ping-pong passes) */
    gl.useProgram(blurProg);
    gl.uniform2f(BlurU.u_Texel, 1 / W, 1 / H);
    let readTex = bloomA.tex;
    for (let i = 0; i < 6; i++) {
      const horiz = (i % 2) === 0, writeRT = horiz ? bloomB : bloomA;
      gl.bindFramebuffer(gl.FRAMEBUFFER, writeRT.fbo);
      bindTex(gl, gl.TEXTURE0, gl.TEXTURE_2D, readTex, BlurU.u_Img, 0);
      gl.uniform2f(BlurU.u_Dir, horiz ? 1 : 0, horiz ? 0 : 1);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      readTex = writeRT.tex;
    }

    /* Pass 4 — composite scene + bloom to screen */
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(compProg);
    bindTex(gl, gl.TEXTURE0, gl.TEXTURE_2D, sceneRT.tex, CompU.u_Scene, 0);
    bindTex(gl, gl.TEXTURE1, gl.TEXTURE_2D, readTex,     CompU.u_Bloom, 1);
    gl.uniform1f(CompU.u_Strength, 1.05);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    requestAnimationFrame(frame);
  }

  document.getElementById('loading').style.display = 'none';
  requestAnimationFrame(frame);
}

main().catch(err => {
  const msgEl = document.getElementById('msg');
  if (msgEl) msgEl.textContent = 'Error: ' + err.message;
  console.error(err);
});
