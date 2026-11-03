/* 現代の街道を歩くフィールド移動デモ (4 画面 = 2x2)。
 * 画面端を越えるとその画面のネームテーブルを描き直す。 */

#define PPU_CTRL   (*(volatile unsigned char *)0x2000)
#define PPU_MASK   (*(volatile unsigned char *)0x2001)
#define PPU_STATUS (*(volatile unsigned char *)0x2002)
#define PPU_SCROLL (*(volatile unsigned char *)0x2005)
#define PPU_ADDR   (*(volatile unsigned char *)0x2006)
#define PPU_DATA   (*(volatile unsigned char *)0x2007)
#define JOY1       (*(volatile unsigned char *)0x4016)
#define OAM        ((volatile unsigned char *)0x0200)

#define PAD_UP    0x08
#define PAD_DOWN  0x04
#define PAD_LEFT  0x02
#define PAD_RIGHT 0x01

#define MAP_W 32
#define MAP_H 28
#define SCR_W 16               /* 1 画面 = 16x14 マス (1 マス = 16x16 px) */
#define SCR_H 14
#define STEP_PX 2              /* 1 フレームの移動量 (16px / 2 = 8 フレーム/マス) */
#define SCROLL_Y 232           /* 上下 8px ずつ余白にして NTSC の可視範囲 224 行に収める */

enum { T_GRASS, T_FOREST, T_MOUNTAIN, T_ROCK, T_WATER,
       T_BRIDGE_H, T_BRIDGE_V, T_ROAD_H, T_ROAD_V, T_ROAD_X };
enum { DIR_DOWN, DIR_UP, DIR_LEFT, DIR_RIGHT };

extern void wait_vblank(void);

/* . 草原  ^ 山  T 森  ~ 水  # 岩山  b/B 橋(横/縦)  -/| 道路  + 交差点 */
static const char world[MAP_H][MAP_W + 1] = {
    "........|.....~~........|.......",
    ".^^^^^^.|.....~~...####.|.#####.",
    ".^^^^^^.|.....~~...####.|.#####.",
    ".^^^^^^.|.....~~...####.|.#####.",
    ".^^^^^^.|.....~~...####.|.......",
    "........|.....~~........|.......",
    "--------+-----bb--------+-------",
    "........|.....~~........|.......",
    "........|.....~~..TTTTT.|.......",
    "........|.TTT..~~.TTTTT.|..####.",
    "..^^^^..|.TTT..~~.TTTTT.|..####.",
    "..^^^^..|.TTT..~~.TTTTT.|..####.",
    "..^^^^..|.TTT..~~.TTTTT.|..####.",
    "........|......~~.......|.......",
    "........|......~~.......|.......",
    "........|......~~.......|.......",
    ".TTTTTT.|.~~~..~~...^^^^|.~~~~~.",
    ".TTTTTT.|.~~~..~~...^^^^|.~~~~~.",
    ".TTTTTT.|.~~~..~~.......|.~~~~~.",
    "........|.......~~......|.~~~~~.",
    "--------+-------bb------+-------",
    "........|.......~~......|.......",
    "........|.......~~.TTTT.|...~~~.",
    ".######.|.TTTT..~~.TTTT.|...~~~.",
    ".######.|.TTTT..~~.TTTT.|...~~~.",
    ".######.|.TTTT..~~.TTTT.|...~~~.",
    ".######.|.TTTT..~~.TTTT.|.......",
    "........|.......~~......|.......",
};

/* BG パレット: 0=草/森 1=山 2=岩/道路 3=水/橋 (T_* の並び順) */
static const unsigned char tile_pal[] = { 0, 0, 1, 2, 3, 3, 3, 2, 2, 2 };

static const unsigned char palette[32] = {
    0x1A, 0x0A, 0x2A, 0x17,
    0x1A, 0x17, 0x07, 0x30,
    0x1A, 0x00, 0x10, 0x30,
    0x1A, 0x11, 0x21, 0x17,
    0x1A, 0x0F, 0x36, 0x16,   /* 上半身: 髪 肌 キャップ */
    0x1A, 0x30, 0x12, 0x36,   /* 下半身: シャツ ジーンズ 肌 */
    0x1A, 0x0F, 0x36, 0x16,
    0x1A, 0x0F, 0x36, 0x16
};

static unsigned char cx, cy;   /* 現在のマス */
static signed char ox, oy;     /* 描画上の残り移動量 (px) */
static unsigned char dir;
static unsigned char toggle;   /* 歩くたびに反転 (足の左右) */
static unsigned char hold;     /* 画面切り替え直後の待ち */

static unsigned char terrain(unsigned char x, unsigned char y)
{
    switch (world[y][x]) {
    case 'T': return T_FOREST;
    case '^': return T_MOUNTAIN;
    case '#': return T_ROCK;
    case '~': return T_WATER;
    case 'b': return T_BRIDGE_H;
    case 'B': return T_BRIDGE_V;
    case '-': return T_ROAD_H;
    case '|': return T_ROAD_V;
    case '+': return T_ROAD_X;
    default:  return T_GRASS;
    }
}

static unsigned char passable(unsigned char x, unsigned char y)
{
    unsigned char t = terrain(x, y);
    return t != T_WATER && t != T_ROCK;
}

