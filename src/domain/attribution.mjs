// 交付归因与披露引擎：对每个交付单（产品批）按 as-of 时点证据计算产品碳强度，
// 给出可承诺内容、待补证据、回撤判断与可披露范围。规则编号见 src/rules.mjs。
import { round2, round4, sum } from './math.mjs';
import { findFactor } from './state.mjs';
import { certEligibility, availableCertificates } from './certificates.mjs';

const STAGE_ORDER = (state, product) =>
  state.stageLinks.filter(l => l.product === product)
    .sort((a, b) => Number(a.ordering) - Number(b.ordering))
    .map(l => ({ plant: l.plant, phase: l.phase, method_group: l.method_group }));

function buildStage(state, allocation, order, link, deliveryShare) {
  const contract = state.contracts.find(c => c.client === order.client);
  const floor = contract ? Number(contract.sample_floor) : 0;
  const allowed = contract ? contract.allowed_phases.includes(link.phase) : false;
  const observed = state.observationCounts.get(`${order.product}|${link.plant}|${link.phase}`) || 0;
  const sampleOk = observed >= floor;

  const cell = allocation.cells.find(c =>
    Number(c.period) === Number(order.month) && c.product === order.product &&
    c.plant === link.plant && c.phase === link.phase);

  const stage = {
    plant: link.plant,
    phase: link.phase,
    method_group: link.method_group,
    allowed_by_contract: allowed,
    observations: observed,
    sample_floor: floor,
    sample_ok: sampleOk,
    in_scope: allowed && sampleOk,
    delivery_share: round4(deliveryShare),
    pool_kwh: 0,
    pool_kg: 0,
    kwh: 0,
    grid_kwh: 0,
    contract_kwh: 0,
    default_kwh: 0,
    common_kwh: 0,
    grams: 0,
    factor_breakdown: [],
    evidence: [],
    gaps: [],
  };
  if (!cell) {
    stage.gaps.push({ rule: 'R18', code: 'NO_PRODUCTION_CELL', text: `${link.plant}/${link.phase} 无生产与用电记录` });
    return stage;
  }
  stage.energy_records = cell.energy_records;
  stage.common_sources = cell.common_sources;
  stage.pool_kg = cell.production_kg;
  stage.pool_kwh = round4(cell.direct_kwh + cell.verified_kwh + cell.default_kwh + cell.common_kwh);
  // 该交付按产量份额从产品池归属电量；超产部分（share>1）不自动取得电量与证据。
  stage.kwh = round4(stage.pool_kwh * Math.min(1, deliveryShare));

  // R13/R12：合同不允许或样本不足 → 阶段整体出范围，证据保留为缺口。
  if (!stage.in_scope) {
    const reason = !allowed
      ? { rule: 'R12', code: 'PHASE_NOT_ALLOWED', text: `客户合同未允许阶段 ${link.phase}` }
      : { rule: 'R13', code: 'SAMPLE_FLOOR_NOT_MET', text: `独立观察 ${observed} 条低于样本下限 ${floor}` };
    stage.gaps.push(reason);
    return stage;
  }

  const gridFactor = findFactor(state, link.plant, link.phase, Number(order.month), 'grid');
  const certFactor = findFactor(state, link.plant, link.phase, Number(order.month), 'certificate');
  if (!gridFactor) {
    stage.gaps.push({ rule: 'R10', code: 'NO_GRID_FACTOR', text: `${link.plant}/${link.phase} 第 ${order.month} 期无电网因子` });
  }

  // R3：default 来源仅在客户授权时进入；不授权则出范围并留痕。
  if (cell.default_kwh > 0 && order.defaults !== 'true') {
    stage.gaps.push({ rule: 'R3', code: 'DEFAULT_NOT_AUTHORIZED', text: `${cell.default_kwh}kWh 为 default 来源，客户未授权使用默认值` });
    stage.default_kwh_excluded = cell.default_kwh;
  }
  const usableDefault = order.defaults === 'true' ? cell.default_kwh : 0;

  // 该交付在本阶段可引用的凭证 claim（时点可知 + 地点/期间合格 + 已确认）。
  // 先在产品池层面确认合约电量（不得超过直接归属电量，R5/R6），再按交付份额缩放。
  const directPool = cell.direct_kwh + cell.verified_kwh + usableDefault;
  const poolClaims = [];
  const claimProblems = [];
  let poolClaimKwh = 0;
  for (const claim of state.claims.filter(c => c.delivery === order.delivery)) {
    const cert = claim.cert;
    if (!cert) continue;
    const eligibility = certEligibility(cert, link.plant, Number(order.month));
    if (!eligibility.eligible) {
      claimProblems.push({ claim: claim.claim, certificate: cert.certificate, state: claim.state, problems: eligibility.problems });
      continue;
    }
    if (claim.state === 'requested') {
      claimProblems.push({ claim: claim.claim, certificate: cert.certificate, state: claim.state, problems: ['requested 尚未确认，不计入可披露凭证用量（R7）'] });
      continue;
    }
    const capped = Math.max(0, round4(Math.min(Number(claim.kwh), directPool - poolClaimKwh)));
    if (capped <= 0) {
      claimProblems.push({ claim: claim.claim, certificate: cert.certificate, state: claim.state, problems: ['可匹配直接归属电量不足，凭证用量无法在本阶段确认（R5/R6）'] });
      continue;
    }
    poolClaimKwh = round4(poolClaimKwh + capped);
    poolClaims.push({
      claim: claim.claim, certificate: cert.certificate, state: claim.state,
      pool_kwh: capped, factor: certFactor ? certFactor.factor : null,
      factor_name: certFactor ? certFactor.name : null,
    });
  }
  stage.claim_problems = claimProblems;
  const share = Math.min(1, deliveryShare);

  // 先在产品池层面分层并计算池排放（R10：合约→grid→default 标记；R5：公用段走 grid）。
  const poolLayers = [];
  for (const part of poolClaims) {
    poolLayers.push({
      layer: 'contract', pool_kwh: part.pool_kwh, factor: part.factor, factor_name: part.factor_name,
      source_claim: part.claim, certificate: part.certificate, claim_state: part.state, rule: 'R10',
    });
  }
  const poolGridDirect = round4(directPool - poolClaimKwh);
  if (poolGridDirect > 0) {
    poolLayers.push({
      layer: 'grid', pool_kwh: poolGridDirect, factor: gridFactor?.factor ?? null,
      factor_name: gridFactor?.name ?? null, rule: 'R10',
    });
  }
  if (cell.common_kwh > 0) {
    poolLayers.push({
      layer: 'grid_common', pool_kwh: cell.common_kwh, factor: gridFactor?.factor ?? null,
      factor_name: gridFactor?.name ?? null, rule: 'R5',
    });
  }

  // 池总排放与池 g/kg 率；交付按产量份额缩放电量与排放，使交付强度恒等于池率。
  let poolGrams = 0;
  for (const part of poolLayers) {
    const kwh = round4(part.pool_kwh * share);
    const layer = { ...part, kwh, pool_kwh: part.pool_kwh };
    stage.factor_breakdown.push(layer);
    if (part.layer === 'contract') stage.contract_kwh = round4(stage.contract_kwh + kwh);
    if (part.layer === 'grid' || part.layer === 'grid_common') stage.grid_kwh = round4(stage.grid_kwh + kwh);
    if (part.layer === 'grid_common') stage.common_kwh = round4(stage.common_kwh + kwh);
    if (part.factor === null) {
      stage.gaps.push({ rule: 'R10', code: 'MISSING_FACTOR', text: `${part.layer} ${kwh}kWh 无适用因子` });
    } else {
      poolGrams += part.pool_kwh * part.factor;
    }
  }
  stage.default_kwh = round4(usableDefault * share);
  stage.pool_grams = round4(poolGrams);
  stage.pool_grams_per_kg = cell.production_kg > 0 ? round4(poolGrams / cell.production_kg) : null;
  // 交付排放 = 池 g/kg 率 × 交付归属产量（份额×池产量，封顶为交付重量），
  // 使交付强度恒等于池率；超产无证据部分不进排放与分母（R14）。
  const attributableKg = Math.min(Number(order.kg), share * cell.production_kg);
  stage.attributable_kg = round4(attributableKg);
  const grams = stage.pool_grams_per_kg !== null
    ? round4(stage.pool_grams_per_kg * attributableKg)
    : 0;
  stage.grams = round4(grams);
  stage.evidence = [...(cell.energy_records || []), ...poolClaims.map(p => p.claim)];
  return stage;
}

