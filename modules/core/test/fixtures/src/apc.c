/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/*
 * Asynchronous procedure calls: queued to a thread, run by it when it waits
 * alertably and never otherwise, from QueueUserAPC and from a waitable timer's
 * completion routine.
 */

#include "rt.h"

typedef void (__stdcall *apc_routine)(unsigned long);
typedef void (__stdcall *timer_routine)(void *, unsigned, unsigned);

__declspec(dllimport) unsigned __stdcall QueueUserAPC(apc_routine routine, void *thread,
    unsigned long data);
__declspec(dllimport) unsigned __stdcall SleepEx(unsigned ms, int alertable);
__declspec(dllimport) unsigned __stdcall WaitForSingleObjectEx(void *handle, unsigned ms,
    int alertable);
__declspec(dllimport) unsigned __stdcall WaitForSingleObject(void *handle, unsigned ms);
__declspec(dllimport) void *__stdcall CreateEventA(void *security, int manual, int initial,
    const char *name);
__declspec(dllimport) int __stdcall SetEvent(void *event);
__declspec(dllimport) void *__stdcall CreateWaitableTimerA(void *security, int manual,
    const char *name);
__declspec(dllimport) int __stdcall SetWaitableTimer(void *timer, const long long *due,
    long period, timer_routine routine, void *argument, int resume);
__declspec(dllimport) void *__stdcall CreateThread(void *security, unsigned stack,
    unsigned (__stdcall *start)(void *), void *parameter, unsigned flags, unsigned *id);
__declspec(dllimport) unsigned __stdcall GetCurrentThreadId(void);
__declspec(dllimport) void *__stdcall GetCurrentThread(void);
__declspec(dllimport) void __stdcall Sleep(unsigned ms);

#define WAIT_OBJECT_0 0
#define WAIT_IO_COMPLETION 0xc0
#define INFINITE 0xffffffff

static volatile unsigned ran = 0, ran_on = 0, sum = 0;

static void __stdcall count(unsigned long data)
{
    ran++;
    sum += data;
    ran_on = GetCurrentThreadId();
}

static void __stdcall chain(unsigned long data)
{
    ran++;
    QueueUserAPC(count, GetCurrentThread(), data + 1);
}

static volatile unsigned timer_ran = 0;
static void *volatile timer_argument = 0;
static void __stdcall on_timer(void *argument, unsigned low, unsigned high)
{
    timer_ran++;
    timer_argument = argument;
    (void)low;
    (void)high;
}

static volatile unsigned worker_id = 0, worker_answer = 0, worker_second = 0;
static void *go;

static unsigned __stdcall sleeper(void *unused)
{
    (void)unused;
    worker_id = GetCurrentThreadId();
    worker_answer = SleepEx(INFINITE, 1);
    return 0;
}

static unsigned __stdcall waiter(void *unused)
{
    (void)unused;
    /* Not alertable: an APC queued now waits for the next alertable wait. */
    worker_answer = WaitForSingleObject(go, INFINITE);
    worker_second = SleepEx(0, 1);
    return 0;
}

int mainCRTStartup(void)
{
    QueueUserAPC(count, GetCurrentThread(), 5);
    check("queuing does not run it", ran == 0);
    unsigned answer = SleepEx(0, 1);
    check("an alertable wait runs what is queued and says so",
        answer == WAIT_IO_COMPLETION && ran == 1 && sum == 5);
    check("a non-alertable one never does", (Sleep(0), ran == 1));

    ran = 0;
    QueueUserAPC(chain, GetCurrentThread(), 10);
    answer = SleepEx(INFINITE, 1);
    check("a routine queued by a routine runs in the same wait",
        answer == WAIT_IO_COMPLETION && ran == 2 && sum == 16);

    ran = 0;
    void *thread = CreateThread(0, 0, sleeper, 0, 0, 0);
    Sleep(10);
    QueueUserAPC(count, thread, 1);
    WaitForSingleObject(thread, INFINITE);
    check("an APC ends another thread's alertable sleep, and runs on that thread",
        worker_answer == WAIT_IO_COMPLETION && ran == 1 && ran_on == worker_id);

    ran = 0;
    go = CreateEventA(0, 1, 0, 0);
    thread = CreateThread(0, 0, waiter, 0, 0, 0);
    Sleep(10);
    QueueUserAPC(count, thread, 1);
    Sleep(10);
    check("an APC does not end a wait that is not alertable", ran == 0);
    SetEvent(go);
    WaitForSingleObject(thread, INFINITE);
    check("the wait ends on its object, and the APC runs at the next alertable one",
        worker_answer == WAIT_OBJECT_0 && worker_second == WAIT_IO_COMPLETION && ran == 1);

    void *timer = CreateWaitableTimerA(0, 0, 0);
    long long due = -100000; /* ten milliseconds from now */
    SetWaitableTimer(timer, &due, 0, on_timer, (void *)0x1234, 0);
    answer = SleepEx(INFINITE, 1);
    check("a timer's completion routine runs in the setting thread's alertable wait",
        answer == WAIT_IO_COMPLETION && timer_ran == 1 && timer_argument == (void *)0x1234);

    void *never = CreateEventA(0, 1, 0, 0);
    ran = 0;
    QueueUserAPC(count, GetCurrentThread(), 1);
    answer = WaitForSingleObjectEx(never, INFINITE, 1);
    check("WaitForSingleObjectEx takes one queued before it and does not block",
        answer == WAIT_IO_COMPLETION && ran == 1);

    ExitProcess(failures);
    return 0;
}
