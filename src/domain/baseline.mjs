// 基期与强度变化分解：共用基期对比各期实际构成，分别解释
// 数据覆盖（coverage）、采购/产品结构（structure）、强度（intensity，再拆
// 电网因子更新 grid_update 与供应商绿电改善 supplier_action）。
// 基期无可比段标记 gap 并追踪，不静默丢弃（R18）；电网因子更新单列，不冒充供应商改善（R11）。
import { round4, sum, weightedFactor } from './math.mjs';
import { findFactor } from './state.mjs';

function mixWeights(state, client, period) {
  const rows = state.productMix.filter(r => r.customer === client).map(r => Number(r.period));
  // 时点视角：取不晚于所请求期间的最近一期结构记录；缺口在 gap_trace 中注明。
  const usable = rows.filter(p => p <= period).sort((a, b) => b - a);
  const chosenPeriod = usable[0] ?? Math.min(...rows);
  const row = state.productMix.find(r => r.customer === client && Number(r.period) === chosenPeriod);
  if (!row) return null;
  const entries = [
    { product: 'X', kg: Number(row.x_kg) },
    { product: 'Y', kg: Number(row.y_kg) },
  ].filter(e => e.kg > 0);
  const total = sum(entries.map(e => e.kg));
  return {
    period: chosenPeriod,
    requested_period: Number(period),
    period_note: chosenPeriod !== Number(period)
      ? `第 ${period} 期无结构记录，采用最近可知的第 ${chosenPeriod} 期（R1/R18）`
      : '',
    total,
    weights: entries.map(e => ({ product: e.product, kg: e.kg, share: total > 0 ? e.kg / total : 0 })),
  };
}

function stageIntensity(state, allocation, product, plant, phase, period, factorContext, mode) {
  const cell = allocation.cells.find(c =>
    Number(c.period) === Number(period) && c.product === product && c.plant === plant && c.phase === phase);
  if (!cell) return { missing: true, reason: 'NO_CELL' };
  const kwh = round4(cell.direct_kwh + cell.verified_kwh + cell.default_kwh + cell.common_kwh);
  if (kwh <= 0) return { missing: true, reason: 'ZERO_KWH' };

  if (mode === 'current') {
    // 复用交付口径不便（交付与 mix 口径不同），这里按分层因子直接计算。
    const parts = [];
    const grid = factorContext.gridFactor(plant, phase, period);
    const certF = factorContext.certFactor(plant, phase, period);
    const contractKwh = factorContext.confirmedContractKwh(plant, phase, period, product);
    const directBase = cell.direct_kwh + cell.verified_kwh + cell.default_kwh;
    const usedCert = Math.min(contractKwh, directBase);
    if (usedCert > 0) parts.push({ kwh: usedCert, factor: certF?.factor ?? grid?.factor ?? 0 });
    const rest = kwh - usedCert;
    if (rest > 0) parts.push({ kwh: rest, factor: grid?.factor ?? 0 });
    return {
      missing: false, kwh, kg: cell.production_kg,
      factor: weightedFactor(parts),
      grid_factor: grid?.factor ?? null,
      contract_kwh: usedCert,
    };
  }
  // baseline：只用电网因子（基期无已确认绿电合约份额时）。
  const grid = factorContext.gridFactor(plant, phase, period);
  return {
    missing: false, kwh, kg: cell.production_kg,
    factor: grid ? grid.factor : null,
    grid_factor: grid?.factor ?? null,
    contract_kwh: 0,
  };
}

function productIntensity(state, allocation, client, product, period, factorContext, mode) {
  const contract = state.contracts.find(c => c.client === client);
  const stages = state.stageLinks.filter(l => l.product === product)
    .sort((a, b) => Number(a.ordering) - Number(b.ordering));
  const parts = [];
  const gaps = [];
  for (const link of stages) {
    if (!contract.allowed_phases.includes(link.phase)) {
      gaps.push({ product, phase: link.phase, rule: 'R12', reason: 'NOT_ALLOWED' });
      continue;
    }
    const observed = state.observationCounts.get(`${product}|${link.plant}|${link.phase}`) || 0;
    const floor = Number(contract.sample_floor);
    if (observed < floor) {
      gaps.push({ product, phase: link.phase, rule: 'R13', reason: 'SAMPLE_FLOOR', observations: observed, floor });
      continue;
    }
    const s = stageIntensity(state, allocation, product, link.plant, link.phase, period, factorContext, mode);
    if (s.missing) {
      gaps.push({ product, phase: link.phase, rule: 'R18', reason: s.reason });
      continue;
    }
    if (s.factor === null) {
      gaps.push({ product, phase: link.phase, rule: 'R10', reason: 'NO_FACTOR' });
      continue;
    }
    parts.push({ phase: link.phase, kwh_per_kg: s.kwh / (s.kg || 1), factor: s.factor, kwh: s.kwh, contract_kwh: s.contract_kwh || 0 });
  }
  // 产品阶段强度 = Σ(kwh/kg × 因子)；kg 缺失时退回按电量加权因子。
  let intensity;
  const withKg = parts.filter(p => Number.isFinite(p.kwh_per_kg));
  if (withKg.length === parts.length && parts.length > 0) {
    intensity = round4(sum(parts.map(p => p.kwh_per_kg * p.factor)));
  } else if (parts.length > 0) {
    intensity = weightedFactor(parts.map(p => ({ kwh: p.kwh, factor: p.factor })));
  } else {
    intensity = null;
  }
  return {
    product,
    intensity,
    coverage: parts.length / (stages.length || 1),
    covered_phases: parts.map(p => p.phase),
    gaps,
  };
}

