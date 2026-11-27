/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/*
 * A 64-bit program on a 64-bit machine, starting a 32-bit child and a 64-bit
 * one beside it: STARTUPINFO and PROCESS_INFORMATION in their 64-bit layouts,
 * IsWow64Process true of the 32-bit child alone, the SysWOW64 directory and
 * the environment's architecture, and each child's exit code read back.
 * Each check prints a line; the exit code counts the checks that failed.
 */

#include "rt.h"

typedef struct
{
    unsigned cb;
    char *lpReserved, *lpDesktop, *lpTitle;
    unsigned dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute,
        dwFlags;
    unsigned short wShowWindow, cbReserved2;
    unsigned char *lpReserved2;
    void *hStdInput, *hStdOutput, *hStdError;
} STARTUPINFOA;

typedef struct
{
    void *hProcess, *hThread;
    unsigned dwProcessId, dwThreadId;
} PROCESS_INFORMATION;

__declspec(dllimport) void *__stdcall GetCurrentProcess(void);
__declspec(dllimport) int __stdcall IsWow64Process(void *process, int *wow64);
__declspec(dllimport) unsigned __stdcall GetSystemWow64DirectoryA(char *buffer, unsigned size);
__declspec(dllimport) unsigned __stdcall GetEnvironmentVariableA(const char *name, char *buffer,
    unsigned size);
__declspec(dllimport) void __stdcall GetStartupInfoA(STARTUPINFOA *info);
__declspec(dllimport) int __stdcall CreateProcessA(const char *application, char *commandLine,
    void *processSecurity, void *threadSecurity, int inherit, unsigned flags, void *environment,
    const char *directory, STARTUPINFOA *startup, PROCESS_INFORMATION *information);
__declspec(dllimport) unsigned __stdcall WaitForSingleObject(void *handle, unsigned milliseconds);
__declspec(dllimport) int __stdcall GetExitCodeProcess(void *process, unsigned *code);
__declspec(dllimport) int __stdcall CloseHandle(void *handle);

#define INFINITE 0xffffffff
#define STALE ((void *)0xdeadbeef00000000ull)

static int same(const char *a, const char *b)
{
    while (*a && *a == *b)
    {
        a++;
        b++;
    }
    return *a == *b;
}

/* A handle written whole: not null, no high half. */
static int whole(void *handle)
{
    return handle != 0 && ((unsigned long long)handle >> 32) == 0;
}

/* Starts a child, answering whether it runs under WOW64 and its exit code. */
static int start(const char *path, int *wow64, unsigned *code)
{
    STARTUPINFOA startup = { sizeof startup };
    PROCESS_INFORMATION information = { STALE, STALE, 0, 0 };
    if (!CreateProcessA(path, 0, 0, 0, 0, 0, 0, 0, &startup, &information)
        || !whole(information.hProcess) || !whole(information.hThread)
        || information.dwProcessId == 0 || information.dwThreadId == 0)
    {
        return 0;
    }
    *wow64 = -1;
    int asked = IsWow64Process(information.hProcess, wow64);
    WaitForSingleObject(information.hProcess, INFINITE);
    *code = 0xffffffff;
    GetExitCodeProcess(information.hProcess, code);
    CloseHandle(information.hThread);
    CloseHandle(information.hProcess);
    return asked;
}

int mainCRTStartup(void)
{
    int wow64 = -1;
    check("a 64-bit process does not run under WOW64",
        IsWow64Process(GetCurrentProcess(), &wow64) && wow64 == 0);
    char directory[64] = { 0 };
    check("GetSystemWow64DirectoryA answers SysWOW64 to it too",
        GetSystemWow64DirectoryA(directory, sizeof directory) == 19
        && same(directory, "C:\\WINDOWS\\SysWOW64"));
    char architecture[16] = { 0 };
    GetEnvironmentVariableA("PROCESSOR_ARCHITECTURE", architecture, sizeof architecture);
    check("the environment names its architecture AMD64", same(architecture, "AMD64"));
    STARTUPINFOA own;
    own.lpReserved2 = STALE;
    GetStartupInfoA(&own);
    check("GetStartupInfoA fills the 104 bytes of a 64-bit STARTUPINFOA",
        own.cb == 104 && own.lpReserved2 == 0);

    unsigned code = 0;
    check("a 32-bit child starts, runs under WOW64 and exits",
        start("C:\\App\\wow64_child.exe", &wow64, &code) && wow64 == 1 && code == 0);
    check("a 64-bit child starts beside it, not under WOW64",
        start("C:\\App\\hello64.exe", &wow64, &code) && wow64 == 0 && code == 0);
    ExitProcess(failures);
    return 0;
}
