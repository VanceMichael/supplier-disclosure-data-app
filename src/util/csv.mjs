// CSV 工具：沿用交接资料约定 —— UTF-8、逗号分隔、无引号、无内嵌换行。
// 未提供字段为空字符串；关系值 `-` 表示不适用；多值字段用竖线分隔。

export function parseTable(content, fields, table = '') {
  const lines = content.trimEnd().split(/\r?\n/).filter(line => line.length > 0);
  const header = lines.shift().split(',');
  if (header.length !== fields.length || header.some((field, index) => field !== fields[index])) {
    throw new Error(`${table} 的表头与格式约定不一致`);
  }
  return lines.map((line, index) => {
    const cells = line.split(',');
    if (cells.length !== fields.length || line.includes('"')) {
      throw new Error(`${table} 第 ${index + 2} 行不是约定的字段格式`);
    }
    return Object.fromEntries(fields.map((field, position) => [field, cells[position] ?? '']));
  });
}

export function toCsv(rows, fields) {
  const escape = value => {
    const text = value === null || value === undefined ? '' : String(value);
    if (/[",\n]/.test(text)) {
      throw new Error(`CSV 不支持引号/逗号/换行内嵌值：${text}`);
    }
    return text;
  };
  const lines = [fields.join(',')];
  for (const row of rows) {
    lines.push(fields.map(field => escape(row[field])).join(','));
  }
  return lines.join('\n') + '\n';
}

export function splitList(value) {
  if (value === '' || value === '-') return [];
  return value.split('|').filter(Boolean);
}

export function joinList(values) {
  return values.length ? values.join('|') : '';
}
