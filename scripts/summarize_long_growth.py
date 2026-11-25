"""Summarize an outcome-first study of reported Korean business growth."""

import argparse
import json
import math
import re
import statistics
from collections import defaultdict
from pathlib import Path

from backtest_market_growth import TRACKS
from scan_market_growth import ListingTable, fetch, number, parallel


DART_WEB = 'https://dart.fss.or.kr'
FEATURES = {
    'sales10': lambda s: s['recentGrowth'] >= 10,
    'opMargin10': lambda s: s['recentOpMargin'] >= 10,
    'dualMargin10': lambda s: min(s['recentOpMargin'], s['recentNetMargin']) >= 10,
    'pairedGrowth': lambda s: s['recentGrowth'] >= 10 and at_least(s['recentOpGrowth'], 10),
    'twoReportPairedGrowth': lambda s: min(s['recentGrowth'], s['annualGrowth']) >= 5 and
    at_least(s['recentOpGrowth'], 10) and at_least(s['annualOpGrowth'], 10) and s['marginDelta'] >= 0,
    'moderateSalesHighMargin': lambda s: 0 < s['recentGrowth'] < 10 and
    s['recentOpMargin'] >= 15 and at_least(s['recentOpGrowth'], 10),
    'highSalesThinMargin': lambda s: s['recentGrowth'] >= 20 and s['recentOpMargin'] < 10,
    'stableMargin': lambda s: s['marginDelta'] >= 0,
    'positiveNetAndOpGrowth': lambda s: at_least(s['netGrowth'], 10) and at_least(s['recentOpGrowth'], 10),
    'positiveTwoYearSales': lambda s: min(s['annualGrowth'], s['precedingGrowth']) > 0,
}


def at_least(value, minimum):
    return value is not None and value >= minimum


def fraction(num, denom):
    return round(100 * num / denom, 2) if denom else None


def metrics(rows, horizon, qualifies):
    selected = [row for row in rows if qualifies(row)]
    eligible = [r for r in rows if r['outcomes'].get(horizon) is not None]
    selected_measured = [r for r in selected if r['outcomes'].get(horizon) is not None]
    selected_success = sum(r['outcomes'][horizon]['success'] for r in selected_measured)
    success = sum(r['outcomes'][horizon]['success'] for r in eligible)
    not_selected_success = success - selected_success
    not_selected_measured = len(eligible) - len(selected_measured)
    return {
        'selected': len(selected), 'measured': len(selected_measured), 'successes': selected_success,
        'successPct': fraction(selected_success, len(selected_measured)),
        'capturePct': fraction(selected_success, success),
        'coveragePct': fraction(len(selected_measured), len(selected)),
        'notSelectedMeasured': not_selected_measured, 'notSelectedSuccesses': not_selected_success,
        'notSelectedSuccessPct': fraction(not_selected_success, not_selected_measured),
        'missingAllFailedPct': fraction(selected_success, len(selected)),
        'missingAllSucceededPct': fraction(selected_success + len(selected) - len(selected_measured), len(selected)),
    }


def summarize(rows, horizon):
    groups = {
        'all': lambda _: True,
        'existingAny': lambda r: r['track'] != 'comparison',
        **{track: (lambda row, track=track: row['track'] == track) for track in TRACKS},
        **{name: (lambda row, rule=rule: rule(row['signals'])) for name, rule in FEATURES.items()},
    }
    return {name: metrics(rows, horizon, rule) for name, rule in groups.items()}


def matched_screen(rows, rule):
    peers = defaultdict(list)
    selected = []
    for row in rows:
        result = row['outcomes'].get('5')
        if result is None or not row['industry']:
            continue
        key = (row['market'], row['industrySource'], row['industry'], row['scope'])
        if rule(row):
            selected.append((key, row))
        else:
            peers[key].append(row)
    actual, expected = [], []
    for key, row in selected:
        size = row['base']['sales']
        comparable = [r['outcomes']['5']['success'] for r in peers[key] if size / 2 <= r['base']['sales'] <= size * 2]
        if len(comparable) >= 3:
            actual.append(row['outcomes']['5']['success'])
            expected.append(statistics.mean(comparable))
    return {'matched': len(actual), 'selectedWithIndustry': len(selected),
            'selectedSuccessPct': fraction(sum(actual), len(actual)),
            'matchedPeerSuccessPct': fraction(sum(expected), len(expected))}


def at_threshold(rows, minimum):
    result = []
    for row in rows:
        point = row['outcomes'].get('5')
        if point is None:
            result.append(row)
            continue
        base, interim = row['base'], row['y3']
        success = (min(point['salesCagr'], point['opCagr']) >= minimum - 1e-8 and
                   interim['sales'] > base['sales'] and interim['op'] > base['op'])
        result.append({**row, 'outcomes': {**row['outcomes'], '5': {**point, 'success': success}}})
    return result


