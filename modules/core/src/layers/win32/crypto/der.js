/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A reader for the Distinguished Encoding Rules (ITU-T X.690), the encoding of
 * every certificate and signed message the verifier reads.
 *
 * A node is a window on the bytes it came from, never a copy: a signature is
 * checked over the exact bytes that were signed, so the encoding a node was read
 * from has to stay at hand. Only definite lengths are read -- DER has no other
 * -- and a length that runs past its parent is an error, not a truncation.
 */

/** Universal tags, with the constructed bit where the type always has it. */
export const TAG = Object.freeze({
    BOOLEAN: 0x01,
    INTEGER: 0x02,
    BIT_STRING: 0x03,
    OCTET_STRING: 0x04,
    NULL: 0x05,
    OID: 0x06,
    UTF8_STRING: 0x0c,
    PRINTABLE_STRING: 0x13,
    T61_STRING: 0x14,
    IA5_STRING: 0x16,
    UTC_TIME: 0x17,
    GENERALIZED_TIME: 0x18,
    BMP_STRING: 0x1e,
    SEQUENCE: 0x30,
    SET: 0x31,
});

/** A context-specific tag [n], constructed (EXPLICIT, or IMPLICIT over a constructed type). */
export const context = (/** @type {number} */ n)=>0xa0 | n;

/** A context-specific tag [n] over a primitive type. */
export const contextPrimitive = (/** @type {number} */ n)=>0x80 | n;

export class DerError extends Error {}

/**
 * @typedef {Object} DerNode
 * @property {Uint8Array} bytes      The buffer the node was read from.
 * @property {number} tag            Its identifier octet.
 * @property {number} start          Where its identifier octet is.
 * @property {number} contentStart   Where its contents begin.
 * @property {number} end            Just past its contents.
 */

/**
 * Reads the node at `at`, which must end by `limit`.
 *
 * @param {Uint8Array} bytes
 * @param {number} [at]
 * @param {number} [limit]
 * @returns {DerNode}
 */
export function readNode(bytes, at = 0, limit = bytes.length){
    if (at + 2 > limit)
    {
        throw new DerError(`no room for a node at ${at}`);
    }
    const tag = bytes[at];
    if ((tag & 0x1f) === 0x1f)
    {
        throw new DerError(`a high tag number at ${at}`);
    }
    let length = bytes[at + 1];
    let contentStart = at + 2;
    if (length & 0x80)
    {
        const count = length & 0x7f;
        if (count === 0 || count > 4)
        {
            throw new DerError(`a length of ${count} bytes at ${at}`);
        }
        if (contentStart + count > limit)
        {
            throw new DerError(`a length running past its parent at ${at}`);
        }
        length = 0;
        for (let i = 0; i < count; i++)
        {
            length = length * 256 + bytes[contentStart + i];
        }
        contentStart += count;
    }
    const end = contentStart + length;
    if (end > limit)
    {
        throw new DerError(`contents running past their parent at ${at}`);
    }
    return { bytes, tag, start: at, contentStart, end };
}

/** The node's whole encoding, header included. @param {DerNode} node */
export const encoding = node=>node.bytes.subarray(node.start, node.end);

/** The node's contents octets. @param {DerNode} node */
export const contents = node=>node.bytes.subarray(node.contentStart, node.end);

/**
 * The nodes inside a constructed one, in order.
 *
 * @param {DerNode} node
 * @returns {DerNode[]}
 */
export function childrenOf(node){
    if ((node.tag & 0x20) === 0)
    {
        throw new DerError(`a primitive node (tag ${node.tag}) has no children`);
    }
    const out = [];
    for (let at = node.contentStart; at < node.end;)
    {
        const child = readNode(node.bytes, at, node.end);
        out.push(child);
        at = child.end;
    }
    return out;
}

/**
 * The node itself, after checking its tag.
 *
 * @param {DerNode | undefined} node
 * @param {number} tag
 * @param {string} what  For the error.
 * @returns {DerNode}
 */
