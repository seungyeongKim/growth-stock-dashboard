const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const data = JSON.parse(fs.readFileSync(path.join(root, "data", "investment-decision.json"), "utf8"));
const dashboardPath = path.join(root, "index.html");
const dashboard = fs.readFileSync(dashboardPath, "utf8");
const replacement = [
  "/* INVESTMENT_DECISION_START */",
  `const investmentDecision = ${JSON.stringify(data, null, 2)};`,
  "/* INVESTMENT_DECISION_END */"
].join("\n");
const pattern = /\/\* INVESTMENT_DECISION_START \*\/[\s\S]*?\/\* INVESTMENT_DECISION_END \*\//;
if (!pattern.test(dashboard)) throw new Error("investment decision insertion boundary was not found in index.html");
fs.writeFileSync(dashboardPath, dashboard.replace(pattern, replacement));
console.log(`Applied ${Object.keys(data.companies || {}).length} investment decisions.`);
