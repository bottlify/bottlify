/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * OLE's default handler: the object a container holds for an embedded
 * object whose server is not loaded -- OleCreateDefaultHandler's, an
 * InprocHandler32 of "ole32.dll", OleLoad's for a class with no server in
 * process -- and OleCreateEmbeddingHelper's, the same over a server's own
 * class factory.
 *
 * Until it runs, the handler answers from the registry (verbs, user type,
 * miscellaneous status) and from its data cache (the presentations it is
 * drawn from), and refuses what only the server can do with
 * OLE_E_NOTRUNNING, as ole2.c's test_default_handler records Windows. Run
 * makes the server -- a local server through CoCreateInstance, or the
 * embedding helper's factory -- gives it the storage, the site and the host
 * names, and starts the cache on its data; from then on IOleObject and
 * IDataObject are the server's.
 *
 * The cache's interfaces are the handler's own, each method sent on to the
 * cache it holds, so the handler is one object to the program.
 */

import { formatGuid, parseGuid } from './guid.js';
import {
    IID_IDATAOBJECT, IID_IOLECACHE, IID_IOLECACHE2, IID_IOLECACHECONTROL, IID_IPERSISTSTORAGE,
    IID_IVIEWOBJECT, IID_IVIEWOBJECT2,
} from './datacache.js';

const S_OK = 0;
const E_FAIL = 0x80004005 | 0;
const E_POINTER = 0x80004003 | 0;
const E_INVALIDARG = 0x80070057 | 0;
const E_NOINTERFACE = 0x80004002 | 0;
const E_OUTOFMEMORY = 0x8007000e | 0;
const OLE_E_NOTRUNNING = 0x80040005 | 0;
const OLE_E_BLANK = 0x80040007 | 0;
const OLE_E_NOCONNECTION = 0x80040004 | 0;
const CLASS_E_NOAGGREGATION = 0x80040110 | 0;

export const IID_IOLEOBJECT = '{00000112-0000-0000-C000-000000000046}';
export const IID_IRUNNABLEOBJECT = '{00000126-0000-0000-C000-000000000046}';
const IID_IUNKNOWN = '{00000000-0000-0000-C000-000000000046}';
const IID_IPERSIST = '{0000010C-0000-0000-C000-000000000046}';
const CLSID_DEFAULT_HANDLER = '{7b5b0b8e-1f8c-4b36-9d1c-2a6d4e4b0041}';

const CLSCTX_LOCAL_SERVER = 4;
const EMBDHLP_INPROC_SERVER = 1;
const EMBDHLP_DELAYCREATE = 0x10000;
const OLECLOSE_NOSAVE = 1;

/** The \1Ole stream a new object's storage is given: version 0x02000001 and zeros. */
const OLE_STREAM = '\x01Ole';
const OLE_STREAM_HEADER = [0x02000001, 0, 0, 0, 0];
const STGM_CREATE_READWRITE_EXCLUSIVE = 0x1012;

/** The slots of the interfaces the handler calls on what it holds. */
const SLOT = Object.freeze({
    QUERY_INTERFACE: 0, ADD_REF: 1, RELEASE: 2,
    SET_CLIENT_SITE: 3, SET_HOST_NAMES: 5, CLOSE: 6,
    CREATE_INSTANCE: 3,
    INIT_NEW: 5, LOAD: 6, SAVE: 7, SAVE_COMPLETED: 8, HANDS_OFF: 9, IS_DIRTY: 4,
    ADVISE: 3, UNADVISE: 4, ENUM_ADVISE: 5,
    CACHE_ON_RUN: 3, CACHE_ON_STOP: 4,
    VIEW_GET_EXTENT: 9,
    DATA_GET: 3, DATA_QUERY: 5, DATA_DADVISE: 3, DATA_DUNADVISE: 4, DATA_ENUM_DADVISE: 5,
});

/**
 * The cache's interfaces, method by method, as the handler sends them on:
 * the name and the stdcall bytes of each after IUnknown's three.
 *
 * @type {Readonly<Record<string, [string, number][]>>}
 */
