/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/*
 * A 64-bit window program: a class registered with WNDCLASSEXA and read
 * back, a window made with a pointer for WM_CREATE, the structures the
 * system hands its procedure in their 64-bit layouts -- CREATESTRUCT,
 * MINMAXINFO, WINDOWPOS, NCCALCSIZE_PARAMS -- the window's and the class's
 * pointer-sized longs, WPARAM, LPARAM and LRESULT as quadwords -- a WPARAM
 * widened as a UINT, an LPARAM and an LRESULT as a LONG, so -1 is -1 whole --
 * a MSG out of GetMessage and PeekMessage, a
 * paint with BeginPaint's PAINTSTRUCT and GDI, GetObject's LOGBRUSH, BITMAP
 * and DIBSECTION, and a quit. Each check prints a
 * line; the exit code counts the checks that failed.
 */

typedef unsigned long DWORD;
typedef unsigned int UINT;
typedef void *HANDLE;
typedef HANDLE HWND, HDC, HBRUSH, HINSTANCE, HICON, HCURSOR, HMENU, HGDIOBJ, HPEN;
typedef unsigned long long WPARAM;
typedef long long LPARAM, LRESULT, LONG_PTR;
typedef unsigned long long ULONG_PTR;
typedef LRESULT (*WNDPROC)(HWND, UINT, WPARAM, LPARAM);

typedef struct { long x, y; } POINT;
typedef struct { long left, top, right, bottom; } RECT;

typedef struct
{
    UINT cbSize, style;
    WNDPROC lpfnWndProc;
    int cbClsExtra, cbWndExtra;
    HINSTANCE hInstance;
    HICON hIcon;
    HCURSOR hCursor;
    HBRUSH hbrBackground;
    const char *lpszMenuName, *lpszClassName;
    HICON hIconSm;
} WNDCLASSEXA;

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

typedef struct { POINT reserved, maxSize, maxPosition, minTrackSize, maxTrackSize; } MINMAXINFO;

typedef struct
{
    HWND hwnd, hwndInsertAfter;
    int x, y, cx, cy;
    UINT flags;
} WINDOWPOS;

typedef struct { RECT rgrc[3]; WINDOWPOS *lppos; } NCCALCSIZE_PARAMS;

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
    HDC hdc;
    int fErase;
    RECT rcPaint;
    int fRestore, fIncUpdate;
    unsigned char rgbReserved[32];
} PAINTSTRUCT;

__declspec(dllimport) void __stdcall ExitProcess(UINT code);
__declspec(dllimport) HANDLE __stdcall GetStdHandle(DWORD which);
__declspec(dllimport) int __stdcall WriteFile(HANDLE file, const void *bytes, DWORD count,
    DWORD *written, void *overlapped);
__declspec(dllimport) HINSTANCE __stdcall GetModuleHandleA(const char *name);
__declspec(dllimport) unsigned short __stdcall RegisterClassExA(const WNDCLASSEXA *cls);
__declspec(dllimport) int __stdcall GetClassInfoExA(HINSTANCE instance, const char *name,
    WNDCLASSEXA *cls);
__declspec(dllimport) HWND __stdcall CreateWindowExA(DWORD exStyle, const char *className,
    const char *title, DWORD style, int x, int y, int width, int height, HWND parent,
    HMENU menu, HINSTANCE instance, void *parameter);
__declspec(dllimport) LRESULT __stdcall DefWindowProcA(HWND, UINT, WPARAM, LPARAM);
__declspec(dllimport) LONG_PTR __stdcall GetWindowLongPtrA(HWND, int);
__declspec(dllimport) LONG_PTR __stdcall SetWindowLongPtrA(HWND, int, LONG_PTR);
__declspec(dllimport) ULONG_PTR __stdcall GetClassLongPtrA(HWND, int);
__declspec(dllimport) ULONG_PTR __stdcall SetClassLongPtrA(HWND, int, LONG_PTR);
__declspec(dllimport) int __stdcall ShowWindow(HWND, int);
__declspec(dllimport) int __stdcall UpdateWindow(HWND);
__declspec(dllimport) int __stdcall SetWindowPos(HWND, HWND, int, int, int, int, UINT);
__declspec(dllimport) LRESULT __stdcall SendMessageA(HWND, UINT, WPARAM, LPARAM);
__declspec(dllimport) int __stdcall PostMessageA(HWND, UINT, WPARAM, LPARAM);
__declspec(dllimport) int __stdcall GetMessageA(MSG *message, HWND window, UINT first,
    UINT last);
