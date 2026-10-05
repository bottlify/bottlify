/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * COM between processes: a class served by an executable (LocalServer32), and
 * every interface pointer that crosses from one process to another after it.
 *
 * Each process is a machine of its own with its own memory, so an interface
 * pointer means nothing on the other side. What crosses is a reference -- the
 * exporting process and the object's number in its table -- and the side that
 * receives one holds a proxy: a host object whose vtable sends each call to
 * the exporter, where a stub makes it on the real object and sends back what
 * it wrote. How a call's arguments travel is the typelib marshaler's
 * (`oleaut32/marshal.js`); this file is the channel under it.
 *
 * An interface no type library describes crosses the way COM sends one whose
 * ProxyStubClsid32 names a MIDL proxy/stub DLL: the DLL's IPSFactoryBuffer
 * makes a proxy -- guest code, aggregated on the proxy manager here -- and a
 * stub on the exporter's side, and what crosses between them is the bytes of
 * the NDR buffer the generated code marshaled, through an IRpcChannelBuffer
 * of this file's.
 *
 * The model is COM's single-threaded apartment, which is what every program
 * of this era that serves a class out of process uses. An object belongs to
 * the thread that exported it, and a call for it runs there and nowhere
 * else: posted to the apartment's hidden window, the way ole32 posts an
 * incoming call, so it runs when that thread's message loop dispatches it --
 * or, when the thread is itself waiting on a call it made, inside that wait,
 * as COM's modal loop runs one.
 *
 * The table of registered class objects is the service control manager's:
 * one for the whole run, shared by every process in it. A process that asks
 * for a class nobody has registered starts the server the class names, with
 * `-Embedding`, and waits until it registers.
 *
 * References are counted across the line as COM counts them: every reference
 * that crosses carries one count with it, a proxy gives back all it holds
 * when its last local reference goes, and the table entry behind an exported
 * object releases the object when the last remote count goes. A process that
 * ends gives back everything its proxies held, as COM's rundown does.
 */

import { formatGuid, parseGuid } from './guid.js';
import { IUNKNOWN_METHODS } from './objects.js';
import {
    IID_ICLASSFACTORY, IID_IUNKNOWN, argumentBytes, createInterfaceCatalog,
    marshalReply, marshalRequest, unmarshalReply, unmarshalRequest,
} from '../oleaut32/marshal.js';

const S_OK = 0;
const E_NOTIMPL = 0x80004001 | 0;
const E_NOINTERFACE = 0x80004002 | 0;
const E_POINTER = 0x80004003 | 0;
const E_OUTOFMEMORY = 0x8007000e | 0;
const REGDB_E_CLASSNOTREG = 0x80040154 | 0;
const CO_E_SERVER_EXEC_FAILURE = 0x80080005 | 0;
const RPC_E_DISCONNECTED = 0x80010108 | 0;
const RPC_E_SERVERFAULT = 0x80010105 | 0;
const RPC_E_INVALID_OBJREF = 0x8001011d | 0;

export const REGCLS_MULTIPLEUSE = 1;
export const REGCLS_SUSPENDED = 4;

/** The message that tells an apartment a call is waiting for it. */
const WM_OLE_CALL = 0x0400;

const SLOT_QUERY_INTERFACE = 0;
const SLOT_ADD_REF = 1;
const SLOT_RELEASE = 2;
const SLOT_CREATE_INSTANCE = 3;

/** IPSFactoryBuffer's methods, and IRpcProxyBuffer's and IRpcStubBuffer's. */
const SLOT_CREATE_PROXY = 3;
const SLOT_CREATE_STUB = 4;
const SLOT_CONNECT = 3;
const SLOT_DISCONNECT = 4;
const SLOT_INVOKE = 5;

const IID_IRPCCHANNELBUFFER = '{D5F56B60-593B-101A-B569-08002B2DBF7A}';

/** IErrorInfo, and the methods of it and of ICreateErrorInfo a reply's error is moved by. */
const IID_IERRORINFO = '{1CF2B120-547D-101B-8E65-08002B2BD119}';
const SLOT_ERROR_GET_GUID = 3;
const SLOT_ERROR_GET_SOURCE = 4;
const SLOT_ERROR_GET_DESCRIPTION = 5;
const SLOT_ERROR_GET_HELP_FILE = 6;
const SLOT_ERROR_GET_HELP_CONTEXT = 7;
const SLOT_ERROR_SET_GUID = 3;
const SLOT_ERROR_SET_SOURCE = 4;
const SLOT_ERROR_SET_HELP_CONTEXT = 7;
const GUID_BYTES = 16;

/** RPCOLEMESSAGE, as a channel reads and writes it. */
const MESSAGE = Object.freeze({
    DATA_REPRESENTATION: 4, BUFFER: 8, BUFFER_LENGTH: 12, METHOD: 16, SIZE: 44,
});

/** Little-endian, ASCII, IEEE: what every buffer here is in. */
const NDR_LOCAL_DATA_REPRESENTATION = 0x10;

/** A channel's destination: another process on this machine. */
const MSHCTX_LOCAL = 0;

/**
 * @typedef {Object} Reference
 * @property {number} endpoint  The process that exported the object.
 * @property {number} object    Its number there.
 */

/**
 * @typedef {Object} Registration
 * @property {string} clsid
 * @property {number} endpoint
 * @property {number} object
 * @property {number} flags     REGCLS_*.
 * @property {number} cookie
 * @property {boolean} suspended
 * @property {boolean} used     A REGCLS_SINGLEUSE object, once activated.
 */

/**
 * @typedef {Object} Endpoint
 * @property {unknown} process
 * @property {(message: any) => Promise<any>} deliver
 * @property {() => Promise<void>} rundown
 * @property {boolean} alive
 */

/**
 * @typedef {Object} ClassTableHooks
 * @property {(request: { command: string, clsid: string }, process: unknown)
 *     => { exited: Promise<unknown> } | null} [launch]
 *     Starts a server as a process beside the caller's, or says it cannot.
 */

/**
 * An object in the running object table: what its moniker compares as, the
 * reference the table holds on it, and what a process that enumerates the
 * table makes the moniker again from.
 *
 * @typedef {Object} RunningEntry
 * @property {number} cookie
 * @property {string} key        The moniker's comparison data, in hex.
 * @property {Reference} reference
 * @property {number} flags      ROTFLAGS_*.
 * @property {number[]} time     The last change, a FILETIME's two words.
 * @property {{ clsid: string, bytes: Uint8Array } | null} moniker
 *     Its class and what IPersistStream::Save wrote of it, if it says.
 * @property {number} endpoint   The process that registered it.
 */

/**
 * The service control manager's table: every class object registered for
 * other processes to use, and the endpoints that serve them.
 *
 * @param {ClassTableHooks} [hooks]
 */
