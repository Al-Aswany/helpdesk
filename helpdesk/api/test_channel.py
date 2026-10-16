import json
from unittest.mock import patch

import frappe
from frappe.tests.utils import FrappeTestCase

from helpdesk.api import channel
from helpdesk.helpdesk.doctype.hd_ticket.api import (
    get_ticket_activities,
    get_ticket_contact,
)
from helpdesk.test_utils import (
    create_agent,
    create_user,
    make_ticket,
    patch_channel_providers,
)

AGENT = "helpdesk-channel-agent@example.com"
OUTSIDER = "helpdesk-channel-outsider@example.com"
THIS_MODULE = "helpdesk.api.test_channel"

# The module doubles as the provider: Helpdesk resolves it from the hook value only.
CLAIMED: set[str] = set()
SENT: list[dict] = []
RESULT: dict = {}


def get_ticket_channel(ticket):
    if ticket not in CLAIMED:
        return None
    return {
        "label": "Fake Chat",
        "icon": "message_circle",
        "status": "ready",
        "contact": {"name": "Ada", "identity": "+15550001", "wa_id": "15550001"},
        "account": {"label": "Main"},
        "reply": {"enabled": True, "max_length": "4096"},
        "window": {"open": True, "seconds_left": 120},
        "capabilities": {"text": True, "media": 1, "templates": 0},
        "access_token": "must-not-leak",
        "outbound": [
            {
                "name": "OUT-1",
                "state": "Queued",
                "body": "hi",
                "provider_message_id": "wamid.X",
            },
            "not a row",
        ],
    }


def send_ticket_reply(ticket, message, request_id):
    SENT.append({"ticket": ticket, "message": message, "request_id": request_id})
    return {
        "ok": True,
        "state": "Queued",
        "request_id": request_id,
        "message": message,
        "secret": "must-not-leak",
        **RESULT,
    }


