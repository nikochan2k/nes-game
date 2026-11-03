#!/usr/bin/env python3
"""gfx/tiles.chr (8KB) を生成する。

  $0000 BG     : 16x16 地形を 8x8 x4 (TL,TR,BL,BR) で 1 メタタイルとして並べる
  $1000 スプライト: 16x16 のプレイヤー 6 フレーム x4 タイル

色番号 0..3 の意味はパレットごとに main.c 側で決める。
"""
import random
import sys

def grid():
    return [[0] * 16 for _ in range(16)]

def put(g, x, y, c):
    g[y % 16][x % 16] = c

def from_art(rows):
    assert len(rows) == 16 and all(len(r) == 16 for r in rows), rows
    return [[int(ch) for ch in r] for r in rows]

def transpose(g):
    return [[g[x][y] for x in range(16)] for y in range(16)]

# ---- BG (pal0: 草/森, pal1: 山, pal2: 岩/道路, pal3: 水/橋) ----
def grass():
    g = grid()
    for x, y in [(3, 2), (11, 5), (6, 9), (13, 12), (2, 13)]:
        put(g, x, y, 2); put(g, x - 1, y + 1, 2); put(g, x + 1, y + 1, 2)
    for x, y in [(9, 1), (1, 7), (8, 13), (14, 8)]:
        put(g, x, y, 1)
    return g

TREE = ["00111100", "01121110", "11211111", "11111121",
        "11111111", "01111110", "00033000", "00033000"]

def forest():
    g = grid()
    for ox, oy in [(0, 0), (8, 0), (4, 8), (12, 8)]:
        for ty, row in enumerate(TREE):
            for tx, ch in enumerate(row):
                if ch != "0":
                    put(g, ox + tx, oy + ty, int(ch))
    return g

def mountain():
    g = grid()
    for r in range(1, 15):
        hw = int(r * 0.55) + 1
        for x in range(max(0, 8 - hw), min(16, 8 + hw)):
            c = 1 if x < 8 else 2
            if r <= 3 or (r == 4 and x % 2 == 0) or (r == 5 and x % 4 == 0):
                c = 3
            g[r][x] = c
    return g

def rock():
    rnd = random.Random(7)
    g = [[2] * 16 for _ in range(16)]
    for _ in range(14):
        x, y = rnd.randrange(16), rnd.randrange(16)
        for dx, dy in [(0, 0), (1, 0), (1, 1)]:
            put(g, x + dx, y + dy, 1)
    for _ in range(9):
        put(g, rnd.randrange(16), rnd.randrange(16), 3)
    return g

def water():
    g = [[1] * 16 for _ in range(16)]
    for x, y in [(2, 3), (10, 2), (6, 8), (14, 9), (3, 13), (11, 14)]:
        for dx in range(3):
            put(g, x + dx, y, 2)
    return g

def bridge_h():
    g = water()
    for x in range(16):
        g[2][x] = 2
        g[13][x] = 2
        for y in range(3, 13):
            g[y][x] = 1 if x % 4 == 0 else 3
    return g

def road_h():
    g = grid()
    for x in range(16):
        g[0][x] = g[15][x] = 2
        for y in range(1, 15):
            g[y][x] = 1
        if x % 8 in (2, 3, 4, 5):
            g[7][x] = g[8][x] = 3
    return g

def road_x():
    g = [[1] * 16 for _ in range(16)]
    for x, y in [(0, 0), (14, 0), (0, 14), (14, 14)]:
        for dx in range(2):
            for dy in range(2):
                g[y + dy][x + dx] = 2
    return g

# 並び順は main.c の T_* と一致させる
BG = [grass(), forest(), mountain(), rock(), water(),
      bridge_h(), transpose(bridge_h()), road_h(), transpose(road_h()), road_x()]

# ---- プレイヤー (上半身 pal0: 1=髪 2=肌 3=赤キャップ / 下半身 pal1: 1=白 2=ジーンズ 3=肌) ----
LEGS_STAND = ["0000022222200000", "0000022222200000", "0000022002200000", "0000011001100000"]
LEGS_WALK  = ["0000022222200000", "0000022222200000", "0000022001100000", "0000011000000000"]
BODY_FRONT = ["0000111111110000", "0001111111111000", "0001111111111000", "0003011111103000"]

HEAD_FRONT = ["0000000000000000", "0000033333300000", "0000333333330000", "0000112222110000",
              "0000121221210000", "0000022222200000", "0000002222000000", "0000002222000000"]
HEAD_BACK  = ["0000000000000000", "0000033333300000", "0000333333330000", "0000333333330000",
              "0000111111110000", "0000011111100000", "0000002222000000", "0000002222000000"]
HEAD_SIDE  = ["0000000000000000", "0000003333000000", "0000033333300000", "0000011333333000",
              "0000011221220000", "0000001222200000", "0000000222000000", "0000000220000000"]
BODY_SIDE  = ["0000001111000000", "0000011111100000", "0000011111100000", "0000011111300000"]
SIDE_STAND = ["0000002222000000", "0000002222000000", "0000002222000000", "0000001111000000"]
SIDE_STRIDE = ["0000002222000000", "0000022002200000", "0000220000220000", "0000110000110000"]

SPR = [
    from_art(HEAD_FRONT + BODY_FRONT + LEGS_STAND),   # 0 down stand
    from_art(HEAD_FRONT + BODY_FRONT + LEGS_WALK),    # 1 down walk
    from_art(HEAD_BACK + BODY_FRONT + LEGS_STAND),    # 2 up stand
    from_art(HEAD_BACK + BODY_FRONT + LEGS_WALK),     # 3 up walk
    from_art(HEAD_SIDE + BODY_SIDE + SIDE_STAND),     # 4 side stand
    from_art(HEAD_SIDE + BODY_SIDE + SIDE_STRIDE),    # 5 side stride
]

def tile_bytes(g, tx, ty):
    p0, p1 = [], []
    for y in range(8):
        b0 = b1 = 0
        for x in range(8):
            c = g[ty * 8 + y][tx * 8 + x]
            b0 = (b0 << 1) | (c & 1)
            b1 = (b1 << 1) | (c >> 1)
        p0.append(b0); p1.append(b1)
    return bytes(p0 + p1)

def bank(images):
    out = bytearray()
    for g in images:
        for ty in range(2):
            for tx in range(2):
                out += tile_bytes(g, tx, ty)
    return out.ljust(0x1000, b"\0")

if __name__ == "__main__":
    data = bank(BG) + bank(SPR)
    assert len(data) == 0x2000
    path = sys.argv[1] if len(sys.argv) > 1 else "gfx/tiles.chr"
    with open(path, "wb") as f:
        f.write(data)
