from uuid import uuid4

import frappe
from frappe.desk.form.assign_to import add
from frappe.tests.utils import FrappeTestCase, change_settings
from frappe.utils import add_to_date, now_datetime

from helpdesk.api.follow_up import create_callback, get_queue, update_callback
from helpdesk.test_utils import create_agent, make_team, make_ticket


class TestHDCallback(FrappeTestCase):
    def setUp(self):
        suffix = frappe.generate_hash(length=8)
        self.agent = create_agent(f"callback-{suffix}@example.com").name
        self.other = create_agent(f"callback-other-{suffix}@example.com").name
        self.due_at = str(add_to_date(now_datetime(), hours=2))

    def test_creation_retry_and_duplicate_ziwo_reference(self):
        request_id = str(uuid4())
        source_reference = str(uuid4())
        args = (request_id, "+971 50 000 0000", self.due_at, "Follow up")
        with self.set_user(self.agent):
            callback = create_callback(*args, source_reference=source_reference)
            self.assertEqual(
                create_callback(*args, source_reference=source_reference), callback
            )
            with self.assertRaisesRegex(
                frappe.ValidationError, "A callback already exists"
            ):
                create_callback(
                    str(uuid4()),
                    args[1],
                    args[2],
                    args[3],
                    source_reference=source_reference.upper(),
                )
        self.assertEqual(
            frappe.db.get_value("HD Callback", callback, "phone"), "+971500000000"
        )

    def test_agent_cannot_access_someone_elses_standalone_callback(self):
        with self.set_user(self.agent):
            name = create_callback(
                str(uuid4()), "+971500000000", self.due_at, "Follow up"
            )
        modified = str(frappe.db.get_value("HD Callback", name, "modified"))
        with self.set_user(self.other):
            self.assertNotIn(name, {row.name for row in get_queue()["rows"]})
            with self.assertRaises(frappe.PermissionError):
                update_callback(name, "complete", modified, outcome="Reached")

    def test_claim_and_outcome_reject_a_stale_update(self):
        ticket = make_ticket()
        name = create_callback(
            str(uuid4()),
            "+971500000000",
            self.due_at,
            "Follow up",
            ticket.name,
            assigned_agent="",
        )
        modified = str(frappe.db.get_value("HD Callback", name, "modified"))
        with self.set_user(self.agent):
            update_callback(name, "claim", modified)
            with self.assertRaisesRegex(
                frappe.ValidationError, "This callback changed"
            ):
                update_callback(name, "complete", modified, outcome="Reached")
            modified = str(frappe.db.get_value("HD Callback", name, "modified"))
            update_callback(
                name, "complete", modified, outcome="Reached", note="Details confirmed"
            )
        row = frappe.db.get_value(
            "HD Callback",
            name,
            ["assigned_agent", "outcome", "completed_by"],
            as_dict=True,
        )
        self.assertEqual(
            (row.assigned_agent, row.outcome, row.completed_by),
            (self.agent, "Reached", self.agent),
        )

    def test_queue_uses_ticket_visibility_and_live_assignments(self):
        my_team = make_team(
            "Callback " + frappe.generate_hash(length=8), members=[self.agent]
        )
        other_team = make_team(
            "Callback " + frappe.generate_hash(length=8), members=[self.other]
        )
        for team in (my_team, other_team):
            frappe.db.set_value("Assignment Rule", team.assignment_rule, "disabled", 1)
        with change_settings("HD Settings", {"restrict_tickets_by_agent_group": 1}):
            visible = make_ticket(agent_group=my_team.name, status="Open")
            hidden = make_ticket(agent_group=other_team.name, status="Open")
            assigned = make_ticket(agent_group=my_team.name, status="Open")
            add(
                {
                    "doctype": "HD Ticket",
                    "name": assigned.name,
                    "assign_to": [self.agent],
                }
            )
            hidden_callback = create_callback(
                str(uuid4()),
                "+971500000000",
                self.due_at,
                "Follow up",
                hidden.name,
                assigned_agent="",
            )
            with self.set_user(self.agent):
                unassigned = {row.name for row in get_queue("unassigned")["rows"]}
                self.assertIn(visible.name, unassigned)
                self.assertNotIn(hidden.name, unassigned)
                self.assertNotIn(assigned.name, unassigned)
                self.assertNotIn(
                    hidden_callback, {row.name for row in get_queue()["rows"]}
                )
                with self.assertRaises(frappe.PermissionError):
                    create_callback(
                        str(uuid4()),
                        "+971500000000",
                        self.due_at,
                        "Follow up",
                        hidden.name,
                    )
