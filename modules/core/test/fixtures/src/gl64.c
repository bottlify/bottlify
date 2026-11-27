/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/*
 * OpenGL from a 64-bit process: a pixel format, a context, floats and doubles
 * passed in XMM registers and past them in single stack slots -- read back
 * through the getters to show they arrived as they were sent -- a pointer a
 * query writes whole, an extension's entry point, and a frame: a clear and a
 * triangle, swapped. Each check prints a line; the exit code counts the
 * checks that failed.
 */

typedef unsigned long DWORD;
typedef unsigned int UINT;
typedef unsigned short WORD;
typedef unsigned char BYTE;
typedef void *HANDLE;
typedef HANDLE HWND, HINSTANCE, HMENU, HICON, HCURSOR, HBRUSH, HDC, HGLRC;
typedef unsigned long long WPARAM, ULONG_PTR;
typedef long long LPARAM, LRESULT;
typedef LRESULT (*WNDPROC)(HWND, UINT, WPARAM, LPARAM);
typedef unsigned int GLenum;
typedef unsigned int GLbitfield;
typedef int GLint;
typedef int GLsizei;
typedef float GLfloat;
typedef double GLdouble;
typedef unsigned char GLubyte;

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
    WORD nSize, nVersion;
    DWORD dwFlags;
    BYTE iPixelType, cColorBits, cRedBits, cRedShift, cGreenBits, cGreenShift, cBlueBits,
        cBlueShift, cAlphaBits, cAlphaShift, cAccumBits, cAccumRedBits, cAccumGreenBits,
        cAccumBlueBits, cAccumAlphaBits, cDepthBits, cStencilBits, cAuxBuffers, iLayerType,
        bReserved;
    DWORD dwLayerMask, dwVisibleMask, dwDamageMask;
} PIXELFORMATDESCRIPTOR;

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
__declspec(dllimport) HDC __stdcall GetDC(HWND);
__declspec(dllimport) int __stdcall ReleaseDC(HWND, HDC);
__declspec(dllimport) int __stdcall ChoosePixelFormat(HDC, const PIXELFORMATDESCRIPTOR *);
__declspec(dllimport) int __stdcall SetPixelFormat(HDC, int, const PIXELFORMATDESCRIPTOR *);
__declspec(dllimport) int __stdcall SwapBuffers(HDC);
__declspec(dllimport) HGLRC __stdcall wglCreateContext(HDC);
__declspec(dllimport) int __stdcall wglMakeCurrent(HDC, HGLRC);
__declspec(dllimport) int __stdcall wglDeleteContext(HGLRC);
__declspec(dllimport) void *__stdcall wglGetProcAddress(const char *);
__declspec(dllimport) const GLubyte *__stdcall glGetString(GLenum);
__declspec(dllimport) void __stdcall glClearColor(GLfloat, GLfloat, GLfloat, GLfloat);
__declspec(dllimport) void __stdcall glClear(GLbitfield);
__declspec(dllimport) void __stdcall glViewport(GLint, GLint, GLsizei, GLsizei);
__declspec(dllimport) void __stdcall glMatrixMode(GLenum);
__declspec(dllimport) void __stdcall glLoadIdentity(void);
__declspec(dllimport) void __stdcall glOrtho(GLdouble, GLdouble, GLdouble, GLdouble, GLdouble,
    GLdouble);
__declspec(dllimport) void __stdcall glTranslated(GLdouble, GLdouble, GLdouble);
__declspec(dllimport) void __stdcall glDepthRange(GLdouble, GLdouble);
__declspec(dllimport) void __stdcall glLineWidth(GLfloat);
__declspec(dllimport) void __stdcall glGetFloatv(GLenum, GLfloat *);
__declspec(dllimport) void __stdcall glGetDoublev(GLenum, GLdouble *);
__declspec(dllimport) void __stdcall glVertexPointer(GLint, GLenum, GLsizei, const void *);
__declspec(dllimport) void __stdcall glGetPointerv(GLenum, void **);
__declspec(dllimport) void __stdcall glBegin(GLenum);
__declspec(dllimport) void __stdcall glEnd(void);
__declspec(dllimport) void __stdcall glColor3f(GLfloat, GLfloat, GLfloat);
__declspec(dllimport) void __stdcall glVertex2f(GLfloat, GLfloat);
__declspec(dllimport) void __stdcall glFlush(void);
__declspec(dllimport) GLenum __stdcall glGetError(void);

#define WS_OVERLAPPEDWINDOW 0x00cf0000
#define PFD_DRAW_TO_WINDOW 0x04
#define PFD_SUPPORT_OPENGL 0x20
#define PFD_DOUBLEBUFFER 0x01
#define GL_VENDOR 0x1F00
#define GL_COLOR_BUFFER_BIT 0x4000
#define GL_TRIANGLES 0x0004
#define GL_MODELVIEW 0x1700
#define GL_PROJECTION 0x1701
#define GL_MODELVIEW_MATRIX 0x0BA6
#define GL_PROJECTION_MATRIX 0x0BA7
#define GL_COLOR_CLEAR_VALUE 0x0C22
#define GL_DEPTH_RANGE 0x0B70
#define GL_LINE_WIDTH 0x0B21
#define GL_FLOAT 0x1406
#define GL_VERTEX_ARRAY_POINTER 0x808E
#define GL_TEXTURE1_ARB 0x84C1

