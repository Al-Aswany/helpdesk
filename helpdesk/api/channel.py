"""Optional bridge for tickets that are not answered by email.

An installed app can own a non-email conversation channel by registering a
provider in its ``hooks.py``::

    helpdesk_ticket_channel_providers = {"whatsapp": "my_app.channels.whatsapp"}

The provider module implements two functions:

``get_ticket_channel(ticket) -> dict | None``
    ``None`` when the ticket does not belong to this channel. Otherwise a
    descriptor (see ``clean_descriptor`` for the accepted keys).
``send_ticket_reply(ticket, message, request_id) -> dict``
    Queue one public reply. Idempotency, permissions, routing and delivery are
    the provider's job. Helpdesk never learns the recipient or the credentials.

Only the key is visible to the browser. The module path comes from ``hooks.py``,
so a request cannot select a callable. Without a provider every ticket behaves
exactly as before.
"""

import re

import frappe
from frappe import _

HOOK = "helpdesk_ticket_channel_providers"
KEY_PATTERN = re.compile(r"^[a-z][a-z0-9_]{0,31}$")
STATUSES = ("ready", "unavailable")
# ".invalid" is reserved (RFC 2606): an address under it can never receive mail.
TECHNICAL_SUFFIX = ".invalid"

_TEXT_LIMIT = 140
_OUTBOUND_LIMIT = 200
_OUTBOUND_FIELDS = (
    "name",
    "request_key",
    "state",
    "reason",
    "error_summary",
    "communication",
    "body",
    "creation",
    "queued_at",
    "sending_started_at",
    "accepted_at",
    "completed_at",
)
_RESULT_FIELDS = (
    "ok",
    "state",
    "reason",
    "outbox",
    "error",
    "communication",
    "request_id",
    "message",
)


def is_technical_identity(address: str | None) -> bool:
    """True for an address that exists only to satisfy ticket validation."""
    return bool(address) and str(address).strip().lower().endswith(TECHNICAL_SUFFIX)


def registered_providers() -> dict[str, str]:
    """``{key: module path}`` from hooks. Malformed entries are ignored."""
    declared = frappe.get_hooks(HOOK) or {}
    if not isinstance(declared, dict):
        return {}
    providers = {}
    for key, value in declared.items():
        if isinstance(value, list | tuple):
            value = value[-1] if value else None
        if isinstance(key, str) and KEY_PATTERN.match(key) and isinstance(value, str) and value:
            providers[key] = value
    return providers


def load_provider(key: str):
    """The provider module for a registered key, or ``None``."""
    path = registered_providers().get(key or "")
    if not path:
        return None
    try:
        module = frappe.get_module(path)
    except ImportError:
        frappe.log_error(
            title="Ticket channel provider cannot be imported",
            message=f"provider={key}\n{frappe.get_traceback()}",
        )
        return None
    if not callable(getattr(module, "get_ticket_channel", None)) or not callable(
        getattr(module, "send_ticket_reply", None)
    ):
        return None
    return module


def get_ticket_channel(ticket: str) -> dict | None:
    """The descriptor of the channel that owns ``ticket``, or ``None`` for email.

    The caller has already checked read permission. A provider that raises is
    logged and does not break the ticket page. A ticket with a technical address
    that no provider could describe gets an explicit unavailable descriptor, so
    the client never offers an email reply to an address that cannot receive it.
    """
    for key in sorted(registered_providers()):
        try:
            provider = load_provider(key)
            raw = provider.get_ticket_channel(ticket) if provider else None
            if raw is None:
                continue
            return clean_descriptor(key, raw)
        except Exception:
            frappe.log_error(
                title="Ticket channel provider failed",
                message=f"provider={key} ticket={ticket}\n{frappe.get_traceback()}",
            )
            if is_technical_identity(frappe.db.get_value("HD Ticket", ticket, "raised_by")):
                return clean_descriptor(
                    key, {"status": "unavailable", "reason": "lookup_failed"}
                )
    return None


