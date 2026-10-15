import json
import os
import random
import subprocess
import sys
import time
import unittest

import oracle
from rooms.report import peak_report

TIME_LIMIT_S = 20  # generous for slow CI machines; the original needs hours


def random_bookings(rng, n, rooms, horizon):
    out = []
    for i in range(n):
        start = rng.randint(0, horizon)
        length = rng.choice([0, 0, 1, 2, 5, rng.randint(1, horizon // 3 + 1)])
        bid = str(rng.randint(0, n // 2 + 1)) if rng.random() < 0.3 else "b%d" % i
        out.append({"id": bid, "room": rng.choice(rooms), "start": start, "end": start + length})
    return out


def run(fn, bookings, caps):
    try:
        return ("ok", json.dumps(fn([dict(b) for b in bookings], dict(caps)), sort_keys=True))
    except ValueError as e:
        return ("error", str(e))


class Hidden(unittest.TestCase):
    def test_same_output_as_original(self):
        rng = random.Random(1234)
        for _ in range(600):
            rooms = ["r%d" % k for k in range(rng.randint(1, 4))]
            caps = {r: rng.randint(0, 3) for r in rooms if rng.random() < 0.6}
            bookings = random_bookings(rng, rng.randint(0, 30), rooms, rng.choice([5, 20, 100]))
            if rng.random() < 0.05 and bookings:
                bad = rng.randrange(len(bookings))
                bookings[bad] = dict(bookings[bad], end=bookings[bad]["start"] - 1)
            self.assertEqual(run(peak_report, bookings, caps), run(oracle.peak_report, bookings, caps))

    def test_key_order_and_room_order(self):
        bookings = [{"id": "1", "room": "Z", "start": 3, "end": 3},
                    {"id": "2", "room": "A", "start": 0, "end": 4},
                    {"id": "3", "room": "A", "start": 4, "end": 9},
                    {"id": "4", "room": "A", "start": 2, "end": 6}]
        got = peak_report(bookings, {"A": 1})
        self.assertEqual(list(got), list(oracle.peak_report(bookings, {"A": 1})))
        self.assertEqual(got, {"Z": {"peak": 0, "overbooked": []},
                               "A": {"peak": 2, "overbooked": [[2, 6]]}})

    def test_large_input_is_fast(self):
        script = (
            "import random, time, sys\n"
            "from rooms.report import peak_report\n"
            "rng = random.Random(99)\n"
            "rooms = ['room%d' % k for k in range(300)]\n"
            "bk = []\n"
            "for i in range(240000):\n"
            "    s = rng.randint(0, 525600)\n"
            "    bk.append({'id': 'b%d' % i, 'room': rng.choice(rooms), 'start': s, 'end': s + rng.randint(0, 600)})\n"
            "bk += [dict(b) for b in rng.sample(bk, 60000)]\n"
            "caps = {r: rng.randint(1, 3) for r in rooms[:200]}\n"
            "t = time.time()\n"
            "rep = peak_report(bk, caps)\n"
            "print(len(rep), sum(v['peak'] for v in rep.values()), time.time() - t)\n"
        )
        start = time.time()
        try:
            out = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True,
                                 timeout=TIME_LIMIT_S, env=dict(os.environ), check=True).stdout
        except subprocess.TimeoutExpired:
            self.fail("peak_report on 300k bookings took longer than %ds" % TIME_LIMIT_S)
        self.assertEqual(out.split()[0], "300")
        self.assertLess(time.time() - start, TIME_LIMIT_S)
