const fs = require("fs");
const path = require("path");
const target = process.argv[2] || "index.html";
const html = fs.readFileSync(target, "utf8");
const script = html.match(/<script>([\s\S]*)<\/script>/);
if (!script) throw new Error("Script block not found");
new Function(script[1]);
const required = [
  "dailyGrowthTracking",
  "renderDailyGrowthTracking",
  "weeklyGrowthWatchlist",
  "renderWeeklyGrowthWatchlist",
  "companyDecisionModel",
  "renderDecisionOverview",
  "AI 결론",
  "financialSnapshots",
  "renderFinancialSnapshot"
];
const missing = required.filter((item) => !html.includes(item));
if (missing.length) throw new Error(`Missing markers: ${missing.join(", ")}`);

const modelPath = path.join(path.dirname(target), "data", "company-decision-model.json");
const model = JSON.parse(fs.readFileSync(modelPath, "utf8"));
const records = Object.entries(model.companies || {});
if (records.length !== 20) throw new Error(`Expected 20 decision records, found ${records.length}`);

const allowedConclusions = new Set(["관심 제외", "관찰", "심층 검토", "매수 조건 충족"]);
for (const [code, record] of records) {
  if (!allowedConclusions.has(record.conclusion)) throw new Error(`${code}: invalid conclusion`);
  for (const field of ["growthDurability", "growthAcceleration", "valuationAttractiveness", "expectationBurden", "confidence"]) {
    if (!Number.isFinite(record[field]) || record[field] < 0 || record[field] > 100) throw new Error(`${code}: invalid ${field}`);
  }
  if (!Array.isArray(record.minimumChecks) || record.minimumChecks.length < 3) throw new Error(`${code}: minimumChecks requires at least 3 items`);
  if (!record.positiveScenario || !record.bearCase) throw new Error(`${code}: scenario data is incomplete`);
}

const financialPath = path.join(path.dirname(target), "data", "financial-snapshots.json");
const financial = JSON.parse(fs.readFileSync(financialPath, "utf8"));
const financialRecords = Object.entries(financial.companies || {});
if (financial.updatedAt && financialRecords.length !== 20) throw new Error(`Expected 20 financial records after collection, found ${financialRecords.length}`);
for (const [code, record] of financialRecords) {
  if (!record.status || !Array.isArray(record.annual)) throw new Error(`${code}: invalid financial snapshot`);
}

console.log(JSON.stringify({ script: "ok", requiredMarkers: required.length, decisionRecords: records.length, financialRecords: financialRecords.length, target }, null, 2));

