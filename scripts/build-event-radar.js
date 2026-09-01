const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const read = (name) => JSON.parse(fs.readFileSync(path.join(root, "data", name), "utf8"));
const watchlist = read("growth-watchlist-20.json");
const weekly = read("weekly-growth-watchlist.json");
const daily = read("daily-growth-tracking.json");
const outPath = path.join(root, "data", "event-radar.json");

function classify(title) {
  const text = String(title || "");
  if (/횡령|배임|관리종목|상장적격|회생절차|감사의견.*한정|거절/.test(text)) return { category: "중대 리스크", severity: "높음", impact: "투자 논리 재검토" };
  if (/유상증자|전환사채|신주인수권|교환사채/.test(text)) return { category: "자본조달", severity: "주의", impact: "희석·자금 사용처 확인" };
  if (/최대주주|주식등의대량보유|임원|주요주주/.test(text)) return { category: "지분변동", severity: "주의", impact: "지분 변화 이유와 규모 확인" };
  if (/단일판매|공급계약|수주/.test(text)) return { category: "수주·매출", severity: "정보", impact: "계약 규모·마진·매출 인식 시점 확인" };
  if (/잠정.*실적|영업.*잠정|매출액.*영업이익/.test(text)) return { category: "실적", severity: "정보", impact: "컨센서스 대비·마진 변화 확인" };
  if (/합병|분할|영업양수|타법인.*출자/.test(text)) return { category: "사업구조", severity: "주의", impact: "성장 논리와 자본배분 영향 확인" };
  return { category: "일반 공시", severity: "정보", impact: "원문 필요성 확인" };
}

function normalize(items) {
  const seen = new Set();
  return items.filter((item) => item?.title && !seen.has(item.receiptNo || `${item.date}:${item.title}`) && seen.add(item.receiptNo || `${item.date}:${item.title}`))
    .map((item) => ({ ...item, ...classify(item.title) }));
}

function main() {
  const weeklyByCode = new Map((weekly.items || []).map((item) => [item.code, item]));
  const dailyByCode = new Map((daily.targets || []).map((item) => [item.code, item]));
  const companies = {};
  for (const target of watchlist.targets || []) {
    const items = normalize([
      ...((weeklyByCode.get(target.code)?.dart?.items) || []),
      ...((dailyByCode.get(target.code)?.dart?.items) || [])
    ]).slice(0, 5);
    const highest = items.find((item) => item.severity === "높음") || items.find((item) => item.severity === "주의") || items[0] || null;
    companies[target.code] = {
      code: target.code,
      name: target.name,
      status: highest ? highest.severity : "변화 없음",
      headline: highest ? `${highest.category}: ${highest.title}` : "최근 수집 범위에서 주요 DART 공시 없음",
      items
    };
  }
  const output = {
    updatedAt: daily.updatedAt || weekly.updatedAt || null,
    sourcePolicy: "DART 공시 제목을 규칙 기반으로 분류한 보조 신호이며, 실제 영향은 공시 원문 확인이 필요하다.",
    companies
  };
  fs.writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(`Wrote ${outPath}`);
}

main();
