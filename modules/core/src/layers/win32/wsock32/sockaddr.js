/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

/**
 * Addresses, and the byte order they are kept in.
 *
 * Every number that crosses this boundary is in network order, which on x86
 * means the bytes inside the field run the other way from every other field the
 * guest has. That is the whole difficulty: a port read without the swap is a
 * plausible port, an address read without it is a plausible address, and a
 * program built on either talks confidently to the wrong place. So the swap
 * lives in exactly two functions and nothing else is allowed to do it by hand.
 *
 * sockaddr_in is sixteen bytes and only the first eight carry anything:
 *
 *     +0  short  sin_family    AF_INET
 *     +2  ushort sin_port      network order
 *     +4  ulong  sin_addr      network order
 *     +8  char[8] sin_zero     zero, and callers do compare it
 */

import { AF_INET, INADDR_NONE } from './constants.js';

export const SOCKADDR_IN_SIZE = 16;

/** @param {number} value */
export const swap16 = value=>((value & 0xff) << 8 | (value >>> 8) & 0xff) & 0xffff;

/** @param {number} value */
export const swap32 = value=>(
    (value & 0xff) << 24 | (value & 0xff00) << 8
    | (value >>> 8) & 0xff00 | (value >>> 24) & 0xff) >>> 0;

/**
 * @typedef {Object} Address
 * @property {number} host  Host order, so it compares and prints the obvious way.
 * @property {number} port  Host order.
 */

/**
 * Reads a sockaddr_in.
 *
 * A family that is not AF_INET is reported rather than corrected: a caller that
 * passed AF_INET6 or a zeroed structure has made a mistake this surface has to
 * answer for, and quietly reading it as IPv4 would hide that.
 *
 * @param {(address: number, length: number) => Uint8Array} readMemory
 * @param {number} pointer
 * @returns {{ family: number, host: number, port: number } | null}
 */
export function readSockaddr(readMemory, pointer){
    if (pointer === 0)
    {
        return null;
    }
    const bytes = readMemory(pointer >>> 0, SOCKADDR_IN_SIZE);
    if (bytes.length < 8)
    {
        return null;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return {
        family: view.getUint16(0, true),
        // Read big-endian, which *is* the swap: the field holds network order.
        port: view.getUint16(2, false),
        host: view.getUint32(4, false),
    };
}

/**
 * Writes a sockaddr_in, including the eight zero bytes.
 *
 * @param {(address: number, bytes: Uint8Array) => void} writeMemory
 * @param {number} pointer
 * @param {Address} address
 */
export function writeSockaddr(writeMemory, pointer, address){
    const bytes = new Uint8Array(SOCKADDR_IN_SIZE);
    const view = new DataView(bytes.buffer);
    view.setUint16(0, AF_INET, true);
    view.setUint16(2, address.port & 0xffff, false);
    view.setUint32(4, address.host >>> 0, false);
    writeMemory(pointer >>> 0, bytes);
}

/**
 * Parses dotted-quad notation the way inet_addr does, which is not the way a
 * careful parser would: it accepts one, two, three or four parts, and the last
 * part fills every byte the earlier ones did not. "127.1" is 127.0.0.1, and
 * programs do rely on it.
 *
 * @param {string} text
 * @returns {number} host order, or INADDR_NONE
 */
export function parseAddress(text){
    const trimmed = text.trim();
    if (trimmed === '')
    {
        return INADDR_NONE;
    }
    const parts = trimmed.split('.');
    if (parts.length > 4)
    {
        return INADDR_NONE;
    }
    /** @type {number[]} */
    const numbers = [];
    for (const part of parts)
    {
        if (!/^\d+$/.test(part))
        {
            return INADDR_NONE;
        }
        numbers.push(Number(part));
    }
    // Every part but the last is one byte; the last fills the remainder.
    const leading = numbers.slice(0, -1);
    const tail = numbers[numbers.length - 1];
    if (leading.some(value=>value > 0xff))
    {
        return INADDR_NONE;
    }
    const tailBits = (4 - leading.length) * 8;
    if (tailBits < 32 && tail >= 2 ** tailBits)
    {
        return INADDR_NONE;
    }
    let result = 0;
    for (const value of leading)
    {
        result = (result << 8 | value) >>> 0;
    }
    return ((result * 2 ** tailBits) + tail) >>> 0;
}

/** @param {number} host host order @returns {string} */
export function formatAddress(host){
    return [24, 16, 8, 0].map(shift=>(host >>> shift) & 0xff).join('.');
}

/**
 * The key an address is bound under.
 *
 * Datagram and stream sockets get separate key spaces, and that separation is
 * the whole of why a UDP discovery datagram cannot land in a TCP stream that
 * happens to share its port. Both protocols really do use the same port numbers
 * independently, so one space would be wrong as well as dangerous.
 *
 * @param {boolean} stream
 * @param {Address} address
 */
export const addressKey = (stream, address)=>
    `${stream ? 'tcp' : 'udp'}:${formatAddress(address.host)}:${address.port}`;
