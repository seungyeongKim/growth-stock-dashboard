const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const read = (name) => JSON.parse(fs.readFileSync(path.join(root, "data", name), "utf8"));
const valid = Number.isFinite;
const rounded = (x) => Number(x.toFixed(1));
const yearGrowth = (current, prior) => valid(current) && prior > 0 ? rounded((current / prior - 1) * 100) : null;
const change = (current, prior) => valid(current) && valid(prior) ? rounded(current - prior) : null;
const assumptions = { years: 2, annualReturn: 0.12, multiples: [15, 20, 25] };

function hurdle(marketCap, baseNet, multiple, years, annualReturn) {
  if (!(marketCap > 0 && baseNet > 0 && multiple > 0 && years > 0)) return null;
  const requiredNet = marketCap * (1 + annualReturn) ** years / multiple;
  return { multiple, requiredNet: Math.round(requiredNet), requiredCagr: rounded(((requiredNet / baseNet) ** (1 / years) - 1) * 100) };
}

function earningsBase(annual, latest, prior) {
  if (annual?.year === latest?.year - 1 && prior?.year === annual.year
    && latest.reportCode === prior.reportCode && latest.fsDiv === prior.fsDiv && annual.fsDiv === latest.fsDiv
    && [annual.ownerNet, latest.cumulativeOwnerNet, prior.cumulativeOwnerNet].every(valid)) {
    return { net: annual.ownerNet + latest.cumulativeOwnerNet - prior.cumulativeOwnerNet, label: `${latest.period} TTM`, fsDiv: latest.fsDiv };
  }
  return valid(annual?.ownerNet) ? { net: annual.ownerNet, label: annual.period, fsDiv: annual.fsDiv } : null;
}

function buildReview(target, snapshot, valuation, checkpoint, financialAsOf) {
  const annual = snapshot?.annual?.at(-1);
  const latest = snapshot?.latestInterim;
  const prior = snapshot?.priorInterim;
  const comparable = latest && prior && latest.fsDiv === prior.fsDiv && latest.reportCode === prior.reportCode;
  const base = earningsBase(annual, latest, prior);
  const priceAsOf = valuation?.priceAsOf || null;
  const marketCap = valuation?.status === "ok" ? valuation.marketCap : null;
  const scenarios = assumptions.multiples.map((multiple) =>
    hurdle(marketCap, base?.net, multiple, assumptions.years, assumptions.annualReturn)).filter(Boolean);
  const revenueGrowth = comparable ? yearGrowth(latest.revenue, prior.revenue) : null;
  const opGrowth = comparable ? yearGrowth(latest.operatingProfit, prior.operatingProfit) : null;
  const ownerNetGrowth = comparable ? yearGrowth(latest.ownerNet, prior.ownerNet) : null;
  const marginDelta = comparable ? change(latest.operatingMargin, prior.operatingMargin) : null;
  const notes = [];
  if (!comparable) notes.push("동일 범위의 전년 동기 비교 자료 부족");
  if (revenueGrowth < 0 && revenueGrowth !== null) notes.push("분기 매출 역성장");
  if (marginDelta <= -3 && marginDelta !== null) notes.push("분기 영업이익률 3%p 이상 하락");
  if (valid(latest?.ownerNet) && latest.ownerNet <= 0) notes.push("최신 분기 지배주주 순이익 또는 별도 순이익 적자");
  if (opGrowth !== null && ownerNetGrowth !== null && Math.abs(ownerNetGrowth - opGrowth) >= 25) notes.push("영업이익과 순이익 성장률 차이 25%p 이상: 영업외·일회성 손익 확인");
  if (snapshot?.shareCountAsOf !== latest?.period) notes.push("최신 재무와 주식수 기준 기간 차이 확인");
  if (!scenarios.length) notes.push("양의 이익 기준 또는 가격 자료 부족: 필요 이익 역산 보류");
  return {
    name: target.name, financialAsOf, priceAsOf, price: valuation?.price ?? null, marketCap,
    period: latest?.period ?? annual?.period ?? null,
    scope: latest?.fsDiv ?? annual?.fsDiv ?? null,
    annualRevenueGrowth: annual?.revenueGrowthYoY ?? null,
    revenueGrowth, opGrowth, ownerNetGrowth, opMargin: latest?.operatingMargin ?? null, marginDelta,
    netMargin: latest?.netMargin ?? null, debtToEquity: (latest || annual)?.debtToEquity ?? null,
    base, actualPer: marketCap > 0 && base?.net > 0 ? rounded(marketCap / base.net) : null,
    shareCountAsOf: snapshot?.shareCountAsOf ?? null,
    receipts: [...new Set([latest?.receipt, prior?.receipt, annual?.receipt].filter((value) => /^\d{14}$/.test(value)))],
    scenarios, notes, checkpoint
  };
}

function main() {
  const targets = read("growth-watchlist-20.json").targets;
  const financials = read("financial-snapshots.json");
  const valuations = read("valuation-snapshot.json");
  const checkpoints = read("purchase-review-checkpoints.json");
  const companies = Object.fromEntries(targets.map((target) => {
    if (!checkpoints[target.code]) throw new Error(`Missing purchase checkpoint: ${target.code}`);
    return [target.code, buildReview(target, financials.companies[target.code], valuations.companies[target.code], checkpoints[target.code], financials.updatedAt)];
  }));
  const data = { priceAsOf: valuations.updatedAt, financialAsOf: financials.updatedAt, assumptions, companies };
  fs.writeFileSync(path.join(root, "data", "purchase-review.json"), JSON.stringify(data, null, 2) + "\n");
  console.log(`Purchase evidence: ${Object.values(companies).filter((item) => item.scenarios.length).length}/${targets.length} with valuation scenarios.`);
}

if (require.main === module) main();
module.exports = { hurdle, earningsBase, buildReview };
