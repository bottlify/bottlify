/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * shlwapi's helpers over a program's own COM objects: each is a few method
 * calls through the object's vtable, made as guest calls on the thread that
 * asked. Among them the references a thread and the process hold to keep
 * someone alive - a thread's, and Explorer's, which a shell extension's
 * worker takes to keep its host from ending under it.
 */

import { IID_IUNKNOWN, IUNKNOWN_METHODS } from '../ole32/objects.js';
import { parseGuid } from '../ole32/guid.js';
import { forwarded, wholeAddress } from '../common/pointers.js';

const S_OK = 0;
const E_FAIL = 0x80004005 | 0;
const E_NOINTERFACE = 0x80004002 | 0;
const E_INVALIDARG = 0x80070057 | 0;
const E_OUTOFMEMORY = 0x8007000e | 0;

/** The vtable slots these call: IUnknown's three, then IServiceProvider's one. */
const SLOT_QUERY_INTERFACE = 0;
const SLOT_ADD_REF = 1;
const SLOT_RELEASE = 2;
const SLOT_QUERY_SERVICE = 3;

/** IID_IServiceProvider, {6d5140c1-7436-11ce-8034-00aa006009fa}, as the structure holds it. */
const IID_ISERVICEPROVIDER = Uint8Array.from([
    0xc1, 0x40, 0x51, 0x6d, 0x36, 0x74, 0xce, 0x11,
    0x80, 0x34, 0x00, 0xaa, 0x00, 0x60, 0x09, 0xfa,
]);

/** IBindCtx::GetObjectParam and IPersist::GetClassID. */
const SLOT_GET_OBJECT_PARAM = 10;
const SLOT_GET_CLASS_ID = 3;
const E_POINTER = 0x80004003 | 0;

/** @param {string} text  a GUID in braces @returns {Uint8Array} its bytes, as REFIID points at */
const iidBytes = text=>/** @type {Uint8Array} */ (parseGuid(text));
const IID_IUNKNOWN_BYTES = iidBytes('{00000000-0000-0000-C000-000000000046}');
const IID_IPERSIST = iidBytes('{0000010C-0000-0000-C000-000000000046}');
const IID_IOLEWINDOW = iidBytes('{00000114-0000-0000-C000-000000000046}');
const IID_IOBJECTWITHSITE = iidBytes('{FC4801A3-2BA9-11CF-A229-00AA003D7352}');
const IID_IINTERNETSECURITYMANAGER = iidBytes('{79EAC9EE-BAF9-11CE-8C82-00AA004BA90B}');
const IID_IINTERNETSECURITYMGRSITE = iidBytes('{79EAC9ED-BAF9-11CE-8C82-00AA004BA90B}');
const IID_ISHELLSERVICE = iidBytes('{5836FB00-8187-11CF-A12B-00AA004AE837}');
const IID_IOLECOMMANDTARGET = iidBytes('{B722BCCB-4E68-101B-A2BC-00AA00404770}');
const IID_IINPUTOBJECT = iidBytes('{68284FAA-6A48-11D0-8C78-00C04FD918B4}');
const IID_IINPUTOBJECTSITE = iidBytes('{F1DB8392-7331-11D0-8C99-00A0C92DBFE8}');
const IID_IOLECONTROLSITE = iidBytes('{B196B289-BAB4-101A-B69C-00AA00341D07}');
const IID_IPERSISTPROPERTYBAG = iidBytes('{37D84F60-42CB-11CE-8135-00AA004BB851}');
const SID_SWEBBROWSERAPP = iidBytes('{0002DF05-0000-0000-C000-000000000046}');

