"""Find new growth candidates independently of the researched watchlist."""

import concurrent.futures
import argparse
import datetime as dt
import io
import json
import math
import os
from pathlib import Path
import re
import time
from collections import Counter, defaultdict
from html.parser import HTMLParser
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET
from zipfile import ZipFile


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "data" / "market-growth-scan.json"
KST = dt.timezone(dt.timedelta(hours=9))
MARKETS = {"KOSPI": "stockMkt", "KOSDAQ": "kosdaqMkt"}
DART = "https://opendart.fss.or.kr/api"
KIND = "https://kind.krx.co.kr/corpgeneral/corpList.do"
NAVER = "https://m.stock.naver.com/api/stocks/marketValue"
BATCH_SIZE = 80
PAGE_SIZE = 100
RESULT_LIMIT = 20
MIN_GROWTH = 10
MIN_MARGIN = 10
MAX_MARGIN_DROP = -5
CODE = re.compile(r"[0-9A-Z]{6}")
RECEIPT = re.compile(r"\d{14}")


def fetch(url, params=None):
    request = Request(url + ("?" + urlencode(params) if params else ""),
                      headers={"User-Agent": "growth-stock-dashboard/1.0"})
    for attempt in range(3):
        try:
            with urlopen(request, timeout=25) as response:
                return response.read()
        except HTTPError as error:
            if error.code not in (429, 500, 502, 503, 504) or attempt == 2:
                raise RuntimeError(f"{urlsplit(url).path}: HTTP {error.code}") from None
        except (URLError, TimeoutError):
            if attempt == 2:
                raise RuntimeError(f"{urlsplit(url).path}: connection failed") from None
        time.sleep(1 + attempt)


def parallel(fn, args, workers=4):
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        jobs = [pool.submit(fn, arg) for arg in args]
        done, pending = concurrent.futures.wait(jobs, return_when=concurrent.futures.FIRST_EXCEPTION)
        for job in done:
            if job.exception() is not None:
                for task in pending:
                    task.cancel()
                job.result()
        return [job.result() for job in jobs]


class ListingTable(HTMLParser):
    def __init__(self):
        super().__init__()
        self.rows, self.row, self.cell = [], None, None

    def handle_starttag(self, tag, attrs):
        if tag == "tr":
            self.row = []
        elif tag == "td" and self.row is not None:
            self.cell = []

    def handle_data(self, text):
        if self.cell is not None:
            self.cell.append(text)

    def handle_endtag(self, tag):
        if tag == "td" and self.cell is not None:
            self.row.append("".join(self.cell).strip())
            self.cell = None
        elif tag == "tr" and self.row is not None:
            self.rows.append(self.row)
            self.row = None


def listings(market):
    table = ListingTable()
    table.feed(fetch(KIND, {"method": "download", "marketType": MARKETS[market]}).decode("cp949"))
    rows = {}
    for row in table.rows:
        if len(row) < 7 or not CODE.fullmatch(row[2]):
            continue
        name, _, code, industry, _, _, fiscal_month = row[:7]
        excluded = "결산월 다름" if fiscal_month.replace(" ", "") != "12월" else (
            "금융·지주·스팩 등" if re.search(r"스팩|기업인수목적|리츠", name) or
            re.search(r"은행|보험|금융|신탁업", industry) else None)
        rows[code] = {"code": code, "name": name, "industry": industry, "market": market, "excluded": excluded}
    if len(rows) < (650 if market == "KOSPI" else 1400):
        raise RuntimeError(f"KIND listing coverage unexpectedly low: {market} {len(rows)}")
    return rows


def dart_codes(key):
    raw = fetch(DART + "/corpCode.xml", {"crtfc_key": key})
    with ZipFile(io.BytesIO(raw)) as archive:
        root = ET.fromstring(archive.read("CORPCODE.xml"))
    return {item.findtext("stock_code", "").strip(): item.findtext("corp_code", "").strip()
            for item in root.findall("list") if CODE.fullmatch(item.findtext("stock_code", "").strip())}


def period_plan(day):
    md = day.month * 100 + day.day
    if md >= 1116:
        return day.year - 1, (day.year, "11014", "Q3")
    if md >= 816:
        return day.year - 1, (day.year, "11012", "H1")
    if md >= 516:
        return day.year - 1, (day.year, "11013", "Q1")
    if md >= 401:
        return day.year - 1, None
    return day.year - 2, (day.year - 1, "11014", "Q3")


