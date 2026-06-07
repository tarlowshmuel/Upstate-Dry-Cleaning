import os
from flask import Flask, request
from twilio.twiml.messaging_response import MessagingResponse
from twilio.rest import Client

app = Flask(__name__)

# --- Twilio credentials (set as environment variables in Railway) ---
TWILIO_ACCOUNT_SID  = os.environ.get("TWILIO_ACCOUNT_SID")
TWILIO_AUTH_TOKEN   = os.environ.get("TWILIO_AUTH_TOKEN")
TWILIO_PHONE_NUMBER = os.environ.get("TWILIO_PHONE_NUMBER")  # +18456060022
ADMIN_PHONE_NUMBER  = os.environ.get("ADMIN_PHONE_NUMBER")   # Your personal cell

client = Client(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)

# ----------------------------------------------------------------
# In-memory storage (resets if app restarts — fine for getting started)
# ----------------------------------------------------------------
sessions      = {}   # { phone: { step, name, colony, address, contact_phone, notes } }
orders        = {}   # { order_id: { ... } }
next_order_id = 1

# Customer conversation steps in order
STEPS = ["name", "colony", "address", "items", "contact_phone", "notes", "confirm"]


def notify_admin(msg):
    client.messages.create(body=msg, from_=TWILIO_PHONE_NUMBER, to=ADMIN_PHONE_NUMBER)


def text_customer(to, msg):
    client.messages.create(body=msg, from_=TWILIO_PHONE_NUMBER, to=to)


