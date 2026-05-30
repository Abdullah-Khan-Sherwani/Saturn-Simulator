/* Image loading helpers */

export function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload  = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load image: ' + url));
    img.src = url;
  });
}

export async function loadCubemapFaces(basePath) {
  const faces = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];
  return Promise.all(faces.map(face => loadImage(`${basePath}/${face}.png`)));
}
