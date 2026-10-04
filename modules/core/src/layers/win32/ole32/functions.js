/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The ole32 surface a program touches before it can ask for an interface:
 * entering an apartment, asking a class for an object, the task allocator, and
 * the conversions between a GUID and its string.
 *
 * Two things about this file decide whether anything built on it works.
 *
 * Everything here returns an HRESULT, which is not a BOOL and not an error code:
 * zero is success, and both success and failure carry more than one value. A
 * program written as `if (FAILED(hr))` reads the top bit, so S_FALSE is a
 * success it will proceed from -- which is exactly why the second CoInitialize
 * on a thread has to return S_FALSE rather than S_OK, and why the matching
 * CoUninitialize count has to be right.
 *
 * And an out-parameter is zeroed on every failure. Programs check the pointer
 * rather than the HRESULT more often than they should, and one that keeps
 * whatever was on the stack is a pointer they will call through.
 *
 * The vtable itself is not built here. `host.vtables.publish` turns an interface
 * into an address in guest memory; that is marshaling, and marshaling belongs to
 * the bridge.
 */

import {
    GUID_NULL, GUID_SIZE, GUID_STRING_LENGTH, canonicalGuid, formatGuid, parseGuid, readGuid,
    writeGuid,
} from './guid.js';
import { HKEY_CLASSES_ROOT } from '../advapi32/registry.js';
import { createStorageFunctions } from './storage.js';
import { createPropVariantFunctions } from './propvariant.js';
import { decodeAnsi, encodeAnsi } from '../kernel32/locale.js';
import { createClassTable, createRemoting } from './remote.js';
import { OBJREF_BYTES, decodeObjref, encodeObjref } from './objref.js';

/** HRESULTs this file produces. */
const S_OK = 0x00000000;
const S_FALSE = 0x00000001;
const E_NOTIMPL = 0x80004001;
const E_NOINTERFACE = 0x80004002;
/** What a call the apartment model does not allow answers. */
const CO_E_NOT_SUPPORTED = 0x80004021;
/** Some of the interfaces CoCreateInstanceEx was asked for, not all. */
const CO_S_NOTALLINTERFACES = 0x00080012;
/** MULTI_QI: the interface asked for, the pointer found, and the answer. */
const MULTI_QI_SIZE = 12;
const E_POINTER = 0x80004003;
const E_FAIL = 0x80004005;
const E_OUTOFMEMORY = 0x8007000e;
const E_INVALIDARG = 0x80070057;
const RPC_E_CHANGED_MODE = 0x80010106;
const CLASS_E_NOAGGREGATION = 0x80040110;
const CLASS_E_CLASSNOTAVAILABLE = 0x80040111;
const REGDB_E_CLASSNOTREG = 0x80040154;
const REGDB_E_IIDNOTREG = 0x80040155;
const RPC_E_INVALID_OBJREF = 0x8001011d;
/** The registry could not be written: CoTreatAsClass with no hive to write. */
const REGDB_E_WRITEREGDB = 0x80040151;
/** A registry string value's type. */
const REG_SZ = 1;
const CO_E_NOTINITIALIZED = 0x800401f0;
const CO_E_CLASSSTRING = 0x800401f3;
const CO_E_OBJNOTREG = 0x800401fb;
const CO_E_DLLNOTFOUND = 0x800401f8;
const CO_E_ERRORINDLL = 0x800401f9;
const DRAGDROP_E_NOTREGISTERED = 0x80040100;
const DRAGDROP_E_ALREADYREGISTERED = 0x80040101;
const DRAGDROP_E_INVALIDHWND = 0x80040102;

/** CLSCTX bits: where a program will accept the object being made. */
const CLSCTX_INPROC = 0x3;
const CLSCTX_LOCAL_SERVER = 0x4;

/** IID_IClassFactory: what a class object answers to. */
const IID_ICLASSFACTORY = '{00000001-0000-0000-C000-000000000046}';

/** What a proxy/stub DLL's class object is asked for. */
const IID_IPSFACTORYBUFFER = '{D5F569D0-593B-101A-B569-08002B2DBF7A}';

/**
 * The proxy/stub classes of the universal marshaler, whose interfaces a type
 * library describes rather than a proxy/stub DLL.
 */
const PSOAINTERFACE = '{00020424-0000-0000-C000-000000000046}';
const PSDISPATCH = '{00020420-0000-0000-C000-000000000046}';

/** How a marshaled packet may be used: once, the only way crossing here goes. */
const MSHLFLAGS_TABLESTRONG = 1;
const MSHLFLAGS_TABLEWEAK = 2;

/** IStream's Read and Write. */
const SLOT_STREAM_READ = 3;
const SLOT_STREAM_WRITE = 4;

/** A guest object's vtable slots this file calls: IUnknown's three, then IClassFactory's. */
const SLOT_QUERY_INTERFACE = 0;
const SLOT_ADD_REF = 1;
const SLOT_RELEASE = 2;
const SLOT_CREATE_INSTANCE = 3;

/**
 * The apartment models. COINIT_MULTITHREADED is zero, so the model is one bit
 * and the rest of dwCoInit (COINIT_DISABLE_OLE1DDE, COINIT_SPEED_OVER_MEMORY)
 * says nothing about which apartment the thread joined.
 */
const COINIT_APARTMENTTHREADED = 0x2;
const COINIT_DISABLE_OLE1DDE = 0x4;

/** What CoGetApartmentType answers. */
const APTTYPE_CURRENT = 0xffffffff;
const APTTYPE_STA = 0;
const APTTYPE_MTA = 1;
const APTTYPE_MAINSTA = 3;
const APTTYPEQUALIFIER_NONE = 0;
const APTTYPEQUALIFIER_IMPLICIT_MTA = 1;

/**
 * ole32's per-thread record, where TEB.ReservedForOle points: its flags are
 * the fourth dword, and these three say which apartment the thread entered.
 */
const TEB_RESERVED_FOR_OLE = 0xf80;
const OLETLS_SIZE = 0x40;
const OLETLS_FLAGS = 12;
const OLETLS_DISABLE_OLE1DDE = 0x40;
const OLETLS_APARTMENTTHREADED = 0x80;
const OLETLS_MULTITHREADED = 0x100;

/** The longest ProgID a registry key can carry. */
const MAX_PROGID = 255;

/**
 * @typedef {Object} OleHeap
 * @property {(bytes: number) => number} allocate  The address, or 0 if nothing fits.
 * @property {(address: number) => boolean} free
 * @property {(address: number) => { size: number } | null} block
 * @property {(address: number, bytes: number) => boolean} resize
 *           Whether the block can hold that many bytes where it already is.
 */

/**
 * @typedef {Object} OleHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, value: number, length: number) => void} fillMemory
 *     Sets a range to one byte value in place, with no host buffer holding
 *     the pattern: the lengths are the program's, and a clear of a megabyte
 *     through writeMemory costs an allocation and two extra passes.
 * @property {() => any} currentThread  The record apartment state hangs on.
 * @property {OleHeap} heap             Where task memory comes from.
 * @property {((api: string, detail: string) => void) | undefined} [divergence]
 *           Where a class this build does not have is named. A program asking
 *           for one is asking for a component it shipped or expects installed,
 *           and the code it gets back says only "not registered".
 * @property {import('./objects.js').ComRegistry} registry
 * @property {{ pointer: () => number }} [taskAllocator]
 *           The process's IMalloc, for CoGetMalloc. Absent, that call fails
 *           as an allocation failure would.
 * @property {{ root: (id: number) => any, open: (key: any, path: string) => any,
 *              getValue: (key: any, name: string) => { data: Uint8Array } | null,
 *              create?: (key: any, path: string) => { key: any },
 *              setValue?: (key: any, name: string, type: number, data: Uint8Array) => void,
 *              remove?: (key: any, path: string) => string }} [hive]
 *           The registry, for the class keys ProgIDFromCLSID reads. Absent,
 *           no class has a ProgID.
 * @property {{ load: (name: number) => number | Promise<number>,
 *              free: (module: number) => number,
 *              loadAnsi?: (name: number) => number | Promise<number>,
 *              procAddress?: (module: number, name: number) => number }} [libraries]
 *           LoadLibraryW and FreeLibrary, for CoLoadLibrary and CoFreeLibrary:
 *           a library COM loads is the same mapping kernel32 makes, and a
 *           name it takes is a wide string. Absent, CoLoadLibrary answers 0.
 * @property {import('./storage.js').StorageFiles} [files]
 *           The volume, for a docfile. Absent, no storage opens.
 * @property {(entry: number, args: number[], thread?: unknown) => Promise<number>} [call]
 *           A stdcall into guest code, for an object a program saves to a
 *           stream: its GetClassID and Save are the program's. The thread
 *           names whose call a second, awaited-after call answers.
 * @property {() => unknown} [callerThread]  Whose call is being handled.
 * @property {(clsid: string, definition: import('./objects.js').ComClassDefinition)
 *           => import('./objects.js').ComObject} [makeObject]
 *           An object of our own that no CLSID produces: the class object
 *           CoGetClassObject answers with for a class implemented here.
 * @property {{ copy: (bstr: number) => number, free: (bstr: number) => unknown }} [bstr]
 *           oleaut32's SysAllocString and SysFreeString, for a BSTR a
 *           PROPVARIANT holds. Absent, such a value cannot be copied.
 * @property {{ copy: (array: number, out: number) => number | Promise<number>,
 *              destroy: (array: number) => number | Promise<number> }} [safeArray]
 *           oleaut32's SafeArrayCopy and SafeArrayDestroy, likewise.
 * @property {(window: number) => boolean} [isWindow]
 *           Whether a handle names a window that exists, as user32's IsWindow
 *           answers. Absent, no handle is known to be one, and a drop target
 *           is refused for want of a window to hang it on.
 * @property {{ set: (window: number, name: number, value: number) => number,
 *              remove: (window: number, name: number) => number }} [windowProperty]
 *           user32's SetPropA and RemovePropA, the name an ANSI string in
 *           guest memory: a drop target is also a property of its window,
 *           where a program finds it. Absent, the target is kept here alone.
 * @property {{ publish: (object: import('./objects.js').ComObject,
 *                        interfaceId: string) => number }} vtables
 *           Puts an interface into guest memory and answers with the interface
 *           pointer, or 0 if it cannot. It must answer with the same address for
 *           the same object and interface every time: a program compares the
 *           IUnknown it got through two interfaces to decide whether they belong
 *           to one object, and two addresses for one interface fails that test
 *           however correct the object model underneath is.
 * @property {{ table: ReturnType<typeof createClassTable>, process: unknown }} [com]
 *           The run's table of class objects served out of process, and what
 *           names this process to it. Absent, this process has a table of its
 *           own and can start no server.
 * @property {{ create: (handler: (message: number) => number | Promise<number>)
 *         => number | Promise<number>,
 *     post: (window: number, message: number) => unknown }} [apartmentWindow]
 *           A hidden window on the calling thread, for the calls another
 *           process makes on this apartment's objects.
 * @property {(entry: number, args: number[], thread: unknown) => Promise<number>} [guardedCall]
 *           A call into guest code inside a frame that takes what it raises:
 *           how a method runs for another process.
 * @property {{ allocate?: (bytes: Uint8Array) => number }} [strings]
 *           A BSTR made from its content, for a string that crosses in.
 * @property {(vt: number, bounds: { elements: number, lower: number }[]) => number}
 *           [createSafeArray]
 * @property {(marshaler: import('../rpcrt4/runtime.js').ObjrefMarshaler) => void}
 *           [offerMarshaler]  Where the OBJREFs of this process are made and
 *           read, handed to the NDR runtime, whose interface pointers cross as
 *           them.
 */

