/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The Winsock surface the guest calls, over the socket registry.
 *
 * This is translation and nothing else: handles into sockets, guest pointers
 * into addresses and buffers, outcomes into a return value plus an error slot.
 * Every decision about what a socket *does* is one layer down.
 *
 * Three things about the translation are worth stating, because each is a place
 * a faithful implementation looks wrong.
 *
 * The error slot is per thread. WSAGetLastError is documented that way and
 * programs rely on it: a worker thread that fails a call must not have its
 * reason overwritten by whatever the main thread did in between.
 *
 * A blocking call answers with a promise. The bridge suspends the guest thread
 * on one and resumes it with the result, which is the same machinery a file
 * read on an absent bundle block uses -- so a blocking recv costs a suspended
 * host call, not a spin.
 *
 * Anything read out of guest memory is read when the call is made, never when
 * it completes. Between those two moments the program is free to reuse the
 * buffer it passed, so a completion that goes back for the arguments finds
 * whatever is there now. The argument list itself is safe here -- the bridge
 * builds a fresh one per call -- but a WSABUF array behind a pointer is not,
 * and is copied at entry for exactly that reason.
 */

import {
    ADDRINFO, AF_INET, AF_UNSPEC, AI_CANONNAME, AI_NUMERICHOST, AI_PASSIVE,
    FD_ACCEPT, FD_CLOSE, FD_CONNECT, FD_MAX_EVENTS, FD_READ, FD_WRITE, FIONBIO, FIONREAD,
    FROM_PROTOCOL_INFO, HOSTENT, INADDR_ANY, INADDR_LOOPBACK, INADDR_NONE, INVALID_SOCKET,
    NI_DGRAM, NI_NAMEREQD, NI_NUMERICHOST, NI_NUMERICSERV, PROTOENT, SD_BOTH,
    SOCKET_ERROR, SOCK_DGRAM, SOCK_RAW, SOCK_RDM, SOCK_SEQPACKET, SOCK_STREAM, SOL_SOCKET,
    SO_TYPE, WSADATA, WSADESCRIPTION, WSAOVERLAPPED, WSAPROTOCOL_INFO, WSASYSSTATUS,
    WSAEAFNOSUPPORT, WSAEFAULT, WSAEINVAL, WSAENOTSOCK, WSAEMSGSIZE, WSAEOPNOTSUPP,
    WSAESOCKTNOSUPPORT, WSAEWOULDBLOCK, WSAHOST_NOT_FOUND, WSANOTINITIALISED, WSANO_DATA,
    WSANO_RECOVERY, WSATYPE_NOT_FOUND, WSA_INVALID_HANDLE, WSA_INVALID_PARAMETER,
    WSA_IO_INCOMPLETE, WSA_IO_PENDING, WSA_MAXIMUM_WAIT_EVENTS, WSA_NOT_ENOUGH_MEMORY,
    WSA_OPERATION_ABORTED, WSA_WAIT_FAILED, WSOCK32_ORDINALS, WS2_32_ORDINALS,
} from './constants.js';
import {
    SOCKADDR_IN_SIZE, formatAddress, parseAddress, readSockaddr, swap16, swap32, writeSockaddr,
} from './sockaddr.js';
import { formatIpv6Text, parseIpv4Text, parseIpv6Text } from './inet.js';
import { encodeAnsi } from '../kernel32/locale.js';
import { createRefusals } from '../common/refusal.js';

/** The name this host answers to, and the only one it can resolve to itself. */
const HOSTNAME = 'bottlify';

/**
 * The services of the services file Windows ships that a program may ask for
 * by name: each with its port and the protocols it is listed for.
 *
 * @type {[string, number, string[]][]}
 */
const SERVICES = [
    ['echo', 7, ['tcp', 'udp']], ['discard', 9, ['tcp', 'udp']], ['daytime', 13, ['tcp', 'udp']],
    ['ftp-data', 20, ['tcp']], ['ftp', 21, ['tcp']], ['telnet', 23, ['tcp']],
    ['smtp', 25, ['tcp']], ['time', 37, ['tcp', 'udp']], ['domain', 53, ['tcp', 'udp']],
    ['tftp', 69, ['udp']], ['gopher', 70, ['tcp']], ['finger', 79, ['tcp']],
    ['http', 80, ['tcp']], ['pop3', 110, ['tcp']], ['nntp', 119, ['tcp']], ['ntp', 123, ['udp']],
    ['imap', 143, ['tcp']], ['snmp', 161, ['udp']], ['irc', 194, ['tcp']],
    ['https', 443, ['tcp', 'udp']],
];

/** struct servent on 32-bit Windows: the name, the aliases, the port, then the protocol. */
const SERVENT = { s_name: 0, s_aliases: 4, s_port: 8, s_proto: 12, SIZE: 16 };

/** The one extension lookup a program makes before it settles for the plain calls. */
const SIO_GET_EXTENSION_FUNCTION_POINTER = 0xc8000006;
/**
 * The WSAIoctl controls a program sets on a socket as it makes it (mstcpip.h,
 * ws2def.h): what a UDP socket does with an ICMP unreachable or a TTL
 * expiry, TCP keep-alive's timing, the loopback fast path, the base
 * provider's handle, and the address a socket would send from.
 */
const SIO_KEEPALIVE_VALS = 0x98000004;
const SIO_UDP_CONNRESET = 0x9800000c;
const SIO_UDP_NETRESET = 0x9800000f;
const SIO_LOOPBACK_FAST_PATH = 0x98000010;
const SIO_BASE_HANDLE = 0x48000022;
const SIO_ADDRESS_LIST_QUERY = 0x48000016;
const SIO_ROUTING_INTERFACE_QUERY = 0xc8000014;

/**
 * The extension functions SIO_GET_EXTENSION_FUNCTION_POINTER names by GUID
 * (mswsock.h), each the mswsock export of the same name: a program built for
 * completion ports asks for these before it opens a connection.
 */
const EXTENSION_GUIDS = Object.freeze({
    'b5367df1-cbac-11cf-95ca-00805f48a192': 'AcceptEx',
    'b5367df2-cbac-11cf-95ca-00805f48a192': 'GetAcceptExSockaddrs',
    'b5367df0-cbac-11cf-95ca-00805f48a192': 'TransmitFile',
    '25a207b9-ddf3-4660-8ee9-76e58c74063e': 'ConnectEx',
    '7fda2e11-8630-436f-a031-f536a6eec157': 'DisconnectEx',
});

/**
 * The protocols of the protocol file Windows ships, each with its number and
 * the alias that file gives it.
 *
 * @type {[string, number, string][]}
 */
const PROTOCOLS = [
    ['ip', 0, 'IP'], ['icmp', 1, 'ICMP'], ['ggp', 3, 'GGP'], ['tcp', 6, 'TCP'],
    ['egp', 8, 'EGP'], ['pup', 12, 'PUP'], ['udp', 17, 'UDP'], ['hmp', 20, 'HMP'],
    ['xns-idp', 22, 'XNS-IDP'], ['rdp', 27, 'RDP'], ['rvd', 66, 'RVD'],
];

/**
 * What an overlapped operation's Internal word holds: the status the system
 * keeps there, pending until the operation completes, then its outcome.
 */
const STATUS_SUCCESS = 0;
const STATUS_PENDING = 0x103;
const STATUS_BUFFER_OVERFLOW = 0x80000005;
const STATUS_UNSUCCESSFUL = 0xc0000001;
const STATUS_CANCELLED = 0xc0000120;

/** WSARecv's flags word, as it comes back: nothing partial is ever reported. */
const NO_FLAGS = 0;

/** TransmitFile's flags: a disconnect after the data, and the reuse that needs one. */
const TF_DISCONNECT = 0x01;
const TF_REUSE_SOCKET = 0x02;
/** How much of a file TransmitFile reads at a time. */
const TRANSMIT_CHUNK = 0x10000;

/**
 * @typedef {Object} WinsockHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {() => any} currentThread
 * @property {any} heap                 Allocates the buffers we hand back pointers to.
 * @property {any} registry             The socket registry.
 * @property {(message: { hwnd: number, message: number, wParam: number,
 *             lParam: number }) => void} post
 *           Where a readiness notification goes -- the same window queue
 *           PostMessage uses, so a program's own PeekMessage loop sees it.
 * @property {(handle: number) => void} signalEvent
 *           Signals a kernel event object by its guest handle, for
 *           WSAEventSelect. A stale or mistyped handle is the program's
 *           mistake, not a fault here.
 * @property {(name: string) => ((args: number[]) => any) | undefined} [kernel32]
 *           Another kernel32 export's handler, by name, read when it is
 *           called: a WSAEVENT is a kernel event, so the event calls are
 *           CreateEvent, SetEvent and the waits under other names, and
 *           TransmitFile reads its file through ReadFile. Absent, those
 *           calls are refused.
 * @property {(api: string, detail: string) => void} [divergence]
 * @property {(name: string) => number | Promise<number>} [extension]
 *           Where mswsock's export of this name is, mswsock loaded first if
 *           it is not yet, as ws2_32 loads it for its provider; zero for one
 *           it does not export. Absent, the extension lookup is refused.
 */

/**
 * A GUID as its text, lower case, from the sixteen bytes a structure holds.
 *
 * @param {Uint8Array} bytes
 */
const guidText = bytes=>{
    const view = new DataView(bytes.buffer, bytes.byteOffset, 16);
    const hex = (/** @type {number} */ value, /** @type {number} */ digits)=>
        value.toString(16).padStart(digits, '0');
    const tail = [...bytes.subarray(8, 16)].map(byte=>hex(byte, 2)).join('');
    return `${hex(view.getUint32(0, true), 8)}-${hex(view.getUint16(4, true), 4)}-`
        + `${hex(view.getUint16(6, true), 4)}-${tail.slice(0, 4)}-${tail.slice(4)}`;
};

const AF_INET6 = 23;
const WSASERVICE_NOT_FOUND = 10108;
const WSAENOBUFS = 10055;
const ERROR_INVALID_PARAMETER = 87;

/**
 * WSAPROTOCOL_INFOW, the wide description WSCEnumProtocols fills: the
 * narrow one is the same up to szProtocol, which holds 256 characters of
 * either width.
 */
const PROTOCOL_INFO = Object.freeze({
    SERVICE_FLAGS1: 0, PROVIDER_FLAGS: 16, PROVIDER_ID: 20, CATALOG_ENTRY: 36,
    CHAIN_LENGTH: 40, VERSION: 72, ADDRESS_FAMILY: 76, MAX_SOCKADDR: 80, MIN_SOCKADDR: 84,
    SOCKET_TYPE: 88, PROTOCOL: 92, MESSAGE_SIZE: 108, NAME: 116,
    SIZE_A: 372, SIZE_W: 628,
});

/** The base provider every Windows has for TCP/IP, mswsock's MSAFD, by its GUID's bytes. */
const MSAFD_TCPIP = Uint8Array.of(0xa0, 0x1a, 0x0f, 0xe7, 0x8b, 0xab, 0xcf, 0x11,
    0x8c, 0xa3, 0x00, 0x80, 0x5f, 0x48, 0xa1, 0x92);
const MSAFD_PATH = '%SystemRoot%\\system32\\mswsock.dll';
/**
 * The two base protocols this stack carries, as the catalogue lists them:
 * TCP (guaranteed, ordered, graceful close, expedited data) and UDP
 * (connectionless, message oriented, broadcast and multipoint), both with
 * IFS handles and matching protocol zero.
 */
const BASE_PROTOCOLS = Object.freeze([
    { name: 'MSAFD Tcpip [TCP/IP]', catalog: 1001, type: SOCK_STREAM, protocol: 6,
        flags: 0x20066, messageSize: 0 },
    { name: 'MSAFD Tcpip [UDP/IP]', catalog: 1002, type: SOCK_DGRAM, protocol: 17,
        flags: 0x20e09, messageSize: 65527 },
]);

/**
 * @param {WinsockHost} host
 */
