/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A folder on this disk with the shape of a directory handle of the origin's
 * private file system -- the part the translation store uses (`getFileHandle`,
 * `getDirectoryHandle`, `entries`, `removeEntry`, a file's `getFile` and its
 * synchronous access handle). Node has no such file system, and a store in
 * memory is gone when the run ends: over a folder, a second run of a tool finds
 * the regions the first one translated, as a player's second start does.
 */

import { closeSync, existsSync, fstatSync, ftruncateSync, mkdirSync, openSync, readdirSync,
    readFileSync, readSync, rmSync, statSync, writeSync } from 'node:fs';
import { join } from 'node:path';

/** @param {string} name */
const notFound = name=>new DOMException(`${name} not found`, 'NotFoundError');

/** @param {string} path */
function fileHandle(path){
    return {
        kind: 'file',
        async getFile(){
            const bytes = readFileSync(path);
            return { size: bytes.length, arrayBuffer: async()=>bytes.buffer.slice(
                bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
        },
        async createSyncAccessHandle(){
            const fd = openSync(path, 'r+');
            return {
                getSize: ()=>fstatSync(fd).size,
                /** @param {Uint8Array} into @param {{ at: number }} where */
                read: (into, { at })=>readSync(fd, into, 0, into.length, at),
                /** @param {Uint8Array} from @param {{ at: number }} where */
                write: (from, { at })=>writeSync(fd, from, 0, from.length, at),
                /** @param {number} length */
                truncate: length=>ftruncateSync(fd, length),
                flush(){},
                close: ()=>closeSync(fd),
            };
        },
    };
}

/**
 * @param {string} path  the folder; made when it is not there
 * @returns {{ getDirectoryHandle: Function, getFileHandle: Function,
 *     entries: () => AsyncGenerator<[string, any]>, removeEntry: Function }}
 */
export function diskDirectory(path){
    mkdirSync(path, { recursive: true });
    /**
     * @param {string} name @param {{ create?: boolean }} options
     * @param {boolean} folder
     */
    const child = (name, options, folder)=>{
        const at = join(path, name);
        if (!existsSync(at))
        {
            if (!options.create)
            {
                throw notFound(name);
            }
            if (folder)
            {
                mkdirSync(at);
            }
            else
            {
                closeSync(openSync(at, 'w'));
            }
        }
        else if (statSync(at).isDirectory() !== folder)
        {
            throw new DOMException(`${name} is the other kind`, 'TypeMismatchError');
        }
        return folder ? diskDirectory(at) : fileHandle(at);
    };
    return {
        /** @param {string} name @param {{ create?: boolean }} [options] */
        getDirectoryHandle: async(name, options = {})=>child(name, options, true),
        /** @param {string} name @param {{ create?: boolean }} [options] */
        getFileHandle: async(name, options = {})=>child(name, options, false),
        async* entries(){
            for (const entry of readdirSync(path, { withFileTypes: true }))
            {
                const at = join(path, entry.name);
                yield [entry.name, entry.isDirectory() ? diskDirectory(at) : fileHandle(at)];
            }
        },
        /** @param {string} name @param {{ recursive?: boolean }} [options] */
        removeEntry: async(name, options = {})=>{
            rmSync(join(path, name), { recursive: options.recursive === true });
        },
    };
}
