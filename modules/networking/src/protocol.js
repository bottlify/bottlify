/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The wire between a runtime and the relay.
 *
 * Both halves import this one module rather than each keeping its own copy of
 * the layout, because a wire protocol described in two places is a protocol that
 * will disagree with itself the first time one side is edited.
 *
 * There are two kinds of message and they are carried differently on purpose.
 *
 * Control is JSON, in text frames: joining, being told who else is here, being
 * told why not. It happens a handful of times per session, it is the part a
 * person reads in a log when something is wrong, and nothing about it is hot.
 *
 * Everything else is a binary frame with a fixed twenty-byte header. The payload
 * is guest bytes and the relay never looks inside it -- it routes on the header
 * and forwards the rest untouched, so one guest send is one frame and the
 * boundaries a datagram depends on survive the trip. Encoding those bytes as
 * JSON would inflate them by a third and cost a parse per packet, on the path
 * where a guest thread is waiting.
 *
 * Header, little-endian throughout:
 *
 *     +0   u8   op
 *     +1   u8   flags
 *     +2   u16  reserved   zero
 *     +4   u32  tag        stream id, or query id, or zero
 *     +8   u32  fromIp     host order, as sockaddr.js keeps addresses
 *     +12  u32  toIp       host order
 *     +16  u16  fromPort
 *     +18  u16  toPort
 *
 * Addresses are host order and little-endian encoded, deliberately, rather than
 * the network order a sockaddr holds. Both ends of this wire are ours and both
 * work in host order internally; carrying network order would mean two swaps per
 * frame and a class of bug where one of them is forgotten.
 *
 * A stream is named by a tag its client chose, never by an address pair. Two
 * connections to the same host and port exist at once, so a pair is not a name.
 */

export const PROTOCOL_VERSION = 1;

/** What a frame is. */
export const Op = Object.freeze({
    /** Client asks for a stream to `toIp:toPort`. `tag` names it from now on. */
    DIAL: 1,
    /** Relay answers a DIAL. `fromIp:fromPort` is the local end it got. */
    OPENED: 2,
    /** Stream bytes, either direction. */
    STREAM: 3,
    /** A stream ended. See HALF and REJECT. Payload may carry a u32 error. */
    HANGUP: 4,
    /** A datagram, either direction. `toIp` of 0xffffffff is the room. */
    DATAGRAM: 5,
    /** Client is now serving `toPort`. STREAM flag picks TCP over UDP. */
    LISTEN: 6,
    /** Client has stopped serving `toPort`. */
    UNLISTEN: 7,
    /** A peer opened a stream to a port this client listens on. */
    ACCEPTED: 8,
    /** Client asks for a name. `tag` names the question. */
    RESOLVE: 9,
    /** The answer: payload is zero or more host-order u32 addresses. */
    RESOLVED: 10,
});

/** A HANGUP that is a refusal -- the dial never happened. */
export const FLAG_REJECT = 0x01;
/** A HANGUP that is shutdown(SD_SEND): this end is done sending, not reading. */
export const FLAG_HALF = 0x02;
/** LISTEN/UNLISTEN is about a stream port rather than a datagram port. */
export const FLAG_STREAM = 0x04;

export const HEADER_SIZE = 20;

/**
 * The largest frame either side will encode or accept.
 *
 * A length is the one field an attacker controls before anything has been
 * validated, so it is bounded before it is believed. Sixty-four kilobytes is
 * comfortably above the largest datagram IPv4 can carry.
 */
export const MAX_PAYLOAD = 64 * 1024;

/** The address a guest sends to when it means "everyone on this LAN". */
export const BROADCAST = 0xffffffff;

/**
 * The reasons a HANGUP carries.
 *
 * These are Winsock's numbers rather than the relay's own, and they travel the
 * wire as such, because the only thing that will ever read one is a guest
 * calling WSAGetLastError. Inventing a relay error space would mean a table on
 * each side translating between them and a third set of numbers in the logs.
 */
export const Wsa = Object.freeze({
    CONNRESET: 10054,
    TIMEDOUT: 10060,
    CONNREFUSED: 10061,
    NETDOWN: 10050,
    NETUNREACH: 10051,
    HOSTUNREACH: 10065,
});

/**
 * What a failed system call means to a guest.
 *
 * @param {string | undefined} code  a Node error code
 */
export function wsaErrorFor(code){
    switch (code)
    {
        case 'ECONNREFUSED': return Wsa.CONNREFUSED;
        case 'ETIMEDOUT': return Wsa.TIMEDOUT;
        case 'ECONNRESET': return Wsa.CONNRESET;
        case 'EHOSTUNREACH': return Wsa.HOSTUNREACH;
        case 'ENOTFOUND':
        case 'EAI_AGAIN':
        case 'ENETUNREACH': return Wsa.NETUNREACH;
        default: return Wsa.CONNREFUSED;
    }
}

/**
 * @typedef {Object} Frame
 * @property {number} op
 * @property {number} flags
 * @property {number} tag
 * @property {number} fromIp   host order
 * @property {number} toIp     host order
 * @property {number} fromPort
 * @property {number} toPort
 * @property {Uint8Array} payload
 */

