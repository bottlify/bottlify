/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The browser half: a relay, wearing the shape a runtime's sockets expect.
 *
 * Everything here is one translation -- a transport verb into a frame, a frame
 * into an inbound callback -- and it is deliberately the only thing here. No
 * socket state, no queues, no retries: the runtime above already keeps all of
 * that for local sockets and would keep it differently, and wrongly, if this
 * kept a second copy.
 *
 * Three decisions are worth the words.
 *
 * The connection is established before the transport exists. The relay hands
 * this runtime its address on the room's network as part of joining, and that
 * address is what ports bind under; a transport that answered "loopback" until
 * the welcome arrived would let a guest bind under one address and be reachable
 * at another, and the sockets bound in that window would never receive anything.
 * So there is no half-open state to get wrong -- connectRelay resolves when the
 * runtime is on the network, or rejects.
 *
 * A dropped link is repaired only as the same session. A fresh join would get a
 * different address and an empty room, so every socket the guest holds would be
 * stale while looking healthy. A relay that keeps the session for a resume
 * window lets the link come back to the same peer, with whatever either side
 * missed resent, and the guest sees a pause. Past the window, or with a relay
 * that keeps nothing, the runtime is told the network has gone -- both the
 * truth and the thing a program is written to handle: reads return, connects
 * fail, and the game shows its own "connection lost" rather than hanging.
 *
 * Nothing is sent that was not asked for. A frame carries one guest operation,
 * so a coalescing or batching layer here would change the message boundaries a
 * datagram protocol depends on.
 */

import {
    BROADCAST, FLAG_HALF, FLAG_STREAM, Op, PROTOCOL_VERSION, Wsa,
    decodeControl, decodeFrame, encodeControl, encodeFrame, parseIp, unpackAddresses,
    unpackError,
} from '../protocol.js';

/** How long the join may take before it is given up on. */
const JOIN_TIMEOUT_MS = 15000;

/** The frames kept for resending after a dropped link, by their bytes. */
const REPLAY_BYTES = 2 * 1024 * 1024;

/**
 * An address as the runtime keeps one: host order, both fields.
 *
 * @typedef {Object} Address
 * @property {number} host
 * @property {number} port
 */

/**
 * The runtime's side of the contract, restated here rather than imported.
 *
 * This package is the browser half of a relay and must not depend on the engine
 * to be built or tested -- a transport is a thing you can write without one, and
 * one that could not be would not be a seam. The engine's own copy in
 * wsock32/transport.js is the authority on what these mean.
 *
 * @typedef {Object} TransportInbound
 * @property {(port: number, streamId: number, remote: Address) => void} accepted
 * @property {(streamId: number, bytes: Uint8Array) => void} received
 * @property {(streamId: number, error?: number) => void} disconnected
 * @property {(port: number, from: Address, bytes: Uint8Array) => void} datagram
 * @property {(error: number) => void} lost
 */

/**
 * @typedef {Object} ClientTransport
 * @property {(handlers: TransportInbound) => void} attach
 * @property {() => number} localAddress
 * @property {(streamId: number, to: Address) =>
 *      Promise<{ local?: Address, error?: number }>} connect
 * @property {(streamId: number, bytes: Uint8Array) => void} send
 * @property {(streamId: number, half: boolean) => void} disconnect
 * @property {(from: Address, to: Address, bytes: Uint8Array) => void} sendTo
 * @property {(stream: boolean, port: number) => void} listen
 * @property {(stream: boolean, port: number) => void} release
 * @property {(name: string) => Promise<number[]>} resolve
 * @property {() => void} dispose
 * @property {() => Record<string, unknown>} diagnostics
 */

/**
 * @typedef {Object} RelayOptions
 * @property {string} url        The relay, wss:// in anything but a local test.
 * @property {string} room       Peers naming the same room share a network.
 * @property {string} [token]
 * @property {number} [joinTimeoutMs]
 * @property {(event: { type: string, address?: string }) => void} [onRoster]
 *      Told when a peer joins or leaves, for a lobby to display. The guest's
 *      sockets do not need it and do not see it.
 * @property {boolean} [resumable]
 *      Whether to ask the relay to keep this session through a dropped link
 *      (yes by default); the relay says for how long.
 * @property {typeof WebSocket} [WebSocketImpl]  For tests.
 */

/**
 * Joins a room and returns a transport for it.
 *
 * The listeners used for joining are removed the moment it succeeds. Leaving
 * them attached is the classic version of this bug: the next ordinary frame
 * arrives, the handshake code decides it is a frame sent before the welcome, and
 * closes a connection that was working.
 *
 * @param {RelayOptions} options
 * @returns {Promise<ClientTransport>}
 */
