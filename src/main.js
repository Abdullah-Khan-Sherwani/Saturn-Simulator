import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

// ── Renderer ──────────────────────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.8;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

// ── Scene / Camera ────────────────────────────────────────────────────────────
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1a2e);

const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.05, 100);
camera.position.set(0, 2.5, 3.8);

// ── Controls ──────────────────────────────────────────────────────────────────
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.85, 0);
controls.minPolarAngle = 0.2;
controls.maxPolarAngle = Math.PI / 2.1;
controls.minDistance = 1.5;
controls.maxDistance = 7;
controls.update();

// ── Post-processing ───────────────────────────────────────────────────────────
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(
  new THREE.Vector2(innerWidth, innerHeight),
  0.8,   // strength
  0.4,   // radius
  1.5    // threshold — only true emissives glow, not lit paper
);
composer.addPass(bloom);

// ── Desk ──────────────────────────────────────────────────────────────────────
const texLoader = new THREE.TextureLoader();

const woodDiffuse = texLoader.load('/Textures/wood_diffuse.jpg');
woodDiffuse.colorSpace = THREE.SRGBColorSpace;
woodDiffuse.wrapS = THREE.RepeatWrapping;
woodDiffuse.wrapT = THREE.RepeatWrapping;
woodDiffuse.repeat.set(2, 2);

const woodRoughness = texLoader.load('/Textures/wood_roughness.jpg');
woodRoughness.wrapS = THREE.RepeatWrapping;
woodRoughness.wrapT = THREE.RepeatWrapping;
woodRoughness.repeat.set(2, 2);

const deskMat = new THREE.MeshStandardMaterial({
  map: woodDiffuse,
  roughnessMap: woodRoughness,
  color: 0x8b5a2b, // fallback tint if textures fail to load
});

const DESK = { w: 3.2, h: 0.08, d: 2.0, y: 0.82 };
const SURFACE = DESK.y + DESK.h / 2;

const tabletop = new THREE.Mesh(new THREE.BoxGeometry(DESK.w, DESK.h, DESK.d), deskMat);
tabletop.position.y = DESK.y;
tabletop.receiveShadow = true;
scene.add(tabletop);

const legH = DESK.y - DESK.h / 2;
const legGeo = new THREE.BoxGeometry(0.09, legH, 0.09);
for (const [x, z] of [[-1.52, -0.92], [1.52, -0.92], [-1.52, 0.92], [1.52, 0.92]]) {
  const leg = new THREE.Mesh(legGeo, deskMat);
  leg.position.set(x, legH / 2, z);
  leg.castShadow = true;
  scene.add(leg);
}

// ── Glass of water ────────────────────────────────────────────────────────────
const glass = new THREE.Mesh(
  new THREE.CylinderGeometry(0.07, 0.06, 0.28, 32),
  new THREE.MeshPhysicalMaterial({
    transmission: 1.0, ior: 1.33, thickness: 0.35,
    roughness: 0.0, metalness: 0.0, color: 0xddeeff,
  })
);
glass.position.set(0.75, SURFACE + 0.14, 0.5);
scene.add(glass);

// ── Lights ────────────────────────────────────────────────────────────────────
// Minimal ambient — just enough to see into shadows, not wash them out
scene.add(new THREE.AmbientLight(0x404040, 0.2));

// Spotlight — banker's lamp, repositioned higher and left
const spot = new THREE.SpotLight(0xffd580, 6, 7, Math.PI / 7, 1.0, 1.8);
spot.position.set(-0.5, 3.5, 0.5);
spot.target.position.set(0.2, DESK.y, 0.0);
spot.castShadow = true;
spot.shadow.mapSize.set(2048, 2048);
spot.shadow.camera.near = 0.5;
spot.shadow.camera.far = 8;
spot.shadow.bias = -0.0008;
scene.add(spot, spot.target);

// Moonlight — cool directional, no shadows
const moon = new THREE.DirectionalLight(0x8899cc, 0.4);
moon.position.set(-4, 5, -3);
scene.add(moon);