__declspec(dllimport) int __stdcall PeekMessageA(MSG *message, HWND window, UINT first,
    UINT last, UINT remove);
__declspec(dllimport) LRESULT __stdcall DispatchMessageA(const MSG *message);
__declspec(dllimport) int __stdcall TranslateMessage(const MSG *message);
__declspec(dllimport) void __stdcall PostQuitMessage(int code);
__declspec(dllimport) int __stdcall DestroyWindow(HWND);
__declspec(dllimport) HDC __stdcall BeginPaint(HWND, PAINTSTRUCT *);
__declspec(dllimport) int __stdcall EndPaint(HWND, const PAINTSTRUCT *);
__declspec(dllimport) HDC __stdcall GetDC(HWND);
__declspec(dllimport) int __stdcall ReleaseDC(HWND, HDC);
__declspec(dllimport) int __stdcall FillRect(HDC, const RECT *, HBRUSH);
__declspec(dllimport) int __stdcall GetClientRect(HWND, RECT *);
__declspec(dllimport) HBRUSH __stdcall CreateSolidBrush(DWORD colour);
__declspec(dllimport) HPEN __stdcall CreatePen(int style, int width, DWORD colour);
__declspec(dllimport) HGDIOBJ __stdcall SelectObject(HDC, HGDIOBJ);
__declspec(dllimport) int __stdcall DeleteObject(HGDIOBJ);
__declspec(dllimport) int __stdcall Rectangle(HDC, int, int, int, int);
__declspec(dllimport) int __stdcall TextOutA(HDC, int, int, const char *, int);
__declspec(dllimport) DWORD __stdcall GetPixel(HDC, int, int);
__declspec(dllimport) int __stdcall GetObjectA(HGDIOBJ, int, void *);
__declspec(dllimport) HGDIOBJ __stdcall CreateDIBSection(HDC, const void *info, UINT usage,
    void **bits, HANDLE section, DWORD offset);

typedef struct { UINT lbStyle; DWORD lbColor; ULONG_PTR lbHatch; } LOGBRUSH;
typedef struct
{
    long bmType, bmWidth, bmHeight, bmWidthBytes;
    unsigned short bmPlanes, bmBitsPixel;
    void *bmBits;
} BITMAP;
typedef struct
{
    DWORD biSize;
    long biWidth, biHeight;
    unsigned short biPlanes, biBitCount;
    DWORD biCompression, biSizeImage;
    long biXPelsPerMeter, biYPelsPerMeter;
    DWORD biClrUsed, biClrImportant;
} BITMAPINFOHEADER;
typedef struct
{
    BITMAP dsBm;
    BITMAPINFOHEADER dsBmih;
    DWORD dsBitfields[3];
    HANDLE dshSection;
    DWORD dsOffset;
} DIBSECTION;

#define WM_CREATE 0x0001
#define WM_DESTROY 0x0002
#define WM_PAINT 0x000f
#define WM_GETMINMAXINFO 0x0024
#define WM_WINDOWPOSCHANGING 0x0046
#define WM_WINDOWPOSCHANGED 0x0047
#define WM_NCCREATE 0x0081
#define WM_NCCALCSIZE 0x0083
#define WM_USER 0x0400
#define WS_OVERLAPPEDWINDOW 0x00cf0000
#define WS_EX_APPWINDOW 0x00040000
#define GWLP_WNDPROC (-4)
#define GWLP_HINSTANCE (-6)
#define GWLP_USERDATA (-21)
#define GCLP_HBRBACKGROUND (-10)
#define GCLP_WNDPROC (-24)
#define SWP_NOZORDER 0x0004
#define PM_REMOVE 1

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

static int marker;
static HINSTANCE instance;
static HBRUSH red;
static int nccreate, created, minmax, changing, changed, calcsize, painted;