export function buildDelivery(state, allocation, order) {
  // 交付在产品池中的产量份额（同一期同产品的所有交付合计可能超过报送产量 → R14）。
  const periodDeliveries = state.orders.filter(o => Number(o.month) === Number(order.month) && o.product === order.product);
  const totalDeliveryKg = sum(periodDeliveries.map(o => Number(o.kg)));
  const deliveryShare = totalDeliveryKg > 0 ? Number(order.kg) / totalDeliveryKg : 0;
  const stages = STAGE_ORDER(state, order.product).map(link => buildStage(state, allocation, order, link, deliveryShare));
  const inScopeStages = stages.filter(s => s.in_scope);
  const grams = round4(sum(inScopeStages.map(s => s.grams)));
  const kwh = round4(sum(inScopeStages.map(s => s.kwh)));

  // R14：可证据覆盖产量为各在范围阶段归属产量之和；超产无证据部分不进强度分母。
  const coveredKg = round4(sum(inScopeStages.map(s => s.attributable_kg || 0)));
  const uncoveredKg = round4(Math.max(0, Number(order.kg) - coveredKg));
  const intensity = coveredKg > 0 ? round4(grams / coveredKg) : null;

  // 超产无证据部分（R14）。
  const overrun = allocation.overrun.find(o => Number(o.period) === Number(order.month) && o.product === order.product);

  // 凭证撤销对本交付的影响（R9/R16）。
  const revokedClaims = [];
  for (const claim of state.claims.filter(c => c.delivery === order.delivery)) {
    if (claim.cert && claim.cert.status === 'revoked') {
      revokedClaims.push({
        claim: claim.claim, certificate: claim.cert.certificate, kwh: Number(claim.kwh),
        state: claim.state,
        disposition: claim.state === 'signed' ? '历史声明待复核（R16）' : '未确认引用失效，需补证（R9）',
      });
    }
  }

  // 待补证与可承诺判断。
  const needsEvidence = [];
  for (const stage of stages) {
    for (const gap of stage.gaps) needsEvidence.push({ phase: stage.phase, ...gap });
    for (const problem of stage.claim_problems || []) {
      needsEvidence.push({ phase: stage.phase, rule: 'R6', code: 'CLAIM_NOT_CONFIRMED', text: `${problem.claim}（${problem.certificate}）：${problem.problems.join('；')}` });
    }
  }
  if (overrun) needsEvidence.push({ rule: 'R14', code: 'DELIVERY_OVERRUN', text: overrun.impact || `超产 ${overrun.gap_kg}kg 无生产证据` });

  const uncoveredGreen = round4(sum(inScopeStages.map(s =>
    Math.max(0, (s.kwh - s.common_kwh) - s.contract_kwh))));
  const procurementOptions = order.method === 'certificate'
    ? availableCertificates(state, inScopeStages[0]?.plant, Number(order.month), order.delivery)
    : [];

  const blockingCodes = new Set(['DELIVERY_OVERRUN', 'NO_PRODUCTION_CELL', 'PHASE_NOT_ALLOWED', 'SAMPLE_FLOOR_NOT_MET']);
  const committable = inScopeStages.length > 0 &&
    !needsEvidence.some(e => blockingCodes.has(e.code)) &&
    uncoveredKg === 0;

  // 回撤判断：已作采购承诺（signed）的凭证失效 → 需要回撤/更正声明。
  const retractionRequired = revokedClaims.some(c => c.state === 'signed');

  return {
    delivery: order.delivery,
    client: order.client,
    product: order.product,
    period: Number(order.month),
    kg: Number(order.kg),
    covered_kg: coveredKg,
    uncovered_kg: uncoveredKg,
    method: order.method,
    defaults_allowed: order.defaults === 'true',
    claim_date: Number(order.claim_date),
    as_of: state.asOf,
    stages,
    in_scope_phases: inScopeStages.map(s => s.phase),
    scope_kwh: kwh,
    scope_grams: grams,
    carbon_intensity_g_per_kg: intensity,
    grid_kwh: round4(sum(inScopeStages.map(s => s.grid_kwh))),
    contract_kwh: round4(sum(inScopeStages.map(s => s.contract_kwh))),
    default_kwh: round4(sum(inScopeStages.map(s => s.default_kwh))),
    uncovered_green_demand_kwh: order.method === 'certificate' ? uncoveredGreen : 0,
    procurement_options: procurementOptions,
    revoked_claims: revokedClaims,
    needs_evidence: needsEvidence,
    overrun: overrun || null,
    committable,
    retraction_required: retractionRequired,
    commitment: commitmentText(order, inScopeStages, intensity, retractionRequired),
  };
}

