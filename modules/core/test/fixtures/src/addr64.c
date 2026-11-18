/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/*
 * A 64-bit program's addresses past 2 GiB, and values past 4 GiB where a
 * pointer-sized value goes through the system: memory reserved until a block
 * lies above 2 GiB (as Unity reserves its heap), the answers of VirtualAlloc
 * and HeapAlloc whole, strchr on such memory, a thread's parameter, a
 * window's lpCreateParams and GWLP_USERDATA - each a pointer past 2 GiB and a
 * value past 4 GiB, which must come back as given. Each check prints a line,
 * "ok" or "FAIL" with what came back; the exit code counts the failures.
 */

typedef unsigned long DWORD;
typedef unsigned int UINT;
typedef unsigned long long SIZE_T, ULONG_PTR, WPARAM;
typedef long long LPARAM, LRESULT, LONG_PTR;
typedef void *HANDLE, *HWND, *HINSTANCE, *HMENU;
typedef LRESULT (*WNDPROC)(HWND, UINT, WPARAM, LPARAM);
typedef DWORD (*THREADPROC)(void *);

typedef struct
{
    UINT style;
    WNDPROC lpfnWndProc;
    int cbClsExtra, cbWndExtra;
    HINSTANCE hInstance;
    HANDLE hIcon, hCursor, hbrBackground;
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

__declspec(dllimport) HANDLE __stdcall GetStdHandle(DWORD handle);
__declspec(dllimport) int __stdcall WriteFile(HANDLE file, const void *buffer, DWORD length,
    DWORD *written, void *overlapped);
__declspec(dllimport) void __stdcall ExitProcess(UINT code);
__declspec(dllimport) void *__stdcall VirtualAlloc(void *address, SIZE_T size, DWORD type,
    DWORD protect);
__declspec(dllimport) HANDLE __stdcall GetProcessHeap(void);
__declspec(dllimport) void *__stdcall HeapAlloc(HANDLE heap, DWORD flags, SIZE_T bytes);
__declspec(dllimport) HANDLE __stdcall CreateThread(void *attributes, SIZE_T stack,
    THREADPROC start, void *parameter, DWORD flags, DWORD *id);
__declspec(dllimport) DWORD __stdcall WaitForSingleObject(HANDLE handle, DWORD ms);
__declspec(dllimport) HINSTANCE __stdcall GetModuleHandleA(const char *name);
__declspec(dllimport) unsigned short __stdcall RegisterClassA(const WNDCLASSA *wc);
__declspec(dllimport) HWND __stdcall CreateWindowExA(DWORD exStyle, const char *className,
    const char *name, DWORD style, int x, int y, int w, int h, HWND parent, HMENU menu,
    HINSTANCE instance, void *param);
__declspec(dllimport) LRESULT __stdcall DefWindowProcA(HWND hwnd, UINT message, WPARAM w,
    LPARAM l);
__declspec(dllimport) int __stdcall DestroyWindow(HWND hwnd);
__declspec(dllimport) LONG_PTR __stdcall SetWindowLongPtrA(HWND hwnd, int index, LONG_PTR value);
__declspec(dllimport) LONG_PTR __stdcall GetWindowLongPtrA(HWND hwnd, int index);
__declspec(dllimport) char *strchr(const char *text, int c);
__declspec(dllimport) LRESULT __stdcall SendMessageA(HWND hwnd, UINT message, WPARAM w, LPARAM l);
__declspec(dllimport) int __stdcall PostMessageA(HWND hwnd, UINT message, WPARAM w, LPARAM l);
__declspec(dllimport) int __stdcall PeekMessageA(void *message, HWND hwnd, UINT first, UINT last,
    UINT remove);
__declspec(dllimport) int __stdcall EnumWindows(int (*each)(HWND, LPARAM), LPARAM l);
__declspec(dllimport) DWORD __stdcall TlsAlloc(void);
__declspec(dllimport) int __stdcall TlsSetValue(DWORD slot, void *value);
__declspec(dllimport) void *__stdcall TlsGetValue(DWORD slot);
__declspec(dllimport) DWORD __stdcall FlsAlloc(void *callback);
__declspec(dllimport) int __stdcall FlsSetValue(DWORD slot, void *value);
__declspec(dllimport) void *__stdcall FlsGetValue(DWORD slot);
__declspec(dllimport) DWORD __stdcall QueueUserAPC(void (*apc)(unsigned long long), HANDLE thread,
    unsigned long long parameter);
__declspec(dllimport) DWORD __stdcall SleepEx(DWORD ms, int alertable);
__declspec(dllimport) HANDLE __stdcall GetCurrentThread(void);
__declspec(dllimport) DWORD __stdcall GetCurrentThreadId(void);
__declspec(dllimport) LRESULT __stdcall SendMessageTimeoutA(HWND hwnd, UINT message, WPARAM w,
    LPARAM l, UINT flags, UINT timeout, ULONG_PTR *result);
__declspec(dllimport) int __stdcall SendNotifyMessageA(HWND hwnd, UINT message, WPARAM w,
    LPARAM l);
__declspec(dllimport) int __stdcall PostThreadMessageA(DWORD thread, UINT message, WPARAM w,
    LPARAM l);
__declspec(dllimport) LRESULT __stdcall CallWindowProcA(WNDPROC procedure, HWND hwnd,
    UINT message, WPARAM w, LPARAM l);

__declspec(dllimport) int __stdcall EnumDesktopWindows(HANDLE desktop, int (*each)(HWND, LPARAM),
    LPARAM l);
__declspec(dllimport) int __stdcall EnumWindowStationsA(int (*each)(char *, LPARAM), LPARAM l);
__declspec(dllimport) HANDLE __stdcall GetDC(HWND hwnd);
__declspec(dllimport) int __stdcall ReleaseDC(HWND hwnd, HANDLE dc);
__declspec(dllimport) int __stdcall EnumFontFamiliesA(HANDLE dc, const char *family,
    int (*each)(const void *, const void *, DWORD, LPARAM), LPARAM l);
__declspec(dllimport) int __stdcall LineDDA(int x0, int y0, int x1, int y1,
    void (*each)(int, int, LPARAM), LPARAM l);
__declspec(dllimport) ULONG_PTR __stdcall SetTimer(HWND hwnd, ULONG_PTR id, UINT elapse,
    void (*proc)(HWND, UINT, ULONG_PTR, DWORD));
__declspec(dllimport) int __stdcall KillTimer(HWND hwnd, ULONG_PTR id);
__declspec(dllimport) LRESULT __stdcall DispatchMessageA(const void *message);
__declspec(dllimport) void __stdcall Sleep(DWORD ms);

typedef struct
{
    HWND hwnd;
    UINT message;
    WPARAM wParam;
    LPARAM lParam;
    DWORD time;
    long x, y;
} MSG;
#define WM_USER 0x0400
#define WM_TIMER 0x0113

#define MEM_COMMIT 0x1000
#define MEM_RESERVE 0x2000
#define PAGE_READWRITE 0x04
#define WM_NCCREATE 0x0081
#define GWLP_USERDATA (-21)
#define TWO_GIB 0x80000000ull
/* A value no address of this process is: it must come back whole all the same. */
#define PAST_4GIB ((void *)0x123456789ull)

static int failures;

static void say(const char *text)
{
    DWORD length = 0, written;
    while (text[length] != 0)
    {
        length++;
    }
    WriteFile(GetStdHandle((DWORD)-11), text, length, &written, 0);
}

static void hex(unsigned long long value)
{
    char digits[19] = "0x";
    for (int i = 0; i < 16; i++)
    {
        digits[2 + i] = "0123456789abcdef"[(value >> (60 - 4 * i)) & 15];
    }
    digits[18] = 0;
    say(digits);
}

/* "ok NAME" or "FAIL NAME: got X, wanted Y". */
static void check(const char *name, unsigned long long got, unsigned long long wanted)
{
    if (got == wanted)
    {
        say("ok ");
        say(name);
        say("\n");
        return;
    }
    failures++;
    say("FAIL ");
    say(name);
    say(": got ");
    hex(got);
    say(", wanted ");
    hex(wanted);
    say("\n");
}

static void *threadSaw;

static DWORD threadStart(void *parameter)
{
    threadSaw = parameter;
    return 0;
}

static void *threadParameter(void *parameter)
{
    threadSaw = 0;
    HANDLE thread = CreateThread(0, 0, threadStart, parameter, 0, 0);
    if (thread == 0)
    {
        return (void *)~0ull;
    }
    WaitForSingleObject(thread, 0xffffffff);
    return threadSaw;
}

static void *createSaw;
static WPARAM sentW;
static LPARAM sentL;

static LRESULT windowProc(HWND hwnd, UINT message, WPARAM w, LPARAM l)
{
    if (message == WM_NCCREATE)
    {
        createSaw = ((CREATESTRUCTA *)l)->lpCreateParams;
    }
    if (message == WM_USER)
    {
        sentW = w;
        sentL = l;
        /* An LRESULT is a quadword: what the procedure answers comes back whole. */
        return l;
    }
    return DefWindowProcA(hwnd, message, w, l);
}

static LPARAM enumSaw;

static int eachWindow(HWND hwnd, LPARAM l)
{
    (void)hwnd;
    enumSaw = l;
    return 0;
}

static int eachName(char *name, LPARAM l)
{
    (void)name;
    enumSaw = l;
    return 0;
}

static int eachFace(const void *font, const void *metrics, DWORD type, LPARAM l)
{
    (void)font;
    (void)metrics;
    (void)type;
    enumSaw = l;
    return 0;
}

static void eachPoint(int x, int y, LPARAM l)
{
    (void)x;
    (void)y;
    enumSaw = l;
}

static ULONG_PTR timerSaw;

static void timerProc(HWND hwnd, UINT message, ULONG_PTR id, DWORD time)
{
    (void)hwnd;
    (void)message;
    (void)time;
    timerSaw = id;
}

/* The timer's next tick, taken off the queue: zero where none came. */
static int tick(HWND hwnd, MSG *message)
{
    for (int i = 0; i < 2000; i++)
    {
        if (PeekMessageA(message, hwnd, WM_TIMER, WM_TIMER, 1))
        {
            return 1;
        }
        Sleep(5);
    }
    return 0;
}

static unsigned long long apcSaw;

static void apc(unsigned long long parameter)
{
    apcSaw = parameter;
}

/* Values the host only hands on: each must reach the other side whole. */
static LRESULT windowProc(HWND hwnd, UINT message, WPARAM w, LPARAM l);

static void forwarded(HWND hwnd, unsigned long long value, const char *names[22])
{
    sentW = 0;
    sentL = 0;
    LRESULT answered = SendMessageA(hwnd, WM_USER, (WPARAM)value, (LPARAM)value);
    check(names[0], (unsigned long long)sentW, value);
    check(names[1], (unsigned long long)sentL, value);
    check(names[2], (unsigned long long)answered, value);
    MSG message = { 0 };
    PostMessageA(hwnd, WM_USER + 1, (WPARAM)value, (LPARAM)value);
    PeekMessageA(&message, hwnd, WM_USER + 1, WM_USER + 1, 1);
    check(names[3], (unsigned long long)message.wParam, value);
    check(names[4], (unsigned long long)message.lParam, value);
    enumSaw = 0;
    EnumWindows(eachWindow, (LPARAM)value);
    check(names[5], (unsigned long long)enumSaw, value);
    DWORD tls = TlsAlloc();
    TlsSetValue(tls, (void *)value);
    check(names[6], (unsigned long long)TlsGetValue(tls), value);
    DWORD fls = FlsAlloc(0);
    FlsSetValue(fls, (void *)value);
    check(names[7], (unsigned long long)FlsGetValue(fls), value);
    apcSaw = 0;
    QueueUserAPC(apc, GetCurrentThread(), value);
    SleepEx(0, 1);
    check(names[8], apcSaw, value);
    ULONG_PTR timed = 0;
    sentL = 0;
    SendMessageTimeoutA(hwnd, WM_USER, (WPARAM)value, (LPARAM)value, 0, 1000, &timed);
    check(names[9], (unsigned long long)sentL, value);
    check(names[10], (unsigned long long)timed, value);
    sentW = 0;
    sentL = 0;
    LRESULT called = CallWindowProcA(windowProc, hwnd, WM_USER, (WPARAM)value, (LPARAM)value);
    check(names[11], (unsigned long long)sentL, value);
    check(names[12], (unsigned long long)called, value);
    sentL = 0;
    SendNotifyMessageA(hwnd, WM_USER, (WPARAM)value, (LPARAM)value);
    check(names[13], (unsigned long long)sentL, value);
    PostThreadMessageA(GetCurrentThreadId(), WM_USER + 2, (WPARAM)value, (LPARAM)value);
    message.lParam = 0;
    PeekMessageA(&message, (HWND)-1, WM_USER + 2, WM_USER + 2, 1);
    check(names[14], (unsigned long long)message.lParam, value);
    enumSaw = 0;
    EnumDesktopWindows(0, eachWindow, (LPARAM)value);
    check(names[15], (unsigned long long)enumSaw, value);
    enumSaw = 0;
    EnumWindowStationsA(eachName, (LPARAM)value);
    check(names[16], (unsigned long long)enumSaw, value);
    enumSaw = 0;
    HANDLE dc = GetDC(hwnd);
    EnumFontFamiliesA(dc, 0, eachFace, (LPARAM)value);
    ReleaseDC(hwnd, dc);
    check(names[17], (unsigned long long)enumSaw, value);
    /* A timer's id is the program's own name for it, a pointer often enough. */
    message.wParam = 0;
    SetTimer(hwnd, (ULONG_PTR)value, 10, 0);
    tick(hwnd, &message);
    check(names[18], (unsigned long long)message.wParam, value);
    check(names[19], (unsigned long long)KillTimer(hwnd, (ULONG_PTR)value), 1);
    timerSaw = 0;
    SetTimer(hwnd, (ULONG_PTR)value, 10, timerProc);
    if (tick(hwnd, &message))
    {
        DispatchMessageA(&message);
    }
    KillTimer(hwnd, (ULONG_PTR)value);
    check(names[20], (unsigned long long)timerSaw, value);
    enumSaw = 0;
    LineDDA(0, 0, 3, 0, eachPoint, (LPARAM)value);
    check(names[21], (unsigned long long)enumSaw, value);
}

static void windowChecks(void *high)
{
    WNDCLASSA wc = { 0 };
    wc.lpfnWndProc = windowProc;
    wc.hInstance = GetModuleHandleA(0);
    wc.lpszClassName = "addr64";
    RegisterClassA(&wc);
    void *params[2] = { high, PAST_4GIB };
    const char *names[2] = { "lpCreateParams past 2 GiB", "lpCreateParams past 4 GiB" };
    for (int i = 0; i < 2; i++)
    {
        createSaw = 0;
        HWND hwnd = CreateWindowExA(0, "addr64", "", 0, 0, 0, 10, 10, 0, 0, wc.hInstance,
            params[i]);
        check(names[i], (unsigned long long)createSaw, (unsigned long long)params[i]);
        if (hwnd != 0)
        {
            LONG_PTR values[2] = { (LONG_PTR)high, (LONG_PTR)PAST_4GIB };
            const char *longs[2] = { "GWLP_USERDATA past 2 GiB", "GWLP_USERDATA past 4 GiB" };
            SetWindowLongPtrA(hwnd, GWLP_USERDATA, values[i]);
            check(longs[i], (unsigned long long)GetWindowLongPtrA(hwnd, GWLP_USERDATA),
                (unsigned long long)values[i]);
            static const char *passed[2][22] = {
                { "SendMessage's WPARAM past 2 GiB", "SendMessage's LPARAM past 2 GiB",
                    "an LRESULT past 2 GiB", "a posted WPARAM past 2 GiB",
                    "a posted LPARAM past 2 GiB", "EnumWindows' LPARAM past 2 GiB",
                    "a TLS value past 2 GiB", "an FLS value past 2 GiB",
                    "an APC's parameter past 2 GiB", "a timed send's LPARAM past 2 GiB",
                    "a timed send's result past 2 GiB", "CallWindowProc's LPARAM past 2 GiB",
                    "CallWindowProc's answer past 2 GiB", "a notified LPARAM past 2 GiB",
                    "a thread message's LPARAM past 2 GiB",
                    "EnumDesktopWindows' LPARAM past 2 GiB",
                    "EnumWindowStations' LPARAM past 2 GiB",
                    "EnumFontFamilies' LPARAM past 2 GiB", "a timer's id past 2 GiB",
                    "KillTimer of an id past 2 GiB", "a TIMERPROC's id past 2 GiB",
                    "LineDDA's LPARAM past 2 GiB" },
                { "SendMessage's WPARAM past 4 GiB", "SendMessage's LPARAM past 4 GiB",
                    "an LRESULT past 4 GiB", "a posted WPARAM past 4 GiB",
                    "a posted LPARAM past 4 GiB", "EnumWindows' LPARAM past 4 GiB",
                    "a TLS value past 4 GiB", "an FLS value past 4 GiB",
                    "an APC's parameter past 4 GiB", "a timed send's LPARAM past 4 GiB",
                    "a timed send's result past 4 GiB", "CallWindowProc's LPARAM past 4 GiB",
                    "CallWindowProc's answer past 4 GiB", "a notified LPARAM past 4 GiB",
                    "a thread message's LPARAM past 4 GiB",
                    "EnumDesktopWindows' LPARAM past 4 GiB",
                    "EnumWindowStations' LPARAM past 4 GiB",
                    "EnumFontFamilies' LPARAM past 4 GiB", "a timer's id past 4 GiB",
                    "KillTimer of an id past 4 GiB", "a TIMERPROC's id past 4 GiB",
                    "LineDDA's LPARAM past 4 GiB" },
            };
            forwarded(hwnd, (unsigned long long)values[i], passed[i]);
            DestroyWindow(hwnd);
        }
    }
}

void mainCRTStartup(void)
{
    /* Reserved 256 MiB at a time, as Unity reserves its heap, until a block lies past 2 GiB. */
    char *high = 0;
    int signedAnswers = 0;
    for (int i = 0; i < 15 && high == 0; i++)
    {
        unsigned long long block = (unsigned long long)VirtualAlloc(0, 256ull << 20, MEM_RESERVE,
            PAGE_READWRITE);
        if (block == 0)
        {
            break;
        }
        signedAnswers += block >> 32 != 0;
        if (block >= TWO_GIB)
        {
            high = (char *)block;
        }
    }
    check("VirtualAlloc answers no upper half", (unsigned long long)signedAnswers, 0);
    check("a reservation past 2 GiB", high != 0, 1);
    if (high != 0)
    {
        char *page = VirtualAlloc(high, 0x10000, MEM_COMMIT, PAGE_READWRITE);
        check("a commit past 2 GiB", (unsigned long long)page, (unsigned long long)high);
        if (page != 0)
        {
            page[0] = 'x';
            page[1] = 'y';
            page[2] = 'z';
            page[3] = 0;
            check("strchr past 2 GiB", (unsigned long long)strchr(page, 'y'),
                (unsigned long long)(page + 1));
        }
    }
    /* The process heap's large blocks, whose answers must have no upper half wherever they lie. */
    int heapSigned = 0;
    for (int i = 0; i < 8; i++)
    {
        unsigned long long block = (unsigned long long)HeapAlloc(GetProcessHeap(), 0, 64ull << 20);
        heapSigned += block >> 32 != 0;
    }
    check("HeapAlloc answers no upper half", (unsigned long long)heapSigned, 0);
    /* A pointer past 2 GiB, the one reserved where there is one. */
    void *beyond = high != 0 ? (void *)high : (void *)0x90001000ull;
    check("a thread's parameter past 2 GiB", (unsigned long long)threadParameter(beyond),
        (unsigned long long)beyond);
    check("a thread's parameter past 4 GiB", (unsigned long long)threadParameter(PAST_4GIB),
        (unsigned long long)PAST_4GIB);
    windowChecks(beyond);
    say(failures == 0 ? "all ok\n" : "some failed\n");
    ExitProcess((UINT)failures);
}