def number(value):
    try:
        parsed = float(str(value).replace(",", "").strip())
        return parsed if math.isfinite(parsed) else None
    except ValueError:
        return None


ACCOUNTS = {
    "매출액": "sales", "수익(매출액)": "sales", "영업수익": "sales",
    "영업이익": "operating", "영업이익(손실)": "operating",
    "당기순이익": "net", "당기순이익(손실)": "net", "분기순이익": "net", "반기순이익": "net",
    "부채총계": "debt", "자본총계": "equity",
}
FLOW = ("sales", "operating", "net")


def accounts_by_company(rows):
    by_company = defaultdict(dict)
    for row in rows:
        label = ACCOUNTS.get(str(row.get("account_nm", "")).replace(" ", ""))
        code, scope, receipt = (row.get(field, "") for field in ("stock_code", "fs_div", "rcept_no"))
        if (not label or not CODE.fullmatch(code) or scope not in ("CFS", "OFS")
                or row.get("currency") != "KRW" or not RECEIPT.fullmatch(receipt)
                or row.get("sj_div") != ("IS" if label in FLOW else "BS")):
            continue
        record = by_company[code].setdefault((scope, receipt), {})
        record.setdefault(label, row)
    return by_company


def fetch_financials(key, codes, year, report):
    batches = [codes[i:i + BATCH_SIZE] for i in range(0, len(codes), BATCH_SIZE)]

    def batch(corp_codes):
        data = json.loads(fetch(DART + "/fnlttMultiAcnt.json", {
            "crtfc_key": key, "corp_code": ",".join(corp_codes), "bsns_year": year, "reprt_code": report,
        }))
        if data.get("status") == "013":
            return []
        if data.get("status") != "000" or not isinstance(data.get("list"), list):
            raise RuntimeError(f"OpenDART financial batch failed: {data.get('status')}")
        return data["list"]

    return accounts_by_company(row for rows in parallel(batch, batches, workers=8) for row in rows)


def divide(numerator, denominator):
    return numerator / denominator * 100 if numerator is not None and denominator is not None and denominator > 0 else None


def growth(current, prior):
    level = divide(current, prior)
    return level - 100 if level is not None else None


def annual_statement(records, scope):
    for (basis, receipt), a in sorted(records.items(), reverse=True):
        if basis != scope or not set(FLOW).issubset(a):
            continue
        sales, op, net = (number(a[account].get("thstrm_amount")) for account in FLOW)
        prior = number(a["sales"].get("frmtrm_amount"))
        older = number(a["sales"].get("bfefrmtrm_amount"))
        values = (growth(sales, prior), growth(prior, older), divide(op, sales), divide(net, sales))
        if all(value is not None for value in values):
            return {"receipt": receipt, "net": net, "values": values,
                    "priorOpMargin": divide(number(a["operating"].get("frmtrm_amount")), prior),
                    "debtRatio": divide(number(a.get("debt", {}).get("thstrm_amount")), number(a.get("equity", {}).get("thstrm_amount")))}
    return None


def interim_statement(records, scope, report):
    for (basis, receipt), a in sorted(records.items(), reverse=True):
        if basis != scope or not set(FLOW).issubset(a):
            continue
        fields = ("thstrm_amount", "frmtrm_amount") if report == "11013" else ("thstrm_add_amount", "frmtrm_add_amount")
        sales, op, net = (number(a[account].get(fields[0])) for account in FLOW)
        prior = number(a["sales"].get(fields[1]))
        prior_op = number(a["operating"].get(fields[1]))
        op_margin, prior_margin = divide(op, sales), divide(prior_op, prior)
        values = (growth(sales, prior), op_margin, divide(net, sales), prior_margin)
        if all(value is not None for value in values):
            return {"receipt": receipt, "values": values,
                    "debtRatio": divide(number(a.get("debt", {}).get("thstrm_amount")), number(a.get("equity", {}).get("thstrm_amount")))}
    return None


