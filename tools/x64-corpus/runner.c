/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/*
 * Runs x86-64 instruction sequences on this processor and says what they did:
 * the hardware half of the 64-bit corpus (tools/x64-corpus.mjs).
 *
 * Each case is a few instructions with the sixteen general registers and the
 * flags it starts from; its data lives in DATA_SIZE bytes at DATA_AT, below
 * 4 GiB as the engine's window is, filled from the case's seed by the same
 * xorshift the model's side uses; its code is copied to CODE_AT and ends with
 * `jmp [rip + d]` to `exit_case`, whose address sits in the code area's last
 * eight bytes, so every byte a case can read up to there is its own code, that
 * jump or zeros, and the model knows them all. `exit_case` saves the registers
 * and the flags. A fault --
 * a divide by zero, a store off the buffer, an invalid encoding -- is caught
 * on its own stack and reported with its signal and the instruction's address.
 *
 * Input on stdin, little-endian, per case: u32 code length, the code, 17 u64
 * (rax..r15, rflags), u32 seed; xmm0-15 start from the seed too. Output on
 * stdout per case: 17 u64 (the same, after), xmm0-15 (256 bytes), u32 signal
 * (0 for none), u64 faulting address, u32 changed bytes, then (u32 offset, u8
 * value) for each byte of the buffer that changed.
 *
 * Linux on x86-64 only; built by tools/x64-corpus.mjs with clang.
 */

#define _GNU_SOURCE
#include <setjmp.h>
#include <stddef.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <ucontext.h>

#define CODE_AT 0x20000000UL
#define CODE_SIZE 0x10000UL
#define DATA_AT 0x10000000UL
#define DATA_SIZE 0x2000UL
/* The xmm registers start from the case's seed with these bits flipped. */
#define XMM_SEED 0x9e3779b9u

typedef struct { uint64_t r[16]; uint64_t flags; uint8_t x[16][16]; } Regs;

Regs g_in, g_out;
uint64_t g_host_rsp;
uint64_t g_code = CODE_AT;
/* A stack of the harness's own for the exit's pushfq, so the case's stack is left as it was. */
uint64_t g_exit_stack[16];

extern void enter_case(void);
extern char exit_case[];

__asm__(
    ".intel_syntax noprefix\n"
    ".globl enter_case\n"
    "enter_case:\n"
    "    push rbx\n push rbp\n push r12\n push r13\n push r14\n push r15\n"
    "    mov [rip + g_host_rsp], rsp\n"
    "    lea rax, [rip + g_in]\n"
    "    push qword ptr [rax + 128]\n"
    "    popfq\n"
    "    mov rcx, [rax + 8]\n mov rdx, [rax + 16]\n mov rbx, [rax + 24]\n"
    "    mov rsp, [rax + 32]\n mov rbp, [rax + 40]\n mov rsi, [rax + 48]\n"
    "    mov rdi, [rax + 56]\n mov r8, [rax + 64]\n mov r9, [rax + 72]\n"
    "    mov r10, [rax + 80]\n mov r11, [rax + 88]\n mov r12, [rax + 96]\n"
    "    mov r13, [rax + 104]\n mov r14, [rax + 112]\n mov r15, [rax + 120]\n"
    "    movdqu xmm0, [rax + 136]\n movdqu xmm1, [rax + 152]\n movdqu xmm2, [rax + 168]\n"
    "    movdqu xmm3, [rax + 184]\n movdqu xmm4, [rax + 200]\n movdqu xmm5, [rax + 216]\n"
    "    movdqu xmm6, [rax + 232]\n movdqu xmm7, [rax + 248]\n movdqu xmm8, [rax + 264]\n"
    "    movdqu xmm9, [rax + 280]\n movdqu xmm10, [rax + 296]\n movdqu xmm11, [rax + 312]\n"
    "    movdqu xmm12, [rax + 328]\n movdqu xmm13, [rax + 344]\n movdqu xmm14, [rax + 360]\n"
    "    movdqu xmm15, [rax + 376]\n"
    "    mov rax, [rax]\n"
    "    jmp qword ptr [rip + g_code]\n"
    ".globl exit_case\n"
    "exit_case:\n"
    "    mov [rip + g_out], rax\n"
    "    lea rax, [rip + g_out]\n"
    "    mov [rax + 8], rcx\n mov [rax + 16], rdx\n mov [rax + 24], rbx\n"
    "    mov [rax + 32], rsp\n mov [rax + 40], rbp\n mov [rax + 48], rsi\n"
    "    mov [rax + 56], rdi\n mov [rax + 64], r8\n mov [rax + 72], r9\n"
    "    mov [rax + 80], r10\n mov [rax + 88], r11\n mov [rax + 96], r12\n"
    "    mov [rax + 104], r13\n mov [rax + 112], r14\n mov [rax + 120], r15\n"
    "    movdqu [rax + 136], xmm0\n movdqu [rax + 152], xmm1\n movdqu [rax + 168], xmm2\n"
    "    movdqu [rax + 184], xmm3\n movdqu [rax + 200], xmm4\n movdqu [rax + 216], xmm5\n"
    "    movdqu [rax + 232], xmm6\n movdqu [rax + 248], xmm7\n movdqu [rax + 264], xmm8\n"
    "    movdqu [rax + 280], xmm9\n movdqu [rax + 296], xmm10\n movdqu [rax + 312], xmm11\n"
    "    movdqu [rax + 328], xmm12\n movdqu [rax + 344], xmm13\n movdqu [rax + 360], xmm14\n"
    "    movdqu [rax + 376], xmm15\n"
    "    lea rsp, [rip + g_exit_stack + 128]\n"
    "    pushfq\n"
    "    pop qword ptr [rax + 128]\n"
    "    cld\n"
    "    mov rsp, [rip + g_host_rsp]\n"
    "    pop r15\n pop r14\n pop r13\n pop r12\n pop rbp\n pop rbx\n"
    "    ret\n"
    ".att_syntax prefix\n");

