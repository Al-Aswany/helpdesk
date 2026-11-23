import frappe
from frappe.tests.utils import FrappeTestCase
from frappe.utils import add_to_date, now_datetime

from helpdesk.api.contact import merge_contacts
from helpdesk.test_utils import (
    create_agent,
    create_contact,
    make_agent_manager,
    make_ticket,
    unique_email,
    unique_name,
)


def phone_contact(number: str) -> str:
    return (
        frappe.get_doc(
            {
                "doctype": "Contact",
                "first_name": unique_name("Merge Caller"),
                "phone_nos": [{"phone": number, "is_primary_mobile_no": 1, "is_primary_phone": 1}],
            }
        )
        .insert(ignore_permissions=True)
        .name
    )


def open_callback(contact: str, phone: str) -> str:
    return (
        frappe.get_doc(
            {
                "doctype": "HD Callback",
                "phone": phone,
                "due_at": add_to_date(now_datetime(), days=1),
                "summary": "merge test",
                "contact": contact,
            }
        )
        .insert(ignore_permissions=True)
        .name
    )


class TestMergeContacts(FrappeTestCase):
    def setUp(self) -> None:
        frappe.set_user("Administrator")
        self.manager = make_agent_manager("merge-manager")
        self.email = unique_email("merge-target")
        self.target = create_contact("Merge Target", self.email, user=False)["contact"]
        self.source = phone_contact("+971501110201")

    def tearDown(self) -> None:
        frappe.set_user("Administrator")

    def merge(self):
        frappe.set_user(self.manager)
        return merge_contacts(self.source, self.target)

    def test_tickets_and_numbers_move_and_the_source_is_deleted(self) -> None:
        ticket = make_ticket(subject="merge ticket", raised_by=self.email)
        frappe.db.set_value("HD Ticket", ticket.name, "contact", self.source)

        self.assertEqual(self.merge(), self.target)

        self.assertFalse(frappe.db.exists("Contact", self.source))
        self.assertEqual(frappe.db.get_value("HD Ticket", ticket.name, "contact"), self.target)
        target = frappe.get_doc("Contact", self.target)
        self.assertIn("+971501110201", [row.phone for row in target.phone_nos])
        self.assertEqual(target.email_id, self.email)

    def test_the_only_open_callback_follows_the_contact(self) -> None:
        moved = open_callback(self.source, "+971501110201")
        self.merge()
        self.assertEqual(
            frappe.db.get_value("HD Callback", moved, ["contact", "open_contact"]),
            (self.target, self.target),
        )

    def test_a_second_open_callback_is_closed_and_the_target_keeps_its_own(self) -> None:
        moved = open_callback(self.source, "+971501110201")
        kept = open_callback(self.target, "+971501110202")
        self.merge()
        self.assertEqual(frappe.db.get_value("HD Callback", kept, "open_contact"), self.target)
        closed = frappe.db.get_value(
            "HD Callback", moved, ["open_contact", "outcome", "completed_at"], as_dict=True
        )
        self.assertIsNone(closed.open_contact)
        self.assertEqual(closed.outcome, "Cancelled")
        self.assertTrue(closed.completed_at)

    def test_an_agent_who_is_not_a_manager_cannot_merge(self) -> None:
        frappe.set_user(create_agent(unique_email("merge-agent")).name)
        with self.assertRaises(frappe.PermissionError):
            merge_contacts(self.source, self.target)
        frappe.set_user("Administrator")
        self.assertTrue(frappe.db.exists("Contact", self.source))

    def test_a_contact_cannot_merge_into_itself(self) -> None:
        frappe.set_user(self.manager)
        with self.assertRaises(frappe.ValidationError):
            merge_contacts(self.target, self.target)
