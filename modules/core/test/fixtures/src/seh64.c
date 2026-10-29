/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/*
 * Table-based structured exception handling, as a 64-bit console program
 * built against the system runtime uses it: `__try`/`__except` frames whose
 * language handler is `__C_specific_handler`, a raised exception and
 * processor faults alike reaching their filter, a `__finally` that runs as
 * the stack unwinds past it, and a hundred faults in a row so the walk is the
 * same every time. Each check prints a line; the exit code counts the ones
 * that failed.
 */

typedef unsigned long DWORD;
typedef void *HANDLE;

__declspec(dllimport) void __stdcall ExitProcess(unsigned code);
__declspec(dllimport) HANDLE __stdcall GetStdHandle(DWORD which);
__declspec(dllimport) int __stdcall WriteFile(HANDLE file, const void *bytes, DWORD count,
    DWORD *written, void *overlapped);
__declspec(dllimport) void __stdcall RaiseException(DWORD code, DWORD flags, DWORD count,
    const unsigned long long *arguments);

unsigned long __cdecl _exception_code(void);

static void say(const char *text)
{
    DWORD length = 0, written;
    while (text[length])
    {
        length++;
    }
    WriteFile(GetStdHandle((DWORD)-11), text, length, &written, 0);
}

static int failures = 0;
static void check(const char *what, int ok)
{
    say(ok ? "ok   " : "FAIL ");
    say(what);
    say("\r\n");
    failures += !ok;
}

static volatile int zero = 0;
static unsigned seen = 0;
static int finally_count = 0;

static int remember(unsigned code, int answer)
{
    seen = code;
    return answer;
}

__declspec(noinline) static void raise_one(void)
{
    RaiseException(0xe0004321, 0, 0, 0);
}

__declspec(noinline) static int divide(int value)
{
    return value / zero;
}

__declspec(noinline) static void invalid(void)
{
    __asm__ volatile(".byte 0x0f, 0x0b"); /* ud2 */
}

/* A __finally that an exception unwinds through, counted so the run can see
 * it ran exactly once before the outer __except block. */
__declspec(noinline) static void through_finally(void)
{
    __try
    {
        raise_one();
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
    check("and the filter sees its code", seen == 0xe0004321);

    r = 0;
    __try
    {
        through_finally();
    }
    __except (1)
    {
        r = 1;
    }
    check("a __finally runs as the stack unwinds past it", finally_count == 1 && r == 1);

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
        r = 1;
        __try
        {
            raise_one();
        }
        __finally
        {
            r += 4;
        }
    }
    __except (1)
    {
        r += 100;
    }
    check("an inner __finally runs before the outer __except", r == 105);

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

    ExitProcess(failures);
    return 0;
}
