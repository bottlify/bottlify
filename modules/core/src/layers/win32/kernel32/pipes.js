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
 * (SetFileCompletionNotificationModes).
 *
 * Each way through an instance holds what the pipe was made to buffer: the
 * server's output size for what the server writes, its input size for what
 * the client writes. A write is queued whole, where a peek sees it, and
 * finishes once everything queued up to its end fits that size - at once
 * when it does, else as the reader drains the queue, writes finishing in
 * the order they were made. A write of nothing finishes at once. A write on
 * a handle that does not wait (PIPE_NOWAIT) never waits: what a waiting
 * reader takes is written, and the rest only if it all fits. FlushFileBuffers
 * waits for the reader to have taken everything.
 */

import { STATUS, toDosError } from '../ntdll/status.js';
import { overlappedLayout, overlappedResult } from '../common/overlapped.js';
import { OBJ_INHERIT, readObjectAttributes } from './object-attributes.js';
import { readLargeInteger } from './due-time.js';
import { INTERACTIVE_SESSION } from './teb.js';
import { allows, mappedAccess } from './access.js';

const ERROR_SUCCESS = 0;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_ACCESS_DENIED = 5;
const ERROR_INVALID_HANDLE = 6;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_SEM_TIMEOUT = 121;
const ERROR_INVALID_NAME = 123;
const ERROR_INSUFFICIENT_BUFFER = 122;
/** A pipe whose client is on this machine has no client computer name. */
const ERROR_PIPE_LOCAL = 229;
const ERROR_CALL_NOT_IMPLEMENTED = 120;
const ERROR_BAD_PIPE = 230;
const ERROR_PIPE_BUSY = 231;
const ERROR_NO_DATA = 232;
const ERROR_PIPE_CONNECTED = 535;
const ERROR_IO_PENDING = 997;
const ERROR_NOACCESS = 998;

const INVALID_HANDLE_VALUE = 0xffffffff;
const ERROR_INVALID_FUNCTION = 1;
const ERROR_NOT_ENOUGH_MEMORY = 8;
/** CallNamedPipe's steps: the open, and the zeroed fixed block its read mode is passed in. */
const OPEN_EXISTING = 3;
const LPTR = 0x40;

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
/** What a pipe made with a buffer size of 0 holds that way (decisions.md A273). */
const DEFAULT_BUFFER = 4096;
/** What a pipe made with no timeout waits by default: fifty milliseconds. */
const DEFAULT_TIMEOUT = 50;

/** Access bits a client end is opened with. */
const GENERIC_READ = 0x80000000;
const GENERIC_WRITE = 0x40000000;
const FILE_READ_DATA = 0x1;
const FILE_WRITE_DATA = 0x2;
const FILE_READ_ATTRIBUTES = 0x80;
const FILE_WRITE_ATTRIBUTES = 0x100;
const SYNCHRONIZE = 0x00100000;
/** The open mode's security rights, WRITE_DAC, WRITE_OWNER and ACCESS_SYSTEM_SECURITY. */
const OPEN_MODE_RIGHTS = 0x010c0000;
/** NtCreateNamedPipeFile's ShareAccess: what a client may open the pipe for. */
const FILE_SHARE_READ = 0x1;
const FILE_SHARE_WRITE = 0x2;
/** NtCreateNamedPipeFile's dispositions and the option that makes an end synchronous. */
const FILE_OPEN = 1;
const FILE_CREATE = 2;
const FILE_OPEN_IF = 3;
/** FILE_SYNCHRONOUS_IO_ALERT | FILE_SYNCHRONOUS_IO_NONALERT. */
const FILE_SYNCHRONOUS_IO = 0x30;
/** The synchronous option whose waits a queued routine ends. */
const FILE_SYNCHRONOUS_IO_ALERT = 0x10;
/** IO_STATUS_BLOCK.Information of a create that made its object. */
const FILE_CREATED = 2;

/** SetFileCompletionNotificationModes' flags. */
const FILE_SKIP_COMPLETION_PORT_ON_SUCCESS = 0x1;
const FILE_SKIP_SET_EVENT_ON_HANDLE = 0x2;
/** The native call's third flag: a fast I/O's own event left alone (ntifs.h). */
const FILE_SKIP_SET_USER_EVENT_ON_FAST_IO = 0x4;

/** The pipe statuses an OVERLAPPED is finished with. */
const STATUS_PIPE_BROKEN = STATUS.PIPE_BROKEN;
const STATUS_CANCELLED = STATUS.CANCELLED;
const STATUS_PIPE_DISCONNECTED = STATUS.PIPE_DISCONNECTED;
const STATUS_PIPE_LISTENING = STATUS.PIPE_LISTENING;
/** A write to an end whose peer is gone: ERROR_NO_DATA. */
const STATUS_PIPE_CLOSING = STATUS.PIPE_CLOSING;
/** A listen whose client came first: a good connection. */
const STATUS_PIPE_CONNECTED = STATUS.PIPE_CONNECTED;

/** NtFsControlFile's peek, and the head of the FILE_PIPE_PEEK_BUFFER it fills. */
const FSCTL_PIPE_PEEK = 0x11400c;
/** NtFsControlFile's ConnectNamedPipe and DisconnectNamedPipe. */
const FSCTL_PIPE_LISTEN = 0x110008;
const FSCTL_PIPE_DISCONNECT = 0x110004;
const PEEK_HEAD = 16;
/** A pipe's state as FILE_PIPE_PEEK_BUFFER and FILE_PIPE_LOCAL_INFORMATION say it. */
const FILE_PIPE_DISCONNECTED_STATE = 1;
const FILE_PIPE_LISTENING_STATE = 2;
const FILE_PIPE_CONNECTED_STATE = 3;
const FILE_PIPE_CLOSING_STATE = 4;

/** The FILE_INFORMATION_CLASS values a pipe end answers itself. */
const FILE_STANDARD_INFORMATION = 5;
const FILE_NAME_INFORMATION = 9;
const FILE_PIPE_INFORMATION = 23;
const FILE_PIPE_LOCAL_INFORMATION = 24;

/** Where a pipe's names begin, in the namespace's own spelling. */
const PREFIXES = ['\\\\.\\pipe\\', '\\\\?\\pipe\\'];
/** The run's table keys pipes under this, which no event or mutex name begins with. */
const TABLE_PREFIX = 'pipe:';

/**
 * Where a read across a link is finished as NtReadFile's (`acrossOf`): its
 * bytes, and its status block. No memory is behind either; the op's writes
 * there are kept.
 */
const ACROSS_BUFFER = 1;
const ACROSS_STATUS = 2;

/** A name read whole, as Windows reads it: 256 characters is a pipe name's limit. */
const NAME_BYTES = 520;

/** What a server end's client is, by its handle (`functions[PIPE_CLIENT]`). */
export const PIPE_CLIENT = Symbol('pipeClient');

/**
 * Whether a name is a pipe's, as CreateFile is handed one.
 *
 * @param {string} name
 */
export const isPipeName = name=>PREFIXES.some(prefix=>
    name.toLowerCase().startsWith(prefix) && name.length > prefix.length);

/**
 * A pipe's name in the object namespace - `\??\pipe\` (or `\DosDevices\`,
 * `\GLOBAL??\`) or the device's own `\Device\NamedPipe\`, in any case - in
 * the Win32 spelling, `\\.\pipe\`; null for a name that is no pipe's, an
 * empty rest of it included.
 *
 * @param {string} name
 * @returns {string | null}
 */
export const pipeNameOf = name=>{
    const named = /^\\(?:\?\?|DosDevices|GLOBAL\?\?)\\pipe\\|^\\Device\\NamedPipe\\/i
        .exec(name);
    return named && name.length > named[0].length
        ? `\\\\.\\pipe\\${name.slice(named[0].length)}` : null;
};

/**
 * Which of the pipe device's own names a name is: `\Device\NamedPipe` (or
 * `\??\pipe`, its link) is the device itself, under which no name is a
 * pipe's; `\Device\NamedPipe\` (or `\??\pipe\`) is the device's root
 * directory, under which every name is one. Null for any other name.
 *
 * @param {string} name
 * @returns {'device' | 'root' | null}
 */
export const pipeDeviceOf = name=>{
    const named = /^\\(?:(?:\?\?|DosDevices|GLOBAL\?\?)\\pipe|Device\\NamedPipe)(\\?)$/i
        .exec(name);
    return named ? (named[1] === '' ? 'device' : 'root') : null;
};

/** The pipe device's controls past the ones an end answers (winioctl.h). */
const FSCTL_PIPE_ASSIGN_EVENT = 0x110000;
const FSCTL_PIPE_QUERY_EVENT = 0x110010;
const FSCTL_PIPE_TRANSCEIVE = 0x11c017;
const FSCTL_PIPE_WAIT = 0x110018;
const FSCTL_PIPE_IMPERSONATE = 0x11001c;
const FSCTL_PIPE_SET_CLIENT_PROCESS = 0x110020;
const FSCTL_PIPE_QUERY_CLIENT_PROCESS = 0x110024;
const FSCTL_PIPE_GET_CONNECTION_ATTRIBUTE = 0x110030;

/**
 * What the device answers a control meant for an end: none is an end's, so
 * the requests that need a connection find none, the ones only a server
 * makes are no function of it, and the event controls of LAN Manager are not
 * supported (Wine's ntdll pipe test, subtest_empty_name_pipe_operations).
 *
 * @type {Map<number, number>}
 */
const DEVICE_CONTROLS = new Map([
    [FSCTL_PIPE_ASSIGN_EVENT, STATUS.NOT_SUPPORTED],
    [FSCTL_PIPE_DISCONNECT, STATUS.PIPE_DISCONNECTED],
    [FSCTL_PIPE_LISTEN, STATUS.ILLEGAL_FUNCTION],
    [FSCTL_PIPE_QUERY_EVENT, STATUS.NOT_SUPPORTED],
    [FSCTL_PIPE_TRANSCEIVE, STATUS.PIPE_DISCONNECTED],
    [FSCTL_PIPE_IMPERSONATE, STATUS.ILLEGAL_FUNCTION],
    [FSCTL_PIPE_SET_CLIENT_PROCESS, STATUS.NOT_SUPPORTED],
    [FSCTL_PIPE_QUERY_CLIENT_PROCESS, STATUS.INVALID_PARAMETER],
    [FSCTL_PIPE_PEEK, STATUS.INVALID_PARAMETER],
    [FSCTL_PIPE_GET_CONNECTION_ATTRIBUTE, STATUS.INVALID_PARAMETER],
]);

/**
 * What a process gives the pipes to finish its operations with.
 *
 * @typedef {Object} PipeHost
 * @property {number} [pointerSize]  8 in a 64-bit process, whose OVERLAPPED is
 *     laid out wider (`overlappedLayout`); absent, 4.
 * @property {any} kernel  block, wake, onTimeout, clock
 * @property {{ open: (type: string, object: any, access?: number | null) => number,
 *     resolve: (handle: number, type?: string) => any,
 *     typeOf?: (handle: number) => string | null,
 *     access?: (handle: number) => number | null }} handles
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(address: number, maxBytes: number) => string} readWideString
 * @property {(code: number) => void} setLastError
 * @property {(thread: any, code: number) => void} setLastErrorFor
 * @property {() => any} currentThread
 * @property {() => any} park
 * @property {(name: string, args: number[], thread: any) => Promise<number>} [call]
 *     a kernel32 export made on `thread`, its answer awaited: what CallNamedPipe is made of
 * @property {Map<string, any> | null} [table]  the run's named objects; absent, this
 *           process's own
 * @property {boolean} [remote]  a process in a worker of its own: no pipes
 * @property {number} [processId]
 * @property {(file: number, transferred: number, overlapped: number, status?: number,
 *     skip?: { port?: boolean, event?: boolean }) => boolean} [completed]
 *           Finishes an OVERLAPPED: its status, its count, its event, the port.
 * @property {(event: number) => void} [setEvent]
 * @property {(event: number) => void} [resetEvent]  an OVERLAPPED's event, as its
 *     operation begins
 * @property {(file: number, transferred: number, status: number, value: number) => boolean}
 *     [posted]  a native call's packet to the handle's port, its ApcContext the value
 * @property {(thread: any, routine: number, args: number[]) => void} [queueApc]
 * @property {(api: string, detail: string) => void} [divergence]
 * @property {(alertable: boolean, wait: () => any, answer: () => number) => any} [alertably]
 *     a wait made alertable: routines queued to the thread run first and end it at
 *     once, one queued while it waits ends it; `answer` is then the call's answer
 * @property {PipesAcross | null} [across]  where the ends a process in a worker of
 *     its own was started with are served (`EndAcross`), by their numbers
 */

/**
 * The run's side of the ends a process across a link holds, asked by the
 * number the process has each by.
 *
 * @typedef {Object} PipesAcross
 * @property {(id: number, length: number) => AcrossAnswer | Promise<AcrossAnswer>} read
 * @property {(id: number, bytes: Uint8Array) => AcrossAnswer} write
 * @property {(id: number, size: number) => AcrossAnswer} peek
 * @property {(id: number) => number} cancel
 * @property {(id: number) => void} close
 */

/**
 * A pipe end this process holds and another thread serves: its number there,
 * what it can do, and the handles onto it here.
 *
 * @typedef {Object} StandIn
 * @property {true} standIn
 * @property {number} id
 * @property {'server' | 'client'} side
 * @property {boolean} canRead
 * @property {boolean} canWrite
 * @property {boolean} messages
 * @property {number} refs
 * @property {() => void} retain
 */

/**
 * The stand-in of an end served across a link, as `EndAcross.describe`
 * described it; no handle holds it until one is adopted onto it.
 *
 * @param {number} id
 * @param {{ side: 'server' | 'client', canRead: boolean, canWrite: boolean,
 *     messages: boolean }} described
 * @returns {StandIn}
 */
