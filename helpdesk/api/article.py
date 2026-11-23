import re

import frappe
from frappe import _
from frappe.utils import escape_html

from helpdesk.search_sqlite import HelpdeskArticleSearch
from helpdesk.utils import is_agent

NUM_RESULTS = 5
SNIPPET_CHARS = 200
# Shorter words match too much when any one word is enough.
MIN_ANY_WORD_LENGTH = 3
# Arabic short vowels and tatweel, which customers type inconsistently.
ARABIC_MARKS = re.compile(r"[\u064B-\u0652\u0640]")
# The search adds <mark> around matches; the text is escaped, so they are dropped.
HIGHLIGHT = re.compile(r"</?mark>")


def filter_public_articles(articles: list) -> list:
    """Drop hits whose article is no longer published, the index can be stale."""
    names = {article["name"].split("#")[0] for article in articles}
    if not names:
        return []
    published = frappe.get_list(
        "HD Article",
        filters={"name": ("in", list(names)), "status": "Published"},
        pluck="name",
    )
    return [
        article for article in articles if article["name"].split("#")[0] in published
    ]


def sanitize_query(query: str) -> str:
    """Letters and digits of any script, lower-cased, single-spaced."""
    q = ARABIC_MARKS.sub("", (query or "").strip().lower())
    return " ".join(re.findall(r"\w+", q))


@frappe.whitelist()
def get_article_stats(article_name: str):
    views, status = frappe.db.get_value(
        "HD Article", article_name, ["views", "status"]
    ) or (None, None)
    if not is_agent() and status != "Published":
        frappe.throw(_("Access denied"), frappe.PermissionError)

    likes = frappe.db.count(
        "HD Article Feedback",
        filters={
            "article": article_name,
            "feedback": 1,
        },
    )

    dislikes = frappe.db.count(
        "HD Article Feedback",
        filters={
            "article": article_name,
            "feedback": 2,
        },
    )

    return {
        "views": views,
        "likes": likes,
        "dislikes": dislikes,
    }


def _hits(query: str, any_word: bool) -> list[dict]:
    index = HelpdeskArticleSearch(any_word=any_word)
    if not index.index_exists():
        return []
    return [
        {
            "id": row["id"],
            "name": row["name"],
            "subject": HIGHLIGHT.sub("", row.get("title") or "") or row["name"],
            "headings": "",
            "description": escape_html(
                HIGHLIGHT.sub("", row.get("content") or "")[:SNIPPET_CHARS]
            ),
        }
        for row in index.search(query)["results"]
    ]


@frappe.whitelist()
def search(query: str) -> list:
    """Published articles for a ticket being written: every word first, then any word."""
    query = sanitize_query(query)
    if not query:
        return []
    found = filter_public_articles(_hits(query, any_word=False))
    if len(found) < NUM_RESULTS:
        loose = " ".join(w for w in query.split() if len(w) >= MIN_ANY_WORD_LENGTH)
        if loose:
            seen = {hit["name"] for hit in found}
            found += [
                hit
                for hit in filter_public_articles(_hits(loose, any_word=True))
                if hit["name"] not in seen
            ]
    return found[:NUM_RESULTS]
