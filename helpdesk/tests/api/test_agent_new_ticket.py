import frappe
from frappe.tests.utils import FrappeTestCase

from helpdesk.api.contact import find_contacts
from helpdesk.helpdesk.doctype.hd_ticket.api import new
from helpdesk.test_utils import create_agent, create_contact, unique_email, unique_name


def phone_contact(number: str) -> str:
    return (
        frappe.get_doc(
            {
                "doctype": "Contact",
                "first_name": unique_name("Phone Caller"),
                "phone_nos": [{"phone": number, "is_primary_mobile_no": 1}],
            }
        )
        .insert(ignore_permissions=True)
        .name
    )


class TestAgentCreatesTicketForCustomer(FrappeTestCase):
    def setUp(self) -> None:
        frappe.set_user("Administrator")
        self.agent = create_agent(unique_email("new-ticket-agent")).name
        self.customer_email = unique_email("new-ticket-customer")
        self.contact = create_contact("New Ticket Customer", self.customer_email, user=False)[
            "contact"
        ]

    def tearDown(self) -> None:
        frappe.set_user("Administrator")

    def create(self, **doc):
        frappe.set_user(self.agent)
        return new({"subject": "Agent ticket", "description": "<p>Details</p>", **doc})

    def test_the_customer_is_the_requester(self) -> None:
        ticket = self.create(contact=self.contact)
        self.assertEqual(ticket.contact, self.contact)
        self.assertEqual(ticket.raised_by, self.customer_email)

    def test_a_phone_only_customer_keeps_the_agent_as_raised_by(self) -> None:
        contact = phone_contact("+971501110099")
        ticket = self.create(contact=contact)
        self.assertEqual(ticket.contact, contact)
        self.assertEqual(ticket.raised_by, self.agent)

    def test_a_ticket_without_a_customer_is_refused(self) -> None:
        with self.assertRaises(frappe.ValidationError):
            self.create()

    def test_a_missing_contact_is_refused(self) -> None:
        with self.assertRaises(frappe.DoesNotExistError):
            self.create(contact="no-such-contact")

    def test_a_portal_customer_still_raises_their_own_ticket(self) -> None:
        customer = create_contact("Portal Customer", unique_email("portal-customer"))
        frappe.set_user(customer["user"])
        ticket = new({"subject": "Portal ticket", "description": "<p>Help</p>"})
        self.assertEqual(ticket.raised_by, customer["user"])


class TestFindContacts(FrappeTestCase):
    def setUp(self) -> None:
        frappe.set_user("Administrator")
        self.agent = create_agent(unique_email("find-contacts-agent")).name

    def tearDown(self) -> None:
        frappe.set_user("Administrator")

    def test_a_phone_only_contact_is_found_by_its_digits(self) -> None:
        contact = phone_contact("+971501110098")
        frappe.set_user(self.agent)
        self.assertIn(contact, [row.name for row in find_contacts("50 111 0098")])

    def test_a_contact_is_found_by_email(self) -> None:
        email = unique_email("find-by-email")
        contact = create_contact("Find By Email", email, user=False)["contact"]
        frappe.set_user(self.agent)
        self.assertIn(contact, [row.name for row in find_contacts(email)])

    def test_a_channel_placeholder_address_is_not_shown(self) -> None:
        contact = create_contact("Channel Customer", f"wa-{unique_name('x')}@wa.inchaa.invalid", user=False)[
            "contact"
        ]
        frappe.set_user(self.agent)
        row = next(row for row in find_contacts("Channel Customer") if row.name == contact)
        self.assertEqual(row.email_id, "")

    def test_customers_cannot_search_contacts(self) -> None:
        customer = create_contact("Portal Searcher", unique_email("portal-searcher"))
        frappe.set_user(customer["user"])
        with self.assertRaises(frappe.PermissionError):
            find_contacts("a")
