/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/*
 * Runs the benchmark's own bytes on the processor, as the reference the
 * engine is judged against: a Linux program with no C library that maps a
 * fixed-base PE at its preferred address, binds each import the benchmark
 * names to a function here, and calls the entry point. The program's checksum
 * then comes from the hardware running the very instructions the engine
 * translates, x87 spills and all. Built twice: as a 32-bit program for the
 * x86 builds (`peload`, stdcall bindings) and as a 64-bit one for the x64
 * build (`peload64`, a PE32+ and Microsoft's x64 convention).
 *
 *     peload <bench.exe> <workload> [iterations]
 *
 * Writes what the program writes, then `native-ns <n>` on stderr, and exits
 * with the program's exit code (the low byte, as a process can).
 */

typedef unsigned char u8;
typedef unsigned short u16;
typedef unsigned int u32;
typedef int i32;
typedef long long i64;
/* A register's width: an address, a system call's argument and answer. */
typedef long word;

#if defined(__x86_64__)
#define STDCALL __attribute__((ms_abi))
#define CDECL __attribute__((ms_abi))
#define WIDE 1
enum { SYS_READ = 0, SYS_WRITE = 1, SYS_OPEN = 2, SYS_CLOSE = 3, SYS_EXIT = 60,
    SYS_EXIT_GROUP = 231, SYS_CLOCK_GETTIME = 228 };

static word sys(word n, word a, word b, word c)
{
    word r;
    __asm__ volatile("syscall" : "=a"(r) : "a"(n), "D"(a), "S"(b), "d"(c) : "rcx", "r11", "memory");
    return r;
}

static void *mapFixed(word address, word size)
{
    // mmap(address, size, RWX, MAP_PRIVATE|MAP_ANONYMOUS|MAP_FIXED, -1, 0)
    word r;
    register word flags __asm__("r10") = 0x32;
    register word fd __asm__("r8") = -1;
    register word offset __asm__("r9") = 0;
    __asm__ volatile("syscall"
                     : "=a"(r)
                     : "a"(9), "D"(address), "S"(size), "d"(7), "r"(flags), "r"(fd), "r"(offset)
                     : "rcx", "r11", "memory");
    return (void *)r;
}
#else
#define STDCALL __attribute__((stdcall))
#define CDECL
#define WIDE 0
enum { SYS_READ = 3, SYS_WRITE = 4, SYS_OPEN = 5, SYS_CLOSE = 6, SYS_EXIT = 1,
    SYS_EXIT_GROUP = 252, SYS_CLOCK_GETTIME = 265 };

static word sys(word n, word a, word b, word c)
{
    word r;
    __asm__ volatile("int $0x80" : "=a"(r) : "a"(n), "b"(a), "c"(b), "d"(c) : "memory");
    return r;
}

static void *mapFixed(word address, word size)
{
    // mmap2(address, size, RWX, MAP_PRIVATE|MAP_ANONYMOUS|MAP_FIXED, -1, 0)
    word r;
    __asm__ volatile("push %%ebp\n\txor %%ebp, %%ebp\n\tint $0x80\n\tpop %%ebp"
                     : "=a"(r)
                     : "a"(192), "b"(address), "c"(size), "d"(7), "S"(0x32), "D"(-1)
                     : "memory");
    return (void *)r;
}
#endif

static u32 length(const char *s)
{
    u32 n = 0;
    while (s[n])
    {
        n++;
    }
    return n;
}

static void put(int fd, const char *s)
{
    sys(SYS_WRITE, fd, (word)s, (word)length(s));
}

static void putNumber(int fd, u32 v)
{
    char t[24];
    int at = 23;
    t[at] = 0;
    do
    {
        t[--at] = (char)('0' + v % 10);
        v /= 10;
    } while (v);
    put(fd, t + at);
}

static void die(const char *why, const char *what)
{
    put(2, "peload: ");
    put(2, why);
    put(2, what);
    put(2, "\n");
    sys(SYS_EXIT, 127, 0, 0);
}

struct Time {
    word sec, nsec;
};

static struct Time now(void)
{
    struct Time t;
    sys(SYS_CLOCK_GETTIME, 1, (word)&t, 0); // CLOCK_MONOTONIC
    return t;
}

static struct Time started;
static char commandLine[512];

/* ---- kernel32 ---- */

