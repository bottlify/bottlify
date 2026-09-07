/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The viewport, both halves of it.
 *
 * This is the one place in the backend that decides what "setting a viewport"
 * means, and the answer is deliberately not a choice:
 *
 *  1. the hardware viewport is set to the rectangle, and
 *  2. the vertex stage is fed the matching inverse offset and extent.
 *
 * A vertex given in target pixels is turned into clip space by
 * `(p + offset) * scale` and then biased -- x by -1, y by +1 -- so the two
 * halves cancel and the vertex lands on the pixel it names. Doing only the
 * first leaves pre-transformed vertices in the wrong place; doing only the
 * second tears the frame apart; and a stack that routes some draws through one
 * convention and some through the other mixes both inside a frame.
 *
 * So the halves are produced by one function and travel as one value. There is
 * no way to ask for the rectangle without the constants, which is what makes
 * the pairing structural rather than a convention somebody has to remember.
 *
 * The subtle case the second half exists for: a conversion that divides by the
 * extent but never subtracts the origin looks right for every viewport whose
 * origin is zero, and is wrong for every other one.
 */

/**
 * @param {import('../contract.js').ViewportRect} rect
 * @returns {import('../contract.js').ViewportState}
 */
export function viewportState(rect){
    if (!(rect.width > 0) || !(rect.height > 0))
    {
        throw new Error(
            `Viewport extent must be positive, got ${rect.width}x${rect.height}`);
    }
    return {
        rect: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            minDepth: rect.minDepth === undefined ? 0 : rect.minDepth,
            maxDepth: rect.maxDepth === undefined ? 1 : rect.maxDepth,
        },
        offset: [-rect.x, -rect.y],
        scale: [2 / rect.width, -2 / rect.height],
    };
}

/**
 * The viewport a render target starts with. A successful target change resets
 * to this, so a small viewport left over from a downscale pass cannot stay
 * latched on the passes that follow.
 *
 * @param {{ width: number, height: number }} target
 * @returns {import('../contract.js').ViewportState}
 */
export function fullTarget(target){
    return viewportState({ x: 0, y: 0, width: target.width, height: target.height });
}
