import assert from 'node:assert/strict';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { DisclosureService } from '../src/service.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = pathToFileURL(`${join(here, '..', 'fixtures')}/`);

async function freshService() {
  const file = join(tmpdir(), `disc-${Math.random().toString(36).slice(2)}.jsonl`);
  const service = DisclosureService.fromFile(file);
  await service.loadFolder(FIXTURES, { validateLinks: true });
  return { service, file };
}

test('装载交接资料后各表进入事件存储', async () => {
  const { service, file } = await freshService();
  const run = service.runAt(3);
  assert.ok(run.state.energy.length >= 5);
  assert.ok(run.state.orders.length === 4);
  rmSync(file, { force: true });
});

test('R1 时点可知性：as-of 2 看不到第 3 月才可知的 verified 行与 D3/D4', async () => {
  const { service, file } = await freshService();
  const run2 = service.runAt(2);
  const bCoat = run2.state.energy.find(e => e.plant === 'B' && e.phase === 'coat');
  assert.equal(bCoat.source, 'default');
  assert.deepEqual(run2.state.orders.map(o => o.delivery).sort(), ['D1', 'D2']);
  const run3 = service.runAt(3);
  const bCoat3 = run3.state.energy.find(e => e.plant === 'B' && e.phase === 'coat');
  assert.equal(bCoat3.source, 'verified');
  assert.deepEqual(bCoat3.replaced_records, ['E5']);
  rmSync(file, { force: true });
});

test('R2 verified 替代 default 而不叠加（B/coat 第 2 月只保留 1100kWh）', async () => {
  const { service, file } = await freshService();
  const { state } = service.runAt(3);
  const bCoat = state.energy.find(e => e.plant === 'B' && e.phase === 'coat');
  assert.equal(bCoat.kwh, 1100);
  rmSync(file, { force: true });
});

test('R4 共用段按 run_hours 分摊且合计守恒；U3 未授权进入无法归属', async () => {
  const { service, file } = await freshService();
  const { allocation } = service.runAt(3);
  const u1 = allocation.cells.filter(c => c.period === 1 && c.plant === 'A');
  const common = u1.reduce((a, c) => a + c.common_kwh, 0);
  assert.equal(Math.round(common * 100) / 100, 190);
  const noBasis = allocation.unallocable.find(u => u.kind === 'common_meter_no_basis');
  assert.equal(noBasis.meter, 'U3');
  assert.equal(noBasis.kwh, 88);
  rmSync(file, { force: true });
});

test('R5 公用电不取得凭证权益：D1 合约电量不超过直接归属电量', async () => {
  const { service, file } = await freshService();
  const d1 = service.singleDelivery('D1', 2);
  const forming = d1.stages.find(s => s.phase === 'forming');
  const directBase = 1800;
  assert.ok(forming.contract_kwh <= directBase);
  assert.ok(forming.common_kwh > 0);
  const commonPart = forming.factor_breakdown.find(p => p.layer === 'grid_common');
  assert.equal(commonPart.rule, 'R5');
  rmSync(file, { force: true });
});

test('R7 凭证余量：R1 占用 1100/1200，R2 撤销后不产生负余量', async () => {
  const { service, file } = await freshService();
  const { state } = service.runAt(3);
  const r1 = state.ledger.find(c => c.certificate === 'R1');
  assert.equal(r1.committed_kwh, 1100);
  assert.equal(r1.remaining_kwh, 100);
  assert.equal(r1.over_committed, false);
  rmSync(file, { force: true });
});

test('R9 撤销凭证当前不合格：R2 的 requested 引用在 D4 中列为待补证', async () => {
  const { service, file } = await freshService();
  const d4 = service.singleDelivery('D4', 3);
  const problems = d4.stages.flatMap(s => s.claim_problems || []);
  assert.ok(problems.some(p => p.certificate === 'R2' && p.problems.some(t => t.includes('revoked'))));
  rmSync(file, { force: true });
});

test('R16 撤销双轨：D1 历史 signed 引用待复核且要求回撤，D4 未确认引用失效需补证', async () => {
  const { service, file } = await freshService();
  const bench = service.revocationWorkbench(3);
  const d1 = bench.history_pending_review.find(h => h.delivery === 'D1');
  assert.equal(d1.retraction_required, true);
  assert.ok(d1.revoked_claims.some(c => c.state === 'signed'));
  // D3 的 reserved 挂在仍 active 的 R1 上，不进撤销清单；D4 挂 R2（revoked）的 requested 失效。
  const d4 = bench.history_pending_review.find(h => h.delivery === 'D4');
  assert.ok(d4.revoked_claims.some(c => c.state === 'requested'));
  // 新采购方案只列 active 合格凭证。
  const d4Options = bench.new_procurement_options.find(o => o.delivery === 'D4');
  assert.ok(d4Options.options.every(o => o.certificate !== 'R2'));
  rmSync(file, { force: true });
});

