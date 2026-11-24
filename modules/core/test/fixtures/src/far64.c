/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/*
 * Reservations past what a 4 GiB layout holds, as a 64-bit Unity player makes
 * them: sixteen of 512 MiB less a page, PAGE_NOACCESS, 8 GiB in all, each with
 * a megabyte committed at a 256 MiB line inside it. Every committed byte is
 * written and read back, by bytes and by quadwords that cross a 64 KiB line,
 * and copied from one reservation to the next; a page reserved but not
 * committed faults when read and when written, and so does one decommitted;
 * VirtualQuery says what each part is; every reservation is released and the
 * space reserved again. Each check prints a line; the exit code counts the
 * ones that failed.
 */

typedef unsigned long DWORD;
typedef void *HANDLE;
typedef unsigned long long QWORD;

typedef struct
{
    void *BaseAddress;
    void *AllocationBase;
    DWORD AllocationProtect;
    unsigned short PartitionId;
    QWORD RegionSize;
    DWORD State;
    DWORD Protect;
    DWORD Type;
} MEMORY_BASIC_INFORMATION;

__declspec(dllimport) void __stdcall ExitProcess(unsigned code);
__declspec(dllimport) HANDLE __stdcall GetStdHandle(DWORD which);
__declspec(dllimport) int __stdcall WriteFile(HANDLE file, const void *bytes, DWORD count,
    DWORD *written, void *overlapped);
__declspec(dllimport) void *__stdcall VirtualAlloc(void *address, QWORD bytes, DWORD type,
    DWORD protect);
__declspec(dllimport) int __stdcall VirtualFree(void *address, QWORD bytes, DWORD type);
__declspec(dllimport) QWORD __stdcall VirtualQuery(const void *address,
    MEMORY_BASIC_INFORMATION *info, QWORD length);

unsigned long __cdecl _exception_code(void);

#define MEM_COMMIT 0x1000
#define MEM_RESERVE 0x2000
#define MEM_DECOMMIT 0x4000
#define MEM_RELEASE 0x8000
#define PAGE_NOACCESS 1
#define PAGE_READWRITE 4
#define ACCESS_VIOLATION 0xC0000005ul
#define RESERVES 16
#define SPAN ((512ull << 20) - 4096)
#define LINE (256ull << 20)
#define COMMITTED (1ull << 20)

static void say(const char *text)
{
    DWORD length = 0, written;
    while (text[length])
    {
        length++;
    }
    WriteFile(GetStdHandle((DWORD)-11), text, length, &written, 0);
}

static void number(const char *what, unsigned value)
{
    char digits[12];
    int at = 11;
    digits[at] = 0;
    do
    {
        digits[--at] = (char)('0' + value % 10);
        value /= 10;
    }
    while (value);
    say(what);
    say(" ");
    say(digits + at);
    say("\r\n");
}

static unsigned failures = 0;

static void check(int right, const char *what)
{
    failures += !right;
    say(right ? "ok   " : "FAIL ");
    say(what);
    say("\r\n");
}

/* The access a __try covers is a call, as the compiler keeps a scope only
 * around one: a fault in the callee reaches the caller's filter. */
static __declspec(noinline) unsigned char load(volatile unsigned char *at)
{
    return *at;
}

static __declspec(noinline) void store(volatile unsigned char *at)
{
    *at = 1;
}

/* Whether reading the byte faults with an access violation. */
static __declspec(noinline) int readFaults(volatile unsigned char *at)
{
    __try
    {
        load(at);
    }
    __except (_exception_code() == ACCESS_VIOLATION)
    {
        return 1;
    }
    return 0;
}

/* Whether writing the byte faults with an access violation. */
static __declspec(noinline) int writeFaults(volatile unsigned char *at)
{
    __try
    {
        store(at);
    }
    __except (_exception_code() == ACCESS_VIOLATION)
    {
        return 1;
    }
    return 0;
}

static unsigned char *base[RESERVES], *part[RESERVES];