export function createWinsockFunctions(host){
    const { registry, post, signalEvent } = host;

    /**
     * The last error, per thread.
     *
     * Keyed by the thread object the kernel hands out rather than by an id,
     * because the object is what identifies a thread everywhere else here and
     * an id would be a second, quietly different, notion of the same thing.
     *
     * @type {Map<any, number>}
     */
    const errors = new Map();

    /** Whether WSAStartup has been called. Winsock refuses everything until it has. */
    let started = false;

    /** @param {number} code */
    const setError = code=>{
        errors.set(host.currentThread(), code >>> 0);
    };

    const lastError = ()=>errors.get(host.currentThread()) ?? 0;

    /** Fails a call: the error slot carries the reason, the return value only says "failed". */
    const fail = (/** @type {number} */ code, /** @type {number} */ result = SOCKET_ERROR)=>{
        setError(code);
        return result >>> 0;
    };

    /** Succeeds. The slot is not cleared -- Winsock leaves it alone on success. */
    const ok = (/** @type {number} */ result = 0)=>result >>> 0;

    /** @param {number} address @param {number} value */
    const writeDword = (address, value)=>{
        host.writeMemory(address >>> 0, new Uint8Array([
            value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
        ]));
    };

    /** @param {number} address */
    const readDword = address=>{
        const bytes = host.readMemory(address >>> 0, 4);
        return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
    };

    /** Terminated, in the ANSI page a name a program passes is read in. @param {string} text */
    const sz = text=>encodeAnsi(`${text}\0`);

    /**
     * Resolves a handle, or reports that it is not a socket. A stale handle is
     * a return code and never a fault: programs do close a socket twice.
     *
     * @param {number} handle
     */
    const socketOf = handle=>registry.get(handle);

    /**
     * Every call but the four startup ones needs the library to have been
     * started, and Winsock is documented to say so rather than working anyway.
     */
    const needStarted = ()=>started ? null : WSANOTINITIALISED;

    /**
     * Outstanding WSAAsyncGetHostByName tasks, keyed by the handle it gave
     * back. Held only long enough to know whether WSACancelAsyncRequest
     * reached it before its resolution did -- there is nothing else here for
     * a program to ask about one.
     *
     * @type {Map<number, { cancelled: boolean }>}
     */
    const asyncTasks = new Map();
    let nextAsyncTask = 1;

    /**
     * A buffer we allocate and keep, for the calls documented to return a
     * pointer into library memory. One per name, reused, because the contract
     * is that it stays valid until the next call and nothing says it moves.
     *
     * @type {Map<string, number>}
     */
    const statics = new Map();

    /** @param {string} name @param {number} bytes */
    const staticBuffer = (name, bytes)=>{
        const held = statics.get(name);
        if (held !== undefined)
        {
            return held;
        }
        const address = host.heap.allocate(bytes);
        statics.set(name, address);
        return address;
    };

    /**
     * The protocol a service lookup is narrowed to, lowercased, or null for any.
     *
     * @param {number} pointer
     */
    const protoOf = pointer=>((pointer >>> 0) === 0
        ? null : host.readCString(pointer >>> 0, 16).toLowerCase());

    /**
     * A service as struct servent, in the buffer both lookups share: named by
     * the protocol asked for, or the first it is listed for.
     *
     * @param {[string, number, string[]]} service @param {string | null} proto
     */
    const writeServent = ([name, port, protocols], proto)=>{
        const block = staticBuffer('servent', SERVENT.SIZE + 48);
        const nameAt = block + SERVENT.SIZE;
        const aliasesAt = nameAt + 32;
        const protoAt = aliasesAt + 4;
        host.writeMemory(nameAt, sz(name));
        writeDword(aliasesAt, 0);
        host.writeMemory(protoAt, sz(proto ?? protocols[0]));
        const record = new DataView(new ArrayBuffer(SERVENT.SIZE));
        record.setUint32(SERVENT.s_name, nameAt, true);
        record.setUint32(SERVENT.s_aliases, aliasesAt, true);
        record.setUint16(SERVENT.s_port, port, false);
        record.setUint32(SERVENT.s_proto, protoAt, true);
        host.writeMemory(block, new Uint8Array(record.buffer));
        return block >>> 0;
    };

    /**
     * Reads a WSABUF array as values, at call time.
     *
     * The array lives in guest memory the caller may reuse the moment this
     * returns, so what a later completion needs has to be taken now. This is
     * the whole of the async-callback invariant at this boundary.
     *
     * @param {number} pointer @param {number} count
     * @returns {{ pointer: number, length: number }[]}
     */
    const readBuffers = (pointer, count)=>{
        const buffers = [];
        for (let at = 0; at < count; at++)
        {
            const entry = (pointer >>> 0) + at * 8;
            buffers.push({ length: readDword(entry), pointer: readDword(entry + 4) });
        }
        return buffers;
    };

    /** How many bytes a WSABUF array offers in total. */
    const totalOf = (/** @type {{ length: number }[]} */ buffers)=>
        buffers.reduce((sum, buffer)=>sum + buffer.length, 0);

    /**
     * Spreads received bytes across a WSABUF array, in order.
     *
     * @param {{ pointer: number, length: number }[]} buffers
     * @param {Uint8Array} bytes
     */
    const scatter = (buffers, bytes)=>{
        let at = 0;
        for (const buffer of buffers)
        {
            if (at >= bytes.length)
            {
                break;
            }
            const part = bytes.subarray(at, at + buffer.length);
            host.writeMemory(buffer.pointer, part);
            at += part.length;
        }
    };

    /** Gathers a WSABUF array into one buffer. */
    const gather = (/** @type {{ pointer: number, length: number }[]} */ buffers)=>{
        const out = new Uint8Array(totalOf(buffers));
        let at = 0;
        for (const buffer of buffers)
        {
            out.set(host.readMemory(buffer.pointer, buffer.length), at);
            at += buffer.length;
        }
        return out;
    };

    /**
     * Waits for a socket to be able to answer, then answers.
     *
     * The attempt is retried rather than trusted after a wake-up, because a
     * wake-up says something changed and not that this caller is the one it
     * changed for -- two threads reading one socket both wake, and only one
     * finds bytes.
     *
     * @param {any} socket
     * @param {() => any} attempt  Returns an outcome, or an error of WSAEWOULDBLOCK.
     * @returns {Promise<any>}
     */
    const until = async(socket, attempt)=>{
        for (;;)
        {
            const outcome = attempt();
            if (outcome.error !== WSAEWOULDBLOCK)
            {
                return outcome;
            }
            if (socket.closed)
            {
                return { error: WSAENOTSOCK };
            }
            await registry.readableSoon(socket);
        }
    };

    /**
     * The shape every blocking call here shares: try it, and if it would block,
     * either say so or wait, depending on what the socket was set to.
     *
     * @param {any} socket
     * @param {() => any} attempt
     * @param {(outcome: any) => number} settle
     * @param {any} [outcome]  The first try's outcome, where the caller already made it.
     */
    const blocking = (socket, attempt, settle, outcome = attempt())=>{
        if (outcome.error !== WSAEWOULDBLOCK)
        {
            return settle(outcome);
        }
        if (socket.nonBlocking)
        {
            return fail(WSAEWOULDBLOCK);
        }
        return until(socket, attempt).then(settle);
    };

    /**
     * recv and recvfrom past their first try, apart from them: a function
     * whose variables a closure takes keeps them in an environment made at
     * every call, and the first try answers most calls a game makes.
     *
     * @param {any} socket @param {number} wanted @param {number} buffer
     * @param {number} name  Where recvfrom puts the sender; 0 for recv.
     * @param {number} lengthPointer @param {any} first
     */
    const receiveInto = (socket, wanted, buffer, name, lengthPointer, first)=>blocking(socket,
        ()=>registry.receive(socket, wanted), outcome=>{
            rearm(socket, 'read');
            if (outcome.error)
            {
                return fail(outcome.error);
            }
            if (outcome.value > 0)
            {
                host.writeMemory(buffer >>> 0, outcome.bytes);
            }
            if (name !== 0 && outcome.from)
            {
                writeSockaddr(host.writeMemory, name, outcome.from);
                if (lengthPointer !== 0)
                {
                    writeDword(lengthPointer, SOCKADDR_IN_SIZE);
                }
            }
            // A datagram that did not fit reports the loss, and does so
            // *after* the bytes that did fit have been handed over.
            return outcome.truncated ? fail(WSAEMSGSIZE) : ok(outcome.value);
        }, first);

    /** How many bytes writeHostentAt needs, past what the caller already has room for. */
    const HOSTENT_BLOCK_SIZE = HOSTENT.SIZE + 64;

    /**
     * Lays out a hostent at a given block and returns it back.
     *
     * @param {number} block @param {string} name @param {number} address host order
     */
    const writeHostentAt = (block, name, address)=>{
        const nameAt = block + HOSTENT.SIZE;
        const aliasesAt = nameAt + 32;
        const listAt = aliasesAt + 8;
        const addressAt = listAt + 8;

        host.writeMemory(nameAt, sz(name));
        writeDword(aliasesAt, 0);
        writeDword(addressAt, swap32(address));
        writeDword(listAt, addressAt);
        writeDword(listAt + 4, 0);

        const record = new Uint8Array(HOSTENT.SIZE);
        const view = new DataView(record.buffer);
        view.setUint32(HOSTENT.h_name, nameAt, true);
        view.setUint32(HOSTENT.h_aliases, aliasesAt, true);
        view.setUint16(HOSTENT.h_addrtype, AF_INET, true);
        view.setUint16(HOSTENT.h_length, 4, true);
        view.setUint32(HOSTENT.h_addr_list, listAt, true);
        host.writeMemory(block, record);
        return block >>> 0;
    };

    /**
     * The gethostbyname/gethostbyaddr form: one buffer this library keeps,
     * reused rather than reallocated, valid until the next call.
     *
     * @param {string} name @param {number} address host order
     */
    const writeHostent = (name, address)=>
        writeHostentAt(staticBuffer('hostent', HOSTENT_BLOCK_SIZE), name, address);

    /** fd_set is a count followed by that many handles. */
    const readFdSet = (/** @type {number} */ pointer)=>{
        if (pointer === 0)
        {
            return [];
        }
        const total = readDword(pointer);
        const handles = [];
        for (let at = 0; at < total; at++)
        {
            handles.push(readDword((pointer >>> 0) + 4 + at * 4));
        }
        return handles;
    };

    /**
     * Writes an fd_set back.
     *
     * The count the caller passed in is the array's capacity, and it is the only
     * thing that says how much room there is -- so more ready sockets than the
     * caller listed is a fault rather than a write past the end.
     *
     * @param {number} pointer @param {any[]} sockets
     */
    const writeFdSet = (pointer, sockets)=>{
        if (pointer === 0)
        {
            return true;
        }
        if (sockets.length > readDword(pointer))
        {
            return false;
        }
        writeDword(pointer, sockets.length);
        sockets.forEach((socket, at)=>writeDword((pointer >>> 0) + 4 + at * 4, socket.handle));
        return true;
    };

    /**
     * Readiness as a window message (WSAAsyncSelect) or a kernel event
     * (WSAEventSelect), over the same per-socket state machine.
     *
     * Both notify on the same four edges -- writable, a connection to
     * accept, bytes to read, the peer done -- and both are level-triggered
     * with the same re-enable rule: FD_READ waits for `recv` to be called
     * again before it can fire a second time, FD_ACCEPT waits for `accept`.
     * FD_WRITE and FD_CLOSE need no re-enabling here, because nothing in
     * this stack ever reports WSAEWOULDBLOCK from a send to clear, and a
     * closed connection has nothing further to report.
     *
     * A socket's selection lives on the socket object itself (`asyncSelect`
     * or `eventSelect`, never both), alongside `nonBlocking` and the rest of
     * what functions.js already keeps there directly.
     */

    /** The bit position WSAEnumNetworkEvents' iErrorCode[] answers about. */
    const eventBit = (/** @type {number} */ event)=>Math.log2(event) | 0;

    /**
     * Delivers one event: a posted message for WSAAsyncSelect, an
     * accumulated bit plus a signalled kernel event for WSAEventSelect.
     *
     * @param {any} socket @param {number} event @param {number} error
     */
    const notify = (socket, event, error)=>{
        const select = socket.asyncSelect;
        if (select)
        {
            post({
                hwnd: select.hwnd, message: select.msg, wParam: socket.handle >>> 0,
                lParam: ((event & 0xffff) | ((error & 0xffff) << 16)) >>> 0,
            });
            return;
        }
        const armed = socket.eventSelect;
        if (armed)
        {
            const bit = eventBit(event);
            armed.pending |= 1 << bit;
            armed.errors[bit] = error & 0xffff;
            signalEvent(armed.handle);
        }
    };

    /** Whichever of the two selections is active, or undefined. */
    const selectionOf = (/** @type {any} */ socket)=>socket.asyncSelect || socket.eventSelect;

    /** Whether a socket has either kind of notification armed -- select()'s exclusion. */
    const notifying = (/** @type {any} */ socket)=>Boolean(selectionOf(socket));

    /** @param {any} socket */
    const isStream = socket=>socket.type === SOCK_STREAM;

    /** @param {any} socket */
    const isWritable = socket=>!socket.closed && (!isStream(socket) || socket.connected);

    /**
     * Checks every edge but FD_CONNECT, which only ever fires from the
     * connect call itself -- there being nothing to poll for it here, a
     * local connect never being pending and a remote one settling its own
     * promise once, exactly where the attempt was made.
     *
     * @param {any} socket
     */
    const pumpSelection = socket=>{
        const state = selectionOf(socket);
        if (!state || socket.closed)
        {
            return;
        }
        if ((state.mask & FD_WRITE) && !state.writeSent && isWritable(socket))
        {
            state.writeSent = true;
            notify(socket, FD_WRITE, 0);
        }
        if ((state.mask & FD_ACCEPT) && state.acceptArmed && socket.backlog.length > 0)
        {
            state.acceptArmed = false;
            notify(socket, FD_ACCEPT, 0);
        }
        if ((state.mask & FD_READ) && state.readArmed && socket.rx.length > 0)
        {
            state.readArmed = false;
            notify(socket, FD_READ, 0);
        }
        if ((state.mask & FD_CLOSE) && !state.closeSent && socket.finished)
        {
            state.closeSent = true;
            notify(socket, FD_CLOSE, socket.error || 0);
        }
    };

    /**
     * Re-enables FD_READ or FD_ACCEPT, then re-checks at once: the call that
     * re-enabled it may itself have left more to report -- a `recv` for less
     * than what was queued, an `accept` with another connection still
     * backlogged.
     *
     * @param {any} socket @param {'read' | 'accept'} which
     */
    const rearm = (socket, which)=>{
        const state = selectionOf(socket);
        if (!state)
        {
            return;
        }
        if (which === 'read')
        {
            state.readArmed = true;
        }
        else
        {
            state.acceptArmed = true;
        }
        pumpSelection(socket);
    };

    /**
     * Delivers FD_CONNECT (and, on success, whatever FD_WRITE that unlocks)
     * from the one place a connect's outcome is ever learned, whether that
     * was immediate or the far end of a promise.
     *
     * @param {any} socket @param {{ error?: number }} outcome
     */
    const notifyConnect = (socket, outcome)=>{
        const state = selectionOf(socket);
        if (!state)
        {
            return;
        }
        if (outcome.error)
        {
            if (state.mask & FD_CONNECT)
            {
                notify(socket, FD_CONNECT, outcome.error);
            }
            return;
        }
        if (state.mask & FD_CONNECT)
        {
            notify(socket, FD_CONNECT, 0);
        }
        pumpSelection(socket);
    };

    /**
     * Keeps a selection live across state changes the socket did not cause
     * itself to be asked about again.
     *
     * `registry`'s `wake` is one-shot: every waiter on a socket runs once and
     * is forgotten. A selection needs the opposite -- watching for as long as
     * it is armed -- so this re-attaches itself to the socket's waiter list
     * every time it runs, which is the same trick `readableSoon` callers use
     * one level up, done here so it never misses a second change that lands
     * before anyone has pumped messages for the first.
     *
     * @param {any} socket
     */
    const watch = socket=>{
        if (socket.watchingSelection)
        {
            return;
        }
        socket.watchingSelection = true;
        const tick = ()=>{
            pumpSelection(socket);
            if (!socket.closed && selectionOf(socket))
            {
                socket.waiters.push(tick);
            }
            else
            {
                socket.watchingSelection = false;
            }
        };
        socket.waiters.push(tick);
    };

    /**
     * socket(), and WSASocket after it has read the protocol description.
     *
     * @param {number} family @param {number} type
     */
    const createSocket = (family, type)=>{
        const missing = needStarted();
        if (missing !== null)
        {
            return fail(missing, INVALID_SOCKET);
        }
        if (family !== AF_INET)
        {
            return fail(WSAEAFNOSUPPORT, INVALID_SOCKET);
        }
        const made = registry.create(family, type);
        return made.error ? fail(made.error, INVALID_SOCKET) : ok(made.value);
    };

    /**
     * connect(), and WSAConnect without its connect data.
     *
     * @param {number} handle @param {number} name @param {number} length
     */
    const connectCall = (handle, name, length)=>{
        const socket = socketOf(handle);
        if (!socket)
        {
            return fail(WSAENOTSOCK);
        }
        if (length < SOCKADDR_IN_SIZE)
        {
            return fail(WSAEFAULT);
        }
        const address = readSockaddr(host.readMemory, name);
        if (!address)
        {
            return fail(WSAEFAULT);
        }
        // Reaching anything outside this runtime takes a round trip, so
        // the outcome may be a promise; the bridge parks the guest
        // thread on one, which is what a blocking connect does anyway.
        const settle = (/** @type {any} */ outcome)=>{
            notifyConnect(socket, outcome);
            return outcome.error ? fail(outcome.error) : ok(0);
        };
        const outcome = registry.connect(socket, address);
        return outcome instanceof Promise ? outcome.then(settle) : settle(outcome);
    };

    /**
     * A protoent in the one buffer this library keeps for it, valid until the
     * next call: the name, then the one alias and the list that names it.
     *
     * @param {[string, number, string]} protocol
     */
    const writeProtoent = ([name, number, alias])=>{
        const block = staticBuffer('protoent', PROTOENT.SIZE + 48);
        const nameAt = block + PROTOENT.SIZE;
        const aliasAt = nameAt + 16;
        const aliasesAt = aliasAt + 16;
        host.writeMemory(nameAt, sz(name));
        host.writeMemory(aliasAt, sz(alias));
        writeDword(aliasesAt, aliasAt);
        writeDword(aliasesAt + 4, 0);
        const record = new DataView(new ArrayBuffer(PROTOENT.SIZE));
        record.setUint32(PROTOENT.p_name, nameAt, true);
        record.setUint32(PROTOENT.p_aliases, aliasesAt, true);
        record.setInt16(PROTOENT.p_proto, number, true);
        host.writeMemory(block, new Uint8Array(record.buffer));
        return block >>> 0;
    };

    /** A kernel32 export's handler, read when it is called. @param {string} name */
    const kernel = name=>{
        const handler = host.kernel32?.(name);
        if (!handler)
        {
            throw new Error(`winsock: kernel32 has no ${name} to answer with`);
        }
        return handler;
    };

    /**
     * Carries the kernel's reason for a failure it just reported into this
     * library's slot: on Windows the two are one slot, and a program reads
     * WSAGetLastError after WSACloseEvent.
     *
     * @param {number} result @param {number} fallback  When the kernel kept no reason.
     */
    const kernelFailure = (result, fallback)=>{
        const code = host.kernel32?.('GetLastError')?.([]) ?? 0;
        setError(code === 0 ? fallback : code);
        return result >>> 0;
    };

    const refuse = createRefusals({ setLastError: setError, divergence: host.divergence });

    /**
     * An entry over kernel32, or -- on a host that reaches none -- its refusal.
     *
     * @param {string} name @param {number} argBytes
     * @param {{ answer: number, lastError: number }} refusal
     * @param {(args: number[]) => any} handler
     */
    const overKernel = (name, argBytes, refusal, handler)=>(host.kernel32
        ? { argBytes, handler }
        : refuse(name, { argBytes, ...refusal, why: 'no kernel32 is reachable from winsock' }));

    /**
     * The overlapped operations still in flight, by their WSAOVERLAPPED, each
     * with what settles when it completes.
     *
     * @type {Map<number, Promise<void>>}
     */
    const inFlight = new Map();

    /**
     * How the overlapped operations that failed failed, by their WSAOVERLAPPED.
     * Only the failures: a success is what Internal already says, and keeping
     * nothing for one keeps this from growing with every operation.
     *
     * @type {Map<number, number>}
     */
    const failures = new Map();

    /** The status an outcome leaves in Internal. @param {number} error */
    const statusOf = error=>(error === 0 ? STATUS_SUCCESS
        : error === WSAEMSGSIZE ? STATUS_BUFFER_OVERFLOW
            : error === WSA_OPERATION_ABORTED ? STATUS_CANCELLED : STATUS_UNSUCCESSFUL);

    /**
     * The event an operation signals, read when the call is made: the low bit
     * only asks that no completion port be told, and the rest is the handle.
     *
     * @param {number} overlapped
     */
    const eventOf = overlapped=>(readDword(overlapped + WSAOVERLAPPED.hEvent) & ~1) >>> 0;

    /** An operation begun and not yet done, as Internal says while it lasts. */
    const begin = (/** @type {number} */ overlapped)=>{
        failures.delete(overlapped);
        writeDword(overlapped + WSAOVERLAPPED.Internal, STATUS_PENDING);
        writeDword(overlapped + WSAOVERLAPPED.InternalHigh, 0);
    };

    /**
     * Completes an operation: its status and byte count where the system keeps
     * them, then its event -- signalled also for one that completed at once,
     * which Windows signals too, so a program that waits on it either way
     * never waits for nothing.
     *
     * @param {number} overlapped @param {number} event
     * @param {{ error: number, bytes: number }} outcome
     */
    const complete = (overlapped, event, { error, bytes })=>{
        inFlight.delete(overlapped);
        if (error === 0)
        {
            failures.delete(overlapped);
        }
        else
        {
            failures.set(overlapped, error);
        }
        writeDword(overlapped + WSAOVERLAPPED.Internal, statusOf(error));
        writeDword(overlapped + WSAOVERLAPPED.InternalHigh, bytes);
        if (event !== 0)
        {
            signalEvent(event);
        }
    };

    /** The calls whose completion routine has been refused, said once each. */
    const routinesRefused = new Set();

    /**
     * A completion routine runs as an APC on the calling thread the next time
     * it waits alertably, and no APC queue is reachable from here. Refused
     * rather than accepted and never run: a program told the call is pending
     * waits for a routine that never comes.
     *
     * @param {string} api
     */
    const noRoutine = api=>{
        if (!routinesRefused.has(api))
        {
            routinesRefused.add(api);
            host.divergence?.(api, 'a completion routine needs an APC queue winsock cannot reach');
        }
        return fail(WSAEOPNOTSUPP);
    };

    /**
     * What WSARecv and WSARecvFrom both are. The buffers and the address to
     * fill are taken at the call; the bytes land in them now or, for an
     * overlapped call that would have waited, when they arrive -- and then the
     * operation completes in its WSAOVERLAPPED and signals its event.
     *
     * @param {{ handle: number, buffers: number, count: number, received: number,
     *     flags: number, from: number, fromLength: number, overlapped: number,
     *     routine: number }} call
     * @param {string} api
     */
    const receiveCall = (call, api)=>{
        const socket = socketOf(call.handle);
        if (!socket)
        {
            return fail(WSAENOTSOCK);
        }
        if ((call.routine >>> 0) !== 0)
        {
            return noRoutine(api);
        }
        const from = call.from >>> 0;
        const fromLength = call.fromLength >>> 0;
        if (from !== 0 && (fromLength === 0 || (readDword(fromLength) | 0) < SOCKADDR_IN_SIZE))
        {
            return fail(WSAEFAULT);
        }
        const taken = readBuffers(call.buffers, call.count >>> 0);
        const overlapped = call.overlapped >>> 0;
        const event = overlapped === 0 ? 0 : eventOf(overlapped);
        const attempt = ()=>registry.receive(socket, totalOf(taken));

        /** @param {any} outcome @returns {{ error: number, bytes: number }} */
        const deliver = outcome=>{
            rearm(socket, 'read');
            if (outcome.error)
            {
                return { error: outcome.error, bytes: 0 };
            }
            scatter(taken, outcome.bytes);
            if (from !== 0 && outcome.from)
            {
                writeSockaddr(host.writeMemory, from, outcome.from);
                writeDword(fromLength, SOCKADDR_IN_SIZE);
            }
            // A datagram that did not fit is a failure that still delivered
            // what fitted, and says so after handing it over.
            return { error: outcome.truncated ? WSAEMSGSIZE : 0, bytes: outcome.value };
        };

        /** The call's own answer, once the bytes are in. @param {{ error: number, bytes: number }} result */
        const answer = result=>{
            const delivered = result.error === 0 || result.error === WSAEMSGSIZE;
            if (!delivered)
            {
                return fail(result.error);
            }
            if (overlapped !== 0)
            {
                complete(overlapped, event, result);
            }
            if ((call.received >>> 0) !== 0)
            {
                writeDword(call.received, result.bytes);
            }
            if ((call.flags >>> 0) !== 0)
            {
                writeDword(call.flags, NO_FLAGS);
            }
            return result.error === 0 ? ok(0) : fail(result.error);
        };

        const first = attempt();
        if (first.error !== WSAEWOULDBLOCK)
        {
            return answer(deliver(first));
        }
        rearm(socket, 'read');
        if (overlapped !== 0)
        {
            // Pending: the counts belong to the completion, and writing them
            // now is what makes a program read a byte count for data that has
            // not arrived. A socket closed under the operation aborts it.
            begin(overlapped);
            const record = { kind: 'recv', overlapped, buffers: taken };
            socket.pending.push(record);
            inFlight.set(overlapped, until(socket, attempt).then(outcome=>{
                const at = socket.pending.indexOf(record);
                if (at >= 0)
                {
                    socket.pending.splice(at, 1);
                }
                const result = deliver(outcome);
                complete(overlapped, event, result.error === WSAENOTSOCK
                    ? { error: WSA_OPERATION_ABORTED, bytes: 0 } : result);
            }));
            return fail(WSA_IO_PENDING);
        }
        if (socket.nonBlocking)
        {
            return fail(WSAEWOULDBLOCK);
        }
        return until(socket, attempt).then(outcome=>answer(deliver(outcome)));
    };

    /**
     * What WSASend and WSASendTo both are: a send never waits here, so an
     * overlapped one completes at once, in its WSAOVERLAPPED as well as in the
     * count it was handed.
     *
     * @param {{ handle: number, buffers: number, count: number, sent: number,
     *     to: number, toLength: number, overlapped: number, routine: number }} call
     * @param {string} api
     */
    const sendCall = (call, api)=>{
        const socket = socketOf(call.handle);
        if (!socket)
        {
            return fail(WSAENOTSOCK);
        }
        if ((call.routine >>> 0) !== 0)
        {
            return noRoutine(api);
        }
        const to = call.to >>> 0;
        if (to !== 0 && (call.toLength | 0) < SOCKADDR_IN_SIZE)
        {
            return fail(WSAEFAULT);
        }
        const target = to === 0 ? null : readSockaddr(host.readMemory, to);
        if (to !== 0 && !target)
        {
            return fail(WSAEFAULT);
        }
        const overlapped = call.overlapped >>> 0;
        const event = overlapped === 0 ? 0 : eventOf(overlapped);
        const outcome = registry.send(socket, gather(readBuffers(call.buffers, call.count >>> 0)),
            target);
        if (outcome.error)
        {
            return fail(outcome.error);
        }
        if (overlapped !== 0)
        {
            complete(overlapped, event, { error: 0, bytes: outcome.value });
        }
        if ((call.sent >>> 0) !== 0)
        {
            writeDword(call.sent, outcome.value);
        }
        return ok(0);
    };

    /**
     * The name a host is asked by, as a number: a literal, this machine by
     * either of its names, or -- for anything else -- null, which the
     * transport's resolver is asked about.
     *
     * @param {string} name
     */
    const resolveLocally = name=>{
        const literal = parseAddress(name);
        // The one address whose number is also inet_addr's failure.
        if (literal !== INADDR_NONE || name.trim() === '255.255.255.255')
        {
            return literal;
        }
        return name === HOSTNAME || name === 'localhost' || name === '' ? INADDR_LOOPBACK : null;
    };

    /**
     * The nodes getaddrinfo handed out, so freeaddrinfo frees only what was
     * ours: a pointer it never made is the program's mistake, not a block to
     * hand back to the heap.
     *
     * @type {Set<number>}
     */
    const addrinfoNodes = new Set();

    /**
     * A getaddrinfo answer in guest memory: one node per address, each a block
     * of its own with its sockaddr after it -- so a program that frees part of
     * the chain frees exactly that part -- and the canonical name, when asked
     * for, after the first.
     *
     * @param {number[]} addresses host order
     * @param {number} port
     * @param {{ socktype: number, protocol: number }} hints
     * @param {string | null} canonical
     */
    const writeAddrinfo = (addresses, port, hints, canonical)=>{
        let next = 0;
        for (let at = addresses.length - 1; at >= 0; at--)
        {
            const name = at === 0 && canonical !== null ? sz(canonical) : null;
            const block = host.heap.allocate(ADDRINFO.SIZE + SOCKADDR_IN_SIZE
                + (name ? name.length : 0)) >>> 0;
            if (block === 0)
            {
                return 0;
            }
            addrinfoNodes.add(block);
            const addressAt = block + ADDRINFO.SIZE;
            const nameAt = addressAt + SOCKADDR_IN_SIZE;
            const node = new DataView(new ArrayBuffer(ADDRINFO.SIZE));
            node.setInt32(ADDRINFO.ai_flags, 0, true);
            node.setInt32(ADDRINFO.ai_family, AF_INET, true);
            node.setInt32(ADDRINFO.ai_socktype, hints.socktype, true);
            node.setInt32(ADDRINFO.ai_protocol, hints.protocol, true);
            node.setUint32(ADDRINFO.ai_addrlen, SOCKADDR_IN_SIZE, true);
            node.setUint32(ADDRINFO.ai_canonname, name ? nameAt : 0, true);
            node.setUint32(ADDRINFO.ai_addr, addressAt, true);
            node.setUint32(ADDRINFO.ai_next, next, true);
            host.writeMemory(block, new Uint8Array(node.buffer));
            writeSockaddr(host.writeMemory, addressAt, { host: addresses[at], port });
            if (name)
            {
                host.writeMemory(nameAt, name);
            }
            next = block;
        }
        return next;
    };

    /**
     * A getaddrinfo or getnameinfo failure: the code is the answer, and the
     * error slot holds it too.
     *
     * @param {number} code
     */
    const eai = code=>{
        setError(code);
        return code >>> 0;
    };

    /**
     * The socket calls, shared by wsock32 and ws2_32.
     *
     * One table and one registry, because they are one library as far as a
     * program is concerned: a socket made through either is usable through the
     * other, and on Windows they are the same sockets for the same reason.
     */
    /**
     * What ioctlsocket and WSAIoctl both do with a command: the argument is
     * read or written in place, so the buffered form hands in whichever of its
     * two buffers the command uses.
     *
     * @param {number} handle @param {number} command @param {number} argument
     */
    const ioctl = (handle, command, argument)=>{
        const socket = socketOf(handle);
        if (!socket)
        {
            return fail(WSAENOTSOCK);
        }
        if ((command >>> 0) === FIONBIO)
        {
            if (argument === 0)
            {
                return fail(WSAEFAULT);
            }
            socket.nonBlocking = readDword(argument) !== 0;
            return ok(0);
        }
        if ((command >>> 0) === FIONREAD)
        {
            if (argument === 0)
            {
                return fail(WSAEFAULT);
            }
            writeDword(argument, registry.available(socket));
            return ok(0);
        }
        return fail(WSAEINVAL);
    };

    /** UTF-16LE with its terminator. @param {string} text */
    const wide = text=>{
        const out = new Uint8Array(text.length * 2 + 2);
        for (let at = 0; at < text.length; at++)
        {
            out[at * 2] = text.charCodeAt(at) & 0xff;
            out[at * 2 + 1] = text.charCodeAt(at) >>> 8;
        }
        return out;
    };

    /**
     * The protocol catalogue into `buffer`, as WSCEnumProtocols and
     * WSAEnumProtocols give it: the base protocols the zero-terminated list
     * at `protocols` names (all, without one), their count as the answer.
     *
     * @param {number} protocols @param {number} buffer @param {number} length
     * @param {boolean} wideNames @param {(code: number) => number} refuseWith
     */
    const enumProtocols = (protocols, buffer, length, wideNames, refuseWith)=>{
        if ((length >>> 0) === 0)
        {
            return refuseWith(WSAEFAULT);
        }
        /** @type {number[] | null} */
        let wanted = null;
        if ((protocols >>> 0) !== 0)
        {
            wanted = [];
            for (let at = protocols >>> 0; wanted.length < 64; at += 4)
            {
                const protocol = readDword(at);
                if (protocol === 0)
                {
                    break;
                }
                wanted.push(protocol);
            }
        }
        const chosen = BASE_PROTOCOLS.filter(entry=>wanted === null
            || wanted.includes(entry.protocol));
        const size = wideNames ? PROTOCOL_INFO.SIZE_W : PROTOCOL_INFO.SIZE_A;
        if ((buffer >>> 0) === 0 || readDword(length) < chosen.length * size)
        {
            writeDword(length, chosen.length * size);
            return refuseWith(WSAENOBUFS);
        }
        chosen.forEach((entry, index)=>{
            const record = new Uint8Array(size);
            const view = new DataView(record.buffer);
            view.setUint32(PROTOCOL_INFO.SERVICE_FLAGS1, entry.flags, true);
            // PFL_MATCHES_PROTOCOL_ZERO: socket(AF_INET, type, 0) finds it.
            view.setUint32(PROTOCOL_INFO.PROVIDER_FLAGS, 0x8, true);
            record.set(MSAFD_TCPIP, PROTOCOL_INFO.PROVIDER_ID);
            view.setUint32(PROTOCOL_INFO.CATALOG_ENTRY, entry.catalog, true);
            // A base protocol's chain is itself alone.
            view.setUint32(PROTOCOL_INFO.CHAIN_LENGTH, 1, true);
            view.setUint32(PROTOCOL_INFO.VERSION, 2, true);
            view.setUint32(PROTOCOL_INFO.ADDRESS_FAMILY, AF_INET, true);
            view.setUint32(PROTOCOL_INFO.MAX_SOCKADDR, SOCKADDR_IN_SIZE, true);
            view.setUint32(PROTOCOL_INFO.MIN_SOCKADDR, SOCKADDR_IN_SIZE, true);
            view.setUint32(PROTOCOL_INFO.SOCKET_TYPE, entry.type, true);
            view.setUint32(PROTOCOL_INFO.PROTOCOL, entry.protocol, true);
            view.setUint32(PROTOCOL_INFO.MESSAGE_SIZE, entry.messageSize, true);
            record.set(wideNames ? wide(entry.name) : sz(entry.name), PROTOCOL_INFO.NAME);
            host.writeMemory((buffer >>> 0) + index * size, record);
        });
        return chosen.length;
    };

    const table = {
        WSAStartup: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([requested, data])=>{
                started = true;
                if (data !== 0)
                {
                    const block = new Uint8Array(WSADATA.SIZE);
                    const view = new DataView(block.buffer);
                    // The version negotiated is the one asked for, capped at
                    // what we implement; the high version is what we could do.
                    const asked = requested & 0xffff;
                    view.setUint16(WSADATA.wVersion, asked === 0 ? 0x0202 : asked, true);
                    view.setUint16(WSADATA.wHighVersion, 0x0202, true);
                    block.set(sz(WSADESCRIPTION), WSADATA.szDescription);
                    block.set(sz(WSASYSSTATUS), WSADATA.szSystemStatus);
                    // Winsock 2 says to ignore both limits and leaves them
                    // zero; a 1.x caller still reads them, and Windows tells
                    // it 32767 sockets and 65467-byte datagrams (Wine's
                    // sock.c test_startup). Zero there reads as no sockets.
                    const legacy = (asked & 0xff) < 2;
                    view.setUint16(WSADATA.iMaxSockets, legacy ? 32767 : 0, true);
                    view.setUint16(WSADATA.iMaxUdpDg, legacy ? 65467 : 0, true);
                    host.writeMemory(data >>> 0, block);
                }
                return ok(0);
            },
        },

        WSACleanup: {
            argBytes: 0,
            handler: ()=>{
                for (const socket of registry.all())
                {
                    registry.close(socket);
                }
                started = false;
                return ok(0);
            },
        },

        WSAGetLastError: { argBytes: 0, handler: ()=>lastError() >>> 0 },

        // Winsock 1.1's blocking hooks. No call here blocks the way they
        // describe -- a blocking call parks its thread, which other threads
        // and the message loop run beside -- so there is no hook to run and
        // nothing to cancel, and each answers as Wine's tests see Windows do.
        /** FARPROC WSASetBlockingHook(FARPROC lpBlockFunc): the hook before it, none. */
        WSASetBlockingHook: { argBytes: 4, handler: ()=>0 },
        /** int WSAUnhookBlockingHook(void) */
        WSAUnhookBlockingHook: { argBytes: 0, handler: ()=>0 },
        /** int WSACancelBlockingCall(void) */
        WSACancelBlockingCall: { argBytes: 0, handler: ()=>0 },
        /** BOOL WSAIsBlocking(void) */
        WSAIsBlocking: { argBytes: 0, handler: ()=>0 },

        WSASetLastError: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([code])=>{
                setError(code);
                return 0;
            },
        },

        socket: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([family, type])=>createSocket(family, type),
        },

        closesocket: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                const socket = socketOf(handle);
                if (!socket)
                {
                    return fail(WSAENOTSOCK);
                }
                const outcome = registry.close(socket);
                return outcome.error ? fail(outcome.error) : ok(0);
            },
        },

        bind: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, name, length])=>{
                const socket = socketOf(handle);
                if (!socket)
                {
                    return fail(WSAENOTSOCK);
                }
                if (length < SOCKADDR_IN_SIZE)
                {
                    return fail(WSAEFAULT);
                }
                const address = readSockaddr(host.readMemory, name);
                if (!address)
                {
                    return fail(WSAEFAULT);
                }
                if (address.family !== AF_INET)
                {
                    return fail(WSAEAFNOSUPPORT);
                }
                const outcome = registry.bind(socket, address);
                return outcome.error ? fail(outcome.error) : ok(0);
            },
        },

        listen: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle])=>{
                const socket = socketOf(handle);
                if (!socket)
                {
                    return fail(WSAENOTSOCK);
                }
                const outcome = registry.listen(socket);
                return outcome.error ? fail(outcome.error) : ok(0);
            },
        },

        connect: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, name, length])=>connectCall(handle, name, length),
        },

        accept: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, name, lengthPointer])=>{
                const socket = socketOf(handle);
                if (!socket)
                {
                    return fail(WSAENOTSOCK, INVALID_SOCKET);
                }
                return blocking(socket, ()=>registry.accept(socket), outcome=>{
                    rearm(socket, 'accept');
                    if (outcome.error)
                    {
                        return fail(outcome.error, INVALID_SOCKET);
                    }
                    const accepted = registry.get(outcome.value);
                    if (name !== 0 && accepted?.remote)
                    {
                        writeSockaddr(host.writeMemory, name, accepted.remote);
                        if (lengthPointer !== 0)
                        {
                            writeDword(lengthPointer, SOCKADDR_IN_SIZE);
                        }
                    }
                    return ok(outcome.value);
                });
            },
        },

        send: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([handle, buffer, length])=>{
                const socket = socketOf(handle);
                if (!socket)
                {
                    return fail(WSAENOTSOCK);
                }
                const bytes = host.readMemory(buffer >>> 0, length >>> 0);
                const outcome = registry.send(socket, bytes);
                return outcome.error ? fail(outcome.error) : ok(outcome.value);
            },
        },

        recv: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([handle, buffer, length])=>{
                const socket = socketOf(handle);
                if (!socket)
                {
                    return fail(WSAENOTSOCK);
                }
                const wanted = length >>> 0;
                // A game polls its socket in the loop that waits for a frame:
                // nothing there on a socket that does not block is answered
                // before anything is made to wait with.
                const first = registry.receive(socket, wanted);
                if (first.error === WSAEWOULDBLOCK && socket.nonBlocking)
                {
                    return fail(WSAEWOULDBLOCK);
                }
                return receiveInto(socket, wanted, buffer, 0, 0, first);
            },
        },

        sendto: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([handle, buffer, length, , name])=>{
                const socket = socketOf(handle);
                if (!socket)
                {
                    return fail(WSAENOTSOCK);
                }
                const target = name === 0 ? null : readSockaddr(host.readMemory, name);
                if (name !== 0 && !target)
                {
                    return fail(WSAEFAULT);
                }
                const bytes = host.readMemory(buffer >>> 0, length >>> 0);
                const outcome = registry.send(socket, bytes, target);
                return outcome.error ? fail(outcome.error) : ok(outcome.value);
            },
        },

        recvfrom: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([handle, buffer, length, , name, lengthPointer])=>{
                const socket = socketOf(handle);
                if (!socket)
                {
                    return fail(WSAENOTSOCK);
                }
                const wanted = length >>> 0;
                // A game polls its socket in the loop that waits for a frame:
                // nothing there on a socket that does not block is answered
                // before anything is made to wait with.
                const first = registry.receive(socket, wanted);
                if (first.error === WSAEWOULDBLOCK && socket.nonBlocking)
                {
                    return fail(WSAEWOULDBLOCK);
                }
                return receiveInto(socket, wanted, buffer, name, lengthPointer, first);
            },
        },

        shutdown: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, how])=>{
                const socket = socketOf(handle);
                if (!socket)
                {
                    return fail(WSAENOTSOCK);
                }
                const outcome = registry.shutdown(socket, how);
                return outcome.error ? fail(outcome.error) : ok(0);
            },
        },

        getsockname: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, name, lengthPointer])=>{
                const socket = socketOf(handle);
                if (!socket)
                {
                    return fail(WSAENOTSOCK);
                }
                writeSockaddr(host.writeMemory, name, socket.local);
                if (lengthPointer !== 0)
                {
                    writeDword(lengthPointer, SOCKADDR_IN_SIZE);
                }
                return ok(0);
            },
        },

        getpeername: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, name, lengthPointer])=>{
                const socket = socketOf(handle);
                if (!socket)
                {
                    return fail(WSAENOTSOCK);
                }
                if (!socket.remote)
                {
                    return fail(WSAEINVAL);
                }
                writeSockaddr(host.writeMemory, name, socket.remote);
                if (lengthPointer !== 0)
                {
                    writeDword(lengthPointer, SOCKADDR_IN_SIZE);
                }
                return ok(0);
            },
        },

        setsockopt: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([handle, , option, value, length])=>{
                const socket = socketOf(handle);
                if (!socket)
                {
                    return fail(WSAENOTSOCK);
                }
                registry.writeOption(socket, option,
                    value !== 0 && length >= 4 ? readDword(value) : 0);
                return ok(0);
            },
        },

        getsockopt: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([handle, level, option, value, lengthPointer])=>{
                const socket = socketOf(handle);
                if (!socket)
                {
                    return fail(WSAENOTSOCK);
                }
                if (value === 0)
                {
                    return fail(WSAEFAULT);
                }
                const answer = level === SOL_SOCKET && option === SO_TYPE
                    ? socket.type
                    : registry.readOption(socket, option);
                writeDword(value, answer);
                if (lengthPointer !== 0)
                {
                    writeDword(lengthPointer, 4);
                }
                return ok(0);
            },
        },

        ioctlsocket: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, command, argument])=>ioctl(handle, command, argument),
        },

        /**
         * int WSAIoctl(SOCKET s, DWORD dwIoControlCode, LPVOID lpvInBuffer,
         *              DWORD cbInBuffer, LPVOID lpvOutBuffer, DWORD cbOutBuffer,
         *              LPDWORD lpcbBytesReturned, LPWSAOVERLAPPED lpOverlapped,
         *              LPWSAOVERLAPPED_COMPLETION_ROUTINE lpCompletionRoutine)
         *
         * The two commands ioctlsocket takes, in the buffered form: FIONBIO
         * reads its flag from the input buffer, FIONREAD writes its count to
         * the output one. SIO_GET_EXTENSION_FUNCTION_POINTER answers a GUID
         * mswsock.h names with the address of mswsock's export of that
         * function, as the provider does; a GUID it does not know is
         * WSAEINVAL, and with no mswsock to point into, the lookup is refused
         * as a stack without the extensions refuses it.
         */
        WSAIoctl: {
            argBytes: 36,
            /** @param {number[]} args */
            handler: ([handle, command, input, inputSize, output, outputSize, returned])=>{
                if (!socketOf(handle))
                {
                    return fail(WSAENOTSOCK);
                }
                if ((command >>> 0) === SIO_GET_EXTENSION_FUNCTION_POINTER)
                {
                    if (!host.extension)
                    {
                        return fail(WSAEOPNOTSUPP);
                    }
                    if ((inputSize >>> 0) < 16 || (input >>> 0) === 0
                        || (outputSize >>> 0) < 4 || (output >>> 0) === 0)
                    {
                        return fail(WSAEFAULT);
                    }
                    const name = EXTENSION_GUIDS[
                        /** @type {keyof typeof EXTENSION_GUIDS} */ (
                            guidText(host.readMemory(input >>> 0, 16)))];
                    if (!name)
                    {
                        return fail(WSAEINVAL);
                    }
                    const answer = (/** @type {number} */ address)=>{
                        if (address === 0)
                        {
                            return fail(WSAEINVAL);
                        }
                        writeDword(output, address);
                        if ((returned >>> 0) !== 0)
                        {
                            writeDword(returned, 4);
                        }
                        return ok(0);
                    };
                    const address = host.extension(name);
                    return address instanceof Promise ? address.then(answer) : answer(address);
                }
                if ((command >>> 0) === FIONBIO)
                {
                    return ioctl(handle, command, input);
                }
                const socket = /** @type {any} */ (socketOf(handle));
                /** An out-buffer answer of `bytes`, its size in `returned`. @param {Uint8Array} bytes */
                const answerWith = bytes=>{
                    if ((output >>> 0) === 0 || (outputSize >>> 0) < bytes.length)
                    {
                        if ((returned >>> 0) !== 0)
                        {
                            writeDword(returned, bytes.length);
                        }
                        return fail(WSAEFAULT);
                    }
                    host.writeMemory(output >>> 0, bytes);
                    if ((returned >>> 0) !== 0)
                    {
                        writeDword(returned, bytes.length);
                    }
                    return ok(0);
                };
                switch (command >>> 0)
                {
                    // A datagram socket's: an ICMP unreachable or expired TTL
                    // reported to the next receive, or not. No ICMP reaches a
                    // socket here, so the choice is kept and changes nothing.
                    case SIO_UDP_CONNRESET:
                    case SIO_UDP_NETRESET:
                        if (isStream(socket))
                        {
                            return fail(WSAEINVAL);
                        }
                        if ((inputSize >>> 0) < 4 || (input >>> 0) === 0)
                        {
                            return fail(WSAEFAULT);
                        }
                        return ok(0);
                    // A stream socket's keep-alive timing (struct tcp_keepalive)
                    // and its loopback fast path: kept, with nothing to time or
                    // to shorten -- the relay keeps the real connection alive.
                    case SIO_KEEPALIVE_VALS:
                    case SIO_LOOPBACK_FAST_PATH:
                        if (!isStream(socket))
                        {
                            return fail(WSAEOPNOTSUPP);
                        }
                        if ((input >>> 0) === 0 || (inputSize >>> 0)
                            < ((command >>> 0) === SIO_KEEPALIVE_VALS ? 12 : 4))
                        {
                            return fail(WSAEFAULT);
                        }
                        return ok(0);
                    // No layered provider sits over the base one: the socket is
                    // its own base.
                    case SIO_BASE_HANDLE: {
                        const bytes = new Uint8Array(4);
                        new DataView(bytes.buffer).setUint32(0, handle >>> 0, true);
                        return answerWith(bytes);
                    }
                    // SOCKET_ADDRESS_LIST of the machine's one address: a count,
                    // a SOCKET_ADDRESS (pointer, length), then the sockaddr_in
                    // it points at, in the same buffer.
                    case SIO_ADDRESS_LIST_QUERY: {
                        const bytes = new Uint8Array(12 + SOCKADDR_IN_SIZE);
                        const view = new DataView(bytes.buffer);
                        view.setUint32(0, 1, true);
                        view.setUint32(4, ((output >>> 0) + 12) >>> 0, true);
                        view.setInt32(8, SOCKADDR_IN_SIZE, true);
                        const address = new Uint8Array(SOCKADDR_IN_SIZE);
                        writeSockaddr((/** @type {number} */ at, /** @type {Uint8Array} */ data)=>
                            address.set(data, at), 0,
                        { host: registry.localAddress(), port: 0 });
                        bytes.set(address, 12);
                        return answerWith(bytes);
                    }
                    // The local address a datagram to the destination would
                    // leave from: the machine's one address.
                    case SIO_ROUTING_INTERFACE_QUERY: {
                        if ((input >>> 0) === 0 || (inputSize >>> 0) < SOCKADDR_IN_SIZE)
                        {
                            return fail(WSAEFAULT);
                        }
                        const address = new Uint8Array(SOCKADDR_IN_SIZE);
                        writeSockaddr((/** @type {number} */ at, /** @type {Uint8Array} */ data)=>
                            address.set(data, at), 0,
                        { host: registry.localAddress(), port: 0 });
                        return answerWith(address);
                    }
                    default:
                        break;
                }
                if ((command >>> 0) === FIONREAD)
                {
                    if ((outputSize >>> 0) < 4)
                    {
                        return fail(WSAEFAULT);
                    }
                    const result = ioctl(handle, command, output);
                    if (result === 0 && returned !== 0)
                    {
                        writeDword(returned, 4);
                    }
                    return result;
                }
                return fail(WSAEINVAL);
            },
        },


        select: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([, readPointer, writePointer, exceptPointer, timeout])=>{
                const gather3 = (/** @type {number} */ pointer)=>{
                    const handles = readFdSet(pointer);
                    return handles.map(socketOf);
                };
                const read = gather3(readPointer);
                const write = gather3(writePointer);
                const except = gather3(exceptPointer);
                if ([...read, ...write, ...except].some(socket=>!socket))
                {
                    return fail(WSAENOTSOCK);
                }
                // WSAAsyncSelect/WSAEventSelect and select() are two ways of
                // asking the same question, and Winsock refuses to answer
                // both at once for one socket.
                if ([...read, ...write, ...except].some(notifying))
                {
                    return fail(WSAEINVAL);
                }

                const answer = ()=>{
                    const ready = registry.poll(read, write, except);
                    if (!writeFdSet(readPointer, ready.read)
                        || !writeFdSet(writePointer, ready.write)
                        || !writeFdSet(exceptPointer, ready.except))
                    {
                        return fail(WSAEFAULT);
                    }
                    return ok(ready.read.length + ready.write.length + ready.except.length);
                };

                const ready = registry.poll(read, write, except);
                const total = ready.read.length + ready.write.length + ready.except.length;
                if (total > 0)
                {
                    return answer();
                }

                // A timeval of NULL means wait forever; anything else, including
                // a zero timeout, is a poll that has already been answered.
                if (timeout !== 0)
                {
                    const seconds = readDword(timeout);
                    const micro = readDword((timeout >>> 0) + 4);
                    const milliseconds = seconds * 1000 + Math.floor(micro / 1000);
                    if (milliseconds === 0)
                    {
                        return answer();
                    }
                    return registry.anyReadableSoon(read, milliseconds).then(answer);
                }
                return registry.anyReadableSoon(read, null).then(answer);
            },
        },

        __WSAFDIsSet: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, pointer])=>
                readFdSet(pointer).includes(handle >>> 0) ? 1 : 0,
        },

        /**
         * int WSAAsyncSelect(SOCKET s, HWND hWnd, u_int wMsg, long lEvent)
         *
         * Puts the socket in non-blocking mode and arms it to post `wMsg` to
         * `hWnd` for each event in `lEvent`; a fresh registration replaces
         * whatever was armed before, and reports at once whatever in the new
         * mask is already true -- there being no other moment such a thing
         * would otherwise be noticed. `lEvent = 0` cancels.
         */
        WSAAsyncSelect: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([handle, hwnd, msg, mask])=>{
                const socket = socketOf(handle);
                if (!socket)
                {
                    return fail(WSAENOTSOCK);
                }
                socket.nonBlocking = true;
                socket.eventSelect = null;
                const bits = mask >>> 0;
                if (bits === 0)
                {
                    socket.asyncSelect = null;
                    return ok(0);
                }
                socket.asyncSelect = {
                    hwnd: hwnd >>> 0, msg: msg >>> 0, mask: bits,
                    readArmed: true, acceptArmed: true, writeSent: false, closeSent: false,
                };
                watch(socket);
                pumpSelection(socket);
                return ok(0);
            },
        },

        /**
         * int WSAEventSelect(SOCKET s, WSAEVENT hEventObject, long lNetworkEvents)
         *
         * The same arming, over a kernel event instead of a window message:
         * every event in the mask sets a bit in an accumulator that
         * WSAEnumNetworkEvents reads and clears, and signals `hEventObject`
         * each time a new bit is set. Also non-blocking, and replaces
         * whatever WSAAsyncSelect had armed -- the two are one notification
         * mechanism with two ways of collecting it, never both at once.
         */
        WSAEventSelect: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, hEvent, mask])=>{
                const socket = socketOf(handle);
                if (!socket)
                {
                    return fail(WSAENOTSOCK);
                }
                socket.nonBlocking = true;
                socket.asyncSelect = null;
                const bits = mask >>> 0;
                if (bits === 0)
                {
                    socket.eventSelect = null;
                    return ok(0);
                }
                socket.eventSelect = {
                    handle: hEvent >>> 0, mask: bits, pending: 0,
                    errors: new Array(FD_MAX_EVENTS).fill(0),
                    readArmed: true, acceptArmed: true, writeSent: false, closeSent: false,
                };
                watch(socket);
                pumpSelection(socket);
                return ok(0);
            },
        },

        /**
         * int WSAEnumNetworkEvents(SOCKET s, WSAEVENT hEventObject,
         *                           LPWSANETWORKEVENTS lpNetworkEvents)
         *
         * Reports lNetworkEvents and iErrorCode[FD_MAX_EVENTS] as they stand
         * and clears both -- the accumulator exists so nothing is lost
         * between one enum call and the next, never so the same bit is read
         * twice -- and resets hEventObject, as documented. Left signalled, a
         * manual-reset event answers every wait at once and a network thread
         * waiting on it spins.
         */
        WSAEnumNetworkEvents: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, hEvent, eventsPointer])=>{
                const socket = socketOf(handle);
                if (!socket)
                {
                    return fail(WSAENOTSOCK);
                }
                if (eventsPointer === 0)
                {
                    return fail(WSAEFAULT);
                }
                if ((hEvent >>> 0) !== 0)
                {
                    host.kernel32?.('ResetEvent')?.([hEvent >>> 0]);
                }
                const armed = socket.eventSelect;
                const pending = armed ? armed.pending : 0;
                writeDword(eventsPointer, pending);
                for (let bit = 0; bit < FD_MAX_EVENTS; bit++)
                {
                    const error = armed && (pending & (1 << bit)) ? armed.errors[bit] : 0;
                    writeDword((eventsPointer >>> 0) + 4 + bit * 4, error);
                }
                if (armed)
                {
                    armed.pending = 0;
                    armed.errors.fill(0);
                }
                return ok(0);
            },
        },

        htons: { argBytes: 4, handler: (/** @type {number[]} */ [value])=>swap16(value) },
        ntohs: { argBytes: 4, handler: (/** @type {number[]} */ [value])=>swap16(value) },
        htonl: { argBytes: 4, handler: (/** @type {number[]} */ [value])=>swap32(value) },
        ntohl: { argBytes: 4, handler: (/** @type {number[]} */ [value])=>swap32(value) },

        inet_addr: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([pointer])=>{
                if (pointer === 0)
                {
                    return INADDR_NONE;
                }
                const host32 = parseAddress(host.readCString(pointer >>> 0, 64));
                // The answer is in network order, because it goes straight into
                // a sockaddr without passing through htonl.
                return host32 === INADDR_NONE ? INADDR_NONE : swap32(host32);
            },
        },

        inet_ntoa: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([value])=>{
                const buffer = staticBuffer('inet_ntoa', 16);
                host.writeMemory(buffer, sz(formatAddress(swap32(value))));
                return buffer >>> 0;
            },
        },

        gethostname: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([buffer, length])=>{
                if (buffer === 0 || length < HOSTNAME.length + 1)
                {
                    return fail(WSAEFAULT);
                }
                host.writeMemory(buffer >>> 0, sz(HOSTNAME));
                return ok(0);
            },
        },

        /**
         * Resolution.
         *
         * The names this host can answer for itself -- its own, localhost, and
         * anything already written as an address -- are answered here and
         * without a round trip. Anything else is the transport's, and only if it
         * has a resolver at all: without one the call fails with
         * WSAHOST_NOT_FOUND rather than being pointed at the loopback, because a
         * program told a name resolved will connect to it and fail somewhere
         * further away with less to go on.
         */
        gethostbyname: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([pointer])=>{
                const name = pointer === 0 ? HOSTNAME : host.readCString(pointer >>> 0, 256);
                const literal = parseAddress(name);
                const known = name === HOSTNAME || name === 'localhost';
                if (literal !== INADDR_NONE || known)
                {
                    return writeHostent(
                        name, literal === INADDR_NONE ? INADDR_LOOPBACK : literal);
                }
                const asked = registry.resolve(name);
                if (!asked)
                {
                    return fail(WSAHOST_NOT_FOUND, 0);
                }
                return asked.then((/** @type {number[]} */ found)=>found.length === 0
                    ? fail(WSAHOST_NOT_FOUND, 0)
                    : writeHostent(name, found[0]));
            },
        },

        /**
         * struct hostent* gethostbyaddr(const char *addr, int len, int type)
         *
         * The reverse of gethostbyname for the one address this host answers
         * for without a resolver: the loopback, which Windows names with the
         * machine's own name. Any other address is not found.
         */
        gethostbyaddr: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([pointer, length, type])=>{
                if (pointer === 0 || (length | 0) < 4)
                {
                    return fail(WSAEFAULT, 0);
                }
                if ((type | 0) !== AF_INET)
                {
                    return fail(WSAEAFNOSUPPORT, 0);
                }
                const bytes = host.readMemory(pointer >>> 0, 4);
                const address = (bytes[0] << 24 | bytes[1] << 16 | bytes[2] << 8 | bytes[3]) >>> 0;
                return address === INADDR_LOOPBACK
                    ? writeHostent(HOSTNAME, address) : fail(WSAHOST_NOT_FOUND, 0);
            },
        },

        /**
         * struct servent* getservbyname(const char *name, const char *proto)
         *
         * A service `SERVICES` lists, its port in network order, in the one
         * buffer this library keeps for it, valid until the next call. A name
         * it does not list, or a protocol it is not listed for, is not found.
         */
        getservbyname: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([namePointer, protoPointer])=>{
                if (namePointer === 0)
                {
                    return fail(WSAEFAULT, 0);
                }
                const name = host.readCString(namePointer >>> 0, 64).toLowerCase();
                const proto = protoOf(protoPointer);
                const found = SERVICES.find(([service, , protocols])=>service === name
                    && (proto === null || protocols.includes(proto)));
                return found ? writeServent(found, proto) : fail(WSANO_DATA, 0);
            },
        },

        /**
         * struct servent* getservbyport(int port, const char *proto)
         *
         * getservbyname's lookup the other way: the port comes in network
         * order, in the low half of the int, and the answer shares the same
         * buffer -- one call overwrites what the other returned.
         */
        getservbyport: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([port, protoPointer])=>{
                const wanted = (port & 0xff) << 8 | port >>> 8 & 0xff;
                const proto = protoOf(protoPointer);
                const found = SERVICES.find(([, own, protocols])=>own === wanted
                    && (proto === null || protocols.includes(proto)));
                return found ? writeServent(found, proto) : fail(WSANO_DATA, 0);
            },
        },

        /**
         * HANDLE WSAAsyncGetHostByName(HWND hWnd, u_int wMsg, const char *name,
         *                               char *buf, int buflen)
         *
         * Returns a task handle at once and answers later, always -- even a
         * name this host can resolve without a round trip is still reported
         * through the posted message, because that is the only place a
         * caller is told the buffer is ready. The hostent is written into
         * the caller's own buffer, with every pointer inside it fixed up to
         * that buffer, since this answer does not get to live in the shared
         * one gethostbyname reuses across calls.
         */
        WSAAsyncGetHostByName: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([hwnd, msg, namePointer, buf, buflen])=>{
                const missing = needStarted();
                if (missing !== null)
                {
                    return fail(missing, 0);
                }
                const task = nextAsyncTask++;
                asyncTasks.set(task, { cancelled: false });
                const name = namePointer === 0
                    ? HOSTNAME : host.readCString(namePointer >>> 0, 256);

                const deliver = (/** @type {number} */ error)=>{
                    const record = asyncTasks.get(task);
                    asyncTasks.delete(task);
                    if (!record || record.cancelled)
                    {
                        return;
                    }
                    post({
                        hwnd: hwnd >>> 0, message: msg >>> 0, wParam: task >>> 0,
                        lParam: ((buflen & 0xffff) | ((error & 0xffff) << 16)) >>> 0,
                    });
                };
                const answer = (/** @type {number} */ error, /** @type {number} */ address)=>{
                    if (error !== 0)
                    {
                        deliver(error);
                        return;
                    }
                    if (buf === 0 || (buflen >>> 0) < HOSTENT_BLOCK_SIZE)
                    {
                        deliver(WSAEFAULT);
                        return;
                    }
                    writeHostentAt(buf >>> 0, name, address);
                    deliver(0);
                };

                Promise.resolve().then(()=>{
                    const literal = parseAddress(name);
                    const known = name === HOSTNAME || name === 'localhost';
                    if (literal !== INADDR_NONE || known)
                    {
                        answer(0, literal === INADDR_NONE ? INADDR_LOOPBACK : literal);
                        return;
                    }
                    const asked = registry.resolve(name);
                    if (!asked)
                    {
                        answer(WSAHOST_NOT_FOUND, 0);
                        return;
                    }
                    asked.then((/** @type {number[]} */ found)=>answer(
                        found.length === 0 ? WSAHOST_NOT_FOUND : 0, found[0]));
                });

                return task >>> 0;
            },
        },

        /**
         * BOOL WSACancelAsyncRequest(HANDLE hAsyncTaskHandle)
         *
         * Only WSAAsyncGetHostByName ever hands out a task handle here, so
         * this is only ever cancelling that -- a request already answered or
         * never issued is WSAEINVAL, matching what a stale handle means
         * everywhere else on this surface.
         */
        WSACancelAsyncRequest: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([task])=>{
                const record = asyncTasks.get(task >>> 0);
                if (!record)
                {
                    return fail(WSAEINVAL);
                }
                record.cancelled = true;
                return ok(0);
            },
        },

        /**
         * The overlapped calls.
         *
         * Everything the completion needs is taken at the call. One that
         * finishes at once completes at once -- its counts written, its
         * WSAOVERLAPPED filled in and its event signalled, as Windows does for
         * a call that did not have to wait. One that would wait answers
         * WSA_IO_PENDING and completes in its WSAOVERLAPPED when the bytes
         * arrive, signalling its event then; WSAGetOverlappedResult reads it.
         * A completion routine is refused (`noRoutine`), and so is a
         * completion port: there is no CreateIoCompletionPort to post to.
         */

        /**
         * int WSARecv(SOCKET s, LPWSABUF lpBuffers, DWORD dwBufferCount,
         *   LPDWORD lpNumberOfBytesRecvd, LPDWORD lpFlags,
         *   LPWSAOVERLAPPED lpOverlapped, LPWSAOVERLAPPED_COMPLETION_ROUTINE)
         */
        WSARecv: {
            argBytes: 28,
            /** @param {number[]} args */
            handler: ([handle, buffers, count, received, flags, overlapped, routine])=>
                receiveCall({ handle, buffers, count, received, flags, from: 0, fromLength: 0,
                    overlapped, routine }, 'WSARecv'),
        },

        /**
         * int WSARecvFrom(SOCKET s, LPWSABUF lpBuffers, DWORD dwBufferCount,
         *   LPDWORD lpNumberOfBytesRecvd, LPDWORD lpFlags, struct sockaddr *lpFrom,
         *   LPINT lpFromlen, LPWSAOVERLAPPED lpOverlapped,
         *   LPWSAOVERLAPPED_COMPLETION_ROUTINE lpCompletionRoutine)
         *
         * WSARecv with the sender's address, written with the bytes: a
         * length that cannot hold a sockaddr_in is WSAEFAULT before anything
         * is read.
         */
        WSARecvFrom: {
            argBytes: 36,
            /** @param {number[]} args */
            handler: ([handle, buffers, count, received, flags, from, fromLength, overlapped,
                routine])=>receiveCall({
                handle, buffers, count, received, flags, from, fromLength, overlapped, routine,
            }, 'WSARecvFrom'),
        },

        /**
         * int WSASend(SOCKET s, LPWSABUF lpBuffers, DWORD dwBufferCount,
         *   LPDWORD lpNumberOfBytesSent, DWORD dwFlags, LPWSAOVERLAPPED lpOverlapped,
         *   LPWSAOVERLAPPED_COMPLETION_ROUTINE lpCompletionRoutine)
         */
        WSASend: {
            argBytes: 28,
            /** @param {number[]} args */
            handler: ([handle, buffers, count, sent, , overlapped, routine])=>sendCall({
                handle, buffers, count, sent, to: 0, toLength: 0, overlapped, routine,
            }, 'WSASend'),
        },

        /**
         * int WSASendTo(SOCKET s, LPWSABUF lpBuffers, DWORD dwBufferCount,
         *   LPDWORD lpNumberOfBytesSent, DWORD dwFlags, const struct sockaddr *lpTo,
         *   int iTolen, LPWSAOVERLAPPED lpOverlapped,
         *   LPWSAOVERLAPPED_COMPLETION_ROUTINE lpCompletionRoutine)
         *
         * sendto over a WSABUF array. A stream socket goes to its peer
         * whatever address it is given, as sendto's does.
         */
        WSASendTo: {
            argBytes: 36,
            /** @param {number[]} args */
            handler: ([handle, buffers, count, sent, , to, toLength, overlapped, routine])=>
                sendCall({ handle, buffers, count, sent, to, toLength, overlapped, routine },
                    'WSASendTo'),
        },

        /**
         * BOOL WSAGetOverlappedResult(SOCKET s, LPWSAOVERLAPPED lpOverlapped,
         *   LPDWORD lpcbTransfer, BOOL fWait, LPDWORD lpdwFlags)
         *
         * What an overlapped operation came to: its byte count and TRUE, or
         * FALSE with the reason it failed. Still pending, it is
         * WSA_IO_INCOMPLETE -- or, with fWait, the answer once it completes.
         */
        WSAGetOverlappedResult: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([handle, overlapped, transferred, wait, flags])=>{
                if (!socketOf(handle))
                {
                    return fail(WSAENOTSOCK, 0);
                }
                if ((overlapped >>> 0) === 0 || (transferred >>> 0) === 0)
                {
                    return fail(WSAEFAULT, 0);
                }
                const at = overlapped >>> 0;
                const report = ()=>{
                    const status = readDword(at + WSAOVERLAPPED.Internal);
                    writeDword(transferred, readDword(at + WSAOVERLAPPED.InternalHigh));
                    if ((flags >>> 0) !== 0)
                    {
                        writeDword(flags, NO_FLAGS);
                    }
                    const error = failures.get(at) ?? (status === STATUS_SUCCESS ? 0 : WSAEINVAL);
                    return error === 0 ? 1 : fail(error, 0);
                };
                if (readDword(at + WSAOVERLAPPED.Internal) !== STATUS_PENDING)
                {
                    return report();
                }
                const waiting = inFlight.get(at);
                if (wait === 0 || !waiting)
                {
                    return fail(WSA_IO_INCOMPLETE, 0);
                }
                return waiting.then(report);
            },
        },

        /**
         * The event calls. A WSAEVENT is a manual-reset kernel event, so
         * these are CreateEvent, CloseHandle, SetEvent, ResetEvent and
         * WaitForMultipleObjectsEx under other names -- an event made here is
         * one WaitForSingleObject waits on, and one WSAEventSelect signals --
         * with the kernel's reason for a failure carried into this library's
         * slot.
         */

        /** WSAEVENT WSACreateEvent(void): manual reset, not signalled, unnamed. */
        WSACreateEvent: overKernel('WSACreateEvent', 0,
            { answer: 0, lastError: WSA_NOT_ENOUGH_MEMORY }, ()=>{
                const event = kernel('CreateEventA')([0, 1, 0, 0]) >>> 0;
                return event === 0 ? kernelFailure(0, WSA_NOT_ENOUGH_MEMORY) : event;
            }),

        /** BOOL WSACloseEvent(WSAEVENT hEvent) */
        WSACloseEvent: overKernel('WSACloseEvent', 4,
            { answer: 0, lastError: WSA_INVALID_HANDLE },
            ([event])=>(kernel('CloseHandle')([event]) !== 0
                ? 1 : kernelFailure(0, WSA_INVALID_HANDLE))),

        /** BOOL WSASetEvent(WSAEVENT hEvent) */
        WSASetEvent: overKernel('WSASetEvent', 4,
            { answer: 0, lastError: WSA_INVALID_HANDLE },
            ([event])=>(kernel('SetEvent')([event]) !== 0
                ? 1 : kernelFailure(0, WSA_INVALID_HANDLE))),

        /** BOOL WSAResetEvent(WSAEVENT hEvent) */
        WSAResetEvent: overKernel('WSAResetEvent', 4,
            { answer: 0, lastError: WSA_INVALID_HANDLE },
            ([event])=>(kernel('ResetEvent')([event]) !== 0
                ? 1 : kernelFailure(0, WSA_INVALID_HANDLE))),

        /**
         * DWORD WSAWaitForMultipleEvents(DWORD cEvents, const WSAEVENT *lphEvents,
         *   BOOL fWaitAll, DWORD dwTimeout, BOOL fAlertable)
         *
         * WaitForMultipleObjectsEx with the same five arguments: the answers
         * -- WSA_WAIT_EVENT_0 + n, WSA_WAIT_TIMEOUT, WSA_WAIT_IO_COMPLETION --
         * are the kernel's under other names. No events, or more than
         * WSA_MAXIMUM_WAIT_EVENTS, is WSA_INVALID_PARAMETER.
         */
        WSAWaitForMultipleEvents: overKernel('WSAWaitForMultipleEvents', 20,
            { answer: WSA_WAIT_FAILED, lastError: WSA_INVALID_PARAMETER },
            ([count, events, waitAll, timeout, alertable])=>{
                const total = count >>> 0;
                if (total === 0 || total > WSA_MAXIMUM_WAIT_EVENTS || (events >>> 0) === 0)
                {
                    return fail(WSA_INVALID_PARAMETER, WSA_WAIT_FAILED);
                }
                const settle = (/** @type {number} */ result)=>((result >>> 0) === WSA_WAIT_FAILED
                    ? kernelFailure(WSA_WAIT_FAILED, WSA_INVALID_HANDLE) : result >>> 0);
                const result = kernel('WaitForMultipleObjectsEx')(
                    [total, events, waitAll, timeout, alertable]);
                return result instanceof Promise ? result.then(settle) : settle(result);
            }),

        /**
         * int WSAConnect(SOCKET s, const struct sockaddr *name, int namelen,
         *   LPWSABUF lpCallerData, LPWSABUF lpCalleeData, LPQOS lpSQOS, LPQOS lpGQOS)
         *
         * connect: TCP/IP carries no connect data and grants no quality of
         * service, so the caller's data is not sent and the callee's comes
         * back empty.
         */
        WSAConnect: {
            argBytes: 28,
            /** @param {number[]} args */
            handler: ([handle, name, length, , calleeData])=>{
                if ((calleeData >>> 0) !== 0 && socketOf(handle))
                {
                    writeDword(calleeData, 0);
                }
                return connectCall(handle, name, length);
            },
        },

        /**
         * SOCKET WSASocketA(int af, int type, int protocol,
         *   LPWSAPROTOCOL_INFOA lpProtocolInfo, GROUP g, DWORD dwFlags)
         *
         * socket, with FROM_PROTOCOL_INFO taken from the description the
         * caller passed. Every socket here takes overlapped calls, so
         * WSA_FLAG_OVERLAPPED changes nothing; a socket group is not one
         * this stack forms.
         */
        WSASocketA: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([family, type, protocol, info, group])=>{
                void protocol;
                if ((group >>> 0) !== 0)
                {
                    return fail(WSAEINVAL, INVALID_SOCKET);
                }
                const described = (/** @type {number} */ value, /** @type {number} */ offset)=>
                    ((value | 0) === FROM_PROTOCOL_INFO && (info >>> 0) !== 0
                        ? readDword((info >>> 0) + offset) : value);
                return createSocket(described(family, WSAPROTOCOL_INFO.iAddressFamily),
                    described(type, WSAPROTOCOL_INFO.iSocketType));
            },
        },

        /** SOCKET WSASocketW: WSASocketA, the description read the same up to its name. */
        WSASocketW: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: args=>table.WSASocketA.handler(args),
        },

        /**
         * int WSASendMsg(SOCKET Handle, LPWSAMSG lpMsg, DWORD dwFlags,
         *   LPDWORD lpNumberOfBytesSent, LPWSAOVERLAPPED lpOverlapped,
         *   LPWSAOVERLAPPED_COMPLETION_ROUTINE lpCompletionRoutine)
         *
         * WSASendTo with its arguments in a WSAMSG: name, namelen, the
         * WSABUF array and its count, the control data and the flags. The
         * control data is ancillary information TCP/IP has no use for here
         * (no option it would set is carried by the relay), so it is not sent.
         */
        WSASendMsg: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([handle, message, , sent, overlapped, routine])=>{
                if ((message >>> 0) === 0)
                {
                    return fail(WSAEFAULT);
                }
                const at = message >>> 0;
                return sendCall({ handle, buffers: readDword(at + 8), count: readDword(at + 12),
                    sent, to: readDword(at), toLength: readDword(at + 4), overlapped, routine },
                'WSASendMsg');
            },
        },

        /**
         * INT inet_pton(INT Family, PCSTR pszAddrString, PVOID pAddrBuf)
         *
         * 1 with the address written in network order, 0 for text that is
         * not one, -1 with WSAEAFNOSUPPORT for a family other than the two.
         */
        inet_pton: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([family, text, out])=>{
                if ((text >>> 0) === 0 || (out >>> 0) === 0)
                {
                    return fail(WSAEFAULT);
                }
                if (family !== AF_INET && family !== AF_INET6)
                {
                    return fail(WSAEAFNOSUPPORT);
                }
                const string = host.readCString(text >>> 0, 64);
                const bytes = family === AF_INET ? parseIpv4Text(string) : parseIpv6Text(string);
                if (!bytes)
                {
                    return 0;
                }
                host.writeMemory(out >>> 0, bytes);
                return 1;
            },
        },

        /**
         * PCSTR inet_ntop(INT Family, const VOID *pAddr, PSTR pStringBuf,
         *   size_t StringBufSize)
         *
         * The buffer, or NULL: WSAEAFNOSUPPORT for another family,
         * ERROR_INVALID_PARAMETER for no buffer or one too short for the text
         * and its terminator.
         */
        inet_ntop: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([family, address, buffer, size])=>{
                if (family !== AF_INET && family !== AF_INET6)
                {
                    return fail(WSAEAFNOSUPPORT, 0);
                }
                if ((address >>> 0) === 0 || (buffer >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER, 0);
                }
                const bytes = host.readMemory(address >>> 0, family === AF_INET ? 4 : 16);
                const text = family === AF_INET ? [...bytes].join('.') : formatIpv6Text(bytes);
                if ((size >>> 0) < text.length + 1)
                {
                    return fail(ERROR_INVALID_PARAMETER, 0);
                }
                host.writeMemory(buffer >>> 0, sz(text));
                return buffer >>> 0;
            },
        },

        /**
         * int WSADuplicateSocketW(SOCKET s, DWORD dwProcessId,
         *   LPWSAPROTOCOL_INFOW lpProtocolInfo)
         *
         * A socket is this process's registry's alone; no other process can
         * be handed it, so the duplicate is refused as for a process it
         * cannot go to.
         */
        WSADuplicateSocketW: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, , info])=>{
                if (!socketOf(handle))
                {
                    return fail(WSAENOTSOCK);
                }
                if ((info >>> 0) === 0)
                {
                    return fail(WSAEFAULT);
                }
                host.divergence?.('WSADuplicateSocketW',
                    'a socket cannot be shared with another process');
                return fail(WSAEINVAL);
            },
        },

        /**
         * int WSCEnumProtocols(LPINT lpiProtocols, LPWSAPROTOCOL_INFOW lpProtocolBuffer,
         *   LPDWORD lpdwBufferLength, LPINT lpErrno)
         *
         * The catalogue: MSAFD's TCP and UDP, or those of them the protocol
         * list names. Too little room is WSAENOBUFS with the length needed.
         */
        WSCEnumProtocols: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([protocols, buffer, length, errno])=>enumProtocols(protocols, buffer,
                length, true, code=>{
                    if ((errno >>> 0) !== 0)
                    {
                        writeDword(errno, code);
                    }
                    return SOCKET_ERROR;
                }),
        },

        /** int WSAEnumProtocolsA(LPINT, LPWSAPROTOCOL_INFOA, LPDWORD): the catalogue, narrow. */
        WSAEnumProtocolsA: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([protocols, buffer, length])=>(needStarted()
                ? fail(WSANOTINITIALISED)
                : enumProtocols(protocols, buffer, length, false, code=>fail(code))),
        },

        /** int WSAEnumProtocolsW(LPINT, LPWSAPROTOCOL_INFOW, LPDWORD): the catalogue, wide. */
        WSAEnumProtocolsW: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([protocols, buffer, length])=>(needStarted()
                ? fail(WSANOTINITIALISED)
                : enumProtocols(protocols, buffer, length, true, code=>fail(code))),
        },

        /**
         * int WSCGetProviderPath(LPGUID lpProviderId, WCHAR *lpszProviderDllPath,
         *   LPINT lpProviderDllPathLen, LPINT lpErrno)
         *
         * MSAFD's library, as the catalogue keeps it -- unexpanded. Its
         * length counts the terminator; short of it, WSAEFAULT with the
         * length needed. Another provider is WSAEINVAL.
         */
        WSCGetProviderPath: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([guid, path, length, errno])=>{
                const refuseWith = (/** @type {number} */ code)=>{
                    if ((errno >>> 0) !== 0)
                    {
                        writeDword(errno, code);
                    }
                    return SOCKET_ERROR;
                };
                if ((guid >>> 0) === 0 || (length >>> 0) === 0)
                {
                    return refuseWith(WSAEFAULT);
                }
                const id = host.readMemory(guid >>> 0, 16);
                if (!id.every((byte, index)=>byte === MSAFD_TCPIP[index]))
                {
                    return refuseWith(WSAEINVAL);
                }
                if ((path >>> 0) === 0 || readDword(length) < MSAFD_PATH.length + 1)
                {
                    writeDword(length, MSAFD_PATH.length + 1);
                    return refuseWith(WSAEFAULT);
                }
                host.writeMemory(path >>> 0, wide(MSAFD_PATH));
                writeDword(length, MSAFD_PATH.length + 1);
                return 0;
            },
        },

        /**
         * The name space calls. No name space provider is installed here --
         * names resolve through getaddrinfo and the relay, not a provider a
         * program can query -- so the list is empty and every lookup finds
         * no service.
         */

        /** INT WSAEnumNameSpaceProvidersW(LPDWORD lpdwBufferLength, LPWSANAMESPACE_INFOW) */
        WSAEnumNameSpaceProvidersW: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([length])=>{
                if (needStarted())
                {
                    return fail(WSANOTINITIALISED);
                }
                if ((length >>> 0) === 0)
                {
                    return fail(WSAEFAULT);
                }
                return 0;
            },
        },

        /** INT WSALookupServiceBeginW(LPWSAQUERYSETW, DWORD dwControlFlags, LPHANDLE) */
        WSALookupServiceBeginW: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([query, , out])=>{
                if (needStarted())
                {
                    return fail(WSANOTINITIALISED);
                }
                if ((query >>> 0) === 0 || (out >>> 0) === 0)
                {
                    return fail(WSAEFAULT);
                }
                return fail(WSASERVICE_NOT_FOUND);
            },
        },

        /** INT WSALookupServiceNextW(HANDLE, DWORD, LPDWORD, LPWSAQUERYSETW): no lookup was begun. */
        WSALookupServiceNextW: { argBytes: 16, handler: ()=>fail(WSA_INVALID_HANDLE) },

        /** INT WSALookupServiceEnd(HANDLE hLookup): no lookup was begun. */
        WSALookupServiceEnd: { argBytes: 4, handler: ()=>fail(WSA_INVALID_HANDLE) },

        /** INT WSASetServiceW(LPWSAQUERYSETW, WSAESETSERVICEOP, DWORD): no provider takes it. */
        WSASetServiceW: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([query])=>{
                if (needStarted())
                {
                    return fail(WSANOTINITIALISED);
                }
                return fail((query >>> 0) === 0 ? WSAEFAULT : WSASERVICE_NOT_FOUND);
            },
        },

        /**
         * int getaddrinfo(PCSTR pNodeName, PCSTR pServiceName,
         *   const ADDRINFOA *pHints, PADDRINFOA *ppResult)
         *
         * gethostbyname's resolution, as a list of ADDRINFOA in guest memory
         * -- IPv4 alone, as on a Windows XP without the IPv6 stack installed.
         * No node is the loopback, or "any" with AI_PASSIVE; a service is a
         * port number or a name from the services file. The answer is the
         * error code itself (zero for success), which the error slot holds
         * too; a failure leaves the result NULL.
         */
        getaddrinfo: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([nodePointer, servicePointer, hintsPointer, result])=>{
                if ((result >>> 0) !== 0)
                {
                    writeDword(result, 0);
                }
                if (!started)
                {
                    return eai(WSANOTINITIALISED);
                }
                if ((result >>> 0) === 0)
                {
                    return eai(WSAEINVAL);
                }
                if ((nodePointer >>> 0) === 0 && (servicePointer >>> 0) === 0)
                {
                    return eai(WSAHOST_NOT_FOUND);
                }
                let flags = 0;
                let family = AF_UNSPEC;
                let socktype = 0;
                let protocol = 0;
                if ((hintsPointer >>> 0) !== 0)
                {
                    const hints = new DataView(
                        host.readMemory(hintsPointer >>> 0, ADDRINFO.SIZE).slice().buffer);
                    flags = hints.getInt32(ADDRINFO.ai_flags, true);
                    family = hints.getInt32(ADDRINFO.ai_family, true);
                    socktype = hints.getInt32(ADDRINFO.ai_socktype, true);
                    protocol = hints.getInt32(ADDRINFO.ai_protocol, true);
                    // A hint's other members are documented to be zero.
                    if ([ADDRINFO.ai_addrlen, ADDRINFO.ai_canonname, ADDRINFO.ai_addr,
                        ADDRINFO.ai_next].some(at=>hints.getUint32(at, true) !== 0))
                    {
                        return eai(WSANO_RECOVERY);
                    }
                }
                if ((flags & ~(AI_PASSIVE | AI_CANONNAME | AI_NUMERICHOST)) !== 0
                    || ((flags & AI_CANONNAME) !== 0 && (nodePointer >>> 0) === 0))
                {
                    return eai(WSAEINVAL);
                }
                if (family !== AF_UNSPEC && family !== AF_INET)
                {
                    return eai(WSAEAFNOSUPPORT);
                }
                if (![0, SOCK_STREAM, SOCK_DGRAM, SOCK_RAW, SOCK_RDM, SOCK_SEQPACKET]
                    .includes(socktype))
                {
                    return eai(WSAESOCKTNOSUPPORT);
                }

                let port = 0;
                if ((servicePointer >>> 0) !== 0)
                {
                    const service = host.readCString(servicePointer >>> 0, 64);
                    if (/^\d+$/.test(service))
                    {
                        port = Number(service);
                        if (port > 0xffff)
                        {
                            return eai(WSATYPE_NOT_FOUND);
                        }
                    }
                    else
                    {
                        const proto = socktype === SOCK_STREAM ? 'tcp'
                            : socktype === SOCK_DGRAM ? 'udp' : null;
                        const found = SERVICES.find(([name, , protocols])=>
                            name === service.toLowerCase()
                            && (proto === null || protocols.includes(proto)));
                        if (!found)
                        {
                            return eai(WSATYPE_NOT_FOUND);
                        }
                        port = found[1];
                    }
                }

                const shape = { socktype, protocol };
                const reply = (/** @type {number[]} */ addresses, /** @type {string | null} */ name)=>{
                    const list = writeAddrinfo(addresses, port, shape,
                        (flags & AI_CANONNAME) !== 0 ? name : null);
                    if (list === 0)
                    {
                        return eai(WSA_NOT_ENOUGH_MEMORY);
                    }
                    writeDword(result, list);
                    return 0;
                };
                if ((nodePointer >>> 0) === 0)
                {
                    return reply([(flags & AI_PASSIVE) !== 0 ? INADDR_ANY : INADDR_LOOPBACK], null);
                }
                const name = host.readCString(nodePointer >>> 0, 256);
                const numeric = parseAddress(name) !== INADDR_NONE
                    || name.trim() === '255.255.255.255';
                if ((flags & AI_NUMERICHOST) !== 0 && !numeric)
                {
                    return eai(WSAHOST_NOT_FOUND);
                }
                const local = resolveLocally(name);
                if (local !== null)
                {
                    return reply([local], name);
                }
                const asked = registry.resolve(name);
                if (!asked)
                {
                    return eai(WSAHOST_NOT_FOUND);
                }
                return asked.then((/** @type {number[]} */ found)=>(found.length === 0
                    ? eai(WSAHOST_NOT_FOUND) : reply(found, name)));
            },
        },

        /**
         * void freeaddrinfo(PADDRINFOA pAddrInfo)
         *
         * Frees the chain from the node given to its end, a node at a time,
         * as getaddrinfo made them. A pointer it did not make is left alone.
         */
        freeaddrinfo: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([list])=>{
                let node = list >>> 0;
                while (node !== 0 && addrinfoNodes.has(node))
                {
                    const next = readDword(node + ADDRINFO.ai_next);
                    addrinfoNodes.delete(node);
                    host.heap.free?.(node);
                    node = next;
                }
                return 0;
            },
        },

        /**
         * int getnameinfo(const struct sockaddr *sa, socklen_t salen, char *host,
         *   DWORD hostlen, char *serv, DWORD servlen, int flags)
         *
         * gethostbyaddr's reverse lookup and getservbyname's table, the other
         * way round: the loopback is this machine's name and any other
         * address is its own dotted form -- or, with NI_NAMEREQD, not found.
         * A port the services file names is that name, any other its number.
         */
        getnameinfo: {
            argBytes: 28,
            /** @param {number[]} args */
            handler: ([pointer, length, hostOut, hostLength, servOut, servLength, flags])=>{
                if (!started)
                {
                    return eai(WSANOTINITIALISED);
                }
                if ((pointer >>> 0) === 0)
                {
                    return eai(WSAEFAULT);
                }
                const address = /** @type {{ family: number, host: number, port: number }} */ (
                    readSockaddr(host.readMemory, pointer >>> 0));
                if (address.family !== AF_INET)
                {
                    return eai(WSAEAFNOSUPPORT);
                }
                if ((length | 0) < SOCKADDR_IN_SIZE)
                {
                    return eai(WSAEFAULT);
                }
                const wantHost = (hostOut >>> 0) !== 0 && (hostLength >>> 0) !== 0;
                const wantService = (servOut >>> 0) !== 0 && (servLength >>> 0) !== 0;
                if (!wantHost && !wantService)
                {
                    return eai(WSAHOST_NOT_FOUND);
                }
                /** @type {Uint8Array | null} */
                let hostText = null;
                if (wantHost)
                {
                    const reversed = address.host === INADDR_LOOPBACK
                        && (flags & NI_NUMERICHOST) === 0;
                    if (!reversed && (flags & (NI_NUMERICHOST | NI_NAMEREQD)) === NI_NAMEREQD)
                    {
                        return eai(WSAHOST_NOT_FOUND);
                    }
                    hostText = sz(reversed ? HOSTNAME : formatAddress(address.host));
                }
                /** @type {Uint8Array | null} */
                let serviceText = null;
                if (wantService)
                {
                    const proto = (flags & NI_DGRAM) !== 0 ? 'udp' : 'tcp';
                    const found = (flags & NI_NUMERICSERV) === 0
                        ? SERVICES.find(([, port, protocols])=>port === address.port
                            && protocols.includes(proto))
                        : undefined;
                    serviceText = sz(found ? found[0] : String(address.port));
                }
                if ((hostText && hostText.length > (hostLength >>> 0))
                    || (serviceText && serviceText.length > (servLength >>> 0)))
                {
                    return eai(WSAEFAULT);
                }
                if (hostText)
                {
                    host.writeMemory(hostOut >>> 0, hostText);
                }
                if (serviceText)
                {
                    host.writeMemory(servOut >>> 0, serviceText);
                }
                return 0;
            },
        },

        /**
         * struct protoent* getprotobyname(const char *name)
         * struct protoent* getprotobynumber(int number)
         *
         * A protocol the protocol file lists, by its name or its alias in any
         * case, or by its number, in the one buffer this library keeps for
         * it. One it does not list is WSANO_DATA and NULL.
         */
        getprotobyname: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([pointer])=>{
                if ((pointer >>> 0) === 0)
                {
                    return fail(WSAEFAULT, 0);
                }
                const name = host.readCString(pointer >>> 0, 64).toLowerCase();
                const found = PROTOCOLS.find(([own, , alias])=>own === name
                    || alias.toLowerCase() === name);
                return found ? writeProtoent(found) : fail(WSANO_DATA, 0);
            },
        },

        getprotobynumber: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([number])=>{
                const found = PROTOCOLS.find(([, own])=>own === (number | 0));
                return found ? writeProtoent(found) : fail(WSANO_DATA, 0);
            },
        },

        /**
         * BOOL TransmitFile(SOCKET hSocket, HANDLE hFile, DWORD nNumberOfBytesToWrite,
         *   DWORD nNumberOfBytesPerSend, LPOVERLAPPED lpOverlapped,
         *   LPTRANSMIT_FILE_BUFFERS lpTransmitBuffers, DWORD dwReserved)
         *
         * The head, the file from where its position stands -- all of it, or
         * the count asked for -- and the tail, sent as one; read through
         * ReadFile, so a file is whatever kernel32 opened. TF_DISCONNECT shuts
         * the connection down after. An overlapped call completes at once,
         * as every send here does.
         */
        TransmitFile: overKernel('TransmitFile', 28, { answer: 0, lastError: WSAEOPNOTSUPP },
            ([handle, file, total, , overlapped, buffers, flags])=>{
                const socket = socketOf(handle);
                if (!socket)
                {
                    return fail(WSAENOTSOCK, 0);
                }
                const how = flags >>> 0;
                if ((how & TF_REUSE_SOCKET) !== 0 && (how & TF_DISCONNECT) === 0)
                {
                    return fail(WSAEINVAL, 0);
                }
                /** @param {number} at @param {number} bytes */
                const taken = (at, bytes)=>(at === 0 || bytes === 0
                    ? new Uint8Array(0) : host.readMemory(at, bytes).slice());
                const extra = (buffers >>> 0) === 0 ? null : {
                    head: taken(readDword(buffers), readDword((buffers >>> 0) + 4)),
                    tail: taken(readDword((buffers >>> 0) + 8), readDword((buffers >>> 0) + 12)),
                };
                const event = (overlapped >>> 0) === 0 ? 0 : eventOf(overlapped >>> 0);
                const wanted = total >>> 0;
                const scratch = (file >>> 0) === 0 ? 0
                    : host.heap.allocate(TRANSMIT_CHUNK + 4) >>> 0;
                if ((file >>> 0) !== 0 && scratch === 0)
                {
                    return fail(WSA_NOT_ENOUGH_MEMORY, 0);
                }
                /** @type {Uint8Array[]} */
                const parts = extra ? [extra.head] : [];
                let read = 0;

                /** @param {boolean} failed  Whether the file could not be read. */
                const finish = failed=>{
                    if (scratch !== 0)
                    {
                        host.heap.free?.(scratch);
                    }
                    if (failed)
                    {
                        return kernelFailure(0, WSA_INVALID_HANDLE);
                    }
                    if (extra)
                    {
                        parts.push(extra.tail);
                    }
                    const body = new Uint8Array(parts.reduce((sum, part)=>sum + part.length, 0));
                    let at = 0;
                    for (const part of parts)
                    {
                        body.set(part, at);
                        at += part.length;
                    }
                    const outcome = registry.send(socket, body);
                    if (outcome.error)
                    {
                        return fail(outcome.error, 0);
                    }
                    if ((how & TF_DISCONNECT) !== 0)
                    {
                        registry.shutdown(socket, SD_BOTH);
                    }
                    if ((overlapped >>> 0) !== 0)
                    {
                        complete(overlapped >>> 0, event, { error: 0, bytes: outcome.value });
                    }
                    return 1;
                };

                /**
                 * What one ReadFile came to: the call's answer once the file
                 * is done with, or null to read on.
                 *
                 * @param {number} succeeded
                 */
                const took = succeeded=>{
                    if (succeeded === 0)
                    {
                        return finish(true);
                    }
                    const got = readDword(scratch + TRANSMIT_CHUNK);
                    if (got === 0)
                    {
                        return finish(false);
                    }
                    parts.push(host.readMemory(scratch, got).slice());
                    read += got;
                    return wanted !== 0 && read >= wanted ? finish(false) : null;
                };

                /** @returns {number | Promise<number>} */
                const pump = ()=>{
                    for (;;)
                    {
                        const ask = wanted === 0 ? TRANSMIT_CHUNK
                            : Math.min(TRANSMIT_CHUNK, wanted - read);
                        const result = kernel('ReadFile')(
                            [file, scratch, ask, scratch + TRANSMIT_CHUNK, 0]);
                        if (result instanceof Promise)
                        {
                            return result.then(value=>took(value) ?? pump());
                        }
                        const verdict = took(result);
                        if (verdict !== null)
                        {
                            return verdict;
                        }
                    }
                };
                return (file >>> 0) === 0 ? finish(false) : pump();
            }),
    };

    /** The extensions, which a program reaches by name through GetProcAddress. */
    const extensions = {
        AcceptEx: {
            argBytes: 32,
            /** @param {number[]} args */
            handler: ([listenHandle, acceptHandle])=>{
                const listener = socketOf(listenHandle);
                const accepting = socketOf(acceptHandle);
                if (!listener || !accepting)
                {
                    return fail(WSAENOTSOCK, 0);
                }
                const outcome = registry.accept(listener);
                if (outcome.error)
                {
                    return fail(outcome.error === WSAEWOULDBLOCK
                        ? WSA_IO_PENDING : outcome.error, 0);
                }
                // The caller supplied the socket the connection is to arrive on,
                // so what accept produced is folded onto it rather than handed
                // back: AcceptEx has no return value that could carry a handle.
                const ready = registry.get(outcome.value);
                accepting.local = ready.local;
                accepting.remote = ready.remote;
                accepting.connected = true;
                accepting.peer = ready.peer;
                if (ready.peer)
                {
                    ready.peer.peer = accepting;
                }
                accepting.rx = ready.rx;
                // Detached before it is closed. Closing a stream socket tells
                // its peer the connection is finished, and this one still names
                // the client -- so leaving it attached would greet a client with
                // its own connection hanging up the instant it was accepted.
                ready.peer = null;
                registry.close(ready);
                return 1;
            },
        },

        GetAcceptExSockaddrs: {
            argBytes: 32,
            /** @param {number[]} args */
            handler: ([, , , , , , localOut, remoteOut])=>{
                // The addresses live in the buffer AcceptEx was given, which we
                // never wrote into, so there is nothing honest to report here.
                if (localOut !== 0)
                {
                    writeDword(localOut, 0);
                }
                if (remoteOut !== 0)
                {
                    writeDword(remoteOut, 0);
                }
                return 0;
            },
        },

        ConnectEx: {
            argBytes: 28,
            /** @param {number[]} args */
            handler: ([handle, name, length])=>{
                const socket = socketOf(handle);
                if (!socket)
                {
                    return fail(WSAENOTSOCK, 0);
                }
                if (length < SOCKADDR_IN_SIZE)
                {
                    return fail(WSAEFAULT, 0);
                }
                const address = readSockaddr(host.readMemory, name);
                if (!address)
                {
                    return fail(WSAEFAULT, 0);
                }
                const settle = (/** @type {any} */ outcome)=>{
                    notifyConnect(socket, outcome);
                    return outcome.error ? fail(outcome.error, 0) : 1;
                };
                const outcome = registry.connect(socket, address);
                return outcome instanceof Promise ? outcome.then(settle) : settle(outcome);
            },
        },

        DisconnectEx: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([handle])=>{
                const socket = socketOf(handle);
                if (!socket)
                {
                    return fail(WSAENOTSOCK, 0);
                }
                registry.shutdown(socket, 2);
                return 1;
            },
        },
    };

    /**
     * The ordinals that actually resolve.
     *
     * The tables in constants.js record what each number *is*, including entries
     * this does not implement -- that is reference data and worth keeping. What
     * a module may export is the intersection with what exists, computed rather
     * than maintained: an ordinal exported to a guest and pointing at nothing is
     * a call that binds and then jumps into nowhere, with no name anywhere in
     * the import table to say what it was.
     *
     * @param {Record<number, string>} all @param {Record<string, unknown>} [exported]
     */
    const resolvable = (all, exported = table)=>Object.freeze(Object.fromEntries(
        Object.entries(all).filter(([, name])=>name in exported)));

    return {
        /** wsock32 and ws2_32 both export these, over one registry. */
        sockets: table,
        /** mswsock's, reached by name rather than through an import table. */
        extensions,
        /** Which ordinal is which name, for whoever synthesises the module. */
        ordinals: {
            wsock32: resolvable(WSOCK32_ORDINALS, { ...table, ...extensions }),
            ws2_32: resolvable(WS2_32_ORDINALS),
        },
        diagnostics: ()=>({ started, ...registry.diagnostics() }),
    };
}
