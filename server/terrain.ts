/** 地形 ID。src/terrain.h と gfx/gen_chr.ts の BG の並びと一致させる。 */
export const T_GRASS = 0, T_FOREST = 1, T_MOUNTAIN = 2, T_ROCK = 3, T_WATER = 4,
  T_BUILDING = 5,              // 市街地も同じ
  T_SAND = 6, T_WETLAND = 7,
  T_ROAD = 8,                  // 8..18 の 11 種。つながる方向の組み合わせ (server/rail.ts の SHAPES の並び)
  T_RAIL = 19,                 // 19..29 の 11 種。同上
  T_CROSSING_H = 30,           // 踏切: 線路が横 (東西) に走り、道路が縦に横切る
  T_CROSSING_V = 31,           // 踏切: 線路が縦 (南北) に走り、道路が横に横切る
  T_STATION = 32;              // 1 つの駅に 1 マスだけ

/** 道路・線路のタイルの種類の数 (T_ROAD .. T_ROAD + N_SHAPES - 1、T_RAIL .. T_RAIL + N_SHAPES - 1)。 */
export const N_SHAPES = 11;
/** 地形の種類の数 (ID は 0 .. T_COUNT-1)。 */
export const T_COUNT = 33;
/**
 * 応答の 1 バイトの上位 2bit は、見た目に出ない道路・線路のフラグ。下位 6bit が地形 ID (ID は 33 種)。
 *   F_ROAD_TOO (0x80): 道路でもある (線路・踏切のマスに道路も重なる。道路が上の線の下を通って隠れているマスも)
 *   F_RAIL_TOO (0x40): 線路でもある (線路が上の線 (高架・新幹線) の下を通って、絵に出ないマス)
 * 絵は変わらないが、ゲームでは、道路・線路としても通れるマスとして使う (線路は、市街地などに隠れても途切れない)。
 */
export const F_ROAD_TOO = 0x80, F_RAIL_TOO = 0x40, T_ID_MASK = 0x3F;
