"""Protocol test: two human clients + host-run bots through a live server.  python3 tests/net_test.py [port]"""
import asyncio, base64, json, os, struct, sys, time

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080

class WS:
    def __init__(self, name): self.name = name; self.inbox = []; self.id = None
    async def connect(self):
        self.r, self.w = await asyncio.open_connection("127.0.0.1", PORT)
        key = base64.b64encode(os.urandom(16)).decode()
        self.w.write(f"GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n".encode())
        await self.r.readuntil(b"\r\n\r\n")
        self.task = asyncio.ensure_future(self.loop())
    async def loop(self):
        try:
            while True:
                b1, b2 = await self.r.readexactly(2); ln = b2 & 0x7F
                if ln == 126: ln = struct.unpack("!H", await self.r.readexactly(2))[0]
                elif ln == 127: ln = struct.unpack("!Q", await self.r.readexactly(8))[0]
                data = await self.r.readexactly(ln)
                if b1 & 0xF == 1: self.inbox.append(json.loads(data))
        except Exception: pass
    def send(self, o):
        data = json.dumps(o).encode(); mask = os.urandom(4); n = len(data)
        head = bytes([0x81]) + (bytes([0x80 | n]) if n < 126 else bytes([0x80 | 126]) + struct.pack("!H", n) if n < 65536 else bytes([0x80 | 127]) + struct.pack("!Q", n))
        self.w.write(head + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))
    async def wait(self, t, timeout=5, pred=None):
        end = time.time() + timeout
        while time.time() < end:
            for i, m in enumerate(self.inbox):
                if m.get("t") == t and (pred is None or pred(m)): return self.inbox.pop(i)
            await asyncio.sleep(0.02)
        raise AssertionError(f"{self.name}: timeout waiting for {t}; inbox={[m.get('t') for m in self.inbox][-8:]}")