static STDCALL void ExitProcess(u32 code)
{
    struct Time t = now();
    word sec = t.sec - started.sec, nsec = t.nsec - started.nsec;
    if (nsec < 0)
    {
        sec--;
        nsec += 1000000000;
    }
    // Seconds, then the nanoseconds as nine digits: no 64-bit division here.
    put(2, "native-ns ");
    if (sec)
    {
        putNumber(2, (u32)sec);
        char digits[10];
        for (int i = 8; i >= 0; i--)
        {
            digits[i] = (char)('0' + nsec % 10);
            nsec /= 10;
        }
        digits[9] = 0;
        put(2, digits);
    }
    else
    {
        putNumber(2, (u32)nsec);
    }
    put(2, "\n");
    put(2, "native-exit ");
    putNumber(2, code);
    put(2, "\n");
    sys(SYS_EXIT_GROUP, (word)code, 0, 0);
}

static STDCALL void *GetStdHandle(u32 which)
{
    return (void *)(word)(which == (u32)-12 ? 2 : 1);
}

static STDCALL int WriteFile(void *file, const void *bytes, u32 count, u32 *written, void *overlapped)
{
    (void)overlapped;
    sys(SYS_WRITE, (word)file, (word)bytes, (word)count);
    if (written)
    {
        *written = count;
    }
    return 1;
}

static STDCALL const char *GetCommandLineA(void)
{
    return commandLine;
}

static STDCALL u32 GetCurrentThreadId(void)
{
    return 0x1234;
}

static u32 lastError;
static STDCALL u32 GetLastError(void)
{
    return lastError;
}
static STDCALL void SetLastError(u32 code)
{
    lastError = code;
}

static void *slots[64];
static u32 slotsUsed;
static STDCALL u32 TlsAlloc(void)
{
    return slotsUsed++;
}
static STDCALL int TlsSetValue(u32 index, void *value)
{
    slots[index & 63] = value;
    return 1;
}
static STDCALL void *TlsGetValue(u32 index)
{
    lastError = 0;
    return slots[index & 63];
}

static STDCALL void InitializeCriticalSection(void *section)
{
    u32 *words = (u32 *)section;
    for (int i = 0; i < 6; i++)
    {
        words[i] = 0;
    }
    words[1] = (u32)-1;
}
static STDCALL void EnterCriticalSection(void *section)
{
    ((i32 *)section)[1]++;
}
static STDCALL void LeaveCriticalSection(void *section)
{
    ((i32 *)section)[1]--;
}

static STDCALL i32 InterlockedIncrement(volatile i32 *value)
{
    return ++*value;
}
static STDCALL i32 InterlockedCompareExchange(volatile i32 *target, i32 value, i32 comparand)
{
    i32 old = *target;
    if (old == comparand)
    {
        *target = value;
    }
    return old;
}

static STDCALL u32 GetTickCount(void)
{
    struct Time t = now();
    return (u32)t.sec * 1000 + (u32)t.nsec / 1000000;
}
static STDCALL int QueryPerformanceCounter(i64 *count)
{
    struct Time t = now();
    *count = (i64)t.sec * 1000000000 + t.nsec;
    return 1;
}

/* One pool for the heap and malloc; nothing the checksum reads depends on addresses. */
static u8 pool[64 << 20];
static u32 poolUsed;
static void *allocate(u32 bytes)
{
    u32 at = (poolUsed + 15) & ~15u;
    if (at + bytes > sizeof pool)
    {
        poolUsed = 0; // the benchmark frees what it takes before taking more
        at = 0;
    }
    poolUsed = at + bytes;
    return pool + at;
}

static STDCALL void *GetProcessHeap(void)
{
    return (void *)1;
}
static STDCALL void *HeapAlloc(void *heap, u32 flags, u32 bytes)
{
    (void)heap;
    u8 *p = (u8 *)allocate(bytes);
    if (flags & 8)
    {
        for (u32 i = 0; i < bytes; i++)
        {
            p[i] = 0;
        }
    }
    return p;
}
static STDCALL int HeapFree(void *heap, u32 flags, void *block)
{
    (void)heap;
    (void)flags;
    (void)block;
    return 1;
}

static STDCALL int lstrlenA(const char *text)
{
    return text ? (int)length(text) : 0;
}

static STDCALL int MultiByteToWideChar(u32 codePage, u32 flags, const char *text, int count, u16 *wide,
    int wideLength)
{
    (void)codePage;
    (void)flags;
    int n = count < 0 ? (int)length(text) + 1 : count;
    if (wideLength == 0)
    {
        return n;
    }
    if (n > wideLength)
    {
        lastError = 122;
        return 0;
    }
    for (int i = 0; i < n; i++)
    {
        wide[i] = (u8)text[i];
    }
    return n;
}

/* ---- msvcrt ---- */

static CDECL u32 crtStrlen(const char *text)
{
    return length(text);
}

