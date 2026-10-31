/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/*
 * Runs i386 instruction sequences on this processor and says what they did:
 * the hardware half of the 32-bit corpus (tools/x86-corpus.mjs).
 *
 * Freestanding, a static 32-bit program with no C library (none for i386 is
 * needed on the host): it talks to the kernel through `int 0x80` alone --
 * read, write, mmap2, sigaltstack, rt_sigaction, exit.
 *
 * Each case's code is copied to CODE_AT and followed by `hlt`, which user mode
 * may not run: the processor raises #GP there, so every case ends in a signal,
 * the normal end and a fault alike, and the kernel's signal frame holds the
 * whole state as it stood -- the eight registers, EFLAGS, EIP, the exception's
 * vector (`trapno`), its error code and faulting address, and the FPU state:
 * the fxsave image (x87 registers bit for bit, FCW, FSW, the abridged tag,
 * MXCSR, XMM0-7) and, in front of it, the full tag word the kernel derives from
 * it as fnstenv would. A fault is precise: the registers are those before the
 * faulting instruction. Data is DATA_SIZE bytes at DATA_AT, filled from the
 * case's seed by xorshift32, as the corpus's reader fills it; the bytes that
 * changed are reported.
 *
 * In trace mode the case runs with TF set: after every instruction the trap's
 * frame gives the address of the next one and the registers before it, which
 * the generator decodes to know what flags each instruction left undefined.
 * The trace run's own results are not the case's (pushf would push TF).
 *
 * Input on stdin, little-endian, per case: u32 mode (0 run, 1 trace), u32 code
 * length, the code, u32 eax..edi, u32 eflags, the 512-byte fxsave image to
 * start from, u32 seed. Output per case: u32 eax..edi, eflags, eip, trapno,
 * err, signal, si_code, fault address; the 512-byte fxsave image; u32 full tag
 * word; u32 changed bytes and (u32 offset, u8 value) each; u32 trace steps and
 * (eip, eax..edi, eflags) each. A case still running after two seconds is
 * stopped by an alarm and reported with SIGALRM.
 *
 * Built by tools/x86-corpus.mjs: clang -m32 -nostdlib -static, linked by lld.
 */

typedef unsigned int u32;
typedef unsigned short u16;
typedef unsigned char u8;

#define CODE_AT 0x80000u
#define CODE_SIZE 0x10000u
#define DATA_AT 0x100000u
#define DATA_SIZE 0x2000u
#define TRACE_MAX 4096u

#define SIGILL 4
#define SIGTRAP 5
#define SIGBUS 7
#define SIGFPE 8
#define SIGSEGV 11
#define SIGALRM 14

/* The registers and flags the case starts from, then those it ended with. */
u32 g_in[9];
u32 g_out[16];
u32 g_host_esp;
u32 g_code = CODE_AT;
u8 g_fx_in[512] __attribute__((aligned(16)));
u8 g_fx_out[512];
u32 g_tag;
u32 g_tracing;
u32 g_trace_count;
u32 g_trace[TRACE_MAX][10];

extern void enter_case(void);
extern void leave_case(void);
extern void restore_signal(void);
extern u32 sys6(u32 number, u32 a, u32 b, u32 c, u32 d, u32 e, u32 f);

