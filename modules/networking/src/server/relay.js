/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The relay: real sockets, on behalf of runtimes that have none.
 *
 * A browser tab cannot open a TCP connection or bind a UDP port. So a runtime
 * that wants either asks here, and this process does the work with its own
 * sockets and forwards the bytes back. That is the whole idea, and everything
 * below is a consequence of it.
 *
 * There are two destinations and one address space decides which.
 *
 * Peers that gave the same room name are put on a small private network and each
 * is given an address on it. Traffic aimed at one of those addresses never
 * leaves this process -- it is handed straight to that peer -- and a datagram
 * broadcast reaches everyone in the room and nobody outside it. This is what a
 * game's LAN discovery and its peer-to-peer play run on, and it is why a room is
 * an isolation boundary rather than a label: two rooms cannot see each other,
 * so two unrelated sessions cannot find each other's games.
 *
 * Anything aimed at any other address is a real socket, opened here, and it is
 * refused unless the policy says otherwise. The default policy refuses
 * everything, which makes an unconfigured relay a private LAN and nothing more.
 * That default is deliberate: a relay that forwarded anywhere by default would
 * be an open proxy the moment it was deployed, and would be found within a day.
 *
 * Two invariants are worth stating because they are how this breaks.
 *
 * A stream is named by a tag, per connection, and the two ends of a room stream
 * have different tags. The dialling peer chose its own; the accepting peer is
 * given one from a separate range, because it also allocates tags of its own and
 * a collision would splice two unrelated connections together.
 *
 * A refusal has to arrive. Every path that can fail a dial -- policy, DNS, the
 * connection itself, the peer disappearing mid-dial -- ends in a HANGUP carrying
 * the tag that was dialled. A dial that simply stops leaves a guest thread
 * parked in connect for the rest of the session.
 */

import { Socket } from 'node:net';
import { createSocket } from 'node:dgram';
import { lookup } from 'node:dns/promises';

import {
    BROADCAST, FLAG_HALF, FLAG_REJECT, FLAG_STREAM, Op, PROTOCOL_VERSION, Wsa,
    decodeControl, decodeFrame, encodeControl, encodeFrame, formatIp, packAddresses,
    packError, parseIp, unpackError, wsaErrorFor,
} from '../protocol.js';

/** The private network a room's peers are put on: 10.86.0.0/16. */
const ROOM_SUBNET = 0x0a560000;
const ROOM_MASK = 0xffff0000;

/** Tags the relay allocates for an accepting peer, kept clear of the peer's own. */
const ACCEPTED_TAG_BASE = 0x80000000;

/** @param {number} host host order */
const inRoom = host=>((host & ROOM_MASK) >>> 0) === ROOM_SUBNET;

/**
 * @typedef {Object} PolicyRequest
 * @property {string} room
 * @property {string} peer      The asking peer's address on the room network.
 * @property {'tcp' | 'udp' | 'dns'} protocol
 * @property {string} host      A dotted address, or a name for a dns request.
 * @property {number} port      Zero for dns.
 */

/**
 * @callback RelayPolicy
 * @param {PolicyRequest} request
 * @returns {boolean | Promise<boolean>}
 */

/**
 * @typedef {Object} RelayOptions
 * @property {RelayPolicy} [policy]
 *      Whether a runtime may reach outside its room. Refuses everything by
 *      default, which is the only safe thing an unconfigured relay can do.
 * @property {number} [maxSocketsPerPeer]
 * @property {number} [maxPeersPerRoom]
 */

/**
 * The routing half, with no notion of how bytes reach a peer.
 *
 * Separated from the WebSocket server so the whole of it can be tested by
 * driving fake peers directly, without a port, a handshake or a timer -- which
 * is what makes the interesting cases (a peer vanishing mid-dial, a refusal, a
 * room filling up) ordinary tests rather than a staging environment.
 *
 * @param {RelayOptions} [options]
 */
