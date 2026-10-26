/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/*
 * An x86-64 program on msvcrt's start-up, as a console program built against
 * the system's runtime starts: its arguments from __getmainargs, its
 * constructors through _initterm, its exit handlers through _onexit and
 * __dllonexit, its text through `&_iob[1]`, which a 64-bit FILE puts 48 bytes
 * apart. Then the kernel32 structures a 64-bit process lays out with 8-byte
 * pointers: a critical section of 40 bytes, SYSTEM_INFO, the affinity masks.
 * Each check prints a line; the exit code counts the checks that failed.
 */

typedef void *HANDLE;
typedef unsigned long DWORD;
typedef unsigned long long DWORD_PTR;
typedef struct { char opaque[48]; } FILE;
typedef int (*Initialiser)(void);
typedef void (*Constructor)(void);

typedef struct
{
    void *DebugInfo;
    long LockCount;
    long RecursionCount;
    HANDLE OwningThread;
    HANDLE LockSemaphore;
    DWORD_PTR SpinCount;
} CRITICAL_SECTION;

typedef struct
{
    unsigned short wProcessorArchitecture;
    unsigned short wReserved;
    DWORD dwPageSize;
    void *lpMinimumApplicationAddress;
    void *lpMaximumApplicationAddress;
    DWORD_PTR dwActiveProcessorMask;
    DWORD dwNumberOfProcessors;
    DWORD dwProcessorType;
    DWORD dwAllocationGranularity;
    unsigned short wProcessorLevel;
    unsigned short wProcessorRevision;
} SYSTEM_INFO;

__declspec(dllimport) extern FILE _iob[];
__declspec(dllimport) extern char **__initenv;
__declspec(dllimport) int __cdecl __getmainargs(int *argc, char ***argv, char ***env,
    int wildcard, int *startInfo);
__declspec(dllimport) void __cdecl _initterm(Constructor *start, Constructor *end);
__declspec(dllimport) Initialiser __cdecl _onexit(Initialiser handler);
__declspec(dllimport) Initialiser __cdecl __dllonexit(Initialiser handler, Initialiser **begin,
    Initialiser **end);
__declspec(dllimport) int __cdecl fputs(const char *text, FILE *stream);
__declspec(dllimport) int __cdecl fputc(int character, FILE *stream);
__declspec(dllimport) void __cdecl exit(int code);
__declspec(dllimport) unsigned long long __cdecl strlen(const char *text);
__declspec(dllimport) void *__cdecl memset(void *to, int value, unsigned long long count);
__declspec(dllimport) void __stdcall InitializeCriticalSection(CRITICAL_SECTION *section);
__declspec(dllimport) void __stdcall EnterCriticalSection(CRITICAL_SECTION *section);
__declspec(dllimport) void __stdcall LeaveCriticalSection(CRITICAL_SECTION *section);
__declspec(dllimport) int __stdcall TryEnterCriticalSection(CRITICAL_SECTION *section);
__declspec(dllimport) void __stdcall DeleteCriticalSection(CRITICAL_SECTION *section);
__declspec(dllimport) DWORD __stdcall GetCurrentThreadId(void);
__declspec(dllimport) void __stdcall GetSystemInfo(SYSTEM_INFO *info);
__declspec(dllimport) HANDLE __stdcall GetCurrentProcess(void);
__declspec(dllimport) int __stdcall GetProcessAffinityMask(HANDLE process, DWORD_PTR *mine,
    DWORD_PTR *system);

static int failed;
static int built;

static void say(const char *text)
{
    fputs(text, &_iob[1]);
}

static void number(unsigned long long value)
{
    char digits[24];
    int count = 0;
    do
    {
        digits[count++] = (char)('0' + value % 10);
        value /= 10;
    } while (value != 0);
    while (count != 0)
    {
        fputc(digits[--count], &_iob[1]);
    }
}

static void check(const char *what, int good)
{
    say(good ? "ok " : "FAILED ");
    say(what);
    fputc('\n', &_iob[1]);
    failed += !good;
}

