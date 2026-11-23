// 应用服务层：把存储、时点状态、分摊、凭证、归因、基期分解、披露串成用例。
import { EventStore } from './store.mjs';
import { loadInto, enterRow, TABLE_FIELDS } from './ingest.mjs';
import { buildState } from './domain/state.mjs';
import { computeAllocations } from './domain/allocation.mjs';
import { ledgerViolations, revocationReview } from './domain/certificates.mjs';
import { buildAllDeliveries, buildDelivery, clientSummary } from './domain/attribution.mjs';
import { baselineReport, decomposition } from './domain/baseline.mjs';
import { clientDisclosure, committeeView, makeSnapshot } from './domain/disclosure.mjs';

export class DisclosureService {
  constructor(store) {
    this.store = store;
    this.snapshots = [];
  }

  static fromFile(file) {
    return new DisclosureService(new EventStore(file));
  }

  async loadFolder(folder, options) {
    return loadInto(this.store, folder, options);
  }

  enter(table, values) {
    return enterRow(this.store, table, values);
  }

  tables() {
    return TABLE_FIELDS;
  }

  runAt(asOf) {
    const state = buildState(this.store, Number(asOf));
    const allocation = computeAllocations(state, this.store.rows('orders'));
    const deliveries = buildAllDeliveries(state, allocation);
    const baselines = baselineReport(state, allocation);
    const decompositions = state.contracts.map(c => decomposition(state, allocation, c.client, Number(asOf)));
    const violations = ledgerViolations(state);
    const revocation = revocationReview(state);
    return { state, allocation, deliveries, baselines, decompositions, violations, revocation };
  }

  disclosureFor(client, asOf) {
    const run = this.runAt(asOf);
    // 只返回脱敏后的披露包；内部全量运行结果绝不挂到可序列化对象上（R17）。
    return clientDisclosure(run.deliveries, client, {
      asOf: Number(asOf),
      snapshots: this.snapshots,
    });
  }

  committee(asOf) {
    const run = this.runAt(asOf);
    return committeeView({
      state: run.state,
      allocation: run.allocation,
      deliveries: run.deliveries,
      baselines: run.baselines,
      decompositions: run.decompositions,
      ledgerViolations: run.violations,
      revocation: run.revocation,
    });
  }

  clientRollup(asOf) {
    const { deliveries } = this.runAt(asOf);
    return clientSummary(deliveries);
  }

  issueSnapshots(asOf) {
    const { deliveries } = this.runAt(asOf);
    const issued = deliveries.map(d => {
      const snap = makeSnapshot(d, Number(asOf));
      this.snapshots.push(snap);
      return snap;
    });
    return issued;
  }

  // 撤销双轨（R16）：区分待复核历史声明与可用新采购方案，保留已签发内容。
  revocationWorkbench(asOf) {
    const run = this.runAt(asOf);
    const affectedDeliveries = run.deliveries.filter(d => d.revoked_claims.length > 0);
    return {
      as_of: Number(asOf),
      revoked_certificates: run.revocation.revoked_certificates,
      history_pending_review: affectedDeliveries.map(d => ({
        delivery: d.delivery,
        client: d.client,
        product: d.product,
        period: d.period,
        revoked_claims: d.revoked_claims,
        preserved_snapshots: this.snapshots.filter(s => s.delivery === d.delivery),
        retraction_required: d.retraction_required,
      })),
      new_procurement_options: affectedDeliveries.map(d => ({
        delivery: d.delivery,
        uncovered_green_demand_kwh: d.uncovered_green_demand_kwh,
        options: d.procurement_options,
      })),
      rule: 'R16',
    };
  }

  singleDelivery(deliveryId, asOf) {
    const run = this.runAt(asOf);
    const order = run.state.orders.find(o => o.delivery === deliveryId);
    if (!order) throw new Error(`时点 ${asOf} 下找不到交付 ${deliveryId}（可能 claim_date 晚于该时点，R1）`);
    return buildDelivery(run.state, run.allocation, order);
  }
}
