/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/*
 * An x86-64 program on what a 64-bit process is given at its own width: its
 * thread and process blocks through GS, the static thread-local storage and
 * TLS callback its own directory declares (IMAGE_TLS_DIRECTORY64, laid out
 * here as a C runtime's tlssup does), a second thread, a wait on an array of
 * handles, a routine the system calls back with an argument (the TLS callback
 * told of a thread's end), quadword answers in RAX, and the pointers in
 * localeconv's structure and CommandLineToArgvW's array, the interlocked
 * arithmetic kernel32 exports, its last error, thread-local slots and fibre
 * slots, pointer encoding, critical sections taken by three threads at once,
 * and the heaps three threads allocate from, fill, check and free at once.
 * Each check prints a line; the exit code counts the checks that failed.
 */

typedef void *HANDLE;
typedef unsigned long DWORD;
typedef unsigned short WCHAR;
typedef unsigned long long QWORD;
typedef struct { char opaque[48]; } FILE;
typedef DWORD (__stdcall *ThreadStart)(void *parameter);
typedef void (__stdcall *TlsCallback)(void *module, DWORD reason, void *reserved);

typedef struct
{
    QWORD StartAddressOfRawData;
    QWORD EndAddressOfRawData;
    QWORD AddressOfIndex;
    QWORD AddressOfCallBacks;
    DWORD SizeOfZeroFill;
    DWORD Characteristics;
} TlsDirectory;

typedef struct
{
    DWORD dwOSVersionInfoSize;
    DWORD dwMajorVersion;
    DWORD dwMinorVersion;
    DWORD dwBuildNumber;
    DWORD dwPlatformId;
    WCHAR szCSDVersion[128];
} OSVERSIONINFOW;

/* RTL_CRITICAL_SECTION at 64 bits: 40 bytes, the owner a quadword HANDLE. */
typedef struct
{
    void *DebugInfo;
    long LockCount;
    long RecursionCount;
    HANDLE OwningThread;
    HANDLE LockSemaphore;
    QWORD SpinCount;
} CRITICAL_SECTION;

struct lconv
{
    char *decimal_point;
    char *thousands_sep;
    char *grouping;
    char *int_curr_symbol;
    char *currency_symbol;
    char *mon_decimal_point;
    char *mon_thousands_sep;
    char *mon_grouping;
    char *positive_sign;
    char *negative_sign;
    char int_frac_digits;
    char frac_digits;
    char p_cs_precedes;
    char p_sep_by_space;
    char n_cs_precedes;
    char n_sep_by_space;
    char p_sign_posn;
    char n_sign_posn;
};

__declspec(dllimport) extern FILE _iob[];
__declspec(dllimport) int __cdecl fputs(const char *text, FILE *stream);
__declspec(dllimport) int __cdecl fputc(int character, FILE *stream);
__declspec(dllimport) void __cdecl exit(int code);
__declspec(dllimport) struct lconv *__cdecl localeconv(void);
__declspec(dllimport) QWORD __cdecl mbrtowc(WCHAR *unit, const char *text, QWORD count,
    int *state);
__declspec(dllimport) long long __cdecl _atoi64(const char *text);
__declspec(dllimport) HANDLE __stdcall CreateThread(void *attributes, QWORD stack,
    ThreadStart start, void *parameter, DWORD flags, DWORD *id);
__declspec(dllimport) HANDLE __stdcall CreateEventA(void *attributes, int manual, int initial,
    const char *name);
__declspec(dllimport) DWORD __stdcall WaitForMultipleObjects(DWORD count, const HANDLE *handles,
    int all, DWORD milliseconds);
