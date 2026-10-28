#!/usr/bin/env python3
"""V8 Grand Prix server: static files + WebSocket rooms. Python 3.8+ standard library only.

    python3 server.py [--port 8080] [--host 0.0.0.0]

Physics runs in each player's browser; the server is the lobby, the referee for the start
sequence and lap/finish bookkeeping, and relays car snapshots to everyone in the room.
"""
import argparse
import asyncio
import base64
import hashlib
import json
import mimetypes
import os
import random
import re
import socket
import struct
import time

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "public")
GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
MAX_MSG = 400_000
TICK = 1 / 30
CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ"
COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")

rooms = {}      # code -> Room
clients = {}    # id -> Client
_next_id = 1


def now_ms():
    return int(time.time() * 1000)


def clean_name(s, fallback="Driver"):
    s = re.sub(r"[\x00-\x1f<>]", "", str(s or "")).strip()[:16]
    return s or fallback


# --------------------------------------------------------------------------- websocket

class Client:
    def __init__(self, reader, writer):
        global _next_id
        self.id = "p%d" % _next_id
        _next_id += 1
        self.reader, self.writer = reader, writer
        self.name = "Driver"
        self.color = "#e10600"
        self.num = 0
        self.room = None
        self.ready = False
        self.setup = {}
        self.state = None
        self.alive = True

    async def send(self, obj, droppable=False):
        if not self.alive:
            return
        try:
            if droppable and self.writer.transport.get_write_buffer_size() > 400_000:
                return
            data = json.dumps(obj, separators=(",", ":")).encode()
            self.writer.write(ws_frame(data))
        except Exception:
            self.alive = False


def ws_frame(data, opcode=0x1):
    n = len(data)
    if n < 126:
        head = struct.pack("!BB", 0x80 | opcode, n)
    elif n < 65536:
        head = struct.pack("!BBH", 0x80 | opcode, 126, n)
    else:
        head = struct.pack("!BBQ", 0x80 | opcode, 127, n)
    return head + data


