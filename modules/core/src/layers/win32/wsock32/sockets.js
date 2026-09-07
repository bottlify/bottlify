/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a socket is, underneath the calls that operate on one.
 *
 * Nothing here knows about guest memory, argument lists or return codes. It
 * deals in sockets, addresses and bytes, and it answers in outcomes -- a count,
 * or an error number -- which is what lets the surface above be a translation
 * and nothing more, and what lets all of this be tested without an emulator.
 *
 * Four properties are load-bearing and each one is a defect that has happened:
 *
 * A stream has no message boundaries. Bytes go into a queue of whatever chunks
 * arrived and come out in whatever amount was asked for, spanning chunks. A
 * reader that gets one send() per recv() is a reader that will break the first
 * time the sender coalesces.
 *
 * A datagram does have boundaries, and one recvfrom yields exactly one, however
 * much room the caller offered. A buffer too small truncates and reports
 * WSAEMSGSIZE rather than keeping the remainder for next time.
 *
 * A peer hanging up has to arrive. When one end closes, the other's next read
 * of an empty queue returns zero rather than waiting forever, and anything
 * already parked on that queue is woken to see it. A close that only unbinds an
 * address leaves the other side blocked for the rest of the run.
 *
 * Streams and datagrams live in separate address spaces. They really do share
 * port numbers independently, and a discovery datagram arriving in a stream is
 * both wrong and a way for one protocol to corrupt the other.
 */

import {
    INADDR_ANY, INADDR_LOOPBACK, SD_BOTH, SD_RECEIVE, SD_SEND, SOCK_DGRAM, SOCK_STREAM,
    SO_ERROR, WSAEADDRINUSE, WSAECONNREFUSED, WSAECONNRESET, WSAEINVAL, WSAEISCONN,
    WSAENOTCONN, WSAENOTSOCK, WSAEOPNOTSUPP, WSAEWOULDBLOCK,
} from './constants.js';
import { addressKey } from './sockaddr.js';

/** Where an unbound socket's port comes from. The range Windows uses. */
const EPHEMERAL_FIRST = 49152;
const EPHEMERAL_LAST = 65535;

/** An outcome that is a failure, so a count and an error cannot be confused. */
const failure = (/** @type {number} */ error)=>({ error });

/** An outcome that is a count. */
const count = (/** @type {number} */ value)=>({ value });

/**
 * @param {Object} deps
 * @param {import('./loopback.js').Adapter} deps.adapter
 * @returns {any}
 */
