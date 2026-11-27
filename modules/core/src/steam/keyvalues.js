/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Valve's KeyValues, the two forms product info comes in: text (an app's
 * info -- name, type, launch options, depots) and binary (a package's: which
 * apps and depots a licence grants). Both become nested objects of strings;
 * a binary integer becomes a number, a 64-bit one a BigInt. Keys keep their
 * case: Valve's own data is not consistent about it, and a reader that needs
 * to can look a key up either way.
 */

/** @typedef {{ [key: string]: KeyValue }} KeyValues */
/** @typedef {string | number | bigint | KeyValues} KeyValue */

/**
 * Parses text KeyValues: "key" "value" pairs and "key" { ... } blocks, with
 * // comments, unquoted tokens, escapes in quotes, and the [$PLATFORM]
 * conditions after a value -- which are read past, the value kept.
 *
 * @param {string} text
 * @returns {KeyValues}
 */
export function parseText(text){
    let at = 0;
    const skip = ()=>{
        for (;;)
        {
            while (at < text.length && /\s/.test(text[at]))
            {
                at++;
            }
            if (text.startsWith('//', at))
            {
                while (at < text.length && text[at] !== '\n')
                {
                    at++;
                }
                continue;
            }
            return;
        }
    };
    /** @returns {string | null} a token, or null at a brace or the end */
    const token = ()=>{
        skip();
        if (at >= text.length || text[at] === '{' || text[at] === '}' || text[at] === '\0')
        {
            return null;
        }
        if (text[at] === '"')
        {
            let out = '';
            at++;
            while (at < text.length && text[at] !== '"')
            {
                if (text[at] === '\\' && at + 1 < text.length)
                {
                    const next = text[at + 1];
                    out += next === 'n' ? '\n' : next === 't' ? '\t' : next;
                    at += 2;
                    continue;
                }
                out += text[at++];
            }
            at++;
            return out;
        }
        const start = at;
        while (at < text.length && !/[\s{}"]/.test(text[at]))
        {
            at++;
        }
        return text.slice(start, at);
    };
    const condition = ()=>{
        skip();
        if (text[at] === '[')
        {
            at = text.indexOf(']', at) + 1 || text.length;
        }
    };
    /** @param {boolean} nested @returns {KeyValues} */
    const block = nested=>{
        /** @type {KeyValues} */
        const out = {};
        for (;;)
        {
            const key = token();
            if (key === null)
            {
                skip();
                if (text[at] === '}')
                {
                    if (!nested)
                    {
                        throw new SyntaxError('keyvalues: a } with no { before it');
                    }
                    at++;
                }
                else if (nested)
                {
                    throw new SyntaxError(`keyvalues: a block not closed, at ${at}`);
                }
                return out;
            }
            skip();
            if (text[at] === '{')
            {
                at++;
                out[key] = block(true);
            }
            else
            {
                const value = token();
                if (value === null)
                {
                    throw new SyntaxError(`keyvalues: "${key}" has no value`);
                }
                out[key] = value;
            }
            condition();
        }
    };
    return block(false);
}

const TYPE_NONE = 0;
const TYPE_STRING = 1;
const TYPE_INT32 = 2;
const TYPE_FLOAT32 = 3;
const TYPE_POINTER = 4;
const TYPE_WIDESTRING = 5;
const TYPE_COLOR = 6;
const TYPE_UINT64 = 7;
const TYPE_END = 8;
const TYPE_INT64 = 10;
const TYPE_ALTERNATE_END = 11;

/**
 * Parses binary KeyValues: a type byte, a NUL-ended name, the value; a
 * subtree ends with an end byte.
 *
 * @param {Uint8Array} bytes
 * @returns {KeyValues}
 */
export function parseBinary(bytes){
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const utf8 = new TextDecoder();
    let at = 0;
    const string = ()=>{
        const end = bytes.indexOf(0, at);
        if (end < 0)
        {
            throw new RangeError('keyvalues: a name runs past the data');
        }
        const out = utf8.decode(bytes.subarray(at, end));
        at = end + 1;
        return out;
    };
    /** @param {number} size */
    const need = size=>{
        if (at + size > bytes.length)
        {
            throw new RangeError('keyvalues: a value runs past the data');
        }
    };
    /** @returns {KeyValues} */
    const block = ()=>{
        /** @type {KeyValues} */
        const out = {};
        while (at < bytes.length)
        {
            const type = bytes[at++];
            if (type === TYPE_END || type === TYPE_ALTERNATE_END)
            {
                return out;
            }
            const key = string();
            switch (type)
            {
                case TYPE_NONE: out[key] = block(); break;
                case TYPE_STRING: out[key] = string(); break;
                case TYPE_WIDESTRING:
                {
                    // UTF-16, ended by a NUL character.
                    let end = at;
                    while (end + 1 < bytes.length && (bytes[end] || bytes[end + 1]))
                    {
                        end += 2;
                    }
                    out[key] = new TextDecoder('utf-16le').decode(bytes.subarray(at, end));
                    at = end + 2;
                    break;
                }
                case TYPE_INT32: case TYPE_POINTER: case TYPE_COLOR:
                    need(4); out[key] = view.getInt32(at, true); at += 4; break;
                case TYPE_FLOAT32: need(4); out[key] = view.getFloat32(at, true); at += 4; break;
                case TYPE_UINT64: need(8); out[key] = view.getBigUint64(at, true); at += 8; break;
                case TYPE_INT64: need(8); out[key] = view.getBigInt64(at, true); at += 8; break;
                default:
                    throw new RangeError(`keyvalues: type ${type} is not binary KeyValues`);
            }
        }
        return out;
    };
    return block();
}
