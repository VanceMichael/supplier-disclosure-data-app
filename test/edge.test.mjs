import assert from 'node:assert/strict';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { rmSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { DisclosureService } from '../src/service.mjs';
import { ledgerViolations } from '../src/domain/certificates.mjs';
import { buildState } from '../src/domain/state.mjs';
import { server } from '../src/server.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = pathToFileURL(`${join(here, '..', 'fixtures')}/`);

async function freshService() {
  const file = join(tmpdir(), `disc-edge-${Math.random().toString(36).slice(2)}.jsonl`);
  const service = DisclosureService.fromFile(file);
  await service.loadFolder(FIXTURES, { validateLinks: false });
  return { service, file };
}

test('R7 构造超分场景：同一凭证 signed+reserved 超过容量即被台账判违规', async () => {
  const { service, file } = await freshService();
  // R1 容量 1200，再追加两条占用使其超过 1200。
  service.enter('claims', { claim: 'K9', delivery: 'D2', certificate: 'R1', kwh: 500, known_month: 2, state: 'signed' });
  const state = buildState(service.store, 3);
  const violations = ledgerViolations(state);
  const r1 = violations.find(v => v.certificate === 'R1');
  assert.ok(r1, 'R1 应被识别为超分');
  assert.ok(r1.excess_kwh > 0);
  rmSync(file, { force: true });
});

test('R6 期间不符：凭证期间与订单期间不一致进入违规清单', async () => {
  const { service, file } = await freshService();
  // R3 是第 1 期凭证，挂到第 2 期订单 D2 上。
  service.enter('claims', { claim: 'K8', delivery: 'D2', certificate: 'R3', kwh: 100, known_month: 2, state: 'signed' });
  const state = buildState(service.store, 3);
  const violations = ledgerViolations(state);
  assert.ok(violations.some(v => v.rule === 'R6' && v.certificate === 'R3'));
  rmSync(file, { force: true });
});

test('追加录入在 as-of 早于 known_month 时不可见（R1 端到端）', async () => {
  const { service, file } = await freshService();
  service.enter('orders', {
    delivery: 'D9', client: 'C1', product: 'Y', month: 3, kg: 120,
    method: 'grid', defaults: 'false', claim_date: 4,
  });
  assert.equal(service.runAt(3).state.orders.some(o => o.delivery === 'D9'), false);
  assert.equal(service.runAt(4).state.orders.some(o => o.delivery === 'D9'), true);
  rmSync(file, { force: true });
});

test('HTTP API：健康检查、客户披露脱敏、委员会视图可用', async () => {
  const http = await import('node:http');
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  const get = path => new Promise((resolve, reject) => {
    http.get(`http://localhost:${port}${path}`, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(body) }));
    }).on('error', reject);
  });
  const health = await get('/api/health');
  assert.equal(health.status, 200);
  const disc = await get('/api/disclosure?client=C2&as_of=3');
  assert.equal(disc.json.audience, 'client');
  assert.ok(!JSON.stringify(disc.json).includes('K1'));
  const committee = await get('/api/committee?as_of=3');
  assert.equal(committee.json.audience, 'committee');
  assert.ok(Array.isArray(committee.json.allocations));
  await new Promise(resolve => server.close(resolve));
});