class TestTicketChannel(FrappeTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        create_agent(AGENT)
        create_user(OUTSIDER)
        cls.ticket = make_ticket(subject="Channel ticket")
        cls.email_ticket = make_ticket(
            subject="Email ticket", raised_by="person@example.com"
        )
        cls.technical_ticket = make_ticket(
            subject="Technical", raised_by="wa-abc@channel.invalid"
        )

    def setUp(self):
        CLAIMED.clear()
        SENT.clear()
        RESULT.clear()
        frappe.set_user(AGENT)

    def tearDown(self):
        frappe.set_user("Administrator")

    def test_hook_values_are_parsed_defensively(self):
        declared = {
            "Bad Key": ["os.path"],
            "empty": [],
            "listed": ["first.module", "last.module"],
            "plain": "plain.module",
            "blank": "",
        }
        real = frappe.get_hooks

        def hooks(hook=None, *args, **kwargs):
            return declared if hook == channel.HOOK else real(hook, *args, **kwargs)

        with patch.object(frappe, "get_hooks", side_effect=hooks):
            self.assertEqual(
                channel.registered_providers(),
                {"listed": "last.module", "plain": "plain.module"},
            )
        with patch.object(frappe, "get_hooks", return_value=[]):
            self.assertEqual(channel.registered_providers(), {})

    def test_without_a_provider_every_ticket_is_unchanged(self):
        with patch.object(channel, "registered_providers", return_value={}):
            for ticket in (self.ticket, self.email_ticket, self.technical_ticket):
                self.assertIsNone(channel.get_ticket_channel(ticket.name))
                self.assertNotIn("channel", get_ticket_activities(ticket.name))
        activities = get_ticket_activities(self.email_ticket.name)
        self.assertEqual(
            set(activities), {"comments", "communications", "history", "views", "calls"}
        )

    def test_contact_of_a_technical_identity_never_shows_the_placeholder(self):
        CLAIMED.add(self.technical_ticket.name)
        with patch_channel_providers(THIS_MODULE):
            contact = get_ticket_contact(self.technical_ticket.name)
        self.assertEqual(contact["name"], "Ada")
        self.assertEqual(contact["email_id"], "")
        self.assertNotIn("invalid", json.dumps(contact))
        self.assertNotIn("wa-abc", json.dumps(contact))

        # No provider claims the ticket (connector absent or failing): still no
        # placeholder, and no email address to write to.
        with patch.object(channel, "registered_providers", return_value={}):
            contact = get_ticket_contact(self.technical_ticket.name)
        self.assertEqual(contact["email_id"], "")
        self.assertNotIn("invalid", json.dumps(contact))
        self.assertNotIn("wa-abc", json.dumps(contact))

    def test_contact_of_an_email_ticket_is_unchanged(self):
        with patch_channel_providers(THIS_MODULE):
            contact = get_ticket_contact(self.email_ticket.name)
        self.assertEqual(contact["email_id"], "person@example.com")
        self.assertEqual(contact["name"], "person")

    def test_descriptor_keeps_only_documented_plain_values(self):
        CLAIMED.add(self.ticket.name)
        with patch_channel_providers(THIS_MODULE):
            descriptor = channel.get_ticket_channel(self.ticket.name)
        self.assertEqual(descriptor["key"], "fake")
        self.assertEqual(descriptor["label"], "Fake Chat")
        self.assertEqual(descriptor["icon"], "message_circle")
        self.assertEqual(descriptor["status"], "ready")
        self.assertEqual(
            descriptor["contact"], {"name": "Ada", "identity": "+15550001"}
        )
        self.assertEqual(descriptor["reply"], {"enabled": True, "max_length": 4096})
        self.assertEqual(descriptor["window"]["seconds_left"], 120)
        self.assertEqual(
            descriptor["capabilities"],
            {"text": True, "media": True, "templates": False},
        )
        self.assertEqual(len(descriptor["outbound"]), 1)
        self.assertEqual(set(descriptor["outbound"][0]), set(channel._OUTBOUND_FIELDS))
        blob = json.dumps(descriptor)
        for leaked in ("must-not-leak", "wamid.X", "wa_id", "access_token"):
            self.assertNotIn(leaked, blob)

    def test_unknown_status_is_unavailable_and_cannot_enable_a_reply(self):
        descriptor = channel.clean_descriptor(
            "fake", {"status": "ok", "reply": {"enabled": True}, "reason": "Not A Slug"}
        )
        self.assertEqual(descriptor["status"], "unavailable")
        self.assertFalse(descriptor["reply"]["enabled"])
        self.assertIsNone(descriptor["reason"])
        unavailable = channel.clean_descriptor(
            "fake",
            {
                "status": "unavailable",
                "reason": "account_paused",
                "reply": {"enabled": True},
            },
        )
        self.assertEqual(unavailable["reason"], "account_paused")
        self.assertFalse(unavailable["reply"]["enabled"])
        with self.assertRaises(TypeError):
            channel.clean_descriptor("fake", ["not", "a", "dict"])

    def test_long_text_is_bounded(self):
        descriptor = channel.clean_descriptor(
            "fake", {"label": "x" * 500, "contact": {"name": "y" * 500}}
        )
        self.assertEqual(len(descriptor["label"]), 140)
        self.assertEqual(len(descriptor["contact"]["name"]), 140)

    def test_activities_embed_the_descriptor_and_the_communication_medium(self):
        CLAIMED.add(self.ticket.name)
        with patch_channel_providers(THIS_MODULE):
            activities = get_ticket_activities(self.ticket.name)
        self.assertEqual(activities["channel"]["key"], "fake")
        self.assertTrue(
            all("communication_medium" in row for row in activities["communications"])
        )
        with patch_channel_providers(THIS_MODULE):
            self.assertNotIn("channel", get_ticket_activities(self.email_ticket.name))

    def test_provider_failure_is_contained_and_fails_closed_only_for_technical_tickets(
        self,
    ):
        with patch_channel_providers(THIS_MODULE), patch.object(
            channel.frappe, "log_error"
        ) as logged, patch(
            f"{THIS_MODULE}.get_ticket_channel", side_effect=RuntimeError("boom")
        ):
            technical = channel.get_ticket_channel(self.technical_ticket.name)
            email = channel.get_ticket_channel(self.email_ticket.name)
            activities = get_ticket_activities(self.technical_ticket.name)
        self.assertEqual(logged.call_count, 3)
        self.assertEqual(
            (technical["key"], technical["status"], technical["reason"]),
            ("fake", "unavailable", "lookup_failed"),
        )
        self.assertFalse(technical["reply"]["enabled"])
        self.assertIsNone(email)
        self.assertEqual(activities["channel"]["status"], "unavailable")

    def test_a_provider_without_the_required_functions_is_ignored(self):
        with patch.object(
            channel,
            "registered_providers",
            return_value={"fake": "helpdesk.api.ticket"},
        ):
            self.assertIsNone(channel.load_provider("fake"))
            self.assertIsNone(channel.get_ticket_channel(self.ticket.name))

    def test_reply_is_dispatched_by_key_with_only_ticket_message_and_request_id(self):
        RESULT["state"] = "Blocked"
        with patch_channel_providers(THIS_MODULE):
            result = channel.send_channel_reply(
                self.ticket.name,
                "fake",
                "Hello",
                "11111111-1111-4111-8111-111111111111",
            )
        self.assertEqual(
            SENT,
            [
                {
                    "ticket": self.ticket.name,
                    "message": "Hello",
                    "request_id": "11111111-1111-4111-8111-111111111111",
                }
            ],
        )
        self.assertEqual(set(result), set(channel._RESULT_FIELDS))
        self.assertEqual(result["state"], "Blocked")
        self.assertNotIn("secret", result)

    def test_a_request_cannot_select_a_callable_or_add_routing(self):
        with patch_channel_providers(THIS_MODULE):
            for key in (THIS_MODULE, "os.system", "../fake", "", "email"):
                with self.assertRaises(frappe.ValidationError):
                    channel.send_channel_reply(self.ticket.name, key, "Hi", "id")
            with self.assertRaises(TypeError):
                channel.send_channel_reply(
                    self.ticket.name, "fake", "Hi", "id", to="15550001"
                )
        self.assertEqual(SENT, [])

    def test_reply_and_read_require_ticket_permission_before_the_provider_runs(self):
        CLAIMED.add(self.ticket.name)
        frappe.set_user(OUTSIDER)
        with patch_channel_providers(THIS_MODULE):
            with self.assertRaises(frappe.PermissionError):
                channel.send_channel_reply(self.ticket.name, "fake", "Hi", "id")
            with self.assertRaises(frappe.PermissionError):
                channel.get_channel(self.ticket.name, "fake")
        frappe.set_user("Guest")
        with patch_channel_providers(THIS_MODULE):
            with self.assertRaises(frappe.PermissionError):
                channel.send_channel_reply(self.ticket.name, "fake", "Hi", "id")
        self.assertEqual(SENT, [])

    def test_get_channel_filters_by_key_and_never_sends(self):
        CLAIMED.add(self.ticket.name)
        with patch_channel_providers(THIS_MODULE):
            self.assertEqual(
                channel.get_channel(self.ticket.name, "fake")["key"], "fake"
            )
            self.assertIsNone(channel.get_channel(self.ticket.name, "other"))
            self.assertIsNone(channel.get_channel(self.email_ticket.name, "fake"))
            with self.assertRaises(frappe.DoesNotExistError):
                channel.get_channel("no-such-ticket-9999999", "fake")
        self.assertEqual(SENT, [])

    def test_a_malformed_provider_result_is_refused(self):
        with patch_channel_providers(THIS_MODULE), patch(
            f"{THIS_MODULE}.send_ticket_reply", return_value="ok"
        ):
            with self.assertRaises(frappe.ValidationError):
                channel.send_channel_reply(self.ticket.name, "fake", "Hi", "id")

    def test_technical_identity_is_the_reserved_invalid_suffix(self):
        self.assertTrue(channel.is_technical_identity("wa-1@x.invalid"))
        self.assertTrue(channel.is_technical_identity(" WA-1@X.INVALID "))
        self.assertFalse(channel.is_technical_identity("a@invalid.example.com"))
        self.assertFalse(channel.is_technical_identity(None))
        self.assertFalse(channel.is_technical_identity(""))
