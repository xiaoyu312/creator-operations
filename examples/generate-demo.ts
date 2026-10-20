import { createDemoState } from '../shared/seed.ts';

export const SYNTHETIC_SEED = 'dabo-demo-2026-10-13-v1';

/** Fixed original artificial fixtures. No file inputs, network or live records. */
export function generateDemo() {
  return {
    classification: 'synthetic_demo',
    seed: SYNTHETIC_SEED,
    state: createDemoState(),
  };
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/examples/generate-demo.ts')) {
  process.stdout.write(`${JSON.stringify(generateDemo(), null, 2)}\n`);
}
