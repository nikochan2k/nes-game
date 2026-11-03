/* 地図サーバーとの通信。
 *
 * コントローラポート 2 を同期式シリアルとして使う。
 *   NES -> 相手: $4016 bit0 (ラッチ線) に出した値を、$4017 を 1 回読むたびに 1 ビットとして取り込む
 *   相手 -> NES: $4017 bit0 (D0) を読むたびに 1 ビット返る
 * $4017 の読み出しがクロックなので、ボーレートの調整は要らない。ビットは MSB から。
 *
 * 手順:
 *   1. 0x00, 0xA5 を送る (同期。相手は 0xA5 を見つけるまで読み飛ばす)
 *   2. 要求 9 バイトを送る
 *        z / タイル x (3B) / タイル y (3B) / xo<<4|yo / vertical<<7|len
 *   3. 相手の準備ができるまで読む (0 が返る間は待ち)。最初に 1 が来たら開始ビット
 *   4. len バイトを受け取る (1 マス 1 バイトの地形 ID)
 */

#include "link.h"
#include "worldgen.h"

#define JOY1 (*(volatile unsigned char *)0x4016)
#define JOY2 (*(volatile unsigned char *)0x4017)

#define SYNC_BYTE 0xA5
#define WAIT_CLOCKS 20000      /* 応答待ちの上限 (約 0.3 秒) */

static unsigned char link_dead;   /* 一度でも応答がなければ以後は ROM 内で生成 */

static void tx_byte(unsigned char b)
{
    unsigned char i, dummy;
    for (i = 0; i < 8; ++i) {
        JOY1 = b >> 7;
        dummy = JOY2;           /* 読み出し = クロック */
        b <<= 1;
    }
}

static unsigned char rx_byte(void)
{
    unsigned char i, v = 0;
    for (i = 0; i < 8; ++i) {
        v = (v << 1) | (JOY2 & 1);
    }
    return v;
}

static unsigned char serial_fetch(unsigned char z, unsigned long x, unsigned long y,
                                  unsigned char vertical, unsigned char len, unsigned char *buf)
{
    unsigned wait;
    unsigned char i;

    tx_byte(0x00);
    tx_byte(SYNC_BYTE);
    tx_byte(z);
    tx_byte(x >> 20);
    tx_byte(x >> 12);
    tx_byte(x >> 4);
    tx_byte(y >> 20);
    tx_byte(y >> 12);
    tx_byte(y >> 4);
    tx_byte(((unsigned char)x & 15) << 4 | ((unsigned char)y & 15));
    tx_byte((vertical ? 0x80 : 0) | len);

    for (wait = 0; wait < WAIT_CLOCKS; ++wait) {
        if (JOY2 & 1) {
            break;
        }
    }
    if (wait == WAIT_CLOCKS) {
        return 0;
    }
    for (i = 0; i < len; ++i) {
        buf[i] = rx_byte();
    }
    return 1;
}

void link_fetch(unsigned char z, unsigned long x, unsigned long y,
                unsigned char vertical, unsigned char len, unsigned char *buf)
{
    unsigned char i;

    if (!link_dead && serial_fetch(z, x, y, vertical, len, buf)) {
        return;
    }
    link_dead = 1;
    for (i = 0; i < len; ++i) {
        buf[i] = worldgen_cell((unsigned)x + (vertical ? 0 : i), (unsigned)y + (vertical ? i : 0));
    }
}
