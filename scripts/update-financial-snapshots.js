const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const root = path.resolve(__dirname, "..");
const targets = JSON.parse(fs.readFileSync(path.join(root, "data", "growth-watchlist-20.json"), "utf8")).targets;
const outPath = path.join(root, "data", "financial-snapshots.json");
const dartKey = process.env.DART_API_KEY || process.env.OPENDART_API_KEY || "";

function kstDate(date = new Date()) {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(date).replace(" ", "T");
}

function safeJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

function errorText(error) {
  return [error?.message, error?.cause?.code, error?.cause?.message].filter(Boolean).join(" / ") || String(error);
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function fetchResponse(url, { timeoutMs = 20000, retries = 1 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { headers: { "user-agent": "growth-stock-dashboard/1.0", accept: "application/json" }, signal: controller.signal });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(800 * (attempt + 1));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error(errorText(lastError));
}

async function fetchJson(url) { return (await fetchResponse(url)).json(); }

function unzipEntry(zip, fileName) {
  for (let pos = zip.length - 22; pos >= 0; pos -= 1) {
    if (zip.readUInt32LE(pos) !== 0x06054b50) continue;
    const entries = zip.readUInt16LE(pos + 10);
    let cursor = zip.readUInt32LE(pos + 16);
    for (let index = 0; index < entries; index += 1) {
      if (zip.readUInt32LE(cursor) !== 0x02014b50) throw new Error("Invalid DART corp code archive");
      const method = zip.readUInt16LE(cursor + 10);
      const compressedSize = zip.readUInt32LE(cursor + 20);
      const nameLength = zip.readUInt16LE(cursor + 28);
      const extraLength = zip.readUInt16LE(cursor + 30);
      const commentLength = zip.readUInt16LE(cursor + 32);
      const localOffset = zip.readUInt32LE(cursor + 42);
      const name = zip.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
      cursor += 46 + nameLength + extraLength + commentLength;
      if (name !== fileName) continue;
      if (zip.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("Invalid local file header");
      const localNameLength = zip.readUInt16LE(localOffset + 26);
      const localExtraLength = zip.readUInt16LE(localOffset + 28);
      const payload = zip.subarray(localOffset + 30 + localNameLength + localExtraLength, localOffset + 30 + localNameLength + localExtraLength + compressedSize);
      return method === 0 ? payload : method === 8 ? zlib.inflateRawSync(payload) : (() => { throw new Error(`Unsupported archive compression: ${method}`); })();
    }
  }
  throw new Error(`${fileName} not found in DART archive`);
}

async function fetchCorpCodes() {
  const url = new URL("https://opendart.fss.or.kr/api/corpCode.xml");
  url.searchParams.set("crtfc_key", dartKey);
  const zip = Buffer.from(await (await fetchResponse(url)).arrayBuffer());
  const xml = unzipEntry(zip, "CORPCODE.xml").toString("utf8");
  const byStockCode = new Map();
  for (const match of xml.matchAll(/<list>([\s\S]*?)<\/list>/g)) {
    const value = (tag) => match[1].match(new RegExp(`<${tag}>([\\s\\S]*?)<\/${tag}>`))?.[1]?.trim() || "";
    const stockCode = value("stock_code");
    if (stockCode) byStockCode.set(stockCode.padStart(6, "0"), value("corp_code"));
  }
  return byStockCode;
}

function amount(value) {
  const parsed = Number(String(value || "").replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function accountValue(records, ids, names) {
  const record = records.find((item) => ids.includes(item.account_id)) || records.find((item) => names.includes(String(item.account_nm || "").replaceAll(" ", "")));
  return record ? amount(record.thstrm_amount) : null;
}

function normalizeStatement(data, year, period, reportCode, fsDiv) {
  if (!data || !["000", "013"].includes(data.status) || !Array.isArray(data.list)) {
    throw new Error(`DART 재무 API ${data?.status || "unknown"}: ${data?.message || "응답 오류"}`);
  }
  const records = data.list.filter((item) => item.sj_div === "IS" || item.sj_div === "CIS");
  const revenue = accountValue(records, ["ifrs-full_Revenue", "ifrs-full_RevenueFromContractsWithCustomers"], ["매출액", "수익(매출액)", "영업수익"]);
  const operatingProfit = accountValue(records, ["dart_OperatingIncomeLoss"], ["영업이익"]);
  const netIncome = accountValue(records, ["ifrs-full_ProfitLoss"], ["당기순이익", "당기순이익(손실)"]);
  return {
    year,
    period,
    reportCode,
    fsDiv,
    revenue,
    operatingProfit,
    netIncome,
    operatingMargin: revenue ? Number((operatingProfit / revenue * 100).toFixed(1)) : null,
    netMargin: revenue ? Number((netIncome / revenue * 100).toFixed(1)) : null,
    source: "OpenDART 단일회사 전체 재무제표"
  };
}

async function fetchStatement(corpCode, year, reportCode, period) {
  const url = new URL("https://opendart.fss.or.kr/api/fnlttSinglAcntAll.json");
  url.searchParams.set("crtfc_key", dartKey);
  url.searchParams.set("corp_code", corpCode);
  url.searchParams.set("bsns_year", String(year));
  url.searchParams.set("reprt_code", reportCode);
  url.searchParams.set("fs_div", "CFS");
  let data = await fetchJson(url);
  if (data.status === "013") {
    url.searchParams.set("fs_div", "OFS");
    data = await fetchJson(url);
    return normalizeStatement(data, year, period, reportCode, "OFS");
  }
  return normalizeStatement(data, year, period, reportCode, "CFS");
}

function enrichAnnual(records) {
  return records.map((record, index) => {
    const previous = records[index - 1];
    return {
      ...record,
      revenueGrowthYoY: previous?.revenue && record.revenue ? Number(((record.revenue / previous.revenue - 1) * 100).toFixed(1)) : null,
      operatingProfitGrowthYoY: previous?.operatingProfit && record.operatingProfit ? Number(((record.operatingProfit / previous.operatingProfit - 1) * 100).toFixed(1)) : null
    };
  });
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await mapper(items[index]);
    }
  }));
  return results;
}

