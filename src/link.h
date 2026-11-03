#ifndef LINK_H
#define LINK_H

/* 外部 (Raspberry Pi) からマップを取得する通信層。
 * (x, y) から len マスぶんを buf に地形 ID で返す。
 * vertical=0: x 方向 (行)、vertical=1: y 方向 (列)。
 * 現状は ROM 内の worldgen で代用している。 */
void link_fetch(unsigned x, unsigned y, unsigned char vertical,
                unsigned char len, unsigned char *buf);

#endif
