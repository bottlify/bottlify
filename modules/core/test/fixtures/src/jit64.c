/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/*
 * Where a 64-bit process's code runs from, by the last letter of its command
 * line: `i` runs a loop in the image, `j` the same bytes copied into pages it
 * asked for as executable (what a JIT does), `h` a loop of HeapAlloc and
 * HeapFree (the system's own code), `s` a loop of strlen (the C runtime's).
 * Each says its result (`sum 1234`), which is the same wherever the code lay;
 * the test reads from the engine how the instructions were run.
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
__declspec(dllimport) int __stdcall HeapFree(HANDLE heap, DWORD flags, void *block);
__declspec(dllimport) void *__stdcall VirtualAlloc(void *address, QWORD bytes, DWORD type,
    DWORD protect);
__declspec(dllimport) char *__stdcall GetCommandLineA(void);
__declspec(dllimport) QWORD __cdecl strlen(const char *text);

#define MEM_COMMIT 0x1000
#define MEM_RESERVE 0x2000
#define PAGE_EXECUTE_READWRITE 0x40

static void say(const char *text)
{
    DWORD length = 0, written;
    while (text[length])
    {
        length++;
    }
    WriteFile(GetStdHandle((DWORD)-11), text, length, &written, 0);
}

static void count(const char *what, QWORD value)
{
    char digits[24];
    int at = 23;
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

/* No call and no address of its own in it: its bytes run wherever they lie. */
__attribute__((noinline)) static QWORD work(QWORD seed, QWORD rounds)
{
    QWORD sum = 0;
    while (rounds--)
    {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        sum += seed & 0xff;
    }
    return sum;
}

/* Laid after `work`: where its bytes end. */
__attribute__((noinline)) static QWORD after(QWORD seed)
{
    return seed * 3 + 1;
}

typedef QWORD (*Work)(QWORD seed, QWORD rounds);

void mainCRTStartup(void)
{
    const char *line = GetCommandLineA();
    char how = 'i';
    QWORD sum = 0;
    while (*line)
    {
        how = *line++;
    }
    if (how == 'i')
    {
        sum = work(after(7), 3000000);
    }
    else if (how == 'j')
    {
        const unsigned char *from = (const unsigned char *)work;
        QWORD bytes = (QWORD)((const unsigned char *)after - from);
        unsigned char *pages = VirtualAlloc(0, 4096, MEM_RESERVE | MEM_COMMIT,
            PAGE_EXECUTE_READWRITE);
        if (!pages || bytes == 0 || bytes > 4096)
        {
            say("FAIL no pages for the code\r\n");
            ExitProcess(2);
        }
        for (QWORD index = 0; index < bytes; index++)
        {
            pages[index] = from[index];
        }
        count("code", (QWORD)pages >> 32);
        sum = ((Work)pages)(after(7), 3000000);
    }
    else if (how == 'h')
    {
        HANDLE heap = GetProcessHeap();
        for (unsigned round = 0; round < 100000; round++)
        {
            unsigned char *block = HeapAlloc(heap, 0, 64 + (round & 63));
            block[0] = (unsigned char)round;
            sum += block[0];
            HeapFree(heap, 0, block);
        }
    }
    else
    {
        static char text[200];
        for (unsigned index = 0; index < 199; index++)
        {
            text[index] = 'a';
        }
        for (unsigned round = 0; round < 100000; round++)
        {
            text[100 + (round & 63)] = 0;
            sum += strlen(text);
            text[100 + (round & 63)] = 'a';
        }
    }
    count("sum", sum);
    ExitProcess(0);
}
