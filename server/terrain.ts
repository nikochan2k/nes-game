/** 地形 ID。src/terrain.h と gfx/gen_chr.ts の BG の並びと一致させる。 */
export const T_GRASS = 0, T_FOREST = 1, T_MOUNTAIN = 2, T_ROCK = 3, T_WATER = 4,
  T_BUILDING = 5,              // 市街地も同じ
  T_SAND = 6, T_WETLAND = 7,
  T_ROAD = 8,                  // 向きのない 1 種 (高速道路も、水の上も同じ)
  T_RAIL = 9,                  // 9..28 の 20 種。つながる 2 方向の組み合わせ (server/rail.ts)
  T_CROSSING_H = 29,           // 踏切: 線路が横 (東西) に走り、道路が縦に横切る
  T_CROSSING_V = 30,           // 踏切: 線路が縦 (南北) に走り、道路が横に横切る
  T_STATION = 31;              // 1 つの駅に 1 マスだけ

/** 線路のタイルの種類の数 (T_RAIL .. T_RAIL + N_RAIL - 1)。 */
export const N_RAIL = 20;
/** 地形の種類の数 (ID は 0 .. T_COUNT-1)。 */
export const T_COUNT = 32;
