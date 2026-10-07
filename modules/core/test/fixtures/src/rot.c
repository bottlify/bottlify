/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/*
 * The running object table between processes, as an installer's engine
 * uses it: the client makes the server's object with CoCreateInstance, which
 * starts the server (-Embedding); the server registers that object as its
 * class's active object and under a file moniker. The client then finds it
 * by class (GetActiveObject), by moniker (IRunningObjectTable::GetObject),
 * and by display name (MkParseDisplayName, CoGetObject), calling it each
 * time. Told to quit, the server revokes both and leaves, and the client
 * finds nothing of it running.
 */

#include "rt.h"

typedef struct { unsigned a; unsigned short b, c; unsigned char d[8]; } GUID;

typedef struct Object Object;
typedef struct
{
    long(__stdcall *QueryInterface)(Object *self, const GUID *iid, void **out);
    unsigned(__stdcall *AddRef)(Object *self);
    unsigned(__stdcall *Release)(Object *self);
    void *methods[24];
} Vtbl;
struct Object { const Vtbl *vtbl; };

__declspec(dllimport) char *__stdcall GetCommandLineA(void);
__declspec(dllimport) void *__stdcall CreateEventA(void *security, int manual, int initial,
    const char *name);
__declspec(dllimport) int __stdcall SetEvent(void *event);
__declspec(dllimport) void __stdcall Sleep(unsigned milliseconds);
__declspec(dllimport) long __stdcall RegCreateKeyExA(void *key, const char *path, unsigned reserved,
    char *className, unsigned options, unsigned access, void *security, void **result,
    unsigned *disposition);
__declspec(dllimport) long __stdcall RegSetValueExA(void *key, const char *name, unsigned reserved,
    unsigned type, const void *data, unsigned size);
__declspec(dllimport) long __stdcall RegCloseKey(void *key);
__declspec(dllimport) long __stdcall CoRegisterClassObject(const GUID *clsid, Object *factory,
    unsigned context, unsigned flags, unsigned *cookie);
__declspec(dllimport) long __stdcall CoRevokeClassObject(unsigned cookie);
__declspec(dllimport) long __stdcall CoCreateInstance(const GUID *clsid, Object *outer,
    unsigned context, const GUID *iid, void **out);
__declspec(dllimport) long __stdcall CoInitialize(void *reserved);
__declspec(dllimport) void __stdcall CoUninitialize(void);
__declspec(dllimport) long __stdcall CoWaitForMultipleHandles(unsigned flags, unsigned timeout,
    unsigned count, void **handles, unsigned *index);
__declspec(dllimport) long __stdcall GetRunningObjectTable(unsigned reserved, Object **table);
__declspec(dllimport) long __stdcall CreateFileMoniker(const unsigned short *path,
    Object **moniker);
__declspec(dllimport) long __stdcall CreateBindCtx(unsigned reserved, Object **context);
__declspec(dllimport) long __stdcall MkParseDisplayName(Object *context,
    const unsigned short *name, unsigned *eaten, Object **moniker);
__declspec(dllimport) long __stdcall CoGetObject(const unsigned short *name, void *options,
    const GUID *iid, void **out);
__declspec(dllimport) long __stdcall RegisterActiveObject(Object *object, const GUID *clsid,
    unsigned flags, unsigned *cookie);
__declspec(dllimport) long __stdcall RevokeActiveObject(unsigned cookie, void *reserved);
__declspec(dllimport) long __stdcall GetActiveObject(const GUID *clsid, void *reserved,
    Object **out);

#define S_OK 0
#define S_FALSE 1
#define E_NOINTERFACE ((long)0x80004002)
#define CLASS_E_NOAGGREGATION ((long)0x80040110)
#define CLSCTX_LOCAL_SERVER 4
#define REGCLS_MULTIPLEUSE 1
#define HKEY_CLASSES_ROOT ((void *)0x80000000)
#define KEY_WRITE 0x20006
#define REG_SZ 1
#define MK_E_UNAVAILABLE ((long)0x800401e3)
#define ACTIVEOBJECT_STRONG 0
#define INFINITE 0xffffffff
#define ANSWER 7

