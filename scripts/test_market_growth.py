import datetime as dt
import unittest

from scan_market_growth import KST, accounts_by_company, financial_screen, period_plan, price_candidate, ranked_tracks


def statement(scope, amounts, prior, older=80, interim=False, currency="KRW"):
    rows = []
    for index, account in enumerate(("매출액", "영업이익", "당기순이익")):
        rows.append({
            "stock_code": "000001", "fs_div": scope, "rcept_no": "20261116000001",
            "currency": currency, "sj_div": "IS", "account_nm": account,
            "thstrm_amount": str(amounts[index] if not interim else 1),
            "frmtrm_amount": str(prior[index] if not interim else 1),
            "thstrm_add_amount": str(amounts[index]), "frmtrm_add_amount": str(prior[index]),
            "bfefrmtrm_amount": str(older),
        })
    return rows


class MarketGrowthTest(unittest.TestCase):
    def screen(self, annual, recent):
        return financial_screen(accounts_by_company(annual).get("000001", {}),
                                accounts_by_company(recent).get("000001", {}), "11014")

    def test_uses_comparable_cumulative_results(self):
        annual = statement("CFS", (130, 30, 17), (100, 22, 12))
        recent = statement("CFS", (125, 28, 16), (100, 21, 12), interim=True)
        status, facts = self.screen(annual, recent)
        self.assertEqual(status, "financialPass")
        self.assertEqual(facts["track"], "verified")
        self.assertEqual(facts["recentGrowth"], 25)
        self.assertEqual(facts["annualTotalNet"], 17)

    def test_rejects_bad_consolidated_or_different_scope(self):
        bad_cfs = statement("CFS", (130, 30, 5), (100, 22, 12))
        good_ofs = statement("OFS", (130, 30, 20), (100, 22, 12))
        self.assertEqual(self.screen(bad_cfs + good_ofs, good_ofs)[0], "recentMissing")
        self.assertEqual(self.screen(statement("CFS", (130, 30, 20), (100, 22, 12)), good_ofs)[0], "recentMissing")

    def test_missing_history_and_margin_drop_are_different(self):
        annual = statement("CFS", (130, 30, 20), (100, 22, 12))
        recent = statement("CFS", (125, 25, 16), (100, 26, 12), interim=True)
        self.assertEqual(self.screen(annual, recent)[0], "recentFail")
        self.assertEqual(self.screen(statement("CFS", (130, 30, 20), (100, 22, 12), currency="USD"), recent)[0], "annualMissing")

    def test_untradable_and_stale_quotes_do_not_rank(self):
        now = dt.datetime(2026, 11, 25, tzinfo=KST)
        facts = {"annualTotalNet": 300, "recentGrowth": 15, "annualGrowth": 20,
                 "recentOperatingMargin": 25, "recentNetMargin": 20}
        quote = {"tradableStatus": "tradable", "localTradedAt": "2026-11-24T15:30:00+09:00",
                 "marketValueRaw": "6000", "closePriceRaw": "10", "accumulatedTradingVolumeRaw": "12"}
        self.assertEqual(price_candidate(facts, quote, now)["annualPer"], 20)
        self.assertIsNone(price_candidate(facts, {**quote, "tradableStatus": "halted"}, now))
        self.assertIsNone(price_candidate(facts, {**quote, "localTradedAt": "2026-10-30T15:30:00+09:00"}, now))

    def test_reporting_calendar(self):
        self.assertEqual(period_plan(dt.date(2026, 11, 25)), (2025, (2026, "11014", "Q3")))
        self.assertEqual(period_plan(dt.date(2027, 2, 1)), (2025, (2026, "11014", "Q3")))

    def test_high_margin_without_earnings_growth_is_not_a_growth_track(self):
        annual = statement("CFS", (107, 25, 15), (100, 22, 12))
        recent = statement("CFS", (106, 23, 14), (100, 20, 12), interim=True)
        self.assertEqual(self.screen(annual, recent)[1]["track"], "profitLed")
        flat_profit = statement("CFS", (106, 20, 14), (100, 20, 12), interim=True)
        self.assertEqual(self.screen(annual, flat_profit), ("recentFail", None))

    def test_high_sales_growth_needs_higher_margin_and_profit_for_confirmation(self):
        annual = statement("CFS", (120, 5, -1), (100, 2, -2))
        improving = statement("CFS", (125, 10, 5), (100, 5, -1), interim=True)
        waiting = statement("CFS", (125, 7, 1), (100, 5, -1), interim=True)
        still_losing = statement("CFS", (125, 10, -1), (100, 5, -1), interim=True)
        self.assertEqual(self.screen(annual, improving)[1]["track"], "salesImproving")
        self.assertEqual(self.screen(annual, waiting)[1]["track"], "salesWatch")
        self.assertEqual(self.screen(annual, still_losing)[1]["track"], "salesWatch")
        turnaround = statement("CFS", (125, 10, 5), (100, -5, -1), interim=True)
        track = self.screen(annual, turnaround)[1]
        self.assertEqual(track["track"], "salesImproving")
        self.assertIsNone(track["recentOperatingGrowth"])

    def test_loss_is_not_a_pe_and_rank_history_is_per_track(self):
        facts = {"track": "salesImproving", "annualTotalNet": -1, "recentGrowth": 25, "annualGrowth": 20,
                 "recentOperatingMargin": 8, "recentNetMargin": 4, "marginDelta": 3}
        quote = {"tradableStatus": "tradable", "localTradedAt": "2026-11-24T15:30:00+09:00",
                 "marketValueRaw": "6000", "closePriceRaw": "10", "accumulatedTradingVolumeRaw": "12"}
        price = price_candidate(facts, quote, dt.datetime(2026, 11, 25, tzinfo=KST))
        self.assertIsNone(price["annualPer"])
        row = {"code": "001000", "name": "Test", "inWatchlist": False, **facts, **price}
        result = ranked_tracks([row], {"updatedAt": "old", "items": [row]})
        self.assertEqual(result["verified"]["removed"], ["Test"])
        self.assertEqual(result["salesImproving"]["items"][0]["rank"], 1)
        self.assertIsNone(result["salesImproving"]["previousRun"])


if __name__ == "__main__":
    unittest.main()