static void first(void) { built += 1; }
static void second(void) { built += 10; }
static Constructor constructors[] = { first, 0, second };

static int last(void)
{
    say("bye\n");
    return 0;
}

static Initialiser *table;
static Initialiser *tableEnd;

static int fromLibrary(void)
{
    return 0;
}

void mainCRTStartup(void)
{
    int argc = 0;
    char **argv = 0;
    char **env = 0;
    int startInfo = 0;
    check("__getmainargs answers 0", __getmainargs(&argc, &argv, &env, 0, &startInfo) == 0);
    check("argc counts the program and its two arguments", argc == 3);
    check("argv's pointers are 8 bytes apart", argv != 0 && argv[3] == 0
        && argv[1][0] == 'o' && argv[1][1] == 'n' && argv[1][2] == 'e' && argv[2][0] == 't');
    check("env is __initenv", env != 0 && __initenv == env);
    int variables = 0;
    int named = 1;
    for (char **at = env; *at != 0; at++)
    {
        variables++;
        int equals = 0;
        for (const char *c = *at; *c != 0; c++)
        {
            equals |= *c == '=';
        }
        named &= equals;
    }
    check("env's 8-byte entries are NAME=value strings", variables > 0 && named);
    char filled[16];
    check("guest routines answer a 64-bit caller", strlen(argv[2]) == 3
        && memset(filled, 'x', sizeof filled) == filled && filled[15] == 'x');
    say("argv[2]=");
    say(argv[2]);
    fputc('\n', &_iob[1]);

    _initterm(constructors, constructors + 3);
    check("_initterm runs every constructor of 8-byte entries", built == 11);

    check("_onexit answers its handler", _onexit(last) == last);
    table = (Initialiser *)-1;
    check("__dllonexit answers its handler", __dllonexit(fromLibrary, &table, &tableEnd)
        == fromLibrary);
    check("__dllonexit's table holds one 8-byte entry", tableEnd - table == 1
        && table[0] == fromLibrary);

    CRITICAL_SECTION section;
    InitializeCriticalSection(&section);
    check("a new section is free", section.LockCount == -1 && section.DebugInfo == (void *)-1
        && section.OwningThread == 0);
    EnterCriticalSection(&section);
    EnterCriticalSection(&section);
    check("the owner enters again", section.RecursionCount == 2
        && (DWORD_PTR)section.OwningThread == GetCurrentThreadId());
    check("a try by the owner takes it", TryEnterCriticalSection(&section) == 1
        && section.RecursionCount == 3 && section.LockCount == 2);
    LeaveCriticalSection(&section);
    LeaveCriticalSection(&section);
    LeaveCriticalSection(&section);
    check("left as often as entered, it is free", section.LockCount == -1
        && section.RecursionCount == 0 && section.OwningThread == 0);
    DeleteCriticalSection(&section);

    SYSTEM_INFO info;
    for (unsigned at = 0; at < sizeof info; at++)
    {
        ((volatile char *)&info)[at] = (char)0xcc;
    }
    GetSystemInfo(&info);
    check("SYSTEM_INFO names the x64 processor", info.wProcessorArchitecture == 9
        && info.dwProcessorType == 8664);
    check("SYSTEM_INFO's pointers and mask are 8 bytes", info.dwPageSize == 4096
        && (DWORD_PTR)info.lpMinimumApplicationAddress == 0x10000
        && ((DWORD_PTR)info.lpMaximumApplicationAddress >> 32) == 0
        && info.dwActiveProcessorMask != 0 && (info.dwActiveProcessorMask >> 32) == 0
        && info.dwNumberOfProcessors >= 1 && info.dwAllocationGranularity == 65536);

    DWORD_PTR mine = ~0ull;
    DWORD_PTR system = ~0ull;
    check("the affinity masks are 8 bytes", GetProcessAffinityMask(GetCurrentProcess(), &mine,
        &system) && mine == system && mine != 0 && (mine >> 32) == 0);

    say("failed ");
    number((unsigned long long)failed);
    fputc('\n', &_iob[1]);
    exit(failed);
}
