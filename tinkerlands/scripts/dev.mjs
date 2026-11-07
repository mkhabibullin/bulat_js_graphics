// Development: rebuild the client on change and restart the server on change.
// Reload the browser tab to pick up client changes.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { build } from './build.mjs';

const root = path.resolve(import.meta.dirname, '..');
await build();

let timer = null;
const rebuild = () => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    build().catch((err) => console.error(err.message));
  }, 150);
};
fs.watch(path.join(root, 'client'), { recursive: true }, rebuild);

const server = spawn(
  process.execPath,
  ['--watch', '--disable-warning=ExperimentalWarning', 'server/index.ts'],
  { cwd: root, stdio: 'inherit', env: { ...process.env, LOG_LEVEL: process.env.LOG_LEVEL || 'debug' } },
);
server.on('exit', (code) => process.exit(code ?? 0));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.kill(signal));