export function connectRelay(options){
    return join(options, {
        t: 'hello', protocol: PROTOCOL_VERSION, room: options.room, token: options.token,
        ...(options.resumable === false ? {} : { resumable: true }),
    }, options.joinTimeoutMs ?? JOIN_TIMEOUT_MS,
    (socket, welcome)=>makeTransport(socket, welcome, options));
}

/**
 * Opens a link and says hello on it: the first join, or coming back to a
 * session. `adopt` takes the link and the welcome inside the welcome's own
 * event, before the next message is dispatched -- the relay sends the frames a
 * resumed session missed right behind the welcome, and a listener attached a
 * microtask later would never see them. Resolves with what `adopt` returned,
 * or rejects with the reason.
 *
 * @template T
 * @param {RelayOptions} options
 * @param {import('../protocol.js').Hello} hello
 * @param {number} within
 * @param {(socket: any, welcome: import('../protocol.js').Welcome) => T} adopt
 * @returns {Promise<T>}
 */
function join(options, hello, within, adopt){
    const Impl = options.WebSocketImpl ?? WebSocket;
    const socket = new Impl(options.url);
    socket.binaryType = 'arraybuffer';

    return new Promise((resolve, reject)=>{
        /** @type {any} */
        let timer = setTimeout(()=>fail('relay did not answer in time'), within);
        let done = false;

        const detach = ()=>{
            done = true;
            if (timer !== null)
            {
                clearTimeout(timer);
                timer = null;
            }
            socket.removeEventListener('error', onError);
            socket.removeEventListener('close', onClose);
            socket.removeEventListener('open', onOpen);
            socket.removeEventListener('message', onMessage);
        };

        /** @param {string} reason */
        function fail(reason){
            if (done)
            {
                return;
            }
            detach();
            socket.close();
            reject(new Error(reason));
        }

        function onError(){
            fail('relay unreachable');
        }

        function onClose(){
            fail('relay closed the connection');
        }

        function onOpen(){
            socket.send(encodeControl(hello));
        }

        /** @param {any} event */
        function onMessage(event){
            if (typeof event.data !== 'string')
            {
                fail('relay sent a frame before welcoming');
                return;
            }
            const message = decodeControl(event.data);
            if (!message)
            {
                fail('relay sent nonsense');
                return;
            }
            if (message.t === 'error')
            {
                fail(message.reason);
                return;
            }
            if (message.t !== 'welcome')
            {
                return;
            }
            detach();
            resolve(adopt(socket, message));
        }

        socket.addEventListener('error', onError);
        socket.addEventListener('close', onClose);
        socket.addEventListener('open', onOpen);
        socket.addEventListener('message', onMessage);
    });
}

/**
 * @param {any} first
 * @param {import('../protocol.js').Welcome} welcome
 * @param {RelayOptions} options
 * @returns {ClientTransport}
 */
