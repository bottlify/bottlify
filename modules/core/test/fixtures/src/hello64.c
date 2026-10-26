/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/*
 * The first x86-64 program: prints a line and exits through the x64 calling
 * convention, with what a compiler emits for 64-bit code anyway -- a
 * recursion, a quadword divide by a constant (a multiply-high), SSE moves for
 * the text and a vectorised copy. It exits with 0 only when the arithmetic
 * came out right.
 */

typedef void *HANDLE;
typedef unsigned long DWORD;
__declspec(dllimport) HANDLE __stdcall GetStdHandle(DWORD handle);
__declspec(dllimport) int __stdcall WriteFile(HANDLE file, const void *buffer, DWORD length,
    DWORD *written, void *overlapped);
__declspec(dllimport) void __stdcall ExitProcess(unsigned code);

static unsigned long long fib(unsigned n)
{
    return n < 2 ? n : fib(n - 1) + fib(n - 2);
}

void mainCRTStartup(void)
{
    char text[64] = "hello from x64, fib(40)=";
    unsigned long long value = fib(40);
    char digits[24];
    int count = 0;
    do
    {
        digits[count++] = (char)('0' + value % 10);
        value /= 10;
    } while (value != 0);
    int at = 24;
    while (count != 0)
    {
        text[at++] = digits[--count];
    }
    text[at++] = '\n';
    DWORD written = 0;
    WriteFile(GetStdHandle((DWORD)-11), text, (DWORD)at, &written, 0);
    ExitProcess(written == (DWORD)at && at == 34 ? 0 : 1);
}
