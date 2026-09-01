const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const read = (name) => JSON.parse(fs.readFileSync(path.join(root, "data", name), "utf8"));
const model = read("company-decision-model.json");
const financials = read("financial-snapshots.json");
const valuations = read("valuation-snapshot.json");
const watchlist = read("weekly-growth-watchlist.json");
const events = read("event-radar.json");
const rubric = read("investment-rubric.json");
const outPath = path.join(root, "data", "investment-decision.json");

function dateAgeDays(value) {
  if (!value) return null;
  const date = new Date(`${value}T00:00:00+09:00`);
  if (Number.isNaN(date.getTime())) return null;
  return Math.max(0, Math.floor((Date.now() - date.getTime()) / 86400000));
}

function average(values) {
  const valid = values.filter((value) => Number.isFinite(value));
  return valid.length ? Math.round(valid.reduce((sum, value) => sum + value, 0) / valid.length) : 0;
}

function financialQuality(snapshot) {
  const latest = snapshot?.annual?.at(-1);
  if (!latest) return 25;
  const margin = latest.operatingMargin >= 30 ? 90 : latest.operatingMargin >= 20 ? 80 : latest.operatingMargin >= 10 ? 65 : 45;
  const growth = latest.revenueGrowthYoY >= 20 ? 85 : latest.revenueGrowthYoY >= 10 ? 70 : latest.revenueGrowthYoY >= 0 ? 55 : 30;
  const net = latest.netMargin >= 15 ? 80 : latest.netMargin >= 8 ? 65 : 45;
  return average([margin, growth, net]);
}

function momentum(snapshot) {
  const signal = snapshot?.summary?.financialSignal;
  return {
    "성장 가속·유지": 85,
    "성장 유지·확인": 65,
    "수익성 둔화 경보": 40,
    "성장 둔화 경보": 25,
    "비교 자료 부족": 35
  }[signal] ?? 35;
}

function valuationQuality(snapshot) {
  return {
    "확정 실적 대비 여유": 85,
    "성장 반영·검토 가능": 70,
    "실적과 가격 동시 확인": 55,
    "높은 미래 기대 반영": 30,
    "순이익 기준 확인 필요": 35
  }[snapshot?.classification] ?? 30;
}

function estimateFreshness(updatedAt) {
  const age = dateAgeDays(updatedAt);
  if (age === null) return { score: 20, label: "기준일 확인 필요", capBuy: true };
  if (age <= rubric.rules.forwardEstimateCurrentDays) return { score: 80, label: `기준일 ${age}일`, capBuy: false };
  if (age <= rubric.rules.forwardEstimateAgingDays) return { score: 55, label: `기준일 ${age}일 · 갱신 필요`, capBuy: true };
  return { score: 30, label: `기준일 ${age}일 · 오래됨`, capBuy: true };
}

function dataStrength(financial, valuation, estimate) {
  const annual = financial?.annual?.length || 0;
  const official = financial?.status === "ok" ? 35 : 20;
  const comparableInterim = financial?.priorInterim && financial?.latestInterim ? 20 : 5;
  const price = valuation?.status === "ok" ? 15 : 5;
  return Math.min(100, official + comparableInterim + price + Math.round(estimate.score * 0.3));
}

function conclusion(base, total, financial, valuation, estimate, dataScore, event) {
  const signal = financial?.summary?.financialSignal;
  const warning = signal === "성장 둔화 경보" || signal === "수익성 둔화 경보";
  const baseConclusion = base.conclusion || "관찰";
  if (baseConclusion === "관심 제외") return "관심 제외";
  if (event?.status === "높음") return "관찰";
  if (warning) return "관찰";
  if (baseConclusion === "심층 검토" && total >= rubric.rules.deepReviewScore) return "심층 검토";
  if (baseConclusion === "관찰" && total >= rubric.rules.promotionScore && valuation?.classification !== "높은 미래 기대 반영") return "심층 검토";
  if (!estimate.capBuy && total >= rubric.rules.buyConditionScore && dataScore >= 75 && valuation?.classification === "확정 실적 대비 여유") return "매수 조건 충족";
  return "관찰";
}

