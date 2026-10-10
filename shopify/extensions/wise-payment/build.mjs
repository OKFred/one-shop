import { build } from 'esbuild';
await build({
  entryPoints: ['src/order-status.jsx', 'src/order-menu.jsx'],
  outdir: 'dist', bundle: true, format: 'esm', target: 'es2022',
  jsx: 'automatic', jsxImportSource: 'preact', minify: true,
  legalComments: 'inline'
});