export function createClassTable(hooks = {}){
    /** @type {Map<number, Endpoint>} */
    const endpoints = new Map();
    let nextEndpoint = 1;
    /** @type {Registration[]} */
    let classes = [];
    /** @type {{ clsid: string, wake: () => void }[]} */
    let waiting = [];
    /**
     * The running object table: one for the run, as Windows keeps one for a
     * machine's processes in its service control manager.
     *
     * @type {Map<number, RunningEntry>}
     */
    const running = new Map();
    let nextRunning = 1;
    /**
     * The RPC endpoints processes listen on -- the protocol sequence and the
     * endpoint a server named, as one key -- and the endpoint of the process
     * that has each: what Windows' endpoint mapper is to its service control
     * manager, kept here beside it.
     *
     * @type {Map<string, number>}
     */
    const listening = new Map();

    const wake = ()=>{
        const woken = waiting;
        waiting = [];
        woken.forEach(entry=>entry.wake());
    };

    /** @param {string} clsid */
    const available = clsid=>classes.find(entry=>entry.clsid === clsid && !entry.suspended
        && !entry.used) ?? null;

    return {
        hooks,

        /** @param {Endpoint} endpoint */
        attach(endpoint){
            const id = nextEndpoint++;
            endpoints.set(id, endpoint);
            return id;
        },

        /** @param {number} id */
        endpoint: id=>endpoints.get(id) ?? null,

        /** @param {Registration} entry */
        register(entry){
            classes.push(entry);
            wake();
        },

        /**
         * @param {number} endpoint @param {number} cookie
         * @returns {Registration | null}
         */
        revoke(endpoint, cookie){
            const entry = classes.find(one=>one.endpoint === endpoint && one.cookie === cookie);
            classes = classes.filter(one=>one !== entry);
            return entry ?? null;
        },

        /**
         * CoSuspendClassObjects: this endpoint's registrations stay, and no
         * new client is handed one until they are resumed.
         *
         * @param {number} endpoint
         */
        suspend(endpoint){
            classes.filter(entry=>entry.endpoint === endpoint)
                .forEach(entry=>{
                    entry.suspended = true;
                });
        },

        /** @param {number} endpoint */
        resume(endpoint){
            classes.filter(entry=>entry.endpoint === endpoint)
                .forEach(entry=>{
                    entry.suspended = false;
                });
            wake();
        },

        /**
         * The class object a new client gets, taken: a single-use one is not
         * handed to a second.
         *
         * @param {string} clsid
         */
        take(clsid){
            const entry = available(clsid);
            if (entry && (entry.flags & (REGCLS_MULTIPLEUSE | 2)) === 0)
            {
                entry.used = true;
            }
            return entry;
        },

        /**
         * A process claims an RPC endpoint: refused when another has it, and
         * a process that asks again for its own is given it again.
         *
         * @param {string} key @param {number} endpoint @returns {boolean}
         */
        rpcListen(key, endpoint){
            const held = listening.get(key);
            if (held !== undefined && held !== endpoint)
            {
                return false;
            }
            listening.set(key, endpoint);
            return true;
        },

        /**
         * The process listening on an RPC endpoint, as the endpoint it is
         * delivered to by, or null when none is.
         *
         * @param {string} key @returns {number | null}
         */
        rpcServer: key=>listening.get(key) ?? null,

        /**
         * A process gives up an RPC endpoint, or every one it has.
         *
         * @param {number} endpoint @param {string} [key]
         */
        rpcUnlisten(endpoint, key){
            for (const [held, owner] of listening)
            {
                if (owner === endpoint && (key === undefined || key === held))
                {
                    listening.delete(held);
                }
            }
        },

        /**
         * Waits until someone registers the class, or until `ended` settles:
         * the server that was started for it gave up without registering.
         *
         * @param {string} clsid @param {Promise<unknown>} ended
         * @returns {Promise<boolean>}
         */
        async whenRegistered(clsid, ended){
            const server = { over: false };
            const end = ()=>{
                server.over = true;
                wake();
            };
            ended.then(end, end);
            while (!available(clsid) && !server.over)
            {
                await new Promise(resolve=>{
                    waiting.push({ clsid, wake: ()=>resolve(undefined) });
                });
            }
            return available(clsid) !== null;
        },

        /**
         * Puts an object in the running object table under its moniker's
         * comparison data; a second object under the same data is put there
         * too, and told so.
         *
         * @param {Omit<RunningEntry, 'cookie'>} entry
         * @returns {{ cookie: number, duplicate: boolean }}
         */
        rotRegister(entry){
            const duplicate = [...running.values()].some(other=>other.key === entry.key);
            const cookie = nextRunning++;
            running.set(cookie, { ...entry, cookie });
            return { cookie, duplicate };
        },

        /**
         * Takes an object out of the table: the entry, whose reference the
         * caller gives back, or null for a cookie it does not hold.
         *
         * @param {number} cookie @returns {RunningEntry | null}
         */
        rotRevoke(cookie){
            const entry = running.get(cookie) ?? null;
            running.delete(cookie);
            return entry;
        },

        /**
         * The object registered first under a moniker's comparison data.
         *
         * @param {string} key @returns {RunningEntry | null}
         */
        rotFind: key=>[...running.values()].find(entry=>entry.key === key) ?? null,

        /** @param {number} cookie @param {number[]} time @returns {boolean} */
        rotNoteChange(cookie, time){
            const entry = running.get(cookie);
            if (entry)
            {
                entry.time = time;
            }
            return Boolean(entry);
        },

        /** Every entry, in the order they were registered. @returns {RunningEntry[]} */
        rotEntries: ()=>[...running.values()],

        /**
         * A process has ended: what it registered goes, and so does every
         * reference its proxies held.
         *
         * @param {unknown} process
         */
        async ended(process){
            for (const [id, endpoint] of endpoints)
            {
                if (endpoint.process !== process)
                {
                    continue;
                }
                endpoint.alive = false;
                classes = classes.filter(entry=>entry.endpoint !== id);
                for (const [key, owner] of listening)
                {
                    if (owner === id)
                    {
                        listening.delete(key);
                    }
                }
                // What it registered, and what it held no longer has a server.
                for (const [cookie, entry] of running)
                {
                    if (entry.endpoint === id || entry.reference.endpoint === id)
                    {
                        running.delete(cookie);
                    }
                }
                await endpoint.rundown();
                endpoints.delete(id);
            }
            wake();
        },
    };
}

/**
 * @typedef {Object} RemotingHost
 * @property {ReturnType<typeof createClassTable>} table
 * @property {unknown} process   Whatever names this process to the table's hooks.
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {{ allocate: (bytes: number) => number, free: (address: number) => unknown }} heap
 * @property {(entry: number, args: number[], thread?: unknown) => Promise<number>} call
 * @property {(entry: number, args: number[], thread: unknown) => Promise<number>} [guardedCall]
 *     The same inside a frame that takes whatever the routine raises and
 *     answers RPC_E_SERVERFAULT: how a stub runs a method, so that an
 *     exception in it fails the call rather than the server.
 * @property {() => unknown} callerThread
 * @property {{ publish: (object: any, interfaceId: string) => number,
 *     unpublish?: (object: any, interfaceId: string) => boolean }} vtables
 * @property {{ allocate: (bytes: Uint8Array) => number, free: (bstr: number) => unknown }} bstr
 * @property {{ create: (vt: number, bounds: { elements: number, lower: number }[]) => number,
 *     destroy: (array: number) => unknown }} [safeArray]
 * @property {{ create: (handler: (message: number) => number | Promise<number>)
 *         => number | Promise<number>,
 *     post: (window: number, message: number) => unknown }} [apartmentWindow]
 *     A hidden window on the calling thread, whose procedure is `handler`,
 *     and a way to post to it.
 * @property {import('../oleaut32/marshal.js').CatalogHost} catalog
 * @property {{ factory: (iid: string, thread: unknown) => Promise<number> }} [proxyStub]
 *     The IPSFactoryBuffer of the proxy/stub DLL the registry names for an
 *     interface, loaded into this process as COM loads it; 0 when none is.
 * @property {(api: string, detail: string) => void} [divergence]
 * @property {{ take: () => number, set: (pointer: number) => unknown,
 *     create: (out: number) => number }} [errors]
 *     The thread's error-information slot -- taken off it, which clears it,
 *     and set, the slot keeping the reference handed it -- and
 *     CreateErrorInfo: how a failed call's error crosses back to its caller.
 */

/**
 * One process's end of the channel.
 *
 * @param {RemotingHost} host
 */
