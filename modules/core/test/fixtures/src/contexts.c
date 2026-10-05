/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/*
 * An apartment's context, as Wine's compobj tests find it on Windows: one
 * object per apartment answering as IObjContext, IComThreadingInfo and
 * IContextCallback; its token is its IObjContext pointer, handed out with no
 * count, so the apartment's own hold is not in what AddRef answers. The
 * multithreaded apartment's context is another, and a thread in no apartment
 * of its own while that one stands is in it. ContextCallback runs its
 * function in the context, a single-threaded apartment's on that apartment's
 * thread, which serves it while it waits.
 */

#include "rt.h"

typedef struct { unsigned a; unsigned short b, c; unsigned char d[8]; } GUID;

typedef struct Object Object;
typedef struct
{
    long(__stdcall *QueryInterface)(Object *self, const GUID *iid, void **out);
    unsigned(__stdcall *AddRef)(Object *self);
    unsigned(__stdcall *Release)(Object *self);
    void *methods[16];
} Vtbl;
struct Object { const Vtbl *vtbl; };

__declspec(dllimport) long __stdcall CoInitializeEx(void *reserved, unsigned model);
__declspec(dllimport) void __stdcall CoUninitialize(void);
__declspec(dllimport) long __stdcall CoGetObjectContext(const GUID *iid, void **out);
__declspec(dllimport) long __stdcall CoGetContextToken(unsigned *token);
__declspec(dllimport) long __stdcall CoGetDefaultContext(int type, const GUID *iid, void **out);
__declspec(dllimport) long __stdcall CoGetCurrentLogicalThreadId(GUID *id);
__declspec(dllimport) long __stdcall CoWaitForMultipleHandles(unsigned flags, unsigned timeout,
    unsigned count, void **handles, unsigned *index);
__declspec(dllimport) void *__stdcall CreateThread(void *security, unsigned stack,
    unsigned(__stdcall *start)(void *), void *argument, unsigned flags, unsigned *id);
__declspec(dllimport) unsigned __stdcall WaitForSingleObject(void *handle, unsigned timeout);
__declspec(dllimport) int __stdcall CloseHandle(void *handle);

#define S_OK 0
#define S_FALSE 1
#define E_POINTER ((long)0x80004003)
#define CO_E_NOTINITIALIZED ((long)0x800401f0)
#define COINIT_MULTITHREADED 0
#define COINIT_APARTMENTTHREADED 2
#define APTTYPE_MTA 1
#define APTTYPE_MAINSTA 3
#define THDTYPE_BLOCKMESSAGES 0
#define THDTYPE_PROCESSMESSAGES 1
#define INFINITE 0xffffffff

static const GUID IID_IObjContext = { 0x000001c6, 0, 0, { 0xc0, 0, 0, 0, 0, 0, 0, 0x46 } };
static const GUID IID_IComThreadingInfo = { 0x000001ce, 0, 0, { 0xc0, 0, 0, 0, 0, 0, 0, 0x46 } };
static const GUID IID_IContextCallback = { 0x000001da, 0, 0, { 0xc0, 0, 0, 0, 0, 0, 0, 0x46 } };
static const GUID GUID_NULL = { 0 };

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

/* IComThreadingInfo's and IContextCallback's methods, by slot. */
static long apartmentType(Object *info, int *type)
{
    return ((long(__stdcall *)(Object *, int *))info->vtbl->methods[0])(info, type);
}
static long threadType(Object *info, int *type)
{
    return ((long(__stdcall *)(Object *, int *))info->vtbl->methods[1])(info, type);
}
static long getLogical(Object *info, GUID *id)
{
    return ((long(__stdcall *)(Object *, GUID *))info->vtbl->methods[2])(info, id);
}
static long setLogical(Object *info, const GUID *id)
{
    return ((long(__stdcall *)(Object *, const GUID *))info->vtbl->methods[3])(info, id);
}
typedef long(__stdcall *Callback)(void *data);
static long contextCallback(Object *callback, Callback function, void *data)
{
    return ((long(__stdcall *)(Object *, Callback, void *, const GUID *, int, void *))
        callback->vtbl->methods[0])(callback, function, data, &IID_IContextCallback, 2, 0);
}

/* What a callback saw: the context it ran in and how often it ran. */
static unsigned seenToken;
static unsigned ran;
static long __stdcall callbackFunction(void *data)
{
    (void)data;
    CoGetContextToken(&seenToken);
    ran++;
    return S_FALSE;
}

static Object *mainCallback;
static unsigned mainToken;
static unsigned threadResult;

/* Another single-threaded apartment asks the main one's context to run a function. */
static unsigned __stdcall otherApartment(void *argument)
{
    (void)argument;
    CoInitializeEx(0, COINIT_APARTMENTTHREADED);
    unsigned own = 0;
    CoGetContextToken(&own);
    ran = 0;
    seenToken = 0;
    long hr = contextCallback(mainCallback, callbackFunction, 0);
    threadResult = hr == S_FALSE && ran == 1 && seenToken == mainToken && own != mainToken;
    CoUninitialize();
    return 0;
}

static unsigned mtaToken;
static unsigned implicitResult;

