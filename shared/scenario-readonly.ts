import type { Creator, CreatorCommerceType, OrderStatus, Platform, SampleStatus, ScheduleStatus } from './types.ts';
import type { BusinessProgressWorkspace } from './business-progress.ts';

/** Field allowlist for the organization reader. No source rows, identities or free-form notes. */
export interface ScenarioReadOnlyWorkspace {
  schemaVersion: 1;
  accessMode: 'read_only';
  businessProgress?: BusinessProgressWorkspace;
  brand: { id: string; name: string };
  sourceSummary: {
    classification: 'real_or_mixed';
    sourceRowCount: number;
    sourceCreatorCount: number;
    sourceProductCount: number;
    simulatedAccountCount: number;
    referenceDate: string;
  };
  creators: Array<{
    id: string; name: string; crmStage: Creator['crmStage'];
    accounts: Array<{ platform: Platform; displayName: string; commerceTypes: CreatorCommerceType[] }>;
  }>;
  products: Array<{ id: string; name: string; sku: string | null; specification: string | null; active: boolean }>;
  stores: Array<{ id: string; name: string; platform: Platform; active: boolean }>;
  assortments: Array<{
    id: string; storeId: string; productId: string; priceCents: number | null;
    livePriceCents: number | null; creatorCommissionBps: number | null; active: boolean;
  }>;
  samples: Array<{
    id: string; creatorId: string; platform: Platform | null; status: SampleStatus; createdAt: string;
    lines: Array<{ productId: string; quantity: number }>;
  }>;
  schedules: Array<{
    id: string; creatorId: string; platform: Platform; title: string;
    plannedStartAt: string; plannedEndAt: string; status: ScheduleStatus;
  }>;
  orders: Array<{
    id: string; creatorId: string | null; productId: string | null;
    platform: Platform; status: OrderStatus; paidAt: string | null; paidAmountCents: number | null;
  }>;
  refunds: Array<{
    id: string; orderLineId: string; platform: Platform; refundedAt: string | null;
    status: 'succeeded' | 'pending' | 'reversed' | 'unknown';
    amountCents: number | null; direction: 'refund' | 'reversal';
  }>;
  salesReports: Array<{
    id: string; creatorId: string; platform: Platform; commerceType: CreatorCommerceType;
    title: string; creditedOn: string; gmvCents: number;
    status: 'pending_review' | 'approved' | 'returned'; reconciled: boolean;
  }>;
}

export interface ScenarioReadOnlyStore {
  read(): Promise<ScenarioReadOnlyWorkspace>;
}