static unsigned char read_pad(void)
{
    unsigned char i, v = 0;
    JOY1 = 1;
    JOY1 = 0;
    for (i = 0; i < 8; ++i) {
        v = (v << 1) | (JOY1 & 1);
    }
    return v;
}

/* 画面 (sx, sy) をネームテーブル 0 に描く。描画は一度止める。 */
static void draw_screen(unsigned char sx, unsigned char sy)
{
    unsigned char bx = sx * SCR_W, by = sy * SCR_H;
    unsigned char x, y, half, t, a;

    PPU_MASK = 0;
    x = PPU_STATUS;
    PPU_ADDR = 0x20;
    PPU_ADDR = 0x00;
    for (y = 0; y < SCR_H; ++y) {
        for (half = 0; half < 2; ++half) {
            for (x = 0; x < SCR_W; ++x) {
                t = terrain(bx + x, by + y) * 4 + half * 2;
                PPU_DATA = t;
                PPU_DATA = t + 1;
            }
        }
    }
    for (x = 0; x < 64; ++x) {      /* 余りの 2 タイル行 */
        PPU_DATA = 0;
    }
    for (y = 0; y < 8; ++y) {       /* 属性: 1 マス (16x16) ごとにパレット */
        for (x = 0; x < 8; ++x) {
            a = 0;
            if (y < SCR_H / 2) {
                a = tile_pal[terrain(bx + x * 2, by + y * 2)]
                  | tile_pal[terrain(bx + x * 2 + 1, by + y * 2)] << 2
                  | tile_pal[terrain(bx + x * 2, by + y * 2 + 1)] << 4
                  | tile_pal[terrain(bx + x * 2 + 1, by + y * 2 + 1)] << 6;
            }
            PPU_DATA = a;
        }
    }
    wait_vblank();                  /* スクロール設定は vblank 内で */
    x = PPU_STATUS;
    PPU_SCROLL = 0;
    PPU_SCROLL = SCROLL_Y;
    PPU_MASK = 0x1E;
}

static void draw_player(void)
{
    unsigned char moving = (ox | oy) != 0;
    signed char m = ox ? ox : oy;
    unsigned char frame, flip, tl, tr, bl, br;
    int px = (cx & (SCR_W - 1)) * 16 + ox;
    int py = 8 + (cy % SCR_H) * 16 + oy - 1;

    if (m < 0) {
        m = -m;
    }
    if (dir == DIR_DOWN || dir == DIR_UP) {
        frame = dir * 2 + moving;
        flip = moving && toggle;
    } else {
        frame = 4 + (moving && m > 8);
        flip = dir == DIR_LEFT;
    }
    tl = frame * 4;
    tr = tl + 1;
    bl = tl + 2;
    br = tl + 3;
    if (flip) {
        tl ^= 1; tr ^= 1; bl ^= 1; br ^= 1;
    }
    OAM[0] = py;      OAM[1] = tl; OAM[2] = flip ? 0x40 : 0; OAM[3] = px;
    OAM[4] = py;      OAM[5] = tr; OAM[6] = flip ? 0x40 : 0; OAM[7] = px + 8;
    OAM[8] = py + 8;  OAM[9] = bl; OAM[10] = flip ? 0x41 : 1; OAM[11] = px;
    OAM[12] = py + 8; OAM[13] = br; OAM[14] = flip ? 0x41 : 1; OAM[15] = px + 8;
}

static void update_player(unsigned char pad)
{
    unsigned char nx = cx, ny = cy;

    if (hold) {
        --hold;
        return;
    }
    if (ox || oy) {
        if (ox < 0) ox += STEP_PX; else if (ox > 0) ox -= STEP_PX;
        if (oy < 0) oy += STEP_PX; else if (oy > 0) oy -= STEP_PX;
        return;
    }
    if (pad & PAD_UP)         { dir = DIR_UP;    --ny; }
    else if (pad & PAD_DOWN)  { dir = DIR_DOWN;  ++ny; }
    else if (pad & PAD_LEFT)  { dir = DIR_LEFT;  --nx; }
    else if (pad & PAD_RIGHT) { dir = DIR_RIGHT; ++nx; }
    else return;

    if (nx >= MAP_W || ny >= MAP_H || !passable(nx, ny)) {
        return;                     /* 範囲外 (unsigned の -1 含む) / 通行不可 */
    }
    toggle ^= 1;
    if (nx / SCR_W != cx / SCR_W || ny / SCR_H != cy / SCR_H) {
        cx = nx;
        cy = ny;
        draw_screen(cx / SCR_W, cy / SCR_H);
        hold = 6;
    } else {
        ox = (signed char)(cx - nx) * 16;
        oy = (signed char)(cy - ny) * 16;
        cx = nx;
        cy = ny;
    }
}

void main(void)
{
    unsigned char i;

    PPU_CTRL = 0;
    PPU_MASK = 0;
    i = PPU_STATUS;
    PPU_ADDR = 0x3F;
    PPU_ADDR = 0x00;
    for (i = 0; i < 32; ++i) {
        PPU_DATA = palette[i];
    }

    cx = 8;
    cy = 8;
    dir = DIR_DOWN;
    PPU_CTRL = 0x88;                /* NMI 有効 / スプライトはパターンテーブル 1 */
    draw_screen(cx / SCR_W, cy / SCR_H);

    for (;;) {
        wait_vblank();
        update_player(read_pad());
        draw_player();
    }
}