const FORWARDED = Object.freeze({
    [IID_IOLECACHE]: [['Cache', 16], ['Uncache', 8], ['EnumCache', 8], ['InitCache', 8],
        ['SetData', 16]],
    [IID_IOLECACHE2]: [['Cache', 16], ['Uncache', 8], ['EnumCache', 8], ['InitCache', 8],
        ['SetData', 16], ['UpdateCache', 16], ['DiscardCache', 8]],
    [IID_IOLECACHECONTROL]: [['OnRun', 8], ['OnStop', 4]],
    [IID_IVIEWOBJECT]: [['Draw', 44], ['GetColorSet', 28], ['Freeze', 20], ['Unfreeze', 8],
        ['SetAdvise', 16], ['GetAdvise', 16]],
    [IID_IVIEWOBJECT2]: [['Draw', 44], ['GetColorSet', 28], ['Freeze', 20], ['Unfreeze', 8],
        ['SetAdvise', 16], ['GetAdvise', 16], ['GetExtent', 20]],
});

/**
 * @typedef {Object} HandlerEnv
 * @property {import('./oleutil.js').OleEnv} ole
 * @property {ReturnType<typeof import('./oleutil.js').createOleUtil>} util
 * @property {ReturnType<typeof import('./datacache.js').createDataCaches>} caches
 * @property {(name: string, guids: string[], args: (pointers: number[]) => number[])
 *     => Promise<number>} callExport
 *     One of ole32's own exports, the GUIDs it takes lent: the registry's
 *     answers about a class, and the advise holders.
 */

/**
 * @typedef {Object} HandlerState
 * @property {string} clsid
 * @property {number} cache       The data cache's IUnknown, held.
 * @property {Map<string, number>} cacheInterfaces  Its interfaces asked for, each held.
 * @property {number} server      The running object's IOleObject, held, or 0.
 * @property {number} factory     The embedding helper's class factory, held, or 0.
 * @property {number} serverUnknown  An in-process server made at once, or 0.
 * @property {number} site
 * @property {number} storage     Held from InitNew or Load.
 * @property {boolean} loaded     Load rather than InitNew gave the storage.
 * @property {number} oleAdvise   The IOleAdviseHolder, made on the first Advise.
 * @property {number} dataAdvise  The IDataAdviseHolder, made on the first DAdvise.
 * @property {{ app: string | null, object: string | null }} hostNames
 * @property {boolean} contained
 */

