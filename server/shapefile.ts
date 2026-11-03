/**
 * ESRI Shapefile (.shp) の多角形を読む。osmdata.openstreetmap.de の land-polygons-split-3857 用。
 * 座標は EPSG:3857 (m) で、z18 のマス座標に直して返す。範囲 (m) に重なる多角形だけ読む。
 */
import { open } from "node:fs/promises";
import { WORLD_CELLS } from "./osmfeatures";

const MERC = 20037508.342789244;
const toCell = (v: number) => ((v + MERC) / (2 * MERC)) * WORLD_CELLS;

export interface Polygon { parts: Float64Array[]; minx: number; miny: number; maxx: number; maxy: number }

/** bbox は 3857 の m (xmin, ymin, xmax, ymax)。 */
export async function readPolygons(path: string, bbox: [number, number, number, number]): Promise<Polygon[]> {
  const fh = await open(path, "r");
  const out: Polygon[] = [];
  try {
    const size = (await fh.stat()).size;
    const CH = 32 * 1024 * 1024;
    let off = 100;                                    // ファイルヘッダ
    let chunk = new Uint8Array(0);
    let chunkOff = 0;                                 // chunk の先頭のファイル位置
    const ensure = async (need: number) => {         // off から need バイトを chunk に載せる
      if (off >= chunkOff && off + need <= chunkOff + chunk.length) return;
      const len = Math.min(Math.max(CH, need), size - off);
      chunk = new Uint8Array(len);
      await fh.read(chunk, 0, len, off);
      chunkOff = off;
    };
    while (off + 8 <= size) {
      await ensure(8);
      const hv = new DataView(chunk.buffer, chunk.byteOffset + (off - chunkOff), 8);
      const contentLen = hv.getInt32(4, false) * 2;
      await ensure(8 + contentLen);
      const dv = new DataView(chunk.buffer, chunk.byteOffset + (off - chunkOff) + 8, contentLen);
      const type = dv.getInt32(0, true);
      if (type === 5) {                               // Polygon
        const minx = dv.getFloat64(4, true), miny = dv.getFloat64(12, true);
        const maxx = dv.getFloat64(20, true), maxy = dv.getFloat64(28, true);
        if (maxx >= bbox[0] && minx <= bbox[2] && maxy >= bbox[1] && miny <= bbox[3]) {
          const nParts = dv.getInt32(36, true), nPoints = dv.getInt32(40, true);
          const partsAt = 44, ptsAt = partsAt + 4 * nParts;
          const starts: number[] = [];
          for (let i = 0; i < nParts; i++) starts.push(dv.getInt32(partsAt + 4 * i, true));
          starts.push(nPoints);
          const parts: Float64Array[] = [];
          for (let p = 0; p < nParts; p++) {
            const a = new Float64Array((starts[p + 1] - starts[p]) * 2);
            for (let i = starts[p]; i < starts[p + 1]; i++) {
              a[(i - starts[p]) * 2] = toCell(dv.getFloat64(ptsAt + 16 * i, true));
              a[(i - starts[p]) * 2 + 1] = WORLD_CELLS - toCell(dv.getFloat64(ptsAt + 16 * i + 8, true));   // y は北が 0
            }
            parts.push(a);
          }
          out.push({ parts, minx: toCell(minx), maxx: toCell(maxx),
            miny: WORLD_CELLS - toCell(maxy), maxy: WORLD_CELLS - toCell(miny) });
        }
      }
      off += 8 + contentLen;
    }
  } finally {
    await fh.close();
  }
  return out;
}
