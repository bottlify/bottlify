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

export const REGCLS_MULTIPLEUSE = 1;
export const REGCLS_SUSPENDED = 4;

/** The message that tells an apartment a call is waiting for it. */
const WM_OLE_CALL = 0x0400;

const SLOT_QUERY_INTERFACE = 0;
const SLOT_ADD_REF = 1;
const SLOT_RELEASE = 2;
const SLOT_CREATE_INSTANCE = 3;

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
 * @property {(process: unknown) => void} [publish]
 *     What a process has written -- its files and its registry -- made what
 *     every other process sees, before another process runs on its behalf.
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
 * @property {(api: string, detail: string) => void} [divergence]
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
            host.table.hooks.publish?.(host.process);
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
     * Sends a message to another process and waits for its answer, running
     * the calls that arrive for this thread meanwhile.
     *
     * @param {unknown} thread @param {number} target @param {any} message
     * @returns {Promise<any>}
     */
    const outgoing = async(thread, target, message)=>{
        const home = apartment(thread);
        home.outgoing++;
        try
        {
            // What this process wrote is what the other one runs against.
            host.table.hooks.publish?.(host.process);
            const answer = send(target, message).then(value=>({ value }));
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
        destroySafeArray: array=>{
            host.safeArray?.destroy(array);
        },
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
                await releaseProxy(proxy);
            }
            return { endpoint: proxy.endpoint, object: proxy.object };
        }
        await ensureWindow(thread);
        const identity = await queryGuest(pointer, IID_IUNKNOWN, thread);
        const unknown = identity.hr < 0 ? pointer >>> 0 : identity.pointer;
        let entry = exported.get(byIdentity.get(unknown) ?? 0);
        if (!entry)
        {
            entry = { id: nextObject++, unknown, interfaces: new Map(), refs: 0, thread };
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
        for (const pointer of entry.interfaces.values())
        {
            await callSlot(pointer, SLOT_RELEASE, [], thread);
        }
        await callSlot(entry.unknown, SLOT_RELEASE, [], thread);
    };

    /**
     * @typedef {Object} Proxy
     * @property {number} endpoint
     * @property {number} object
     * @property {number} local     References the program holds.
     * @property {number} remote    Counts held on the exporter.
     * @property {Map<string, any>} records
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
                invoke: (/** @type {Proxy} */ proxy)=>releaseProxy(proxy) },
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
     * Gives a proxy the record for one interface, when anything describes it.
     *
     * @param {Proxy} proxy @param {string} iid
     * @returns {Promise<boolean>}
     */
    const describeFor = async(proxy, iid)=>{
        if (proxy.records.has(iid))
        {
            return true;
        }
        const description = await catalog.describe(iid);
        if (!description)
        {
            report(`no proxy for interface ${iid}: nothing registers a type library for it`);
            return false;
        }
        proxy.records.set(iid, Object.freeze({ object: proxy, id: iid,
            methods: methodsFor(iid, description) }));
        return true;
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
        if (!await describeFor(proxy, iid) || !await describeFor(proxy, IID_IUNKNOWN))
        {
            if (proxy.local === 0)
            {
                await retire(proxy);
            }
            return 0;
        }
        const pointer = host.vtables.publish(proxy, iid) >>> 0;
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
        if (out === 0)
        {
            return E_POINTER;
        }
        writeU32(out, 0);
        const iid = formatGuid(host.readMemory(riid, 16));
        if (!proxy.records.has(iid))
        {
            const reply = await outgoing(host.callerThread(), proxy.endpoint,
                { kind: 'query', object: proxy.object, iid });
            if ((reply.hr | 0) < 0)
            {
                return reply.hr | 0;
            }
            if (!await describeFor(proxy, iid))
            {
                return E_NOINTERFACE;
            }
        }
        const pointer = host.vtables.publish(proxy, iid) >>> 0;
        if (pointer === 0)
        {
            return E_OUTOFMEMORY;
        }
        proxyAt.set(pointer, proxy);
        proxy.local++;
        writeU32(out, pointer);
        return S_OK;
    };

    /** @param {Proxy} proxy */
    const releaseProxy = async proxy=>{
        if (proxy.local > 0)
        {
            proxy.local--;
        }
        if (proxy.local > 0)
        {
            return proxy.local;
        }
        await retire(proxy);
        return 0;
    };

    /**
     * A proxy nobody holds: its pointers stop answering, and its counts go
     * back to the exporter.
     *
     * @param {Proxy} proxy
     */
    const retire = async proxy=>{
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
                await retire(proxy);
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

        diagnostics: ()=>({
            exported: exported.size,
            proxies: proxies.size,
            registered: registered.size,
        }),
    };
}
