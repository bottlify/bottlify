/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/*
 * C++ exceptions in a 64-bit program, as the compiler lays them out for the
 * table-based unwinder: every function's frames described in `.pdata`, its
 * try blocks, objects and catch funclets in the tables its language handler
 * reads. Catch by value, by reference and as a second base, destructors run
 * as the stack unwinds, rethrow, a try inside a catch block, a throw out of a
 * catch block to the try around it, a throw out of a callback the system
 * made, two threads throwing at once, a catch (...) a structured exception
 * passes by, and frames whose language handler is guest code that hands them
 * on to the runtime's, as a /GS build's handler does.
 *
 * Built twice (`scripts/build-fixtures.mjs`): with the tables as the compiler
 * emits them, read by `__CxxFrameHandler3`, and with the same tables rewritten
 * into the compressed form `__CxxFrameHandler4` reads. FRAME_HANDLER names the
 * one the guest handler hands its frames on to.
 */

#include "rt.h"

#ifndef FRAME_HANDLER
#define FRAME_HANDLER __CxxFrameHandler3
#endif

extern "C" {
typedef unsigned long DWORD;
typedef DWORD (__stdcall *ThreadStart)(void *parameter);
__declspec(dllimport) int __stdcall EnumSystemLocalesA(int (__stdcall *found)(char *locale),
    DWORD flags);
__declspec(dllimport) void *__stdcall CreateThread(void *security, unsigned long long stack,
    ThreadStart start, void *parameter, DWORD flags, DWORD *id);
__declspec(dllimport) DWORD __stdcall WaitForSingleObject(void *handle, DWORD ms);
__declspec(dllimport) void __stdcall Sleep(DWORD ms);
__declspec(dllimport) void __stdcall RaiseException(DWORD code, DWORD flags, DWORD count,
    const unsigned long long *arguments);
__declspec(dllimport) int __cdecl FRAME_HANDLER(void *record, void *frame, void *context,
    void *dispatch);
unsigned long __cdecl _exception_code(void);
}

/* The vtable every type descriptor's first word points at and the marker that
 * says the program uses floating point, which the C runtime's static library
 * would have supplied; nothing reads either. */
extern "C" const void *type_info_vftable[2] __asm__("??_7type_info@@6B@");
const void *type_info_vftable[2] = { 0, 0 };
extern "C" int _fltused = 0;

static int live = 0, copies = 0;

struct Tracked
{
    int id;
    Tracked(int value) : id(value) { live++; }
    Tracked(const Tracked &other) : id(other.id) { live++; copies++; }
    ~Tracked() { live--; }
};

struct Base { int b; virtual ~Base() {} };
struct Other { long long o; virtual ~Other() {} };
struct Derived : Other, Base { int d; };

__declspec(noinline) static void thrower(int depth)
{
    Tracked local(depth);
    if (depth == 0)
    {
        throw Tracked(99);
    }
    thrower(depth - 1);
}

static int __stdcall locale_found(char *locale)
{
    if (locale[0] != 0)
    {
        throw 77;
    }
    return 1;
}

struct Guard
{
    int *count;
    Guard(int *where) : count(where) { ++*count; }
    ~Guard() { --*count; }
};

__declspec(noinline) static int deep(int depth, int *alive)
{
    Guard guard(alive);
    if (depth == 0)
    {
        Sleep(0);
        throw depth + 1000;
    }
    return deep(depth - 1, alive) + 1;
}

static DWORD __stdcall worker(void *result)
{
    int alive = 0, sum = 0;
    for (int i = 0; i < 150; i++)
    {
        try
        {
            deep(i % 7, &alive);
        }
        catch (int value)
        {
            sum += value;
        }
    }
    *(int *)result = alive == 0 && sum == 150000;
    return 0;
}

/* Rethrows what it caught to its caller, from a catch block of its own. */
__declspec(noinline) static void rethrower(int *seen)
{
    try
    {
        thrower(2);
    }
    catch (Tracked &caught)
    {
        *seen = caught.id;
        throw;
    }
}

/* A throw out of a catch block, caught by the try around it in the same
 * function, past an object the catch block made. */
__declspec(noinline) static int escape_catch(void)
{
    int r = 0;
    try
    {
        try
        {
            throw 1;
        }
        catch (int)
        {
            Tracked inside(5);
            throw 2;
        }
    }
    catch (int value)
    {
        r = value;
    }
    return r;
}

