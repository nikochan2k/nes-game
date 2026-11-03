; 最小の NES 起動コード (mapper 0, 4 画面ミラー)。
; NMI で OAM DMA(シャドウ $0200)とフレームカウンタ更新だけ行う。

.export __STARTUP__ : absolute = 1
.export _exit
.export _wait_vblank
.exportzp _nmi_count

.import _main
.import copydata, zerobss, initlib, donelib
.import __SRAM_START__, __SRAM_SIZE__
.importzp sp

.segment "HEADER"
    .byte "NES", $1A
    .byte 2             ; PRG 16K x 2
    .byte 1             ; CHR 8K x 1
    .byte $08           ; 4 画面ミラー / mapper 0
    .byte 0
    .res 8, 0

.segment "ZEROPAGE"
_nmi_count: .res 1

.segment "STARTUP"
reset:
    sei
    cld
    ldx #$40
    stx $4017           ; フレーム IRQ 禁止
    ldx #$FF
    txs
    inx
    stx $2000           ; NMI 禁止
    stx $2001           ; 描画禁止
    stx $4010           ; DMC IRQ 禁止
    bit $2002
:   bit $2002
    bpl :-              ; vblank 1回目

    txa                 ; A = 0
:   sta $0000,x
    sta $0100,x
    sta $0300,x
    sta $0400,x
    sta $0500,x
    sta $0600,x
    sta $0700,x
    inx
    bne :-
    lda #$FF            ; 全スプライトを画面外へ
:   sta $0200,x
    inx
    bne :-
:   bit $2002
    bpl :-              ; vblank 2回目

    lda #<(__SRAM_START__ + __SRAM_SIZE__)
    sta sp
    lda #>(__SRAM_START__ + __SRAM_SIZE__)
    sta sp+1
    jsr zerobss
    jsr copydata
    jsr initlib
    jsr _main
_exit:
    jsr donelib
:   jmp :-

nmi:
    pha
    lda #0
    sta $2003
    lda #2
    sta $4014           ; OAM DMA ($0200)
    inc _nmi_count
    pla
irq:
    rti

.segment "CODE"
; void wait_vblank(void)  次の NMI まで待つ
_wait_vblank:
    lda _nmi_count
:   cmp _nmi_count
    beq :-
    rts

.segment "VECTORS"
    .word nmi, reset, irq
