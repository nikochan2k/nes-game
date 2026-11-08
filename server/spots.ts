/**
 * 見栄えの確認の基準地点 (doc/process-visual-review.md)。
 * make preview (server/preview.ts) が描き、make sample (build_world.ts sample) が、この地点の周りだけの小さな DB を作る。
 */
import { existsSync, readFileSync } from "node:fs";
import { parseStart } from "../gfx/gen_start";

export interface Spot { name: string; lat: number; lon: number }

export const DEFAULT_SPOTS: Spot[] = [
  { name: "東京駅", lat: 35.6812, lon: 139.7671 }, { name: "豊洲 (海岸)", lat: 35.649, lon: 139.795 },
  { name: "奥多摩 (山)", lat: 35.85, lon: 138.95 }, { name: "房総南端 (海岸と森)", lat: 34.92, lon: 139.85 },
  { name: "熊谷 (平野)", lat: 36.15, lon: 139.39 }, { name: "筑波山", lat: 36.22, lon: 140.1 },
];

/** "名前:緯度,経度;名前:緯度,経度" を地点の列にする。 */
export function parseSpots(s: string): Spot[] {
  return s.split(";").filter(Boolean).map((p) => {
    const [name, ll] = p.includes(":") ? p.split(":") : [p, p];
    const [lat, lon] = ll.split(",").map(Number);
    if (Number.isNaN(lat) || Number.isNaN(lon)) throw new Error(`地点は "名前:緯度,経度": ${p}`);
    return { name, lat, lon };
  });
}

/** data/start.json (起動位置。自宅付近など。gitignore) があれば、その位置。 */
export function startSpot(): Spot | null {
  const f = "data/start.json";
  if (!existsSync(f)) return null;
  const s = parseStart(readFileSync(f, "utf8"));
  return { name: "起動位置 (data/start.json)", lat: s.lat, lon: s.lon };
}

/** 基準地点の全部 (起動位置が先頭)。 */
export function allSpots(): Spot[] {
  const st = startSpot();
  return st ? [st, ...DEFAULT_SPOTS] : DEFAULT_SPOTS;
}

/** 地点の周り (度。±0.02° = 約 1.7 x 2.2 km。z17 の 2 画面ぶんより広い) の範囲 w,s,e,n。 */
export const SPOT_RADIUS = 0.02;
export const spotBbox = (s: Spot): [number, number, number, number] =>
  [s.lon - SPOT_RADIUS, s.lat - SPOT_RADIUS, s.lon + SPOT_RADIUS, s.lat + SPOT_RADIUS];
