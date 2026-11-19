/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/*
 * An x86-64 program whose threads change the same memory at once through every
 * locked form a compiler or a runtime's own assembly writes: `lock xadd`, `lock
 * add`, `sub`, `inc`, `dec`, `and`, `or`, `xor`, `not`, `neg`, `bts` and `btr`
 * with an immediate, `lock cmpxchg` in a loop, `xchg` as a spin lock around a
 * plain increment, at a byte, a word, a dword and a quadword, and at a dword
 * and a word that lie across their own alignment inside one aligned quadword
 * (one across two is a split lock, not indivisible here: decision A274). Each
 * sum is what it is
 * only if no thread's change is lost: on several executors that is each form
 * made one indivisible access. Each check prints a line; the exit code counts
 * the checks that failed.
 */

typedef void *HANDLE;
typedef unsigned long DWORD;
typedef unsigned long long QWORD;
typedef struct { char opaque[48]; } FILE;
typedef DWORD (__stdcall *ThreadStart)(void *parameter);

__declspec(dllimport) extern FILE _iob[];
__declspec(dllimport) int __cdecl fputs(const char *text, FILE *stream);
__declspec(dllimport) void __cdecl exit(int code);
__declspec(dllimport) HANDLE __stdcall CreateThread(void *attributes, QWORD stack,
    ThreadStart start, void *parameter, DWORD flags, DWORD *id);
__declspec(dllimport) DWORD __stdcall WaitForMultipleObjects(DWORD count, const HANDLE *handles,
    int all, DWORD milliseconds);

#define THREADS 4
#define TURNS 60000

#pragma pack(push, 1)
static struct
{
    char pad;
    unsigned odd32;        /* at 1: across its own alignment, inside one quadword */
    unsigned short odd16;  /* at 5: likewise */
} crooked;
#pragma pack(pop)

static volatile unsigned char sum8;
static volatile unsigned short sum16;
static volatile unsigned sum32;
static volatile QWORD sum64;
static volatile unsigned swapped;
static volatile QWORD swapped64;
static volatile unsigned gate;
static unsigned guarded;
static volatile unsigned stepped;
static volatile QWORD stepped64;
static volatile unsigned bits;
static volatile unsigned flipped;
static volatile unsigned negated;
static volatile unsigned short under16;

static int failed;

static void check(int passed, const char *what)
{
    fputs(passed ? "ok " : "FAILED ", &_iob[1]);
    fputs(what, &_iob[1]);
    fputs("\n", &_iob[1]);
    failed += !passed;
}

static DWORD __stdcall hammer(void *parameter)
{
    unsigned mine = 1u << (unsigned)(QWORD)parameter;
    for (int turn = 0; turn < TURNS; turn++)
    {
        __sync_fetch_and_add(&sum8, 1);
        __sync_fetch_and_add(&sum16, 1);
        __sync_fetch_and_add(&sum32, 1);
        __sync_fetch_and_add(&sum64, 0x100000001ull);
        __asm__ volatile("lock addl $1, %0" : "+m"(crooked.odd32));
        __asm__ volatile("lock addw $1, %0" : "+m"(crooked.odd16));
        for (;;)
        {
            unsigned seen = swapped;
            if (__sync_val_compare_and_swap(&swapped, seen, seen + 1) == seen)
            {
                break;
            }
        }
        for (;;)
        {
            QWORD seen = swapped64;
            if (__sync_val_compare_and_swap(&swapped64, seen, seen + 0x100000001ull) == seen)
            {
                break;
            }
        }
        while (__sync_lock_test_and_set(&gate, 1) != 0)
        {
            __asm__ volatile("pause");
        }
        guarded++;
        __sync_lock_release(&gate);
        __asm__ volatile("lock incl %0" : "+m"(stepped));
        __asm__ volatile("lock incq %0" : "+m"(stepped64));
        __asm__ volatile("lock incq %0" : "+m"(stepped64));
        __asm__ volatile("lock decq %0" : "+m"(stepped64));
        __asm__ volatile("lock subw $1, %0" : "+m"(under16));
        /* Its own bit set and cleared, by `or` / `and`, by `bts` / `btr`, by `xor` twice. */
        __asm__ volatile("lock orl %1, %0" : "+m"(bits) : "r"(mine));
        __asm__ volatile("lock andl %1, %0" : "+m"(bits) : "r"(~mine));
        __asm__ volatile("lock btsl $9, %0" : "+m"(bits));
        __asm__ volatile("lock xorl %1, %0" : "+m"(bits) : "r"(mine << 16));
        __asm__ volatile("lock xorl %1, %0" : "+m"(bits) : "r"(mine << 16));
        /* An even count of each over all threads leaves what was there. */
        __asm__ volatile("lock notl %0" : "+m"(flipped));
        __asm__ volatile("lock notl %0" : "+m"(flipped));
        __asm__ volatile("lock negl %0" : "+m"(negated));
        __asm__ volatile("lock negl %0" : "+m"(negated));
    }
    return 0;
}

void mainCRTStartup(void)
{
    HANDLE threads[THREADS];
    QWORD all = (QWORD)THREADS * TURNS;
    flipped = 0x5a5a1234;
    negated = 77;
    for (QWORD i = 0; i < THREADS; i++)
    {
        threads[i] = CreateThread(0, 0, hammer, (void *)i, 0, 0);
    }
    WaitForMultipleObjects(THREADS, threads, 1, 0xffffffff);
    check(sum8 == (unsigned char)all, "lock xadd at a byte");
    check(sum16 == (unsigned short)all, "lock xadd at a word");
    check(sum32 == all, "lock xadd at a dword");
    check(sum64 == all * 0x100000001ull, "lock xadd at a quadword");
    check(crooked.odd32 == all, "a dword across its alignment");
    check(crooked.odd16 == (unsigned short)all, "a word across its alignment");
    check(swapped == all, "lock cmpxchg at a dword");
    check(swapped64 == all * 0x100000001ull, "lock cmpxchg at a quadword");
    check(guarded == all, "xchg as a spin lock");
    check(stepped == all, "lock inc at a dword");
    check(stepped64 == all, "lock inc and dec at a quadword");
    check(under16 == (unsigned short)(0 - all), "lock sub at a word");
    check(bits == 1u << 9, "lock or, and, bts and xor");
    check(flipped == 0x5a5a1234, "lock not");
    check(negated == 77, "lock neg");
    fputs(failed ? "failed\n" : "failed 0\n", &_iob[1]);
    exit(failed);
}