export function pipeStandIn(id, described){
    /** @type {StandIn} */
    const standIn = { standIn: true, id, side: described.side, canRead: described.canRead,
        canWrite: described.canWrite, messages: described.messages, refs: 0,
        retain(){
            standIn.refs++;
        } };
    return standIn;
}

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
 * @property {boolean} [heard]  the server has read what this connection's client
 *     wrote: the client's identity is known, and may be impersonated
 */

/**
 * @typedef {Object} End
 * @property {Instance} instance
 * @property {'server' | 'client'} side
 * @property {Entry[]} inbox  what the other end wrote, unread: a write still
 *     waiting for room is here too, its op beside its bytes
 * @property {number} waiting  the entries of `inbox` whose write still waits
 * @property {Op[]} drains  FlushFileBuffers' waits on the other end's writes: they
 *     finish when `inbox` is empty
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
 * @property {() => EndAcross} across  the end served to a process in a worker of its own
 */

/**
 * A write as the reading end holds it: its bytes, how many were read, and
 * while the write has not finished, its op.
 *
 * @typedef {Object} Entry
 * @property {Uint8Array} bytes
 * @property {number} at
 * @property {Op} [op]
 */

/**
 * What a call on an end across a link answers: its status, and the bytes a
 * read or a peek got (a part of a message is STATUS_BUFFER_OVERFLOW, with
 * its bytes).
 *
 * @typedef {Object} AcrossAnswer
 * @property {number} status
 * @property {Uint8Array} [bytes]
 * @property {number} [count]  what a write wrote
 * @property {number} [total]  a peek's bytes waiting
 * @property {number} [left]  a peek's rest of the message at the front
 */

/**
 * An end held by a process in a worker of its own, served where the end is:
 * that process holds a stand-in under the same number (`standIn`) and asks
 * here for each read, write and peek. A read that must wait is queued among
 * the end's readers like any process's, and its answer is the promise.
 *
 * @typedef {Object} EndAcross
 * @property {(length: number) => AcrossAnswer | Promise<AcrossAnswer>} read
 * @property {(bytes: Uint8Array) => AcrossAnswer} write
 * @property {(size: number) => AcrossAnswer} peek
 * @property {() => { side: 'server' | 'client', canRead: boolean, canWrite: boolean,
 *     messages: boolean, readMessages: boolean }} describe
 * @property {() => number} cancel  ends its waiting reads, cancelled: how many
 * @property {() => void} release  its handle closed: cancels, then lets the end go
 */

/**
 * An operation waiting: a read, a write that has no room yet, a connect or
 * a flush, with the process it belongs to.
 *
 * @typedef {Object} Op
 * @property {'read' | 'write' | 'connect' | 'flush'} kind
 * @property {Context} ctx
 * @property {any} thread
 * @property {number} handle
 * @property {End} [end]  the end it is on, whose signal it holds down while pending
 * @property {number} overlapped  0 for a synchronous call, parked
 * @property {number} buffer
 * @property {number} length
 * @property {number} out  the count's address
 * @property {boolean} [native]  NtReadFile's: `out` is the IO_STATUS_BLOCK
 * @property {NativeAsync} [io]  a synchronous native call's event, APC and context
 * @property {NativeAsync} [async]  NtReadFile's on an end opened for overlapped I/O:
 *     answered STATUS_PENDING, it finishes through its block, event, APC and port
 * @property {number} [statusAt]  the OVERLAPPED a call on a handle opened
 *     without FILE_FLAG_OVERLAPPED gave, which waits and is told its status there
 * @property {number} [routine]  ReadFileEx's completion routine: queued to the
 *     thread that asked, with no event set and no packet posted
 */

