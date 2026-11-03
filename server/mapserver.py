#!/usr/bin/env python3
"""NES 用の地図サーバー (Raspberry Pi 想定、標準ライブラリのみ)。

NES から z/x/y のタイル番号とタイル内のマス位置を受け取り、1 行 (または 1 列) ぶんの
地形 ID を返す。地形 ID は src/terrain.h と一致させる。

要求 (9 バイト):
  [0]    z (1..20)
  [1:4]  タイル x (24bit ビッグエンディアン)
  [4:7]  タイル y (同上)
  [7]    xo<<4 | yo   タイル内のマス位置 (1 タイル = 16x16 マス)
  [8]    vertical<<7 | len   vertical=1 なら y 方向、0 なら x 方向に len マス (1..63)
応答: len バイト (1 マス 1 バイトの地形 ID)

マスの世界座標は X = tx*16+xo, Y = ty*16+yo。1 辺は 2**(z+4) マス。
X は経度方向なので巻き戻し、Y が範囲外なら T_ROCK (極の外側) を返す。
"""
import argparse
import math
import socketserver

T_GRASS, T_FOREST, T_MOUNTAIN, T_ROCK, T_WATER, \
    T_BRIDGE_H, T_BRIDGE_V, T_ROAD_H, T_ROAD_V, T_ROAD_X = range(10)

Z_MIN, Z_MAX = 1, 20
REQ_LEN = 9


def _hash(ix, iy, seed):
    h = (ix * 374761393 + iy * 668265263 + seed * 2147483647) & 0xFFFFFFFF
    h = ((h ^ (h >> 13)) * 1274126177) & 0xFFFFFFFF
    h ^= h >> 16
    return h / 4294967296.0


def _smooth(t):
    return t * t * (3.0 - 2.0 * t)


def _vnoise(u, v, freq, seed):
    """周期 freq (u 方向は巻き戻し) の値ノイズ。u, v は 0..1。"""
    fx, fy = u * freq, v * freq
    ix, iy = math.floor(fx), math.floor(fy)
    tx, ty = _smooth(fx - ix), _smooth(fy - iy)
    def at(i, j):
        return _hash(i % freq, j, seed)
    top = at(ix, iy) * (1 - tx) + at(ix + 1, iy) * tx
    bot = at(ix, iy + 1) * (1 - tx) + at(ix + 1, iy + 1) * tx
    return top * (1 - ty) + bot * ty


def _fbm(u, v, seed, octaves):
    total, amp, norm = 0.0, 1.0, 0.0
    for k in range(octaves):
        total += amp * _vnoise(u, v, 4 << k, seed + k * 101)
        norm += amp
        amp *= 0.55
    return total / norm


class SyntheticSource:
    """ノイズで作った仮の世界。ズームしても同じ場所が同じ地形になる。"""

    SEA = 0.50

    def __init__(self, seed=1):
        self.seed = seed

    def _moisture(self, u, v, w, octaves, z):
        m = _fbm(u, v, self.seed + 7, octaves)
        if z >= 3:
            m = 0.4 * m + 0.6 * _vnoise(u, v, w >> 3, self.seed + 80)
        return m

    def cell(self, z, x, y):
        w = 1 << (z + 4)
        if y < 0 or y >= w:
            return T_ROCK
        x %= w
        u, v = (x + 0.5) / w, (y + 0.5) / w
        octaves = min(z + 2, 10)
        # 大域のノイズに、1 マスが粗くなりすぎないよう 16 マス程度の起伏を重ねる
        e = _fbm(u, v, self.seed, octaves)
        if z >= 3:
            e = 0.6 * e + 0.4 * _vnoise(u, v, w >> 4, self.seed + 50)
        if v < 0.04 or v > 0.96:
            e = max(e, 0.9)           # 極冠
        if e <= self.SEA:
            t = T_WATER
        elif e > 0.70:
            t = T_ROCK
        elif e > 0.62:
            t = T_MOUNTAIN
        elif self._moisture(u, v, w, octaves, z) > 0.55:
            t = T_FOREST
        else:
            t = T_GRASS
        if z >= 9:                    # 拡大すると 32 マスおきに道路が通る
            if x % 32 == 0 and y % 32 == 0:
                return T_ROAD_X
            if x % 32 == 0:
                return T_BRIDGE_V if t == T_WATER else T_ROAD_V
            if y % 32 == 0:
                return T_BRIDGE_H if t == T_WATER else T_ROAD_H
        return t


def decode_request(req):
    z = req[0]
    tx = int.from_bytes(req[1:4], "big")
    ty = int.from_bytes(req[4:7], "big")
    xo, yo = req[7] >> 4, req[7] & 15
    vertical = bool(req[8] & 0x80)
    n = req[8] & 0x3F
    return z, tx * 16 + xo, ty * 16 + yo, vertical, n


def answer(source, req):
    z, x, y, vertical, n = decode_request(req)
    if not Z_MIN <= z <= Z_MAX:
        return bytes([T_ROCK]) * n
    return bytes(source.cell(z, x, y + i) if vertical else source.cell(z, x + i, y)
                 for i in range(n))


class Handler(socketserver.BaseRequestHandler):
    def recv_exact(self, n):
        buf = b""
        while len(buf) < n:
            chunk = self.request.recv(n - len(buf))
            if not chunk:
                return None
            buf += chunk
        return buf

    def handle(self):
        while True:
            req = self.recv_exact(REQ_LEN)
            if req is None:
                return
            res = answer(self.server.source, req)
            if self.server.verbose:
                z, x, y, vertical, n = decode_request(req)
                print(f"z={z} cell=({x},{y}) {'col' if vertical else 'row'} n={n}", flush=True)
            self.request.sendall(res)


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=5555)
    ap.add_argument("--seed", type=int, default=SEED)
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()
    with Server((args.host, args.port), Handler) as srv:
        srv.source = SyntheticSource(args.seed)
        srv.verbose = args.verbose
        print(f"mapserver listening on {args.host}:{args.port} (seed {args.seed})", flush=True)
        srv.serve_forever()


SEED = 88     # 起動地点 (東京 z=10) が陸になるように選んだ

if __name__ == "__main__":
    main()
