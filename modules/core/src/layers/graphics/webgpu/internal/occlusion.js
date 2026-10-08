/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What an occlusion query of WebGPU's says, as the samples Direct3D promises.
 *
 * WebGPU promises only that the answer is zero when no sample passed and
 * something else when some did, and Dawn on D3D12 answers 1 whatever the
 * number. A program that weighs the count against a threshold of a few pixels
 * then hides everything it tests. A count above one is a backend that counts,
 * and stands; a 1 is taken as every pixel the draw could reach -- the answer
 * that never hides what should have been drawn.
 */

/**
 * @typedef {{ x?: number, y?: number, width: number, height: number }} Rect
 */

/**
 * The pixels a draw can touch: its viewport, cut to the scissor when there is one.
 *
 * @param {Rect} viewport @param {Rect | null} [scissor]
 * @returns {number}
 */
export function reachableArea(viewport, scissor = null){
    const x0 = Math.max(viewport.x ?? 0, scissor ? scissor.x ?? 0 : -Infinity);
    const y0 = Math.max(viewport.y ?? 0, scissor ? scissor.y ?? 0 : -Infinity);
    const x1 = Math.min((viewport.x ?? 0) + viewport.width,
        scissor ? (scissor.x ?? 0) + scissor.width : Infinity);
    const y1 = Math.min((viewport.y ?? 0) + viewport.height,
        scissor ? (scissor.y ?? 0) + scissor.height : Infinity);
    return Math.max(0, Math.round(x1 - x0)) * Math.max(0, Math.round(y1 - y0));
}

/**
 * @param {number} answered  What the GPU's query resolved to.
 * @param {number} area      The pixels the draw could reach.
 * @returns {{ samples: number, assumed: boolean }}   `assumed` when the answer was
 *     only that some sample passed.
 */
export function passedSamples(answered, area){
    return answered === 1 && area > 1 ? { samples: area, assumed: true }
        : { samples: answered, assumed: false };
}