static CDECL int crtStrcmp(const char *a, const char *b)
{
    while (*a && *a == *b)
    {
        a++;
        b++;
    }
    // msvcrt answers -1, 0 or 1.
    int d = (int)(u8)*a - (int)(u8)*b;
    return d < 0 ? -1 : d > 0;
}

static CDECL char *crtStrcpy(char *to, const char *from)
{
    char *d = to;
    while ((*d++ = *from++))
    {
    }
    return to;
}

#if WIDE
#define VA_LIST __builtin_ms_va_list
#define VA_START __builtin_ms_va_start
#define VA_END __builtin_ms_va_end
#else
#define VA_LIST __builtin_va_list
#define VA_START __builtin_va_start
#define VA_END __builtin_va_end
#endif

static CDECL int crtSprintf(char *to, const char *format, ...)
{
    VA_LIST args;
    VA_START(args, format);
    char *o = to;
    for (const char *f = format; *f; f++)
    {
        if (*f != '%')
        {
            *o++ = *f;
            continue;
        }
        f++;
        if (*f == 's')
        {
            const char *s = __builtin_va_arg(args, const char *);
            while (*s)
            {
                *o++ = *s++;
            }
        }
        else if (*f == 'd' || *f == 'x')
        {
            u32 v = __builtin_va_arg(args, u32);
            char t[12];
            int at = 11;
            t[at] = 0;
            int negative = *f == 'd' && (i32)v < 0;
            if (negative)
            {
                v = 0u - v;
            }
            u32 base = *f == 'd' ? 10 : 16;
            do
            {
                t[--at] = "0123456789abcdef"[v % base];
                v /= base;
            } while (v);
            if (negative)
            {
                *o++ = '-';
            }
            for (char *p = t + at; *p; p++)
            {
                *o++ = *p;
            }
        }
        else
        {
            *o++ = *f;
        }
    }
    *o = 0;
    VA_END(args);
    return (int)(o - to);
}

static CDECL void *crtMalloc(u32 bytes)
{
    return allocate(bytes);
}

static CDECL void crtFree(void *block)
{
    (void)block;
}

typedef int (CDECL *Compare)(const void *, const void *);
static CDECL void crtQsort(void *base, u32 count, u32 size, Compare compare)
{
    u8 *a = (u8 *)base;
    u8 t[64];
    for (u32 i = 1; i < count; i++)
    {
        for (u32 k = 0; k < size; k++)
        {
            t[k] = a[i * size + k];
        }
        u32 j = i;
        while (j > 0 && compare(a + (j - 1) * size, t) > 0)
        {
            for (u32 k = 0; k < size; k++)
            {
                a[j * size + k] = a[(j - 1) * size + k];
            }
            j--;
        }
        for (u32 k = 0; k < size; k++)
        {
            a[j * size + k] = t[k];
        }
    }
}

struct Binding {
    const char *name;
    void *function;
};

static const struct Binding BINDINGS[] = {
    { "ExitProcess", (void *)ExitProcess },
    { "GetStdHandle", (void *)GetStdHandle },
    { "WriteFile", (void *)WriteFile },
    { "GetCommandLineA", (void *)GetCommandLineA },
    { "GetCurrentThreadId", (void *)GetCurrentThreadId },
    { "GetLastError", (void *)GetLastError },
    { "SetLastError", (void *)SetLastError },
    { "TlsAlloc", (void *)TlsAlloc },
    { "TlsSetValue", (void *)TlsSetValue },
    { "TlsGetValue", (void *)TlsGetValue },
    { "InitializeCriticalSection", (void *)InitializeCriticalSection },
    { "EnterCriticalSection", (void *)EnterCriticalSection },
    { "LeaveCriticalSection", (void *)LeaveCriticalSection },
    { "InterlockedIncrement", (void *)InterlockedIncrement },
    { "InterlockedCompareExchange", (void *)InterlockedCompareExchange },
    { "GetTickCount", (void *)GetTickCount },
    { "QueryPerformanceCounter", (void *)QueryPerformanceCounter },
    { "GetProcessHeap", (void *)GetProcessHeap },
    { "HeapAlloc", (void *)HeapAlloc },
    { "HeapFree", (void *)HeapFree },
    { "lstrlenA", (void *)lstrlenA },
    { "MultiByteToWideChar", (void *)MultiByteToWideChar },
    { "strlen", (void *)crtStrlen },
    { "strcmp", (void *)crtStrcmp },
    { "strcpy", (void *)crtStrcpy },
    { "sprintf", (void *)crtSprintf },
    { "malloc", (void *)crtMalloc },
    { "free", (void *)crtFree },
    { "qsort", (void *)crtQsort },
};

