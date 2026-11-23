from typing import Literal

import frappe
from frappe import _
from frappe.core.api.user_invitation import invite_by_email
from frappe.desk.reportview import delete_bulk
from frappe.model.rename_doc import rename_doc

from helpdesk.api.channel import is_technical_identity
from frappe.utils import validate_phone_number_with_country_code

from helpdesk.utils import (
    agent_only,
    get_country_from_timezone,
    get_customers,
    is_agent_manager,
)


@frappe.whitelist(methods=["GET"])
def search_contacts(
    txt: str, additional_filters: str | list | None = None
) -> list[dict[Literal["full_name", "name", "email_id"], str]]:
    doctype = "Contact"
    filters: list[list] = [[doctype, "email_id", "is", "set"]]
    if additional_filters:
        if isinstance(additional_filters, str):
            additional_filters = frappe.parse_json(additional_filters)
        filters.extend(additional_filters)
    or_filters: list[list[str]] = []
    search_fields = ["full_name", "email_id", "name"]
    if txt:
        for field in search_fields:
            or_filters.append([doctype, field, "like", f"%{txt}%"])
    return frappe.get_list(
        doctype,
        filters=filters,
        fields=search_fields,
        or_filters=or_filters,
        limit_start=0,
        limit_page_length=10,
        order_by="email_id, full_name, name",
        ignore_permissions=False,
        strict=False,
    )


@frappe.whitelist()
@agent_only
def find_contacts(txt: str = "") -> list[dict]:
    """Contacts by name, email or phone, including customers with no email."""
    txt = (txt or "").strip()
    or_filters = []
    if txt:
        digits = "".join(ch for ch in txt if ch.isdigit())
        or_filters = [["full_name", "like", f"%{txt}%"], ["email_id", "like", f"%{txt}%"]]
        if len(digits) >= 4:
            or_filters += [
                ["mobile_no", "like", f"%{digits}%"],
                ["phone", "like", f"%{digits}%"],
            ]
    rows = frappe.get_list(
        "Contact",
        fields=["name", "full_name", "email_id", "mobile_no", "phone"],
        or_filters=or_filters,
        order_by="modified desc",
        limit_page_length=10,
    )
    # Channel contacts carry a placeholder address that means nothing to an agent.
    for row in rows:
        if is_technical_identity(row.email_id):
            row.email_id = ""
    return rows


@frappe.whitelist(methods=["POST"])
def merge_contacts(source: str, target: str) -> str:
    """Move everything of ``source`` onto ``target``, then delete ``source``. Cannot be undone."""
    if not is_agent_manager():
        frappe.throw(_("Only an Agent Manager can merge contacts."), frappe.PermissionError)
    if not source or not target or source == target:
        frappe.throw(_("Choose two different contacts."), frappe.ValidationError)
    for name in (source, target):
        if not frappe.db.exists("Contact", name):
            frappe.throw(_("Contact {0} not found.").format(name), frappe.DoesNotExistError)

    # A merge moves links but deletes the source's own rows, so they are copied first.
    _copy_contact_details(source, target)
    open_source = frappe.db.get_value("HD Callback", {"open_contact": source}, "name")
    open_target = frappe.db.get_value("HD Callback", {"open_contact": target}, "name")
    rename_doc(
        "Contact", source, target, merge=True, force=True, ignore_permissions=True, show_alert=False
    )
    if open_source:
        _settle_open_callback(open_source, open_target, target)
    _refresh_outreach(target)
    return target


def _copy_contact_details(source: str, target: str) -> None:
    old = frappe.get_doc("Contact", source)
    new = frappe.get_doc("Contact", target)
    emails = {row.email_id.lower() for row in new.email_ids if row.email_id}
    for row in old.email_ids:
        if row.email_id and row.email_id.lower() not in emails:
            new.append("email_ids", {"email_id": row.email_id, "is_primary": not emails})
            emails.add(row.email_id.lower())
    phones = {_digits(row.phone) for row in new.phone_nos if row.phone}
    for row in old.phone_nos:
        if row.phone and _digits(row.phone) not in phones:
            new.append(
                "phone_nos",
                {"phone": row.phone, "is_primary_phone": not phones, "is_primary_mobile_no": not phones},
            )
            phones.add(_digits(row.phone))
    linked = {(row.link_doctype, row.link_name) for row in new.links}
    for row in old.links:
        if (row.link_doctype, row.link_name) not in linked:
            new.append("links", {"link_doctype": row.link_doctype, "link_name": row.link_name})
    if not new.user and old.user:
        new.user = old.user
    new.save(ignore_permissions=True)


def _digits(phone: str) -> str:
    return "".join(ch for ch in phone if ch.isdigit())


def _settle_open_callback(moved: str, kept: str | None, target: str) -> None:
    """A contact has one open callback: the source's joins the target, unless it has one."""
    if not kept:
        frappe.db.set_value("HD Callback", moved, "open_contact", target)
        return
    frappe.db.set_value(
        "HD Callback",
        moved,
        {
            "open_contact": None,
            "outcome": "Cancelled",
            "result_note": _("Contact merged. Callback {0} stays open.").format(kept),
            "completed_at": frappe.utils.now_datetime(),
            "completed_by": frappe.session.user,
        },
    )


def _refresh_outreach(contact: str) -> None:
    try:
        from inchaa_custmization.integrations.ziwo.outreach import refresh_contact_summary
    except ImportError:
        return
    refresh_contact_summary(contact)


