import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const folder = new URL('../fixtures/', import.meta.url);

export function parseTable(content, fields, table) {
  const lines = content.trimEnd().split(/\r?\n/);
  const header = lines.shift().split(',');
  if (header.length !== fields.length || header.some((field, index) => field !== fields[index])) {
    throw new Error(`${table} 的表头与格式约定不一致`);
  }
  return lines.map((line, index) => {
    const cells = line.split(',');
    if (cells.length !== fields.length || line.includes('"')) {
      throw new Error(`${table} 第 ${index + 2} 行不是约定的字段格式`);
    }
    return Object.fromEntries(fields.map((field, position) => [field, cells[position]]));
  });
}

export function checkLinks(tables, links) {
  for (const [table, field, target, key] of links) {
    const keys = new Set(tables[target].map(row => row[key]));
    for (const row of tables[table]) {
      const value = row[field];
      if (value !== '' && value !== '-' && !keys.has(value)) {
        throw new Error(`${table}.${field} 的 ${value} 在 ${target}.${key} 中无对应记录`);
      }
    }
  }
}

export async function checkMaterials(source = folder) {
  const format = JSON.parse(await readFile(new URL('format.json', source), 'utf8'));
  const tables = {};
  for (const [name, fields] of Object.entries(format.tables)) {
    const content = await readFile(new URL(`${name}.csv`, source), 'utf8');
    tables[name] = parseTable(content, fields, name);
    if (tables[name].length === 0) {
      throw new Error(`${name} 没有交接记录`);
    }
  }
  checkLinks(tables, format.links);
  return Object.fromEntries(Object.entries(tables).map(([name, rows]) => [name, rows.length]));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const counts = await checkMaterials();
  console.log(JSON.stringify({ 状态: '资料可读取', 记录数: counts }, null, 2));
}