/* What an out parameter holds before the call: a high half a 32-bit write leaves. */
#define STALE ((void *)0xdeadbeef00000000ull)

int _fltused = 0;

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

static LRESULT window_procedure(HWND hwnd, UINT message, WPARAM wParam, LPARAM lParam)
{
    return DefWindowProcA(hwnd, message, wParam, lParam);
}

static const GLfloat corners[6] = { 0.0f, 0.5f, 0.5f, -0.5f, -0.5f, -0.5f };

int mainCRTStartup(void)
{
    WNDCLASSA cls = { 0 };
    cls.lpfnWndProc = window_procedure;
    cls.hInstance = GetModuleHandleA(0);
    cls.lpszClassName = "GL64";
    RegisterClassA(&cls);
    HWND window = CreateWindowExA(0, "GL64", "triangle", WS_OVERLAPPEDWINDOW, 0, 0, 160, 120,
        0, 0, cls.hInstance, 0);
    HDC dc = GetDC(window);

    PIXELFORMATDESCRIPTOR wanted = { 0 };
    wanted.nSize = sizeof wanted;
    wanted.nVersion = 1;
    wanted.dwFlags = PFD_DRAW_TO_WINDOW | PFD_SUPPORT_OPENGL | PFD_DOUBLEBUFFER;
    wanted.cColorBits = 32;
    wanted.cDepthBits = 24;
    int format = ChoosePixelFormat(dc, &wanted);
    check("ChoosePixelFormat and SetPixelFormat",
        format > 0 && SetPixelFormat(dc, format, &wanted));
    HGLRC context = wglCreateContext(dc);
    check("wglCreateContext and wglMakeCurrent", context && wglMakeCurrent(dc, context));
    if (!context)
    {
        ExitProcess(100);
    }
    const GLubyte *vendor = glGetString(GL_VENDOR);
    check("glGetString answers a string", vendor && vendor[0]);

    glClearColor(0.2f, 0.4f, 0.6f, 1.0f);
    GLfloat clear[4] = { 0 };
    glGetFloatv(GL_COLOR_CLEAR_VALUE, clear);
    check("glClearColor's four floats arrive from XMM0-XMM3",
        clear[0] == 0.2f && clear[1] == 0.4f && clear[2] == 0.6f && clear[3] == 1.0f);

    glLineWidth(2.5f);
    GLfloat width = 0;
    glGetFloatv(GL_LINE_WIDTH, &width);
    check("glLineWidth's float, the only argument", width == 2.5f);

    glMatrixMode(GL_PROJECTION);
    glLoadIdentity();
    glOrtho(-2.0, 2.0, -4.0, 4.0, -1.0, 3.0);
    GLdouble projection[16] = { 0 };
    glGetDoublev(GL_PROJECTION_MATRIX, projection);
    check("glOrtho's six doubles, four in XMM registers and two in stack slots",
        projection[0] == 0.5 && projection[5] == 0.25 && projection[10] == -0.5
        && projection[14] == -0.5 && projection[15] == 1.0);
    glMatrixMode(GL_MODELVIEW);
    glLoadIdentity();
    glTranslated(0.5, -0.25, 0.125);
    GLdouble modelview[16] = { 0 };
    glGetDoublev(GL_MODELVIEW_MATRIX, modelview);
    check("glTranslated's three doubles",
        modelview[12] == 0.5 && modelview[13] == -0.25 && modelview[14] == 0.125);
    glLoadIdentity();
    glDepthRange(0.25, 0.75);
    GLdouble range[2] = { 0 };
    glGetDoublev(GL_DEPTH_RANGE, range);
    check("glDepthRange's two doubles", range[0] == 0.25 && range[1] == 0.75);
    glDepthRange(0.0, 1.0);

    void *pointer = STALE;
    glVertexPointer(2, GL_FLOAT, 0, corners);
    glGetPointerv(GL_VERTEX_ARRAY_POINTER, &pointer);
    check("glGetPointerv writes the pointer whole", pointer == (void *)corners);

    void (__stdcall *activeTexture)(GLenum) =
        (void (__stdcall *)(GLenum))wglGetProcAddress("glActiveTextureARB");
    check("wglGetProcAddress answers an extension's entry point", activeTexture != 0);
    if (activeTexture)
    {
        activeTexture(GL_TEXTURE1_ARB);
        activeTexture(0x84C0);
    }

    glViewport(0, 0, 160, 120);
    glClear(GL_COLOR_BUFFER_BIT);
    glBegin(GL_TRIANGLES);
    glColor3f(1.0f, 0.5f, 0.25f);
    glVertex2f(0.0f, 0.5f);
    glVertex2f(0.5f, -0.5f);
    glVertex2f(-0.5f, -0.5f);
    glEnd();
    glFlush();
    check("a frame: a clear and a triangle, with no error", glGetError() == 0);
    check("SwapBuffers", SwapBuffers(dc));

    check("wglMakeCurrent(none) and wglDeleteContext",
        wglMakeCurrent(0, 0) && wglDeleteContext(context));
    ReleaseDC(window, dc);
    DestroyWindow(window);
    ExitProcess(failures);
    return 0;
}