@app.route("/sms", methods=["POST"])
def sms_webhook():
    global next_order_id

    from_number = request.form.get("From", "")
    body        = request.form.get("Body", "").strip()
    body_up     = body.upper()
    resp        = MessagingResponse()

    # ============================================================
    # ADMIN COMMANDS  (messages from your personal number)
    # ============================================================
    if from_number == ADMIN_PHONE_NUMBER:
        parts = body.split(maxsplit=2)
        cmd   = parts[0].upper() if parts else ""

        if cmd == "LIST":
            if not orders:
                resp.message("No orders yet.")
            else:
                lines = []
                for oid, o in orders.items():
                    ext = f" [EXT:{o['external_id']}]" if o.get("external_id") else ""
                    lines.append(f"#{oid}{ext} {o['name']} @ {o['colony']} | {o['status'].upper()}")
                resp.message("📋 Orders:\n" + "\n".join(lines))
            return str(resp)

        try:
            order_id = int(parts[1]) if len(parts) > 1 else None
            assert order_id is not None
        except (ValueError, AssertionError):
            resp.message(
                "Commands:\n"
                "LIST\n"
                "CONFIRM [#]\n"
                "SCHEDULE [#] [time]\n"
                "READY [#]\n"
                "CANCEL [#] [reason]\n"
                "EXT [#] [external-id]"
            )
            return str(resp)

        order = orders.get(order_id)
        if not order:
            resp.message(f"Order #{order_id} not found.")
            return str(resp)

        cphone = order["contact_phone"]
        cname  = order["name"]

        if cmd == "CONFIRM":
            order["status"] = "confirmed"
            text_customer(cphone,
                f"Hi {cname}! Your pickup request with Upstate Cleaning Service is confirmed. "
                f"We'll text you shortly with a pickup time.")
            resp.message(f"✅ #{order_id} confirmed. {cname} notified.")

        elif cmd == "SCHEDULE":
            time_str = parts[2] if len(parts) > 2 else ""
            if not time_str:
                resp.message("Include a time, e.g.: SCHEDULE 1 Tomorrow at 10am")
                return str(resp)
            order["status"] = "scheduled"
            text_customer(cphone,
                f"Hi {cname}! Your dry cleaning pickup is scheduled for {time_str}. "
                f"See you then! — Upstate Cleaning Service")
            resp.message(f"📅 #{order_id} scheduled for {time_str}. {cname} notified.")

        elif cmd == "READY":
            order["status"] = "ready"
            text_customer(cphone,
                f"Hi {cname}! Your cleaning is ready. "
                f"Reply to arrange delivery. — Upstate Cleaning Service")
            resp.message(f"👕 #{order_id} marked ready. {cname} notified.")

        elif cmd == "CANCEL":
            reason = parts[2] if len(parts) > 2 else ""
            order["status"] = "cancelled"
            msg = f"Hi {cname}, your pickup request has been cancelled."
            if reason:
                msg += f" {reason}."
            msg += " Text us anytime to reschedule. — Upstate Cleaning Service"
            text_customer(cphone, msg)
            resp.message(f"❌ #{order_id} cancelled. {cname} notified.")

        elif cmd == "EXT":
            ext_id = parts[2] if len(parts) > 2 else ""
            if not ext_id:
                resp.message("Include a ticket number, e.g.: EXT 1 42")
                return str(resp)
            order["external_id"] = ext_id
            text_customer(cphone,
                f"Hi {cname}! Your Upstate Cleaning Service ticket number is #{ext_id}. "
                f"Keep this for your records. — Upstate Cleaning Service")
            resp.message(f"🔖 Order #{order_id} → Ticket #{ext_id}. {cname} has been notified.")

        else:
            resp.message(
                "Commands:\n"
                "LIST\n"
                "CONFIRM [#]\n"
                "SCHEDULE [#] [time]\n"
                "READY [#]\n"
                "CANCEL [#] [reason]\n"
                "EXT [#] [external-id]"
            )

        return str(resp)

    # ============================================================
    # CUSTOMER FLOW
    # ============================================================
    session = sessions.get(from_number)

    # Bail-out keywords
    if body_up in ("STOP", "CANCEL", "QUIT"):
        sessions.pop(from_number, None)
        resp.message("No problem! Text us anytime to schedule a pickup. — Upstate Cleaning Service")
        return str(resp)

    # No active session → start fresh
    if not session:
        sessions[from_number] = {"step": "name"}
        resp.message(
            "👋 Welcome to Upstate Cleaning Service!\n\n"
            "To schedule a dry cleaning pickup, I just need a few quick details.\n\n"
            "What's your name?"
        )
        return str(resp)

    step = session["step"]

    if step == "name":
        session["name"] = body
        session["step"] = "colony"
        resp.message(f"Thanks, {body}! What's your colony name?")

    elif step == "colony":
        session["colony"] = body
        session["step"] = "address"
        resp.message("Got it! What's your full address? (house/bungalow number and street)")

    elif step == "address":
        session["address"] = body
        session["step"] = "items"
        resp.message(
            "What items do you need cleaned?\n"
            "(e.g. '2 shirts, 1 suit, 3 pants')"
        )

    elif step == "items":
        session["items"] = body
        session["step"] = "contact_phone"
        resp.message("What's the best phone number to reach you?")

    elif step == "contact_phone":
        session["contact_phone"] = body
        session["step"] = "notes"
        resp.message(
            "Any access codes or special notes for pickup? "
            "(Reply SKIP to skip)"
        )

    elif step == "notes":
        session["notes"] = "" if body_up == "SKIP" else body
        session["step"] = "confirm"
        notes_line = f"\n📝 Notes: {session['notes']}" if session["notes"] else ""
        resp.message(
            "Here's your request:\n\n"
            f"👤 {session['name']}\n"
            f"🏘️ Colony: {session['colony']}\n"
            f"📍 {session['address']}\n"
            f"📞 {session['contact_phone']}\n"
            f"👕 {session['items']}"
            f"{notes_line}\n\n"
            "Reply YES to submit or NO to cancel."
        )

    elif step == "confirm":
        if body_up == "YES":
            oid = next_order_id
            next_order_id += 1
            orders[oid] = {
                "sms_from":      from_number,
                "name":          session["name"],
                "colony":        session["colony"],
                "address":       session["address"],
                "items":         session["items"],
                "contact_phone": session["contact_phone"],
                "notes":         session.get("notes", ""),
                "status":        "pending",
                "external_id":   None,
            }
            sessions.pop(from_number, None)

            notes_line = f"\nNotes: {orders[oid]['notes']}" if orders[oid]["notes"] else ""
            notify_admin(
                f"🧺 New Pickup Request #{oid}\n"
                f"Name: {orders[oid]['name']}\n"
                f"Colony: {orders[oid]['colony']}\n"
                f"Address: {orders[oid]['address']}\n"
                f"Phone: {orders[oid]['contact_phone']}\n"
                f"Items: {orders[oid]['items']}"
                f"{notes_line}\n\n"
                f"Reply: CONFIRM {oid}, SCHEDULE {oid} [time], CANCEL {oid}"
            )

            resp.message(
                f"✅ Request received! (Order #{oid})\n"
                f"We'll be in touch to confirm your pickup time.\n\n"
                f"— Upstate Cleaning Service"
            )

        elif body_up == "NO":
            sessions.pop(from_number, None)
            resp.message("No problem! Text us when you're ready. — Upstate Cleaning Service")

        else:
            resp.message("Reply YES to confirm or NO to cancel.")

    return str(resp)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)
