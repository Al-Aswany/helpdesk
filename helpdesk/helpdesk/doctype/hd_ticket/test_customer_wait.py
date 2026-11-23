"""Ordinary Send keeps the status. Only a successful 'Reply and wait' pauses the SLA."""

from unittest.mock import patch

import frappe
from frappe.tests.utils import FrappeTestCase
from frappe.utils import add_to_date, now_datetime

from helpdesk.test_utils import make_ticket


def chat(ticket, direction):
	doc = frappe.get_doc(
		{
			"doctype": "Communication",
			"communication_type": "Communication",
			"communication_medium": "Chat",
			"sent_or_received": direction,
			"subject": "Re: wait",
			"sender": "agent@example.com" if direction == "Sent" else "customer@example.com",
			"content": "<p>hello</p>",
			"status": "Linked",
			"reference_doctype": "HD Ticket",
			"reference_name": ticket,
		}
	)
	doc.insert(ignore_permissions=True)
	return doc


class TestReplyAndWait(FrappeTestCase):
	def setUp(self):
		frappe.set_user("Administrator")
		self.ticket = make_ticket(subject="Wait for the customer")
		self.previous = frappe.db.get_value(
			"HD Settings",
			"HD Settings",
			["auto_update_status", "update_status_to", "enable_reply_email_via_agent"],
			as_dict=True,
		)
		frappe.db.set_single_value("HD Settings", "auto_update_status", 1)
		frappe.db.set_single_value("HD Settings", "update_status_to", "Replied")

	def tearDown(self):
		frappe.set_user("Administrator")
		for field in ("auto_update_status", "update_status_to", "enable_reply_email_via_agent"):
			frappe.db.set_single_value("HD Settings", field, self.previous.get(field))

	def reload(self):
		self.ticket.reload()
		return self.ticket

	def test_an_ordinary_send_keeps_the_status_even_when_auto_update_is_on(self):
		frappe.db.set_single_value("HD Settings", "enable_reply_email_via_agent", 0)
		self.ticket.reply_via_agent(message="<p>On it</p>", to="customer@example.com")
		ticket = self.reload()
		self.assertEqual(ticket.status, "Open")
		self.assertNotEqual(ticket.agreement_status, "Paused")

	def test_a_successful_wait_pauses_the_sla_and_a_customer_reply_resumes_it(self):
		self.assertTrue(self.ticket.sla)
		self.ticket.arm_customer_wait()
		chat(self.ticket.name, "Sent")
		ticket = self.reload()
		self.assertEqual(ticket.status, "Replied")
		self.assertEqual(ticket.status_category, "Paused")
		self.assertEqual(ticket.agreement_status, "Paused")
		self.assertIsNotNone(ticket.on_hold_since)
		self.assertFalse(ticket.inchaa_wait_for_customer)

		chat(self.ticket.name, "Received")
		ticket = self.reload()
		self.assertEqual(ticket.status, "Open")
		self.assertEqual(ticket.status_category, "Open")
		self.assertNotEqual(ticket.agreement_status, "Paused")
		self.assertIsNone(ticket.on_hold_since)

	def test_a_customer_reply_before_acceptance_stays_actionable(self):
		self.ticket.arm_customer_wait()
		chat(self.ticket.name, "Received")
		self.reload()
		self.assertEqual(self.ticket.status, "Open")
		self.assertFalse(self.ticket.inchaa_wait_for_customer)
		chat(self.ticket.name, "Sent")
		ticket = self.reload()
		self.assertEqual(ticket.status, "Open")
		self.assertNotEqual(ticket.agreement_status, "Paused")
		self.assertFalse(ticket.inchaa_wait_requested_on)

	def test_a_late_delivery_receipt_does_not_bury_a_newer_customer_reply(self):
		self.ticket.arm_customer_wait()
		sent = chat(self.ticket.name, "Sent")
		self.reload()
		self.assertEqual(self.ticket.status, "Replied")
		chat(self.ticket.name, "Received")
		self.reload()
		agent_reply = self.ticket.last_agent_response
		sent.reload()
		sent.save(ignore_permissions=True)
		ticket = self.reload()
		self.assertEqual(ticket.status, "Open")
		self.assertEqual(ticket.last_agent_response, agent_reply)
		self.assertGreater(ticket.last_customer_response, ticket.last_agent_response)

	def test_a_failed_email_send_does_not_pause_the_sla(self):
		frappe.db.set_single_value("HD Settings", "enable_reply_email_via_agent", 1)
		sender = frappe._dict(name="Test Outgoing", email_id="support@example.com")
		with (
			patch.object(
				type(self.ticket),
				"_resolve_sender_email",
				return_value=(sender, None),
			),
			patch.object(type(self.ticket), "_account_signature_fallback", return_value=""),
			patch("helpdesk.helpdesk.doctype.hd_ticket.hd_ticket.get_message_id", return_value="<m@test>"),
			patch("frappe.sendmail", side_effect=Exception("smtp down")),
		):
			with self.assertRaises(Exception):
				self.ticket.reply_via_agent(
					message="<p>This failed</p>",
					to="customer@example.com",
					from_email={"email_id": "support@example.com", "email_account": "Test Outgoing"},
					wait_for_customer=1,
				)
		ticket = self.reload()
		self.assertEqual(ticket.status, "Open")
		self.assertNotEqual(ticket.agreement_status, "Paused")
		self.assertFalse(ticket.inchaa_wait_for_customer)

	def test_a_successful_email_wait_pauses_after_the_message_is_handed_off(self):
		frappe.db.set_single_value("HD Settings", "enable_reply_email_via_agent", 1)
		sender = frappe._dict(name="Test Outgoing", email_id="support@example.com")
		with (
			patch.object(
				type(self.ticket),
				"_resolve_sender_email",
				return_value=(sender, None),
			),
			patch.object(type(self.ticket), "_account_signature_fallback", return_value=""),
			patch("helpdesk.helpdesk.doctype.hd_ticket.hd_ticket.get_message_id", return_value="<m@test>"),
			patch("frappe.sendmail", return_value=True),
		):
			self.ticket.reply_via_agent(
				message="<p>Please reply</p>",
				to="customer@example.com",
				from_email={"email_id": "support@example.com", "email_account": "Test Outgoing"},
				wait_for_customer=1,
			)
		ticket = self.reload()
		self.assertEqual(ticket.status, "Replied")
		self.assertEqual(ticket.agreement_status, "Paused")

	def test_a_failed_channel_send_clears_the_wait(self):
		from helpdesk.api.channel import send_channel_reply

		self.ticket.arm_customer_wait()
		with (
			patch("helpdesk.api.channel.get_ticket_channel", return_value={"key": "whatsapp"}),
			patch("helpdesk.api.channel.load_provider") as load,
		):
			load.return_value.send_ticket_reply.return_value = {
				"ok": False,
				"state": "Blocked",
				"reason": "outside_window",
			}
			send_channel_reply(
				self.ticket.name,
				"whatsapp",
				"hello",
				"request-1",
				wait_for_customer=1,
			)
		ticket = self.reload()
		self.assertEqual(ticket.status, "Open")
		self.assertFalse(ticket.inchaa_wait_for_customer)
		self.assertFalse(ticket.inchaa_wait_requested_on)
