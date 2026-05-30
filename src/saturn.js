import { mat4, vec3 } from 'gl-matrix';
import { mkProg, glBuf, glTex2D, glTexCubeFromImages,
         mkRenderTarget, freeRenderTarget, cacheUniforms, bindTex } from './gl-utils.js';
import { loadImage, loadCubemapFaces } from './geometry.js';
import { loadGLTF, extractMeshes } from './gltf-loader.js';
import { RT_VS, RT_FS, POST_VS, BRIGHT_FS, BLUR_FS, COMPOSITE_FS } from './shaders.js';

const isRing = m => /saturn2/.test(m.name);

const ENC_ORBIT_R = 15.0;
// Toward the sun. Tilted ~32° out of the ring plane so the rings throw a clear
// banded shadow onto the planet and Saturn throws its shadow across the rings.
const SUN_DIR = vec3.normalize(vec3.create(), [-0.5, 0.32, -0.8]);
const SUN_COL = new Float32Array([0.92, 0.88, 0.80]);

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

  /* ── Load image textures + starfield cubemap (in parallel) ─────────────── */
  msgEl.textContent = 'Loading textures…';
  const [satImg, ringImg, cubeFaces] = await Promise.all([
    loadImage('/8k_saturn.jpg'),
    loadImage('/8k_saturn_ring_alpha.png'),
    loadCubemapFaces('/cubemap_starmap_2020_1024'),
  ]);

  /* ── GLB models — parsed only for their embedded diffuse + specular maps.
     Saturn's body specular/glossiness map and Enceladus' diffuse map live
     inside the GLBs; we sample them on the analytic spheres. ─────────────── */
  const fmtMB = e => e.lengthComputable
    ? `${(e.loaded / 1048576).toFixed(0)} / ${(e.total / 1048576).toFixed(0)} MB` : '…';
  const [satGLTF, encGLTF] = await Promise.all([
    loadGLTF('/saturn.glb',    e => { msgEl.textContent = 'Saturn model: '    + fmtMB(e); }),
    loadGLTF('/enceladus.glb', e => { msgEl.textContent = 'Enceladus model: ' + fmtMB(e); }),
  ]);
  const satMeshes = extractMeshes(satGLTF).filter(m => !/(mimas|enceladus)/.test(m.name));
  const satBody   = satMeshes.find(m => !isRing(m) && m.specImage) ?? satMeshes[0];
  const encBody   = extractMeshes(encGLTF).find(m => m.image);

  const satTex     = glTex2D(gl, satImg);
  const satSpecTex = glTex2D(gl, satBody.specImage);   // KHR specular/glossiness map
  const encTex     = glTex2D(gl, encBody.image);       // Enceladus diffuse map
  const ringTex    = glTex2D(gl, ringImg);
  const envCube    = glTexCubeFromImages(gl, cubeFaces);

  /* ── Programs: one ray tracer + three post passes ──────────────────────── */
  const rtProg     = mkProg(gl, RT_VS,   RT_FS);
  const brightProg = mkProg(gl, POST_VS, BRIGHT_FS);
  const blurProg   = mkProg(gl, POST_VS, BLUR_FS);
  const compProg   = mkProg(gl, POST_VS, COMPOSITE_FS);

  const RtU   = cacheUniforms(gl, rtProg, [
    'u_InvVP', 'u_Cam', 'u_Time', 'u_SunDir', 'u_SunCol', 'u_EncCenter',
    'u_SatTex', 'u_SatSpecTex', 'u_EncTex', 'u_RingTex', 'u_Env', 'u_FogColor', 'u_FogDensity',
  ]);
  const BrightU = cacheUniforms(gl, brightProg, ['u_Img', 'u_Threshold']);
  const BlurU   = cacheUniforms(gl, blurProg,   ['u_Img', 'u_Texel', 'u_Dir']);
  const CompU   = cacheUniforms(gl, compProg,   ['u_Scene', 'u_Bloom', 'u_Strength']);

  /* ── Full-screen quad (shared by the ray tracer and every post pass) ───── */
  const quadVAO = gl.createVertexArray();
  gl.bindVertexArray(quadVAO);
  gl.bindBuffer(gl.ARRAY_BUFFER, glBuf(gl, new Float32Array([-1,-1, 1,-1, -1,1, 1,1])));
  const qLoc = gl.getAttribLocation(rtProg, 'a_Pos');
  gl.enableVertexAttribArray(qLoc);
  gl.vertexAttribPointer(qLoc, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  const drawQuad = () => { gl.bindVertexArray(quadVAO); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); };

  /* ── View mode: orbit Saturn or follow Enceladus ───────────────────────── */
  let viewMode = 'saturn', satCamR = 22.0, encCamR = 3.0;
  const modeEl = document.getElementById('view-mode');
  window.addEventListener('keydown', e => {
    if (e.key !== 'e' && e.key !== 'E') return;
    viewMode = viewMode === 'saturn' ? 'enceladus' : 'saturn';
    camRx = 0.20; camRy = -1.5;   // reset to a sunlit 3/4 angle
    if (modeEl) modeEl.textContent = viewMode === 'enceladus' ? 'VIEW: ENCELADUS' : 'VIEW: SATURN';
  });

  /* ── Camera (mouse + touch + scroll) ───────────────────────────────────── */
  let camRx = 0.30, camRy = -1.5, dragging = false, px = 0, py = 0;  // sunlit 3/4 view
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
    if (viewMode === 'saturn') satCamR = Math.max(6,   Math.min(120, satCamR + e.deltaY * 0.06));
    else                       encCamR = Math.max(1.2, Math.min(15,  encCamR + e.deltaY * 0.02));
    e.preventDefault();
  }, { passive: false });

  /* ── Render targets (scene + bloom ping-pong), resized lazily ──────────── */
  const proj = mat4.create(), view = mat4.create(), vp = mat4.create(), invVP = mat4.create();
  let sceneRT = null, bloomA = null, bloomB = null, rtW = 0, rtH = 0;
  const ensureTargets = (w, h) => {
    if (w === rtW && h === rtH && sceneRT) return;
    [sceneRT, bloomA, bloomB].forEach(rt => freeRenderTarget(gl, rt));
    sceneRT = mkRenderTarget(gl, w, h, false);   // no depth — rays sort analytically
    bloomA  = mkRenderTarget(gl, w, h, false);
    bloomB  = mkRenderTarget(gl, w, h, false);
    rtW = w; rtH = h;
  };

  /* ── Render loop ───────────────────────────────────────────────────────── */
  let t = 0;
  function frame() {
    t += 0.004;
    resize();
    const W = canvas.width, H = canvas.height;
    ensureTargets(W, H);

    const encAngle = t * 0.70;
    const encCenter = [ENC_ORBIT_R * Math.cos(encAngle), 0, -ENC_ORBIT_R * Math.sin(encAngle)];

    const ctr    = viewMode === 'enceladus' ? encCenter : [0, 0, 0];
    const camR   = viewMode === 'enceladus' ? encCamR   : satCamR;
    const camPos = new Float32Array([
      ctr[0] + camR * Math.sin(camRy) * Math.cos(camRx),
      ctr[1] + camR * Math.sin(camRx),
      ctr[2] + camR * Math.cos(camRy) * Math.cos(camRx),
    ]);

    mat4.perspective(proj, Math.PI / 4, W / H, 0.1, 8000.0);
    mat4.lookAt(view, camPos, ctr, [0, 1, 0]);
    mat4.multiply(vp, proj, view);
    mat4.invert(invVP, vp);

    /* Pass 1 — ray trace the whole scene into an offscreen FBO */
    gl.viewport(0, 0, W, H);
    gl.bindFramebuffer(gl.FRAMEBUFFER, sceneRT.fbo);
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
    gl.useProgram(rtProg);
    gl.uniformMatrix4fv(RtU.u_InvVP, false, invVP);
    gl.uniform3fv(RtU.u_Cam,        camPos);
    gl.uniform1f (RtU.u_Time,       t);
    gl.uniform3fv(RtU.u_SunDir,     SUN_DIR);
    gl.uniform3fv(RtU.u_SunCol,     SUN_COL);
    gl.uniform3fv(RtU.u_EncCenter,  encCenter);
    gl.uniform3fv(RtU.u_FogColor,   new Float32Array([0, 0, 0.018]));
    gl.uniform1f (RtU.u_FogDensity, 0.011);
    bindTex(gl, gl.TEXTURE0, gl.TEXTURE_2D,       satTex,     RtU.u_SatTex,     0);
    bindTex(gl, gl.TEXTURE4, gl.TEXTURE_2D,       satSpecTex, RtU.u_SatSpecTex, 4);
    bindTex(gl, gl.TEXTURE3, gl.TEXTURE_2D,       encTex,     RtU.u_EncTex,     3);
    bindTex(gl, gl.TEXTURE2, gl.TEXTURE_2D,       ringTex,    RtU.u_RingTex,    2);
    bindTex(gl, gl.TEXTURE1, gl.TEXTURE_CUBE_MAP, envCube,    RtU.u_Env,        1);
    drawQuad();

    /* Pass 2 — bright extract */
    gl.bindFramebuffer(gl.FRAMEBUFFER, bloomA.fbo);
    gl.useProgram(brightProg);
    bindTex(gl, gl.TEXTURE0, gl.TEXTURE_2D, sceneRT.tex, BrightU.u_Img, 0);
    gl.uniform1f(BrightU.u_Threshold, 0.85);   // only the sun/hot specular bloom, not the starfield
    drawQuad();

    /* Pass 3 — separable Gaussian blur (6 ping-pong passes) */
    gl.useProgram(blurProg);
    gl.uniform2f(BlurU.u_Texel, 1 / W, 1 / H);
    let readTex = bloomA.tex;
    for (let i = 0; i < 6; i++) {
      const horiz = (i % 2) === 0, writeRT = horiz ? bloomB : bloomA;
      gl.bindFramebuffer(gl.FRAMEBUFFER, writeRT.fbo);
      bindTex(gl, gl.TEXTURE0, gl.TEXTURE_2D, readTex, BlurU.u_Img, 0);
      gl.uniform2f(BlurU.u_Dir, horiz ? 1 : 0, horiz ? 0 : 1);
      drawQuad();
      readTex = writeRT.tex;
    }

    /* Pass 4 — composite scene + bloom to the screen */
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(compProg);
    bindTex(gl, gl.TEXTURE0, gl.TEXTURE_2D, sceneRT.tex, CompU.u_Scene, 0);
    bindTex(gl, gl.TEXTURE1, gl.TEXTURE_2D, readTex,     CompU.u_Bloom, 1);
    gl.uniform1f(CompU.u_Strength, 0.9);
    drawQuad();

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
