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

import { clientReads, planLayout, scanIndices } from './gpu-layout.js';

export function createModelRenderer(){
    /** @type {WeakMap<object, { width: number, height: number }>} */
    const drawables = new WeakMap();
    let frames = 0;
    const settled = Promise.resolve();

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
            for (const read of clientReads(layout.slots, min, max).reads)
            {
                if (read)
                {
                    request.read(read.at, read.length);
                }
            }
            return true;
        },

        draw(){},
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
            return { width: target.width, height: target.height };
        },

        settled: ()=>settled,

        diagnostics: ()=>({ frames }),
    };
}