static LRESULT window_procedure(HWND hwnd, UINT message, WPARAM wParam, LPARAM lParam)
{
    switch (message)
    {
        case WM_NCCREATE:
        {
            const CREATESTRUCTA *cs = (const CREATESTRUCTA *)lParam;
            nccreate = cs->lpCreateParams == &marker && cs->hInstance == instance
                && cs->cx == 320 && cs->cy == 240 && cs->x == 10 && cs->y == 20
                && cs->style == (long)WS_OVERLAPPEDWINDOW
                && (cs->dwExStyle & WS_EX_APPWINDOW) != 0
                && same(cs->lpszName, "sixty-four") && same(cs->lpszClass, "Bottlify64")
                && cs->hwndParent == 0 && cs->hMenu == 0;
            SetWindowLongPtrA(hwnd, GWLP_USERDATA, (LONG_PTR)cs->lpCreateParams);
            break;
        }
        case WM_CREATE:
        {
            const CREATESTRUCTA *cs = (const CREATESTRUCTA *)lParam;
            created = cs->lpCreateParams == &marker && same(cs->lpszClass, "Bottlify64");
            return 0;
        }
        case WM_GETMINMAXINFO:
        {
            MINMAXINFO *info = (MINMAXINFO *)lParam;
            minmax += info->maxTrackSize.x > 0 && info->maxTrackSize.y > 0;
            break;
        }
        case WM_WINDOWPOSCHANGING:
            changing += ((WINDOWPOS *)lParam)->hwnd == hwnd;
            break;
        case WM_WINDOWPOSCHANGED:
        {
            const WINDOWPOS *pos = (const WINDOWPOS *)lParam;
            changed += pos->hwnd == hwnd && pos->cx == 300 && pos->cy == 200;
            break;
        }
        case WM_NCCALCSIZE:
            if (wParam)
            {
                const NCCALCSIZE_PARAMS *params = (const NCCALCSIZE_PARAMS *)lParam;
                calcsize += params->lppos != 0 && params->lppos->hwnd == hwnd;
            }
            break;
        case WM_PAINT:
        {
            PAINTSTRUCT ps;
            HDC dc = BeginPaint(hwnd, &ps);
            RECT all;
            GetClientRect(hwnd, &all);
            FillRect(dc, &all, red);
            HPEN pen = CreatePen(0, 1, 0x00ff0000);
            HGDIOBJ old = SelectObject(dc, pen);
            Rectangle(dc, 40, 40, 80, 80);
            SelectObject(dc, old);
            DeleteObject(pen);
            TextOutA(dc, 100, 100, "x64", 3);
            painted += ps.hdc == dc && dc != 0 && ps.rcPaint.right > ps.rcPaint.left;
            EndPaint(hwnd, &ps);
            return 0;
        }
        case WM_USER:
            return lParam * 2;
        case WM_USER + 1:
            return wParam == 0x80000001ULL && lParam == -1;
        case WM_DESTROY:
            PostQuitMessage(7);
            return 0;
    }
    return DefWindowProcA(hwnd, message, wParam, lParam);
}

