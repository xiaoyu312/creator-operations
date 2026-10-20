import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { CsvImportRequest, CsvKind } from '../../../shared/http.ts';
import type { ImportCreatorRow, ImportOrderRow, ImportRefundRow } from '../../../shared/types.ts';
import { PLATFORMS, type Platform } from '../../../shared/types.ts';
import type { ImportPreviewCommand } from '../../../shared/commands.ts';

export const csvRequestSchema = z.object({
  kind: z.enum(['creators', 'orders', 'refunds']),
  csvText: z.string().min(1).max(2_000_000).refine((value) => Buffer.byteLength(value, 'utf8') <= 2_000_000, 'CSV 文本不能超过 2 MB。'),
  sourceName: z.string().trim().min(1).max(200).optional(),
  columnMapping: z.record(z.string().max(100), z.string().max(100)).optional(),
}).strict();

export const csvCommitSchema = csvRequestSchema.extend({ previewHash: z.string().min(32).max(400) });

export const csvColumns: Record<CsvKind, string[]> = {
  creators: ['platform', 'externalAccountId', 'name', 'displayName', 'category', 'tags', 'source', 'profileUrl', 'contactName', 'phone', 'email', 'handle'],
  orders: ['platform', 'shopId', 'externalOrderId', 'externalLineId', 'creatorAccountId', 'paidAt', 'status', 'paidAmount', 'productId', 'sku'],
  refunds: ['platform', 'shopId', 'externalRefundId', 'externalOrderId', 'externalLineId', 'refundedAt', 'status', 'amount', 'direction'],
};

const aliases: Record<string, string[]> = {
  platform: ['平台'],
  externalAccountId: ['平台账号ID', '达人账号ID', '抖音UID', '抖音号', '达人ID'],
  name: ['达人名称', '达人昵称', '昵称'],
  displayName: ['账号昵称'],
  category: ['品类', '类目'], tags: ['标签'], source: ['来源'],
  profileUrl: ['主页链接'], contactName: ['联系人'], phone: ['手机号', '联系电话'],
  email: ['邮箱'], handle: ['微信号'], shopId: ['店铺ID'], externalOrderId: ['订单号', '订单ID'],
  externalLineId: ['订单明细ID', '子订单ID'], creatorAccountId: ['平台账号ID', '达人账号ID', '抖音UID'],
  paidAt: ['支付时间'], status: ['状态'], paidAmount: ['支付金额', '实付金额'],
  productId: ['商品ID'], sku: ['SKU'], externalRefundId: ['退款ID', '退款单号'],
  refundedAt: ['退款成功时间'], amount: ['退款金额'], direction: ['方向'],
};

const platformAliases: Record<string, Platform> = {
  douyin: 'douyin', '抖音': 'douyin',
  channels: 'channels', '视频号': 'channels',
  xiaohongshu: 'xiaohongshu', '小红书': 'xiaohongshu',
  kuaishou: 'kuaishou', '快手': 'kuaishou',
};

interface CsvRecord { rowNumber: number; values: string[] }
export interface ParsedCsv {
  headers: string[];
  rows: Array<{ rowNumber: number; values: Record<string, string> }>;
}

/** RFC 4180 subset: escaped quotes, quoted newlines, CRLF and UTF-8 BOM. */
export function parseCsv(text: string): ParsedCsv {
  const input = text.replace(/^\uFEFF/u, '');
  const records: CsvRecord[] = [];
  let fields: string[] = [];
  let field = '';
  let quoted = false;
  let afterQuote = false;
  let line = 1;
  let recordLine = 1;
  const finishField = () => { fields.push(field); field = ''; afterQuote = false; };
  const finishRecord = () => {
    finishField();
    if (fields.some((value) => value.trim().length > 0)) records.push({ rowNumber: recordLine, values: fields });
    fields = [];
    if (records.length > 5001) throw new Error('单次最多导入 5,000 行，请分批上传。');
  };
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (quoted) {
      if (character === '"') {
        if (input[index + 1] === '"') { field += '"'; index += 1; }
        else { quoted = false; afterQuote = true; }
      } else {
        field += character;
        if (character === '\n') line += 1;
      }
      continue;
    }
    if (character === ',') { finishField(); continue; }
    if (character === '\n' || character === '\r') {
      finishRecord();
      if (character === '\r' && input[index + 1] === '\n') index += 1;
      line += 1;
      recordLine = line;
      continue;
    }
    if (afterQuote) {
      if (character === ' ' || character === '\t') continue;
      throw new Error(`第 ${line} 行引号结束后出现无效字符。`);
    }
    if (character === '"') {
      if (field.length > 0) throw new Error(`第 ${line} 行引号必须从字段开头开始。`);
      quoted = true;
      continue;
    }
    field += character;
  }
  if (quoted) throw new Error(`第 ${recordLine} 行存在未闭合的引号。`);
  if (field || fields.length || afterQuote) finishRecord();
  if (!records.length) throw new Error('CSV 没有表头。');
  const headers = records[0].values.map((value) => value.trim());
  if (headers.some((header) => !header) || new Set(headers).size !== headers.length) {
    throw new Error('表头不能为空或重复。');
  }
  if (headers.length > 60) throw new Error('CSV 最多允许 60 列。');
  const rows = records.slice(1).map((record) => {
    if (record.values.length !== headers.length) throw new Error(`第 ${record.rowNumber} 行列数与表头不一致。`);
    return { rowNumber: record.rowNumber, values: Object.fromEntries(headers.map((header, index) => [header, record.values[index].trim()])) };
  });
  if (!rows.length) throw new Error('CSV 只有表头，没有业务记录。');
  return { headers, rows };
}

