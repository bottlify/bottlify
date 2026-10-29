/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/*
 * A 32-bit program a 64-bit one starts (wow64.c): it runs under WOW64, and
 * every way of asking says so -- IsWow64Process, GetNativeSystemInfo against
 * GetSystemInfo, the SysWOW64 directory, the environment's two architectures.
 * Each check prints a line prefixed "child"; the exit code counts the checks
 * that failed.
 */

#include "rt.h"

typedef struct
{
    unsigned short wProcessorArchitecture, wReserved;
    unsigned dwPageSize;
    void *lpMinimumApplicationAddress, *lpMaximumApplicationAddress;
    unsigned dwActiveProcessorMask, dwNumberOfProcessors, dwProcessorType,
        dwAllocationGranularity;
    unsigned short wProcessorLevel, wProcessorRevision;
} SYSTEM_INFO;

__declspec(dllimport) void *__stdcall GetCurrentProcess(void);
__declspec(dllimport) int __stdcall IsWow64Process(void *process, int *wow64);
__declspec(dllimport) void __stdcall GetSystemInfo(SYSTEM_INFO *info);
__declspec(dllimport) void __stdcall GetNativeSystemInfo(SYSTEM_INFO *info);
__declspec(dllimport) unsigned __stdcall GetSystemWow64DirectoryA(char *buffer, unsigned size);
__declspec(dllimport) unsigned __stdcall GetEnvironmentVariableA(const char *name, char *buffer,
    unsigned size);

#define PROCESSOR_ARCHITECTURE_INTEL 0
#define PROCESSOR_ARCHITECTURE_AMD64 9

static int same(const char *a, const char *b)
{
    while (*a && *a == *b)
    {
        a++;
        b++;
    }
    return *a == *b;
}

static void child(const char *what, int ok)
{
    say("child ");
    check(what, ok);
}

int mainCRTStartup(void)
{
    int wow64 = -1;
    child("IsWow64Process says this process runs under WOW64",
        IsWow64Process(GetCurrentProcess(), &wow64) && wow64 == 1);

    SYSTEM_INFO info, native;
    GetSystemInfo(&info);
    GetNativeSystemInfo(&native);
    child("GetSystemInfo names the x86 processor the process sees",
        info.wProcessorArchitecture == PROCESSOR_ARCHITECTURE_INTEL);
    child("GetNativeSystemInfo the x64 machine beneath",
        native.wProcessorArchitecture == PROCESSOR_ARCHITECTURE_AMD64
        && native.dwProcessorType == 8664);

    char directory[64] = { 0 };
    unsigned length = GetSystemWow64DirectoryA(directory, sizeof directory);
    child("GetSystemWow64DirectoryA answers SysWOW64",
        length == 19 && same(directory, "C:\\WINDOWS\\SysWOW64"));

    char architecture[16] = { 0 }, beneath[16] = { 0 };
    GetEnvironmentVariableA("PROCESSOR_ARCHITECTURE", architecture, sizeof architecture);
    GetEnvironmentVariableA("PROCESSOR_ARCHITEW6432", beneath, sizeof beneath);
    child("and the environment says x86, over AMD64",
        same(architecture, "x86") && same(beneath, "AMD64"));
    ExitProcess(failures);
    return 0;
}
