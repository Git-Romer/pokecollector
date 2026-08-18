import unittest

from services.supporters import parse_rescue_donations_csv


class RescueDonationsTests(unittest.TestCase):
    def test_rescue_donation_batches_are_totaled(self):
        result = parse_rescue_donations_csv(
            "date,amount,currency,organization,url,note\n"
            "2026-05-29,20,EUR,Animal Shelter,https://example.com,First batch\n"
            "2026-06-02,30.50,EUR,Animal Rescue,,Second batch\n"
        )

        self.assertEqual(result["total_amount"], 50.5)
        self.assertEqual(result["currency"], "EUR")
        self.assertEqual(result["donation_count"], 2)
        self.assertEqual(result["latest_donation_at"], "2026-06-02")
        self.assertEqual([donation["amount"] for donation in result["donations"]], [30.5, 20.0])

    def test_rescue_donations_ignore_empty_and_zero_amount_rows(self):
        result = parse_rescue_donations_csv(
            "date,amount,currency,organization,url,note\n"
            "2026-05-29,,EUR,Animal Shelter,,\n"
            "2026-05-30,0,EUR,Animal Shelter,,\n"
        )

        self.assertEqual(result["total_amount"], 0.0)
        self.assertEqual(result["currency"], "EUR")
        self.assertEqual(result["donation_count"], 0)
        self.assertEqual(result["latest_donation_at"], None)
        self.assertEqual(result["donations"], [])
if __name__ == "__main__":
    unittest.main()