__asm__(
    ".intel_syntax noprefix\n"
    ".globl sys6\n"
    "sys6:\n"
    "    push ebp\n push ebx\n push esi\n push edi\n"
    "    mov eax, [esp + 20]\n mov ebx, [esp + 24]\n mov ecx, [esp + 28]\n"
    "    mov edx, [esp + 32]\n mov esi, [esp + 36]\n mov edi, [esp + 40]\n"
    "    mov ebp, [esp + 44]\n"
    "    int 0x80\n"
    "    pop edi\n pop esi\n pop ebx\n pop ebp\n"
    "    ret\n"
    /* The case's state, every register, then a jump to its code; the flags
       go last of the host stack's, so TF traps no more of the harness. */
    ".globl enter_case\n"
    "enter_case:\n"
    "    push ebp\n push ebx\n push esi\n push edi\n"
    "    mov [g_host_esp], esp\n"
    "    fxrstor [g_fx_in]\n"
    "    push dword ptr [g_in + 32]\n"
    "    mov ecx, [g_in + 4]\n mov edx, [g_in + 8]\n mov ebx, [g_in + 12]\n"
    "    mov ebp, [g_in + 20]\n mov esi, [g_in + 24]\n mov edi, [g_in + 28]\n"
    "    popfd\n"
    "    mov esp, [g_in + 16]\n"
    "    mov eax, [g_in]\n"
    "    jmp dword ptr [g_code]\n"
    /* Back from a signal handler to enter_case's caller, on the host's stack. */
    ".globl leave_case\n"
    "leave_case:\n"
    "    mov esp, [g_host_esp]\n"
    "    cld\n"
    "    pop edi\n pop esi\n pop ebx\n pop ebp\n"
    "    ret\n"
    ".globl restore_signal\n"
    "restore_signal:\n"
    "    mov eax, 173\n"
    "    int 0x80\n"
    ".att_syntax prefix\n");

/* The compiler may call these for copies and clears; there is no library. */
void *memcpy(void *to, const void *from, u32 size)
{
    u8 *t = to;
    const u8 *f = from;
    while (size--)
    {
        *t++ = *f++;
    }
    return to;
}

void *memset(void *to, int value, u32 size)
{
    u8 *t = to;
    while (size--)
    {
        *t++ = (u8)value;
    }
    return to;
}

__attribute__((noreturn)) static void quit(u32 status)
{
    sys6(1, status, 0, 0, 0, 0, 0);
    __builtin_unreachable();
}

static u32 rd(void *into, u32 size)
{
    u8 *at = into;
    u32 got = 0;
    while (got < size)
    {
        int n = (int)sys6(3, 0, (u32)(at + got), size - got, 0, 0, 0);
        if (n <= 0)
        {
            return 0;
        }
        got += (u32)n;
    }
    return 1;
}

static u8 g_buffer[1 << 16];
static u32 g_buffered;

static void flush(void)
{
    u32 sent = 0;
    while (sent < g_buffered)
    {
        int n = (int)sys6(4, 1, (u32)(g_buffer + sent), g_buffered - sent, 0, 0, 0);
        if (n <= 0)
        {
            quit(4);
        }
        sent += (u32)n;
    }
    g_buffered = 0;
}

static void put(const void *from, u32 size)
{
    const u8 *f = from;
    while (size--)
    {
        if (g_buffered == sizeof g_buffer)
        {
            flush();
        }
        g_buffer[g_buffered++] = *f++;
    }
}

static void put32(u32 value)
{
    put(&value, 4);
}

/* The i386 signal frame: ucontext's mcontext at 20, sigcontext's fields by offset. */
#define SC_EDI 16
#define SC_TRAPNO 48
#define SC_ERR 52
#define SC_EIP 56
#define SC_EFLAGS 64
#define SC_FPSTATE 76
#define SC_CR2 84

static u32 word(const u8 *at, u32 offset)
{
    return *(const u32 *)(at + offset);
}

static void on_signal(int signal, void *info, void *context)
{
    u8 *sc = (u8 *)context + 20;
    u32 eip = word(sc, SC_EIP);
    if (signal == SIGTRAP && word(sc, SC_TRAPNO) == 1)
    {
        /* Stepping goes on past a popfd that cleared TF. */
        *(u32 *)(sc + SC_EFLAGS) |= 0x100;
        /* A single step: the state before the instruction at eip. */
        if (g_tracing && eip >= CODE_AT && eip < CODE_AT + CODE_SIZE
            && g_trace_count < TRACE_MAX)
        {
            u32 *step = g_trace[g_trace_count++];
            step[0] = eip;
            /* sigcontext keeps edi esi ebp esp ebx edx ecx eax; the trace eax..edi. */
            static const u8 order[8] = { 7, 6, 5, 4, 3, 2, 1, 0 };
            for (u32 i = 0; i < 8; i++)
            {
                step[1 + i] = word(sc, SC_EDI + 4 * order[i]);
            }
            step[9] = word(sc, SC_EFLAGS);
        }
        return;
    }
    static const u8 order[8] = { 7, 6, 5, 4, 3, 2, 1, 0 };
    for (u32 i = 0; i < 8; i++)
    {
        g_out[i] = word(sc, SC_EDI + 4 * order[i]);
    }
    g_out[8] = word(sc, SC_EFLAGS);
    g_out[9] = eip;
    g_out[10] = word(sc, SC_TRAPNO);
    g_out[11] = word(sc, SC_ERR);
    g_out[12] = (u32)signal;
    g_out[13] = *(const u32 *)((const u8 *)info + 8);
    g_out[14] = *(const u32 *)((const u8 *)info + 12);
    const u8 *fp = (const u8 *)word(sc, SC_FPSTATE);
    if (fp)
    {
        g_tag = word(fp, 8) & 0xffff;
        memcpy(g_fx_out, fp + 112, 512);
    }
    leave_case();
}

