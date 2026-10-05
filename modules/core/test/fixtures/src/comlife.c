/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/*
 * A server's life between processes, and what its calls see. Started plainly
 * it is the client; started with -Embedding, as COM starts a class's server,
 * it is the server, which waits in CoWaitForMultipleHandles -- the wait that
 * goes on serving its apartment -- rather than in a message loop of its own,
 * counts itself with CoAddRefServerProcess, and leaves when the release that
 * brings that count to zero sets its event.
 *
 * The served object is an IDispatch whose GetTypeInfoCount answers what the
 * server saw: on the first call, inside it, the call context and the client's
 * security; on the second, whether it could disconnect itself. A third call
 * through the same proxy then finds the object gone.
 */

#include "rt.h"

typedef struct { unsigned a; unsigned short b, c; unsigned char d[8]; } GUID;

typedef struct Object Object;
typedef struct
{
    long(__stdcall *QueryInterface)(Object *self, const GUID *iid, void **out);
    unsigned(__stdcall *AddRef)(Object *self);
    unsigned(__stdcall *Release)(Object *self);
    void *methods[8];
} Vtbl;
struct Object { const Vtbl *vtbl; };

__declspec(dllimport) char *__stdcall GetCommandLineA(void);
__declspec(dllimport) void *__stdcall CreateEventA(void *security, int manual, int initial,
    const char *name);
__declspec(dllimport) int __stdcall SetEvent(void *event);
__declspec(dllimport) unsigned __stdcall GetCurrentThreadId(void);
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
__declspec(dllimport) long __stdcall CoGetCallContext(const GUID *iid, void **out);
__declspec(dllimport) long __stdcall CoImpersonateClient(void);
__declspec(dllimport) long __stdcall CoRevertToSelf(void);
__declspec(dllimport) long __stdcall CoQueryClientBlanket(unsigned *authn, unsigned *authz,
    void *principal, unsigned *level, unsigned *impersonation, void *privileges,
    unsigned *capabilities);
__declspec(dllimport) long __stdcall CoQueryProxyBlanket(Object *proxy, unsigned *authn,
    unsigned *authz, void *principal, unsigned *level, unsigned *impersonation, void *identity,
    unsigned *capabilities);
__declspec(dllimport) long __stdcall CoCopyProxy(Object *proxy, Object **copy);
__declspec(dllimport) long __stdcall CoDisconnectObject(Object *object, unsigned reserved);
__declspec(dllimport) unsigned __stdcall CoAddRefServerProcess(void);
__declspec(dllimport) unsigned __stdcall CoReleaseServerProcess(void);
__declspec(dllimport) unsigned __stdcall CoGetCurrentProcess(void);
__declspec(dllimport) long __stdcall CoWaitForMultipleHandles(unsigned flags, unsigned timeout,
    unsigned count, void **handles, unsigned *index);
__declspec(dllimport) long __stdcall CoMarshalHresult(Object *stream, long hresult);
__declspec(dllimport) long __stdcall CoUnmarshalHresult(Object *stream, long *hresult);
__declspec(dllimport) long __stdcall CreateStreamOnHGlobal(void *global, int release,
    Object **stream);
__declspec(dllimport) int __stdcall PostThreadMessageA(unsigned thread, unsigned message,
    unsigned wParam, unsigned lParam);
typedef struct { void *window; unsigned message; unsigned wParam, lParam, time, x, y; } MSG;
__declspec(dllimport) int __stdcall PeekMessageA(MSG *message, void *window, unsigned first,
    unsigned last, unsigned remove);

#define S_OK 0
#define E_INVALIDARG ((long)0x80070057)
#define E_NOINTERFACE ((long)0x80004002)
#define CLASS_E_NOAGGREGATION ((long)0x80040110)
#define RPC_E_CALL_COMPLETE ((long)0x80010117)
#define RPC_E_DISCONNECTED ((long)0x80010108)
#define RPC_E_NO_SYNC ((long)0x80010120)
#define RPC_S_CALLPENDING ((long)0x80010115)
#define CLSCTX_LOCAL_SERVER 4
#define REGCLS_MULTIPLEUSE 1
#define HKEY_CLASSES_ROOT ((void *)0x80000000)
#define KEY_WRITE 0x20006
#define REG_SZ 1
#define RPC_C_AUTHN_WINNT 10
#define WM_USER 0x400
#define PM_REMOVE 1