def ok(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond: ok.failed = True
ok.failed = False

async def main():
    a, b = WS("alice"), WS("bob")
    await a.connect(); await b.connect()
    a.send({"t": "hello", "name": "Alice", "color": "#e10600"}); b.send({"t": "hello", "name": "Bob<script>", "color": "#nothex"})
    wa = await a.wait("welcome"); wb = await b.wait("welcome")
    ok(wa["id"] != wb["id"], "unique ids assigned")
    a.send({"t": "ping", "c": 123}); p = await a.wait("pong"); ok(p["c"] == 123 and p["s"] > 0, "ping/pong clock sync")

    a.send({"t": "create", "settings": {"laps": 2, "ai": 2, "track": {"type": "seed", "seed": "hello"}}})
    j = await a.wait("joined"); code = j["code"]
    ok(len(code) == 4 and j["host"] == wa["id"], f"room {code} created, alice is host")
    ok(j["settings"]["laps"] == 2 and j["settings"]["track"]["type"] == "seed", "settings applied on create")

    b.send({"t": "rooms"}); rl = await b.wait("rooms")
    ok(any(r["code"] == code for r in rl["list"]), "public room listed")
    b.send({"t": "join", "code": "ZZZZ"}); e = await b.wait("err"); ok("No room" in e["msg"], "bad code rejected")
    b.send({"t": "join", "code": code.lower()}); jb = await b.wait("joined")
    ok(len(jb["players"]) == 2, "bob joined (case-insensitive code)")
    ok("<" not in [p for p in jb["players"] if p["id"] == wb["id"]][0]["name"], "name sanitised")
    ok([p for p in jb["players"] if p["id"] == wb["id"]][0]["color"] == "#e10600", "invalid colour falls back to default")

    b.send({"t": "chat", "text": "gl hf"}); c = await a.wait("chat"); ok(c["text"] == "gl hf", "chat relayed")
    b.send({"t": "settings", "s": {"laps": 9}}); await asyncio.sleep(0.2)
    a.send({"t": "settings", "s": {"laps": 3, "track": {"type": "custom", "spec": {"name": "T", "points": [[0, 0], [500, 0], [900, 300], [900, 800], [400, 1000], [-200, 700], [-300, 200]], "width": 13}}}})
    r = await b.wait("room", pred=lambda m: m["settings"]["laps"] == 3)
    ok(r["settings"]["laps"] == 3 and r["settings"]["track"]["type"] == "custom", "only host can change settings; custom track accepted")
    a.send({"t": "settings", "s": {"track": {"type": "custom", "spec": {"points": [[1e9, 0]] * 8}}}}); await asyncio.sleep(0.2)
    a.send({"t": "profile", "setup": {"compound": "soft", "wing": 0.3, "bias": 0.6}}); await asyncio.sleep(0.1)
    b.send({"t": "ready", "ready": True}); rr = await a.wait("room", pred=lambda m: any(p["ready"] for p in m["players"])); ok(True, "ready toggled")

    b.send({"t": "start"}); await asyncio.sleep(0.2); ok(not any(m.get("t") == "race" for m in a.inbox), "non-host cannot start")
    a.send({"t": "start"})
    ra = await a.wait("race"); rb = await b.wait("race")
    ok(ra["raceId"] == rb["raceId"] and len(ra["cars"]) == 4, "race started for both, 2 humans + 2 bots")
    ok(sorted(ra["grid"].values()) == [0, 1, 2, 3], "grid slots unique")
    ok(ra["go"] > ra["lights0"] + 5000 - 1, "go time is after the five lights")
    ok(any(c.get("setup", {}).get("compound") == "soft" for c in ra["cars"]), "tyre setup travels with the grid")

    # state relay
    for i in range(5):
        a.send({"t": "st", "s": [10 + i, 0, 0, 50, 0, 0, 0, 12000, 3, 1, 0, 100, 0, 0, 0]})
        a.send({"t": "bots", "c": {"b1": [5, 5, 0, 40, 0, 0, 0, 9000, 3, 1, 0, 50, 0, 0, 0]}})
        await asyncio.sleep(0.05)
    s = await b.wait("snap", pred=lambda m: wa["id"] in m["c"] and "b1" in m["c"])
    ok(s["c"][wa["id"]][3] == 50 and "b1" in s["c"], "snapshots carry human and bot states")

    # laps, finish, results
    a.send({"t": "lap", "lap": 1, "time": 80.5, "total": 80.5}); e = await b.wait("lap"); ok(e["id"] == wa["id"] and e["lap"] == 1, "lap event broadcast")
    a.send({"t": "lap", "lap": 3, "time": 79, "total": 240}); await asyncio.sleep(0.1)
    a.send({"t": "lap", "lap": 2, "time": 79.5, "total": 160}); e = await b.wait("lap", pred=lambda m: m["lap"] == 2); ok(True, "valid lap 2 accepted")
    a.send({"t": "lap", "lap": 3, "time": 79, "total": 239}); f = await b.wait("lap", pred=lambda m: m["lap"] == 3); ok(f.get("fin") and f["pos"] == 1, "alice finishes P1")
    b.send({"t": "lap", "id": "b1", "lap": 1, "time": 90, "total": 90}); await asyncio.sleep(0.2); ok(not any(m.get("t") == "lap" and m.get("id") == "b1" for m in b.inbox), "non-host cannot report bot laps")
    for l in (1, 2, 3): b.send({"t": "lap", "lap": l, "time": 85, "total": 85 * l})
    res = await a.wait("results", timeout=5)
    ok(res["list"][0]["name"] == "Alice" and res["list"][1]["name"].startswith("Bob") and len(res["list"]) == 4, "results classified (winner first, bots included)")

    a.send({"t": "lobby"}); await b.wait("lobby"); ok(True, "host returns everyone to lobby")
    # host migration
    a.w.close(); await asyncio.sleep(0.3)
    r = await b.wait("room", pred=lambda m: m["host"] == wb["id"]); ok(True, "host migrates when host disconnects")
    b.send({"t": "leave"}); await asyncio.sleep(0.2)
    c2 = WS("carol"); await c2.connect(); c2.send({"t": "hello", "name": "Carol"}); await c2.wait("welcome")
    c2.send({"t": "join", "code": code}); e = await c2.wait("err"); ok("No room" in e["msg"], "empty room is deleted")
    c2.send({"t": "quick"}); j = await c2.wait("joined"); ok(True, "quick join creates a room when none are open")
    print("\nALL PASSED" if not ok.failed else "\nSOME FAILED")
    sys.exit(1 if ok.failed else 0)

asyncio.run(main())