/** The ordinals these are exported by (Wine's shlwapi.spec). */
export const UNKNOWN_ORDINALS = Object.freeze({ 169: 'IUnknown_AtomicRelease',
    176: 'IUnknown_QueryService', 199: 'IUnknown_Set', 163: 'IUnknown_QueryStatus',
    164: 'IUnknown_Exec', 171: 'SHIsSameObject', 172: 'IUnknown_GetWindow',
    173: 'IUnknown_SetOwner', 174: 'IUnknown_SetSite', 187: 'SHLoadFromPropertyBag',
    188: 'IUnknown_TranslateAcceleratorOCS', 189: 'IUnknown_OnFocusOCS', 200: 'MayQSForward',
    201: 'MayExecForward', 219: 'QISearch', 256: 'IUnknown_GetSite',
    267: 'SHWeakQueryInterface', 268: 'SHWeakReleaseInterface', 404: 'IShellFolder_EnumObjects',
    478: 'IUnknown_TranslateAcceleratorIO', 479: 'IUnknown_UIActivateIO',
    481: 'IUnknown_HasFocusIO', 509: 'IUnknown_OnFocusChangeIS',
    538: 'IUnknown_QueryServiceForWebBrowserApp', 16: 'SHCreateThread' });

/**
 * @typedef {Object} UnknownHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(bytes: number) => number} allocate
 * @property {(address: number) => void} free
 * @property {(entry: number, args: number[], thread: unknown) => Promise<number> | number} call
 *           A guest function called with these arguments on that thread.
 * @property {() => unknown} callerThread  The thread whose call this is.
 * @property {(object: any, iid: string) => number} [publish]  An object of the
 *           engine's own as the interface pointer a program is handed, 0 when
 *           none can be published.
 * @property {(library: string) => Record<string, { handler: (args: number[]) => any }> | undefined}
 *     [library]  kernel32, whose CreateThread SHCreateThread starts a thread with.
 * @property {(api: string, detail: string) => void} [divergence]
 */

/** SHCreateThread's flags. */
const CTF_INSIST = 0x1;
const CTF_THREAD_REF = 0x2;
const CTF_PROCESS_REF = 0x4;
const CTF_COINIT = 0x8;

