"""Fetch one extra like-for-like filing checkpoint for frozen growth cohorts."""

import argparse
import datetime as dt
import json
import os
from pathlib import Path

from backtest_market_growth import comparable_actuals
from scan_market_growth import fetch_financials


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('cohort', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    key = os.environ.get('DART_API_KEY') or os.environ.get('OPENDART_API_KEY')
    if not key:
        raise SystemExit('Missing OpenDART key')
    data = json.loads(args.cohort.read_text(encoding='utf-8'))
    year, rows = data['year'], data['rows']
    endpoint = year + 2
    cutoff = dt.date(endpoint, 11, 20)
    account = fetch_financials(key, [row['corp'] for row in rows], endpoint, '11014', by_corp=True)
    observed = {row['corp']: comparable_actuals(account.get(row['corp'], {}), endpoint, row['scope'], cutoff)
                for row in rows}
    measured = sum(value is not None for value in observed.values())
    if measured < len(rows) * .6:
        raise RuntimeError(f'{year}: second-year filing coverage too low ({measured}/{len(rows)})')
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps({'year': year, 'cutoff': cutoff.isoformat(), 'rows': observed}, indent=2) + '\n', encoding='utf-8')
    print(f'{year}: {measured}/{len(rows)} comparable second-year reports', flush=True)


if __name__ == '__main__':
    main()
