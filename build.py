#!/usr/bin/env python3
"""Builds data.enc.json: the trip data, encrypted with a key derived from the family's username and password.

    RESAN_USER=... RESAN_PASS=... python3 build.py [path/to/Trip.json]

The page decrypts it in the browser (PBKDF2-SHA256, AES-256-CBC, HMAC-SHA256), so the repository only ever holds
ciphertext. Only what the family wants to share is picked out of Trip.json: no booking codes, no ticket numbers,
no street addresses, no passport data.
"""
import base64, hashlib, hmac, json, os, subprocess, sys
from datetime import datetime
from zoneinfo import ZoneInfo

TRIP = sys.argv[1] if len(sys.argv) > 1 else "../resan/Packages/ResanCore/Sources/ResanCore/Resources/Trip.json"
ITERATIONS = 600_000

PLACES = {  # id: (name, country, lat, lon, zone)
    "ARN": ("Stockholm", "Sverige", 59.6519, 17.9186, "Europe/Stockholm"),
    "BKK": ("Bangkok", "Thailand", 13.69, 100.7501, "Asia/Bangkok"),
    "KBV": ("Krabi", "Thailand", 8.0996, 98.9862, "Asia/Bangkok"),
    "LANTA": ("Ko Lanta", "Thailand", 7.62, 99.07, "Asia/Bangkok"),
    "BOM": ("Mumbai", "Indien", 19.0896, 72.8656, "Asia/Kolkata"),
    "NASHIK": ("Nashik", "Indien", 20.0, 73.79, "Asia/Kolkata"),
    "MUC": ("München", "Tyskland", 48.3538, 11.7861, "Europe/Berlin"),
}
AIRPORT_NAMES = {
    "ARN": "Stockholm Arlanda", "BKK": "Bangkok Suvarnabhumi", "KBV": "Krabi", "BOM": "Mumbai Chhatrapati Shivaji Maharaj", "MUC": "München",
}

def parse(s):
    """'2026-11-13T13:00[Europe/Stockholm]' -> (UTC milliseconds or None for a bare date, local text, zone)."""
    body, zone = s.rstrip("]").split("[")
    zone = zone or "UTC"
    if "T" in body:
        dt = datetime.fromisoformat(body).replace(tzinfo=ZoneInfo(zone))
        return int(dt.timestamp() * 1000), body, zone
    dt = datetime.fromisoformat(body + "T12:00").replace(tzinfo=ZoneInfo(zone))
    return int(dt.timestamp() * 1000), body, zone

def public(trip):
    flights = []
    for f in trip["flights"]:
        dep, depLocal, depZone = parse(f["departure"]); arr, arrLocal, arrZone = parse(f["arrival"]) if f.get("arrival") else (None, None, None)
        flights.append({"number": f["flightNumber"], "airline": f["airline"], "from": f["fromIata"], "to": f["toIata"],
                        "fromName": AIRPORT_NAMES.get(f["fromIata"], f["fromIata"]), "toName": AIRPORT_NAMES.get(f["toIata"], f["toIata"]),
                        "dep": dep, "depLocal": depLocal, "depZone": depZone, "arr": arr, "arrLocal": arrLocal, "arrZone": arrZone,
                        "aircraft": f.get("aircraft")})
    hotels = []
    for h in trip["hotels"]:
        a, aLocal, zone = parse(h["checkIn"]); b, bLocal, _ = parse(h["checkOut"])
        city = {"Ko Lanta": "LANTA", "Bangkok (Thonglor)": "BKK", "Mumbai (Terminal 2)": "BOM"}.get(h["city"], "BOM")
        hotels.append({"name": h["name"], "place": city, "in": a, "inLocal": aLocal, "out": b, "outLocal": bLocal, "zone": zone})
    transfers = []
    for t in trip["transfers"]:
        w, wLocal, zone = parse(t["when"])
        transfers.append({"title": t["title"], "from": t["from"], "to": t["to"], "when": w, "whenLocal": wLocal, "zone": zone, "timed": "T" in wLocal,
                          "driveMin": t.get("driveMinutes"), "driveKm": t.get("driveKm")})
    events = []
    for e in trip["events"]:
        s, sLocal, zone = parse(e["start"])
        events.append({"title": e["title"], "place": e.get("place") or "", "start": s, "startLocal": sLocal, "zone": zone})
    places = {k: {"name": v[0], "country": v[1], "lat": v[2], "lon": v[3], "zone": v[4]} for k, v in PLACES.items()}
    return {"title": "Filip, Linda och Elliot reser", "people": ["Filip", "Linda", "Elliot"], "places": places,
            "flights": flights, "hotels": hotels, "transfers": transfers, "events": events,
            "start": parse(trip["countdownTarget"])[0], "end": parse(trip["endDate"])[0]}

def derive(user, password, salt):
    return hashlib.pbkdf2_hmac("sha256", f"{user.strip().lower()}:{password}".encode(), salt, ITERATIONS, dklen=64)

def encrypt(plain, user, password):
    # The salt is fixed so a key saved on a device keeps working after every rebuild (the IV still changes).
    salt, iv = hashlib.sha256(b"resan-web-salt-v1").digest()[:16], os.urandom(16)
    key = derive(user, password, salt)
    enc, mac = key[:32], key[32:]
    ct = subprocess.run(["openssl", "enc", "-aes-256-cbc", "-K", enc.hex(), "-iv", iv.hex()], input=plain, capture_output=True, check=True).stdout
    tag = hmac.new(mac, iv + ct, hashlib.sha256).digest()
    b = lambda x: base64.b64encode(x).decode()
    return {"v": 1, "iter": ITERATIONS, "salt": b(salt), "iv": b(iv), "ct": b(ct), "mac": b(tag)}

if __name__ == "__main__":
    user, password = os.environ.get("RESAN_USER"), os.environ.get("RESAN_PASS")
    if not user or not password:
        sys.exit("Set RESAN_USER and RESAN_PASS.")
    data = public(json.load(open(TRIP)))
    out = encrypt(json.dumps(data, ensure_ascii=False).encode(), user, password)
    json.dump(out, open("data.enc.json", "w"))
    print(f"data.enc.json written ({len(out['ct'])} bytes of ciphertext, {len(data['flights'])} flights, {len(data['hotels'])} hotels)")