__declspec(dllimport) int __stdcall CloseHandle(HANDLE handle);
__declspec(dllimport) DWORD __stdcall GetCurrentThreadId(void);
__declspec(dllimport) void *__stdcall GetModuleHandleA(const char *name);
__declspec(dllimport) DWORD __stdcall GetVersion(void);
__declspec(dllimport) DWORD __stdcall GetTickCount(void);
__declspec(dllimport) QWORD __stdcall GetTickCount64(void);
__declspec(dllimport) WCHAR *__stdcall GetCommandLineW(void);
__declspec(dllimport) WCHAR **__stdcall CommandLineToArgvW(const WCHAR *line, int *count);
__declspec(dllimport) long __stdcall RtlGetVersion(OSVERSIONINFOW *info);
__declspec(dllimport) void __stdcall SetLastError(DWORD code);
__declspec(dllimport) DWORD __stdcall GetLastError(void);
__declspec(dllimport) DWORD __stdcall TlsAlloc(void);
__declspec(dllimport) int __stdcall TlsFree(DWORD index);
__declspec(dllimport) void *__stdcall TlsGetValue(DWORD index);
__declspec(dllimport) int __stdcall TlsSetValue(DWORD index, void *value);
__declspec(dllimport) DWORD __stdcall FlsAlloc(void *callback);
__declspec(dllimport) int __stdcall FlsFree(DWORD index);
__declspec(dllimport) void *__stdcall FlsGetValue(DWORD index);
__declspec(dllimport) int __stdcall FlsSetValue(DWORD index, void *value);
__declspec(dllimport) void *__stdcall EncodePointer(void *pointer);
__declspec(dllimport) void *__stdcall DecodePointer(void *pointer);
__declspec(dllimport) void __stdcall Sleep(DWORD milliseconds);
__declspec(dllimport) DWORD __stdcall WaitForSingleObject(HANDLE handle, DWORD milliseconds);
__declspec(dllimport) void __stdcall InitializeCriticalSection(CRITICAL_SECTION *section);
__declspec(dllimport) void __stdcall EnterCriticalSection(CRITICAL_SECTION *section);
__declspec(dllimport) void __stdcall LeaveCriticalSection(CRITICAL_SECTION *section);
__declspec(dllimport) int __stdcall TryEnterCriticalSection(CRITICAL_SECTION *section);
__declspec(dllimport) void __stdcall DeleteCriticalSection(CRITICAL_SECTION *section);
__declspec(dllimport) HANDLE __stdcall GetProcessHeap(void);
__declspec(dllimport) void *__stdcall HeapAlloc(HANDLE heap, DWORD flags, QWORD bytes);
__declspec(dllimport) int __stdcall HeapFree(HANDLE heap, DWORD flags, void *block);
__declspec(dllimport) QWORD __stdcall HeapSize(HANDLE heap, DWORD flags, const void *block);
__declspec(dllimport) void *__stdcall HeapReAlloc(HANDLE heap, DWORD flags, void *block,
    QWORD bytes);
__declspec(dllimport) HANDLE __stdcall GlobalAlloc(unsigned flags, QWORD bytes);
__declspec(dllimport) HANDLE __stdcall GlobalFree(HANDLE block);
__declspec(dllimport) void *__cdecl malloc(QWORD bytes);
__declspec(dllimport) void *__cdecl calloc(QWORD count, QWORD bytes);
__declspec(dllimport) void *__cdecl realloc(void *block, QWORD bytes);
__declspec(dllimport) void __cdecl free(void *block);
__declspec(dllimport) QWORD __cdecl _msize(void *block);
__declspec(dllimport) long __stdcall InterlockedIncrement(volatile long *addend);
__declspec(dllimport) long __stdcall InterlockedDecrement(volatile long *addend);
__declspec(dllimport) long __stdcall InterlockedExchange(volatile long *target, long value);
__declspec(dllimport) long __stdcall InterlockedExchangeAdd(volatile long *addend, long value);
__declspec(dllimport) long __stdcall InterlockedCompareExchange(volatile long *destination,
    long exchange, long comparand);

/* The image's thread-local storage, declared as a C runtime's tlssup does. */
#pragma section(".tls", read, write)
#pragma section(".tls$ZZZ", read, write)
#pragma section(".CRT$XLA", read)
#pragma section(".CRT$XLB", read)
#pragma section(".CRT$XLZ", read)

static void __stdcall onThread(void *module, DWORD reason, void *reserved);

__declspec(allocate(".tls")) char _tls_start = 0;
__declspec(allocate(".tls$ZZZ")) char _tls_end = 0;
DWORD _tls_index;
__declspec(allocate(".CRT$XLA")) TlsCallback __xl_a = 0;
__declspec(allocate(".CRT$XLB")) TlsCallback __xl_b = onThread;
__declspec(allocate(".CRT$XLZ")) TlsCallback __xl_z = 0;
const TlsDirectory _tls_used = {
    (QWORD)&_tls_start, (QWORD)&_tls_end, (QWORD)&_tls_index, (QWORD)(&__xl_a + 1), 0, 0,
};

