/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/*
 * Where a 64-bit process finds what the system places for it: its thread and
 * process blocks, its stacks (the first thread's and a second's), heap blocks
 * of every heap call, pages from VirtualAlloc with no address and with one,
 * the C runtime's strings and structures, the system's libraries, their
 * functions, the shared user data, a handle, a thread-local slot's array, and
 * COM objects with their method tables (Direct3D 9's and ole32's stream).
 * Each must lie below 4 GiB whatever the image's own base is: a guest routine
 * keeps such an address in a dword, and so do the system's own tables. A line
 * a place: `ok` or `FAIL` with it. The exit code counts the places at or past
 * 4 GiB.
 */

typedef unsigned long DWORD;
typedef unsigned int UINT;
typedef void *HANDLE;
typedef unsigned long long QWORD;
typedef struct { char opaque[48]; } FILE;
typedef DWORD (__stdcall *ThreadStart)(void *parameter);

struct lconv { char *decimal_point; char *thousands_sep; };

__declspec(dllimport) extern FILE _iob[];
__declspec(dllimport) extern char **_environ;
__declspec(dllimport) struct lconv *__cdecl localeconv(void);
__declspec(dllimport) void *__cdecl malloc(QWORD bytes);
__declspec(dllimport) void *__cdecl calloc(QWORD count, QWORD bytes);
__declspec(dllimport) void *__cdecl realloc(void *block, QWORD bytes);
__declspec(dllimport) void __stdcall ExitProcess(UINT code);
__declspec(dllimport) HANDLE __stdcall GetStdHandle(DWORD which);
__declspec(dllimport) int __stdcall WriteFile(HANDLE file, const void *bytes, DWORD count,
    DWORD *written, void *overlapped);
__declspec(dllimport) HANDLE __stdcall GetModuleHandleA(const char *name);
__declspec(dllimport) HANDLE __stdcall GetProcessHeap(void);
__declspec(dllimport) void *__stdcall HeapAlloc(HANDLE heap, DWORD flags, QWORD bytes);
__declspec(dllimport) void *__stdcall HeapReAlloc(HANDLE heap, DWORD flags, void *block,
    QWORD bytes);
__declspec(dllimport) HANDLE __stdcall GlobalAlloc(UINT flags, QWORD bytes);
__declspec(dllimport) void *__stdcall VirtualAlloc(void *address, QWORD bytes, DWORD type,
    DWORD protect);
__declspec(dllimport) char *__stdcall GetCommandLineA(void);
__declspec(dllimport) unsigned short *__stdcall GetCommandLineW(void);
__declspec(dllimport) HANDLE __stdcall CreateThread(void *attributes, QWORD stack,
    ThreadStart start, void *parameter, DWORD flags, DWORD *id);
__declspec(dllimport) DWORD __stdcall WaitForSingleObject(HANDLE handle, DWORD milliseconds);
__declspec(dllimport) HANDLE __stdcall CreateEventA(void *attributes, int manual, int initial,
    const char *name);
__declspec(dllimport) DWORD __stdcall TlsAlloc(void);
__declspec(dllimport) int __stdcall TlsSetValue(DWORD index, void *value);
__declspec(dllimport) void *__stdcall Direct3DCreate9(UINT version);
__declspec(dllimport) long __stdcall CoInitialize(void *reserved);
__declspec(dllimport) long __stdcall CreateStreamOnHGlobal(HANDLE global, int deleteOnRelease,
    void **stream);

#define MEM_COMMIT 0x1000
#define MEM_RESERVE 0x2000
#define PAGE_READWRITE 4

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

/* A place the system chose: there, and below 4 GiB. */
static void low(const char *what, const void *place)
{
    static const char digits[] = "0123456789abcdef";
    char hex[19];
    QWORD value = (QWORD)place;
    int ok = value != 0 && (value >> 32) == 0;
    hex[0] = '0';
    hex[1] = 'x';
    for (int index = 0; index < 16; index++)
    {
        hex[2 + index] = digits[(value >> (60 - 4 * index)) & 15];
    }
    hex[18] = 0;
    say(ok ? "ok   " : "FAIL ");
    say(what);
    if (!ok)
    {
        say(" at ");
        say(hex);
    }
    say("\r\n");
    failures += !ok;
}

