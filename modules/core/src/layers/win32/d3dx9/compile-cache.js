/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The shader compiles D3DX has done, kept in the run's cache (the `cache`
 * layer's space handed in) rather than beside it: a program that asks for the
 * same compile again -- every frame, as some do after a refusal; again in each
 * process it starts, as a shader cache warmer does -- is given the earlier
 * answer by any process of the run, and one nobody asked for in a while goes
 * as every other body of the cache does, to be compiled again if it is asked
 * for after.
 *
 * A compile is named by a digest of what went into it, since that is the
 * whole source; the body carries the whole key too, so two compiles whose
 * digests meet are told apart and the later one is a miss. The body:
 *
 *     u32 header bytes | header (UTF-8 JSON) | tokens | constant table
 *
 * the header holding the key, the files the compile included (to be found the
 * same before the answer is), whether it compiled, its messages, and the bytes
 * of the tokens and of the table (null for none).
 */

import { FNV_PRIME, fnv1aString } from '../../../system/hash.js';

/** @typedef {import('../../cache/module.js').CacheSpace} CacheSpace */

/** @typedef {{ name: string, system: boolean, parent: string, text: string }} Included */

/**
 * What a compile answered, as far as a program sees it.
 *
 * @typedef {{ ok: boolean, messages: string, tokens: Uint32Array | null,
 *     constantTable: Uint8Array | null }} KeptResult
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * A digest of `text` to name it by: FNV-1a over its UTF-16 units, and a
 * second lane from another seed that folds its high bits down at each step.
 * Not a promise of no collision -- the body's key is -- only a name short
 * enough for the cache's table; kept as it is, since the cache keeps the names.
 *
 * @param {string} text @returns {string}
 */
export function compileName(text){
    const a = fnv1aString(text);
    let b = 0x050c5d1f;
    for (let i = 0; i < text.length; i++)
    {
        b = Math.imul(b ^ text.charCodeAt(i), FNV_PRIME) ^ b >>> 15;
    }
    return `${a.toString(16).padStart(8, '0')}${(b >>> 0).toString(16).padStart(8, '0')}`
        + `-${text.length.toString(36)}`;
}

/**
 * A compile as the body the cache keeps.
 *
 * @param {string} key @param {Included[]} included @param {KeptResult} result
 * @returns {Uint8Array}
 */
function encodeCompile(key, included, result){
    const tokens = result.tokens
        ? new Uint8Array(result.tokens.buffer, result.tokens.byteOffset, result.tokens.byteLength)
        : null;
    const table = result.constantTable;
    const header = encoder.encode(JSON.stringify({ key, included, ok: result.ok,
        messages: result.messages, tokens: tokens?.length ?? null, table: table?.length ?? null }));
    const body = new Uint8Array(4 + header.length + (tokens?.length ?? 0) + (table?.length ?? 0));
    new DataView(body.buffer).setUint32(0, header.length, true);
    body.set(header, 4);
    let at = 4 + header.length;
    if (tokens)
    {
        body.set(tokens, at);
        at += tokens.length;
    }
    if (table)
    {
        body.set(table, at);
    }
    return body;
}

/**
 * The compile a body holds, copied out of it, or null where it holds another
 * key's or is not one.
 *
 * @param {Uint8Array} body @param {string} key
 * @returns {{ included: Included[], result: KeptResult } | null}
 */
function decodeCompile(body, key){
    if (body.length < 4)
    {
        return null;
    }
    const length = new DataView(body.buffer, body.byteOffset, 4).getUint32(0, true);
    if (4 + length > body.length)
    {
        return null;
    }
    // The body is the cache's shared memory, which TextDecoder will not read.
    const header = JSON.parse(decoder.decode(body.slice(4, 4 + length)));
    if (header.key !== key)
    {
        return null;
    }
    let at = 4 + length;
    const tokensBytes = header.tokens;
    const tableBytes = header.table;
    if (at + (tokensBytes ?? 0) + (tableBytes ?? 0) !== body.length)
    {
        return null;
    }
    const tokens = tokensBytes === null ? null
        : new Uint32Array(body.slice(at, at + tokensBytes).buffer);
    at += tokensBytes ?? 0;
    const constantTable = tableBytes === null ? null : body.slice(at, at + tableBytes);
    return { included: header.included,
        result: { ok: header.ok, messages: header.messages, tokens, constantTable } };
}

/** Where a layer built without the run's cache keeps its compiles: nowhere. @type {CacheSpace} */
const KEEP_NOTHING = Object.freeze({
    look: ()=>null, with: ()=>undefined, put: ()=>false, drop: ()=>{},
});

/**
 * The compiles kept in `space`: `find` the one under `key`, `keep` one done.
 *
 * @param {CacheSpace} [space]  none: nothing is kept, and each compile is done again
 */
export function createCompileCache(space = KEEP_NOTHING){
    return {
        /** @param {string} key */
        find: key=>space.with(compileName(key), body=>decodeCompile(body, key)) ?? null,
        /**
         * Kept where the cache has room; a compile it has none for is done
         * again when asked for again. A body kept under the name before
         * (another key whose digest met this one's) is taken away by the put.
         *
         * @param {string} key @param {Included[]} included @param {KeptResult} result
         */
        keep: (key, included, result)=>space.put(compileName(key),
            encodeCompile(key, included, result)),
    };
}
