/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A renderer with nothing behind it, for a context whose drawing is done by
 * a twin elsewhere (`remote/opengl.js`): it answers every question a context
 * puts to its renderer as `gpu.js` would, and draws nothing.
 *
 * The one answer that is not state alone is whether a draw by arrays is
 * taken as the arrays lie: a context assembles the vertices itself when it is
 * not, so both sides must say the same, and they ask the same layout plan.
 * A draw that is taken reads the program's memory where `gpu.js` reads it --
 * the client arrays' ranges -- so that whoever watches this side's reads
 * knows the bytes the twin's renderer will.
 */

import { clientReads, lockedFor, planLayout, scanIndices } from './gpu-layout.js';

export function createModelRenderer(){
    /** @type {WeakMap<object, { width: number, height: number }>} */
    const drawables = new WeakMap();
    let frames = 0;
    const settled = Promise.resolve();
    /**
     * The locked ranges read this frame, as `gpu.js` keeps their copies: a
     * pass drawn from one reads nothing more, and nothing more is sent.
     * @type {Set<string>}
     */
    const lockedRead = new Set();
    /** Draws assembled vertex by vertex, as `gpu.js` counts them. */
    const assembled = { draws: 0, vertices: 0, byReason: /** @type {Record<string, number>} */ ({}) };

    return {
        /** @param {object} context @param {{ width: number, height: number }} drawable */
        attach(context, drawable){
            drawables.set(context, { width: Math.max(1, drawable.width),
                height: Math.max(1, drawable.height) });
        },

        /** @param {object} context */
        attached: (/** @type {object} */ context)=>drawables.has(context),

        clear(){},

        /**
         * @param {object} context
         * @param {import('./gpu.js').DrawRequest} request
         * @returns {boolean}
         */
        drawArrays(context, request){
            if (!drawables.has(context))
            {
                return false;
            }
            const layout = planLayout(request.arrays);
            if (!layout)
            {
                return false;
            }
            if (request.count === 0)
            {
                return true;
            }
            if (layout.slots.some(slot=>slot.buffer !== 0 && !request.bufferObject(slot.buffer)))
            {
                return false;
            }
            if (layout.slots.every(slot=>slot.buffer !== 0))
            {
                return true;
            }
            const indices = request.indices;
            const scanned = indices
                ? scanIndices(indices.bytes, indices.type, request.count) : null;
            const min = scanned ? scanned.min : request.first;
            const max = scanned ? scanned.max : request.first + request.count - 1;
            const lock = lockedFor(request, min, max);
            const { reads } = lock
                ? clientReads(layout.slots, lock.first, lock.first + lock.count - 1)
                : clientReads(layout.slots, min, max);
            layout.slots.forEach((slot, index)=>{
                const read = reads[index];
                if (!read)
                {
                    return;
                }
                if (lock)
                {
                    const key = `${lock.epoch}:${slot.base}:${slot.stride}`;
                    if (lockedRead.has(key))
                    {
                        return;
                    }
                    lockedRead.add(key);
                }
                request.read(read.at, read.length);
            });
            return true;
        },

        draw(){},

        /** @param {string} why @param {number} vertices */
        noteAssembled(why, vertices){
            assembled.draws++;
            assembled.vertices += vertices;
            assembled.byReason[why] = (assembled.byReason[why] ?? 0) + 1;
        },
        copyToTexture(){},
        releaseBuffer(){},

        /**
         * @param {object} context
         * @returns {{ width: number, height: number } | null}
         */
        present(context){
            const target = drawables.get(context);
            if (!target)
            {
                return null;
            }
            frames++;
            lockedRead.clear();
            return { width: target.width, height: target.height };
        },

        settled: ()=>settled,

        diagnostics: ()=>({ frames, assembled }),
    };
}
