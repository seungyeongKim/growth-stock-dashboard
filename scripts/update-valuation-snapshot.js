const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const watchlist = JSON.parse(fs.readFileSync(path.join(root, "data", "weekly-growth-watchlist.json"), "utf8"));
const financials = JSON.parse(fs.readFileSync(path.join(root, "data", "financial-snapshots.json"), "utf8"));
const outPath = path.join(root, "data", "valuation-snapshot.json");

function parseNumber(value) {
  const number = Number(String(value || "").replaceAll(",", ""));
  return Number.isFinite(number) ? number : null;
}

function ratio(numerator, denominator) {
  return numerator && denominator ? Number((numerator / denominator).toFixed(1)) : null;
}

function classify(per, ps, margin, growth) {
  if (per === null) return "순이익 기준 확인 필요";
  if (per <= 15 && growth >= 10 && margin >= 10) return "확정 실적 대비 여유";
  if (per <= 30 && growth >= 10) return "성장 반영·검토 가능";
  if (per > 50) return "높은 미래 기대 반영";
  return "실적과 가격 동시 확인";
}

function main() {
  const companies = {};
  for (const item of watchlist.items || []) {
    const financial = financials.companies?.[item.code];
    const latest = financial?.annual?.at(-1);
    const price = parseNumber(item.quote?.price);
    const shareCount = financial?.shareCount ?? null;
    const marketCap = price && shareCount ? price * shareCount : null;
    const per = ratio(marketCap, latest?.netIncome);
    const ps = ratio(marketCap, latest?.revenue);
    const pop = ratio(marketCap, latest?.operatingProfit);
    companies[item.code] = {
      code: item.code,
      name: item.name,
      status: marketCap && latest ? "ok" : "partial",
      price,
      priceAsOf: watchlist.updatedAt || null,
      shareCount,
      shareCountAsOf: financial?.shareCountAsOf || null,
      marketCap,
      actualBaseYear: latest?.year || null,
      actualPer: per,
      actualPs: ps,
      actualPop: pop,
      classification: classify(per, ps, latest?.operatingMargin, latest?.revenueGrowthYoY),
      note: marketCap
        ? "시가총액은 비공식 실시간 가격과 DART 발행주식수의 곱으로 계산한 참고값입니다."
        : financial?.shareNote || "가격 또는 발행주식수 확인 필요"
    };
  }
  const output = {
    updatedAt: watchlist.updatedAt || financials.updatedAt || null,
    sourcePolicy: "현재 가격은 Naver Finance 실시간 참고값, 발행주식수와 확정 실적은 OpenDART 기준이다. 실제 매수 전 증권사·거래소 가격과 최신 주식수 변동을 재확인한다.",
    companies
  };
  fs.writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(`Wrote ${outPath}`);
}

main();
