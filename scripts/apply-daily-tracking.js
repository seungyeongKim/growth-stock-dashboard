const fs = require("fs");
const path = require("path");

const root = process.cwd();
const htmlPath = process.argv[2] || path.join(root, "index.html");
const trackingPath = process.argv[3] || path.join(root, "data", "daily-growth-tracking.json");

const html = fs.readFileSync(htmlPath, "utf8");
const tracking = JSON.parse(fs.readFileSync(trackingPath, "utf8"));
const literal = `const dailyGrowthTracking = ${JSON.stringify(tracking, null, 6)};`;

if (!html.includes("const dailyGrowthTracking =")) {
  throw new Error("dailyGrowthTracking block not found in index.html");
}

const next = html.replace(/const dailyGrowthTracking = [\s\S]*?;\n\n    function renderDailyGrowthTracking/, `${literal}\n\n    function renderDailyGrowthTracking`);
fs.writeFileSync(htmlPath, next, "utf8");
console.log(`Applied daily tracking to ${htmlPath}`);
