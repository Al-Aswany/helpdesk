import json
from unittest.mock import patch

import frappe
from frappe import _
from frappe.tests.utils import FrappeTestCase
from frappe.utils import add_days, getdate, now_datetime, nowdate

from helpdesk.api.dashboard import HelpdeskDashboard, get_dashboard_data
from helpdesk.test_utils import (
    create_agent,
    create_contact,
    get_number_cards,
    make_agent_manager,
    make_assigned_ticket,
    make_sla,
    make_tagged_ticket,
    make_team,
    make_ticket,
    unique_email,
    unique_name,
)

AGENT = "dashboard-sla-agent@example.com"


class TestSlaFulfilledCard(FrappeTestCase):
    def test_fulfilled_percentage_stays_within_100(self):
        """A response-only policy marks a still-open ticket Fulfilled. Counting it
        in the numerator while the denominator only holds resolved tickets pushes
        the card past 100%."""
        create_agent(AGENT)
        response_only = make_sla("Response Only", "doc.subject == 'Response only'", 1)
        response_only.apply_sla_for_resolution = 0
        response_only.save()

        open_ticket = self.make_assigned_ticket("Response only")
        self.assertEqual(open_ticket.agreement_status, "Fulfilled")
        self.assertNotEqual(open_ticket.status_category, "Resolved")

        resolved_ticket = self.make_assigned_ticket("Resolved one", status="Closed")
        self.assertEqual(resolved_ticket.agreement_status, "Fulfilled")

        card = self.get_sla_card()
        self.assertEqual(card["value"], 100)

    def test_trend_plots_sla_fulfilled_as_percentage(self):
        with self.freeze_time("2031-03-12 10:00:00"):
            for subject, agreement_status in (
                ("Answered in time", "Fulfilled"),
                ("Answered late", "Failed"),
            ):
                ticket = self.make_assigned_ticket(subject, status="Closed")
                frappe.db.set_value(
                    "HD Ticket", ticket.name, "agreement_status", agreement_status
                )

        filters = frappe._dict(
            from_date="2031-03-12", to_date="2031-03-12", agent=AGENT
        )
        [day] = HelpdeskDashboard(filters).get_ticket_trend_data()["data"]
        self.assertEqual(day["SLA Fulfilled"], 50)

    def make_assigned_ticket(self, subject: str, status: str | None = None):
        """A ticket that has been responded to, scoped to this test's agent."""
        ticket = make_ticket(subject=subject)
        ticket.reload()
        ticket.first_responded_on = now_datetime()
        if status:
            ticket.status = status
        ticket.save()
        frappe.db.set_value("HD Ticket", ticket.name, "_assign", json.dumps([AGENT]))
        return ticket

    def get_sla_card(self) -> dict:
        filters = frappe._dict(
            from_date=add_days(nowdate(), -1), to_date=nowdate(), agent=AGENT
        )
        return HelpdeskDashboard(filters).get_sla_fulfilled_count()


class TestNumberCardDelta(FrappeTestCase):
    """Number cards compare against the period of the same length just before."""

    def setUp(self):
        self.agent = create_agent(unique_email("dashboard-delta-agent")).name

    def test_cards_show_no_change_without_a_previous_period(self):
        with self.freeze_time("2031-05-10 10:00:00"):
            make_assigned_ticket(self.agent, "Only ticket", status="Closed")

        for card in get_number_cards(self.agent, "2031-05-10", "2031-05-10").values():
            self.assertIsNone(card["delta"], card["title"])

    def test_averages_show_no_data_for_an_empty_period(self):
        with self.freeze_time("2031-08-09 10:00:00"):
            make_assigned_ticket(self.agent, "Only yesterday", status="Closed")

        cards = get_number_cards(self.agent, "2031-08-10", "2031-08-10")
        tickets = cards.pop(_("Tickets"))
        self.assertEqual(tickets["value"], 0)
        self.assertEqual(tickets["delta"], -100)
        for card in cards.values():
            self.assertIsNone(card["value"], card["title"])
            self.assertIsNone(card["delta"], card["title"])

    def test_ticket_count_changes_against_the_previous_period(self):
        with self.freeze_time("2031-06-09 10:00:00"):
            make_assigned_ticket(self.agent, "Yesterday")
        with self.freeze_time("2031-06-10 10:00:00"):
            make_assigned_ticket(self.agent, "Today")
            make_assigned_ticket(self.agent, "Today again")

        cards = get_number_cards(self.agent, "2031-06-10", "2031-06-10")
        tickets = cards[_("Tickets")]
        self.assertEqual(tickets["value"], 2)
        self.assertEqual(tickets["delta"], 100)

    def test_previous_period_has_as_many_days_as_this_one(self):
        # sep 8-9 should be compared with sep 6-7
        for day in ("2031-09-06", "2031-09-07", "2031-09-08"):
            with self.freeze_time(f"{day} 10:00:00"):
                make_assigned_ticket(self.agent, f"Raised {day}")

        cards = get_number_cards(self.agent, "2031-09-08", "2031-09-09")
        tickets = cards[_("Tickets")]
        self.assertEqual(tickets["value"], 1)
        self.assertEqual(tickets["delta"], -50)

    def test_zero_hour_previous_average_still_compares(self):
        with self.freeze_time("2031-07-09 10:00:00"):
            earlier = make_assigned_ticket(self.agent, "Answered at once")
        with self.freeze_time("2031-07-10 10:00:00"):
            later = make_assigned_ticket(self.agent, "Answered later")
        frappe.db.set_value("HD Ticket", earlier.name, "first_response_time", 0)
        frappe.db.set_value("HD Ticket", later.name, "first_response_time", 7200)

        cards = get_number_cards(self.agent, "2031-07-10", "2031-07-10")
        self.assertEqual(cards[_("Avg. First Response")]["delta"], 2)


