/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The tables of `context-legacy.js` the state table and the rasteriser read:
 * the enumerants, the state a context starts with, the attribute groups'
 * shares of it, and the stipple's test. A file of its own because the state
 * table imports it, and the calls' file names the kernel, whose type names
 * the state table: one file would close the circle.
 */

/** The enumerants of this file, which `constants.js` does not name. */
export const LEGACY = Object.freeze({
    MAP_COLOR: 0x0d10,
    MAP_STENCIL: 0x0d11,
    INDEX_SHIFT: 0x0d12,
    INDEX_OFFSET: 0x0d13,
    RED_SCALE: 0x0d14,
    RED_BIAS: 0x0d15,
    GREEN_SCALE: 0x0d18,
    GREEN_BIAS: 0x0d19,
    BLUE_SCALE: 0x0d1a,
    BLUE_BIAS: 0x0d1b,
    ALPHA_SCALE: 0x0d1c,
    ALPHA_BIAS: 0x0d1d,
    DEPTH_SCALE: 0x0d1e,
    DEPTH_BIAS: 0x0d1f,
    PIXEL_MAP_I_TO_I: 0x0c70,
    PIXEL_MAP_S_TO_S: 0x0c71,
    PIXEL_MAP_I_TO_R: 0x0c72,
    PIXEL_MAP_I_TO_G: 0x0c73,
    PIXEL_MAP_I_TO_B: 0x0c74,
    PIXEL_MAP_I_TO_A: 0x0c75,
    PIXEL_MAP_R_TO_R: 0x0c76,
    PIXEL_MAP_G_TO_G: 0x0c77,
    PIXEL_MAP_B_TO_B: 0x0c78,
    PIXEL_MAP_A_TO_A: 0x0c79,
    /** GL_PIXEL_MAP_I_TO_I_SIZE; each map's size query is its own enumerant plus 0x40. */
    PIXEL_MAP_SIZE: 0x40,
    MAP1_COLOR_4: 0x0d90,
    MAP1_INDEX: 0x0d91,
    MAP1_NORMAL: 0x0d92,
    MAP1_TEXTURE_COORD_1: 0x0d93,
    MAP1_TEXTURE_COORD_2: 0x0d94,
    MAP1_TEXTURE_COORD_3: 0x0d95,
    MAP1_TEXTURE_COORD_4: 0x0d96,
    MAP1_VERTEX_3: 0x0d97,
    MAP1_VERTEX_4: 0x0d98,
    /** A two-dimensional map's target is its one-dimensional twin's plus this. */
    MAP2: 0x20,
    MAP2_COLOR_4: 0x0db0,
    MAP2_INDEX: 0x0db1,
    MAP2_NORMAL: 0x0db2,
    MAP2_TEXTURE_COORD_1: 0x0db3,
    MAP2_TEXTURE_COORD_2: 0x0db4,
    MAP2_TEXTURE_COORD_3: 0x0db5,
    MAP2_TEXTURE_COORD_4: 0x0db6,
    MAP2_VERTEX_3: 0x0db7,
    MAP2_VERTEX_4: 0x0db8,
    MAP1_GRID_DOMAIN: 0x0dd0,
    MAP1_GRID_SEGMENTS: 0x0dd1,
    MAP2_GRID_DOMAIN: 0x0dd2,
    MAP2_GRID_SEGMENTS: 0x0dd3,
    COEFF: 0x0a00,
    ORDER: 0x0a01,
    DOMAIN: 0x0a02,
});

/** The ten pixel maps' names, in enumerant order from GL_PIXEL_MAP_I_TO_I. */
const PIXEL_MAP_NAMES = Object.freeze(['I_TO_I', 'S_TO_S', 'I_TO_R', 'I_TO_G', 'I_TO_B',
    'I_TO_A', 'R_TO_R', 'G_TO_G', 'B_TO_B', 'A_TO_A']);

/** @type {readonly number[]} the ten pixel maps, in enumerant order */
export const PIXEL_MAPS = Object.freeze(PIXEL_MAP_NAMES.map((_, k)=>LEGACY.PIXEL_MAP_I_TO_I + k));

/** @type {ReadonlySet<number>} the maps an index looks up: sized in powers of two */
export const INDEX_MAPS = new Set([LEGACY.PIXEL_MAP_I_TO_I, LEGACY.PIXEL_MAP_S_TO_S,
    LEGACY.PIXEL_MAP_I_TO_R, LEGACY.PIXEL_MAP_I_TO_G, LEGACY.PIXEL_MAP_I_TO_B,
    LEGACY.PIXEL_MAP_I_TO_A]);

/** @type {ReadonlySet<number>} the maps whose entries are indices, not colours */
export const INDEX_VALUED = new Set([LEGACY.PIXEL_MAP_I_TO_I, LEGACY.PIXEL_MAP_S_TO_S]);

/**
 * The one-dimensional evaluator targets in enumerant order, each with its
 * component count, its initial control point (OpenGL 2.1 table 5.1 and
 * section 5.1: a map of order one over [0, 1]) and its name's end.
 *
 * @type {readonly [number, number, readonly number[], string][]}
 */
