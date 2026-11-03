import socket
import threading
import unittest

import mapserver as m


def request(z, x, y, vertical, n):
    """マス座標 (x, y) からの要求バイト列 (NES の link.c と同じ並び)。"""
    tx, ty = x >> 4, y >> 4
    return bytes([z]) + (tx & 0xFFFFFF).to_bytes(3, "big") + (ty & 0xFFFFFF).to_bytes(3, "big") \
        + bytes([(x & 15) << 4 | (y & 15), (0x80 if vertical else 0) | n])


class MapServerTest(unittest.TestCase):
    def setUp(self):
        self.src = m.SyntheticSource(m.SEED)

    def test_decode_roundtrip(self):
        self.assertEqual(m.decode_request(request(10, 14549, 6451, True, 17)),
                         (10, 14549, 6451, True, 17))

    def test_row_and_column(self):
        row = m.answer(self.src, request(10, 14540, 6451, False, 19))
        col = m.answer(self.src, request(10, 14549, 6443, True, 17))
        self.assertEqual(list(row), [self.src.cell(10, 14540 + i, 6451) for i in range(19)])
        self.assertEqual(list(col), [self.src.cell(10, 14549, 6443 + i) for i in range(17)])

    def test_x_wraps_and_y_out_of_range_is_rock(self):
        w = 1 << (10 + 4)
        self.assertEqual(self.src.cell(10, -3, 100), self.src.cell(10, w - 3, 100))
        self.assertEqual(self.src.cell(10, 5, -1), m.T_ROCK)
        self.assertEqual(self.src.cell(10, 5, w), m.T_ROCK)
        # NES は y のはみ出しを 24bit に切り詰めて送ってくる
        res = m.answer(self.src, request(10, 5, (-1) & 0xFFFFFFF, False, 1))
        self.assertEqual(res, bytes([m.T_ROCK]))

    def test_ids_in_range_at_every_zoom(self):
        for z in range(m.Z_MIN, m.Z_MAX + 1):
            w = 1 << (z + 4)
            for x, y in ((0, 0), (w // 2, w // 2), (w - 1, w - 1)):
                self.assertTrue(0 <= self.src.cell(z, x, y) <= m.T_ROAD_X)

    def test_tcp_roundtrip(self):
        with m.Server(("127.0.0.1", 0), m.Handler) as srv:
            srv.source, srv.verbose = self.src, False
            threading.Thread(target=srv.serve_forever, daemon=True).start()
            with socket.create_connection(srv.server_address) as c:
                for _ in range(2):          # 同じ接続で続けて要求できる
                    c.sendall(request(10, 14540, 6451, False, 19))
                    got = b""
                    while len(got) < 19:
                        got += c.recv(19 - len(got))
                    self.assertEqual(got, m.answer(self.src, request(10, 14540, 6451, False, 19)))
            srv.shutdown()


if __name__ == "__main__":
    unittest.main()
