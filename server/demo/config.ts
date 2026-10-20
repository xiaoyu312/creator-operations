export function readDemoConfig(env: NodeJS.ProcessEnv = process.env) {
  if (env.NODE_ENV === 'production' || (env.DABO_MODE ?? 'demo') !== 'demo'
    || env.DABO_ENABLE_PLATFORM === '1') {
    throw new Error('The local entry point only supports isolated synthetic demo mode.');
  }
  const rawPort = env.DABO_DEMO_API_PORT ?? '4310';
  if (!/^\d{1,5}$/u.test(rawPort) || Number(rawPort) < 1024 || Number(rawPort) > 65535) {
    throw new Error('DABO_DEMO_API_PORT must be an integer between 1024 and 65535.');
  }
  return { mode: 'demo' as const, host: '127.0.0.1' as const, port: Number(rawPort) };
}
