/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The engine's libraries made when first asked for. A process loads a few of
 * the ~150 the engine provides; made at its start, every table's functions
 * and the state their factories keep were most of what a process held (some
 * 7 MiB each, for a program that imports kernel32 alone).
 *
 * A library is `define`d by the function that makes it; what another part of
 * the engine adds to it or takes from it - a name shared with a library of
 * another name, an entry Windows moved between two - is a `patch`, applied
 * when it is made, in the order the patches were given, or at once when it
 * was made already. `each` is a patch of every library. The table is a plain
 * object whose properties are getters: its names are read without making
 * anything (`Object.keys`, `in`); a value read is made then.
 */

/**
 * @typedef {Record<string, any>} Library
 * @typedef {{
 *     table: Record<string, Library>,
 *     define: (name: string, make: () => Library) => void,
 *     patch: (name: string, apply: (library: Library) => void) => void,
 *     each: (apply: (library: Library, name: string) => void) => void,
 *     made: (name: string) => boolean,
 * }} LazyLibraries
 */

/**
 * The libraries whose factories register COM classes: made when a CLSID is
 * first not found (`ComRegistry.whenMissing`), so a program that asks for one
 * by its CLSID alone finds it, as Windows finds its server in the registry.
 */
export const CLASS_SERVERS = Object.freeze(['ole32.dll', 'SHELL32.dll', 'windowscodecs.dll']);

/**
 * @param {{ around?: (name: string, make: () => Library) => Library }} [options]
 *     `around`: runs each library's making, for a check of what it did
 * @returns {LazyLibraries}
 */
export function createLazyLibraries({ around = (name, make)=>make() } = {}){
    /** @type {Record<string, Library>} */
    const table = {};
    /** @type {Map<string, () => Library>} */
    const makers = new Map();
    /** @type {Map<string, Library>} */
    const made = new Map();
    /** @type {Map<string, ((library: Library) => void)[]>} */
    const patches = new Map();
    /** @type {((library: Library, name: string) => void)[]} */
    const everyOne = [];

    /** @param {string} name */
    const make = name=>{
        const already = made.get(name);
        if (already !== undefined)
        {
            return already;
        }
        const maker = /** @type {() => Library} */ (makers.get(name));
        const library = around(name, maker);
        // Known before its patches run, so one that reads it back - or reads
        // a library that reads it - finds it rather than making it twice.
        made.set(name, library);
        for (const apply of patches.get(name) ?? [])
        {
            apply(library);
        }
        patches.delete(name);
        for (const apply of everyOne)
        {
            apply(library, name);
        }
        return library;
    };

    // Carried by `mergeLibraries` as it is, so a merged table asks this one:
    // a library taken out of it since is gone from the merge too.
    /** @param {string} name */
    const describe = name=>Object.defineProperty(table, name, {
        enumerable: true,
        configurable: true,
        get: ()=>(Object.hasOwn(table, name) ? make(name) : undefined),
        set: value=>{
            makers.set(name, ()=>value);
            made.delete(name);
        },
    });

    return {
        table,
        define(name, maker){
            makers.set(name, maker);
            made.delete(name);
            describe(name);
        },
        patch(name, apply){
            const library = made.get(name);
            if (library !== undefined)
            {
                apply(library);
                return;
            }
            const waiting = patches.get(name) ?? [];
            waiting.push(apply);
            patches.set(name, waiting);
        },
        each(apply){
            everyOne.push(apply);
            for (const [name, library] of made)
            {
                apply(library, name);
            }
        },
        made: name=>made.has(name),
    };
}

