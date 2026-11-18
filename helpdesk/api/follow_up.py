import re
from uuid import UUID

import frappe
from frappe import _
from frappe.query_builder import Order
from frappe.utils import cint, get_datetime, get_system_timezone, now_datetime

from helpdesk.utils import agent_only, is_agent, is_agent_manager

CALLBACK = "HD Callback"
TICKET = "HD Ticket"
PAGE_SIZE = 25
OUTCOMES = ("Reached", "No answer", "Cancelled")
CALLBACK_FIELDS = (
    "name",
    "phone",
    "ticket",
    "assigned_agent",
    "due_at",
    "summary",
    "source_reference",
    "outcome",
    "result_note",
    "modified",
    "completed_at",
)


@frappe.whitelist(methods=["GET"])
@agent_only
def get_queue(view: str = "pending", start: int = 0) -> dict:
    user = frappe.session.user
    manager = is_agent_manager(user)
    start = max(0, cint(start))
    if view == "unassigned":
        rows = _unassigned_tickets(start)
    elif view in ("pending", "completed"):
        callback = frappe.qb.DocType(CALLBACK)
        has_ticket = callback.ticket.notnull() & (callback.ticket != "")
        is_unassigned = callback.assigned_agent.isnull() | (
            callback.assigned_agent == ""
        )
        visible_ticket = frappe.qb.get_query(
            TICKET, fields=["name"], ignore_permissions=False
        )
        query = (
            frappe.qb.from_(callback)
            .select(*(callback[field] for field in CALLBACK_FIELDS))
            .where(~has_ticket | callback.ticket.isin(visible_ticket))
        )
        if not manager:
            query = query.where(
                (callback.assigned_agent == user) | (is_unassigned & has_ticket)
            )
        if view == "pending":
            query = query.where(callback.completed_at.isnull()).orderby(callback.due_at)
        else:
            query = query.where(callback.completed_at.notnull()).orderby(
                callback.completed_at, order=Order.desc
            )
        rows = (
            query.orderby(callback.name)
            .offset(start)
            .limit(PAGE_SIZE + 1)
            .run(as_dict=True)
        )
    else:
        frappe.throw(_("Unknown follow-up view."))

    return {
        "rows": rows[:PAGE_SIZE],
        "has_more": len(rows) > PAGE_SIZE,
        "page_size": PAGE_SIZE,
        "site_timezone": get_system_timezone(),
        "now": now_datetime(),
        "can_manage": manager,
        "current_user": user,
    }


def _unassigned_tickets(start: int) -> list:
    ticket = frappe.qb.DocType(TICKET)
    status = frappe.qb.DocType("HD Ticket Status")
    todo = frappe.qb.DocType("ToDo")
    unresolved = (
        frappe.qb.from_(status)
        .select(status.name)
        .where(status.category.isin(("Open", "Paused")))
    )
    assigned = (
        frappe.qb.from_(todo)
        .select(todo.reference_name)
        .where(
            (todo.reference_type == TICKET)
            & (todo.status == "Open")
            & todo.reference_name.notnull()
            & todo.allocated_to.notnull()
            & (todo.allocated_to != "")
        )
    )
    return (
        frappe.qb.get_query(
            TICKET,
            fields=[
                "name",
                "subject",
                "status",
                "priority",
                "agent_group",
                "creation",
                "response_by",
                "first_responded_on",
            ],
            ignore_permissions=False,
        )
        .where(
            ticket.status.isin(unresolved)
            & (ticket.is_merged == 0)
            & ticket.name.notin(assigned)
        )
        .orderby(ticket.creation, ticket.name)
        .offset(start)
        .limit(PAGE_SIZE + 1)
        .run(as_dict=True)
    )


@frappe.whitelist(methods=["GET"])
@agent_only
def get_callback_agents() -> list:
    if not is_agent_manager():
        frappe.throw(
            _("Only a manager can assign callbacks to other agents."),
            frappe.PermissionError,
        )
    agent = frappe.qb.DocType("HD Agent")
    user = frappe.qb.DocType("User")
    return (
        frappe.qb.from_(agent)
        .join(user)
        .on(user.name == agent.user)
        .select(user.name, agent.agent_name.as_("label"))
        .where((agent.is_active == 1) & (user.enabled == 1))
        .orderby(agent.agent_name, user.name)
        .run(as_dict=True)
    )