static __declspec(thread) int counter = 5;

static volatile int told[4];
static volatile int toldModule = 1;
static volatile QWORD toldReserved[4];
static int failed;

static void __stdcall onThread(void *module, DWORD reason, void *reserved)
{
    if (reason < 4)
    {
        told[reason]++;
        toldReserved[reason] = (QWORD)reserved;
    }
    toldModule &= module == GetModuleHandleA(0);
}

static QWORD gs(DWORD offset)
{
    QWORD value;
    __asm__ volatile ("movq %%gs:(%1), %0" : "=r"(value) : "r"((QWORD)offset));
    return value;
}

static void say(const char *text)
{
    fputs(text, &_iob[1]);
}

static void number(unsigned long long value)
{
    char digits[24];
    int count = 0;
    do
    {
        digits[count++] = (char)('0' + value % 10);
        value /= 10;
    } while (value != 0);
    while (count != 0)
    {
        fputc(digits[--count], &_iob[1]);
    }
}

static void check(const char *what, int good)
{
    say(good ? "ok " : "FAILED ");
    say(what);
    fputc('\n', &_iob[1]);
    failed += !good;
}

/* Whether a thread's variable lies in the block its slot names. */
static int inSlot(void)
{
    QWORD block = ((QWORD *)gs(0x58))[_tls_index];
    return block != 0 && (QWORD)&counter >= block && (QWORD)&counter < block + 64;
}

/* What the second thread saw of itself, checked on the first. */
static struct
{
    void *parameter;
    int counter;
    QWORD block;
    QWORD variable;
    int idInBlock;
    int slotIsCounter;
} worker;

static DWORD __stdcall work(void *parameter)
{
    worker.parameter = parameter;
    worker.counter = counter;
    counter += 100;
    worker.block = gs(0x30);
    worker.variable = (QWORD)&counter;
    worker.idInBlock = gs(0x48) == GetCurrentThreadId()
        && *(QWORD *)(worker.block + 0x30) == worker.block;
    worker.slotIsCounter = inSlot();
    return 7;
}

static CRITICAL_SECTION section;
static volatile long total;
static volatile int tried = -1;

/* Each turn reads the total, gives the processor away while it holds the
   section, and writes the total plus one: a turn another thread got into
   between the two is a count lost. */
static DWORD __stdcall contend(void *parameter)
{
    for (int i = 0; i < 300; i++)
    {
        EnterCriticalSection(&section);
        EnterCriticalSection(&section);
        long seen = total;
        if (i % 3 == 0)
        {
            Sleep(0);
        }
        total = seen + 1;
        LeaveCriticalSection(&section);
        LeaveCriticalSection(&section);
    }
    return (DWORD)(QWORD)parameter;
}

static DWORD __stdcall attempt(void *parameter)
{
    tried = TryEnterCriticalSection(&section);
    if (tried)
    {
        LeaveCriticalSection(&section);
    }
    return 0;
}

static void sections(void)
{
    InitializeCriticalSection(&section);
    EnterCriticalSection(&section);
    EnterCriticalSection(&section);
    check("an entered section names its owner in a quadword, the recursion counted",
        section.OwningThread == (HANDLE)(QWORD)GetCurrentThreadId()
        && section.RecursionCount == 2);
    HANDLE thread = CreateThread(0, 0, attempt, 0, 0, 0);
    WaitForSingleObject(thread, 0xffffffff);
    CloseHandle(thread);
    check("another thread's try finds it held", tried == 0);
    check("and the owner's own try takes it again", TryEnterCriticalSection(&section)
        && section.RecursionCount == 3);
    LeaveCriticalSection(&section);
    LeaveCriticalSection(&section);
    LeaveCriticalSection(&section);
    check("left as often as entered, it is free", section.OwningThread == 0
        && section.RecursionCount == 0 && section.LockCount == -1);
    thread = CreateThread(0, 0, attempt, 0, 0, 0);
    WaitForSingleObject(thread, 0xffffffff);
    CloseHandle(thread);
    check("and another thread's try takes it", tried == 1 && section.LockCount == -1);

    HANDLE threads[2];
    threads[0] = CreateThread(0, 0, contend, (void *)1, 0, 0);
    threads[1] = CreateThread(0, 0, contend, (void *)2, 0, 0);
    contend(0);
    WaitForMultipleObjects(2, threads, 1, 0xffffffff);
    CloseHandle(threads[0]);
    CloseHandle(threads[1]);
    check("three threads taking one section lose no count", total == 900);
    check("and leave it free", section.OwningThread == 0 && section.RecursionCount == 0
        && section.LockCount == -1);
    DeleteCriticalSection(&section);
}