/**
 * CoTaskMemRealloc's contract, which IMalloc::Realloc shares: NULL allocates,
 * a size of zero frees and answers NULL, a block that cannot grow in place
 * moves, and on failure the original block is untouched so a caller that
 * kept its pointer still owns its data.
 *
 * @param {OleHeap} heap
 * @param {{ readMemory: (address: number, length: number) => Uint8Array,
 *           writeMemory: (address: number, bytes: Uint8Array) => void }} memory
 * @param {number} pointer @param {number} size
 */
function reallocate(heap, memory, pointer, size){
    const address = pointer >>> 0;
    const wanted = size >>> 0;
    if (address === 0)
    {
        return heap.allocate(wanted);
    }
    if (wanted === 0)
    {
        heap.free(address);
        return 0;
    }
    const block = heap.block(address);
    if (!block)
    {
        return 0;
    }
    if (heap.resize(address, wanted))
    {
        return address;
    }
    const moved = heap.allocate(wanted);
    if (moved === 0)
    {
        return 0;
    }
    memory.writeMemory(moved, memory.readMemory(address, Math.min(block.size, wanted)).slice());
    heap.free(address);
    return moved;
}

/** IID_IMalloc, and the private class the task allocator is registered under. */
const IID_IMALLOC = '{00000002-0000-0000-C000-000000000046}';
const CLSID_TASK_ALLOCATOR = '{7b5b0b8e-1f8c-4b36-9d1c-2a6d4e4b0001}';

/** The one memory context CoGetMalloc accepts. */
const MEMCTX_TASK = 1;

/**
 * The process's task allocator: the IMalloc behind CoTaskMemAlloc, which
 * CoGetMalloc and SHGetMalloc hand out.
 *
 * One object for the life of the process, published once and never
 * destroyed by a Release: a program takes it at start-up, frees the shell's
 * item id lists through it and releases it on the way out, and the same
 * pointer has to keep answering through all of that. Blocks come from the
 * same heap CoTaskMemAlloc uses, so memory taken one way is freed the other.
 *
 * @param {Object} deps
 * @param {OleHeap} deps.heap
 * @param {import('./objects.js').ComRegistry} deps.registry
 * @param {{ publish: (object: import('./objects.js').ComObject, interfaceId: string) => number }}
 *        deps.vtables
 * @param {(address: number, length: number) => Uint8Array} deps.readMemory
 * @param {(address: number, bytes: Uint8Array) => void} deps.writeMemory
 */
export function createTaskAllocator({ heap, registry, vtables, readMemory, writeMemory }){
    const memory = { readMemory, writeMemory };
    registry.registerClass(CLSID_TASK_ALLOCATOR, ()=>({
        interfaces: [{
            id: IID_IMALLOC,
            methods: [
                { name: 'Alloc', argBytes: 8,
                    invoke: (object, [bytes])=>heap.allocate(bytes >>> 0) },
                { name: 'Realloc', argBytes: 12,
                    invoke: (object, [pointer, size])=>reallocate(heap, memory, pointer, size) },
                { name: 'Free', argBytes: 8, invoke: (object, [pointer])=>{
                    if ((pointer >>> 0) !== 0)
                    {
                        heap.free(pointer >>> 0);
                    }
                    return 0;
                } },
                { name: 'GetSize', argBytes: 8,
                    invoke: (object, [pointer])=>heap.block(pointer >>> 0)?.size ?? 0xffffffff },
                // 1 when the block is this allocator's, 0 when not: there is
                // one heap, so a block it knows is one it made.
                { name: 'DidAlloc', argBytes: 8,
                    invoke: (object, [pointer])=>(heap.block(pointer >>> 0) ? 1 : 0) },
                { name: 'HeapMinimize', argBytes: 4, invoke: ()=>0 },
            ],
        }],
    }));
    let pointer = 0;
    /** @type {import('./objects.js').ComObject | null} */
    let allocator = null;
    return {
        /**
         * The interface pointer, made on first use; 0 when nothing can hold it.
         *
         * Every hand-out carries a reference, because every caller gives one
         * back: a program that asks twice and releases twice would otherwise
         * take the object to zero, and the next caller would be handed the
         * same address with nothing behind it.
         */
        pointer: ()=>{
            if (pointer === 0)
            {
                allocator = registry.create(CLSID_TASK_ALLOCATOR);
                if (!allocator)
                {
                    return 0;
                }
                // The process's own reference, never released: the creation
                // reference is the one the guest was handed and will give back.
                allocator.addRef();
                pointer = vtables.publish(allocator, IID_IMALLOC) >>> 0;
            }
            else
            {
                allocator?.addRef();
            }
            return pointer;
        },
    };
}

/**
 * Builds the function table: name -> { argBytes, handler }.
 *
 * All of these are stdcall, which is the bridge's default, so none of them says
 * so. `argBytes` is the size of the argument list the guest compiled against.
 *
 * @param {OleHost} host
 */
