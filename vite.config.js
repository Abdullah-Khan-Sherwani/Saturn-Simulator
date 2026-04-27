import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  publicDir: 'Assets',
  assetsInclude: ['**/*.glb', '**/*.exr'],

  build: {
    rollupOptions: {
      input: {
        saturn: resolve(__dirname, 'saturn.html'),
      },
    },
  },
});
