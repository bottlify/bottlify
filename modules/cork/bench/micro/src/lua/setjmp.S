    .text
    .globl setjmp
setjmp:
    mov 4(%esp), %eax
    mov %ebx, 0(%eax)
    mov %esi, 4(%eax)
    mov %edi, 8(%eax)
    mov %ebp, 12(%eax)
    lea 4(%esp), %ecx
    mov %ecx, 16(%eax)
    mov (%esp), %ecx
    mov %ecx, 20(%eax)
    xor %eax, %eax
    ret
    .globl longjmp
longjmp:
    mov 4(%esp), %edx
    mov 8(%esp), %eax
    test %eax, %eax
    jnz 1f
    inc %eax
1:  mov 0(%edx), %ebx
    mov 4(%edx), %esi
    mov 8(%edx), %edi
    mov 12(%edx), %ebp
    mov 16(%edx), %esp
    jmp *20(%edx)
    .section .note.GNU-stack,"",@progbits