export function createRemoting(host){
    const catalog = createInterfaceCatalog(host.catalog);
    const report = (/** @type {string} */ detail)=>host.divergence?.('COM', detail);

    /** @param {number} address */
    const readU32 = address=>{
        const bytes = host.readMemory(address >>> 0, 4);
        return (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
    };
    /** @param {number} address @param {number} value */
    const writeU32 = (address, value)=>host.writeMemory(address >>> 0, Uint8Array.of(
        value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff));

    /**
     * A method of a guest object, called on the thread whose host call is
     * waiting.
     *
     * @param {number} pointer @param {number} slot @param {number[]} args @param {unknown} thread
     */
    const callSlot = (pointer, slot, args, thread)=>
        host.call(readU32(readU32(pointer) + slot * 4), [pointer >>> 0, ...args], thread);
    /** @param {number} pointer @param {number} slot @param {number[]} args @param {unknown} thread */
    const callGuarded = (pointer, slot, args, thread)=>(host.guardedCall ?? host.call)(
        readU32(readU32(pointer) + slot * 4), [pointer >>> 0, ...args], thread);

    /**
     * QueryInterface on a guest object, the IID and the answer in task memory
     * for the length of the call.
     *
     * @param {number} pointer @param {string} iid @param {unknown} thread
     * @returns {Promise<{ hr: number, pointer: number }>}
     */
    const queryGuest = async(pointer, iid, thread)=>{
        const block = host.heap.allocate(20);
        if (block === 0)
        {
            return { hr: E_OUTOFMEMORY, pointer: 0 };
        }
        writeU32(block, 0);
        host.writeMemory(block + 4, /** @type {Uint8Array} */ (parseGuid(iid)));
        const hr = (await callSlot(pointer, SLOT_QUERY_INTERFACE, [block + 4, block], thread)) | 0;
        const found = readU32(block);
        host.heap.free(block);
        return { hr, pointer: hr < 0 ? 0 : found };
    };

    /**
     * An exported object: its identity, the interfaces of it the stub holds a
     * reference on, the counts the other processes hold, and the apartment
     * its calls run in.
     *
     * @typedef {Object} Exported
     * @property {number} id
     * @property {number} unknown
     * @property {Map<string, number>} interfaces
     * @property {Map<string, number>} stubs  The MIDL stubs its calls go through.
     * @property {number} refs
     * @property {unknown} thread
     */

    /** @type {Map<number, Exported>} */
    const exported = new Map();
    /** @type {Map<number, number>} */
    const byIdentity = new Map();
    let nextObject = 1;

    /**
     * @typedef {Object} Apartment
     * @property {{ message: any, resolve: (reply: any) => void }[]} queue
     * @property {number} window
     * @property {Promise<number> | null} making
     * @property {number} outgoing  Calls this thread is waiting on.
     * @property {(() => void) | null} waiting
     * @property {Set<(reply: any) => void>} running  Answers owed for calls under way.
     */

    /** @type {Map<unknown, Apartment>} */
    const apartments = new Map();
    /** @param {unknown} thread @returns {Apartment} */
    const apartment = thread=>{
        let found = apartments.get(thread);
        if (!found)
        {
            found = { queue: [], window: 0, making: null, outgoing: 0, waiting: null,
                running: new Set() };
            apartments.set(thread, found);
        }
        return found;
    };

    /**
     * The apartment's hidden window, made on its own thread the first time
     * something of it is exported.
     *
     * @param {unknown} thread
     */
    const ensureWindow = async thread=>{
        const home = apartment(thread);
        if (home.window !== 0 || !host.apartmentWindow)
        {
            return;
        }
        home.making ??= Promise.resolve(host.apartmentWindow.create(message=>{
            if (message !== WM_OLE_CALL)
            {
                return 0;
            }
            return drain(host.callerThread()).then(()=>0);
        }));
        home.window = (await home.making) >>> 0;
    };

    /**
     * Runs every call waiting for this thread, on it.
     *
     * @param {unknown} thread
     */
    const drain = async thread=>{
        const home = apartment(thread);
        while (home.queue.length > 0)
        {
            const item = /** @type {{ message: any, resolve: (reply: any) => void }} */ (
                home.queue.shift());
            let reply;
            home.running.add(item.resolve);
            try
            {
                reply = await execute(item.message, thread);
            }
            catch (e){
                report(`a call failed in its server: ${e instanceof Error ? e.message : e}`);
                reply = { hr: RPC_E_SERVERFAULT };
            }
            home.running.delete(item.resolve);
            item.resolve(reply);
        }
    };

    /**
     * Hands a call to the apartment it belongs to.
     *
     * @param {unknown} thread @param {any} message
     * @returns {Promise<any>}
     */
    const enqueue = (thread, message)=>new Promise(resolve=>{
        const home = apartment(thread);
        home.queue.push({ message, resolve });
        if (home.waiting)
        {
            home.waiting();
        }
        else if (home.outgoing === 0 && home.window !== 0)
        {
            host.apartmentWindow?.post(home.window, WM_OLE_CALL);
        }
        else if (home.outgoing === 0)
        {
            report('a call arrived for an apartment with no window to deliver it through');
            home.queue.pop();
            resolve({ hr: RPC_E_DISCONNECTED });
        }
    });

    /**
     * A BSTR's text, read where it lies, and the BSTR given back.
     *
     * @param {number} bstr @returns {string | null}
     */
    const takeBstr = bstr=>{
        if (bstr === 0)
        {
            return null;
        }
        const length = Math.min(readU32(bstr - 4), 1 << 20);
        const bytes = host.readMemory(bstr, length);
        let text = '';
        for (let at = 0; at + 1 < bytes.length; at += 2)
        {
            text += String.fromCharCode(bytes[at] | (bytes[at + 1] << 8));
        }
        host.bstr.free(bstr);
        return text;
    };

    /**
     * The error information the thread holds, taken off it and read as
     * values: what a call's reply carries back to the process that made it,
     * where an IErrorInfo pointer of this one would mean nothing. Null when
     * the thread holds none.
     *
     * @param {unknown} thread
     * @returns {Promise<{ guid: string, source: string | null, description: string | null,
     *     helpFile: string | null, helpContext: number } | null>}
     */
    const takeErrorInfo = async thread=>{
        const pointer = host.errors?.take() ?? 0;
        if (pointer === 0)
        {
            return null;
        }
        const block = host.heap.allocate(GUID_BYTES + 4);
        if (block === 0)
        {
            await callSlot(pointer, SLOT_RELEASE, [], thread);
            return null;
        }
        host.writeMemory(block, new Uint8Array(GUID_BYTES + 4));
        await callSlot(pointer, SLOT_ERROR_GET_GUID, [block], thread);
        const guid = formatGuid(host.readMemory(block, GUID_BYTES).slice());
        /** @param {number} slot */
        const text = async slot=>{
            writeU32(block + GUID_BYTES, 0);
            const hr = (await callSlot(pointer, slot, [block + GUID_BYTES], thread)) | 0;
            return hr < 0 ? null : takeBstr(readU32(block + GUID_BYTES));
        };
        const source = await text(SLOT_ERROR_GET_SOURCE);
        const description = await text(SLOT_ERROR_GET_DESCRIPTION);
        const helpFile = await text(SLOT_ERROR_GET_HELP_FILE);
        writeU32(block + GUID_BYTES, 0);
        await callSlot(pointer, SLOT_ERROR_GET_HELP_CONTEXT, [block + GUID_BYTES], thread);
        const helpContext = readU32(block + GUID_BYTES);
        host.heap.free(block);
        await callSlot(pointer, SLOT_RELEASE, [], thread);
        return { guid, source, description, helpFile, helpContext };
    };

    /**
     * Error information another process's call carried back, made an object
     * of this process's and set on the thread, as GetErrorInfo reads it.
     *
     * @param {{ guid: string, source: string | null, description: string | null,
     *     helpFile: string | null, helpContext: number }} values
     * @param {unknown} thread
     */
    const giveErrorInfo = async(values, thread)=>{
        if (!host.errors)
        {
            return;
        }
        const strings = [values.source, values.description, values.helpFile]
            .map(value=>(value ?? ''));
        const size = GUID_BYTES + 4 + strings.reduce((sum, value)=>sum + (value.length + 1) * 2, 0);
        const block = host.heap.allocate(size);
        if (block === 0)
        {
            return;
        }
        writeU32(block, 0);
        if ((host.errors.create(block) | 0) < 0 || readU32(block) === 0)
        {
            host.heap.free(block);
            return;
        }
        const creator = readU32(block);
        host.writeMemory(block + 4, /** @type {Uint8Array} */ (parseGuid(values.guid)));
        await callSlot(creator, SLOT_ERROR_SET_GUID, [block + 4], thread);
        let at = block + 4 + GUID_BYTES;
        for (const [index, value] of strings.entries())
        {
            const bytes = new Uint8Array((value.length + 1) * 2);
            for (let unit = 0; unit < value.length; unit++)
            {
                bytes[unit * 2] = value.charCodeAt(unit) & 0xff;
                bytes[unit * 2 + 1] = value.charCodeAt(unit) >>> 8;
            }
            host.writeMemory(at, bytes);
            await callSlot(creator, SLOT_ERROR_SET_SOURCE + index, [at], thread);
            at += bytes.length;
        }
        await callSlot(creator, SLOT_ERROR_SET_HELP_CONTEXT, [values.helpContext >>> 0], thread);
        const asked = await queryGuest(creator, IID_IERRORINFO, thread);
        await callSlot(creator, SLOT_RELEASE, [], thread);
        host.heap.free(block);
        // The thread's slot holds the reference the query took.
        if (asked.pointer !== 0)
        {
            host.errors.set(asked.pointer);
        }
    };

    /**
     * Waits on `pending` for `thread`, running the calls that arrive for its
     * apartment meanwhile: COM's modal loop.
     *
     * @param {unknown} thread @param {Promise<any>} pending
     * @returns {Promise<any>}
     */
    const awaitServing = async(thread, pending)=>{
        const home = apartment(thread);
        home.outgoing++;
        try
        {
            const answer = pending.then(value=>({ value }));
            for (;;)
            {
                if (home.queue.length > 0)
                {
                    await drain(thread);
                    continue;
                }
                const woken = new Promise(resolve=>{
                    home.waiting = ()=>resolve(null);
                });
                const settled = await Promise.race([answer, woken]);
                home.waiting = null;
                if (settled)
                {
                    return settled.value;
                }
            }
        }
        finally
        {
            home.outgoing--;
        }
    };

    /**
     * Sends a message to another process and waits for its answer, running
     * the calls that arrive for this thread meanwhile.
     *
     * @param {unknown} thread @param {number} target @param {any} message
     * @returns {Promise<any>}
     */
    const outgoing = async(thread, target, message)=>{
        const value = await awaitServing(thread, send(target, message));
        // What the server said of its failure is this thread's to read with
        // GetErrorInfo now, as the channel hands it.
        if (value?.errorInfo)
        {
            await giveErrorInfo(value.errorInfo, thread);
        }
        return value;
    };

    /**
     * @param {number} target @param {any} message
     * @returns {Promise<any>}
     */
    const send = async(target, message)=>{
        const endpoint = host.table.endpoint(target);
        if (!endpoint?.alive)
        {
            return { hr: RPC_E_DISCONNECTED, disconnected: true };
        }
        return endpoint.deliver(message);
    };

    /**
     * The side of a call this process's memory is: what the marshaler needs
     * of it, with interfaces crossing on `thread`.
     *
     * @param {unknown} thread
     * @returns {import('../oleaut32/marshal.js').MarshalSide}
     */
    const sideOn = thread=>({
        readMemory: host.readMemory,
        writeMemory: host.writeMemory,
        allocate: bytes=>host.heap.allocate(bytes),
        free: address=>{
            host.heap.free(address);
        },
        allocateBstr: bytes=>host.bstr.allocate(bytes),
        freeBstr: bstr=>{
            host.bstr.free(bstr);
        },
        createSafeArray: (vt, bounds)=>host.safeArray?.create(vt, bounds) ?? 0,
        destroySafeArray: array=>host.safeArray?.destroy(array),
        exportInterface: (pointer, iid, transfer)=>exportInterface(pointer, iid, transfer, thread),
        importInterface: (reference, iid)=>importInterface(reference, iid, thread),
        releaseInterface: pointer=>callSlot(pointer, SLOT_RELEASE, [], thread),
    });

    /**
     * An interface pointer of this process, as a reference another process can
     * hold. One of our proxies is passed through as the reference it stands
     * for; anything else is entered in the table.
     *
     * @param {number} pointer @param {string} iid @param {boolean} transfer
     * @param {unknown} thread
     * @returns {Promise<Reference>}
     */
    const exportInterface = async(pointer, iid, transfer, thread)=>{
        const proxy = proxyAt.get(pointer >>> 0);
        if (proxy)
        {
            await send(proxy.endpoint, { kind: 'addref', object: proxy.object });
            if (transfer)
            {
                await releaseProxy(proxy, thread);
            }
            return { endpoint: proxy.endpoint, object: proxy.object };
        }
        await ensureWindow(thread);
        const identity = await queryGuest(pointer, IID_IUNKNOWN, thread);
        const unknown = identity.hr < 0 ? pointer >>> 0 : identity.pointer;
        let entry = exported.get(byIdentity.get(unknown) ?? 0);
        if (!entry)
        {
            entry = { id: nextObject++, unknown, interfaces: new Map(), stubs: new Map(), refs: 0,
                thread };
            exported.set(entry.id, entry);
            byIdentity.set(unknown, entry.id);
        }
        else if (identity.hr >= 0)
        {
            await callSlot(unknown, SLOT_RELEASE, [], thread);
        }
        if (identity.hr < 0)
        {
            await callSlot(unknown, SLOT_ADD_REF, [], thread);
        }
        if (!entry.interfaces.has(iid))
        {
            entry.interfaces.set(iid, pointer >>> 0);
            if (!transfer)
            {
                await callSlot(pointer, SLOT_ADD_REF, [], thread);
            }
        }
        else if (transfer)
        {
            await callSlot(pointer, SLOT_RELEASE, [], thread);
        }
        entry.refs++;
        return { endpoint: endpointId, object: entry.id };
    };

    /**
     * Gives back remote counts on an exported object, and the object itself
     * with the last of them.
     *
     * @param {Exported} entry @param {number} count @param {unknown} thread
     */
    const dropExported = async(entry, count, thread)=>{
        entry.refs -= count;
        if (entry.refs > 0 || !exported.has(entry.id))
        {
            return;
        }
        exported.delete(entry.id);
        byIdentity.delete(entry.unknown);
        // A stub holds the object too, and is the DLL's to release.
        for (const stub of entry.stubs.values())
        {
            await callSlot(stub, SLOT_DISCONNECT, [], thread);
            await callSlot(stub, SLOT_RELEASE, [], thread);
        }
        entry.stubs.clear();
        for (const pointer of entry.interfaces.values())
        {
            await callSlot(pointer, SLOT_RELEASE, [], thread);
        }
        await callSlot(entry.unknown, SLOT_RELEASE, [], thread);
    };

    /**
     * The exported entry of the object a pointer is an interface of, if it is
     * exported: found by its identity, as COM finds a stub manager.
     *
     * @param {number} pointer @param {unknown} thread
     * @returns {Promise<Exported | null>}
     */
    const exportedFor = async(pointer, thread)=>{
        const identity = await queryGuest(pointer, IID_IUNKNOWN, thread);
        const unknown = identity.hr < 0 ? pointer : identity.pointer;
        if (identity.hr >= 0)
        {
            await callSlot(unknown, SLOT_RELEASE, [], thread);
        }
        return exported.get(byIdentity.get(unknown) ?? 0) ?? null;
    };

    /**
     * @typedef {Object} Proxy
     * @property {number} endpoint
     * @property {number} object
     * @property {number} local     References the program holds.
     * @property {number} remote    Counts held on the exporter.
     * @property {Map<string, any>} records
     * @property {Map<string, { pointer: number, buffer: number }>} midl
     *           The interfaces a proxy/stub DLL's proxy stands for: its
     *           interface pointer, and the IRpcProxyBuffer that owns it.
     * @property {boolean} destroyed
     */

    /** @type {Map<string, Proxy>} */
    const proxies = new Map();
    /** @type {Map<number, Proxy>} */
    const proxyAt = new Map();

    /**
     * The vtable methods of a proxy for one interface, made once per
     * interface: the table they are published through is shared by every
     * proxy of it.
     *
     * @type {Map<string, any[]>}
     */
    const tables = new Map();

    /**
     * @param {string} iid
     * @param {import('../oleaut32/marshal.js').InterfaceDescription} description
     */
    const methodsFor = (iid, description)=>{
        const existing = tables.get(iid);
        if (existing)
        {
            return existing;
        }
        const methods = [
            { name: 'QueryInterface', argBytes: 12,
                invoke: (/** @type {Proxy} */ proxy, /** @type {number[]} */ [riid, out])=>
                    queryProxy(proxy, riid >>> 0, out >>> 0) },
            { name: 'AddRef', argBytes: 4,
                invoke: (/** @type {Proxy} */ proxy)=>++proxy.local },
            { name: 'Release', argBytes: 4,
                invoke: (/** @type {Proxy} */ proxy)=>releaseProxy(proxy, host.callerThread()) },
        ];
        for (let slot = 3; slot < description.methods.length; slot++)
        {
            const method = description.methods[slot];
            if (!method)
            {
                methods.push({ name: `slot ${slot}`, argBytes: 4, invoke: ()=>E_NOTIMPL });
                continue;
            }
            methods.push({ name: method.name, argBytes: argumentBytes(method),
                invoke: (/** @type {Proxy} */ proxy, /** @type {number[]} */ args)=>
                    callProxy(proxy, iid, description.name, method, [...args]) });
        }
        tables.set(iid, methods);
        return methods;
    };

    /**
     * Gives a proxy the interface: a record whose methods the type library
     * describes, or else a proxy the interface's proxy/stub DLL makes.
     *
     * @param {Proxy} proxy @param {string} iid @param {unknown} thread
     * @returns {Promise<boolean>}
     */
    const describeFor = async(proxy, iid, thread)=>{
        if (proxy.records.has(iid) || proxy.midl.has(iid))
        {
            return true;
        }
        const description = await catalog.describe(iid);
        if (description)
        {
            proxy.records.set(iid, Object.freeze({ object: proxy, id: iid,
                methods: methodsFor(iid, description) }));
            return true;
        }
        if (await midlProxy(proxy, iid, thread))
        {
            return true;
        }
        report(`no proxy for interface ${iid}: neither a type library nor a proxy/stub DLL`
            + ' is registered for it');
        return false;
    };

    /**
     * A proxy the interface's proxy/stub DLL makes, aggregated on this proxy
     * manager and connected to a channel to the exporter. Its methods are the
     * DLL's code, which marshals into the channel's buffer.
     *
     * @param {Proxy} proxy @param {string} iid @param {unknown} thread
     * @returns {Promise<boolean>}
     */
    const midlProxy = async(proxy, iid, thread)=>{
        const factory = await host.proxyStub?.factory(iid, thread) ?? 0;
        if (factory === 0 || !await describeFor(proxy, IID_IUNKNOWN, thread))
        {
            return false;
        }
        const outer = host.vtables.publish(proxy, IID_IUNKNOWN) >>> 0;
        const block = outer === 0 ? 0 : host.heap.allocate(24);
        if (block === 0)
        {
            return false;
        }
        proxyAt.set(outer, proxy);
        writeU32(block, 0);
        writeU32(block + 4, 0);
        host.writeMemory(block + 8, /** @type {Uint8Array} */ (parseGuid(iid)));
        const hr = (await callSlot(factory, SLOT_CREATE_PROXY, [outer, block + 8, block, block + 4],
            thread)) | 0;
        const buffer = readU32(block);
        const pointer = readU32(block + 4);
        host.heap.free(block);
        if (hr < 0 || buffer === 0 || pointer === 0)
        {
            report(`the proxy/stub DLL of ${iid} made no proxy: 0x${(hr >>> 0).toString(16)}`);
            return false;
        }
        // The interface came with a reference counted on this manager, which
        // holds its own interfaces without one.
        proxy.local--;
        const channel = makeChannel({ proxy, iid });
        const connected = channel.pointer === 0 ? E_OUTOFMEMORY
            : (await callSlot(buffer, SLOT_CONNECT, [channel.pointer], thread)) | 0;
        // The proxy holds the channel now, or nothing does.
        channel.release();
        if (connected < 0)
        {
            await callSlot(buffer, SLOT_RELEASE, [], thread);
            report(`the proxy of ${iid} did not connect: 0x${(connected >>> 0).toString(16)}`);
            return false;
        }
        proxy.midl.set(iid, { pointer, buffer });
        proxyAt.set(pointer, proxy);
        return true;
    };

    /**
     * The pointer a proxy is known by for one interface.
     *
     * @param {Proxy} proxy @param {string} iid
     */
    const pointerFor = (proxy, iid)=>
        proxy.midl.get(iid)?.pointer ?? (host.vtables.publish(proxy, iid) >>> 0);

    /**
     * Where a channel's call goes: to a proxy's exporter, for the channel a
     * proxy sends through; nowhere, for the one a stub answers through.
     *
     * @typedef {{ proxy: Proxy, iid: string } | null} ChannelSide
     */

    /**
     * IRpcChannelBuffer's methods, shared by every channel of this process:
     * each finds where it goes from the channel it was called through.
     */
    const channelMethods = Object.freeze([
        ...IUNKNOWN_METHODS,
        {
            name: 'GetBuffer',
            argBytes: 12,
            /** HRESULT GetBuffer(RPCOLEMESSAGE *pMessage, REFIID riid) */
            invoke: (/** @type {any} */ _channel, /** @type {number[]} */ [message])=>{
                const buffer = host.heap.allocate(Math.max(readU32(message + MESSAGE.BUFFER_LENGTH),
                    8));
                if (buffer === 0)
                {
                    return E_OUTOFMEMORY;
                }
                writeU32(message + MESSAGE.BUFFER, buffer);
                writeU32(message + MESSAGE.DATA_REPRESENTATION, NDR_LOCAL_DATA_REPRESENTATION);
                return S_OK;
            },
        },
        {
            name: 'SendReceive',
            argBytes: 12,
            /** HRESULT SendReceive(RPCOLEMESSAGE *pMessage, ULONG *pStatus) */
            invoke: (/** @type {{ side: ChannelSide }} */ channel,
                /** @type {number[]} */ [message, status])=>channel.side
                ? sendReceive(channel.side, message >>> 0, status >>> 0)
                : E_NOTIMPL,
        },
        {
            name: 'FreeBuffer',
            argBytes: 8,
            /** HRESULT FreeBuffer(RPCOLEMESSAGE *pMessage) */
            invoke: (/** @type {any} */ _channel, /** @type {number[]} */ [message])=>{
                const buffer = readU32(message + MESSAGE.BUFFER);
                if (buffer !== 0)
                {
                    host.heap.free(buffer);
                    writeU32(message + MESSAGE.BUFFER, 0);
                }
                return S_OK;
            },
        },
        {
            name: 'GetDestCtx',
            argBytes: 12,
            /** HRESULT GetDestCtx(DWORD *pdwDestContext, void **ppvDestContext) */
            invoke: (/** @type {any} */ _channel, /** @type {number[]} */ [context, pointer])=>{
                if ((context >>> 0) !== 0)
                {
                    writeU32(context, MSHCTX_LOCAL);
                }
                if ((pointer >>> 0) !== 0)
                {
                    writeU32(pointer, 0);
                }
                return S_OK;
            },
        },
        {
            name: 'IsConnected',
            argBytes: 4,
            /** HRESULT IsConnected(void) */
            invoke: (/** @type {{ side: ChannelSide }} */ channel)=>{
                const side = channel.side;
                return side && !side.proxy.destroyed
                    && host.table.endpoint(side.proxy.endpoint)?.alive ? S_OK : 1;
            },
        },
    ]);

    /**
     * An IRpcChannelBuffer in guest memory, made with one reference.
     *
     * @param {ChannelSide} side
     */
    const makeChannel = side=>{
        let refs = 1;
        const channel = {
            side,
            destroyed: false,
            /** @param {string} id */
            interfaceFor: id=>[IID_IUNKNOWN, IID_IRPCCHANNELBUFFER].includes(id) ? record : null,
            addRef: ()=>++refs,
            release: ()=>{
                refs = Math.max(refs - 1, 0);
                channel.destroyed = refs === 0;
                return refs;
            },
            pointer: 0,
        };
        const record = Object.freeze({ object: channel, id: IID_IRPCCHANNELBUFFER,
            methods: channelMethods });
        channel.pointer = host.vtables.publish(channel, IID_IRPCCHANNELBUFFER) >>> 0;
        return channel;
    };

    /**
     * A proxy's call: the bytes its code marshaled go to the exporter, and
     * the bytes the stub there marshaled come back in their place.
     *
     * @param {{ proxy: Proxy, iid: string }} side
     * @param {number} message @param {number} status
     */
    const sendReceive = async({ proxy, iid }, message, status)=>{
        const thread = host.callerThread();
        if (proxy.destroyed)
        {
            return RPC_E_DISCONNECTED;
        }
        const request = readU32(message + MESSAGE.BUFFER);
        const bytes = host.readMemory(request, readU32(message + MESSAGE.BUFFER_LENGTH)).slice();
        const reply = await outgoing(thread, proxy.endpoint, { kind: 'ndr', object: proxy.object,
            iid, method: readU32(message + MESSAGE.METHOD), bytes });
        if (reply.disconnected)
        {
            return RPC_E_DISCONNECTED;
        }
        if ((reply.hr | 0) < 0)
        {
            return reply.hr | 0;
        }
        /** @type {Uint8Array} */
        const answer = reply.bytes ?? new Uint8Array(0);
        const buffer = host.heap.allocate(Math.max(answer.length, 8));
        if (buffer === 0)
        {
            return E_OUTOFMEMORY;
        }
        host.writeMemory(buffer, answer);
        host.heap.free(request);
        writeU32(message + MESSAGE.BUFFER, buffer);
        writeU32(message + MESSAGE.BUFFER_LENGTH, answer.length);
        writeU32(message + MESSAGE.DATA_REPRESENTATION, NDR_LOCAL_DATA_REPRESENTATION);
        if (status !== 0)
        {
            writeU32(status, 0);
        }
        return S_OK;
    };

    /** @type {ReturnType<typeof makeChannel> | null} */
    let stubChannel = null;

    /**
     * The stub a proxy/stub DLL makes for an exported object's interface,
     * made the first time a call for it arrives.
     *
     * @param {Exported} entry @param {string} iid @param {unknown} thread
     */
    const stubFor = async(entry, iid, thread)=>{
        const known = entry.stubs.get(iid);
        if (known !== undefined)
        {
            return known;
        }
        const factory = await host.proxyStub?.factory(iid, thread) ?? 0;
        const block = factory === 0 ? 0 : host.heap.allocate(20);
        if (block === 0)
        {
            return 0;
        }
        writeU32(block, 0);
        host.writeMemory(block + 4, /** @type {Uint8Array} */ (parseGuid(iid)));
        const hr = (await callSlot(factory, SLOT_CREATE_STUB, [block + 4, entry.unknown, block],
            thread)) | 0;
        const stub = readU32(block);
        host.heap.free(block);
        if (hr < 0 || stub === 0)
        {
            report(`the proxy/stub DLL of ${iid} made no stub: 0x${(hr >>> 0).toString(16)}`);
            return 0;
        }
        entry.stubs.set(iid, stub);
        return stub;
    };

    /**
     * A call a proxy/stub DLL's proxy sent: its bytes put in an RPCOLEMESSAGE
     * here, the DLL's stub invoked on them, and what the stub marshaled
     * through the channel's GetBuffer sent back.
     *
     * @param {Exported} entry @param {any} message @param {unknown} thread
     */
    const invokeStub = async(entry, message, thread)=>{
        const stub = await stubFor(entry, message.iid, thread);
        if (stub === 0)
        {
            return { hr: E_NOINTERFACE };
        }
        stubChannel ??= makeChannel(null);
        /** @type {Uint8Array} */
        const bytes = message.bytes;
        const rpc = host.heap.allocate(MESSAGE.SIZE);
        const request = host.heap.allocate(Math.max(bytes.length, 8));
        if (rpc === 0 || request === 0 || stubChannel.pointer === 0)
        {
            return { hr: E_OUTOFMEMORY };
        }
        host.writeMemory(rpc, new Uint8Array(MESSAGE.SIZE));
        host.writeMemory(request, bytes);
        writeU32(rpc + MESSAGE.DATA_REPRESENTATION, NDR_LOCAL_DATA_REPRESENTATION);
        writeU32(rpc + MESSAGE.BUFFER, request);
        writeU32(rpc + MESSAGE.BUFFER_LENGTH, bytes.length);
        writeU32(rpc + MESSAGE.METHOD, message.method);
        const hr = (await callGuarded(stub, SLOT_INVOKE, [rpc, stubChannel.pointer], thread)) | 0;
        // The request stays until the stub is done: what it unmarshaled in
        // place is read from there while the method runs.
        const replied = readU32(rpc + MESSAGE.BUFFER);
        const reply = replied !== request && replied !== 0
            ? host.readMemory(replied, readU32(rpc + MESSAGE.BUFFER_LENGTH)).slice()
            : new Uint8Array(0);
        if (replied !== request && replied !== 0)
        {
            host.heap.free(replied);
        }
        host.heap.free(request);
        host.heap.free(rpc);
        return hr < 0 ? { hr } : { hr: S_OK, bytes: reply };
    };

    /**
     * @param {number} endpoint @param {number} object
     * @returns {Proxy}
     */
    const makeProxy = (endpoint, object)=>{
        /** @type {Proxy & { interfaceFor: (id: string) => any }} */
        const proxy = {
            endpoint,
            object,
            local: 0,
            remote: 0,
            records: new Map(),
            midl: new Map(),
            destroyed: false,
            interfaceFor: id=>proxy.records.get(formatGuid(
                /** @type {Uint8Array} */ (parseGuid(id) ?? new Uint8Array(16)))) ?? null,
        };
        proxies.set(`${endpoint}:${object}`, proxy);
        return proxy;
    };

    /**
     * A pointer of this process for the object a reference names: the object
     * itself when it is ours, a proxy when it is not.
     *
     * @param {Reference} reference @param {string} iid @param {unknown} thread
     * @returns {Promise<number>}
     */
    const importInterface = async(reference, iid, thread)=>{
        if (reference.endpoint === endpointId)
        {
            const entry = exported.get(reference.object);
            if (!entry)
            {
                return 0;
            }
            let pointer = entry.interfaces.get(iid) ?? 0;
            if (pointer === 0)
            {
                pointer = (await queryGuest(entry.unknown, iid, thread)).pointer;
            }
            else
            {
                await callSlot(pointer, SLOT_ADD_REF, [], thread);
            }
            await dropExported(entry, 1, thread);
            return pointer;
        }
        const key = `${reference.endpoint}:${reference.object}`;
        const proxy = proxies.get(key) ?? makeProxy(reference.endpoint, reference.object);
        proxy.remote++;
        if (!await describeFor(proxy, IID_IUNKNOWN, thread)
            || !await describeFor(proxy, iid, thread))
        {
            if (proxy.local === 0)
            {
                await retire(proxy, thread);
            }
            return 0;
        }
        const pointer = pointerFor(proxy, iid);
        if (pointer === 0)
        {
            return 0;
        }
        proxy.local++;
        proxyAt.set(pointer, proxy);
        return pointer;
    };

    /**
     * QueryInterface through a proxy: an interface it already has is answered
     * here, any other is asked of the real object first.
     *
     * @param {Proxy} proxy @param {number} riid @param {number} out
     */
    const queryProxy = async(proxy, riid, out)=>{
        const thread = host.callerThread();
        if (out === 0)
        {
            return E_POINTER;
        }
        writeU32(out, 0);
        const iid = formatGuid(host.readMemory(riid, 16));
        if (!proxy.records.has(iid) && !proxy.midl.has(iid))
        {
            const reply = await outgoing(thread, proxy.endpoint,
                { kind: 'query', object: proxy.object, iid });
            if ((reply.hr | 0) < 0)
            {
                return reply.hr | 0;
            }
            if (!await describeFor(proxy, iid, thread))
            {
                return E_NOINTERFACE;
            }
        }
        const pointer = pointerFor(proxy, iid);
        if (pointer === 0)
        {
            return E_OUTOFMEMORY;
        }
        proxyAt.set(pointer, proxy);
        proxy.local++;
        writeU32(out, pointer);
        return S_OK;
    };

    /** @param {Proxy} proxy @param {unknown} thread */
    const releaseProxy = async(proxy, thread)=>{
        if (proxy.local > 0)
        {
            proxy.local--;
        }
        if (proxy.local > 0)
        {
            return proxy.local;
        }
        await retire(proxy, thread);
        return 0;
    };

    /**
     * A proxy nobody holds: its pointers stop answering, and its counts go
     * back to the exporter. A proxy/stub DLL's proxies are disconnected and
     * released on `thread`; a process that has ended has no thread to do it
     * on and no memory it would matter to.
     *
     * @param {Proxy} proxy @param {unknown} thread
     */
    const retire = async(proxy, thread)=>{
        if (proxy.destroyed)
        {
            return;
        }
        proxy.destroyed = true;
        proxies.delete(`${proxy.endpoint}:${proxy.object}`);
        for (const [pointer, owner] of proxyAt)
        {
            if (owner === proxy)
            {
                proxyAt.delete(pointer);
            }
        }
        for (const iid of proxy.records.keys())
        {
            host.vtables.unpublish?.(proxy, iid);
        }
        for (const { buffer } of proxy.midl.values())
        {
            if (thread !== null)
            {
                await callSlot(buffer, SLOT_DISCONNECT, [], thread);
                await callSlot(buffer, SLOT_RELEASE, [], thread);
            }
        }
        proxy.midl.clear();
        if (proxy.remote > 0)
        {
            const count = proxy.remote;
            proxy.remote = 0;
            await send(proxy.endpoint, { kind: 'release', object: proxy.object, count });
        }
    };

    /**
     * A method called through a proxy: the arguments out, the call made in
     * the exporter's apartment, the [out] values back.
     *
     * @param {Proxy} proxy @param {string} iid @param {string} name
     * @param {import('../oleaut32/marshal.js').MethodDescription} method
     * @param {number[]} args
     */
    const callProxy = async(proxy, iid, name, method, args)=>{
        if (method.unsupported)
        {
            report(`${name}::${method.name} cannot cross to another process:`
                + ` ${method.unsupported}`);
            return E_NOTIMPL;
        }
        const thread = host.callerThread();
        const side = sideOn(thread);
        let request;
        try
        {
            request = await marshalRequest(side, method, args);
        }
        catch (e){
            report(`${name}::${method.name}: ${e instanceof Error ? e.message : String(e)}`);
            return E_NOTIMPL;
        }
        const reply = await outgoing(thread, proxy.endpoint,
            { kind: 'call', object: proxy.object, iid, slot: method.slot, request });
        if (reply.disconnected)
        {
            return RPC_E_DISCONNECTED;
        }
        if (reply.reply)
        {
            await unmarshalReply(side, method, args, request, reply.reply);
        }
        return reply.hr | 0;
    };

    /**
     * What a message asks of this process, done on the object's own thread.
     *
     * @param {any} message @param {unknown} thread
     * @returns {Promise<any>}
     */
    const execute = async(message, thread)=>{
        if (message.kind === 'enter')
        {
            return { hr: await message.work(thread) };
        }
        const reply = await executeKind(message, thread);
        if (message.kind === 'call' || message.kind === 'ndr')
        {
            const errorInfo = await takeErrorInfo(thread);
            if (errorInfo)
            {
                return { ...reply, errorInfo };
            }
        }
        return reply;
    };

    /**
     * What each kind of message asks, done.
     *
     * @param {any} message @param {unknown} thread
     * @returns {Promise<any>}
     */
    const executeKind = async(message, thread)=>{
        const entry = exported.get(message.object);
        if (!entry)
        {
            return { hr: RPC_E_DISCONNECTED, disconnected: true };
        }
        switch (message.kind)
        {
            case 'release':
                await dropExported(entry, message.count, thread);
                return { hr: S_OK };
            case 'query': {
                if (entry.interfaces.has(message.iid) || message.iid === IID_IUNKNOWN)
                {
                    return { hr: S_OK };
                }
                const found = await queryGuest(entry.unknown, message.iid, thread);
                if (found.hr >= 0)
                {
                    entry.interfaces.set(message.iid, found.pointer);
                }
                return { hr: found.hr };
            }
            case 'classobject': {
                const found = await queryGuest(entry.unknown, message.iid, thread);
                if (found.hr < 0)
                {
                    return { hr: found.hr };
                }
                return { hr: S_OK,
                    reference: await exportInterface(found.pointer, message.iid, true, thread) };
            }
            case 'activate': {
                const factory = await queryGuest(entry.unknown, IID_ICLASSFACTORY, thread);
                if (factory.hr < 0)
                {
                    return { hr: factory.hr };
                }
                const block = host.heap.allocate(20);
                writeU32(block, 0);
                host.writeMemory(block + 4, /** @type {Uint8Array} */ (parseGuid(message.iid)));
                const hr = (await callGuarded(factory.pointer, SLOT_CREATE_INSTANCE,
                    [0, block + 4, block], thread)) | 0;
                const made = readU32(block);
                host.heap.free(block);
                await callSlot(factory.pointer, SLOT_RELEASE, [], thread);
                if (hr < 0 || made === 0)
                {
                    return { hr: hr < 0 ? hr : E_NOINTERFACE };
                }
                return { hr, reference: await exportInterface(made, message.iid, true, thread) };
            }
            case 'ndr':
                return invokeStub(entry, message, thread);
            case 'call': {
                const pointer = entry.interfaces.get(message.iid)
                    ?? (message.iid === IID_IUNKNOWN ? entry.unknown : 0);
                const description = await catalog.describe(message.iid);
                const method = description?.methods[message.slot];
                if (!pointer || !method)
                {
                    return { hr: E_NOINTERFACE };
                }
                const side = sideOn(thread);
                const call = await unmarshalRequest(side, method, message.request);
                const hr = (await callGuarded(pointer, message.slot, call.words, thread)) | 0;
                return { hr, reply: await marshalReply(side, method, message.request, call) };
            }
            default:
                return { hr: E_NOTIMPL };
        }
    };

    /** @type {Endpoint} */
    const endpoint = {
        process: host.process,
        alive: true,
        deliver(message){
            const entry = exported.get(message.object);
            if (!entry || !endpoint.alive)
            {
                return Promise.resolve({ hr: RPC_E_DISCONNECTED, disconnected: true });
            }
            // Counting needs no guest code, so it needs no apartment either.
            if (message.kind === 'addref')
            {
                entry.refs++;
                return Promise.resolve({ hr: S_OK });
            }
            return enqueue(entry.thread, message);
        },
        async rundown(){
            for (const home of apartments.values())
            {
                // A process that ended in the middle of a call never answers
                // it: the caller is told the server is gone.
                for (const resolve of [...home.queue.splice(0).map(item=>item.resolve),
                    ...home.running])
                {
                    resolve({ hr: RPC_E_DISCONNECTED, disconnected: true });
                }
                home.running.clear();
            }
            for (const proxy of [...proxies.values()])
            {
                await retire(proxy, null);
            }
        },
    };
    const endpointId = host.table.attach(endpoint);

    /** @type {Map<number, number>} this process's registrations, by cookie */
    const registered = new Map();

    return {
        /**
         * Registers a class object for other processes. The table holds one
         * count on it until the registration is revoked.
         *
         * @param {string} clsid @param {number} object @param {number} flags
         * @param {number} cookie
         */
        async registerClass(clsid, object, flags, cookie){
            const thread = host.callerThread();
            const reference = await exportInterface(object, IID_IUNKNOWN, false, thread);
            registered.set(cookie, reference.object);
            host.table.register({ clsid, endpoint: endpointId, object: reference.object, flags,
                cookie, suspended: (flags & REGCLS_SUSPENDED) !== 0, used: false });
        },

        /** @param {number} cookie */
        async revokeClass(cookie){
            const object = registered.get(cookie);
            if (object === undefined)
            {
                return false;
            }
            registered.delete(cookie);
            host.table.revoke(endpointId, cookie);
            const entry = exported.get(object);
            if (entry)
            {
                await dropExported(entry, 1, host.callerThread());
            }
            return true;
        },

        /** CoResumeClassObjects: this process's suspended registrations become visible. */
        resume: ()=>host.table.resume(endpointId),

        /** CoSuspendClassObjects: this process's registrations stop being handed out. */
        suspend: ()=>host.table.suspend(endpointId),

        /**
         * CoLockObjectExternal: a count on the object held as another
         * process's are, so it stays exported while no process holds it; the
         * last unlock lets it go only when asked to, and otherwise leaves it
         * to the next count given back.
         *
         * @param {number} pointer @param {boolean} lock @param {boolean} lastUnlockReleases
         * @param {unknown} [thread]
         */
        async lockExternal(pointer, lock, lastUnlockReleases, thread = host.callerThread()){
            if (lock)
            {
                await exportInterface(pointer >>> 0, IID_IUNKNOWN, false, thread);
                return;
            }
            const entry = await exportedFor(pointer >>> 0, thread);
            if (!entry)
            {
                return;
            }
            if (lastUnlockReleases)
            {
                await dropExported(entry, 1, thread);
            }
            else
            {
                entry.refs--;
            }
        },

        /**
         * CoDisconnectObject: every other process's hold on the object goes at
         * once; their proxies answer RPC_E_DISCONNECTED from then on.
         *
         * @param {number} pointer @param {unknown} [thread]
         */
        async disconnect(pointer, thread = host.callerThread()){
            const entry = await exportedFor(pointer >>> 0, thread);
            if (entry)
            {
                await dropExported(entry, entry.refs, thread);
            }
        },

        /**
         * Whether `thread` is running a call another process made: what
         * CoGetCallContext answers inside of.
         *
         * @param {unknown} [thread]
         */
        serving: (thread = host.callerThread())=>(apartments.get(thread)?.running.size ?? 0) > 0,

        /**
         * The apartment of `thread` made ready for work other threads hand it:
         * its window made, on that thread, as ole32 makes one when a thread
         * enters a single-threaded apartment.
         *
         * @param {unknown} [thread]
         */
        prepare: (thread = host.callerThread())=>ensureWindow(thread),

        /**
         * Runs `work` in the apartment of `thread`: at once on the caller's
         * own thread, otherwise posted to that apartment as an incoming call
         * is, the caller serving its own apartment until it ran.
         *
         * @param {unknown} thread @param {(thread: unknown) => Promise<number> | number} work
         * @returns {Promise<number>}
         */
        async enter(thread, work){
            const caller = host.callerThread();
            if (thread === caller)
            {
                return work(caller);
            }
            const reply = await awaitServing(caller, enqueue(thread, { kind: 'enter', work }));
            return reply.hr;
        },

        /** Whether a pointer is a proxy of this process's for another's object. @param {number} pointer */
        isProxy: pointer=>proxyAt.has(pointer >>> 0),

        /**
         * An object of a class served by another process: registered already,
         * or started with `command` and waited for.
         *
         * @param {string} clsid @param {string} iid @param {number} out
         * @param {string | null} command  The server's command line, or null.
         * @param {'activate' | 'classobject'} kind
         *        An instance, or the class object itself.
         * @returns {Promise<number>}
         */
        async activate(clsid, iid, out, command, kind = 'activate'){
            const thread = host.callerThread();
            let entry = host.table.take(clsid);
            if (!entry)
            {
                if (command === null)
                {
                    return REGDB_E_CLASSNOTREG;
                }
                const launched = host.table.hooks.launch?.({ command, clsid }, host.process)
                    ?? null;
                if (!launched)
                {
                    report(`the server of ${clsid} (${command}) cannot be started here`);
                    return CO_E_SERVER_EXEC_FAILURE;
                }
                if (!await host.table.whenRegistered(clsid, launched.exited))
                {
                    report(`the server of ${clsid} ended without registering it`);
                    return CO_E_SERVER_EXEC_FAILURE;
                }
                entry = host.table.take(clsid);
                if (!entry)
                {
                    return CO_E_SERVER_EXEC_FAILURE;
                }
            }
            const reply = await outgoing(thread, entry.endpoint,
                { kind, object: entry.object, iid });
            if (reply.disconnected)
            {
                return CO_E_SERVER_EXEC_FAILURE;
            }
            if ((reply.hr | 0) < 0)
            {
                return reply.hr | 0;
            }
            const pointer = await importInterface(reply.reference, iid, thread);
            if (pointer === 0)
            {
                return E_NOINTERFACE;
            }
            writeU32(out, pointer);
            return S_OK;
        },

        /**
         * An interface pointer of this process as a reference another process
         * can hold, which carries a reference of its own: what an OBJREF
         * CoMarshalInterface writes stands for.
         *
         * @param {number} pointer @param {string} iid
         * @param {unknown} [thread]  Whose call this is; the caller's by default.
         * @returns {Promise<Reference>}
         */
        exportReference: (pointer, iid, thread = host.callerThread())=>
            exportInterface(pointer >>> 0, iid, false, thread),

        /**
         * A reference as a pointer of this process, which takes the reference
         * it carried: what CoUnmarshalInterface answers with. 0 when nothing
         * here can stand for it.
         *
         * @param {Reference} reference @param {string} iid
         * @param {unknown} [thread]
         * @returns {Promise<number>}
         */
        importReference: (reference, iid, thread = host.callerThread())=>
            importInterface(reference, iid, thread),

        /**
         * One more count on what a reference names, for a reference handed on
         * while the holder keeps its own: what the running object table does
         * for each process that asks it for an object.
         *
         * @param {Reference} reference @param {unknown} [thread]
         */
        async addReference(reference, thread = host.callerThread()){
            if (reference.endpoint !== endpointId)
            {
                await send(reference.endpoint, { kind: 'addref', object: reference.object });
                return;
            }
            const entry = exported.get(reference.object);
            if (entry)
            {
                entry.refs++;
            }
            void thread;
        },

        /** This process's endpoint in the run's table. */
        endpoint: ()=>endpointId,

        /**
         * Gives back the reference a reference carries, unused: what
         * CoReleaseMarshalData does with a packet nobody unmarshaled.
         *
         * @param {Reference} reference @param {unknown} [thread]
         */
        async releaseReference(reference, thread = host.callerThread()){
            if (reference.endpoint !== endpointId)
            {
                await send(reference.endpoint,
                    { kind: 'release', object: reference.object, count: 1 });
                return S_OK;
            }
            const entry = exported.get(reference.object);
            if (!entry)
            {
                return RPC_E_INVALID_OBJREF;
            }
            await dropExported(entry, 1, thread);
            return S_OK;
        },

        diagnostics: ()=>({
            exported: exported.size,
            proxies: proxies.size,
            registered: registered.size,
        }),
    };
}
