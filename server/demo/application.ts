import { DaboApiService } from '../modules/dabo/dabo-api.service.ts';
import { DemoIdentityProvider } from '../modules/dabo/identity.ts';
import { MemoryDemoStore } from './memory-store.ts';
import { readDemoConfig } from './config.ts';
import { createApiRouter } from '../http/router.ts';

/** Construction has no filesystem, database, network or socket side effects. */
export function createDemoApplication(env: NodeJS.ProcessEnv = process.env) {
  const config = readDemoConfig(env);
  const store = new MemoryDemoStore();
  const identity = new DemoIdentityProvider('demo:manager');
  // Omit production secrets. The original service generates an ephemeral random key.
  const service = new DaboApiService(store, identity, undefined);
  return { config, store, service, dispatch: createApiRouter(service) };
}
