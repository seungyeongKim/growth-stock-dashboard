const fs = require("node:fs/promises");

const receipts = {
  "sanil-base": "20261116001322", "sanil-prior": "20251121000329",
  "silicon-base": "20261113000882", "silicon-prior": "20251113000448",
  "pharma-base": "20261113001686", "pharma-prior": "20251114000932"
};

async function main() {
  const key = process.env.DART_API_KEY;
  if (!key) throw new Error("Missing OpenDART key");
  await fs.mkdir("evidence-filings", { recursive: true });
  for (const [caseName, receipt] of Object.entries(receipts)) {
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
}

main().catch(() => { process.exitCode = 1; });
