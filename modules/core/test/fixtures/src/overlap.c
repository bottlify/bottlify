/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/*
 * Two programs' windows, one over the other. The parent shows a red window at
 * the screen's corner and starts its child, then looks at its queue until the
 * child is gone. The child shows a blue window over the parent's lower right
 * quarter and runs until a key comes. Each program draws only its own: what
 * the screen shows where they overlap is the run's to decide.
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
__declspec(dllimport) int __stdcall CreateProcessA(const char *application, char *commandLine,
    void *processSecurity, void *threadSecurity, int inherit, unsigned flags, void *environment,
    const char *directory, STARTUPINFOA *startup, PROCESS_INFORMATION *information);
__declspec(dllimport) int __stdcall CloseHandle(void *handle);
__declspec(dllimport) unsigned short __stdcall RegisterClassA(const WNDCLASSA *cls);
__declspec(dllimport) void *__stdcall CreateWindowExA(unsigned exStyle, const char *className,
    const char *title, unsigned style, int x, int y, int width, int height, void *parent,
    void *menu, void *instance, void *param);
__declspec(dllimport) long __stdcall DefWindowProcA(void *window, unsigned message,
    unsigned wParam, unsigned lParam);
__declspec(dllimport) int __stdcall PeekMessageA(MSG *message, void *window, unsigned first,
    unsigned last, unsigned remove);
__declspec(dllimport) int __stdcall GetMessageA(MSG *message, void *window, unsigned first,
    unsigned last);
__declspec(dllimport) long __stdcall DispatchMessageA(const MSG *message);
__declspec(dllimport) unsigned __stdcall MsgWaitForMultipleObjects(unsigned count,
    void **handles, int waitAll, unsigned milliseconds, unsigned wakeMask);
__declspec(dllimport) void *__stdcall CreateSolidBrush(unsigned colour);

#define WS_POPUP 0x80000000
#define WS_VISIBLE 0x10000000
#define WM_KEYDOWN 0x0100
#define PM_REMOVE 1
#define QS_ALLINPUT 0x04ff
#define INFINITE 0xffffffff
#define WAIT_OBJECT_0 0

static void *makeWindow(const char *className, unsigned colour, int at)
{
    WNDCLASSA cls = { 0 };
    cls.procedure = (void *)DefWindowProcA;
    cls.instance = GetModuleHandleA(0);
    cls.className = className;
    cls.background = CreateSolidBrush(colour);
    RegisterClassA(&cls);
    return CreateWindowExA(0, className, className, WS_POPUP | WS_VISIBLE, at, at, 200, 200, 0,
        0, cls.instance, 0);
}

static void drain(void)
{
    MSG message;
    while (PeekMessageA(&message, 0, 0, 0, PM_REMOVE))
    {
        DispatchMessageA(&message);
    }
}

static int child(void)
{
    check("child: its window made", makeWindow("OverlapGuest", 0x00ff0000, 100) != 0);
    MSG message;
    while (GetMessageA(&message, 0, 0, 0) > 0)
    {
        if (message.message == WM_KEYDOWN)
        {
            break;
        }
        DispatchMessageA(&message);
    }
    return 0;
}

static int parent(void)
{
    check("parent: its window made", makeWindow("OverlapHost", 0x000000ff, 0) != 0);
    drain();
    STARTUPINFOA startup = { sizeof(STARTUPINFOA) };
    PROCESS_INFORMATION started = { 0 };
    char command[] = "C:\\App\\overlap.exe child";
    check("parent: the child started",
        CreateProcessA("C:\\App\\overlap.exe", command, 0, 0, 0, 0, 0, 0, &startup, &started));
    for (;;)
    {
        unsigned woke = MsgWaitForMultipleObjects(1, &started.process, 0, INFINITE, QS_ALLINPUT);
        drain();
        if (woke == WAIT_OBJECT_0)
        {
            break;
        }
    }
    CloseHandle(started.process);
    CloseHandle(started.thread);
    return 0;
}

int mainCRTStartup(void)
{
    const char *line = GetCommandLineA();
    int isChild = 0;
    for (const char *at = line; *at; at++)
    {
        if (at[0] == 'c' && at[1] == 'h' && at[2] == 'i' && at[3] == 'l' && at[4] == 'd')
        {
            isChild = 1;
        }
    }
    if (isChild)
    {
        child();
    }
    else
    {
        parent();
    }
    ExitProcess(failures);
    return 0;
}
