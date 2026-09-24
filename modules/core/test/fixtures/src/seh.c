/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/*
 * Structured exception handling as the compiler emits it against the
 * system's C runtime: `__try` frames handled by `_except_handler3`, raised
 * exceptions and processor faults alike, and a longjmp out through a
 * `__finally`.
 */

#include "rt.h"

unsigned long __cdecl _exception_code(void);
__declspec(dllimport) void __stdcall RaiseException(unsigned code, unsigned flags,
    unsigned count, const void *arguments);

typedef int jmp_buf[16];
int __cdecl _setjmp3(jmp_buf, int, ...);
__declspec(noreturn) void __cdecl longjmp(jmp_buf, int);

static volatile int zero = 0;
static unsigned seen = 0;

static int remember(unsigned code, int answer)
{
    seen = code;
    return answer;
}

__declspec(noinline) static void raise_one(void)
{
    RaiseException(0xe0001234, 0, 0, 0);
}

__declspec(noinline) static int divide(int value)
{
    return value / zero;
}

__declspec(noinline) static void invalid(void)
{
    __asm__ volatile(".byte 0x0f, 0x0b"); /* ud2 */
}

__declspec(noinline) static void breakpoint(void)
{
    __asm__ volatile(".byte 0xcc"); /* int3 */
}

static jmp_buf mark;
static int finally_count = 0;

__declspec(noinline) static void jump_out(void)
{
    __try
    {
        longjmp(mark, 5);
    }
    __finally
    {
        finally_count++;
    }
}

int mainCRTStartup(void)
{
    volatile int r = 0;

    __try
    {
        raise_one();
        r = 1;
    }
    __except (remember(_exception_code(), 1))
    {
        r = 10;
    }
    check("a raised exception reaches its __except block", r == 10);
    check("and the filter sees its code", seen == 0xe0001234);

    r = 0;
    __try
    {
        __try
        {
            raise_one();
        }
        __finally
        {
            r += 5;
        }
    }
    __except (1)
    {
        r += 100;
    }
    check("an inner __finally runs before the outer __except block", r == 105);

    r = 0;
    __try
    {
        r = divide(10);
    }
    __except (remember(_exception_code(), 1))
    {
        r = -1;
    }
    check("a divide by zero is an exception", r == -1 && seen == 0xc0000094);

    r = 0;
    __try
    {
        invalid();
    }
    __except (remember(_exception_code(), 1))
    {
        r = -2;
    }
    check("an invalid opcode is an exception", r == -2 && seen == 0xc000001d);

    r = 0;
    __try
    {
        breakpoint();
    }
    __except (remember(_exception_code(), 1))
    {
        r = -3;
    }
    check("a breakpoint is an exception", r == -3 && seen == 0x80000003);

    int caught = 0;
    for (int i = 0; i < 100; i++)
    {
        __try
        {
            divide(i);
        }
        __except (1)
        {
            caught++;
        }
    }
    check("a hundred faults in a row", caught == 100);

    int value = _setjmp3(mark, 0);
    if (value == 0)
    {
        jump_out();
    }
    check("longjmp returns to the mark with its value", value == 5);
    check("and runs the __finally it leaves on the way", finally_count == 1);

    ExitProcess(failures);
    return 0;
}
