import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  publicDir: 'Assets',
  assetsInclude: ['**/*.glb', '**/*.exr'],

  server: {
    open: '/saturn',
  },

  plugins: [
    {
      name: 'saturn-rewrite',
      configureServer(server) {
        server.middlewares.use((req, _res, next) => {
          if (req.url === '/saturn') req.url = '/saturn.html';
          next();
        });
      },
    },
  ],

  build: {
    rollupOptions: {
      input: {
        saturn: resolve(__dirname, 'saturn.html'),
      },
    },
  },
});
