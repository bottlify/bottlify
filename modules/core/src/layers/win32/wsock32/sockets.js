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
 *
 * Reaching anything outside this runtime goes through the transport contract in
 * transport.js. The routing rule is one line -- an address this runtime holds is
 * served here, anything else is the transport's -- and it is what keeps a
 * single-tab run free of every cost of being networked. Everything a transport
 * delivers is appended to the same queues local delivery uses, so the calls
 * above cannot tell the two apart and do not try.
 */

import {
    INADDR_ANY, SD_BOTH, SD_RECEIVE, SD_SEND, SOCK_DGRAM, SOCK_STREAM,
    SO_ERROR, WSAEADDRINUSE, WSAECONNREFUSED, WSAECONNRESET, WSAEINVAL, WSAEISCONN,
    WSAENOTCONN, WSAENOTSOCK, WSAEOPNOTSUPP, WSAEWOULDBLOCK,
} from './constants.js';
import { addressKey } from './sockaddr.js';
import { TRANSPORT_LOST, asNetwork } from './transport.js';

/** Where an unbound socket's port comes from. The range Windows uses. */
const EPHEMERAL_FIRST = 49152;
const EPHEMERAL_LAST = 65535;

/** An outcome that is a failure, so a count and an error cannot be confused. */
const failure = (/** @type {number} */ error)=>({ error });

/** An outcome that is a count. */
const count = (/** @type {number} */ value)=>({ value });

/**
 * @param {Object} deps
 * @param {import('./loopback.js').Adapter
 *         | import('./transport.js').NetworkTransport} [deps.adapter]
 * @returns {any}
 */