export function createOleFunctions(host){
    /** @param {number} address @param {number} value */
    const writeU32 = (address, value)=>{
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
        host.writeMemory(address, bytes);
    };

    /** @param {number} address */
    const readU32 = address=>new DataView(host.readMemory(address >>> 0, 4).slice().buffer)
        .getUint32(0, true);

    /** @param {any} value @param {(answer: any) => any} then */
    const andThen = (value, then)=>(typeof value?.then === 'function'
        ? value.then(then)
        : then(value));

    /**
     * Calls a method of a guest object through its vtable: `this` first, as
     * a COM method takes it.
     *
     * @param {number} object @param {number} slot @param {number[]} args
     * @param {unknown} [thread]
     * @returns {Promise<number>}
     */
    const callMethod = (object, slot, args, thread)=>{
        if (!host.call)
        {
            return Promise.resolve(E_NOINTERFACE);
        }
        const entry = readU32(readU32(object) + slot * 4);
        return host.call(entry, [object >>> 0, ...args], thread);
    };

    /**
     * The drop targets a program registered, by window, each holding the
     * reference RegisterDragDrop took. Nothing is ever dropped on a window
     * here, so a target is kept and let go of and never called otherwise.
     *
     * @type {Map<number, number>}
     */
    const dropTargets = new Map();

    /**
     * Sets a window's drop-target property through user32, or removes it
     * for a null target. The name is lent guest memory for the call alone,
     * since user32 keeps a copy of it.
     *
     * @param {number} window @param {number | null} target
     * @returns {boolean} false when there was no memory to lend the name
     */
    const dropTargetProperty = (window, target)=>{
        const property = host.windowProperty;
        if (!property)
        {
            return true;
        }
        const text = 'OleDropTargetInterface';
        const name = host.heap.allocate(text.length + 1) >>> 0;
        if (name === 0)
        {
            return false;
        }
        host.writeMemory(name, Uint8Array.from([...text].map(c=>c.charCodeAt(0)).concat(0)));
        if (target === null)
        {
            property.remove(window, name);
        }
        else
        {
            property.set(window, name, target);
        }
        host.heap.free(name);
        return true;
    };

    /**
     * Whether OleInitialize ever succeeded in this process. A thread outside
     * any apartment is refused a drop target either way, with a different
     * code once OLE has run, which is how Windows tells the two apart.
     */
    let oleStarted = false;

    /**
     * The class objects a program registered with CoRegisterClassObject, by
     * the cookie it was answered with. Each holds the reference the
     * registration took; the thread is the apartment it belongs to, whose
     * last CoUninitialize revokes it.
     *
     * @type {Map<number, { clsid: string, object: number, thread: any }>}
     */
    const classObjects = new Map();
    let nextCookie = 1;
    /** @param {string} clsid */
    const registeredObject = clsid=>{
        for (const entry of classObjects.values())
        {
            if (entry.clsid === clsid)
            {
                return entry;
            }
        }
        return null;
    };

    /**
     * Drops a registration and the reference it held.
     *
     * @param {number} cookie @param {unknown} [thread]
     */
    const revoke = (cookie, thread)=>{
        const entry = classObjects.get(cookie);
        if (!entry)
        {
            return null;
        }
        classObjects.delete(cookie);
        return andThen(remoting?.revokeClass(cookie),
            ()=>callMethod(entry.object, SLOT_RELEASE, [], thread));
    };

    /**
     * This process's end of the channel to the others, made the first time a
     * class crosses: a program that never serves or asks for an out-of-process
     * class never has one.
     *
     * @type {ReturnType<typeof createRemoting> | null}
     */
    let remoting = null;
    const remote = ()=>{
        if (remoting || !host.call || !host.callerThread || !host.bstr)
        {
            return remoting;
        }
        const call = host.call;
        const callerThread = host.callerThread;
        const bstr = host.bstr;
        remoting = createRemoting({
            table: host.com?.table ?? createClassTable(),
            process: host.com?.process ?? null,
            readMemory: host.readMemory,
            writeMemory: host.writeMemory,
            heap: host.heap,
            call: (entry, args, thread)=>call(entry, args, thread),
            guardedCall: host.guardedCall,
            callerThread,
            vtables: host.vtables,
            bstr: {
                allocate: bytes=>host.strings?.allocate?.(bytes) ?? 0,
                free: pointer=>bstr.free(pointer),
            },
            safeArray: {
                create: (vt, bounds)=>host.createSafeArray?.(vt, bounds) ?? 0,
                destroy: array=>host.safeArray?.destroy(array),
            },
            apartmentWindow: host.apartmentWindow,
            catalog: { hive: host.hive, readFile: wholeFile },
            proxyStub: { factory: (iid, thread)=>proxyStubFactory(iid, thread) },
            divergence: host.divergence,
        });
        return remoting;
    };

    /**
     * The IPSFactoryBuffers of the proxy/stub DLLs this process has loaded,
     * by the class the registry names: loaded once and held, as COM holds
     * the ones it loads.
     *
     * @type {Map<string, Promise<number>>}
     */
    const proxyFactories = new Map();

    /**
     * The class object of the proxy/stub DLL an interface's ProxyStubClsid32
     * names, as an IPSFactoryBuffer; 0 when none is registered or it does not
     * load. The universal marshaler's classes are not DLLs of this kind.
     *
     * @param {string} iid @param {unknown} thread
     * @returns {Promise<number>}
     */
    const proxyStubFactory = (iid, thread)=>{
        const clsid = canonicalGuid(interfaceKeyValue(iid, 'ProxyStubClsid32') ?? '');
        if (clsid === null || clsid === PSOAINTERFACE || clsid === PSDISPATCH)
        {
            return Promise.resolve(0);
        }
        const known = proxyFactories.get(clsid);
        if (known)
        {
            return known;
        }
        const loading = (async()=>{
            const block = host.heap.allocate(GUID_SIZE * 2 + 4);
            if (block === 0)
            {
                return 0;
            }
            writeGuid(host, block, clsid);
            writeGuid(host, block + GUID_SIZE, IID_IPSFACTORYBUFFER);
            writeU32(block + GUID_SIZE * 2, 0);
            const hr = (await (fromServer(clsid, block, block + GUID_SIZE, block + GUID_SIZE * 2,
                thread) ?? REGDB_E_CLASSNOTREG)) | 0;
            const factory = readU32(block + GUID_SIZE * 2);
            host.heap.free(block);
            if (hr < 0 || factory === 0)
            {
                host.divergence?.('COM', `the proxy/stub class ${clsid} of ${iid} gave no`
                    + ` IPSFactoryBuffer: 0x${(hr >>> 0).toString(16)}`);
                proxyFactories.delete(clsid);
                return 0;
            }
            return factory;
        })();
        proxyFactories.set(clsid, loading);
        return loading;
    };

    /**
     * Where the OBJREFs an interface pointer crosses as are made and read:
     * the out-of-process channel's references, in DCOM's standard packet.
     *
     * @type {import('../rpcrt4/runtime.js').ObjrefMarshaler}
     */
    const marshaler = {
        async marshal(pointer, iid, thread){
            const channel = remote();
            const bytes = parseGuid(iid);
            if (!channel || !bytes || (pointer >>> 0) === 0)
            {
                return { hr: channel ? E_INVALIDARG : E_FAIL, objref: null };
            }
            const reference = await channel.exportReference(pointer >>> 0, iid, thread);
            return { hr: S_OK, objref: encodeObjref(bytes, reference) };
        },
        async unmarshal(objref, iid, thread){
            const decoded = decodeObjref(objref);
            const channel = remote();
            if (!decoded || !channel)
            {
                return { hr: RPC_E_INVALID_OBJREF | 0, pointer: 0 };
            }
            const pointer = await channel.importReference(decoded.reference, iid, thread);
            return pointer === 0 ? { hr: E_NOINTERFACE | 0, pointer: 0 } : { hr: S_OK, pointer };
        },
    };
    host.offerMarshaler?.(marshaler);

    /**
     * Reads a stream through its own IStream::Read: what a packet a program
     * marshaled into it holds.
     *
     * @param {number} stream @param {number} bytes @param {unknown} thread
     * @returns {Promise<Uint8Array | null>}
     */
    const readStream = async(stream, bytes, thread)=>{
        const block = host.heap.allocate(bytes + 4);
        if (block === 0)
        {
            return null;
        }
        writeU32(block + bytes, 0);
        const hr = (await callMethod(stream, SLOT_STREAM_READ, [block, bytes, block + bytes],
            thread)) | 0;
        const read = Math.min(readU32(block + bytes), bytes);
        const data = host.readMemory(block, read).slice();
        host.heap.free(block);
        return hr < 0 ? null : data;
    };

    /**
     * A string value of a key under HKEY_CLASSES_ROOT\Interface\{iid}.
     *
     * @param {string} iid @param {string} subkey
     */
    const interfaceKeyValue = (iid, subkey)=>{
        const root = host.hive?.root(HKEY_CLASSES_ROOT);
        const key = root ? host.hive?.open(root, `Interface\\${iid}\\${subkey}`) : null;
        const value = key ? host.hive?.getValue(key, '') : null;
        if (!value)
        {
            return null;
        }
        const end = value.data.indexOf(0);
        const text = decodeAnsi(end < 0 ? value.data : value.data.subarray(0, end));
        return text.length > 0 ? text : null;
    };

    /**
     * A file off the volume whole, or null: the type library that describes
     * an interface crossing to another process.
     *
     * @param {string} path
     * @returns {Uint8Array | Promise<Uint8Array> | null}
     */
    const wholeFile = path=>{
        const files = host.files;
        const entry = files?.stat(path);
        const node = files && entry?.exists && !entry.isDirectory
            ? files.open(path, { read: true })
            : null;
        if (!files || !entry || !node)
        {
            return null;
        }
        const bytes = files.read(node, 0, entry.size);
        if (bytes instanceof Promise)
        {
            return bytes.finally(()=>files.close(node));
        }
        files.close(node);
        return bytes;
    };

    /**
     * The command line that starts the class's local server, or null.
     *
     * @param {string} clsid
     */
    const localServer = clsid=>classKeyValue(clsid, 'LocalServer32')
        ?? classKeyValue(clsid, 'LocalServer');

    /**
     * Whether a class is made in another process: the caller accepts a local
     * server, and either has not asked for one in process or there is none.
     *
     * @param {string} clsid @param {number} context  CLSCTX_*.
     */
    const outOfProcess = (clsid, context)=>(context & CLSCTX_LOCAL_SERVER) !== 0
        && ((context & CLSCTX_INPROC) === 0 || classKeyValue(clsid, 'InprocServer32') === null);

    /**
     * A string value of the class's key under HKEY_CLASSES_ROOT\CLSID, or
     * null.
     *
     * @param {string} clsid @param {string} subkey
     */
    const classKeyValue = (clsid, subkey)=>{
        const root = host.hive?.root(HKEY_CLASSES_ROOT);
        const key = root ? host.hive?.open(root, `CLSID\\${clsid}\\${subkey}`) : null;
        const value = key ? host.hive?.getValue(key, '') : null;
        if (!value)
        {
            return null;
        }
        let text = '';
        for (const byte of value.data)
        {
            if (byte === 0)
            {
                break;
            }
            text += String.fromCharCode(byte);
        }
        return text.length > 0 ? text : null;
    };

    /**
     * A string in task memory for as long as `use` needs it: the path and
     * name a load and a lookup read out of guest memory.
     *
     * @template T
     * @param {Uint8Array} bytes @param {(address: number) => T} use
     */
    const scratch = (bytes, use)=>{
        const block = host.heap.allocate(Math.max(bytes.length, 4));
        if (block === 0)
        {
            return null;
        }
        host.writeMemory(block, bytes);
        return andThen(use(block), (/** @type {any} */ answer)=>{
            host.heap.free(block);
            return answer;
        });
    };
    /** @param {string} text */
    const ansi = text=>Uint8Array.from([...text].map(c=>c.charCodeAt(0) & 0xff).concat([0]));

    /**
     * The class object an in-process server exports for a class registered
     * under InprocServer32: its DLL loaded and DllGetClassObject asked, with
     * the program's own CLSID and IID pointers. Answers the HRESULT; null when
     * the class names no server at all.
     *
     * @param {string} clsid @param {number} classId @param {number} interfaceId
     * @param {number} out @param {unknown} thread
     * @returns {number | Promise<number> | null}
     */
    const fromServer = (clsid, classId, interfaceId, out, thread)=>{
        const path = classKeyValue(clsid, 'InprocServer32');
        const libraries = host.libraries;
        if (!path)
        {
            return null;
        }
        if (!libraries?.loadAnsi || !libraries.procAddress)
        {
            return CO_E_DLLNOTFOUND;
        }
        const loadAnsi = libraries.loadAnsi;
        const procAddress = libraries.procAddress;
        return andThen(scratch(ansi(path), loadAnsi), (/** @type {number | null} */ module)=>{
            if (!module)
            {
                host.divergence?.('COM', `the server ${path} of ${clsid} did not load`);
                return CO_E_DLLNOTFOUND;
            }
            return andThen(scratch(ansi('DllGetClassObject'),
                name=>procAddress(module >>> 0, name)), (/** @type {number | null} */ entry)=>{
                if (!entry || !host.call)
                {
                    return CO_E_ERRORINDLL;
                }
                return host.call(entry >>> 0, [classId >>> 0, interfaceId >>> 0, out >>> 0],
                    thread);
            });
        });
    };

    /**
     * An object of a class implemented here, handed out through `ppv` with
     * the reference QueryInterface took: what CoCreateInstance and a built-in
     * class object's CreateInstance both do.
     *
     * @param {string} clsid @param {number} outer @param {string} iid @param {number} out
     */
    const createBuiltIn = (clsid, outer, iid, out)=>{
        if ((outer >>> 0) !== 0)
        {
            // Aggregation makes the outer object's IUnknown the one this
            // object answers with, and nothing here can do that. Saying
            // so is the documented answer; succeeding would hand back an
            // object whose identity is wrong.
            return CLASS_E_NOAGGREGATION;
        }
        const object = host.registry.create(clsid);
        if (!object)
        {
            return CLASS_E_CLASSNOTAVAILABLE;
        }
        const record = object.queryInterface(iid);
        if (!record)
        {
            object.release();
            return E_NOINTERFACE;
        }

        const pointer = host.vtables.publish(object, iid) >>> 0;
        if (pointer === 0)
        {
            object.release();
            object.release();
            return E_OUTOFMEMORY;
        }
        // The creation reference goes; what the guest holds is the one
        // QueryInterface took, so the object comes back with exactly one.
        object.release();
        writeU32(out, pointer);
        return S_OK;
    };

    /**
     * Reads an LPCOLESTR that is supposed to be a GUID, or a ProgID. Only as
     * far as one can reach: a longer one is not one, and stopping there
     * means a missing terminator cannot walk off into whatever follows.
     *
     * @param {number} address
     * @param {number} [maxLength]
     * @returns {string}
     */
    const readOleString = (address, maxLength = GUID_STRING_LENGTH)=>{
        const bytes = host.readMemory(address, (maxLength + 1) * 2);
        const units = Math.min(maxLength + 1, bytes.length >> 1);
        let text = '';
        for (let index = 0; index < units; index++)
        {
            const unit = bytes[index * 2] | (bytes[index * 2 + 1] << 8);
            if (unit === 0)
            {
                break;
            }
            text += String.fromCharCode(unit);
        }
        return text;
    };

    /** @param {number} address @param {string} text  Written with its terminator. */
    const writeOleString = (address, text)=>{
        const bytes = new Uint8Array((text.length + 1) * 2);
        for (let index = 0; index < text.length; index++)
        {
            const unit = text.charCodeAt(index);
            bytes[index * 2] = unit & 0xff;
            bytes[index * 2 + 1] = (unit >>> 8) & 0xff;
        }
        host.writeMemory(address, bytes);
    };

    /**
     * The first thread to enter a single-threaded apartment, whose apartment
     * is the main one until it leaves (APTTYPE_MAINSTA); and how many threads
     * are in the multithreaded apartment. While any is, every thread that
     * entered no apartment of its own is in it too, implicitly, and may make
     * objects -- as ole32's compobj tests have a thread do.
     *
     * @type {any}
     */
    let mainSta = null;
    let mtaThreads = 0;
    /** Whether the multithreaded apartment exists: a thread in it, or a usage holding it open. */
    const mtaOpen = ()=>mtaThreads > 0 || (host.registry?.mtaUsage?.users ?? 0) > 0;

    /** @param {any} thread */
    const inApartment = thread=>Boolean(thread?.ole32) || mtaOpen();

    /**
     * The flags ole32 keeps in its per-thread record, which the thread's
     * block points at (TEB.ReservedForOle): the apartment the thread entered,
     * as a program reading the block sees it. The record is made the first
     * time and kept, as Windows keeps it.
     *
     * @param {any} thread @param {number} flags
     */
    const writeOleFlags = (thread, flags)=>{
        const teb = thread?.tebAddress >>> 0;
        if (!teb)
        {
            return;
        }
        if (!thread.oleRecord)
        {
            thread.oleRecord = host.heap.allocate(OLETLS_SIZE);
            if (thread.oleRecord === 0)
            {
                return;
            }
            host.fillMemory(thread.oleRecord, 0, OLETLS_SIZE);
            writeU32(teb + TEB_RESERVED_FOR_OLE, thread.oleRecord);
        }
        writeU32(thread.oleRecord + OLETLS_FLAGS, flags);
    };

    /**
     * CoInitialize and CoInitializeEx are the same call; the first one names the
     * model rather than taking it.
     *
     * @param {number} mode
     * @returns {number} an HRESULT
     */
    const enterApartment = mode=>{
        const thread = host.currentThread();
        const model = (mode & COINIT_APARTMENTTHREADED) !== 0 ? COINIT_APARTMENTTHREADED : 0;
        const apartment = thread.ole32;
        if (!apartment)
        {
            thread.ole32 = { model, depth: 1 };
            if (model === COINIT_APARTMENTTHREADED)
            {
                mainSta ??= thread;
                writeOleFlags(thread, OLETLS_APARTMENTTHREADED
                    | ((mode & COINIT_DISABLE_OLE1DDE) !== 0 ? OLETLS_DISABLE_OLE1DDE : 0));
            }
            else
            {
                mtaThreads++;
                // The multithreaded apartment has no DDE window to disable,
                // and ole32's own tests read the flag set for it.
                writeOleFlags(thread, OLETLS_MULTITHREADED | OLETLS_DISABLE_OLE1DDE);
            }
            return S_OK;
        }
        if (apartment.model !== model)
        {
            // The thread stays in the apartment it is in, and the count is not
            // touched: this call failed, so no CoUninitialize answers for it.
            return RPC_E_CHANGED_MODE;
        }
        apartment.depth++;
        return S_FALSE;
    };

    const leaveApartment = ()=>{
        const thread = host.currentThread();
        const apartment = thread.ole32;
        // Unbalanced on the other side: documented as something a
        // program must not do, and there is nothing to report it with.
        if (!apartment)
        {
            return 0;
        }
        apartment.depth--;
        if (apartment.depth !== 0)
        {
            return 0;
        }
        thread.ole32 = null;
        if (apartment.model !== COINIT_APARTMENTTHREADED)
        {
            mtaThreads--;
        }
        if (mainSta === thread)
        {
            mainSta = null;
        }
        writeOleFlags(thread, 0);
        // The apartment's class objects go with it: revoked, and the
        // reference each registration held released, as the last
        // CoUninitialize does on Windows. Objects of the classes built in
        // here are not tracked by apartment and outlive it.
        const mine = [...classObjects].filter(([, entry])=>entry.thread === thread)
            .map(([cookie])=>cookie);
        const caller = host.callerThread?.();
        /** @param {number} index @returns {number | Promise<number>} */
        const next = index=>(index >= mine.length
            ? 0
            : andThen(revoke(mine[index], caller), ()=>next(index + 1)));
        return next(0);
    };

    /**
     * @param {number} guidPointer  Where a REFCLSID or REFIID argument points.
     * @returns {string | null}
     */
    const guidAt = guidPointer=>{
        const address = guidPointer >>> 0;
        return address === 0 ? null : readGuid(host, address);
    };

    /** The proxy/stub classes this process registered for itself, by interface. */
    const ownProxyStubs = new Map();

    /**
     * @param {string} api @param {number} out  Where the object would go, or 0.
     * @returns {number} E_OUTOFMEMORY
     */
    const refuseObject = (api, out)=>{
        if (out !== 0)
        {
            writeU32(out, 0);
        }
        host.divergence?.(api, 'the running object table and monikers are not built');
        return E_OUTOFMEMORY;
    };

    const stringFromGuid = {
        argBytes: 8,
        /** @param {number[]} args */
        handler: ([rguid, ppsz])=>{
            const out = ppsz >>> 0;
            const guid = guidAt(rguid);
            if (guid === null || out === 0)
            {
                return E_INVALIDARG;
            }
            const block = host.heap.allocate((GUID_STRING_LENGTH + 1) * 2);
            host.writeMemory(out, new Uint8Array(4));
            if (block === 0)
            {
                return E_OUTOFMEMORY;
            }
            writeOleString(block, guid);
            const pointer = new Uint8Array(4);
            new DataView(pointer.buffer).setUint32(0, block, true);
            host.writeMemory(out, pointer);
            return S_OK;
        },
    };

    /**
     * CoCreateInstance's work, which CoCreateInstanceEx shares.
     *
     * @param {number[]} args  rclsid, pUnkOuter, dwClsContext, riid, ppv.
     * @returns {number | Promise<number>}
     */
    const coCreateInstance = ([classId, outer, context, interfaceId, ppv])=>{
        const out = ppv >>> 0;
        if (out === 0)
        {
            return E_POINTER;
        }
        writeU32(out, 0);

        if (!inApartment(host.currentThread()))
        {
            return CO_E_NOTINITIALIZED;
        }
        const clsid = guidAt(classId);
        const iid = guidAt(interfaceId);
        if (clsid === null || iid === null)
        {
            return E_INVALIDARG;
        }
        const thread = host.callerThread?.();

        // A class object the program registered itself comes first,
        // as Windows looks there first: its CreateInstance is the
        // program's, aggregation included.
        const registered = registeredObject(clsid);
        if (registered)
        {
            return callMethod(registered.object, SLOT_CREATE_INSTANCE,
                [outer >>> 0, interfaceId >>> 0, out], thread);
        }
        if (host.registry.isRegistered(clsid))
        {
            return createBuiltIn(clsid, outer, iid, out);
        }

        // An executable serves it, and the caller cannot take it in
        // process: the object is made over there.
        const channel = outOfProcess(clsid, context) ? remote() : null;
        if (channel)
        {
            if ((outer >>> 0) !== 0)
            {
                return CLASS_E_NOAGGREGATION;
            }
            const made = channel.activate(clsid, iid, out, localServer(clsid), 'activate');
            return andThen(made,
                (/** @type {number} */ hr)=>{
                    if (hr === REGDB_E_CLASSNOTREG)
                    {
                        host.divergence?.('COM', `no class ${clsid} is registered,`
                            + ' so CoCreateInstance refused it');
                    }
                    return hr;
                });
        }

        // A server the registry names: its class object, asked for
        // the instance and let go.
        const factorySlot = host.heap.allocate(4 + GUID_SIZE);
        if (factorySlot === 0)
        {
            return E_OUTOFMEMORY;
        }
        writeU32(factorySlot, 0);
        writeGuid(host, factorySlot + 4, IID_ICLASSFACTORY);
        const served = fromServer(clsid, classId, factorySlot + 4, factorySlot, thread);
        if (served === null)
        {
            host.heap.free(factorySlot);
            // Named, because the number alone is the whole question. A
            // program that asks for a class and is refused takes a
            // different path -- often a quieter one -- and which class
            // it wanted is the difference between "a component we have
            // not built" and "a filter the game brought with it".
            host.divergence?.('COM',
                `no class ${clsid} is registered, so CoCreateInstance refused it`);
            return REGDB_E_CLASSNOTREG;
        }
        return andThen(served, (/** @type {number} */ hr)=>{
            const factory = readU32(factorySlot);
            host.heap.free(factorySlot);
            if ((hr | 0) < 0 || factory === 0)
            {
                return hr;
            }
            return callMethod(factory, SLOT_CREATE_INSTANCE,
                [outer >>> 0, interfaceId >>> 0, out], thread)
                .then(created=>callMethod(factory, SLOT_RELEASE, [], thread)
                    .then(()=>created));
        });
    };

    return {
        /** HRESULT CoInitialize(LPVOID pvReserved) */
        CoInitialize: {
            argBytes: 4,
            // Documented as equivalent to CoInitializeEx with
            // COINIT_APARTMENTTHREADED, which is what makes the two nest together.
            handler: ()=>enterApartment(COINIT_APARTMENTTHREADED),
        },

        /** HRESULT CoInitializeEx(LPVOID pvReserved, DWORD dwCoInit) */
        CoInitializeEx: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([, mode])=>enterApartment(mode >>> 0),
        },

        /**
         * HRESULT CoIncrementMTAUsage(CO_MTA_USAGE_COOKIE *pCookie)
         *
         * Keeps the multithreaded apartment open with no thread in it, so a
         * thread that entered none is in it implicitly; the cookie is what
         * CoDecrementMTAUsage takes back.
         */
        CoIncrementMTAUsage: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([cookie])=>{
                if ((cookie >>> 0) === 0 || !host.registry?.mtaUsage)
                {
                    return E_INVALIDARG;
                }
                host.registry.mtaUsage.enter();
                writeU32(cookie >>> 0, host.registry.mtaUsage.users);
                return S_OK;
            },
        },

        /** HRESULT CoDecrementMTAUsage(CO_MTA_USAGE_COOKIE cookie) */
        CoDecrementMTAUsage: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([cookie])=>{
                if ((cookie >>> 0) === 0 || !host.registry?.mtaUsage?.users)
                {
                    return E_INVALIDARG;
                }
                host.registry.mtaUsage.leave();
                return S_OK;
            },
        },

        /**
         * HRESULT CoGetApartmentType(APTTYPE *pAptType, APTTYPEQUALIFIER *pAptQualifier)
         *
         * The apartment the calling thread is in: the main single-threaded
         * one, another single-threaded one, the multithreaded one -- entered,
         * or implicitly while another thread is in it -- or none, which is
         * CO_E_NOTINITIALIZED with APTTYPE_CURRENT written. Both pointers are
         * required, and a call missing one writes nothing.
         */
        CoGetApartmentType: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([type, qualifier])=>{
                if ((type >>> 0) === 0 || (qualifier >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const thread = host.currentThread();
                const apartment = thread?.ole32;
                let answer = S_OK;
                let kind = APTTYPE_MTA;
                let detail = APTTYPEQUALIFIER_NONE;
                if (apartment?.model === COINIT_APARTMENTTHREADED)
                {
                    kind = mainSta === thread ? APTTYPE_MAINSTA : APTTYPE_STA;
                }
                else if (!apartment && mtaOpen())
                {
                    detail = APTTYPEQUALIFIER_IMPLICIT_MTA;
                }
                else if (!apartment)
                {
                    kind = APTTYPE_CURRENT;
                    answer = CO_E_NOTINITIALIZED;
                }
                writeU32(type >>> 0, kind);
                writeU32(qualifier >>> 0, detail);
                return answer;
            },
        },

        /**
         * HRESULT CoGetCurrentLogicalThreadId(GUID *pguid)
         *
         * A GUID naming the calling thread's logical thread, the same one
         * every time that thread asks and another for any other thread; never
         * GUID_NULL. Its last word is the thread's id, which makes it its own.
         */
        CoGetCurrentLogicalThreadId: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const id = (host.currentThread()?.id ?? 0) >>> 0;
                writeGuid(host, out >>> 0, `{1063CB43-B0F3-4A56-B7C1-${
                    id.toString(16).toUpperCase().padStart(12, '0')}}`);
                return S_OK;
            },
        },

        /** void CoUninitialize(void) */
        /**
         * void CoFreeUnusedLibraries(void)
         *
         * A hint that any in-process server with no objects left may be
         * unloaded. Nothing here is unloaded ever -- an address handed out
         * earlier has to keep working -- so the honest answer is to accept the
         * hint and do nothing with it, which is also what Windows does when
         * every server says it is still needed.
         */
        /**
         * HRESULT CoSetProxyBlanket(IUnknown *pProxy, DWORD dwAuthnSvc,
         *     DWORD dwAuthzSvc, OLECHAR *pServerPrincName, DWORD dwAuthnLevel,
         *     DWORD dwImpLevel, RPC_AUTH_IDENTITY_HANDLE pAuthInfo, DWORD dwCapabilities)
         * HRESULT CoInitializeSecurity(PSECURITY_DESCRIPTOR pSecDesc, LONG cAuthSvc,
         *     SOLE_AUTHENTICATION_SERVICE *asAuthSvc, void *pReserved1, DWORD dwAuthnLevel,
         *     DWORD dwImpLevel, void *pAuthList, DWORD dwCapabilities, void *pReserved3)
         *
         * Security for calls that cross a process. Every object here lives in
         * the caller's process, so there is nothing to secure, and a program
         * that sets a blanket on the WMI services it was handed goes on to
         * use them only if this succeeds.
         */
        CoSetProxyBlanket: {
            argBytes: 32,
            handler: ()=>0,
        },
        CoInitializeSecurity: {
            argBytes: 36,
            handler: ()=>0,
        },

        CoFreeUnusedLibraries: {
            argBytes: 0,
            handler: ()=>0,
        },

        /**
         * void CoFreeAllLibraries(void): a library COM loaded stays mapped for
         * the process here, as CoFreeUnusedLibraries leaves it.
         */
        CoFreeAllLibraries: {
            argBytes: 0,
            handler: ()=>0,
        },

        /**
         * HINSTANCE CoLoadLibrary(LPOLESTR lpszLibName, BOOL bAutoFree)
         * void CoFreeLibrary(HINSTANCE hInst)
         *
         * LoadLibrary and FreeLibrary under COM's names, and the same
         * mapping: an address this hands out is one GetProcAddress accepts.
         * The auto-free flag only says whether CoFreeUnusedLibraries may
         * unload the library later, and nothing here ever does.
         */
        CoLoadLibrary: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([name])=>host.libraries?.load(name >>> 0) ?? 0,
        },
        CoFreeLibrary: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([module])=>{
                host.libraries?.free(module >>> 0);
                return 0;
            },
        },

        CoUninitialize: {
            argBytes: 0,
            handler: leaveApartment,
        },

        /**
         * HRESULT OleInitialize(LPVOID pvReserved)
         * void OleUninitialize(void)
         *
         * The apartment calls under another name: OleInitialize is documented
         * as CoInitializeEx with the single-threaded model, plus the clipboard
         * and drag-and-drop services, which here go no further than the calls
         * below. It nests with the Co* pair, so one leave serves either.
         */
        OleInitialize: {
            argBytes: 4,
            handler: ()=>{
                const answer = enterApartment(COINIT_APARTMENTTHREADED);
                oleStarted ||= answer === S_OK || answer === S_FALSE;
                return answer;
            },
        },

        /**
         * HRESULT RegisterDragDrop(HWND hwnd, LPDROPTARGET pDropTarget)
         *
         * The window accepts drops, and the target is kept with a reference
         * of its own until RevokeDragDrop, and is the window's
         * "OleDropTargetInterface" property meanwhile. Nothing ever drags
         * onto a window here, so it is never called -- the same as on a
         * desktop where nobody drags anything.
         */
        RegisterDragDrop: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([window, target])=>{
                if ((target >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                if ((window >>> 0) === 0 || !host.isWindow?.(window >>> 0))
                {
                    return DRAGDROP_E_INVALIDHWND;
                }
                if (!host.currentThread()?.ole32)
                {
                    return oleStarted ? CO_E_NOTINITIALIZED : E_OUTOFMEMORY;
                }
                if (dropTargets.has(window >>> 0))
                {
                    return DRAGDROP_E_ALREADYREGISTERED;
                }
                if (!dropTargetProperty(window >>> 0, target >>> 0))
                {
                    return E_OUTOFMEMORY;
                }
                dropTargets.set(window >>> 0, target >>> 0);
                return host.call
                    ? callMethod(target >>> 0, SLOT_ADD_REF, [], host.callerThread?.())
                        .then(()=>S_OK)
                    : S_OK;
            },
        },

        /** HRESULT RevokeDragDrop(HWND hwnd) */
        RevokeDragDrop: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([window])=>{
                const target = dropTargets.get(window >>> 0);
                if ((window >>> 0) === 0 || !host.isWindow?.(window >>> 0))
                {
                    // The window went without revoking, and its handle may
                    // come back as another window's.
                    dropTargets.delete(window >>> 0);
                    return DRAGDROP_E_INVALIDHWND;
                }
                if (target === undefined)
                {
                    return DRAGDROP_E_NOTREGISTERED;
                }
                dropTargets.delete(window >>> 0);
                dropTargetProperty(window >>> 0, null);
                return host.call
                    ? callMethod(target, SLOT_RELEASE, [], host.callerThread?.()).then(()=>S_OK)
                    : S_OK;
            },
        },

        /**
         * HRESULT OleFlushClipboard(void)
         * HRESULT OleIsCurrentClipboard(LPDATAOBJECT pDataObject)
         *
         * Only OleSetClipboard puts an object on the clipboard, and this
         * build does not export it: no object is ever current, and flushing
         * has nothing to render or release. A thread that never entered an
         * apartment is refused the flush, as Windows refuses it.
         */
        OleFlushClipboard: {
            argBytes: 0,
            handler: ()=>(host.currentThread()?.ole32 ? S_OK : E_FAIL),
        },
        OleIsCurrentClipboard: {
            argBytes: 4,
            handler: ()=>S_FALSE,
        },

        OleUninitialize: {
            argBytes: 0,
            handler: leaveApartment,
        },

        /**
         * HRESULT CoRegisterMessageFilter(LPMESSAGEFILTER lpMessageFilter,
         *   LPMESSAGEFILTER *lplpMessageFilter)
         *
         * A single-threaded apartment's filter, kept with a reference and the
         * one it replaces handed back to the caller, or let go of when the
         * caller asked not to have it; a thread in the multithreaded
         * apartment, or in none, has no filter to set. Nothing calls into
         * one: no call here ever waits on another apartment's answer while
         * messages arrive.
         */
        CoRegisterMessageFilter: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([filter, previous])=>{
                const apartment = host.currentThread()?.ole32;
                if (!apartment || apartment.model !== COINIT_APARTMENTTHREADED)
                {
                    return CO_E_NOT_SUPPORTED;
                }
                const thread = host.callerThread?.();
                const held = apartment.messageFilter ?? 0;
                apartment.messageFilter = filter >>> 0;
                if ((previous >>> 0) !== 0)
                {
                    writeU32(previous >>> 0, held);
                }
                const taken = (filter >>> 0) !== 0
                    ? callMethod(filter >>> 0, SLOT_ADD_REF, [], thread) : S_OK;
                return andThen(taken, ()=>(held !== 0 && (previous >>> 0) === 0
                    ? callMethod(held, SLOT_RELEASE, [], thread).then(()=>S_OK) : S_OK));
            },
        },

        /**
         * HRESULT OleSetMenuDescriptor(HOLEMENU holemenu, HWND hwndFrame,
         *   HWND hwndActiveObject, LPOLEINPLACEFRAME lpFrame,
         *   LPOLEINPLACEACTIVEOBJECT lpActiveObj)
         *
         * No object is ever active in place here, so there are no menu
         * messages to send one: a NULL descriptor -- taking the dispatching
         * off a frame -- has nothing to undo, and a composite menu is told so.
         */
        OleSetMenuDescriptor: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([holemenu, frame])=>{
                if ((holemenu >>> 0) === 0)
                {
                    return S_OK;
                }
                if (!host.isWindow?.(frame >>> 0))
                {
                    return E_INVALIDARG;
                }
                host.divergence?.('OleSetMenuDescriptor',
                    'a composite menu is accepted but its messages are never dispatched');
                return S_OK;
            },
        },

        /**
         * HRESULT CoCreateInstance(REFCLSID rclsid, LPUNKNOWN pUnkOuter,
         *   DWORD dwClsContext, REFIID riid, LPVOID *ppv)
         *
         * A class built in here is in-process whatever dwClsContext says: a
         * program asking for CLSCTX_LOCAL_SERVER gets the same object rather
         * than a failure it has no fallback for. A class whose server is an
         * executable is made in that server's process, started for it if no
         * process serves it yet, and the caller holds a proxy (`remote.js`).
         */
        CoCreateInstance: {
            argBytes: 20,
            handler: coCreateInstance,
        },

        /**
         * HRESULT CoCreateInstanceEx(REFCLSID rclsid, IUnknown *punkOuter,
         *   DWORD dwClsCtx, COSERVERINFO *pServerInfo, DWORD dwCount, MULTI_QI *pResults)
         *
         * The object is made as CoCreateInstance makes it, asked for the
         * first interface of the array, and then for each of the rest, every
         * entry told its own answer: S_OK when all were found,
         * CO_S_NOTALLINTERFACES when some were and E_NOINTERFACE when none
         * was. A server named in pServerInfo is this machine: there is no
         * other.
         */
        CoCreateInstanceEx: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([classId, outer, context, server, count, results])=>{
                if ((count >>> 0) === 0 || (results >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                if ((server >>> 0) !== 0 && readU32((server >>> 0) + 4) !== 0)
                {
                    host.divergence?.('CoCreateInstanceEx',
                        'the server a program names is made on this machine');
                }
                /** @param {number} index */
                const entry = index=>(results >>> 0) + index * MULTI_QI_SIZE;
                for (let index = 0; index < (count >>> 0); index++)
                {
                    writeU32(entry(index) + 4, 0);
                    writeU32(entry(index) + 8, E_NOINTERFACE);
                }
                const thread = host.callerThread?.();
                const first = entry(0);
                return andThen(coCreateInstance([classId, outer, context, readU32(first),
                    first + 4]), (/** @type {number} */ made)=>{
                    if ((made | 0) < 0)
                    {
                        for (let index = 0; index < (count >>> 0); index++)
                        {
                            writeU32(entry(index) + 8, made);
                        }
                        return made;
                    }
                    writeU32(first + 8, S_OK);
                    const object = readU32(first + 4);
                    /** @param {number} index @returns {number | Promise<number>} */
                    const ask = index=>{
                        if (index >= (count >>> 0))
                        {
                            let found = 0;
                            for (let at = 0; at < (count >>> 0); at++)
                            {
                                found += readU32(entry(at) + 8) === S_OK ? 1 : 0;
                            }
                            return found === (count >>> 0) ? S_OK
                                : found === 0 ? E_NOINTERFACE : CO_S_NOTALLINTERFACES;
                        }
                        return callMethod(object, SLOT_QUERY_INTERFACE,
                            [readU32(entry(index)), entry(index) + 4], thread)
                            .then(hr=>{
                                writeU32(entry(index) + 8, hr);
                                return ask(index + 1);
                            });
                    };
                    return ask(1);
                });
            },
        },

        /**
         * HRESULT CoGetClassObject(REFCLSID rclsid, DWORD dwClsContext,
         *   COSERVERINFO *pServerInfo, REFIID riid, LPVOID *ppv)
         *
         * The class object itself: one the program registered, a class
         * factory of our own over a class built in here, or what the class's
         * InprocServer32 exports.
         */
        CoGetClassObject: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([classId, context, , interfaceId, ppv])=>{
                const out = ppv >>> 0;
                if (out === 0)
                {
                    return E_POINTER;
                }
                writeU32(out, 0);
                const clsid = guidAt(classId);
                const iid = guidAt(interfaceId);
                if (clsid === null || iid === null)
                {
                    return E_INVALIDARG;
                }
                const thread = host.callerThread?.();
                const registered = registeredObject(clsid);
                if (registered)
                {
                    return callMethod(registered.object, SLOT_QUERY_INTERFACE,
                        [interfaceId >>> 0, out], thread);
                }
                if (host.registry.isRegistered(clsid) && host.makeObject)
                {
                    const factory = host.makeObject(clsid, {
                        interfaces: [{ id: IID_ICLASSFACTORY, methods: [
                            { name: 'CreateInstance', argBytes: 16,
                                /** @param {any} _object @param {number[]} args */
                                invoke: (_object, [outer, wanted, into])=>{
                                    const asked = guidAt(wanted);
                                    if ((into >>> 0) === 0)
                                    {
                                        return E_POINTER;
                                    }
                                    writeU32(into >>> 0, 0);
                                    return asked === null
                                        ? E_INVALIDARG
                                        : createBuiltIn(clsid, outer, asked, into >>> 0);
                                } },
                            // Nothing here is unloaded, so there is nothing to keep loaded.
                            { name: 'LockServer', argBytes: 8, invoke: ()=>S_OK },
                        ] }],
                    });
                    if (!factory.queryInterface(iid))
                    {
                        factory.release();
                        return E_NOINTERFACE;
                    }
                    const pointer = host.vtables.publish(factory, iid) >>> 0;
                    factory.release();
                    if (pointer === 0)
                    {
                        return E_OUTOFMEMORY;
                    }
                    writeU32(out, pointer);
                    return S_OK;
                }
                const channel = outOfProcess(clsid, context) ? remote() : null;
                if (channel)
                {
                    return channel.activate(clsid, iid, out, localServer(clsid), 'classobject');
                }
                const served = fromServer(clsid, classId, interfaceId, out, thread);
                return served ?? REGDB_E_CLASSNOTREG;
            },
        },

        /**
         * HRESULT CoRegisterClassObject(REFCLSID rclsid, LPUNKNOWN pUnk,
         *   DWORD dwClsContext, DWORD flags, LPDWORD lpdwRegister)
         *
         * A program's own class object, found by CoCreateInstance and
         * CoGetClassObject before anything the registry names -- how a
         * program serves its own classes to itself and to the components it
         * hosts. The registration holds a reference until it is revoked.
         */
        CoRegisterClassObject: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([classId, object, context, flags, cookieOut])=>{
                const thread = host.currentThread();
                if (!inApartment(thread))
                {
                    return CO_E_NOTINITIALIZED;
                }
                const clsid = guidAt(classId);
                if (clsid === null || (object >>> 0) === 0 || (cookieOut >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const cookie = nextCookie++;
                classObjects.set(cookie, { clsid, object: object >>> 0, thread });
                writeU32(cookieOut >>> 0, cookie);
                const held = callMethod(object >>> 0, SLOT_ADD_REF, [], host.callerThread?.());
                // Served to other processes too, through the run's table.
                const channel = (context & CLSCTX_LOCAL_SERVER) !== 0 ? remote() : null;
                return andThen(held, ()=>(channel
                    ? channel.registerClass(clsid, object >>> 0, flags >>> 0, cookie)
                        .then(()=>S_OK)
                    : S_OK));
            },
        },

        /** HRESULT CoRevokeClassObject(DWORD dwRegister) */
        CoRevokeClassObject: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([cookie])=>{
                const released = revoke(cookie >>> 0, host.callerThread?.());
                return released === null ? CO_E_OBJNOTREG : andThen(released, ()=>S_OK);
            },
        },

        /**
         * HRESULT CoResumeClassObjects(void)
         *
         * What a server registered with REGCLS_SUSPENDED becomes visible to
         * other processes, all at once.
         */
        CoResumeClassObjects: {
            argBytes: 0,
            handler: ()=>{
                remote()?.resume();
                return S_OK;
            },
        },

        /** HRESULT CoCreateGuid(GUID *pguid) */
        CoCreateGuid: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([pguid])=>{
                const address = pguid >>> 0;
                if (address === 0)
                {
                    return E_INVALIDARG;
                }
                const bytes = new Uint8Array(GUID_SIZE);
                crypto.getRandomValues(bytes);
                // Version 4, variant 1: the two fields a reader inspects to tell
                // a random GUID from one carrying a MAC address and a timestamp.
                // Data3 is little-endian, so its high byte is the eighth.
                bytes[7] = (bytes[7] & 0x0f) | 0x40;
                bytes[8] = (bytes[8] & 0x3f) | 0x80;
                host.writeMemory(address, bytes);
                return S_OK;
            },
        },

        /** LPVOID CoTaskMemAlloc(SIZE_T cb) */
        CoTaskMemAlloc: {
            argBytes: 4,
            /** @param {number[]} args */
            // A zero-byte request still yields a pointer that is not NULL, which
            // is what the caller tests for.
            handler: ([bytes])=>host.heap.allocate(bytes >>> 0),
        },

        /**
         * HRESULT CoGetMalloc(DWORD dwMemContext, LPMALLOC *ppMalloc)
         *
         * The task allocator, and only that: the shared context of 16-bit
         * OLE is gone and is refused as the documentation says.
         */
        CoGetMalloc: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([context, out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const pointer = (context >>> 0) === MEMCTX_TASK
                    ? host.taskAllocator?.pointer() ?? 0
                    : 0;
                writeU32(out >>> 0, pointer);
                if ((context >>> 0) !== MEMCTX_TASK)
                {
                    return E_INVALIDARG;
                }
                return pointer === 0 ? E_OUTOFMEMORY : S_OK;
            },
        },

        /** void CoTaskMemFree(LPVOID pv) */
        CoTaskMemFree: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([pointer])=>{
                const address = pointer >>> 0;
                // Documented as a no-op for NULL, so wrappers can pass it on.
                if (address !== 0)
                {
                    host.heap.free(address);
                }
                return 0;
            },
        },

        /** LPVOID CoTaskMemRealloc(LPVOID pv, SIZE_T cb) */
        CoTaskMemRealloc: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([pointer, size])=>reallocate(host.heap, host, pointer, size),
        },

        /** int StringFromGUID2(REFGUID rguid, LPOLESTR lpsz, int cchMax) */
        StringFromGUID2: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([rguid, lpsz, cchMax])=>{
                const out = lpsz >>> 0;
                const guid = guidAt(rguid);
                // The count includes the terminator, so a buffer of exactly 38
                // characters is one short and nothing is written into it.
                if (guid === null || out === 0 || (cchMax | 0) <= GUID_STRING_LENGTH)
                {
                    return 0;
                }
                writeOleString(out, guid);
                return GUID_STRING_LENGTH + 1;
            },
        },

        // Structured storage: the docfile, its objects and the entry points
        // that hand them out, over the same heap, registry and vtables.
        ...createStorageFunctions(host),

        // The property value, whose copy owns what it points at in task memory.
        ...createPropVariantFunctions(host),

        /**
         * HRESULT ProgIDFromCLSID(REFCLSID clsid, LPOLESTR *lplpszProgID)
         *
         * The class's ProgID key in the registry, as a string in task
         * memory; a class with no key is not registered.
         */
        /**
         * HRESULT CoTreatAsClass(REFCLSID clsidOld, REFCLSID clsidNew)
         *
         * Writes the emulation into the registry, as the call does: the old
         * class's TreatAs key names the new one, and a new class of GUID_NULL
         * or the old class itself takes the emulation away.
         */
        CoTreatAsClass: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([oldClass, newClass])=>{
                const old = guidAt(oldClass);
                const replacement = guidAt(newClass);
                if (old === null || replacement === null)
                {
                    return E_INVALIDARG;
                }
                const root = host.hive?.root(HKEY_CLASSES_ROOT);
                if (!root || !host.hive?.create || !host.hive.setValue || !host.hive.remove)
                {
                    return REGDB_E_WRITEREGDB;
                }
                const nothing = replacement.toUpperCase() === old.toUpperCase()
                    || replacement === GUID_NULL;
                if (nothing)
                {
                    host.hive.remove(root, `CLSID\\${old}\\TreatAs`);
                    return S_OK;
                }
                const key = host.hive.create(root, `CLSID\\${old}\\TreatAs`).key;
                host.hive.setValue(key, '', REG_SZ, encodeAnsi(`${replacement}\0`));
                return S_OK;
            },
        },

        ProgIDFromCLSID: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([rclsid, out])=>{
                const slot = out >>> 0;
                const guid = guidAt(rclsid);
                if (guid === null || slot === 0)
                {
                    return E_INVALIDARG;
                }
                writeU32(slot, 0);
                const root = host.hive?.root(HKEY_CLASSES_ROOT);
                const key = root ? host.hive?.open(root, `CLSID\\${guid}\\ProgID`) : null;
                const value = key ? host.hive?.getValue(key, '') : null;
                if (!value)
                {
                    return REGDB_E_CLASSNOTREG;
                }
                // The registry's bytes are the ANSI page's, widened as
                // MultiByteToWideChar(CP_ACP) widens them.
                const end = value.data.indexOf(0);
                const progId = decodeAnsi(
                    value.data.subarray(0, end < 0 ? value.data.length : end));
                const block = host.heap.allocate((progId.length + 1) * 2);
                if (block === 0)
                {
                    return E_OUTOFMEMORY;
                }
                writeOleString(block, progId);
                writeU32(slot, block);
                return S_OK;
            },
        },

        /**
         * HRESULT CLSIDFromProgID(LPCOLESTR lpszProgID, LPCLSID lpclsid)
         *
         * The other direction: the ProgID's own key, whose CLSID subkey
         * holds the class as a string. A ProgID with no key is not
         * registered, which is the code a program branches on.
         */
        CLSIDFromProgID: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([lpszProgID, lpclsid])=>{
                const out = lpclsid >>> 0;
                if (out === 0 || (lpszProgID >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                writeGuid(host, out, GUID_NULL);
                const progId = readOleString(lpszProgID >>> 0, MAX_PROGID);
                const root = host.hive?.root(HKEY_CLASSES_ROOT);
                const key = root && progId.length > 0
                    ? host.hive?.open(root, `${progId}\\CLSID`)
                    : null;
                const value = key ? host.hive?.getValue(key, '') : null;
                if (!value)
                {
                    return CO_E_CLASSSTRING;
                }
                let text = '';
                for (const byte of value.data)
                {
                    if (byte === 0)
                    {
                        break;
                    }
                    text += String.fromCharCode(byte);
                }
                return writeGuid(host, out, text) ? S_OK : CO_E_CLASSSTRING;
            },
        },

        /**
         * HRESULT CoMarshalInterface(IStream *pStm, REFIID riid, IUnknown *pUnk,
         *     DWORD dwDestContext, void *pvDestContext, DWORD mshlflags)
         *
         * An OBJREF, written into the stream: the object is exported for other
         * processes (`remote.js`), and the packet carries one reference for
         * whoever unmarshals it. A packet unmarshals once; table marshaling,
         * which lets it unmarshal again and again, is not built.
         */
        CoMarshalInterface: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([stream, riid, unknown, , , flags])=>{
                const thread = host.callerThread?.();
                const iid = guidAt(riid);
                if ((stream >>> 0) === 0 || (unknown >>> 0) === 0 || iid === null)
                {
                    return E_INVALIDARG;
                }
                if ((flags & (MSHLFLAGS_TABLESTRONG | MSHLFLAGS_TABLEWEAK)) !== 0)
                {
                    host.divergence?.('CoMarshalInterface', 'table marshaling is not implemented');
                    return E_NOTIMPL;
                }
                return marshaler.marshal(unknown >>> 0, iid, thread).then(async made=>{
                    if (made.hr < 0 || !made.objref)
                    {
                        return made.hr;
                    }
                    const block = host.heap.allocate(made.objref.length);
                    if (block === 0)
                    {
                        return E_OUTOFMEMORY;
                    }
                    host.writeMemory(block, made.objref);
                    const hr = (await callMethod(stream >>> 0, SLOT_STREAM_WRITE,
                        [block, made.objref.length, 0], thread)) | 0;
                    host.heap.free(block);
                    return hr < 0 ? hr : S_OK;
                });
            },
        },

        /**
         * HRESULT CoUnmarshalInterface(IStream *pStm, REFIID riid, LPVOID *ppv)
         *
         * The pointer an OBJREF stands for, holding the reference the packet
         * carried: the object itself if this process exported it, a proxy if
         * another did. An IID other than the packet's is asked for of it.
         */
        CoUnmarshalInterface: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([stream, riid, ppv])=>{
                const thread = host.callerThread?.();
                const out = ppv >>> 0;
                if (out === 0 || (stream >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                writeU32(out, 0);
                const wanted = guidAt(riid);
                return readStream(stream >>> 0, OBJREF_BYTES, thread).then(async bytes=>{
                    const decoded = bytes ? decodeObjref(bytes) : null;
                    if (!decoded)
                    {
                        return RPC_E_INVALID_OBJREF;
                    }
                    const carried = formatGuid(decoded.iid);
                    const made = await marshaler.unmarshal(/** @type {Uint8Array} */ (bytes),
                        carried, thread);
                    if (made.hr < 0)
                    {
                        return made.hr;
                    }
                    if (wanted === null || wanted === GUID_NULL || wanted === carried)
                    {
                        writeU32(out, made.pointer);
                        return S_OK;
                    }
                    const hr = (await callMethod(made.pointer, SLOT_QUERY_INTERFACE,
                        [riid >>> 0, out], thread)) | 0;
                    await callMethod(made.pointer, SLOT_RELEASE, [], thread);
                    return hr;
                });
            },
        },

        /**
         * HRESULT CoGetMarshalSizeMax(ULONG *pulSize, REFIID riid, IUnknown *pUnk,
         *     DWORD dwDestContext, void *pvDestContext, DWORD mshlflags)
         */
        CoGetMarshalSizeMax: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([size])=>{
                if ((size >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                writeU32(size >>> 0, OBJREF_BYTES);
                return S_OK;
            },
        },

        /**
         * HRESULT CoReleaseMarshalData(IStream *pStm)
         *
         * The reference an OBJREF nobody unmarshaled carries, given back. A
         * packet CoMarshalInterThreadInterfaceInStream wrote holds only the
         * pointer, and nothing is owned by it.
         */
        CoReleaseMarshalData: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([stream])=>{
                const thread = host.callerThread?.();
                if ((stream >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                return readStream(stream >>> 0, OBJREF_BYTES, thread).then(async bytes=>{
                    if (bytes?.length === 4)
                    {
                        return S_OK;
                    }
                    const decoded = bytes ? decodeObjref(bytes) : null;
                    const channel = remote();
                    if (!decoded || !channel)
                    {
                        return RPC_E_INVALID_OBJREF;
                    }
                    return channel.releaseReference(decoded.reference, thread);
                });
            },
        },

        /**
         * HRESULT CoRegisterPSClsid(REFIID riid, REFCLSID rclsid)
         *
         * The proxy/stub class for an interface, for this process alone:
         * what CoGetPSClsid answers ahead of the registry.
         */
        CoRegisterPSClsid: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([riid, rclsid])=>{
                const iid = guidAt(riid);
                const clsid = guidAt(rclsid);
                if (iid === null || clsid === null)
                {
                    return E_INVALIDARG;
                }
                ownProxyStubs.set(canonicalGuid(iid), canonicalGuid(clsid));
                return S_OK;
            },
        },

        /**
         * HRESULT CoGetPSClsid(REFIID riid, CLSID *pClsid)
         *
         * The proxy/stub class the process registered for an interface, or
         * else the one the registry names.
         */
        CoGetPSClsid: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([riid, pclsid])=>{
                const iid = guidAt(riid);
                const clsid = iid === null ? null
                    : ownProxyStubs.get(canonicalGuid(iid))
                        ?? canonicalGuid(interfaceKeyValue(iid, 'ProxyStubClsid32') ?? '');
                if ((pclsid >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                if (clsid === null)
                {
                    writeGuid(host, pclsid >>> 0, GUID_NULL);
                    return REGDB_E_IIDNOTREG;
                }
                writeGuid(host, pclsid >>> 0, clsid);
                return S_OK;
            },
        },

        /**
         * HRESULT GetRunningObjectTable(DWORD reserved, LPRUNNINGOBJECTTABLE *pprot)
         * HRESULT CreateItemMoniker(LPCOLESTR lpszDelim, LPCOLESTR lpszItem, LPMONIKER *ppmk)
         *
         * Monikers and the running object table are how one process finds
         * another's objects, and there is one process here. Both refuse as
         * an allocation failure, which is the answer a caller of either is
         * written to handle, and say so.
         */
        GetRunningObjectTable: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([, out])=>refuseObject('GetRunningObjectTable', out >>> 0),
        },
        CreateItemMoniker: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([, , out])=>refuseObject('CreateItemMoniker', out >>> 0),
        },

        /**
         * HRESULT StringFromCLSID(REFCLSID rclsid, LPOLESTR *ppsz)
         * HRESULT StringFromIID(REFIID rclsid, LPOLESTR *ppsz)
         *
         * The same string as StringFromGUID2, in a block the caller frees
         * with CoTaskMemFree.
         */
        StringFromCLSID: stringFromGuid,
        StringFromIID: stringFromGuid,

        /**
         * HRESULT CLSIDFromString(LPCOLESTR lpsz, LPCLSID pclsid)
         *
         * On Windows this also resolves a ProgID through the registry, which is
         * why its documented failure is CO_E_CLASSSTRING rather than E_INVALIDARG.
         * There is no ProgID registry here, so anything that is not a GUID string
         * fails that way -- the code a program branches on either way.
         *
         * A NULL string is not a failure: it yields CLSID_NULL and success, which
         * is the observable behaviour rather than anything the documentation says.
         */
        CLSIDFromString: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([lpsz, pclsid])=>{
                const out = pclsid >>> 0;
                if (out === 0)
                {
                    return E_INVALIDARG;
                }
                writeGuid(host, out, GUID_NULL);
                if ((lpsz >>> 0) === 0)
                {
                    return S_OK;
                }
                return writeGuid(host, out, readOleString(lpsz >>> 0))
                    ? S_OK
                    : CO_E_CLASSSTRING;
            },
        },

        /**
         * HRESULT IIDFromString(LPCOLESTR lpsz, LPIID lpiid)
         *
         * The same conversion, but an interface is never named by a ProgID, so a
         * malformed string is simply a bad argument.
         */
        IIDFromString: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([lpsz, lpiid])=>{
                const out = lpiid >>> 0;
                if (out === 0)
                {
                    return E_INVALIDARG;
                }
                writeGuid(host, out, GUID_NULL);
                if ((lpsz >>> 0) === 0)
                {
                    return S_OK;
                }
                return writeGuid(host, out, readOleString(lpsz >>> 0))
                    ? S_OK
                    : E_INVALIDARG;
            },
        },

        /**
         * BOOL IsEqualGUID(REFGUID rguid1, REFGUID rguid2)
         *
         * A BOOL, not an HRESULT: the SDK also has this as an inline comparison,
         * and code that calls the export expects the same 0 or 1. Windows would
         * fault on a NULL argument; answering FALSE keeps a guest bug from
         * becoming a host one.
         */
        IsEqualGUID: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([first, second])=>{
                const left = guidAt(first);
                const right = guidAt(second);
                return left !== null && left === right ? 1 : 0;
            },
        },
    };
}
