/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/*
 * Marshaling within one process, as Wine's conformance tests check it: a
 * packet marshaled into a table is read as often as it is asked and holds
 * the object until it is released; the free-threaded marshaler writes the
 * object's own pointer for its process and the standard marshaler's packet
 * for another; an object that aggregates it is marshaled through it, in a
 * custom OBJREF; and the standard marshaler answers for an object whatever
 * it marshals itself. Every count the object takes is given back.
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

__declspec(dllimport) long __stdcall CoInitialize(void *reserved);
__declspec(dllimport) void __stdcall CoUninitialize(void);
__declspec(dllimport) long __stdcall CreateStreamOnHGlobal(void *global, int release,
    Object **stream);
__declspec(dllimport) long __stdcall CoMarshalInterface(Object *stream, const GUID *iid,
    Object *object, unsigned context, void *data, unsigned flags);
__declspec(dllimport) long __stdcall CoUnmarshalInterface(Object *stream, const GUID *iid,
    void **out);
__declspec(dllimport) long __stdcall CoReleaseMarshalData(Object *stream);
__declspec(dllimport) long __stdcall CoGetMarshalSizeMax(unsigned *size, const GUID *iid,
    Object *object, unsigned context, void *data, unsigned flags);
__declspec(dllimport) long __stdcall CoCreateFreeThreadedMarshaler(Object *outer,
    Object **marshaler);
__declspec(dllimport) long __stdcall CoGetStandardMarshal(const GUID *iid, Object *object,
    unsigned context, void *data, unsigned flags, Object **marshaler);

#define S_OK 0
#define E_NOINTERFACE ((long)0x80004002)
#define MSHCTX_LOCAL 0
#define MSHCTX_INPROC 3
#define MSHLFLAGS_NORMAL 0
#define MSHLFLAGS_TABLESTRONG 1
#define MSHLFLAGS_TABLEWEAK 2

static const GUID IID_IUnknown = { 0x00000000, 0, 0, { 0xc0, 0, 0, 0, 0, 0, 0, 0x46 } };
static const GUID IID_IMarshal = { 0x00000003, 0, 0, { 0xc0, 0, 0, 0, 0, 0, 0, 0x46 } };
static const GUID CLSID_StdMarshal = { 0x00000017, 0, 0, { 0xc0, 0, 0, 0, 0, 0, 0, 0x46 } };
static const GUID CLSID_InProcFreeMarshaler =
    { 0x0000033a, 0, 0, { 0xc0, 0, 0, 0, 0, 0, 0, 0x46 } };

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

/* The object, counted; it hands out the free-threaded marshaler's IMarshal when it has one. */
static unsigned locks;
static Object *aggregated;

static long __stdcall ObjectQueryInterface(Object *self, const GUID *iid, void **out)
{
    if (same(iid, &IID_IUnknown))
    {
        *out = self;
        locks++;
        return S_OK;
    }
    if (aggregated && same(iid, &IID_IMarshal))
    {
        return aggregated->vtbl->QueryInterface(aggregated, iid, out);
    }
    *out = 0;
    return E_NOINTERFACE;
}
static unsigned __stdcall ObjectAddRef(Object *self)
{
    (void)self;
    return ++locks;
}
static unsigned __stdcall ObjectRelease(Object *self)
{
    (void)self;
    return --locks;
}
static const Vtbl objectVtbl = { ObjectQueryInterface, ObjectAddRef, ObjectRelease, { 0 } };
static Object object = { &objectVtbl };

/* IStream's Seek, Read and IMarshal's methods, by slot. */
static long seek(Object *stream)
{
    return ((long(__stdcall *)(Object *, unsigned, unsigned, unsigned, void *))
        stream->vtbl->methods[2])(stream, 0, 0, 0, 0);
}
static long readBytes(Object *stream, void *into, unsigned count, unsigned *read)
{
    return ((long(__stdcall *)(Object *, void *, unsigned, unsigned *))
        stream->vtbl->methods[0])(stream, into, count, read);
}
static long unmarshalClass(Object *marshal, unsigned context, GUID *clsid)
{
    return ((long(__stdcall *)(Object *, const GUID *, void *, unsigned, void *, unsigned, GUID *))
        marshal->vtbl->methods[0])(marshal, &IID_IUnknown, &object, context, 0, 0, clsid);
}
static long sizeMax(Object *marshal, unsigned context, unsigned *size)
{
    return ((long(__stdcall *)(Object *, const GUID *, void *, unsigned, void *, unsigned,
        unsigned *))marshal->vtbl->methods[1])(marshal, &IID_IUnknown, &object, context, 0, 0,
        size);
}
static long marshalInto(Object *marshal, Object *stream, unsigned context, unsigned flags)
{
    return ((long(__stdcall *)(Object *, Object *, const GUID *, void *, unsigned, void *,
        unsigned))marshal->vtbl->methods[2])(marshal, stream, &IID_IUnknown, &object, context, 0,
        flags);
}
static long unmarshalFrom(Object *marshal, Object *stream, void **out)
{
    return ((long(__stdcall *)(Object *, Object *, const GUID *, void **))
        marshal->vtbl->methods[3])(marshal, stream, &IID_IUnknown, out);
}

