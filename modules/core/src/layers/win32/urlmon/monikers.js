/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * URL monikers: the names urlmon gives what a URL locates, and the binding
 * that hands the bytes there to a program's IBindStatusCallback.
 *
 * An ActiveX control that loads its content by URL - Flash Player, a
 * WebBrowser - names even a file on the local disk this way
 * (file:///C|/...), registers its callback in a bind context and binds the
 * moniker to a stream. A `file:` URL, or a plain path, binds to the file the
 * volume holds, through the same stream SHCreateStreamOnFileW opens. Nothing
 * here reaches a network: another scheme is answered as a resource not
 * found, through the callback as urlmon reports a failed download, and said
 * once.
 *
 * A bind the callback asks to be asynchronous (BINDF_ASYNCHRONOUS) answers
 * MK_S_ASYNCHRONOUS once OnStartBinding has been told, and the rest - the
 * progress, the data, OnStopBinding - comes later from the thread's message
 * loop, through a hidden window posted to, as urlmon delivers it: a program
 * sets up its state for the bind after the call returns. A synchronous bind
 * tells the callback everything inside the call and answers the stream.
 */

import { pathFromFileUrl } from '../shlwapi/path.js';

const S_OK = 0;
const S_FALSE = 1;
const E_NOTIMPL = 0x80004001 | 0;
const E_NOINTERFACE = 0x80004002 | 0;
const E_ABORT = 0x80004004 | 0;
const E_INVALIDARG = 0x80070057 | 0;
const E_OUTOFMEMORY = 0x8007000e | 0;
const MK_S_ASYNCHRONOUS = 0x000401e8;
const MK_S_REDUCED_TO_SELF = 0x000401e2;
const MK_E_NOINVERSE = 0x800401ec | 0;
const MK_E_UNAVAILABLE = 0x800401e3 | 0;
const INET_E_RESOURCE_NOT_FOUND = 0x800c0005 | 0;
const INET_E_DOWNLOAD_FAILURE = 0x800c0008 | 0;

export const CLSID_STD_URL_MONIKER = '{79EAC9E0-BAF9-11CE-8C82-00AA004BA90B}';
const IID_IMONIKER = '{0000000F-0000-0000-C000-000000000046}';
const IID_IPERSIST = '{0000010C-0000-0000-C000-000000000046}';
const IID_IPERSISTSTREAM = '{00000109-0000-0000-C000-000000000046}';
const IID_IASYNCMONIKER = '{79EAC9D3-BAF9-11CE-8C82-00AA004BA90B}';
const IID_IBINDING = '{79EAC9C0-BAF9-11CE-8C82-00AA004BA90B}';
const IID_IBINDSTATUSCALLBACK = '{79EAC9C1-BAF9-11CE-8C82-00AA004BA90B}';
const IID_ISTREAM = '{0000000C-0000-0000-C000-000000000046}';

/** MKSYS_URLMONIKER: what IsSystemMoniker names a URL moniker. */
const MKSYS_URLMONIKER = 6;
/** The object parameter a bind context holds the callback under. */
export const BSCB_HOLDER = '_BSCB_Holder_';

const BINDF_ASYNCHRONOUS = 0x1;
const BSCF_FIRSTDATANOTIFICATION = 0x1;
const BSCF_LASTDATANOTIFICATION = 0x4;
const BSCF_DATAFULLYAVAILABLE = 0x8;
const BINDSTATUS_BEGINDOWNLOADDATA = 4;
const BINDSTATUS_ENDDOWNLOADDATA = 6;
const BINDSTATUS_CACHEFILENAMEAVAILABLE = 14;
const TYMED_NULL = 0;
const TYMED_HGLOBAL = 1;
const TYMED_FILE = 2;
const TYMED_ISTREAM = 4;
const TYMED_ISTORAGE = 8;
const DV_E_TYMED = 0x80040069 | 0;
const GMEM_MOVEABLE = 0x2;
const DVASPECT_CONTENT = 1;
const STGM_READ = 0;
const STGM_SHARE_DENY_WRITE = 0x20;
/** BINDINFO as Internet Explorer 6 and later lay it out. */
const BINDINFO_SIZE = 84;
const WM_USER = 0x400;

/** IUnknown's three, then: */
const SLOT = Object.freeze({
    RELEASE: 2,
    // IBindCtx
    REGISTER_OBJECT_PARAM: 9, GET_OBJECT_PARAM: 10, REVOKE_OBJECT_PARAM: 12,
    // IUnknown
    QUERY_INTERFACE: 0, ADD_REF: 1,
    // IBindStatusCallback
    ON_START_BINDING: 3, ON_PROGRESS: 6, ON_STOP_BINDING: 7, GET_BIND_INFO: 8,
    ON_DATA_AVAILABLE: 9,
    // IStream
    STAT: 12,
});

/**
 * A URL as urlmon keeps it: a path of the local disk made a `file:` URL, any
 * other string kept as written; one with no scheme of its own taken relative
 * to the context's, as a link in a page is.
 *
 * @param {string} url @param {string | null} context
 */
export function canonicalUrl(url, context){
    if (/^[a-z]:[\\/]/i.test(url) || url.startsWith('\\\\'))
    {
        return `file:///${url.replace(/\\/g, '/')}`;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(url) || context === null)
    {
        return url;
    }
    const base = context.slice(0, context.lastIndexOf('/') + 1);
    return url.startsWith('/') ? `${base.slice(0, base.indexOf('/', base.indexOf('//') + 2))}${url}`
        : `${base}${url}`;
}

/**
 * The path of the local disk a `file:` URL names, as PathCreateFromUrl reads
 * it (file:///C|/..., file://\C|\... as a program joins one onto a path), or
 * null for another scheme.
 *
 * @param {string} url
 */
export const fileUrlPath = url=>pathFromFileUrl(url, code=>String.fromCharCode(code));

/** @param {string} text */
const wide = text=>{
    const bytes = new Uint8Array(text.length * 2 + 2);
    for (let i = 0; i < text.length; i++)
    {
        bytes[i * 2] = text.charCodeAt(i) & 0xff;
        bytes[i * 2 + 1] = text.charCodeAt(i) >> 8;
    }
    return bytes;
};

/**
 * @typedef {Object} UrlmonHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readWideString
 * @property {{ allocate: (bytes: number) => number, free: (address: number) => unknown }} heap
 * @property {{ publish: (object: any, interfaceId: string) => number }} vtables
 * @property {(clsid: string, definition: import('../ole32/objects.js').ComClassDefinition)
 *     => any} makeObject  an object of ours, holding one reference
 * @property {(entry: number, args: number[], thread?: unknown) => Promise<number>} call
 *     guest code at `entry`, on the calling thread
 * @property {() => unknown} callerThread
 * @property {(library: string, name: string, args: number[], thread?: unknown)
 *     => number | Promise<number> | null} system  another library's export
 * @property {{ create: (handler: (message: number) => number | Promise<number>)
 *     => number | Promise<number>, post: (window: number, message: number) => unknown }} [window]
 *     a hidden window on the calling thread, whose posted messages run `handler`
 * @property {(api: string, detail: string) => void} [divergence]
 */

/**
 * @param {UrlmonHost} host
 */
export function createUrlMonikers(host){
    /** @param {number} address */
    const readU32 = address=>{
        const bytes = host.readMemory(address >>> 0, 4);
        return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
    };
    /** @param {number} address @param {number} value */
    const writeU32 = (address, value)=>{
        if ((address >>> 0) !== 0)
        {
            host.writeMemory(address >>> 0, new Uint8Array(new Uint32Array([value >>> 0]).buffer));
        }
    };
    /**
     * @param {number} pointer @param {number} slot @param {number[]} args @param {unknown} thread
     */
    const callMethod = async(pointer, slot, args, thread)=>
        (await host.call(readU32(readU32(pointer) + slot * 4), [pointer >>> 0, ...args],
            thread)) | 0;
    /** @param {number} pointer @param {unknown} thread */
    const release = (pointer, thread)=>((pointer >>> 0) === 0 ? Promise.resolve(0)
        : callMethod(pointer, SLOT.RELEASE, [], thread));
    /**
     * Guest memory for the length of `body`, zeroed.
     *
     * @template T
     * @param {number} size @param {(at: number) => Promise<T>} body @param {T} failed
     */
    const lend = async(size, body, failed)=>{
        const at = host.heap.allocate(size) >>> 0;
        if (at === 0)
        {
            return failed;
        }
        try
        {
            host.writeMemory(at, new Uint8Array(size));
            return await body(at);
        }
        finally
        {
            host.heap.free(at);
        }
    };
    /** @param {string} text @param {(at: number) => Promise<number>} body */
    const lendWide = (text, body)=>{
        const bytes = wide(text);
        return lend(bytes.length, at=>{
            host.writeMemory(at, bytes);
            return body(at);
        }, E_OUTOFMEMORY);
    };
    /** @type {Set<string>} */
    const said = new Set();
    /** @param {string} api @param {string} detail */
    const diverge = (api, detail)=>{
        if (!said.has(`${api}\0${detail}`))
        {
            said.add(`${api}\0${detail}`);
            host.divergence?.(api, detail);
        }
    };

    /** The URL monikers made here, by their IMoniker pointer. @type {Map<number, string>} */
    const urls = new Map();

    /** @param {string} iid */
    const iidBytes = iid=>{
        const hex = iid.replace(/[{}-]/g, '');
        const bytes = new Uint8Array(16);
        const view = new DataView(bytes.buffer);
        view.setUint32(0, parseInt(hex.slice(0, 8), 16), true);
        view.setUint16(4, parseInt(hex.slice(8, 12), 16), true);
        view.setUint16(6, parseInt(hex.slice(12, 16), 16), true);
        for (let i = 0; i < 8; i++)
        {
            bytes[8 + i] = parseInt(hex.slice(16 + i * 2, 18 + i * 2), 16);
        }
        return bytes;
    };

    /**
     * The callback a bind context holds, as IBindStatusCallback, holding a
     * reference; 0 when it holds none.
     *
     * @param {number} context @param {unknown} thread
     */
    const callbackOf = (context, thread)=>lendWide(BSCB_HOLDER, name=>lend(4, async out=>{
        const hr = await callMethod(context, SLOT.GET_OBJECT_PARAM, [name, out], thread);
        const unknown = hr >= 0 ? readU32(out) : 0;
        if (unknown === 0)
        {
            return 0;
        }
        const iid = iidBytes(IID_IBINDSTATUSCALLBACK);
        const found = await lend(20, async at=>{
            host.writeMemory(at, iid);
            const answer = await callMethod(unknown, SLOT.QUERY_INTERFACE, [at, at + 16], thread);
            return answer >= 0 ? readU32(at + 16) : 0;
        }, 0);
        await release(unknown, thread);
        return found;
    }, 0));

    /** IBinding: what a callback is handed to abort a bind with. */
    const makeBinding = ()=>{
        const state = { aborted: false };
        const object = createBinding(state);
        return { state, pointer: host.vtables.publish(object, IID_IBINDING) >>> 0 };
    };
    /** @type {(state: { aborted: boolean }) => any} */
    let createBinding = ()=>null;

    /**
     * Opens what a URL names as a stream, holding one reference, or answers
     * why it cannot.
     *
     * @param {string} url @param {unknown} thread
     * @returns {Promise<{ hr: number, stream: number, path: string | null }>}
     */
    const openStream = async(url, thread)=>{
        const path = fileUrlPath(url);
        if (path === null)
        {
            diverge('URL moniker', `${url.split(':')[0]}: is not fetched here: answered as a`
                + ' resource not found');
            return { hr: INET_E_RESOURCE_NOT_FOUND, stream: 0, path };
        }
        const opened = await lendWide(path, name=>lend(4, async out=>{
            const hr = (await host.system('SHLWAPI.dll', 'SHCreateStreamOnFileW',
                [name, STGM_READ | STGM_SHARE_DENY_WRITE, out], thread) ?? E_NOTIMPL) | 0;
            return hr >= 0 ? readU32(out) : 0;
        }, 0));
        return opened === 0 ? { hr: INET_E_RESOURCE_NOT_FOUND, stream: 0, path }
            : { hr: S_OK, stream: opened, path };
    };

    /** @param {number} stream @param {unknown} thread */
    const sizeOf = (stream, thread)=>lend(80, async at=>{
        // STATFLAG_NONAME: the size alone, no name to free.
        const hr = await callMethod(stream, SLOT.STAT, [at, 1], thread);
        return hr >= 0 ? readU32(at + 8) : 0;
    }, 0);

    /**
     * What a bind tells its callback after OnStartBinding: where the file is,
     * the data in one notification, and the end - or, for a URL that could not
     * be opened or a bind aborted, the end alone with why.
     *
     * @param {{ callback: number, binding: { state: { aborted: boolean }, pointer: number },
     *     url: string, opened: { hr: number, stream: number, path: string | null } }} bind
     * @param {unknown} thread
     */
    const finish = async({ callback, binding, url, opened }, thread)=>{
        let hr = binding.state.aborted ? E_ABORT : opened.hr;
        if (hr >= 0)
        {
            const size = await sizeOf(opened.stream, thread);
            const progress = (/** @type {number} */ code, /** @type {string} */ text)=>
                lendWide(text, at=>callMethod(callback, SLOT.ON_PROGRESS, [size, size, code, at],
                    thread));
            await progress(BINDSTATUS_CACHEFILENAMEAVAILABLE, opened.path ?? url);
            await progress(BINDSTATUS_BEGINDOWNLOADDATA, url);
            await progress(BINDSTATUS_ENDDOWNLOADDATA, url);
            if (!binding.state.aborted)
            {
                await lend(32, async at=>{
                    // FORMATETC { cfFormat 0, ptd null, dwAspect, lindex -1, tymed },
                    // then STGMEDIUM { tymed, pstm, pUnkForRelease null }.
                    writeU32(at + 8, DVASPECT_CONTENT);
                    writeU32(at + 12, 0xffffffff);
                    writeU32(at + 16, TYMED_ISTREAM);
                    writeU32(at + 20, TYMED_ISTREAM);
                    writeU32(at + 24, opened.stream);
                    return callMethod(callback, SLOT.ON_DATA_AVAILABLE, [BSCF_FIRSTDATANOTIFICATION
                        | BSCF_LASTDATANOTIFICATION | BSCF_DATAFULLYAVAILABLE, size, at, at + 20],
                    thread);
                }, 0);
            }
            hr = binding.state.aborted ? E_ABORT : S_OK;
        }
        await callMethod(callback, SLOT.ON_STOP_BINDING, [hr, 0], thread);
        await release(opened.stream, thread);
        await release(binding.pointer, thread);
        await release(callback, thread);
    };

    /** Binds waiting for the message loop, by the hidden window of their thread. */
    /** @type {Map<number, (() => Promise<unknown>)[]>} */
    const queued = new Map();
    /** The hidden window each thread delivers through, made on first use. */
    /** @type {Map<unknown, number>} */
    const windows = new Map();
    /**
     * @param {unknown} thread @param {() => Promise<unknown>} work
     * @returns {Promise<boolean>} false where there is no window to post to
     */
    const later = async(thread, work)=>{
        if (!host.window)
        {
            return false;
        }
        let hwnd = windows.get(thread) ?? 0;
        if (hwnd === 0)
        {
            hwnd = (await host.window.create(async()=>{
                const due = queued.get(hwnd) ?? [];
                queued.set(hwnd, []);
                for (const next of due)
                {
                    await next();
                }
                return 0;
            })) >>> 0;
            if (hwnd === 0)
            {
                return false;
            }
            windows.set(thread, hwnd);
        }
        const due = queued.get(hwnd) ?? [];
        due.push(work);
        queued.set(hwnd, due);
        host.window.post(hwnd, WM_USER);
        return true;
    };

    /**
     * IMoniker::BindToStorage on a URL moniker.
     *
     * @param {string} url @param {number[]} args
     */
    const bindToStorage = async(url, [context, , iidAt, out])=>{
        const thread = host.callerThread();
        writeU32(out, 0);
        const iid = [...host.readMemory(iidAt >>> 0, 16)].join(',');
        if (iid !== [...iidBytes(IID_ISTREAM)].join(','))
        {
            diverge('IMoniker::BindToStorage', 'a URL moniker binds to a stream alone');
            return E_NOINTERFACE;
        }
        const callback = (context >>> 0) === 0 ? 0 : await callbackOf(context, thread);
        if (callback === 0)
        {
            const opened = await openStream(url, thread);
            writeU32(out, opened.stream);
            return opened.hr;
        }
        const bindFlags = await lend(4 + BINDINFO_SIZE, async at=>{
            writeU32(at + 4, BINDINFO_SIZE);
            await callMethod(callback, SLOT.GET_BIND_INFO, [at, at + 4], thread);
            return readU32(at);
        }, 0);
        const binding = makeBinding();
        await callMethod(callback, SLOT.ON_START_BINDING, [0, binding.pointer], thread);
        const opened = await openStream(url, thread);
        const bind = { callback, binding, url, opened };
        if ((bindFlags & BINDF_ASYNCHRONOUS) !== 0
            && await later(thread, ()=>finish(bind, host.callerThread())))
        {
            return MK_S_ASYNCHRONOUS;
        }
        // Handed to the caller as well, with a reference of its own.
        if (opened.stream !== 0)
        {
            await callMethod(opened.stream, SLOT.ADD_REF, [], thread);
            writeU32(out, opened.stream);
        }
        await finish(bind, thread);
        return opened.hr;
    };

    /**
     * The IMoniker methods after IUnknown's, in vtable order, of the moniker
     * whose URL `urlOf` answers.
     *
     * @param {() => string} urlOf @param {() => number} self
     * @returns {import('../ole32/objects.js').ComMethod[]}
     */
    const monikerMethods = (urlOf, self)=>{
        /** @type {(name: string, words: number, invoke: (args: number[]) => number
         *     | Promise<number>) => import('../ole32/objects.js').ComMethod} */
        const method = (name, words, invoke)=>({ name, argBytes: 4 + words * 4,
            invoke: (_, args)=>invoke(args) });
        /** @param {string} name @param {number} words @param {number} answer */
        const refused = (name, words, answer)=>method(name, words, ()=>{
            diverge(`IMoniker::${name}`, 'a URL moniker does not answer it here');
            return answer;
        });
        return [
            method('GetClassID', 1, ([out])=>{
                host.writeMemory(out >>> 0, iidBytes(CLSID_STD_URL_MONIKER));
                return S_OK;
            }),
            method('IsDirty', 0, ()=>S_FALSE),
            refused('Load', 1, E_NOTIMPL),
            refused('Save', 2, E_NOTIMPL),
            refused('GetSizeMax', 1, E_NOTIMPL),
            refused('BindToObject', 4, E_NOTIMPL),
            method('BindToStorage', 4, args=>bindToStorage(urlOf(), args)),
            method('Reduce', 4, async([, , , out])=>{
                await callMethod(self(), SLOT.ADD_REF, [], host.callerThread());
                writeU32(out, self());
                return MK_S_REDUCED_TO_SELF;
            }),
            refused('ComposeWith', 3, E_NOTIMPL),
            method('Enum', 2, ([, out])=>{
                writeU32(out, 0);
                return S_OK;
            }),
            method('IsEqual', 1, ([other])=>(urls.get(other >>> 0) === urlOf() ? S_OK : S_FALSE)),
            method('Hash', 1, ([out])=>{
                let hash = 0;
                for (const unit of urlOf())
                {
                    hash = (Math.imul(hash, 31) + unit.charCodeAt(0)) | 0;
                }
                writeU32(out, hash);
                return S_OK;
            }),
            method('IsRunning', 3, ()=>S_FALSE),
            method('GetTimeOfLastChange', 3, ()=>MK_E_UNAVAILABLE),
            method('Inverse', 1, ([out])=>{
                writeU32(out, 0);
                return MK_E_NOINVERSE;
            }),
            refused('CommonPrefixWith', 2, E_NOTIMPL),
            refused('RelativePathTo', 2, E_NOTIMPL),
            method('GetDisplayName', 3, ([, , out])=>{
                const bytes = wide(urlOf());
                const at = host.heap.allocate(bytes.length) >>> 0;
                writeU32(out, at);
                if (at === 0)
                {
                    return E_OUTOFMEMORY;
                }
                host.writeMemory(at, bytes);
                return S_OK;
            }),
            refused('ParseDisplayName', 5, E_NOTIMPL),
            method('IsSystemMoniker', 1, ([out])=>{
                writeU32(out, MKSYS_URLMONIKER);
                return S_OK;
            }),
        ];
    };

    /** @param {string} url @returns {Promise<number>} its IMoniker pointer, or 0 */
    const makeMoniker = async url=>{
        let pointer = 0;
        const methods = monikerMethods(()=>url, ()=>pointer);
        const persistMethods = methods.slice(0, 5);
        const object = host.makeObject(CLSID_STD_URL_MONIKER, {
            interfaces: [
                { id: IID_IMONIKER, methods },
                { id: IID_IPERSISTSTREAM, methods: persistMethods },
                { id: IID_IPERSIST, methods: methods.slice(0, 1) },
                { id: IID_IASYNCMONIKER, methods: [] },
            ],
            destroy: ()=>urls.delete(pointer),
        });
        pointer = host.vtables.publish(object, IID_IMONIKER) >>> 0;
        if (pointer !== 0)
        {
            urls.set(pointer, url);
        }
        return pointer;
    };

    createBinding = state=>host.makeObject('{00000000-0000-0000-0000-000000000000}', {
        interfaces: [{ id: IID_IBINDING, methods: [
            { name: 'Abort', argBytes: 4, invoke: ()=>{
                state.aborted = true;
                return S_OK;
            } },
            { name: 'Suspend', argBytes: 4, invoke: ()=>E_NOTIMPL },
            { name: 'Resume', argBytes: 4, invoke: ()=>E_NOTIMPL },
            { name: 'SetPriority', argBytes: 8, invoke: ()=>S_OK },
            { name: 'GetPriority', argBytes: 8, invoke: (_, [out])=>{
                writeU32(out, 0);
                return S_OK;
            } },
            { name: 'GetBindResult', argBytes: 20, invoke: (_, [clsid, result, text])=>{
                if ((clsid >>> 0) !== 0)
                {
                    host.writeMemory(clsid >>> 0, new Uint8Array(16));
                }
                writeU32(result, 0);
                writeU32(text, 0);
                return S_OK;
            } },
        ] }],
    });

    return {
        /** HRESULT CreateURLMoniker(IMoniker *pmkContext, LPCWSTR szURL, IMoniker **ppmk) */
        CreateURLMoniker: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: async([context, urlAt, out])=>{
                if ((urlAt >>> 0) === 0 || (out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const url = canonicalUrl(host.readWideString(urlAt >>> 0, 0x8000),
                    urls.get(context >>> 0) ?? null);
                const pointer = await makeMoniker(url);
                writeU32(out, pointer);
                return pointer === 0 ? E_OUTOFMEMORY : S_OK;
            },
        },

        /**
         * HRESULT RegisterBindStatusCallback(IBindCtx *pbc, IBindStatusCallback *pbsc,
         *     IBindStatusCallback **ppbscPrevious, DWORD dwReserved)
         */
        RegisterBindStatusCallback: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: async([context, callback, previousOut])=>{
                if ((context >>> 0) === 0 || (callback >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const thread = host.callerThread();
                const previous = await callbackOf(context, thread);
                if ((previousOut >>> 0) !== 0)
                {
                    writeU32(previousOut, previous);
                }
                else
                {
                    await release(previous, thread);
                }
                return lendWide(BSCB_HOLDER, name=>callMethod(context, SLOT.REGISTER_OBJECT_PARAM,
                    [name, callback], thread));
            },
        },

        /**
         * HRESULT CreateAsyncBindCtx(DWORD reserved, IBindStatusCallback *pBSCb,
         *     IEnumFORMATETC *pEFetc, IBindCtx **ppBC)
         *
         * A bind context, as CreateBindCtx makes it, with the callback
         * registered on it as RegisterBindStatusCallback registers one. A
         * format enumerator is not kept, said once: the media a bind offers
         * here are its own.
         */
        CreateAsyncBindCtx: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: async([, callback, formats, out])=>{
                if ((callback >>> 0) === 0 || (out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                writeU32(out, 0);
                const thread = host.callerThread();
                const made = await lend(4, async at=>{
                    const hr = (await host.system('ole32.dll', 'CreateBindCtx', [0, at], thread)
                        ?? E_NOTIMPL) | 0;
                    return hr < 0 ? hr : readU32(at);
                }, E_OUTOFMEMORY);
                if (made < 0 || made === 0)
                {
                    return made === 0 ? E_OUTOFMEMORY : made;
                }
                if ((formats >>> 0) !== 0)
                {
                    diverge('CreateAsyncBindCtx', 'the format enumerator is not kept');
                }
                const hr = await lendWide(BSCB_HOLDER, name=>callMethod(made,
                    SLOT.REGISTER_OBJECT_PARAM, [name, callback], thread));
                if (hr < 0)
                {
                    await release(made, thread);
                    return hr;
                }
                writeU32(out, made);
                return S_OK;
            },
        },

        /**
         * HRESULT IsAsyncMoniker(IMoniker *pmk)
         *
         * S_OK for a moniker that binds asynchronously - one that answers
         * IMonikerAsync, as a URL moniker does - S_FALSE for another.
         */
        IsAsyncMoniker: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: async([moniker])=>{
                if ((moniker >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const thread = host.callerThread();
                return lend(20, async at=>{
                    host.writeMemory(at, iidBytes(IID_IASYNCMONIKER));
                    const answer = await callMethod(moniker, SLOT.QUERY_INTERFACE, [at, at + 16],
                        thread);
                    if (answer < 0)
                    {
                        return S_FALSE;
                    }
                    await release(readU32(at + 16), thread);
                    return S_OK;
                }, E_OUTOFMEMORY);
            },
        },

        /**
         * HRESULT CopyStgMedium(const STGMEDIUM *pcstgmedSrc, STGMEDIUM *pstgmedDest)
         *
         * The medium copied with what it holds made the copy's own: an
         * interface given a reference, a global block or a file name copied.
         * A GDI handle or a metafile is refused, said once.
         */
        CopyStgMedium: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: async([source, target])=>{
                if ((source >>> 0) === 0 || (target >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const thread = host.callerThread();
                const kind = readU32(source);
                let handle = readU32(source + 4);
                const forRelease = readU32(source + 8);
                if (kind === TYMED_ISTREAM || kind === TYMED_ISTORAGE)
                {
                    if (handle !== 0)
                    {
                        await callMethod(handle, SLOT.ADD_REF, [], thread);
                    }
                }
                else if (kind === TYMED_HGLOBAL && handle !== 0)
                {
                    const kernel32 = async(/** @type {string} */ name, /** @type {number[]} */ args)=>
                        (await host.system('KERNEL32.dll', name, args, thread) ?? 0) >>> 0;
                    const size = await kernel32('GlobalSize', [handle]);
                    const copy = await kernel32('GlobalAlloc', [GMEM_MOVEABLE, size]);
                    if (copy === 0)
                    {
                        return E_OUTOFMEMORY;
                    }
                    const from = await kernel32('GlobalLock', [handle]);
                    const to = await kernel32('GlobalLock', [copy]);
                    host.writeMemory(to, host.readMemory(from, size).slice());
                    await kernel32('GlobalUnlock', [copy]);
                    await kernel32('GlobalUnlock', [handle]);
                    handle = copy;
                }
                else if (kind === TYMED_FILE && handle !== 0)
                {
                    const bytes = wide(host.readWideString(handle, 0x8000));
                    const copy = host.heap.allocate(bytes.length) >>> 0;
                    if (copy === 0)
                    {
                        return E_OUTOFMEMORY;
                    }
                    host.writeMemory(copy, bytes);
                    handle = copy;
                }
                else if (kind !== TYMED_NULL)
                {
                    diverge('CopyStgMedium', `a medium of TYMED ${kind} is not copied here`);
                    return DV_E_TYMED;
                }
                if (forRelease !== 0)
                {
                    await callMethod(forRelease, SLOT.ADD_REF, [], thread);
                }
                writeU32(target, kind);
                writeU32(target + 4, handle);
                writeU32(target + 8, forRelease);
                return S_OK;
            },
        },

        /**
         * HRESULT HlinkSimpleNavigateToMoniker(IMoniker *pmkTarget, LPCWSTR szLocation,
         *     LPCWSTR szTargetFrameName, IUnknown *pUnk, IBindCtx *pbc,
         *     IBindStatusCallback *, DWORD grfHLNF, DWORD dwReserved)
         *
         * Opening a link in the user's browser: there is none to open it in,
         * so the link is taken and said once.
         */
        HlinkSimpleNavigateToMoniker: {
            argBytes: 32,
            /** @param {number[]} args */
            handler: ([target])=>{
                const url = urls.get(target >>> 0) ?? 'a moniker not made here';
                diverge('HlinkSimpleNavigateToMoniker', `a link is not opened: ${url}`);
                return S_OK;
            },
        },

        /**
         * HRESULT URLDownloadToFileW(LPUNKNOWN pCaller, LPCWSTR szURL, LPCWSTR szFileName,
         *     DWORD dwReserved, LPBINDSTATUSCALLBACK lpfnCB)
         *
         * A file: URL copied to the file named; another scheme is not
         * fetched here, INET_E_DOWNLOAD_FAILURE, said once. The callback is
         * not told of the copy.
         */
        URLDownloadToFileW: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: async([, urlAt, target])=>{
                if ((urlAt >>> 0) === 0 || (target >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const url = canonicalUrl(host.readWideString(urlAt >>> 0, 0x8000), null);
                const path = fileUrlPath(url);
                if (path === null)
                {
                    diverge('URLDownloadToFileW', `${url.split(':')[0]}: is not fetched here`);
                    return INET_E_DOWNLOAD_FAILURE;
                }
                const copied = await lendWide(path, from=>Promise.resolve(host.system(
                    'KERNEL32.dll', 'CopyFileW', [from, target, 0], host.callerThread()) ?? 0));
                return copied !== 0 ? S_OK : INET_E_DOWNLOAD_FAILURE;
            },
        },

        /** HRESULT RevokeBindStatusCallback(IBindCtx *pbc, IBindStatusCallback *pbsc) */
        RevokeBindStatusCallback: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([context, callback])=>((context >>> 0) === 0 || (callback >>> 0) === 0
                ? E_INVALIDARG
                : lendWide(BSCB_HOLDER, name=>callMethod(context, SLOT.REVOKE_OBJECT_PARAM,
                    [name], host.callerThread()))),
        },
    };
}