#define HEAP_ZERO_MEMORY 0x8
#define GMEM_ZEROINIT 0x40
#define SLOTS 64

/* What one thread found wrong, a bit for each kind of check. */
static volatile int heapWrong[3];

/* A thread's blocks, each filled with a byte of its own: a block that
   another one overlaps, or that a free or a resize lost, shows as a byte
   that is not its fill. Each turn frees or resizes or allocates, by one of
   the families at random. */
static DWORD __stdcall churn(void *parameter)
{
    int me = (int)(QWORD)parameter;
    HANDLE heap = GetProcessHeap();
    unsigned char *blocks[SLOTS] = { 0 };
    QWORD sizes[SLOTS] = { 0 };
    char kinds[SLOTS] = { 0 };
    unsigned state = 0x9e3779b9u * (unsigned)(me + 1);
    int wrong = 0;
    for (int turn = 0; turn < 3000; turn++)
    {
        state = state * 1103515245u + 12345u;
        int slot = (state >> 8) % SLOTS;
        unsigned char fill = (unsigned char)(me * 64 + slot + 1);
        unsigned char *block = blocks[slot];
        if (block)
        {
            for (QWORD i = 0; i < sizes[slot]; i++)
            {
                if (block[i] != fill)
                {
                    wrong |= 1;
                    break;
                }
            }
            QWORD size = kinds[slot] == 'h' ? HeapSize(heap, 0, block)
                : kinds[slot] == 'm' ? _msize(block) : sizes[slot];
            if (size != sizes[slot])
            {
                wrong |= 2;
            }
            if ((state >> 20) % 4 == 0 && kinds[slot] != 'g')
            {
                QWORD grown = (state >> 4) % 300;
                unsigned char *moved = kinds[slot] == 'h'
                    ? HeapReAlloc(heap, HEAP_ZERO_MEMORY, block, grown) : realloc(block, grown);
                if (grown != 0 && moved == 0)
                {
                    wrong |= 4;
                    continue;
                }
                if (kinds[slot] == 'h')
                {
                    for (QWORD i = sizes[slot]; i < grown; i++)
                    {
                        if (moved[i] != 0)
                        {
                            wrong |= 8;
                            break;
                        }
                    }
                }
                for (QWORD i = 0; i < grown; i++)
                {
                    moved[i] = fill;
                }
                blocks[slot] = grown == 0 && kinds[slot] != 'h' ? 0 : moved;
                sizes[slot] = grown;
                continue;
            }
            if (kinds[slot] == 'h')
            {
                wrong |= HeapFree(heap, 0, block) ? 0 : 16;
            }
            else if (kinds[slot] == 'g')
            {
                wrong |= GlobalFree(block) == 0 ? 0 : 16;
            }
            else
            {
                free(block);
            }
            blocks[slot] = 0;
            continue;
        }
        QWORD size = (state >> 12) % ((state >> 28) % 8 == 0 ? 3000 : 200);
        int kind = (state >> 24) % 4;
        int zero = (state >> 26) % 2;
        block = kind == 0 ? HeapAlloc(heap, zero ? HEAP_ZERO_MEMORY : 0, size)
            : kind == 1 ? (zero ? calloc(1, size) : malloc(size))
            : kind == 2 ? GlobalAlloc(zero ? GMEM_ZEROINIT : 0, size)
            : malloc(size);
        if (block == 0)
        {
            wrong |= 32;
            continue;
        }
        if (zero && kind != 3)
        {
            for (QWORD i = 0; i < size; i++)
            {
                if (block[i] != 0)
                {
                    wrong |= 64;
                    break;
                }
            }
        }
        for (QWORD i = 0; i < size; i++)
        {
            block[i] = fill;
        }
        blocks[slot] = block;
        sizes[slot] = size;
        kinds[slot] = kind == 0 ? 'h' : kind == 2 ? 'g' : 'm';
    }
    for (int slot = 0; slot < SLOTS; slot++)
    {
        if (blocks[slot] && kinds[slot] == 'h')
        {
            HeapFree(heap, 0, blocks[slot]);
        }
        else if (blocks[slot])
        {
            free(blocks[slot]);
        }
    }
    heapWrong[me] = wrong;
    return 0;
}

