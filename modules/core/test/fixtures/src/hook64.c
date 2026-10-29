/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/*
 * Window hooks in a 64-bit process, each a procedure of the program's that
 * the system calls with the structures it hands a hook in their 64-bit
 * layouts: a CBT hook told of a window being made (CBT_CREATEWND and the
 * CREATESTRUCT it points at) and activated (CBTACTIVATESTRUCT), a
 * GetMessage hook handed the MSG being retrieved -- which it may change --
 * and a keyboard and a mouse hook told of input SendInput made, its INPUT
 * records 40 bytes each (MOUSEHOOKSTRUCT for the mouse). Each hook hands on
 * through CallNextHookEx, and none is called once unhooked. Each check prints
 * a line; the exit code counts the checks that failed.
 */

typedef unsigned long DWORD;
typedef unsigned int UINT;
typedef void *HANDLE;
typedef HANDLE HWND, HINSTANCE, HHOOK, HMENU, HICON, HCURSOR, HBRUSH;
typedef unsigned long long WPARAM, ULONG_PTR;
typedef long long LPARAM, LRESULT;
typedef LRESULT (*HOOKPROC)(int, WPARAM, LPARAM);
typedef LRESULT (*WNDPROC)(HWND, UINT, WPARAM, LPARAM);

typedef struct { long x, y; } POINT;

typedef struct
{
    UINT style;
    WNDPROC lpfnWndProc;
    int cbClsExtra, cbWndExtra;
    HINSTANCE hInstance;
    HICON hIcon;
    HCURSOR hCursor;
    HBRUSH hbrBackground;
    const char *lpszMenuName, *lpszClassName;
} WNDCLASSA;

typedef struct
{
    void *lpCreateParams;
    HINSTANCE hInstance;
    HMENU hMenu;
    HWND hwndParent;
    int cy, cx, y, x;
    long style;
    const char *lpszName, *lpszClass;
    DWORD dwExStyle;
} CREATESTRUCTA;

typedef struct { CREATESTRUCTA *lpcs; HWND hwndInsertAfter; } CBT_CREATEWNDA;
typedef struct { int fMouse; HWND hWndActive; } CBTACTIVATESTRUCT;
typedef struct { POINT pt; HWND hwnd; UINT wHitTestCode; ULONG_PTR dwExtraInfo; } MOUSEHOOKSTRUCT;

typedef struct
{
    HWND hwnd;
    UINT message;
    WPARAM wParam;
    LPARAM lParam;
    DWORD time;
    POINT pt;
    DWORD lPrivate;
} MSG;

typedef struct
{
    DWORD type;
    union
    {
        struct { long dx, dy; DWORD mouseData, dwFlags, time; ULONG_PTR dwExtraInfo; } mi;
        struct
        {
            unsigned short wVk, wScan;
            DWORD dwFlags, time;
            ULONG_PTR dwExtraInfo;
        } ki;
    };
} INPUT;

__declspec(dllimport) void __stdcall ExitProcess(UINT code);
__declspec(dllimport) HANDLE __stdcall GetStdHandle(DWORD which);
__declspec(dllimport) int __stdcall WriteFile(HANDLE file, const void *bytes, DWORD count,
    DWORD *written, void *overlapped);
__declspec(dllimport) DWORD __stdcall GetCurrentThreadId(void);
__declspec(dllimport) HINSTANCE __stdcall GetModuleHandleA(const char *name);
__declspec(dllimport) unsigned short __stdcall RegisterClassA(const WNDCLASSA *cls);
__declspec(dllimport) HWND __stdcall CreateWindowExA(DWORD exStyle, const char *className,
    const char *title, DWORD style, int x, int y, int width, int height, HWND parent,
    HMENU menu, HINSTANCE instance, void *parameter);
