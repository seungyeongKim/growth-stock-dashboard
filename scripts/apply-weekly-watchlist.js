const fs = require("fs");
const path = require("path");

const root = process.cwd();
const htmlPath = process.argv[2] || path.join(root, "index.html");
const trackingPath = process.argv[3] || path.join(root, "data", "weekly-growth-watchlist.json");
const html = fs.readFileSync(htmlPath, "utf8");
const tracking = JSON.parse(fs.readFileSync(trackingPath, "utf8"));
const literal = `const weeklyGrowthWatchlist = ${JSON.stringify(tracking, null, 6)};`;
if (!html.includes("const weeklyGrowthWatchlist =")) {
  throw new Error("weeklyGrowthWatchlist block not found in index.html");
}
const next = html.replace(/const weeklyGrowthWatchlist = [\s\S]*?;\n\n    function renderWeeklyGrowthWatchlist/, `${literal}\n\n    function renderWeeklyGrowthWatchlist`);
fs.writeFileSync(htmlPath, next, "utf8");
console.log(`Applied weekly watchlist to ${htmlPath}`);
