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
 *
 * Started with -send, the child also sends to the window and waits for the
 * answers: a block of bytes, a new caption, the caption read back, a message
 * with a timeout. With -held, where the parent runs nothing while its child
 * runs, a send is refused at once rather than waited on for ever.
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

typedef struct { unsigned data, count; const void *bytes; } COPYDATASTRUCT;

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
__declspec(dllimport) long __stdcall SendMessageA(void *window, unsigned message,
    unsigned wParam, long lParam);
__declspec(dllimport) long __stdcall SendMessageTimeoutA(void *window, unsigned message,
    unsigned wParam, long lParam, unsigned flags, unsigned timeout, unsigned *result);
__declspec(dllimport) unsigned __stdcall GetLastError(void);

#define INFINITE 0xffffffff
#define WM_APP 0x8000
#define WM_SETTEXT 0x000c
#define WM_GETTEXT 0x000d
#define WM_COPYDATA 0x004a
#define SMTO_NORMAL 0
#define ERROR_TIMEOUT 1460
#define COPIED 0x1234
#define ASKED 99

/* What the parent's window was handed by WM_COPYDATA, checked by the parent. */
static unsigned copiedData, copiedCount;
static char copied[8];

static long __stdcall procedure(void *window, unsigned message, unsigned wParam, long lParam)
{
    if (message == WM_COPYDATA)
    {
        const COPYDATASTRUCT *block = (const COPYDATASTRUCT *)lParam;
        copiedData = block->data;
        copiedCount = block->count;
        for (unsigned at = 0; at < block->count && at < sizeof copied; at++)
        {
            copied[at] = ((const char *)block->bytes)[at];
        }
        return COPIED;
    }
    if (message == WM_APP + 2)
    {
        return ASKED + (long)wParam;
    }
    if (message == WM_APP + 3)
    {
        /* Asked by the child, which waits for the answer: asking it back. */
        void *child = FindWindowA("BottlifyGuest", 0);
        return child ? SendMessageA(child, WM_APP + 4, wParam, 0) + 1 : -1;
    }
    return DefWindowProcA(window, message, wParam, lParam);
}

/* The child's own window, which the parent sends to while the child waits on it. */
static long __stdcall guestProcedure(void *window, unsigned message, unsigned wParam, long lParam)
{
    if (message == WM_APP + 4)
    {
        return (long)wParam * 2;
    }
    return DefWindowProcA(window, message, wParam, lParam);
}

/* Whether the command line holds the word, whole. */
static int asked(const char *word)
{
    for (const char *at = GetCommandLineA(); *at; at++)
    {
        int i = 0;
        while (word[i] && at[i] == word[i])
        {
            i++;
        }
        if (!word[i] && (at[i] == ' ' || at[i] == 0))
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
    if (asked("-send"))
    {
        static const char bytes[] = "hello";
        COPYDATASTRUCT block = { 7, 5, bytes };
        check("child: WM_COPYDATA is answered by the parent's procedure",
            SendMessageA(window, WM_COPYDATA, 0, (long)&block) == COPIED);
        check("child: WM_SETTEXT renames it",
            SendMessageA(window, WM_SETTEXT, 0, (long)"Renamed") == 1
            && GetWindowTextA(window, text, sizeof text) == 7 && equal(text, "Renamed"));
        char back[32] = { 0 };
        check("child: WM_GETTEXT fills this process's buffer",
            SendMessageA(window, WM_GETTEXT, sizeof back, (long)back) == 7
            && equal(back, "Renamed"));
        unsigned result = 0;
        check("child: SendMessageTimeout is answered in time",
            SendMessageTimeoutA(window, WM_APP + 2, 1, 0, SMTO_NORMAL, 5000, &result)
            && result == ASKED + 1);
        WNDCLASSA cls = { 0 };
        cls.procedure = (void *)guestProcedure;
        cls.instance = GetModuleHandleA(0);
        cls.className = "BottlifyGuest";
        RegisterClassA(&cls);
        CreateWindowExA(0, "BottlifyGuest", "Guest", 0, 0, 0, 10, 10, 0, 0, cls.instance, 0);
        check("child: a send the parent answers by sending back to this one, which waits",
            SendMessageA(window, WM_APP + 3, 20, 0) == 41);
    }
    if (asked("-held"))
    {
        unsigned result = 0;
        check("child: a send to a process that runs nothing now is refused",
            SendMessageA(window, WM_APP + 2, 1, 0) == 0);
        check("child: as a window that does not answer in time",
            !SendMessageTimeoutA(window, WM_APP + 2, 1, 0, SMTO_NORMAL, 5000, &result)
            && GetLastError() == ERROR_TIMEOUT);
    }
    check("child: a message posted to it is taken",
        PostMessageA(window, WM_APP + 1, owner, (long)GetCurrentProcessId()));
    return failures;
}

int mainCRTStartup(void)
{
    if (asked("-child"))
    {
        ExitProcess(look());
    }
    WNDCLASSA cls = { 0 };
    cls.procedure = (void *)procedure;
    cls.instance = GetModuleHandleA(0);
    cls.className = "BottlifyHost";
    RegisterClassA(&cls);
    void *window = CreateWindowExA(0, "BottlifyHost", "Host Window", 0, 0, 0, 100, 100, 0, 0,
        cls.instance, 0);
    check("parent: a window made", window != 0);

    STARTUPINFOA startup = { sizeof startup };
    PROCESS_INFORMATION information = { 0 };
    /* The child's command line: its own flag, then whatever this one was given. */
    char command[64];
    char *at = command;
    for (const char *from = "C:\\App\\windows.exe -child "; *from; )
    {
        *at++ = *from++;
    }
    for (const char *from = asked("-send") ? "-send" : asked("-held") ? "-held" : ""; *from; )
    {
        *at++ = *from++;
    }
    *at = 0;
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
    if (asked("-send"))
    {
        check("parent: the block the child sent arrived whole", copiedData == 7
            && copiedCount == 5 && copied[0] == 'h' && copied[4] == 'o');
    }

    unsigned code = 1;
    WaitForSingleObject(information.process, INFINITE);
    GetExitCodeProcess(information.process, &code);
    check("parent: every check of the child's held", code == 0);
    ExitProcess(failures);
    return 0;
}