export function amountToCents(value: string): number | null {
  if (!value.trim()) return null;
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/u.test(value.trim())) {
    throw new Error('金额须为非负十进制数且最多 2 位小数，不支持千分位或科学计数。');
  }
  const [whole, decimal = ''] = value.trim().split('.');
  const cents = BigInt(whole) * 100n + BigInt(decimal.padEnd(2, '0'));
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('金额超过可安全计算的范围。');
  return Number(cents);
}

function importTime(value: string): string | null {
  if (!value) return null;
  let normalized = value;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?$/u.test(value)) {
    normalized = `${value.replace(' ', 'T')}+08:00`;
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/u.test(normalized) || !Number.isFinite(Date.parse(normalized))) {
    throw new Error('时间须为含时区的 ISO 格式，或 YYYY-MM-DD HH:mm:ss（上海时间）。');
  }
  // Reject normalization of invalid dates, e.g. February 30.
  const calendar = normalized.slice(0, 10);
  if (new Date(`${calendar}T00:00:00Z`).toISOString().slice(0, 10) !== calendar) throw new Error('日期不存在。');
  return normalized;
}

function nullable(value: string): string | null { return value.length ? value : null; }

export function prepareCsv(request: CsvImportRequest) {
  const parsed = parseCsv(request.csvText);
  const mapping = request.columnMapping ?? {};
  for (const [canonical, column] of Object.entries(mapping)) {
    if (!csvColumns[request.kind].includes(canonical) || !parsed.headers.includes(column)) {
      throw new Error(`字段映射 ${canonical} → ${column} 无效。`);
    }
  }
  const read = (values: Record<string, string>, key: string): string => {
    if (mapping[key]) return values[mapping[key]] ?? '';
    for (const column of [key, ...(aliases[key] ?? [])]) {
      if (Object.hasOwn(values, column)) return values[column];
    }
    return '';
  };
  const explicitPlatformColumn = [mapping.platform, 'platform', ...(aliases.platform ?? [])]
    .some((column) => Boolean(column && parsed.headers.includes(column)));
  const readPlatform = (values: Record<string, string>): Platform => {
    if (!explicitPlatformColumn) return 'douyin';
    const raw = read(values, 'platform').trim();
    const normalized = platformAliases[raw] ?? platformAliases[raw.toLocaleLowerCase()];
    if (!normalized || !(PLATFORMS as readonly string[]).includes(normalized)) {
      throw new Error(`平台不能为空或不支持：${raw || '空值'}；仅支持抖音、视频号、小红书、快手。`);
    }
    return normalized;
  };
  const required = request.kind === 'creators' ? ['externalAccountId', 'name'] : request.kind === 'orders' ? ['externalOrderId', 'externalLineId'] : ['externalRefundId', 'externalOrderId', 'externalLineId'];
  for (const key of required) {
    if (![mapping[key], key, ...(aliases[key] ?? [])].some((column) => column && parsed.headers.includes(column))) {
      throw new Error(`缺少必需列 ${key}，请使用规范模板或提供字段映射。`);
    }
  }
  const errors: Array<{ rowNumber: number; field?: string; message: string }> = [];
  const creators: ImportCreatorRow[] = [];
  const orders: ImportOrderRow[] = [];
  const refunds: ImportRefundRow[] = [];
  for (const row of parsed.rows) {
    const value = (key: string) => read(row.values, key);
    try {
      for (const key of required) if (!value(key)) throw new Error(`${key} 不能为空。`);
      if (request.kind === 'creators') {
        const url = nullable(value('profileUrl'));
        if (url && !/^https?:\/\//iu.test(url)) throw new Error('主页链接只支持 http/https。');
        creators.push({
          rowNumber: row.rowNumber, platform: readPlatform(row.values), externalAccountId: value('externalAccountId'),
          name: value('name'), displayName: value('displayName') || value('name'), profileUrl: url,
          category: nullable(value('category')), tags: value('tags').split(/[;；|]/u).map((tag) => tag.trim()).filter(Boolean),
          source: value('source') || 'csv',
          contact: ['contactName', 'phone', 'email', 'handle'].some((key) => value(key)) ? {
            contactName: nullable(value('contactName')), phone: nullable(value('phone')),
            email: nullable(value('email')), handle: nullable(value('handle')),
          } : null,
        });
      } else if (request.kind === 'orders') {
        const platform = readPlatform(row.values);
        const sourceStatus = value('status');
        const map: Record<string, ImportOrderRow['status']> = { paid: 'paid', '已支付': 'paid', '已完成': 'paid', pending: 'pending', '待支付': 'pending', cancelled: 'cancelled', '已取消': 'cancelled', closed: 'closed', '已关闭': 'closed', unknown: 'unknown' };
        orders.push({ rowNumber: row.rowNumber, platform, shopId: nullable(value('shopId')), externalOrderId: value('externalOrderId'),
          externalLineId: value('externalLineId'), creatorAccountId: nullable(value('creatorAccountId')),
          productId: nullable(value('productId')), sku: nullable(value('sku')), paidAt: importTime(value('paidAt')),
          sourceStatus, status: map[sourceStatus] ?? 'unknown', paidAmountCents: amountToCents(value('paidAmount')), rawAmount: nullable(value('paidAmount')),
        });
      } else {
        const platform = readPlatform(row.values);
        const sourceStatus = value('status');
        const map: Record<string, ImportRefundRow['status']> = { succeeded: 'succeeded', '退款成功': 'succeeded', pending: 'pending', '处理中': 'pending', reversed: 'reversed', '已冲正': 'reversed', unknown: 'unknown' };
        const direction = value('direction');
        if (direction && !['refund', 'reversal', '退款', '冲正'].includes(direction)) throw new Error('退款方向只支持 refund 或 reversal。');
        refunds.push({ rowNumber: row.rowNumber, platform, shopId: nullable(value('shopId')), externalRefundId: value('externalRefundId'),
          externalOrderId: value('externalOrderId'), externalLineId: value('externalLineId'), refundedAt: importTime(value('refundedAt')),
          sourceStatus, status: map[sourceStatus] ?? 'unknown', amountCents: amountToCents(value('amount')), rawAmount: nullable(value('amount')),
          direction: ['reversal', '冲正'].includes(direction) ? 'reversal' : 'refund',
        });
      }
    } catch (error) {
      errors.push({ rowNumber: row.rowNumber, message: error instanceof Error ? error.message : '数据格式无效。' });
    }
  }
  const sourceName = request.sourceName || `${request.kind}.csv`;
  // Legacy creator rows already included the default platform; order/refund
  // rows did not. Preserve each historical digest shape; explicit-platform CSVs
  // include platform in the digest so otherwise-identical cross-platform files differ.
  const digestRows = explicitPlatformColumn
    ? { creators, orders, refunds }
    : {
      creators,
      orders: orders.map(({ platform: _platform, ...row }) => row),
      refunds: refunds.map(({ platform: _platform, ...row }) => row),
    };
  const digest = createHash('sha256').update(JSON.stringify({ kind: request.kind, sourceName, ...digestRows })).digest('hex');
  const command: ImportPreviewCommand = {
    type: 'import.preview', batchId: `csv-${digest.slice(0, 40)}`, sourceName,
    creators,
    orders: orders.map((row) => ({ ...row, platform: row.platform ?? 'douyin' })),
    refunds: refunds.map((row) => ({ ...row, platform: row.platform ?? 'douyin' })),
  };
  return { ...parsed, errors, command, digest, sourceName };
}

/** Prefix formula-looking cells so CSV exports cannot execute spreadsheet formulas. */
export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[\s]*[=+\-@\t\r]/u.test(text)) text = `'${text}`;
  return `"${text.replace(/"/gu, '""')}"`;
}

export function encodeCsv(columns: string[], rows: unknown[][]): string {
  return `\uFEFF${[columns, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

export function csvTemplate(kind: CsvKind): string {
  return encodeCsv(csvColumns[kind], []);
}