/**
 * What NtReadFile is handed beside its IO_STATUS_BLOCK, for a call that does
 * not wait.
 *
 * @typedef {Object} NativeAsync
 * @property {number} event  0 for none
 * @property {number} apc  the APC routine, 0 for none
 * @property {number} context  the ApcContext: the APC's argument, the port's value
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
    const layout = overlappedLayout(host.pointerSize);
    const { kernel } = host;
    /** @type {Map<string, any>} */
    const table = host.table ?? new Map();
    /** @type {Context} */
    const ctx = { host, modes: new Map() };
    /**
     * The context of a wait a host call makes on its thread's behalf while
     * that thread is already waiting on the call (CallNamedPipe's): what would
     * wake the thread answers `tell` instead, since a thread waiting on a
     * host call is no thread a pipe may park or wake.
     *
     * @param {(result: number) => void} tell
     * @returns {Context}
     */
    const settling = tell=>({ modes: ctx.modes, host: Object.create(host, {
        kernel: { value: Object.create(kernel, {
            wake: { value: (/** @type {any} */ thread, /** @type {number} */ result)=>{
                void thread;
                tell(result >>> 0);
            } },
        }) },
    }) });
    /** What startRead answers a read made with `tell` that waits. */
    const WAITING = Symbol('waiting');
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
    /**
     * An OVERLAPPED's event is reset as its operation begins, as the I/O
     * manager resets the event any I/O call is given: a program that reuses
     * one manual-reset event for a connect, a read and a write waits on it
     * after each, and a wait that found it still set by the one before went
     * on before its own had finished.
     *
     * @param {number} overlapped
     */
    const begin = overlapped=>{
        if ((overlapped >>> 0) === 0)
        {
            return;
        }
        // The low bit asks that no packet go to a port; the handle is the rest.
        const event = (readDword((overlapped >>> 0) + layout.event) & ~1) >>> 0;
        if (event !== 0)
        {
            host.resetEvent?.(event);
        }
    };
    /** @param {number} handle @returns {End | null} */
    const endOf = handle=>{
        if ((host.handles.typeOf?.(handle >>> 0) ?? 'pipe') !== 'pipe')
        {
            return null;
        }
        try
        {
            const object = host.handles.resolve(handle >>> 0, 'pipe');
            return object?.standIn || object?.device ? null : object;
        }
        catch {
            return null;
        }
    };
    /**
     * The pipe device a handle opens, 'device' or 'root' (`pipeDeviceOf`);
     * null for any other handle.
     *
     * @param {number} handle
     * @returns {'device' | 'root' | null}
     */
    const deviceOf = handle=>{
        if ((host.handles.typeOf?.(handle >>> 0) ?? 'pipe') !== 'pipe')
        {
            return null;
        }
        try
        {
            return host.handles.resolve(handle >>> 0, 'pipe')?.device ?? null;
        }
        catch {
            return null;
        }
    };
    /** @param {number} handle @returns {StandIn | null} */
    const standInOf = handle=>{
        if (!host.across || (host.handles.typeOf?.(handle >>> 0) ?? 'pipe') !== 'pipe')
        {
            return null;
        }
        try
        {
            const object = host.handles.resolve(handle >>> 0, 'pipe');
            return object?.standIn ? object : null;
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
            instance, side, inbox: [], waiting: 0, drains: [], readers: [],
            readMessages: false, nowait: false,
            canRead, canWrite, closed: false, cut: false, refs: 1,
            retain(){
                end.refs++;
            },
            across: ()=>acrossOf(end),
        };
        return end;
    };

    /** The other end of an end, while there is one. @param {End} end */
    const peerOf = end=>(end.side === 'server' ? end.instance.client : end.instance.server);

    /** Bytes waiting at an end. @param {End} end */
    const available = end=>end.inbox.reduce((total, message)=>
        total + message.bytes.length - message.at, 0);

    /**
     * What a peek at an end sees: the bytes a read would see first - on a
     * message pipe the message at the front, whatever the end reads in, on a
     * byte pipe all of them - up to `size` of them, every byte waiting, the
     * length of the message at the front (0 on a byte pipe) and how many
     * messages wait. A peek's "left in this message" is that length less what
     * it copied, as Windows' PeekNamedPipe computes it - on a byte pipe, the
     * copy's count below zero.
     *
     * @param {End} end @param {number} size
     */
    const peekAt = (end, size)=>{
        const { messages } = end.instance.pipe;
        const front = end.inbox[0];
        const length = messages && front ? front.bytes.length - front.at : 0;
        const total = available(end);
        const copied = Math.min(messages ? length : total, size >>> 0);
        const bytes = new Uint8Array(copied);
        let at = 0;
        for (const message of end.inbox)
        {
            if (at === copied)
            {
                break;
            }
            const part = message.bytes.subarray(message.at,
                message.at + Math.min(copied - at, message.bytes.length - message.at));
            bytes.set(part, at);
            at += part.length;
        }
        return { bytes, total, length, count: messages ? end.inbox.length : 0 };
    };

    /**
     * What the queue into an end holds before a write waits: the server's
     * input size for what its client writes, its output size for what it
     * writes itself, as the pipe was made; a size of 0 is the default, 4096,
     * as CreatePipe's is (decisions.md A273).
     *
     * @param {End} end
     */
    const quotaOf = end=>(end.side === 'server' ? end.instance.pipe.inSize
        : end.instance.pipe.outSize) || DEFAULT_BUFFER;

    /**
     * A write the reader has taken the whole of has finished, if it had not.
     *
     * @param {End} end @param {Entry} entry
     */
    const drained = (end, entry)=>{
        if (entry.op)
        {
            const { op } = entry;
            entry.op = undefined;
            end.waiting--;
            finish(op, STATUS.SUCCESS, op.length);
        }
    };

    /**
     * Finishes the writes into an end that now fit its queue, in the order
     * they were made, and the flushes once the queue is empty.
     *
     * @param {End} end
     */
    const settle = end=>{
        if (end.waiting > 0)
        {
            const quota = quotaOf(end);
            let total = 0;
            for (const entry of end.inbox)
            {
                total += entry.bytes.length - entry.at;
                if (total > quota)
                {
                    break;
                }
                drained(end, entry);
            }
        }
        if (end.inbox.length === 0 && end.drains.length > 0)
        {
            for (const op of end.drains.splice(0))
            {
                finish(op, STATUS.SUCCESS, 0);
            }
        }
    };

    /**
     * Empties the queue into an end: the writes still waiting in it and the
     * flushes waiting for it fail with the status - the reader gone, or the
     * pipe disconnected - or, for a status of null, are dropped unanswered.
     *
     * @param {End} end @param {number | null} status
     */
    const dropInbox = (end, status)=>{
        const ops = [...end.inbox.flatMap(entry=>(entry.op ? [entry.op] : [])),
            ...end.drains.splice(0)];
        end.inbox = [];
        end.waiting = 0;
        if (status !== null)
        {
            for (const op of ops)
            {
                finish(op, status, 0);
            }
        }
    };

    /**
     * Finishes a native call that did not wait: its IO_STATUS_BLOCK, its event,
     * its APC on the thread that asked, and a packet for the port the handle
     * is bound to - each as NtReadFile completes one on Windows.
     *
     * @param {PipeHost} owner @param {number} handle @param {number} block
     * @param {NativeAsync} io @param {any} thread @param {number} status @param {number} count
     * @param {boolean} [skipPort]  finished in its own call on a handle that skips the port
     */
    function finishNative(owner, handle, block, io, thread, status, count, skipPort = false){
        owner.writeMemory(block, dwordBytes(status));
        owner.writeMemory(block + 4, dwordBytes(count));
        if (io.event !== 0)
        {
            owner.setEvent?.(io.event);
        }
        if (io.apc !== 0)
        {
            owner.queueApc?.(thread, io.apc, [io.context, block, 0]);
        }
        if (!skipPort)
        {
            owner.posted?.(handle, count, status, io.context);
        }
    }

    /**
     * Finishes a ReadFileEx or WriteFileEx where its process asked it: the
     * OVERLAPPED says how it ended, and the completion routine is queued to
     * the thread that asked, to run at its next alertable wait. Its event is
     * the program's own and no port hears of it, as Windows documents.
     *
     * @param {PipeHost} owner @param {any} thread @param {number} overlapped
     * @param {number} routine @param {number} status @param {number} count
     */
    const completeRoutine = (owner, thread, overlapped, routine, status, count)=>{
        const theirs = overlappedLayout(owner.pointerSize);
        overlappedResult((at, value)=>owner.writeMemory(at, dwordBytes(value)), theirs,
            overlapped, status, count);
        owner.queueApc?.(thread, routine,
            [status === STATUS.SUCCESS ? ERROR_SUCCESS : toDosError(status), count, overlapped]);
    };

    /**
     * Whether an asynchronous operation was given an event of its own: a
     * native call's Event, an OVERLAPPED's hEvent. A synchronous one signals
     * the handle whatever it was given.
     *
     * @param {Op} op
     */
    const ownEvent = op=>{
        if (op.async)
        {
            return op.async.event !== 0;
        }
        const overlapped = op.overlapped;
        if (overlapped === 0)
        {
            return false;
        }
        const theirs = overlappedLayout(op.ctx.host.pointerSize);
        const word = op.ctx.host.readMemory((overlapped + theirs.event) >>> 0, 4);
        return ((word[0] | word[1] << 8 | word[2] << 16 | word[3] << 24) & ~1) !== 0;
    };

    /**
     * Finishes an operation where its process asked it, and wakes that process's
     * thread when it was parked.
     *
     * @param {Op} op @param {number} status @param {number} count
     */
    const finish = (op, status, count)=>{
        const owner = op.ctx.host;
        // The end's handle is signalled by an operation that had no event of
        // its own to signal, as a file object is when its request completes;
        // one with an event leaves the handle as the request's start left it.
        if (op.end?.signal && !ownEvent(op))
        {
            owner.kernel.setEvent?.(op.end.signal);
        }
        const error = toDosError(status);
        const succeeded = status === STATUS.SUCCESS;
        if (op.routine)
        {
            completeRoutine(owner, op.thread, op.overlapped, op.routine, status, count);
            return;
        }
        if (op.overlapped !== 0)
        {
            if (owner.completed)
            {
                owner.completed(op.handle, count, op.overlapped, status);
            }
            else
            {
                const theirs = overlappedLayout(owner.pointerSize);
                overlappedResult((at, value)=>owner.writeMemory(at, dwordBytes(value)), theirs,
                    op.overlapped, status, count);
                const event = readFrom(owner, op.overlapped + theirs.event);
                if (event !== 0)
                {
                    owner.setEvent?.(event);
                }
            }
            return;
        }
        if (op.async)
        {
            finishNative(owner, op.handle, op.out, op.async, op.thread, status, count);
            return;
        }
        if (op.native)
        {
            owner.writeMemory(op.out, dwordBytes(status));
            owner.writeMemory(op.out + 4, dwordBytes(count));
            // The thread is woken with the answer first: the APC queued
            // after must wait for its next alertable wait, not end this one.
            owner.kernel.wake(op.thread, status);
            // A synchronous native call that waited still signals its event
            // and queues its APC once it reached the pipe.
            if (op.io && status !== STATUS_CANCELLED && (status >>> 30) !== 3)
            {
                if (op.io.event !== 0)
                {
                    owner.setEvent?.(op.io.event);
                }
                if (op.io.apc !== 0)
                {
                    owner.queueApc?.(op.thread, op.io.apc, [op.io.context, op.out, 0]);
                }
            }
            return;
        }
        if (op.out !== 0)
        {
            owner.writeMemory(op.out, dwordBytes(count));
        }
        if (op.statusAt)
        {
            const theirs = overlappedLayout(owner.pointerSize);
            overlappedResult((at, value)=>owner.writeMemory(at, dwordBytes(value)), theirs,
                op.statusAt, status, count);
            const event = readFrom(owner, op.statusAt + theirs.event);
            if (event !== 0)
            {
                owner.setEvent?.(event);
            }
        }
        // A part of a message is read and still FALSE, ERROR_MORE_DATA; one
        // that went through leaves the last error as it was.
        if (!succeeded)
        {
            owner.setLastErrorFor(op.thread, error);
        }
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
        if (end.side === 'server')
        {
            end.instance.heard = true;
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
                settle(end);
                return { bytes, status: STATUS.BUFFER_OVERFLOW };
            }
            drained(end, /** @type {Entry} */ (end.inbox.shift()));
            settle(end);
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
                drained(end, /** @type {Entry} */ (end.inbox.shift()));
            }
        }
        // A byte read that took nothing still takes an empty message at the
        // front, and reads nothing; one whose buffer filled leaves the empty
        // message behind it for the next read (Wine's test_blocking_rw).
        if (taken === 0 && end.inbox.length > 0
            && end.inbox[0].bytes.length === end.inbox[0].at)
        {
            drained(end, /** @type {Entry} */ (end.inbox.shift()));
        }
        settle(end);
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

    /**
     * Ends what waits on an end, as cancelled - or, where the end itself is
     * closing, as the pipe broken, which is how a read still pending on the
     * handle being closed completes on Windows. A write that waits is taken
     * out of the reader's queue with what was not read of it, and the writes
     * behind it may then fit. A status of null drops them unanswered: their
     * process is gone.
     *
     * @param {End} end @param {(op: Op) => boolean} which
     * @param {number | null} [status]
     */
    const abort = (end, which, status = STATUS_CANCELLED)=>{
        let count = 0;
        for (const op of [...end.readers, ...end.side === 'server' ? end.instance.connects : []])
        {
            if (!which(op))
            {
                continue;
            }
            end.readers = end.readers.filter(one=>one !== op);
            end.instance.connects = end.instance.connects.filter(one=>one !== op);
            if (status !== null)
            {
                finish(op, status, 0);
            }
            count++;
        }
        const peer = peerOf(end);
        if (!peer)
        {
            return count;
        }
        const writes = peer.inbox.filter(entry=>entry.op?.end === end && which(entry.op));
        const flushes = peer.drains.filter(op=>op.end === end && which(op));
        if (writes.length === 0 && flushes.length === 0)
        {
            return count;
        }
        peer.inbox = peer.inbox.filter(entry=>!writes.includes(entry));
        peer.drains = peer.drains.filter(op=>!flushes.includes(op));
        peer.waiting -= writes.length;
        for (const entry of writes)
        {
            const op = /** @type {Op} */ (entry.op);
            entry.op = undefined;
            if (status !== null)
            {
                finish(op, status, entry.at);
            }
        }
        if (status !== null)
        {
            for (const op of flushes)
            {
                finish(op, status, 0);
            }
        }
        settle(peer);
        return count + writes.length + flushes.length;
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
        abort(end, ()=>true, STATUS_PIPE_BROKEN);
        // Nobody reads what was written to it: a write still waiting for room
        // finds the pipe broken.
        dropInbox(end, STATUS_PIPE_BROKEN);
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
     * A server end listens for its client, as ConnectNamedPipe and
     * FSCTL_PIPE_LISTEN ask: a client already there is STATUS_PIPE_CONNECTED
     * (a good connection), one that came and went STATUS_PIPE_CLOSING, an end
     * that does not wait STATUS_PIPE_LISTENING; a disconnected instance
     * listens again. Otherwise the connect waits: pending through its
     * OVERLAPPED or its native block, or parked - the answer then the park's.
     *
     * @param {End} end @param {number} handle
     * @param {{ overlapped?: number, block?: number, io?: NativeAsync }} how
     * @returns {number | any}  a status, or the park
     */
    const listen = (end, handle, { overlapped = 0, block = 0, io })=>{
        const { instance } = end;
        if (instance.state === 'connected')
        {
            return STATUS_PIPE_CONNECTED;
        }
        if (instance.state === 'closing')
        {
            return STATUS_PIPE_CLOSING;
        }
        if (instance.state === 'disconnected')
        {
            instance.state = 'listening';
            listening(instance.pipe);
        }
        if (end.nowait)
        {
            return STATUS_PIPE_LISTENING;
        }
        const native = block !== 0;
        const async = native && io !== undefined && /** @type {any} */ (end).overlapped === true
            ? io : undefined;
        /** @type {Op} */
        const op = { kind: 'connect', ctx, thread: host.currentThread(), handle,
            overlapped, buffer: 0, length: 0, out: block, end,
            ...native ? { native } : {}, ...async ? { async } : {},
            ...native && io && !async ? { io } : {} };
        instance.connects.push(op);
        if (end.signal)
        {
            kernel.resetEvent?.(end.signal);
        }
        if (overlapped !== 0 || async)
        {
            return STATUS.PENDING;
        }
        kernel.block(op.thread, `pipe ${instance.pipe.name}`);
        return host.park();
    };

    /**
     * A synchronous native wait on an end opened FILE_SYNCHRONOUS_IO_ALERT,
     * made alertable: a routine queued to the thread, before or while it
     * waits, runs, and the request it waited for is cancelled
     * (STATUS_CANCELLED) without touching its status block. Any other wait,
     * or with nothing to make it alertable, is made as it is.
     *
     * @param {End} end @param {() => any} wait  the wait, which may park
     * @param {(op: Op) => boolean} mine  the op the wait queued
     */
    const alertableWait = (end, wait, mine)=>{
        if (!(/** @type {any} */ (end).alerts) || !host.alertably)
        {
            return wait();
        }
        return host.alertably(true, wait, ()=>{
            for (const one of [end, peerOf(end)])
            {
                if (one)
                {
                    one.readers = one.readers.filter(op=>!mine(op));
                }
            }
            end.instance.connects = end.instance.connects.filter(op=>!mine(op));
            return STATUS_CANCELLED;
        });
    };

    /**
     * A server end cuts its client off, as DisconnectNamedPipe and
     * FSCTL_PIPE_DISCONNECT ask: the client's handle stays and every call on
     * it says the pipe is not connected, what was unread either way is
     * dropped, and a write still waiting for room, or a flush, finds the
     * pipe not connected. The instance may then be connected again. An
     * instance still listening is STATUS_PIPE_LISTENING; one already cut off
     * has no client to cut off again.
     *
     * @param {End} end  a server end
     */
    const disconnect = end=>{
        const { instance } = end;
        if (instance.state === 'listening')
        {
            return STATUS_PIPE_LISTENING;
        }
        if (instance.state === 'disconnected')
        {
            return STATUS_PIPE_DISCONNECTED;
        }
        const client = instance.client;
        dropInbox(end, STATUS_PIPE_DISCONNECTED);
        if (client)
        {
            client.cut = true;
            dropInbox(client, STATUS_PIPE_DISCONNECTED);
            abort(client, ()=>true);
        }
        abort(end, op=>op.kind === 'read');
        instance.client = null;
        instance.state = 'disconnected';
        return STATUS.SUCCESS;
    };

    /**
     * An end served across a link (`EndAcross`). Its reads that wait are ops
     * whose process is the promise: what `serve` writes for them is kept, and
     * what wakes them answers it. The end's own event is the kernel's here.
     *
     * @param {End} end
     * @returns {EndAcross}
     */
    const acrossOf = end=>{
        /** @type {Set<Op>} */
        const waiting = new Set();
        return {
            read(length){
                if (!end.canRead)
                {
                    return { status: STATUS.ACCESS_DENIED };
                }
                const got = end.readers.length === 0 ? take(end, length >>> 0) : null;
                if (got)
                {
                    return { status: got.status, bytes: got.bytes };
                }
                const why = blocked(end, false);
                if (why !== null)
                {
                    return { status: why };
                }
                if (end.nowait)
                {
                    return { status: STATUS_PIPE_LISTENING };
                }
                return new Promise(resolve=>{
                    let bytes = new Uint8Array(0);
                    // Finished as NtReadFile's is: the bytes at `buffer`, the
                    // status and count at `out`, the status as the wake's.
                    /** @type {Op} */
                    const op = { kind: 'read', thread: null, handle: 0, overlapped: 0,
                        buffer: ACROSS_BUFFER, length: length >>> 0, out: ACROSS_STATUS,
                        native: true, end, ctx: { modes: new Map(), host: /** @type {any} */ ({
                            writeMemory: (/** @type {number} */ at, /** @type {Uint8Array} */ data)=>{
                                if (at === ACROSS_BUFFER)
                                {
                                    bytes = data.slice();
                                }
                            },
                            kernel: {
                                setEvent: (/** @type {any} */ event)=>kernel.setEvent?.(event),
                                wake: (/** @type {any} */ thread, /** @type {number} */ status)=>{
                                    void thread;
                                    waiting.delete(op);
                                    resolve({ status: status >>> 0, bytes });
                                },
                            },
                        }) } };
                    waiting.add(op);
                    end.readers.push(op);
                    if (end.signal)
                    {
                        kernel.resetEvent?.(end.signal);
                    }
                });
            },
            write(bytes){
                if (!end.canWrite)
                {
                    return { status: STATUS.ACCESS_DENIED };
                }
                const why = blocked(end, true);
                if (why !== null)
                {
                    return { status: why === STATUS_PIPE_BROKEN ? STATUS_PIPE_CLOSING : why };
                }
                const peer = /** @type {End} */ (peerOf(end));
                if (bytes.length > 0 || end.instance.pipe.messages)
                {
                    peer.inbox.push({ bytes: bytes.slice(), at: 0 });
                }
                serve(peer);
                if (available(peer) > quotaOf(peer) && !unboundedSaid)
                {
                    unboundedSaid = true;
                    host.divergence?.('WriteFile', 'a write from a process in a worker of its own'
                        + ' is not held back by the pipe\'s buffer: it finishes at once');
                }
                return { status: STATUS.SUCCESS, count: bytes.length };
            },
            peek(size){
                const why = blocked(end, false);
                if (why !== null && end.inbox.length === 0)
                {
                    return { status: why };
                }
                const seen = peekAt(end, size);
                return { status: STATUS.SUCCESS, bytes: seen.bytes, total: seen.total,
                    left: (seen.length - seen.bytes.length) >>> 0 };
            },
            describe: ()=>({ side: end.side, canRead: end.canRead, canWrite: end.canWrite,
                messages: end.instance.pipe.messages, readMessages: end.readMessages }),
            cancel: ()=>abort(end, op=>waiting.has(op)),
            release(){
                abort(end, op=>waiting.has(op));
                if (--end.refs <= 0 && !end.closed)
                {
                    closeEnd(end);
                }
            },
        };
    };

    /**
     * A server instance of a pipe, as the native create asks for one
     * (NtCreateNamedPipeFile; CreateNamedPipe is spelt over it): a first
     * instance makes the pipe, a later one is the first's kind of pipe. The
     * instance count is the first refusal - an instance asked for past it is
     * busy whether or not the call wanted the first instance - then a first
     * instance asked for of a pipe that is already there.
     *
     * @param {string} name  a `\\.\pipe\` name
     * @param {{ direction: number, messages: boolean, readMessages: boolean,
     *     nowait: boolean, overlapped: boolean, maxInstances: number, outSize: number,
     *     inSize: number, timeoutMs: number, disposition: 'create' | 'open' | 'either',
     *     inherit: boolean, access: number, alerts?: boolean, key?: string }} asked
     *     `access`: what the server handle was asked for, its rights (`access.js`,
     *     the pipe kind); `alerts`: FILE_SYNCHRONOUS_IO_ALERT, a queued routine ends
     *     its waits; `key`: the run's key of a pipe made with no name, empty `name`
     * @returns {{ handle: number } | { error: number }}  a Win32 error
     */
    const makeInstance = (name, asked)=>{
        if (host.remote)
        {
            host.divergence?.('CreateNamedPipe', 'a process in a worker of its own has no '
                + 'way to the run\'s pipes; refused as Windows 9x refuses it');
            return { error: ERROR_CALL_NOT_IMPLEMENTED };
        }
        const { direction, maxInstances: max } = asked;
        if (max === 0 || max > PIPE_UNLIMITED_INSTANCES || direction === 0
            || (asked.readMessages && !asked.messages))
        {
            return { error: ERROR_INVALID_PARAMETER };
        }
        const key = asked.key ?? keyOf(name);
        let pipe = pipeAt(key);
        if (pipe)
        {
            if (pipe.instances.size >= pipe.maxInstances)
            {
                return { error: ERROR_PIPE_BUSY };
            }
            // A second instance carries bytes the way the first does: its
            // direction must agree, while the type, the count and the sizes it
            // asks for are the pipe's already (Wine's test_CreateNamedPipe_
            // instances_must_match: a message instance of a byte pipe is made).
            if (asked.disposition === 'create'
                || direction !== (pipe.openMode & (PIPE_ACCESS_INBOUND | PIPE_ACCESS_OUTBOUND)))
            {
                return { error: ERROR_ACCESS_DENIED };
            }
        }
        else
        {
            if (asked.disposition === 'open')
            {
                return { error: ERROR_FILE_NOT_FOUND };
            }
            pipe = {
                name, key, maxInstances: max, openMode: direction,
                messages: asked.messages,
                timeout: asked.timeoutMs === 0 ? DEFAULT_TIMEOUT : asked.timeoutMs,
                outSize: asked.outSize, inSize: asked.inSize,
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
        instance.server.readMessages = asked.readMessages;
        instance.server.nowait = asked.nowait;
        /** @type {any} */ (instance.server).overlapped = asked.overlapped;
        /** @type {any} */ (instance.server).alerts = asked.alerts === true;
        /** @type {any} */ (instance.server).serverProcess = host.processId ?? 0;
        pipe.instances.add(instance);
        const handle = host.handles.open('pipe', instance.server,
            mappedAccess('pipe', asked.access));
        inheritable.set(handle, asked.inherit);
        listening(pipe);
        return { handle };
    };

    /**
     * CreateNamedPipe: a server instance, in the Win32 spelling.
     *
     * @param {string | null} name
     * @param {number[]} args  the rest of CreateNamedPipe's arguments
     */
    const createPipe = (name, args)=>{
        const [openMode, pipeMode, maxInstances, outSize, inSize, timeout, attributes] = args;
        if (!host.remote && (name === null || !isPipeName(name)))
        {
            return fail(ERROR_INVALID_NAME, INVALID_HANDLE_VALUE);
        }
        const mode = openMode >>> 0;
        const kind = pipeMode >>> 0;
        const made = makeInstance(name ?? '', {
            direction: mode & (PIPE_ACCESS_INBOUND | PIPE_ACCESS_OUTBOUND),
            messages: (kind & PIPE_TYPE_MESSAGE) !== 0,
            readMessages: (kind & PIPE_READMODE_MESSAGE) !== 0,
            nowait: (kind & PIPE_NOWAIT) !== 0,
            overlapped: (mode & FILE_FLAG_OVERLAPPED) !== 0,
            maxInstances: maxInstances >>> 0,
            outSize: outSize >>> 0, inSize: inSize >>> 0, timeoutMs: timeout >>> 0,
            disposition: (mode & FILE_FLAG_FIRST_PIPE_INSTANCE) !== 0 ? 'create' : 'either',
            inherit: inheritsBy(attributes),
            // The server end may do what its direction lets it, as CreateNamedPipe
            // asks the native create: reading inbound, writing (the attributes
            // with it) outbound, and the security rights the open mode names.
            access: ((mode & PIPE_ACCESS_INBOUND) !== 0 ? GENERIC_READ : 0)
                | ((mode & PIPE_ACCESS_OUTBOUND) !== 0 ? GENERIC_WRITE : 0) | SYNCHRONIZE
                | (mode & OPEN_MODE_RIGHTS),
        });
        if ('error' in made)
        {
            return fail(made.error, INVALID_HANDLE_VALUE);
        }
        host.setLastError(ERROR_SUCCESS);
        return made.handle;
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
        return connectClient(instance, access, flags, attributes);
    };

    /**
     * A client end of one instance that listens, the way it may carry bytes.
     *
     * @param {Instance} instance @param {number} access @param {number} flags
     * @param {number} attributes
     * @returns {{ handle: number } | { error: number }}
     */
    const connectClient = (instance, access, flags, attributes)=>{
        const { pipe } = instance;
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
        instance.heard = false;
        instance.clientProcess = host.processId ?? 0;
        const handle = host.handles.open('pipe', client, mappedAccess('pipe', asked));
        inheritable.set(handle, inheritsBy(attributes));
        connected(instance);
        return { handle };
    };

    /**
     * A query of a pipe's name - GetFileAttributes, as a program's stat of
     * it: Windows opens the name to answer, so it takes an instance that
     * listens and lets it go at once, which leaves that instance with its
     * client gone, not listening, until the server disconnects it. An error
     * when no instance listens or there is no such pipe, as CreateFile's.
     *
     * @param {string} name
     * @returns {number}  ERROR_SUCCESS or why not
     */
    const query = name=>{
        if (host.remote)
        {
            return ERROR_FILE_NOT_FOUND;
        }
        const pipe = pipeAt(keyOf(name));
        if (!pipe)
        {
            return ERROR_FILE_NOT_FOUND;
        }
        const instance = [...pipe.instances].find(one=>one.state === 'listening');
        if (!instance)
        {
            return ERROR_PIPE_BUSY;
        }
        const client = makeEnd(instance, 'client', false, false);
        instance.client = client;
        instance.state = 'connected';
        instance.heard = false;
        instance.clientProcess = host.processId ?? 0;
        connected(instance);
        closeEnd(client);
        return ERROR_SUCCESS;
    };

    /**
     * Starts a read on an end the call has already found.
     *
     * @param {End} end @param {number} handle @param {number} buffer @param {number} length
     * @param {number} out @param {number} overlapped @param {boolean} native
     * @param {NativeAsync} [io]  NtReadFile's event, APC and context
     * @param {number} [routine]  ReadFileEx's completion routine
     * @param {(result: number) => void} [tell]  for a read a host call makes
     *     on its waiting thread's behalf: told the answer of one that waits,
     *     which answers WAITING (`settling`)
     * @returns {number | typeof WAITING}
     */
    const startRead = (end, handle, buffer, length, out, overlapped, native, io, routine = 0,
        tell = undefined)=>
    {
        // A native read on an end opened for overlapped I/O does not wait.
        const async = native && io !== undefined && /** @type {any} */ (end).overlapped === true
            ? io : undefined;
        /** @param {number} status @param {number} count */
        const answerNow = (status, count)=>{
            if (async)
            {
                // The block, the event and the APC are the native call's to
                // answer (`ntTransfer`); a port still gets its packet.
                const skip = status === STATUS.SUCCESS
                    && ((ctx.modes.get(handle) ?? 0) & FILE_SKIP_COMPLETION_PORT_ON_SUCCESS) !== 0;
                if (!skip)
                {
                    host.posted?.(handle, count, status, async.context);
                }
            }
            if (routine !== 0)
            {
                // Done at once, the routine is still queued, never run here.
                completeRoutine(host, host.currentThread(), overlapped, routine, status, count);
                return 1;
            }
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
            // A transfer that succeeds leaves the last error as it was
            // (`startWrite`).
            return status === STATUS.SUCCESS ? 1 : fail(toDosError(status));
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
        // A handle opened without FILE_FLAG_OVERLAPPED takes an OVERLAPPED for
        // its offset and its status alone: the read waits, as a synchronous
        // one, and says its count where the call asked. A service that polls
        // that count waited for ever on a read answered "pending".
        const waits = overlapped !== 0 && !native && routine === 0
            && /** @type {any} */ (end).overlapped !== true;
        /** @type {Op} */
        const op = { kind: 'read', ctx: tell ? settling(tell) : ctx,
            thread: host.currentThread(), handle,
            overlapped: waits ? 0 : overlapped >>> 0, buffer: buffer >>> 0,
            length: length >>> 0, out: out >>> 0, native, end,
            ...waits ? { statusAt: overlapped >>> 0 } : {}, ...async ? { async } : {},
            ...native && io && !async ? { io } : {},
            ...routine !== 0 ? { routine } : {} };
        end.readers.push(op);
        if (end.signal)
        {
            kernel.resetEvent?.(end.signal);
        }
        if (async)
        {
            return STATUS.PENDING;
        }
        if (routine !== 0)
        {
            // ReadFileEx answers TRUE for a read that has begun.
            overlappedResult(writeDword, layout, overlapped, STATUS.PENDING, 0);
            return 1;
        }
        if (op.overlapped !== 0)
        {
            overlappedResult(writeDword, layout, overlapped, STATUS.PENDING, 0);
            return native ? STATUS.PENDING : fail(ERROR_IO_PENDING);
        }
        if (tell)
        {
            return WAITING;
        }
        kernel.block(op.thread, 'pipe read');
        return host.park();
    };

    /**
     * Writes from an end the call has already found. The write is queued
     * whole for the reader; it finishes now if everything queued up to its
     * end fits the queue (`quotaOf`), else it waits for the reader to drain
     * it - parked, pending through its OVERLAPPED or its native block, or
     * with its completion routine - as a read that finds nothing waits.
     *
     * @param {End} end @param {number} handle @param {number} buffer @param {number} length
     * @param {number} out @param {number} overlapped @param {boolean} native
     * @param {number} [routine]  WriteFileEx's completion routine
     * @param {{ io?: NativeAsync, whole?: boolean }} [extra]  NtWriteFile's event,
     *     APC and context; `whole`, a write that never waits (TransactNamedPipe's)
     */
    const startWrite = (end, handle, buffer, length, out, overlapped, native, routine = 0,
        { io, whole = false } = {})=>
    {
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
        const { messages } = end.instance.pipe;
        const quota = quotaOf(peer);
        // A zero-length write is a message of its own on a message pipe, and
        // nothing at all on a byte one.
        /** @type {Entry | null} */
        const entry = count > 0 || messages ? { bytes: count === 0 ? new Uint8Array(0)
            : host.readMemory(buffer >>> 0, count).slice(), at: 0 } : null;
        let written = count;
        let waits = false;
        if (entry && end.nowait && count > 0)
        {
            // A handle that does not wait writes what a waiting reader takes,
            // and the rest only if all of it fits; a message goes whole or not
            // at all.
            const reader = peer.inbox.length === 0 ? peer.readers[0] : undefined;
            const takes = reader ? Math.min(reader.length, count) : 0;
            if (messages && available(peer) + count - takes > quota)
            {
                written = 0;
            }
            else
            {
                peer.inbox.push(entry);
                serve(peer);
                if (peer.inbox.includes(entry) && available(peer) > quota)
                {
                    peer.inbox = peer.inbox.filter(one=>one !== entry);
                    written = entry.at;
                }
            }
        }
        else if (entry)
        {
            peer.inbox.push(entry);
            serve(peer);
            waits = !whole && count > 0 && peer.inbox.includes(entry)
                && available(peer) > quota;
        }
        if (waits)
        {
            const entryOf = /** @type {Entry} */ (entry);
            const async = native && io !== undefined && /** @type {any} */ (end).overlapped === true
                ? io : undefined;
            // A handle opened without FILE_FLAG_OVERLAPPED waits with the
            // OVERLAPPED it was given, as its read does (`startRead`).
            const parks = overlapped !== 0 && !native && routine === 0
                && /** @type {any} */ (end).overlapped !== true;
            /** @type {Op} */
            const op = { kind: 'write', ctx, thread: host.currentThread(), handle,
                overlapped: parks ? 0 : overlapped >>> 0, buffer: buffer >>> 0, length: count,
                out: out >>> 0, native, end,
                ...parks ? { statusAt: overlapped >>> 0 } : {}, ...async ? { async } : {},
                ...native && io && !async ? { io } : {},
                ...routine !== 0 ? { routine } : {} };
            entryOf.op = op;
            peer.waiting++;
            if (end.signal)
            {
                kernel.resetEvent?.(end.signal);
            }
            if (async)
            {
                return STATUS.PENDING;
            }
            if (routine !== 0 || op.overlapped !== 0)
            {
                overlappedResult(writeDword, layout, overlapped, STATUS.PENDING, 0);
                return routine !== 0 ? 1 : native ? STATUS.PENDING : fail(ERROR_IO_PENDING);
            }
            kernel.block(op.thread, 'pipe write');
            return host.park();
        }
        const modes = ctx.modes.get(handle) ?? 0;
        if (routine !== 0)
        {
            completeRoutine(host, host.currentThread(), overlapped, routine, STATUS.SUCCESS,
                written);
        }
        else if (overlapped !== 0 && host.completed)
        {
            host.completed(handle, written, overlapped, STATUS.SUCCESS, {
                port: (modes & FILE_SKIP_COMPLETION_PORT_ON_SUCCESS) !== 0,
                event: (modes & FILE_SKIP_SET_EVENT_ON_HANDLE) !== 0 });
        }
        if (native)
        {
            if (io !== undefined && /** @type {any} */ (end).overlapped === true
                && (modes & FILE_SKIP_COMPLETION_PORT_ON_SUCCESS) === 0)
            {
                // Done in its own call, an overlapped native write still posts
                // its packet, as its read does (`startRead`).
                host.posted?.(handle, written, STATUS.SUCCESS, io.context);
            }
            writeDword(out, STATUS.SUCCESS);
            writeDword(out + 4, written);
            return STATUS.SUCCESS;
        }
        // The last error is left as it was, as WriteFile and ReadFile leave
        // it when they succeed: a program reads it after one that is pending
        // and another that went through (ntdll's thread pool I/O tests).
        writeDwordIf(out, written);
        return 1;
    };

    /**
     * A read of an end served across a link: asked there, and answered here
     * when it comes -- the bytes into the buffer, the count and the status
     * where the call wants them, a waiting call's thread woken as the promise
     * it was answered with settles.
     *
     * @param {StandIn} standIn @param {number} handle @param {number} buffer
     * @param {number} length @param {number} out @param {number} overlapped
     * @param {boolean} native
     */
    const readAcross = (standIn, handle, buffer, length, out, overlapped, native)=>{
        const across = /** @type {PipesAcross} */ (host.across);
        if (!standIn.canRead)
        {
            return native ? STATUS.ACCESS_DENIED : fail(ERROR_ACCESS_DENIED);
        }
        if ((buffer >>> 0) === 0 && (length >>> 0) !== 0)
        {
            return native ? STATUS.ACCESS_VIOLATION : fail(ERROR_NOACCESS);
        }
        const thread = host.currentThread();
        /** @param {AcrossAnswer} got */
        const into = got=>{
            const count = got.bytes?.length ?? 0;
            if (count > 0)
            {
                host.writeMemory(buffer >>> 0, /** @type {Uint8Array} */ (got.bytes));
            }
            return count;
        };
        const asked = across.read(standIn.id, length >>> 0);
        if (overlapped !== 0)
        {
            overlappedResult(writeDword, layout, overlapped, STATUS.PENDING, 0);
            void Promise.resolve(asked).then(got=>{
                host.completed?.(handle, into(got), overlapped, got.status);
            });
            return native ? STATUS.PENDING : fail(ERROR_IO_PENDING);
        }
        /** @param {AcrossAnswer} got */
        const answered = got=>{
            const count = into(got);
            if (native)
            {
                writeDword(out, got.status);
                writeDword(out + 4, count);
                return got.status;
            }
            writeDwordIf(out, count);
            if (got.status === STATUS.SUCCESS)
            {
                return 1;
            }
            host.setLastErrorFor(thread, toDosError(got.status));
            return 0;
        };
        return typeof (/** @type {any} */ (asked)).then === 'function'
            ? /** @type {Promise<AcrossAnswer>} */ (asked).then(answered)
            : answered(/** @type {AcrossAnswer} */ (asked));
    };

    /**
     * A write to an end served across a link: it finishes there at once, as
     * every pipe write does.
     *
     * @param {StandIn} standIn @param {number} handle @param {number} buffer
     * @param {number} length @param {number} out @param {number} overlapped
     * @param {boolean} native
     */
    const writeAcross = (standIn, handle, buffer, length, out, overlapped, native)=>{
        if (!standIn.canWrite)
        {
            return native ? STATUS.ACCESS_DENIED : fail(ERROR_ACCESS_DENIED);
        }
        const count = length >>> 0;
        if ((buffer >>> 0) === 0 && count !== 0)
        {
            return native ? STATUS.ACCESS_VIOLATION : fail(ERROR_NOACCESS);
        }
        const got = /** @type {PipesAcross} */ (host.across).write(standIn.id,
            count === 0 ? new Uint8Array(0) : host.readMemory(buffer >>> 0, count).slice());
        if (got.status !== STATUS.SUCCESS)
        {
            return native ? got.status : fail(got.status === STATUS_PIPE_CLOSING ? ERROR_NO_DATA
                : toDosError(got.status));
        }
        if (overlapped !== 0 && host.completed)
        {
            const modes = ctx.modes.get(handle) ?? 0;
            host.completed(handle, count, overlapped, STATUS.SUCCESS, {
                port: (modes & FILE_SKIP_COMPLETION_PORT_ON_SUCCESS) !== 0,
                event: (modes & FILE_SKIP_SET_EVENT_ON_HANDLE) !== 0 });
        }
        if (native)
        {
            writeDword(out, STATUS.SUCCESS);
            writeDword(out + 4, count);
            return STATUS.SUCCESS;
        }
        writeDwordIf(out, count);
        return 1;
    };

    /**
     * ReadFile's and NtReadFile's way in: the answer, or null for a handle
     * that is no pipe end.
     *
     * @param {number} handle @param {number} buffer @param {number} length
     * @param {number} out @param {boolean} [native] @param {number} [overlapped]
     * @param {NativeAsync} [io]  NtReadFile's event, APC and context
     * @param {number} [routine]  ReadFileEx's completion routine
     */
    const read = (handle, buffer, length, out, native = false, overlapped = 0, io = undefined,
        routine = 0)=>
    {
        const end = endOf(handle);
        const standIn = end ? null : standInOf(handle);
        if (!end && !standIn)
        {
            // The pipe device carries no bytes of its own.
            return deviceOf(handle) === null ? null
                : native ? STATUS.INVALID_PARAMETER : fail(ERROR_INVALID_PARAMETER);
        }
        if (routine === 0)
        {
            begin(overlapped);
        }
        if (end)
        {
            // An answer or a park, never WAITING: that answers a read made with `tell`.
            return /** @type {number | ReturnType<PipeHost['park']>} */ (startRead(end,
                handle >>> 0, buffer, length, out >>> 0, overlapped >>> 0, native, io,
                routine >>> 0));
        }
        if (routine !== 0)
        {
            return exAcross('ReadFileEx');
        }
        return readAcross(/** @type {StandIn} */ (standIn), handle >>> 0, buffer, length,
            out >>> 0, overlapped >>> 0, native);
    };

    /**
     * ReadFileEx or WriteFileEx on an end another thread serves: refused, and said.
     *
     * @param {string} api
     */
    const exAcross = api=>{
        host.divergence?.(api, 'a completion routine on a pipe end its parent serves from '
            + 'another thread is not delivered; the call fails with ERROR_INVALID_FUNCTION');
        return fail(ERROR_INVALID_FUNCTION);
    };

    /**
     * WriteFile's and NtWriteFile's way in.
     *
     * @param {number} handle @param {number} buffer @param {number} length
     * @param {number} out @param {boolean} [native] @param {number} [overlapped]
     * @param {number} [routine]  WriteFileEx's completion routine
     * @param {NativeAsync} [io]  NtWriteFile's event, APC and context
     */
    const write = (handle, buffer, length, out, native = false, overlapped = 0, routine = 0,
        io = undefined)=>
    {
        const end = endOf(handle);
        const standIn = end ? null : standInOf(handle);
        if (!end && !standIn)
        {
            // The pipe device carries no bytes of its own.
            return deviceOf(handle) === null ? null
                : native ? STATUS.INVALID_PARAMETER : fail(ERROR_INVALID_PARAMETER);
        }
        if (routine === 0)
        {
            begin(overlapped);
        }
        if (end)
        {
            return startWrite(end, handle >>> 0, buffer, length, out >>> 0, overlapped >>> 0,
                native, routine >>> 0, { io });
        }
        if (routine !== 0)
        {
            return exAcross('WriteFileEx');
        }
        return writeAcross(/** @type {StandIn} */ (standIn), handle >>> 0, buffer, length,
            out >>> 0, overlapped >>> 0, native);
    };

    /**
     * CancelIo and CancelIoEx: what waits on a pipe end of this process --
     * all of it, the calling thread's alone, or the one OVERLAPPED -- ends
     * cancelled, through whichever handle onto the end it was asked: I/O
     * belongs to the file object, not to a handle's number. The count, or
     * null for a handle that is no pipe end.
     *
     * NtCancelIoFileEx names the one by its IO_STATUS_BLOCK (`block`): an
     * OVERLAPPED is one, a native call's is where it was asked.
     *
     * @param {number} handle
     * @param {{ overlapped?: number, thread?: any, block?: number }} which
     */
    const cancel = (handle, which)=>{
        const end = endOf(handle);
        if (!end)
        {
            // Every read of this process waits there on its one handle.
            const standIn = standInOf(handle);
            return standIn ? /** @type {PipesAcross} */ (host.across).cancel(standIn.id) : null;
        }
        return abort(end, op=>op.ctx === ctx
            && (which.overlapped === undefined || op.overlapped === which.overlapped)
            && (which.block === undefined || op.overlapped === which.block
                || op.statusAt === which.block || (op.native === true && op.out === which.block))
            && (which.thread === undefined || op.thread === which.thread));
    };

    /**
     * CancelSynchronousIo: the reads, writes and connects a thread of this
     * process waits in synchronously end cancelled - NtCancelSynchronousIoFile's,
     * the one whose IO_STATUS_BLOCK is `block`. How many there were.
     *
     * @param {any} thread @param {number} [block]
     */
    const cancelSynchronous = (thread, block = 0)=>{
        let count = 0;
        forEachEnd(end=>{
            count += abort(end, op=>op.ctx === ctx && op.thread === thread
                && op.overlapped === 0 && !op.async && !op.routine
                && (block === 0 || (op.native === true && op.out === block)
                    || op.statusAt === block));
        });
        return count;
    };

    /**
     * Every end of every pipe in the run's table.
     *
     * @param {(end: End) => void} visit
     */
    function forEachEnd(visit){
        for (const [key, entry] of table)
        {
            if (!key.startsWith(TABLE_PREFIX) || entry?.kind !== 'pipe')
            {
                continue;
            }
            for (const instance of [.../** @type {Pipe} */ (entry.object).instances])
            {
                for (const end of [instance.server, instance.client])
                {
                    if (end)
                    {
                        visit(end);
                    }
                }
            }
        }
    }

    /**
     * FlushFileBuffers on a pipe end: it waits until the other end has read
     * everything this end wrote, as Windows' does - at once when it has, or
     * with the pipe's state when the other end goes. Null for a handle that
     * is no pipe end.
     *
     * @param {number} handle
     */
    const flush = handle=>{
        const end = endOf(handle);
        if (!end)
        {
            return standInOf(handle) ? 1 : null;
        }
        // Everything written read, or nothing left to read it: done, whatever
        // became of the reader since.
        const peer = peerOf(end);
        if (!end.canWrite || !peer || peer.inbox.length === 0)
        {
            return 1;
        }
        const why = blocked(end, true);
        if (why !== null)
        {
            return fail(toDosError(why));
        }
        /** @type {Op} */
        const op = { kind: 'flush', ctx, thread: host.currentThread(), handle: handle >>> 0,
            overlapped: 0, buffer: 0, length: 0, out: 0, end };
        peer.drains.push(op);
        kernel.block(op.thread, 'pipe flush');
        return host.park();
    };

    /**
     * NtFlushBuffersFile on a pipe end: it waits, on an overlapped end too,
     * until the other end has read everything this one wrote; done at once
     * when there is nothing to wait for, a server end in any state included.
     * A client the server cut off is STATUS_PIPE_DISCONNECTED. The status
     * block is written either way it ends. A status, the park, or null for a
     * handle that is no pipe end.
     *
     * @param {number} handle @param {number} block
     * @returns {number | { parked: any } | null}
     */
    const flushNative = (handle, block)=>{
        const end = endOf(handle);
        if (!end)
        {
            return null;
        }
        if (end.side === 'client' && (end.cut || end.instance.state === 'disconnected'))
        {
            return STATUS_PIPE_DISCONNECTED;
        }
        const peer = peerOf(end);
        if (!end.canWrite || !peer || peer.closed || peer.inbox.length === 0
            || blocked(end, true) !== null)
        {
            host.writeMemory(block >>> 0, dwordBytes(STATUS.SUCCESS));
            host.writeMemory((block >>> 0) + 4, dwordBytes(0));
            return STATUS.SUCCESS;
        }
        /** @type {Op} */
        const op = { kind: 'flush', ctx, thread: host.currentThread(), handle: handle >>> 0,
            overlapped: 0, buffer: 0, length: 0, out: block >>> 0, end, native: true };
        peer.drains.push(op);
        // Pending, it holds the end's handle down as any request does.
        if (end.signal)
        {
            kernel.resetEvent?.(end.signal);
        }
        kernel.block(op.thread, 'pipe flush');
        return { parked: host.park() };
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
        if (object?.standIn)
        {
            if (--object.refs <= 0)
            {
                host.across?.close(object.id);
            }
            return;
        }
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

    /**
     * CallNamedPipe in either width: the pipe opened, waited for while it is
     * busy, set to read messages, one message written and the answer read,
     * and closed - each step the call a program would make, so a server sees
     * a client like any other. A step that fails ends it with that step's
     * error, the handle closed without losing it.
     *
     * @param {boolean} wide
     */
    const callNamedPipe = wide=>({
        argBytes: 28,
        /** @param {number[]} args */
        handler: async([name, input, inputSize, output, outputSize, count, timeout])=>{
            const call = host.call;
            if (!call)
            {
                host.divergence?.('CallNamedPipe', 'no way to make the calls it is made of');
                return fail(ERROR_INVALID_FUNCTION);
            }
            const thread = host.currentThread();
            /** @param {string} api @param {number[]} values */
            const step = async(api, values)=>(await call(api, values, thread)) >>> 0;
            const openPipe = ()=>step(wide ? 'CreateFileW' : 'CreateFileA', [name,
                (GENERIC_READ | GENERIC_WRITE) >>> 0, 0, 0, OPEN_EXISTING, 0, 0]);
            let handle = await openPipe();
            if (handle === INVALID_HANDLE_VALUE)
            {
                // The waits are made here, not by the exports: this thread
                // already waits on this call, and only a call's own thread
                // in flight may be parked.
                if (await step('GetLastError', []) !== ERROR_PIPE_BUSY
                    || await settled(tell=>waitForInstance(name, timeout, wide, tell)) === 0)
                {
                    return 0;
                }
                handle = await openPipe();
                if (handle === INVALID_HANDLE_VALUE)
                {
                    return 0;
                }
            }
            const mode = await step('LocalAlloc', [LPTR, 4]);
            if (mode !== 0)
            {
                writeDword(mode, PIPE_READMODE_MESSAGE);
            }
            const ok = mode !== 0
                && await step('SetNamedPipeHandleState', [handle, mode, 0, 0]) !== 0
                && await settled(tell=>transact(
                    [handle, input, inputSize, output, outputSize, count, 0], tell)) !== 0;
            const error = ok ? 0 : await step('GetLastError', []);
            if (mode !== 0)
            {
                await step('LocalFree', [mode]);
            }
            await step('CloseHandle', [handle]);
            if (!ok)
            {
                host.setLastErrorFor(thread, mode === 0 ? ERROR_NOT_ENOUGH_MEMORY : error);
                return 0;
            }
            return 1;
        },
    });

    /** @param {boolean} wide */
    /**
     * WaitNamedPipe's work: TRUE at once for a pipe with an instance
     * listening, else the thread waits for one until the time-out
     * (ERROR_SEM_TIMEOUT) - parked, or with `tell` told the answer, for a
     * host call waiting on its thread's behalf (`settling`).
     *
     * @param {number} pointer @param {number} timeout @param {boolean} wide
     * @param {(result: number) => void} [tell]
     * @returns {number | typeof WAITING}
     */
    const waitForInstance = (pointer, timeout, wide, tell)=>{
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
        if (!tell)
        {
            pipe.waiters.push({ ctx, thread });
            kernel.block(thread, `pipe ${pipe.name}`, wait === NMPWAIT_WAIT_FOREVER
                ? undefined : { deadline: kernel.clock.virtualTime() + wait, result: 0 });
            return host.park();
        }
        // The time-out is a timer of the guest's clock, which the waiter
        // that came first disarms.
        const timer = wait === NMPWAIT_WAIT_FOREVER ? null : kernel.createTimer({});
        const waiter = { ctx: settling(result=>{
            if (timer)
            {
                kernel.cancelTimer(timer);
            }
            tell(result);
        }), thread };
        pipe.waiters.push(waiter);
        if (timer)
        {
            kernel.armTimer(timer, kernel.clock.virtualTime() + wait, 0, ()=>{
                const at = pipe.waiters.indexOf(waiter);
                if (at !== -1)
                {
                    pipe.waiters.splice(at, 1);
                    tell(0);
                }
            });
        }
        return WAITING;
    };

    /**
     * TransactNamedPipe's work: a message written, then the answer read, on a
     * message pipe read as one. Its write never waits for room; an answer
     * already waiting unread refuses the transaction, ERROR_PIPE_BUSY, before
     * anything is written. A read that waits parks the thread, or with
     * `tell` tells it the answer (`settling`).
     *
     * @param {number[]} args @param {(result: number) => void} [tell]
     * @returns {number | typeof WAITING}
     */
    const transact = ([handle, input, inputSize, output, outputSize, count, overlapped],
        tell = undefined)=>
    {
        const end = endOf(handle);
        if (!end)
        {
            return fail(ERROR_INVALID_HANDLE);
        }
        if (!end.instance.pipe.messages || !end.readMessages)
        {
            return fail(ERROR_BAD_PIPE);
        }
        if (end.inbox.length > 0)
        {
            return fail(ERROR_PIPE_BUSY);
        }
        begin(overlapped);
        const wrote = startWrite(end, handle >>> 0, input, inputSize, 0, 0, false, 0,
            { whole: true });
        if (wrote !== 1)
        {
            return 0;
        }
        return startRead(end, handle >>> 0, output, outputSize, count >>> 0,
            overlapped >>> 0, false, undefined, 0, tell);
    };

    /**
     * A wait a host call makes on its thread's behalf, as a promise: what the
     * call answers at once, or what the wait is told.
     *
     * @param {(tell: (result: number) => void) => number | typeof WAITING} start
     * @returns {Promise<number>}
     */
    const settled = start=>new Promise(resolve=>{
        const now = start(resolve);
        if (now !== WAITING)
        {
            resolve(/** @type {number} */ (now) >>> 0);
        }
    });

    /** @param {boolean} wide */
    const waitNamedPipe = wide=>({
        argBytes: 8,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [pointer, timeout])=>
            waitForInstance(pointer, timeout, wide),
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

    /** A pipe end's session, either side's. */
    const sessionOf = ()=>({
        argBytes: 8,
        /** @param {number[]} args */
        handler: ([handle, out])=>{
            if (!endOf(handle))
            {
                return fail(ERROR_INVALID_HANDLE);
            }
            if ((out >>> 0) === 0)
            {
                return fail(ERROR_INVALID_PARAMETER);
            }
            writeDword(out, INTERACTIVE_SESSION);
            return 1;
        },
    });

    /** A pipe client's computer name, which a local client has none of. */
    const clientComputerName = ()=>({
        argBytes: 12,
        /** @param {number[]} args */
        handler: ([handle, , length])=>{
            if (!endOf(handle))
            {
                return fail(ERROR_INVALID_HANDLE);
            }
            return fail((length >>> 0) === 0 ? ERROR_INSUFFICIENT_BUFFER : ERROR_PIPE_LOCAL);
        },
    });

    const functions = {
        /**
         * Whose identity a server end can take on, for advapi32's
         * ImpersonateNamedPipeClient: 'none' for a handle that is no pipe's
         * server end, 'unknown' until the server has read what its client
         * wrote, 'client' after. Every process of the run is the one account,
         * so the client's identity is the process's own.
         *
         * @param {number} handle @returns {'none' | 'unknown' | 'client'}
         */
        [PIPE_CLIENT]: handle=>{
            const end = endOf(handle);
            if (!end || end.side !== 'server')
            {
                return 'none';
            }
            return end.instance.heard ? 'client' : 'unknown';
        },

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
                begin(overlapped);
                const answer = listen(end, handle >>> 0, { overlapped: overlapped >>> 0 });
                if (answer === STATUS.PENDING)
                {
                    overlappedResult(writeDword, layout, overlapped >>> 0, STATUS.PENDING, 0);
                    return fail(ERROR_IO_PENDING);
                }
                if (answer === STATUS_PIPE_CONNECTED)
                {
                    return fail(ERROR_PIPE_CONNECTED);
                }
                return typeof answer === 'number' ? fail(answer === STATUS_PIPE_CLOSING
                    ? ERROR_NO_DATA : toDosError(answer)) : answer;
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
                const status = disconnect(end);
                return status === STATUS.SUCCESS ? 1 : fail(toDosError(status));
            },
        },

        /**
         * BOOL CallNamedPipeA(LPCSTR lpNamedPipeName, LPVOID lpInBuffer, DWORD nInBufferSize,
         *   LPVOID lpOutBuffer, DWORD nOutBufferSize, LPDWORD lpBytesRead, DWORD nTimeOut), and W
         */
        CallNamedPipeA: callNamedPipe(false),
        CallNamedPipeW: callNamedPipe(true),

        /** BOOL WaitNamedPipeA(LPCSTR lpNamedPipeName, DWORD nTimeOut), and W */
        WaitNamedPipeA: waitNamedPipe(false),
        WaitNamedPipeW: waitNamedPipe(true),

        /**
         * BOOL TransactNamedPipe(HANDLE, LPVOID lpInBuffer, DWORD nInBufferSize,
         *   LPVOID lpOutBuffer, DWORD nOutBufferSize, LPDWORD lpBytesRead, LPOVERLAPPED)
         *
         * A message written, then the answer read, on a message pipe read as one.
         * Its write never waits for room; an answer already waiting unread
         * refuses the transaction, ERROR_PIPE_BUSY, before anything is written
         * (Windows 7 answers at once, as here; 8 and later through the
         * OVERLAPPED - Wine's test_transact takes either).
         */
        TransactNamedPipe: {
            argBytes: 28,
            /** @param {number[]} args */
            handler: (/** @type {number[]} */ args)=>transact(args),
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
         * BOOL GetNamedPipeClientSessionId(HANDLE Pipe, PULONG ClientSessionId), and the
         * server's: both ends are the interactive user's, in its one session.
         */
        GetNamedPipeClientSessionId: sessionOf(),
        GetNamedPipeServerSessionId: sessionOf(),

        /**
         * BOOL GetNamedPipeClientComputerNameA(HANDLE Pipe, LPSTR ClientComputerName,
         *   ULONG ClientComputerNameLength), and W
         *
         * The name of a client across the network. Every client here is on
         * this machine: no room is ERROR_INSUFFICIENT_BUFFER, any other call
         * ERROR_PIPE_LOCAL, and the buffer is left as it was.
         */
        GetNamedPipeClientComputerNameA: clientComputerName(),
        GetNamedPipeClientComputerNameW: clientComputerName(),

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
                const error = setCompletionModes(handle, flags,
                    FILE_SKIP_COMPLETION_PORT_ON_SUCCESS | FILE_SKIP_SET_EVENT_ON_HANDLE);
                return error === 0 ? 1 : fail(error);
            },
        },
    };

    /**
     * Adds to a handle's completion modes, which are never taken off again:
     * SetFileCompletionNotificationModes' and NtSetInformationFile's
     * FileIoCompletionNotificationInformation, each with the flags it knows.
     *
     * @param {number} handle @param {number} flags @param {number} known
     * @returns {number} 0, or the Win32 error the setting is refused with
     */
    function setCompletionModes(handle, flags, known){
        if (((flags >>> 0) & ~known) !== 0)
        {
            return ERROR_INVALID_PARAMETER;
        }
        if ((host.handles.typeOf?.(handle >>> 0) ?? null) === null)
        {
            return ERROR_INVALID_HANDLE;
        }
        ctx.modes.set(handle >>> 0, (ctx.modes.get(handle >>> 0) ?? 0) | (flags >>> 0));
        return 0;
    }

    /** What a pipe's native create was refused with, by the Win32 error the instance gave. */
    const NATIVE_REFUSALS = new Map([
        [ERROR_PIPE_BUSY, STATUS.INSTANCE_NOT_AVAILABLE],
        [ERROR_ACCESS_DENIED, STATUS.ACCESS_DENIED],
        [ERROR_INVALID_PARAMETER, STATUS.INVALID_PARAMETER],
        [ERROR_FILE_NOT_FOUND, STATUS.OBJECT_NAME_NOT_FOUND],
        [ERROR_CALL_NOT_IMPLEMENTED, STATUS.NOT_IMPLEMENTED],
    ]);
    /**
     * FSCTL_PIPE_TRANSCEIVE: TransactNamedPipe's native request - a message
     * written whole, then the answer read through the request's block, event
     * and APC, pending on an end opened for overlapped I/O. An end with no
     * peer to answer is refused before anything is written: a server that is
     * listening or cut off, or whose client is gone, is in no state for it, a
     * client cut off is disconnected; a pipe not read as messages has no
     * transaction, and an answer already waiting unread makes the pipe busy.
     *
     * @param {End} end @param {number} handle @param {number} input
     * @param {number} inLength @param {number} output @param {number} room
     * @param {number} block @param {NativeAsync | undefined} io
     * @returns {{ status: number, information: number } | { parked: any }}
     */
    const transceive = (end, handle, input, inLength, output, room, block, io)=>{
        /** @param {number} status */
        const refused = status=>({ status, information: 0 });
        const { instance } = end;
        if (end.side === 'client' && (end.cut || instance.state === 'disconnected'))
        {
            return refused(STATUS_PIPE_DISCONNECTED);
        }
        const peer = peerOf(end);
        if (instance.state !== 'connected' || !peer || peer.closed)
        {
            return refused(STATUS.INVALID_PIPE_STATE);
        }
        if (!instance.pipe.messages || !end.readMessages)
        {
            return refused(STATUS.INVALID_READ_MODE);
        }
        if (end.inbox.length > 0)
        {
            return refused(STATUS.PIPE_BUSY);
        }
        if (block === 0)
        {
            return refused(STATUS.ACCESS_VIOLATION);
        }
        // The write goes whole and at once; the block it fills is the read's
        // to answer after it.
        const wrote = startWrite(end, handle, input, inLength, block, 0, true, 0, { whole: true });
        if (wrote !== STATUS.SUCCESS)
        {
            return refused(/** @type {number} */ (wrote));
        }
        const answer = startRead(end, handle, output, room, block, 0, true, io);
        if (typeof answer !== 'number')
        {
            return { parked: answer };
        }
        return { status: answer,
            information: answer === STATUS.PENDING ? 0 : readDword(block + 4) };
    };

    /** Whether a wait through the device that would have waited was said to answer at once. */
    let deviceWaitSaid = false;
    /**
     * A control asked of the pipe device rather than an end. FSCTL_PIPE_WAIT
     * waits for an instance of a pipe named under the root - none by that
     * name is STATUS_OBJECT_NAME_NOT_FOUND, one that listens a success, a
     * time-out of zero with none listening STATUS_IO_TIMEOUT - and is no
     * function of the device itself, under which nothing is named; the
     * controls meant for an end answer as `DEVICE_CONTROLS` says.
     *
     * @param {'device' | 'root'} device @param {number} code
     * @param {number} input @param {number} inLength
     * @returns {{ status: number, information: number }}
     */
    const deviceControl = (device, code, input, inLength)=>{
        /** @param {number} status */
        const answer = status=>({ status, information: 0 });
        if (code !== FSCTL_PIPE_WAIT)
        {
            const status = DEVICE_CONTROLS.get(code);
            if (status === undefined)
            {
                host.divergence?.('NtFsControlFile', `pipe device control code 0x${code
                    .toString(16)} is not answered`);
                return answer(STATUS.INVALID_DEVICE_REQUEST);
            }
            return answer(status);
        }
        if (device === 'device')
        {
            return answer(STATUS.ILLEGAL_FUNCTION);
        }
        // FILE_PIPE_WAIT_FOR_BUFFER: Timeout, NameLength, TimeoutSpecified, Name.
        const NAME_AT = 14;
        if (inLength < NAME_AT)
        {
            return answer(STATUS.INVALID_PARAMETER);
        }
        const head = new DataView(host.readMemory(input, NAME_AT).slice().buffer);
        const nameBytes = head.getUint32(8, true);
        if (nameBytes % 2 !== 0 || NAME_AT + nameBytes > inLength)
        {
            return answer(STATUS.INVALID_PARAMETER);
        }
        const raw = host.readMemory(input + NAME_AT, nameBytes);
        let name = '';
        for (let at = 0; at + 1 < raw.length; at += 2)
        {
            name += String.fromCharCode(raw[at] | (raw[at + 1] << 8));
        }
        const pipe = pipeAt(keyOf(`\\\\.\\pipe\\${name}`));
        if (!pipe)
        {
            return answer(STATUS.OBJECT_NAME_NOT_FOUND);
        }
        if ([...pipe.instances].some(one=>one.state === 'listening'))
        {
            return answer(STATUS.SUCCESS);
        }
        const timed = head.getUint8(12) !== 0;
        if ((!timed || head.getBigInt64(0, true) !== 0n) && !deviceWaitSaid)
        {
            deviceWaitSaid = true;
            host.divergence?.('NtFsControlFile', 'FSCTL_PIPE_WAIT on the pipe device '
                + 'does not wait for an instance to listen: STATUS_IO_TIMEOUT at once');
        }
        return answer(STATUS.IO_TIMEOUT);
    };

    /** Whether a create relative to a directory handle was said to be refused. */
    let rootSaid = false;
    /** Numbers the pipes made with no name under the device's root. */
    let unnamedCount = 0;

    /**
     * The native calls over the same pipes, which ntdll publishes.
     */
    const natives = {
        /**
         * NTSTATUS NtCreateNamedPipeFile(PHANDLE FileHandle, ULONG DesiredAccess,
         *   POBJECT_ATTRIBUTES, PIO_STATUS_BLOCK, ULONG ShareAccess,
         *   ULONG CreateDisposition, ULONG CreateOptions, ULONG NamedPipeType,
         *   ULONG ReadMode, ULONG CompletionMode, ULONG MaximumInstances,
         *   ULONG InboundQuota, ULONG OutboundQuota, PLARGE_INTEGER DefaultTimeout)
         *
         * The server instance CreateNamedPipe makes, by the pipe's name in the
         * object namespace (`\??\pipe\` or the device's own `\Device\NamedPipe\`,
         * in any case, as the pipe file system compares names). Which way bytes
         * go is the sharing a client is let open it with: FILE_SHARE_READ makes
         * it outbound, FILE_SHARE_WRITE inbound, none of them is refused; the
         * access asked for is the server handle's rights. FILE_CREATE asks for
         * the first instance, FILE_OPEN for one of a pipe already there,
         * FILE_OPEN_IF for either; an instance without FILE_SYNCHRONOUS_IO_* is
         * overlapped. The handle is written as 0 when the call fails, as
         * Windows 7 and later write it.
         */
        NtCreateNamedPipeFile: {
            argBytes: 56,
            /** @param {number[]} args */
            handler: ([out, access, attributes, status, share, disposition, options, type,
                readMode, completion, maxInstances, inbound, outbound, timeout])=>{
                // The handle's place is written before anything is made: a call
                // that cannot answer makes no instance.
                writeDword(out, 0);
                const given = readObjectAttributes(host.readMemory, attributes,
                    host.pointerSize === 8 ? 8 : 4);
                if (given === null)
                {
                    return STATUS.OBJECT_NAME_INVALID;
                }
                const name = given.name ?? '';
                /** @type {string | null} */
                let pipeName;
                if (given.root !== 0)
                {
                    // Under the device's root a name is a pipe's, and no name
                    // at all is a pipe of its own that no name opens; the
                    // device itself makes nothing by a name under it.
                    const under = deviceOf(given.root);
                    if (under === null)
                    {
                        if (!rootSaid)
                        {
                            rootSaid = true;
                            host.divergence?.('NtCreateNamedPipeFile', 'a name relative to a '
                                + 'handle other than the pipe device\'s is refused');
                        }
                        return STATUS.OBJECT_PATH_NOT_FOUND;
                    }
                    if (under === 'device')
                    {
                        return STATUS.OBJECT_NAME_INVALID;
                    }
                    pipeName = name === '' ? null : `\\\\.\\pipe\\${name}`;
                }
                else
                {
                    pipeName = pipeNameOf(name);
                    if (pipeName === null)
                    {
                        return pipeDeviceOf(name) ? STATUS.OBJECT_NAME_INVALID
                            : STATUS.OBJECT_PATH_NOT_FOUND;
                    }
                }
                // Which way bytes go is what clients may share the pipe for:
                // reading makes it outbound, writing inbound. The server
                // handle's access is its rights only.
                const sharing = share >>> 0;
                if (sharing === 0 || (sharing & ~(FILE_SHARE_READ | FILE_SHARE_WRITE)) !== 0)
                {
                    return STATUS.INVALID_PARAMETER;
                }
                /** @type {Record<number, 'open' | 'create' | 'either'>} */
                const dispositions = { [FILE_OPEN]: 'open', [FILE_CREATE]: 'create',
                    [FILE_OPEN_IF]: 'either' };
                const asked = dispositions[disposition >>> 0];
                if (asked === undefined)
                {
                    return STATUS.INVALID_PARAMETER;
                }
                const count = maxInstances >>> 0;
                const due = (timeout >>> 0) === 0 ? 0n
                    : readLargeInteger(host.readMemory, timeout >>> 0);
                // A pipe made with no name is one of its own: nothing opens
                // it by a name, so asking to open one finds none.
                if (pipeName === null && asked === 'open')
                {
                    return STATUS.OBJECT_NAME_NOT_FOUND;
                }
                const made = makeInstance(pipeName ?? '', {
                    // Keyed outside the names' keys (`keyOf`), so no name reaches it.
                    ...pipeName === null ? { key: `unnamed:${++unnamedCount}` } : {},
                    direction: ((sharing & FILE_SHARE_WRITE) !== 0 ? PIPE_ACCESS_INBOUND : 0)
                        | ((sharing & FILE_SHARE_READ) !== 0 ? PIPE_ACCESS_OUTBOUND : 0),
                    messages: (type >>> 0) !== 0,
                    readMessages: (readMode >>> 0) !== 0,
                    nowait: (completion >>> 0) !== 0,
                    overlapped: ((options >>> 0) & FILE_SYNCHRONOUS_IO) === 0,
                    alerts: ((options >>> 0) & FILE_SYNCHRONOUS_IO_ALERT) !== 0,
                    // Unlimited is -1 here and PIPE_UNLIMITED_INSTANCES to
                    // Win32, the count GetNamedPipeInfo answers.
                    maxInstances: count === 0xffffffff ? PIPE_UNLIMITED_INSTANCES : count,
                    outSize: outbound >>> 0, inSize: inbound >>> 0,
                    timeoutMs: due < 0n ? Math.round(Number(-due) / 10000) : 0,
                    disposition: asked,
                    inherit: (given.attributes & OBJ_INHERIT) !== 0,
                    access: access >>> 0,
                });
                if ('error' in made)
                {
                    return NATIVE_REFUSALS.get(made.error) ?? STATUS.UNSUCCESSFUL;
                }
                writeDword(out, made.handle);
                if ((status >>> 0) !== 0)
                {
                    writeDword(status, STATUS.SUCCESS);
                    writeDword((status >>> 0) + 4, FILE_CREATED);
                }
                return STATUS.SUCCESS;
            },
        },
    };
    /** @type {any} */ (functions.CreateNamedPipeW).natives = natives;

    /** Numbers the unnamed pipes CreatePipe makes, the run's way Windows numbers them. */
    let anonymousCount = 0;
    /** Whether a wait on an end served across a link was said to fail. */
    let waitAcrossSaid = false;
    /** Whether a write across a link past the pipe's buffer was said to finish at once. */
    let unboundedSaid = false;

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
                if (standInOf(handle) && !waitAcrossSaid)
                {
                    waitAcrossSaid = true;
                    host.divergence?.('WaitForSingleObject', 'a wait on a pipe end its parent'
                        + ' serves from another thread fails with ERROR_INVALID_HANDLE');
                }
                return null;
            }
            end.signal ??= kernel.createEvent({ manualReset: true,
                signalled: end.readers.length === 0
                    && !end.instance.connects.some(op=>op.end === end)
                    && !peerOf(end)?.inbox.some(entry=>entry.op?.end === end),
                name: `pipe ${end.instance.pipe.name}` });
            return end.signal;
        },
        read,
        write,
        flush,
        flushNative,
        cancelSynchronous,
        /**
         * ReadFileEx's way in: the answer, or null for a handle that is no pipe end.
         *
         * @param {number} handle @param {number} buffer @param {number} length
         * @param {number} overlapped @param {number} routine
         */
        readEx: (handle, buffer, length, overlapped, routine)=>
            read(handle, buffer, length, 0, false, overlapped, undefined, routine),
        /**
         * WriteFileEx's.
         *
         * @param {number} handle @param {number} buffer @param {number} length
         * @param {number} overlapped @param {number} routine
         */
        writeEx: (handle, buffer, length, overlapped, routine)=>
            write(handle, buffer, length, 0, false, overlapped, routine),
        open,
        /**
         * NtCreateFile of a name the pipe device answers, null for one it
         * does not. The device and its root (`pipeDeviceOf`) open as handles
         * of their own, through which pipes are made and waited for. A pipe's
         * name - absolute, or relative to the root - opens a client end of an
         * instance that listens; an empty name relative to a server end opens
         * a client of that very instance, or finds it taken
         * (STATUS_PIPE_NOT_AVAILABLE), and any other name there is invalid.
         * Only an open of what is there is asked: another disposition is an
         * invalid parameter.
         *
         * @param {{ root: number, name: string }} given  the object attributes' name
         * @param {number} access @param {number} options  NtCreateFile's
         * @param {number} disposition
         * @returns {{ handle: number } | { error: number } | { status: number } | null}
         */
        nativeOpen(given, access, options, disposition){
            const flags = ((options >>> 0) & FILE_SYNCHRONOUS_IO) === 0 ? FILE_FLAG_OVERLAPPED : 0;
            /** @type {'device' | 'root' | null} */
            let device = null;
            /** @type {string | null} */
            let pipeName = null;
            /** @type {Instance | null} */
            let instance = null;
            if (given.root !== 0)
            {
                const under = deviceOf(given.root);
                const end = under ? null : endOf(given.root);
                if (under)
                {
                    if (given.name === '')
                    {
                        device = under;
                    }
                    else if (under === 'root')
                    {
                        pipeName = `\\\\.\\pipe\\${given.name}`;
                    }
                    else
                    {
                        return { status: STATUS.OBJECT_NAME_INVALID };
                    }
                }
                else if (end?.side === 'server')
                {
                    if (given.name !== '')
                    {
                        return { status: STATUS.OBJECT_NAME_INVALID };
                    }
                    instance = end.instance;
                }
                else
                {
                    return null;
                }
            }
            else
            {
                device = pipeDeviceOf(given.name);
                pipeName = device ? null : pipeNameOf(given.name);
                if (!device && pipeName === null)
                {
                    return null;
                }
            }
            if ((disposition >>> 0) !== FILE_OPEN && (disposition >>> 0) !== FILE_OPEN_IF)
            {
                return { status: STATUS.INVALID_PARAMETER };
            }
            if (device)
            {
                return { handle: host.handles.open('pipe', { device },
                    mappedAccess('pipe', access >>> 0)) };
            }
            if (instance)
            {
                return instance.state === 'listening'
                    ? connectClient(instance, access, flags, 0)
                    : { status: STATUS.PIPE_NOT_AVAILABLE };
            }
            return open(/** @type {string} */ (pipeName), access, flags);
        },
        query,
        cancel,
        closed,

        /**
         * Whether an operation that finished in its own call skips the port,
         * as SetFileCompletionNotificationModes set it for the handle -- kept
         * here for every handle, a socket's as well as a pipe end's.
         *
         * @param {number} handle
         */
        /**
         * The native call's side of the completion modes: set with every flag
         * ntifs.h names, read back as they stand.
         */
        completionModes: {
            set: (/** @type {number} */ handle, /** @type {number} */ flags)=>
                setCompletionModes(handle, flags, FILE_SKIP_COMPLETION_PORT_ON_SUCCESS
                    | FILE_SKIP_SET_EVENT_ON_HANDLE | FILE_SKIP_SET_USER_EVENT_ON_FAST_IO),
            of: (/** @type {number} */ handle)=>ctx.modes.get(handle >>> 0) ?? 0,
        },

        skipsPortOnSuccess: (/** @type {number} */ handle)=>
            ((ctx.modes.get(handle >>> 0) ?? 0) & FILE_SKIP_COMPLETION_PORT_ON_SUCCESS) !== 0,

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
            const standIn = end ? null : standInOf(handle);
            if (standIn)
            {
                const got = /** @type {PipesAcross} */ (host.across).peek(standIn.id, size >>> 0);
                if (got.status !== STATUS.SUCCESS)
                {
                    return fail(toDosError(got.status));
                }
                const bytes = got.bytes ?? new Uint8Array(0);
                if ((buffer >>> 0) !== 0 && bytes.length > 0)
                {
                    host.writeMemory(buffer >>> 0, bytes);
                }
                writeDwordIf(copiedOut, bytes.length);
                writeDwordIf(total, got.total ?? 0);
                writeDwordIf(left, got.left ?? 0);
                return 1;
            }
            if (!end)
            {
                return null;
            }
            // A server end cut from its client is in no state to be peeked at
            // (STATUS_INVALID_PIPE_STATE); the client end it cut is merely not
            // connected.
            if (end.side === 'server' && end.instance.state === 'disconnected')
            {
                return fail(ERROR_BAD_PIPE);
            }
            const why = blocked(end, false);
            if (why !== null && end.inbox.length === 0)
            {
                return fail(toDosError(why));
            }
            const seen = peekAt(end, (buffer >>> 0) === 0 ? 0 : size);
            if (seen.bytes.length > 0)
            {
                host.writeMemory(buffer >>> 0, seen.bytes);
            }
            writeDwordIf(copiedOut, seen.bytes.length);
            writeDwordIf(total, seen.total);
            writeDwordIf(left, (seen.length - seen.bytes.length) >>> 0);
            return 1;
        },

        /**
         * NtFsControlFile on a pipe end: FSCTL_PIPE_PEEK fills a
         * FILE_PIPE_PEEK_BUFFER - the pipe's state, the bytes waiting, the
         * messages waiting and the front message's length, then what a peek
         * sees of the data. A buffer too small for its head is
         * STATUS_BUFFER_TOO_SMALL; data cut short, STATUS_BUFFER_OVERFLOW.
         * Null for a handle that is no pipe end; another code answers
         * STATUS_INVALID_DEVICE_REQUEST, said.
         *
         * FSCTL_PIPE_LISTEN and FSCTL_PIPE_DISCONNECT are ConnectNamedPipe's and
         * DisconnectNamedPipe's, native: a listen that waits is STATUS_PENDING
         * on an overlapped end, finished through its block, event, APC and
         * port, and parks a synchronous one (`parked`, the call's answer).
         *
         * @param {number} handle @param {number} code @param {number} output
         * @param {number} room @param {number} [block]  the IO_STATUS_BLOCK
         * @param {NativeAsync} [io]  the event, APC and context the call was given
         * @param {number} [input]  the request's input buffer
         * @param {number} [inLength]  its length
         * @returns {{ status: number, information: number } | { parked: any } | null}
         */
        control(handle, code, output, room, block = 0, io = undefined, input = 0, inLength = 0){
            const device = deviceOf(handle);
            if (device)
            {
                return deviceControl(device, code >>> 0, input >>> 0, inLength >>> 0);
            }
            const end = endOf(handle);
            if (!end)
            {
                return null;
            }
            if ((code >>> 0) === FSCTL_PIPE_LISTEN || (code >>> 0) === FSCTL_PIPE_DISCONNECT)
            {
                if (end.side !== 'server')
                {
                    return { status: STATUS.ILLEGAL_FUNCTION, information: 0 };
                }
                if ((block >>> 0) === 0)
                {
                    return { status: STATUS.ACCESS_VIOLATION, information: 0 };
                }
                const thread = host.currentThread();
                const answer = (code >>> 0) === FSCTL_PIPE_DISCONNECT ? disconnect(end)
                    : alertableWait(end, ()=>listen(end, handle >>> 0, { block: block >>> 0, io }),
                        op=>op.thread === thread && op.kind === 'connect');
                return typeof answer === 'number' ? { status: answer, information: 0 }
                    : { parked: answer };
            }
            if ((code >>> 0) === FSCTL_PIPE_TRANSCEIVE)
            {
                return transceive(end, handle >>> 0, input >>> 0, inLength >>> 0, output >>> 0,
                    room >>> 0, block >>> 0, io);
            }
            if ((code >>> 0) !== FSCTL_PIPE_PEEK)
            {
                host.divergence?.('NtFsControlFile', `pipe control code 0x${(code >>> 0)
                    .toString(16)} is not answered`);
                return { status: STATUS.INVALID_DEVICE_REQUEST, information: 0 };
            }
            if ((room >>> 0) < PEEK_HEAD)
            {
                return { status: STATUS.BUFFER_TOO_SMALL, information: 0 };
            }
            // A server with no client - cut from one, or listening for one -
            // is in no state to be peeked at.
            if (end.side === 'server' && (end.instance.state === 'disconnected'
                || end.instance.state === 'listening'))
            {
                return { status: STATUS.INVALID_PIPE_STATE, information: 0 };
            }
            const why = blocked(end, false);
            if (why !== null && end.inbox.length === 0)
            {
                return { status: why, information: 0 };
            }
            const seen = peekAt(end, (room >>> 0) - PEEK_HEAD);
            // Its peer gone, what is left to read is the pipe closing.
            const peer = peerOf(end);
            const state = end.instance.state === 'connected' && peer && !peer.closed
                ? FILE_PIPE_CONNECTED_STATE : FILE_PIPE_CLOSING_STATE;
            writeDword(output, state);
            writeDword((output >>> 0) + 4, seen.total);
            writeDword((output >>> 0) + 8, seen.count);
            writeDword((output >>> 0) + 12, seen.length);
            if (seen.bytes.length > 0)
            {
                host.writeMemory((output >>> 0) + PEEK_HEAD, seen.bytes);
            }
            // Only a message cut short overflows: a byte pipe's peek takes what fits.
            const whole = end.instance.pipe.messages ? seen.length : seen.bytes.length;
            return { status: seen.bytes.length < whole ? STATUS.BUFFER_OVERFLOW : STATUS.SUCCESS,
                information: PEEK_HEAD + seen.bytes.length };
        },

        /**
         * NtQueryInformationFile's classes of a pipe end: FilePipeInformation
         * (the end's read and completion modes), FilePipeLocalInformation (the
         * pipe's kind, direction, instances and quotas, the bytes the end may
         * read and the room its writes have, its state, which end it is) and
         * FileNameInformation (the pipe's name on its device). The first two
         * need FILE_READ_ATTRIBUTES on the handle, and a client the server cut
         * off has neither (STATUS_PIPE_DISCONNECTED). Null for a handle that
         * is no pipe end, or a class a pipe end does not answer itself.
         *
         * @param {number} handle @param {number} kind
         * @returns {Uint8Array | { status: number } | null}
         */
        information(handle, kind){
            // The device has no name of a pipe to give.
            if (deviceOf(handle) && (kind >>> 0) === FILE_NAME_INFORMATION)
            {
                return { status: STATUS.INVALID_PARAMETER };
            }
            const end = endOf(handle);
            if (!end || ![FILE_STANDARD_INFORMATION, FILE_NAME_INFORMATION,
                FILE_PIPE_INFORMATION, FILE_PIPE_LOCAL_INFORMATION].includes(kind >>> 0))
            {
                return null;
            }
            const { instance } = end;
            const { pipe } = instance;
            if ((kind >>> 0) === FILE_STANDARD_INFORMATION)
            {
                // The pipe's quotas are its allocation, what the end may read
                // its end of file; a pipe is deleted as its last end closes, so
                // its deletion is always pending.
                if (end.side === 'client' && (end.cut || instance.state === 'disconnected'))
                {
                    return { status: STATUS_PIPE_DISCONNECTED };
                }
                const bytes = new Uint8Array(24);
                const view = new DataView(bytes.buffer);
                view.setBigUint64(0, BigInt(pipe.inSize + pipe.outSize), true);
                view.setBigUint64(8, BigInt(available(end)), true);
                view.setUint32(16, 1, true);
                bytes[20] = 1;
                return bytes;
            }
            if ((kind >>> 0) === FILE_NAME_INFORMATION)
            {
                if (end.side === 'client' && (end.cut || instance.state === 'disconnected'))
                {
                    return { status: STATUS_PIPE_DISCONNECTED };
                }
                const prefix = PREFIXES.find(one=>pipe.name.toLowerCase().startsWith(one))
                    ?? PREFIXES[0];
                const name = `\\${pipe.name.slice(prefix.length)}`;
                const bytes = new Uint8Array(4 + name.length * 2);
                const view = new DataView(bytes.buffer);
                view.setUint32(0, name.length * 2, true);
                [...name].forEach((ch, at)=>view.setUint16(4 + at * 2, ch.charCodeAt(0), true));
                return bytes;
            }
            if (!allows(host.handles.access?.(handle >>> 0) ?? null, FILE_READ_ATTRIBUTES))
            {
                return { status: STATUS.ACCESS_DENIED };
            }
            if (end.side === 'client' && (end.cut || instance.state === 'disconnected'))
            {
                return { status: STATUS_PIPE_DISCONNECTED };
            }
            if ((kind >>> 0) === FILE_PIPE_INFORMATION)
            {
                return Uint8Array.of(...dwordBytes(end.readMessages ? 1 : 0),
                    ...dwordBytes(end.nowait ? 1 : 0));
            }
            const peer = peerOf(end);
            const state = end.cut || instance.state === 'disconnected'
                ? FILE_PIPE_DISCONNECTED_STATE
                : instance.state === 'listening' ? FILE_PIPE_LISTENING_STATE
                    : peer && !peer.closed ? FILE_PIPE_CONNECTED_STATE : FILE_PIPE_CLOSING_STATE;
            // What the end writes queues at the other end, up to that end's quota.
            const quota = end.side === 'server' ? pipe.outSize : pipe.inSize;
            const queued = peer ? available(peer) : 0;
            const inbound = (pipe.openMode & PIPE_ACCESS_INBOUND) !== 0;
            const outbound = (pipe.openMode & PIPE_ACCESS_OUTBOUND) !== 0;
            return Uint8Array.of(...[
                pipe.messages ? 1 : 0,
                inbound && outbound ? 2 : outbound ? 1 : 0,
                pipe.maxInstances === PIPE_UNLIMITED_INSTANCES ? 0xffffffff : pipe.maxInstances,
                pipe.instances.size,
                pipe.inSize,
                available(end),
                pipe.outSize,
                Math.max(0, quota - queued),
                state,
                end.side === 'server' ? 1 : 0,
            ].flatMap(value=>[...dwordBytes(value)]));
        },

        /**
         * NtSetInformationFile's FilePipeInformation of a pipe end: its read
         * mode (message reading of a byte pipe is refused) and its completion
         * mode, each 0 or 1. The handle needs FILE_WRITE_ATTRIBUTES. Null for
         * a handle that is no pipe end or another class; else the status.
         *
         * @param {number} handle @param {number} kind @param {number} from
         * @param {number} length
         * @returns {number | null}
         */
        setInformation(handle, kind, from, length){
            const end = endOf(handle);
            if (!end || (kind >>> 0) !== FILE_PIPE_INFORMATION)
            {
                return null;
            }
            if ((length >>> 0) < 8)
            {
                return STATUS.INFO_LENGTH_MISMATCH;
            }
            if (!allows(host.handles.access?.(handle >>> 0) ?? null, FILE_WRITE_ATTRIBUTES))
            {
                return STATUS.ACCESS_DENIED;
            }
            if (end.side === 'client' && (end.cut || end.instance.state === 'disconnected'))
            {
                return STATUS_PIPE_DISCONNECTED;
            }
            const readMode = readDword(from >>> 0);
            const completion = readDword((from >>> 0) + 4);
            if (readMode > 1 || completion > 1 || (readMode === 1 && !end.instance.pipe.messages))
            {
                return STATUS.INVALID_PARAMETER;
            }
            end.readMessages = readMode === 1;
            end.nowait = completion === 1;
            return STATUS.SUCCESS;
        },

        /**
         * Each of this process's pipe handles, one line: its name or that it
         * is anonymous, its side, the handles onto it and onto the other end
         * in every process, whether the other end is gone, the reads waiting
         * and the bytes unread.
         *
         * @returns {string[]}
         */
        describe(){
            return [...inheritable.keys()].flatMap(handle=>{
                const end = endOf(handle);
                if (!end)
                {
                    return [];
                }
                const peer = peerOf(end);
                const unread = end.inbox.reduce((sum, one)=>sum + one.bytes.length - one.at, 0);
                return [`${handle} ${end.instance.pipe.name ?? 'anonymous'} ${end.side}`
                    + ` refs=${end.refs} peer=${peer ? `${peer.refs}${peer.closed ? ' closed' : ''}`
                        : 'none'} state=${end.instance.state} readers=${end.readers.length}`
                    + ` unread=${unread}`];
            });
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
        /**
         * A pipe end's name under the pipe device, as the object namespace
         * spells it (`\Device\NamedPipe\name`); null for a pipe made with
         * no name, undefined for a handle that is no pipe end.
         *
         * @param {number} handle
         * @returns {string | null | undefined}
         */
        objectName(handle){
            const end = endOf(handle);
            if (!end)
            {
                return undefined;
            }
            const { name } = end.instance.pipe;
            if (!name)
            {
                return null;
            }
            const prefix = PREFIXES.find(one=>name.toLowerCase().startsWith(one)) ?? PREFIXES[0];
            return `\\Device\\NamedPipe\\${name.slice(prefix.length)}`;
        },
        isPipe: (/** @type {number} */ handle)=>endOf(handle) !== null
            || standInOf(handle) !== null,

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

        /**
         * The process has ended: every pipe handle it held is closed, as
         * Windows closes a process's handles, so an end it shared with
         * another process goes with its last handle -- a parent reading the
         * output a child inherited reads to its end when the child exits.
         */
        processEnded(){
            // Its reads, writes and flushes end with it, unanswered: what a
            // write of it had not had read is gone from the pipe, as Windows
            // cancels a thread's I/O when it ends.
            forEachEnd(end=>abort(end, op=>op.ctx === ctx, null));
            for (const handle of [...inheritable.keys()])
            {
                closed(handle, endOf(handle) ?? standInOf(handle));
            }
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
