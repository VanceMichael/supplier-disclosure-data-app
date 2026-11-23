# 绿电采购与产品碳披露数据应用

面向零部件联合采购组织的月度数据应用：厂商录入工厂用电、品类实物量与已核验凭证批次，
采购与披露人员按客户、按产品批、按披露时点（as-of）生成可追认的碳强度与绿电改善说明。
仅依赖 Node.js 22 标准库，无第三方运行时依赖。

## 1. 它解决什么

- 厂商年报用公司均值，但下游采购要求**按批 + 可追认的用电契约**核 —— 本工具按交付批（delivery）归集。
- 绿电凭证可能被多个订单引用 —— 凭证台账统一占用余量，signed/reserved 锁量、不可超分、不可转移。
- 行业默认因子不能和实测无标记地算作降幅 —— `direct / verified / default` 三源分层，default 单独标记且需客户授权。
- 电网因子更新不能冒充供应商改善 —— 强度变化分解把 `grid_update` 与 `supplier_action` 单列。
- 共用基期对比、缺口追踪、撤销双轨、客户间保密 —— 全部规则化并在输出中带规则编号。

## 2. 目录结构

```
src/
  rules.mjs               规则目录 R1–R18（所有结论引用规则编号）
  store.mjs               追加式事件存储（JSONL），只增不改，可对账
  ingest.mjs              CSV 装载/单条录入，表头与跨表引用校验
  service.mjs             应用服务层，串起全部用例
  server.mjs              零依赖 HTTP 服务（网页与 JSON API）
  cli.mjs                 命令行入口
  util/csv.mjs            交接资料 CSV 约定的解析/序列化
  web/index.html          采购/披露人员网页工作台（原生 JS）
  domain/
    math.mjs              数值与加权工具
    state.mjs             as-of 时点状态重建（R1 时效、R2 替代、R9 撤销）
    allocation.mjs        直接/共享/外包分摊与无法归属量（R4/R5/R14）
    certificates.mjs      凭证合格性、余量台账、撤销双轨（R6–R9/R16）
    attribution.mjs       交付批碳强度引擎（R3/R10/R12/R13）
    baseline.mjs          共用基期与覆盖/结构/强度分解（R11/R18）
    disclosure.mjs        客户脱敏视图、委员会视图、披露快照（R15/R17）
test/domain.test.mjs      17 条规则级测试
fixtures/                 合成交接资料（只读输入，格式见 format.json）
```

## 3. 规则到代码的映射

| 规则 | 含义 | 实现位置 |
| --- | --- | --- |
| R1 | 证据时效：只用 claim_date 当时可知证据 | `domain/state.mjs` 的 `known()` 过滤 |
| R2 | verified 替代 default/direct，不叠加 | `state.mjs` 的 `effectiveEnergy()` |
| R3 | default 需客户授权且单独标记 | `attribution.mjs` 的 `DEFAULT_NOT_AUTHORIZED` |
| R4 | 共用段须登记 basis，按 run_hours 分摊 | `allocation.mjs` 的 common-meters 段 |
| R5 | 公用电不自动取得绿电权益 | 分层中 `grid_common` 强制走电网因子 |
| R6 | 凭证地点/期间合格性 | `certificates.mjs` 的 `certEligibility()` |
| R7 | 余量不可超分，requested 不确认 | `state.mjs` 台账 + `certificates.mjs` 违规检查 |
| R8 | 已 signed 用量不可转移 | claim 不可变 + 撤销只标记不改写 |
| R9 | revoked 当前无效、历史待复核 | 台账取最新状态 + `revocationReview()` |
| R10 | 合约/电网/default 三档因子 | `attribution.mjs` 池层分层 |
| R11 | 电网更新≠供应商改善 | `baseline.mjs` 的 `grid_update_effect` |
| R12 | 外包阶段须合同允许 | `attribution.mjs` 的 `PHASE_NOT_ALLOWED` |
| R13 | 样本下限按独立观察条数 | `state.mjs` 计数 + `SAMPLE_FLOOR_NOT_MET` |
| R14 | 无法归属量与超产留痕 | `allocation.mjs` 的 `unallocable/overrun` |
| R15 | 披露时点快照 | `disclosure.mjs` 的 `makeSnapshot()` |
| R16 | 撤销双轨：历史待复核 + 新采购方案 | `service.revocationWorkbench()` |
| R17 | 客户间保密、私有成本剔除 | `disclosure.mjs` 的 `redactForClient()` |
| R18 | 基期可比性与缺口追踪 | `baseline.mjs` 的 gap_trace |

## 4. 核心计算口径

### 4.1 产品池与交付份额

同一期、同一产品的全部交付共享一个「产品池」（工厂×阶段的用电与产量）。

1. 直接归属电量：effective energy（已做 verified 替代）按产品入池。
2. 共用段电量：登记 `allocation_basis` 的按当期同产线 `run_hours` 分摊到允许产品；
   未登记的整段进 `unallocable`，不进任何产品可披露范围。