static const GUID CLSID_Served =
    { 0x3c1d5a2e, 0x7b44, 0x4f0a, { 0x8e, 0x21, 0x5d, 0x90, 0x6b, 0x13, 0x27, 0xc4 } };
static const GUID IID_IUnknown =
    { 0x00000000, 0, 0, { 0xc0, 0, 0, 0, 0, 0, 0, 0x46 } };
static const GUID IID_IClassFactory =
    { 0x00000001, 0, 0, { 0xc0, 0, 0, 0, 0, 0, 0, 0x46 } };
static const GUID IID_IDispatch =
    { 0x00020400, 0, 0, { 0xc0, 0, 0, 0, 0, 0, 0, 0x46 } };
static const GUID IID_IServerSecurity =
    { 0x0000013e, 0, 0, { 0xc0, 0, 0, 0, 0, 0, 0, 0x46 } };

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

/* What the served object's calls saw, a bit each. */
#define SAW_CONTEXT 1
#define SAW_IMPERSONATE 2
#define SAW_REVERT 4
#define SAW_BLANKET 8
#define SAW_SEQUENCE 16
#define SAW_ALL 31

static void *done;
static unsigned references;
static unsigned calls;

static Object object;

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
    if (--references == 0 && CoReleaseServerProcess() == 0)
    {
        SetEvent(done);
    }
    return references;
}
static long __stdcall GetTypeInfoCount(Object *self, unsigned *answer)
{
    calls++;
    if (calls == 1)
    {
        unsigned saw = 0;
        Object *context = 0;
        if (CoGetCallContext(&IID_IServerSecurity, (void **)&context) == S_OK && context)
        {
            saw |= SAW_CONTEXT;
            context->vtbl->Release(context);
        }
        saw |= CoImpersonateClient() == S_OK ? SAW_IMPERSONATE : 0;
        saw |= CoRevertToSelf() == S_OK ? SAW_REVERT : 0;
        unsigned authn = 0;
        saw |= CoQueryClientBlanket(&authn, 0, 0, 0, 0, 0, 0) == S_OK
            && authn == RPC_C_AUTHN_WINNT ? SAW_BLANKET : 0;
        saw |= CoGetCurrentProcess() != 0 ? SAW_SEQUENCE : 0;
        *answer = saw;
        return S_OK;
    }
    /* Every other process's hold goes, and with it the object. */
    *answer = CoDisconnectObject(self, 0) == S_OK;
    return S_OK;
}
static const Vtbl objectVtbl = {
    ObjectQueryInterface, ObjectAddRef, ObjectRelease, { (void *)GetTypeInfoCount },
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
    if (outer)
    {
        return CLASS_E_NOAGGREGATION;
    }
    CoAddRefServerProcess();
    return ObjectQueryInterface(&object, (const GUID *)iid, (void **)out);
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
    unsigned cookie = 0, index = 0;
    done = CreateEventA(0, 1, 0, 0);
    CoInitialize(0);
    check("server: class object registered", CoRegisterClassObject(&CLSID_Served, &factory,
        CLSCTX_LOCAL_SERVER, REGCLS_MULTIPLEUSE, &cookie) == S_OK);
    /* Its client's calls are served while it waits, from the wait itself. */
    long waited = CoWaitForMultipleHandles(0, 0xffffffff, 1, &done, &index);
    check("server: the wait ended on its event once the last object went",
        waited == S_OK && index == 0);
    CoRevokeClassObject(cookie);
    CoUninitialize();
    return 0;
}

