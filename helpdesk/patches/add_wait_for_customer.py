import frappe
from frappe.custom.doctype.custom_field.custom_field import create_custom_fields


def execute():
	"""Remember an explicit 'Reply and wait for customer' until that send settles."""
	create_custom_fields(
		{
			"HD Ticket": [
				{
					"fieldname": "inchaa_wait_for_customer",
					"label": "Wait for customer",
					"fieldtype": "Check",
					"insert_after": "status",
					"hidden": 1,
					"read_only": 1,
					"no_copy": 1,
				},
				{
					"fieldname": "inchaa_wait_requested_on",
					"label": "Wait requested on",
					"fieldtype": "Datetime",
					"insert_after": "inchaa_wait_for_customer",
					"hidden": 1,
					"read_only": 1,
					"no_copy": 1,
				},
			]
		},
		update=True,
	)
