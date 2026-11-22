# 供应商低碳声明的证据配额与客户披露

业务资料均为合成记录。表头字段及跨表引用见 `fixtures/format.json`。

## 数据说明

厂商报送期为自然月的序号。数据 source 为 direct、default 或 verified；同厂产品与阶段有后知 verified 时可替代 default，不能叠加。外包阶段见 stage-links。能耗为 kWh，排放因子为每 kWh 的克数，共同基期与各客户合同匹配。客户选择 grid 或 certificate，不允许通过把未匹配凭证视为负排放来凑足可声明总量。
凭证用量须对应工厂期、产品证据和客户用途。signed 是签发占用，reserved 是已锁定待签。作废凭证对当前合格性不再有效，已签的引用仍须列为待复核证据。客户份额仅对授予该客户的记录披露。

CSV 使用 UTF-8、逗号分隔，无引号与内嵌换行。未提供的字段是空字符串，作为关系值的 `-` 表示不适用。多值字段用竖线分隔，数值和日期单位见业务约定。

## 资料检查

使用 Node.js 22.23.4，依赖仅为 Node.js 标准库。运行 `npm ci --ignore-scripts --offline` 准备工作区。

运行 `npm run check:materials` 检查合成交接资料的字段与记录引用。运行 `npm test` 检查交接资料的读取和校验。
