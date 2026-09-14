import unittest

from services.postgres_cli import parse_database_url


class ParseDatabaseUrlTests(unittest.TestCase):
    def test_decodes_credentials_database_and_driver_scheme(self):
        self.assertEqual(
            parse_database_url(
                "postgresql+psycopg2://user%40name:p%40ss%3Aword@db.example:5544/cards%20db"
            ),
            {
                "user": "user@name",
                "password": "p@ss:word",
                "host": "db.example",
                "port": "5544",
                "dbname": "cards db",
            },
        )

    def test_supports_postgres_scheme_ipv6_and_default_port(self):
        self.assertEqual(
            parse_database_url("postgres://user:pass@[2001:db8::1]/pokemon"),
            {
                "user": "user",
                "password": "pass",
                "host": "2001:db8::1",
                "port": "5432",
                "dbname": "pokemon",
            },
        )

    def test_rejects_non_postgres_and_incomplete_urls(self):
        for database_url in (
            "sqlite:///pokemon.db",
            "postgresql://user:pass@host",
            "postgresql:///pokemon",
            "postgresql://user:pass@host:not-a-port/pokemon",
        ):
            with self.subTest(database_url=database_url):
                self.assertIsNone(parse_database_url(database_url))


if __name__ == "__main__":
    unittest.main()