@frappe.whitelist(methods=["POST"])
@agent_only
def create_callback(
    request_id: str,
    phone: str,
    due_at: str,
    summary: str,
    ticket: str = "",
    assigned_agent: str | None = None,
    source_reference: str = "",
) -> str:
    user = frappe.session.user
    try:
        request_uuid = UUID(request_id)
    except ValueError:
        frappe.throw(_("Invalid callback request ID."))
    if request_uuid.version != 4:
        frappe.throw(_("Invalid callback request ID."))
    name = request_uuid.hex
    if frappe.db.exists(CALLBACK, {"name": name, "owner": user}):
        return name

    due_at = _future_due_at(due_at)
    phone = re.sub(r"[\s().-]", "", phone)
    if not re.fullmatch(r"\+[1-9][0-9]{1,14}", phone):
        frappe.throw(_("Enter a phone number with its international country code."))
    summary = _text(summary, required=True)
    ticket = ticket.strip()
    assigned_agent = user if assigned_agent is None else assigned_agent.strip()
    source_reference = source_reference.strip().lower() or None
    if source_reference and (
        len(source_reference) > 140 or any(char.isspace() for char in source_reference)
    ):
        frappe.throw(_("Enter a single ZIWO call reference of up to 140 characters."))
    if source_reference:
        existing = frappe.db.get_value(CALLBACK, {"source_reference": source_reference}, "name")
        if existing and existing != name:
            frappe.throw(_("A callback already exists for this ZIWO call reference."))
    if assigned_agent != user and not is_agent_manager(user):
        frappe.throw(
            _("Only a manager can assign callbacks to other agents."),
            frappe.PermissionError,
        )
    if ticket:
        _check_ticket(ticket, user)
    if assigned_agent:
        _check_assignee(assigned_agent, ticket)
    callback = frappe.get_doc(
        {
            "doctype": CALLBACK,
            "phone": phone,
            "due_at": due_at,
            "summary": summary,
            "ticket": ticket or None,
            "assigned_agent": assigned_agent or None,
            "source_reference": source_reference,
        }
    )
    frappe.db.savepoint("create_hd_callback")
    try:
        callback.insert(ignore_permissions=True, set_name=name)
    except (frappe.DuplicateEntryError, frappe.UniqueValidationError):
        frappe.db.rollback(save_point="create_hd_callback")
        if frappe.db.get_value(
            CALLBACK, {"name": name, "owner": user}, "name", for_update=True
        ):
            return name
        if source_reference:
            frappe.throw(_("A callback already exists for this ZIWO call reference."))
        raise
    return callback.name


@frappe.whitelist(methods=["POST"])
@agent_only
def update_callback(
    name: str,
    action: str,
    modified: str,
    assigned_agent: str = "",
    due_at: str = "",
    outcome: str = "",
    note: str = "",
) -> None:
    user = frappe.session.user
    manager = is_agent_manager(user)
    callback = _locked_callback(name)
    if (
        action == "claim"
        and callback.assigned_agent
        and callback.assigned_agent != user
    ):
        frappe.throw(_("This callback already has an assigned agent."))
    if not manager and callback.assigned_agent != user:
        if action != "claim" or callback.assigned_agent or not callback.ticket:
            frappe.throw(_("You cannot update this callback."), frappe.PermissionError)
    if callback.ticket:
        _check_ticket(callback.ticket, user)
    if (
        not modified
        or get_datetime(modified) != get_datetime(callback.modified)
        or callback.completed_at
    ):
        frappe.throw(_("This callback changed. Refresh the queue and try again."))

    if action == "claim":
        if callback.assigned_agent:
            frappe.throw(_("This callback already has an assigned agent."))
        _check_assignee(user, callback.ticket)
        callback.assigned_agent = user
    elif action == "assign" and manager:
        if assigned_agent:
            _check_assignee(assigned_agent, callback.ticket)
        callback.assigned_agent = assigned_agent or None
    elif action in ("reschedule", "complete") and callback.assigned_agent:
        callback.result_note = _text(note)
        if action == "reschedule":
            callback.due_at = _future_due_at(due_at)
        else:
            if outcome not in OUTCOMES:
                frappe.throw(_("Select a callback outcome."))
            callback.outcome = outcome
            callback.completed_at = now_datetime()
            callback.completed_by = user
    else:
        frappe.throw(
            _("You cannot perform this callback action."), frappe.PermissionError
        )
    callback.save(ignore_permissions=True)


def _locked_callback(name: str):
    """Lock the callback against the latest committed row.

    Permission checks earlier in the request open a snapshot. A second claim
    then hits MariaDB's "record has changed" error instead of seeing the
    winner. Outside tests, drop that read-only snapshot first. A test runs in
    one transaction, so rolling it back would discard the callback it just
    created.
    """
    if not frappe.flags.in_test:
        frappe.db.rollback()
    try:
        return frappe.get_doc(CALLBACK, name, for_update=True)
    except frappe.QueryDeadlockError:
        frappe.db.rollback()
        return frappe.get_doc(CALLBACK, name, for_update=True)


def _check_ticket(ticket: str, user: str) -> None:
    if not frappe.has_permission(TICKET, ptype="read", doc=ticket, user=user):
        frappe.throw(_("You cannot access this ticket."), frappe.PermissionError)


def _check_assignee(user: str, ticket: str | None) -> None:
    if not is_agent(user) or not frappe.db.get_value("User", user, "enabled"):
        frappe.throw(_("Select an active Helpdesk agent."))
    if ticket:
        _check_ticket(ticket, user)


def _future_due_at(value: str):
    try:
        due_at = get_datetime(value) if value else None
    except (ValueError, TypeError, OverflowError):
        due_at = None
    if not due_at or due_at.tzinfo or due_at <= now_datetime():
        frappe.throw(_("Choose a future callback time in the site time zone."))
    return due_at


def _text(value: str, required: bool = False) -> str:
    value = value.strip()
    if required and not value:
        frappe.throw(_("Enter a reason for the callback."))
    if len(value) > 1000:
        frappe.throw(_("Enter up to 1,000 characters."))
    return value