void mainCRTStartup(void)
{
    unsigned made = 0, past = 0, committed = 0;
    for (unsigned i = 0; i < RESERVES; i++)
    {
        base[i] = VirtualAlloc(0, SPAN, MEM_RESERVE, PAGE_NOACCESS);
        if (!base[i])
        {
            break;
        }
        made++;
        past += (QWORD)base[i] >> 32 != 0;
        QWORD at = ((QWORD)base[i] + LINE - 1) & ~(LINE - 1);
        if (at + COMMITTED > (QWORD)base[i] + SPAN)
        {
            at = (QWORD)base[i];
        }
        part[i] = VirtualAlloc((void *)at, COMMITTED, MEM_COMMIT, PAGE_READWRITE);
        committed += part[i] == (unsigned char *)at;
    }
    number("reserved", made);
    check(made == RESERVES, "every reservation made");
    check(committed == made, "every commit inside its reservation");
    check(past > 0, "some reservation past 4 GiB");
    if (made != RESERVES || committed != made)
    {
        ExitProcess(failures);
    }

    // Bytes, then quadwords across every 64 KiB line, written and read back.
    unsigned wrong = 0;
    for (unsigned i = 0; i < RESERVES; i++)
    {
        volatile unsigned char *bytes = part[i];
        for (QWORD k = 0; k < COMMITTED; k += 61)
        {
            bytes[k] = (unsigned char)(k * 7 + i);
        }
        for (QWORD k = 0; k < COMMITTED; k += 61)
        {
            wrong += bytes[k] != (unsigned char)(k * 7 + i);
        }
        for (QWORD line = 0x10000; line < COMMITTED; line += 0x10000)
        {
            volatile QWORD *across = (volatile QWORD *)(part[i] + line - 3);
            *across = 0x0102030405060708ull * (i + 1) + line;
        }
        for (QWORD line = 0x10000; line < COMMITTED; line += 0x10000)
        {
            volatile QWORD *across = (volatile QWORD *)(part[i] + line - 3);
            wrong += *across != 0x0102030405060708ull * (i + 1) + line;
        }
    }
    check(wrong == 0, "every byte and quadword read back");

    // A copy from each reservation into the next, then a sum of both.
    unsigned copied = 0;
    for (unsigned i = 0; i + 1 < RESERVES; i++)
    {
        volatile QWORD *from = (volatile QWORD *)part[i];
        volatile QWORD *to = (volatile QWORD *)(part[i + 1] + COMMITTED / 2);
        for (QWORD k = 0; k < COMMITTED / 16; k++)
        {
            to[k] = from[k] ^ 0x5555;
        }
        for (QWORD k = 0; k < COMMITTED / 16; k++)
        {
            copied += to[k] != (from[k] ^ 0x5555);
        }
    }
    check(copied == 0, "every quadword copied to the next reservation");

    // What is reserved and not committed, before and after the committed part.
    unsigned faults = 0, quiet = 0;
    for (unsigned i = 0; i < RESERVES; i++)
    {
        unsigned char *before = part[i] == base[i] ? base[i] + SPAN - 4096 : base[i];
        faults += readFaults(before) + writeFaults(before);
        faults += readFaults(part[i] + COMMITTED) + writeFaults(part[i] + COMMITTED);
        quiet += readFaults(part[i]) + writeFaults(part[i] + COMMITTED - 1);
    }
    check(faults == RESERVES * 4, "a reserved page faults, read or written");
    check(quiet == 0, "a committed page does not");

    MEMORY_BASIC_INFORMATION info;
    unsigned told = 0;
    for (unsigned i = 0; i < RESERVES; i++)
    {
        told += VirtualQuery(part[i] + 100, &info, sizeof info) == sizeof info
            && info.BaseAddress == part[i] && info.AllocationBase == base[i]
            && info.RegionSize == COMMITTED && info.State == MEM_COMMIT
            && info.Protect == PAGE_READWRITE && info.AllocationProtect == PAGE_NOACCESS;
        told += VirtualQuery(part[i] + COMMITTED, &info, sizeof info) == sizeof info
            && info.AllocationBase == base[i] && info.State == MEM_RESERVE
            && info.BaseAddress == part[i] + COMMITTED;
    }
    check(told == RESERVES * 2, "VirtualQuery tells committed from reserved");

    // Decommitted, the pages fault again.
    unsigned gone = 0;
    for (unsigned i = 0; i < RESERVES; i++)
    {
        gone += VirtualFree(part[i], COMMITTED, MEM_DECOMMIT) != 0 && readFaults(part[i]);
    }
    check(gone == RESERVES, "a decommitted page faults");

    unsigned released = 0;
    for (unsigned i = 0; i < RESERVES; i++)
    {
        released += VirtualFree(base[i], 0, MEM_RELEASE) != 0;
    }
    check(released == RESERVES, "every reservation released");
    unsigned again = 0;
    for (unsigned i = 0; i < RESERVES; i++)
    {
        base[i] = VirtualAlloc(0, SPAN, MEM_RESERVE, PAGE_NOACCESS);
        again += base[i] != 0;
    }
    check(again == RESERVES, "the space reserved again");
    number("failed", failures);
    ExitProcess(failures);
}