static void raise_structured(void)
{
    RaiseException(0xe0001234, 0, 0, 0);
}

/* A catch (...) in code built with /EHs takes no structured exception. */
__declspec(noinline) static int ellipsis_passes(void)
{
    int r = 0;
    try
    {
        raise_structured();
    }
    catch (...)
    {
        r = 1;
    }
    return r;
}

static int structured_seen(void)
{
    int r = 0;
    __try
    {
        r = ellipsis_passes();
    }
    __except (_exception_code() == 0xe0001234)
    {
        r = 2;
    }
    return r;
}

static int forwarded = 0;

/* A language handler of the program's own, which hands every frame on to the
 * runtime's, as /GS's __GSHandlerCheck_EH does after checking the cookie.
 * The build names it for every frame of `via_guest_handler`. */
extern "C" int __cdecl guest_language_handler(void *record, void *frame, void *context,
    void *dispatch)
{
    forwarded++;
    return FRAME_HANDLER(record, frame, context, dispatch);
}

__declspec(noinline) static int via_guest_handler(int depth)
{
    int r = 0;
    try
    {
        Tracked mine(depth);
        thrower(depth);
    }
    catch (Tracked &caught)
    {
        r = caught.id + (live == 1 ? 1 : 0);
        try
        {
            throw 5;
        }
        catch (int value)
        {
            r += value;
        }
    }
    return r;
}

extern "C" int mainCRTStartup()
{
    int r = 0;
    try { throw 42; } catch (int value) { r = value; }
    check("catch (int)", r == 42);

    r = 0;
    try
    {
        thrower(3);
    }
    catch (Tracked &caught)
    {
        r = caught.id;
        check("every local is destroyed before the catch block runs", live == 1);
    }
    check("catch by reference", r == 99);
    check("the thrown object is destroyed after the catch block", live == 0);

    r = 0;
    copies = 0;
    try { thrower(1); } catch (Tracked caught) { r = caught.id; }
    check("catch by value copies once", r == 99 && copies == 1 && live == 0);

    r = 0;
    try { throw 1.5; } catch (int) { r = 1; } catch (...) { r = 2; }
    check("catch (...) takes what nothing before it did", r == 2);

    r = 0;
    try
    {
        Derived derived;
        derived.b = 5;
        derived.d = 6;
        throw derived;
    }
    catch (Base &base)
    {
        r = base.b;
    }
    check("a derived object is caught as its second base", r == 5);

    r = 0;
    try
    {
        try { throw Tracked(7); } catch (Tracked &) { r = 1; throw; }
    }
    catch (Tracked &caught)
    {
        r += caught.id;
    }
    check("throw; reaches the enclosing catch", r == 8);
    check("and the object is destroyed once", live == 0);

    r = 0;
    int seen = 0;
    try { rethrower(&seen); } catch (Tracked &caught) { r = caught.id; }
    check("throw; from a callee's catch block reaches its caller", r == 99 && seen == 99);
    check("with every object destroyed once", live == 0);

    r = 0;
    try
    {
        throw 1;
    }
    catch (int)
    {
        try { throw 2; } catch (int value) { r = value; }
        r += 10;
    }
    check("a try inside a catch block", r == 12);

    check("a throw out of a catch block reaches the try around it", escape_catch() == 2);
    check("past the catch block's own object", live == 0);

    r = 0;
    try { EnumSystemLocalesA(locale_found, 2); } catch (int value) { r = value; }
    check("a throw out of a callback the system made", r == 77);

    r = 0;
    for (int i = 0; i < 200; i++)
    {
        try { throw i; } catch (int value) { r += value; }
    }
    check("two hundred throws in a row", r == 19900);

    check("a catch (...) lets a structured exception pass", structured_seen() == 2);

    forwarded = 0;
    r = via_guest_handler(2);
    check("frames whose handler is guest code catch and destroy",
        r == 99 + 1 + 5 && live == 0);
    check("and their handler was called", forwarded > 0);

    int a = 0, b = 0;
    void *first = CreateThread(0, 0, worker, &a, 0, 0);
    void *second = CreateThread(0, 0, worker, &b, 0, 0);
    WaitForSingleObject(first, 0xffffffff);
    WaitForSingleObject(second, 0xffffffff);
    check("two threads throwing at once, each catching its own", a == 1 && b == 1);

    ExitProcess(failures);
    return 0;
}
