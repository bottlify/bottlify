/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/*
 * The processor, asked every way a program asks: the CPUID instruction,
 * GetSystemInfo, IsProcessorFeaturePresent, the registry key the kernel writes
 * at boot, and the process block. Every answer has to agree with CPUID. The
 * raw leaf 1 is printed too, for the test to hold the engine's own record of
 * it to what the processor says.
 */

#include "rt.h"

typedef struct
{
    unsigned short architecture, reserved;
    unsigned page_size;
    void *minimum, *maximum;
    unsigned active_mask, count, type, granularity;
    unsigned short level, revision;
} SYSTEM_INFO;

__declspec(dllimport) void __stdcall GetSystemInfo(SYSTEM_INFO *info);
__declspec(dllimport) int __stdcall IsProcessorFeaturePresent(unsigned feature);
__declspec(dllimport) long __stdcall RegOpenKeyExA(void *key, const char *path, unsigned options,
    unsigned access, void **result);
__declspec(dllimport) long __stdcall RegQueryValueExA(void *key, const char *name,
    unsigned *reserved, unsigned *type, void *data, unsigned *size);

#define HKEY_LOCAL_MACHINE ((void *)0x80000002)
#define KEY_READ 0x20019

static void hex(unsigned value)
{
    char text[11] = "0x00000000";
    for (int i = 0; i < 8; i++)
    {
        unsigned digit = value >> (28 - 4 * i) & 15;
        text[2 + i] = (char)(digit < 10 ? '0' + digit : 'a' + digit - 10);
    }
    say(text);
}

static int same(const char *a, const char *b)
{
    while (*a && *a == *b)
    {
        a++;
        b++;
    }
    return *a == *b;
}

static void number(char **at, unsigned value)
{
    char digits[12];
    int n = 0;
    do
    {
        digits[n++] = (char)('0' + value % 10);
        value /= 10;
    } while (value);
    while (n)
    {
        *(*at)++ = digits[--n];
    }
}

int mainCRTStartup(void)
{
    unsigned eax, ebx, ecx, edx;
    __asm__ volatile("cpuid" : "=a"(eax), "=b"(ebx), "=c"(ecx), "=d"(edx) : "a"(1), "c"(0));
    unsigned family = eax >> 8 & 15, model = eax >> 4 & 15, stepping = eax & 15;

    say("cpuid ");
    hex(eax);
    say(" ");
    hex(ecx);
    say(" ");
    hex(edx);
    say("\r\n");

    SYSTEM_INFO info;
    GetSystemInfo(&info);
    check("GetSystemInfo's level is CPUID's family", info.level == family);
    check("and its revision CPUID's model and stepping",
        info.revision == (model << 8 | stepping));
    check("one processor, in the mask as well", info.count == 1 && info.active_mask == 1);

    check("MMX as CPUID says", IsProcessorFeaturePresent(3) == !!(edx & 1 << 23));
    check("SSE as CPUID says", IsProcessorFeaturePresent(6) == !!(edx & 1 << 25));
    check("SSE2 as CPUID says", IsProcessorFeaturePresent(10) == !!(edx & 1 << 26));
    check("SSE3 as CPUID says", IsProcessorFeaturePresent(13) == !!(ecx & 1));
    check("rdtsc as CPUID says", IsProcessorFeaturePresent(8) == !!(edx & 1 << 4));
    check("cmpxchg8b as CPUID says", IsProcessorFeaturePresent(2) == !!(edx & 1 << 8));

    char expected[64];
    char *at = expected;
    for (const char *s = "x86 Family "; *s; s++) *at++ = *s;
    number(&at, family);
    for (const char *s = " Model "; *s; s++) *at++ = *s;
    number(&at, model);
    for (const char *s = " Stepping "; *s; s++) *at++ = *s;
    number(&at, stepping);
    *at = 0;

    void *key = 0;
    char identifier[64];
    identifier[0] = 0;
    unsigned size = sizeof identifier, type = 0;
    long opened = RegOpenKeyExA(HKEY_LOCAL_MACHINE,
        "HARDWARE\\DESCRIPTION\\System\\CentralProcessor\\0", 0, KEY_READ, &key);
    long read = RegQueryValueExA(key, "Identifier", 0, &type, identifier, &size);
    check("the registry names the processor CPUID describes",
        opened == 0 && read == 0 && same(identifier, expected));

    unsigned peb;
    __asm__ volatile("movl %%fs:0x30, %0" : "=r"(peb));
    check("the process block counts the same processors",
        *(unsigned *)(peb + 0x64) == info.count);

    ExitProcess(failures);
    return 0;
}
