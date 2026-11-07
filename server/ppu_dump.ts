#!/usr/bin/env bun
/**
 * mesen/dump_ppu.lua が送ってくる PPU のダンプを受け取って、マスごとのパレットが ROM の期待
 * (src/main.c の tile_pal) と合っているか集計する。
 *   bun server/ppu_dump.ts      (待ち受け。Mesen のスクリプトウィンドウで dump_ppu.lua を実行する)
 */
import { loadRomTables, terrainName } from "./romtables";

const { tilePal: TILE_PAL } = loadRomTables();        // 期待値は src/main.c から読む (地形を足しても食い違わない)
const NAMES = TILE_PAL.map((_, id) => terrainName(id));

function analyze(text: string) {
  const m: Record<string, number[]> = {};
  for (const l of text.split("\n")) {
    const [k, ...v] = l.trim().split(" ");
    if (k && v.length) m[k] = v.map((x) => parseInt(x, 16));
  }
  console.log("パレット RAM:", m.PALETTE?.map((x) => x.toString(16).padStart(2, "0")).join(" "));
  const per: Record<number, Record<number, number>> = {};
  let bad = 0, total = 0;
  const wrong: string[] = [];
  for (let sy = 0; sy < 30; sy++) {
    for (let sx = 0; sx < 32; sx++) {
      // 輪のマス (sx, sy) → ネームテーブル nt と、その中のマス (lx, ly)
      let nt = sx >> 4, ly = sy;
      const lx = sx & 15;
      if (sy >= 15) { nt |= 2; ly = sy - 15; }
      const tile = m["NT" + nt]?.[ly * 2 * 32 + lx * 2];
      if (tile === undefined) continue;
      const id = tile >> 2;
      if (id >= TILE_PAL.length || tile & 3) continue;       // 描かれていないマス
      const ab = (ly >> 1) * 8 + (lx >> 1), sh = ((ly & 1) << 2) | ((lx & 1) << 1);
      const got = (m["ATTR" + nt][ab] >> sh) & 3;
      total++;
      ((per[id] ??= {})[got] = ((per[id] ??= {})[got] ?? 0) + 1);
      if (got !== TILE_PAL[id]) { bad++; if (wrong.length < 12) wrong.push(`(${sx},${sy}) nt${nt} ${NAMES[id]} 期待 pal${TILE_PAL[id]} 実際 pal${got} attr[${ab}]=0x${m["ATTR" + nt][ab].toString(16)}`); }
    }
  }
  console.log(`属性のパレットが期待と違うマス ${bad}/${total}`);
  for (const [id, v] of Object.entries(per)) {
    console.log(`  ${id}:${NAMES[+id]}`.padEnd(10), `期待 pal${TILE_PAL[+id]}  実際`, Object.entries(v).map(([p, n]) => `pal${p}×${n}`).join(" "));
  }
  for (const w of wrong) console.log("  例:", w);
}

if (import.meta.main) {
  let buf = "";
  Bun.listen({
    hostname: "127.0.0.1", port: 5560,
    socket: {
      data(_s, c) { buf += new TextDecoder().decode(c); if (buf.includes("END\n")) { Bun.write("data/ppu_dump.txt", buf); analyze(buf); buf = ""; } },
    },
  });
  console.log("ppu_dump: 127.0.0.1:5560 で待ち受け中");
}
export { analyze };
