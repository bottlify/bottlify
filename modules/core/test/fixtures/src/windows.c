/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/*
 * One process's window, as another process sees it. The parent makes a
 * window and starts its child, then waits in its message loop; the child
 * finds the parent's window by its class and by its title, asks who made it,
 * reads its caption and class, and posts to it: which process owns the
 * window, and its own id. The parent checks what arrived, then the child's
 * exit code -- the number of its own checks that failed.
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

typedef struct
{
    unsigned style;
    void *procedure;
    int classExtra, windowExtra;
    void *instance, *icon, *cursor, *background;
    const char *menuName, *className;
} WNDCLASSA;

typedef struct { void *window; unsigned message; unsigned wParam, lParam, time, x, y; } MSG;

__declspec(dllimport) char *__stdcall GetCommandLineA(void);
__declspec(dllimport) void *__stdcall GetModuleHandleA(const char *name);
__declspec(dllimport) unsigned __stdcall GetCurrentProcessId(void);
__declspec(dllimport) int __stdcall CreateProcessA(const char *application, char *commandLine,
    void *processSecurity, void *threadSecurity, int inherit, unsigned flags, void *environment,
    const char *directory, STARTUPINFOA *startup, PROCESS_INFORMATION *information);
__declspec(dllimport) unsigned __stdcall WaitForSingleObject(void *handle, unsigned milliseconds);
__declspec(dllimport) int __stdcall GetExitCodeProcess(void *process, unsigned *code);
__declspec(dllimport) unsigned short __stdcall RegisterClassA(const WNDCLASSA *cls);
__declspec(dllimport) void *__stdcall CreateWindowExA(unsigned exStyle, const char *className,
    const char *title, unsigned style, int x, int y, int width, int height, void *parent,
    void *menu, void *instance, void *parameter);
__declspec(dllimport) long __stdcall DefWindowProcA(void *window, unsigned message,
    unsigned wParam, long lParam);
__declspec(dllimport) void *__stdcall FindWindowA(const char *className, const char *title);
__declspec(dllimport) int __stdcall IsWindow(void *window);
__declspec(dllimport) unsigned __stdcall GetWindowThreadProcessId(void *window,
    unsigned *processId);
__declspec(dllimport) int __stdcall GetWindowTextA(void *window, char *text, int room);
__declspec(dllimport) int __stdcall GetClassNameA(void *window, char *name, int room);
__declspec(dllimport) int __stdcall PostMessageA(void *window, unsigned message,
    unsigned wParam, long lParam);
__declspec(dllimport) int __stdcall GetMessageA(MSG *message, void *window, unsigned first,
    unsigned last);
__declspec(dllimport) long __stdcall DispatchMessageA(const MSG *message);

#define INFINITE 0xffffffff
#define WM_APP 0x8000

static int child(void)
{
    for (const char *at = GetCommandLineA(); *at; at++)
    {
        if (at[0] == '-' && at[1] == 'c' && at[2] == 'h' && at[3] == 'i' && at[4] == 'l'
            && at[5] == 'd')
        {
            return 1;
        }
    }
    return 0;
}

static int equal(const char *a, const char *b)
{
    while (*a && *a == *b)
    {
        a++;
        b++;
    }
    return *a == *b;
}

static int look(void)
{
    void *window = FindWindowA("BottlifyHost", 0);
    check("child: the parent's window is found by its class", window != 0);
    check("child: and by its title, whatever its case", FindWindowA(0, "host window") == window);
    check("child: a class nobody registered names no window",
        FindWindowA("BottlifyNobody", 0) == 0);
    check("child: it is a window", IsWindow(window));
    unsigned owner = 0;
    unsigned thread = GetWindowThreadProcessId(window, &owner);
    check("child: made by another process's thread",
        thread != 0 && owner != 0 && owner != GetCurrentProcessId());
    char text[32];
    check("child: its caption reads", GetWindowTextA(window, text, sizeof text) == 11
        && equal(text, "Host Window"));
    check("child: its class reads", GetClassNameA(window, text, sizeof text) == 12
        && equal(text, "BottlifyHost"));
    check("child: a message posted to it is taken",
        PostMessageA(window, WM_APP + 1, owner, (long)GetCurrentProcessId()));
    return failures;
}

int mainCRTStartup(void)
{
    if (child())
    {
        ExitProcess(look());
    }
    WNDCLASSA cls = { 0 };
    cls.procedure = (void *)DefWindowProcA;
    cls.instance = GetModuleHandleA(0);
    cls.className = "BottlifyHost";
    RegisterClassA(&cls);
    void *window = CreateWindowExA(0, "BottlifyHost", "Host Window", 0, 0, 0, 100, 100, 0, 0,
        cls.instance, 0);
    check("parent: a window made", window != 0);

    STARTUPINFOA startup = { sizeof startup };
    PROCESS_INFORMATION information = { 0 };
    char command[] = "C:\\App\\windows.exe -child";
    check("parent: the child started", CreateProcessA(0, command, 0, 0, 0, 0, 0, 0, &startup,
        &information));

    MSG message;
    int got = 0;
    while (!got && GetMessageA(&message, 0, 0, 0) > 0)
    {
        if (message.message == WM_APP + 1)
        {
            got = 1;
            continue;
        }
        DispatchMessageA(&message);
    }
    check("parent: the child's message arrived, for this window", got && message.window == window);
    check("parent: the child named this process as the window's",
        got && message.wParam == GetCurrentProcessId());
    check("parent: and itself as the poster", got && message.lParam == information.processId);

    unsigned code = 1;
    WaitForSingleObject(information.process, INFINITE);
    GetExitCodeProcess(information.process, &code);
    check("parent: every check of the child's held", code == 0);
    ExitProcess(failures);
    return 0;
}
