/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * An area as a list of rectangles that do not overlap: what a clip region and
 * the part of the screen no window covers both are. The pieces never share a
 * pixel, so a drawing done once inside each of them touches every pixel of
 * the area exactly once -- which an XOR raster operation depends on.
 */

/**
 * @typedef {Object} Rect
 * @property {number} left
 * @property {number} top
 * @property {number} right
 * @property {number} bottom
 */

/** @param {Rect} rect */
export const isEmptyRect = rect=>rect.right <= rect.left || rect.bottom <= rect.top;

/** @param {Rect} a @param {Rect} b @returns {Rect} */
export const intersectRect = (a, b)=>({
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
});

/**
 * What is left of a rectangle once another is taken out of it: up to four
 * pieces, the bands above and below the hole and the ones beside it.
 *
 * @param {Rect} rect @param {Rect} hole
 * @returns {Rect[]}
 */
export const subtractRect = (rect, hole)=>{
    const cut = intersectRect(rect, hole);
    if (isEmptyRect(cut))
    {
        return [rect];
    }
    return [
        { left: rect.left, top: rect.top, right: rect.right, bottom: cut.top },
        { left: rect.left, top: cut.top, right: cut.left, bottom: cut.bottom },
        { left: cut.right, top: cut.top, right: rect.right, bottom: cut.bottom },
        { left: rect.left, top: cut.bottom, right: rect.right, bottom: rect.bottom },
    ].filter(piece=>!isEmptyRect(piece));
};

/**
 * An area less a rectangle.
 *
 * @param {Rect[]} area @param {Rect} hole
 * @returns {Rect[]}
 */
export const subtractFromArea = (area, hole)=>area.flatMap(piece=>subtractRect(piece, hole));

/**
 * The part of an area inside a rectangle.
 *
 * @param {Rect[]} area @param {Rect} rect
 * @returns {Rect[]}
 */
export const intersectArea = (area, rect)=>area.map(piece=>intersectRect(piece, rect))
    .filter(piece=>!isEmptyRect(piece));

/**
 * The smallest rectangle holding every piece; an empty one for no pieces.
 *
 * @param {Rect[]} area
 * @returns {Rect}
 */
export const boundsOf = area=>(area.length === 0
    ? { left: 0, top: 0, right: 0, bottom: 0 }
    : area.reduce((box, piece)=>({
        left: Math.min(box.left, piece.left),
        top: Math.min(box.top, piece.top),
        right: Math.max(box.right, piece.right),
        bottom: Math.max(box.bottom, piece.bottom),
    })));

/**
 * The same area in as few pieces as joining neighbours makes it: two pieces
 * one on top of the other with the same sides, or side by side with the same
 * top and bottom, are one. What is one rectangle is then one piece, which
 * is the region a program is told is simple.
 *
 * @param {Rect[]} area
 * @returns {Rect[]}
 */
export const simplifyArea = area=>{
    const pieces = area.filter(piece=>!isEmptyRect(piece)).map(piece=>({ ...piece }));
    for (let joined = true; joined;)
    {
        joined = false;
        for (let a = 0; a < pieces.length && !joined; a++)
        {
            for (let b = 0; b < pieces.length && !joined; b++)
            {
                const one = pieces[a];
                const other = pieces[b];
                if (a === b)
                {
                    continue;
                }
                if (one.left === other.left && one.right === other.right
                    && one.bottom === other.top)
                {
                    one.bottom = other.bottom;
                }
                else if (one.top === other.top && one.bottom === other.bottom
                    && one.right === other.left)
                {
                    one.right = other.right;
                }
                else
                {
                    continue;
                }
                pieces.splice(b, 1);
                joined = true;
            }
        }
    }
    return pieces;
};