export function expect(node, tag, what){
    if (!node || node.tag !== tag)
    {
        throw new DerError(`expected ${what}`);
    }
    return node;
}

/** @param {DerNode} node @returns {string} */
export function readOid(node){
    const body = contents(expect(node, TAG.OID, 'an object identifier'));
    if (body.length === 0)
    {
        throw new DerError('an empty object identifier');
    }
    const arcs = [];
    let value = 0;
    for (const byte of body)
    {
        value = value * 128 + (byte & 0x7f);
        if ((byte & 0x80) === 0)
        {
            arcs.push(value);
            value = 0;
        }
    }
    const first = Math.min(Math.floor(arcs[0] / 40), 2);
    return [first, arcs[0] - first * 40, ...arcs.slice(1)].join('.');
}

/**
 * An INTEGER's value, two's complement as X.690 encodes it.
 *
 * @param {DerNode} node
 * @returns {bigint}
 */
export function readInteger(node){
    const body = contents(expect(node, TAG.INTEGER, 'an integer'));
    let value = 0n;
    for (const byte of body)
    {
        value = (value << 8n) | BigInt(byte);
    }
    if (body.length > 0 && (body[0] & 0x80))
    {
        value -= 1n << BigInt(body.length * 8);
    }
    return value;
}

/**
 * An unsigned big-endian magnitude, the form RSA moduli take: the sign octet a
 * positive INTEGER needs is dropped.
 *
 * @param {DerNode} node
 * @returns {Uint8Array}
 */
export function readUnsigned(node){
    const body = contents(expect(node, TAG.INTEGER, 'an integer'));
    let at = 0;
    while (at < body.length - 1 && body[at] === 0)
    {
        at++;
    }
    return body.subarray(at);
}

/** @param {DerNode} node @returns {boolean} */
export function readBoolean(node){
    const body = contents(expect(node, TAG.BOOLEAN, 'a boolean'));
    return body.length > 0 && body[0] !== 0;
}

/**
 * A BIT STRING's bytes, with the count of unused bits in the last one.
 *
 * @param {DerNode} node
 * @returns {{ unused: number, bits: Uint8Array }}
 */
export function readBitString(node){
    const body = contents(expect(node, TAG.BIT_STRING, 'a bit string'));
    if (body.length === 0 || body[0] > 7)
    {
        throw new DerError('a malformed bit string');
    }
    return { unused: body[0], bits: body.subarray(1) };
}

/**
 * A UTCTime or GeneralizedTime as milliseconds since 1970, in UTC. UTCTime's
 * two-digit year is 1950-2049 (RFC 5280, 4.1.2.5.1).
 *
 * @param {DerNode} node
 * @returns {number}
 */
export function readTime(node){
    const text = String.fromCharCode(...contents(node));
    const parts = node.tag === TAG.UTC_TIME
        ? /^(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)?Z$/.exec(text)
        : node.tag === TAG.GENERALIZED_TIME
            ? /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)?(?:\.\d+)?Z$/.exec(text)
            : null;
    if (!parts)
    {
        throw new DerError(`a time that is not one: ${text}`);
    }
    let year = Number(parts[1]);
    if (node.tag === TAG.UTC_TIME)
    {
        year += year < 50 ? 2000 : 1900;
    }
    return Date.UTC(year, Number(parts[2]) - 1, Number(parts[3]), Number(parts[4]),
        Number(parts[5]), Number(parts[6] ?? 0));
}

/**
 * A string type's text, for names in diagnostics: BMPString is UTF-16BE, the
 * others are read a byte to a character (UTF-8 decoded).
 *
 * @param {DerNode} node
 * @returns {string}
 */
export function readString(node){
    const body = contents(node);
    if (node.tag === TAG.BMP_STRING)
    {
        let text = '';
        for (let i = 0; i + 1 < body.length; i += 2)
        {
            text += String.fromCharCode((body[i] << 8) | body[i + 1]);
        }
        return text;
    }
    if (node.tag === TAG.UTF8_STRING)
    {
        return new TextDecoder().decode(body);
    }
    return String.fromCharCode(...body);
}
