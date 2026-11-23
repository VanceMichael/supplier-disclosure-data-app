// 零依赖 HTTP 服务：采购与披露人员每月通过网页录入、查询披露与委员会多维结果。
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { DisclosureService } from './service.mjs';
import { parseTable } from './util/csv.mjs';
import { TABLE_FIELDS } from './ingest.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const STORE = resolve(process.env.STORE_FILE || 'data/events.jsonl');
const service = DisclosureService.fromFile(STORE);
const PORT = Number(process.env.PORT || 8787);

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body, null, 2));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  return JSON.parse(raw);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  try {
    if (req.method === 'GET' && path === '/api/health') {
      return send(res, 200, { ok: true, store: STORE });
    }
    if (req.method === 'GET' && path === '/api/tables') {
      return send(res, 200, TABLE_FIELDS);
    }
    if (req.method === 'POST' && path === '/api/ingest-folder') {
      const { folder } = await readBody(req);
      const count = await service.loadFolder(resolve(folder), {});
      return send(res, 200, { loaded: count });
    }
    if (req.method === 'POST' && path === '/api/rows') {
      const body = await readBody(req);
      const row = service.enter(body.table, body.values || {});
      return send(res, 201, { table: body.table, row });
    }
    if (req.method === 'POST' && path === '/api/rows-csv') {
      // 粘贴 CSV 文本批量录入。
      const { table, csv } = await readBody(req);
      const rows = parseTable(csv, TABLE_FIELDS[table], table);
      for (const values of rows) service.enter(table, values);
      return send(res, 201, { table, inserted: rows.length });
    }
    if (req.method === 'GET' && path === '/api/disclosure') {
      const client = url.searchParams.get('client');
      const asOf = Number(url.searchParams.get('as_of') || 3);
      return send(res, 200, service.disclosureFor(client, asOf));
    }
    if (req.method === 'GET' && path === '/api/delivery') {
      const id = url.searchParams.get('id');
      const asOf = Number(url.searchParams.get('as_of') || 3);
      return send(res, 200, service.singleDelivery(id, asOf));
    }
    if (req.method === 'GET' && path === '/api/committee') {
      const asOf = Number(url.searchParams.get('as_of') || 3);
      return send(res, 200, service.committee(asOf));
    }
    if (req.method === 'GET' && path === '/api/baseline') {
      const asOf = Number(url.searchParams.get('as_of') || 3);
      return send(res, 200, service.runAt(asOf).baselines);
    }
    if (req.method === 'GET' && path === '/api/decomposition') {
      const client = url.searchParams.get('client');
      const asOf = Number(url.searchParams.get('as_of') || 3);
      const found = service.runAt(asOf).decompositions.find(d => d.client === client);
      return send(res, 200, found || { error: `无客户 ${client} 的分解结果` });
    }
    if (req.method === 'GET' && path === '/api/revocation') {
      const asOf = Number(url.searchParams.get('as_of') || 3);
      return send(res, 200, service.revocationWorkbench(asOf));
    }
    if (req.method === 'POST' && path === '/api/snapshots') {
      const { as_of } = await readBody(req);
      return send(res, 201, service.issueSnapshots(Number(as_of || 3)));
    }
    if (req.method === 'GET' && path === '/') {
      const html = await readFile(resolve(here, 'web/index.html'), 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    send(res, 404, { error: '未找到路由' });
  } catch (error) {
    send(res, 400, { error: error.message });
  }
});

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  server.listen(PORT, () => console.log(`披露数据应用已启动：http://localhost:${PORT}（存储 ${STORE}）`));
}

export { server };
