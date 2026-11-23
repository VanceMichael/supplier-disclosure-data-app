// 凭证模块：合格性、余量台账、凭证撤销的双轨处理。
// 凭证只能用于合格地点与对应期间（R6）；signed/reserved 占余量、不可超分（R7）；
// 已 signed 不可转移（R8）；revoked 当前无效、历史引用待复核（R9/R16）。
import { round4 } from './math.mjs';

export function certEligibility(cert, plant, period) {
  const problems = [];
  if (cert.plant !== plant) problems.push(`凭证工厂 ${cert.plant} 与用电工厂 ${plant} 不符`);
  if (Number(cert.period) !== Number(period)) problems.push(`凭证期间 ${cert.period} 与生产期间 ${period} 不符`);
  if (cert.status === 'revoked') problems.push('凭证已作废（revoked），当前不合格');
  return { eligible: problems.length === 0, problems };
}

// 全库超分检查（采购委员会视图）。
export function ledgerViolations(state) {
  const violations = [];
  for (const entry of state.ledger) {
    if (entry.over_committed) {
      violations.push({
        rule: 'R7',
        certificate: entry.certificate,
        capacity_kwh: Number(entry.kwh),
        committed_kwh: entry.committed_kwh,
        excess_kwh: round4(entry.committed_kwh - Number(entry.kwh)),
        references: entry.references,
      });
    }
    // 引用了地点/期间不符凭证的 claim（R6）。
    for (const ref of entry.references) {
      const order = ref.order;
      if (!order) continue;
      // 订单工厂由产品阶段推导；这里做凭证期间与订单期间的一致性核查。
      if (Number(entry.period) !== Number(order.month)) {
        violations.push({
          rule: 'R6', certificate: entry.certificate, delivery: ref.delivery,
          problem: `凭证期间 ${entry.period} 与订单期间 ${order.month} 不符`,
        });
      }
    }
  }
  return violations;
}

// 撤销事件（as-of 视角对比：哪些凭证已 revoked，哪些历史 signed 引用受影响）。
export function revocationReview(state) {
  const revoked = state.certificates.filter(c => c.status === 'revoked');
  const reviews = [];
  for (const cert of revoked) {
    const affected = state.claims.filter(c =>
      c.certificate === cert.certificate && (c.state === 'signed' || c.state === 'reserved'));
    for (const claim of affected) {
      reviews.push({
        rule: claim.state === 'signed' ? 'R16' : 'R9',
        certificate: cert.certificate,
        claim: claim.claim,
        delivery: claim.delivery,
        client: claim.order?.client ?? '',
        kwh: Number(claim.kwh),
        claim_state: claim.state,
        disposition: claim.state === 'signed'
          ? '历史声明待复核：批次已发走，保留签发内容供对账，不得静默改写（R8/R16）'
          : '锁定释放：reserved 不再占用，需另行采购（R9）',
      });
    }
  }
  return { revoked_certificates: revoked.map(c => c.certificate), reviews };
}

// 可用新采购方案：给某交付列出当前仍 active 且地点/期间合格、尚有余量的凭证。
export function availableCertificates(state, plant, period, excludeDelivery = null) {
  const options = [];
  for (const cert of state.ledger) {
    if (cert.status !== 'active') continue;
    const eligibility = certEligibility(cert, plant, period);
    if (!eligibility.eligible) continue;
    const otherCommitted = cert.references
      .filter(r => (r.state === 'signed' || r.state === 'reserved') && r.delivery !== excludeDelivery)
      .reduce((a, r) => a + Number(r.kwh), 0);
    const freeForThis = round4(Number(cert.kwh) - otherCommitted);
    options.push({
      certificate: cert.certificate,
      plant: cert.plant,
      period: Number(cert.period),
      capacity_kwh: Number(cert.kwh),
      remaining_kwh: cert.remaining_kwh,
      available_for_delivery_kwh: freeForThis,
    });
  }
  return options;
}