static sigjmp_buf g_jump;
static volatile int g_signal;
static volatile uint64_t g_fault_rip;

/* The registers in rax..r15 order, by their place in the signal's context. */
static const int CONTEXT_ORDER[16] = {
    REG_RAX, REG_RCX, REG_RDX, REG_RBX, REG_RSP, REG_RBP, REG_RSI, REG_RDI,
    REG_R8, REG_R9, REG_R10, REG_R11, REG_R12, REG_R13, REG_R14, REG_R15,
};

/* A fault is precise: the registers and flags are as they stood before the faulting instruction. */
static void on_fault(int signal, siginfo_t *info, void *context)
{
    (void)info;
    ucontext_t *uc = context;
    g_signal = signal;
    g_fault_rip = (uint64_t)uc->uc_mcontext.gregs[REG_RIP];
    for (int i = 0; i < 16; i++)
    {
        g_out.r[i] = (uint64_t)uc->uc_mcontext.gregs[CONTEXT_ORDER[i]];
    }
    g_out.flags = (uint64_t)uc->uc_mcontext.gregs[REG_EFL];
    memcpy(g_out.x, uc->uc_mcontext.fpregs->_xmm, sizeof g_out.x);
    siglongjmp(g_jump, 1);
}

/* Bytes from a seed: xorshift32, the low byte each step. */
static void fill(uint8_t *data, size_t size, uint32_t seed)
{
    uint32_t x = seed ? seed : 1;
    for (size_t i = 0; i < size; i++)
    {
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        data[i] = (uint8_t)x;
    }
}

static int readAll(void *into, size_t size)
{
    return fread(into, 1, size, stdin) == size;
}

int main(void)
{
    uint8_t *code = mmap((void *)CODE_AT, CODE_SIZE, PROT_READ | PROT_WRITE | PROT_EXEC,
        MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED, -1, 0);
    uint8_t *data = mmap((void *)DATA_AT, DATA_SIZE, PROT_READ | PROT_WRITE,
        MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED, -1, 0);
    if (code == MAP_FAILED || data == MAP_FAILED)
    {
        perror("mmap");
        return 1;
    }
    static uint8_t alternate[1 << 16];
    stack_t stack = { .ss_sp = alternate, .ss_size = sizeof alternate, .ss_flags = 0 };
    sigaltstack(&stack, NULL);
    struct sigaction action;
    memset(&action, 0, sizeof action);
    action.sa_sigaction = on_fault;
    action.sa_flags = SA_SIGINFO | SA_ONSTACK | SA_NODEFER;
    sigaction(SIGSEGV, &action, NULL);
    sigaction(SIGBUS, &action, NULL);
    sigaction(SIGFPE, &action, NULL);
    sigaction(SIGILL, &action, NULL);
    sigaction(SIGTRAP, &action, NULL);

    static uint8_t before[DATA_SIZE];
    uint32_t length;
    while (readAll(&length, 4))
    {
        if (length > CODE_SIZE - 16)
        {
            return 2;
        }
        uint32_t seed;
        if (!readAll(code, length) || !readAll(&g_in, offsetof(Regs, x)) || !readAll(&seed, 4))
        {
            return 3;
        }
        fill(&g_in.x[0][0], sizeof g_in.x, seed ^ XMM_SEED);
        /* jmp qword ptr [rip + d] to the slot at the area's end; zeros up to it. */
        uint64_t target = (uint64_t)exit_case;
        int32_t disp = (int32_t)(CODE_SIZE - 8 - (length + 6));
        memset(code + length, 0, CODE_SIZE - 8 - length);
        code[length] = 0xff;
        code[length + 1] = 0x25;
        memcpy(code + length + 2, &disp, 4);
        memcpy(code + CODE_SIZE - 8, &target, 8);
        __builtin___clear_cache((char *)code, (char *)code + CODE_SIZE);
        fill(data, DATA_SIZE, seed);
        memcpy(before, data, DATA_SIZE);
        g_signal = 0;
        g_fault_rip = 0;
        memset(&g_out, 0, sizeof g_out);
        if (sigsetjmp(g_jump, 1) == 0)
        {
            enter_case();
        }
        fwrite(&g_out, sizeof g_out, 1, stdout);
        uint32_t signal = (uint32_t)g_signal;
        uint64_t rip = g_fault_rip;
        fwrite(&signal, 4, 1, stdout);
        fwrite(&rip, 8, 1, stdout);
        uint32_t changed = 0;
        for (size_t i = 0; i < DATA_SIZE; i++)
        {
            changed += data[i] != before[i];
        }
        fwrite(&changed, 4, 1, stdout);
        for (uint32_t i = 0; i < DATA_SIZE; i++)
        {
            if (data[i] != before[i])
            {
                fwrite(&i, 4, 1, stdout);
                fwrite(&data[i], 1, 1, stdout);
            }
        }
    }
    return 0;
}