function makeTransport(first, welcome, options){
    const address = parseIp(welcome.address);
    const encoder = new TextEncoder();
    // A session the relay keeps after a dropped link, when it gave one.
    const session = welcome.session ?? '';
    const window = welcome.resume ?? 0;
    const heartbeat = welcome.heartbeat ?? 0;

    /** @type {any} */
    let socket = first;

    /** @type {TransportInbound | null} */
    let inbound = null;

    /** Dials awaiting an answer, by the stream id the runtime gave them. */
    /** @type {Map<number, (opened: any) => void>} */
    const dialling = new Map();

    /** Name lookups awaiting an answer. */
    /** @type {Map<number, (found: number[]) => void>} */
    const asking = new Map();

    /** @type {Set<number>} */
    const open = new Set();

    let nextQuery = 1;
    let lost = false;
    let disposed = false;
    let sent = 0;
    let received = 0;
    let resumed = 0;
    // Back on a link after a drop: frames written meanwhile wait in the replay.
    let away = false;
    let heard = Date.now();

    /** What was sent and not yet acknowledged, for resending on coming back. */
    /** @type {Uint8Array[]} */
    const replay = [];
    let replayFirst = 1;
    let replayBytes = 0;

    /** @param {number} upTo */
    const forget = upTo=>{
        while (replay.length > 0 && replayFirst <= upTo)
        {
            replayBytes -= /** @type {Uint8Array} */ (replay.shift()).length;
            replayFirst++;
        }
    };

    /** @param {Partial<import('../protocol.js').Frame> & { op: number }} frame */
    const write = frame=>{
        if (lost)
        {
            return;
        }
        const bytes = encodeFrame(frame);
        if (session)
        {
            replay.push(bytes);
            replayBytes += bytes.length;
            while (replayBytes > REPLAY_BYTES)
            {
                replayBytes -= /** @type {Uint8Array} */ (replay.shift()).length;
                replayFirst++;
            }
        }
        else if (socket.readyState !== 1)
        {
            return;
        }
        sent++;
        if (!away && socket.readyState === 1)
        {
            socket.send(bytes);
        }
    };

    /**
     * The link is gone, and everything waiting on it has to hear so.
     *
     * A dial that never settles is a guest thread parked in connect for the rest
     * of the run, and a name lookup that never settles is the same in
     * gethostbyname -- so both are answered here before the streams are, and
     * both are answered with the failure rather than left to a timeout.
     */
    const drop = ()=>{
        if (lost)
        {
            return;
        }
        lost = true;
        clearInterval(beating);
        for (const settle of [...dialling.values()])
        {
            settle({ error: Wsa.NETDOWN });
        }
        dialling.clear();
        for (const settle of [...asking.values()])
        {
            settle([]);
        }
        asking.clear();
        open.clear();
        inbound?.lost(Wsa.NETDOWN);
        options.onRoster?.({ type: 'lost' });
    };

    /**
     * Back to the session after the link dropped, within the window the relay
     * keeps it: what the relay missed is resent, and the guest sees nothing but
     * a pause. Only a relay that refuses, or a window that passes, is a loss.
     */
    const comeBack = ()=>{
        away = true;
        const until = Date.now() + window;
        let attempt = 0;
        const again = ()=>{
            if (disposed || lost)
            {
                return;
            }
            const left = until - Date.now();
            if (left <= 0)
            {
                drop();
                return;
            }
            join(options, {
                t: 'hello', protocol: PROTOCOL_VERSION, room: welcome.room, token: options.token,
                session, received,
            }, left, (link, back)=>{
                const had = back.received ?? 0;
                if (disposed || lost || had < replayFirst - 1 || had > sent)
                {
                    link.close();
                    drop();
                    return;
                }
                socket = link;
                wire(link);
                forget(had);
                for (const bytes of replay)
                {
                    link.send(bytes);
                }
                away = false;
                heard = Date.now();
                resumed++;
                options.onRoster?.({ type: 'resumed' });
            }).catch((/** @type {Error} */ error)=>{
                if (error.message === 'cannot resume')
                {
                    drop();
                    return;
                }
                const pause = Math.min(250 * 2 ** attempt++, 2000);
                setTimeout(again, Math.min(pause, Math.max(until - Date.now(), 0)));
            });
        };
        again();
    };

    /** @param {any} link */
    const broken = link=>{
        if (link !== socket || lost || away)
        {
            return;
        }
        if (session && window > 0 && !disposed)
        {
            comeBack();
            return;
        }
        drop();
    };

    /**
     * The heartbeat: what this side has received, so the relay may forget it,
     * and a link that has heard nothing for three beats taken for dead -- a
     * link that died without closing never says so itself.
     */
    /** @type {any} */
    const beating = session && heartbeat > 0 ? setInterval(()=>{
        if (away || lost)
        {
            return;
        }
        if (Date.now() - heard > heartbeat * 3)
        {
            const dead = socket;
            dead.close();
            broken(dead);
            return;
        }
        if (socket.readyState === 1)
        {
            socket.send(encodeControl({ t: 'ack', received }));
        }
    }, heartbeat) : null;

    /** @param {any} link */
    const wire = link=>{
        link.addEventListener('close', ()=>broken(link));
        link.addEventListener('error', ()=>broken(link));
        link.addEventListener('message', (/** @type {any} */ event)=>{
            if (link !== socket)
            {
                return;
            }
            heard = Date.now();
            if (typeof event.data === 'string')
            {
                const message = decodeControl(event.data);
                if (message?.t === 'ack')
                {
                    forget(message.received);
                }
                else if (message?.t === 'peer')
                {
                    options.onRoster?.({
                        type: message.joined ? 'joined' : 'left', address: message.address,
                    });
                }
                return;
            }
            // Counted before it is read, as the relay counted it when it sent it.
            received++;
            const frame = decodeFrame(new Uint8Array(event.data));
            if (!frame)
            {
                return;
            }
            deliver(frame);
        });
    };
    wire(socket);

    /** @param {import('../protocol.js').Frame} frame */
    const deliver = frame=>{
        switch (frame.op)
        {
            case Op.OPENED:
            {
                const settle = dialling.get(frame.tag);
                if (settle)
                {
                    dialling.delete(frame.tag);
                    open.add(frame.tag);
                    settle({ local: { host: address, port: frame.fromPort } });
                }
                return;
            }
            case Op.STREAM:
                inbound?.received(frame.tag, frame.payload);
                return;
            case Op.HANGUP:
            {
                const settle = dialling.get(frame.tag);
                if (settle)
                {
                    // A hangup on a stream still being dialled is the dial's
                    // answer, not a disconnection of something that never
                    // connected. Reported as refused unless the relay named a
                    // better reason, which it does for a DNS or routing failure.
                    dialling.delete(frame.tag);
                    settle({ error: unpackError(frame.payload) || Wsa.CONNREFUSED });
                    return;
                }
                if (frame.flags & FLAG_HALF)
                {
                    // The far end will send no more; this end may still send, so
                    // the stream is finished for reading only.
                    inbound?.disconnected(frame.tag);
                    return;
                }
                open.delete(frame.tag);
                inbound?.disconnected(frame.tag, unpackError(frame.payload));
                return;
            }
            case Op.ACCEPTED:
                open.add(frame.tag);
                inbound?.accepted(frame.toPort, frame.tag,
                    { host: frame.fromIp, port: frame.fromPort });
                return;
            case Op.DATAGRAM:
                inbound?.datagram(frame.toPort,
                    { host: frame.fromIp, port: frame.fromPort }, frame.payload);
                return;
            case Op.RESOLVED:
            {
                const settle = asking.get(frame.tag);
                if (settle)
                {
                    asking.delete(frame.tag);
                    settle(unpackAddresses(frame.payload));
                }
                return;
            }
            default:
                // DIAL, LISTEN, UNLISTEN and RESOLVE only travel outward. A
                // relay sending one back is not something to act on.
                return;
        }
    };

    return {
        /** @param {TransportInbound} handlers */
        attach(handlers){
            inbound = handlers;
        },

        localAddress: ()=>address,

        /** @param {number} streamId @param {{ host: number, port: number }} to */
        connect(streamId, to){
            if (lost)
            {
                return Promise.resolve({ error: Wsa.NETDOWN });
            }
            return new Promise(settle=>{
                dialling.set(streamId, settle);
                write({
                    op: Op.DIAL, tag: streamId,
                    fromIp: address, toIp: to.host, toPort: to.port,
                });
            });
        },

        /** @param {number} streamId @param {Uint8Array} bytes */
        send(streamId, bytes){
            write({ op: Op.STREAM, tag: streamId, payload: bytes });
        },

        /** @param {number} streamId @param {boolean} half */
        disconnect(streamId, half){
            if (!half)
            {
                open.delete(streamId);
                dialling.delete(streamId);
            }
            write({ op: Op.HANGUP, tag: streamId, flags: half ? FLAG_HALF : 0 });
        },

        /**
         * @param {{ host: number, port: number }} from
         * @param {{ host: number, port: number }} to
         * @param {Uint8Array} bytes
         */
        sendTo(from, to, bytes){
            write({
                op: Op.DATAGRAM,
                fromIp: address, fromPort: from.port,
                // The guest's broadcast address means everyone on this network,
                // and the relay reads it the same way -- the room, and no wider.
                toIp: to.host === BROADCAST ? BROADCAST : to.host, toPort: to.port,
                payload: bytes,
            });
        },

        /** @param {boolean} stream @param {number} port */
        listen(stream, port){
            write({ op: Op.LISTEN, flags: stream ? FLAG_STREAM : 0, toPort: port });
        },

        /** @param {boolean} stream @param {number} port */
        release(stream, port){
            write({ op: Op.UNLISTEN, flags: stream ? FLAG_STREAM : 0, toPort: port });
        },

        /** @param {string} name @returns {Promise<number[]>} */
        resolve(name){
            if (lost)
            {
                return Promise.resolve([]);
            }
            const tag = nextQuery++;
            return new Promise(settle=>{
                asking.set(tag, settle);
                write({ op: Op.RESOLVE, tag, payload: encoder.encode(name) });
            });
        },

        /** Closes the link. Everything on it is reported as lost, as it is. */
        dispose(){
            disposed = true;
            socket.close();
            drop();
        },

        diagnostics: ()=>({
            transport: 'relay',
            room: welcome.room,
            address: welcome.address,
            connected: !lost && !away,
            resumable: session !== '',
            resumed,
            streams: open.size,
            dialling: dialling.size,
            sent,
            received,
        }),
    };
}

export {
    FLAG_HALF, FLAG_REJECT, FLAG_STREAM, Op, PROTOCOL_VERSION,
} from '../protocol.js';
