// 分摊模块：区分直接归属、共享产线与外包段（协议类型来自 stage-links.method_group）。
// 仅登记 allocation_basis 的共用段可按 run_hours 分给产品（R4）；
// 公用电不自动取得绿电凭证权益（R5）；对不上的量进入无法归属清单（R14）。
import { round4, sum } from './math.mjs';

const DIRECT_KWH_FIELDS = { direct: 'direct_kwh', verified: 'verified_kwh', default: 'default_kwh' };

function emptyCell(period, plant, phase, product, methodGroup) {
  return {
    period, plant, phase, product, method_group: methodGroup ?? '',
    direct_kwh: 0,
    verified_kwh: 0,
    default_kwh: 0,
    common_kwh: 0,
    production_kg: 0,
    energy_records: [],
    common_sources: [],
  };
}

export function computeAllocations(state, allOrders = []) {
  const cells = new Map();
  const unallocable = [];
  const linkKey = (plant, phase) => state.stageLinks
    .filter(l => l.plant === plant && l.phase === phase)
    .map(l => ({ product: l.product, method_group: l.method_group }));
  const groupOf = (plant, phase, product) =>
    state.stageLinks.find(l => l.plant === plant && l.phase === phase && l.product === product)?.method_group ?? '';

  const cell = (period, plant, phase, product) => {
    const key = `${period}|${plant}|${phase}|${product}`;
    if (!cells.has(key)) {
      cells.set(key, emptyCell(period, plant, phase, product, groupOf(plant, phase, product)));
    }
    return cells.get(key);
  };

  // 1) 直接归属电量（已在 state 层完成 verified 替代 default 的归并，R2）。
  for (const e of state.energy) {
    const c = cell(e.month, e.plant, e.phase, e.product);
    c[DIRECT_KWH_FIELDS[e.source]] += Number(e.kwh);
    c.production_kg += Number(e.kg);
    c.energy_records.push(...e.records);
  }

  // 2) 共用段：未登记 basis → 整段无法归属；登记 → 按当期同产线有效 run_hours 分摊。
  for (const meter of state.meters) {
    const aux = Number(meter.auxiliary_kwh);
    if (!meter.allocation_basis) {
      unallocable.push({
        kind: 'common_meter_no_basis',
        rule: 'R4',
        meter: meter.meter, plant: meter.plant, phase: meter.phase, line: meter.line,
        period: Number(meter.month), kwh: aux,
        impact: `共用段 ${aux}kWh 未获准分摊，不计入任何产品的可披露范围`,
      });
      continue;
    }
    const obs = state.observations.filter(o =>
      o.plant === meter.plant && o.phase === meter.phase && o.line === meter.line &&
      Number(o.month) === Number(meter.month) && meter.allowed_products.includes(o.product));
    const totalHours = sum(obs.map(o => Number(o.run_hours)));
    if (totalHours <= 0) {
      unallocable.push({
        kind: 'common_meter_no_run_hours',
        rule: 'R4',
        meter: meter.meter, plant: meter.plant, phase: meter.phase, line: meter.line,
        period: Number(meter.month), kwh: aux,
        impact: '无有效 run_hours 观察，无法分摊',
      });
      continue;
    }
    const perProduct = new Map();
    for (const o of obs) perProduct.set(o.product, (perProduct.get(o.product) || 0) + Number(o.run_hours));
    const allocations = [];
    let allocated = 0;
    const entries = [...perProduct.entries()];
    entries.forEach(([product, hours], index) => {
      const share = index === entries.length - 1
        ? round4(aux - allocated)
        : round4(aux * hours / totalHours);
      allocated = round4(allocated + share);
      allocations.push({ product, hours, kwh: share });
      const c = cell(Number(meter.month), meter.plant, meter.phase, product);
      c.common_kwh = round4(c.common_kwh + share);
      c.common_sources.push({ meter: meter.meter, kwh: share, basis: meter.allocation_basis });
    });
    // 允许产品之外若存在生产记录，记录协议覆盖缺口。
    const knownProducts = new Set(linkKey(meter.plant, meter.phase).map(l => l.product));
    for (const product of knownProducts) {
      if (!meter.allowed_products.includes(product)) {
        unallocable.push({
          kind: 'product_outside_allowed_list',
          rule: 'R4',
          meter: meter.meter, product, plant: meter.plant, phase: meter.phase,
          period: Number(meter.month), kwh: 0,
          impact: `产品 ${product} 不在该共用段允许清单，不参与分摊`,
        });
      }
    }
    meter._allocations = allocations;
  }

  // 3) 交付量 vs 报送产量：超产部分无生产证据，列为无法归属（R14）。
  // 注意：超产判断用全量订单（不受 as-of 可知性过滤），因为对不上的是物理口径。
  const overrun = [];
  const delivered = new Map();
  for (const order of allOrders) {
    const key = `${order.month}|${order.product}`;
    delivered.set(key, (delivered.get(key) || 0) + Number(order.kg));
  }
  for (const [key, deliveryKg] of delivered) {
    const sep = key.indexOf('|');
    const period = Number(key.slice(0, sep));
    const product = key.slice(sep + 1);
    // 同一产品跨阶段的 production_kg 是同批产量的重复列示，取最大值去重而非求和。
    const productCells = [...cells.values()].filter(c => Number(c.period) === period && c.product === product);
    const produced = productCells.length ? Math.max(...productCells.map(c => c.production_kg)) : 0;
    if (deliveryKg > produced) {
      const gap = deliveryKg - produced;
      overrun.push({ period: Number(period), product, delivery_kg: deliveryKg, produced_kg: produced, gap_kg: gap });
      unallocable.push({
        kind: 'delivery_overrun',
        rule: 'R14',
        period: Number(period), product, kg: gap,
        impact: `交付 ${deliveryKg}kg 超出报送产量 ${produced}kg，${gap}kg 无生产证据，对应范围不可披露`,
      });
    }
  }

  return {
    cells: [...cells.values()].sort((a, b) =>
      `${a.period}${a.plant}${a.phase}${a.product}`.localeCompare(`${b.period}${b.plant}${b.phase}${b.product}`)),
    unallocable,
    overrun,
  };
}

export function findCells(allocation, { period, product } = {}) {
  return allocation.cells.filter(c =>
    (period === undefined || Number(c.period) === Number(period)) &&
    (product === undefined || c.product === product));
}
