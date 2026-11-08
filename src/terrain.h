#ifndef TERRAIN_H
#define TERRAIN_H

/* 地形 ID。gfx/gen_chr.ts の BG の並びと一致させる (タイル番号 = ID * 4)。server/terrain.ts とも一致させる。
 * 道路・線路は、上下左右につながる方向の組み合わせ (罫線スタイル) で 11 種ずつ。server/rail.ts の SHAPES と並びが同じ:
 *   ─ │ ┌ ┐ ┘ └ ┬ ┤ ┴ ├ ┼
 * 橋・高速道路・市街地・農地・雪はなく、それぞれ道路・道路・建物・草・岩山と同じ。 */
enum { T_GRASS, T_FOREST, T_MOUNTAIN, T_ROCK, T_WATER,
       T_BUILDING,
       T_SAND, T_WETLAND,
       T_ROAD_FIRST,
       T_ROAD_LAST = T_ROAD_FIRST + 10,
       T_RAIL_FIRST,
       T_RAIL_LAST = T_RAIL_FIRST + 10,
       T_CROSSING_H, T_CROSSING_V,
       T_STATION,
       T_AIRPORT,
       T_ASPHALT,
       T_COUNT };

/* 道路の形 (T_ROAD_FIRST からの位置): ─ は 0、│ は 1、┼ は 10 */
#define T_ROAD_H     T_ROAD_FIRST
#define T_ROAD_V     (T_ROAD_FIRST + 1)
#define T_ROAD_CROSS (T_ROAD_FIRST + 10)

/* サーバーの応答 1 バイト: 下位 6bit が地形 ID、上位 2bit が見た目に出ないフラグ。
 *   F_ROAD_TOO: 道路でもある (線路・踏切のマスに道路も重なる、道路が上の線の下を通って隠れている)
 *   F_RAIL_TOO: 線路でもある (線路が上の線 (高架・新幹線) の下を通って、絵に出ない) */
#define F_ROAD_TOO 0x80
#define F_RAIL_TOO 0x40
#define T_ID_MASK  0x3F

#endif
