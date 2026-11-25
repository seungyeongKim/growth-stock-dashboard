"""Run point-in-time growth screens on historical Korean reporting cohorts."""

import argparse
import datetime as dt
import hashlib
import json
import os
import re
from collections import Counter
from pathlib import Path

from scan_market_growth import (
    CODE, CORP_CODE, DART, KST, RECEIPT, annual_prefilter, annual_statement, fetch,
    fetch_financials, financial_screen, growth, interim_statement, number, parallel,
    try_kind, verify_issuer,
)


TRACKS = ("verified", "profitLed", "salesImproving", "salesWatch", "comparison")
SAMPLE = {"Y": 225, "K": 425}


def q3_index(key, year, market, cutoff):
    def page(index):
        result = json.loads(fetch(DART + "/list.json", {
            "crtfc_key": key, "bgn_de": f"{year}1101", "end_de": cutoff.strftime("%Y%m%d"),
            "corp_cls": market, "pblntf_detail_ty": "A003", "page_count": 100, "page_no": index,
        }))
        if result.get("status") != "000" or not isinstance(result.get("list"), list):
            raise RuntimeError(f"Historical filing index {year}/{market}: {result.get('status')}")
        return result

    first = page(1)
    pages = int(first["total_page"])
    if not 1 <= pages <= 70:
        raise RuntimeError(f"Unexpected filing page count {year}/{market}: {pages}")
    filings = [first, *parallel(page, range(2, pages + 1))]
    companies = {}
    period = re.compile(rf"\(\s*{year}\.09\s*\)")
    for block in filings:
        for report in block["list"]:
            code, corp = report.get("stock_code") or "", report.get("corp_code") or ""
            name = report.get("corp_name") or ""
            receipt = report.get("rcept_no") or ""
            if CODE.fullmatch(code) and CORP_CODE.fullmatch(corp) and period.search(report.get("report_nm", "")):
                if not re.search(r"스팩|기업인수목적|리츠", name) and RECEIPT.fullmatch(receipt):
                    if receipt[:8] <= cutoff.strftime('%Y%m%d') and receipt > companies.get(corp, {}).get('receipt', ''):
                        companies[corp] = {"corp": corp, "code": code, "name": name, "market": market, "receipt": receipt}
    if len(companies) < (400 if market == "Y" else 700):
        raise RuntimeError(f"Historical universe unexpectedly small: {year}/{market} {len(companies)}")
    return companies


def pick_sample(companies, year, market):
    def priority(corp):
        return hashlib.sha256(f"growth-screen-v1|{year}|{market}|{corp}".encode()).digest()
    return [companies[corp] for corp in sorted(companies, key=priority)[:SAMPLE[market]]]


def public_by(records, cutoff):
    end = cutoff.strftime("%Y%m%d")
    return {(scope, receipt): report for (scope, receipt), report in records.items() if receipt[:8] <= end}


def comparable_actuals(records, year, scope, cutoff):
    record = interim_statement(public_by(records, cutoff), scope, "11014")
    if record is None:
        return None
    receipt = record["receipt"]
    accounts = records[scope, receipt]
    end = re.compile(rf"{year}[./-]\s*0?9[./-]\s*30(?!\d)")
    if not end.search(accounts["sales"].get("thstrm_dt", "")):
        return None
    return {
        "receipt": receipt,
        "sales": number(accounts["sales"].get("thstrm_add_amount")),
        "op": number(accounts["operating"].get("thstrm_add_amount")),
        "margin": record["values"][1], "netMargin": record["values"][2],
    }


def outcome(base, future, years):
    if not future:
        return None
    sales = growth(future["sales"], base["sales"])
    op = growth(future["op"], base["op"])
    hurdle = ((1.1 ** years) - 1) * 100 - 1e-8
    turnaround = base["op"] <= 0 < future["op"]
    return {
        "receipt": future["receipt"], "salesGrowth": sales, "operatingGrowth": op,
        "margin": future["margin"], "marginChange": future["margin"] - base["margin"],
        "turnaround": turnaround,
        "bothGrow": sales is not None and sales >= hurdle and (turnaround or (op is not None and op >= hurdle)),
        "marginImproved": future["margin"] - base["margin"] >= 2 - 1e-8,
        "marginAtLeast10": future["margin"] >= 10,
    }


