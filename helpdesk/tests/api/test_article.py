from unittest.mock import patch

import frappe
from frappe.tests.utils import FrappeTestCase

from helpdesk.api.article import NUM_RESULTS, get_article_stats, search
from helpdesk.search_sqlite import HelpdeskArticleSearch
from helpdesk.test_utils import (
    create_agent,
    create_contact,
    make_agent_manager,
    make_article,
    make_article_feedback,
    unique_email,
)


class TestGetArticleStats(FrappeTestCase):
    def setUp(self) -> None:
        frappe.set_user("Administrator")
        self.published = make_article()
        self.draft = make_article(status="Draft")

    def test_counts_views_likes_and_dislikes_of_one_article(self) -> None:
        frappe.db.set_value("HD Article", self.published, "views", 7)
        for feedback in (1, 1, 2, 0):
            make_article_feedback(self.published, feedback)
        make_article_feedback(self.draft, 1)

        stats = get_article_stats(self.published)

        self.assertEqual(stats, {"views": 7, "likes": 2, "dislikes": 1})

    def test_administrator_reads_stats_of_draft(self) -> None:
        self.assertEqual(get_article_stats(self.draft)["likes"], 0)

    def test_agent_reads_stats_of_draft(self) -> None:
        with self.set_user(create_agent(unique_email("article-agent")).name):
            self.assertEqual(get_article_stats(self.draft)["dislikes"], 0)

    def test_agent_manager_reads_stats_of_draft(self) -> None:
        user = make_agent_manager("article-manager")

        with self.set_user(user):
            self.assertEqual(get_article_stats(self.draft)["likes"], 0)

    def test_customer_reads_stats_of_published_article(self) -> None:
        make_article_feedback(self.published, 1)

        customer = create_contact("Article Customer", unique_email("article-customer"))

        with self.set_user(customer["user"]):
            self.assertEqual(get_article_stats(self.published)["likes"], 1)

    def test_customer_cannot_read_stats_of_unpublished_article(self) -> None:
        archived = make_article(status="Archived")
        customer = create_contact("Article Customer", unique_email("article-customer"))

        for article in (self.draft, archived, "missing-article"):
            with self.subTest(article=article), self.set_user(customer["user"]):
                with self.assertRaises(frappe.PermissionError):
                    get_article_stats(article)

    def test_inactive_agent_cannot_read_stats_of_draft(self) -> None:
        agent = create_agent(unique_email("article-agent")).name
        frappe.db.set_value("HD Agent", agent, "is_active", 0)

        with self.set_user(agent), self.assertRaises(frappe.PermissionError):
            get_article_stats(self.draft)


def make_titled_article(title: str, content: str, status: str = "Published") -> str:
    return (
        frappe.get_doc(
            {
                "doctype": "HD Article",
                "title": title,
                "content": content,
                "status": status,
            }
        )
        .insert(ignore_permissions=True)
        .name
    )


class TestSearchArticles(FrappeTestCase):
    """Runs against a real SQLite index in its own file, dropped after each test."""

    def setUp(self) -> None:
        frappe.set_user("Administrator")
        index = patch.object(
            HelpdeskArticleSearch,
            "INDEX_NAME",
            f"test-article-search-{frappe.generate_hash(length=8)}.db",
        )
        index.start()
        self.addCleanup(index.stop)
        self.addCleanup(lambda: HelpdeskArticleSearch().drop_index())

    def build(self) -> None:
        HelpdeskArticleSearch().build_index()

    def test_every_word_matches_before_any_word(self) -> None:
        exact = make_titled_article("Reset your password", "<p>Open settings and reset the password.</p>")
        loose = make_titled_article("Password rules", "<p>Use twelve characters.</p>")
        self.build()

        result = search("  How do I RESET my password?! ")

        names = [hit["name"] for hit in result]
        self.assertEqual(names[0], exact)
        self.assertIn(loose, names)
        self.assertEqual(result[0]["subject"], "Reset your password")
        self.assertEqual(result[0]["headings"], "")

    def test_an_arabic_question_finds_an_arabic_article(self) -> None:
        article = make_titled_article(
            "إعادة تعيين كلمة المرور", "<p>افتح الإعدادات ثم اضغط إعادة تعيين كلمة المرور.</p>"
        )
        self.build()

        self.assertEqual([hit["name"] for hit in search("كيف أُعيد تعيين كلمة المرور؟")], [article])

    def test_results_stop_at_the_limit(self) -> None:
        for i in range(NUM_RESULTS + 2):
            make_titled_article(f"Invoice question {i}", "<p>Invoices are sent monthly.</p>")
        self.build()

        self.assertEqual(len(search("invoice")), NUM_RESULTS)

    def test_no_match_returns_empty_list(self) -> None:
        make_titled_article("Reset your password", "<p>Open settings.</p>")
        self.build()

        self.assertEqual(search("nothing matches this"), [])
        self.assertEqual(search("?!"), [])

    def test_a_missing_index_returns_empty_list(self) -> None:
        make_titled_article("Reset your password", "<p>Open settings.</p>")

        self.assertEqual(search("password"), [])

    def test_customer_never_sees_an_unpublished_article(self) -> None:
        published = make_titled_article("Refund policy", "<p>Refunds take five days.</p>")
        make_titled_article("Refund draft", "<p>Refunds draft.</p>", status="Draft")
        archived = make_titled_article("Refund archived", "<p>Refunds archived.</p>")
        self.build()
        frappe.db.set_value("HD Article", archived, "status", "Archived")
        customer = create_contact("Article Customer", unique_email("article-customer"))

        with self.set_user(customer["user"]):
            result = search("refund")

        self.assertEqual([hit["name"] for hit in result], [published])

    def test_article_text_is_escaped_in_the_snippet(self) -> None:
        make_titled_article("Script note", "<p>Type &lt;script&gt;alert(1)&lt;/script&gt; nowhere.</p>")
        self.build()

        hit = search("script")[0]

        self.assertNotIn("<script>", hit["description"])
        self.assertIn("&lt;script&gt;", hit["description"])
        self.assertNotIn("mark", hit["description"] + hit["subject"])