static void *gs(QWORD offset)
{
    void *value;
    __asm__ volatile("movq %%gs:(%1), %0" : "=r"(value) : "r"(offset));
    return value;
}

static DWORD __stdcall second(void *parameter)
{
    int local = 0;
    (void)parameter;
    low("a second thread's stack", &local);
    low("a second thread's block", gs(0x30));
    low("a second thread's thread-local array", gs(0x58));
    low("a block from the heap on a second thread", HeapAlloc(GetProcessHeap(), 0, 64));
    return 0;
}

void mainCRTStartup(void)
{
    int local = 0;
    void *block;
    void *object = 0;
    /* Where the image itself is: the one thing that may lie past 4 GiB. */
    say((QWORD)(void *)mainCRTStartup >> 32 ? "note the image lies past 4 GiB\r\n"
        : "note the image lies below 4 GiB\r\n");
    low("the first thread's stack", &local);
    low("the thread's block", gs(0x30));
    low("the process's block", gs(0x60));
    low("the thread's stack base", gs(0x08));
    TlsSetValue(TlsAlloc(), &local);
    low("the thread-local array", gs(0x58));

    low("the process heap", GetProcessHeap());
    block = HeapAlloc(GetProcessHeap(), 0, 100);
    low("a block from HeapAlloc", block);
    low("a block grown by HeapReAlloc", HeapReAlloc(GetProcessHeap(), 0, block, 3 << 20));
    low("a megabyte from HeapAlloc", HeapAlloc(GetProcessHeap(), 8, 1 << 20));
    low("a block from GlobalAlloc", GlobalAlloc(0, 200));
    block = malloc(48);
    low("a block from malloc", block);
    low("a block grown by realloc", realloc(block, 1 << 16));
    low("a block from calloc", calloc(16, 16));
    low("pages from VirtualAlloc with no address",
        VirtualAlloc(0, 1 << 20, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE));
    low("64 MiB reserved by VirtualAlloc", VirtualAlloc(0, 64 << 20, MEM_RESERVE,
        PAGE_READWRITE));
    block = VirtualAlloc(0, 1 << 16, MEM_RESERVE, PAGE_READWRITE);
    low("pages committed at an address VirtualAlloc reserved",
        VirtualAlloc(block, 1 << 12, MEM_COMMIT, PAGE_READWRITE));

    low("the command line", GetCommandLineA());
    low("the wide command line", GetCommandLineW());
    low("the C runtime's streams", &_iob[1]);
    low("the C runtime's environment", _environ);
    low("localeconv's structure", localeconv());
    low("and its decimal point", localeconv()->decimal_point);

    low("KERNEL32.dll", GetModuleHandleA("KERNEL32.dll"));
    low("msvcrt.dll", GetModuleHandleA("msvcrt.dll"));
    low("a function of KERNEL32.dll", (void *)ExitProcess);
    low("a function of msvcrt.dll", (void *)malloc);
    low("the shared user data's version", (void *)(QWORD)*(DWORD *)0x7ffe026c);
    low("a handle", CreateEventA(0, 0, 0, 0));

    block = CreateThread(0, 0, second, 0, 0, 0);
    low("a thread's handle", block);
    WaitForSingleObject(block, 0xffffffff);

    block = Direct3DCreate9(32);
    low("Direct3D 9's object", block);
    if (block)
    {
        low("its method table", *(void **)block);
        low("a method of it", **(void ***)block);
    }
    CoInitialize(0);
    CreateStreamOnHGlobal(0, 1, &object);
    low("ole32's stream", object);
    if (object)
    {
        low("the stream's method table", *(void **)object);
        low("a method of the stream", **(void ***)object);
    }
    say(failures ? "some lie past 4 GiB\r\n" : "all below 4 GiB\r\n");
    ExitProcess(failures);
}
