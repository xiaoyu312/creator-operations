import type { DomainState } from '../../shared/types.ts';
import { createDemoState } from '../../shared/seed.ts';
import type { DomainStore } from '../domain/domain-service.ts';

/**
 * The original FileDomainStore's clone/queue/commit contract, without disk access.
 * A fresh process starts with the reviewed deterministic synthetic seed.
 */
export class MemoryDemoStore implements DomainStore {
  private state: DomainState = createDemoState();
  private queue: Promise<void> = Promise.resolve();
  private readonly orgId = this.state.orgId;

  async read(): Promise<DomainState> {
    await this.queue;
    return structuredClone(this.state);
  }

  async transaction<T>(operation: (draft: DomainState) => T | Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const draft = structuredClone(this.state);
      const result = await operation(draft);
      if (draft.dataMode !== 'demo' || draft.schemaVersion !== 1 || draft.orgId !== this.orgId) {
        throw new Error('The local demo cannot change its synthetic workspace identity.');
      }
      this.state = draft;
      return structuredClone(result);
    });
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }
}