static int same(const char *a, const char *b)
{
    while (*a && *a == *b)
    {
        a++;
        b++;
    }
    return *a == *b;
}

static u8 file[8 << 20];

static u32 rd32(const u8 *p)
{
    return p[0] | p[1] << 8 | p[2] << 16 | (u32)p[3] << 24;
}

static u16 rd16(const u8 *p)
{
    return (u16)(p[0] | p[1] << 8);
}

__attribute__((used)) static void run(int argc, char **argv)
{
    if (argc < 3)
    {
        die("usage: peload <bench.exe> <workload> [iterations]", "");
    }
    word fd = sys(SYS_OPEN, (word)argv[1], 0, 0);
    if (fd < 0)
    {
        die("cannot open ", argv[1]);
    }
    u32 size = 0;
    for (;;)
    {
        word n = sys(SYS_READ, fd, (word)(file + size), (word)(sizeof file - size));
        if (n <= 0)
        {
            break;
        }
        size += (u32)n;
    }
    sys(SYS_CLOSE, fd, 0, 0);

    const u8 *pe = file + rd32(file + 0x3c);
    if (rd32(pe) != 0x4550)
    {
        die("not a PE: ", argv[1]);
    }
    u32 sections = rd16(pe + 6);
    u32 optionalSize = rd16(pe + 20);
    const u8 *opt = pe + 24;
    // A PE32+ (magic 0x20b) keeps an 8-byte base and its directories 16 bytes later.
    int plus = rd16(opt) == 0x20b;
    if (plus != WIDE)
    {
        die(WIDE ? "not a PE32+ (peload64 runs the x64 build): " : "a PE32+ (run peload64): ",
            argv[1]);
    }
    u32 entry = rd32(opt + 16);
    word base = (word)rd32(opt + (plus ? 24 : 28));
    u32 imageSize = rd32(opt + 56);
    u32 headersSize = rd32(opt + 60);
    u32 importRva = rd32(opt + (plus ? 112 : 96) + 8);

    u8 *image = (u8 *)mapFixed(base, (imageSize + 0xfff) & ~0xfffu);
    if ((word)image != base)
    {
        die("cannot map the image at its base", "");
    }
    for (u32 i = 0; i < headersSize; i++)
    {
        image[i] = file[i];
    }
    const u8 *section = opt + optionalSize;
    for (u32 s = 0; s < sections; s++, section += 40)
    {
        u32 va = rd32(section + 12), raw = rd32(section + 16), from = rd32(section + 20);
        for (u32 i = 0; i < raw; i++)
        {
            image[va + i] = file[from + i];
        }
    }
    for (const u8 *d = image + importRva; rd32(d + 12); d += 20)
    {
        u32 names = rd32(d) ? rd32(d) : rd32(d + 16);
        // A thunk is a pointer's width: the low half names the import by its hint and name.
        word *iat = (word *)(image + rd32(d + 16));
        for (const word *thunk = (const word *)(image + names); *thunk; thunk++, iat++)
        {
            const char *name = (const char *)(image + (u32)*thunk + 2);
            void *bound = 0;
            for (u32 b = 0; b < sizeof BINDINGS / sizeof *BINDINGS; b++)
            {
                if (same(BINDINGS[b].name, name))
                {
                    bound = BINDINGS[b].function;
                }
            }
            if (!bound)
            {
                die("no native binding for ", name);
            }
            *iat = (word)bound;
        }
    }

    // The command line the program asks for: its own name, then the arguments.
    char *o = commandLine;
    for (const char *s = "bench.exe"; *s;)
    {
        *o++ = *s++;
    }
    for (int a = 2; a < argc; a++)
    {
        *o++ = ' ';
        for (const char *s = argv[a]; *s;)
        {
            *o++ = *s++;
        }
    }
    *o = 0;

    started = now();
    // Called as Windows calls an entry point: under x64, with the home space its convention gives.
    ((void (STDCALL *)(void))(image + entry))();
    die("the entry point returned", "");
}

#if WIDE
__asm__(".globl _start\n"
        "_start:\n"
        "  mov (%rsp), %rdi\n"
        "  lea 8(%rsp), %rsi\n"
        "  and $-16, %rsp\n"
        "  call run\n"
        "  hlt\n");
#else
__asm__(".globl _start\n"
        "_start:\n"
        "  mov (%esp), %eax\n"
        "  lea 4(%esp), %ecx\n"
        "  and $-16, %esp\n"
        "  push %ecx\n"
        "  push %eax\n"
        "  call run\n"
        "  hlt\n");
#endif
