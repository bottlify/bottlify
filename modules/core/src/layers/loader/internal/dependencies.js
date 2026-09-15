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

import { parsePe, readImports } from './pe.js';

/**
 * @typedef {Object} Dependency
 * @property {string} name    As an import descriptor spells it.
 * @property {Uint8Array} file  The raw bytes read from the volume.
 */

/**
 * @param {Object} options
 * @param {Uint8Array} options.entry   The executable.
 * @param {(name: string) => Promise<Uint8Array | null>} options.readLibrary
 *        Finds a library beside the program and reads it, or answers null when
 *        there is no such file. Asynchronous because the volume may have to
 *        fetch it; this runs before the first guest instruction, so it may wait.
 * @param {(name: string) => boolean} options.isSystem
 *        Whether this engine provides the library itself. Only a fallback:
 *        a name the program brought is planned from its file even when this
 *        says yes, because that is the file the loader maps on Windows.
 * @param {(name: string) => boolean} options.isKnownDll
 *        Whether the name is one Windows maps out of the system directory and
 *        never looks for beside the program. These are ours whatever is on the
 *        volume: the file, if any, is ignored.
 * @returns {Promise<{ order: Dependency[], missing: string[] }>}
 *        `order` is dependency-first and excludes the executable. `missing`
 *        names libraries that are neither ours nor present in the volume --
 *        recorded rather than thrown, because a program that never calls into
 *        one still runs, and one that does fails where it called.
 */
export async function planDependencies({ entry, readLibrary, isSystem, isKnownDll }){
    /** @type {Dependency[]} */
    const order = [];
    /** @type {string[]} */
    const missing = [];
    /** Lower-cased, because an import descriptor's spelling is not dependable. */
    const seen = new Set();

    /**
     * @param {Uint8Array} file
     * @returns {string[]} the libraries this image imports
     */
    const importsOf = file=>{
        const image = parsePe(file);
        return readImports(file, image).map(entry_=>entry_.dll);
    };

    /** @param {Uint8Array} file */
    const visit = async file=>{
        for (const name of importsOf(file))
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

            const bytes = await readLibrary(name);
            if (!bytes)
            {
                // Ours only when no such file exists: the table is the
                // fallback, not the first answer.
                if (!isSystem(name))
                {
                    missing.push(name);
                }
                continue;
            }
            await visit(bytes);
            order.push({ name, file: bytes });
        }
    };

    await visit(entry);
    return { order, missing };
}
