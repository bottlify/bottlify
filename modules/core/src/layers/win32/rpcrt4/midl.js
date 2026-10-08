/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * rpcrt4 between processes: what a program built on MIDL's generated RPC stubs
 * -- not a COM proxy or stub -- calls to serve an interface or to call one.
 *
 * A server names a protocol sequence and an endpoint (`RpcServerUseProtseqEp`),
 * registers the interface it serves (`RpcServerRegisterIf`) and listens
 * (`RpcServerListen`), and the thread that listens is the one that runs the
 * stubs: each call another process makes arrives at the run's table
 * (`ole32/remote.js`, where Windows keeps the endpoint mapper beside its
 * service control manager), is handed to that process's endpoint as a message
 * of numbers, strings and bytes, and is run there as `DispatchTable[ProcNum]
 * (RPC_MESSAGE *)` on the listening thread, one after another. The stub
 * unmarshals the request out of the message's buffer, calls the server's
 * routine and marshals the reply into a buffer of its own -- the one place it
 * asks the runtime for memory, `I_RpcGetBuffer` -- and what is left in the
 * message when it returns is the reply.
 *
 * A client composes a string binding, makes a binding of it, and its stub
 * allocates a buffer (`NdrGetBuffer`), marshals the request into it, sends it
 * and finds the reply in its place (`NdrSendReceive`) and frees it
 * (`NdrFreeBuffer`). A call that fails raises its status on the calling
 * thread, as `RpcRaiseException` does, for the stub's `RpcTryExcept` to take.
 *
 * What is here is the transport. A stub that marshals through the NDR engine's
 * format strings (`NdrClientCall2`, `NdrServerCall2`) is not served; neither
 * is a server that listens without waiting, which has no thread of its own to
 * run the stubs on, and a binding to another machine.
 */

import { GUID_SIZE, formatGuid, parseGuid } from '../ole32/guid.js';
import { NDR_LOCAL_DATA_REPRESENTATION, RPC_MESSAGE, STUB_DESC, STUB_MESSAGE } from './ndr.js';

const RPC_S_OK = 0;
const RPC_S_OUT_OF_MEMORY = 14;
const RPC_S_INVALID_STRING_BINDING = 1700;
const RPC_S_INVALID_BINDING = 1702;
const RPC_S_PROTSEQ_NOT_SUPPORTED = 1703;
const RPC_S_INVALID_RPC_PROTSEQ = 1704;
const RPC_S_INVALID_STRING_UUID = 1705;
const RPC_S_INVALID_ENDPOINT_FORMAT = 1706;
const RPC_S_NO_ENDPOINT_FOUND = 1708;
const RPC_S_TYPE_ALREADY_REGISTERED = 1712;
const RPC_S_ALREADY_LISTENING = 1713;
const RPC_S_NO_PROTSEQS_REGISTERED = 1714;
const RPC_S_NOT_LISTENING = 1715;
const RPC_S_UNKNOWN_IF = 1717;
const RPC_S_SERVER_UNAVAILABLE = 1722;
const RPC_S_CALL_FAILED = 1726;
const RPC_S_DUPLICATE_ENDPOINT = 1740;
const RPC_S_PROCNUM_OUT_OF_RANGE = 1745;
const ERROR_ACCESS_DENIED = 5;

/** What a server's routine answers when it raised an exception the stub did not take. */
const SERVER_FAULT = 0x80010105 | 0;

/** RPC_SERVER_INTERFACE and RPC_CLIENT_INTERFACE: the fields both have, from the front. */
const INTERFACE = Object.freeze({
    ID: 4, TRANSFER_SYNTAX: 24, DISPATCH_TABLE: 44, DEFAULT_MANAGER_EPV: 56,
});

/** The field of an RPC_MESSAGE `ndr.js` leaves unnamed: the manager a call is for. */
const MESSAGE_MANAGER_EPV = 32;

/** The protocol sequences that stay on this machine, which is all this one is. */
const PROTSEQS = new Set(['ncalrpc', 'ncacn_np', 'ncacn_ip_tcp', 'ncadg_ip_udp']);

/** What a network address that names this machine can be. */
const LOCAL_ADDRESSES = new Set(['', '.', 'localhost', '127.0.0.1', '::1']);

/** The characters a string binding sets apart, which a component holds only behind a backslash. */
const SPECIAL = /[\\[\],:@]/g;

/** @param {string} text */
const escapeBinding = text=>text.replace(SPECIAL, match=>`\\${match}`);