static int use(void)
{
    void *key;
    static const char server[] = "C:\\App\\comlife.exe";
    RegCreateKeyExA(HKEY_CLASSES_ROOT,
        "CLSID\\{3C1D5A2E-7B44-4F0A-8E21-5D906B1327C4}\\LocalServer32", 0, 0, 0, KEY_WRITE, 0,
        &key, 0);
    RegSetValueExA(key, 0, 0, REG_SZ, server, sizeof server);
    RegCloseKey(key);

    CoInitialize(0);
    Object *context = 0;
    check("client: outside a call there is no call context",
        CoGetCallContext(&IID_IServerSecurity, (void **)&context) == RPC_E_CALL_COMPLETE
            && !context);
    check("client: nor a client to impersonate", CoImpersonateClient() == RPC_E_CALL_COMPLETE);

    Object *stream = 0;
    long carried = 0;
    if (CreateStreamOnHGlobal(0, 1, &stream) == S_OK && stream)
    {
        long wrote = CoMarshalHresult(stream, RPC_E_DISCONNECTED);
        unsigned long long zero = 0;
        ((long(__stdcall *)(Object *, unsigned long long, unsigned, void *))
            stream->vtbl->methods[2])(stream, zero, 0, 0);
        check("client: an HRESULT through a stream comes back as it went",
            wrote == S_OK && CoUnmarshalHresult(stream, &carried) == S_OK
                && carried == RPC_E_DISCONNECTED);
        stream->vtbl->Release(stream);
    }

    void *events[2] = { CreateEventA(0, 1, 0, 0), CreateEventA(0, 1, 1, 0) };
    unsigned index = 7;
    check("client: a wait with nowhere to say which is refused",
        CoWaitForMultipleHandles(0, 50, 1, events, 0) == E_INVALIDARG);
    check("client: a wait on nothing has nothing to wait for",
        CoWaitForMultipleHandles(0, 50, 0, events, &index) == RPC_E_NO_SYNC && index == 0);
    MSG message;
    PostThreadMessageA(GetCurrentThreadId(), WM_USER, 0, 0);
    check("client: a signalled handle answers with its index, the message left waiting",
        CoWaitForMultipleHandles(0, 50, 2, events, &index) == S_OK && index == 1
            && PeekMessageA(&message, 0, WM_USER, WM_USER, PM_REMOVE));
    PostThreadMessageA(GetCurrentThreadId(), WM_USER, 0, 0);
    check("client: a wait that times out is pending, its messages dispatched meanwhile",
        CoWaitForMultipleHandles(0, 50, 1, events, &index) == RPC_S_CALLPENDING
            && !PeekMessageA(&message, 0, WM_USER, WM_USER, PM_REMOVE));

    Object *served = 0;
    check("client: an instance from the server it started", CoCreateInstance(&CLSID_Served, 0,
        CLSCTX_LOCAL_SERVER, &IID_IDispatch, (void **)&served) == S_OK && served);
    if (served)
    {
        unsigned authn = 0;
        check("client: the proxy says how it authenticates",
            CoQueryProxyBlanket(served, &authn, 0, 0, 0, 0, 0, 0) == S_OK
                && authn == RPC_C_AUTHN_WINNT);
        check("client: an object of its own is no proxy",
            CoQueryProxyBlanket(&factory, &authn, 0, 0, 0, 0, 0, 0) == E_NOINTERFACE);
        Object *copy = 0;
        if (CoCopyProxy(served, &copy) == S_OK && copy)
        {
            check("client: a copy of the proxy", 1);
            copy->vtbl->Release(copy);
        }
        else
        {
            check("client: a copy of the proxy", 0);
        }
        long (__stdcall *count)(Object *, unsigned *) =
            (long(__stdcall *)(Object *, unsigned *))served->vtbl->methods[0];
        unsigned saw = 0;
        check("client: inside the call the server saw its context and its client",
            count(served, &saw) == S_OK && saw == SAW_ALL);
        unsigned disconnected = 0;
        check("client: the server disconnected the object",
            count(served, &disconnected) == S_OK && disconnected == 1);
        check("client: and the proxy finds it gone", count(served, &saw) == RPC_E_DISCONNECTED);
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
