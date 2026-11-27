/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Which libraries a program needs, and the order to load them in.
 *
 * A program's imports name two completely different kinds of library, and
 * treating them alike is the mistake this file exists to prevent. A KnownDLL
 * is one Windows maps out of the system directory and never looks for beside
 * the program: kernel32, user32, gdi32, ole32 and the rest, and its exports are
 * ours -- synthesised into guest memory as a real module. Everything else the
 * program may have brought with it -- a sound engine, a video decoder, a
 * vendor's own runtime, a `d3dx9_*` -- is real x86 code sitting in the volume
 * beside the executable, and the only correct thing to do with it is load it
 * and let it run. Our own table for such a name is the fallback for when the
 * program did not bring a file, not the first answer.
 *
 * So this walks the import graph, and every name it meets that is not a
 * KnownDLL is a file to look for; when it is not there and we have a table for
 * it, that table is the answer, and otherwise the name is recorded missing.
 * A missing name is one of two things. A library Windows itself carries
 * (`isWindowsLibrary`) that the engine does not recreate is the engine's gap:
 * the program still starts, as it would have on Windows, and fails where it
 * calls in. A library in no list, imported by a static import table, is one the
 * program was meant to bring: Windows does not start such a process
 * (STATUS_DLL_NOT_FOUND), and neither does the engine (`absent`). A delay-loaded
 * one fails on its first call on Windows, not at the start, and stays missing.
 *
 * Order matters and is not merely tidiness. A library's own imports have to
 * resolve against libraries that are already mapped, so the graph is emitted
 * depth-first: a dependency appears before whatever depends on it, and the
 * executable is last. DllMain is called in that same order, which is what a
 * library initialising against another library's state requires.
 *
 * Cycles are ordinary. Two libraries importing each other is not a defect and
 * must not deadlock the walk: a name already being visited is emitted once, in
 * the position its first visit gives it, and the binding pass afterwards -- run
 * over every image once they are all mapped -- is what actually resolves the
 * mutual references.
 */

import { parsePe, readExports, readImports } from './pe.js';
import { readDelayImports } from './delayload.js';

/**
 * @typedef {Object} Dependency
 * @property {string} name    As an import descriptor spells it.
 * @property {Uint8Array} file  The raw bytes read from the volume.
 */

/**
 * @param {Object} options
 * @param {Uint8Array} options.entry   The executable.
 * @param {string} [options.entryName]
 *        The executable's file name. A library that imports from the program
 *        names it, and is bound to the program already there: Windows looks in
 *        the loaded-module list before it looks on disk, and a second copy
 *        planned as a library would have the program's own startup run as its
 *        DllMain.
 * @param {(name: string, wanted: import('./pe.js').ImportEntry[]) =>
 *     Promise<Uint8Array | null>} options.readLibrary
 *        Finds a library beside the program and reads it, or answers null when
 *        there is no such file. Asynchronous because the volume may have to
 *        fetch it; this runs before the first guest instruction, so it may wait.
 *        Told what the image that names it imports from it: a table of ours
 *        that lacks some of that is not the answer while a file of the name
 *        is on the volume.
 * @param {(name: string) => boolean} options.isSystem
 *        Whether this engine provides the library itself. Only a fallback:
 *        a name the program brought is planned from its file even when this
 *        says yes, because that is the file the loader maps on Windows.
 * @param {(name: string) => boolean} options.isKnownDll
 *        Whether the name is one Windows maps out of the system directory and
 *        never looks for beside the program. These are ours whatever is on the
 *        volume: the file, if any, is ignored.
 * @param {(name: string) => boolean} [options.isWindowsLibrary]
 *        Whether Windows itself carries the library. Not given, every missing
 *        name is taken to be one, and nothing is `absent`.
 * @returns {Promise<{ order: Dependency[], missing: string[], absent: string[] }>}
 *        `order` is dependency-first and excludes the executable. `missing`
 *        names libraries that are neither ours nor present in the volume --
 *        recorded rather than thrown, because a program that never calls into
 *        one still runs, and one that does fails where it called. `absent` is
 *        the part of it that ends the start: statically imported, and carried
 *        by no Windows.
 */
