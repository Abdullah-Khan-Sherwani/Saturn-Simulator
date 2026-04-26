# Product Requirements Document (PRD): "The General's Desk"
**Project Type:** 3D Scene Rendering System (WebGL / Three.js)

## 1. AI Coding Directives & Code Quality Standards (CRITICAL)
*Any AI or developer executing this PRD MUST adhere strictly to the following coding standards:*
* **Absolute Simplicity:** Code must be as simple as possible. Do not over-engineer or create unnecessary abstractions.
* **DRY & SOLID Principles:** Follow "Don't Repeat Yourself" (DRY) and core SOLID principles. Encapsulate logic where it makes sense (e.g., a single function for asset loading, a single class/module for light setup), but keep the architecture flat and understandable.
* **Minimize Lines of Code (LOC):** Achieve the required functionality with the absolute minimum LOC necessary, without sacrificing readability. 
* **Clean Three.js Architecture:** * Use modern ES6+ syntax (Promises, async/await for loaders).
    * Clean up memory loops and explicitly manage rendering state.
    * Ensure proper `requestAnimationFrame` loop with delta time for controls.

## 2. Project Objective
Develop an interactive, browser-based 3D diorama using WebGL (and threejs just for loading models and environment. The core of this project is to demonstrate concepts of computer graphics in WebGL. use WebGL imports and libraries but do not use threejs for anything other than loading models). The project integrates core rasterization with ray-tracing concepts (glass refraction), procedural geometry, external assets, and post-processing to create a cinematic "still-life" of a battlefield commander's desk at night.

## 3. Asset Manifest (Local Directory Structure)
The system must dynamically load the following local assets:
* **3D Models:** * `Tiger_Tank_Rig_v1_L2.1.123c5e810a97.glb`
    * `Mauser_1918_T-Gewehr_v1_L2.1.123c5e810a97.glb`
* **Environment Map:** * `small_empty_room_3_2k.exr` (Loaded via `EXRLoader`, used *only* for `scene.environment`, NOT `scene.background`). Set background to pure black or very dark grey.
* **Textures:**
    * **Desk:** High-resolution Wood Diffuse Map and Specular Map.
    * **Battle Map:** Vintage Map Diffuse Map and Normal Map.

## 4. Baseline Technical Requirements
* **Lighting Pipeline:** Accumulation of three distinct light types:
    1.  **Spotlight (Banker's Lamp):** The primary light. Warm color, high intensity. Must have inner/outer angle cutoff (penumbra) and `castShadow = true`.
    2.  **Directional Light (Moonlight):** Dim, cool blue light. No shadows. Simulates the window light from the EXR.
    3.  **Point Light:** Small, warm glow near the Mauser demonstrating strict distance attenuation (`distance` and `decay` properties).
* **Materials:** Utilization of per-fragment Phong shading (`MeshPhongMaterial`) for the desk and battle map surfaces to satisfy baseline syllabus requirements.

## 5. Advanced Techniques (Target Effort Score: 13/10)
To achieve the maximum grade, the following advanced techniques MUST be implemented:
* **Shadow Mapping (Effort: 4/5):** The Spotlight must cast high-resolution shadows. Ensure proper frustum and bias settings to avoid shadow acne and Peter Panning.
* **Environment Mapping (Effort: 3/5):** The Mauser and Tank materials will reflect the `.exr` environment map. Set `envMapIntensity` low (e.g., `0.1` or `0.2`) to maintain a dark, moody night scene.
* **Refraction (Effort: 3/5):** A glass of water centerpiece built with `CylinderGeometry`. Must use `MeshPhysicalMaterial` with `transmission: 1.0`, `ior: 1.33` (Index of Refraction), `thickness`, and `roughness: 0.0` to physically distort the desk behind it.
* **Normal Mapping (Effort: 3/5):** Applied to a flat plane (the Battle Map) under the tank to simulate paper wrinkles and texture depth without adding complex geometry.

## 6. Post-Processing & Visuals
* The standard `WebGLRenderer` must be routed through an `EffectComposer`.
* **Bloom Pass (Effort: 4/5):** Implement `UnrealBloomPass` to extract and blur bright specular highlights (on the glass and Mauser metal) to create a cinematic glow. Configure threshold carefully so the whole scene doesn't wash out.
* **Tone Mapping:** Set renderer to `THREE.ACESFilmicToneMapping` and enable `THREE.SRGBColorSpace` for accurate color handling of the EXR and GLB assets.

## 7. Execution Steps for AI Coder
1.  **Scaffolding:** Set up Vite/Webpack, HTML canvas, `WebGLRenderer`, `PerspectiveCamera`, and `OrbitControls` (restrict camera angle so user cannot look under the desk).
2.  **Asset Loading:** Create an asynchronous `AssetManager` to load the EXR, GLBs, and Textures sequentially or via `Promise.all()`.
3.  **Scene Assembly:** Build the BoxGeometry for the desk, PlaneGeometry for the battle map, CylinderGeometry for the glass, and position the loaded GLB models.
4.  **Lighting & Shadows:** Inject the 3-light system and configure the shadow map resolution/bias.
5.  **Post-Processing:** Apply the EffectComposer and Bloom.