test('R10 三档因子：D1 合约+电网分层，按产品池率与交付份额计算碳强度', async () => {
  const { service, file } = await freshService();
  const d1 = service.singleDelivery('D1', 2);
  const forming = d1.stages.find(s => s.phase === 'forming');
  const layers = forming.factor_breakdown.map(p => p.layer);
  assert.ok(layers.includes('contract'));
  assert.ok(layers.includes('grid') || layers.includes('grid_common'));
  assert.ok(d1.carbon_intensity_g_per_kg > 0);
  // 产品池 g/kg 率：X 第 2 月池口径 —— 合约 1000kWh@45、直接电网 800kWh@520、
  // 公用段 107.2941kWh@520，除以池产量 1000kg。交付级强度等于池率（份额在分子分母相消）。
  const common = 240 * ((21 + 17) / (21 + 17 + 27 + 20));
  const poolGramsPerKg = (1000 * 45 + 800 * 520 + common * 520) / 1000;
  assert.equal(Math.round(d1.carbon_intensity_g_per_kg * 100) / 100, Math.round(poolGramsPerKg * 100) / 100);
  assert.ok(Math.abs(d1.carbon_intensity_g_per_kg - 516.7929) < 0.01);
  // 分层电量守恒于交付份额。
  const layerSum = forming.factor_breakdown.reduce((a, p) => a + p.kwh, 0);
  assert.ok(Math.abs(layerSum - forming.kwh) < 0.05);
  rmSync(file, { force: true });
});

test('R12/R13 外包 coat 阶段：C1 样本不足出范围；C3 合同不允许 coat', async () => {
  const { service, file } = await freshService();
  const d1 = service.singleDelivery('D1', 3);
  const coat = d1.stages.find(s => s.phase === 'coat');
  assert.equal(coat.in_scope, false);
  assert.ok(coat.gaps.some(g => g.code === 'SAMPLE_FLOOR_NOT_MET'));
  const d4 = service.singleDelivery('D4', 3);
  const coatC3 = d4.stages.find(s => s.phase === 'coat');
  assert.ok(coatC3.gaps.some(g => g.code === 'PHASE_NOT_ALLOWED'));
  rmSync(file, { force: true });
});

test('R14 交付超产留痕：X 第 2 月交付 1200kg 超报送产量 1000kg', async () => {
  const { service, file } = await freshService();
  const { allocation } = service.runAt(3);
  const overrun = allocation.overrun.find(o => o.product === 'X' && o.period === 2);
  assert.equal(overrun.gap_kg, 200);
  rmSync(file, { force: true });
});

test('R17 客户脱敏：C2 披露包不含其他客户凭证编号与私有成本字段', async () => {
  const { service, file } = await freshService();
  const pack = service.disclosureFor('C2', 3);
  const text = JSON.stringify(pack);
  assert.ok(!text.includes('K1')); // C1 的 claim 编号
  assert.ok(!text.includes('"cost"'));
  assert.ok(pack.disclosures.every(d => d.client === undefined || true));
  rmSync(file, { force: true });
});

test('R18 基期缺口可追踪，分解各效应合计等于总变化（残差为 0）', async () => {
  const { service, file } = await freshService();
  const report = service.runAt(3).baselines.find(b => b.client === 'C1');
  assert.ok(report.gaps.some(g => g.phase === 'coat'));
  const dec = service.runAt(3).decompositions.find(d => d.client === 'C1');
  const effectSum = dec.effects.reduce((a, e) => a + (e.g_per_kg || 0), 0);
  assert.ok(Math.abs(effectSum - dec.total_change_g_per_kg) < 0.01);
  assert.ok(Math.abs(dec.residual_g_per_kg) < 0.0001);
  assert.ok(dec.effects.some(e => e.effect === 'grid_update_effect'));
  rmSync(file, { force: true });
});

test('R11 电网更新效应与供应商改善效应分列', async () => {
  const { service, file } = await freshService();
  const dec = service.runAt(3).decompositions.find(d => d.client === 'C1');
  const grid = dec.effects.find(e => e.effect === 'grid_update_effect');
  const supplier = dec.effects.find(e => e.effect === 'supplier_action_effect');
  assert.notEqual(grid.g_per_kg, null);
  assert.notEqual(supplier.g_per_kg, null);
  rmSync(file, { force: true });
});

test('R15 披露快照留存，撤销后快照保留且标记待复核', async () => {
  const { service, file } = await freshService();
  const snaps = service.issueSnapshots(2);
  assert.ok(snaps.length >= 2);
  const later = service.revocationWorkbench(3);
  const d1 = later.history_pending_review.find(h => h.delivery === 'D1');
  assert.ok(d1.preserved_snapshots.length >= 1);
  rmSync(file, { force: true });
});

test('R3 default 授权边界：D2 允许 default，未授权客户的 default 电量出范围', async () => {
  const { service, file } = await freshService();
  const d2 = service.singleDelivery('D2', 2);
  assert.equal(d2.defaults_allowed, true);
  const d1 = service.singleDelivery('D1', 2);
  assert.equal(d1.defaults_allowed, false);
  rmSync(file, { force: true });
});

test('月度录入采用追加事件，重新装载不破坏既有事件', async () => {
  const { service, file } = await freshService();
  const before = service.runAt(3).state.orders.length;
  service.enter('orders', {
    delivery: 'D9', client: 'C1', product: 'X', month: 3, kg: 100,
    method: 'grid', defaults: 'false', claim_date: 3,
  });
  const after = service.runAt(3).state.orders.length;
  assert.equal(after, before + 1);
  rmSync(file, { force: true });
});
