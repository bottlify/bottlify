/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/*
 * Direct3D 9 from a 64-bit process: the interfaces' tables of eight-byte
 * slots called with the x64 convention, the structures with pointers in them
 * in their 64-bit layouts (D3DPRESENT_PARAMETERS, D3DDEVICE_CREATION_PARAMETERS),
 * an interface or a locked pointer written whole into an eight-byte out
 * parameter, a float argument in an XMM register, and a frame: a clear and a
 * triangle from a vertex buffer, another from the program's memory, presented.
 * Each check prints a line; the exit code counts the checks that failed.
 *
 * Written against the interfaces' slots rather than d3d9.h, which this
 * build does not have: METHOD(object, slot, type) is the slot's function.
 */

typedef unsigned long DWORD;
typedef unsigned int UINT;
typedef long HRESULT;
typedef void *HANDLE;
typedef HANDLE HWND, HINSTANCE, HMENU, HICON, HCURSOR, HBRUSH;
typedef unsigned long long WPARAM, ULONG_PTR;
typedef long long LPARAM, LRESULT;
typedef LRESULT (*WNDPROC)(HWND, UINT, WPARAM, LPARAM);

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
    UINT BackBufferWidth, BackBufferHeight, BackBufferFormat, BackBufferCount;
    UINT MultiSampleType;
    DWORD MultiSampleQuality;
    UINT SwapEffect;
    HWND hDeviceWindow;
    int Windowed, EnableAutoDepthStencil;
    UINT AutoDepthStencilFormat;
    DWORD Flags;
    UINT FullScreen_RefreshRateInHz, PresentationInterval;
} D3DPRESENT_PARAMETERS;

typedef struct
{
    UINT AdapterOrdinal, DeviceType;
    HWND hFocusWindow;
    DWORD BehaviorFlags;
} D3DDEVICE_CREATION_PARAMETERS;

typedef struct { UINT Width, Height, RefreshRate, Format; } D3DDISPLAYMODE;
typedef struct
{
    UINT Format, Type;
    DWORD Usage;
    UINT Pool, MultiSampleType;
    DWORD MultiSampleQuality;
    UINT Width, Height;
} D3DSURFACE_DESC;

typedef struct { float x, y, z, rhw; DWORD color; } VERTEX;

/* What the compiler names when a program uses floating point; no runtime defines it here. */
int _fltused = 0;

__declspec(dllimport) void __stdcall ExitProcess(UINT code);
__declspec(dllimport) HANDLE __stdcall GetStdHandle(DWORD which);
__declspec(dllimport) int __stdcall WriteFile(HANDLE file, const void *bytes, DWORD count,
    DWORD *written, void *overlapped);
__declspec(dllimport) HINSTANCE __stdcall GetModuleHandleA(const char *name);
__declspec(dllimport) unsigned short __stdcall RegisterClassA(const WNDCLASSA *cls);
__declspec(dllimport) HWND __stdcall CreateWindowExA(DWORD exStyle, const char *className,
    const char *title, DWORD style, int x, int y, int width, int height, HWND parent,
    HMENU menu, HINSTANCE instance, void *parameter);
__declspec(dllimport) LRESULT __stdcall DefWindowProcA(HWND, UINT, WPARAM, LPARAM);
__declspec(dllimport) int __stdcall DestroyWindow(HWND);
__declspec(dllimport) void *__stdcall Direct3DCreate9(UINT version);

#define METHOD(object, slot, type) ((type)((*(void ***)(object))[slot]))

/* IDirect3D9 */
#define RELEASE 2
#define GET_ADAPTER_COUNT 4
#define GET_ADAPTER_DISPLAY_MODE 8
#define CREATE_DEVICE 16
/* IDirect3DDevice9 */
#define GET_DIRECT3D 6
#define GET_CREATION_PARAMETERS 9
#define PRESENT 17
#define GET_BACK_BUFFER 18
#define CREATE_VERTEX_BUFFER 26
#define BEGIN_SCENE 41
#define END_SCENE 42
#define CLEAR 43
#define SET_N_PATCH_MODE 79
#define GET_N_PATCH_MODE 80
#define DRAW_PRIMITIVE 81
#define DRAW_PRIMITIVE_UP 83
#define SET_FVF 89
#define SET_STREAM_SOURCE 100
/* IDirect3DVertexBuffer9 */
#define LOCK 11
#define UNLOCK 12
/* IDirect3DSurface9 */
#define SURFACE_GET_DESC 12