export const MAP_TARGETS = Object.freeze([
    [LEGACY.MAP1_COLOR_4, 4, [1, 1, 1, 1], 'COLOR_4'],
    [LEGACY.MAP1_INDEX, 1, [1], 'INDEX'],
    [LEGACY.MAP1_NORMAL, 3, [0, 0, 1], 'NORMAL'],
    [LEGACY.MAP1_TEXTURE_COORD_1, 1, [0], 'TEXTURE_COORD_1'],
    [LEGACY.MAP1_TEXTURE_COORD_2, 2, [0, 0], 'TEXTURE_COORD_2'],
    [LEGACY.MAP1_TEXTURE_COORD_3, 3, [0, 0, 0], 'TEXTURE_COORD_3'],
    [LEGACY.MAP1_TEXTURE_COORD_4, 4, [0, 0, 0, 1], 'TEXTURE_COORD_4'],
    [LEGACY.MAP1_VERTEX_3, 3, [0, 0, 0], 'VERTEX_3'],
    [LEGACY.MAP1_VERTEX_4, 4, [0, 0, 0, 1], 'VERTEX_4'],
]);

/**
 * How many components a map of `target` has: zero for no target.
 *
 * @param {number} target  a MAP1_* or MAP2_* enumerant
 * @returns {number}
 */
export function mapComponents(target){
    const base = target >= LEGACY.MAP1_COLOR_4 + LEGACY.MAP2 ? target - LEGACY.MAP2 : target;
    return MAP_TARGETS.find(([one])=>one === base)?.[1] ?? 0;
}

/** Every evaluator enable, one- and two-dimensional, as state defaults. */
export const LEGACY_ENABLES = Object.freeze(MAP_TARGETS.flatMap(([target, , , name])=>[
    { query: target, name: `GL_MAP1_${name}`, kind: /** @type {'bool'} */ ('bool'), value: [0] },
    { query: target + LEGACY.MAP2, name: `GL_MAP2_${name}`,
        kind: /** @type {'bool'} */ ('bool'), value: [0] },
]));

/** The pixel transfer state glPixelTransfer sets: GL_PIXEL_MODE_BIT's. */
export const TRANSFER_STATE = Object.freeze([
    { query: LEGACY.MAP_COLOR, name: 'GL_MAP_COLOR', kind: /** @type {'bool'} */ ('bool'),
        value: [0] },
    { query: LEGACY.MAP_STENCIL, name: 'GL_MAP_STENCIL', kind: /** @type {'bool'} */ ('bool'),
        value: [0] },
    { query: LEGACY.INDEX_SHIFT, name: 'GL_INDEX_SHIFT', kind: /** @type {'int'} */ ('int'),
        value: [0] },
    { query: LEGACY.INDEX_OFFSET, name: 'GL_INDEX_OFFSET', kind: /** @type {'int'} */ ('int'),
        value: [0] },
    ...[['RED', 0x0d14], ['GREEN', 0x0d18], ['BLUE', 0x0d1a], ['ALPHA', 0x0d1c],
        ['DEPTH', 0x0d1e]].flatMap(([colour, scale])=>[
        { query: Number(scale), name: `GL_${colour}_SCALE`, kind: /** @type {'float'} */ ('float'),
            value: [1] },
        { query: Number(scale) + 1, name: `GL_${colour}_BIAS`,
            kind: /** @type {'float'} */ ('float'), value: [0] },
    ]),
]);

/** The evaluators' grids: GL_EVAL_BIT's, with the enables. */
const GRID_STATE = Object.freeze([
    { query: LEGACY.MAP1_GRID_DOMAIN, name: 'GL_MAP1_GRID_DOMAIN',
        kind: /** @type {'float'} */ ('float'), value: [0, 1] },
    { query: LEGACY.MAP1_GRID_SEGMENTS, name: 'GL_MAP1_GRID_SEGMENTS',
        kind: /** @type {'int'} */ ('int'), value: [1] },
    { query: LEGACY.MAP2_GRID_DOMAIN, name: 'GL_MAP2_GRID_DOMAIN',
        kind: /** @type {'float'} */ ('float'), value: [0, 1, 0, 1] },
    { query: LEGACY.MAP2_GRID_SEGMENTS, name: 'GL_MAP2_GRID_SEGMENTS',
        kind: /** @type {'int'} */ ('int'), value: [1, 1] },
]);

/** Each pixel map's size, one entry to start with. */
const MAP_SIZE_STATE = Object.freeze(PIXEL_MAPS.map((map, k)=>({
    query: map + LEGACY.PIXEL_MAP_SIZE, name: `GL_PIXEL_MAP_${PIXEL_MAP_NAMES[k]}_SIZE`,
    kind: /** @type {'int'} */ ('int'), value: [1],
})));

/** The state of this file that is not an enable, for the default table. */
export const LEGACY_STATE = Object.freeze([...TRANSFER_STATE, ...GRID_STATE, ...MAP_SIZE_STATE]);

/** What glPushAttrib(GL_PIXEL_MODE_BIT) saves of it. */
export const PIXEL_MODE_QUERIES = Object.freeze(TRANSFER_STATE.map(entry=>entry.query));

/** What glPushAttrib(GL_EVAL_BIT) saves of it: the enables and the grids. */
export const EVAL_QUERIES = Object.freeze([...LEGACY_ENABLES, ...GRID_STATE]
    .map(entry=>entry.query));

/** The pixel maps' sizes, which no group saves (nor the maps). */
export const PIXEL_MAP_SIZE_QUERIES = Object.freeze(MAP_SIZE_STATE.map(entry=>entry.query));

/**
 * Whether a stipple keeps the fragment at a window position, y counted up
 * from the bottom row.
 *
 * @param {{ words: Uint32Array }} pattern @param {number} x @param {number} y
 * @returns {boolean}
 */
export function stippleKeeps(pattern, x, y){
    return ((pattern.words[y & 31] >>> (x & 31)) & 1) !== 0;
}