__declspec(dllimport) LRESULT __stdcall DefWindowProcA(HWND, UINT, WPARAM, LPARAM);
__declspec(dllimport) int __stdcall ShowWindow(HWND, int);
__declspec(dllimport) HWND __stdcall SetFocus(HWND);
__declspec(dllimport) int __stdcall PostMessageA(HWND, UINT, WPARAM, LPARAM);
__declspec(dllimport) int __stdcall GetMessageA(MSG *message, HWND window, UINT first,
    UINT last);
__declspec(dllimport) int __stdcall PeekMessageA(MSG *message, HWND window, UINT first,
    UINT last, UINT remove);
__declspec(dllimport) LRESULT __stdcall DispatchMessageA(const MSG *message);
__declspec(dllimport) int __stdcall DestroyWindow(HWND);
__declspec(dllimport) HHOOK __stdcall SetWindowsHookExA(int type, HOOKPROC proc,
    HINSTANCE module, DWORD thread);
__declspec(dllimport) int __stdcall UnhookWindowsHookEx(HHOOK hook);
__declspec(dllimport) LRESULT __stdcall CallNextHookEx(HHOOK hook, int code, WPARAM wParam,
    LPARAM lParam);
__declspec(dllimport) UINT __stdcall SendInput(UINT count, INPUT *inputs, int size);
__declspec(dllimport) int __stdcall GetSystemMetrics(int index);
__declspec(dllimport) void __stdcall Sleep(DWORD ms);

#define WH_KEYBOARD 2
#define WH_GETMESSAGE 3
#define WH_CBT 5
#define WH_MOUSE 7
#define HCBT_CREATEWND 3
#define HCBT_ACTIVATE 5
#define WM_MOUSEMOVE 0x0200
#define WM_KEYDOWN 0x0100
#define WM_USER 0x0400
#define WS_OVERLAPPEDWINDOW 0x00cf0000
#define PM_REMOVE 1
#define INPUT_MOUSE 0
#define INPUT_KEYBOARD 1
#define MOUSEEVENTF_MOVE 0x0001
#define MOUSEEVENTF_ABSOLUTE 0x8000
#define KEYEVENTF_KEYUP 0x0002

static void say(const char *text)
{
    DWORD length = 0, written;
    while (text[length])
    {
        length++;
    }
    WriteFile(GetStdHandle((DWORD)-11), text, length, &written, 0);
}