function latestInterimPlan() {
  const now = new Date();
  const year = Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Seoul", year: "numeric" }).format(now));
  const month = Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Seoul", month: "numeric" }).format(now));
  if (month >= 8) return { year, reportCode: "11012", period: `${year} H1` };
  if (month >= 5) return { year, reportCode: "11013", period: `${year} Q1` };
  return null;
}

async function buildCompany(target, corpCode) {
  if (!corpCode) return { code: target.code, name: target.name, status: "unavailable", note: "DART 고유번호를 찾지 못함", annual: [], latestInterim: null };
  const currentYear = Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Seoul", year: "numeric" }).format(new Date()));
  const years = [currentYear - 3, currentYear - 2, currentYear - 1];
  const annualResults = await Promise.allSettled(years.map((year) => fetchStatement(corpCode, year, "11011", `${year} FY`)));
  const annual = enrichAnnual(annualResults.filter((item) => item.status === "fulfilled").map((item) => item.value));
  const interimPlan = latestInterimPlan();
  const interimResult = interimPlan ? await Promise.allSettled([
    fetchStatement(corpCode, interimPlan.year, interimPlan.reportCode, interimPlan.period),
    fetchStatement(corpCode, interimPlan.year - 1, interimPlan.reportCode, `${interimPlan.year - 1} ${interimPlan.period.split(" ").at(-1)}`)
  ]) : [];
  const latestInterim = interimResult[0]?.status === "fulfilled" ? interimResult[0].value : null;
  const priorInterim = interimResult[1]?.status === "fulfilled" ? interimResult[1].value : null;
  const interimRevenueGrowthYoY = latestInterim?.revenue && priorInterim?.revenue ? Number(((latestInterim.revenue / priorInterim.revenue - 1) * 100).toFixed(1)) : null;
  const interimOperatingMarginChangeYoY = Number.isFinite(latestInterim?.operatingMargin) && Number.isFinite(priorInterim?.operatingMargin)
    ? Number((latestInterim.operatingMargin - priorInterim.operatingMargin).toFixed(1)) : null;
  const financialSignal = interimRevenueGrowthYoY === null || interimOperatingMarginChangeYoY === null ? "비교 자료 부족"
    : interimRevenueGrowthYoY <= 0 ? "성장 둔화 경보"
      : interimOperatingMarginChangeYoY <= -5 ? "수익성 둔화 경보"
        : interimRevenueGrowthYoY >= 15 ? "성장 가속·유지"
          : "성장 유지·확인";
  const failures = [...annualResults, ...interimResult].filter((item) => item.status === "rejected").map((item) => errorText(item.reason));
  const latestAnnual = annual.at(-1);
  return {
    code: target.code,
    name: target.name,
    corpCode,
    status: annual.length >= 2 ? (failures.length ? "partial" : "ok") : "partial",
    note: failures.length ? `일부 재무 수집 실패: ${failures[0]}` : "최근 3개 연도와 최신 분기/반기 재무 수집",
    annual,
    latestInterim,
    priorInterim,
    summary: latestAnnual ? {
      latestAnnualYear: latestAnnual.year,
      latestAnnualRevenueGrowth: latestAnnual.revenueGrowthYoY,
      latestAnnualOperatingMargin: latestAnnual.operatingMargin,
      latestAnnualNetMargin: latestAnnual.netMargin,
      latestInterimRevenue: latestInterim?.revenue ?? null,
      latestInterimOperatingMargin: latestInterim?.operatingMargin ?? null,
      interimRevenueGrowthYoY,
      interimOperatingMarginChangeYoY,
      financialSignal
    } : null
  };
}

async function main() {
  const previous = safeJson(outPath, { companies: {} });
  const attemptedAt = kstDate();
  if (!dartKey) {
    fs.writeFileSync(outPath, `${JSON.stringify({ ...previous, lastAttemptAt: attemptedAt, dart: { enabled: false, note: "DART_API_KEY가 없어 기존 재무 스냅샷을 유지함" } }, null, 2)}\n`, "utf8");
    console.log("DART_API_KEY is missing; kept previous financial snapshot.");
    return;
  }

  const corpCodes = await fetchCorpCodes();
  const rows = await mapLimit(targets, 4, (target) => buildCompany(target, corpCodes.get(target.code)));
  const companies = Object.fromEntries(rows.map((row) => [row.code, row]));
  const successful = rows.filter((row) => row.status === "ok").length;
  const output = {
    updatedAt: attemptedAt,
    lastAttemptAt: attemptedAt,
    dart: { enabled: true, note: `OpenDART 공식 재무 수집 완료: 정상 ${successful}개, 부분 ${rows.length - successful}개` },
    sourcePolicy: "재무 수치는 OpenDART 단일회사 전체 재무제표에서 수집한 연결(CFS) 우선, 없으면 별도(OFS) 기준 값이다. 매수 전 회사 공시 원문을 다시 확인한다.",
    companies
  };
  fs.writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(`Wrote ${outPath}`);
}

main().catch((error) => { console.error(error); process.exit(1); });
