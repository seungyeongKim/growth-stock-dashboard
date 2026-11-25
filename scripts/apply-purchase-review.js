const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const data = JSON.parse(fs.readFileSync(path.join(root, "data", "purchase-review.json"), "utf8"));
const htmlPath = path.join(root, "index.html");
const html = fs.readFileSync(htmlPath, "utf8");
const boundary = /\/\* PURCHASE_REVIEW_START \*\/[\s\S]*?\/\* PURCHASE_REVIEW_END \*\//;
if (!boundary.test(html)) throw new Error("Missing purchase review insertion boundary");
const payload = JSON.stringify(data, null, 2).replaceAll("<", "\\u003c");
fs.writeFileSync(htmlPath, html.replace(boundary, () =>
  `/* PURCHASE_REVIEW_START */\nconst purchaseReview = ${payload};\n/* PURCHASE_REVIEW_END */`));
