const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const data = JSON.parse(fs.readFileSync(path.join(root, "data", "event-radar.json"), "utf8"));
const dashboardPath = path.join(root, "index.html");
const dashboard = fs.readFileSync(dashboardPath, "utf8");
const replacement = [
  "/* EVENT_RADAR_START */",
  `const eventRadar = ${JSON.stringify(data, null, 2)};`,
  "/* EVENT_RADAR_END */"
].join("\n");
const pattern = /\/\* EVENT_RADAR_START \*\/[\s\S]*?\/\* EVENT_RADAR_END \*\//;
if (!pattern.test(dashboard)) throw new Error("event radar insertion boundary was not found in index.html");
fs.writeFileSync(dashboardPath, dashboard.replace(pattern, replacement));
console.log(`Applied ${Object.keys(data.companies || {}).length} event radar records.`);
