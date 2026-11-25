const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const data = JSON.parse(fs.readFileSync(path.join(root, "data", "market-growth-scan.json"), "utf8"));
const file = path.join(root, "index.html");
const html = fs.readFileSync(file, "utf8");
const boundary = /\/\* MARKET_GROWTH_SCAN_START \*\/[\s\S]*?\/\* MARKET_GROWTH_SCAN_END \*\//;
if (!boundary.test(html) || !Array.isArray(data.items) || data.items.length > 20) throw new Error("Invalid market scan or HTML");
const codes = new Set();
data.items.forEach((row, index) => {
  if (!/^[A-Z0-9]{6}$/.test(row.code) || codes.has(row.code) || row.rank !== index + 1
    || !/^\d{14}$/.test(row.annualReceipt) || !/^\d{14}$/.test(row.recentReceipt)
    || !["KOSPI", "KOSDAQ"].includes(row.market) || !(row.annualPer > 0 && row.price > 0)) throw new Error("Invalid scan row");
  codes.add(row.code);
});
const value = JSON.stringify(data, null, 2).replaceAll("<", "\\u003c");
fs.writeFileSync(file, html.replace(boundary, () => `/* MARKET_GROWTH_SCAN_START */\nconst marketGrowthScan = ${value};\n/* MARKET_GROWTH_SCAN_END */`));
