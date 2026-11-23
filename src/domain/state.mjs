// 时点状态：给定 as-of 月（通常等于某次披露的 claim_date），从事件存储重建
// 当时可知的全部证据。所有后续计算只依赖本模块输出，确保时点一致性（R1）。
import { round4 } from './math.mjs';

function known(rows, asOf) {
  return rows.filter(row => (row.known_month === '' || row.known_month === undefined) ? true : Number(row.known_month) <= asOf);
}

// R2：同键下 verified 替代 default/direct，不叠加；多源各自求和后取最高可信来源。
function effectiveEnergy(rows, asOf) {
  const groups = new Map();
  for (const row of known(rows, asOf)) {
    const key = `${row.plant}|${row.phase}|${row.month}|${row.product}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const result = [];
  for (const [key, group] of groups) {
    const pick = source => group.filter(r => r.source === source);
    const verified = pick('verified');
    const direct = pick('direct');
    const fallback = pick('default');
    let chosen;
    let source;
    let replaced = [];
    if (verified.length) {
      chosen = verified;
      source = 'verified';
      replaced = group.filter(r => r.source !== 'verified').map(r => r.record);
    } else if (direct.length) {
      chosen = direct;
      source = 'direct';
    } else {
      chosen = fallback;
      source = 'default';
    }
    const [plant, phase, month, product] = key.split('|');
    result.push({
      key,
      plant,
      phase,
      month: Number(month),
      product,
      kg: chosen.reduce((a, r) => a + Number(r.kg), 0),
      kwh: chosen.reduce((a, r) => a + Number(r.kwh), 0),
      source,
      records: chosen.map(r => r.record),
      replaced_records: replaced,
      known_month: Math.max(...chosen.map(r => Number(r.known_month || 0))),
    });
  }
  return result.sort((a, b) => a.key.localeCompare(b.key));
}

// 凭证台账：同一 certificate 的事件取 as-of 前最新一条（R9 撤销据此生效）。
function certificateLedger(rows, asOf) {
  const byId = new Map();
  for (const row of known(rows, asOf).sort((a, b) => Number(a.known_month) - Number(b.known_month))) {
    byId.set(row.certificate, row);
  }
  return [...byId.values()];
}

export function buildState(store, asOf) {
  const rows = table => store.rows(table);

  const energy = effectiveEnergy(rows('energy'), asOf);
  const certificates = certificateLedger(rows('certificates'), asOf);
  const claims = known(rows('claims'), asOf);
  const factors = rows('factors').filter(r => Number(r.from) <= asOf && Number(r.to) >= 1);
  const observations = known(rows('line-observations'), asOf);
  const meters = known(rows('common-meters'), asOf);
  const orders = rows('orders').filter(o => Number(o.claim_date) <= asOf);
  const contracts = rows('contracts');
  const stageLinks = rows('stage-links');
  const productMix = rows('product-mix').filter(r => Number(r.period) <= asOf);

  // R13：样本下限按产品×阶段下独立观察条目数计。
  const observationCounts = new Map();
  for (const obs of observations) {
    const key = `${obs.product}|${obs.plant}|${obs.phase}`;
    observationCounts.set(key, (observationCounts.get(key) || 0) + 1);
  }

  // R7：signed + reserved 占用余量；requested 不确认但列示。
  const certById = new Map(certificates.map(c => [c.certificate, c]));
  const orderById = new Map(rows('orders').map(o => [o.delivery, o]));
  const enrichedClaims = claims.map(c => ({
    ...c,
    cert: certById.get(c.certificate) || null,
    order: orderById.get(c.delivery) || null,
  }));
  const ledger = certificates.map(cert => {
    const refs = enrichedClaims.filter(c => c.certificate === cert.certificate);
    const committed = refs.filter(c => c.state === 'signed' || c.state === 'reserved')
      .reduce((a, c) => a + Number(c.kwh), 0);
    const requested = refs.filter(c => c.state === 'requested')
      .reduce((a, c) => a + Number(c.kwh), 0);
    return {
      ...cert,
      committed_kwh: committed,
      requested_kwh: requested,
      remaining_kwh: round4(Number(cert.kwh) - committed),
      over_committed: committed > Number(cert.kwh),
      references: refs.map(r => ({
        claim: r.claim, delivery: r.delivery, client: r.order?.client ?? '',
        kwh: Number(r.kwh), state: r.state, known_month: r.known_month,
        order: r.order, cert: r.cert,
      })),
    };
  });

  return {
    asOf,
    energy,
    certificates,
    certById,
    ledger,
    claims: enrichedClaims,
    factors,
    observations,
    observationCounts,
    meters,
    orders,
    contracts,
    stageLinks,
    productMix,
  };
}

// 因子查找：工厂×阶段×期间×方法；找不到返回 null（调用方记为缺口）。
export function findFactor(state, plant, phase, month, method) {
  const hit = state.factors.find(f =>
    f.plant === plant && f.phase === phase && f.method === method &&
    Number(f.from) <= month && Number(f.to) >= month);
  return hit ? { name: hit.name, factor: Number(hit.grams_per_kwh) } : null;
}
