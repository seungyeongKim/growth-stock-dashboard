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
  if (!(marketCap > 0 && multiple > 0 && years > 0)) return null;
  const requiredNet = marketCap * (1 + annualReturn) ** years / multiple;
  return { multiple, requiredNet: Math.round(requiredNet), requiredCagr: baseNet > 0
    ? rounded(((requiredNet / baseNet) ** (1 / years) - 1) * 100) : null };
}

function earningsBase(annual, latest, prior) {
  const previous = latest?.priorComparable?.cumulativeOwnerNet ?? (prior?.year === annual?.year
    && latest?.reportCode === prior?.reportCode && latest?.fsDiv === prior?.fsDiv ? prior?.cumulativeOwnerNet : null);
  if (annual?.year === latest?.year - 1 && annual.fsDiv === latest.fsDiv
    && [annual.ownerNet, latest.cumulativeOwnerNet, previous].every(valid)) {
    return { net: annual.ownerNet + latest.cumulativeOwnerNet - previous, label: `${latest.period} TTM`, fsDiv: latest.fsDiv };
  }
  return valid(annual?.ownerNet) ? { net: annual.ownerNet, label: annual.period, fsDiv: annual.fsDiv } : null;
}

function parseMarketValue(value) {
  const match = /^(?:(\d+)조\s*)?(?:(\d+)억)?$/.exec(String(value || "").replaceAll(",", "").trim());
  return match && (match[1] || match[2]) ? Number(match[1] || 0) * 1e12 + Number(match[2] || 0) * 1e8 : null;
}

async function alternateMarketCap(code) {
  try {
    const response = await fetch(`https://m.stock.naver.com/api/stock/${code}/integration`, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) return null;
    const data = await response.json();
    const value = parseMarketValue(data.totalInfos?.find((item) => item.code === "marketValue")?.value);
    return value > 0 ? value : null;
  } catch {
    return null;
  }
}

function buildReview(target, snapshot, valuation, checkpoint, financialAsOf, fallbackCap = null) {
  const annual = snapshot?.annual?.at(-1);
  const latest = snapshot?.latestInterim;
  const prior = snapshot?.priorInterim;
  const scopeBreak = Boolean(checkpoint.breakThroughYear && (latest?.year ?? annual?.year ?? 0) <= checkpoint.breakThroughYear);
  const sameFiling = latest?.priorComparable?.revenue > 0;
  const comparable = scopeBreak && checkpoint.omitQuarterComparison ? null : sameFiling ? latest.priorComparable : !scopeBreak && latest && prior
    && latest.fsDiv === prior.fsDiv && latest.reportCode === prior.reportCode ? prior : null;
  const base = scopeBreak ? null : earningsBase(annual, latest, prior);
  const priceAsOf = valuation?.priceAsOf || null;
  const marketCap = valuation?.marketCap > 0 ? valuation.marketCap : fallbackCap;
  const marketCapSource = valuation?.marketCap > 0 ? "네이버 시세 × OpenDART 보통주 수"
    : marketCap > 0 ? "Npay 증권 표시 시가총액 (별도 조회·반올림)" : null;
  const scenarios = assumptions.multiples.map((multiple) =>
    hurdle(marketCap, base?.net, multiple, assumptions.years, assumptions.annualReturn)).filter(Boolean);
  const revenueGrowth = comparable ? yearGrowth(latest.revenue, comparable.revenue) : null;
  const opGrowth = comparable ? yearGrowth(latest.operatingProfit, comparable.operatingProfit) : null;
  const ownerNetGrowth = comparable ? yearGrowth(latest.ownerNet, comparable.ownerNet) : null;
  const marginDelta = comparable ? change(latest.operatingMargin, comparable.operatingMargin) : null;
  const notes = [];
  if (!comparable) notes.push("동일 범위의 전년 동기 비교 자료 부족");
  if (scopeBreak) notes.push("인적분할 전후 이익을 섞지 않기 위해 실적 PER과 필요 성장률을 표시하지 않음");
  if (base && !base.label.endsWith("TTM")) notes.push("누적 비교 자료가 충분하지 않아 최근 연간 이익을 기준으로 계산");
  if (revenueGrowth < 0 && revenueGrowth !== null) notes.push("분기 매출 역성장");
  if (marginDelta <= -3 && marginDelta !== null) notes.push("분기 영업이익률 3%p 이상 하락");
  if (valid(latest?.ownerNet) && latest.ownerNet <= 0) notes.push("최신 분기 지배주주 순이익 또는 별도 순이익 적자");
  if (opGrowth !== null && ownerNetGrowth !== null && Math.abs(ownerNetGrowth - opGrowth) >= 25) notes.push("영업이익과 순이익 성장률 차이 25%p 이상: 영업외·일회성 손익 확인");
  if (snapshot?.shareCountAsOf !== latest?.period) notes.push("최신 재무와 주식수 기준 기간 차이 확인");
  if (!scenarios.length) notes.push("시가총액 자료 부족: 필요 이익 역산 보류");
  return {
    name: target.name, financialAsOf, priceAsOf, price: valuation?.price ?? null, marketCap, marketCapSource,
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

async function main() {
  const targets = read("growth-watchlist-20.json").targets;
  const financials = read("financial-snapshots.json");
  const valuations = read("valuation-snapshot.json");
  const checkpoints = read("purchase-review-checkpoints.json");
  const companies = Object.fromEntries(await Promise.all(targets.map(async (target) => {
    if (!checkpoints[target.code]) throw new Error(`Missing purchase checkpoint: ${target.code}`);
    const valuation = valuations.companies[target.code];
    const fallback = valuation?.marketCap > 0 ? null : await alternateMarketCap(target.code);
    return [target.code, buildReview(target, financials.companies[target.code], valuation, checkpoints[target.code], financials.updatedAt, fallback)];
  })));
  const data = { priceAsOf: valuations.updatedAt, financialAsOf: financials.updatedAt, assumptions, companies };
  fs.writeFileSync(path.join(root, "data", "purchase-review.json"), JSON.stringify(data, null, 2) + "\n");
  console.log(`Purchase evidence: ${Object.values(companies).filter((item) => item.scenarios.length).length}/${targets.length} with valuation scenarios.`);
}

if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { hurdle, earningsBase, buildReview, parseMarketValue };