export async function planDependencies(options){
    const { entry, entryName, readLibrary, isSystem, isKnownDll } = options;
    const isWindowsLibrary = options.isWindowsLibrary ?? (()=>true);
    /** @type {Dependency[]} */
    const order = [];
    /** @type {string[]} */
    const missing = [];
    /** @type {string[]} */
    const absent = [];
    /** Lower-cased, because an import descriptor's spelling is not dependable. */
    const seen = new Set(entryName ? [entryName.toLowerCase()] : []);

    /**
     * The libraries this image imports, the delay-loaded ones with them: the
     * loader binds a delay-load table up front, before the program runs, so
     * a library the program brought for it has to be mapped by then -- or
     * its slots are bound to nothing while the file sits beside the program.
     *
     * @param {Uint8Array} file
     * @returns {{ dll: string, entries: import('./pe.js').ImportEntry[], delayed: boolean }[]}
     */
    const importsOf = file=>{
        // Read alone, so an x86-64 program's imports are walked as well.
        const image = parsePe(file, { wide: true });
        return [...readImports(file, image).map(table=>({ ...table, delayed: false })),
            ...readDelayImports(file, image).map(table=>({ ...table, delayed: true }))];
    };

    /**
     * The libraries a library's forwarders lead to, for the imports taken
     * from it that are forwarded: what Windows' loader loads to snap such an
     * import ("LIB.Name", "LIB.#7"), so they are planned before it.
     *
     * @param {Uint8Array} file
     * @param {import('./pe.js').ImportEntry[]} wanted
     * @param {boolean} delayed
     * @returns {{ dll: string, entries: import('./pe.js').ImportEntry[], delayed: boolean }[]}
     */
    const forwardsOf = (file, wanted, delayed)=>{
        let exports;
        try
        {
            exports = readExports(file, parsePe(file, { wide: true })).exports;
        }
        catch {
            return [];
        }
        const forwarders = exports.filter(each=>each.forwards !== null);
        if (forwarders.length === 0)
        {
            return [];
        }
        const byName = new Map(forwarders.filter(each=>each.name !== null)
            .map(each=>[String(each.name), each.forwards]));
        const byOrdinal = new Map(forwarders.map(each=>[each.ordinal, each.forwards]));
        /** @type {Map<string, import('./pe.js').ImportEntry[]>} */
        const targets = new Map();
        for (const asked of wanted)
        {
            const forward = (asked.name !== null ? byName.get(asked.name)
                : byOrdinal.get(asked.ordinal ?? -1)) ?? null;
            const dot = forward === null ? -1 : forward.lastIndexOf('.');
            if (forward === null || dot <= 0)
            {
                continue;
            }
            const exported = forward.slice(dot + 1);
            const dll = `${forward.slice(0, dot)}.dll`;
            const list = targets.get(dll) ?? [];
            list.push(exported.startsWith('#')
                ? { name: null, ordinal: Number(exported.slice(1)) >>> 0, iatRva: 0 }
                : { name: exported, ordinal: null, iatRva: 0 });
            targets.set(dll, list);
        }
        return [...targets].map(([dll, entries])=>({ dll, entries, delayed }));
    };

    /**
     * @param {{ dll: string, entries: import('./pe.js').ImportEntry[],
     *     delayed: boolean }[]} imports
     */
    const visit = async imports=>{
        for (const { dll: name, entries, delayed } of imports)
        {
            const key = name.toLowerCase();
            if (seen.has(key) || isKnownDll(name))
            {
                continue;
            }
            // Marked before its own imports are walked, so a cycle terminates
            // and a library that imports back into this one is not visited
            // twice.
            seen.add(key);

            const bytes = await readLibrary(name, entries);
            if (!bytes)
            {
                // Ours only when no such file exists: the table is the
                // fallback, not the first answer.
                if (!isSystem(name))
                {
                    missing.push(name);
                    if (!delayed && !isWindowsLibrary(name))
                    {
                        absent.push(name);
                    }
                }
                continue;
            }
            await visit([...forwardsOf(bytes, entries, delayed), ...importsOf(bytes)]);
            order.push({ name, file: bytes });
        }
    };

    await visit(importsOf(entry));
    return { order, missing, absent };
}