const EMPTY = new Uint8Array(0);

/**
 * @param {Partial<Frame> & { op: number }} frame
 * @returns {Uint8Array}
 */
export function encodeFrame(frame){
    const payload = frame.payload ?? EMPTY;
    if (payload.length > MAX_PAYLOAD)
    {
        throw new RangeError(`frame payload ${payload.length} over ${MAX_PAYLOAD}`);
    }
    const bytes = new Uint8Array(HEADER_SIZE + payload.length);
    const view = new DataView(bytes.buffer);
    view.setUint8(0, frame.op & 0xff);
    view.setUint8(1, (frame.flags ?? 0) & 0xff);
    view.setUint16(2, 0, true);
    view.setUint32(4, (frame.tag ?? 0) >>> 0, true);
    view.setUint32(8, (frame.fromIp ?? 0) >>> 0, true);
    view.setUint32(12, (frame.toIp ?? 0) >>> 0, true);
    view.setUint16(16, (frame.fromPort ?? 0) & 0xffff, true);
    view.setUint16(18, (frame.toPort ?? 0) & 0xffff, true);
    bytes.set(payload, HEADER_SIZE);
    return bytes;
}

/**
 * Reads a frame, or null if these bytes are not one.
 *
 * Null rather than a throw: this decodes whatever arrived on a socket anyone
 * can open, so a malformed frame is an ordinary event to drop the sender for,
 * not an exception to unwind a relay through.
 *
 * @param {Uint8Array} bytes
 * @returns {Frame | null}
 */
export function decodeFrame(bytes){
    if (bytes.length < HEADER_SIZE || bytes.length > HEADER_SIZE + MAX_PAYLOAD)
    {
        return null;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const op = view.getUint8(0);
    if (op < Op.DIAL || op > Op.RESOLVED)
    {
        return null;
    }
    return {
        op,
        flags: view.getUint8(1),
        tag: view.getUint32(4, true),
        fromIp: view.getUint32(8, true),
        toIp: view.getUint32(12, true),
        fromPort: view.getUint16(16, true),
        toPort: view.getUint16(18, true),
        // Copied, not a view: the buffer it arrived in is the transport's and is
        // reused. A payload that aliases it turns into whatever came next.
        payload: bytes.slice(HEADER_SIZE),
    };
}

/** @param {string} dotted @returns {number} host order, or 0 if it is not one */
export function parseIp(dotted){
    const parts = dotted.split('.');
    if (parts.length !== 4)
    {
        return 0;
    }
    let value = 0;
    for (const part of parts)
    {
        if (!/^\d{1,3}$/.test(part))
        {
            return 0;
        }
        const octet = Number(part);
        if (octet > 255)
        {
            return 0;
        }
        value = (value * 256) + octet;
    }
    return value >>> 0;
}

/** @param {number} value host order */
export function formatIp(value){
    return [24, 16, 8, 0].map(shift=>(value >>> shift) & 0xff).join('.');
}

/**
 * A RESOLVED payload: the answers, four bytes each.
 *
 * @param {number[]} addresses host order
 */
export function packAddresses(addresses){
    const bytes = new Uint8Array(addresses.length * 4);
    const view = new DataView(bytes.buffer);
    addresses.forEach((address, at)=>view.setUint32(at * 4, address >>> 0, true));
    return bytes;
}

/** @param {Uint8Array} payload @returns {number[]} host order */
export function unpackAddresses(payload){
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const addresses = [];
    for (let at = 0; at + 4 <= payload.length; at += 4)
    {
        addresses.push(view.getUint32(at, true));
    }
    return addresses;
}

/** A HANGUP's reason, when it has one. @param {number} error */
export function packError(error){
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, error >>> 0, true);
    return bytes;
}

/** @param {Uint8Array} payload @returns {number} zero when no reason was given */
export function unpackError(payload){
    return payload.length < 4
        ? 0
        : new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
            .getUint32(0, true);
}

/**
 * @typedef {Object} Hello
 * @property {'hello'} t
 * @property {number} protocol
 * @property {string} room   Peers sharing a room see each other and nobody else.
 * @property {string} [token]
 */

/**
 * @typedef {Object} Welcome
 * @property {'welcome'} t
 * @property {string} address  This runtime's address on the room's network.
 * @property {string} room
 * @property {string[]} peers  Everyone already here.
 */

/**
 * @typedef {Object} PeerChanged
 * @property {'peer'} t
 * @property {string} address
 * @property {boolean} joined
 */

/**
 * @typedef {Object} Refused
 * @property {'error'} t
 * @property {string} reason
 */

/**
 * @typedef {Hello | Welcome | PeerChanged | Refused} Control
 */

/**
 * Reads a control message, or null.
 *
 * Same reasoning as decodeFrame: anything can arrive here, so bad input is a
 * value and not an exception.
 *
 * @param {string} text
 * @returns {Control | null}
 */
export function decodeControl(text){
    try {
        const message = JSON.parse(text);
        return message && typeof message.t === 'string' ? message : null;
    }
    catch {
        return null;
    }
}

/** @param {Control} message */
export function encodeControl(message){
    return JSON.stringify(message);
}
