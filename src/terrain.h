#ifndef TERRAIN_H
#define TERRAIN_H

/* 地形 ID。gfx/gen_chr.ts の BG の並びと一致させる (タイル番号 = ID * 4) */
enum { T_GRASS, T_FOREST, T_MOUNTAIN, T_ROCK, T_WATER,
       T_BRIDGE_H, T_BRIDGE_V, T_ROAD_H, T_ROAD_V, T_ROAD_X,
       T_URBAN, T_BUILDING, T_SAND, T_SNOW, T_FARM, T_WETLAND,
       T_RAIL_H, T_RAIL_V, T_RAIL_X, T_CROSSING,
       T_HWY_H, T_HWY_V, T_HWY_X };

#endif