/** @param {Uint8Array} bytes */
const u32 = bytes=>(bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;

/** @param {number} value */
const dword = value=>{
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
    return bytes;
};

/** @param {UnknownHost} host */
export function createUnknownFunctions(host){
    /**
     * A method of an object, `this` first, as a COM method takes it.
     *
     * @param {number} object @param {number} slot @param {number[]} args @param {unknown} thread
     */
    const callMethod = async(object, slot, args, thread)=>{
        const entry = u32(host.readMemory(u32(host.readMemory(object, 4)) + slot * 4, 4));
        return (await host.call(entry, [object, ...args], thread)) | 0;
    };

    /** @param {number} at */
    const readLong = at=>new DataView(host.readMemory(at, 4).slice().buffer).getInt32(0, true);

    /** The reference each thread was given to hold (SHSetThreadRef). @type {Map<unknown, number>} */
    const threadReferences = new Map();
    /** The one the process holds (SetProcessReference); 0 for none. */
    let processReference = 0;
    /** Said once: what SHCreateThread does not do of Windows'. */
    let threadShortfallSaid = false;

    /**
     * Hands out a reference someone holds, one more on it for the caller:
     * E_INVALIDARG with nowhere to put it, the absent answer with none held.
     *
     * @param {number} held @param {number} out @param {number} absent
     */
    const handOut = async(held, out, absent)=>{
        if ((out >>> 0) === 0)
        {
            return E_INVALIDARG;
        }
        host.writeMemory(wholeAddress(out), dword(held));
        if (held === 0)
        {
            return absent;
        }
        await callMethod(held, SLOT_ADD_REF, [], host.callerThread());
        return S_OK;
    };

    /** @type {Record<string, { argBytes: number, handler: (args: number[]) => any }>} */
    const table = {
        /**
         * void IUnknown_AtomicRelease(IUnknown **ppunk)
         *
         * The pointer cleared first and the object released after, so nothing
         * that runs while it goes finds it still there.
         */
        IUnknown_AtomicRelease: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: async([slot])=>{
                const object = (slot >>> 0) === 0 ? 0 : u32(host.readMemory(wholeAddress(slot), 4));
                if (object !== 0)
                {
                    host.writeMemory(wholeAddress(slot), dword(0));
                    await callMethod(object, SLOT_RELEASE, [], host.callerThread());
                }
                return 0;
            },
        },

        /**
         * void IUnknown_Set(IUnknown **ppunk, IUnknown *punk)
         *
         * The slot takes the new object, a reference added, and lets the old
         * one go after.
         */
        IUnknown_Set: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: async([slot, object])=>{
                const thread = host.callerThread();
                const old = u32(host.readMemory(wholeAddress(slot), 4));
                if (old === (object >>> 0))
                {
                    return 0;
                }
                if ((object >>> 0) !== 0)
                {
                    await callMethod(object >>> 0, SLOT_ADD_REF, [], thread);
                }
                host.writeMemory(wholeAddress(slot), dword(object >>> 0));
                if (old !== 0)
                {
                    await callMethod(old, SLOT_RELEASE, [], thread);
                }
                return 0;
            },
        },

        /**
         * HRESULT SHCreateThreadRef(LONG *pcRef, IUnknown **ppunk)
         *
         * An object whose count is the caller's LONG: set to one, raised and
         * lowered by AddRef and Release, which answer it, so the thread that
         * owns the LONG sees when the last holder let go.
         */
        SHCreateThreadRef: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([count, out])=>{
                if ((count >>> 0) === 0 || (out >>> 0) === 0)
                {
                    if ((out >>> 0) !== 0)
                    {
                        host.writeMemory(wholeAddress(out), dword(0));
                    }
                    return E_INVALIDARG;
                }
                if (!host.publish)
                {
                    host.writeMemory(wholeAddress(out), dword(0));
                    return E_OUTOFMEMORY;
                }
                host.writeMemory(wholeAddress(count), dword(1));
                const at = count >>> 0;
                const object = {
                    state: null,
                    /** @param {string} asked */
                    interfaceFor: asked=>(asked === IID_IUNKNOWN
                        ? { id: asked, methods: IUNKNOWN_METHODS } : null),
                    addRef(){
                        const next = readLong(at) + 1;
                        host.writeMemory(at, dword(next));
                        return next;
                    },
                    release(){
                        const next = readLong(at) - 1;
                        host.writeMemory(at, dword(next));
                        return Math.max(next, 0);
                    },
                    get refCount(){
                        return readLong(at);
                    },
                    get destroyed(){
                        return readLong(at) <= 0;
                    },
                };
                const pointer = host.publish(object, IID_IUNKNOWN) >>> 0;
                host.writeMemory(wholeAddress(out), dword(pointer));
                return pointer === 0 ? E_OUTOFMEMORY : S_OK;
            },
        },

        /**
         * HRESULT SHSetThreadRef(IUnknown *punk)
         *
         * The reference the calling thread holds, kept as it is given - no
         * reference added; NULL clears it.
         */
        SHSetThreadRef: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([object])=>{
                threadReferences.set(host.callerThread(), object >>> 0);
                return S_OK;
            },
        },

        /**
         * HRESULT SHGetThreadRef(IUnknown **ppunk)
         *
         * The calling thread's reference with one more on it, or NULL and
         * E_NOINTERFACE when it holds none.
         */
        SHGetThreadRef: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([out])=>handOut(threadReferences.get(host.callerThread()) ?? 0, out,
                E_NOINTERFACE),
        },

        /**
         * HRESULT SHReleaseThreadRef(void)
         *
         * The calling thread's reference released and forgotten; E_FAIL when
         * it holds none.
         */
        SHReleaseThreadRef: {
            argBytes: 0,
            handler: async()=>{
                const thread = host.callerThread();
                const held = threadReferences.get(thread) ?? 0;
                threadReferences.delete(thread);
                if (held === 0)
                {
                    return E_FAIL;
                }
                await callMethod(held, SLOT_RELEASE, [], thread);
                return S_OK;
            },
        },

        /**
         * void SetProcessReference(IUnknown *punk)
         *
         * The reference the process holds - Explorer's in Explorer - kept as
         * it is given; shell32's SHSetInstanceExplorer.
         */
        SetProcessReference: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([object])=>{
                processReference = object >>> 0;
                return 0;
            },
        },

        /**
         * HRESULT GetProcessReference(IUnknown **ppunk)
         *
         * The process's reference with one more on it; E_FAIL and NULL until
         * one was set, which in a process that is not Explorer is every time
         * unless the program set its own. shell32's SHGetInstanceExplorer.
         */
        GetProcessReference: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([out])=>handOut(processReference, out, E_FAIL),
        },

        /**
         * HRESULT IUnknown_QueryService(IUnknown *punk, REFGUID guidService,
         *   REFIID riid, void **ppvOut)
         *
         * The object's IServiceProvider asked for the service, and let go
         * after: whatever QueryInterface or QueryService answers is the
         * answer, and E_FAIL with no object or nowhere to put one, NULL
         * written first wherever there is somewhere, as Wine's conformance
         * tests have it.
         */
        IUnknown_QueryService: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: async([object, service, interfaceId, out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_FAIL;
                }
                host.writeMemory(wholeAddress(out), dword(0));
                if ((object >>> 0) === 0)
                {
                    return E_FAIL;
                }
                const thread = host.callerThread();
                const block = host.allocate(IID_ISERVICEPROVIDER.length + 4);
                if (block === 0)
                {
                    return E_OUTOFMEMORY;
                }
                try
                {
                    host.writeMemory(block, IID_ISERVICEPROVIDER);
                    const slot = block + IID_ISERVICEPROVIDER.length;
                    host.writeMemory(slot, dword(0));
                    const asked = await callMethod(object >>> 0, SLOT_QUERY_INTERFACE,
                        [block, slot], thread);
                    const provider = u32(host.readMemory(slot, 4));
                    if (asked !== S_OK || provider === 0)
                    {
                        return asked;
                    }
                    const answer = await callMethod(provider, SLOT_QUERY_SERVICE,
                        [service >>> 0, interfaceId >>> 0, out >>> 0], thread);
                    await callMethod(provider, SLOT_RELEASE, [], thread);
                    return answer;
                }
                finally
                {
                    host.free(block);
                }
            },
        },

        /**
         * HRESULT _SHGetInstanceExplorer(IUnknown **lppUnknown)
         *
         * The process's reference, as GetProcessReference hands it out.
         */
        /**
         * BOOL SHCreateThread(LPTHREAD_START_ROUTINE pfnThreadProc, void *pData,
         *     DWORD dwFlags, LPTHREAD_START_ROUTINE pfnCallback)
         *
         * The routine on a thread of its own, made by kernel32's CreateThread;
         * where none can be made, run here with CTF_INSIST and FALSE without.
         * The callback runs first and is answered before the thread starts,
         * on the caller's thread where Windows runs it on the new one, and
         * the thread is given no reference and no COM apartment of the
         * caller's: both said once.
         */
        SHCreateThread: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: async args=>{
                const [routine, , flags, callback] = args;
                // The routine's own parameter: whole to it, on either thread.
                const data = /** @type {number} */ (forwarded(args, 1));
                const thread = host.callerThread();
                if ((flags & (CTF_THREAD_REF | CTF_PROCESS_REF | CTF_COINIT)) !== 0
                    || (callback >>> 0) !== 0)
                {
                    if (!threadShortfallSaid)
                    {
                        threadShortfallSaid = true;
                        host.divergence?.('SHCreateThread', 'the callback runs on the caller\'s'
                            + ' thread, and the new thread holds no reference or apartment');
                    }
                }
                if ((callback >>> 0) !== 0)
                {
                    await host.call(callback >>> 0, [data], thread);
                }
                const create = host.library?.('KERNEL32.dll')?.CreateThread;
                const handle = create ? /** @type {number} */ (await create.handler([0, 0,
                    routine >>> 0, Number(data), 0, 0])) >>> 0 : 0;
                if (handle !== 0)
                {
                    await host.library?.('KERNEL32.dll')?.CloseHandle?.handler([handle]);
                    return 1;
                }
                if ((flags & CTF_INSIST) !== 0)
                {
                    await host.call(routine >>> 0, [data], thread);
                    return 1;
                }
                return 0;
            },
        },

        _SHGetInstanceExplorer: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([out])=>handOut(processReference, out, E_FAIL),
        },

        /**
         * HRESULT IUnknown_SetSite(IUnknown *obj, IUnknown *site)
         *
         * IObjectWithSite::SetSite, or where the object has none,
         * IInternetSecurityManager::SetSecuritySite.
         */
        IUnknown_SetSite: forward([IID_IOBJECTWITHSITE, IID_IINTERNETSECURITYMANAGER], 3, 8,
            ([, site])=>[site]),

        /**
         * HRESULT IUnknown_GetSite(LPUNKNOWN lpUnknown, REFIID iid, PVOID *lppSite)
         *
         * IObjectWithSite::GetSite; NULL written first.
         */
        IUnknown_GetSite: forward([IID_IOBJECTWITHSITE], 4, 12, ([, iid, out])=>[iid, out], 2),

        /**
         * HRESULT IUnknown_GetWindow(IUnknown *lpUnknown, HWND *lphWnd)
         *
         * IOleWindow::GetWindow, or IInternetSecurityMgrSite's.
         */
        IUnknown_GetWindow: forward([IID_IOLEWINDOW, IID_IINTERNETSECURITYMGRSITE], 3, 8,
            ([, out])=>[out], 1),

        /** HRESULT IUnknown_SetOwner(IUnknown *iface, IUnknown *pUnk): IShellService::SetOwner. */
        IUnknown_SetOwner: forward([IID_ISHELLSERVICE], 3, 8, ([, owner])=>[owner]),

        /**
         * HRESULT IUnknown_QueryStatus(IUnknown *lpUnknown, REFGUID pguidCmdGroup,
         *     ULONG cCmds, OLECMD *prgCmds, OLECMDTEXT *pCmdText)
         */
        IUnknown_QueryStatus: forward([IID_IOLECOMMANDTARGET], 3, 20, ([, ...rest])=>rest),

        /**
         * HRESULT IUnknown_Exec(IUnknown *lpUnknown, REFGUID pguidCmdGroup, DWORD nCmdID,
         *     DWORD nCmdexecopt, VARIANT *pvaIn, VARIANT *pvaOut)
         */
        IUnknown_Exec: forward([IID_IOLECOMMANDTARGET], 4, 24, ([, ...rest])=>rest),

        /**
         * HRESULT MayQSForward(IUnknown *lpUnknown, PVOID lpReserved, REFGUID riidCmdGrp,
         *     ULONG cCmds, OLECMD *prgCmds, OLECMDTEXT *pCmdText)
         *
         * IUnknown_QueryStatus, the reserved word passed over.
         */
        MayQSForward: forward([IID_IOLECOMMANDTARGET], 3, 24, ([, , ...rest])=>rest),

        /**
         * HRESULT MayExecForward(IUnknown *lpUnknown, INT iUnk, REFGUID pguidCmdGroup,
         *     DWORD nCmdID, DWORD nCmdexecopt, VARIANT *pvaIn, VARIANT *pvaOut)
         */
        MayExecForward: forward([IID_IOLECOMMANDTARGET], 4, 28, ([, , ...rest])=>rest),

        /** HRESULT IUnknown_UIActivateIO(IUnknown *unknown, BOOL activate, LPMSG msg) */
        IUnknown_UIActivateIO: forward([IID_IINPUTOBJECT], 3, 12, ([, ...rest])=>rest),
        /** HRESULT IUnknown_HasFocusIO(IUnknown *lpUnknown) */
        IUnknown_HasFocusIO: forward([IID_IINPUTOBJECT], 4, 4, ()=>[]),
        /** HRESULT IUnknown_TranslateAcceleratorIO(IUnknown *lpUnknown, LPMSG lpMsg) */
        IUnknown_TranslateAcceleratorIO: forward([IID_IINPUTOBJECT], 5, 8, ([, ...rest])=>rest),

        /**
         * HRESULT IUnknown_OnFocusChangeIS(LPUNKNOWN lpUnknown, LPUNKNOWN pFocusObject,
         *     BOOL bFocus)
         */
        IUnknown_OnFocusChangeIS: forward([IID_IINPUTOBJECTSITE], 3, 12, ([, ...rest])=>rest),

        /**
         * HRESULT IUnknown_TranslateAcceleratorOCS(IUnknown *lpUnknown, LPMSG lpMsg,
         *     DWORD dwModifiers)
         */
        IUnknown_TranslateAcceleratorOCS: forward([IID_IOLECONTROLSITE], 7, 12,
            ([, ...rest])=>rest),
        /** HRESULT IUnknown_OnFocusOCS(IUnknown *lpUnknown, BOOL fGotFocus) */
        IUnknown_OnFocusOCS: forward([IID_IOLECONTROLSITE], 8, 8, ([, ...rest])=>rest),

        /**
         * HRESULT SHLoadFromPropertyBag(IUnknown *lpUnknown, IPropertyBag *lpPropBag)
         *
         * IPersistPropertyBag::Load with no error log.
         */
        SHLoadFromPropertyBag: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: args=>((args[0] >>> 0) === 0 || (args[1] >>> 0) === 0 ? E_INVALIDARG
                : forward([IID_IPERSISTPROPERTYBAG], 5, 8, ([, bag])=>[bag, 0]).handler(args)),
        },

        /**
         * HRESULT IUnknown_QueryServiceForWebBrowserApp(IUnknown *lpUnknown, REFGUID riid,
         *     LPVOID *lppOut)
         *
         * IUnknown_QueryService for SID_SWebBrowserApp.
         */
        IUnknown_QueryServiceForWebBrowserApp: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: async([object, iid, out])=>{
                const block = host.allocate(16);
                if (block === 0)
                {
                    return E_OUTOFMEMORY;
                }
                try
                {
                    host.writeMemory(block, SID_SWEBBROWSERAPP);
                    return await queryService(object, block, iid, out);
                }
                finally
                {
                    host.free(block);
                }
            },
        },

        /**
         * HRESULT IShellFolder_EnumObjects(LPSHELLFOLDER lpFolder, HWND hwnd, SHCONTF flags,
         *     IEnumIDList **ppenum)
         *
         * The folder's own EnumObjects.
         */
        IShellFolder_EnumObjects: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([folder, ...rest])=>((folder >>> 0) === 0 ? E_INVALIDARG
                : callMethod(folder >>> 0, 4, rest.map(value=>value >>> 0), host.callerThread())),
        },

        /**
         * BOOL SHIsSameObject(IUnknown *lpInt1, IUnknown *lpInt2)
         *
         * The same object: their IUnknowns are one pointer.
         */
        SHIsSameObject: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: async([first, second])=>{
                if ((first >>> 0) === 0 || (second >>> 0) === 0)
                {
                    return 0;
                }
                const thread = host.callerThread();
                const a = await identity(first >>> 0, thread);
                const b = await identity(second >>> 0, thread);
                return a !== 0 && a === b ? 1 : 0;
            },
        },

        /**
         * HRESULT QISearch(void *base, const QITAB *table, REFIID riid, void **ppv)
         *
         * The table's entry for the interface asked - its offset from the
         * object's base - with a reference added; IUnknown is the first
         * entry's. NULL and E_NOINTERFACE for one the table does not have.
         */
        QISearch: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: async([base, entries, iid, out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                host.writeMemory(wholeAddress(out), dword(0));
                if ((iid >>> 0) === 0 || (entries >>> 0) === 0)
                {
                    return E_NOINTERFACE;
                }
                const wanted = host.readMemory(wholeAddress(iid), 16).slice();
                const isUnknown = sameBytes(wanted, IID_IUNKNOWN_BYTES);
                for (let at = wholeAddress(entries); ; at += 8)
                {
                    const entry = u32(host.readMemory(at, 4));
                    if (entry === 0)
                    {
                        return E_NOINTERFACE;
                    }
                    if (isUnknown || sameBytes(host.readMemory(entry, 16), wanted))
                    {
                        const found = ((base >>> 0) + u32(host.readMemory(at + 4, 4))) >>> 0;
                        host.writeMemory(wholeAddress(out), dword(found));
                        await callMethod(found, SLOT_ADD_REF, [], host.callerThread());
                        return S_OK;
                    }
                }
            },
        },

        /**
         * HRESULT SHWeakQueryInterface(IUnknown *pUnk, IUnknown *pInner, IID *riid,
         *     LPVOID *ppv)
         *
         * The inner object asked, and the outer one released when it answers:
         * an aggregate's weak reference to its outer object.
         */
        SHWeakQueryInterface: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: async([outer, inner, iid, out])=>{
                if ((outer >>> 0) === 0 || (inner >>> 0) === 0)
                {
                    return E_NOINTERFACE;
                }
                const thread = host.callerThread();
                const answer = await callMethod(inner >>> 0, SLOT_QUERY_INTERFACE,
                    [iid >>> 0, out >>> 0], thread);
                if (answer >= 0)
                {
                    await callMethod(outer >>> 0, SLOT_RELEASE, [], thread);
                }
                return answer;
            },
        },

        /**
         * VOID SHWeakReleaseInterface(IUnknown *lpDest, IUnknown **lppUnknown)
         *
         * The reference given back to the outer object and the pointer
         * cleared.
         */
        SHWeakReleaseInterface: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: async([outer, slot])=>{
                const held = (slot >>> 0) === 0 ? 0 : u32(host.readMemory(wholeAddress(slot), 4));
                if (held !== 0 && (outer >>> 0) !== 0)
                {
                    const thread = host.callerThread();
                    await callMethod(outer >>> 0, SLOT_ADD_REF, [], thread);
                    await callMethod(held, SLOT_RELEASE, [], thread);
                    host.writeMemory(wholeAddress(slot), dword(0));
                }
                return 0;
            },
        },

        /**
         * BOOL SHSkipJunction(IBindCtx *pbc, const CLSID *pclsid)
         *
         * Whether the bind context names this class as the junction to skip:
         * its "Skip Binding CLSID" object's class.
         */
        SHSkipJunction: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: async([context, clsid])=>{
                if ((context >>> 0) === 0 || (clsid >>> 0) === 0)
                {
                    return 0;
                }
                const thread = host.callerThread();
                const name = [...'Skip Binding CLSID\0'].flatMap(unit=>[unit.charCodeAt(0), 0]);
                const block = host.allocate(name.length + 8 + 16 + 16);
                if (block === 0)
                {
                    return 0;
                }
                try
                {
                    const out = block + name.length;
                    const iid = out + 8;
                    const got = iid + 16;
                    host.writeMemory(block, Uint8Array.from(name));
                    host.writeMemory(out, dword(0));
                    if (await callMethod(context >>> 0, SLOT_GET_OBJECT_PARAM, [block, out], thread)
                        < 0 || u32(host.readMemory(out, 4)) === 0)
                    {
                        return 0;
                    }
                    const object = u32(host.readMemory(out, 4));
                    host.writeMemory(iid, IID_IPERSIST);
                    host.writeMemory(out + 4, dword(0));
                    const persist = await callMethod(object, SLOT_QUERY_INTERFACE, [iid, out + 4],
                        thread) >= 0 ? u32(host.readMemory(out + 4, 4)) : 0;
                    let same = false;
                    if (persist !== 0)
                    {
                        same = await callMethod(persist, SLOT_GET_CLASS_ID, [got], thread) >= 0
                            && sameBytes(host.readMemory(got, 16),
                                host.readMemory(wholeAddress(clsid), 16));
                        await callMethod(persist, SLOT_RELEASE, [], thread);
                    }
                    await callMethod(object, SLOT_RELEASE, [], thread);
                    return same ? 1 : 0;
                }
                finally
                {
                    host.free(block);
                }
            },
        },
    };
    return table;

    /**
     * A helper that asks an object for the first of some interfaces it has,
     * calls one method of it with the caller's other arguments, and lets it
     * go: E_FAIL with no object or none of them, NULL first written through
     * the out pointer at `clears` when there is one.
     *
     * @param {Uint8Array[]} interfaces @param {number} slot @param {number} argBytes
     * @param {(args: number[]) => number[]} pick @param {number} [clears]
     */
    function forward(interfaces, slot, argBytes, pick, clears){
        return {
            argBytes,
            /** @param {number[]} args */
            handler: async(/** @type {number[]} */ args)=>{
                if (clears !== undefined && (args[clears] >>> 0) !== 0)
                {
                    host.writeMemory(args[clears] >>> 0, dword(0));
                }
                const object = args[0] >>> 0;
                if (object === 0)
                {
                    return E_FAIL;
                }
                const thread = host.callerThread();
                for (const iid of interfaces)
                {
                    const found = await queryInterface(object, iid, thread);
                    if (found !== 0)
                    {
                        const answer = await callMethod(found, slot,
                            pick(args).map(value=>value >>> 0), thread);
                        await callMethod(found, SLOT_RELEASE, [], thread);
                        return answer;
                    }
                }
                return E_FAIL;
            },
        };
    }

    /**
     * An interface of an object, a reference added, or 0.
     *
     * @param {number} object @param {Uint8Array} iid @param {unknown} thread
     */
    async function queryInterface(object, iid, thread){
        const block = host.allocate(20);
        if (block === 0)
        {
            return 0;
        }
        try
        {
            host.writeMemory(block, iid);
            host.writeMemory(block + 16, dword(0));
            const answer = await callMethod(object, SLOT_QUERY_INTERFACE, [block, block + 16],
                thread);
            return answer >= 0 ? u32(host.readMemory(block + 16, 4)) : 0;
        }
        finally
        {
            host.free(block);
        }
    }

    /**
     * An object's IUnknown pointer, its identity, released again; 0 when it
     * gives none.
     *
     * @param {number} object @param {unknown} thread
     */
    async function identity(object, thread){
        const unknown = await queryInterface(object, IID_IUNKNOWN_BYTES, thread);
        if (unknown !== 0)
        {
            await callMethod(unknown, SLOT_RELEASE, [], thread);
        }
        return unknown;
    }

    /**
     * IUnknown_QueryService's body with the service's GUID already in memory.
     *
     * @param {number} object @param {number} service @param {number} iid @param {number} out
     */
    async function queryService(object, service, iid, out){
        return /** @type {number} */ (await table.IUnknown_QueryService.handler([object, service,
            iid, out]));
    }
}

/** @param {Uint8Array} a @param {Uint8Array} b */
const sameBytes = (a, b)=>a.length === b.length && a.every((byte, at)=>byte === b[at]);
