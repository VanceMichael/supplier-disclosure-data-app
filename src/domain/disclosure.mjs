// 披露模块：按提出披露的客户、当时可知证据和产品批生成披露包；
// 客户材料脱敏（R17），委员会保留多维全量；每次披露留存快照（R15）。
import { RULES } from '../rules.mjs';

const PRIVATE_FIELDS = ['cost', 'unit_cost', 'supplier_cost', 'private_cost'];

function stripPrivate(obj) {
  if (Array.isArray(obj)) return obj.map(stripPrivate);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [key, value] of Object.entries(obj)) {
      if (PRIVATE_FIELDS.includes(key)) continue;
      out[key] = stripPrivate(value);
    }
    return out;
  }
  return obj;
}

// 客户视图：只保留本客户凭证编号与采购量；其他客户的凭证编号、采购量一律掩码（R17）。
function redactForClient(delivery, client) {
  const d = stripPrivate(structuredClone(delivery));
  const ownDelivery = d.client === client;
  for (const stage of d.stages) {
    for (const part of stage.factor_breakdown || []) {
      if (part.layer === 'contract' && !ownDelivery) {
        part.certificate = '***';
        part.source_claim = '***';
      }
    }
    for (const problem of stage.claim_problems || []) {
      if (!ownDelivery) {
        problem.claim = '***';
        problem.certificate = '***';
      }
    }
  }
  for (const item of d.revoked_claims || []) {
    if (!ownDelivery) {
      item.claim = '***';
      item.certificate = '***';
    }
  }
  // 采购方案中其他客户占用情况不暴露编号与用量。
  d.procurement_options = (d.procurement_options || []).map(opt => ({
    certificate: opt.certificate,
    plant: opt.plant,
    period: opt.period,
    available_for_delivery_kwh: opt.available_for_delivery_kwh,
    note: '其他客户的凭证编号与采购量不予列示（R17）',
  }));
  return d;
}

export function clientDisclosure(deliveries, client, { asOf, snapshots = [] } = {}) {
  const mine = deliveries.filter(d => d.client === client);
  const packages = mine.map(d => {
    const view = redactForClient(d, client);
    return {
      delivery: view.delivery,
      product: view.product,
      period: view.period,
      kg: view.kg,
      as_of: asOf,
      can_commit: view.committable,
      commitment: view.commitment,
      carbon_intensity_g_per_kg: view.carbon_intensity_g_per_kg,
      in_scope_phases: view.in_scope_phases,
      factor_basis: view.stages.map(s => ({
        phase: s.phase,
        method_group: s.method_group,
        delivery_share: s.delivery_share,
        layers: s.factor_breakdown.map(p => ({
          layer: p.layer, kwh: p.kwh, factor: p.factor,
          certificate: p.certificate, source_claim: p.source_claim,
          claim_state: p.claim_state, rule: p.rule,
        })),
      })),
      default_marked_kwh: view.default_kwh,
      evidence_needed: view.needs_evidence,
      revoked_claims: view.revoked_claims.map(c => ({
        claim: c.claim, certificate: c.certificate, kwh: c.kwh, disposition: c.disposition,
      })),
      retraction_required: view.retraction_required,
      procurement_plan: view.procurement_options,
    };
  });
  return {
    audience: 'client',
    client,
    as_of: asOf,
    rule_references: ['R1', 'R3', 'R5', 'R6', 'R7', 'R10', 'R14', 'R15', 'R16', 'R17'],
    rule_text: Object.fromEntries(['R1', 'R3', 'R5', 'R6', 'R7', 'R10', 'R14', 'R15', 'R16', 'R17'].map(id => [id, RULES[id].title])),
    disclosures: packages,
    prior_snapshots: snapshots.filter(s => s.client === client).map(s => ({
      snapshot_id: s.snapshot_id, claim_date: s.claim_date, delivery: s.delivery,
      intensity: s.intensity, status: s.status,
    })),
  };
}

// 采购委员会视图：规则对齐的多维结果，含分摊明细、台账占用与无法归属量。
export function committeeView({ state, allocation, deliveries, baselines, decompositions, ledgerViolations, revocation }) {
  return stripPrivate({
    audience: 'committee',
    as_of: state.asOf,
    allocations: allocation.cells.map(c => ({
      period: c.period, plant: c.plant, phase: c.phase, product: c.product,
      method_group: c.method_group,
      direct_kwh: c.direct_kwh, verified_kwh: c.verified_kwh, default_kwh: c.default_kwh,
      common_kwh: c.common_kwh, production_kg: c.production_kg,
      energy_records: c.energy_records, common_sources: c.common_sources,
    })),
    unallocable: allocation.unallocable,
    certificate_ledger: state.ledger,
    ledger_violations: ledgerViolations,
    deliveries: deliveries.map(d => ({
      delivery: d.delivery, client: d.client, product: d.product, period: d.period, kg: d.kg,
      carbon_intensity_g_per_kg: d.carbon_intensity_g_per_kg,
      grid_kwh: d.grid_kwh, contract_kwh: d.contract_kwh, default_kwh: d.default_kwh,
      in_scope_phases: d.in_scope_phases,
      needs_evidence: d.needs_evidence, revoked_claims: d.revoked_claims,
      retraction_required: d.retraction_required,
    })),
    baselines,
    decompositions,
    revocation_review: revocation,
    rules: RULES,
  });
}

export function makeSnapshot(delivery, asOf) {
  return {
    snapshot_id: `SNAP-${delivery.delivery}-${asOf}-${Date.now().toString(36)}`,
    client: delivery.client,
    delivery: delivery.delivery,
    claim_date: delivery.claim_date,
    as_of: asOf,
    intensity: delivery.carbon_intensity_g_per_kg,
    scope_grams: delivery.scope_grams,
    scope_kwh: delivery.scope_kwh,
    factor_breakdown: delivery.stages.flatMap(s => (s.factor_breakdown || []).map(p => ({ phase: s.phase, ...p }))),
    status: delivery.retraction_required ? 'PENDING_REVIEW' : 'ISSUED',
    issued_content_preserved: true,
  };
}
