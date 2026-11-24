/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Disks for the cache's tests: in memory, and over a directory of node's file
 * system, both in the shape of OPFS's synchronous handles. Opening answers a
 * promise, as OPFS does.
 */

import fs from 'node:fs';
import path from 'node:path';

/** @returns {import('./keeper.js').Disk & { files: Map<string, Uint8Array> }} */
export function memoryDisk(){
    /** @type {Map<string, Uint8Array>} */
    const files = new Map();
    return {
        files,
        async open(name){
            if (!files.has(name))
            {
                files.set(name, new Uint8Array(0));
            }
            // Room grows by doubling; the file's size is kept apart from it.
            let room = /** @type {Uint8Array} */ (files.get(name));
            let size = room.length;
            const keep = ()=>files.set(name, room.subarray(0, size));
            return {
                read(view, { at }){
                    const part = room.subarray(at, Math.min(size, at + view.length));
                    view.set(part);
                    return part.length;
                },
                write(view, { at }){
                    if (at + view.length > room.length)
                    {
                        const larger = new Uint8Array(Math.max(at + view.length, room.length * 2));
                        larger.set(room.subarray(0, size));
                        room = larger;
                    }
                    room.set(view, at);
                    size = Math.max(size, at + view.length);
                    keep();
                    return view.length;
                },
                flush(){},
                getSize: ()=>size,
                truncate(length){
                    size = Math.min(size, length);
                    keep();
                },
                close(){},
            };
        },
    };
}

/** @param {string} directory @returns {import('./keeper.js').Disk} */
export function directoryDisk(directory){
    fs.mkdirSync(directory, { recursive: true });
    return {
        async open(name){
            const file = path.join(directory, name);
            const fd = fs.openSync(file, fs.existsSync(file) ? 'r+' : 'w+');
            return {
                read: (view, { at })=>fs.readSync(fd, view, 0, view.length, at),
                write: (view, { at })=>fs.writeSync(fd, view, 0, view.length, at),
                flush: ()=>fs.fsyncSync(fd),
                getSize: ()=>fs.fstatSync(fd).size,
                truncate: size=>fs.ftruncateSync(fd, size),
                close: ()=>fs.closeSync(fd),
            };
        },
        remove: name=>fs.rmSync(path.join(directory, name), { force: true }),
    };
}