class TestTagDashboard(FrappeTestCase):
    """Tag charts reached through `get_dashboard_data("tags", ...)`."""

    @classmethod
    def setUpClass(cls) -> None:
        super().setUpClass()
        cls.manager = make_agent_manager("tag-dash-manager")
        cls.agent = create_agent(unique_email("tag-dash-agent")).name
        cls.member = create_agent(unique_email("tag-dash-member")).name
        cls.customer = create_contact("Tag Customer", unique_email("tag-dash"))
        # so no ticket below is Administrator's first, which would get a tag
        make_ticket()

    def setUp(self) -> None:
        self.suffix = frappe.generate_hash(length=6)
        self.team = make_team(f"Tag Team {self.suffix}", [self.member]).name

    def test_top_tags_count_each_tag_of_a_ticket(self) -> None:
        billing, refund = self.tag("billing"), self.tag("refund")
        make_tagged_ticket(self.team, "2031-03-10 10:00:00", billing, refund)
        make_tagged_ticket(self.team, "2031-03-11 10:00:00", billing)
        make_tagged_ticket(self.team, "2031-03-11 11:00:00")

        top_tags = self.get_charts("2031-03-10", "2031-03-11")["top_tags"]["data"]
        # busiest tag first so it shows at the top
        self.assertEqual(
            top_tags, [{"tag": billing, "Tickets": 2}, {"tag": refund, "Tickets": 1}]
        )

    def test_date_range_includes_whole_first_and_last_day(self) -> None:
        billing = self.tag("billing")
        make_tagged_ticket(self.team, "2031-04-09 23:59:59", billing)
        make_tagged_ticket(self.team, "2031-04-10 00:00:00", billing)
        make_tagged_ticket(self.team, "2031-04-12 23:59:59", billing)
        make_tagged_ticket(self.team, "2031-04-13 00:00:00", billing)

        charts = self.get_charts("2031-04-10", "2031-04-12")
        self.assertEqual(self.top_tag_counts(charts), {billing: 2})

    def test_tag_trend_zero_fills_each_day(self) -> None:
        billing, refund = self.tag("billing"), self.tag("refund")
        make_tagged_ticket(self.team, "2031-05-01 09:00:00", billing)
        make_tagged_ticket(self.team, "2031-05-01 17:00:00", billing)
        make_tagged_ticket(self.team, "2031-05-03 09:00:00", refund)

        trend = self.get_charts("2031-05-01", "2031-05-03")["tag_trend"]
        self.assertEqual(
            trend["data"],
            [
                {"date": getdate("2031-05-01"), billing: 2, refund: 0},
                {"date": getdate("2031-05-03"), billing: 0, refund: 1},
            ],
        )
        self.assertEqual(trend["y"], [billing, refund])

    def test_charts_keep_only_the_busiest_tags(self) -> None:
        # tag i sits on i + 1 tickets, so the ranking has no ties
        tags = [self.tag(f"t{index}") for index in range(11)]
        for index in range(11):
            make_tagged_ticket(self.team, "2031-06-01 10:00:00", *tags[index:])

        charts = self.get_charts("2031-06-01", "2031-06-01")
        top_tags = [row["tag"] for row in charts["top_tags"]["data"]]
        self.assertEqual(top_tags, tags[:0:-1])
        self.assertEqual(charts["tag_trend"]["y"], tags[:5:-1])

    def test_untagged_tickets_give_empty_charts(self) -> None:
        make_tagged_ticket(self.team, "2031-07-01 10:00:00")

        charts = self.get_charts("2031-07-01", "2031-07-01")
        self.assertEqual(charts["top_tags"]["data"], [])
        self.assertEqual(charts["tag_trend"]["data"], [])
        self.assertEqual(charts["tag_trend"]["y"], [])

    def test_other_teams_tickets_are_not_counted(self) -> None:
        billing = self.tag("billing")
        other_team = make_team(f"Other Tag Team {self.suffix}", [self.member]).name
        make_tagged_ticket(self.team, "2031-08-01 10:00:00", billing)
        make_tagged_ticket(other_team, "2031-08-01 10:00:00", billing)

        charts = self.get_charts("2031-08-01", "2031-08-01")
        self.assertEqual(self.top_tag_counts(charts), {billing: 1})

    def test_deleted_ticket_and_removed_tag_are_not_counted(self) -> None:
        billing = self.tag("billing")
        make_tagged_ticket(self.team, "2031-09-01 10:00:00", billing)
        deleted = make_tagged_ticket(self.team, "2031-09-01 10:00:00", billing)
        untagged = make_tagged_ticket(self.team, "2031-09-01 10:00:00", billing)
        frappe.delete_doc("HD Ticket", deleted.name, force=True)
        untagged.remove_tag(billing)

        charts = self.get_charts("2031-09-01", "2031-09-01")
        self.assertEqual(self.top_tag_counts(charts), {billing: 1})

    def test_agent_sees_tags_of_own_tickets_only(self) -> None:
        billing = self.tag("billing")
        mine = make_tagged_ticket(self.team, "2031-10-01 10:00:00", billing)
        make_tagged_ticket(self.team, "2031-10-01 10:00:00", billing)
        frappe.db.set_value("HD Ticket", mine.name, "_assign", json.dumps([self.agent]))

        filters = {
            "from_date": "2031-10-01",
            "to_date": "2031-10-01",
            "agent": self.agent,
        }
        with self.set_user(self.agent):
            charts = self.by_key(get_dashboard_data("tags", filters))
        self.assertEqual(self.top_tag_counts(charts), {billing: 1})

    def test_agent_cannot_view_team_or_org_tag_charts(self) -> None:
        with self.set_user(self.agent):
            with self.assertRaises(frappe.PermissionError):
                get_dashboard_data("tags", {"team": self.team, "agent": self.agent})
            with self.assertRaises(frappe.PermissionError):
                get_dashboard_data("tags", {})

    def test_customer_cannot_view_tag_charts(self) -> None:
        with self.set_user(self.customer["user"]):
            with self.assertRaises(frappe.PermissionError):
                get_dashboard_data("tags", {"agent": self.customer["user"]})

    def tag(self, label: str) -> str:
        return f"{label}-{self.suffix}"

    def get_charts(self, from_date: str, to_date: str) -> dict[str, dict]:
        """Tag charts for this test's team, as the manager sees them."""
        filters = {"from_date": from_date, "to_date": to_date, "team": self.team}
        with self.set_user(self.manager):
            return self.by_key(get_dashboard_data("tags", filters))

    @staticmethod
    def by_key(charts: list[dict]) -> dict[str, dict]:
        return {chart["key"]: chart for chart in charts}

    @staticmethod
    def top_tag_counts(charts: dict[str, dict]) -> dict[str, int]:
        return {row["tag"]: row["Tickets"] for row in charts["top_tags"]["data"]}



