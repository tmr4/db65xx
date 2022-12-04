putc := $f001
getc := $f004

.bss
buffer: .res 256

.code

reset:
  ldx #$ff
  txs

  ldx #0
  ldy #0
print:
  lda message,x
  beq @1
  jsr print_char
  inx
  bra print

@1:
  lda #$0d
  jsr print_char

loop:
  jsr get_char
  beq loop
  cmp #$08
  bne @2
  cpy #0
  beq loop
  dey
  bra loop
@2:
  sta buffer,y
  iny
  bra loop

print_char:
  sta putc
  rts

get_char:
  lda getc
  rts

.rodata
message: .asciiz "Hello, world!"

.segment "VECTORS"
.word $0000
.word $0000
.word $0000
.word $0000
.word $0000
.word $0000
.word $0000
.word $0000
.word $0000
.word $0000
.word $0000
.word $0000
.word $0000
.word $0000
.word reset
.word $0000