int mainCRTStartup(void)
{
    instance = GetModuleHandleA(0);
    red = CreateSolidBrush(0x000000ff);

    WNDCLASSEXA cls = { sizeof cls };
    cls.lpfnWndProc = window_procedure;
    cls.cbWndExtra = 16;
    cls.hInstance = instance;
    cls.hbrBackground = (HBRUSH)6;
    cls.lpszClassName = "Bottlify64";
    check("RegisterClassExA takes a WNDCLASSEXA of 80 bytes", RegisterClassExA(&cls) != 0);
    WNDCLASSEXA back = { sizeof back };
    check("GetClassInfoExA writes it back", GetClassInfoExA(instance, "Bottlify64", &back)
        && back.lpfnWndProc == window_procedure && back.cbWndExtra == 16
        && back.hInstance == instance && back.hbrBackground == (HBRUSH)6
        && same(back.lpszClassName, "Bottlify64"));

    HWND hwnd = CreateWindowExA(WS_EX_APPWINDOW, "Bottlify64", "sixty-four",
        WS_OVERLAPPEDWINDOW, 10, 20, 320, 240, 0, 0, instance, &marker);
    check("CreateWindowExA", hwnd != 0);
    check("WM_NCCREATE's CREATESTRUCT", nccreate);
    check("WM_CREATE's CREATESTRUCT", created);

    check("GWLP_USERDATA keeps a pointer", GetWindowLongPtrA(hwnd, GWLP_USERDATA)
        == (LONG_PTR)&marker);
    check("GWLP_WNDPROC is the procedure", GetWindowLongPtrA(hwnd, GWLP_WNDPROC)
        == (LONG_PTR)window_procedure);
    check("GWLP_HINSTANCE", GetWindowLongPtrA(hwnd, GWLP_HINSTANCE) == (LONG_PTR)instance);
    SetWindowLongPtrA(hwnd, 8, 0x1122334455667788LL);
    check("the window's extra bytes hold a quadword whole",
        GetWindowLongPtrA(hwnd, 8) == 0x1122334455667788LL);
    check("the class's longs", GetClassLongPtrA(hwnd, GCLP_WNDPROC)
        == (ULONG_PTR)window_procedure
        && SetClassLongPtrA(hwnd, GCLP_HBRBACKGROUND, (LONG_PTR)red) == 6
        && GetClassLongPtrA(hwnd, GCLP_HBRBACKGROUND) == (ULONG_PTR)red);

    check("an LRESULT is a quadword, a negative one sign-extended",
        SendMessageA(hwnd, WM_USER, 0, -21) == -42);
    check("a WPARAM widens as a UINT, an LPARAM as a LONG", SendMessageA(hwnd, WM_USER + 1,
        0x80000001ULL, -1) == 1);

    ShowWindow(hwnd, 3);
    check("WM_GETMINMAXINFO's MINMAXINFO, maximised", minmax > 0);
    ShowWindow(hwnd, 9);
    UpdateWindow(hwnd);
    check("BeginPaint's PAINTSTRUCT", painted > 0);
    HDC dc = GetDC(hwnd);
    check("FillRect painted the client area", GetPixel(dc, 5, 5) == 0x000000ff);
    check("Rectangle drew its outline", GetPixel(dc, 40, 60) == 0x00ff0000);
    ReleaseDC(hwnd, dc);

    SetWindowPos(hwnd, 0, 30, 40, 300, 200, SWP_NOZORDER);
    check("WM_WINDOWPOSCHANGING and WM_WINDOWPOSCHANGED's WINDOWPOS",
        changing > 0 && changed > 0);
    check("WM_NCCALCSIZE's NCCALCSIZE_PARAMS", calcsize > 0);

    LOGBRUSH brush;
    check("GetObject writes a LOGBRUSH of 16 bytes",
        GetObjectA(red, sizeof brush, &brush) == sizeof brush && brush.lbColor == 0x000000ff);
    BITMAPINFOHEADER header = { sizeof header, 16, 8, 1, 32 };
    void *bits = 0;
    HGDIOBJ dib = CreateDIBSection(0, &header, 0, &bits, 0, 0);
    DIBSECTION section;
    BITMAP bitmap;
    check("GetObject writes a BITMAP and a DIBSECTION with bmBits a quadword",
        dib != 0 && bits != 0
        && GetObjectA(dib, sizeof bitmap, &bitmap) == sizeof bitmap && bitmap.bmBits == bits
        && bitmap.bmWidth == 16 && bitmap.bmBitsPixel == 32
        && GetObjectA(dib, sizeof section, &section) == sizeof section
        && section.dsBm.bmBits == bits && section.dsBmih.biWidth == 16
        && section.dsBmih.biBitCount == 32);
    DeleteObject(dib);

    PostMessageA(hwnd, WM_USER + 2, 0x55, -3);
    MSG msg;
    int peeked = PeekMessageA(&msg, hwnd, WM_USER + 2, WM_USER + 2, PM_REMOVE);
    check("PeekMessageA writes a MSG of 48 bytes", peeked && msg.hwnd == hwnd
        && msg.message == WM_USER + 2 && msg.wParam == 0x55 && msg.lParam == -3);

    DestroyWindow(hwnd);
    int got = 0, quit = 0;
    while ((got = GetMessageA(&msg, 0, 0, 0)) > 0)
    {
        TranslateMessage(&msg);
        DispatchMessageA(&msg);
    }
    quit = got == 0 && msg.message == 0x0012 && msg.wParam == 7;
    check("WM_QUIT ends the loop with its code", quit);

    ExitProcess(failures);
    return 0;
}
