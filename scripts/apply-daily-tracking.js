const fs = require("fs");
const path = require("path");

const root = process.cwd();
const htmlPath = process.argv[2] || path.join(root, "index.html");
const trackingPath = process.argv[3] || path.join(root, "data", "daily-growth-tracking.json");

const html = fs.readFileSync(htmlPath, "utf8");
const tracking = JSON.parse(fs.readFileSync(trackingPath, "utf8"));
const literal = `const dailyGrowthTracking = ${JSON.stringify(tracking, null, 6)};`;
const dateOnly = String(tracking.updatedAt || "").slice(0, 10) || new Date().toISOString().slice(0, 10);

if (!html.includes("const dailyGrowthTracking =")) {
  throw new Error("dailyGrowthTracking block not found in index.html");
}

let next = html.replace(/const dailyGrowthTracking = [\s\S]*?;\n\n    function renderDailyGrowthTracking/, `${literal}\n\n    function renderDailyGrowthTracking`);
next = next.replace(/<strong id="dashboardBaseDate">[^<]*<\/strong>/, `<strong id="dashboardBaseDate">${dateOnly}</strong>`);
next = next.replace(/<span id="dashboardUpdateDate">[^<]*<\/span>/, `<span id="dashboardUpdateDate">업데이트 ${dateOnly}</span>`);

fs.writeFileSync(htmlPath, next, "utf8");
console.log(`Applied daily tracking to ${htmlPath}`);
console.log(`Updated dashboard header date to ${dateOnly}`);
