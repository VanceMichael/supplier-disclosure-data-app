// 规则目录：所有计算与披露结论都引用规则编号，便于采购委员会与审计追认。
// 规则来源：业务交接 README、fixtures/format.json 的字段约定与需求说明。
export const RULES = Object.freeze({
  R1: {
    id: 'R1',
    title: '证据时效（时点可知性）',
    text: 'known_month 晚于披露时点 claim_date 的记录不可用于该披露；披露只能基于当时可知证据。',
  },
  R2: {
    id: 'R2',
    title: '数据源替代而非叠加',
    text: '同一工厂×阶段×月×产品下，verified 行替代 default/direct 行；default 不能与实测无标记地叠加。',
  },
  R3: {
    id: 'R3',
    title: 'default 可替代与边界标记',
    text: '仅当订单 defaults=true 时允许 default 来源进入可披露范围；default 贡献必须单独标记，不得计入绿电改善。',
  },
  R4: {
    id: 'R4',
    title: '共用段分摊授权',
    text: 'common-meters 的 allocation_basis 为空表示未获准分摊，该量保留为无法归属；登记 basis 的按 run_hours 分摊到允许产品。',
  },
  R5: {
    id: 'R5',
    title: '公用电不自动取得绿电权益',
    text: '共用段分摊电量按电网因子计算，不能仅凭公用电匹配获得凭证权益；凭证权益只认已确认的 claim。',
  },
  R6: {
    id: 'R6',
    title: '凭证地点与期间合格性',
    text: '凭证只能用于同工厂、对应期间的产品证据；地点或期间不符不得引用。',
  },
  R7: {
    id: 'R7',
    title: '凭证余量与不可超分',
    text: 'signed 与 reserved 均占用凭证余量；分给多个客户的总量不得超过凭证 kwh，requested 在余量检查中列示但不确认。',
  },
  R8: {
    id: 'R8',
    title: '已确认使用不可转移',
    text: '已 signed 的凭证用量不可转给另一个订单；撤销后原引用保留为待复核证据，不静默改写历史。',
  },
  R9: {
    id: 'R9',
    title: '作废凭证当前无效、历史待复核',
    text: 'revoked 凭证对当前合格性不再有效；已签发引用进入待复核，不得用于新的确认或采购承诺。',
  },
  R10: {
    id: 'R10',
    title: '三档因子口径',
    text: '客户方法为 certificate 时仅已确认凭证用量可走合约因子；未匹配部分回落 grid；default 仅在客户授权边界内使用。',
  },
  R11: {
    id: 'R11',
    title: '电网因子更新不等于供应商改善',
    text: 'grid 因子按期间生效，因子表更新造成的强度变化单列为 grid_update 效应，不计入供应商绿电改善。',
  },
  R12: {
    id: 'R12',
    title: '外包阶段边界',
    text: 'stage-links 中 method_group=subcontract 的阶段，仅在客户合同 allowed_phases 允许且达到 sample_floor 时进入可披露范围。',
  },
  R13: {
    id: 'R13',
    title: '样本下限',
    text: '产品×阶段下独立观察条目数低于合同 sample_floor 时，该阶段证据不足，只能作为缺口与范围外披露。',
  },
  R14: {
    id: 'R14',
    title: '无法归属量与可披露范围',
    text: '协议与生产记录对不上的电量/产量（含未授权共用段、超产缺口）保留为无法归属，并量化其对可披露范围的影响。',
  },
  R15: {
    id: 'R15',
    title: '披露时点快照',
    text: '按提出披露的客户、claim_date 当时的可知证据与产品批查询适用范围；每次披露留存快照供对账与回撤判断。',
  },
  R16: {
    id: 'R16',
    title: '凭证撤销后的双轨处理',
    text: '撤销后未来披露无合法份额；已发走批次的历史声明列为待复核，另给可用的新采购方案；已签发内容保留对账。',
  },
  R17: {
    id: 'R17',
    title: '客户间保密',
    text: '客户材料不得暴露其他客户引用过的凭证编号、采购量；厂商私有成本字段对客户视图一律剔除。',
  },
  R18: {
    id: 'R18',
    title: '基期可比性与缺口追踪',
    text: '共用基期与各期实际构成对比；基期无可比段（如外包阶段基期无记录）时标记为 gap，不得静默丢弃。',
  },
});

export function rule(id) {
  return RULES[id];
}
