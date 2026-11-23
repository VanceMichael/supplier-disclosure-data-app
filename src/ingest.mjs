// 数据装载：读取 fixtures 约定的 CSV（或月度录入目录），校验表头与跨表引用，
// 并将字符串字段转为计算所需的数值/列表类型，写入事件存储。
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { parseTable, splitList } from './util/csv.mjs';
import { toInt } from './domain/math.mjs';

export const TABLE_FIELDS = {
  energy: ['record', 'plant', 'phase', 'month', 'product', 'kg', 'kwh', 'known_month', 'source'],
  factors: ['name', 'plant', 'phase', 'from', 'to', 'method', 'grams_per_kwh'],
  certificates: ['certificate', 'plant', 'period', 'kwh', 'known_month', 'status'],
  orders: ['delivery', 'client', 'product', 'month', 'kg', 'method', 'defaults', 'claim_date'],
  claims: ['claim', 'delivery', 'certificate', 'kwh', 'known_month', 'state'],
  contracts: ['client', 'baseline_month', 'allowed_phases', 'sample_floor'],
  'product-mix': ['period', 'customer', 'x_kg', 'y_kg'],
  'stage-links': ['product', 'ordering', 'plant', 'phase', 'method_group'],
  'line-observations': ['observation', 'plant', 'phase', 'month', 'product', 'line', 'run_hours', 'quantity_kg', 'known_month'],
  'common-meters': ['meter', 'plant', 'phase', 'line', 'month', 'auxiliary_kwh', 'allocation_basis', 'allowed_products', 'known_month'],
};

const LINKS = [
  ['claims', 'delivery', 'orders', 'delivery'],
  ['claims', 'certificate', 'certificates', 'certificate'],
  ['energy', 'phase', 'stage-links', 'phase'],
  ['product-mix', 'customer', 'contracts', 'client'],
  ['orders', 'client', 'contracts', 'client'],
  ['line-observations', 'product', 'stage-links', 'product'],
];

const INT_FIELDS = new Set([
  'month', 'kg', 'kwh', 'known_month', 'from', 'to', 'grams_per_kwh', 'period',
  'claim_date', 'baseline_month', 'sample_floor', 'x_kg', 'y_kg', 'ordering',
  'run_hours', 'quantity_kg', 'auxiliary_kwh',
]);
const LIST_FIELDS = new Set(['allowed_phases', 'allowed_products']);

function checkLinks(tables) {
  for (const [table, field, target, key] of LINKS) {
    const keys = new Set(tables[target].map(row => row[key]));
    for (const row of tables[table]) {
      const value = row[field];
      if (value !== '' && value !== '-' && !keys.has(value)) {
        throw new Error(`${table}.${field} 的 ${value} 在 ${target}.${key} 中无对应记录`);
      }
    }
  }
}

export async function readCsvFolder(folder) {
  const dir = folder instanceof URL ? fileURLToPath(folder) : folder;
  const tables = {};
  const names = (await readdir(dir)).filter(name => name.endsWith('.csv')).map(name => name.replace('.csv', ''));
  for (const name of names) {
    if (!TABLE_FIELDS[name]) continue;
    const content = await readFile(join(dir, `${name}.csv`), 'utf8');
    tables[name] = parseTable(content, TABLE_FIELDS[name], name);
  }
  return tables;
}

function typeRow(name, row) {
  const typed = { ...row };
  for (const field of TABLE_FIELDS[name]) {
    if (INT_FIELDS.has(field) && typed[field] !== '') typed[field] = toInt(typed[field]);
    if (LIST_FIELDS.has(field)) typed[field] = splitList(typed[field]);
  }
  return typed;
}

// 全量装载（交接资料或月度目录）。merge 模式允许分目录补充录入。
export async function loadInto(store, folder, { validateLinks = true } = {}) {
  const raw = await readCsvFolder(folder);
  if (validateLinks) checkLinks(raw);
  let count = 0;
  const source = String(folder).includes('fixtures') ? 'handoff' : 'monthly-entry';
  for (const name of Object.keys(TABLE_FIELDS)) {
    if (!raw[name]) continue;
    for (const row of raw[name]) {
      store.append(name, typeRow(name, row), { source });
      count += 1;
    }
  }
  return count;
}

// 单条录入（Web/CLI 表单），按表字段顺序接收对象，做最小校验。
export function enterRow(store, table, values) {
  const fields = TABLE_FIELDS[table];
  if (!fields) throw new Error(`未知数据表：${table}`);
  const row = {};
  for (const field of fields) {
    let value = values[field] ?? '';
    if (INT_FIELDS.has(field) && value !== '') value = toInt(value);
    if (LIST_FIELDS.has(field) && typeof value === 'string') value = splitList(value);
    row[field] = value;
  }
  store.append(table, row, { source: 'manual-entry' });
  return row;
}

export function tableUrl(folder, name) {
  return new URL(`${name}.csv`, pathToFileURL(`${folder}/`));
}
