/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * rpcrt4 under a MIDL `-Os` proxy/stub DLL: the runtime its generated code
 * calls, and the COM objects a DLL built from dlldata.c hands out through it.
 *
 * The DLL is the program's and its code runs in the guest. What it gets from
 * here is laid out where it looks, because the generated code reads it:
 *
 * - The class factory is the DLL's own CStdPSFactoryBuffer, which
 *   NdrDllGetClassObject fills in -- IPSFactoryBuffer vtable, count, the
 *   ProxyFileInfo list -- and hands out.
 * - A proxy is a CStdProxyBuffer: the IRpcProxyBuffer vtable, then the
 *   pointer to the DLL's proxy vtable, which is the interface pointer a
 *   program is given. From that pointer on the fields are the count, the
 *   outer unknown, the channel and the factory, which is where NdrProxy*
 *   finds the channel and IUnknown_*_Proxy the outer unknown.
 * - A stub is a CStdStubBuffer whose vtable is the DLL's IRpcStubBuffer
 *   vtable (these CStdStubBuffer_* entry points, behind the DLL's thunks),
 *   and whose third word is the server object the generated stubs call.
 *
 * A proxy method's RpcTryExcept and RpcTryFinally are frames on the guest's
 * own exception chain. When a call made here fails -- the channel, an
 * unmarshal, an allocation -- the status is raised on the calling thread as
 * RpcRaiseException raises it, and the generated code's handlers take it.
 * Those calls have usually waited on something by then, so the raise is made
 * from the calling thread's own stack rather than from this handler's.
 */

import { formatGuid } from '../ole32/guid.js';
import { OBJREF_BYTES, decodeObjref } from '../ole32/objref.js';
import {
    NDR_LOCAL_DATA_REPRESENTATION, PROXY_PHASE, RPC_MESSAGE, RPC_STATUS, RpcException,
    STUB_DESC, STUB_MESSAGE, createNdr,
} from './ndr.js';
import {
    STUB_VTBL, factoryClass, readProxyFiles, registerProxyFiles, unregisterProxyFiles,
} from './proxyfile.js';

const S_OK = 0;
const S_FALSE = 1;
const E_NOTIMPL = 0x80004001 | 0;
const E_NOINTERFACE = 0x80004002 | 0;
const E_POINTER = 0x80004003 | 0;
const E_FAIL = 0x80004005 | 0;
const E_UNEXPECTED = 0x8000ffff | 0;
const E_OUTOFMEMORY = 0x8007000e | 0;
const CLASS_E_CLASSNOTAVAILABLE = 0x80040111 | 0;
const CO_E_OBJNOTCONNECTED = 0x800401fd | 0;
const RPC_S_PROCNUM_OUT_OF_RANGE = 1745;

const IID_IUNKNOWN = '{00000000-0000-0000-C000-000000000046}';
const IID_IPSFACTORYBUFFER = '{D5F569D0-593B-101A-B569-08002B2DBF7A}';
const IID_IRPCPROXYBUFFER = '{D5F56A34-593B-101A-B569-08002B2DBF7A}';
const IID_IRPCSTUBBUFFER = '{D5F56AFC-593B-101A-B569-08002B2DBF7A}';

/** IUnknown's slots, and IRpcChannelBuffer's after them. */
const SLOT = Object.freeze({
    QUERY_INTERFACE: 0,
    ADD_REF: 1,
    RELEASE: 2,
    GET_BUFFER: 3,
    SEND_RECEIVE: 4,
    FREE_BUFFER: 5,
});

/** CStdPSFactoryBuffer, in the DLL. */
const FACTORY = Object.freeze({ VTABLE: 0, REFS: 4, FILES: 8, SIZE: 16 });

/**
 * CStdProxyBuffer, from the interface pointer a program holds: the
 * IRpcProxyBuffer vtable is the word before it.
 */
const PROXY = Object.freeze({
    BUFFER: -4, VTABLE: 0, REFS: 4, OUTER: 8, CHANNEL: 12, FACTORY: 16, SIZE: 24,
});

/** CStdStubBuffer. */
const STUB = Object.freeze({ VTABLE: 0, REFS: 4, SERVER: 8, FACTORY: 20, SIZE: 28 });

/** The phase a stub starts in. */
const STUB_UNMARSHAL = 0;

/** A proxy vtable entry a stubless (-Oicf) proxy leaves for rpcrt4 to fill. */
const STUBLESS_ENTRY = 0xffffffff;

/**
 * ole32's side of an interface pointer crossing: an OBJREF made for it, and
 * a pointer made from one.
 *
 * @typedef {Object} ObjrefMarshaler
 * @property {(pointer: number, iid: string, thread: unknown)
 *     => Promise<{ hr: number, objref: Uint8Array | null }>} marshal
 * @property {(objref: Uint8Array, iid: string, thread: unknown)
 *     => Promise<{ hr: number, pointer: number }>} unmarshal
 */

/**
 * @typedef {Object} RuntimeHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(bytes: number) => number} allocate  Task memory, as CoTaskMemAlloc.
 * @property {(address: number) => void} free
 * @property {(entry: number, args: number[], thread: unknown) => Promise<number>} call
 *           A stdcall into guest code on `thread`.
 * @property {() => unknown} callerThread  Whose call is being handled.
 * @property {(name: string, fn: { argBytes: number, handler: (args: number[]) => any })
 *     => number} register  A guest address that runs a host routine.
 * @property {(code: number) => any} raise
 *           RaiseException(code, EXCEPTION_NONCONTINUABLE) from a handler that
 *           has not waited on anything.
 * @property {(code: number, thread: unknown) => Promise<any>} raiseLater
 *           The same from one that has: what the handler answers, so that its
 *           thread goes on in the raise.
 * @property {import('./proxyfile.js').ProxyHive} [hive]
 * @property {(module: number) => string | null} [modulePath]
 * @property {() => ObjrefMarshaler | null} [marshaler]
 * @property {(detail: string) => void} [divergence]
 */

/**
 * @param {RuntimeHost} host
 */
export function createRuntime(host){
    const report = (/** @type {string} */ detail)=>host.divergence?.(detail);

    /** @param {number} at */
    const u32 = at=>{
        const bytes = host.readMemory(at >>> 0, 4);
        return (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
    };
    /** @param {number} at @param {number} value */
    const w32 = (at, value)=>host.writeMemory(at >>> 0, Uint8Array.of(
        value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff));
    /** @param {number} at */
    const guidAt = at=>formatGuid(host.readMemory(at >>> 0, 16));

    /**
     * A method of a guest object, whoever implements it.
     *
     * @param {number} pointer @param {number} slot @param {number[]} args @param {unknown} thread
     */
    const callSlot = (pointer, slot, args, thread)=>
        host.call(u32(u32(pointer) + slot * 4), [pointer >>> 0, ...args], thread);

    /**
     * QueryInterface on a guest object for an IID the guest already holds,
     * answering the pointer or 0.
     *
     * @param {number} pointer @param {number} riid @param {unknown} thread
     */
    const query = async(pointer, riid, thread)=>{
        const out = host.allocate(4);
        if (out === 0)
        {
            return { hr: E_OUTOFMEMORY, pointer: 0 };
        }
        w32(out, 0);
        const hr = (await callSlot(pointer, SLOT.QUERY_INTERFACE, [riid, out], thread)) | 0;
        const found = u32(out);
        host.free(out);
        return { hr, pointer: hr < 0 ? 0 : found };
    };

    /**
     * Runs a routine that may fail with an RPC status, raising that status on
     * the calling thread when it does.
     *
     * @param {unknown} thread @param {() => Promise<number>} work
     */
    const raising = (thread, work)=>work().catch(e=>{
        if (e instanceof RpcException)
        {
            // What was wrong is known only here; the guest sees a bare status.
            report(`raised RPC status ${e.code}: ${e.message}`);
            return host.raiseLater(e.code, thread);
        }
        throw e;
    });

    // --- the format-string engine, over this process ---------------------------

    const ndr = createNdr({
        readMemory: host.readMemory,
        writeMemory: host.writeMemory,
        // Through the stub descriptor's routines, which are the DLL's -- the
        // NdrOleAllocate it imported, as a rule, but not necessarily.
        allocate: (call, bytes)=>{
            const routine = u32(call.message + STUB_MESSAGE.ALLOCATE);
            return routine === 0 ? host.allocate(bytes) : host.call(routine, [bytes], call.thread);
        },
        free: (call, address)=>{
            const routine = u32(call.message + STUB_MESSAGE.FREE);
            return routine === 0 ? host.free(address) : host.call(routine, [address], call.thread);
        },
        marshalInterface: async(call, pointer, iid)=>{
            const marshaler = host.marshaler?.() ?? null;
            if (!marshaler)
            {
                report('an interface pointer cannot cross: ole32 does not marshal here');
                throw new RpcException(RPC_STATUS.S_CANNOT_SUPPORT);
            }
            const made = await marshaler.marshal(pointer, formatGuid(iid), call.thread);
            if (made.hr < 0 || !made.objref)
            {
                throw new RpcException(made.hr >>> 0);
            }
            return made.objref;
        },
        unmarshalInterface: async(call, objref, iid)=>{
            const marshaler = host.marshaler?.() ?? null;
            if (!marshaler)
            {
                report('an interface pointer cannot cross: ole32 does not unmarshal here');
                throw new RpcException(RPC_STATUS.S_CANNOT_SUPPORT);
            }
            const carried = iid ?? decodeObjref(objref)?.iid ?? null;
            if (!carried)
            {
                throw new RpcException(RPC_STATUS.X_BAD_STUB_DATA,
                    'an OBJREF that does not decode');
            }
            const made = await marshaler.unmarshal(objref, formatGuid(carried), call.thread);
            if (made.hr < 0)
            {
                throw new RpcException(made.hr >>> 0);
            }
            return made.pointer;
        },
        releaseInterface: (call, pointer)=>callSlot(pointer, SLOT.RELEASE, [], call.thread),
        interfaceBytes: OBJREF_BYTES,
        divergence: report,
    });

    /**
     * Stub messages whose buffer came from the channel and has not gone back.
     *
     * @type {Set<number>}
     */
    const buffered = new Set();

    /**
     * An engine entry point: (message, memory, format) in, a status raised on
     * the calling thread if it fails.
     *
     * @param {(call: import('./ndr.js').NdrCall, memory: number, format: number)
     *     => Promise<void>} pass
     * @param {number} [answer]  What the entry point returns.
     */
    const engineCall = (pass, answer = 0)=>({
        argBytes: 12,
        /** @param {number[]} args */
        handler: ([message, memory, format])=>{
            const thread = host.callerThread();
            return raising(thread, async()=>{
                await pass({ message: message >>> 0, thread }, memory >>> 0, format >>> 0);
                return answer;
            });
        },
    });

    /** (message, ppMemory, format, fMustAlloc): an unmarshal entry point. */
    const unmarshalCall = {
        argBytes: 16,
        /** @param {number[]} args */
        handler: ([message, ppMemory, format, mustAlloc])=>{
            const thread = host.callerThread();
            return raising(thread, async()=>{
                await ndr.unmarshall({ message: message >>> 0, thread }, ppMemory >>> 0,
                    format >>> 0, (mustAlloc & 0xff) !== 0);
                return 0;
            });
        },
    };

    /** The engine's four passes, as each family of entry points names them. */
    const family = {
        BufferSize: engineCall((call, memory, format)=>ndr.bufferSize(call, memory, format)),
        Marshall: engineCall((call, memory, format)=>ndr.marshall(call, memory, format)),
        Unmarshall: unmarshalCall,
        Free: engineCall((call, memory, format)=>ndr.free(call, memory, format)),
    };

    // --- the objects handed out ------------------------------------------------

    /**
     * A vtable of host routines, built once: every object of the kind
     * shares it, and each routine finds its object from `this`.
     *
     * @param {string} name
     * @param {{ name: string, argBytes: number, handler: (args: number[]) => any }[]} methods
     */
    const hostVtable = (name, methods)=>{
        let table = 0;
        return ()=>{
            if (table !== 0)
            {
                return table;
            }
            const made = host.allocate(methods.length * 4);
            if (made === 0)
            {
                return 0;
            }
            methods.forEach((method, index)=>w32(made + index * 4,
                host.register(`${name}::${method.name}`,
                    { argBytes: method.argBytes, handler: method.handler })));
            table = made;
            return table;
        };
    };

    /**
     * The interface a factory's DLL describes under an IID, or null.
     *
     * @param {number} factory @param {number} riid
     */
    const describedBy = (factory, riid)=>{
        const iid = guidAt(riid);
        return readProxyFiles(host, u32(factory + FACTORY.FILES))
            .find(entry=>entry.iid === iid) ?? null;
    };

    /** @param {number} factory */
    const holdFactory = factory=>w32(factory + FACTORY.REFS, u32(factory + FACTORY.REFS) + 1);
    /** @param {number} factory */
    const dropFactory = factory=>{
        const refs = u32(factory + FACTORY.REFS);
        w32(factory + FACTORY.REFS, refs > 0 ? refs - 1 : 0);
        return refs > 0 ? refs - 1 : 0;
    };

    /**
     * IUnknown's three for an object whose count is a word of its own, and
     * which answers to the IIDs given.
     *
     * @param {number} refs  Where the count is, from `this`.
     * @param {string[]} answers
     * @param {(self: number) => any} [destroy]  When the count reaches zero.
     */
    const unknownMethods = (refs, answers, destroy)=>[
        { name: 'QueryInterface', argBytes: 12,
            handler: (/** @type {number[]} */ [self, riid, out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                if (!answers.includes(guidAt(riid)))
                {
                    w32(out, 0);
                    return E_NOINTERFACE;
                }
                w32(self + refs, u32(self + refs) + 1);
                w32(out, self);
                return S_OK;
            } },
        { name: 'AddRef', argBytes: 4,
            handler: (/** @type {number[]} */ [self])=>{
                w32(self + refs, u32(self + refs) + 1);
                return u32(self + refs);
            } },
        { name: 'Release', argBytes: 4,
            handler: (/** @type {number[]} */ [self])=>{
                const left = Math.max(u32(self + refs) - 1, 0);
                w32(self + refs, left);
                return left === 0 && destroy ? destroy(self) : left;
            } },
    ];

    // IRpcProxyBuffer, at a CStdProxyBuffer's start; `this` is the buffer.
    // It shares its count with the interface when the proxy has no outer
    // object, and is then the interface's own unknown.
    const proxyBufferVtable = hostVtable('IRpcProxyBuffer', [
        {
            name: 'QueryInterface',
            argBytes: 12,
            handler: ([buffer, riid, out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                const pointer = buffer - PROXY.BUFFER;
                const iid = guidAt(riid);
                let found = 0;
                if ([IID_IUNKNOWN, IID_IRPCPROXYBUFFER].includes(iid))
                {
                    found = buffer;
                }
                else if (iid === guidAt(u32(u32(pointer + PROXY.VTABLE) - 4)))
                {
                    found = pointer;
                }
                w32(out, found);
                if (found === 0)
                {
                    return E_NOINTERFACE;
                }
                w32(pointer + PROXY.REFS, u32(pointer + PROXY.REFS) + 1);
                return S_OK;
            },
        },
        ...unknownMethods(PROXY.REFS - PROXY.BUFFER, [], buffer=>{
            const thread = host.callerThread();
            return disconnectProxy(buffer - PROXY.BUFFER, thread).then(()=>{
                dropFactory(u32(buffer - PROXY.BUFFER + PROXY.FACTORY));
                host.free(buffer);
                return 0;
            });
        }).slice(1),
        { name: 'Connect', argBytes: 8,
            handler: ([buffer, channel])=>{
                const thread = host.callerThread();
                const pointer = buffer - PROXY.BUFFER;
                return disconnectProxy(pointer, thread).then(async()=>{
                    w32(pointer + PROXY.CHANNEL, channel);
                    if ((channel >>> 0) !== 0)
                    {
                        await callSlot(channel, SLOT.ADD_REF, [], thread);
                    }
                    return S_OK;
                });
            } },
        { name: 'Disconnect', argBytes: 4,
            handler: ([buffer])=>disconnectProxy(buffer - PROXY.BUFFER, host.callerThread())
                .then(()=>0) },
    ]);

    /**
     * A proxy lets go of its channel.
     *
     * @param {number} pointer  The interface pointer. @param {unknown} thread
     */
    const disconnectProxy = async(pointer, thread)=>{
        const channel = u32(pointer + PROXY.CHANNEL);
        w32(pointer + PROXY.CHANNEL, 0);
        if (channel !== 0)
        {
            await callSlot(channel, SLOT.RELEASE, [], thread);
        }
    };

    // IPSFactoryBuffer, over the DLL's own CStdPSFactoryBuffer.
    const factoryVtable = hostVtable('IPSFactoryBuffer', [
        ...unknownMethods(FACTORY.REFS, [IID_IUNKNOWN, IID_IPSFACTORYBUFFER]),
        {
            name: 'CreateProxy',
            argBytes: 20,
            /**
             * HRESULT CreateProxy(IUnknown *pUnkOuter, REFIID riid,
             *                     IRpcProxyBuffer **ppProxy, void **ppv)
             */
            handler: ([factory, outer, riid, ppProxy, ppv])=>{
                const thread = host.callerThread();
                for (const out of [ppProxy, ppv])
                {
                    if ((out >>> 0) !== 0)
                    {
                        w32(out, 0);
                    }
                }
                if ((ppProxy >>> 0) === 0 || (ppv >>> 0) === 0)
                {
                    return E_POINTER;
                }
                const entry = describedBy(factory, riid);
                if (!entry)
                {
                    return E_NOINTERFACE;
                }
                for (let slot = 3; slot < entry.methods; slot++)
                {
                    if (u32(entry.proxyVtbl + slot * 4) === STUBLESS_ENTRY)
                    {
                        report(`the proxy for ${entry.name} ${entry.iid} is stubless (-Oicf),`
                            + ' and the NDR interpreter is not implemented');
                        return E_NOTIMPL;
                    }
                }
                const vtable = proxyBufferVtable();
                const buffer = vtable === 0 ? 0 : host.allocate(PROXY.SIZE);
                if (buffer === 0)
                {
                    return E_OUTOFMEMORY;
                }
                const pointer = buffer - PROXY.BUFFER;
                host.writeMemory(buffer, new Uint8Array(PROXY.SIZE));
                w32(buffer, vtable);
                w32(pointer + PROXY.VTABLE, entry.proxyVtbl);
                w32(pointer + PROXY.REFS, 1);
                // Without an outer unknown the proxy is its own: the buffer.
                w32(pointer + PROXY.OUTER, (outer >>> 0) || buffer);
                w32(pointer + PROXY.FACTORY, factory);
                holdFactory(factory);
                w32(ppProxy, buffer);
                w32(ppv, pointer);
                // The interface is handed out with a reference, which an
                // aggregated proxy counts on its outer object.
                if ((outer >>> 0) === 0)
                {
                    w32(pointer + PROXY.REFS, 2);
                    return S_OK;
                }
                return callSlot(outer, SLOT.ADD_REF, [], thread).then(()=>S_OK);
            },
        },
        {
            name: 'CreateStub',
            argBytes: 16,
            /** HRESULT CreateStub(REFIID riid, IUnknown *pUnkServer, IRpcStubBuffer **ppStub) */
            handler: ([factory, riid, server, ppStub])=>{
                const thread = host.callerThread();
                if ((ppStub >>> 0) === 0)
                {
                    return E_POINTER;
                }
                w32(ppStub, 0);
                const entry = describedBy(factory, riid);
                if (!entry)
                {
                    return E_NOINTERFACE;
                }
                const stub = host.allocate(STUB.SIZE);
                if (stub === 0)
                {
                    return E_OUTOFMEMORY;
                }
                host.writeMemory(stub, new Uint8Array(STUB.SIZE));
                w32(stub + STUB.VTABLE, entry.stubVtbl + STUB_VTBL.VTABLE);
                w32(stub + STUB.REFS, 1);
                w32(stub + STUB.FACTORY, factory);
                holdFactory(factory);
                if ((server >>> 0) === 0)
                {
                    w32(ppStub, stub);
                    return S_OK;
                }
                return query(server, entry.iidAt, thread).then(found=>{
                    if (found.hr < 0)
                    {
                        dropFactory(factory);
                        host.free(stub);
                        return found.hr;
                    }
                    w32(stub + STUB.SERVER, found.pointer);
                    w32(ppStub, stub);
                    return S_OK;
                });
            },
        },
    ]);

    /** @param {number} stub  The IID of the interface a stub is for, where the DLL keeps it. */
    const stubIid = stub=>u32(u32(stub + STUB.VTABLE) - STUB_VTBL.VTABLE + STUB_VTBL.IID);

    /**
     * The last reference to a stub has gone: its server object, its factory
     * and its memory with it.
     *
     * @param {number} stub @param {number} factory @param {unknown} thread
     */
    const releaseStub = async(stub, factory, thread)=>{
        const left = Math.max(u32(stub + STUB.REFS) - 1, 0);
        w32(stub + STUB.REFS, left);
        if (left > 0)
        {
            return left;
        }
        const server = u32(stub + STUB.SERVER);
        w32(stub + STUB.SERVER, 0);
        if (server !== 0)
        {
            await callSlot(server, SLOT.RELEASE, [], thread);
        }
        if (factory !== 0)
        {
            dropFactory(factory);
        }
        host.free(stub);
        return 0;
    };

    /**
     * The channel a proxy's call goes through, or a raise for a proxy nobody
     * connected.
     *
     * @param {number} proxy
     */
    const channelOf = proxy=>{
        const channel = u32(proxy + PROXY.CHANNEL);
        if (channel === 0)
        {
            throw new RpcException(CO_E_OBJNOTCONNECTED >>> 0);
        }
        return channel;
    };

    /**
     * The buffer a channel handed back, as the stub message reads it.
     *
     * @param {number} message
     */
    const takeBuffer = message=>{
        const rpc = u32(message + STUB_MESSAGE.RPC_MESSAGE);
        const buffer = u32(rpc + RPC_MESSAGE.BUFFER);
        const length = u32(rpc + RPC_MESSAGE.BUFFER_LENGTH);
        w32(message + STUB_MESSAGE.BUFFER, buffer);
        w32(message + STUB_MESSAGE.BUFFER_START, buffer);
        w32(message + STUB_MESSAGE.BUFFER_END, buffer + length);
        w32(message + STUB_MESSAGE.BUFFER_LENGTH, length);
    };

    /**
     * A stub message and its RPC message made ready for one call.
     *
     * @param {number} message @param {number} rpc @param {number} descriptor
     * @param {boolean} client
     */
    const initialize = (message, rpc, descriptor, client)=>{
        host.writeMemory(message, new Uint8Array(STUB_MESSAGE.SIZE));
        w32(message + STUB_MESSAGE.RPC_MESSAGE, rpc);
        w32(message + STUB_MESSAGE.IS_CLIENT, client ? 1 : 0);
        w32(message + STUB_MESSAGE.STUB_DESC, descriptor);
        w32(message + STUB_MESSAGE.ALLOCATE, u32(descriptor + STUB_DESC.ALLOCATE));
        w32(message + STUB_MESSAGE.FREE, u32(descriptor + STUB_DESC.FREE));
        ndr.begin(message);
        buffered.delete(message);
    };

    return {
        /**
         * void NdrProxyInitialize(void *This, PRPC_MESSAGE pRpcMsg,
         *     PMIDL_STUB_MESSAGE pStubMsg, PMIDL_STUB_DESC pStubDescriptor,
         *     unsigned int ProcNum)
         */
        NdrProxyInitialize: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([proxy, rpc, message, descriptor, procedure])=>{
                host.writeMemory(rpc >>> 0, new Uint8Array(RPC_MESSAGE.SIZE));
                w32(rpc + RPC_MESSAGE.DATA_REPRESENTATION, NDR_LOCAL_DATA_REPRESENTATION);
                w32(rpc + RPC_MESSAGE.PROC_NUM, procedure);
                w32(rpc + RPC_MESSAGE.INTERFACE_INFORMATION,
                    u32(descriptor + STUB_DESC.INTERFACE_INFORMATION));
                initialize(message >>> 0, rpc >>> 0, descriptor >>> 0, true);
                w32(message + STUB_MESSAGE.STUB_PHASE, PROXY_PHASE.CALCSIZE);
                const channel = u32(proxy + PROXY.CHANNEL);
                w32(message + STUB_MESSAGE.CHANNEL, channel);
                // Nothing is called before this raise: the registers are the
                // caller's still.
                return channel === 0 ? host.raise(CO_E_OBJNOTCONNECTED >>> 0) : 0;
            },
        },

        /** void NdrProxyGetBuffer(void *This, PMIDL_STUB_MESSAGE pStubMsg) */
        NdrProxyGetBuffer: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([proxy, message])=>{
                const thread = host.callerThread();
                return raising(thread, async()=>{
                    w32(message + STUB_MESSAGE.STUB_PHASE, PROXY_PHASE.GETBUFFER);
                    const rpc = u32(message + STUB_MESSAGE.RPC_MESSAGE);
                    w32(rpc + RPC_MESSAGE.BUFFER_LENGTH, u32(message + STUB_MESSAGE.BUFFER_LENGTH));
                    // The IID sits just before the vtable the proxy points at.
                    const iid = u32(u32(proxy) - 4);
                    const hr = (await callSlot(channelOf(proxy), SLOT.GET_BUFFER, [rpc, iid],
                        thread)) | 0;
                    if (hr < 0)
                    {
                        throw new RpcException(hr >>> 0);
                    }
                    buffered.add(message >>> 0);
                    takeBuffer(message);
                    w32(message + STUB_MESSAGE.STUB_PHASE, PROXY_PHASE.MARSHAL);
                    return 0;
                });
            },
        },

        /** void NdrProxySendReceive(void *This, PMIDL_STUB_MESSAGE pStubMsg) */
        NdrProxySendReceive: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([proxy, message])=>{
                const thread = host.callerThread();
                return raising(thread, async()=>{
                    w32(message + STUB_MESSAGE.STUB_PHASE, PROXY_PHASE.SENDRECEIVE);
                    const rpc = u32(message + STUB_MESSAGE.RPC_MESSAGE);
                    // What was written, and not the whole of what was sized.
                    w32(rpc + RPC_MESSAGE.BUFFER_LENGTH,
                        u32(message + STUB_MESSAGE.BUFFER) - u32(rpc + RPC_MESSAGE.BUFFER));
                    const status = host.allocate(4);
                    if (status === 0)
                    {
                        throw new RpcException(RPC_STATUS.S_OUT_OF_MEMORY);
                    }
                    w32(status, 0);
                    const hr = (await callSlot(channelOf(proxy), SLOT.SEND_RECEIVE,
                        [rpc, status], thread)) | 0;
                    host.free(status);
                    // Past the send either way: the exception filter a proxy
                    // wraps its call in takes what is raised from here.
                    w32(message + STUB_MESSAGE.STUB_PHASE, PROXY_PHASE.UNMARSHAL);
                    takeBuffer(message);
                    if (hr < 0)
                    {
                        throw new RpcException(hr >>> 0);
                    }
                    return 0;
                });
            },
        },

        /** void NdrProxyFreeBuffer(void *This, PMIDL_STUB_MESSAGE pStubMsg) */
        NdrProxyFreeBuffer: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([proxy, message])=>{
                // Called from every proxy's RpcFinally, whether or not a
                // buffer was ever taken.
                if (!buffered.delete(message >>> 0))
                {
                    return 0;
                }
                const channel = u32(proxy + PROXY.CHANNEL);
                const rpc = u32(message + STUB_MESSAGE.RPC_MESSAGE);
                if (channel === 0 || u32(rpc + RPC_MESSAGE.BUFFER) === 0)
                {
                    return 0;
                }
                return callSlot(channel, SLOT.FREE_BUFFER, [rpc], host.callerThread())
                    .then(()=>0);
            },
        },

        /**
         * HRESULT NdrProxyErrorHandler(DWORD dwExceptionCode)
         *
         * An exception code that is already an HRESULT is the answer; an RPC
         * status is one as a Win32 error.
         */
        NdrProxyErrorHandler: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([code])=>{
                const status = code >>> 0;
                if ((status & 0x80000000) !== 0 || status === 0)
                {
                    return status | 0;
                }
                return (0x80070000 | (status & 0xffff)) | 0;
            },
        },

        /**
         * void NdrClearOutParameters(PMIDL_STUB_MESSAGE pStubMsg,
         *     PFORMAT_STRING pFormat, void *ArgAddr)
         */
        NdrClearOutParameters: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([message, format, argument])=>{
                const thread = host.callerThread();
                return raising(thread, async()=>{
                    await ndr.clearOut({ message: message >>> 0, thread }, format >>> 0,
                        argument >>> 0);
                    return 0;
                });
            },
        },

        /**
         * void NdrConvert(PMIDL_STUB_MESSAGE pStubMsg, PFORMAT_STRING pFormat)
         * void NdrConvert2(PMIDL_STUB_MESSAGE, PFORMAT_STRING, long NumberParams)
         *
         * Every buffer here is in the local representation, which needs no
         * conversion; one that is not cannot be read.
         */
        NdrConvert: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([message])=>convert(message),
        },
        NdrConvert2: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([message])=>convert(message),
        },

        /**
         * unsigned char *NdrStubInitialize(PRPC_MESSAGE pRpcMsg,
         *     PMIDL_STUB_MESSAGE pStubMsg, PMIDL_STUB_DESC pStubDescriptor,
         *     IRpcChannelBuffer *pRpcChannelBuffer)
         */
        NdrStubInitialize: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([rpc, message, descriptor, channel])=>{
                initialize(message >>> 0, rpc >>> 0, descriptor >>> 0, false);
                w32(message + STUB_MESSAGE.REUSE_BUFFER, 1);
                w32(message + STUB_MESSAGE.CHANNEL, channel);
                w32(message + STUB_MESSAGE.STUB_PHASE, STUB_UNMARSHAL);
                takeBuffer(message);
                return 0;
            },
        },

        /**
         * void NdrStubGetBuffer(IRpcStubBuffer *This,
         *     IRpcChannelBuffer *pRpcChannelBuffer, PMIDL_STUB_MESSAGE pStubMsg)
         */
        NdrStubGetBuffer: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([stub, channel, message])=>{
                const thread = host.callerThread();
                return raising(thread, async()=>{
                    const rpc = u32(message + STUB_MESSAGE.RPC_MESSAGE);
                    w32(rpc + RPC_MESSAGE.BUFFER_LENGTH, u32(message + STUB_MESSAGE.BUFFER_LENGTH));
                    const hr = (await callSlot(channel, SLOT.GET_BUFFER, [rpc, stubIid(stub)],
                        thread)) | 0;
                    if (hr < 0)
                    {
                        throw new RpcException(hr >>> 0);
                    }
                    takeBuffer(message);
                    return 0;
                });
            },
        },

        /** void RpcRaiseException(RPC_STATUS exception) */
        RpcRaiseException: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([code])=>host.raise(code >>> 0),
        },

        /** void *NdrOleAllocate(size_t Size) and void NdrOleFree(void *NodeToFree): task memory. */
        NdrOleAllocate: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([size])=>host.allocate(size >>> 0),
        },
        NdrOleFree: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([node])=>{
                if ((node >>> 0) !== 0)
                {
                    host.free(node >>> 0);
                }
                return 0;
            },
        },

        NdrPointerBufferSize: family.BufferSize,
        NdrPointerMarshall: family.Marshall,
        NdrPointerUnmarshall: family.Unmarshall,
        NdrPointerFree: family.Free,
        NdrSimpleStructBufferSize: family.BufferSize,
        NdrSimpleStructMarshall: family.Marshall,
        NdrSimpleStructUnmarshall: family.Unmarshall,
        NdrSimpleStructFree: family.Free,
        NdrConformantStringBufferSize: family.BufferSize,
        NdrConformantStringMarshall: family.Marshall,
        NdrConformantStringUnmarshall: family.Unmarshall,
        NdrConformantArrayBufferSize: family.BufferSize,
        NdrConformantArrayMarshall: family.Marshall,
        NdrConformantArrayUnmarshall: family.Unmarshall,
        NdrConformantArrayFree: family.Free,
        NdrConformantVaryingArrayBufferSize: family.BufferSize,
        NdrConformantVaryingArrayMarshall: family.Marshall,
        NdrConformantVaryingArrayUnmarshall: family.Unmarshall,
        NdrConformantVaryingArrayFree: family.Free,
        NdrFixedArrayBufferSize: family.BufferSize,
        NdrFixedArrayMarshall: family.Marshall,
        NdrFixedArrayUnmarshall: family.Unmarshall,
        NdrFixedArrayFree: family.Free,
        NdrInterfacePointerBufferSize: family.BufferSize,
        NdrInterfacePointerMarshall: family.Marshall,
        NdrInterfacePointerUnmarshall: family.Unmarshall,
        NdrInterfacePointerFree: family.Free,
        // A [user_marshal] type is not walked yet: its format character is
        // refused out loud, as any the walker does not know.
        NdrUserMarshalBufferSize: family.BufferSize,
        NdrUserMarshalMarshall: family.Marshall,
        NdrUserMarshalUnmarshall: family.Unmarshall,
        NdrUserMarshalFree: family.Free,

        /**
         * void NdrSimpleTypeMarshall(PMIDL_STUB_MESSAGE pStubMsg,
         *     unsigned char *pMemory, unsigned char FormatChar)
         * void NdrSimpleTypeUnmarshall(PMIDL_STUB_MESSAGE, unsigned char *, unsigned char)
         */
        NdrSimpleTypeMarshall: simpleType('marshall'),
        NdrSimpleTypeUnmarshall: simpleType('unmarshall'),

        /**
         * The interpreter's entry points, which `-Oi`/`-Oif` code calls in
         * place of generated marshaling. Not implemented: said, and failed.
         *
         * CLIENT_CALL_RETURN NdrClientCall2(PMIDL_STUB_DESC, PFORMAT_STRING, ...)
         * long NdrStubCall2(void *pThis, void *pChannel, PRPC_MESSAGE, DWORD *pdwStubPhase)
         */
        NdrClientCall2: {
            convention: 'cdecl',
            argBytes: 8,
            handler: ()=>{
                report('NdrClientCall2: the -Oi/-Oif NDR interpreter is not implemented');
                return (0x80070000 | RPC_STATUS.S_CANNOT_SUPPORT) | 0;
            },
        },
        NdrStubCall2: {
            argBytes: 16,
            handler: ()=>{
                report('NdrStubCall2: the -Oi/-Oif NDR interpreter is not implemented');
                return host.raise(RPC_STATUS.S_CANNOT_SUPPORT);
            },
        },
        /**
         * void NdrStubForwardingFunction(IRpcStubBuffer *This,
         *   IRpcChannelBuffer *pChannel, PRPC_MESSAGE pmsg, DWORD *pdwStubPhase)
         *
         * A delegating stub's entry for a method of its base interface, which
         * passes the call on to the base interface's stub. CreateStub here
         * builds no base stub, so there is nowhere to pass it: said, and raised.
         */
        NdrStubForwardingFunction: {
            argBytes: 16,
            handler: ()=>{
                report('NdrStubForwardingFunction: a delegating stub has no base stub to pass'
                    + ' the call to');
                return host.raise(RPC_STATUS.S_CANNOT_SUPPORT);
            },
        },

        /** HRESULT IUnknown_QueryInterface_Proxy(IUnknown *This, REFIID riid, void **ppv) */
        IUnknown_QueryInterface_Proxy: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([proxy, riid, out])=>callSlot(u32(proxy + PROXY.OUTER),
                SLOT.QUERY_INTERFACE, [riid, out], host.callerThread()),
        },
        /** ULONG IUnknown_AddRef_Proxy(IUnknown *This) */
        IUnknown_AddRef_Proxy: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([proxy])=>callSlot(u32(proxy + PROXY.OUTER), SLOT.ADD_REF, [],
                host.callerThread()),
        },
        /** ULONG IUnknown_Release_Proxy(IUnknown *This) */
        IUnknown_Release_Proxy: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([proxy])=>callSlot(u32(proxy + PROXY.OUTER), SLOT.RELEASE, [],
                host.callerThread()),
        },

        /** HRESULT CStdStubBuffer_QueryInterface(IRpcStubBuffer *This, REFIID riid, void **ppv) */
        CStdStubBuffer_QueryInterface: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([stub, riid, out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                if (![IID_IUNKNOWN, IID_IRPCSTUBBUFFER].includes(guidAt(riid)))
                {
                    w32(out, 0);
                    return E_NOINTERFACE;
                }
                w32(stub + STUB.REFS, u32(stub + STUB.REFS) + 1);
                w32(out, stub);
                return S_OK;
            },
        },
        /** ULONG CStdStubBuffer_AddRef(IRpcStubBuffer *This) */
        CStdStubBuffer_AddRef: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([stub])=>{
                w32(stub + STUB.REFS, u32(stub + STUB.REFS) + 1);
                return u32(stub + STUB.REFS);
            },
        },
        /**
         * ULONG NdrCStdStubBuffer_Release(IRpcStubBuffer *This, IPSFactoryBuffer *pPSF)
         * ULONG CStdStubBuffer_Release(IRpcStubBuffer *This)
         *
         * The DLL's own CStdStubBuffer_Release calls the first with its
         * factory; the second finds the factory in the stub.
         */
        NdrCStdStubBuffer_Release: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([stub, factory])=>releaseStub(stub >>> 0, factory >>> 0,
                host.callerThread()),
        },
        CStdStubBuffer_Release: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([stub])=>releaseStub(stub >>> 0, u32(stub + STUB.FACTORY),
                host.callerThread()),
        },
        /**
         * ULONG NdrCStdStubBuffer2_Release(IRpcStubBuffer *This, IPSFactoryBuffer *pPSF)
         *
         * What the DLL's CStdStubBuffer2_Release calls for an interface whose
         * stub delegates to its base interface's. CreateStub here builds no
         * base stub to delegate to, so the stub is released as any other.
         */
        NdrCStdStubBuffer2_Release: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([stub, factory])=>releaseStub(stub >>> 0, factory >>> 0,
                host.callerThread()),
        },
        /** HRESULT CStdStubBuffer_Connect(IRpcStubBuffer *This, IUnknown *pUnkServer) */
        CStdStubBuffer_Connect: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([stub, server])=>{
                const thread = host.callerThread();
                if ((server >>> 0) === 0)
                {
                    return E_UNEXPECTED;
                }
                return query(server, stubIid(stub), thread).then(async found=>{
                    if (found.hr < 0)
                    {
                        return found.hr;
                    }
                    const previous = u32(stub + STUB.SERVER);
                    w32(stub + STUB.SERVER, found.pointer);
                    if (previous !== 0)
                    {
                        await callSlot(previous, SLOT.RELEASE, [], thread);
                    }
                    return S_OK;
                });
            },
        },
        /** void CStdStubBuffer_Disconnect(IRpcStubBuffer *This) */
        CStdStubBuffer_Disconnect: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([stub])=>{
                const server = u32(stub + STUB.SERVER);
                w32(stub + STUB.SERVER, 0);
                return server === 0 ? 0 : callSlot(server, SLOT.RELEASE, [],
                    host.callerThread()).then(()=>0);
            },
        },
        /**
         * HRESULT CStdStubBuffer_Invoke(IRpcStubBuffer *This,
         *     RPCOLEMESSAGE *prpcmsg, IRpcChannelBuffer *pRpcChannelBuffer)
         *
         * The method's stub routine from the DLL's dispatch table, which is
         * indexed by method number: MIDL points it three entries before its
         * first, IUnknown's methods having none.
         */
        CStdStubBuffer_Invoke: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([stub, rpc, channel])=>{
                const thread = host.callerThread();
                const header = u32(stub + STUB.VTABLE) - STUB_VTBL.VTABLE;
                const method = u32(rpc + RPC_MESSAGE.PROC_NUM);
                const count = u32(header + STUB_VTBL.DISPATCH_TABLE_COUNT);
                if (method < 3 || method >= count)
                {
                    return (0x80070000 | RPC_S_PROCNUM_OUT_OF_RANGE) | 0;
                }
                if (u32(stub + STUB.SERVER) === 0)
                {
                    return CO_E_OBJNOTCONNECTED;
                }
                const routine = u32(u32(header + STUB_VTBL.DISPATCH_TABLE) + method * 4);
                const phase = host.allocate(4);
                if (phase === 0)
                {
                    return E_OUTOFMEMORY;
                }
                w32(phase, STUB_UNMARSHAL);
                return host.call(routine, [stub, channel, rpc, phase], thread).then(()=>{
                    host.free(phase);
                    return S_OK;
                });
            },
        },
        /** IRpcStubBuffer *CStdStubBuffer_IsIIDSupported(IRpcStubBuffer *This, REFIID riid) */
        CStdStubBuffer_IsIIDSupported: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([stub, riid])=>{
                if (guidAt(riid) !== guidAt(stubIid(stub)))
                {
                    return 0;
                }
                w32(stub + STUB.REFS, u32(stub + STUB.REFS) + 1);
                return stub;
            },
        },
        /** ULONG CStdStubBuffer_CountRefs(IRpcStubBuffer *This): the server object it holds. */
        CStdStubBuffer_CountRefs: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([stub])=>u32(stub + STUB.SERVER) === 0 ? 0 : 1,
        },
        /** HRESULT CStdStubBuffer_DebugServerQueryInterface(IRpcStubBuffer *This, void **ppv) */
        CStdStubBuffer_DebugServerQueryInterface: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([stub, out])=>{
                const server = u32(stub + STUB.SERVER);
                if ((out >>> 0) !== 0)
                {
                    w32(out, server);
                }
                return server === 0 ? E_UNEXPECTED : S_OK;
            },
        },
        /** void CStdStubBuffer_DebugServerRelease(IRpcStubBuffer *This, void *pv) */
        CStdStubBuffer_DebugServerRelease: {
            argBytes: 8,
            handler: ()=>0,
        },

        /**
         * HRESULT NdrDllGetClassObject(REFCLSID rclsid, REFIID riid, void **ppv,
         *     const ProxyFileInfo **pProxyFileList, const CLSID *pclsid,
         *     CStdPSFactoryBuffer *pPSFactoryBuffer)
         *
         * The factory is the DLL's own CStdPSFactoryBuffer, filled in the
         * first time.
         */
        NdrDllGetClassObject: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([rclsid, riid, out, list, pclsid, factory])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                w32(out, 0);
                const interfaces = readProxyFiles(host, list >>> 0);
                const clsid = factoryClass(host, interfaces, pclsid >>> 0);
                if (clsid === null || guidAt(rclsid) !== clsid)
                {
                    return CLASS_E_CLASSNOTAVAILABLE;
                }
                if (![IID_IUNKNOWN, IID_IPSFACTORYBUFFER].includes(guidAt(riid)))
                {
                    return E_NOINTERFACE;
                }
                if (u32(factory + FACTORY.VTABLE) === 0)
                {
                    const vtable = factoryVtable();
                    if (vtable === 0)
                    {
                        return E_OUTOFMEMORY;
                    }
                    w32(factory + FACTORY.VTABLE, vtable);
                    w32(factory + FACTORY.REFS, 0);
                    w32(factory + FACTORY.FILES, list);
                }
                holdFactory(factory);
                w32(out, factory);
                return S_OK;
            },
        },
        /** HRESULT NdrDllCanUnloadNow(CStdPSFactoryBuffer *pPSFactoryBuffer) */
        NdrDllCanUnloadNow: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([factory])=>u32(factory + FACTORY.REFS) === 0 ? S_OK : S_FALSE,
        },

        /**
         * HRESULT NdrDllRegisterProxy(HMODULE hDll, const ProxyFileInfo **pProxyFileList,
         *                             const CLSID *pclsid)
         * HRESULT NdrDllUnregisterProxy(HMODULE, const ProxyFileInfo **, const CLSID *)
         */
        NdrDllRegisterProxy: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([module, list, pclsid])=>{
                const interfaces = readProxyFiles(host, list >>> 0);
                const clsid = factoryClass(host, interfaces, pclsid >>> 0);
                const path = host.modulePath?.(module >>> 0) ?? null;
                if (!host.hive || clsid === null || path === null)
                {
                    report('NdrDllRegisterProxy: nothing to register, or nowhere to register it');
                    return E_FAIL;
                }
                registerProxyFiles(host.hive, interfaces, clsid, path);
                return S_OK;
            },
        },
        NdrDllUnregisterProxy: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([, list, pclsid])=>{
                const interfaces = readProxyFiles(host, list >>> 0);
                const clsid = factoryClass(host, interfaces, pclsid >>> 0);
                if (!host.hive || clsid === null)
                {
                    return E_FAIL;
                }
                unregisterProxyFiles(host.hive, interfaces, clsid);
                return S_OK;
            },
        },
    };

    /**
     * @param {'marshall' | 'unmarshall'} direction
     */
    function simpleType(direction){
        return {
            argBytes: 12,
            /** @param {number[]} args */
            handler: (/** @type {number[]} */ [message, memory, fc])=>{
                try
                {
                    ndr.simple({ message: message >>> 0 }, memory >>> 0, fc & 0xff, direction);
                    return 0;
                }
                catch (e){
                    if (e instanceof RpcException)
                    {
                        return host.raise(e.code);
                    }
                    throw e;
                }
            },
        };
    }

    /** @param {number} message */
    function convert(message){
        const rpc = u32(message + STUB_MESSAGE.RPC_MESSAGE);
        const representation = u32(rpc + RPC_MESSAGE.DATA_REPRESENTATION) & 0xffff;
        if (representation === NDR_LOCAL_DATA_REPRESENTATION)
        {
            return 0;
        }
        report(`NdrConvert: data representation 0x${representation.toString(16)} is not`
            + ' converted');
        return host.raise(RPC_STATUS.S_CANNOT_SUPPORT);
    }
}
