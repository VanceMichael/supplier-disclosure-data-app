// 数值工具：电量、产量为整数；分摊与因子计算保留四位小数，展示再取位。

export function round4(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.round((value + Number.EPSILON) * 10000) / 10000;
}

export function round2(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function toNumber(value, fallback = 0) {
  if (value === '' || value === null || value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function toInt(value) {
  return Math.trunc(toNumber(value));
}

// 加权平均（g/kWh），权重为 kWh；无权重时返回 null。
export function weightedFactor(parts) {
  let kwh = 0;
  let grams = 0;
  for (const part of parts) {
    kwh += part.kwh;
    grams += part.kwh * part.factor;
  }
  if (kwh <= 0) return null;
  return round4(grams / kwh);
}

export function sum(values) {
  return round4(values.reduce((acc, value) => acc + (Number(value) || 0), 0));
}
