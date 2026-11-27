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

import { contentName } from '../../../system/hash.js';
import { utf8 } from '../../../system/text.js';

/** @typedef {import('../../cache/module.js').CacheSpace} CacheSpace */

/** @typedef {{ name: string, system: boolean, parent: string, text: string }} Included */

/**
 * What a compile answered, as far as a program sees it.
 *
 * @typedef {{ ok: boolean, messages: string, tokens: Uint32Array | null,
 *     constantTable: Uint8Array | null }} KeptResult
 */

/**
 * A compile's name in the cache, by its key's text: the body's key is what
 * tells two keys that share a name apart.
 *
 * @param {string} text @returns {string}
 */
export const compileName = text=>contentName(text);

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
    const header = utf8.encode(JSON.stringify({ key, included, ok: result.ok,
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
    const header = JSON.parse(utf8.decode(body.slice(4, 4 + length)));
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

/**
 * The compiles kept in `space`: `find` the one under `key`, `keep` one done.
 *
 * @param {CacheSpace} space
 */
export function createCompileCache(space){
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