def financial_screen(annual, interim, report):
    # Use consolidated statements whenever the relevant rows exist. Do not
    # rescue a failing consolidated company with a better separate statement.
    scope = "CFS" if any(basis == "CFS" for basis, _ in annual) else "OFS"
    yearly = annual_statement(annual, scope)
    if not yearly:
        return "annualMissing", None
    sales_growth, preceding_growth, op_margin, net_margin = yearly["values"]
    if not (sales_growth >= MIN_GROWTH and preceding_growth > 0 and min(op_margin, net_margin) >= MIN_MARGIN):
        return "annualFail", None
    current = interim_statement(interim, scope, report) if report else {
        "receipt": yearly["receipt"], "values": (sales_growth, op_margin, net_margin, yearly["priorOpMargin"]),
        "debtRatio": yearly["debtRatio"],
    }
    if not current or current["values"][-1] is None:
        return "recentMissing", None
    recent_growth, recent_op, recent_net, prior_margin = current["values"]
    if not (recent_growth >= MIN_GROWTH and min(recent_op, recent_net) >= MIN_MARGIN and recent_op - prior_margin > MAX_MARGIN_DROP):
        return "recentFail", None
    return "financialPass", {
        "scope": scope, "annualReceipt": yearly["receipt"], "recentReceipt": current["receipt"],
        "annualGrowth": sales_growth, "priorAnnualGrowth": preceding_growth,
        "annualOperatingMargin": op_margin, "annualNetMargin": net_margin,
        "recentGrowth": recent_growth, "recentOperatingMargin": recent_op, "recentNetMargin": recent_net,
        "marginDelta": recent_op - prior_margin, "debtRatio": current["debtRatio"],
        "annualTotalNet": yearly["net"],
    }


def market_prices(market, expected_codes):
    def page(i):
        result = json.loads(fetch(f"{NAVER}/{market}", {"page": i, "pageSize": PAGE_SIZE}))
        if result.get("stockListCategoryType") != market or result.get("page") != i or not isinstance(result.get("stocks"), list):
            raise RuntimeError(f"Npay market page shape changed: {market} {i}")
        return result

    first = page(1)
    total = first.get("totalCount")
    if not isinstance(total, int) or not 0 < total < 8000:
        raise RuntimeError(f"Npay market count invalid: {market}")
    pages = [first, *parallel(page, range(2, math.ceil(total / PAGE_SIZE) + 1))]
    quotes = {row.get("itemCode"): row for block in pages for row in block["stocks"] if row.get("itemCode") in expected_codes}
    if len(quotes) < len(expected_codes) * 0.85:
        raise RuntimeError(f"Npay coverage unexpectedly low: {market} {len(quotes)}/{len(expected_codes)}")
    return quotes


