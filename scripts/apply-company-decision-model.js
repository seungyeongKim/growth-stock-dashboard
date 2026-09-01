const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const dataPath = path.join(root, "data", "company-decision-model.json");
const dashboardPath = path.join(root, "index.html");
const model = JSON.parse(fs.readFileSync(dataPath, "utf8"));
const dashboard = fs.readFileSync(dashboardPath, "utf8");
const replacement = [
  "/* COMPANY_DECISION_MODEL_START */",
  `const companyDecisionModel = ${JSON.stringify(model, null, 2)};`,
  "/* COMPANY_DECISION_MODEL_END */"
].join("\n");
const pattern = /\/\* COMPANY_DECISION_MODEL_START \*\/[\s\S]*?\/\* COMPANY_DECISION_MODEL_END \*\//;

if (!pattern.test(dashboard)) {
  throw new Error("company decision model insertion boundary was not found in index.html");
}

fs.writeFileSync(dashboardPath, dashboard.replace(pattern, replacement));
console.log(`Applied ${Object.keys(model.companies).length} company decision records.`);
