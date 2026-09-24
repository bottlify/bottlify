/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/*
 * The child spawn.exe starts and waits on: it leaves a file and a registry
 * value for its parent to find, and exits with a code the parent reads back --
 * 42, or 7 when its command line says it is the second one.
 */

#include "rt.h"

__declspec(dllimport) char *__stdcall GetCommandLineA(void);
__declspec(dllimport) void *__stdcall CreateFileA(const char *name, unsigned access, unsigned share,
    void *security, unsigned disposition, unsigned flags, void *templateFile);
__declspec(dllimport) int __stdcall CloseHandle(void *handle);
__declspec(dllimport) long __stdcall RegCreateKeyExA(void *key, const char *path, unsigned reserved,
    char *className, unsigned options, unsigned access, void *security, void **result,
    unsigned *disposition);
__declspec(dllimport) long __stdcall RegSetValueExA(void *key, const char *name, unsigned reserved,
    unsigned type, const void *data, unsigned size);
__declspec(dllimport) long __stdcall RegCloseKey(void *key);

#define GENERIC_WRITE 0x40000000
#define CREATE_ALWAYS 2
#define HKEY_CURRENT_USER ((void *)0x80000001)
#define KEY_WRITE 0x20006
#define REG_DWORD 4

static int second(void)
{
    for (const char *at = GetCommandLineA(); *at; at++)
    {
        if (at[0] == 's' && at[1] == 'e' && at[2] == 'c' && at[3] == 'o' && at[4] == 'n'
            && at[5] == 'd')
        {
            return 1;
        }
    }
    return 0;
}

int mainCRTStartup(void)
{
    if (second())
    {
        say("child: second\r\n");
        ExitProcess(7);
    }
    void *file = CreateFileA("C:\\App\\made.txt", GENERIC_WRITE, 0, 0, CREATE_ALWAYS, 0, 0);
    unsigned written;
    WriteFile(file, "from child", 10, &written, 0);
    CloseHandle(file);

    void *key;
    unsigned stage = 2;
    RegCreateKeyExA(HKEY_CURRENT_USER, "Software\\Bottlify\\Spawn", 0, 0, 0, KEY_WRITE, 0, &key, 0);
    RegSetValueExA(key, "Stage", 0, REG_DWORD, &stage, 4);
    RegCloseKey(key);

    say("child: first\r\n");
    ExitProcess(42);
    return 0;
}