static const GUID CLSID_Running =
    { 0x5e0b7c41, 0x92a3, 0x4d6e, { 0xb1, 0x8f, 0x2c, 0x47, 0x60, 0x3d, 0x95, 0xa8 } };
static const GUID IID_IUnknown = { 0x00000000, 0, 0, { 0xc0, 0, 0, 0, 0, 0, 0, 0x46 } };
static const GUID IID_IClassFactory = { 0x00000001, 0, 0, { 0xc0, 0, 0, 0, 0, 0, 0, 0x46 } };
static const GUID IID_IDispatch = { 0x00020400, 0, 0, { 0xc0, 0, 0, 0, 0, 0, 0, 0x46 } };
static const unsigned short document[] =
    { 'C', ':', '\\', 'A', 'p', 'p', '\\', 'd', 'o', 'c', '.', 'r', 'o', 't', 0 };
static const unsigned short absent[] =
    { 'C', ':', '\\', 'A', 'p', 'p', '\\', 'n', 'o', 'n', 'e', '.', 'r', 'o', 't', 0 };

static int same(const GUID *a, const GUID *b)
{
    const unsigned char *x = (const unsigned char *)a, *y = (const unsigned char *)b;
    for (int i = 0; i < 16; i++)
    {
        if (x[i] != y[i])
        {
            return 0;
        }
    }
    return 1;
}

/* The served object: IDispatch's GetTypeInfoCount answers a number the client knows. */
static unsigned references;
static long __stdcall ObjectQueryInterface(Object *self, const GUID *iid, void **out)
{
    if (same(iid, &IID_IUnknown) || same(iid, &IID_IDispatch))
    {
        *out = self;
        references++;
        return S_OK;
    }
    *out = 0;
    return E_NOINTERFACE;
}
static unsigned __stdcall ObjectAddRef(Object *self)
{
    (void)self;
    return ++references;
}
static unsigned __stdcall ObjectRelease(Object *self)
{
    (void)self;
    return --references;
}
static long __stdcall GetTypeInfoCount(Object *self, unsigned *answer)
{
    (void)self;
    *answer = ANSWER;
    return S_OK;
}
/* IDispatch::GetIDsOfNames, asked for "Quit": the server leaves once it returns. */
static void *quit;
static long __stdcall GetIDsOfNames(Object *self, const GUID *iid, unsigned short **names,
    unsigned count, unsigned locale, long *ids)
{
    (void)self; (void)iid; (void)locale;
    for (unsigned i = 0; i < count; i++)
    {
        ids[i] = 1;
    }
    if (count == 1 && names[0][0] == 'Q')
    {
        SetEvent(quit);
    }
    return S_OK;
}
static const Vtbl objectVtbl = {
    ObjectQueryInterface, ObjectAddRef, ObjectRelease,
    { (void *)GetTypeInfoCount, 0, (void *)GetIDsOfNames },
};
static Object object = { &objectVtbl };

static long __stdcall FactoryQueryInterface(Object *self, const GUID *iid, void **out)
{
    if (same(iid, &IID_IUnknown) || same(iid, &IID_IClassFactory))
    {
        *out = self;
        return S_OK;
    }
    *out = 0;
    return E_NOINTERFACE;
}
static unsigned __stdcall FactoryAddRef(Object *self)
{
    (void)self;
    return 2;
}
static unsigned __stdcall FactoryRelease(Object *self)
{
    (void)self;
    return 1;
}
static long __stdcall CreateInstance(Object *self, void *outer, void *iid, void *out)
{
    (void)self;
    return outer ? CLASS_E_NOAGGREGATION
        : ObjectQueryInterface(&object, (const GUID *)iid, (void **)out);
}
static long __stdcall LockServer(Object *self, void *lock)
{
    (void)self; (void)lock;
    return S_OK;
}
static const Vtbl factoryVtbl = {
    FactoryQueryInterface, FactoryAddRef, FactoryRelease,
    { (void *)CreateInstance, (void *)LockServer },
};
static Object factory = { &factoryVtbl };

