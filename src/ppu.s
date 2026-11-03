; vblank 内で呼ぶ高速な PPU 書き込み。

.export _flush_cells
.import _queue, _queue_n

; void flush_cells(void)
; queue[] の 11 バイトのレコードを queue_n 個ぶん PPU へ書き、queue_n を 0 にする。
;   +0,+1 アドレス, +2,+3 タイル / +4,+5 アドレス, +6,+7 タイル / +8,+9 アドレス, +10 属性
.segment "CODE"
_flush_cells:
    ldx _queue_n
    beq @done
    lda #0
    sta _queue_n
    tay
@loop:
    lda _queue+0,y
    sta $2006
    lda _queue+1,y
    sta $2006
    lda _queue+2,y
    sta $2007
    lda _queue+3,y
    sta $2007
    lda _queue+4,y
    sta $2006
    lda _queue+5,y
    sta $2006
    lda _queue+6,y
    sta $2007
    lda _queue+7,y
    sta $2007
    lda _queue+8,y
    sta $2006
    lda _queue+9,y
    sta $2006
    lda _queue+10,y
    sta $2007
    tya
    clc
    adc #11
    tay
    dex
    bne @loop
@done:
    rts
