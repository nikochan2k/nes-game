import { describe, expect, test } from "bun:test";
import * as m from "./mapserver";

/** マス座標 (x, y) からの要求バイト列 (NES の link.c と同じ並び)。 */
function request(z: number, x: number, y: number, vertical: boolean, n: number): Uint8Array {
  const tx = (x >> 4) & 0xffffff, ty = (y >> 4) & 0xffffff;
  return new Uint8Array([
    z,
    tx >> 16, (tx >> 8) & 0xff, tx & 0xff,
    ty >> 16, (ty >> 8) & 0xff, ty & 0xff,
    ((x & 15) << 4) | (y & 15),
    (vertical ? 0x80 : 0) | n,
  ]);
}

describe("mapserver", () => {
  const src = new m.SyntheticSource(m.SEED);

  test("decode roundtrip", () => {
    expect(m.decodeRequest(request(10, 14549, 6451, true, 17)))
      .toEqual({ z: 10, x: 14549, y: 6451, vertical: true, n: 17 });
  });

  test("row and column", () => {
    const row = m.answer(src, request(10, 14540, 6451, false, 19));
    const col = m.answer(src, request(10, 14549, 6443, true, 17));
    expect([...row]).toEqual(Array.from({ length: 19 }, (_, i) => src.cell(10, 14540 + i, 6451)));
    expect([...col]).toEqual(Array.from({ length: 17 }, (_, i) => src.cell(10, 14549, 6443 + i)));
  });

  test("x wraps and y out of range is rock", () => {
    const w = 1 << (10 + 4);
    expect(src.cell(10, -3, 100)).toBe(src.cell(10, w - 3, 100));
    expect(src.cell(10, 5, -1)).toBe(m.T_ROCK);
    expect(src.cell(10, 5, w)).toBe(m.T_ROCK);
    // NES は y のはみ出しを 24bit に切り詰めて送ってくる
    const res = m.answer(src, request(10, 5, -1 & 0xfffffff, false, 1));
    expect([...res]).toEqual([m.T_ROCK]);
  });

  test("ids in range at every zoom", () => {
    for (let z = m.Z_MIN; z <= m.Z_MAX; z++) {
      const w = 1 << (z + 4);
      for (const [x, y] of [[0, 0], [w / 2, w / 2], [w - 1, w - 1]]) {
        const t = src.cell(z, x, y);
        expect(t).toBeGreaterThanOrEqual(0);
        expect(t).toBeLessThanOrEqual(m.T_HWY_X);
      }
    }
  });

  test("tcp roundtrip", async () => {
    const srv = m.serve(src, "127.0.0.1", 0);
    const want = m.answer(src, request(10, 14540, 6451, false, 19));
    let got = new Uint8Array(0);
    let wake = () => {};
    const sock = await Bun.connect({
      hostname: "127.0.0.1",
      port: srv.port,
      socket: {
        data(_s, chunk) {
          const c = new Uint8Array(got.length + chunk.length);
          c.set(got);
          c.set(chunk, got.length);
          got = c;
          wake();
        },
      },
    });
    try {
      for (let k = 0; k < 2; k++) {       // 同じ接続で続けて要求できる
        got = new Uint8Array(0);
        const done = new Promise<void>((resolve) => {
          wake = () => { if (got.length >= 19) resolve(); };
        });
        sock.write(request(10, 14540, 6451, false, 19));
        await done;
        expect([...got]).toEqual([...want]);
      }
    } finally {
      sock.end();
      srv.stop(true);
    }
  });
});
