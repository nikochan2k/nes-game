/* 現代の街道を歩く、世界地図フィールド移動デモ。
 * 4 画面ミラーの VRAM (32x30 マスの輪) をカメラ位置に合わせて少しずつ描き足す。
 * 地形は link_fetch() で外部 (地図サーバー) から z/x/y 指定で受け取る。
 * A でズームイン、B でズームアウト。 */

#include "terrain.h"
#include "link.h"

#define PPU_CTRL   (*(volatile unsigned char *)0x2000)
#define PPU_MASK   (*(volatile unsigned char *)0x2001)
#define PPU_STATUS (*(volatile unsigned char *)0x2002)
#define PPU_SCROLL (*(volatile unsigned char *)0x2005)
#define PPU_ADDR   (*(volatile unsigned char *)0x2006)
#define PPU_DATA   (*(volatile unsigned char *)0x2007)
#define JOY1       (*(volatile unsigned char *)0x4016)
#define OAM        ((volatile unsigned char *)0x0200)

#define PAD_A     0x80
#define PAD_B     0x40
#define PAD_UP    0x08
#define PAD_DOWN  0x04
#define PAD_LEFT  0x02
#define PAD_RIGHT 0x01

#define RING_W 32              /* VRAM の輪: 32x30 マス (1 マス = 16x16 px) */
#define RING_H 30
#define NT_H   15              /* ネームテーブル 1 枚 = 16x15 マス */
#define HALF_W 9               /* 常に読み込んでおく範囲: 中心から左右 9 / 上下 8 マス */
#define HALF_H 8
#define LINE_MAX 19
#define STEP_PX 2              /* 1 フレームの移動量 (16px / 2 = 8 フレーム/マス) */
#define CELLS_PER_FRAME 4      /* 1 フレームで vblank 用に積むマス数 */
#define FETCH_PER_FRAME 8      /* 1 フレームで取得するマス数 */
#define PLAYER_X 120           /* プレイヤーは常に画面中央 */
#define PLAYER_Y 111

enum { DIR_DOWN, DIR_UP, DIR_LEFT, DIR_RIGHT, DIR_NONE };
enum { PROBE_NONE, PROBE_REQ, PROBE_OK, PROBE_BLOCKED };

extern void wait_vblank(void);

/* BG パレット: 0=緑 (草/森/農地/湿地) 1=茶/白 (山/砂/雪) 2=灰 (岩/道路/市街/線路) 3=青 (水/橋)
 * (T_* の並び順) */
static const unsigned char tile_pal[] = {
    0, 0, 1, 2, 3, 3, 3, 2, 2, 2,
    2, 2, 1, 1, 0, 0,
    2, 2, 2, 2,
    2, 2, 2
};

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

typedef unsigned long u32;

#define Z_MIN 1                /* 1 辺は 2^(z+4) マス。z=1 でも 32 マスあり、輪より狭くならない */
#define Z_MAX 18               /* OSM 由来のマスは z18 (約 8m) まで。座標は 24bit のまま */
#include "start.h"            /* START_Z / START_X / START_Y。build/start.h (gfx/gen_start.ts が data/start.json から生成) */

static u32 cx, cy;             /* 現在のマス (世界全体での座標) */
static u32 world_mask;         /* (1 << (z + 4)) - 1 */
static unsigned char z;        /* ズームレベル */
static unsigned char sy_slot;  /* cy % RING_H。% は遅いので増減で追う */
static unsigned char prev_pad;
static unsigned char reload;   /* ズーム変更で VRAM を作り直す */
static signed char ox, oy;     /* 描画上の残り移動量 (px) */
static unsigned char dir;
static unsigned char toggle;   /* 歩くたびに反転 (足の左右) */
static int scr_x, scr_y;       /* スクロール位置 (輪の中の px: 0..511 / 0..479) */

/* 進行方向の先の地形を VRAM から読み戻して通行可否を決める */
static unsigned probe_addr;    /* 進行方向の先のマスの VRAM アドレス */
static unsigned char probe, probe_dir;