function buildCompany(target) {
  const base = model.companies[target.code] || {};
  const financial = financials.companies?.[target.code];
  const valuation = valuations.companies?.[target.code];
  const event = events.companies?.[target.code];
  const estimate = estimateFreshness(model.updatedAt);
  const finance = financialQuality(financial);
  const growth = momentum(financial);
  const value = Math.max(0, Math.min(100, valuationQuality(valuation) + (valuation?.peerValuation === "관찰군 내 할인" ? 5 : valuation?.peerValuation === "관찰군 내 프리미엄" ? -5 : 0)));
  const riskAdjusted = Math.max(0, 100 - (base.expectationBurden || 60) - (financial?.summary?.financialSignal === "수익성 둔화 경보" ? 15 : 0) - (event?.status === "주의" ? 10 : event?.status === "높음" ? 35 : 0));
  const dataScore = dataStrength(financial, valuation, estimate);
  const total = Math.round(finance * 0.28 + growth * 0.24 + value * 0.2 + riskAdjusted * 0.13 + dataScore * 0.15);
  const verdict = conclusion(base, total, financial, valuation, estimate, dataScore, event);
  const signal = financial?.summary?.financialSignal || "비교 자료 부족";
  const evidence = [
    `실제 재무: ${signal}`,
    `가격 대비 확정 실적: ${valuation?.classification || "확인 필요"}`,
    `추정치 자료: ${estimate.label}`,
    event?.headline || "최근 수집 범위에서 주요 DART 공시 없음"
  ];
  const limitations = [];
  if (estimate.capBuy) limitations.push("미래 추정치 기준일이 최근 45일 이내가 아니어서 자동 매수 조건 충족 판정을 막음");
  if (financial?.status !== "ok") limitations.push("공식 재무 일부 기간이 누락되어 비교 신뢰도가 낮음");
  if (valuation?.note?.includes("비공식")) limitations.push("현재 가격은 비공식 참고값이므로 매수 전 증권사·거래소 가격 확인 필요");
  if (event?.status === "주의" || event?.status === "높음") limitations.push(`공시 점검: ${event.headline}`);
  return {
    code: target.code,
    name: target.name,
    verdict,
    totalScore: total,
    confidence: Math.min(95, Math.round((base.confidence || 50) * 0.45 + dataScore * 0.55)),
    score: { financialQuality: finance, growthMomentum: growth, valuationQuality: value, riskAdjusted, evidenceStrength: dataScore },
    evidence,
    positiveScenario: base.positiveScenario || base.keyEvidence?.[0] || "성장 지표 재확인",
    counterCase: base.bearCase || "성장 논리 훼손",
    invalidation: base.invalidateCondition || "핵심 지표 악화",
    minimumHumanChecks: base.minimumChecks || [],
    limitations,
    freshness: { financial: financials.updatedAt || null, valuation: valuations.updatedAt || null, estimate: estimate.label },
    sourceStatus: {
      financial: "OpenDART 공식 재무",
      valuation: "OpenDART 발행주식수 + Naver Finance 가격 참고값",
      estimate: estimate.capBuy ? "갱신 필요 또는 출처 재확인" : "최근 기준일 확인",
      disclosure: "OpenDART 최근 공시"
    }
  };
}

function main() {
  const companies = Object.fromEntries((watchlist.items || []).map((target) => [target.code, buildCompany(target)]));
  const counts = Object.values(companies).reduce((acc, item) => {
    acc[item.verdict] = (acc[item.verdict] || 0) + 1;
    return acc;
  }, {});
  const output = {
    updatedAt: valuations.updatedAt || financials.updatedAt || null,
    methodology: rubric.purpose,
    guardrails: rubric.guardrails,
    counts,
    companies
  };
  fs.writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(`Wrote ${outPath}`);
}

main();