3. 交付份额 = 该交付 kg ÷ 同期同产品全部交付 kg。
4. 池层先分层算排放得到 **池 g/kg 率**；交付排放 = 池率 × 交付归属产量。
   因此同一产品各交付的碳强度（g/kg）一致，且与池率恒等。
5. 若全部交付重量超过报送产量（超产），覆盖产量按份额封顶，
   缺口重量进 `uncovered_kg` 与 `unallocable`，不进强度分母。

### 4.2 三档因子（R10）

- `contract`：仅 signed/reserved 且地点期间合格的凭证用量，用 certificate 因子；
  且只覆盖直接归属电量，公用电不取得凭证权益（R5）。
- `grid`：未被凭证匹配的直接电量，用当期电网因子。
- `grid_common`：共用段分摊电量，一律电网因子。
- `default` 来源：仅当订单 `defaults=true` 才进入，且在输出中单列 `default_marked_kwh`。

### 4.3 强度变化分解（相对共用基期）

逐步替换，每一步差值即一个效应，合计等于总变化（残差为 0）：

`I0 基期 → I1 当期覆盖（coverage）→ I2 当期结构（structure）
→ I3 当期电网因子（grid_update，R11 单列）→ I4 当期实际含合约因子（supplier_action）`

基期或当期缺阶段（如外包 coat 无观察、未达样本下限）进 `gap_trace`，不静默丢弃。

## 5. 命令行用法

```bash
# 准备（仅标准库，无需联网安装）
npm ci --ignore-scripts --offline

# 校验交接资料
npm run check:materials
npm test

# 装载交接资料到本地事件日志
npm run ingest -- fixtures --store data/events.jsonl

# 客户披露（脱敏）、委员会全量、基期、分解、撤销工作台
node src/cli.mjs disclosure C1 --as-of 3 --store data/events.jsonl
node src/cli.mjs committee  --as-of 3 --store data/events.jsonl
node src/cli.mjs baseline   --as-of 3 --store data/events.jsonl
node src/cli.mjs decomposition C1 --as-of 3 --store data/events.jsonl
node src/cli.mjs revocation --as-of 3 --store data/events.jsonl

# 月度单条录入（字段见 src/cli.mjs tables）
node src/cli.mjs enter energy --record E7 --plant A --phase forming --month 3 \
  --product X --kg 900 --kwh 1700 --known_month 3 --source direct --store data/events.jsonl
```

## 6. 网页工作台

```bash
npm run serve            # 默认 http://localhost:8787，STORE_FILE 可换存储
```

- **月度录入**：按表表单录入、粘贴 CSV 批量录入、或从服务器目录装载；全部追加为事件。
- **客户披露**：选客户与 as-of 月，输出脱敏披露包（能承诺/待补证/是否回撤）。
- **采购委员会视图**：分摊单元、无法归属、凭证台账占用、多维交付结果、基期与分解。
- **基期与分解**：覆盖、结构、电网更新、供应商改善四效应与缺口追踪。
- **撤销工作台**：待复核历史声明与可用新采购方案分轨，已签发快照保留对账。

## 7. HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` `/api/tables` | 健康检查、表字段清单 |
| POST | `/api/ingest-folder` | 装载服务器端 CSV 目录 |
| POST | `/api/rows` `/api/rows-csv` | 单条/CSV 批量录入 |
| GET | `/api/disclosure?client=&as_of=` | 客户脱敏披露包 |
| GET | `/api/delivery?id=&as_of=` | 单交付批完整归因 |
| GET | `/api/committee?as_of=` | 委员会全量多维视图 |
| GET | `/api/baseline` `/api/decomposition?client=` | 基期与变化分解 |
| GET | `/api/revocation?as_of=` | 撤销双轨工作台 |
| POST | `/api/snapshots` | 留存披露快照 |

## 8. 每月操作流程（采购/披露人员）

1. 厂商提交当月用电、实物量、凭证批次后，在「月度录入」装载或粘贴录入。
2. 委员会视图检查 `unallocable`（未授权共用段、超产）与 `ledger_violations`（超分）。
3. 按客户、按披露月生成披露包：确认 `can_commit`、处理 `evidence_needed`。
4. 若有凭证撤销，在撤销工作台区分历史待复核（保留快照、判断回撤）与新采购方案。
5. 正式对外前留存 snapshot；客户材料只取脱敏视图，凭证编号/采购量/成本不跨客户暴露。

## 9. 数据与隐私

- 事件日志默认写 `data/`（已在 `.gitignore`），只追加，含 `recorded_at` 与来源，支持事后对账与重放。
- 客户视图对其他客户的凭证编号、claim 编号、采购量掩码；`cost` 等私有成本字段统一剔除。
- 委员会视图保留全部编号与分摊明细，供内部规则对齐核查。