/* 1 本ぶん (行または列) の描き足しジョブ */
static unsigned char job_buf[LINE_MAX];
static u32 job_x, job_y;                /* 取得開始のワールド座標 */
static unsigned char job_n, job_fetched, job_done, job_vert, job_sx, job_sy;

static unsigned char attr_shadow[256];   /* 属性テーブルの控え (NT0..3 の 64 バイトずつ) */

#ifdef PROFILE
#define DBG(n) (*(volatile unsigned char *)(0x05F0 + (n)))
#endif

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

/* 輪の中のマス (sx, sy) -> そのマスの左上タイルの VRAM アドレス (上位 / 下位) */
static unsigned cell_addr(unsigned char sx, unsigned char sy)
{
    unsigned char nt = sx >> 4, ly = sy;
    if (sy >= NT_H) {
        nt |= 2;
        ly = sy - NT_H;
    }
    return 0x2000 + ((unsigned)nt << 10) + ((unsigned)ly << 6) + ((unsigned)(sx & 15) << 1);
}

/* vblank に書く内容を先に作っておくキュー (1 マス = 11 バイト)。
 * アドレス計算や属性の合成は重いので vblank の外で済ませる。 */
#define QCELLS 6
#define QREC   11
unsigned char queue[QCELLS * QREC];   /* ppu.s から参照 */
unsigned char queue_n;

/* マス (sx, sy) の描画内容 (タイル 2x2 + 属性) をキューに積む */
static void queue_cell(unsigned char sx, unsigned char sy, unsigned char t)
{
    unsigned char nt = sx >> 4, lx = sx & 15, ly = sy, ab, sh, v, p = tile_pal[t];
    unsigned char *q = queue + queue_n * QREC;
    unsigned char hi, lo;

    if (sy >= NT_H) {
        nt |= 2;
        ly = sy - NT_H;
    }
    t <<= 2;
    hi = 0x20 + (nt << 2) + (ly >> 2);            /* ly * 64 + lx * 2 を 8bit で組む */
    lo = ((ly & 3) << 6) | (lx << 1);
    q[0] = hi;  q[1] = lo;       q[2] = t;      q[3] = t + 1;
    q[4] = hi;  q[5] = lo | 32;  q[6] = t + 2;  q[7] = t + 3;

    ab = (ly >> 1) * 8 + (lx >> 1);
    sh = ((ly & 1) << 2) | ((lx & 1) << 1);
    v = (attr_shadow[(nt << 6) + ab] & (unsigned char)~(3 << sh)) | (p << sh);
    attr_shadow[(nt << 6) + ab] = v;
    q[8] = 0x23 + (nt << 2);  q[9] = 0xC0 + ab;  q[10] = v;
    ++queue_n;
}

/* キューの内容を PPU へ書く (src/ppu.s)。vblank 内で呼ぶ。 */
extern void flush_cells(void);

/* (x, y) から n マスぶんを描き足すジョブを登録する (取得は job_fetch で少しずつ) */
static void job_start(u32 x, u32 y, unsigned char y_slot, unsigned char vert, unsigned char n)
{
    job_x = x;
    job_y = y;
    job_fetched = 0;
    job_sx = x & (RING_W - 1);
    job_sy = y_slot;
    job_vert = vert;
    job_n = n;
    job_done = 0;
}

/* ジョブの地形を最大 max マス取得する。1 フレームに収まるよう分割する。 */
static void job_fetch(unsigned char max)
{
    unsigned char k = job_n - job_fetched;
    if (k > max) {
        k = max;
    }
    if (k) {
        link_fetch(z,
                   job_vert ? job_x : job_x + job_fetched,
                   job_vert ? job_y + job_fetched : job_y,
                   job_vert, k, job_buf + job_fetched);
        job_fetched += k;
    }
}

/* 取得済みのマスを最大 max マスぶんキューに積む */
static void stream_cells(unsigned char max)
{
    while (max-- && job_done < job_fetched) {
        queue_cell(job_sx, job_sy, job_buf[job_done]);
        ++job_done;
        if (job_vert) {
            if (++job_sy == RING_H) {
                job_sy = 0;
            }
        } else {
            job_sx = (job_sx + 1) & (RING_W - 1);
        }
    }
}

