#ifndef WORLDGEN_H
#define WORLDGEN_H

/* マス (x, y) の地形 ID を返す。座標は 16bit で巻き戻る (実質無限)。
 * 外部サーバーが返すデータの代役として ROM 内で手続き生成する。 */
unsigned char worldgen_cell(unsigned x, unsigned y);

#endif
