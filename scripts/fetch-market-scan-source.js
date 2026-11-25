const fs = require("node:fs");

async function main() {
  const { url, timeoutMs } = JSON.parse(fs.readFileSync(0, "utf8"));
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: "application/json, */*", "user-agent": "growth-stock-dashboard/1.0" }
  });
  if (!response.ok) {
    process.stderr.write(String(response.status));
    process.exitCode = 1;
    return;
  }
  process.stdout.write(Buffer.from(await response.arrayBuffer()));
}

main().catch(() => { process.exitCode = 2; });