export function createSocketRegistry({ adapter }){
    /** @type {Map<number, any>} */
    const sockets = new Map();
    let nextHandle = 1;
    let nextPort = EPHEMERAL_FIRST;

    /**
     * Everything waiting on this socket becoming readable runs and is forgotten.
     * Waking is never conditional: a waiter re-checks for itself, because the
     * condition it waited on may have been taken by whoever woke first.
     *
     * @param {any} socket
     */
    const wake = socket=>{
        const waiters = socket.waiters;
        socket.waiters = [];
        for (const waiter of waiters)
        {
            waiter();
        }
    };

    /** @param {any} socket */
    const isStream = socket=>socket.type === SOCK_STREAM;

    /**
     * One host, so binding to "any interface" and binding to the loopback
     * address name the same place. Normalising here rather than at each call
     * site is what stops a server on 0.0.0.0 being unreachable at 127.0.0.1.
     *
     * @param {{ host: number, port: number }} address
     */
    const normalise = address=>({
        host: address.host === INADDR_ANY ? INADDR_LOOPBACK : address.host >>> 0,
        port: address.port & 0xffff,
    });

    /** @param {any} socket */
    const claimPort = socket=>{
        for (let tried = 0; tried <= EPHEMERAL_LAST - EPHEMERAL_FIRST; tried++)
        {
            const port = nextPort;
            nextPort = nextPort >= EPHEMERAL_LAST ? EPHEMERAL_FIRST : nextPort + 1;
            const address = { host: INADDR_LOOPBACK, port };
            if (adapter.bind(addressKey(isStream(socket), address), socket))
            {
                socket.local = address;
                socket.bound = true;
                return true;
            }
        }
        return false;
    };

    /** How many bytes are queued, whatever shape the queue is. */
    const queued = (/** @type {any} */ socket)=>isStream(socket)
        ? socket.rx.reduce(
            (/** @type {number} */ total, /** @type {Uint8Array} */ chunk)=>
                total + chunk.length, 0)
        : socket.rx.reduce(
            (/** @type {number} */ total, /** @type {any} */ datagram)=>
                total + datagram.bytes.length, 0);

    /** @param {any} socket */
    const readable = socket=>socket.rx.length > 0
        || socket.backlog.length > 0
        || socket.finished
        || socket.closed;

    /**
     * Takes up to `length` bytes off a stream, across as many arrived chunks as
     * it takes. The remainder of a partly-consumed chunk stays at the front.
     *
     * @param {any} socket @param {number} length
     */
    const takeStream = (socket, length)=>{
        const parts = [];
        let taken = 0;
        while (taken < length && socket.rx.length > 0)
        {
            const chunk = socket.rx[0];
            const wanted = Math.min(length - taken, chunk.length);
            parts.push(chunk.subarray(0, wanted));
            taken += wanted;
            if (wanted === chunk.length)
            {
                socket.rx.shift();
            }
            else
            {
                socket.rx[0] = chunk.subarray(wanted);
            }
        }
        const out = new Uint8Array(taken);
        let at = 0;
        for (const part of parts)
        {
            out.set(part, at);
            at += part.length;
        }
        return out;
    };

    /**
     * Tells a stream's peer that this end will send nothing more.
     *
     * The flag goes on the *peer*, because it is the peer's reads that have to
     * start returning zero, and the peer is woken so that a read already parked
     * on an empty queue learns it rather than waiting for bytes that are never
     * coming.
     *
     * @param {any} socket
     */
    const finish = socket=>{
        const peer = socket.peer;
        if (!peer)
        {
            return;
        }
        peer.finished = true;
        wake(peer);
    };

    const api = {
        /** @param {number} handle */
        get(handle){
            return sockets.get(handle >>> 0) ?? null;
        },

        /** @param {number} handle */
        isValid: handle=>sockets.has(handle >>> 0),

        /** @param {number} family @param {number} type */
        create(family, type){
            if (type !== SOCK_STREAM && type !== SOCK_DGRAM)
            {
                return failure(WSAEOPNOTSUPP);
            }
            const handle = nextHandle++;
            sockets.set(handle, {
                handle,
                family,
                type,
                local: { host: INADDR_ANY, port: 0 },
                remote: null,
                bound: false,
                listening: false,
                connected: false,
                closed: false,
                // Set when the peer has sent everything it will send. A read of
                // an empty queue then returns zero rather than blocking.
                finished: false,
                nonBlocking: false,
                peer: null,
                /** @type {any[]} */
                rx: [],
                /** @type {any[]} */
                backlog: [],
                /** @type {(() => void)[]} */
                waiters: [],
                /** @type {Map<number, number>} */
                options: new Map(),
                error: 0,
                /** Overlapped operations with nowhere to report completion yet. */
                pending: [],
            });
            return count(handle);
        },

        /** @param {any} socket @param {{ host: number, port: number }} address */
        bind(socket, address){
            if (socket.bound)
            {
                return failure(WSAEINVAL);
            }
            const wanted = normalise(address);
            if (wanted.port === 0)
            {
                return claimPort(socket) ? count(0) : failure(WSAEADDRINUSE);
            }
            if (!adapter.bind(addressKey(isStream(socket), wanted), socket))
            {
                return failure(WSAEADDRINUSE);
            }
            socket.local = wanted;
            socket.bound = true;
            return count(0);
        },

        /** @param {any} socket */
        listen(socket){
            if (!isStream(socket))
            {
                return failure(WSAEOPNOTSUPP);
            }
            if (!socket.bound && !claimPort(socket))
            {
                return failure(WSAEADDRINUSE);
            }
            socket.listening = true;
            return count(0);
        },

        /**
         * Connects, which for a datagram socket only records a default
         * destination -- that is what connect() means on UDP, and it also makes
         * plain send/recv legal on it afterwards.
         *
         * @param {any} socket @param {{ host: number, port: number }} address
         */
        connect(socket, address){
            const wanted = normalise(address);
            if (!isStream(socket))
            {
                socket.remote = wanted;
                socket.connected = true;
                if (!socket.bound && !claimPort(socket))
                {
                    return failure(WSAEADDRINUSE);
                }
                return count(0);
            }
            if (socket.connected)
            {
                return failure(WSAEISCONN);
            }

            const listener = adapter.find(addressKey(true, wanted));
            if (!listener || !listener.listening || listener.closed)
            {
                // Nothing is listening there. Recorded for SO_ERROR as well as
                // returned, because a caller that used a non-blocking connect
                // reads it there rather than from the failing call.
                socket.error = WSAECONNREFUSED;
                return failure(WSAECONNREFUSED);
            }
            if (!socket.bound && !claimPort(socket))
            {
                return failure(WSAEADDRINUSE);
            }

            // The accepted end exists from the moment the connection does, not
            // from the moment accept() gets round to it: bytes the client sends
            // immediately have to land somewhere.
            const accepted = /** @type {any} */ (api.create(socket.family, SOCK_STREAM));
            const server = sockets.get(accepted.value);
            server.local = listener.local;
            server.remote = socket.local;
            server.connected = true;
            server.peer = socket;

            socket.remote = wanted;
            socket.connected = true;
            socket.peer = server;

            listener.backlog.push(server);
            wake(listener);
            return count(0);
        },

        /** @param {any} socket */
        accept(socket){
            if (!socket.listening)
            {
                return failure(WSAEINVAL);
            }
            if (socket.backlog.length === 0)
            {
                return failure(WSAEWOULDBLOCK);
            }
            return count(socket.backlog.shift().handle);
        },

        /**
         * @param {any} socket @param {Uint8Array} bytes
         * @param {{ host: number, port: number } | null} [to]
         */
        send(socket, bytes, to = null){
            if (socket.closed)
            {
                return failure(WSAENOTSOCK);
            }
            if (isStream(socket))
            {
                if (!socket.connected || !socket.peer)
                {
                    return failure(WSAENOTCONN);
                }
                if (socket.peer.closed || socket.sentFin)
                {
                    return failure(WSAECONNRESET);
                }
                // Copied, not referenced: the guest owns the buffer it handed us
                // and is free to overwrite it the instant this returns.
                socket.peer.rx.push(bytes.slice());
                wake(socket.peer);
                return count(bytes.length);
            }

            const target = to ?? socket.remote;
            if (!target)
            {
                return failure(WSAENOTCONN);
            }
            if (!socket.bound && !claimPort(socket))
            {
                return failure(WSAEADDRINUSE);
            }
            const peer = adapter.find(addressKey(false, normalise(target)));
            if (peer && !peer.closed)
            {
                peer.rx.push({ from: socket.local, bytes: bytes.slice() });
                wake(peer);
            }
            // A datagram to nobody is not an error. That is what "unreliable"
            // means, and a sender that treated it as one would be wrong about
            // every real network too.
            return count(bytes.length);
        },

        /**
         * @param {any} socket @param {number} length
         * @returns {{ error: number } | { value: number, bytes: Uint8Array,
         *            from?: { host: number, port: number }, truncated?: boolean }}
         */
        receive(socket, length){
            if (socket.closed)
            {
                return failure(WSAENOTSOCK);
            }
            if (isStream(socket))
            {
                if (!socket.connected)
                {
                    return failure(WSAENOTCONN);
                }
                if (socket.rx.length > 0)
                {
                    const bytes = takeStream(socket, length);
                    return { value: bytes.length, bytes };
                }
                // Nothing queued and the peer has finished: end of stream, which
                // is a zero-length read and not an error.
                if (socket.finished)
                {
                    return { value: 0, bytes: new Uint8Array(0) };
                }
                return failure(WSAEWOULDBLOCK);
            }

            if (socket.rx.length === 0)
            {
                return failure(WSAEWOULDBLOCK);
            }
            const datagram = socket.rx.shift();
            const bytes = datagram.bytes.subarray(0, length);
            return {
                value: bytes.length,
                bytes,
                from: datagram.from,
                // The rest of the datagram is dropped, not kept: a datagram is
                // delivered once, whole or not at all.
                truncated: datagram.bytes.length > length,
            };
        },

        /** @param {any} socket @param {number} how */
        shutdown(socket, how){
            if (!isStream(socket) || !socket.connected)
            {
                return failure(WSAENOTCONN);
            }
            if (how === SD_SEND || how === SD_BOTH)
            {
                socket.sentFin = true;
                finish(socket);
            }
            if (how === SD_RECEIVE || how === SD_BOTH)
            {
                socket.rx = [];
            }
            return count(0);
        },

        /** @param {any} socket */
        close(socket){
            if (socket.closed)
            {
                return failure(WSAENOTSOCK);
            }
            socket.closed = true;
            if (socket.bound)
            {
                adapter.unbind(addressKey(isStream(socket), socket.local));
            }
            // Anything the listener never accepted is closed with it, and each
            // of those has a client on the other end waiting to hear so.
            for (const waiting of socket.backlog)
            {
                waiting.closed = true;
                finish(waiting);
            }
            socket.backlog = [];
            finish(socket);
            wake(socket);
            sockets.delete(socket.handle);
            return count(0);
        },

        /**
         * A promise that settles when this socket has something to report --
         * bytes, a connection to accept, or a peer that has gone.
         *
         * @param {any} socket
         * @returns {Promise<void>}
         */
        readableSoon(socket){
            if (readable(socket))
            {
                return Promise.resolve();
            }
            return new Promise(resolve=>socket.waiters.push(resolve));
        },

        /**
         * The first of these sockets to become readable.
         *
         * Every waiter is removed once one has fired. Leaving them attached is
         * how a later, unrelated wake-up runs a callback belonging to a call
         * that returned long ago -- and in select's case writes an fd_set into
         * a buffer the program has since reused.
         *
         * @param {any[]} watched
         * @param {number | null} timeoutMs
         * @returns {Promise<void>}
         */
        anyReadableSoon(watched, timeoutMs){
            if (watched.some(readable))
            {
                return Promise.resolve();
            }
            return new Promise(resolve=>{
                let settled = false;
                /** @type {any} */
                let timer = null;
                const detach = ()=>{
                    for (const socket of watched)
                    {
                        socket.waiters = socket.waiters.filter(
                            (/** @type {any} */ waiter)=>waiter !== fire);
                    }
                };
                const fire = ()=>{
                    if (settled)
                    {
                        return;
                    }
                    settled = true;
                    if (timer !== null)
                    {
                        clearTimeout(timer);
                    }
                    detach();
                    resolve();
                };
                for (const socket of watched)
                {
                    socket.waiters.push(fire);
                }
                if (timeoutMs !== null)
                {
                    timer = setTimeout(fire, timeoutMs);
                }
            });
        },

        /**
         * Which of these are ready. Writability is unconditional here: a send
         * always takes the whole buffer, so a stream socket is never blocked on
         * one, and saying otherwise would park a caller forever.
         *
         * @param {any[]} read @param {any[]} write @param {any[]} except
         */
        poll(read, write, except){
            return {
                read: read.filter(readable),
                write: write.filter(socket=>!socket.closed
                    && (socket.connected || !isStream(socket))),
                except: except.filter(socket=>socket.error !== 0),
            };
        },

        /** @param {any} socket */
        available: socket=>queued(socket),

        /**
         * SO_ERROR is documented to clear itself, and frameworks depend on it:
         * the code is read once after the call that failed, and a second read
         * has to say there is no error now.
         *
         * @param {any} socket @param {number} option
         */
        readOption(socket, option){
            if (option === SO_ERROR)
            {
                const held = socket.error;
                socket.error = 0;
                return held;
            }
            return socket.options.get(option) ?? 0;
        },

        /** @param {any} socket @param {number} option @param {number} value */
        writeOption(socket, option, value){
            socket.options.set(option, value >>> 0);
        },

        /** Every socket, for diagnostics and for closing them all at once. */
        all: ()=>[...sockets.values()],

        diagnostics: ()=>({
            open: sockets.size,
            listening: [...sockets.values()].filter(socket=>socket.listening).length,
            connected: [...sockets.values()].filter(socket=>socket.connected).length,
        }),
    };

    return api;
}
