/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Named pipes: a server makes instances of a name under `\\.\pipe\`, a client
 * opens one with CreateFile, and the two ends carry bytes both ways -- as a
 * stream, or as messages each read whole or in parts.
 *
 * The namespace is the run's (`system.namedObjects`, the table named events
 * and mutexes are found in), so a pipe one process makes is one its children
 * open: a browser's IPC and a crash reporter's connection are pipes between
 * processes. The pipe and its ends are objects every process of the run on
 * this thread holds directly; a process in a worker of its own has no way to
 * the table's objects and is refused, as before, with a divergence.
 *
 * Every operation that cannot finish at once belongs to the process that
 * asked: it is kept with that process's own memory, kernel and completion
 * ports (`PipeHost`), and whoever supplies the bytes or the client finishes
 * it there -- writing the reader's buffer in the reader's memory, waking the
 * reader's thread, signalling the reader's event, posting to the reader's
 * port. A synchronous call parks its thread; an overlapped one answers
 * ERROR_IO_PENDING and completes through its OVERLAPPED. A read that finds
 * its bytes already there completes at once, and an overlapped one still
 * sets its event and posts its packet, unless the handle asked to skip that
 * (SetFileCompletionNotificationModes). Writes always finish at once: the
 * buffer is not bounded.
 */

import { STATUS, toDosError } from '../ntdll/status.js';

const ERROR_SUCCESS = 0;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_ACCESS_DENIED = 5;
const ERROR_INVALID_HANDLE = 6;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_SEM_TIMEOUT = 121;
const ERROR_INVALID_NAME = 123;
const ERROR_CALL_NOT_IMPLEMENTED = 120;
const ERROR_BAD_PIPE = 230;
const ERROR_PIPE_BUSY = 231;
const ERROR_NO_DATA = 232;
const ERROR_PIPE_CONNECTED = 535;
const ERROR_PIPE_LISTENING = 536;
const ERROR_IO_PENDING = 997;
const ERROR_NOACCESS = 998;

const INVALID_HANDLE_VALUE = 0xffffffff;

/** The open mode: which way bytes go from the server, and the flags read here. */
const PIPE_ACCESS_INBOUND = 0x1;
const PIPE_ACCESS_OUTBOUND = 0x2;
const FILE_FLAG_FIRST_PIPE_INSTANCE = 0x00080000;
const FILE_FLAG_OVERLAPPED = 0x40000000;
/** The pipe mode. */
const PIPE_TYPE_MESSAGE = 0x4;
const PIPE_READMODE_MESSAGE = 0x2;
const PIPE_NOWAIT = 0x1;
const PIPE_UNLIMITED_INSTANCES = 255;
/** GetNamedPipeInfo's flags. */
const PIPE_SERVER_END = 0x1;
/** The pipe-state values GetNamedPipeHandleState answers. */
const PIPE_STATE_MASK = PIPE_READMODE_MESSAGE | PIPE_NOWAIT;

/** WaitNamedPipe's two special timeouts. */
const NMPWAIT_USE_DEFAULT_WAIT = 0;
const NMPWAIT_WAIT_FOREVER = 0xffffffff;
/** What a pipe made with no timeout waits by default: fifty milliseconds. */
const DEFAULT_TIMEOUT = 50;

/** Access bits a client end is opened with. */
const GENERIC_READ = 0x80000000;
const GENERIC_WRITE = 0x40000000;
const FILE_READ_DATA = 0x1;
const FILE_WRITE_DATA = 0x2;

/** SetFileCompletionNotificationModes' flags. */
const FILE_SKIP_COMPLETION_PORT_ON_SUCCESS = 0x1;
const FILE_SKIP_SET_EVENT_ON_HANDLE = 0x2;

/** The pipe statuses an OVERLAPPED is finished with. */
const STATUS_PIPE_BROKEN = STATUS.PIPE_BROKEN;
const STATUS_CANCELLED = STATUS.CANCELLED;
const STATUS_PIPE_DISCONNECTED = STATUS.PIPE_DISCONNECTED;
const STATUS_PIPE_LISTENING = STATUS.PIPE_LISTENING;
/** A write to an end whose peer is gone: ERROR_NO_DATA. */
const STATUS_PIPE_CLOSING = STATUS.PIPE_CLOSING;

/** OVERLAPPED's two status fields and its event. */
const OVERLAPPED_INTERNAL = 0;
const OVERLAPPED_INTERNAL_HIGH = 4;
const OVERLAPPED_EVENT = 16;

/** Where a pipe's names begin, in the namespace's own spelling. */
const PREFIXES = ['\\\\.\\pipe\\', '\\\\?\\pipe\\'];
/** The run's table keys pipes under this, which no event or mutex name begins with. */
const TABLE_PREFIX = 'pipe:';

/** A name read whole, as Windows reads it: 256 characters is a pipe name's limit. */
const NAME_BYTES = 520;

/**
 * Whether a name is a pipe's, as CreateFile is handed one.
 *
 * @param {string} name
 */
export const isPipeName = name=>PREFIXES.some(prefix=>
    name.toLowerCase().startsWith(prefix) && name.length > prefix.length);

/**
 * What a process gives the pipes to finish its operations with.
 *
 * @typedef {Object} PipeHost
 * @property {any} kernel  block, wake, onTimeout, clock
 * @property {{ open: (type: string, object: any) => number,
 *     resolve: (handle: number, type?: string) => any,
 *     typeOf?: (handle: number) => string | null }} handles
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(address: number, maxBytes: number) => string} readWideString
 * @property {(code: number) => void} setLastError
 * @property {(thread: any, code: number) => void} setLastErrorFor
 * @property {() => any} currentThread
 * @property {() => any} park
 * @property {Map<string, any> | null} [table]  the run's named objects; absent, this
 *           process's own
 * @property {boolean} [remote]  a process in a worker of its own: no pipes
 * @property {number} [processId]
 * @property {(file: number, transferred: number, overlapped: number, status?: number,
 *     skip?: { port?: boolean, event?: boolean }) => boolean} [completed]
 *           Finishes an OVERLAPPED: its status, its count, its event, the port.
 * @property {(event: number) => void} [setEvent]
 * @property {(api: string, detail: string) => void} [divergence]
 */

/**
 * @typedef {Object} Pipe
 * @property {string} name
 * @property {string} key
 * @property {number} maxInstances
 * @property {number} openMode
 * @property {boolean} messages  PIPE_TYPE_MESSAGE
 * @property {number} timeout
 * @property {number} outSize
 * @property {number} inSize
 * @property {Set<Instance>} instances
 * @property {Waiter[]} waiters  WaitNamedPipe's callers
 */

/**
 * @typedef {Object} Instance
 * @property {Pipe} pipe
 * @property {'listening' | 'connected' | 'closing' | 'disconnected'} state
 *           listening: a client may open it; connected: both ends there;
 *           closing: the client closed its end; disconnected: the server cut
 *           the client off and has not listened again
 * @property {End} server
 * @property {End | null} client
 * @property {Op[]} connects  ConnectNamedPipe's waits
 * @property {number} clientProcess
 */

/**
 * @typedef {Object} End
 * @property {Instance} instance
 * @property {'server' | 'client'} side
 * @property {{ bytes: Uint8Array, at: number }[]} inbox  what the other end wrote, unread
 * @property {Op[]} readers
 * @property {boolean} readMessages
 * @property {boolean} nowait
 * @property {boolean} canRead
 * @property {boolean} canWrite
 * @property {boolean} closed
 * @property {boolean} cut  a client the server disconnected
 * @property {number} refs  handles onto it, in every process
 * @property {any} [signal]  the event a wait on its handle waits on, made when first
 *     waited on: set while no operation of it is pending, as a file object is
 * @property {() => void} retain  one more handle onto it
 */

/**
 * An operation waiting: a read, a connect or a wait for an instance, with
 * the process it belongs to.
 *
 * @typedef {Object} Op
 * @property {'read' | 'connect'} kind
 * @property {Context} ctx
 * @property {any} thread
 * @property {number} handle
 * @property {End} [end]  the end it is on, whose signal it holds down while pending
 * @property {number} overlapped  0 for a synchronous call, parked
 * @property {number} buffer
 * @property {number} length
 * @property {number} out  the count's address
 * @property {boolean} [native]  NtReadFile's: `out` is the IO_STATUS_BLOCK
 */

/**
 * @typedef {Object} Waiter
 * @property {Context} ctx
 * @property {any} thread
 */

/**
 * One process's way to finish what it asked: the host it called with, and the
 * completion modes its handles were set to.
 *
 * @typedef {Object} Context
 * @property {PipeHost} host
 * @property {Map<number, number>} modes
 */

/** @param {PipeHost} host */
export function createNamedPipes(host){
    const { kernel } = host;
    /** @type {Map<string, any>} */
    const table = host.table ?? new Map();
    /** @type {Context} */
    const ctx = { host, modes: new Map() };
    /**
     * Whether each of this process's pipe handles is inherited by the children
     * it starts: what the security attributes said, then SetHandleInformation.
     *
     * @type {Map<number, boolean>}
     */
    const inheritable = new Map();

    /** @param {number} code @param {number} [result] */
    const fail = (code, result = 0)=>{
        host.setLastError(code);
        return result;
    };
    /** @param {number} address @param {number} value */
    const writeDword = (address, value)=>host.writeMemory(address >>> 0, Uint8Array.of(
        value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff));
    /** @param {number} address @param {number} value */
    const writeDwordIf = (address, value)=>{
        if ((address >>> 0) !== 0)
        {
            writeDword(address, value);
        }
    };
    /** @param {number} address */
    const readDword = address=>{
        const bytes = host.readMemory(address >>> 0, 4);
        return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
    };
    /** @param {number} handle @returns {End | null} */
    const endOf = handle=>{
        if ((host.handles.typeOf?.(handle >>> 0) ?? 'pipe') !== 'pipe')
        {
            return null;
        }
        try
        {
            return host.handles.resolve(handle >>> 0, 'pipe');
        }
        catch {
            return null;
        }
    };
    /** @param {number} pointer @param {boolean} wide */
    const nameAt = (pointer, wide)=>((pointer >>> 0) === 0 ? null
        : wide ? host.readWideString(pointer >>> 0, NAME_BYTES)
            : host.readCString(pointer >>> 0, NAME_BYTES / 2));
    /** The run's key for a pipe's name. @param {string} name */
    const keyOf = name=>{
        const prefix = PREFIXES.find(one=>name.toLowerCase().startsWith(one)) ?? PREFIXES[0];
        return TABLE_PREFIX + name.slice(prefix.length).toLowerCase();
    };
    /** @param {string} key @returns {Pipe | null} */
    const pipeAt = key=>{
        const held = table.get(key);
        return held?.kind === 'pipe' ? held.object : null;
    };
    /** What a security attributes block says of inheritance. @param {number} attributes */
    const inheritsBy = attributes=>(attributes >>> 0) !== 0
        && readDword((attributes >>> 0) + 8) !== 0;

    kernel.onTimeout?.((/** @type {any} */ thread)=>{
        // A WaitNamedPipe that ran out has stopped waiting.
        for (const held of table.values())
        {
            if (held?.kind === 'pipe')
            {
                /** @type {Pipe} */
                const pipe = held.object;
                pipe.waiters = pipe.waiters.filter(waiter=>waiter.thread !== thread);
            }
        }
    });

    /**
     * A new end, one handle onto it.
     *
     * @param {Instance} instance @param {'server' | 'client'} side
     * @param {boolean} canRead @param {boolean} canWrite
     * @returns {End}
     */
    const makeEnd = (instance, side, canRead, canWrite)=>{
        /** @type {End} */
        const end = {
            instance, side, inbox: [], readers: [], readMessages: false, nowait: false,
            canRead, canWrite, closed: false, cut: false, refs: 1,
            retain(){
                end.refs++;
            },
        };
        return end;
    };

    /** The other end of an end, while there is one. @param {End} end */
    const peerOf = end=>(end.side === 'server' ? end.instance.client : end.instance.server);

    /** Bytes waiting at an end. @param {End} end */
    const available = end=>end.inbox.reduce((total, message)=>
        total + message.bytes.length - message.at, 0);

    /**
     * Finishes an operation where its process asked it, and wakes that process's
     * thread when it was parked.
     *
     * @param {Op} op @param {number} status @param {number} count
     */
    const finish = (op, status, count)=>{
        const owner = op.ctx.host;
        if (op.end?.signal)
        {
            owner.kernel.setEvent?.(op.end.signal);
        }
        const error = toDosError(status);
        const succeeded = status === STATUS.SUCCESS;
        if (op.overlapped !== 0)
        {
            if (owner.completed)
            {
                owner.completed(op.handle, count, op.overlapped, status);
            }
            else
            {
                owner.writeMemory(op.overlapped + OVERLAPPED_INTERNAL, dwordBytes(status));
                owner.writeMemory(op.overlapped + OVERLAPPED_INTERNAL_HIGH, dwordBytes(count));
                const event = readFrom(owner, op.overlapped + OVERLAPPED_EVENT);
                if (event !== 0)
                {
                    owner.setEvent?.(event);
                }
            }
            return;
        }
        if (op.native)
        {
            owner.writeMemory(op.out, dwordBytes(status));
            owner.writeMemory(op.out + 4, dwordBytes(count));
            owner.kernel.wake(op.thread, status);
            return;
        }
        if (op.out !== 0)
        {
            owner.writeMemory(op.out, dwordBytes(count));
        }
        // A part of a message is read and still FALSE, ERROR_MORE_DATA.
        owner.setLastErrorFor(op.thread, succeeded ? ERROR_SUCCESS : error);
        owner.kernel.wake(op.thread, succeeded ? 1 : 0);
    };

    /**
     * Takes what a read gets from an end's inbox, in the end's read mode, or
     * null when there is nothing.
     *
     * @param {End} end @param {number} length
     * @returns {{ bytes: Uint8Array, status: number } | null}
     */
    const take = (end, length)=>{
        if (end.inbox.length === 0)
        {
            return null;
        }
        if (end.readMessages)
        {
            const message = end.inbox[0];
            const left = message.bytes.length - message.at;
            const count = Math.min(left, length);
            const bytes = message.bytes.slice(message.at, message.at + count);
            if (count < left)
            {
                message.at += count;
                return { bytes, status: STATUS.BUFFER_OVERFLOW };
            }
            end.inbox.shift();
            return { bytes, status: STATUS.SUCCESS };
        }
        const parts = [];
        let taken = 0;
        while (taken < length && end.inbox.length > 0)
        {
            const message = end.inbox[0];
            const count = Math.min(message.bytes.length - message.at, length - taken);
            parts.push(message.bytes.subarray(message.at, message.at + count));
            message.at += count;
            taken += count;
            if (message.at === message.bytes.length)
            {
                end.inbox.shift();
            }
        }
        // A byte read of an empty message still takes it, and reads nothing.
        while (end.inbox.length > 0 && end.inbox[0].bytes.length === end.inbox[0].at)
        {
            end.inbox.shift();
        }
        const bytes = new Uint8Array(taken);
        let at = 0;
        for (const part of parts)
        {
            bytes.set(part, at);
            at += part.length;
        }
        return { bytes, status: STATUS.SUCCESS };
    };

    /**
     * Why an end cannot read or write now, as a status, or null when it can.
     *
     * @param {End} end @param {boolean} writing
     */
    const blocked = (end, writing)=>{
        const { instance } = end;
        if (end.cut || instance.state === 'disconnected')
        {
            return STATUS_PIPE_DISCONNECTED;
        }
        if (instance.state === 'listening')
        {
            return STATUS_PIPE_LISTENING;
        }
        const peer = peerOf(end);
        if (!peer || peer.closed)
        {
            // What the peer wrote before it went is still read.
            return writing || end.inbox.length === 0 ? STATUS_PIPE_BROKEN : null;
        }
        return null;
    };

    /** Serves an end's waiting readers from its inbox, then the broken pipe. @param {End} end */
    const serve = end=>{
        while (end.readers.length > 0)
        {
            const op = end.readers[0];
            const got = take(end, op.length);
            if (got)
            {
                end.readers.shift();
                if (got.bytes.length > 0)
                {
                    op.ctx.host.writeMemory(op.buffer, got.bytes);
                }
                finish(op, got.status, got.bytes.length);
                continue;
            }
            const why = blocked(end, false);
            if (why === null)
            {
                return;
            }
            end.readers.shift();
            finish(op, why, 0);
        }
    };

    /** Ends what waits on an end, as cancelled. @param {End} end @param {(op: Op) => boolean} which */
    const abort = (end, which)=>{
        let count = 0;
        for (const op of [...end.readers, ...end.side === 'server' ? end.instance.connects : []])
        {
            if (!which(op))
            {
                continue;
            }
            end.readers = end.readers.filter(one=>one !== op);
            end.instance.connects = end.instance.connects.filter(one=>one !== op);
            finish(op, STATUS_CANCELLED, 0);
            count++;
        }
        return count;
    };

    /** A client has come to an instance: its connects end. @param {Instance} instance */
    const connected = instance=>{
        for (const op of instance.connects.splice(0))
        {
            finish(op, STATUS.SUCCESS, 0);
        }
    };

    /** An instance listens again: a WaitNamedPipe may end. @param {Pipe} pipe */
    const listening = pipe=>{
        for (const waiter of pipe.waiters.splice(0))
        {
            waiter.ctx.host.setLastErrorFor(waiter.thread, ERROR_SUCCESS);
            waiter.ctx.host.kernel.wake(waiter.thread, 1);
        }
    };

    /**
     * The last handle onto an end has closed: what waits on it is cancelled,
     * and the other end finds the pipe broken.
     *
     * @param {End} end
     */
    const closeEnd = end=>{
        end.closed = true;
        abort(end, ()=>true);
        const { instance } = end;
        if (end.side === 'client')
        {
            if (instance.client === end && instance.state === 'connected')
            {
                instance.state = 'closing';
            }
            if (instance.client === end && !end.cut)
            {
                serve(instance.server);
            }
            return;
        }
        const { pipe } = instance;
        pipe.instances.delete(instance);
        if (instance.client && !instance.client.cut)
        {
            serve(instance.client);
        }
        if (pipe.instances.size === 0 && pipeAt(pipe.key) === pipe)
        {
            table.delete(pipe.key);
        }
    };

    /**
     * Makes a server instance.
     *
     * @param {string | null} name
     * @param {number[]} args  the rest of CreateNamedPipe's arguments
     */
    const createPipe = (name, args)=>{
        const [openMode, pipeMode, maxInstances, outSize, inSize, timeout, attributes] = args;
        if (host.remote)
        {
            host.divergence?.('CreateNamedPipe', 'a process in a worker of its own has no '
                + 'way to the run\'s pipes; refused as Windows 9x refuses it');
            return fail(ERROR_CALL_NOT_IMPLEMENTED, INVALID_HANDLE_VALUE);
        }
        if (name === null || !isPipeName(name))
        {
            return fail(ERROR_INVALID_NAME, INVALID_HANDLE_VALUE);
        }
        const mode = openMode >>> 0;
        const kind = pipeMode >>> 0;
        const max = maxInstances >>> 0;
        const direction = mode & (PIPE_ACCESS_INBOUND | PIPE_ACCESS_OUTBOUND);
        if (max === 0 || max > PIPE_UNLIMITED_INSTANCES || direction === 0
            || ((kind & PIPE_READMODE_MESSAGE) !== 0 && (kind & PIPE_TYPE_MESSAGE) === 0))
        {
            return fail(ERROR_INVALID_PARAMETER, INVALID_HANDLE_VALUE);
        }
        const key = keyOf(name);
        let pipe = pipeAt(key);
        if (pipe)
        {
            if ((mode & FILE_FLAG_FIRST_PIPE_INSTANCE) !== 0)
            {
                return fail(ERROR_ACCESS_DENIED, INVALID_HANDLE_VALUE);
            }
            if (pipe.instances.size >= pipe.maxInstances)
            {
                return fail(ERROR_PIPE_BUSY, INVALID_HANDLE_VALUE);
            }
            // A second instance is the first's kind of pipe.
            if ((direction !== (pipe.openMode & (PIPE_ACCESS_INBOUND | PIPE_ACCESS_OUTBOUND)))
                || ((kind & PIPE_TYPE_MESSAGE) !== 0) !== pipe.messages)
            {
                return fail(ERROR_ACCESS_DENIED, INVALID_HANDLE_VALUE);
            }
        }
        else
        {
            pipe = {
                name, key, maxInstances: max, openMode: mode,
                messages: (kind & PIPE_TYPE_MESSAGE) !== 0,
                timeout: (timeout >>> 0) === 0 ? DEFAULT_TIMEOUT : timeout >>> 0,
                outSize: outSize >>> 0, inSize: inSize >>> 0,
                instances: new Set(), waiters: [],
            };
            table.set(key, { kind: 'pipe', object: pipe, refs: 1 });
        }
        /** @type {Instance} */
        const instance = {
            pipe, state: 'listening', server: /** @type {any} */ (null), client: null,
            connects: [], clientProcess: 0,
        };
        instance.server = makeEnd(instance, 'server', (direction & PIPE_ACCESS_INBOUND) !== 0,
            (direction & PIPE_ACCESS_OUTBOUND) !== 0);
        instance.server.readMessages = (kind & PIPE_READMODE_MESSAGE) !== 0;
        instance.server.nowait = (kind & PIPE_NOWAIT) !== 0;
        /** @type {any} */ (instance.server).overlapped = (mode & FILE_FLAG_OVERLAPPED) !== 0;
        /** @type {any} */ (instance.server).serverProcess = host.processId ?? 0;
        pipe.instances.add(instance);
        const handle = host.handles.open('pipe', instance.server);
        inheritable.set(handle, inheritsBy(attributes));
        listening(pipe);
        host.setLastError(ERROR_SUCCESS);
        return handle;
    };

    /**
     * CreateFile on a pipe's name: a client end of an instance that listens.
     *
     * @param {string} name @param {number} access @param {number} flags
     * @param {number} [attributes]
     * @returns {{ handle: number } | { error: number }}
     */
    const open = (name, access, flags, attributes = 0)=>{
        if (host.remote)
        {
            return { error: ERROR_FILE_NOT_FOUND };
        }
        const pipe = pipeAt(keyOf(name));
        if (!pipe)
        {
            return { error: ERROR_FILE_NOT_FOUND };
        }
        const instance = [...pipe.instances].find(one=>one.state === 'listening');
        if (!instance)
        {
            return { error: ERROR_PIPE_BUSY };
        }
        const asked = access >>> 0;
        const reads = (asked & (GENERIC_READ | FILE_READ_DATA)) !== 0;
        const writes = (asked & (GENERIC_WRITE | FILE_WRITE_DATA)) !== 0;
        const outbound = (pipe.openMode & PIPE_ACCESS_OUTBOUND) !== 0;
        const inbound = (pipe.openMode & PIPE_ACCESS_INBOUND) !== 0;
        if ((reads && !outbound) || (writes && !inbound))
        {
            return { error: ERROR_ACCESS_DENIED };
        }
        const client = makeEnd(instance, 'client', reads, writes);
        /** @type {any} */ (client).overlapped = ((flags >>> 0) & FILE_FLAG_OVERLAPPED) !== 0;
        instance.client = client;
        instance.state = 'connected';
        instance.clientProcess = host.processId ?? 0;
        const handle = host.handles.open('pipe', client);
        inheritable.set(handle, inheritsBy(attributes));
        connected(instance);
        return { handle };
    };

    /**
     * Starts a read on an end the call has already found.
     *
     * @param {End} end @param {number} handle @param {number} buffer @param {number} length
     * @param {number} out @param {number} overlapped @param {boolean} native
     */
    const startRead = (end, handle, buffer, length, out, overlapped, native)=>{
        /** @param {number} status @param {number} count */
        const answerNow = (status, count)=>{
            if (overlapped !== 0)
            {
                const modes = ctx.modes.get(handle) ?? 0;
                const succeeded = status === STATUS.SUCCESS;
                if (host.completed)
                {
                    host.completed(handle, count, overlapped, status, {
                        port: succeeded && (modes & FILE_SKIP_COMPLETION_PORT_ON_SUCCESS) !== 0,
                        event: (modes & FILE_SKIP_SET_EVENT_ON_HANDLE) !== 0 });
                }
            }
            if (native)
            {
                writeDword(out, status);
                writeDword(out + 4, count);
                return status;
            }
            writeDwordIf(out, count);
            if (status === STATUS.SUCCESS)
            {
                host.setLastError(ERROR_SUCCESS);
                return 1;
            }
            return fail(toDosError(status));
        };
        if (!end.canRead)
        {
            return native ? STATUS.ACCESS_DENIED : fail(ERROR_ACCESS_DENIED);
        }
        if ((buffer >>> 0) === 0 && (length >>> 0) !== 0)
        {
            return native ? STATUS.ACCESS_VIOLATION : fail(ERROR_NOACCESS);
        }
        // Readers queue in order: a second read behind one waiting waits too.
        const got = end.readers.length === 0 ? take(end, length >>> 0) : null;
        if (got)
        {
            if (got.bytes.length > 0)
            {
                host.writeMemory(buffer >>> 0, got.bytes);
            }
            return answerNow(got.status, got.bytes.length);
        }
        const why = blocked(end, false);
        if (why !== null)
        {
            // An error before any I/O started posts nothing.
            if (native)
            {
                return why;
            }
            return fail(toDosError(why));
        }
        if (end.nowait)
        {
            return native ? STATUS_PIPE_LISTENING : fail(ERROR_NO_DATA);
        }
        /** @type {Op} */
        const op = { kind: 'read', ctx, thread: host.currentThread(), handle,
            overlapped: overlapped >>> 0, buffer: buffer >>> 0, length: length >>> 0,
            out: out >>> 0, native, end };
        end.readers.push(op);
        if (end.signal)
        {
            kernel.resetEvent?.(end.signal);
        }
        if (overlapped !== 0)
        {
            writeDword(overlapped + OVERLAPPED_INTERNAL, STATUS.PENDING);
            writeDword(overlapped + OVERLAPPED_INTERNAL_HIGH, 0);
            return native ? STATUS.PENDING : fail(ERROR_IO_PENDING);
        }
        kernel.block(op.thread, 'pipe read');
        return host.park();
    };

    /**
     * Writes from an end the call has already found.
     *
     * @param {End} end @param {number} handle @param {number} buffer @param {number} length
     * @param {number} out @param {number} overlapped @param {boolean} native
     */
    const startWrite = (end, handle, buffer, length, out, overlapped, native)=>{
        if (!end.canWrite)
        {
            return native ? STATUS.ACCESS_DENIED : fail(ERROR_ACCESS_DENIED);
        }
        const count = length >>> 0;
        if ((buffer >>> 0) === 0 && count !== 0)
        {
            return native ? STATUS.ACCESS_VIOLATION : fail(ERROR_NOACCESS);
        }
        const why = blocked(end, true);
        if (why !== null)
        {
            const status = why === STATUS_PIPE_BROKEN ? STATUS_PIPE_CLOSING : why;
            return native ? status : fail(status === STATUS_PIPE_CLOSING ? ERROR_NO_DATA
                : toDosError(status));
        }
        const peer = /** @type {End} */ (peerOf(end));
        // A zero-length write is a message of its own on a message pipe, and
        // nothing at all on a byte one.
        if (count > 0 || end.instance.pipe.messages)
        {
            peer.inbox.push({ bytes: count === 0 ? new Uint8Array(0)
                : host.readMemory(buffer >>> 0, count).slice(), at: 0 });
        }
        if (overlapped !== 0 && host.completed)
        {
            const modes = ctx.modes.get(handle) ?? 0;
            host.completed(handle, count, overlapped, STATUS.SUCCESS, {
                port: (modes & FILE_SKIP_COMPLETION_PORT_ON_SUCCESS) !== 0,
                event: (modes & FILE_SKIP_SET_EVENT_ON_HANDLE) !== 0 });
        }
        serve(peer);
        if (native)
        {
            writeDword(out, STATUS.SUCCESS);
            writeDword(out + 4, count);
            return STATUS.SUCCESS;
        }
        writeDwordIf(out, count);
        host.setLastError(ERROR_SUCCESS);
        return 1;
    };

    /**
     * ReadFile's and NtReadFile's way in: the answer, or null for a handle
     * that is no pipe end.
     *
     * @param {number} handle @param {number} buffer @param {number} length
     * @param {number} out @param {boolean} [native] @param {number} [overlapped]
     */
    const read = (handle, buffer, length, out, native = false, overlapped = 0)=>{
        const end = endOf(handle);
        return end ? startRead(end, handle >>> 0, buffer, length, out >>> 0,
            overlapped >>> 0, native) : null;
    };

    /**
     * WriteFile's and NtWriteFile's way in.
     *
     * @param {number} handle @param {number} buffer @param {number} length
     * @param {number} out @param {boolean} [native] @param {number} [overlapped]
     */
    const write = (handle, buffer, length, out, native = false, overlapped = 0)=>{
        const end = endOf(handle);
        return end ? startWrite(end, handle >>> 0, buffer, length, out >>> 0,
            overlapped >>> 0, native) : null;
    };

    /**
     * CancelIo and CancelIoEx: what waits on a pipe handle of this process --
     * all of it, the calling thread's alone, or the one OVERLAPPED -- ends
     * cancelled. The count, or null for a handle that is no pipe end.
     *
     * @param {number} handle @param {{ overlapped?: number, thread?: any }} which
     */
    const cancel = (handle, which)=>{
        const end = endOf(handle);
        if (!end)
        {
            return null;
        }
        return abort(end, op=>op.ctx === ctx && op.handle === (handle >>> 0)
            && (which.overlapped === undefined || op.overlapped === which.overlapped)
            && (which.thread === undefined || op.thread === which.thread));
    };

    /**
     * A handle of this process was closed. The end goes when its last handle,
     * in any process, does.
     *
     * @param {number} handle @param {any} object  what it named
     */
    const closed = (handle, object)=>{
        inheritable.delete(handle >>> 0);
        ctx.modes.delete(handle >>> 0);
        if (!object || object.instance?.server === undefined || typeof object.retain !== 'function')
        {
            return;
        }
        /** @type {End} */
        const end = object;
        if (--end.refs <= 0 && !end.closed)
        {
            closeEnd(end);
        }
    };

    /** @param {boolean} wide */
    const waitNamedPipe = wide=>({
        argBytes: 8,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [pointer, timeout])=>{
            const name = nameAt(pointer, wide);
            if (name === null || !isPipeName(name))
            {
                return fail(ERROR_INVALID_NAME);
            }
            const pipe = pipeAt(keyOf(name));
            if (!pipe)
            {
                return fail(ERROR_FILE_NOT_FOUND);
            }
            if ([...pipe.instances].some(one=>one.state === 'listening'))
            {
                return 1;
            }
            const wait = (timeout >>> 0) === NMPWAIT_USE_DEFAULT_WAIT ? pipe.timeout
                : timeout >>> 0;
            if (wait !== NMPWAIT_WAIT_FOREVER && wait === 0)
            {
                return fail(ERROR_SEM_TIMEOUT);
            }
            const thread = host.currentThread();
            host.setLastError(ERROR_SEM_TIMEOUT);
            pipe.waiters.push({ ctx, thread });
            kernel.block(thread, `pipe ${pipe.name}`, wait === NMPWAIT_WAIT_FOREVER
                ? undefined : { deadline: kernel.clock.virtualTime() + wait, result: 0 });
            return host.park();
        },
    });

    /** @param {boolean} wide */
    const handleState = wide=>({
        argBytes: 28,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [handle, state, instances, , , user, room])=>{
            const end = endOf(handle);
            if (!end)
            {
                return fail(ERROR_INVALID_HANDLE);
            }
            writeDwordIf(state, (end.readMessages ? PIPE_READMODE_MESSAGE : 0)
                | (end.nowait ? PIPE_NOWAIT : 0));
            writeDwordIf(instances, end.instance.pipe.instances.size);
            if ((user >>> 0) !== 0 && (room >>> 0) > 0)
            {
                // The user the client runs as, asked of the server end: the one user.
                const text = 'User';
                const bytes = wide ? new Uint8Array((text.length + 1) * 2)
                    : new Uint8Array(text.length + 1);
                [...text].forEach((ch, at)=>{
                    bytes[wide ? at * 2 : at] = ch.charCodeAt(0);
                });
                host.writeMemory(user >>> 0, bytes.subarray(0,
                    Math.min(bytes.length, (room >>> 0) * (wide ? 2 : 1))));
            }
            return 1;
        },
    });

    const functions = {
        /**
         * HANDLE CreateNamedPipeA(LPCSTR lpName, DWORD dwOpenMode, DWORD dwPipeMode,
         *   DWORD nMaxInstances, DWORD nOutBufferSize, DWORD nInBufferSize,
         *   DWORD nDefaultTimeOut, LPSECURITY_ATTRIBUTES lpSecurityAttributes), and W
         */
        CreateNamedPipeA: {
            argBytes: 32,
            /** @param {number[]} args */
            handler: ([name, ...rest])=>createPipe(nameAt(name, false), rest),
        },
        CreateNamedPipeW: {
            argBytes: 32,
            /** @param {number[]} args */
            handler: ([name, ...rest])=>createPipe(nameAt(name, true), rest),
        },

        /**
         * BOOL ConnectNamedPipe(HANDLE hNamedPipe, LPOVERLAPPED lpOverlapped)
         *
         * A client that came first is ERROR_PIPE_CONNECTED, which is a good
         * connection; one that came and went is ERROR_NO_DATA. Otherwise the
         * instance listens and the call waits, parked or overlapped.
         */
        ConnectNamedPipe: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, overlapped])=>{
                const end = endOf(handle);
                if (!end || end.side !== 'server')
                {
                    return fail(end ? ERROR_INVALID_PARAMETER : ERROR_INVALID_HANDLE);
                }
                const { instance } = end;
                if (instance.state === 'connected')
                {
                    return fail(ERROR_PIPE_CONNECTED);
                }
                if (instance.state === 'closing')
                {
                    return fail(ERROR_NO_DATA);
                }
                if (instance.state === 'disconnected')
                {
                    instance.state = 'listening';
                    listening(instance.pipe);
                }
                if (end.nowait)
                {
                    return fail(ERROR_PIPE_LISTENING);
                }
                /** @type {Op} */
                const op = { kind: 'connect', ctx, thread: host.currentThread(),
                    handle: handle >>> 0, overlapped: overlapped >>> 0, buffer: 0, length: 0,
                    out: 0, end };
                instance.connects.push(op);
                if (end.signal)
                {
                    kernel.resetEvent?.(end.signal);
                }
                if ((overlapped >>> 0) !== 0)
                {
                    writeDword(overlapped, STATUS.PENDING);
                    writeDword((overlapped >>> 0) + OVERLAPPED_INTERNAL_HIGH, 0);
                    return fail(ERROR_IO_PENDING);
                }
                kernel.block(op.thread, `pipe ${instance.pipe.name}`);
                return host.park();
            },
        },

        /**
         * BOOL DisconnectNamedPipe(HANDLE hNamedPipe)
         *
         * The server's: the client is cut off -- its handle stays, and every
         * call on it says the pipe is not connected -- what was unread either
         * way is dropped, and the instance may be connected again.
         */
        DisconnectNamedPipe: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                const end = endOf(handle);
                if (!end || end.side !== 'server')
                {
                    return fail(end ? ERROR_INVALID_PARAMETER : ERROR_INVALID_HANDLE);
                }
                const { instance } = end;
                if (instance.state === 'listening')
                {
                    return fail(ERROR_PIPE_LISTENING);
                }
                const client = instance.client;
                if (client)
                {
                    client.cut = true;
                    client.inbox = [];
                    abort(client, ()=>true);
                }
                end.inbox = [];
                abort(end, op=>op.kind === 'read');
                instance.client = null;
                instance.state = 'disconnected';
                return 1;
            },
        },

        /** BOOL WaitNamedPipeA(LPCSTR lpNamedPipeName, DWORD nTimeOut), and W */
        WaitNamedPipeA: waitNamedPipe(false),
        WaitNamedPipeW: waitNamedPipe(true),

        /**
         * BOOL TransactNamedPipe(HANDLE, LPVOID lpInBuffer, DWORD nInBufferSize,
         *   LPVOID lpOutBuffer, DWORD nOutBufferSize, LPDWORD lpBytesRead, LPOVERLAPPED)
         *
         * A message written, then the answer read, on a message pipe read as one.
         */
        TransactNamedPipe: {
            argBytes: 28,
            /** @param {number[]} args */
            handler: ([handle, input, inputSize, output, outputSize, count, overlapped])=>{
                const end = endOf(handle);
                if (!end)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                if (!end.instance.pipe.messages || !end.readMessages)
                {
                    return fail(ERROR_BAD_PIPE);
                }
                const wrote = startWrite(end, handle >>> 0, input, inputSize, 0, 0, false);
                if (wrote !== 1)
                {
                    return 0;
                }
                return startRead(end, handle >>> 0, output, outputSize, count >>> 0,
                    overlapped >>> 0, false);
            },
        },

        /**
         * BOOL GetNamedPipeInfo(HANDLE, LPDWORD lpFlags, LPDWORD lpOutBufferSize,
         *   LPDWORD lpInBufferSize, LPDWORD lpMaxInstances)
         */
        GetNamedPipeInfo: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([handle, flags, outSize, inSize, max])=>{
                const end = endOf(handle);
                if (!end)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                const { pipe } = end.instance;
                writeDwordIf(flags, (end.side === 'server' ? PIPE_SERVER_END : 0)
                    | (pipe.messages ? PIPE_TYPE_MESSAGE : 0));
                writeDwordIf(outSize, pipe.outSize);
                writeDwordIf(inSize, pipe.inSize);
                writeDwordIf(max, pipe.maxInstances);
                return 1;
            },
        },

        /**
         * BOOL GetNamedPipeHandleStateA(HANDLE, LPDWORD lpState, LPDWORD lpCurInstances,
         *   LPDWORD lpMaxCollectionCount, LPDWORD lpCollectDataTimeout,
         *   LPSTR lpUserName, DWORD nMaxUserNameSize), and W
         */
        GetNamedPipeHandleStateA: handleState(false),
        GetNamedPipeHandleStateW: handleState(true),

        /**
         * BOOL SetNamedPipeHandleState(HANDLE, LPDWORD lpMode,
         *   LPDWORD lpMaxCollectionCount, LPDWORD lpCollectDataTimeout)
         *
         * The read mode and the wait mode; message reading of a byte pipe is
         * refused. The collection values are a remote client's and taken.
         */
        SetNamedPipeHandleState: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([handle, modePointer])=>{
                const end = endOf(handle);
                if (!end)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                if ((modePointer >>> 0) === 0)
                {
                    return 1;
                }
                const mode = readDword(modePointer);
                if ((mode & ~PIPE_STATE_MASK) !== 0
                    || ((mode & PIPE_READMODE_MESSAGE) !== 0 && !end.instance.pipe.messages))
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                end.readMessages = (mode & PIPE_READMODE_MESSAGE) !== 0;
                end.nowait = (mode & PIPE_NOWAIT) !== 0;
                return 1;
            },
        },

        /** BOOL GetNamedPipeClientProcessId(HANDLE Pipe, PULONG ClientProcessId) */
        GetNamedPipeClientProcessId: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, out])=>{
                const end = endOf(handle);
                if (!end)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                writeDwordIf(out, end.instance.clientProcess);
                return 1;
            },
        },

        /** BOOL GetNamedPipeServerProcessId(HANDLE Pipe, PULONG ServerProcessId) */
        GetNamedPipeServerProcessId: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, out])=>{
                const end = endOf(handle);
                if (!end)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                writeDwordIf(out, /** @type {any} */ (end.instance.server).serverProcess ?? 0);
                return 1;
            },
        },

        /**
         * BOOL SetFileCompletionNotificationModes(HANDLE FileHandle, UCHAR Flags)
         *
         * FILE_SKIP_COMPLETION_PORT_ON_SUCCESS: an operation that finishes in
         * its own call posts no packet; FILE_SKIP_SET_EVENT_ON_HANDLE: nor sets
         * its event. Kept for every handle; the pipes read them.
         */
        SetFileCompletionNotificationModes: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, flags])=>{
                if ((flags >>> 0) & ~(FILE_SKIP_COMPLETION_PORT_ON_SUCCESS
                    | FILE_SKIP_SET_EVENT_ON_HANDLE))
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                if ((host.handles.typeOf?.(handle >>> 0) ?? null) === null)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                ctx.modes.set(handle >>> 0, (ctx.modes.get(handle >>> 0) ?? 0) | (flags >>> 0));
                return 1;
            },
        },
    };

    /** Numbers the unnamed pipes CreatePipe makes, the run's way Windows numbers them. */
    let anonymousCount = 0;

    return {
        functions,
        /**
         * What a wait on a pipe end's handle waits on: an event set while no
         * operation of the end is pending, as a file object is -- a program
         * that watches the handle itself learns its read or connect is done.
         * Null for a handle that is no end.
         *
         * @param {number} handle
         */
        waitable(handle){
            const end = endOf(handle);
            if (!end)
            {
                return null;
            }
            end.signal ??= kernel.createEvent({ manualReset: true,
                signalled: end.readers.length === 0
                    && !end.instance.connects.some(op=>op.end === end),
                name: `pipe ${end.instance.pipe.name}` });
            return end.signal;
        },
        read,
        write,
        open,
        cancel,
        closed,

        /**
         * CreatePipe's pair, made as Windows makes it: a one-instance inbound
         * byte pipe under a name nobody else knows (Win32Pipes.<process>.<n>),
         * its server end the read handle and a client end opened for writing
         * the write handle. So an anonymous pipe reads, writes, breaks, is
         * duplicated and inherited as a named one does. Null where this
         * process cannot reach the run's pipes (a worker of its own).
         *
         * @param {number} attributes  the SECURITY_ATTRIBUTES, for inheritance
         * @param {number} size
         * @returns {{ read: number, write: number } | null}
         */
        anonymous(attributes, size){
            if (host.remote)
            {
                return null;
            }
            anonymousCount++;
            const name = `\\\\.\\pipe\\Win32Pipes.${(host.processId ?? 0).toString(16)
                .padStart(8, '0')}.${anonymousCount.toString(16).padStart(8, '0')}`;
            const reader = createPipe(name, [PIPE_ACCESS_INBOUND, 0, 1, size, size, 0,
                attributes]);
            if ((reader >>> 0) === INVALID_HANDLE_VALUE)
            {
                return null;
            }
            const writer = open(name, GENERIC_WRITE, 0, attributes);
            return 'handle' in writer ? { read: reader, write: writer.handle } : null;
        },

        /**
         * PeekNamedPipe on an end, or null for a handle that is none: the bytes
         * waiting, what a read would see of them, and what is left of the
         * message at the front.
         *
         * @param {number[]} args
         */
        peek([handle, buffer, size, copiedOut, total, left]){
            const end = endOf(handle);
            if (!end)
            {
                return null;
            }
            const why = blocked(end, false);
            if (why !== null && end.inbox.length === 0)
            {
                return fail(toDosError(why));
            }
            const front = end.inbox[0];
            const visible = end.readMessages && front
                ? front.bytes.subarray(front.at) : null;
            const all = available(end);
            const copied = Math.min(visible ? visible.length : all, size >>> 0);
            if ((buffer >>> 0) !== 0 && copied > 0)
            {
                const bytes = new Uint8Array(copied);
                let at = 0;
                for (const message of end.inbox)
                {
                    const part = message.bytes.subarray(message.at,
                        message.at + Math.min(copied - at, message.bytes.length - message.at));
                    bytes.set(part, at);
                    at += part.length;
                    if (at === copied || end.readMessages)
                    {
                        break;
                    }
                }
                host.writeMemory(buffer >>> 0, bytes);
            }
            writeDwordIf(copiedOut, copied);
            writeDwordIf(total, all);
            writeDwordIf(left, end.instance.pipe.messages && front
                ? front.bytes.length - front.at - (visible ? copied : 0) : 0);
            return 1;
        },

        /**
         * This process's pipe handles a child it starts inherits: the
         * inheritable ones, or of those the ones the attribute list names.
         *
         * @param {number[] | null} only
         * @returns {{ handle: number, type: string, object: any }[]}
         */
        inherited(only){
            return [...inheritable].filter(([handle, on])=>on
                && (only === null || only.includes(handle)))
                .flatMap(([handle])=>{
                    const end = endOf(handle);
                    return end && !end.closed ? [{ handle, type: 'pipe', object: end }] : [];
                });
        },

        /**
         * A handle's inheritance as SetHandleInformation or DuplicateHandle
         * set it. A handle that is no pipe end is let be.
         *
         * @param {number} handle @param {boolean} on
         */
        setInheritable(handle, on){
            if (endOf(handle))
            {
                inheritable.set(handle >>> 0, on);
            }
        },

        /** Whether a handle is a pipe end. @param {number} handle */
        isPipe: (/** @type {number} */ handle)=>endOf(handle) !== null,

        /**
         * A pipe end handed to this process at its start (inherited) is one
         * more handle onto it, under the parent's number.
         *
         * @param {number} handle @param {any} end
         */
        adopted(handle, end){
            end.retain();
            inheritable.set(handle >>> 0, true);
        },
    };
}

/** @param {number} value */
const dwordBytes = value=>Uint8Array.of(value & 0xff, (value >>> 8) & 0xff,
    (value >>> 16) & 0xff, (value >>> 24) & 0xff);

/** @param {PipeHost} host @param {number} address */
const readFrom = (host, address)=>{
    const bytes = host.readMemory(address >>> 0, 4);
    return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
};
