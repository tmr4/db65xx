putc = $f001

.bss
cur_char: .byte 0

.code

reset:
  ldx #$ff
  txs

  ldx #0
print:
  lda message,x
  sta cur_char
  beq loop
  jsr print_char
  inx
  jmp print

loop:
  jmp loop

print_char:
  sta putc
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
