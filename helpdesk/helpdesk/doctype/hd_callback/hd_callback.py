from frappe.model.document import Document


class HDCallback(Document):
    def validate(self):
        # Empty stays NULL because this field is unique. MariaDB then allows every
        # ticket callback that has no contact, and only one open callback per contact.
        if self.contact and not self.completed_at:
            self.open_contact = self.contact
        else:
            self.open_contact = None