/* IRunningObjectTable's and IMoniker's methods, by slot. */
static long rotRegister(Object *table, Object *unknown, Object *moniker, unsigned *cookie)
{
    return ((long(__stdcall *)(Object *, unsigned, Object *, Object *, unsigned *))
        table->vtbl->methods[0])(table, 0, unknown, moniker, cookie);
}
static long rotRevoke(Object *table, unsigned cookie)
{
    return ((long(__stdcall *)(Object *, unsigned))table->vtbl->methods[1])(table, cookie);
}
static long rotIsRunning(Object *table, Object *moniker)
{
    return ((long(__stdcall *)(Object *, Object *))table->vtbl->methods[2])(table, moniker);
}
static long rotGetObject(Object *table, Object *moniker, Object **out)
{
    return ((long(__stdcall *)(Object *, Object *, Object **))table->vtbl->methods[3])(table,
        moniker, out);
}
static long monikerIsEqual(Object *moniker, Object *other)
{
    return ((long(__stdcall *)(Object *, Object *))moniker->vtbl->methods[10])(moniker, other);
}

/* Whether `unknown` is the served object, by a call that crosses to it. */
static int answers(Object *unknown)
{
    Object *dispatch = 0;
    unsigned count = 0;
    int ok = unknown && unknown->vtbl->QueryInterface(unknown, &IID_IDispatch,
        (void **)&dispatch) == S_OK && dispatch
        && ((long(__stdcall *)(Object *, unsigned *))dispatch->vtbl->methods[0])(dispatch,
            &count) == S_OK && count == ANSWER;
    if (dispatch)
    {
        dispatch->vtbl->Release(dispatch);
    }
    return ok;
}

static int serving(void)
{
    for (const char *at = GetCommandLineA(); *at; at++)
    {
        if (at[0] == '-' && at[1] == 'E' && at[2] == 'm' && at[3] == 'b' && at[4] == 'e'
            && at[5] == 'd')
        {
            return 1;
        }
    }
    return 0;
}

static int serve(void)
{
    quit = CreateEventA(0, 1, 0, 0);
    CoInitialize(0);
    unsigned classCookie = 0, active = 0, registered = 0, index = 0;
    Object *table = 0, *moniker = 0;
    check("server: class object registered", CoRegisterClassObject(&CLSID_Running, &factory,
        CLSCTX_LOCAL_SERVER, REGCLS_MULTIPLEUSE, &classCookie) == S_OK);
    check("server: registered as its class's active object",
        RegisterActiveObject(&object, &CLSID_Running, ACTIVEOBJECT_STRONG, &active) == S_OK
            && active != 0);
    check("server: and under a file moniker",
        GetRunningObjectTable(0, &table) == S_OK && CreateFileMoniker(document, &moniker) == S_OK
            && rotRegister(table, &object, moniker, &registered) == S_OK && registered != 0);
    /* Its client's calls are served while it waits, from the wait itself. */
    CoWaitForMultipleHandles(0, INFINITE, 1, &quit, &index);
    check("server: both revoked",
        rotRevoke(table, registered) == S_OK && RevokeActiveObject(active, 0) == S_OK);
    /* The client's last releases may still be on their way: served while they come. */
    void *never = CreateEventA(0, 1, 0, 0);
    for (int tries = 0; tries < 200 && references != 0; tries++)
    {
        CoWaitForMultipleHandles(0, 10, 1, &never, &index);
    }
    check("server: every count it handed out came back", references == 0);
    moniker->vtbl->Release(moniker);
    table->vtbl->Release(table);
    CoRevokeClassObject(classCookie);
    CoUninitialize();
    return 0;
}

