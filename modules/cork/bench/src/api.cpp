/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/*
 * A program's calls into the system in the proportions a frame makes them,
 * between short stretches of its own work: errors and thread identity,
 * thread-local slots, a critical section, interlocked counters, the heap,
 * strings, formatting, a conversion to wide characters, and a sort that calls
 * back into the program. Only what the calls answer deterministically reaches
 * the checksum -- never a handle, an address, a thread id or a time.
 */

#include "rt.h"

extern "C" {
struct CriticalSection {
    void *debug;
    i32 lockCount, recursionCount;
    void *owner, *semaphore;
    u32 spinCount;
};

__declspec(dllimport) u32 __stdcall GetCurrentThreadId(void);
__declspec(dllimport) u32 __stdcall GetLastError(void);
__declspec(dllimport) void __stdcall SetLastError(u32 code);
__declspec(dllimport) u32 __stdcall TlsAlloc(void);
__declspec(dllimport) int __stdcall TlsSetValue(u32 index, void *value);
__declspec(dllimport) void *__stdcall TlsGetValue(u32 index);
__declspec(dllimport) void __stdcall InitializeCriticalSection(CriticalSection *section);
__declspec(dllimport) void __stdcall EnterCriticalSection(CriticalSection *section);
__declspec(dllimport) void __stdcall LeaveCriticalSection(CriticalSection *section);
__declspec(dllimport) i32 __stdcall InterlockedIncrement(volatile i32 *value);
__declspec(dllimport) i32 __stdcall InterlockedCompareExchange(volatile i32 *target, i32 value,
    i32 comparand);
__declspec(dllimport) u32 __stdcall GetTickCount(void);
__declspec(dllimport) int __stdcall QueryPerformanceCounter(i64 *count);
__declspec(dllimport) void *__stdcall GetProcessHeap(void);
__declspec(dllimport) void *__stdcall HeapAlloc(void *heap, u32 flags, u32 bytes);
__declspec(dllimport) int __stdcall HeapFree(void *heap, u32 flags, void *block);
__declspec(dllimport) int __stdcall lstrlenA(const char *text);
__declspec(dllimport) int __stdcall MultiByteToWideChar(u32 codePage, u32 flags, const char *text,
    int length, u16 *wide, int wideLength);

__declspec(dllimport) u32 __cdecl strlen(const char *text);
__declspec(dllimport) int __cdecl strcmp(const char *a, const char *b);
__declspec(dllimport) char *__cdecl strcpy(char *to, const char *from);
__declspec(dllimport) int __cdecl sprintf(char *to, const char *format, ...);
__declspec(dllimport) void *__cdecl malloc(u32 bytes);
__declspec(dllimport) void __cdecl free(void *block);
__declspec(dllimport) void __cdecl qsort(void *base, u32 count, u32 size,
    int(__cdecl *compare)(const void *, const void *));
}

namespace {

volatile u32 sink;

int __cdecl byValue(const void *a, const void *b)
{
    u32 x = *(const u32 *)a, y = *(const u32 *)b;
    return x < y ? -1 : x > y;
}

/* A stretch of the program's own work between calls. */
static u32 own(u32 x, u32 n)
{
    for (u32 i = 0; i < n; i++)
    {
        x = x * 1103515245u + 12345u;
        x ^= x >> 13;
    }
    return x;
}

} // namespace

u32 workApi(u32 iterations)
{
    static const char *const NAMES[] = { "alpha", "bravo", "charlie", "delta", "echo", "foxtrot",
        "golf", "hotel", "india", "juliet", "kilo", "lima" };
    const u32 NAMED = sizeof NAMES / sizeof *NAMES;
    Rng rng(0x5eed0008u);
    CriticalSection section;
    InitializeCriticalSection(&section);
    u32 slot = TlsAlloc();
    void *heap = GetProcessHeap();
    volatile i32 counter = 0;
    char text[64];
    u16 wide[64];
    u32 sortable[64];
    u32 sum = 0, time = 0;
    i64 ticks;
    for (u32 it = 0; it < iterations; it++)
    {
        for (u32 k = 0; k < 2000; k++)
        {
            u32 x = own(rng.next(), 8);
            SetLastError(x & 0xffff);
            sum = mix(sum, GetLastError());
            time ^= GetCurrentThreadId();

            TlsSetValue(slot, (void *)(u32)(x | 1));
            sum = mix(sum, (u32)TlsGetValue(slot));

            EnterCriticalSection(&section);
            sum = mix(sum, (u32)InterlockedIncrement(&counter));
            InterlockedCompareExchange(&counter, (i32)(x & 0xff), (i32)(it * 2000 + k + 1));
            LeaveCriticalSection(&section);
            x = own(x, 4);

            u32 bytes = 16 + (x & 255);
            u8 *block = (u8 *)HeapAlloc(heap, 0, bytes);
            block[0] = (u8)x;
            block[bytes - 1] = (u8)(x >> 8);
            sum = mix(sum, (u32)(block[0] + block[bytes - 1]));
            HeapFree(heap, 0, block);
            char *small = (char *)malloc(24 + (x & 31));
            strcpy(small, NAMES[x % NAMED]);
            sum = mix(sum, strlen(small) * 31 + (u32)lstrlenA(NAMES[(x >> 4) % NAMED]));
            sum = mix(sum, (u32)(strcmp(small, NAMES[(x >> 8) % NAMED]) > 0));
            free(small);

            if ((k & 7) == 0)
            {
                int n = sprintf(text, "%s:%d:%x", NAMES[x % NAMED], (int)(x & 0xfff), x >> 20);
                sum = mix(sum, (u32)n);
                for (int i = 0; i < n; i++)
                {
                    sum = mix(sum, (u8)text[i]);
                }
                int w = MultiByteToWideChar(0, 0, text, -1, wide, 64);
                sum = mix(sum, (u32)w ^ wide[0]);
            }
            if ((k & 63) == 0)
            {
                for (u32 i = 0; i < 64; i++)
                {
                    sortable[i] = own(x + i, 2);
                }
                qsort(sortable, 64, sizeof(u32), byValue);
                sum = mix(sum, sortable[0] ^ sortable[63]);
                time ^= GetTickCount();
                QueryPerformanceCounter(&ticks);
                time ^= (u32)ticks;
            }
        }
    }
    // What varies from one machine to the next goes nowhere a checksum reads.
    sink = time;
    return sum;
}