/**
 * A string binding taken apart: `[objuuid@]protseq[:networkaddr][[endpoint[,options]]]`,
 * its components unescaped; null when it is not one.
 *
 * @param {string} text
 * @returns {{ object: string | null, protseq: string, address: string, endpoint: string,
 *     options: string } | null}
 */
export function parseStringBinding(text){
    let at = 0;
    /**
     * Up to the next of `stops` that is not escaped, unescaped; null for a
     * backslash with nothing behind it.
     *
     * @param {string} stops @returns {{ value: string, stop: string } | null}
     */
    const read = stops=>{
        let value = '';
        while (at < text.length)
        {
            const character = text[at];
            if (character === '\\')
            {
                if (at + 1 >= text.length)
                {
                    return null;
                }
                value += text[at + 1];
                at += 2;
            }
            else if (stops.includes(character))
            {
                return { value, stop: character };
            }
            else
            {
                value += character;
                at++;
            }
        }
        return { value, stop: '' };
    };
    let part = read('@:[');
    if (part === null)
    {
        return null;
    }
    let object = null;
    if (part.stop === '@')
    {
        object = part.value;
        at++;
        part = read(':[');
        if (part === null)
        {
            return null;
        }
    }
    const protseq = part.value;
    if (protseq === '')
    {
        return null;
    }
    let address = '';
    let endpoint = '';
    let options = '';
    if (part.stop === ':')
    {
        at++;
        part = read('[');
        if (part === null)
        {
            return null;
        }
        address = part.value;
    }
    if (part.stop === '[')
    {
        at++;
        part = read(',]');
        if (part === null)
        {
            return null;
        }
        endpoint = part.value;
        if (part.stop === ',')
        {
            at++;
            part = read(']');
            if (part === null)
            {
                return null;
            }
            options = part.value;
        }
        if (part.stop !== ']' || ++at !== text.length)
        {
            return null;
        }
    }
    return { object, protseq, address, endpoint, options };
}

/**
 * A string binding put together, the components escaped.
 *
 * @param {{ object?: string | null, protseq: string, address?: string,
 *     endpoint?: string, options?: string }} parts
 */
export function composeStringBinding({ object, protseq, address, endpoint, options }){
    let text = object ? `${escapeBinding(object)}@` : '';
    text += escapeBinding(protseq);
    if (address)
    {
        text += `:${escapeBinding(address)}`;
    }
    else if (endpoint || options)
    {
        text += ':';
    }
    if (endpoint || options)
    {
        text += `[${escapeBinding(endpoint ?? '')}`;
        if (options)
        {
            text += `,${escapeBinding(options)}`;
        }
        text += ']';
    }
    return text;
}

/**
 * What a protocol sequence and an endpoint are called in the run's table: a
 * name that does not depend on how its letters are cased, as the endpoint of
 * a named pipe or a local procedure call is not.
 *
 * @param {string} protseq @param {string} endpoint
 */
const keyOf = (protseq, endpoint)=>`${protseq.toLowerCase()}:${endpoint.toLowerCase()}`;

/**
 * @typedef {Object} MidlHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(address: number) => string} readWideString
 * @property {(bytes: number) => number} allocate  Memory the guest frees through RpcStringFree
 *           or the stub through NdrFreeBuffer; 0 when nothing fits.
 * @property {(address: number) => void} free
 * @property {(entry: number, args: number[], thread: unknown) => Promise<number>} call
 *           A stdcall into guest code on `thread`.
 * @property {(entry: number, args: number[], thread: unknown) => Promise<number>} [guardedCall]
 *           The same, answering `RPC_E_SERVERFAULT` when the routine raises.
 * @property {() => unknown} callerThread
 * @property {(code: number) => any} raise
 *           RaiseException from a handler that has not waited on anything.
 * @property {(code: number, thread: unknown) => Promise<any>} raiseLater
 *           The same from one that has.
 * @property {ReturnType<typeof import('../ole32/remote.js').createClassTable>} table
 * @property {unknown} process
 * @property {(detail: string) => void} [divergence]
 */

/**
 * A call as a server's listener runs it.
 *
 * @typedef {Object} Job
 * @property {string} uuid
 * @property {number} major
 * @property {number} minor
 * @property {number} procedure
 * @property {Uint8Array} request
 * @property {(answer: { status: number, reply?: Uint8Array }) => void} finish
 */

/**
 * The RPC functions one process has.
 *
 * @param {MidlHost} host
 */
