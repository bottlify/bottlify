/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The run's constant tables: those derived from constant data alone (the
 * Unicode properties the platform knows, a code page its decoder reads), the
 * same for every process of the run. Each is one body of the run's cache,
 * made by the first process that asks for it and read in place by every
 * process and worker after; a table nobody asks for is never made.
 *
 * A table is read only inside `read`, for one call's span, as the cache reads
 * every body (`with`): a view kept past it could see whatever the keeper put
 * there next, and Cellar has no pin for a body many readers share (`hold` is
 * one reader's own memory, which no other reads). The space is asked for with
 * `idle: 'stay'`, so a table leaves only when its room is wanted, and is made
 * again by whoever asks for it after.
 *
 * Without a cache - a test, a machine built alone - or with no room in it,
 * the realm keeps the table it made and reads that, as each realm did before
 * the tables were the run's: this is the one place that does so.
 */

/** @typedef {import('../../cache/module.js').CacheSpace} CacheSpace */

/**
 * @typedef {Uint8Array | Uint16Array | Int16Array | Uint32Array | Int32Array} Table
 */

/**
 * @template {Table} A
 * @typedef {{ new (buffer: ArrayBufferLike, offset: number, length: number): A,
 *     BYTES_PER_ELEMENT: number }} TableType
 */

/**
 * One table: `read` calls its reader with the table and answers what that
 * answered.
 *
 * @template {Table} A
 * @typedef {{ read: <T>(reader: (table: A) => T) => T }} RunTable
 */

/**
 * What the tables of this realm did: tables `made` here, `read` in place from
 * the run's cache, `local` ones kept here (no cache, or no room in it).
 *
 * @typedef {{ made: number, read: number, local: number }} RunTableFigures
 */

/**
 * The run's constant tables, as bodies of `space` (the cache layer's, asked
 * for with `idle: 'stay'`); null for none.
 *
 * @param {CacheSpace | null} space
 */
export function runTables(space){
    /** Tables this realm keeps: made here with nowhere in the run to keep them. @type {Map<string, Table>} */
    const local = new Map();
    /** @type {RunTableFigures} */
    const counts = { made: 0, read: 0, local: 0 };
    return {
        /**
         * The table named `key`, of `Type`, which `make` makes: called once
         * a reader asks for it and the run's cache does not hold it.
         *
         * @template {Table} A
         * @param {string} key @param {TableType<A>} Type @param {() => A} make
         * @returns {RunTable<A>}
         */
        table(key, Type, make){
            return {
                read(reader){
                    const own = /** @type {A | undefined} */ (local.get(key));
                    if (own !== undefined)
                    {
                        return reader(own);
                    }
                    if (space !== null)
                    {
                        let found = false;
                        const answer = space.with(key, body=>{
                            found = true;
                            return reader(new Type(body.buffer, body.byteOffset,
                                body.byteLength / Type.BYTES_PER_ELEMENT));
                        });
                        if (found)
                        {
                            counts.read++;
                            return /** @type {any} */ (answer);
                        }
                    }
                    const made = make();
                    counts.made++;
                    const bytes = new Uint8Array(made.buffer, made.byteOffset, made.byteLength);
                    if (space === null || !space.put(key, bytes))
                    {
                        local.set(key, made);
                        counts.local++;
                    }
                    return reader(made);
                },
            };
        },

        /** @returns {RunTableFigures} */
        figures: ()=>({ ...counts }),
    };
}

/** @typedef {ReturnType<typeof runTables>} RunTables */