static void heaps(void)
{
    HANDLE heap = GetProcessHeap();
    check("GetProcessHeap answers the process block's heap at 0x30",
        heap != 0 && heap == *(HANDLE *)(gs(0x60) + 0x30));
    void *block = HeapAlloc(heap, 0, 20);
    check("a block of the process heap is sized as asked", block != 0
        && ((QWORD)block & 7) == 0 && HeapSize(heap, 0, block) == 20);
    check("grown in place within its cell", HeapReAlloc(heap, 0, block, 24) == block
        && HeapSize(heap, 0, block) == 24);
    check("freed", HeapFree(heap, 0, block) && HeapFree(heap, 0, 0));
    unsigned char *zeroed = calloc(5, 20);
    int clear = zeroed != 0 && _msize(zeroed) == 100;
    for (int i = 0; clear && i < 100; i++)
    {
        clear = zeroed[i] == 0;
    }
    check("calloc's block is zero and its size the product", clear);
    free(zeroed);
    free(0);

    HANDLE threads[2];
    threads[0] = CreateThread(0, 0, churn, (void *)1, 0, 0);
    threads[1] = CreateThread(0, 0, churn, (void *)2, 0, 0);
    churn(0);
    WaitForMultipleObjects(2, threads, 1, 0xffffffff);
    CloseHandle(threads[0]);
    CloseHandle(threads[1]);
    check("three threads allocating at once keep every block whole, sized and apart",
        heapWrong[0] == 0 && heapWrong[1] == 0 && heapWrong[2] == 0);
    if (heapWrong[0] | heapWrong[1] | heapWrong[2])
    {
        say("  wrong ");
        number((unsigned long long)(heapWrong[0] | heapWrong[1] << 8 | heapWrong[2] << 16));
        fputc('\n', &_iob[1]);
    }
}

