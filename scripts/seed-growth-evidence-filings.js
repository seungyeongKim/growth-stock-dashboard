const fs = require("node:fs/promises");
const snapshots = require("../data/financial-snapshots.json");

const receipts = {
  "sanil-base": "20261116001322", "sanil-prior": "20251121000329",
  "silicon-base": "20261113000882", "silicon-prior": "20251113000448",
  "pharma-base": "20261113001686", "pharma-prior": "20251114000932"
};

async function main() {
  const key = process.env.DART_API_KEY;
  if (!key) throw new Error("Missing OpenDART key");
  await fs.mkdir("evidence-filings", { recursive: true });
  const epsCases = { "ls-electric": "010120", "samsung-biologics": "207940" };
  const specific = process.env.EPS_ONLY === "1";
  const selected = specific ? Object.fromEntries(Object.entries(epsCases).map(([name, code]) => [name, snapshots.companies[code].latestInterim.receipt])) : receipts;
  for (const [caseName, receipt] of Object.entries(selected)) {
    let saved = false;
    for (const endpoint of ["https://opendart.fss.or.kr/api/document.xml", "https://engopendart.fss.or.kr/engapi/document.xml"]) {
      const query = new URLSearchParams({ crtfc_key: key, rcept_no: receipt });
      try {
        const response = await fetch(`${endpoint}?${query}`, { signal: AbortSignal.timeout(18000) });
        const bytes = Buffer.from(await response.arrayBuffer());
        if (!response.ok || bytes.subarray(0, 4).toString("hex") !== "504b0304") continue;
        await fs.writeFile(`evidence-filings/${caseName}-${receipt}.zip`, bytes);
        saved = true;
        break;
      } catch {
        // Try the other official endpoint without printing a query with credentials.
      }
    }
    console.log(`${caseName}: ${saved ? "saved" : "unavailable"}`);
  }
  if (specific) {
    for (const [name, code] of Object.entries(epsCases)) {
      const company = snapshots.companies[code];
      const record = company.latestInterim;
      const query = new URLSearchParams({ crtfc_key: key, corp_code: company.corpCode, bsns_year: record.year,
        reprt_code: record.reportCode, fs_div: record.fsDiv });
      try {
        const response = await fetch(`https://opendart.fss.or.kr/api/fnlttSinglAcntAll.json?${query}`, { signal: AbortSignal.timeout(18000) });
        const data = await response.json();
        const rows = (data.list || []).filter((row) => row.rcept_no === record.receipt && (/주당/.test(row.account_nm) || /PerShare/.test(row.account_id)));
        await fs.writeFile(`evidence-filings/${name}-eps-rows.json`, JSON.stringify({ status: data.status, rows }, null, 2));
      } catch { console.log(`${name} EPS rows unavailable`); }
    }
  }
}

main().catch(() => { process.exitCode = 1; });
