import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  publicDir: 'Assets',
  assetsInclude: ['**/*.glb', '**/*.exr'],

  /* Multi-page app: General's Desk + Saturn WebGL scene + Tiger Tank */
  build: {
    rollupOptions: {
      input: {
        main:   resolve(__dirname, 'index.html'),
        saturn: resolve(__dirname, 'saturn.html'),
        tiger:  resolve(__dirname, 'tiger.html'),
      },
    },
  },
});
