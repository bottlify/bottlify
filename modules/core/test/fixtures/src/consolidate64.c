/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/*
 * A consolidating unwind, as the x64 C++ runtime makes one to enter a catch
 * block: the frame's language handler, asked in the search pass, calls
 * RtlUnwindEx to its own frame with a STATUS_UNWIND_CONSOLIDATE record whose
 * first parameter is a callback. Every frame the unwind passes is handed
 * that record, parameters and all, as the runtime reads its catch state from
 * them; at the target the callback is called with the record and answers
 * where the thread goes on. Each check prints a line; the exit code counts
 * the ones that failed.
 */

typedef unsigned long DWORD;
typedef void *HANDLE;

#define STATUS_UNWIND_CONSOLIDATE 0x80000029u
#define EXCEPTION_NONCONTINUABLE 1u
#define EH_UNWINDING 2u
#define EH_TARGET_UNWIND 0x20u

typedef struct
{
    DWORD code;
    DWORD flags;
    void *next;
    void *address;
    DWORD count;
    unsigned long long information[15];
} RECORD64;

__declspec(dllimport) void __stdcall ExitProcess(unsigned code);
__declspec(dllimport) HANDLE __stdcall GetStdHandle(DWORD which);
__declspec(dllimport) int __stdcall WriteFile(HANDLE file, const void *bytes, DWORD count,
    DWORD *written, void *overlapped);
__declspec(dllimport) void __stdcall RaiseException(DWORD code, DWORD flags, DWORD count,
    const unsigned long long *arguments);
__declspec(dllimport) void __stdcall RtlUnwindEx(void *frame, void *ip, RECORD64 *record,
    void *value, void *context, void *history);

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

/* A parameter whose high half matters, as a pointer above 4 GiB has. */
#define WIDE_PARAMETER 0x00007ffe12345678ull

static int searched = 0;
static int unwound = 0;
static int at_target = 0;
static unsigned long long seen_count = 0;
static unsigned long long seen_parameter = 0;
static int called_back = 0;
static int inner_finally = 0;
static __declspec(align(16)) unsigned char context[0x4d0];

/* Where the thread goes on: no frame below it is left to return into. */
static void landed(void)
{
    check("the search pass reached the frame's handler once", searched == 1);
    check("the frame between ran its __finally on the way", inner_finally == 1);
    check("each frame unwound was handed the program's record, parameters whole",
        unwound >= 1 && seen_count == 3 && seen_parameter == WIDE_PARAMETER);
    check("the target frame was told it is the target", at_target == 1);
    check("the callback was called once, with the record", called_back == 1);
    ExitProcess(failures);
}

/* What the runtime's __CxxCallCatchBlock is to its unwind: the catch block
 * would run here; the answer is where the thread goes on. */
static void *consolidated(RECORD64 *record)
{
    called_back += record->code == STATUS_UNWIND_CONSOLIDATE
        && record->information[2] == WIDE_PARAMETER;
    return (void *)landed;
}

/* The build names it for every frame of `via_guest_handler`. */
int __cdecl guest_language_handler(RECORD64 *record, void *frame, void *dispatch_context,
    void *dispatch)
{
    (void)dispatch_context;
    (void)dispatch;
    if ((record->flags & EH_UNWINDING) == 0)
    {
        RECORD64 consolidate = { STATUS_UNWIND_CONSOLIDATE, EXCEPTION_NONCONTINUABLE, 0, 0, 3,
            { (unsigned long long)consolidated, 0x1234, WIDE_PARAMETER } };
        searched++;
        RtlUnwindEx(frame, (void *)landed, &consolidate, 0, context, 0);
        check("RtlUnwindEx does not return", 0);
        ExitProcess(100);
    }
    if (record->code == STATUS_UNWIND_CONSOLIDATE)
    {
        unwound++;
        seen_count = record->count;
        seen_parameter = record->information[2];
        at_target += (record->flags & EH_TARGET_UNWIND) != 0;
    }
    return 1; /* ExceptionContinueSearch */
}

__declspec(noinline) static void raise_one(void)
{
    RaiseException(0xe0001234, 0, 0, 0);
}

__declspec(noinline) static void between(void)
{
    __try
    {
        raise_one();
    }
    __finally
    {
        inner_finally++;
    }
}

__declspec(noinline) int consolidate_via_guest_handler(void)
{
    volatile int r = 0;
    __try
    {
        between();
        r = 1;
    }
    __finally
    {
        r = 2;
    }
    return r;
}

int mainCRTStartup(void)
{
    consolidate_via_guest_handler();
    check("the unwind went on at the callback's answer", 0);
    ExitProcess(failures + 1);
    return 0;
}
