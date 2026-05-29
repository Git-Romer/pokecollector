import unittest

from services.supporters import parse_rescue_donations_csv, parse_supporters_csv


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


class SupportersTests(unittest.TestCase):
    def test_supporters_are_aggregated_and_ranked_by_total_amount(self):
        supporters = parse_supporters_csv(
            "date,name,amount,currency,url\n"
            "2026-05-29,Anton,1,EUR,https://github.com/scoutante112\n"
            "2026-05-30,Anton,2.50,EUR,https://github.com/scoutante112\n"
            "2026-05-29,Bella,5,EUR,\n"
            "2026-05-29,Chris,3,EUR,https://example.com/chris\n"
            "2026-05-29,Dana,0.50,EUR,\n"
        )

        self.assertEqual([supporter["name"] for supporter in supporters], ["Bella", "Anton", "Chris", "Dana"])
        self.assertEqual([supporter["crown"] for supporter in supporters], ["gold", "silver", "bronze", None])
        self.assertEqual(supporters[1]["total_amount"], 3.5)
        self.assertEqual(supporters[1]["donation_count"], 2)
        self.assertEqual(supporters[1]["first_supported_at"], "2026-05-29")
        self.assertEqual(supporters[1]["latest_supported_at"], "2026-05-30")
        self.assertEqual([donation["amount"] for donation in supporters[1]["donations"]], [2.5, 1.0])

    def test_missing_optional_fields_still_show_supporter(self):
        supporters = parse_supporters_csv("date,name,amount,currency,url\n,Anonymous,,,\n")

        self.assertEqual(len(supporters), 1)
        self.assertEqual(supporters[0]["name"], "Anonymous")
        self.assertEqual(supporters[0]["total_amount"], 0.0)
        self.assertEqual(supporters[0]["currency"], "EUR")
        self.assertEqual(supporters[0]["crown"], "gold")

    def test_empty_names_are_ignored(self):
        supporters = parse_supporters_csv("date,name,amount,currency,url\n2026-05-29,,1,EUR,\n")

        self.assertEqual(supporters, [])

    def test_only_existing_supporters_receive_crowns(self):
        supporters = parse_supporters_csv(
            "date,name,amount,currency,url\n"
            "2026-05-29,Anton,1,EUR,\n"
            "2026-05-29,Bella,2,EUR,\n"
        )

        self.assertEqual([supporter["crown"] for supporter in supporters], ["gold", "silver"])

    def test_same_name_with_and_without_url_is_one_supporter(self):
        supporters = parse_supporters_csv(
            "date,name,amount,currency,url\n"
            "2026-05-29,Anton,1,EUR,\n"
            "2026-05-30,Anton,2,EUR,https://github.com/scoutante112\n"
        )

        self.assertEqual(len(supporters), 1)
        self.assertEqual(supporters[0]["name"], "Anton")
        self.assertEqual(supporters[0]["url"], "https://github.com/scoutante112")
        self.assertEqual(supporters[0]["total_amount"], 3.0)
        self.assertEqual(supporters[0]["crown"], "gold")

    def test_same_url_with_different_display_name_is_one_supporter(self):
        supporters = parse_supporters_csv(
            "date,name,amount,currency,url\n"
            "2026-05-29,Anton,1,EUR,https://github.com/scoutante112\n"
            "2026-05-30,scoutante112,2,EUR,https://github.com/scoutante112\n"
        )

        self.assertEqual(len(supporters), 1)
        self.assertEqual(supporters[0]["name"], "Anton")
        self.assertEqual(supporters[0]["total_amount"], 3.0)


if __name__ == "__main__":
    unittest.main()
