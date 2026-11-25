"""Collect historical signals without ranking securities or using current constituents."""

import argparse
import datetime as dt
import json
import os
from collections import Counter
from pathlib import Path

from backtest_market_growth import SAMPLE, comparable_actuals, pick_sample, public_by, q3_index
from scan_market_growth import (DART, annual_statement, fetch, fetch_financials, financial_screen,
                                growth, interim_statement, number, parallel, try_kind)


def cagr(start, end, years):
    if start is None or end is None or start <= 0 or end < 0:
        return None
    return 100 * ((end / start) ** (1 / years) - 1)


def long_outcome(base, middle, end, years):
    if not middle or not end or base['op'] <= 0:
        return None
    sales = cagr(base['sales'], end['sales'], years)
    op = cagr(base['op'], max(0, end['op']), years)
    if sales is None or op is None:
        return None
    return {"salesCagr": sales, "opCagr": op, "endMargin": end['margin'],
            "success": min(sales, op) >= 10 - 1e-8 and
            middle['sales'] > base['sales'] and middle['op'] > base['op']}


def classify(row, key, kind):
    info = kind.get(row['code'])
    if info and info['name'].replace(' ', '') == row['name'].replace(' ', ''):
        return not info['excluded'], info['industry'], 'KIND'
    try:
        data = json.loads(fetch(DART + '/company.json', {'crtfc_key': key, 'corp_code': row['corp']}))
    except RuntimeError:
        return None, None, None
    month, industry = data.get('acc_mt') or '', data.get('induty_code') or ''
    if data.get('status') != '000' or not month.isdigit() or not industry.isdigit():
        return None, None, None
    return month == '12' and not industry.startswith(('64', '65', '66')), industry[:2], 'DART'


def collect(year, key):
    cutoff = dt.date(year, 11, 20)
    boards = parallel(lambda market: q3_index(key, year, market, cutoff), tuple(SAMPLE), workers=2)
    sampled = [row for market, board in zip(SAMPLE, boards) for row in pick_sample(board, year, market)]
    print(f'{year}: sampled {len(sampled)} of {sum(map(len, boards))} issuers', flush=True)
    issuers = [row['corp'] for row in sampled]
    annual = fetch_financials(key, issuers, year - 1, '11011', by_corp=True)
    current = fetch_financials(key, issuers, year, '11014', by_corp=True)
    print(f'{year}: {len(annual)} annual; {len(current)} Q3', flush=True)
    counts = Counter()
    valid = []
    for row in sampled:
        a = annual.get(row['corp'], {})
        q = current.get(row['corp'], {})
        available_a, available_q = public_by(a, cutoff), public_by(q, cutoff)
        if (a and not available_a) or (q and not available_q):
            counts['onlyLaterRevision'] += 1
            continue
        scope = 'CFS' if any(s == 'CFS' for s, _ in available_a) else 'OFS'
        yearly = annual_statement(available_a, scope)
        recent = interim_statement(available_q, scope, '11014')
        base = comparable_actuals(available_q, year, scope, cutoff)
        if not yearly or not recent or not base:
            counts['noComparableBaseline'] += 1
            continue
        if base['op'] <= 0:
            counts['initialLoss'] += 1
            continue
        _, facts = financial_screen(available_a, available_q, '11014')
        yoy, opm, netm, prior_margin = recent['values']
        annual_yoy, prior_yoy, annual_opm, annual_netm = yearly['values']
        net = available_q[scope, recent['receipt']]['net']
        valid.append({**row, 'scope': scope, 'base': base, 'annualReceipt': yearly['receipt'],
                      'track': facts['track'] if facts else 'comparison', 'signals': {
                          'annualGrowth': annual_yoy, 'precedingGrowth': prior_yoy,
                          'annualOpMargin': annual_opm, 'annualNetMargin': annual_netm,
                          'recentGrowth': yoy, 'recentOpMargin': opm, 'recentNetMargin': netm,
                          'recentOpGrowth': recent['opGrowth'], 'annualOpGrowth': yearly['opGrowth'],
                          'marginDelta': opm - prior_margin, 'debtRatio': recent['debtRatio'],
                          'netGrowth': growth(number(net['thstrm_add_amount']), number(net.get('frmtrm_add_amount'))),
                      }})

    kind = {code: details for rows in (try_kind() or {}).values() for code, details in rows.items()}
    included = []
    for row, (eligible, industry, source) in zip(valid, parallel(lambda r: classify(r, key, kind), valid, workers=8)):
        if eligible is False:
            counts['financialOrFiscalExcluded'] += 1
            continue
        if eligible is None:
            counts['industryUnconfirmedIncluded'] += 1
        included.append({**row, 'industry': industry, 'industrySource': source})
    if len(included) < len(sampled) * .35:
        raise RuntimeError(f'{year}: insufficient comparable baseline: {len(included)}')
    print(f'{year}: {len(included)} comparable, initially profitable observations', flush=True)

    offsets = (1, 3, 5, 10) if year == 2016 else (1, 3, 5)
    for offset in offsets:
        endpoint = year + offset
        records = fetch_financials(key, [row['corp'] for row in included], endpoint, '11014', by_corp=True)
        outcome_cutoff = dt.date(endpoint, 11, 20)
        available = 0
        for row in included:
            row[f'y{offset}'] = comparable_actuals(records.get(row['corp'], {}), endpoint, row['scope'], outcome_cutoff)
            available += row[f'y{offset}'] is not None
        print(f'{year}: {available}/{len(included)} usable at +{offset}y', flush=True)
    for row in included:
        row['outcomes'] = {str(offset): long_outcome(row['base'], row[f'y{middle}'], row[f'y{offset}'], offset)
                           for middle, offset in ((1, 3), (3, 5), (5, 10)) if offset in offsets}
    return {'year': year, 'cutoff': cutoff.isoformat(), 'sampled': len(sampled), 'counts': dict(counts), 'rows': included}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--year', type=int, choices=(2016, 2019, 2021), required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    key = os.environ.get('DART_API_KEY') or os.environ.get('OPENDART_API_KEY')
    if not key:
        raise SystemExit('DART_API_KEY is required')
    result = collect(args.year, key)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
