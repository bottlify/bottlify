/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/*
 * A class served out of process, and its client, in one program. Started
 * plainly it is the client: it registers itself as the class's LocalServer32,
 * asks for an instance, and calls it through the proxy it is handed. Started
 * with -Embedding, as COM starts a class's server, it registers its class
 * object, serves calls from its message loop, and leaves once the client has
 * let go of the last object it made.
 */

#include "rt.h"

typedef struct { unsigned a; unsigned short b, c; unsigned char d[8]; } GUID;

typedef struct Object Object;
typedef struct
{
    long(__stdcall *QueryInterface)(Object *self, const GUID *iid, void **out);
    unsigned(__stdcall *AddRef)(Object *self);
    unsigned(__stdcall *Release)(Object *self);
    /* The interface's own methods, each cast to its signature where it is called. */
    void *methods[4];
} Vtbl;
struct Object { const Vtbl *vtbl; };

typedef struct { void *window; unsigned message; unsigned wParam, lParam, time, x, y; } MSG;

__declspec(dllimport) char *__stdcall GetCommandLineA(void);
__declspec(dllimport) long __stdcall RegCreateKeyExA(void *key, const char *path, unsigned reserved,
    char *className, unsigned options, unsigned access, void *security, void **result,
    unsigned *disposition);
__declspec(dllimport) long __stdcall RegSetValueExA(void *key, const char *name, unsigned reserved,
    unsigned type, const void *data, unsigned size);
__declspec(dllimport) long __stdcall RegCloseKey(void *key);
__declspec(dllimport) long __stdcall CoInitialize(void *reserved);
__declspec(dllimport) void __stdcall CoUninitialize(void);
__declspec(dllimport) long __stdcall CoRegisterClassObject(const GUID *clsid, Object *factory,
    unsigned context, unsigned flags, unsigned *cookie);
__declspec(dllimport) long __stdcall CoRevokeClassObject(unsigned cookie);
__declspec(dllimport) long __stdcall CoCreateInstance(const GUID *clsid, Object *outer,
    unsigned context, const GUID *iid, void **out);
__declspec(dllimport) int __stdcall GetMessageA(MSG *message, void *window, unsigned first,
    unsigned last);
__declspec(dllimport) int __stdcall TranslateMessage(const MSG *message);
__declspec(dllimport) long __stdcall DispatchMessageA(const MSG *message);
__declspec(dllimport) void __stdcall PostQuitMessage(int code);

#define S_OK 0
#define E_NOINTERFACE ((long)0x80004002)
#define E_NOTIMPL ((long)0x80004001)
#define CLASS_E_NOAGGREGATION ((long)0x80040110)
#define CLSCTX_LOCAL_SERVER 4
#define REGCLS_MULTIPLEUSE 1
#define HKEY_CLASSES_ROOT ((void *)0x80000000)
#define KEY_WRITE 0x20006
#define REG_SZ 1
#define TYPE_INFO_COUNT 7

static const GUID CLSID_Served =
    { 0x6b2f0c1e, 0x3d4a, 0x4e8b, { 0x9a, 0x51, 0x2c, 0x7d, 0x10, 0xe3, 0x48, 0xb6 } };
static const GUID IID_IUnknown =
    { 0x00000000, 0, 0, { 0xc0, 0, 0, 0, 0, 0, 0, 0x46 } };
static const GUID IID_IClassFactory =
    { 0x00000001, 0, 0, { 0xc0, 0, 0, 0, 0, 0, 0, 0x46 } };
static const GUID IID_IDispatch =
    { 0x00020400, 0, 0, { 0xc0, 0, 0, 0, 0, 0, 0, 0x46 } };

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

/* The served object: an IDispatch whose one answer is its type info count. */
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
    if (--references == 0)
    {
        /* The client let go of the last one: nothing is left to serve. */
        PostQuitMessage(0);
    }
    return references;
}
static long __stdcall GetTypeInfoCount(Object *self, void *count)
{
    (void)self;
    *(unsigned *)count = TYPE_INFO_COUNT;
    return S_OK;
}
static const Vtbl objectVtbl = {
    ObjectQueryInterface, ObjectAddRef, ObjectRelease, { (void *)GetTypeInfoCount, 0, 0, 0 },
};
static Object object = { &objectVtbl };

/* Its class object, which lives as long as the server does. */
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
    if (outer)
    {
        return CLASS_E_NOAGGREGATION;
    }
    return ObjectQueryInterface(&object, (const GUID *)iid, (void **)out);
}
static long __stdcall LockServer(Object *self, void *lock)
{
    (void)self; (void)lock;
    return S_OK;
}
static const Vtbl factoryVtbl = {
    FactoryQueryInterface, FactoryAddRef, FactoryRelease,
    { (void *)CreateInstance, (void *)LockServer, 0, 0 },
};
static Object factory = { &factoryVtbl };

static int embedded(void)
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
    unsigned cookie = 0;
    CoInitialize(0);
    check("server: class object registered", CoRegisterClassObject(&CLSID_Served, &factory,
        CLSCTX_LOCAL_SERVER, REGCLS_MULTIPLEUSE, &cookie) == S_OK);
    MSG message;
    while (GetMessageA(&message, 0, 0, 0) > 0)
    {
        TranslateMessage(&message);
        DispatchMessageA(&message);
    }
    CoRevokeClassObject(cookie);
    CoUninitialize();
    return 0;
}

static int use(void)
{
    void *key;
    static const char server[] = "C:\\App\\com.exe";
    RegCreateKeyExA(HKEY_CLASSES_ROOT,
        "CLSID\\{6B2F0C1E-3D4A-4E8B-9A51-2C7D10E348B6}\\LocalServer32", 0, 0, 0, KEY_WRITE, 0,
        &key, 0);
    RegSetValueExA(key, 0, 0, REG_SZ, server, sizeof server);
    RegCloseKey(key);

    CoInitialize(0);
    Object *served = 0;
    check("client: an instance from the server it started", CoCreateInstance(&CLSID_Served, 0,
        CLSCTX_LOCAL_SERVER, &IID_IDispatch, (void **)&served) == S_OK && served);
    if (served)
    {
        unsigned count = 0;
        check("client: a call made in the server, its answer written back",
            ((long(__stdcall *)(Object *, unsigned *))served->vtbl->methods[0])(served, &count)
                == S_OK && count == TYPE_INFO_COUNT);
        served->vtbl->Release(served);
    }
    CoUninitialize();
    return failures;
}

int mainCRTStartup(void)
{
    ExitProcess(embedded() ? serve() : use());
    return 0;
}
