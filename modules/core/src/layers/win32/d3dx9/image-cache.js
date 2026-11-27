/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The images D3DX's texture loaders decoded, kept in the run's cache (the
 * `cache` layer's space handed in) rather than in this heap: a program that
 * makes a texture of the same file again - a level reloaded, a material
 * shared by many meshes, another process of the run - is given the levels
 * decoded the first time, read in place, and the file is not decoded again.
 * A body the cache let go is made again from the file, as on its first
 * create, so the bodies are never the only copy (`disk: 'never'`, the space's
 * default).
 *
 * A decode is named by a digest of the file's bytes and by what the loader
 * was asked (the size, levels, format, colour key and kind), and the body
 * carries both whole: the file's bytes, compared in place, tell two files
 * whose digests meet apart, and the later one is a miss. The body:
 *
 *     u32 header bytes | header (UTF-8 JSON) | the file's bytes | each level's bytes
 *
 * the header holding what was asked, the file's length, the image's
 * description (D3DXIMAGE_INFO's words), the texture made of it (size, depth,
 * levels, format, cube), and each face's levels' lengths.
 *
 * Only a decode is kept: levels the file holds as they go up (a DDS in the
 * format asked) are views of its bytes, which the next create reads again.
 */

import { contentName } from '../../../system/hash.js';

/** @typedef {import('../../cache/module.js').CacheSpace} CacheSpace */

/**
 * The levels a loader writes into the texture it makes, in the texture's
 * format: plain, or read in place where the run's cache keeps them.
 *
 * @typedef {Object} Decoded
 * @property {number[]} info  D3DXIMAGE_INFO's seven words for the file
 * @property {number} w @property {number} h
 * @property {number} depth  0 but for a volume
 * @property {number} count  levels
 * @property {number} target  the texture's D3DFORMAT
 * @property {boolean} cube
 * @property {(face: number, level: number, write: (bytes: Uint8Array) => void) => boolean} read
 *     a level's bytes inside `write`, never kept past it; false where the cache no longer
 *     holds them, `write` not called
 */

/**
 * @typedef {Object} Plain
 * @property {number[]} info @property {number} w @property {number} h
 * @property {number} depth @property {number} count @property {number} target
 * @property {boolean} cube
 * @property {Uint8Array[][]} faces  each face's levels
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();


/**
 * Whether the bytes of `body` from `at` are `bytes`, compared in place.
 *
 * @param {Uint8Array} body @param {number} at @param {Uint8Array} bytes
 */
function holds(body, at, bytes){
    if (at + bytes.length > body.length)
    {
        return false;
    }
    for (let i = 0; i < bytes.length; i++)
    {
        if (body[at + i] !== bytes[i])
        {
            return false;
        }
    }
    return true;
}

/**
 * Whether a plain decode holds anything but views of the file's bytes: what
 * is worth keeping.
 *
 * @param {Plain} plain @param {Uint8Array} file
 */
export function decodedFrom(plain, file){
    return plain.faces.some(levels=>levels.some(level=>level.buffer !== file.buffer));
}

/** Where a layer built without the run's cache keeps its decodes: nowhere. @type {CacheSpace} */
const KEEP_NOTHING = Object.freeze({
    look: ()=>null, with: ()=>undefined, put: ()=>false, drop: ()=>{},
});

/**
 * The decodes kept in `space`: `find` the one of a file asked a way, `keep`
 * one made. What is asked is the caller's string: every argument the decode
 * depends on.
 *
 * @param {CacheSpace} [space]  none: nothing is kept, and each create decodes again
 */
export function createImageCache(space = KEEP_NOTHING){
    /**
     * A decode as the body the cache keeps.
     *
     * @param {string} asked @param {Uint8Array} file @param {Plain} plain
     * @returns {Uint8Array}
     */
    const encode = (asked, file, plain)=>{
        const lengths = plain.faces.map(levels=>levels.map(level=>level.length));
        const header = encoder.encode(JSON.stringify({ asked, file: file.length,
            info: plain.info, w: plain.w, h: plain.h, depth: plain.depth, count: plain.count,
            target: plain.target, cube: plain.cube, lengths }));
        const levels = lengths.flat().reduce((sum, length)=>sum + length, 0);
        const body = new Uint8Array(4 + header.length + file.length + levels);
        new DataView(body.buffer).setUint32(0, header.length, true);
        body.set(header, 4);
        body.set(file, 4 + header.length);
        let at = 4 + header.length + file.length;
        for (const level of plain.faces.flat())
        {
            body.set(level, at);
            at += level.length;
        }
        return body;
    };

    /**
     * What a body holds, read in place: its header and where each level
     * starts; null where it holds another file or ask, or is not one.
     *
     * @param {Uint8Array} body @param {string} asked @param {Uint8Array} file
     */
    const decode = (body, asked, file)=>{
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
        if (header.asked !== asked || header.file !== file.length
            || !holds(body, 4 + length, file))
        {
            return null;
        }
        /** @type {number[][]} */
        const starts = [];
        let at = 4 + length + file.length;
        for (const levels of /** @type {number[][]} */ (header.lengths))
        {
            starts.push(levels.map(level=>{
                const start = at;
                at += level;
                return start;
            }));
        }
        return at === body.length ? { header, starts, size: at } : null;
    };

    return {
        /**
         * The decode of `file` asked as `asked`, its levels read in place
         * where the cache keeps them; null on a miss.
         *
         * @param {string} asked @param {Uint8Array} file @returns {Decoded | null}
         */
        find(asked, file){
            const name = `${contentName(file)}/${asked}`;
            const found = space.with(name, body=>decode(body, asked, file)) ?? null;
            if (found === null)
            {
                return null;
            }
            const { header, starts, size } = found;
            return { info: header.info, w: header.w, h: header.h, depth: header.depth,
                count: header.count, target: header.target, cube: header.cube,
                read: (face, level, write)=>{
                    const start = starts[face][level];
                    const end = start + header.lengths[face][level];
                    // Under its name a body is the one found, the same made
                    // again, or none: another file's would need its digest to
                    // meet this one's, at its length, between the find and
                    // this read.
                    let read = false;
                    space.with(name, body=>{
                        if (body.length === size)
                        {
                            read = true;
                            write(body.subarray(start, end));
                        }
                    });
                    return read;
                } };
        },
        /**
         * Kept where the cache has room; a decode it has none for is made
         * again at the next create. A body kept under the name before (another
         * file whose digest met this one's) is taken away by the put.
         *
         * @param {string} asked @param {Uint8Array} file @param {Plain} plain
         */
        keep: (asked, file, plain)=>space.put(`${contentName(file)}/${asked}`,
            encode(asked, file, plain)),
    };
}

/**
 * A plain decode as a loader reads it.
 *
 * @param {Plain} plain @returns {Decoded}
 */
export function plainDecoded(plain){
    const { faces, ...shape } = plain;
    return { ...shape, read: (face, level, write)=>{
        write(faces[face][level]);
        return true;
    } };
}