@frappe.whitelist()
def delete_contact(name: str, delete_tickets: bool = False):
    frappe.has_permission("Contact", "delete", throw=True)

    tickets = frappe.get_list("HD Ticket", filters={"contact": name}, pluck="name")
    frappe.has_permission("HD Ticket", "write", throw=True)
    if len(tickets) > 0:
        frappe.db.set_value("HD Ticket", tickets, "contact", None)

    if delete_tickets:
        frappe.has_permission("HD Ticket", "delete", throw=True)
        delete_bulk("HD Ticket", tickets)

    unlink_from_customers(name)

    frappe.db.set_value(
        "User Invitation",
        {"contact": name, "app_name": "helpdesk"},
        "contact",
        None,
    )
    frappe.delete_doc("Contact", name)


def unlink_from_customers(name: str):
    customers = frappe.get_all(
        "HD Customer Member",
        filters={"contact_name": name},
        pluck="parent",
    )

    for customer in customers:
        customer_doc = frappe.get_doc("HD Customer", customer)
        customer_doc.remove_contact(name)
        customer_doc.save()


@frappe.whitelist()
def create_contact(doc: dict, invite: bool = False) -> str:
    frappe.has_permission("Contact", "create", throw=True)
    phone = doc.get("phone")
    if phone:
        validate_phone_number_with_country_code(phone, "Phone")

    contact_doc = frappe.get_doc(
        {
            "doctype": "Contact",
            "first_name": doc.get("first_name"),
            "last_name": doc.get("last_name"),
            "image": doc.get("image"),
        }
    )

    if email := doc.get("email"):
        contact_doc.append("email_ids", {"email_id": email, "is_primary": True})

    if phone:
        contact_doc.append(
            "phone_nos",
            {"phone": phone, "is_primary_phone": True, "is_primary_mobile_no": True},
        )

    contact_doc.insert()
    if invite:
        invite_by_email(
            email,
            ["HD Customer"],
            redirect_to_path="/helpdesk",
            app_name="helpdesk",
            contact=contact_doc.name,
            customer=doc.get("customer"),
        )
        contact_doc.reload()

    return contact_doc.get("name")


@frappe.whitelist(methods=["POST"])
def edit_contact(name: str, doc: dict):
    frappe.has_permission("Contact", "write", throw=True)
    contact_doc = frappe.get_doc("Contact", name)

    contact_doc.first_name = doc.get("first_name", contact_doc.first_name)
    contact_doc.last_name = doc.get("last_name", contact_doc.last_name)
    contact_doc.image = doc.get("image", contact_doc.image)

    email_ids = doc.get("email_ids")
    if email_ids is not None:
        contact_doc.email_ids = []
        for e in email_ids:
            contact_doc.append(
                "email_ids",
                {"email_id": e.get("email_id"), "is_primary": e.get("is_primary")},
            )

    phone_nos = doc.get("phone_nos")
    if phone_nos is not None:
        for index, p in enumerate(phone_nos, start=1):
            if phone := p.get("phone"):
                validate_phone_number_with_country_code(phone, f"Phone-row {index}")
        contact_doc.phone_nos = []
        for p in phone_nos:
            contact_doc.append(
                "phone_nos",
                {
                    "phone": p.get("phone"),
                    "is_primary_phone": p.get("is_primary"),
                    "is_primary_mobile_no": p.get("is_primary"),
                },
            )

    contact_doc.save()

    if user := contact_doc.get("user"):
        user_doc = frappe.get_doc("User", user)
        user_doc.user_image = doc.get("image", user_doc.user_image)
        user_doc.time_zone = doc.get("timezone", user_doc.time_zone)
        # the caller passed the Contact write check, and only the photo and timezone change
        user_doc.save(ignore_permissions=True)

    return contact_doc.name


@frappe.whitelist(methods=["GET"])
def get_contact_info(name: str) -> dict:
    frappe.has_permission("Contact", "read", doc=name, throw=True)
    contact = frappe.get_doc("Contact", name)
    primary_email = contact.email_ids[0].email_id if contact.email_ids else None

    result = {
        "customers": get_customers_with_image(name),
        "last_seen": None,
    }
    if not contact.user and (invite := get_invitation(name, primary_email)):
        result["invitation"] = invite

    if contact.user:
        user = frappe.db.get_value(
            "User", contact.user, ["time_zone", "last_active"], as_dict=True
        )
        result["last_seen"] = user.last_active
        if user.time_zone:
            result["timezone"] = user.time_zone
            result["country"] = get_country_from_timezone(user.time_zone)
    return result


def get_customers_with_image(name: str) -> list[dict]:
    customers = get_customers(contact=name)
    fields = ["name", "image"]
    if frappe.db.has_column("HD Customer", "custom_company_type"):
        fields.append("custom_company_type")
    rows = (
        {
            row.name: row
            for row in frappe.get_all(
                "HD Customer",
                filters={"name": ["in", customers]},
                fields=fields,
                limit=len(customers),
            )
        }
        if customers
        else {}
    )
    return [
        {
            "name": customer,
            "image": (rows.get(customer) or {}).get("image"),
            "company_type": (rows.get(customer) or {}).get("custom_company_type") or "",
        }
        for customer in customers
    ]


def get_invitation(name: str, email: str | None) -> dict | None:
    if not email:
        return None
    return frappe.db.get_value(
        "User Invitation",
        {
            "contact": name,
            "status": ["!=", "Accepted"],
            "email": email,
            "app_name": "helpdesk",
        },
        ["name", "status"],
        as_dict=True,
        order_by="creation desc",
    )
