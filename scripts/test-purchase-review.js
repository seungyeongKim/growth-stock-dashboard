const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { hurdle, earningsBase, buildReview, parseMarketValue } = require("./build-purchase-review");

test("reverse valuation compounds the goal, separates multiples and rejects negative earnings", () => {
  assert.deepEqual(hurdle(2000, 100, 20, 2, 0.12), { multiple: 20, requiredNet: 125, requiredCagr: 12 });
  assert.ok(hurdle(2000, 100, 15, 2, 0.12).requiredCagr > 12);
  assert.equal(hurdle(2000, -20, 20, 2, 0.12).requiredCagr, null);
});

test("TTM uses matched year, period and scope; otherwise exposes annual fallback", () => {
  const annual = { year: 2025, period: "2025 FY", fsDiv: "CFS", ownerNet: 100 };
  const latest = { year: 2026, period: "2026 Q3", fsDiv: "CFS", reportCode: "11014", cumulativeOwnerNet: 90 };
  const prior = { year: 2025, fsDiv: "CFS", reportCode: "11014", cumulativeOwnerNet: 75 };
  assert.deepEqual(earningsBase(annual, latest, prior), { net: 115, label: "2026 Q3 TTM", fsDiv: "CFS" });
  assert.equal(earningsBase(annual, latest, { ...prior, fsDiv: "OFS" }).net, 100);
  assert.equal(earningsBase({ ...annual, ownerNet: null }, latest, prior), null);
});

test("missing or incomparable data is not treated as normal growth", () => {
  const result = buildReview({ name: "Test" }, {
    annual: [], latestInterim: { fsDiv: "CFS", receipt: "20261125000001" },
    priorInterim: { fsDiv: "OFS", receipt: "not a filing" },
  }, { status: "partial", marketCap: null }, {}, "2026-11-25");
  assert.equal(result.revenueGrowth, null);
  assert.equal(result.actualPer, null);
  assert.deepEqual(result.scenarios, []);
  assert.deepEqual(result.receipts, ["20261125000001"]);
  assert.ok(result.notes.length);
});

test("a direct market-cap fallback is labeled and a scope break blocks earnings multiples", () => {
  assert.equal(parseMarketValue("1조 9,476억"), 1947600000000);
  assert.equal(parseMarketValue("4,500억"), 450000000000);
  assert.equal(parseMarketValue("1,000원"), null);
  const result = buildReview({ name: "Split" }, { annual: [{ year: 2025, ownerNet: 100 }] },
    {}, { breakThroughYear: 2026 }, "2026-11-25", 2000);
  assert.equal(result.actualPer, null);
  assert.ok(result.marketCapSource.includes("Npay"));
  assert.equal(result.scenarios[1].requiredCagr, null);
  assert.ok(result.scenarios[1].requiredNet > 0);
});

test("position caps cannot exceed allocation or stress-loss budget", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const definition = html.match(/function calculatePositionPlan[\s\S]*?(?=\n    function renderCommonDashboard\()/)[0];
  const calc = vm.runInNewContext(`${definition}\ncalculatePositionPlan`);
  const plan = calc(10, 40, 1);
  assert.equal(plan.cap, 2.5);
  assert.equal(plan.tranches.reduce((a, b) => a + b, 0), 2.5);
  assert.equal(calc(2, 40, 1).cap, 2);
  assert.equal(calc(10, 0, 1), null);
});
