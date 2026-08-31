const fs = require("fs");
const path = require("path");

const root = process.cwd();
const targetPath = path.join(root, "data", "growth-tracking-targets.json");
const outPath = path.join(root, "data", "daily-growth-tracking.json");
const targets = JSON.parse(fs.readFileSync(targetPath, "utf8")).targets;
const dartKey = process.env.DART_API_KEY || process.env.OPENDART_API_KEY || "";

function kstDate(date = new Date()) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(date).replace(" ", "T");
}

function ymd(date) {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(date).replaceAll("-", "");
}

function daysAgo(days) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeError(error) {
  return [error?.message, error?.cause?.code, error?.cause?.message].filter(Boolean).join(" / ") || String(error);
}

async function fetchJson(url, { timeoutMs = 15000, retries = 1 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        headers: {
          "accept": "application/json",
          "user-agent": "growth-stock-dashboard/1.0"
        },
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return response.json();
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(1000 * (attempt + 1));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error(describeError(lastError));
}

let dartListPromise;
async function fetchDartList() {
  if (!dartKey) return { enabled: false, list: [], note: "DART_API_KEY가 없어 공시 자동 수집은 건너뜀" };
  if (!dartListPromise) {
    const end = ymd(new Date());
    const begin = ymd(daysAgo(14));
    const url = new URL("https://opendart.fss.or.kr/api/list.json");
    url.searchParams.set("crtfc_key", dartKey);
    url.searchParams.set("bgn_de", begin);
    url.searchParams.set("end_de", end);
    url.searchParams.set("corp_cls", "Y");
    url.searchParams.set("page_count", "100");
    url.searchParams.set("sort", "date");
    url.searchParams.set("sort_mth", "desc");

    dartListPromise = fetchJson(url).then((data) => {
      if (data.status && !["000", "013"].includes(data.status)) {
        throw new Error(`DART API ${data.status}: ${data.message || "unknown error"}`);
      }
      return { enabled: true, list: Array.isArray(data.list) ? data.list : [], note: null };
    }).catch((error) => ({ enabled: true, list: [], note: `DART 수집 실패: ${describeError(error)}` }));
  }
  return dartListPromise;
}

async function fetchDartRecentDisclosures(target) {
  const dart = await fetchDartList();
  if (!dart.enabled) return { enabled: false, items: [], note: dart.note };
  if (dart.note) return { enabled: true, items: [], note: dart.note };

  const items = dart.list
    .filter((item) => item.stock_code === target.code || item.corp_name === target.name || String(item.corp_name || "").includes(target.name))
    .slice(0, 5)
    .map((item) => ({
      date: item.rcept_dt,
      title: item.report_nm,
      corpName: item.corp_name,
      receiptNo: item.rcept_no,
      url: item.rcept_no ? `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${item.rcept_no}` : "https://dart.fss.or.kr/"
    }));
  return { enabled: true, items, note: items.length ? "최근 14일 DART 공시 확인" : "최근 14일 신규 DART 공시 없음" };
}

async function fetchNaverQuote(target) {
  const url = `https://polling.finance.naver.com/api/realtime/domestic/stock/${target.code}`;
  try {
    const data = await fetchJson(url);
    const item = data?.datas?.[0];
    if (!item) return { enabled: true, source: "Naver Finance realtime", note: "응답에 시세 항목 없음" };
    return {
      enabled: true,
      source: "Naver Finance realtime",
      price: item.closePrice || item.nv || null,
      changeRate: item.fluctuationsRatio || item.cr || null,
      marketCap: item.marketValue || item.mks || null,
      volume: item.accumulatedTradingVolume || item.aq || null,
      note: "비공식 시세 경로이므로 매수 전 증권사/거래소로 재확인"
    };
  } catch (error) {
    return { enabled: false, source: "Naver Finance realtime", note: `시세 수집 실패: ${describeError(error)}` };
  }
}

async function main() {
  const updatedAt = kstDate();
  const items = [];
  for (const target of targets) {
    const [dart, quote] = await Promise.all([
      fetchDartRecentDisclosures(target),
      fetchNaverQuote(target)
    ]);
    items.push({
      code: target.code,
      name: target.name,
      priority: target.priority,
      thesis: target.thesis,
      dailyChecks: target.dailyChecks,
      rules: target.rules || {},
      quote,
      dart,
      decision: {
        status: "관찰 유지",
        nextAction: target.rules?.buy || "새 공시·실적·수주·수출·현금흐름 변화가 있을 때 대시보드 판단 재검토",
        buyGuardrail: "초기 매수는 성장주 슬롯의 40~50% 이내, 논리 훼손 시 추가매수 금지"
      }
    });
  }

  const output = {
    updatedAt,
    sourcePolicy: "공식 공시와 회사 IR을 우선하고, 비공식 시세는 참고값으로만 표시",
    targets: items
  };
  fs.writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(`Wrote ${outPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
