const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const data = JSON.parse(fs.readFileSync(path.join(root, "data", "valuation-snapshot.json"), "utf8"));
const dashboardPath = path.join(root, "index.html");
const dashboard = fs.readFileSync(dashboardPath, "utf8");
const replacement = [
  "/* VALUATION_SNAPSHOT_START */",
  `const valuationSnapshot = ${JSON.stringify(data, null, 2)};`,
  "/* VALUATION_SNAPSHOT_END */"
].join("\n");
const pattern = /\/\* VALUATION_SNAPSHOT_START \*\/[\s\S]*?\/\* VALUATION_SNAPSHOT_END \*\//;
if (!pattern.test(dashboard)) throw new Error("valuation snapshot insertion boundary was not found in index.html");
fs.writeFileSync(dashboardPath, dashboard.replace(pattern, replacement));
console.log(`Applied ${Object.keys(data.companies || {}).length} valuation snapshots.`);
