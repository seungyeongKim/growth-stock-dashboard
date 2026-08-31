const fs = require("fs");
const path = require("path");

const root = process.cwd();
const sourcePath = path.join(root, "data", "growth-watchlist-20.json");
const outPath = path.join(root, "data", "weekly-growth-watchlist.json");
const watchlist = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
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

async function fetchQuote(target) {
  const url = `https://polling.finance.naver.com/api/realtime/domestic/stock/${target.code}`;
  try {
    const data = await fetchJson(url);
    const item = data?.datas?.[0];
    if (!item) return { ok: false, note: "시세 응답 없음" };
    return {
      ok: true,
      source: "Naver Finance realtime",
      price: item.closePrice || item.nv || null,
      changeRate: item.fluctuationsRatio || item.cr || null,
      volume: item.accumulatedTradingVolume || item.aq || null,
      note: "비공식 참고값"
    };
  } catch (error) {
    return { ok: false, note: `시세 수집 실패: ${describeError(error)}` };
  }
}

let dartListPromise;
async function fetchDartList() {
  if (!dartKey) return { ok: false, list: [], note: "DART_API_KEY 미설정" };
  if (!dartListPromise) {
    const url = new URL("https://opendart.fss.or.kr/api/list.json");
    url.searchParams.set("crtfc_key", dartKey);
    url.searchParams.set("bgn_de", ymd(daysAgo(7)));
    url.searchParams.set("end_de", ymd(new Date()));
    url.searchParams.set("corp_cls", "Y");
    url.searchParams.set("page_count", "100");
    url.searchParams.set("sort", "date");
    url.searchParams.set("sort_mth", "desc");

    dartListPromise = fetchJson(url).then((data) => {
      if (data.status && !["000", "013"].includes(data.status)) {
        throw new Error(`DART API ${data.status}: ${data.message || "unknown error"}`);
      }
      return { ok: true, list: Array.isArray(data.list) ? data.list : [], note: null };
    }).catch((error) => ({ ok: false, list: [], note: `DART 수집 실패: ${describeError(error)}` }));
  }
  return dartListPromise;
}

async function fetchDart(target) {
  const dart = await fetchDartList();
  if (!dart.ok) return { ok: false, items: [], note: dart.note };
  const items = dart.list
    .filter((item) => item.stock_code === target.code || item.corp_name === target.name || String(item.corp_name || "").includes(target.name))
    .slice(0, 3)
    .map((item) => ({
      date: item.rcept_dt,
      title: item.report_nm,
      receiptNo: item.rcept_no,
      url: item.rcept_no ? `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${item.rcept_no}` : "https://dart.fss.or.kr/"
    }));
  return { ok: true, items, note: items.length ? "최근 7일 신규 공시 확인" : "최근 7일 신규 공시 없음" };
}

function classify(target, quote, dart) {
  if (target.group === "deep") return "심층 추적 유지";
  if (dart.items && dart.items.length) return "승격 검토";
  if (target.group === "benchmark") return "기준점 관찰";
  if (target.group === "reserve") return "보류 관찰";
  return "관찰 유지";
}

async function main() {
  const updatedAt = kstDate();
  const items = [];
  for (const target of watchlist.targets) {
    const [quote, dart] = await Promise.all([fetchQuote(target), fetchDart(target)]);
    items.push({
      ...target,
      quote,
      dart,
      reviewStatus: classify(target, quote, dart),
      reviewQuestion: target.group === "deep"
        ? "심층 추적 5종목에 계속 남길 만큼 논리가 강화됐나?"
        : "심층 추적 5종목으로 승격할 만한 새 근거가 생겼나?"
    });
  }
  const output = {
    updatedAt,
    cadence: watchlist.reviewCadence,
    rule: watchlist.reviewRule,
    sourcePolicy: "20개 관찰군은 자동 수집값만으로 매수 판단하지 않고, 새 공시와 가격 변화를 승격/강등 검토 신호로만 사용한다.",
    items
  };
  fs.writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(`Wrote ${outPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
