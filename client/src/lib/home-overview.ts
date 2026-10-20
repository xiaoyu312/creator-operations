import type { OrderLine, Product } from '../../../shared/types.ts';

export interface HomeProductRankingRow {
  id: string;
  name: string;
  count: number;
  knownCents: number;
  unknownAmountCount: number;
}

export interface HomeProductRanking {
  rows: HomeProductRankingRow[];
  unmatchedLineCount: number;
}

/**
 * Aggregate already-scoped paid order lines by their recorded product ID.
 * Lines without a visible product remain counted separately instead of being
 * merged into a synthetic product row.
 */
export function buildHomeProductRanking(
  orderLines: readonly Pick<OrderLine, 'productId' | 'paidAmountCents'>[],
  products: readonly Pick<Product, 'id' | 'name'>[],
): HomeProductRanking {
  const productsById = new Map(products.map((product) => [product.id, product]));
  const rowsByProduct = new Map<string, HomeProductRankingRow>();
  let unmatchedLineCount = 0;

  for (const line of orderLines) {
    const product = line.productId ? productsById.get(line.productId) : undefined;
    if (!product) {
      unmatchedLineCount += 1;
      continue;
    }

    const row = rowsByProduct.get(product.id) ?? {
      id: product.id,
      name: product.name,
      count: 0,
      knownCents: 0,
      unknownAmountCount: 0,
    };
    row.count += 1;
    if (line.paidAmountCents === null) row.unknownAmountCount += 1;
    else row.knownCents += line.paidAmountCents;
    rowsByProduct.set(product.id, row);
  }

  const rows = [...rowsByProduct.values()].sort((left, right) =>
    right.knownCents - left.knownCents
    || right.count - left.count
    || left.name.localeCompare(right.name, 'zh-CN')
    || left.id.localeCompare(right.id),
  );

  return { rows, unmatchedLineCount };
}