class TestTicketsByChannel(FrappeTestCase):
    """Tickets by Channel uses the source channel before Portal or Email."""

    def setUp(self):
        self.manager = make_agent_manager("channel-dash-manager")
        self.agent = create_agent(unique_email("channel-dash-agent")).name
        self.other = create_agent(unique_email("channel-dash-other")).name
        self.team = make_team(unique_name("Channel Team"), [self.agent, self.other]).name
        self.other_team = make_team(unique_name("Other Channel Team"), [self.other]).name
        self.day = "2034-04-02"
        self.assertNotIn(self.agent, self.other)
        self.assertNotIn(self.other, self.agent)

    def test_source_channel_wins_over_portal_and_email(self):
        self.assertTrue(
            frappe.db.has_column("HD Ticket", "inchaa_source_channel"),
            "HD Ticket.inchaa_source_channel is required for channel slices",
        )
        for _ in range(3):
            self.make(f"{self.day} 10:00:00", "WhatsApp", 0)
        self.make(f"{self.day} 10:05:00", " WhatsApp ", 1)
        self.make(f"{self.day} 10:10:00", None, 0)
        self.make(f"{self.day} 10:15:00", "   ", 0)
        for _ in range(2):
            self.make(f"{self.day} 11:00:00", "Instagram", 0)
        for _ in range(2):
            self.make(f"{self.day} 12:00:00", "Messenger", 1)
        self.make(f"{self.day} 13:00:00", "", 1)
        self.make(f"{self.day} 13:05:00", None, 1)
        self.make(f"{self.day} 14:00:00", "Inchaa Platform", 1)
        self.make(f"{self.day} 15:00:00", "Phone", 0)
        self.make("2034-04-01 23:59:59", "Should Not Appear", 0)
        self.make(f"{self.day} 16:00:00", "WhatsApp", 0, team=self.other_team)

        chart = self.chart(team=self.team)
        self.assert_counts(
            chart,
            {
                "WhatsApp": 4,
                "Email": 2,
                "Instagram": 2,
                "Messenger": 2,
                "Portal": 2,
                "Inchaa Platform": 1,
                "Phone": 1,
            },
        )

    def test_date_and_team_filters_limit_the_counts(self):
        self.make(f"{self.day} 00:00:00", "Phone", 0)
        self.make(f"{self.day} 23:59:59", "Phone", 0)
        self.make(f"{self.day} 10:00:00", "WhatsApp", 0)
        self.make("2034-04-01 23:59:59", "Instagram", 0)
        self.make("2034-04-03 00:00:00", "Messenger", 0)
        self.make(f"{self.day} 10:00:00", "Inchaa Platform", 0, team=self.other_team)

        self.assert_counts(
            self.chart(team=self.team),
            {"Phone": 2, "WhatsApp": 1},
        )

    def test_agent_sees_assigned_tickets_only(self):
        self.make(f"{self.day} 10:00:00", "WhatsApp", 0, agent=self.agent)
        self.make(f"{self.day} 11:00:00", "Messenger", 0, agent=self.other)
        self.make(f"{self.day} 12:00:00", "Phone", 0, agent=self.agent)

        with self.set_user(self.agent):
            with self.assertRaises(frappe.PermissionError):
                get_dashboard_data(
                    "master",
                    {
                        "from_date": self.day,
                        "to_date": self.day,
                        "team": self.team,
                        "agent": self.agent,
                    },
                )

        self.assert_counts(
            self.chart(agent=self.agent, user=self.agent),
            {"WhatsApp": 1, "Phone": 1},
        )

    def test_customer_cannot_view_channel_chart(self):
        customer = create_contact("Channel Customer", unique_email("channel-dash"))
        with self.set_user(customer["user"]):
            with self.assertRaises(frappe.PermissionError):
                get_dashboard_data(
                    "master",
                    {
                        "from_date": self.day,
                        "to_date": self.day,
                        "agent": customer["user"],
                    },
                )

    def test_missing_source_column_falls_back_to_portal_and_email(self):
        self.make(f"{self.day} 10:00:00", "WhatsApp", 0)
        self.make(f"{self.day} 11:00:00", "WhatsApp", 1)
        self.make(f"{self.day} 12:00:00", None, 1)
        self.make(f"{self.day} 13:00:00", None, 0)
        with patch(
            "helpdesk.api.dashboard._hd_ticket_has_source_channel",
            return_value=False,
        ):
            chart = self.chart(team=self.team)
        self.assert_counts(chart, {"Portal": 2, "Email": 2})

    def make(self, when, channel, portal, team=None, agent=None):
        with self.freeze_time(when):
            ticket = make_ticket(subject="Channel chart", via_customer_portal=portal)
        values = {"agent_group": team or self.team}
        if agent:
            values["_assign"] = json.dumps([agent])
        if channel is not None:
            values["inchaa_source_channel"] = channel
        frappe.db.set_value("HD Ticket", ticket.name, values, update_modified=False)
        return ticket

    def chart(self, team=None, agent=None, user=None):
        filters = {"from_date": self.day, "to_date": self.day}
        if team:
            filters["team"] = team
        if agent:
            filters["agent"] = agent
        with self.set_user(user or self.manager):
            charts = get_dashboard_data("master", filters)
        return next(chart for chart in charts if chart["key"] == "tickets_by_channel")

    def assert_counts(self, chart, expected):
        actual = {row["channel"]: row["count"] for row in chart["data"]}
        self.assertEqual(actual, expected)
        self.assertEqual(
            [(row["channel"], row["count"]) for row in chart["data"]],
            sorted(expected.items(), key=lambda item: (-item[1], item[0])),
        )
        total = sum(expected.values())
        self.assertEqual(sum(actual.values()), total)
        self.assertAlmostEqual(
            sum(count / total * 100 for count in actual.values()),
            100.0,
        )
        self.assertEqual(chart["type"], "donut")
        self.assertEqual(chart["category"], "channel")
        self.assertEqual(chart["value"], "count")
        self.assertEqual(chart["maxSlices"], 12)
        self.assertNotIn("Should Not Appear", actual)
