import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// Two builds from one source:
//   default  -> dist/       served by the local agent at 127.0.0.1:4848, talks to /api
//   --mode demo -> dist-demo/  hosted under /demo/, fictional data, no network at all

// The demo makes no requests beyond its own static files. The policy makes that a rule the
// browser enforces, not just a promise.
const DEMO_CSP = [
  "default-src 'self'",
  "connect-src 'none'",
  "img-src 'self' data:",
  "font-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function demoPolicy(): Plugin {
  return {
    name: 'junction-demo-csp',
    apply: 'build',
    transformIndexHtml: () => [
      {
        tag: 'meta',
        attrs: { 'http-equiv': 'Content-Security-Policy', content: DEMO_CSP },
        injectTo: 'head-prepend',
      },
    ],
  };
}

export default defineConfig(({ mode }) => {
  const demo = mode === 'demo';
  return {
    base: demo ? '/demo/' : '/',
    plugins: [react(), ...(demo ? [demoPolicy()] : [])],
    resolve: {
      alias: {
        '@junction/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
      },
    },
    build: {
      outDir: demo ? 'dist-demo' : 'dist',
      emptyOutDir: true,
      sourcemap: false,
    },
    server: {
      port: demo ? 5174 : 5173,
      strictPort: false,
      ...(demo ? {} : { proxy: { '/api': 'http://127.0.0.1:4848' } }),
    },
    preview: { port: 4173 },
  };
});
