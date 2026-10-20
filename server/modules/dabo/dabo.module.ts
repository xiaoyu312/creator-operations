import { Module } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { createPostgresDomainStore } from '../../storage/index.ts';
import { DaboController } from './dabo.controller.ts';
import { DaboApiService } from './dabo-api.service.ts';
import { PlatformIdentityProvider } from './identity.ts';
import { DOMAIN_STORE, IDENTITY_PROVIDER } from './tokens.ts';

@Module({
  controllers: [DaboController],
  providers: [
    {
      provide: DOMAIN_STORE,
      inject: [DRIZZLE_DATABASE],
      useFactory: (database: PostgresJsDatabase) => {
        if (process.env.DABO_ENABLE_PLATFORM !== '1' || process.env.DABO_MODE !== 'production') throw new Error('平台适配必须显式启用，演示入口不会注册它。');
        const orgId = process.env.DABO_ORG_ID;
        if (!orgId) throw new Error('尚未设置经核验的 DABO_ORG_ID。');
        return createPostgresDomainStore(database, { orgId });
      },
    },
    { provide: IDENTITY_PROVIDER, useFactory: () => new PlatformIdentityProvider() },
    { provide: DaboApiService, inject: [DOMAIN_STORE, IDENTITY_PROVIDER], useFactory: (store: ReturnType<typeof createPostgresDomainStore>, identity: PlatformIdentityProvider) => new DaboApiService(store, identity) },
  ],
})
export class DaboModule {}
