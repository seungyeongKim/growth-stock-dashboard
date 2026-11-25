"""Extend fixed historical cohorts with as-filed EPS and cash flow."""

import argparse
import json
import os
import re
from collections import Counter
from pathlib import Path

from scan_market_growth import DART, fetch, number, parallel
from summarize_long_growth import read_disclosure


def amount(value):
    return number(str(value).replace('(', '-').replace(')', ''))


def first_amount(row, fields):
    for field in fields:
        value = amount(row.get(field))
        if value is not None:
            return value, field
    return None, None


def metric_rank(row, metric):
    identifier = row.get('account_id', '').lower()
    label = re.sub(r'\s+', '', row.get('account_nm', '')).lower()
    if metric == 'eps':
        if row.get('sj_div') not in ('IS', 'CIS'):
            return 0
        if any(text in identifier for text in ('continuing', 'discontinued', 'diluted')) or any(
                text in label for text in ('계속', '지속', '중단', '우선주')):
            return 0
        if identifier.endswith('_basicearningslosspershare'):
            return 3
        if any(text in label for text in ('기본주당', '주당기본', '기본및희석주당')):
            return 2
        return 0
    if row.get('sj_div') != 'CF':
        return 0
    if identifier.endswith('_cashflowsfromusedinoperatingactivities'):
        return 3
    if re.fullmatch(r'(?:[ivx]+[.]|[0-9]+[.])?영업활동(?:으로인한|으로부터의)?현금흐름', label):
        return 2
    return 0


def pick_amounts(rows, metric):
    options = []
    for row in rows:
        rank = metric_rank(row, metric)
        if not rank or row.get('currency') != 'KRW':
            continue
        if metric == 'eps':
            current, _ = first_amount(row, ('thstrm_add_amount',))
            previous, prior_field = first_amount(row, ('frmtrm_add_amount',))
        else:
            current, _ = first_amount(row, ('thstrm_amount',))
            previous, prior_field = first_amount(row, ('frmtrm_add_amount', 'frmtrm_q_amount', 'frmtrm_amount'))
        if current is not None:
            options.append((rank, current, previous, prior_field))
    if options:
        best = sorted((point for point in options if point[0] == max(p[0] for p in options)),
                      key=lambda p: p[2] is None)
        complete = [point for point in best if point[2] is not None] or best
        if len({point[1:3] for point in complete}) == 1:
            _, current, prior, field = complete[0]
            return {'current': current, 'prior': prior, 'priorField': field, 'source': 'OpenDART API'}
    return None


def collect_point(key, corp, scope, fiscal_year, actual):
    if not actual:
        return None
    receipt = actual['receipt']
    result = {'receipt': receipt, 'eps': None, 'operatingCash': None, 'status': None}
    try:
        data = json.loads(fetch(DART + '/fnlttSinglAcntAll.json', {
            'crtfc_key': key, 'corp_code': corp, 'bsns_year': fiscal_year,
            'reprt_code': '11014', 'fs_div': scope,
        }, attempts=2, timeout=10))
        status = str(data.get('status', 'unknown'))
        if status in ('010', '011', '012', '020', '901'):
            raise SystemExit(f'OpenDART authorization or request quota error ({status})')
        result['status'] = status
        if status == '000' and isinstance(data.get('list'), list):
            same_report = [row for row in data['list'] if row.get('rcept_no') == receipt]
            if same_report:
                for metric in ('eps', 'operatingCash'):
                    result[metric] = pick_amounts(same_report, metric)
            else:
                result['status'] = 'differentReceipt'
    except (RuntimeError, ValueError):
        result['status'] = 'apiUnavailable'
    if any(result[m] is None or result[m]['prior'] is None for m in ('eps', 'operatingCash')):
        public = read_disclosure(receipt, scope)
        for metric in ('eps', 'operatingCash'):
            if public[metric] and (result[metric] is None or result[metric]['prior'] is None):
                result[metric] = {**public[metric], 'source': 'DART filing viewer'}
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('cohort', type=Path)
    parser.add_argument('--shard', type=int, choices=range(4), required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    key = os.environ.get('DART_API_KEY') or os.environ.get('OPENDART_API_KEY')
    if not key:
        raise SystemExit('DART_API_KEY is required')
    cohort = json.loads(args.cohort.read_text(encoding='utf-8'))
    year, rows = cohort['year'], cohort['rows'][args.shard::4]

    def collect(row):
        base = collect_point(key, row['corp'], row['scope'], year, row['base'])
        later = (collect_point(key, row['corp'], row['scope'], year + 5, row['y5'])
                 if row['outcomes'].get('5') is not None else None)
        return {'corp': row['corp'], 'base': base, 'year5': later}

    print(f'{year}/{args.shard}: {len(rows)} issuers in fixed shard', flush=True)
    results = []
    for offset in range(0, len(rows), 16):
        results.extend(parallel(collect, rows[offset:offset + 16], workers=6))
        print(f'{year}/{args.shard}: {len(results)}/{len(rows)} issuers', flush=True)
    counts = Counter(f'{period}:{m}:{point[m]["source"] if point[m] else "missing"}'
                     for row in results for period in ('base', 'year5') if (point := row[period])
                     for m in ('eps', 'operatingCash'))
    print(dict(counts), flush=True)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps({'year': year, 'shard': args.shard, 'counts': dict(counts),
                                       'rows': results}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
