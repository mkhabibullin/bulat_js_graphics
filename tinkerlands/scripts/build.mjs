// Bundles the client into dist/public with content-hashed names and
// precompressed variants, which the server serves directly.

import fs from 'node:fs';
import path from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import * as esbuild from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const outdir = path.join(root, 'dist', 'public');

export const buildOptions = {
  absWorkingDir: root,
  entryPoints: { app: 'client/main.ts', styles: 'client/styles.css' },
  bundle: true,
  minify: true,
  format: 'esm',
  target: ['es2022'],
  sourcemap: false,
  legalComments: 'none',
  outdir,
  entryNames: '[name].[hash]',
  assetNames: '[name].[hash]',
  metafile: true,
  loader: { '.woff2': 'file', '.woff': 'empty' },
  external: ['/favicon.svg'],
  logLevel: 'warning',
};

export async function build() {
  fs.rmSync(outdir, { recursive: true, force: true });
  const result = await esbuild.build(buildOptions);

  const outputs = Object.keys(result.metafile.outputs).map((p) => path.basename(p));
  const js = outputs.find((f) => /^app\..*\.js$/.test(f));
  const css = outputs.find((f) => /^styles\..*\.css$/.test(f));
  if (!js || !css) throw new Error('build did not produce the expected files');

  const html = fs
    .readFileSync(path.join(root, 'client', 'index.html'), 'utf8')
    .replace('%%JS%%', js)
    .replace('%%CSS%%', css);
  fs.writeFileSync(path.join(outdir, 'index.html'), html);
  fs.copyFileSync(path.join(root, 'client', 'favicon.svg'), path.join(outdir, 'favicon.svg'));

  for (const name of fs.readdirSync(outdir)) {
    if (!/\.(js|css|html|svg)$/.test(name)) continue;
    const full = path.join(outdir, name);
    const data = fs.readFileSync(full);
    fs.writeFileSync(`${full}.br`, brotliCompressSync(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }));
    fs.writeFileSync(`${full}.gz`, gzipSync(data, { level: 9 }));
  }

  const sizes = fs
    .readdirSync(outdir)
    .filter((f) => f.endsWith('.js.br') || f.endsWith('.css.br'))
    .map((f) => `${f}: ${(fs.statSync(path.join(outdir, f)).size / 1024).toFixed(0)} KB`);
  console.log(`Built client (${sizes.join(', ')})`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  await build();
}