static void fill(u8 *data, u32 size, u32 seed)
{
    u32 x = seed ? seed : 1;
    for (u32 i = 0; i < size; i++)
    {
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        data[i] = (u8)x;
    }
}

static u8 g_alternate[1 << 16];
static u8 g_before[DATA_SIZE];

static void run(void)
{
    u8 *code = (u8 *)sys6(192, CODE_AT, CODE_SIZE, 7, 0x32, (u32)-1, 0);
    u8 *data = (u8 *)sys6(192, DATA_AT, DATA_SIZE, 3, 0x32, (u32)-1, 0);
    if ((u32)code != CODE_AT || (u32)data != DATA_AT)
    {
        quit(1);
    }
    u32 stack[3] = { (u32)g_alternate, 0, sizeof g_alternate };
    sys6(186, (u32)stack, 0, 0, 0, 0, 0);
    /* handler, flags (SA_SIGINFO | SA_ONSTACK | SA_NODEFER | SA_RESTORER), restorer, mask */
    u32 action[5] = { (u32)on_signal, 4 | 0x08000000 | 0x40000000 | 0x04000000,
        (u32)restore_signal, 0, 0 };
    static const u32 signals[6] = { SIGILL, SIGTRAP, SIGBUS, SIGFPE, SIGSEGV, SIGALRM };
    for (u32 i = 0; i < 6; i++)
    {
        sys6(174, signals[i], (u32)action, 0, 8, 0, 0);
    }
    u32 last = 0;
    for (;;)
    {
        u32 mode, length, seed;
        if (!rd(&mode, 4))
        {
            break;
        }
        if (!rd(&length, 4) || length > CODE_SIZE - 16 || !rd(code, length)
            || !rd(g_in, sizeof g_in) || !rd(g_fx_in, sizeof g_fx_in) || !rd(&seed, 4))
        {
            quit(3);
        }
        memset(code + length, 0, last > length ? last - length + 1 : 1);
        code[length] = 0xf4;
        last = length;
        fill(data, DATA_SIZE, seed);
        memcpy(g_before, data, DATA_SIZE);
        if (mode)
        {
            g_in[8] |= 0x100;
        }
        g_tracing = mode;
        g_trace_count = 0;
        memset(g_out, 0, sizeof g_out);
        memset(g_fx_out, 0, sizeof g_fx_out);
        g_tag = 0;
        /* A case that runs away ends at the alarm, reported as SIGALRM. */
        sys6(27, 2, 0, 0, 0, 0, 0);
        enter_case();
        sys6(27, 0, 0, 0, 0, 0, 0);
        g_tracing = 0;
        put(g_out, 15 * 4);
        put(g_fx_out, sizeof g_fx_out);
        put32(g_tag);
        u32 changed = 0;
        for (u32 i = 0; i < DATA_SIZE; i++)
        {
            changed += data[i] != g_before[i];
        }
        put32(changed);
        for (u32 i = 0; i < DATA_SIZE; i++)
        {
            if (data[i] != g_before[i])
            {
                put32(i);
                put(&data[i], 1);
            }
        }
        put32(g_trace_count);
        put(g_trace, g_trace_count * 40);
    }
    flush();
}

__attribute__((force_align_arg_pointer)) void _start(void)
{
    run();
    quit(0);
}
