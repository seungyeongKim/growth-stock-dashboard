const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const data = JSON.parse(fs.readFileSync(path.join(root, "data", "current-growth-selection.json"), "utf8"));
const dashboardPath = path.join(root, "index.html");
const dashboard = fs.readFileSync(dashboardPath, "utf8");
const replacement = [
  "/* CURRENT_GROWTH_SELECTION_START */",
  `const currentGrowthSelection = ${JSON.stringify(data, null, 2)};`,
  "/* CURRENT_GROWTH_SELECTION_END */"
].join("\n");
const pattern = /\/\* CURRENT_GROWTH_SELECTION_START \*\/[\s\S]*?\/\* CURRENT_GROWTH_SELECTION_END \*\//;
if (!pattern.test(dashboard)) throw new Error("current growth selection insertion boundary was not found in index.html");
fs.writeFileSync(dashboardPath, dashboard.replace(pattern, replacement));
console.log(`Applied ${data.items?.length || 0} current growth selections.`);