export function createSocketRegistry({ adapter: supplied } = {}){
    const { adapter, transport } = asNetwork(supplied);

    /** @type {Map<number, any>} */
    const sockets = new Map();
    /** Remote streams by the id this runtime gave them. */
    const streams = new Map();
    let nextHandle = 1;
    let nextStream = 1;
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
     * The one address this runtime answers to. Offline that is the loopback;
     * with a transport it is whatever the network gave us, so a guest that
     * publishes its own address publishes one a peer can reach.
     */
    const self = ()=>transport.localAddress() >>> 0;

    /**
     * Every way of naming this machine. The whole of 127/8 is the loopback and
     * programs do use more of it than 127.0.0.1; "any interface" is this one,
     * there being only one; and the address the transport gave us is us too.
     *
     * @param {number} host
     */
    const isSelf = host=>host === INADDR_ANY || (host >>> 24) === 127 || host === self();

    /**
     * One host, so every name for this machine binds and resolves to the same
     * place. Collapsing them here rather than at each call site is what stops a
     * server on 0.0.0.0 being unreachable at 127.0.0.1 -- and, once there is a
     * transport, what stops a peer's view of us and our own view of us being two
     * different address keys holding two different sockets.
     *
     * @param {{ host: number, port: number }} address
     */
    const normalise = address=>({
        host: isSelf(address.host) ? self() : address.host >>> 0,
        port: address.port & 0xffff,
    });

    /** Whether this runtime serves that address itself. Normalised addresses only. */
    const mine = (/** @type {{ host: number }} */ address)=>address.host === self();

    /** @param {any} socket */
    const claimPort = socket=>{
        for (let tried = 0; tried <= EPHEMERAL_LAST - EPHEMERAL_FIRST; tried++)
        {
            const port = nextPort;
            nextPort = nextPort >= EPHEMERAL_LAST ? EPHEMERAL_FIRST : nextPort + 1;
            const address = { host: self(), port };
            if (adapter.bind(addressKey(isStream(socket), address), socket))
            {
                socket.local = address;
                socket.bound = true;
                // A datagram socket that never called bind still has to hear the
                // answer to what it sent, so its borrowed port is announced too.
                if (!isStream(socket))
                {
                    transport.listen(false, port);
                }
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

    /** Detaches a remote stream, so nothing arriving later finds this socket. */
    const forget = (/** @type {any} */ socket)=>{
        if (socket.stream !== null)
        {
            streams.delete(socket.stream);
            socket.stream = null;
        }
    };

    /**
     * Opens a stream to somewhere outside this runtime.
     *
     * The id is allocated and registered before the dial is asked for, because
     * a transport is free to deliver bytes on it the instant it answers -- and
     * with a relay it will, the accept and the peer's first send arriving in one
     * batch. Registering afterwards drops those.
     *
     * @param {any} socket @param {{ host: number, port: number }} wanted
     */
    const dial = (socket, wanted)=>{
        if (!socket.bound && !claimPort(socket))
        {
            return failure(WSAEADDRINUSE);
        }
        const streamId = nextStream++;
        socket.stream = streamId;
        streams.set(streamId, socket);
        return transport.connect(streamId, wanted).then((/** @type {any} */ opened)=>{
            if (socket.closed)
            {
                forget(socket);
                transport.disconnect(streamId, false);
                return failure(WSAENOTSOCK);
            }
            if (opened.error)
            {
                forget(socket);
                // Recorded as well as returned: a non-blocking connect learns
                // why from getsockopt(SO_ERROR) and never sees this value.
                socket.error = opened.error;
                return failure(opened.error);
            }
            socket.remote = wanted;
            socket.connected = true;
            if (opened.local)
            {
                socket.local = opened.local;
            }
            // Anything the transport delivered while the dial was in flight is
            // already queued, and a reader parked before it landed is waiting.
            wake(socket);
            return count(0);
        });
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
                // The transport's name for this connection, when the other end
                // is not in this runtime. Exactly one of `peer` and `stream` is
                // ever set: a socket is local or it is remote, never both.
                stream: null,
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
            // A datagram socket is reachable the moment it is bound; a stream
            // socket is not reachable until it listens, so its announcement
            // waits for that rather than accepting on a port nobody serves.
            if (!isStream(socket))
            {
                transport.listen(false, wanted.port);
            }
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
            transport.listen(true, socket.local.port);
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
            if (!mine(wanted))
            {
                return dial(socket, wanted);
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
                if (!socket.connected || !(socket.peer || socket.stream !== null))
                {
                    return failure(WSAENOTCONN);
                }
                if (socket.sentFin)
                {
                    return failure(WSAECONNRESET);
                }
                // Copied, not referenced: the guest owns the buffer it handed us
                // and is free to overwrite it the instant this returns.
                if (socket.stream !== null)
                {
                    transport.send(socket.stream, bytes.slice());
                    return count(bytes.length);
                }
                if (socket.peer.closed)
                {
                    return failure(WSAECONNRESET);
                }
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
            const destination = normalise(target);
            if (!mine(destination))
            {
                transport.sendTo(socket.local, destination, bytes.slice());
                return count(bytes.length);
            }
            const peer = adapter.find(addressKey(false, destination));
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
                if (socket.stream !== null)
                {
                    // Half, not full: the peer has to learn this end is done
                    // sending while this end keeps reading, which is the whole
                    // point of the call -- a request written, then its answer.
                    transport.disconnect(socket.stream, true);
                }
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
                if (!isStream(socket) || socket.listening)
                {
                    transport.release(isStream(socket), socket.local.port);
                }
            }
            if (socket.stream !== null)
            {
                transport.disconnect(socket.stream, false);
                forget(socket);
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

        /**
         * Names, when there is something able to answer for them.
         *
         * Null rather than an empty answer when there is no resolver: the caller
         * then keeps its synchronous local reply instead of suspending a guest
         * thread to be told what it already knew.
         *
         * @param {string} name
         * @returns {Promise<number[]> | null}
         */
        resolve: name=>transport.resolve ? transport.resolve(name) : null,

        /** Every socket, for diagnostics and for closing them all at once. */
        all: ()=>[...sockets.values()],

        diagnostics: ()=>({
            open: sockets.size,
            listening: [...sockets.values()].filter(socket=>socket.listening).length,
            connected: [...sockets.values()].filter(socket=>socket.connected).length,
            remote: streams.size,
            ...transport.diagnostics(),
        }),
    };

    /**
     * The other direction: everything the transport delivers.
     *
     * Each of these does the same two things -- append to a queue, wake whoever
     * is on it -- and deliberately nothing else. A socket filled from here is
     * indistinguishable from one filled locally, which is what lets recv,
     * select, FIONREAD and the overlapped pair stay unaware there is a network.
     *
     * @type {import('./transport.js').TransportInbound}
     */
    const inbound = {
        accepted(port, streamId, remote){
            const listener = adapter.find(addressKey(true, { host: self(), port }));
            if (!listener || !listener.listening || listener.closed)
            {
                transport.disconnect(streamId, false);
                return;
            }
            const made = /** @type {any} */ (api.create(listener.family, SOCK_STREAM));
            const server = sockets.get(made.value);
            server.local = listener.local;
            server.remote = { host: remote.host >>> 0, port: remote.port & 0xffff };
            server.connected = true;
            server.stream = streamId;
            streams.set(streamId, server);
            listener.backlog.push(server);
            wake(listener);
        },

        received(streamId, bytes){
            const socket = streams.get(streamId);
            if (!socket || socket.closed)
            {
                return;
            }
            socket.rx.push(bytes);
            wake(socket);
        },

        disconnected(streamId, error){
            const socket = streams.get(streamId);
            if (!socket)
            {
                return;
            }
            // The flag goes on this socket, not on a peer: there is no peer
            // object here, and it is this socket's reads that must return zero
            // once its queue drains.
            //
            // The stream stays mapped. A far end that only finished sending --
            // shutdown(SD_SEND), which is how a request is written before its
            // answer is read -- leaves this end still able to send, and
            // detaching here would fail that send with WSAENOTCONN.
            socket.finished = true;
            if (error)
            {
                socket.error = error;
            }
            wake(socket);
        },

        datagram(port, from, bytes){
            const socket = adapter.find(addressKey(false, { host: self(), port }));
            if (!socket || socket.closed)
            {
                return;
            }
            socket.rx.push({ from: { host: from.host >>> 0, port: from.port & 0xffff }, bytes });
            wake(socket);
        },

        lost(error){
            for (const socket of [...streams.values()])
            {
                socket.finished = true;
                socket.error = error || TRANSPORT_LOST;
                wake(socket);
            }
        },
    };

    transport.attach(inbound);
    return api;
}
