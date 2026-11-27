/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { createTableMemory, openTable } from '@bottlify/cellar';

/**
 * The registry of what the layers publish as numbers.
 *
 * A layer asks for its tables once, when it is created, and from then on
 * writes into them where the figure changes; nothing is asked of the engine
 * thread to read them. What a reader needs to find its way around -- which
 * buffer holds which table, what its columns are called -- is a description
 * made once, after every layer has registered, and handed over with the
 * buffers.
 *
 * Some figures are not kept by anyone: the translator's counters live in its
 * runtime, a thread's state is a field on the thread. Those are sampled
 * into their table once a frame, by a sampler the layer registers here and
 * the profiler runs when the frame closes -- one moment on the engine thread,
 * a few dozen stores, instead of a walk on every request.
 *
 * A cell is an integer (Cellar's table). A figure with a fraction is stored
 * in millionths, as its column's name says: a time in nanoseconds (`…Ns`,
 * milliseconds times 1e6), a share or an amount in parts per million
 * (`…Ppm`). The reader turns them back (`reader.js`, `readable`).
 */

/**
 * @typedef {Object} MetricsRegistry
 * @property {(layer: string, names: string[]) => import('@bottlify/cellar').Table} counters
 * @property {(layer: string, name: string) => import('@bottlify/cellar').Table | null} find
 * @property {(layer: string, name: string, spec: { rows: number, columns: string[] })
 *     => import('@bottlify/cellar').Table} table
 * @property {(sampler: () => void) => () => void} onFrame
 * @property {() => void} sample
 * @property {() => Record<string, Record<string, import('@bottlify/cellar').TableMemory>>} describe
 */

/**
 * @returns {MetricsRegistry}
 */
export function createMetrics(){
    /** @type {Map<string, Map<string, import('@bottlify/cellar').Table>>} */
    const layers = new Map();
    /** @type {(() => void)[]} */
    const samplers = [];

    /** @type {MetricsRegistry['table']} */
    const table = (layer, name, { rows, columns })=>{
        let tables = layers.get(layer);
        if (!tables)
        {
            tables = new Map();
            layers.set(layer, tables);
        }
        if (tables.has(name))
        {
            throw new Error(`log: ${layer} already publishes a table named "${name}"`);
        }
        const made = openTable(createTableMemory({ rows, columns }));
        tables.set(name, made);
        return made;
    };

    return {
        table,

        /**
         * A table already registered, or null. For the few figures one
         * layer's row feeds another's -- a frame's row carries a copy of the
         * cpu layer's counters -- resolved once rather than looked up as they
         * are read.
         *
         * @param {string} layer @param {string} name
         */
        find: (layer, name)=>layers.get(layer)?.get(name) ?? null,

        /**
         * A table of one row of named counters, for the figures a layer keeps
         * as it runs.
         *
         * @param {string} layer @param {string[]} names
         */
        counters(layer, names){
            const made = table(layer, 'counters', { rows: 1, columns: names });
            made.use(1);
            return made;
        },

        onFrame(sampler){
            samplers.push(sampler);
            return ()=>{
                const at = samplers.indexOf(sampler);
                if (at >= 0)
                {
                    samplers.splice(at, 1);
                }
            };
        },

        sample(){
            for (const sampler of samplers)
            {
                sampler();
            }
        },

        describe(){
            /** @type {Record<string, Record<string, import('@bottlify/cellar').TableMemory>>} */
            const out = {};
            for (const [layer, tables] of layers)
            {
                out[layer] = {};
                for (const [name, made] of tables)
                {
                    out[layer][name] = made.memory;
                }
            }
            return out;
        },
    };
}