def select_pairs(rows):
    complete = [row for row in rows if row['outcomes'].get('5') is not None and row['industry']]
    keys = ('recentGrowth', 'recentOpMargin', 'recentNetMargin')

    def distance(a, b):
        sa, sb = a['base']['sales'], b['base']['sales']
        size = abs(math.log(sa / sb))
        if (size > math.log(2) or a['market'] != b['market'] or a['industry'] != b['industry'] or
                a['industrySource'] != b['industrySource'] or a['scope'] != b['scope']):
            return float('inf')
        differences = [abs(a['signals'][k] - b['signals'][k]) for k in keys]
        return size + sum(delta / scale for delta, scale in zip(differences, (12, 6, 6)))

    comparable = [(distance(winner, other), winner['code'], other['code'], winner, other)
                  for winner in complete if winner['outcomes']['5']['success'] and winner['track'] == 'comparison'
                  for other in complete if not other['outcomes']['5']['success'] and other['track'] == 'comparison']
    finite = [item for item in comparable if math.isfinite(item[0])]
    if not finite:
        return None
    score, _, _, winner, other = min(finite, key=lambda item: item[:3])
    return {'distance': round(score, 3), 'growth': winner, 'comparison': other}


def read_disclosure(receipt, scope):
    url = f'{DART_WEB}/dsaf001/main.do?rcpNo={receipt}'
    result = {'url': url, 'eps': None, 'operatingCash': None}
    try:
        page = fetch(url).decode('utf-8', 'replace')
        blocks = re.findall(r"node\d+\['text'\]\s*=\s*\"([^\"]+)\";(.*?)(?=node\d+\['text'\]|$)", page, re.S)
        for title, block in blocks:
            flat = title.replace(' ', '')
            if not flat.endswith('재무제표') or ('연결' in flat) != (scope == 'CFS'):
                continue
            digits = 'rcpNo dcmNo eleId offset length dtd tocNo'.split()
            arguments = dict(re.findall(r"node\d+\['(\w+)'\]\s*=\s*\"([^\"]*)\";", block))
            if not set(digits).issubset(arguments):
                continue
            data = fetch(DART_WEB + '/report/viewer.do', {k: arguments[k] for k in digits})
            table = ListingTable()
            table.feed(data.decode('utf-8', 'replace'))
            for cells in table.rows:
                if len(cells) not in (3, 5, 7):
                    continue
                label = re.sub(r'\(단위:[^)]*\)$', '', re.sub(r'\s+', '', cells[0]))
                values = [number(v.replace('(', '-').replace(')', '')) for v in cells[1:]]
                if any(v is None for v in values):
                    continue
                if '지속' not in label and '계속' not in label and '중단' not in label and (
                        '기본주당' in label or '주당기본' in label or '기본및희석주당' in label):
                    current, previous = (values[1], values[3]) if len(values) >= 4 else values
                    if not result['eps']:
                        result['eps'] = {'current': current, 'prior': previous, 'label': cells[0]}
                if re.fullmatch(r'(?:[IVX]+[.]|[0-9]+[.])?영업활동(?:으로인한|으로부터의)?현금흐름', label) and len(values) in (2, 4) and not result['operatingCash']:
                    result['operatingCash'] = {'current': values[0], 'prior': values[1], 'label': cells[0]}
            if result['eps'] or result['operatingCash']:
                break
    except (RuntimeError, UnicodeError) as error:
        result['error'] = str(error)
    return result


def enrich_case(row):
    links = {'base': row['base']['receipt'], 'year5': row['y5']['receipt']}
    source = {period: read_disclosure(receipt, row['scope']) for period, receipt in links.items()}
    return {**row, 'disclosures': source}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('inputs', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--cases', action='store_true')
    args = parser.parse_args()
    cohorts = [json.loads(path.read_text(encoding='utf-8')) for path in sorted(args.inputs.rglob('cohort-*.json'))]
    if not cohorts or len(cohorts) != len({item['year'] for item in cohorts}):
        raise SystemExit('Missing or duplicate cohorts')
    results = {}
    for cohort in cohorts:
        year, rows = cohort['year'], cohort['rows']
        pairs = select_pairs(rows)
        results[year] = {
            'sampled': cohort['sampled'], 'comparableBaseline': len(rows), 'exclusions': cohort['counts'],
            'industryCovered': sum(row['industry'] is not None for row in rows),
            'outcomes': {str(h): summarize(rows, str(h)) for h in ((3, 5, 10) if year == 2016 else (3, 5))},
            'matched5': {name: matched_screen(rows, rule) for name, rule in {
                'existingAny': lambda row: row['track'] != 'comparison',
                'twoReportPairedGrowth': lambda row: FEATURES['twoReportPairedGrowth'](row['signals']),
            }.items()},
            'examplePair': pairs,
        }
        if pairs and args.cases:
            pairs['growth'], pairs['comparison'] = parallel(enrich_case, (pairs['growth'], pairs['comparison']), workers=2)
    all_rows = [row for cohort in cohorts for row in cohort['rows']]
    payload = {
        'source': 'OpenDART annual and nine-month interim major accounts, Korea Exchange where industry known',
        'success': 'Initially profitable; sales and operating profit each at least 10% CAGR; both above starting value at intermediate observation (year 1/3/5 for endpoints 3/5/10).',
        'caseCaution': 'EPS in original units is not a fully split-adjusted series; review labels and statement units in linked filings.',
        'cohorts': results,
        'overall': {h: summarize([r for r in all_rows if h in r['outcomes']], h) for h in ('3', '5', '10')},
        'robustness5': {
            'startMarginAtLeast3': summarize([row for row in all_rows if row['base']['margin'] >= 3], '5'),
            'onlyConsolidated': summarize([row for row in all_rows if row['scope'] == 'CFS'], '5'),
            'minimumCagr8': summarize(at_threshold(all_rows, 8), '5'),
            'minimumCagr15': summarize(at_threshold(all_rows, 15), '5'),
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