// 基线上下文：grid 因子按基线月取；无合约份额。
function baselineContext(state, baselineMonth) {
  return {
    gridFactor: (plant, phase) => findFactor(state, plant, phase, baselineMonth, 'grid'),
    certFactor: () => null,
    confirmedContractKwh: () => 0,
  };
}

// 当前上下文：grid/certificate 因子按当期取；合约电量取该工厂×期×产品已确认 claim。
function currentContext(state) {
  return {
    gridFactor: (plant, phase, period) => findFactor(state, plant, phase, period, 'grid'),
    certFactor: (plant, phase, period) => findFactor(state, plant, phase, period, 'certificate'),
    confirmedContractKwh: (plant, period_, period, product) => {
      const certs = state.certificates.filter(c => c.plant === plant && Number(c.period) === Number(period) && c.status === 'active');
      let total = 0;
      for (const claim of state.claims) {
        if (!certs.some(c => c.certificate === claim.certificate)) continue;
        if (claim.state !== 'signed' && claim.state !== 'reserved') continue;
        const order = claim.order;
        if (order && order.product === product) total += Number(claim.kwh);
      }
      return total;
    },
  };
}

// 纯结构/覆盖假设下的产品强度（电网因子固定为某一上下文取值，不掺合约因子）。
function hypotheticalIntensity(state, allocation, client, product, period, coverageOverride, gridAt) {
  const contract = state.contracts.find(c => c.client === client);
  const stages = state.stageLinks.filter(l => l.product === product)
    .sort((a, b) => Number(a.ordering) - Number(b.ordering));
  const parts = [];
  for (const link of stages) {
    if (!contract.allowed_phases.includes(link.phase)) continue;
    const cell = allocation.cells.find(c =>
      Number(c.period) === Number(period) && c.product === product && c.plant === link.plant && c.phase === link.phase);
    if (!cell) continue;
    const grid = gridAt(link.plant, link.phase, link.phase ? period : period);
    if (!grid) continue;
    parts.push({ phase: link.phase, kwh: cell.direct_kwh + cell.verified_kwh + cell.default_kwh + cell.common_kwh, kg: cell.production_kg, factor: grid.factor });
  }
  if (parts.length === 0) return null;
  return round4(sum(parts.map(p => (p.kwh / (p.kg || 1)) * p.factor)));
}

// 解析当期实际生产期间：取不晚于 as-of 的最近一个有分摊单元的月份。
function resolveProductionPeriod(state, allocation, asOf) {
  const periods = [...new Set(allocation.cells.map(c => Number(c.period)))].filter(p => p <= Number(asOf));
  return periods.length ? Math.max(...periods) : null;
}

export function baselineReport(state, allocation) {
  const reports = [];
  for (const contract of state.contracts) {
    const basePeriod = Number(contract.baseline_month);
    const weights = mixWeights(state, contract.client, basePeriod);
    const products = weights ? weights.weights.map(w => w.product)
      : [...new Set(state.stageLinks.map(l => l.product))];
    const productResults = products.map(product =>
      productIntensity(state, allocation, contract.client, product, basePeriod, baselineContext(state, basePeriod), 'baseline'));
    const usable = productResults.filter(p => p.intensity !== null);
    const weightMap = new Map((weights?.weights ?? []).map(w => [w.product, w.share]));
    const renorm = usable.length ? sum(usable.map(p => weightMap.get(p.product) ?? 0)) : 0;
    const baselineIntensity = usable.length && renorm > 0
      ? round4(sum(usable.map(p => p.intensity * (weightMap.get(p.product) ?? 0) / renorm)))
      : null;
    reports.push({
      client: contract.client,
      baseline_month: basePeriod,
      baseline_intensity_g_per_kg: baselineIntensity,
      products: productResults,
      gaps: productResults.flatMap(p => p.gaps),
    });
  }
  return reports;
}

