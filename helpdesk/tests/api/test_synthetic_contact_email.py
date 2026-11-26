import frappe
from frappe.tests.utils import FrappeTestCase

from helpdesk.api.channel import customer_facing_email, is_synthetic_contact_email
from helpdesk.api.contact import edit_contact, find_contacts, mask_synthetic_contact_emails
from helpdesk.api.doc import get_list_data
from helpdesk.test_utils import create_agent, create_contact, make_ticket, unique_email, unique_name


DOMAINS = {
	"platform": "platform.inchaa.invalid",
	"fb": "fb.inchaa.invalid",
	"ig": "ig.inchaa.invalid",
	"wa": "wa.inchaa.invalid",
}


def _address(channel: str) -> str:
	prefix = {"platform": "c", "fb": "fb", "ig": "ig", "wa": "wa"}[channel]
	return f"{prefix}-{unique_name('id')}@{DOMAINS[channel]}"


class TestSyntheticContactEmail(FrappeTestCase):
	def setUp(self) -> None:
		frappe.set_user("Administrator")
		self.agent = create_agent(unique_email("synthetic-contact-agent")).name

	def tearDown(self) -> None:
		frappe.set_user("Administrator")

	def test_only_the_verified_domains_are_technical(self) -> None:
		for channel in DOMAINS:
			self.assertTrue(is_synthetic_contact_email(_address(channel)))
			self.assertTrue(is_synthetic_contact_email(_address(channel).upper()))
		self.assertFalse(is_synthetic_contact_email("wa-support@example.com"))
		self.assertFalse(is_synthetic_contact_email("c-ops@example.com"))
		self.assertFalse(is_synthetic_contact_email("person@example.com"))
		self.assertFalse(is_synthetic_contact_email("person@notinchaa.invalid"))
		self.assertFalse(is_synthetic_contact_email("person@wa.inchaa.invalid.example.com"))
		self.assertEqual(customer_facing_email("wa-support@example.com"), "wa-support@example.com")
		self.assertEqual(customer_facing_email(_address("wa")), "")
		real = unique_email("beside-technical")
		self.assertEqual(customer_facing_email(_address("ig"), [real]), real)

	def test_contacts_list_hides_a_technical_address_and_keeps_a_real_one(self) -> None:
		shown = {}
		stored = {}
		for channel in DOMAINS:
			technical = _address(channel)
			name = create_contact(f"Only {channel}", technical, user=False)["contact"]
			stored[channel] = (name, technical)
			shown[channel] = self._listed_email(name)
		self.assertEqual(shown, {channel: "" for channel in DOMAINS})
		for channel, (name, technical) in stored.items():
			self.assertEqual(frappe.db.get_value("Contact", name, "email_id"), technical)

		both_technical = _address("wa")
		both_real = unique_email("real-beside-wa")
		both = create_contact("Both Addresses", both_technical, user=False)["contact"]
		doc = frappe.get_doc("Contact", both)
		doc.append("email_ids", {"email_id": both_real, "is_primary": 0})
		doc.save(ignore_permissions=True)
		self.assertEqual(doc.email_id, both_technical)
		self.assertEqual(self._listed_email(both), both_real)

		plain = unique_email("wa-support")
		plain = plain.replace(plain.split("@", 1)[0], "wa-support")
		plain_name = create_contact("Prefix On Real Domain", plain, user=False)["contact"]
		self.assertEqual(self._listed_email(plain_name), plain)
		customer_prefix = unique_email("c-desk")
		customer_prefix = customer_prefix.replace(customer_prefix.split("@", 1)[0], "c-desk")
		prefix_name = create_contact("Platform Prefix", customer_prefix, user=False)["contact"]
		self.assertEqual(self._listed_email(prefix_name), customer_prefix)

		frappe.set_user(self.agent)
		row = next(row for row in find_contacts("Both Addresses") if row.name == both)
		self.assertEqual(row.email_id, both_real)
		hidden = next(row for row in find_contacts("Only wa") if row.name == stored["wa"][0])
		self.assertEqual(hidden.email_id, "")

	def test_adding_a_real_email_keeps_the_technical_identity_and_requester(self) -> None:
		technical = _address("fb")
		name = create_contact("Channel Requester", technical, user=False)["contact"]
		ticket = make_ticket(subject="Channel ticket", raised_by=technical, contact=name)
		self.assertEqual(ticket.raised_by, technical)
		added = unique_email("added-mailbox")
		edit_contact(
			name,
			{"first_name": "Channel Requester", "email_ids": [{"email_id": added, "is_primary": 1}]},
		)
		doc = frappe.get_doc("Contact", name)
		self.assertEqual(doc.email_id, technical)
		self.assertIn(technical, [row.email_id for row in doc.email_ids])
		self.assertIn(added, [row.email_id for row in doc.email_ids])
		ticket.reload()
		self.assertEqual(ticket.raised_by, technical)
		self.assertEqual(ticket.contact, name)
		self.assertEqual(self._listed_email(name), added)

	def _listed_email(self, name: str) -> str:
		frappe.set_user("Administrator")
		result = get_list_data(
			"Contact",
			filters={"name": name},
			rows=["name", "email_id", "full_name"],
			page_length=5,
		)
		row = next(item for item in result["data"] if item.name == name)
		mask_synthetic_contact_emails([row])
		return row.email_id or ""
