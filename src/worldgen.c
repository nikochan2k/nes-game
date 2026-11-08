#include "terrain.h"
#include "worldgen.h"

static const unsigned char perm[256] = {
     56, 220, 154, 146, 122, 177,  24,   2, 182, 115,  47, 151, 210, 224, 130, 173,
    121, 133, 246, 147, 161, 199, 156, 137, 245,  98, 178,  68, 226, 209, 203, 117,
    131, 163, 225, 184,  42,   8, 236, 142, 144, 116,  53, 110, 138, 140, 164,  80,
    124, 230, 159, 120,  41, 231, 213,  73, 254, 171, 172,  39, 238,  70,   6, 135,
    125,  82, 200,  95,   0, 219, 101,  23,  75, 128,   3, 237,  76,  13,  91,  87,
    141,  21, 103, 241,  30, 113,  64,  11,  78,  97,  26, 150, 216,   7,  29,  15,
      9, 179,  92, 165,  48,  69, 158,  74,   5, 102, 143,  96,  45,  40, 175, 108,
     65,  22,  49, 100, 149, 114,  27,  63,  12, 215,  32, 168, 153, 229,  17,  71,
    228, 251,  18, 166, 191, 111, 234, 123, 255, 169,  61,  72,  50,  20, 218, 207,
    170, 112,  38,   1,  44,  25,  16, 252, 202, 174,  33,  43, 204,  85,  86, 239,
    243,  36, 206, 152, 126,  94, 244,  34,  93, 118,  60,  59, 155, 214, 196,  28,
    232, 107, 189, 201, 129,  66,   4,  57,  10, 222,  58, 247, 211, 145,  81, 205,
    109, 223, 250,  88, 249,  99,  83, 195,  35, 190, 248,  31, 217, 235, 160,  89,
    197,  14, 105,  54, 242,  37, 167, 212, 181, 119, 233, 192, 176,  52, 221, 198,
    187,  19, 132,  84, 180, 139,  79,  55, 157, 253, 134, 106,  90, 127, 188, 208,
    162,  62, 136,  67, 194, 183, 193, 104, 185, 227,  51,  77, 148, 186,  46, 240
};

static unsigned char hash2(unsigned x, unsigned y)
{
    unsigned char a = perm[(unsigned char)((unsigned char)x ^ (unsigned char)(x >> 8))];
    return perm[(unsigned char)(a + (unsigned char)y + (unsigned char)(y >> 8))];
}

/* 行/列を順に引くと region と blk は何マスも同じなので、キーが同じ間は再計算しない */
static unsigned rkx, rky, bkx, bky;
static unsigned char region, blk, cached;

unsigned char worldgen_cell(unsigned x, unsigned y)
{
    unsigned char fine = hash2(x ^ 0x1234, (y ^ 0x4321) + 3);
    unsigned char t;

    if (!cached || (x >> 4) != rkx || (y >> 4) != rky) {
        rkx = x >> 4;
        rky = y >> 4;
        region = hash2(rkx, rky) & 7;
        bkx = 0xFFFF;
    }
    if ((x >> 2) != bkx || (y >> 2) != bky) {
        bkx = x >> 2;
        bky = y >> 2;
        blk = hash2(bkx ^ 0x5A5A, bky) & 3;
    }
    cached = 1;

    switch (region) {
    case 3:  t = blk ? T_FOREST : T_GRASS; break;
    case 4:  t = blk ? T_MOUNTAIN : T_GRASS; break;
    case 5:  t = blk == 0 ? T_MOUNTAIN : (blk == 1 ? T_GRASS : T_ROCK); break;
    case 6:  t = blk ? T_WATER : T_GRASS; break;
    default: t = blk == 0 ? T_FOREST : T_GRASS; break;
    }
    if ((fine & 15) == 0 && t != T_WATER && t != T_ROCK) {
        t = T_GRASS;                 /* 輪郭を崩す */
    }
    if ((fine & 31) == 1 && t == T_GRASS) {
        t = T_FOREST;
    }

    /* 32 マスおきの道路。水の上は橋、岩の上は道路。 */
    if ((x & 31) == 0) {
        return (y & 31) == 0 ? T_ROAD_CROSS : T_ROAD_V;
    }
    if ((y & 31) == 0) {
        return T_ROAD_H;
    }
    return t;
}
