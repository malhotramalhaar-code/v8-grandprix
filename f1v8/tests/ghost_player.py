import asyncio, sys, time
sys.argv = [sys.argv[0], "8080"] + sys.argv[1:]
exec(open("tests/net_test.py").read().split("def ok(")[0])
async def main(code):
    g = WS("ghost"); await g.connect()
    g.send({"t": "hello", "name": "GhostBot", "color": "#00d2be", "num": 77}); await g.wait("welcome")
    g.send({"t": "join", "code": code}); await g.wait("joined"); print("joined", flush=True)
    race = await g.wait("race", timeout=60); print("race started", race["grid"], flush=True)
    t0 = time.time(); x = 120.0
    while time.time() - t0 < 25:
        dt = 1/30; u = min(70, 10 + (time.time() - t0) * 14)
        x += u * dt
        g.send({"t": "st", "s": [round(x, 2), -3.0, 0, round(u, 2), 0, 0, 0, 12000, 3, 1, 0, round(x - 164, 1), 0, 0, 0]})
        await asyncio.sleep(dt)
    print("done", flush=True)
asyncio.run(main(sys.argv[2]))