static int use(void)
{
    void *key;
    static const char server[] = "C:\\App\\rot.exe";
    RegCreateKeyExA(HKEY_CLASSES_ROOT,
        "CLSID\\{5E0B7C41-92A3-4D6E-B18F-2C47603D95A8}\\LocalServer32", 0, 0, 0, KEY_WRITE, 0,
        &key, 0);
    RegSetValueExA(key, 0, 0, REG_SZ, server, sizeof server);
    RegCloseKey(key);
    CoInitialize(0);
    Object *made = 0;
    check("client: an instance from the server it started",
        CoCreateInstance(&CLSID_Running, 0, CLSCTX_LOCAL_SERVER, &IID_IDispatch, (void **)&made)
            == S_OK && answers(made));

    Object *found = 0;
    check("client: the active object of the class, from the other process",
        GetActiveObject(&CLSID_Running, 0, &found) == S_OK && answers(found));
    if (found)
    {
        found->vtbl->Release(found);
    }

    Object *table = 0, *moniker = 0, *other = 0;
    found = 0;
    check("client: the server's file moniker is running, and gives its object",
        GetRunningObjectTable(0, &table) == S_OK && CreateFileMoniker(document, &moniker) == S_OK
            && rotIsRunning(table, moniker) == S_OK
            && rotGetObject(table, moniker, &found) == S_OK && answers(found));
    if (found)
    {
        found->vtbl->Release(found);
    }
    check("client: a name nobody registered is not",
        CreateFileMoniker(absent, &other) == S_OK && rotIsRunning(table, other) == S_FALSE);
    if (other)
    {
        other->vtbl->Release(other);
        other = 0;
    }

    Object *context = 0;
    unsigned eaten = 0;
    check("client: the running name parses whole, as the same moniker",
        CreateBindCtx(0, &context) == S_OK
            && MkParseDisplayName(context, document, &eaten, &other) == S_OK && eaten == 14
            && other && monikerIsEqual(other, moniker) == S_OK);
    if (other)
    {
        other->vtbl->Release(other);
    }
    if (context)
    {
        context->vtbl->Release(context);
    }

    Object *bound = 0;
    check("client: CoGetObject binds the name to the running object",
        CoGetObject(document, 0, &IID_IDispatch, (void **)&bound) == S_OK && answers(bound));
    if (bound)
    {
        bound->vtbl->Release(bound);
    }

    static unsigned short quitName[] = { 'Q', 'u', 'i', 't', 0 };
    unsigned short *names[1] = { quitName };
    long id = 0;
    static const GUID IID_NULL = { 0 };
    check("client: told to quit", ((long(__stdcall *)(Object *, const GUID *, unsigned short **,
        unsigned, unsigned, long *))made->vtbl->methods[2])(made, &IID_NULL, names, 1, 0, &id)
            == S_OK && id == 1);
    made->vtbl->Release(made);
    /* The server revokes as it leaves, in its own time. */
    long gone = S_OK;
    for (int tries = 0; tries < 500 && gone != MK_E_UNAVAILABLE; tries++)
    {
        found = 0;
        gone = GetActiveObject(&CLSID_Running, 0, &found);
        if (found)
        {
            found->vtbl->Release(found);
        }
        Sleep(10);
    }
    check("client: once the server has gone, nothing of it is running",
        gone == MK_E_UNAVAILABLE && rotIsRunning(table, moniker) == S_FALSE);
    moniker->vtbl->Release(moniker);
    table->vtbl->Release(table);
    CoUninitialize();
    return 0;
}

int mainCRTStartup(void)
{
    if (serving())
    {
        serve();
    }
    else
    {
        use();
    }
    ExitProcess(failures);
    return 0;
}