/* A thread in no apartment of its own while the multithreaded one stands. */
static unsigned __stdcall implicitThread(void *argument)
{
    (void)argument;
    unsigned token = 0;
    implicitResult = CoGetContextToken(&token) == S_OK && token == mtaToken
        && ((Object *)token)->vtbl->AddRef((Object *)token) == 1;
    ((Object *)token)->vtbl->Release((Object *)token);
    return 0;
}

int mainCRTStartup(void)
{
    Object *info = 0, *again = 0, *callback = 0, *context = 0;
    unsigned token = 0xdeadbeef, token2 = 0;

    check("outside an apartment there is no context",
        CoGetObjectContext(&IID_IComThreadingInfo, (void **)&info) == CO_E_NOTINITIALIZED
            && info == 0);
    check("nor a token, and nothing written",
        CoGetContextToken(&token) == CO_E_NOTINITIALIZED && token == 0xdeadbeef);

    CoInitializeEx(0, COINIT_APARTMENTTHREADED);
    check("a token needs somewhere to go", CoGetContextToken(0) == E_POINTER);
    check("the same context every time",
        CoGetObjectContext(&IID_IComThreadingInfo, (void **)&info) == S_OK
            && CoGetObjectContext(&IID_IComThreadingInfo, (void **)&again) == S_OK
            && info == again);
    again->vtbl->Release(again);

    int type = -1;
    check("the main apartment, and a thread that pumps messages",
        apartmentType(info, &type) == S_OK && type == APTTYPE_MAINSTA
            && threadType(info, &type) == S_OK && type == THDTYPE_PROCESSMESSAGES);

    GUID id = GUID_NULL, id2 = GUID_NULL;
    check("its logical thread is the thread's",
        getLogical(info, 0) != S_OK && getLogical(info, &id) == S_OK
            && CoGetCurrentLogicalThreadId(&id2) == S_OK && same(&id, &id2)
            && !same(&id, &GUID_NULL));
    check("and set through it",
        setLogical(info, &GUID_NULL) == S_OK && CoGetCurrentLogicalThreadId(&id) == S_OK
            && same(&id, &GUID_NULL) && setLogical(info, &id2) == S_OK);
    check("the context's count is its callers'", info->vtbl->Release(info) == 0);

    check("its token, the same every time",
        CoGetContextToken(&token) == S_OK && token != 0
            && CoGetContextToken(&token2) == S_OK && token2 == token);
    check("handed out with no count",
        ((Object *)token)->vtbl->AddRef((Object *)token) == 1);
    check("the token is the context's IObjContext",
        CoGetObjectContext(&IID_IObjContext, (void **)&context) == S_OK
            && context == (Object *)token && context->vtbl->AddRef(context) == 3
            && context->vtbl->Release(context) == 2
            && ((Object *)token)->vtbl->Release((Object *)token) == 1);
    context->vtbl->Release(context);

    check("the default context of the caller's own apartment is its context",
        CoGetDefaultContext(-1, &IID_IObjContext, (void **)&context) == S_OK
            && context == (Object *)token);
    context->vtbl->Release(context);
    check("no multithreaded apartment, no context of it",
        CoGetDefaultContext(APTTYPE_MTA, &IID_IObjContext, (void **)&context)
            == CO_E_NOTINITIALIZED && context == 0);

    check("a callback in its own context runs there and answers",
        CoGetObjectContext(&IID_IContextCallback, (void **)&callback) == S_OK
            && contextCallback(callback, callbackFunction, 0) == S_FALSE && ran == 1
            && seenToken == token);

    mainCallback = callback;
    mainToken = token;
    void *thread = CreateThread(0, 0, otherApartment, 0, 0, 0);
    unsigned index = 0;
    CoWaitForMultipleHandles(0, INFINITE, 1, &thread, &index);
    CloseHandle(thread);
    check("another apartment's callback runs on this thread, while it waits", threadResult);
    check("the callback object's count was the caller's", callback->vtbl->Release(callback) == 0);
    CoUninitialize();

    CoInitializeEx(0, COINIT_MULTITHREADED);
    check("the multithreaded apartment's context is another",
        CoGetContextToken(&mtaToken) == S_OK && mtaToken != 0 && mtaToken != token);
    check("which blocks rather than pumps",
        CoGetObjectContext(&IID_IComThreadingInfo, (void **)&info) == S_OK
            && apartmentType(info, &type) == S_OK && type == APTTYPE_MTA
            && threadType(info, &type) == S_OK && type == THDTYPE_BLOCKMESSAGES
            && info->vtbl->Release(info) == 0);
    thread = CreateThread(0, 0, implicitThread, 0, 0, 0);
    WaitForSingleObject(thread, INFINITE);
    CloseHandle(thread);
    check("a thread in no apartment while it stands is in its context", implicitResult);
    ran = 0;
    check("a callback there runs and answers",
        CoGetObjectContext(&IID_IContextCallback, (void **)&callback) == S_OK
            && contextCallback(callback, callbackFunction, 0) == S_FALSE && ran == 1
            && seenToken == mtaToken && callback->vtbl->Release(callback) == 0);
    CoUninitialize();

    ExitProcess(failures);
    return 0;
}
