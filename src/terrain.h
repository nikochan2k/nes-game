#ifndef TERRAIN_H
#define TERRAIN_H

/* 地形 ID。gfx/gen_chr.py の BG の並びと一致させる (タイル番号 = ID * 4) */
enum { T_GRASS, T_FOREST, T_MOUNTAIN, T_ROCK, T_WATER,
       T_BRIDGE_H, T_BRIDGE_V, T_ROAD_H, T_ROAD_V, T_ROAD_X };

#endif
