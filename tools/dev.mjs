import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function createDevPlan(preview = false) {
  return [
    ['--experimental-transform-types', path.join(root, 'server/demo/main.ts')],
    [path.join(root, 'node_modules/vite/bin/vite.js'), ...(preview ? ['preview'] : []), '--config', path.join(root, 'vite.config.ts')],
  ];
}

export function startDev(preview = false) {
  if (!existsSync(path.join(root, 'node_modules/vite/bin/vite.js'))) {
    throw new Error('Install this package’s declared dependencies before starting the demo.');
  }
  if (preview && !existsSync(path.join(root, 'dist/client/index.html'))) {
    throw new Error('Run npm run build:client before npm start.');
  }
  const children = [];
  let stopping = false;
  const stop = (code = 0) => {
    if (stopping) return;
    stopping = true;
    process.exitCode = code;
    for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
  };
  for (const args of createDevPlan(preview)) {
    const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit', env: process.env });
    children.push(child);
    child.once('error', () => stop(1));
    child.once('exit', (code) => stop(code ?? 1));
  }
  process.once('SIGINT', () => stop(0));
  process.once('SIGTERM', () => stop(0));
  return { children, stop };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { startDev(process.argv.includes('--preview')); }
  catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
