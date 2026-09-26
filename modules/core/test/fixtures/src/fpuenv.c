/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/*
 * The floating-point environment a thread starts with. Windows starts every
 * thread at the x87 control word 0x27f and an MXCSR of 0x1f80, whatever the
 * thread that created it set: a precision a thread chose and its SSE modes are
 * its own.
 */

#include "rt.h"

__declspec(dllimport) void *__stdcall CreateThread(void *security, unsigned stack,
    unsigned (__stdcall *start)(void *), void *argument, unsigned flags, unsigned *id);
__declspec(dllimport) unsigned __stdcall WaitForSingleObject(void *handle, unsigned milliseconds);

#define INFINITE 0xffffffffu

static unsigned short control(void)
{
    unsigned short word;
    __asm__ volatile("fnstcw %0" : "=m"(word));
    return word;
}

static unsigned simd(void)
{
    unsigned word;
    __asm__ volatile("stmxcsr %0" : "=m"(word));
    return word;
}

static volatile unsigned short child_control = 0;
static volatile unsigned child_simd = 0;

static unsigned __stdcall child(void *unused)
{
    (void)unused;
    child_control = control();
    child_simd = simd();
    return 0;
}

int mainCRTStartup(void)
{
    check("the first thread starts at control word 0x27f", control() == 0x27f);
    check("the first thread starts at MXCSR 0x1f80", simd() == 0x1f80);

    /* Single precision, and SSE's flush-to-zero and denormals-are-zero. */
    unsigned short single = 0x007f;
    unsigned flush = 0x9fc0;
    __asm__ volatile("fldcw %0" : : "m"(single));
    __asm__ volatile("ldmxcsr %0" : : "m"(flush));

    void *thread = CreateThread(0, 0, child, 0, 0, 0);
    WaitForSingleObject(thread, INFINITE);
    check("a created thread starts at 0x27f, not its creator's word", child_control == 0x27f);
    check("a created thread starts at MXCSR 0x1f80, not its creator's", child_simd == 0x1f80);
    check("the creator keeps its own word", control() == 0x007f);
    check("and its own MXCSR", simd() == 0x9fc0);
    ExitProcess(failures);
    return 0;
}
