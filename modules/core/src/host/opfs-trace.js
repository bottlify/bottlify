/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Where an origin-private file system call that failed was made.
 *
 * An OPFS call answers by a promise, and the DOMException it rejects with
 * carries no stack: a run stopped by one says "A requested file or directory
 * could not be found" and nothing of which call, on which file, from where.
 * Wrapped here, each call takes its caller's stack before it starts, and a
 * rejection is rethrown as an Error that keeps the DOMException's name (code
 * that tells NotFoundError from NoModificationAllowedError still can), names
 * the call and the entry, and has that stack.
 *
 * A measurement, not behaviour: only a diagnostics build installs it.
 */

/** @type {[string, string[]][]} */
const CALLS = [
    ['FileSystemDirectoryHandle', ['getFileHandle', 'getDirectoryHandle', 'removeEntry']],
    ['FileSystemFileHandle', ['getFile', 'createSyncAccessHandle', 'createWritable']],
    ['FileSystemWritableFileStream', ['write', 'truncate', 'close']],
];

/**
 * @param {any} scope  the worker's global
 * @returns {number} how many calls were wrapped
 */
export function traceOpfsRejections(scope){
    let wrapped = 0;
    for (const [type, names] of CALLS)
    {
        const proto = scope[type]?.prototype;
        for (const name of names)
        {
            const original = proto?.[name];
            if (typeof original !== 'function' || original.traced)
            {
                continue;
            }
            /** @this {any} @param {any[]} args */
            const traced = function(...args){
                const site = new Error(`${type}.${name}(${typeof args[0] === 'string'
                    ? JSON.stringify(args[0]) : ''}) on "${this?.name ?? '?'}"`);
                return original.apply(this, args).catch((/** @type {any} */ e)=>{
                    throw Object.assign(site, {
                        name: e?.name ?? 'Error',
                        message: `${e?.message ?? e} -- ${site.message}`,
                        cause: e,
                    });
                });
            };
            traced.traced = true;
            proto[name] = traced;
            wrapped++;
        }
    }
    return wrapped;
}
