/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

/**
 * Which libraries a program needs, and the order to load them in.
 *
 * A program's imports name two completely different kinds of library, and
 * treating them alike is the mistake this file exists to prevent. A system
 * library is one this engine provides: its exports are ours, synthesised into
 * guest memory as a real module. A library the program ships with -- a sound
 * engine, a video decoder, a vendor's own runtime -- is not ours to provide at
 * all. It is real x86 code sitting in the volume beside the executable, and the
 * only correct thing to do with it is load it and let it run.
 *
 * So this walks the import graph, and every name it meets that is not a system
 * library is a file to find and read.
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
 *        Whether this engine provides the library itself.
 * @returns {Promise<{ order: Dependency[], missing: string[] }>}
 *        `order` is dependency-first and excludes the executable. `missing`
 *        names libraries that are neither ours nor present in the volume --
 *        recorded rather than thrown, because a program that never calls into
 *        one still runs, and one that does fails where it called.
 */
export async function planDependencies({ entry, readLibrary, isSystem }){
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
            if (seen.has(key) || isSystem(name))
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
                missing.push(name);
                continue;
            }
            await visit(bytes);
            order.push({ name, file: bytes });
        }
    };

    await visit(entry);
    return { order, missing };
}
