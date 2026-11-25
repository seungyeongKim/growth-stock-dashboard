const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const data = JSON.parse(fs.readFileSync(path.join(root, "data", "market-growth-scan.json"), "utf8"));
const file = path.join(root, "index.html");
const html = fs.readFileSync(file, "utf8");
const boundary = /\/\* MARKET_GROWTH_SCAN_START \*\/[\s\S]*?\/\* MARKET_GROWTH_SCAN_END \*\//;
if (!boundary.test(html) || !Array.isArray(data.items) || data.items.length > 20) throw new Error("Invalid market scan or HTML");
const codes = new Set();
const tracks = data.tracks || { verified: { items: data.items } };
if (data.tracks && (Object.keys(tracks).length !== 4
    || !["verified", "profitLed", "salesImproving", "salesWatch"].every((key) => tracks[key])
    || JSON.stringify(data.items) !== JSON.stringify(tracks.verified.items)
    || Object.values(tracks).reduce((sum, track) => sum + track.qualified, 0) !== data.pricedPass)) {
  throw new Error("Market scan categories do not reconcile");
}
for (const [key, track] of Object.entries(tracks)) {
  if (!Array.isArray(track.items) || track.items.length > 20 || (data.tracks && track.items.length !== Math.min(20, track.qualified))) {
    throw new Error(`Invalid candidate count in ${key}`);
  }
  track.items.forEach((row, index) => {
    if (!/^[A-Z0-9]{6}$/.test(row.code) || codes.has(row.code) || row.rank !== index + 1
      || !/^\d{14}$/.test(row.annualReceipt) || !/^\d{14}$/.test(row.recentReceipt)
      || !["KOSPI", "KOSDAQ"].includes(row.market) || !(row.price > 0)
      || (row.annualPer === null ? !key.startsWith("sales") : !(row.annualPer >= 0))
      || (data.tracks && row.track !== key)) throw new Error(`Invalid scan row in ${key}`);
    codes.add(row.code);
  });
}
const value = JSON.stringify(data, null, 2).replaceAll("<", "\\u003c");
fs.writeFileSync(file, html.replace(boundary, () => `/* MARKET_GROWTH_SCAN_START */\nconst marketGrowthScan = ${value};\n/* MARKET_GROWTH_SCAN_END */`));