export function createMidl(host){
    const report = (/** @type {string} */ detail)=>host.divergence?.(detail);

    /** @param {number} at */
    const u32 = at=>{
        const bytes = host.readMemory(at >>> 0, 4);
        return (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
    };
    /** @param {number} at */
    const u16 = at=>{
        const bytes = host.readMemory(at >>> 0, 2);
        return bytes[0] | (bytes[1] << 8);
    };
    /** @param {number} at @param {number} value */
    const w32 = (at, value)=>host.writeMemory(at >>> 0, Uint8Array.of(
        value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff));
    /** @param {number} at */
    const guidAt = at=>formatGuid(host.readMemory(at >>> 0, GUID_SIZE));

    /** Buffers the runtime made, which are its to free. @type {Set<number>} */
    const owned = new Set();

    /** @param {number} bytes @returns {number} */
    const allocateBuffer = bytes=>{
        const address = host.allocate(Math.max(1, bytes));
        if (address !== 0)
        {
            owned.add(address);
        }
        return address;
    };
    /** @param {number} address */
    const freeBuffer = address=>{
        if (address !== 0 && owned.delete(address))
        {
            host.free(address);
        }
    };

    // --- servers ---------------------------------------------------------------

    /**
     * An interface a process serves.
     *
     * @typedef {Object} Served
     * @property {string} uuid
     * @property {number} major
     * @property {number} minor
     * @property {number} spec          The RPC_SERVER_INTERFACE the program gave.
     * @property {string} managerType   The manager type UUID, or '' for the default.
     * @property {number} managerEpv
     */

    /** @type {Served[]} */
    let served = [];
    /** The endpoints this process listens on, as the table names them. @type {Set<string>} */
    const bound = new Set();
    /** This process's endpoint in the run's table, made when it first listens. @type {number | null} */
    let endpointId = null;
    let listening = false;
    let stopping = false;
    /** @type {Job[]} */
    let queue = [];
    /** @type {(() => void) | null} */
    let wake = null;
    /** What the thread that listens is running, so that a process that ends can answer it. @type {Job | null} */
    let running = null;
    /** Whoever waits for the server to stop (RpcMgmtWaitServerListen). @type {(() => void)[]} */
    let released = [];

    /** @param {Job} job @param {{ status: number, reply?: Uint8Array }} outcome */
    const answer = (job, outcome)=>job.finish(outcome);

    /** Every call waiting, and the one running, is answered: the server is gone. */
    const refuseAll = ()=>{
        const waiting = queue;
        queue = [];
        for (const job of waiting)
        {
            answer(job, { status: RPC_S_SERVER_UNAVAILABLE });
        }
        if (running)
        {
            answer(running, { status: RPC_S_CALL_FAILED });
        }
    };

    /** @returns {number} this process's endpoint, attached on first use */
    const endpoint = ()=>{
        if (endpointId === null)
        {
            endpointId = host.table.attach({
                process: host.process,
                alive: true,
                deliver: message=>serve(message),
                rundown: async()=>{
                    listening = false;
                    stopping = true;
                    refuseAll();
                    wake?.();
                },
            });
        }
        return endpointId;
    };

    /**
     * A call another process made, delivered to this one: queued for the
     * thread that listens.
     *
     * @param {any} message
     * @returns {Promise<{ status: number, reply?: Uint8Array }>}
     */
    const serve = message=>new Promise(resolve=>{
        if (message.kind !== 'rpc')
        {
            resolve({ status: RPC_S_CALL_FAILED });
            return;
        }
        if (!listening || stopping)
        {
            resolve({ status: RPC_S_SERVER_UNAVAILABLE });
            return;
        }
        if (!served.some(one=>one.uuid === message.uuid && one.major === message.major
            && one.minor >= message.minor))
        {
            resolve({ status: RPC_S_UNKNOWN_IF });
            return;
        }
        queue.push({ uuid: message.uuid, major: message.major, minor: message.minor,
            procedure: message.proc, request: message.request, finish: resolve });
        wake?.();
    });

    /**
     * Runs one call: the stub's routine on the listening thread, with the
     * request in a buffer of its own and what it leaves in the message for the
     * reply.
     *
     * @param {Job} job @param {unknown} thread
     */
    const run = async(job, thread)=>{
        const entry = served.find(one=>one.uuid === job.uuid && one.major === job.major
            && one.minor >= job.minor);
        if (!entry)
        {
            answer(job, { status: RPC_S_UNKNOWN_IF });
            return;
        }
        const table = u32(entry.spec + INTERFACE.DISPATCH_TABLE);
        const count = table === 0 ? 0 : u32(table);
        if (job.procedure >= count)
        {
            answer(job, { status: RPC_S_PROCNUM_OUT_OF_RANGE });
            return;
        }
        const routine = u32(u32(table + 4) + job.procedure * 4);
        const message = host.allocate(RPC_MESSAGE.SIZE);
        const buffer = allocateBuffer(job.request.length);
        if (message === 0 || buffer === 0)
        {
            host.free(message);
            freeBuffer(buffer);
            answer(job, { status: RPC_S_OUT_OF_MEMORY });
            return;
        }
        host.writeMemory(message, new Uint8Array(RPC_MESSAGE.SIZE));
        host.writeMemory(buffer, job.request);
        w32(message + RPC_MESSAGE.DATA_REPRESENTATION, NDR_LOCAL_DATA_REPRESENTATION);
        w32(message + RPC_MESSAGE.BUFFER, buffer);
        w32(message + RPC_MESSAGE.BUFFER_LENGTH, job.request.length);
        w32(message + RPC_MESSAGE.PROC_NUM, job.procedure);
        w32(message + RPC_MESSAGE.TRANSFER_SYNTAX, entry.spec + INTERFACE.TRANSFER_SYNTAX);
        w32(message + RPC_MESSAGE.INTERFACE_INFORMATION, entry.spec);
        w32(message + MESSAGE_MANAGER_EPV, entry.managerEpv);
        running = job;
        /** What the stub's routine answered, or that it raised: `null` for the second. */
        const ended = await (host.guardedCall ?? host.call)(routine, [message], thread)
            .catch(e=>{
                report(`a stub raised in a call: ${e instanceof Error ? e.message : e}`);
                return null;
            });
        running = null;
        // A void routine leaves whatever it likes in the register, so only a
        // caller that guards the call has an answer that means a raise.
        const faulted = ended === null
            || (host.guardedCall !== undefined && (ended | 0) === SERVER_FAULT);
        const reply = u32(message + RPC_MESSAGE.BUFFER);
        const length = u32(message + RPC_MESSAGE.BUFFER_LENGTH);
        const result = faulted
            ? { status: RPC_S_CALL_FAILED }
            : { status: RPC_S_OK, reply: host.readMemory(reply, length).slice() };
        freeBuffer(buffer);
        if (reply !== buffer)
        {
            freeBuffer(reply);
        }
        host.free(message);
        answer(job, result);
    };

    /**
     * The calling thread serves until the server is stopped: each call that
     * arrives is run on it, in turn.
     *
     * @param {unknown} thread
     */
    const listen = async thread=>{
        for (;;)
        {
            const job = queue.shift();
            if (job)
            {
                await run(job, thread);
            }
            else if (stopping)
            {
                break;
            }
            else
            {
                await new Promise(resolve=>{
                    wake = ()=>{
                        wake = null;
                        resolve(undefined);
                    };
                });
            }
        }
        refuseAll();
    };

    /** @param {number} text @param {boolean} wide */
    const textAt = (text, wide)=>(text >>> 0) === 0 ? null
        : wide ? host.readWideString(text >>> 0) : host.readCString(text >>> 0, 1024);

    /**
     * @param {number} protseq @param {number} calls @param {number} endpointText
     * @param {boolean} wide
     */
    const useProtseqEndpoint = (protseq, calls, endpointText, wide)=>{
        void calls;
        const sequence = textAt(protseq, wide);
        const name = textAt(endpointText, wide);
        if (sequence === null || !/^[A-Za-z0-9_]+$/.test(sequence))
        {
            return RPC_S_INVALID_RPC_PROTSEQ;
        }
        if (!PROTSEQS.has(sequence.toLowerCase()))
        {
            return RPC_S_PROTSEQ_NOT_SUPPORTED;
        }
        if (name === null || name === '')
        {
            return RPC_S_INVALID_ENDPOINT_FORMAT;
        }
        const key = keyOf(sequence, name);
        if (!host.table.rpcListen(key, endpoint()))
        {
            return RPC_S_DUPLICATE_ENDPOINT;
        }
        bound.add(key);
        return RPC_S_OK;
    };

    /**
     * @param {number} spec @param {number} managerType @param {number} epv
     */
    const registerInterface = (spec, managerType, epv)=>{
        if (spec === 0)
        {
            return RPC_S_UNKNOWN_IF;
        }
        const uuid = guidAt(spec + INTERFACE.ID);
        const major = u16(spec + INTERFACE.ID + GUID_SIZE);
        const minor = u16(spec + INTERFACE.ID + GUID_SIZE + 2);
        const type = managerType === 0 ? '' : guidAt(managerType);
        if (served.some(one=>one.uuid === uuid && one.major === major && one.minor === minor
            && one.managerType === type))
        {
            return RPC_S_TYPE_ALREADY_REGISTERED;
        }
        served.push({ uuid, major, minor, spec, managerType: type,
            managerEpv: epv !== 0 ? epv : u32(spec + INTERFACE.DEFAULT_MANAGER_EPV) });
        return RPC_S_OK;
    };

    // --- clients ---------------------------------------------------------------

    /**
     * A binding: where calls go, and which object they are for.
     *
     * @typedef {Object} Binding
     * @property {string | null} object
     * @property {string} protseq
     * @property {string} address
     * @property {string} endpoint
     */

    /** @type {Map<number, Binding>} */
    const bindings = new Map();
    /** The first binding handle: not an address a program could mistake for memory it owns. */
    let nextBinding = 0x0b1d0001;

    /**
     * Sends the message in an RPC_MESSAGE to the server it is bound to and
     * puts the reply in its place.
     *
     * @param {number} message
     * @returns {Promise<number>} an RPC status
     */
    const sendReceive = async message=>{
        const binding = bindings.get(u32(message + RPC_MESSAGE.HANDLE));
        if (!binding)
        {
            return RPC_S_INVALID_BINDING;
        }
        if (!LOCAL_ADDRESSES.has(binding.address.replace(/^\\\\/, '').toLowerCase()))
        {
            report(`a call to ${binding.address}: no other machine is reachable`);
            return RPC_S_SERVER_UNAVAILABLE;
        }
        if (binding.endpoint === '')
        {
            // The mapper that would have found it does not exist here.
            return RPC_S_NO_ENDPOINT_FOUND;
        }
        const information = u32(message + RPC_MESSAGE.INTERFACE_INFORMATION);
        if (information === 0)
        {
            return RPC_S_UNKNOWN_IF;
        }
        const id = information + INTERFACE.ID;
        const server = host.table.rpcServer(keyOf(binding.protseq, binding.endpoint));
        const target = server === null ? null : host.table.endpoint(server);
        if (!target?.alive)
        {
            return RPC_S_SERVER_UNAVAILABLE;
        }
        const length = u32(message + RPC_MESSAGE.BUFFER_LENGTH);
        const request = host.readMemory(u32(message + RPC_MESSAGE.BUFFER), length).slice();
        /** @type {{ status?: number, reply?: Uint8Array, hr?: number }} */
        const answered = await target.deliver({ kind: 'rpc', uuid: guidAt(id),
            major: u16(id + GUID_SIZE), minor: u16(id + GUID_SIZE + 2), object: binding.object,
            proc: u32(message + RPC_MESSAGE.PROC_NUM), request });
        if (answered.hr !== undefined)
        {
            // The server ended in the middle of it.
            return RPC_S_CALL_FAILED;
        }
        if (answered.status !== RPC_S_OK || !answered.reply)
        {
            return answered.status ?? RPC_S_CALL_FAILED;
        }
        const reply = allocateBuffer(answered.reply.length);
        if (reply === 0)
        {
            return RPC_S_OUT_OF_MEMORY;
        }
        host.writeMemory(reply, answered.reply);
        freeBuffer(u32(message + RPC_MESSAGE.BUFFER));
        w32(message + RPC_MESSAGE.BUFFER, reply);
        w32(message + RPC_MESSAGE.BUFFER_LENGTH, answered.reply.length);
        return RPC_S_OK;
    };

    /** @param {number} message  A stub message, whose buffer is the RPC message's. */
    const takeBuffer = message=>{
        const rpc = u32(message + STUB_MESSAGE.RPC_MESSAGE);
        const buffer = u32(rpc + RPC_MESSAGE.BUFFER);
        const length = u32(rpc + RPC_MESSAGE.BUFFER_LENGTH);
        w32(message + STUB_MESSAGE.BUFFER, buffer);
        w32(message + STUB_MESSAGE.BUFFER_START, buffer);
        w32(message + STUB_MESSAGE.BUFFER_END, buffer + length);
        w32(message + STUB_MESSAGE.BUFFER_LENGTH, length);
        return buffer;
    };

    /**
     * An RPC_MESSAGE and a stub message made ready for a call, client or server.
     *
     * @param {number} rpc @param {number} message @param {number} descriptor
     * @param {boolean} client
     */
    const initialize = (rpc, message, descriptor, client)=>{
        host.writeMemory(message, new Uint8Array(STUB_MESSAGE.SIZE));
        w32(message + STUB_MESSAGE.RPC_MESSAGE, rpc);
        w32(message + STUB_MESSAGE.IS_CLIENT, client ? 1 : 0);
        w32(message + STUB_MESSAGE.STUB_DESC, descriptor);
        w32(message + STUB_MESSAGE.ALLOCATE, u32(descriptor + STUB_DESC.ALLOCATE));
        w32(message + STUB_MESSAGE.FREE, u32(descriptor + STUB_DESC.FREE));
    };

    /**
     * A string for the guest to free through RpcStringFree.
     *
     * @param {string} text @param {boolean} wide
     * @returns {number} where it is; 0 when nothing fits
     */
    const makeString = (text, wide)=>{
        const bytes = new Uint8Array((text.length + 1) * (wide ? 2 : 1));
        for (let at = 0; at < text.length; at++)
        {
            if (wide)
            {
                bytes[at * 2] = text.charCodeAt(at) & 0xff;
                bytes[at * 2 + 1] = text.charCodeAt(at) >> 8;
            }
            else
            {
                bytes[at] = text.charCodeAt(at) & 0xff;
            }
        }
        const address = host.allocate(bytes.length);
        if (address !== 0)
        {
            host.writeMemory(address, bytes);
        }
        return address;
    };

    /** @param {boolean} wide */
    const compose = wide=>({
        argBytes: 24,
        /** @param {number[]} args */
        handler: ([object, protseq, address, endpointText, options, out])=>{
            let objectText = textAt(object, wide);
            if (objectText !== null && parseGuid(`{${objectText}}`) === null)
            {
                return RPC_S_INVALID_STRING_UUID;
            }
            objectText = objectText === null ? null : objectText.toLowerCase();
            const sequence = textAt(protseq, wide);
            if (sequence === null)
            {
                return RPC_S_INVALID_RPC_PROTSEQ;
            }
            const text = composeStringBinding({ object: objectText, protseq: sequence,
                address: textAt(address, wide) ?? '', endpoint: textAt(endpointText, wide) ?? '',
                options: textAt(options, wide) ?? '' });
            if ((out >>> 0) === 0)
            {
                return RPC_S_OK;
            }
            const made = makeString(text, wide);
            if (made === 0)
            {
                return RPC_S_OUT_OF_MEMORY;
            }
            w32(out >>> 0, made);
            return RPC_S_OK;
        },
    });

    /** @param {boolean} wide */
    const fromString = wide=>({
        argBytes: 8,
        /** @param {number[]} args */
        handler: ([text, out])=>{
            const parts = parseStringBinding(textAt(text, wide) ?? '');
            if (parts === null)
            {
                return RPC_S_INVALID_STRING_BINDING;
            }
            const uuid = parts.object === null ? null : parseGuid(`{${parts.object}}`);
            if (parts.object !== null && uuid === null)
            {
                return RPC_S_INVALID_STRING_UUID;
            }
            if (!PROTSEQS.has(parts.protseq.toLowerCase()))
            {
                return RPC_S_INVALID_RPC_PROTSEQ;
            }
            // A binding with no endpoint is partly bound: it is made, and a
            // call through it asks a mapper for the rest.
            const handle = nextBinding++;
            bindings.set(handle, { object: uuid === null ? null : formatGuid(uuid),
                protseq: parts.protseq, address: parts.address, endpoint: parts.endpoint });
            w32(out >>> 0, handle);
            return RPC_S_OK;
        },
    });

    /** @param {boolean} wide */
    const useEndpoint = wide=>({
        argBytes: 16,
        /** @param {number[]} args */
        handler: ([protseq, calls, endpointText])=>
            useProtseqEndpoint(protseq, calls, endpointText, wide),
    });

    const registerIf = {
        argBytes: 12,
        /** @param {number[]} args */
        handler: ([spec, managerType, epv])=>registerInterface(spec >>> 0, managerType >>> 0,
            epv >>> 0),
    };
    // The same registration with the options it also takes, which a server that
    // listens on its own account does not use here.
    const registerIfEx = {
        argBytes: 24,
        /** @param {number[]} args */
        handler: ([spec, managerType, epv, flags])=>{
            if ((flags & 1) !== 0)
            {
                report('RPC_IF_AUTOLISTEN: the server listens only when RpcServerListen is called');
            }
            return registerInterface(spec >>> 0, managerType >>> 0, epv >>> 0);
        },
    };

    return {
        /**
         * RPC_STATUS RpcServerUseProtseqEpA(RPC_CSTR Protseq, unsigned int MaxCalls,
         *     RPC_CSTR Endpoint, void *SecurityDescriptor)
         */
        RpcServerUseProtseqEpA: useEndpoint(false),
        RpcServerUseProtseqEpW: useEndpoint(true),

        /**
         * RPC_STATUS RpcServerRegisterIf(RPC_IF_HANDLE IfSpec, UUID *MgrTypeUuid, void *MgrEpv)
         *
         * With no manager type UUID, the interface's own manager is the one
         * its stubs call.
         */
        RpcServerRegisterIf: registerIf,
        RpcServerRegisterIfEx: registerIfEx,
        RpcServerRegisterIf2: { ...registerIfEx, argBytes: 28 },

        /**
         * RPC_STATUS RpcServerUnregisterIf(RPC_IF_HANDLE IfSpec, UUID *MgrTypeUuid,
         *     unsigned int WaitForCallsToComplete)
         */
        RpcServerUnregisterIf: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([spec, managerType])=>{
                if ((spec >>> 0) === 0)
                {
                    const had = served.length > 0;
                    served = [];
                    return had ? RPC_S_OK : RPC_S_UNKNOWN_IF;
                }
                const uuid = guidAt(spec + INTERFACE.ID);
                const major = u16(spec + INTERFACE.ID + GUID_SIZE);
                const minor = u16(spec + INTERFACE.ID + GUID_SIZE + 2);
                const type = (managerType >>> 0) === 0 ? null : guidAt(managerType >>> 0);
                const kept = served.filter(one=>!(one.uuid === uuid && one.major === major
                    && one.minor === minor && (type === null || one.managerType === type)));
                const found = kept.length !== served.length;
                served = kept;
                return found ? RPC_S_OK : RPC_S_UNKNOWN_IF;
            },
        },

        /**
         * RPC_STATUS RpcServerListen(unsigned int MinimumCallThreads,
         *     unsigned int MaxCalls, unsigned int DontWait)
         *
         * The calling thread is the one that runs the stubs, until the server
         * is stopped.
         */
        RpcServerListen: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([, , dontWait])=>{
                if (bound.size === 0)
                {
                    return RPC_S_NO_PROTSEQS_REGISTERED;
                }
                if (listening)
                {
                    return RPC_S_ALREADY_LISTENING;
                }
                if ((dontWait >>> 0) !== 0)
                {
                    report('RpcServerListen without waiting: the stubs have no thread to run on,'
                        + ' and a call to them is refused');
                    return RPC_S_OK;
                }
                listening = true;
                stopping = false;
                const thread = host.callerThread();
                return listen(thread).then(()=>{
                    listening = false;
                    const left = released;
                    released = [];
                    left.forEach(release=>release());
                    return RPC_S_OK;
                });
            },
        },

        /**
         * RPC_STATUS RpcMgmtStopServerListening(RPC_BINDING_HANDLE Binding)
         *
         * This process's server, for no binding; another process's is not
         * stopped from here.
         */
        RpcMgmtStopServerListening: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([binding])=>{
                if ((binding >>> 0) !== 0)
                {
                    report('RpcMgmtStopServerListening on a binding: only the server of this'
                        + ' process is stopped');
                    return ERROR_ACCESS_DENIED;
                }
                if (!listening)
                {
                    return RPC_S_NOT_LISTENING;
                }
                stopping = true;
                wake?.();
                return RPC_S_OK;
            },
        },

        /** RPC_STATUS RpcMgmtWaitServerListen(void) */
        RpcMgmtWaitServerListen: {
            argBytes: 0,
            handler: ()=>{
                if (!listening)
                {
                    return RPC_S_NOT_LISTENING;
                }
                return new Promise(resolve=>{
                    released.push(()=>resolve(RPC_S_OK));
                });
            },
        },

        /** unsigned char *NdrServerInitializeNew(PRPC_MESSAGE pRpcMsg, PMIDL_STUB_MESSAGE pStubMsg, PMIDL_STUB_DESC pStubDescriptor) */
        NdrServerInitializeNew: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([rpc, message, descriptor])=>{
                initialize(rpc >>> 0, message >>> 0, descriptor >>> 0, false);
                takeBuffer(message >>> 0);
                return 0;
            },
        },

        /**
         * RPC_STATUS I_RpcGetBuffer(RPC_MESSAGE *Message)
         *
         * A buffer of BufferLength bytes in the message, for a stub to marshal
         * its reply into; the request's is given back with the call.
         */
        I_RpcGetBuffer: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([message])=>{
                const buffer = allocateBuffer(u32((message >>> 0) + RPC_MESSAGE.BUFFER_LENGTH));
                if (buffer === 0)
                {
                    return RPC_S_OUT_OF_MEMORY;
                }
                w32((message >>> 0) + RPC_MESSAGE.BUFFER, buffer);
                return RPC_S_OK;
            },
        },

        /** RPC_STATUS I_RpcFreeBuffer(RPC_MESSAGE *Message) */
        I_RpcFreeBuffer: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([message])=>{
                freeBuffer(u32((message >>> 0) + RPC_MESSAGE.BUFFER));
                w32((message >>> 0) + RPC_MESSAGE.BUFFER, 0);
                return RPC_S_OK;
            },
        },

        /**
         * RPC_STATUS RpcStringBindingComposeA(RPC_CSTR ObjUuid, RPC_CSTR ProtSeq,
         *     RPC_CSTR NetworkAddr, RPC_CSTR Endpoint, RPC_CSTR Options,
         *     RPC_CSTR *StringBinding)
         */
        RpcStringBindingComposeA: compose(false),
        RpcStringBindingComposeW: compose(true),

        /**
         * RPC_STATUS RpcBindingFromStringBindingA(RPC_CSTR StringBinding,
         *     RPC_BINDING_HANDLE *Binding)
         */
        RpcBindingFromStringBindingA: fromString(false),
        RpcBindingFromStringBindingW: fromString(true),

        /** RPC_STATUS RpcBindingFree(RPC_BINDING_HANDLE *Binding) -- freed, and the handle cleared. */
        RpcBindingFree: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([slot])=>{
                if ((slot >>> 0) === 0)
                {
                    return RPC_S_INVALID_BINDING;
                }
                const handle = u32(slot >>> 0);
                if (!bindings.delete(handle))
                {
                    return RPC_S_INVALID_BINDING;
                }
                w32(slot >>> 0, 0);
                return RPC_S_OK;
            },
        },

        /**
         * void NdrClientInitializeNew(PRPC_MESSAGE pRpcMessage, PMIDL_STUB_MESSAGE pStubMsg,
         *     PMIDL_STUB_DESC pStubDescriptor, unsigned int ProcNum)
         */
        NdrClientInitializeNew: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([rpc, message, descriptor, procedure])=>{
                host.writeMemory(rpc >>> 0, new Uint8Array(RPC_MESSAGE.SIZE));
                w32((rpc >>> 0) + RPC_MESSAGE.DATA_REPRESENTATION, NDR_LOCAL_DATA_REPRESENTATION);
                w32((rpc >>> 0) + RPC_MESSAGE.PROC_NUM, procedure);
                w32((rpc >>> 0) + RPC_MESSAGE.INTERFACE_INFORMATION,
                    u32((descriptor >>> 0) + STUB_DESC.INTERFACE_INFORMATION));
                initialize(rpc >>> 0, message >>> 0, descriptor >>> 0, true);
                return 0;
            },
        },

        /**
         * unsigned char *NdrGetBuffer(PMIDL_STUB_MESSAGE pStubMsg, unsigned long BufferLength,
         *     RPC_BINDING_HANDLE Handle)
         */
        NdrGetBuffer: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([message, length, handle])=>{
                const rpc = u32((message >>> 0) + STUB_MESSAGE.RPC_MESSAGE);
                const buffer = allocateBuffer(length >>> 0);
                if (buffer === 0)
                {
                    return host.raise(RPC_S_OUT_OF_MEMORY);
                }
                w32(rpc + RPC_MESSAGE.HANDLE, handle);
                w32(rpc + RPC_MESSAGE.BUFFER, buffer);
                w32(rpc + RPC_MESSAGE.BUFFER_LENGTH, length);
                return takeBuffer(message >>> 0);
            },
        },

        /**
         * unsigned char *NdrSendReceive(PMIDL_STUB_MESSAGE pStubMsg, unsigned char *pBufferEnd)
         *
         * What the stub wrote is the request; the reply is where it reads
         * from after.
         */
        NdrSendReceive: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([message, end])=>{
                const thread = host.callerThread();
                const rpc = u32((message >>> 0) + STUB_MESSAGE.RPC_MESSAGE);
                w32(rpc + RPC_MESSAGE.BUFFER_LENGTH, ((end >>> 0) - u32(rpc + RPC_MESSAGE.BUFFER))
                    >>> 0);
                return sendReceive(rpc).then(status=>{
                    if (status !== RPC_S_OK)
                    {
                        report(`a call failed with RPC status ${status}`);
                        return host.raiseLater(status, thread);
                    }
                    return takeBuffer(message >>> 0);
                });
            },
        },

        /** void NdrFreeBuffer(PMIDL_STUB_MESSAGE pStubMsg) */
        NdrFreeBuffer: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([message])=>{
                const rpc = u32((message >>> 0) + STUB_MESSAGE.RPC_MESSAGE);
                if (rpc !== 0)
                {
                    freeBuffer(u32(rpc + RPC_MESSAGE.BUFFER));
                    w32(rpc + RPC_MESSAGE.BUFFER, 0);
                }
                return 0;
            },
        },
    };
}