export function createRelay(options = {}){
    const policy = options.policy ?? (()=>false);
    const maxSockets = options.maxSocketsPerPeer ?? 64;
    const maxPeers = options.maxPeersPerRoom ?? 32;

    /** @type {Map<string, Map<number, any>>} room name -> address -> peer */
    const rooms = new Map();
    let accepted = ACCEPTED_TAG_BASE;

    /** @param {string} name */
    const roomOf = name=>{
        const held = rooms.get(name);
        if (held)
        {
            return held;
        }
        const made = new Map();
        rooms.set(name, made);
        return made;
    };

    /** The lowest free address on a room's network. */
    const claimAddress = (/** @type {Map<number, any>} */ room)=>{
        for (let index = 1; index < 0xfffe; index++)
        {
            const address = (ROOM_SUBNET | index) >>> 0;
            if (!room.has(address))
            {
                return address;
            }
        }
        return 0;
    };

    /**
     * A connected runtime.
     *
     * @typedef {Object} Peer
     * @property {string} room
     * @property {number} address
     * @property {(bytes: Uint8Array) => void} sendBinary
     * @property {(text: string) => void} sendText
     * @property {() => void} disconnect
     */

    /**
     * @param {any} peer
     * @param {Partial<import('../protocol.js').Frame> & { op: number }} frame
     */
    const send = (peer, frame)=>peer.sendBinary(encodeFrame(frame));

    /**
     * Ends a stream in whichever way it exists, and tells the peer why.
     *
     * @param {any} peer @param {number} tag @param {number} flags @param {number} error
     */
    const hangup = (peer, tag, flags, error)=>{
        const stream = peer.streams.get(tag);
        peer.streams.delete(tag);
        if (stream?.socket)
        {
            stream.socket.destroy();
        }
        if (stream?.other)
        {
            const { peer: far, tag: farTag } = stream.other;
            far.streams.delete(farTag);
            send(far, { op: Op.HANGUP, tag: farTag, flags, payload: packError(error) });
        }
    };

    /**
     * Whether the policy permits this, with anything but a clear yes a no.
     *
     * A policy that threw has not permitted anything, and the safe reading of a
     * registry that is down is that nobody may leave the room -- the alternative
     * turns an outage into an open proxy.
     *
     * @param {any} peer @param {'tcp' | 'udp' | 'dns'} protocol
     * @param {string} host @param {number} port
     */
    const permits = async(peer, protocol, host, port)=>{
        try {
            return await policy({
                room: peer.room, peer: formatIp(peer.address), protocol, host, port,
            }) === true;
        }
        catch {
            return false;
        }
    };

    /** Every stream and socket this peer had, gone. */
    const dropStreams = (/** @type {any} */ peer)=>{
        for (const tag of [...peer.streams.keys()])
        {
            hangup(peer, tag, 0, Wsa.CONNRESET);
        }
        for (const bound of peer.datagrams.values())
        {
            bound.close();
        }
        peer.datagrams.clear();
        for (const dialling of peer.dialling)
        {
            dialling.destroy();
        }
        peer.dialling.clear();
    };

    /**
     * A real TCP connection, on the peer's behalf.
     *
     * @param {any} peer @param {import('../protocol.js').Frame} frame
     */
    const dialOutside = async(peer, frame)=>{
        const host = formatIp(frame.toIp);
        const refuse = (/** @type {number} */ error)=>send(peer, {
            op: Op.HANGUP, tag: frame.tag, flags: FLAG_REJECT, payload: packError(error),
        });

        if (peer.streams.size >= maxSockets)
        {
            refuse(Wsa.CONNREFUSED);
            return;
        }
        // The name it was resolved from, when it was: a policy written against
        // host names can only see one if the resolve that produced this address
        // is remembered, and the guest only ever passes the address on.
        const name = peer.resolved.get(frame.toIp) ?? null;
        if (!await permits(peer, 'tcp', name ?? host, frame.toPort) || peer.gone)
        {
            refuse(Wsa.CONNREFUSED);
            return;
        }

        const socket = new Socket();
        socket.setNoDelay(true);
        peer.dialling.add(socket);
        // Registered before it connects: bytes the peer sends now are queued by
        // the socket itself, and a HANGUP arriving mid-dial has to find this.
        peer.streams.set(frame.tag, { socket });

        let open = false;
        socket.on('connect', ()=>{
            open = true;
            peer.dialling.delete(socket);
            const local = /** @type {any} */ (socket.address());
            send(peer, {
                op: Op.OPENED, tag: frame.tag,
                fromIp: 0, fromPort: local?.port ?? 0,
                toIp: frame.toIp, toPort: frame.toPort,
            });
        });
        socket.on('data', chunk=>send(peer, {
            op: Op.STREAM, tag: frame.tag, payload: new Uint8Array(chunk),
        }));
        socket.on('error', (/** @type {any} */ error)=>{
            peer.dialling.delete(socket);
            if (!peer.streams.has(frame.tag))
            {
                return;
            }
            peer.streams.delete(frame.tag);
            send(peer, {
                op: Op.HANGUP, tag: frame.tag,
                // A failure before the connection existed is a refusal; after it,
                // the connection was real and merely ended badly. The guest reads
                // the two differently -- one retries, the other does not.
                flags: open ? 0 : FLAG_REJECT,
                payload: packError(wsaErrorFor(error?.code)),
            });
        });
        socket.on('close', ()=>{
            peer.dialling.delete(socket);
            if (!peer.streams.has(frame.tag))
            {
                return;
            }
            peer.streams.delete(frame.tag);
            send(peer, { op: Op.HANGUP, tag: frame.tag, payload: packError(0) });
        });
        socket.connect({ host, port: frame.toPort });
    };

    /**
     * A stream between two peers of one room.
     *
     * @param {any} peer @param {import('../protocol.js').Frame} frame
     */
    const dialPeer = (peer, frame)=>{
        const far = roomOf(peer.room).get(frame.toIp >>> 0);
        if (!far || !far.listening.has(`tcp:${frame.toPort}`))
        {
            send(peer, {
                op: Op.HANGUP, tag: frame.tag, flags: FLAG_REJECT,
                payload: packError(Wsa.CONNREFUSED),
            });
            return;
        }
        const farTag = accepted++;
        peer.streams.set(frame.tag, { other: { peer: far, tag: farTag } });
        far.streams.set(farTag, { other: { peer, tag: frame.tag } });
        send(far, {
            op: Op.ACCEPTED, tag: farTag,
            fromIp: peer.address, fromPort: frame.fromPort, toPort: frame.toPort,
        });
        send(peer, {
            op: Op.OPENED, tag: frame.tag,
            fromIp: peer.address, fromPort: frame.fromPort,
            toIp: frame.toIp, toPort: frame.toPort,
        });
    };

    /**
     * The UDP socket a guest port sends from, made on first use.
     *
     * One per guest source port, because a reply has to reach the port that
     * asked -- a single shared socket would have to guess which of the guest's
     * sockets an arriving datagram was for. The relay's own port is ephemeral
     * and never the guest's: binding what a peer names would let it occupy the
     * host's ports by asking.
     *
     * @param {any} peer @param {number} fromPort
     */
    const datagramSocket = (peer, fromPort)=>{
        const held = peer.datagrams.get(fromPort);
        if (held)
        {
            return held;
        }
        if (peer.datagrams.size >= maxSockets)
        {
            return null;
        }
        const socket = createSocket('udp4');
        socket.on('message', (chunk, from)=>{
            if (peer.gone)
            {
                return;
            }
            send(peer, {
                op: Op.DATAGRAM,
                fromIp: parseIp(from.address), fromPort: from.port,
                toIp: peer.address, toPort: fromPort,
                payload: new Uint8Array(chunk),
            });
        });
        socket.on('error', ()=>{});
        socket.bind();
        peer.datagrams.set(fromPort, socket);
        return socket;
    };

    /** @param {any} peer @param {import('../protocol.js').Frame} frame */
    const datagram = async(peer, frame)=>{
        const room = roomOf(peer.room);
        if (frame.toIp === BROADCAST)
        {
            // Everyone else in the room, and nobody outside it. A broadcast that
            // left the room would put one session's discovery traffic into
            // another's, which is the failure this whole partition exists for.
            for (const far of room.values())
            {
                if (far !== peer && far.listening.has(`udp:${frame.toPort}`))
                {
                    send(far, { ...frame, fromIp: peer.address });
                }
            }
            return;
        }
        if (inRoom(frame.toIp))
        {
            const far = room.get(frame.toIp >>> 0);
            if (far && far.listening.has(`udp:${frame.toPort}`))
            {
                send(far, { ...frame, fromIp: peer.address });
            }
            return;
        }

        const host = formatIp(frame.toIp);
        const name = peer.resolved.get(frame.toIp) ?? null;
        // A refused datagram is dropped rather than reported. That is what an
        // unreachable network does to one anyway, and a sender that expected an
        // answer will time out exactly as it would have.
        if (!await permits(peer, 'udp', name ?? host, frame.toPort) || peer.gone)
        {
            return;
        }
        datagramSocket(peer, frame.fromPort)
            ?.send(Buffer.from(frame.payload), frame.toPort, host, ()=>{});
    };

    /** @param {any} peer @param {import('../protocol.js').Frame} frame */
    const resolve = async(peer, frame)=>{
        const name = new TextDecoder().decode(frame.payload);
        const answer = (/** @type {number[]} */ addresses)=>{
            if (!peer.gone)
            {
                send(peer, {
                    op: Op.RESOLVED, tag: frame.tag, payload: packAddresses(addresses),
                });
            }
        };
        if (!await permits(peer, 'dns', name, 0))
        {
            answer([]);
            return;
        }
        try {
            const found = await lookup(name, { all: true, family: 4 });
            const addresses = found.map(entry=>parseIp(entry.address))
                .filter(address=>address !== 0 && !inRoom(address));
            // Remembered so a later dial to one of these can be judged by the
            // name it came from rather than by a bare address.
            for (const address of addresses)
            {
                peer.resolved.set(address, name);
            }
            answer(addresses);
        }
        catch {
            answer([]);
        }
    };

    /** @param {any} peer @param {import('../protocol.js').Frame} frame */
    const forward = (peer, frame)=>{
        const stream = peer.streams.get(frame.tag);
        if (!stream)
        {
            return;
        }
        if (stream.socket)
        {
            stream.socket.write(Buffer.from(frame.payload));
            return;
        }
        send(stream.other.peer, {
            op: Op.STREAM, tag: stream.other.tag, payload: frame.payload,
        });
    };

    /** @param {any} peer @param {import('../protocol.js').Frame} frame */
    const halfClose = (peer, frame)=>{
        const stream = peer.streams.get(frame.tag);
        if (!stream)
        {
            return;
        }
        if (stream.socket)
        {
            // end(), not destroy(): a half close says this end sends no more and
            // still reads, and destroying it would discard the answer.
            stream.socket.end();
            return;
        }
        send(stream.other.peer, {
            op: Op.HANGUP, tag: stream.other.tag, flags: FLAG_HALF, payload: packError(0),
        });
    };

    const api = {
        /**
         * Admits a runtime, once it has said which room it wants.
         *
         * @param {Object} link
         * @param {(bytes: Uint8Array) => void} link.sendBinary
         * @param {(text: string) => void} link.sendText
         * @param {() => void} link.disconnect
         */
        connect(link){
            /** @type {any} */
            const peer = {
                ...link,
                room: '',
                address: 0,
                joined: false,
                gone: false,
                /** @type {Map<number, any>} */
                streams: new Map(),
                /** @type {Set<string>} */
                listening: new Set(),
                /** @type {Map<number, any>} */
                datagrams: new Map(),
                /** @type {Set<any>} */
                dialling: new Set(),
                /** @type {Map<number, string>} */
                resolved: new Map(),
            };

            /** @param {string} reason */
            const refuse = reason=>{
                peer.sendText(encodeControl({ t: 'error', reason }));
                peer.disconnect();
            };

            /** @param {string} text */
            const hello = text=>{
                const message = decodeControl(text);
                if (!message || message.t !== 'hello')
                {
                    refuse('expected hello');
                    return;
                }
                if (message.protocol !== PROTOCOL_VERSION)
                {
                    refuse(`protocol ${PROTOCOL_VERSION} only`);
                    return;
                }
                const name = String(message.room ?? '');
                if (name === '' || name.length > 128)
                {
                    refuse('bad room');
                    return;
                }
                const room = roomOf(name);
                if (room.size >= maxPeers)
                {
                    refuse('room full');
                    return;
                }
                const address = claimAddress(room);
                if (address === 0)
                {
                    refuse('room full');
                    return;
                }
                peer.room = name;
                peer.address = address;
                peer.joined = true;
                const existing = [...room.keys()].map(formatIp);
                room.set(address, peer);
                peer.sendText(encodeControl({
                    t: 'welcome', address: formatIp(address), room: name, peers: existing,
                }));
                for (const far of room.values())
                {
                    if (far !== peer)
                    {
                        far.sendText(encodeControl({
                            t: 'peer', address: formatIp(address), joined: true,
                        }));
                    }
                }
            };

            return {
                /** @param {Uint8Array | string} data @param {boolean} binary */
                message(data, binary){
                    if (peer.gone)
                    {
                        return;
                    }
                    if (!binary)
                    {
                        if (peer.joined)
                        {
                            // Nothing follows hello on the control channel, so a
                            // second one is a peer that has lost its place.
                            refuse('already joined');
                            return;
                        }
                        hello(/** @type {string} */ (data));
                        return;
                    }
                    if (!peer.joined)
                    {
                        refuse('frame before hello');
                        return;
                    }
                    const frame = decodeFrame(/** @type {Uint8Array} */ (data));
                    if (!frame)
                    {
                        refuse('bad frame');
                        return;
                    }
                    api.route(peer, frame);
                },

                close(){
                    if (peer.gone)
                    {
                        return;
                    }
                    peer.gone = true;
                    dropStreams(peer);
                    if (!peer.joined)
                    {
                        return;
                    }
                    const room = roomOf(peer.room);
                    room.delete(peer.address);
                    for (const far of room.values())
                    {
                        far.sendText(encodeControl({
                            t: 'peer', address: formatIp(peer.address), joined: false,
                        }));
                    }
                    if (room.size === 0)
                    {
                        rooms.delete(peer.room);
                    }
                },

                peer,
            };
        },

        /** @param {any} peer @param {import('../protocol.js').Frame} frame */
        route(peer, frame){
            switch (frame.op)
            {
                case Op.DIAL:
                    if (peer.streams.has(frame.tag))
                    {
                        return;
                    }
                    if (inRoom(frame.toIp))
                    {
                        dialPeer(peer, frame);
                    }
                    else
                    {
                        void dialOutside(peer, frame);
                    }
                    return;
                case Op.STREAM:
                    forward(peer, frame);
                    return;
                case Op.HANGUP:
                    if (frame.flags & FLAG_HALF)
                    {
                        halfClose(peer, frame);
                    }
                    else
                    {
                        hangup(peer, frame.tag, 0, unpackError(frame.payload));
                    }
                    return;
                case Op.DATAGRAM:
                    void datagram(peer, frame);
                    return;
                case Op.LISTEN:
                    peer.listening.add(
                        `${frame.flags & FLAG_STREAM ? 'tcp' : 'udp'}:${frame.toPort}`);
                    return;
                case Op.UNLISTEN:
                    peer.listening.delete(
                        `${frame.flags & FLAG_STREAM ? 'tcp' : 'udp'}:${frame.toPort}`);
                    return;
                case Op.RESOLVE:
                    void resolve(peer, frame);
                    return;
                default:
                    // OPENED, ACCEPTED and RESOLVED only ever travel outward. A
                    // client sending one is confused, and answering it would be
                    // letting a peer forge the relay's own side of a session.
                    return;
            }
        },

        diagnostics: ()=>({
            rooms: rooms.size,
            peers: [...rooms.values()].reduce((total, room)=>total + room.size, 0),
        }),
    };

    return api;
}