async def read_frame(reader):
    b1, b2 = await reader.readexactly(2)
    fin, op = b1 & 0x80, b1 & 0x0F
    ln = b2 & 0x7F
    if ln == 126:
        (ln,) = struct.unpack("!H", await reader.readexactly(2))
    elif ln == 127:
        (ln,) = struct.unpack("!Q", await reader.readexactly(8))
    if ln > MAX_MSG:
        raise ValueError("message too large")
    mask = await reader.readexactly(4) if b2 & 0x80 else None
    data = await reader.readexactly(ln) if ln else b""
    if mask and ln:
        key = (mask * (ln // 4 + 1))[:ln]
        data = (int.from_bytes(data, "big") ^ int.from_bytes(key, "big")).to_bytes(ln, "big")
    return bool(fin), op, data


# --------------------------------------------------------------------------- rooms

DEFAULT_SETTINGS = {
    "track": {"type": "builtin", "id": "veloce"},
    "laps": 5,
    "ai": 0,
    "aiSkill": 0.9,
    "wear": 1.0,
    "public": True,
    "grid": "join",
    "damage": True,
}


class Room:
    def __init__(self, code, host):
        self.code = code
        self.host = host.id
        self.players = {}              # id -> Client
        self.settings = dict(DEFAULT_SETTINGS)
        self.state = "lobby"           # lobby | racing | finished
        self.race = None
        self.max = 20
        self.last_active = time.time()

    def humans(self):
        return list(self.players.values())

    def info(self):
        return {
            "code": self.code,
            "host": self.host,
            "state": self.state,
            "settings": self.settings,
            "players": [
                {"id": p.id, "name": p.name, "color": p.color, "num": p.num, "ready": p.ready, "setup": p.setup}
                for p in self.players.values()
            ],
        }

    async def broadcast(self, obj, skip=None, droppable=False):
        for p in list(self.players.values()):
            if p.id != skip:
                await p.send(obj, droppable)

    async def push_info(self):
        await self.broadcast({"t": "room", **self.info()})


def new_code():
    for _ in range(200):
        c = "".join(random.choice(CODE_CHARS) for _ in range(4))
        if c not in rooms:
            return c
    raise RuntimeError("no codes")


def validate_track(d):
    """Accept only well-formed track descriptors."""
    if not isinstance(d, dict):
        return None
    t = d.get("type")
    if t == "builtin" and isinstance(d.get("id"), str):
        return {"type": "builtin", "id": d["id"][:32]}
    if t == "seed":
        return {"type": "seed", "seed": str(d.get("seed", "0"))[:24]}
    if t == "custom" and isinstance(d.get("spec"), dict):
        s = d["spec"]
        pts = s.get("points")
        if not isinstance(pts, list) or not (6 <= len(pts) <= 300):
            return None
        clean = []
        for p in pts:
            if not (isinstance(p, list) and len(p) == 2):
                return None
            try:
                x, y = float(p[0]), float(p[1])
            except (TypeError, ValueError):
                return None
            if abs(x) > 30000 or abs(y) > 30000:
                return None
            clean.append([round(x, 1), round(y, 1)])
        try:
            width = max(8.0, min(24.0, float(s.get("width", 14))))
            grass = max(0.0, min(20.0, float(s.get("grass", 6))))
            gravel = max(0.0, min(30.0, float(s.get("gravel", 9))))
        except (TypeError, ValueError):
            return None
        style = "street" if s.get("style") == "street" else "circuit"
        return {"type": "custom", "spec": {
            "name": clean_name(s.get("name"), "Custom track"), "points": clean,
            "width": width, "style": style, "grass": grass, "gravel": gravel}}
    return None


def apply_settings(room, s):
    cur = room.settings
    if "track" in s:
        t = validate_track(s["track"])
        if t:
            cur["track"] = t
    if "laps" in s:
        cur["laps"] = max(1, min(60, int(s["laps"])))
    if "ai" in s:
        cur["ai"] = max(0, min(19, int(s["ai"])))
    if "aiSkill" in s:
        cur["aiSkill"] = max(0.5, min(1.0, float(s["aiSkill"])))
    if "wear" in s:
        cur["wear"] = max(0.0, min(3.0, float(s["wear"])))
    if "public" in s:
        cur["public"] = bool(s["public"])
    if "damage" in s:
        cur["damage"] = bool(s["damage"])
    if s.get("grid") in ("join", "random", "reverse"):
        cur["grid"] = s["grid"]


async def leave_room(c):
    room = c.room
    if not room:
        return
    c.room = None
    c.ready = False
    room.players.pop(c.id, None)
    if not room.players:
        rooms.pop(room.code, None)
        return
    if room.host == c.id:
        room.host = next(iter(room.players))
        if room.state == "racing":
            await room.broadcast({"t": "bots_gone"})
    if room.race:
        room.race["cars"].pop(c.id, None)
        await maybe_finish_race(room)
    await room.broadcast({"t": "left", "id": c.id})
    await room.push_info()


async def join_room(c, room):
    if c.room:
        await leave_room(c)
    room.players[c.id] = c
    c.room = room
    c.ready = False
    if not c.num:
        used = {p.num for p in room.players.values() if p is not c}
        c.num = next(n for n in range(1, 100) if n not in used)
    await c.send({"t": "joined", "you": c.id, **room.info()})
    await room.broadcast({"t": "room", **room.info()}, skip=c.id)


# --------------------------------------------------------------------------- race flow

async def start_race(room):
    s = room.settings
    humans = room.humans()
    order = humans[:]
    if s["grid"] == "random":
        random.shuffle(order)
    elif s["grid"] == "reverse":
        order.reverse()
    cars = {}
    grid = {}
    slot = 0
    for p in order:
        grid[p.id] = slot
        cars[p.id] = {"id": p.id, "name": p.name, "color": p.color, "num": p.num, "bot": False, "setup": p.setup}
        slot += 1
    bot_names = ["Rossi", "Hartmann", "Delacroix", "Tanaka", "Okafor", "Lindqvist", "Moreau", "Barros",
                 "Kowalski", "Ferrante", "Nakamura", "Duval", "Santos", "Holm", "Bianchi", "Varga",
                 "Eriksen", "Costa", "Weber"]
    bot_colors = ["#1e41ff", "#ff8000", "#00d2be", "#dc0000", "#006f62", "#2b4562", "#ffffff", "#b6babd",
                  "#900000", "#0090ff", "#ffcc00", "#7d3cff", "#ff66b2", "#2dd36f", "#ff5e00", "#9bd1ff",
                  "#bbb04a", "#4cc3ff", "#c4421a"]
    random.shuffle(bot_names)
    for i in range(s["ai"]):
        bid = "b%d" % (i + 1)
        grid[bid] = slot
        cars[bid] = {"id": bid, "name": bot_names[i % len(bot_names)], "color": bot_colors[i % len(bot_colors)],
                     "num": 20 + i, "bot": True}
        slot += 1
    t = now_ms()
    lights0 = t + 4500
    go = lights0 + 5000 + random.randint(700, 2600)
    room.state = "racing"
    room.race = {
        "id": "%x" % t, "cars": {k: dict(v, laps=0, best=None, total=None, finished=False, last=None) for k, v in cars.items()},
        "laps": s["laps"], "first_finish": None, "go": go, "started": t, "done": False,
    }
    for p in humans:
        p.ready = False
        p.state = None
    msg = {"t": "race", "raceId": room.race["id"], "track": s["track"], "laps": s["laps"], "grid": grid,
           "cars": list(cars.values()), "lights0": lights0, "go": go, "settings": s, "host": room.host}
    await room.broadcast(msg)
    await room.push_info()


async def maybe_finish_race(room, force=False):
    race = room.race
    if not race or race["done"]:
        return
    humans_left = [c for k, c in race["cars"].items() if not c["bot"] and not c["finished"]]
    if humans_left and not force:
        return
    race["done"] = True
    res = [
        {"id": k, "name": c["name"], "color": c["color"], "num": c["num"], "bot": c["bot"], "laps": c["laps"],
         "total": c["total"], "best": c["best"], "finished": c["finished"]}
        for k, c in race["cars"].items()
    ]
    res.sort(key=lambda r: (-(r["laps"]), r["total"] if r["total"] is not None else 1e9))
    room.state = "finished"
    await room.broadcast({"t": "results", "list": res})
    await room.push_info()


async def finish_timeout(room, race_id):
    await asyncio.sleep(45)
    if room.race and room.race["id"] == race_id:
        await maybe_finish_race(room, force=True)


async def handle_lap(c, room, m):
    race = room.race
    if not race or room.state != "racing":
        return
    cid = m.get("id") or c.id
    if cid != c.id and not (c.id == room.host and cid.startswith("b")):
        return
    car = race["cars"].get(cid)
    if not car or car["finished"]:
        return
    try:
        lap = int(m["lap"]); lt = float(m["time"]); total = float(m["total"])
    except (KeyError, TypeError, ValueError):
        return
    if lap != car["laps"] + 1 or lt <= 0:
        return
    car["laps"] = lap
    car["last"] = lt
    if car["best"] is None or lt < car["best"]:
        car["best"] = lt
    ev = {"t": "lap", "id": cid, "lap": lap, "time": lt, "best": car["best"], "total": total}
    if lap >= race["laps"]:
        car["finished"] = True
        car["total"] = total
        ev["fin"] = True
        pos = sum(1 for x in race["cars"].values() if x["finished"])
        ev["pos"] = pos
        if race["first_finish"] is None:
            race["first_finish"] = time.time()
            asyncio.ensure_future(finish_timeout(room, race["id"]))
    await room.broadcast(ev)
    if ev.get("fin"):
        await maybe_finish_race(room)


async def tick_loop():
    """30 Hz: gather the latest car states in each racing room and send one snapshot per player."""
    while True:
        t0 = time.time()
        for room in list(rooms.values()):
            if room.state != "racing":
                continue
            cars = {}
            for p in room.players.values():
                if p.state is not None:
                    cars[p.id] = p.state
            if room.race and room.race.get("bots"):
                cars.update(room.race["bots"])
            if cars:
                snap = {"t": "snap", "s": now_ms(), "c": cars}
                for p in list(room.players.values()):
                    await p.send(snap, droppable=True)
        # prune idle rooms
        for code, room in list(rooms.items()):
            if not room.players:
                rooms.pop(code, None)
        await asyncio.sleep(max(0.0, TICK - (time.time() - t0)))


# --------------------------------------------------------------------------- message handling

async def on_message(c, m):
    t = m.get("t")
    if t == "ping":
        await c.send({"t": "pong", "c": m.get("c"), "s": now_ms()})
        return
    if t == "hello":
        c.name = clean_name(m.get("name"))
        col = m.get("color")
        if isinstance(col, str) and COLOR_RE.match(col):
            c.color = col
        n = m.get("num")
        if isinstance(n, int) and 1 <= n <= 99:
            c.num = n
        await c.send({"t": "welcome", "id": c.id, "now": now_ms()})
        return
    if t == "rooms":
        lst = []
        for r in rooms.values():
            if r.settings.get("public") and r.state == "lobby" and len(r.players) < r.max:
                host = r.players.get(r.host)
                trk = r.settings["track"]
                tname = trk.get("id") if trk["type"] == "builtin" else trk.get("spec", {}).get("name") or ("Seed " + str(trk.get("seed", "")))
                lst.append({"code": r.code, "host": host.name if host else "?", "players": len(r.players),
                            "max": r.max, "track": tname, "laps": r.settings["laps"]})
        await c.send({"t": "rooms", "list": lst})
        return
    if t == "create":
        room = Room(new_code(), c)
        rooms[room.code] = room
        if isinstance(m.get("settings"), dict):
            apply_settings(room, m["settings"])
        await join_room(c, room)
        return
    if t == "join":
        code = str(m.get("code", "")).upper().strip()[:4]
        room = rooms.get(code)
        if not room:
            await c.send({"t": "err", "msg": "No room with code %s" % code})
        elif room.state == "racing":
            await c.send({"t": "err", "msg": "A race is in progress. Try again when it finishes."})
        elif len(room.players) >= room.max:
            await c.send({"t": "err", "msg": "That room is full"})
        else:
            await join_room(c, room)
        return
    if t == "quick":
        open_rooms = [r for r in rooms.values() if r.settings.get("public") and r.state != "racing" and len(r.players) < r.max]
        if open_rooms:
            open_rooms.sort(key=lambda r: -len(r.players))
            await join_room(c, open_rooms[0])
        else:
            room = Room(new_code(), c)
            rooms[room.code] = room
            await join_room(c, room)
        return
    if t == "leave":
        await leave_room(c)
        await c.send({"t": "left_room"})
        return

    room = c.room
    if not room:
        return
    room.last_active = time.time()

    if t == "settings" and c.id == room.host and room.state != "racing":
        apply_settings(room, m.get("s") or {})
        await room.push_info()
    elif t == "profile":
        col = m.get("color")
        if isinstance(col, str) and COLOR_RE.match(col):
            c.color = col
        if "name" in m:
            c.name = clean_name(m["name"], c.name)
        n = m.get("num")
        if isinstance(n, int) and 1 <= n <= 99:
            c.num = n
        if isinstance(m.get("setup"), dict):
            su = m["setup"]
            c.setup = {
                "compound": su.get("compound") if su.get("compound") in ("soft", "medium", "hard") else "medium",
                "wing": max(0.0, min(1.0, float(su.get("wing", 0.5)))),
                "bias": max(0.5, min(0.7, float(su.get("bias", 0.58)))),
            }
        if room.state != "racing":
            await room.push_info()
    elif t == "ready" and room.state != "racing":
        c.ready = bool(m.get("ready"))
        await room.push_info()
    elif t == "chat":
        txt = re.sub(r"[\x00-\x1f]", "", str(m.get("text", "")))[:140].strip()
        if txt:
            await room.broadcast({"t": "chat", "id": c.id, "name": c.name, "text": txt})
    elif t == "start" and c.id == room.host and room.state != "racing":
        await start_race(room)
    elif t == "st" and room.state == "racing":
        s = m.get("s")
        if isinstance(s, list) and len(s) < 24:
            c.state = s
    elif t == "bots" and c.id == room.host and room.race:
        cs = m.get("c")
        if isinstance(cs, dict) and len(cs) <= 20:
            room.race["bots"] = {k: v for k, v in cs.items() if k.startswith("b") and isinstance(v, list)}
    elif t == "lap":
        await handle_lap(c, room, m)
    elif t == "lobby" and c.id == room.host and room.state in ("racing", "finished"):
        room.state = "lobby"
        room.race = None
        for p in room.players.values():
            p.state = None
            p.ready = False
        await room.broadcast({"t": "lobby"})
        await room.push_info()
    elif t == "endrace" and c.id == room.host and room.state == "racing":
        await maybe_finish_race(room, force=True)


async def ws_session(reader, writer, headers):
    key = headers.get("sec-websocket-key", "")
    accept = base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()
    writer.write(
        ("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
         "Sec-WebSocket-Accept: %s\r\n\r\n" % accept).encode()
    )
    await writer.drain()
    c = Client(reader, writer)
    clients[c.id] = c
    frag = b""
    try:
        while True:
            fin, op, data = await read_frame(reader)
            if op == 0x8:
                break
            if op == 0x9:
                writer.write(ws_frame(data, 0xA))
                continue
            if op == 0xA:
                continue
            if op in (0x1, 0x0):
                frag += data
                if len(frag) > MAX_MSG:
                    break
                if fin:
                    msg, frag = frag, b""
                    try:
                        m = json.loads(msg.decode())
                        if isinstance(m, dict):
                            await on_message(c, m)
                    except (ValueError, UnicodeDecodeError):
                        pass
                    except Exception as e:  # keep the connection alive on handler bugs
                        print("handler error:", repr(e))
    except (asyncio.IncompleteReadError, ConnectionError, ValueError, OSError):
        pass
    finally:
        c.alive = False
        clients.pop(c.id, None)
        try:
            await leave_room(c)
        except Exception as e:
            print("leave error:", repr(e))
        try:
            writer.close()
        except Exception:
            pass


# --------------------------------------------------------------------------- http

async def http_response(writer, status, body, ctype="text/plain; charset=utf-8", extra=""):
    if isinstance(body, str):
        body = body.encode()
    writer.write(
        ("HTTP/1.1 %s\r\nContent-Type: %s\r\nContent-Length: %d\r\nCache-Control: no-cache\r\nConnection: close\r\n%s\r\n"
         % (status, ctype, len(body), extra)).encode() + body
    )
    await writer.drain()


async def handle(reader, writer):
    try:
        raw = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=10)
    except Exception:
        writer.close()
        return
    try:
        lines = raw.decode("latin-1").split("\r\n")
        method, path, _ = lines[0].split(" ", 2)
        headers = {}
        for ln in lines[1:]:
            if ":" in ln:
                k, v = ln.split(":", 1)
                headers[k.strip().lower()] = v.strip()
    except ValueError:
        writer.close()
        return

    if headers.get("upgrade", "").lower() == "websocket":
        await ws_session(reader, writer, headers)
        return

    if method not in ("GET", "HEAD"):
        await http_response(writer, "405 Method Not Allowed", "method not allowed")
        writer.close()
        return
    path = path.split("?", 1)[0].split("#", 1)[0]
    if path == "/healthz":
        await http_response(writer, "200 OK", "ok")
        writer.close()
        return
    if path.endswith("/"):
        path += "index.html"
    rel = os.path.normpath(os.path.join(ROOT, path.lstrip("/")))
    if not os.path.realpath(rel).startswith(os.path.realpath(ROOT)) or not os.path.isfile(rel):
        await http_response(writer, "404 Not Found", "not found")
        writer.close()
        return
    ctype = mimetypes.guess_type(rel)[0] or "application/octet-stream"
    if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
        ctype += "; charset=utf-8"
    with open(rel, "rb") as f:
        body = f.read()
    await http_response(writer, "200 OK", body if method == "GET" else b"", ctype)
    writer.close()


def lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


async def main(host, port):
    mimetypes.add_type("application/javascript", ".js")
    server = await asyncio.start_server(handle, host, port, limit=2 ** 20)
    ip = lan_ip()
    print("\n  V8 GRAND PRIX server running")
    print("  This computer : http://localhost:%d" % port)
    print("  Same wifi/LAN : http://%s:%d   <- friends on your network join here" % (ip, port))
    print("  Over the internet: expose this port with a tunnel (see README) or host it on any VPS\n")
    asyncio.ensure_future(tick_loop())
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8080")))
    a = ap.parse_args()
    try:
        asyncio.run(main(a.host, a.port))
    except KeyboardInterrupt:
        pass