function commitmentText(order, stages, intensity, retraction) {
  if (stages.length === 0) {
    return '无可披露阶段：合同允许范围与样本下限均未满足，不能承诺碳强度，仅披露缺口。';
  }
  const phases = stages.map(s => s.phase).join('、');
  const basis = order.method === 'certificate' ? '合约因子（已确认凭证用量）+ 电网因子回落' : '电网因子';
  const tail = retraction ? '注意：存在已签发凭证被撤销，原承诺需回撤更正（R16）。'
    : `可按 ${basis} 承诺 ${phases} 阶段的产品碳强度 ${intensity} g/kg。`;
  return tail;
}

export function buildAllDeliveries(state, allocation) {
  return state.orders.map(order => buildDelivery(state, allocation, order));
}

export function clientSummary(deliveries) {
  const byClient = new Map();
  for (const d of deliveries) {
    if (!byClient.has(d.client)) byClient.set(d.client, []);
    byClient.get(d.client).push(d);
  }
  const summary = [];
  for (const [client, list] of byClient) {
    // 加权强度按可证据覆盖产量计，避免超产无证据部分稀释口径（R14）。
    const kg = sum(list.map(d => d.covered_kg));
    const grams = sum(list.map(d => d.scope_grams));
    summary.push({
      client,
      deliveries: list.map(d => d.delivery),
      total_kg: sum(list.map(d => d.kg)),
      covered_kg: kg,
      uncovered_kg: sum(list.map(d => d.uncovered_kg)),
      total_grams: grams,
      weighted_intensity_g_per_kg: kg > 0 ? round4(grams / kg) : null,
      retraction_required: list.some(d => d.retraction_required),
    });
  }
  return summary;
}
