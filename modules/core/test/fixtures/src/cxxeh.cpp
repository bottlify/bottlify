/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/*
 * C++ exceptions as the compiler emits them against the system's C runtime:
 * frames handled by `__CxxFrameHandler3`, throws through `_CxxThrowException`,
 * destructors, catch by value and by reference, rethrow, a try inside a catch,
 * a throw out of a callback the runtime itself made, and two threads throwing
 * at once.
 */

#include "rt.h"

extern "C" {
__declspec(dllimport) void __cdecl qsort(void *base, unsigned count, unsigned size,
    int (__cdecl *compare)(const void *, const void *));
__declspec(dllimport) void *__stdcall CreateThread(void *security, unsigned stack,
    unsigned (__stdcall *start)(void *), void *parameter, unsigned flags, unsigned *id);
__declspec(dllimport) unsigned __stdcall WaitForSingleObject(void *handle, unsigned ms);
__declspec(dllimport) void __stdcall Sleep(unsigned ms);
}

static int live = 0, copies = 0;

struct Tracked
{
    int id;
    Tracked(int value) : id(value) { live++; }
    Tracked(const Tracked &other) : id(other.id) { live++; copies++; }
    ~Tracked() { live--; }
};

struct Base { int b; virtual ~Base() {} };
struct Other { int o; virtual ~Other() {} };
struct Derived : Other, Base { int d; };

static void thrower(int depth)
{
    Tracked local(depth);
    if (depth == 0)
    {
        throw Tracked(99);
    }
    thrower(depth - 1);
}

static int __cdecl compare(const void *a, const void *b)
{
    if (*(const int *)a == 3)
    {
        throw 77;
    }
    return *(const int *)a - *(const int *)b;
}

struct Guard
{
    int *count;
    Guard(int *where) : count(where) { ++*count; }
    ~Guard() { --*count; }
};

static int deep(int depth, int *alive)
{
    Guard guard(alive);
    if (depth == 0)
    {
        Sleep(0);
        throw depth + 1000;
    }
    return deep(depth - 1, alive) + 1;
}

static unsigned __stdcall worker(void *result)
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

    r = 0;
    int values[5] = { 5, 3, 1, 4, 2 };
    try { qsort(values, 5, 4, compare); } catch (int value) { r = value; }
    check("a throw out of a callback the runtime made", r == 77);

    r = 0;
    for (int i = 0; i < 200; i++)
    {
        try { throw i; } catch (int value) { r += value; }
    }
    check("two hundred throws in a row", r == 19900);

    int a = 0, b = 0;
    void *first = CreateThread(0, 0, worker, &a, 0, 0);
    void *second = CreateThread(0, 0, worker, &b, 0, 0);
    WaitForSingleObject(first, 0xffffffff);
    WaitForSingleObject(second, 0xffffffff);
    check("two threads throwing at once, each catching its own", a == 1 && b == 1);

    ExitProcess(failures);
    return 0;
}
