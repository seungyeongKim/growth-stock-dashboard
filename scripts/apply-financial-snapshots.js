const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const data = JSON.parse(fs.readFileSync(path.join(root, "data", "financial-snapshots.json"), "utf8"));
const dashboardPath = path.join(root, "index.html");
const dashboard = fs.readFileSync(dashboardPath, "utf8");
const replacement = [
  "/* FINANCIAL_SNAPSHOTS_START */",
  `const financialSnapshots = ${JSON.stringify(data, null, 2)};`,
  "/* FINANCIAL_SNAPSHOTS_END */"
].join("\n");
const pattern = /\/\* FINANCIAL_SNAPSHOTS_START \*\/[\s\S]*?\/\* FINANCIAL_SNAPSHOTS_END \*\//;
if (!pattern.test(dashboard)) throw new Error("financial snapshot insertion boundary was not found in index.html");
fs.writeFileSync(dashboardPath, dashboard.replace(pattern, replacement));
console.log(`Applied ${Object.keys(data.companies || {}).length} financial snapshots.`);