def clean_descriptor(key: str, raw: dict) -> dict:
    """Keep only the documented keys, with bounded text and plain types.

    Descriptor keys: ``label``, ``icon``, ``status`` (ready or unavailable),
    ``reason``, ``contact`` (name, identity), ``account`` (label), ``reply``
    (enabled, max_length), ``window`` (open, reason, seconds_left), ``capabilities``
    (text, media, templates), ``current_ticket`` and ``outbound`` (rows).
    """
    if not isinstance(raw, dict):
        raise TypeError("a channel descriptor must be a dict")
    status = raw.get("status") if raw.get("status") in STATUSES else "unavailable"
    contact = _dict(raw.get("contact"))
    account = _dict(raw.get("account"))
    reply = _dict(raw.get("reply"))
    window = _dict(raw.get("window"))
    capabilities = _dict(raw.get("capabilities"))
    return {
        "key": key,
        "label": _text(raw.get("label")),
        "icon": _slug(raw.get("icon")),
        "status": status,
        "reason": _slug(raw.get("reason")),
        "contact": {
            "name": _text(contact.get("name")),
            "identity": _text(contact.get("identity")),
        },
        "account": {"label": _text(account.get("label"))},
        "reply": {
            "enabled": bool(reply.get("enabled")) and status == "ready",
            "max_length": _int(reply.get("max_length")),
        },
        "window": {
            "open": bool(window.get("open")),
            "reason": _slug(window.get("reason")),
            "seconds_left": _int(window.get("seconds_left")) or 0,
        },
        "capabilities": {
            "text": bool(capabilities.get("text")),
            "media": bool(capabilities.get("media")),
            "templates": bool(capabilities.get("templates")),
        },
        "current_ticket": _text(raw.get("current_ticket")) or None,
        "outbound": _outbound(raw.get("outbound")),
    }


def _outbound(rows) -> list[dict]:
    if not isinstance(rows, list | tuple):
        return []
    cleaned = []
    for row in list(rows)[-_OUTBOUND_LIMIT:]:
        if not isinstance(row, dict):
            continue
        item = {}
        for field in _OUTBOUND_FIELDS:
            value = row.get(field)
            item[field] = None if value is None else str(value)
        cleaned.append(item)
    return cleaned


def _dict(value) -> dict:
    return value if isinstance(value, dict) else {}


def _text(value, limit: int = _TEXT_LIMIT) -> str:
    return "" if value is None else str(value)[:limit]


def _slug(value) -> str | None:
    text = _text(value, 40)
    return text if re.fullmatch(r"[a-z][a-z0-9_]*", text) else None


def _int(value) -> int | None:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


@frappe.whitelist()
def get_channel(ticket: str, channel: str) -> dict | None:
    """Current descriptor for one registered channel. Never sends anything."""
    frappe.has_permission("HD Ticket", "read", ticket, throw=True)
    if not frappe.db.exists("HD Ticket", ticket):
        frappe.throw(_("Ticket not found"), frappe.DoesNotExistError)
    descriptor = get_ticket_channel(ticket)
    if descriptor and descriptor["key"] != channel:
        return None
    return descriptor


@frappe.whitelist(methods=["POST"])
def send_channel_reply(ticket: str, channel: str, message: str, request_id: str) -> dict:
    """Hand one public reply to the ticket's channel provider.

    Rendering and polling never reach this function. The provider decides the
    recipient and whether the reply may go out; nothing is taken from the client
    beyond the text and its idempotency key.
    """
    frappe.has_permission("HD Ticket", "write", ticket, throw=True)
    provider = load_provider(channel)
    if not provider:
        frappe.throw(_("This conversation channel is not available."), frappe.ValidationError)
    result = provider.send_ticket_reply(ticket=ticket, message=message, request_id=request_id)
    if not isinstance(result, dict):
        frappe.throw(_("The reply was not saved."), frappe.ValidationError)
    return {field: result.get(field) for field in _RESULT_FIELDS}