def collect_cohort(year, key):
    cutoff = dt.date(year, 11, 20)
    today = dt.datetime.now(KST).date()
    index = parallel(lambda market: q3_index(key, year, market, cutoff), tuple(SAMPLE), workers=2)
    issuers = [company for market, rows in zip(SAMPLE, index) for company in pick_sample(rows, year, market)]
    print(f"{year}: {len(issuers)} of {sum(map(len, index))} listed issuers selected", flush=True)
    codes = [issuer["corp"] for issuer in issuers]
    annuals = fetch_financials(key, codes, year - 1, "11011")
    print(f"{year}: {len(annuals)} annual records", flush=True)
    interim = fetch_financials(key, codes, year, "11014")
    print(f"{year}: {len(interim)} Q3 records", flush=True)
    if min(len(annuals), len(interim)) < len(issuers) * 0.6:
        raise RuntimeError(f"{year}: insufficient sample coverage")
    counts = Counter()
    candidates = []
    for issuer in issuers:
        code = issuer["code"]
        raw_annual = annuals.get(code, {})
        annual = public_by(raw_annual, cutoff)
        raw_recent = interim.get(code, {})
        recent = public_by(raw_recent, cutoff)
        if (raw_annual and not annual) or (raw_recent and not recent):
            counts["asOfRevisionExcluded"] += 1
            continue
        scope = "CFS" if any(basis == "CFS" for basis, _ in annual) else "OFS"
        yearly = annual_statement(annual, scope)
        base = comparable_actuals(recent, year, scope, cutoff)
        if not yearly or not base:
            counts["baselineMissing"] += 1
            continue
        _, facts = financial_screen(annual, recent, "11014")
        recent_statement = interim_statement(recent, scope, "11014")
        candidates.append({
            **issuer, "track": facts["track"] if facts else "comparison",
            "scope": scope, "annualReceipt": yearly["receipt"], "baseline": base,
            "baselineGrowth": recent_statement["values"][0],
        })

    kind = try_kind()
    current_kind = {code: row for group in (kind or {}).values() for code, row in group.items()}

    def eligible_industry(row):
        classification = current_kind.get(row["code"])
        if classification and classification["name"].replace(" ", "") == row["name"].replace(" ", ""):
            return not classification["excluded"]
        return verify_issuer(row["corp"], key)

    fiscal_and_industry = parallel(eligible_industry, candidates, workers=8)
    counts["industryOrCalendarExcluded"] = fiscal_and_industry.count(False)
    counts["industryOrCalendarMissing"] = fiscal_and_industry.count(None)
    candidates = [row for row, ok in zip(candidates, fiscal_and_industry) if ok]
    print(f"{year}: {len(candidates)} usable baseline observations", flush=True)
    if len(candidates) < len(issuers) * 0.45:
        raise RuntimeError(f"{year}: usable baseline coverage below threshold")
    for years in (1, 2):
        future_cutoff = dt.date(year + years, 11, 20)
        if future_cutoff > today:
            continue
        future = fetch_financials(key, [row["corp"] for row in candidates], year + years, "11014")
        print(f"{year}: {len(future)} future filings for +{years} year(s)", flush=True)
        for row in candidates:
            records = future.get(row["code"], {})
            next_actuals = comparable_actuals(records, year + years, row["scope"], future_cutoff)
            row[f"y{years}"] = outcome(row["baseline"], next_actuals, years)

    return {
        "cohortYear": year, "cutoff": cutoff.isoformat(), "sampled": len(issuers),
        "markets": dict(zip(SAMPLE, map(len, index))), "counts": dict(counts),
        "rows": candidates,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--year", type=int, required=True, choices=(2022, 2023, 2024, 2025))
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    key = os.environ.get("DART_API_KEY") or os.environ.get("OPENDART_API_KEY")
    if not key:
        raise SystemExit("DART_API_KEY is required")
    result = collect_cohort(args.year, key)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