/* 通行可否の判定要求を処理する。vblank 内で呼ぶ。 */
static void probe_run(void)
{
    unsigned char t;

    if (probe != PROBE_REQ) {
        return;
    }
    PPU_ADDR = probe_addr >> 8;
    PPU_ADDR = (unsigned char)probe_addr;
    t = PPU_DATA;                   /* 1 回目は読み捨て */
    t = PPU_DATA >> 2;
    /* 線路・高速道路は z14 以上で通行不可 (z13 以下は地図が分断されるので通す) */
    probe = (t == T_WATER || t == T_ROCK || t == T_BUILDING || t == T_WETLAND
             || (z >= 14 && ((t >= T_RAIL_H && t <= T_RAIL_X) || t >= T_HWY_H)))
            ? PROBE_BLOCKED : PROBE_OK;
}

/* vblank 内で呼ぶ */
static void apply_scroll(void)
{
    unsigned char x = PPU_STATUS;
    unsigned char ctrl = 0x88 | (scr_x >> 8), sy = scr_y;
    if (scr_y >= 240) {
        ctrl |= 2;
        sy = scr_y - 240;
    }
    PPU_CTRL = ctrl;
    PPU_SCROLL = (unsigned char)scr_x;
    PPU_SCROLL = sy;
}

static void draw_player(void)
{
    unsigned char moving = (ox | oy) != 0;
    signed char m = ox ? ox : oy;
    unsigned char frame, flip, tl, tr, bl, br;

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
    OAM[0] = PLAYER_Y;      OAM[1] = tl; OAM[2] = flip ? 0x40 : 0; OAM[3] = PLAYER_X;
    OAM[4] = PLAYER_Y;      OAM[5] = tr; OAM[6] = flip ? 0x40 : 0; OAM[7] = PLAYER_X + 8;
    OAM[8] = PLAYER_Y + 8;  OAM[9] = bl; OAM[10] = flip ? 0x41 : 1; OAM[11] = PLAYER_X;
    OAM[12] = PLAYER_Y + 8; OAM[13] = br; OAM[14] = flip ? 0x41 : 1; OAM[15] = PLAYER_X + 8;
}

/* 歩行を 1 フレーム進め、カメラ (スクロール) も同じだけ動かす */
static void advance(void)
{
    if (ox < 0)      { ox += STEP_PX; scr_x += STEP_PX; }
    else if (ox > 0) { ox -= STEP_PX; scr_x -= STEP_PX; }
    if (oy < 0)      { oy += STEP_PX; scr_y += STEP_PX; }
    else if (oy > 0) { oy -= STEP_PX; scr_y -= STEP_PX; }
    if (scr_x < 0) scr_x += RING_W * 16;
    if (scr_x >= RING_W * 16) scr_x -= RING_W * 16;
    if (scr_y < 0) scr_y += RING_H * 16;
    if (scr_y >= RING_H * 16) scr_y -= RING_H * 16;
}

/* sy_slot から d マス (-HALF_H..HALF_H) ずれた行の輪の位置 */
static unsigned char slot_off(signed char d)
{
    unsigned char t = sy_slot + RING_H + d;
    return t >= RING_H ? t - RING_H : t;
}

static void begin_step(unsigned char d)
{
    switch (d) {
    case DIR_UP:
        --cy; oy = 16;
        sy_slot = slot_off(-1);
        job_start(cx - HALF_W, cy - HALF_H, slot_off(-HALF_H), 0, 2 * HALF_W + 1);
        break;
    case DIR_DOWN:
        ++cy; oy = -16;
        sy_slot = slot_off(1);
        job_start(cx - HALF_W, cy + HALF_H, slot_off(HALF_H), 0, 2 * HALF_W + 1);
        break;
    case DIR_LEFT:
        cx = (cx - 1) & world_mask; ox = 16;
        job_start(cx - HALF_W, cy - HALF_H, slot_off(-HALF_H), 1, 2 * HALF_H + 1);
        break;
    default:
        cx = (cx + 1) & world_mask; ox = -16;
        job_start(cx + HALF_W, cy - HALF_H, slot_off(-HALF_H), 1, 2 * HALF_H + 1);
        break;
    }
    toggle ^= 1;
}