#define D3D_SDK_VERSION 32
#define D3DDEVTYPE_HAL 1
#define D3DCREATE_SOFTWARE_VERTEXPROCESSING 0x20
#define D3DFMT_X8R8G8B8 22
#define D3DSWAPEFFECT_DISCARD 1
#define D3DPOOL_MANAGED 1
#define D3DFVF_XYZRHW 0x004
#define D3DFVF_DIFFUSE 0x040
#define D3DCLEAR_TARGET 1
#define D3DPT_TRIANGLELIST 4
#define D3DBACKBUFFER_TYPE_MONO 0
#define WS_OVERLAPPEDWINDOW 0x00cf0000

/* What an out parameter holds before the call: a high half a 32-bit write leaves. */
#define STALE ((void *)0xdeadbeef00000000ull)

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

/* A pointer an out parameter was handed whole: no high half, and not null. */
static int whole(void *pointer)
{
    return pointer != 0 && ((ULONG_PTR)pointer >> 32) == 0;
}

static LRESULT window_procedure(HWND hwnd, UINT message, WPARAM wParam, LPARAM lParam)
{
    return DefWindowProcA(hwnd, message, wParam, lParam);
}

int mainCRTStartup(void)
{
    WNDCLASSA cls = { 0 };
    cls.lpfnWndProc = window_procedure;
    cls.hInstance = GetModuleHandleA(0);
    cls.lpszClassName = "D3D9x64";
    RegisterClassA(&cls);
    HWND window = CreateWindowExA(0, "D3D9x64", "triangle", WS_OVERLAPPEDWINDOW, 0, 0, 320,
        240, 0, 0, cls.hInstance, 0);

    void *d3d = Direct3DCreate9(D3D_SDK_VERSION);
    check("Direct3DCreate9 answers an interface", whole(d3d));
    if (!d3d)
    {
        ExitProcess(100);
    }
    check("IDirect3D9 is called through slots eight bytes apart",
        METHOD(d3d, GET_ADAPTER_COUNT, UINT (*)(void *))(d3d) == 1);
    D3DDISPLAYMODE mode = { 0 };
    check("and fills what it is handed",
        METHOD(d3d, GET_ADAPTER_DISPLAY_MODE, HRESULT (*)(void *, UINT, D3DDISPLAYMODE *))(
            d3d, 0, &mode) == 0 && mode.Width > 0 && mode.Height > 0);

    D3DPRESENT_PARAMETERS present = { 0 };
    present.BackBufferWidth = 64;
    present.BackBufferHeight = 48;
    present.BackBufferFormat = D3DFMT_X8R8G8B8;
    present.BackBufferCount = 1;
    present.SwapEffect = D3DSWAPEFFECT_DISCARD;
    present.hDeviceWindow = window;
    present.Windowed = 1;
    present.PresentationInterval = 0x80000000u;
    void *device = STALE;
    HRESULT made = METHOD(d3d, CREATE_DEVICE, HRESULT (*)(void *, UINT, UINT, HWND, DWORD,
        D3DPRESENT_PARAMETERS *, void **))(d3d, 0, D3DDEVTYPE_HAL, window,
        D3DCREATE_SOFTWARE_VERTEXPROCESSING, &present, &device);
    check("CreateDevice reads D3DPRESENT_PARAMETERS and writes the device whole",
        made == 0 && whole(device));
    if (made != 0)
    {
        ExitProcess(100);
    }

    D3DDEVICE_CREATION_PARAMETERS creation = { 0 };
    creation.BehaviorFlags = 0x5555;
    METHOD(device, GET_CREATION_PARAMETERS, HRESULT (*)(void *,
        D3DDEVICE_CREATION_PARAMETERS *))(device, &creation);
    check("GetCreationParameters fills D3DDEVICE_CREATION_PARAMETERS",
        creation.hFocusWindow == window && creation.DeviceType == D3DDEVTYPE_HAL
        && creation.BehaviorFlags == D3DCREATE_SOFTWARE_VERTEXPROCESSING);
    void *again = STALE;
    METHOD(device, GET_DIRECT3D, HRESULT (*)(void *, void **))(device, &again);
    check("GetDirect3D writes the interface whole", again == d3d);
    METHOD(again, RELEASE, DWORD (*)(void *))(again);
    HRESULT patched = METHOD(device, SET_N_PATCH_MODE, HRESULT (*)(void *, float))(device, 2.5f);
    check("SetNPatchMode takes its float from XMM1 and GetNPatchMode answers it in XMM0",
        patched == 0 && METHOD(device, GET_N_PATCH_MODE, float (*)(void *))(device) == 2.5f);

    void *buffer = STALE;
    HRESULT created = METHOD(device, CREATE_VERTEX_BUFFER, HRESULT (*)(void *, UINT, DWORD,
        DWORD, UINT, void **, HANDLE *))(device, 3 * sizeof(VERTEX), 0,
        D3DFVF_XYZRHW | D3DFVF_DIFFUSE, D3DPOOL_MANAGED, &buffer, 0);
    check("CreateVertexBuffer writes the buffer whole", created == 0 && whole(buffer));
    VERTEX *vertices = STALE;
    HRESULT locked = METHOD(buffer, LOCK, HRESULT (*)(void *, UINT, UINT, void **, DWORD))(
        buffer, 0, 0, (void **)&vertices, 0);
    check("Lock writes the pointer whole", locked == 0 && whole(vertices));
    if (locked == 0)
    {
        VERTEX triangle[3] = {
            { 32.0f, 4.0f, 0.5f, 1.0f, 0xffff0000 },
            { 60.0f, 44.0f, 0.5f, 1.0f, 0xff00ff00 },
            { 4.0f, 44.0f, 0.5f, 1.0f, 0xff0000ff },
        };
        for (int index = 0; index < 3; index++)
        {
            vertices[index] = triangle[index];
        }
        METHOD(buffer, UNLOCK, HRESULT (*)(void *))(buffer);
    }

    HRESULT cleared = METHOD(device, CLEAR, HRESULT (*)(void *, DWORD, const void *, DWORD,
        DWORD, float, DWORD))(device, 0, 0, D3DCLEAR_TARGET, 0xff336699, 1.0f, 0);
    check("Clear", cleared == 0);
    HRESULT began = METHOD(device, BEGIN_SCENE, HRESULT (*)(void *))(device);
    METHOD(device, SET_FVF, HRESULT (*)(void *, DWORD))(device, D3DFVF_XYZRHW | D3DFVF_DIFFUSE);
    METHOD(device, SET_STREAM_SOURCE, HRESULT (*)(void *, UINT, void *, UINT, UINT))(device, 0,
        buffer, 0, sizeof(VERTEX));
    HRESULT drawn = METHOD(device, DRAW_PRIMITIVE, HRESULT (*)(void *, UINT, UINT, UINT))(device,
        D3DPT_TRIANGLELIST, 0, 1);
    VERTEX small[3] = {
        { 8.0f, 8.0f, 0.5f, 1.0f, 0xffffffff },
        { 16.0f, 8.0f, 0.5f, 1.0f, 0xffffffff },
        { 8.0f, 16.0f, 0.5f, 1.0f, 0xffffffff },
    };
    HRESULT drawnUp = METHOD(device, DRAW_PRIMITIVE_UP, HRESULT (*)(void *, UINT, UINT,
        const void *, UINT))(device, D3DPT_TRIANGLELIST, 1, small, sizeof(VERTEX));
    HRESULT ended = METHOD(device, END_SCENE, HRESULT (*)(void *))(device);
    check("a scene draws a triangle from the buffer and one from memory",
        began == 0 && drawn == 0 && drawnUp == 0 && ended == 0);
    check("Present", METHOD(device, PRESENT, HRESULT (*)(void *, const void *, const void *,
        HWND, const void *))(device, 0, 0, 0, 0) == 0);

    void *surface = STALE;
    METHOD(device, GET_BACK_BUFFER, HRESULT (*)(void *, UINT, UINT, UINT, void **))(device, 0, 0,
        D3DBACKBUFFER_TYPE_MONO, &surface);
    D3DSURFACE_DESC description = { 0 };
    int described = whole(surface) && METHOD(surface, SURFACE_GET_DESC, HRESULT (*)(void *,
        D3DSURFACE_DESC *))(surface, &description) == 0;
    check("GetBackBuffer writes the surface whole, and its description is the back buffer's",
        described && description.Width == 64 && description.Height == 48);
    if (whole(surface))
    {
        METHOD(surface, RELEASE, DWORD (*)(void *))(surface);
    }

    METHOD(buffer, RELEASE, DWORD (*)(void *))(buffer);
    check("the device's last reference ends it",
        METHOD(device, RELEASE, DWORD (*)(void *))(device) == 0);
    check("and the object's",
        METHOD(d3d, RELEASE, DWORD (*)(void *))(d3d) == 0);
    DestroyWindow(window);
    ExitProcess(failures);
    return 0;
}