def price_candidate(facts, quote, now):
    if not quote or quote.get("tradableStatus") != "tradable":
        return None
    price, market_cap, volume = (number(quote.get(field)) for field in ("closePriceRaw", "marketValueRaw", "accumulatedTradingVolumeRaw"))
    traded = quote.get("localTradedAt")
    try:
        age = now.date() - dt.datetime.fromisoformat(traded).astimezone(KST).date()
    except (TypeError, ValueError):
        return None
    if not (price and price > 0 and market_cap and market_cap > 0 and volume and volume > 0 and 0 <= age.days <= 7):
        return None
    per = market_cap / facts["annualTotalNet"]

    def factor(value, cap):
        return max(0, min(value / cap, 1))

    score = 30 * factor(facts["recentGrowth"], 40) + 25 * factor(facts["annualGrowth"], 40) + (
        20 * factor(facts["recentOperatingMargin"], 30) + 10 * factor(facts["recentNetMargin"], 25)) + 15 * min(15 / per, 1)
    return {"price": int(price), "marketCap": int(market_cap), "priceTime": traded,
            "annualPer": round(per, 1), "score": round(score, 2)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--probe", action="store_true", help="Verify upstreams without publishing or scanning the full market")
    args = parser.parse_args()
    key = os.environ.get("DART_API_KEY") or os.environ.get("OPENDART_API_KEY")
    if not key:
        raise SystemExit("DART_API_KEY is required; prior scan is unchanged.")
    now = dt.datetime.now(KST)
    annual_year, interim = period_plan(now.date())
    print("Loading KIND market listings", flush=True)
    markets = dict(zip(MARKETS, parallel(listings, list(MARKETS), workers=2)))
    listings_by_code = {code: item for rows in markets.values() for code, item in rows.items()}
    print(f"Loaded {len(listings_by_code)} listed issuers. Loading OpenDART identifiers", flush=True)
    mappings = dart_codes(key)
    if args.probe:
        rows = fetch_financials(key, [mappings["000660"], mappings["005930"]], annual_year, "11011")
        quotes = json.loads(fetch(f"{NAVER}/KOSPI", {"page": 1, "pageSize": PAGE_SIZE}))
        if len(rows) < 2 or not quotes.get("stocks"):
            raise RuntimeError("Upstream sample has insufficient data")
        print(f"Upstream probe verified filings for {len(rows)} issuers and {len(quotes['stocks'])} quotes", flush=True)
        return
    watchlist = json.loads((ROOT / "data/growth-watchlist-20.json").read_text(encoding="utf-8"))
    known = {row["code"] for row in watchlist["targets"]}
    counts = Counter(item["excluded"] for item in listings_by_code.values() if item["excluded"])
    counts["dartMissing"] = sum(code not in mappings for code, row in listings_by_code.items() if not row["excluded"])
    eligible = {code: item for code, item in listings_by_code.items() if not item["excluded"] and code in mappings}
    print(f"Collecting {annual_year} audited filings for {len(eligible)} issuers", flush=True)
    annuals = fetch_financials(key, [mappings[code] for code in eligible], annual_year, "11011")
    if len(annuals.keys() & eligible.keys()) < len(eligible) * 0.65:
        raise RuntimeError(f"OpenDART annual coverage unexpectedly low: {len(annuals)}/{len(eligible)}")
    annual_pass = [code for code in eligible if financial_screen(annuals.get(code, {}), {}, None)[0]
                   not in ("annualFail", "annualMissing")]
    print(f"Annual pass: {len(annual_pass)}. Collecting interim filings", flush=True)
    quarterly = fetch_financials(key, [mappings[code] for code in annual_pass], *interim[:2]) if interim and annual_pass else {}
    if interim and annual_pass and len(quarterly.keys() & set(annual_pass)) < len(annual_pass) * 0.6:
        raise RuntimeError("OpenDART interim coverage unexpectedly low")
    print(f"Loaded {len(quarterly)} interim records. Collecting Npay market prices", flush=True)
    quotes_by_market = parallel(lambda market: market_prices(market, set(markets[market])), list(markets), workers=2)
    quotes = {code: quote for market in quotes_by_market for code, quote in market.items()}
    qualified = []
    for code, issuer in eligible.items():
        status, facts = financial_screen(annuals.get(code, {}), quarterly.get(code, {}), interim[1] if interim else None)
        counts[status] += 1
        if facts is None:
            continue
        quote = price_candidate(facts, quotes.get(code), now)
        if quote is None:
            counts["quoteMissing"] += 1
            continue
        rounded = {field: round(value, 2) if isinstance(value, float) else value for field, value in facts.items()}
        qualified.append({**{k: v for k, v in issuer.items() if k != "excluded"}, **rounded, **quote, "inWatchlist": code in known})
    qualified.sort(key=lambda row: (-row["score"], row["annualPer"], -row["marketCap"], row["code"]))
    previous = json.loads(OUTPUT.read_text(encoding="utf-8")) if OUTPUT.exists() else {}
    former = {row["code"]: row["name"] for row in previous.get("items", [])}
    items = [{"rank": i, **row, "newInTop": row["code"] not in former} for i, row in enumerate(qualified[:RESULT_LIMIT], 1)]
    current_codes = {row["code"] for row in items}
    payload = {
        "updatedAt": now.isoformat(timespec="seconds"),
        "markets": {market: len(rows) for market, rows in markets.items()},
        "annualPeriod": f"{annual_year} FY", "recentPeriod": f"{interim[0]} {interim[2]} 누적" if interim else f"{annual_year} FY",
        "eligibleCount": len(eligible), "counts": dict(counts), "pricedPass": len(qualified),
        "outsideWatchlist": sum(not row["inWatchlist"] for row in items),
        "previousRun": previous.get("updatedAt"), "removed": [name for code, name in former.items() if code not in current_codes],
        "items": items,
    }
    OUTPUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Listings: {sum(payload['markets'].values())}; DART batches targeted: {len(eligible)} companies; qualified: {len(qualified)}; selected: {len(items)}; outside watchlist: {payload['outsideWatchlist']}")


if __name__ == "__main__":
    main()
