/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/*
 * How much memory a 64-bit process is given: blocks of 64 MiB committed by
 * VirtualAlloc until one is refused, the first and the last byte of each
 * written and read back, then the same from the heap in blocks of 16 MiB.
 * It says how many of each it had, in whole 64 MiB steps (`pages 12`,
 * `heap 3`: the test knows the machine and what that should be), whether
 * every block lay below 4 GiB and whether every byte read back. The exit code
 * is 0 where the refusals were plain (a null, no fault) and the bytes right.
 */

typedef unsigned long DWORD;
typedef unsigned int UINT;
typedef void *HANDLE;
typedef unsigned long long QWORD;

__declspec(dllimport) void __stdcall ExitProcess(UINT code);
__declspec(dllimport) HANDLE __stdcall GetStdHandle(DWORD which);
__declspec(dllimport) int __stdcall WriteFile(HANDLE file, const void *bytes, DWORD count,
    DWORD *written, void *overlapped);
__declspec(dllimport) HANDLE __stdcall GetProcessHeap(void);
__declspec(dllimport) void *__stdcall HeapAlloc(HANDLE heap, DWORD flags, QWORD bytes);
__declspec(dllimport) void *__stdcall VirtualAlloc(void *address, QWORD bytes, DWORD type,
    DWORD protect);

#define MEM_COMMIT 0x1000
#define MEM_RESERVE 0x2000
#define PAGE_READWRITE 4
#define STEP (64ull << 20)
#define MOST 256

static void say(const char *text)
{
    DWORD length = 0, written;
    while (text[length])
    {
        length++;
    }
    WriteFile(GetStdHandle((DWORD)-11), text, length, &written, 0);
}

static void count(const char *what, unsigned value)
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

static int high = 0, wrong = 0;

/* A block the process was given: below 4 GiB, and its ends its own. */
static void taken(unsigned char *block, QWORD bytes, unsigned index)
{
    high += (QWORD)block >> 32 != 0;
    block[0] = (unsigned char)(index + 1);
    block[bytes - 1] = (unsigned char)(index + 101);
}

static void kept(const unsigned char *block, QWORD bytes, unsigned index)
{
    wrong += block[0] != (unsigned char)(index + 1)
        || block[bytes - 1] != (unsigned char)(index + 101);
}

void mainCRTStartup(void)
{
    static unsigned char *pages[MOST], *blocks[MOST];
    unsigned had = 0, heap = 0;
    while (had < MOST)
    {
        unsigned char *block = VirtualAlloc(0, STEP, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE);
        if (!block)
        {
            break;
        }
        taken(block, STEP, had);
        pages[had++] = block;
    }
    while (heap < MOST)
    {
        unsigned char *block = HeapAlloc(GetProcessHeap(), 0, STEP / 4);
        if (!block)
        {
            break;
        }
        taken(block, STEP / 4, heap);
        blocks[heap++] = block;
    }
    for (unsigned index = 0; index < had; index++)
    {
        kept(pages[index], STEP, index);
    }
    for (unsigned index = 0; index < heap; index++)
    {
        kept(blocks[index], STEP / 4, index);
    }
    count("pages", had);
    count("heap", heap / 4);
    say(high ? "FAIL a block past 4 GiB\r\n" : "ok   every block below 4 GiB\r\n");
    say(wrong ? "FAIL a byte read back otherwise\r\n" : "ok   every byte read back\r\n");
    ExitProcess(high + wrong);
}
