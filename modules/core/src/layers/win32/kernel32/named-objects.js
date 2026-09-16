/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The one namespace every named kernel object shares.
 *
 * A mutex, an event, a semaphore, a waitable timer and a file mapping are
 * different kinds of object, but Windows keeps a single table of names across
 * all of them -- a name is not decoration, it is how one process coordinates
 * with itself across libraries, and how a second copy of a program discovers
 * the first. Kept here rather than in the kernel because naming is a Win32
 * idea: the kernel has objects and no namespace.
 *
 * A name lives exactly as long as some handle onto its object does, counted
 * here rather than asked of the handle table: the handle table is rebuilt
 * from nothing on every process replacement, while this table is handed in
 * from outside and survives one, the same way the log's sinks and the sound
 * ring do. A live count on the table's own entry answers "is this still
 * open" correctly in both cases -- within one process, where the canonical
 * single-instance idiom probes for a copy, closes it and creates one for
 * real, and across a replacement, where a parent's object was never closed
 * at all, just carried into the process that took its place.
 */

/** What a create reports when the name was already taken. */
const ERROR_ALREADY_EXISTS = 183;
const ERROR_SUCCESS = 0;

/** A live name standing for an object of a different kind. */
export const TAKEN = Symbol('taken');

/**
 * @param {Object} [options]
 * @param {Map<string, { kind: string, object: any, refs: number }>} [options.table]
 *        The backing store. Handed in so it can be created once and outlive a
 *        process replacement, and defaults to one that does not, for a caller
 *        with nothing to carry across.
 */
export function createNamedObjects({ table = new Map() } = {}){
    return {
        /**
         * The object this name already stands for, TAKEN if another kind holds
         * it, or null if the name is free.
         *
         * @param {string | null} name @param {string} kind
         */
        existing(name, kind){
            if (name === null)
            {
                return null;
            }
            const held = table.get(name);
            return !held ? null : held.kind === kind ? held.object : TAKEN;
        },

        /**
         * Records the name and reports what the create should leave behind: a
         * create that found its name already taken says so through the last
         * error, and a reuse counts the handle this create is about to open --
         * the reference that keeps the name alive until it, too, is closed.
         *
         * @param {string | null} name @param {string} kind @param {any} made
         * @param {boolean} reused
         * @param {(code: number) => void} setLastError
         */
        remember(name, kind, made, reused, setLastError){
            if (name !== null)
            {
                const held = table.get(name);
                if (reused && held)
                {
                    held.refs++;
                }
                else
                {
                    table.set(name, { kind, object: made, refs: 1 });
                }
            }
            setLastError(reused ? ERROR_ALREADY_EXISTS : ERROR_SUCCESS);
        },

        /**
         * An Open* call found the name and is about to hand back a handle onto
         * it -- one more reference, counted the same as a create's, but with
         * no last error of its own to set: opening an existing named object is
         * success, not ERROR_ALREADY_EXISTS, which is a create's answer alone.
         *
         * @param {any} object
         */
        reference(object){
            for (const held of table.values())
            {
                if (held.object === object)
                {
                    held.refs++;
                    return;
                }
            }
        },

        /**
         * A handle onto a named object was closed. The last one closes the
         * name too, freeing it for a create that means it for real -- the
         * "probe, close, create again" idiom this table exists to support. A
         * no-op for a handle onto anything unnamed, which is most of them.
         *
         * @param {any} object
         */
        forget(object){
            for (const [name, held] of table)
            {
                if (held.object === object)
                {
                    held.refs--;
                    if (held.refs <= 0)
                    {
                        table.delete(name);
                    }
                    return;
                }
            }
        },
    };
}