static void update_player(unsigned char pad)
{
    unsigned char want = DIR_NONE;

    if (ox || oy) {
        advance();
    }
    if (ox || oy) {
        return;                     /* 歩行中 */
    }

    if (pad & PAD_UP)         want = DIR_UP;
    else if (pad & PAD_DOWN)  want = DIR_DOWN;
    else if (pad & PAD_LEFT)  want = DIR_LEFT;
    else if (pad & PAD_RIGHT) want = DIR_RIGHT;

    if (!(prev_pad & PAD_A) && (pad & PAD_A) && z < Z_MAX) {
        ++z; cx <<= 1; cy <<= 1; reload = 1;
    } else if (!(prev_pad & PAD_B) && (pad & PAD_B) && z > Z_MIN) {
        --z; cx >>= 1; cy >>= 1; reload = 1;
    }
    prev_pad = pad;
    if (reload) {
        return;
    }

    if (probe == PROBE_OK && want == probe_dir) {
        if (job_done < job_n) {
            return;                 /* 前のジョブが終わるまで待つ */
        }
        probe = PROBE_NONE;
        begin_step(want);
        advance();
        return;
    }
    probe = PROBE_NONE;
    if (want == DIR_NONE) {
        return;
    }
    dir = want;                     /* その場で向きだけ変える */
    probe_dir = want;
    if ((want == DIR_UP && cy == 0) || (want == DIR_DOWN && cy == world_mask)) {
        return;                     /* 極の先には進めない */
    }
    if (want == DIR_UP)         probe_addr = cell_addr(cx & (RING_W - 1), slot_off(-1));
    else if (want == DIR_DOWN)  probe_addr = cell_addr(cx & (RING_W - 1), slot_off(1));
    else if (want == DIR_LEFT)  probe_addr = cell_addr((cx - 1) & (RING_W - 1), sy_slot);
    else                        probe_addr = cell_addr((cx + 1) & (RING_W - 1), sy_slot);
    probe = PROBE_REQ;
}

/* 中心の周り (19x17 マス) を描画停止中にまとめて描く */
static void init_world(void)
{
    signed char dy;
    unsigned char n;

    PPU_MASK = 0;
    for (dy = -HALF_H; dy <= HALF_H; ++dy) {
        job_start(cx - HALF_W, cy + dy, slot_off(dy), 0, 2 * HALF_W + 1);
        job_fetch(LINE_MAX);
        for (n = 0; n < 4; ++n) {
            stream_cells(QCELLS);
            flush_cells();
        }
    }
}

/* z, cx, cy から VRAM とスクロールを作り直して表示を始める */
static void reload_world(void)
{
    PPU_MASK = 0;
    world_mask = (1UL << (z + 4)) - 1;
    cx &= world_mask;
    sy_slot = cy % RING_H;
    ox = oy = 0;
    probe = PROBE_NONE;
    queue_n = 0;
    job_n = job_fetched = job_done = 0;
    scr_x = ((cx & (RING_W - 1)) * 16 + RING_W * 16 - PLAYER_X) & (RING_W * 16 - 1);
    scr_y = (sy_slot * 16 + RING_H * 16 - (PLAYER_Y + 1)) % (RING_H * 16);
    init_world();
    draw_player();
    wait_vblank();
    apply_scroll();
    PPU_MASK = 0x1E;
    reload = 0;
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

    z = START_Z;
    cx = START_X;
    cy = START_Y;
    dir = DIR_DOWN;
    PPU_CTRL = 0x88;                /* NMI 有効 / スプライトはパターンテーブル 1 */
    reload_world();

    for (;;) {
        wait_vblank();
        flush_cells();
        probe_run();
        apply_scroll();
        job_fetch(FETCH_PER_FRAME);
        stream_cells(CELLS_PER_FRAME);
        update_player(read_pad());
        if (reload) {
            reload_world();
        }
        draw_player();
#ifdef PROFILE
        ++DBG(0);
        DBG(1) = cx; DBG(2) = cx >> 8; DBG(3) = cx >> 16; DBG(4) = cy; DBG(5) = cy >> 8; DBG(6) = cy >> 16; DBG(7) = z;
#endif
    }
}
