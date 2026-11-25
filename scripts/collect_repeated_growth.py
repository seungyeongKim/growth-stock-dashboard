"""Collect the already-public previous Q3 filing for each frozen issuer."""

import argparse
import datetime as dt
import json
import os
from collections import Counter
from pathlib import Path

from backtest_market_growth import SAMPLE, q3_index
from collect_growth_quality import collect_point
from scan_market_growth import parallel


SHARDS = 6


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('cohort', type=Path)
    parser.add_argument('--shard', type=int, choices=range(SHARDS), required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    key = os.environ.get('DART_API_KEY') or os.environ.get('OPENDART_API_KEY')
    if not key:
        raise SystemExit('DART_API_KEY is required')
    data = json.loads(args.cohort.read_text(encoding='utf-8'))
    year, rows = data['year'], data['rows'][args.shard::SHARDS]
    prior = year - 1
    cutoff = dt.date(prior, 11, 20)
    boards = parallel(lambda market: q3_index(key, prior, market, cutoff), tuple(SAMPLE), workers=2)
    previous = {}
    for board in boards:
        for corp, entry in board.items():
            if entry['receipt'] > previous.get(corp, {}).get('receipt', ''):
                previous[corp] = entry

    def get(row):
        record = previous.get(row['corp'])
        point = collect_point(key, row['corp'], row['scope'], prior, record)
        return {'corp': row['corp'], 'scope': row['scope'], 'previous': point}

    print(f'{year}/{args.shard}: {len(rows)} fixed observations, {sum(r["corp"] in previous for r in rows)} prior receipts', flush=True)
    result = []
    for offset in range(0, len(rows), 12):
        result.extend(parallel(get, rows[offset:offset + 12], workers=4))
        print(f'{year}/{args.shard}: {len(result)}/{len(rows)}', flush=True)
    counts = Counter((row['previous'] or {}).get('status', 'noPriorReceipt') for row in result)
    print(dict(counts), flush=True)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps({'year': year, 'shard': args.shard, 'priorCutoff': cutoff.isoformat(),
                                       'counts': dict(counts), 'rows': result}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
