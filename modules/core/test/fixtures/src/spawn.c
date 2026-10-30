/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/*
 * A parent that goes on after its child: it starts spawn_child.exe, waits on
 * the process, and then reads what the child left -- its exit code, the file
 * it wrote, the registry value it set. Then once more through
 * WaitForMultipleObjects, where the answer is the child's place in the set.
 */

#include "rt.h"

typedef struct
{
    unsigned cb;
    char *reserved, *desktop, *title;
    unsigned x, y, width, height, xChars, yChars, fill, flags;
    unsigned short show, reserved2;
    void *reserved3, *input, *output, *error;
} STARTUPINFOA;

typedef struct
{
    void *process, *thread;
    unsigned processId, threadId;
} PROCESS_INFORMATION;

__declspec(dllimport) int __stdcall CreateProcessA(const char *application, char *commandLine,
    void *processSecurity, void *threadSecurity, int inherit, unsigned flags, void *environment,
    const char *directory, STARTUPINFOA *startup, PROCESS_INFORMATION *information);
__declspec(dllimport) unsigned __stdcall WaitForSingleObject(void *handle, unsigned milliseconds);
__declspec(dllimport) unsigned __stdcall WaitForMultipleObjects(unsigned count, void **handles,
    int waitAll, unsigned milliseconds);
__declspec(dllimport) int __stdcall GetExitCodeProcess(void *process, unsigned *code);
__declspec(dllimport) void *__stdcall CreateEventA(void *security, int manual, int initial,
    const char *name);
__declspec(dllimport) void *__stdcall CreateFileA(const char *name, unsigned access, unsigned share,
    void *security, unsigned disposition, unsigned flags, void *templateFile);
__declspec(dllimport) int __stdcall ReadFile(void *file, void *buffer, unsigned count,
    unsigned *read, void *overlapped);
__declspec(dllimport) int __stdcall CloseHandle(void *handle);
__declspec(dllimport) long __stdcall RegOpenKeyExA(void *key, const char *path, unsigned options,
    unsigned access, void **result);
__declspec(dllimport) long __stdcall RegQueryValueExA(void *key, const char *name,
    unsigned *reserved, unsigned *type, void *data, unsigned *size);

#define INFINITE 0xffffffff
#define GENERIC_READ 0x80000000
#define OPEN_EXISTING 3
#define HKEY_CURRENT_USER ((void *)0x80000001)
#define KEY_READ 0x20019
#define STILL_ACTIVE 259

static int start(char *commandLine, PROCESS_INFORMATION *information)
{
    STARTUPINFOA startup = { sizeof(STARTUPINFOA) };
    return CreateProcessA("C:\\App\\spawn_child.exe", commandLine, 0, 0, 0, 0, 0, 0, &startup,
        information);
}

int mainCRTStartup(void)
{
    /*
     * A child runs from CreateProcess on, beside its parent, and writes to the
     * same output: what the parent finds while a child runs is said once the
     * child is gone, so no line of the parent's is cut by the child's, wherever
     * the two are scheduled.
     */
    PROCESS_INFORMATION child;
    char first[] = "spawn_child.exe first";
    int created = start(first, &child);
    unsigned code = 0;
    /* It may already have finished. */
    int asked = GetExitCodeProcess(child.process, &code)
        && (code == STILL_ACTIVE || code == 42);
    unsigned waited = WaitForSingleObject(child.process, INFINITE);
    check("the child is created", created);
    check("its exit code can be asked at once", asked);
    check("the wait returns when the child exits", waited == 0);
    GetExitCodeProcess(child.process, &code);
    check("with the child's exit code", code == 42);
    check("and the handle stays signalled", WaitForSingleObject(child.process, 0) == 0);
    CloseHandle(child.process);
    CloseHandle(child.thread);

    char text[16] = { 0 };
    unsigned read = 0;
    void *file = CreateFileA("C:\\App\\made.txt", GENERIC_READ, 0, 0, OPEN_EXISTING, 0, 0);
    ReadFile(file, text, 10, &read, 0);
    CloseHandle(file);
    check("the file the child wrote is here",
        read == 10 && text[0] == 'f' && text[5] == 'c' && text[9] == 'd');

    void *key;
    unsigned stage = 0, size = 4, type = 0;
    RegOpenKeyExA(HKEY_CURRENT_USER, "Software\\Bottlify\\Spawn", 0, KEY_READ, &key);
    check("and so is the registry value it set",
        RegQueryValueExA(key, "Stage", 0, &type, &stage, &size) == 0 && stage == 2);

    char second[] = "spawn_child.exe second";
    created = start(second, &child);
    void *set[2] = { CreateEventA(0, 1, 0, 0), child.process };
    waited = WaitForMultipleObjects(2, set, 0, INFINITE);
    check("a second child is created", created);
    check("a wait for any of a set answers with the child's place in it", waited == 1);
    GetExitCodeProcess(child.process, &code);
    check("and its code", code == 0);

    say("parent: done\r\n");
    ExitProcess(failures);
    return 0;
}
