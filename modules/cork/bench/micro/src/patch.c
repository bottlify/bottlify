/* A hot loop calling a routine that patches its own immediate when its argument changes, as the
 * era's hand-written inner loops did (Quake's span drawers write a surface's steps into their
 * code): the routine's page is written again and again, so the translator leaves it to the
 * interpreter, and each call from the translated loop crosses into it and back -- the
 * crossing's own cost, where every other workload runs within one tier. */
typedef unsigned int u32;
u32 scale(u32 value, u32 factor);
#ifdef __x86_64__
/* The same routine at 64 bits: its arguments in edi and esi, its immediate reached RIP-relative. */
__asm__(
    ".section .text.patched, \"ax\", @progbits\n"
    ".balign 4096\n"
    "scale:\n"
    "    cmpl %esi, scale_step - 4(%rip)\n"
    "    je 1f\n"
    "    movl %esi, scale_step - 4(%rip)\n"
    "1:  imull $0x12345678, %edi, %eax\n"
    "scale_step:\n"
    "    addl $7, %eax\n"
    "    ret\n"
    ".balign 4096\n"
    ".text\n");
#else
__asm__(
    ".section .text.patched, \"ax\", @progbits\n"
    ".balign 4096\n"
    "scale:\n"
    "    movl 8(%esp), %eax\n"
    "    cmpl %eax, scale_step - 4\n"
    "    je 1f\n"
    "    movl %eax, scale_step - 4\n"
    "1:  movl 4(%esp), %eax\n"
    "    imull $0x12345678, %eax, %eax\n"
    "scale_step:\n"
    "    addl $7, %eax\n"
    "    ret\n"
    ".balign 4096\n"
    ".text\n");
#endif
int main(void){
    u32 sum = 0;
    for (u32 i = 0; i < 10000; i++)
        sum += scale(i, ((i >> 6) & 15) + 1) ^ (sum >> 3);
    return sum;
}
