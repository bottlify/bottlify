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
 * the stack unwinds past it and one around the `__except` that took the
 * exception which the unwind does not run, and a hundred faults in a row so the walk is the
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

static int forwarded = 0;

int __cdecl __C_specific_handler(void *record, void *frame, void *context, void *dispatch);

/* A language handler of the program's own, which hands every frame on to the
 * runtime's, as /GS's __GSHandlerCheck_SEH does after checking the cookie.
 * The build names it for every frame of `via_guest_handler`. */
int __cdecl guest_language_handler(void *record, void *frame, void *context, void *dispatch)
{
    forwarded++;
    return __C_specific_handler(record, frame, context, dispatch);
}

static int guarded_finally = 0;

/* Returns 10 when its own __except takes the exception, having run the
 * __finally inside on the way. */
__declspec(noinline) int via_guest_handler(void)
{
    volatile int r = 0;
    __try
    {
        __try
        {
            raise_one();
            r = 1;
        }
        __finally
        {
            guarded_finally++;
        }
    }
    __except (remember(_exception_code(), 1))
    {
        r = 10;
    }
    return r;
}

/* The x64 runtime's mark: sixteen 16-byte parts, which the compiler hands
 * `_setjmp` with the calling frame beside it. */
typedef struct { unsigned long long part[2]; } __declspec(align(16)) jmp_part;
typedef jmp_part jmp_buf[16];
int __cdecl _setjmp(jmp_buf);
__declspec(noreturn) void __cdecl longjmp(jmp_buf, int);

static jmp_buf mark;
static int jump_finally = 0;

__declspec(noinline) static void jump_back(int value)
{
    __try
    {
        longjmp(mark, value);
    }
    __finally
    {
        jump_finally++;
    }
}

/* Registers a callee keeps hold these across the jump: the mark has them. */
__declspec(noinline) static int marked(int value, int a, int b, int c, int d, double e)
{
    volatile int reached = 0;
    int r = _setjmp(mark);
    if (r == 0)
    {
        reached = 1;
        jump_back(value);
    }
    return r * 1000 + reached * 100 + (a + b + c + d == 10) * 10 + (e == 2.5);
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

    finally_count = 0;
    r = 0;
    __try
    {
        __try
        {
            raise_one();
        }
        __except (1)
        {
            r = 1;
        }
    }
    __finally
    {
        finally_count++;
    }
    check("a __finally around the __except that took it runs once, on leaving",
        r == 1 && finally_count == 1);

    seen = 0;
    r = via_guest_handler();
    check("a frame whose handler hands on to the runtime's reaches its __except",
        r == 10 && seen == 0xe0004321 && forwarded >= 2);
    check("and its __finally runs on the way, once", guarded_finally == 1);

    r = marked(7, 1, 2, 3, 4, 2.5);
    check("a longjmp returns to its mark with its value and the registers kept", r == 7111);
    check("through the __finally between", jump_finally == 1);
    r = marked(0, 1, 2, 3, 4, 2.5);
    check("a longjmp of zero arrives as one", r == 1111 && jump_finally == 2);

    ExitProcess(failures);
    return 0;
}