void mainCRTStartup(void)
{
    check("the TLS callback heard the process start, with the module", told[1] == 1
        && toldModule && toldReserved[1] != 0);
    check("a thread-local variable starts as its template", counter == 5);
    counter = 42;

    QWORD teb = gs(0x30);
    QWORD peb = gs(0x60);
    QWORD local = 0;
    check("GS:[0x30] is the thread block's own address", teb != 0 && (teb >> 32) == 0
        && *(QWORD *)(teb + 0x30) == teb);
    check("GS:[0x48] is the thread's id", gs(0x48) == GetCurrentThreadId());
    check("the stack lies between GS:[0x10] and GS:[0x08]", gs(0x10) < (QWORD)&local
        && (QWORD)&local < gs(0x08));
    check("GS:[0x58][_tls_index] is this thread's copy", inSlot());
    check("the process block holds the image's base at 0x10",
        *(QWORD *)(peb + 0x10) == (QWORD)GetModuleHandleA(0));
    DWORD version = GetVersion();
    check("the process block holds the version at 0x118",
        *(DWORD *)(peb + 0x118) == (version & 0xff)
        && *(DWORD *)(peb + 0x11c) == (version >> 8 & 0xff));
    OSVERSIONINFOW info;
    info.dwOSVersionInfoSize = sizeof info;
    check("RtlGetVersion reads the version out of the 64-bit process block",
        RtlGetVersion(&info) == 0 && info.dwMajorVersion == (version & 0xff)
        && info.dwPlatformId == 2);

    HANDLE never = CreateEventA(0, 1, 0, 0);
    DWORD id = 0;
    HANDLE thread = CreateThread(0, 0, work, (void *)0x1234, 0, &id);
    HANDLE both[2] = { never, thread };
    check("a wait on two quadword handles answers the second's index",
        WaitForMultipleObjects(2, both, 0, 0xffffffff) == 1);
    check("the thread had its parameter", worker.parameter == (void *)0x1234);
    check("and its own copy of the thread-local variable, as the template has it",
        worker.counter == 5 && counter == 42);
    check("its block through GS is its own", worker.block != 0 && worker.block != teb
        && worker.idInBlock && worker.slotIsCounter && worker.variable != (QWORD)&counter);
    check("the TLS callback heard the thread start and end, with no reserved",
        told[2] == 1 && told[3] == 1 && toldReserved[2] == 0 && toldReserved[3] == 0);
    CloseHandle(thread);
    CloseHandle(never);

    check("a quadword answer is whole in RAX", _atoi64("4294967301") == 4294967301ll
        && _atoi64("-2") == -2);
    DWORD before = GetTickCount();
    QWORD ticks = GetTickCount64();
    check("GetTickCount64 counts the same milliseconds", (ticks >> 32) == 0
        && (DWORD)ticks >= before && (DWORD)ticks - before < 1000);

    struct lconv *conventions = localeconv();
    check("localeconv's strings are quadword pointers", conventions->decimal_point[0] == '.'
        && conventions->thousands_sep[0] == 0 && conventions->negative_sign[0] == 0
        && conventions->int_frac_digits == 127);

    WCHAR unit = 0;
    int state = 0;
    check("mbrtowc converts a byte", mbrtowc(&unit, "A", 1, &state) == 1 && unit == 'A'
        && mbrtowc(&unit, "", 1, &state) == 0
        && mbrtowc(&unit, "A", 0, &state) == (QWORD)-2);

    volatile long shared = 5;
    long seen = InterlockedIncrement(&shared);
    check("InterlockedIncrement answers the value after", seen == 6 && shared == 6);
    seen = InterlockedDecrement(&shared);
    check("InterlockedDecrement answers the value after", seen == 5 && shared == 5);
    seen = InterlockedExchange(&shared, 42);
    check("InterlockedExchange answers the value before", seen == 5 && shared == 42);
    seen = InterlockedExchangeAdd(&shared, -50);
    check("InterlockedExchangeAdd answers the value before", seen == 42 && shared == -8);
    seen = InterlockedCompareExchange(&shared, 7, -8);
    check("InterlockedCompareExchange exchanges where the comparand matches",
        seen == -8 && shared == 7);
    seen = InterlockedCompareExchange(&shared, 9, 1);
    check("and leaves the value where it does not", seen == 7 && shared == 7);

    SetLastError(1234);
    check("the last error set is the last error read", GetLastError() == 1234);
    /* Past the block's 64 slots an index is the host's: some of these are. A
       slot in the block keeps a quadword; the host is handed a pointer's low
       half, which is the whole of a pointer below 4 GiB. */
    DWORD indices[70];
    int kept = 1;
    for (int i = 0; i < 70; i++)
    {
        indices[i] = TlsAlloc();
    }
    for (int i = 0; i < 70; i++)
    {
        QWORD value = indices[i] < 64 ? 0x100000000ull + 0x10 * i : 0x10000ull + 0x10 * i;
        kept &= TlsSetValue(indices[i], (void *)value) != 0;
    }
    int read = 1, past = 1;
    for (int i = 0; i < 70; i++)
    {
        QWORD value = indices[i] < 64 ? 0x100000000ull + 0x10 * i : 0x10000ull + 0x10 * i;
        int same = TlsGetValue(indices[i]) == (void *)value;
        if (indices[i] < 64) read &= same; else past &= same;
    }
    check("a thread-local slot keeps its quadword", kept && read);
    check("past the block's array too, a pointer's", past && indices[69] >= 64);
    SetLastError(5);
    TlsGetValue(indices[0]);
    DWORD inBlock = GetLastError();
    SetLastError(5);
    TlsGetValue(indices[69]);
    check("and reading one clears the last error, in the block or past it",
        indices[0] < 64 && inBlock == 0 && GetLastError() == 0);
    for (int i = 0; i < 70; i++)
    {
        TlsFree(indices[i]);
    }

    DWORD fibre = FlsAlloc(0);
    check("a fibre slot keeps its quadword", FlsSetValue(fibre, (void *)0x123456789ull)
        && FlsGetValue(fibre) == (void *)0x123456789ull && FlsFree(fibre));
    check("an encoded pointer decodes whole", DecodePointer(EncodePointer(
        (void *)0x123456789abcull)) == (void *)0x123456789abcull);

    sections();
    heaps();

    int count = 0;
    WCHAR **args = CommandLineToArgvW(GetCommandLineW(), &count);
    check("CommandLineToArgvW's array holds quadword pointers", count == 3 && args[3] == 0
        && args[1][0] == 'o' && args[1][3] == 0 && args[2][0] == 't');

    say("failed ");
    number((unsigned long long)failed);
    fputc('\n', &_iob[1]);
    exit(failed);
}
