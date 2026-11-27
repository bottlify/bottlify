/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * inherited-files — the open files a child inherits, as they cross to a child
 * started on another thread.
 *
 * Windows duplicates an inheritable handle into the child at CreateProcess:
 * the child's handle names the parent's file object, so both move one file
 * pointer. A child on its parent's thread adopts the parent's open itself
 * (win32's `adoptFile`). A child in a worker of its own is handed values: the
 * handle's number, its rights and the open's terms, which it opens the file on
 * there; the position stays with the parent's open and is asked across the
 * link on each read and write (`handedFiles`). A file the parent handed as a
 * standard handle is one of these, nothing apart.
 */

/** The fields of an open file that cross: data, never its node or position. */
const CROSSING_FIELDS = /** @type {const} */ (['path', 'read', 'write', 'writeAttributes',
    'terms', 'mode', 'overlapped', 'deleteOnClose']);

/**
 * @typedef {object} CrossingFile
 * @property {number} handle  the number the child holds it by, the parent's
 * @property {'file'} type
 * @property {number | null} access  the handle's granted rights
 * @property {Record<string, any>} object  the open's fields, as values
 * @property {boolean} [consoleOnly]  handed only to a console program (`handedDown`)
 * @property {number} [flags]  the handle's HANDLE_FLAG_*, as the parent's table has them
 */

/**
 * The open files among a child's inherited handles, as values that cross.
 *
 * @param {{ handle: number, type: string, object: any, access?: number | null,
 *     consoleOnly?: boolean, flags?: number }[] | undefined} inherited
 * @returns {CrossingFile[]}
 */
export function crossingFiles(inherited){
    return (inherited ?? []).filter(one=>one.type === 'file' && one.object)
        .map(one=>({ handle: one.handle, type: 'file', access: one.access ?? null,
            ...one.consoleOnly ? { consoleOnly: true } : {},
            ...one.flags === undefined ? {} : { flags: one.flags },
            object: Object.fromEntries(CROSSING_FIELDS
                .filter(field=>one.object[field] !== undefined)
                .map(field=>[field, one.object[field]])) }));
}

/**
 * The parent's open a child holds under `handle`, whose position the child's
 * reads and writes move: null when it inherited no file by that number.
 *
 * @param {{ handle: number, type: string, object: any }[] | undefined} inherited
 * @param {number} handle
 * @returns {{ position: number } | null}
 */
export function inheritedOpen(inherited, handle){
    return inherited?.find(one=>one.type === 'file' && one.handle === handle)?.object ?? null;
}

/**
 * Crossed files as the child holds them: each open's position read and moved
 * through `position` and `setPosition`, where the parent's open keeps it.
 *
 * @param {CrossingFile[] | undefined} crossing
 * @param {(handle: number) => number} position
 * @param {(handle: number, at: number) => void} setPosition
 * @returns {{ handle: number, type: 'file', access: number | null, object: any }[]}
 */
export function handedFiles(crossing, position, setPosition){
    return (crossing ?? []).map(one=>({ ...one,
        object: Object.defineProperty({ ...one.object }, 'position', { enumerable: true,
            get: ()=>position(one.handle),
            set: (/** @type {number} */ at)=>{
                setPosition(one.handle, at);
            } }) }));
}
