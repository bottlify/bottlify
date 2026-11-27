    .text
    .globl _start
_start:
    call main
    hlt
    jmp _start
    .section .note.GNU-stack,"",@progbits
