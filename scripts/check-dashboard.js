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
  "renderFinancialSnapshot",
  "valuationSnapshot",
  "renderValuationSnapshot",
  "eventRadar",
  "renderEventRadar",
  "investmentDecision",
  "AI 결론"
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

const valuationPath = path.join(path.dirname(target), "data", "valuation-snapshot.json");
const valuation = JSON.parse(fs.readFileSync(valuationPath, "utf8"));
const valuationRecords = Object.entries(valuation.companies || {});
if (valuation.updatedAt && valuationRecords.length !== 20) throw new Error(`Expected 20 valuation records after collection, found ${valuationRecords.length}`);
for (const [code, record] of valuationRecords) {
  if (!record.status || !record.note) throw new Error(`${code}: invalid valuation snapshot`);
}

const eventPath = path.join(path.dirname(target), "data", "event-radar.json");
const eventRadar = JSON.parse(fs.readFileSync(eventPath, "utf8"));
const eventRecords = Object.entries(eventRadar.companies || {});
if (eventRadar.updatedAt && eventRecords.length !== 20) throw new Error(`Expected 20 event radar records after collection, found ${eventRecords.length}`);
for (const [code, record] of eventRecords) {
  if (!record.status || !Array.isArray(record.items)) throw new Error(`${code}: invalid event radar record`);
}

const decisionPath = path.join(path.dirname(target), "data", "investment-decision.json");
const decision = JSON.parse(fs.readFileSync(decisionPath, "utf8"));
const decisionRecords = Object.entries(decision.companies || {});
if (decision.updatedAt && decisionRecords.length !== 20) throw new Error(`Expected 20 investment decisions after collection, found ${decisionRecords.length}`);
for (const [code, record] of decisionRecords) {
  if (!allowedConclusions.has(record.verdict)) throw new Error(`${code}: invalid automated verdict`);
  if (!Number.isFinite(record.totalScore) || !Number.isFinite(record.confidence)) throw new Error(`${code}: invalid automated decision scores`);
  if (!Array.isArray(record.evidence) || !Array.isArray(record.minimumHumanChecks)) throw new Error(`${code}: incomplete automated decision evidence`);
}

console.log(JSON.stringify({ script: "ok", requiredMarkers: required.length, decisionRecords: records.length, financialRecords: financialRecords.length, valuationRecords: valuationRecords.length, eventRecords: eventRecords.length, automatedDecisions: decisionRecords.length, target }, null, 2));

