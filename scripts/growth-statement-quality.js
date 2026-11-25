const normalizeName = (value) => String(value || "").replace(/\s/g, "");

function number(value) {
  const text = String(value ?? "").trim().replaceAll(",", "");
  if (!text) return null;
  const parsed = Number(text.replace(/^\((.+)\)$/, "-$1"));
  return Number.isFinite(parsed) ? parsed : null;
}

function rowRank(row, metric) {
  const name = normalizeName(row.account_nm);
  const id = String(row.account_id || "").split("_").at(-1);
  if (metric === "cash") {
    if (row.sj_div !== "CF") return 0;
    if (id === "CashFlowsFromUsedInOperatingActivities") return 2;
    return /^(?:[IVX]+\.|\d+\.)?영업활동(?:으로인한|으로부터의)?현금흐름$/.test(name) ? 1 : 0;
  }
  if (row.sj_div !== "IS" && row.sj_div !== "CIS") return 0;
  if (metric === "eps") {
    if (/우선주|계속|중단|지속/.test(name) || /Continuing|Discontinued|^Diluted/.test(id)) return 0;
    if (id === "BasicEarningsLossPerShare") return 2;
    return /기본주당|주당기본|기본및희석주당/.test(name) ? 1 : 0;
  }
  if (metric === "sales") {
    if (id === "Revenue") return 3;
    if (id === "RevenueFromContractsWithCustomers") return 2;
    return ["매출액", "수익(매출액)", "영업수익"].includes(name) ? 1 : 0;
  }
  if (id === "OperatingIncomeLoss") return 2;
  return /^(?:영업이익|영업이익\(손실\))$/.test(name) ? 1 : 0;
}

function usablePair(rows, metric, reportCode) {
  const early = reportCode === "11013";
  const annual = reportCode === "11011";
  const priorKeys = annual ? ["frmtrm_amount"] : metric === "cash" || early
    ? ["frmtrm_q_amount", "frmtrm_add_amount"] : ["frmtrm_add_amount"];
  const currentKeys = annual || early || metric === "cash" ? ["thstrm_amount"] : ["thstrm_add_amount"];
  const first = (row, keys) => keys.map((key) => number(row[key])).find(Number.isFinite) ?? null;
  const candidates = rows.map((row) => ({ rank: rowRank(row, metric), current: first(row, currentKeys), prior: first(row, priorKeys) }))
    .filter((item) => item.rank > 0 && Number.isFinite(item.current));
  if (!candidates.length) return null;
  const highest = Math.max(...candidates.map(({ rank }) => rank));
  const best = candidates.filter(({ rank }) => rank === highest);
  const paired = best.filter(({ prior }) => Number.isFinite(prior));
  const chosen = paired.length ? paired : best;
  if (!chosen.every((item) => item.current === chosen[0].current && item.prior === chosen[0].prior)) return null;
  const { current, prior } = chosen[0];
  return { current, prior };
}

function readGrowthStatementQuality(records, reportCode, receipt) {
  if (!/^\d{14}$/.test(receipt || "") || !["11011", "11012", "11013", "11014"].includes(reportCode)) return null;
  const rows = records.filter((row) => row.rcept_no === receipt && row.currency === "KRW");
  const quality = Object.fromEntries(["sales", "operatingProfit", "eps", "cash"].map((metric) => [metric, usablePair(rows, metric, reportCode)]));
  return Object.values(quality).some(Boolean) ? quality : null;
}

module.exports = { readGrowthStatementQuality };