// Point — inside the glass of water, acts as refracted light source
const point = new THREE.PointLight(0xff9944, 0.8, 2, 2);
point.position.set(0.75, SURFACE + 0.14, 0.5);
scene.add(point);

// ── Helpers ───────────────────────────────────────────────────────────────────
const gltfLoader = new GLTFLoader();
const exrLoader  = new EXRLoader();

function applyEnvMap(root, intensity = 0.2) {
  root.traverse(c => {
    if (!c.isMesh) return;
    c.castShadow = true;
    c.receiveShadow = true;
    if (c.material) c.material.envMapIntensity = intensity;
  });
}

// Fit model's longest axis to targetSize; sit bottom on desk surface.
// preRotate: optional {axis, angle} applied before bounding-box measurement.
function fitToDesk(model, targetSize, x, z, rotY = 0, preRotate = null) {
  if (preRotate) model.rotation[preRotate.axis] = preRotate.angle;

  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  model.scale.setScalar(targetSize / Math.max(size.x, size.y, size.z));

  box.setFromObject(model);
  model.position.set(x, SURFACE - box.min.y, z);
  model.rotation.y = rotY;
}

// ── Asset loading ─────────────────────────────────────────────────────────────
async function loadAssets() {
  const load = (url) => {
    console.log('loading:', url);
    return gltfLoader.loadAsync(url).then(r => { console.log('done:', url); return r; });
  };

  // GLBs load in parallel — scene appears as soon as they finish
  const [tankGltf, mauserGltf, mapGltf, compassGltf] = await Promise.all([
    load('/pzkpfw_vi_tiger_1.glb'),
    load('/mauser_c96_the_redeemer.glb'),
    load('/usgs_topographic_map.glb'),
    load('/antique_military_compass_usaf_ww2_era.glb'),
  ]);

  const tank = tankGltf.scene;
  fitToDesk(tank, 0.55, 0.2, -0.15, Math.PI / 6);
  applyEnvMap(tank);
  scene.add(tank);

  const mauser = mauserGltf.scene;
  fitToDesk(mauser, 0.65, -0.85, 0.1, -Math.PI / 6, { axis: 'x', angle: -Math.PI / 2 });
  applyEnvMap(mauser, 0.25);
  scene.add(mauser);

  // Map — preserve GLB textures, matte paper surface, dimmed 40% to avoid blowout
  const map = mapGltf.scene;
  map.traverse(c => {
    if (c.isMesh) {
      c.castShadow = true;
      c.receiveShadow = true;
      if (c.material) {
        c.material.roughness = 1.0;        // matte paper
        c.material.metalness = 0.0;
        c.material.color.multiplyScalar(0.6); // dim base texture by 40%
      }
    }
  });
  fitToDesk(map, 1.2, 0.15, 0.0);
  map.position.y += 0.001;            // prevent z-fighting with desk surface
  scene.add(map);

  const compass = compassGltf.scene;
  fitToDesk(compass, 0.2, 0.9, 0.55);
  applyEnvMap(compass, 0.25);
  scene.add(compass);

  document.getElementById('loading').style.display = 'none';

  // EXR loads after scene is visible — slow JS decode, don't block on it
  exrLoader.loadAsync('/unfinished_office_4k.exr').then(envTex => {
    envTex.mapping = THREE.EquirectangularReflectionMapping;
    scene.environment = envTex;       // IBL reflections only, no background change
    console.log('EXR environment loaded');
  }).catch(console.error);
}

loadAssets().catch(err => {
  document.getElementById('loading').textContent = 'Error: ' + err.message;
  console.error(err);
});

// ── Resize ────────────────────────────────────────────────────────────────────
window.addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
});

// ── Render loop ───────────────────────────────────────────────────────────────
const clock = new THREE.Clock();
(function animate() {
  requestAnimationFrame(animate);
  controls.update(clock.getDelta());
  composer.render();
})();
