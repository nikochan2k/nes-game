import { expect, test } from "bun:test";
import { DEFAULT_START, header, parseStart, startCell } from "../gfx/gen_start";

test("既定 (東京 z10) は従来の定数と同じ", () => {
  expect(startCell(DEFAULT_START.lat, DEFAULT_START.lon, DEFAULT_START.z)).toEqual([14549, 6451]);
});

test("ズームを上げると座標が 2 倍ずつ細かくなる", () => {
  const [x10, y10] = startCell(35.6812, 139.7671, 10);
  const [x14, y14] = startCell(35.6812, 139.7671, 14);
  expect(Math.floor(x14 / 16)).toBe(x10);
  expect(Math.floor(y14 / 16)).toBe(y10);
});

test("範囲の端は世界の中に収める", () => {
  expect(startCell(0, 180, 1)).toEqual([31, 16]);
  expect(startCell(85, -180, 1)[0]).toBe(0);
});

test("設定の検証とヘッダ", () => {
  const s = parseStart('{"lat": 35.6812, "lon": 139.7671, "z": 14}');
  expect(header(s)).toContain("#define START_Z 14");
  expect(header(s)).toMatch(/START_X \d+UL/);
  expect(parseStart('{"lat":1,"lon":2}').z).toBe(10);
  expect(() => parseStart('{"lat":"a","lon":2}')).toThrow();
  expect(() => parseStart('{"lat":90,"lon":2}')).toThrow();
  expect(() => parseStart('{"lat":1,"lon":200}')).toThrow();
  expect(() => parseStart('{"lat":1,"lon":2,"z":19}')).toThrow();
  expect(() => parseStart('{"lat":1,"lon":2,"z":10.5}')).toThrow();
});
