#ifndef LINK_H
#define LINK_H

/* 外部の地図サーバー (Raspberry Pi) から地形を取得する通信層。
 *
 * ズーム z、ワールド座標 (x, y) (1 マス = 16x16 px、1 タイル = 16x16 マス) から len マスぶんを
 * buf に地形 ID で返す。vertical=0: x 方向 (行)、vertical=1: y 方向 (列)。
 * x, y は 24bit に切り詰めて送る。範囲外の扱い (x の巻き戻しなど) はサーバーが決める。
 *
 * 通信はコントローラポート 2 のビットバンギング (同期式、詳細は link.c)。
 * 応答がなければ以後は ROM 内の手続き生成 (worldgen.c) に切り替える。 */
void link_fetch(unsigned char z, unsigned long x, unsigned long y,
                unsigned char vertical, unsigned char len, unsigned char *buf);

#endif
