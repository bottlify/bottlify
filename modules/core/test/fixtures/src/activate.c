/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/*
 * The foreground window across processes. The parent makes a window and
 * starts its child, then looks at its queue until the child is gone. The
 * child makes a window, which takes the foreground from the parent; finds the
 * parent's window under a point and among every top-level window; then gives
 * the parent's window the foreground, and is told it is not the active
 * program any more. The parent, once the child is gone, was told it lost the
 * foreground and got it back, each time for another program's thread.
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
__declspec(dllimport) unsigned __stdcall GetCurrentThreadId(void);
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
__declspec(dllimport) void *__stdcall FindWindowA(const char *className, const char *title);
__declspec(dllimport) int __stdcall PeekMessageA(MSG *message, void *window, unsigned first,
    unsigned last, unsigned remove);
__declspec(dllimport) long __stdcall DispatchMessageA(const MSG *message);
__declspec(dllimport) unsigned __stdcall MsgWaitForMultipleObjects(unsigned count,
    void **handles, int waitAll, unsigned milliseconds, unsigned wakeMask);
__declspec(dllimport) void *__stdcall GetForegroundWindow(void);
__declspec(dllimport) void *__stdcall GetActiveWindow(void);
__declspec(dllimport) int __stdcall SetForegroundWindow(void *window);
__declspec(dllimport) void *__stdcall WindowFromPoint(int x, int y);
__declspec(dllimport) int __stdcall EnumWindows(int(__stdcall *callback)(void *, unsigned),
    unsigned data);

#define WS_POPUP 0x80000000
#define WS_VISIBLE 0x10000000
#define WM_ACTIVATEAPP 0x001c
#define PM_REMOVE 1
#define QS_ALLINPUT 0x04ff
#define INFINITE 0xffffffff
#define WAIT_OBJECT_0 0

/* What WM_ACTIVATEAPP told this program, in order: 1 for TRUE, 2 for FALSE, the
 * other program's thread beside each. */
static unsigned told[8], toldThread[8], toldCount;

static long __stdcall procedure(void *window, unsigned message, unsigned wParam,
    unsigned lParam)
{
    if (message == WM_ACTIVATEAPP && toldCount < 8)
    {
        told[toldCount] = wParam ? 1 : 2;
        toldThread[toldCount++] = lParam;
    }
    return DefWindowProcA(window, message, wParam, lParam);
}

static void *makeWindow(const char *className, int x)
{
    WNDCLASSA cls = { 0 };
    cls.procedure = (void *)procedure;
    cls.instance = GetModuleHandleA(0);
    cls.className = className;
    RegisterClassA(&cls);
    return CreateWindowExA(0, className, className, WS_POPUP | WS_VISIBLE, x, 0, 200, 200, 0, 0,
        cls.instance, 0);
}

static void drain(void)
{
    MSG message;
    while (PeekMessageA(&message, 0, 0, 0, PM_REMOVE))
    {
        DispatchMessageA(&message);
    }
}

/* Whether a program other than this one told this program something. */
static int foreign(unsigned thread)
{
    return thread != 0 && thread != GetCurrentThreadId();
}

static void *seen[16];
static unsigned seenCount;
static int __stdcall listed(void *window, unsigned data)
{
    (void)data;
    if (seenCount < 16)
    {
        seen[seenCount++] = window;
    }
    return 1;
}

static int child(void)
{
    void *own = makeWindow("ActGuest", 300);
    check("child: its window took the foreground", GetForegroundWindow() == own);
    void *host = FindWindowA("ActHost", 0);
    check("child: under a point of the parent's window, the parent's window",
        host != 0 && WindowFromPoint(50, 50) == host);
    EnumWindows(listed, 0);
    int hasHost = 0, hasOwn = 0;
    for (unsigned i = 0; i < seenCount; i++)
    {
        hasHost |= seen[i] == host;
        hasOwn |= seen[i] == own;
    }
    check("child: every program's top-level window enumerated", hasHost && hasOwn);
    drain();
    toldCount = 0;
    check("child: the parent's window made the foreground one",
        SetForegroundWindow(host) && GetForegroundWindow() == host && GetActiveWindow() == 0);
    drain();
    check("child: told it is not the active program, for the parent's thread",
        toldCount == 1 && told[0] == 2 && foreign(toldThread[0]));
    return 0;
}

static int parent(void)
{
    void *own = makeWindow("ActHost", 0);
    drain();
    toldCount = 0;
    STARTUPINFOA startup = { sizeof(STARTUPINFOA) };
    PROCESS_INFORMATION started = { 0 };
    char command[] = "C:\\App\\activate.exe child";
    check("parent: the child started",
        CreateProcessA("C:\\App\\activate.exe", command, 0, 0, 0, 0, 0, 0, &startup, &started));
    for (;;)
    {
        unsigned woke = MsgWaitForMultipleObjects(1, &started.process, 0, INFINITE, QS_ALLINPUT);
        drain();
        if (woke == WAIT_OBJECT_0)
        {
            break;
        }
    }
    drain();
    CloseHandle(started.process);
    CloseHandle(started.thread);
    check("parent: told it lost the foreground, then had it back, each for the child's thread",
        toldCount == 2 && told[0] == 2 && told[1] == 1 && foreign(toldThread[0])
            && toldThread[1] == toldThread[0]);
    check("parent: its window is the foreground one, and active",
        GetForegroundWindow() == own && GetActiveWindow() == own);
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