export function decomposition(state, allocation, client, asOfPeriod) {
  const contract = state.contracts.find(c => c.client === client);
  if (!contract) throw new Error(`未知客户：${client}`);
  const basePeriod = Number(contract.baseline_month);
  // as-of 是披露时点；实际对比的生产期间取该时点前最近一个有生产记录的月份。
  const currentPeriod = resolveProductionPeriod(state, allocation, asOfPeriod);
  if (currentPeriod === null) {
    return { client, baseline_month: basePeriod, as_of: Number(asOfPeriod), error: '时点前无任何生产记录，无法对比（R18 缺口）' };
  }
  const notes = [];
  if (currentPeriod !== Number(asOfPeriod)) {
    notes.push(`as-of 第 ${asOfPeriod} 月无生产记录，当期口径取最近生产期间第 ${currentPeriod} 月（R1/R18）`);
  }
  const baseWeights = mixWeights(state, client, basePeriod);
  const curWeights = mixWeights(state, client, currentPeriod);
  if (curWeights?.period_note) notes.push(curWeights.period_note);
  if (!baseWeights || !curWeights) {
    return { client, baseline_month: basePeriod, current_period: currentPeriod, notes, error: '缺少产品结构表 product-mix，无法对比（R18 缺口）' };
  }

  const baseProducts = baseWeights.weights.map(w => ({ ...w, result: productIntensity(state, allocation, client, w.product, basePeriod, baselineContext(state, basePeriod), 'baseline') }));
  const curProducts = curWeights.weights.map(w => ({ ...w, result: productIntensity(state, allocation, client, w.product, currentPeriod, currentContext(state), 'current') }));

  const aggregate = items => {
    const usable = items.filter(i => i.result.intensity !== null);
    const totalShare = sum(usable.map(i => i.share));
    if (usable.length === 0 || totalShare === 0) return null;
    return round4(sum(usable.map(i => i.result.intensity * i.share / totalShare)));
  };
  const I0 = aggregate(baseProducts);
  const I4 = aggregate(curProducts);

  // 步骤 A：当前覆盖 + 基线结构/因子（覆盖效应）。
  const coverageHypo = baseWeights.weights.map(w => {
    const cur = curProducts.find(c => c.product === w.product);
    const base = baseProducts.find(b => b.product === w.product);
    const intensity = cur && cur.result.intensity !== null && base && base.result.intensity !== null
      ? base.result.intensity
      : null;
    return { product: w.product, share: w.share, result: { intensity, coverage: cur?.result.coverage ?? 0, gaps: cur?.result.gaps ?? [] } };
  });
  const I1 = aggregate(coverageHypo);

  // 步骤 B：当前覆盖 + 当前结构 + 基线电网因子（结构效应；合约因子置零）。
  const baseGridAt = (plant, phase) => findFactor(state, plant, phase, basePeriod, 'grid');
  const structureHypo = curWeights.weights.map(w => ({
    product: w.product, share: w.share,
    result: { intensity: hypotheticalIntensity(state, allocation, client, w.product, currentPeriod, null, baseGridAt) },
  }));
  const I2 = aggregate(structureHypo);

  // 步骤 C：当前覆盖 + 当前结构 + 当期电网因子（电网更新效应 R11）。
  const curGridAt = (plant, phase, period) => findFactor(state, plant, phase, period, 'grid');
  const gridUpdateHypo = curWeights.weights.map(w => ({
    product: w.product, share: w.share,
    result: { intensity: hypotheticalIntensity(state, allocation, client, w.product, currentPeriod, null, curGridAt) },
  }));
  const I3 = aggregate(gridUpdateHypo);

  const steps = [
    { name: 'I0_baseline', label: '共用基期强度', value: I0 },
    { name: 'I1_current_coverage', label: '替换为当期数据覆盖', value: I1 },
    { name: 'I2_current_structure', label: '再替换为当期采购/产品结构（基线电网因子）', value: I2 },
    { name: 'I3_current_grid_factor', label: '再应用当期电网因子', value: I3 },
    { name: 'I4_actual', label: '当期实际构成（含合约绿电因子）', value: I4 },
  ];
  const diff = (a, b) => (a === null || b === null) ? null : round4(a - b);
  const effects = [
    { effect: 'coverage_effect', rule: 'R18', g_per_kg: diff(I1, I0), explanation: '数据覆盖变化（阶段缺口、样本下限、default 授权差异）' },
    { effect: 'structure_effect', rule: 'R18', g_per_kg: diff(I2, I1), explanation: '采购/产品结构变化（X/Y 份额、外包段组合）' },
    { effect: 'grid_update_effect', rule: 'R11', g_per_kg: diff(I3, I2), explanation: '电网因子表更新，不属于供应商改善，单列披露' },
    { effect: 'supplier_action_effect', rule: 'R10', g_per_kg: diff(I4, I3), explanation: '供应商绿电合约与已确认凭证带来的强度变化' },
  ];
  const explained = round4(sum(effects.map(e => e.g_per_kg || 0)));
  const rawResidual = (I0 !== null && I4 !== null) ? round4((I4 - I0) - explained) : null;
  const residual = rawResidual === 0 ? 0 : rawResidual;

  return {
    client,
    baseline_month: basePeriod,
    as_of: Number(asOfPeriod),
    current_period: currentPeriod,
    notes,
    baseline_intensity_g_per_kg: I0,
    current_intensity_g_per_kg: I4,
    total_change_g_per_kg: diff(I4, I0),
    steps,
    effects,
    residual_g_per_kg: residual,
    gap_trace: [...new Map([...baseProducts, ...curProducts].flatMap(p => p.result.gaps.map(g => [JSON.stringify(g), g]))).values()],
  };
}
