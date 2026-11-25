const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const read = (name) => JSON.parse(fs.readFileSync(path.join(root, "data", name), "utf8"));
const write = (name, data) => fs.writeFileSync(path.join(root, "data", name), `${JSON.stringify(data, null, 2)}\n`, "utf8");
const targets = read("growth-watchlist-20.json");
const weekly = read("weekly-growth-watchlist.json");
const decisions = read("investment-decision.json");
const financials = read("financial-snapshots.json");
const valuations = read("valuation-snapshot.json");

const verdictRank = { "심층 검토": 0, "관찰": 1, "관심 제외": 2, "매수 조건 충족": 0 };

function hasGrowthQuality(code) {
  const latest = financials.companies?.[code]?.annual?.at(-1);
  const signal = financials.companies?.[code]?.summary?.financialSignal;
  if (!latest) return { passed: false, reason: "공식 재무 부족" };
  const passed = latest.revenueGrowthYoY >= 10 && latest.operatingMargin >= 10 && latest.netMargin >= 10 && !["성장 둔화 경보", "수익성 둔화 경보"].includes(signal);
  return { passed, reason: passed ? "매출 성장·수익성·최근 실적 신호 통과" : signal || "재무 조건 재확인" };
}

function rankTarget(target) {
  const decision = decisions.companies?.[target.code] || {};
  const valuation = valuations.companies?.[target.code] || {};
  const quality = hasGrowthQuality(target.code);
  return {
    ...target,
    verdict: decision.verdict || "관찰",
    totalScore: decision.totalScore ?? 0,
    confidence: decision.confidence ?? 0,
    financialSignal: financials.companies?.[target.code]?.summary?.financialSignal || "비교 자료 부족",
    valuation: valuation.classification || "확인 필요",
    currentFinancialPass: quality.passed,
    screenReason: quality.reason
  };
}

function applyPriority(items) {
  return items.map((item, index) => ({
    ...item,
    priority: index + 1,
    group: item.verdict === "심층 검토" && index < 5 ? "deep" : item.verdict === "관심 제외" ? "reserve" : "watch"
  }));
}

function toTarget(item) {
  const { verdict, totalScore, confidence, financialSignal, valuation, currentFinancialPass, screenReason, ...target } = item;
  return target;
}

function main() {
  const ranked = targets.targets.map(rankTarget).sort((a, b) =>
    (verdictRank[a.verdict] ?? 9) - (verdictRank[b.verdict] ?? 9)
    || Number(b.currentFinancialPass) - Number(a.currentFinancialPass)
    || b.totalScore - a.totalScore
    || b.confidence - a.confidence
    || a.name.localeCompare(b.name, "ko-KR")
  );
  const selected = applyPriority(ranked);
  const selectedTargets = selected.map(toTarget);
  const weeklyByCode = new Map((weekly.items || []).map((item) => [item.code, item]));
  const selectedWeekly = selected.map((item) => ({ ...weeklyByCode.get(item.code), ...toTarget(item) }));
  const updatedAt = decisions.updatedAt || financials.updatedAt || weekly.updatedAt || null;

  write("growth-watchlist-20.json", {
    ...targets,
    selectionUpdatedAt: updatedAt,
    reviewRule: "매주 최신 OpenDART 재무·현재 가격·최근 공시를 반영해 20개 관찰군의 심층 검토 순위를 다시 매긴다. 검증된 최신 전망치가 없으면 자동 매수 판단으로 승격하지 않는다.",
    targets: selectedTargets
  });
  write("weekly-growth-watchlist.json", {
    ...weekly,
    selectionUpdatedAt: updatedAt,
    sourcePolicy: "20개 관찰군은 최신 OpenDART 재무·최근 공시와 현재 가격 참고값으로 매주 재정렬한다. 자동 판단은 매수 추천이 아니며, 최신 전망치 출처가 없으면 매수 조건 충족으로 올리지 않는다.",
    items: selectedWeekly
  });
  write("current-growth-selection.json", {
    updatedAt,
    methodology: "기존 20개 후보를 최신 공식 재무, 현재 가격 기반 확정 실적 밸류에이션, 최근 공시 위험 신호로 다시 정렬한다. 이는 전 종목 시장 스캔이 아니라 현재 관리 중인 20개 후보군의 재선별 결과다.",
    guardrails: [
      "OpenDART 공식 재무가 없거나 최근 실적 경보가 있으면 심층 검토 우선순위를 낮춘다.",
      "현재 가격은 Naver Finance 참고값이며, 확정 실적 P/E는 미래 이익 추정치가 아니다.",
      "검증 가능한 최신 컨센서스·목표주가 소스가 연결되기 전에는 자동 매수 조건 충족으로 분류하지 않는다."
    ],
    counts: selected.reduce((result, item) => {
      result[item.verdict] = (result[item.verdict] || 0) + 1;
      return result;
    }, {}),
    items: selected.map((item) => ({
      code: item.code,
      name: item.name,
      industry: item.industry,
      rank: item.priority,
      verdict: item.verdict,
      totalScore: item.totalScore,
      confidence: item.confidence,
      financialSignal: item.financialSignal,
      valuation: item.valuation,
      currentFinancialPass: item.currentFinancialPass,
      screenReason: item.screenReason
    }))
  });
  console.log(`Refreshed growth selection for ${selected.length} companies.`);
}

main();
