import unittest

from research_long_growth import cagr, long_outcome
from scan_market_growth import accounts_by_company
from summarize_long_growth import matched_screen, metrics


def actual(sales, op):
    return {'sales': sales, 'op': op, 'margin': 100 * op / sales}


class GrowthResearchTests(unittest.TestCase):
    def test_exact_growth_hurdle(self):
        self.assertAlmostEqual(cagr(200, 200 * 1.1 ** 5, 5), 10)
        good = long_outcome(actual(200, 20), actual(300, 25), actual(200 * 1.1 ** 5, 20 * 1.1 ** 5), 5)
        self.assertTrue(good['success'])

    def test_endpoint_is_not_enough(self):
        base, middle, end = actual(100, 4), actual(120, 3), actual(220, 12)
        self.assertFalse(long_outcome(base, middle, end, 5)['success'])
        self.assertIsNone(long_outcome(base, None, end, 5))
        self.assertIsNone(long_outcome(actual(100, -2), middle, end, 5))
        self.assertFalse(long_outcome(base, middle, actual(240, -1), 5)['success'])

    def test_filter_precision_capture_and_unknown(self):
        rows = [{'match': match, 'outcomes': {'5': None if result is None else {'success': result}}}
                for match, result in [(True, True), (False, True), (True, False), (False, True), (True, None)]]
        result = metrics(rows, '5', lambda r: r['match'])
        self.assertEqual(result['successPct'], 50)
        self.assertEqual(result['capturePct'], 33.33)
        self.assertEqual(result['coveragePct'], 66.67)
        self.assertEqual(result['missingAllFailedPct'], 33.33)
        self.assertEqual(result['missingAllSucceededPct'], 66.67)

    def test_historical_corporation_does_not_need_a_current_stock_code(self):
        rows = [{'corp_code': '00123456', 'stock_code': '', 'fs_div': 'CFS',
                 'rcept_no': '20201116123456', 'account_nm': '매출액', 'currency': 'KRW', 'sj_div': 'IS'}]
        self.assertIn('00123456', accounts_by_company(rows, by_corp=True))
        self.assertEqual({}, accounts_by_company(rows))

    def test_matched_peers_exclude_wrong_board_or_size(self):
        def row(selected, sales, growth, market='Y'):
            return {'selected': selected, 'base': {'sales': sales}, 'market': market, 'industry': 'parts',
                    'scope': 'CFS', 'industrySource': 'KIND', 'outcomes': {'5': {'success': growth}}}
        selected = row(True, 100, True)
        peers = [row(False, 50, True), row(False, 180, False), row(False, 200, False),
                 row(False, 210, True), row(False, 100, True, market='K')]
        match = matched_screen([selected, *peers], lambda r: r['selected'])
        self.assertEqual(match['matched'], 1)
        self.assertEqual(match['matchedPeerSuccessPct'], 33.33)


if __name__ == '__main__':
    unittest.main()