static int failures = 0;
static void check(const char *what, int ok)
{
    say(ok ? "ok   " : "FAIL ");
    say(what);
    say("\r\n");
    failures += !ok;
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

static HWND window;
static int created, activated, retrieved, keyed, moused, after;
static int unhooked;

static LRESULT cbt_hook(int code, WPARAM wParam, LPARAM lParam)
{
    if (unhooked)
    {
        after++;
    }
    if (code == HCBT_CREATEWND)
    {
        const CBT_CREATEWNDA *made = (const CBT_CREATEWNDA *)lParam;
        created += wParam != 0 && made->lpcs != 0 && same(made->lpcs->lpszClass, "Hook64")
            && made->lpcs->cx == 200 && made->lpcs->cy == 150 && made->hwndInsertAfter == 0;
    }
    else if (code == HCBT_ACTIVATE)
    {
        const CBTACTIVATESTRUCT *how = (const CBTACTIVATESTRUCT *)lParam;
        activated += (HWND)wParam == window && how != 0 && how->fMouse == 0
            && how->hWndActive == 0;
    }
    return CallNextHookEx(0, code, wParam, lParam);
}

static LRESULT message_hook(int code, WPARAM wParam, LPARAM lParam)
{
    MSG *message = (MSG *)lParam;
    if (code == 0 && message->message == WM_USER + 5 && message->wParam == 9
        && message->lParam == -9 && message->hwnd == window)
    {
        retrieved++;
        message->wParam = 10;
    }
    return CallNextHookEx(0, code, wParam, lParam);
}

static LRESULT keyboard_hook(int code, WPARAM wParam, LPARAM lParam)
{
    keyed += code == 0 && wParam == 'Q';
    return CallNextHookEx(0, code, wParam, lParam);
}

static LRESULT mouse_hook(int code, WPARAM wParam, LPARAM lParam)
{
    const MOUSEHOOKSTRUCT *where = (const MOUSEHOOKSTRUCT *)lParam;
    moused += code == 0 && wParam == WM_MOUSEMOVE && where->hwnd == window
        && where->wHitTestCode == 1 && where->dwExtraInfo == 0;
    return CallNextHookEx(0, code, wParam, lParam);
}

static LRESULT window_procedure(HWND hwnd, UINT message, WPARAM wParam, LPARAM lParam)
{
    return DefWindowProcA(hwnd, message, wParam, lParam);
}

static void pump(void)
{
    MSG message;
    for (int round = 0; round < 20; round++)
    {
        while (PeekMessageA(&message, 0, 0, 0, PM_REMOVE))
        {
            DispatchMessageA(&message);
        }
        Sleep(1);
    }
}

int mainCRTStartup(void)
{
    DWORD thread = GetCurrentThreadId();
    WNDCLASSA cls = { 0 };
    cls.lpfnWndProc = window_procedure;
    cls.hInstance = GetModuleHandleA(0);
    cls.lpszClassName = "Hook64";
    RegisterClassA(&cls);

    HHOOK cbt = SetWindowsHookExA(WH_CBT, cbt_hook, 0, thread);
    HHOOK messages = SetWindowsHookExA(WH_GETMESSAGE, message_hook, 0, thread);
    HHOOK keys = SetWindowsHookExA(WH_KEYBOARD, keyboard_hook, 0, thread);
    HHOOK mouse = SetWindowsHookExA(WH_MOUSE, mouse_hook, 0, thread);
    check("SetWindowsHookExA installs each hook", cbt && messages && keys && mouse);

    window = CreateWindowExA(0, "Hook64", "hooked", WS_OVERLAPPEDWINDOW, 0, 0, 200, 150, 0,
        0, cls.hInstance, 0);
    check("a CBT hook is handed CBT_CREATEWND and its CREATESTRUCT", window && created == 1);
    ShowWindow(window, 1);
    SetFocus(window);
    check("and CBTACTIVATESTRUCT when the window is activated", activated > 0);

    PostMessageA(window, WM_USER + 5, 9, -9);
    MSG message;
    int got = GetMessageA(&message, window, WM_USER + 5, WM_USER + 5);
    check("a GetMessage hook is handed the MSG and may change it",
        got && retrieved == 1 && message.wParam == 10 && message.lParam == -9);

    INPUT key[2] = { { INPUT_KEYBOARD }, { INPUT_KEYBOARD } };
    key[0].ki.wVk = 'Q';
    key[1].ki.wVk = 'Q';
    key[1].ki.dwFlags = KEYEVENTF_KEYUP;
    check("SendInput takes INPUT records of 40 bytes", SendInput(2, key, sizeof key[0]) == 2);
    pump();
    check("a keyboard hook hears the key", keyed > 0);

    INPUT move = { INPUT_MOUSE };
    move.mi.dx = 100 * 65535 / (GetSystemMetrics(0) - 1);
    move.mi.dy = 100 * 65535 / (GetSystemMetrics(1) - 1);
    move.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE;
    SendInput(1, &move, sizeof move);
    pump();
    check("a mouse hook is handed MOUSEHOOKSTRUCT", moused > 0);

    check("UnhookWindowsHookEx removes each", UnhookWindowsHookEx(cbt)
        && UnhookWindowsHookEx(messages) && UnhookWindowsHookEx(keys)
        && UnhookWindowsHookEx(mouse));
    unhooked = 1;
    DestroyWindow(CreateWindowExA(0, "Hook64", "after", WS_OVERLAPPEDWINDOW, 0, 0, 50, 50, 0,
        0, cls.hInstance, 0));
    check("and an unhooked procedure is called no more", after == 0);

    DestroyWindow(window);
    ExitProcess(failures);
    return 0;
}
