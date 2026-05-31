#!/usr/bin/env python3
"""Link WhatsApp contacts: populate messages.db `contacts` from the whatsmeow
session store (whatsapp.db). Resolves both phone JIDs (<pn>@s.whatsapp.net) and
their LID aliases (<lid>@lid) to display names so chat name-resolution works for
LID-format chats. Idempotent (INSERT OR REPLACE). Safe to run on every invocation.

Usage: python3 link_contacts.py [--store-dir DIR]
Prints a one-line JSON summary.
"""

import sqlite3, os, sys, json

store = os.path.join(os.path.dirname(os.path.abspath(__file__)), "store")
if "--store-dir" in sys.argv:
    store = sys.argv[sys.argv.index("--store-dir") + 1]
MSG_DB = os.path.join(store, "messages.db")
WA_DB = os.path.join(store, "whatsapp.db")


def pick_name(first, full, push, biz):
    for v in (full, first, push, biz):
        if v and v.strip():
            return v.strip()
    return None


def main():
    if not (os.path.exists(MSG_DB) and os.path.exists(WA_DB)):
        print(
            json.dumps(
                {"ok": False, "error": "db missing", "msg_db": MSG_DB, "wa_db": WA_DB}
            )
        )
        return 1
    wa = sqlite3.connect(f"file:{WA_DB}?mode=ro", uri=True)
    # pn -> lid (reverse of lid_map)
    pn2lid = {}
    try:
        for lid, pn in wa.execute("SELECT lid, pn FROM whatsmeow_lid_map"):
            pn2lid[str(pn)] = str(lid)
    except sqlite3.OperationalError:
        pass
    rows = wa.execute(
        "SELECT DISTINCT their_jid, first_name, full_name, push_name, business_name "
        "FROM whatsmeow_contacts"
    ).fetchall()
    wa.close()

    msg = sqlite3.connect(MSG_DB)
    cur = msg.cursor()
    upserts = 0
    lid_upserts = 0
    for their_jid, first, full, push, biz in rows:
        name = pick_name(first, full, push, biz)
        if not name or not their_jid:
            continue
        node = str(their_jid).split("@")[0]
        suffix = (
            str(their_jid).split("@")[1] if "@" in str(their_jid) else "s.whatsapp.net"
        )
        phone = node if suffix == "s.whatsapp.net" else None
        cur.execute(
            "INSERT INTO contacts(jid,name,phone,source,updated_at) VALUES(?,?,?, 'whatsmeow_link', strftime('%s','now')) "
            "ON CONFLICT(jid) DO UPDATE SET name=excluded.name, phone=COALESCE(excluded.phone,contacts.phone), "
            "source='whatsmeow_link', updated_at=strftime('%s','now')",
            (str(their_jid), name, phone),
        )
        upserts += 1
        # LID alias
        lid = pn2lid.get(node)
        if lid:
            cur.execute(
                "INSERT INTO contacts(jid,name,phone,source,updated_at) VALUES(?,?,?, 'whatsmeow_link', strftime('%s','now')) "
                "ON CONFLICT(jid) DO UPDATE SET name=excluded.name, phone=COALESCE(excluded.phone,contacts.phone), "
                "source='whatsmeow_link', updated_at=strftime('%s','now')",
                (f"{lid}@lid", name, node),
            )
            lid_upserts += 1
    msg.commit()
    total = cur.execute(
        "SELECT count(*) FROM contacts WHERE name IS NOT NULL AND name<>''"
    ).fetchone()[0]
    msg.close()
    print(
        json.dumps(
            {
                "ok": True,
                "phone_contacts": upserts,
                "lid_aliases": lid_upserts,
                "named_total": total,
            }
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