int mainCRTStartup(void)
{
    CoInitialize(0);
    Object *stream = 0;
    CreateStreamOnHGlobal(0, 1, &stream);
    void *got = 0, *again = 0;

    /* A table's packet. */
    check("table: marshaled", CoMarshalInterface(stream, &IID_IUnknown, &object, MSHCTX_INPROC, 0,
        MSHLFLAGS_TABLESTRONG) == S_OK && locks > 0);
    seek(stream);
    check("table: read once", CoUnmarshalInterface(stream, &IID_IUnknown, &got) == S_OK
        && got == &object);
    seek(stream);
    check("table: and again", CoUnmarshalInterface(stream, &IID_IUnknown, &again) == S_OK
        && again == &object);
    ObjectRelease(&object);
    ObjectRelease(&object);
    check("table: the packet holds the object while it stands", locks > 0);
    seek(stream);
    check("table: released", CoReleaseMarshalData(stream) == S_OK && locks == 0);

    /* The free-threaded marshaler. */
    Object *ftm = 0, *marshal = 0;
    check("free-threaded: made", CoCreateFreeThreadedMarshaler(0, &ftm) == S_OK && ftm
        && ftm->vtbl->QueryInterface(ftm, &IID_IMarshal, (void **)&marshal) == S_OK && marshal);
    GUID clsid;
    unsigned size = 0;
    check("free-threaded: within the process, its own class and 28 bytes",
        unmarshalClass(marshal, MSHCTX_INPROC, &clsid) == S_OK
            && same(&clsid, &CLSID_InProcFreeMarshaler)
            && sizeMax(marshal, MSHCTX_INPROC, &size) == S_OK && size == 28);
    check("free-threaded: to another process, the standard marshaler's",
        unmarshalClass(marshal, MSHCTX_LOCAL, &clsid) == S_OK && same(&clsid, &CLSID_StdMarshal));
    seek(stream);
    unsigned data[7] = { 0 }, read = 0;
    check("free-threaded: marshaled, holding the object",
        marshalInto(marshal, stream, MSHCTX_INPROC, MSHLFLAGS_NORMAL) == S_OK && locks == 1);
    seek(stream);
    check("free-threaded: its flags and the object's pointer",
        readBytes(stream, data, sizeof data, &read) == S_OK && read == 28
            && data[0] == MSHLFLAGS_NORMAL && data[1] == (unsigned)&object);
    seek(stream);
    got = 0;
    check("free-threaded: unmarshaled is the object, the packet's count the reader's",
        unmarshalFrom(marshal, stream, &got) == S_OK && got == &object && locks == 1);
    ObjectRelease(&object);
    seek(stream);
    check("free-threaded: a weak table's packet holds nothing",
        marshalInto(marshal, stream, MSHCTX_INPROC, MSHLFLAGS_TABLEWEAK) == S_OK && locks == 0);

    /* An object that aggregates it. */
    aggregated = ftm;
    seek(stream);
    check("aggregate: marshaled through its own marshaler",
        CoMarshalInterface(stream, &IID_IUnknown, &object, MSHCTX_INPROC, 0, MSHLFLAGS_NORMAL)
            == S_OK);
    seek(stream);
    unsigned header[12] = { 0 };
    check("aggregate: a custom OBJREF naming the free-threaded unmarshaler",
        readBytes(stream, header, sizeof header, &read) == S_OK && header[0] == 0x574f454d
            && header[1] == 4 && same((GUID *)&header[6], &CLSID_InProcFreeMarshaler));
    seek(stream);
    got = 0;
    check("aggregate: unmarshaled is the object", CoUnmarshalInterface(stream, &IID_IUnknown, &got)
        == S_OK && got == &object);
    ObjectRelease(&object);
    check("aggregate: every count given back", locks == 0);
    size = 0;
    check("aggregate: its size is the custom header's and the marshaler's",
        CoGetMarshalSizeMax(&size, &IID_IUnknown, &object, MSHCTX_INPROC, 0, MSHLFLAGS_NORMAL)
            == S_OK && size == 48 + 28);
    aggregated = 0;
    marshal->vtbl->Release(marshal);
    ftm->vtbl->Release(ftm);

    /* The standard marshaler. */
    Object *standard = 0;
    check("standard: made", CoGetStandardMarshal(&IID_IUnknown, &object, MSHCTX_LOCAL, 0,
        MSHLFLAGS_NORMAL, &standard) == S_OK && standard);
    check("standard: its own class", unmarshalClass(standard, MSHCTX_LOCAL, &clsid) == S_OK
        && same(&clsid, &CLSID_StdMarshal));
    seek(stream);
    check("standard: marshaled", marshalInto(standard, stream, MSHCTX_LOCAL, MSHLFLAGS_NORMAL)
        == S_OK);
    seek(stream);
    got = 0;
    check("standard: unmarshaled is the object", CoUnmarshalInterface(stream, &IID_IUnknown, &got)
        == S_OK && got == &object);
    ObjectRelease(&object);
    standard->vtbl->Release(standard);
    check("standard: every count given back", locks == 0);

    stream->vtbl->Release(stream);
    CoUninitialize();
    ExitProcess(failures);
    return 0;
}
