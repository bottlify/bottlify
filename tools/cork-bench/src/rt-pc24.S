    # The start of a program under Direct3D: creating the device left the x87
    # precision control at single (PC = 00) on the thread, once, and every
    # frame after runs under it.
    .text
    .globl _start
_start:
    subl $4, %esp
    fnstcw (%esp)
    andw $0xfcff, (%esp)
    fldcw (%esp)
    addl $4, %esp
1:
    call main
    hlt
    jmp 1b
    .section .note.GNU-stack,"",@progbits