/** @param {HandlerEnv} context */
export function createDefaultHandlers(context){
    const { ole: env, util, caches } = context;
    const { readU32, writeU32, release } = util;

    /** @param {number} pointer @param {number} slot @param {number[]} args @param {unknown} thread */
    const call = async(pointer, slot, args, thread)=>(await env.callMethod(pointer, slot, args,
        thread)) | 0;

    /**
     * The cache's interface `iid`, asked for once and held.
     *
     * @param {HandlerState} state @param {string} iid @param {unknown} thread
     */
    const cacheInterface = async(state, iid, thread)=>{
        const known = state.cacheInterfaces.get(iid);
        if (known)
        {
            return known;
        }
        const pointer = await env.queryPointer(state.cache, iid, thread);
        if (pointer !== 0)
        {
            state.cacheInterfaces.set(iid, pointer);
        }
        return pointer;
    };

    /** @param {string} iid @returns {import('./objects.js').ComMethod[]} */
    const forwarding = iid=>FORWARDED[iid].map(([name, argBytes], index)=>({
        name, argBytes,
        invoke: async(/** @type {any} */ object, /** @type {number[]} */ args)=>{
            const thread = env.callerThread();
            const pointer = await cacheInterface(object.state, iid, thread);
            return pointer === 0 ? E_NOINTERFACE : call(pointer, 3 + index, args, thread);
        },
    }));

    /** @param {any} object @returns {HandlerState} */
    const stateOf = object=>object.state;

    /**
     * The server's interface `iid` while it runs, which the caller releases;
     * 0 when it does not run or has none.
     *
     * @param {HandlerState} state @param {string} iid @param {unknown} thread
     */
    const serverInterface = (state, iid, thread)=>(state.server === 0 ? Promise.resolve(0)
        : env.queryPointer(state.server, iid, thread));

    /**
     * An IOleObject method: the server's while it runs, `idle` otherwise.
     *
     * @param {string} name @param {number} argBytes @param {number} slot
     * @param {(state: HandlerState, args: number[], thread: unknown)
     *     => number | Promise<number>} idle
     * @param {(state: HandlerState, args: number[], thread: unknown) => unknown} [remember]
     *     What the handler keeps of the call either way.
     * @returns {import('./objects.js').ComMethod}
     */
    const oleMethod = (name, argBytes, slot, idle, remember)=>({
        name, argBytes,
        invoke: async(/** @type {any} */ object, /** @type {number[]} */ args)=>{
            const state = stateOf(object);
            const thread = env.callerThread();
            await remember?.(state, args, thread);
            return state.server === 0 ? idle(state, args, thread)
                : call(state.server, slot, args, thread);
        },
    });

    /** @param {string} name @param {number} argBytes @param {number} slot */
    const notRunning = (name, argBytes, slot)=>oleMethod(name, argBytes, slot,
        ()=>OLE_E_NOTRUNNING);

    /** @type {import('./objects.js').ComMethod[]} */
    const OLE_OBJECT_METHODS = [
        oleMethod('SetClientSite', 8, SLOT.SET_CLIENT_SITE, ()=>S_OK, async(state, args, thread)=>{
            const [site] = args;
            if ((site >>> 0) !== 0)
            {
                await call(site >>> 0, SLOT.ADD_REF, [], thread);
            }
            const previous = state.site;
            state.site = site >>> 0;
            if (previous !== 0)
            {
                await release(previous, thread);
            }
        }),
        { name: 'GetClientSite', argBytes: 8, invoke: async(object, [out])=>{
            const state = stateOf(object);
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            if (state.site !== 0)
            {
                await call(state.site, SLOT.ADD_REF, [], env.callerThread());
            }
            writeU32(out, state.site);
            return S_OK;
        } },
        oleMethod('SetHostNames', 12, SLOT.SET_HOST_NAMES, ()=>S_OK, (state, [app, object])=>{
            state.hostNames = { app: (app >>> 0) === 0 ? null : util.readWide(app >>> 0),
                object: (object >>> 0) === 0 ? null : util.readWide(object >>> 0) };
        }),
        { name: 'Close', argBytes: 8, invoke: async(object, [option])=>{
            const state = stateOf(object);
            return stop(state, option >>> 0, env.callerThread());
        } },
        oleMethod('SetMoniker', 12, 7, ()=>S_OK),
        oleMethod('GetMoniker', 16, 8, async(state, [assign, which, out], thread)=>{
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            writeU32(out, 0);
            // The site names the object's moniker; without one there is none.
            return state.site === 0 ? E_FAIL
                : call(state.site, 4, [assign >>> 0, which >>> 0, out >>> 0], thread);
        }),
        notRunning('InitFromData', 16, 9),
        notRunning('GetClipboardData', 12, 10),
        { name: 'DoVerb', argBytes: 28, invoke: async(object, args)=>{
            const state = stateOf(object);
            const thread = env.callerThread();
            const ran = await run(state, thread);
            return ran < 0 ? ran : call(state.server, 11, args, thread);
        } },
        oleMethod('EnumVerbs', 8, 12, (state, [out])=>context.callExport('OleRegEnumVerbs',
            [state.clsid], ([clsid])=>[clsid, out >>> 0])),
        oleMethod('Update', 4, 13, async(state, _args, thread)=>{
            const ran = await run(state, thread);
            return ran < 0 ? ran : call(state.server, 13, [], thread);
        }),
        notRunning('IsUpToDate', 4, 14),
        { name: 'GetUserClassID', argBytes: 8, invoke: async(object, [out])=>{
            const state = stateOf(object);
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            if (state.server !== 0)
            {
                return call(state.server, 15, [out >>> 0], env.callerThread());
            }
            env.writeMemory(out >>> 0, /** @type {Uint8Array} */ (parseGuid(state.clsid)));
            return S_OK;
        } },
        oleMethod('GetUserType', 12, 16, (state, [form, out])=>context.callExport(
            'OleRegGetUserType', [state.clsid], ([clsid])=>[clsid, form >>> 0, out >>> 0])),
        notRunning('SetExtent', 12, 17),
        oleMethod('GetExtent', 12, 18, async(state, [aspect, out], thread)=>{
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            const view = await cacheInterface(state, IID_IVIEWOBJECT2, thread);
            return view === 0 ? OLE_E_BLANK
                : call(view, SLOT.VIEW_GET_EXTENT, [aspect >>> 0, -1, 0, out >>> 0], thread);
        }),
        { name: 'Advise', argBytes: 12, invoke: async(object, [sink, out])=>{
            const state = stateOf(object);
            const holder = await oleAdviseHolder(state);
            return holder === 0 ? E_OUTOFMEMORY
                : call(holder, SLOT.ADVISE, [sink >>> 0, out >>> 0], env.callerThread());
        } },
        { name: 'Unadvise', argBytes: 8, invoke: async(object, [connection])=>{
            const state = stateOf(object);
            return state.oleAdvise === 0 ? OLE_E_NOCONNECTION
                : call(state.oleAdvise, SLOT.UNADVISE, [connection >>> 0], env.callerThread());
        } },
        { name: 'EnumAdvise', argBytes: 8, invoke: async(object, [out])=>{
            const state = stateOf(object);
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            writeU32(out, 0);
            return state.oleAdvise === 0 ? S_OK
                : call(state.oleAdvise, SLOT.ENUM_ADVISE, [out >>> 0], env.callerThread());
        } },
        oleMethod('GetMiscStatus', 12, 22, (state, [aspect, out])=>context.callExport(
            'OleRegGetMiscStatus', [state.clsid], ([clsid])=>[clsid, aspect >>> 0, out >>> 0])),
        notRunning('SetColorScheme', 8, 23),
    ];

    /**
     * The IOleAdviseHolder the handler's sinks are kept in, made once.
     *
     * @param {HandlerState} state
     */
    const oleAdviseHolder = async state=>{
        if (state.oleAdvise === 0)
        {
            state.oleAdvise = await util.withScratch(4, async slot=>{
                const hr = await context.callExport('CreateOleAdviseHolder', [], ()=>[slot]);
                return hr < 0 ? 0 : readU32(slot);
            }) ?? 0;
        }
        return state.oleAdvise;
    };

    /** @param {HandlerState} state */
    const dataAdviseHolder = async state=>{
        if (state.dataAdvise === 0)
        {
            state.dataAdvise = await util.withScratch(4, async slot=>{
                const hr = await context.callExport('CreateDataAdviseHolder', [], ()=>[slot]);
                return hr < 0 ? 0 : readU32(slot);
            }) ?? 0;
        }
        return state.dataAdvise;
    };

    /**
     * An IDataObject method: the cache's answer first, then the server's
     * while it runs, else OLE_E_NOTRUNNING.
     *
     * @param {string} name @param {number} argBytes @param {number} slot
     * @returns {import('./objects.js').ComMethod}
     */
    const dataMethod = (name, argBytes, slot)=>({
        name, argBytes,
        invoke: async(/** @type {any} */ object, /** @type {number[]} */ args)=>{
            const state = stateOf(object);
            const thread = env.callerThread();
            const cache = await cacheInterface(state, IID_IDATAOBJECT, thread);
            if (cache !== 0 && (slot === SLOT.DATA_GET || slot === SLOT.DATA_QUERY))
            {
                const answer = await call(cache, slot, args, thread);
                if (answer === S_OK)
                {
                    return answer;
                }
            }
            const data = await serverInterface(state, IID_IDATAOBJECT, thread);
            if (data === 0)
            {
                return OLE_E_NOTRUNNING;
            }
            const answer = await call(data, slot, args, thread);
            await release(data, thread);
            return answer;
        },
    });

    /** @type {import('./objects.js').ComMethod[]} */
    const DATA_OBJECT_METHODS = [
        dataMethod('GetData', 12, 3),
        dataMethod('GetDataHere', 12, 4),
        dataMethod('QueryGetData', 8, 5),
        dataMethod('GetCanonicalFormatEtc', 12, 6),
        dataMethod('SetData', 16, 7),
        { name: 'EnumFormatEtc', argBytes: 12, invoke: async(object, [direction, out])=>{
            const state = stateOf(object);
            const thread = env.callerThread();
            const data = await serverInterface(state, IID_IDATAOBJECT, thread);
            if (data !== 0)
            {
                const answer = await call(data, 8, [direction >>> 0, out >>> 0], thread);
                await release(data, thread);
                return answer;
            }
            return context.callExport('OleRegEnumFormatEtc', [state.clsid],
                ([clsid])=>[clsid, direction >>> 0, out >>> 0]);
        } },
        { name: 'DAdvise', argBytes: 20, invoke: async(object, [format, advf, sink, out])=>{
            const state = stateOf(object);
            const holder = await dataAdviseHolder(state);
            return holder === 0 ? E_OUTOFMEMORY : call(holder, SLOT.DATA_DADVISE,
                [0, format >>> 0, advf >>> 0, sink >>> 0, out >>> 0], env.callerThread());
        } },
        { name: 'DUnadvise', argBytes: 8, invoke: async(object, [connection])=>{
            const state = stateOf(object);
            return state.dataAdvise === 0 ? OLE_E_NOCONNECTION : call(state.dataAdvise,
                SLOT.DATA_DUNADVISE, [connection >>> 0], env.callerThread());
        } },
        { name: 'EnumDAdvise', argBytes: 8, invoke: async(object, [out])=>{
            const state = stateOf(object);
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            writeU32(out, 0);
            return state.dataAdvise === 0 ? S_OK : call(state.dataAdvise,
                SLOT.DATA_ENUM_DADVISE, [out >>> 0], env.callerThread());
        } },
    ];

    /**
     * Makes the server run: the embedding helper's factory or a local
     * server, given what the handler kept for it.
     *
     * @param {HandlerState} state @param {unknown} thread
     */
    const run = async(state, thread)=>{
        if (state.server !== 0)
        {
            return S_OK;
        }
        const made = await util.withScratch(4, async slot=>{
            writeU32(slot, 0);
            let hr;
            if (state.serverUnknown !== 0)
            {
                const own = await env.queryPointer(state.serverUnknown, IID_IOLEOBJECT, thread);
                writeU32(slot, own);
                hr = own === 0 ? E_NOINTERFACE : S_OK;
            }
            else if (state.factory !== 0)
            {
                hr = await util.withScratch(16, async iid=>{
                    env.writeMemory(iid, /** @type {Uint8Array} */ (parseGuid(IID_IOLEOBJECT)));
                    return call(state.factory, SLOT.CREATE_INSTANCE, [0, iid, slot], thread);
                }) ?? E_OUTOFMEMORY;
            }
            else
            {
                hr = await env.createInstance(state.clsid, 0, CLSCTX_LOCAL_SERVER, IID_IOLEOBJECT,
                    slot);
            }
            return { hr, pointer: hr < 0 ? 0 : readU32(slot) };
        }) ?? { hr: E_OUTOFMEMORY, pointer: 0 };
        if (made.hr < 0 || made.pointer === 0)
        {
            return made.hr < 0 ? made.hr : E_NOINTERFACE;
        }
        state.server = made.pointer;
        if (state.storage !== 0)
        {
            const persist = await env.queryPointer(state.server, IID_IPERSISTSTORAGE, thread);
            if (persist !== 0)
            {
                await call(persist, state.loaded ? SLOT.LOAD : SLOT.INIT_NEW, [state.storage],
                    thread);
                await release(persist, thread);
            }
        }
        if (state.site !== 0)
        {
            await call(state.server, SLOT.SET_CLIENT_SITE, [state.site], thread);
        }
        const control = await cacheInterface(state, IID_IOLECACHECONTROL, thread);
        const data = await env.queryPointer(state.server, IID_IDATAOBJECT, thread);
        if (control !== 0 && data !== 0)
        {
            await call(control, SLOT.CACHE_ON_RUN, [data], thread);
        }
        if (data !== 0)
        {
            await release(data, thread);
        }
        return S_OK;
    };

    /**
     * Stops the server: closed as asked, the cache told, and let go of.
     *
     * @param {HandlerState} state @param {number} option @param {unknown} thread
     */
    const stop = async(state, option, thread)=>{
        if (state.server === 0)
        {
            return S_OK;
        }
        const server = state.server;
        const hr = await call(server, SLOT.CLOSE, [option], thread);
        const control = await cacheInterface(state, IID_IOLECACHECONTROL, thread);
        if (control !== 0)
        {
            await call(control, SLOT.CACHE_ON_STOP, [], thread);
        }
        state.server = 0;
        await release(server, thread);
        return hr;
    };

    /** @type {import('./objects.js').ComMethod[]} */
    const RUNNABLE_METHODS = [
        { name: 'GetRunningClass', argBytes: 8, invoke: (object, [out])=>{
            if ((out >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            env.writeMemory(out >>> 0, /** @type {Uint8Array} */ (parseGuid(stateOf(object).clsid)));
            return S_OK;
        } },
        { name: 'Run', argBytes: 8, invoke: object=>run(stateOf(object), env.callerThread()) },
        { name: 'IsRunning', argBytes: 4, invoke: object=>(stateOf(object).server !== 0 ? 1 : 0) },
        { name: 'LockRunning', argBytes: 12, invoke: async(object, [lock, closes])=>{
            const state = stateOf(object);
            const thread = env.callerThread();
            if (lock)
            {
                const ran = await run(state, thread);
                if (ran < 0)
                {
                    return ran;
                }
            }
            else if (closes && state.server !== 0)
            {
                return stop(state, OLECLOSE_NOSAVE, thread);
            }
            return S_OK;
        } },
        { name: 'SetContainedObject', argBytes: 8, invoke: (object, [contained])=>{
            stateOf(object).contained = contained !== 0;
            return S_OK;
        } },
    ];

    /**
     * An IPersistStorage method: the cache's, then the running server's.
     *
     * @param {HandlerState} state @param {number} slot @param {number[]} args
     * @param {unknown} thread
     */
    const persistBoth = async(state, slot, args, thread)=>{
        const cache = await cacheInterface(state, IID_IPERSISTSTORAGE, thread);
        let hr = cache === 0 ? E_NOINTERFACE : await call(cache, slot, args, thread);
        const persist = await serverInterface(state, IID_IPERSISTSTORAGE, thread);
        if (persist !== 0)
        {
            const own = await call(persist, slot, args, thread);
            hr = own < 0 ? own : hr;
            await release(persist, thread);
        }
        return hr;
    };

    /**
     * Holds the storage the object lives in.
     *
     * @param {HandlerState} state @param {number} storage @param {unknown} thread
     */
    const holdStorage = async(state, storage, thread)=>{
        if (storage !== 0)
        {
            await call(storage, SLOT.ADD_REF, [], thread);
        }
        const previous = state.storage;
        state.storage = storage;
        if (previous !== 0)
        {
            await release(previous, thread);
        }
    };

    /**
     * The \1Ole stream a new object's storage holds, written if it is not
     * there (defaulthandler.c test_olestream).
     *
     * @param {number} storage @param {unknown} thread
     */
    const writeOleStream = async(storage, thread)=>{
        const opened = await util.openStream(storage, OLE_STREAM, STGM_CREATE_READWRITE_EXCLUSIVE,
            true, thread);
        if (opened.hr < 0)
        {
            return opened.hr;
        }
        const bytes = new Uint8Array(OLE_STREAM_HEADER.length * 4);
        OLE_STREAM_HEADER.forEach((word, index)=>new DataView(bytes.buffer)
            .setUint32(index * 4, word >>> 0, true));
        const hr = await util.writeStream(opened.stream, bytes, thread);
        await release(opened.stream, thread);
        return hr;
    };

    /** @type {import('./objects.js').ComMethod[]} */
    const PERSIST_METHODS = [
        { name: 'GetClassID', argBytes: 8, invoke: (object, [out])=>{
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            env.writeMemory(out >>> 0, /** @type {Uint8Array} */ (parseGuid(stateOf(object).clsid)));
            return S_OK;
        } },
        { name: 'IsDirty', argBytes: 4, invoke: object=>persistBoth(stateOf(object), SLOT.IS_DIRTY,
            [], env.callerThread()) },
        { name: 'InitNew', argBytes: 8, invoke: async(object, [storage])=>{
            const state = stateOf(object);
            const thread = env.callerThread();
            if ((storage >>> 0) === 0)
            {
                return E_POINTER;
            }
            const written = await writeOleStream(storage >>> 0, thread);
            if (written < 0)
            {
                return written;
            }
            await holdStorage(state, storage >>> 0, thread);
            state.loaded = false;
            return persistBoth(state, SLOT.INIT_NEW, [storage >>> 0], thread);
        } },
        { name: 'Load', argBytes: 8, invoke: async(object, [storage])=>{
            const state = stateOf(object);
            const thread = env.callerThread();
            if ((storage >>> 0) === 0)
            {
                return E_POINTER;
            }
            await holdStorage(state, storage >>> 0, thread);
            state.loaded = true;
            return persistBoth(state, SLOT.LOAD, [storage >>> 0], thread);
        } },
        { name: 'Save', argBytes: 12,
            invoke: (object, args)=>persistBoth(stateOf(object), SLOT.SAVE, args,
                env.callerThread()) },
        { name: 'SaveCompleted', argBytes: 8, invoke: (object, args)=>persistBoth(stateOf(object),
            SLOT.SAVE_COMPLETED, args, env.callerThread()) },
        { name: 'HandsOffStorage', argBytes: 4, invoke: async object=>{
            const state = stateOf(object);
            const thread = env.callerThread();
            const hr = await persistBoth(state, SLOT.HANDS_OFF, [], thread);
            await holdStorage(state, 0, thread);
            return hr;
        } },
    ];

    /**
     * Interfaces the handler does not have itself: an in-process server's
     * made at once, its answer whatever it is (ole2.c: a QueryInterface
     * failure of the delegate is the handler's), or the running server's.
     *
     * @param {HandlerState} state @param {string} iid @param {unknown} thread
     * @returns {Promise<{ hr: number, pointer: number }>}
     */
    const delegated = async(state, iid, thread)=>{
        const target = state.serverUnknown || state.server;
        if (target === 0)
        {
            return { hr: E_NOINTERFACE, pointer: 0 };
        }
        return await util.withScratch(20, async block=>{
            env.writeMemory(block, /** @type {Uint8Array} */ (parseGuid(iid)));
            writeU32(block + 16, 0);
            const hr = await call(target, SLOT.QUERY_INTERFACE, [block, block + 16], thread);
            return { hr, pointer: readU32(block + 16) };
        }) ?? { hr: E_OUTOFMEMORY, pointer: 0 };
    };

    /**
     * The handler's QueryInterface: its own interfaces, then what the server
     * it delegates to answers, failure and all.
     *
     * @type {import('./objects.js').ComMethod}
     */
    const QUERY_INTERFACE = { name: 'QueryInterface', argBytes: 12,
        invoke: async(/** @type {any} */ object, /** @type {number[]} */ [riid, out])=>{
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            writeU32(out, 0);
            if ((riid >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            const asked = formatGuid(env.readMemory(riid >>> 0, 16));
            if (object.interfaceFor(asked))
            {
                const pointer = env.publish(object, asked) >>> 0;
                object.addRef();
                writeU32(out, pointer);
                return S_OK;
            }
            const passed = await delegated(stateOf(object), asked, env.callerThread());
            writeU32(out, passed.pointer);
            return passed.pointer === 0 && passed.hr >= 0 ? E_NOINTERFACE : passed.hr;
        } };

    /** Each of the handler's interfaces with its own QueryInterface, made once. */
    /** @type {Map<string, readonly any[]>} */
    const tables = new Map();
    /** @param {string} id @param {readonly any[]} methods */
    const withOwnQuery = (id, methods)=>{
        let table = tables.get(id);
        if (!table)
        {
            table = Object.freeze([QUERY_INTERFACE, ...methods.slice(1)]);
            tables.set(id, table);
        }
        return table;
    };

    return {
        /**
         * OleCreateDefaultHandler and OleCreateEmbeddingHelper's object, its
         * `iid` into `out`.
         *
         * @param {string} clsid @param {number} outer @param {number} flags
         * @param {number} factory @param {string} iid @param {number} out @param {unknown} thread
         * @returns {Promise<number>}
         */
        async create(clsid, outer, flags, factory, iid, out, thread){
            writeU32(out, 0);
            if (outer !== 0)
            {
                util.sayOnce('OleCreateDefaultHandler', 'an aggregated default handler is refused');
                return CLASS_E_NOAGGREGATION;
            }
            const cacheObject = caches.create(0, clsid);
            const cache = cacheObject ? env.publish(cacheObject, caches.IID_IUNKNOWN) >>> 0 : 0;
            if (cache === 0)
            {
                return E_OUTOFMEMORY;
            }
            /** @type {HandlerState} */
            const state = { clsid, cache, cacheInterfaces: new Map(), server: 0, factory: 0,
                serverUnknown: 0, site: 0, storage: 0, loaded: false, oleAdvise: 0, dataAdvise: 0,
                hostNames: { app: null, object: null }, contained: false };
            if (factory !== 0)
            {
                await call(factory, SLOT.ADD_REF, [], thread);
                state.factory = factory;
                // An in-process server made now, unless it is to wait.
                if ((flags & EMBDHLP_INPROC_SERVER) !== 0 && (flags & EMBDHLP_DELAYCREATE) === 0)
                {
                    const made = await util.withScratch(20, async block=>{
                        env.writeMemory(block, /** @type {Uint8Array} */ (parseGuid(IID_IUNKNOWN)));
                        writeU32(block + 16, 0);
                        const hr = await call(factory, SLOT.CREATE_INSTANCE, [0, block, block + 16],
                            thread);
                        return hr < 0 ? 0 : readU32(block + 16);
                    }) ?? 0;
                    state.serverUnknown = made;
                }
            }
            const object = env.makeObject(CLSID_DEFAULT_HANDLER, {
                state,
                interfaces: [
                    { id: IID_IOLEOBJECT, methods: OLE_OBJECT_METHODS },
                    { id: IID_IDATAOBJECT, methods: DATA_OBJECT_METHODS },
                    { id: IID_IRUNNABLEOBJECT, methods: RUNNABLE_METHODS },
                    { id: IID_IPERSISTSTORAGE, methods: PERSIST_METHODS },
                    { id: IID_IPERSIST, methods: PERSIST_METHODS.slice(0, 1) },
                    ...Object.keys(FORWARDED).map(id=>({ id, methods: forwarding(id) })),
                ],
                lastRelease: async()=>{
                    const caller = env.callerThread();
                    await stop(state, OLECLOSE_NOSAVE, caller);
                    for (const pointer of [...state.cacheInterfaces.values(), state.cache,
                        state.site, state.storage, state.oleAdvise, state.dataAdvise,
                        state.serverUnknown, state.factory])
                    {
                        if (pointer !== 0)
                        {
                            await release(pointer, caller);
                        }
                    }
                    state.cacheInterfaces.clear();
                    Object.assign(state, { cache: 0, site: 0, storage: 0, oleAdvise: 0,
                        dataAdvise: 0, serverUnknown: 0, factory: 0 });
                },
            });
            if (!object)
            {
                await release(cache, thread);
                return E_OUTOFMEMORY;
            }
            const own = object.interfaceFor.bind(object);
            /** The handler's records, made once each: a record is a pointer. */
            /** @type {Map<string, any>} */
            const records = new Map();
            object.interfaceFor = (/** @type {string} */ id)=>{
                const found = own(id);
                if (!found)
                {
                    return null;
                }
                let record = records.get(found.id);
                if (!record)
                {
                    record = Object.freeze({ ...found,
                        methods: withOwnQuery(found.id, found.methods) });
                    records.set(found.id, record);
                }
                return record;
            };
            const record = object.interfaceFor(iid);
            if (!record)
            {
                const passed = await delegated(state, iid, thread);
                object.release();
                if (passed.pointer !== 0)
                {
                    await release(passed.pointer, thread);
                }
                return passed.hr < 0 ? passed.hr : E_NOINTERFACE;
            }
            writeU32(out, env.publish(object, iid) >>> 0);
            return S_OK;
        },

    };
}
