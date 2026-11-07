#ifndef TERRAIN_H
#define TERRAIN_H

/* 地形 ID。gfx/gen_chr.ts の BG の並びと一致させる (タイル番号 = ID * 4)。server/terrain.ts とも一致させる。
 * 道路は向きのない 1 種。橋・高速道路・市街地・農地・雪はなく、それぞれ道路・道路・建物・草・岩山と同じ。 */
enum { T_GRASS, T_FOREST, T_MOUNTAIN, T_ROCK, T_WATER,
       T_BUILDING,
       T_SAND, T_WETLAND,
       T_ROAD,
       /* 線路 20 種 (T_RAIL_FIRST .. T_RAIL_LAST)。つながる 2 方向の組み合わせ (server/rail.ts) */
       T_RAIL_FIRST,
       T_RAIL_LAST = T_RAIL_FIRST + 19,
       T_CROSSING_H, T_CROSSING_V,
       T_STATION };

#endif
