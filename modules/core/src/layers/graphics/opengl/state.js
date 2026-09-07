/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The state a context has before a program has set anything, as a table.
 *
 * A table rather than a constructor for the same reason the render states of
 * the other APIs are one: this is a specification. Programs read these back and
 * branch on them, and a wrong default is a picture that is subtly wrong rather
 * than a call that fails.
 *
 * Three entries are worth naming before anything else reads the list:
 *
 * - **GL_DITHER is the one enable that starts on.** Every other capability
 *   here starts off, and an implementation that initialises the whole enable
 *   set to false is wrong exactly once, invisibly.
 * - **GL_UNPACK_ALIGNMENT is four, not one.** A texture uploaded from tightly
 *   packed rows whose width is not a multiple of four shears, and it shears in
 *   a way that looks like a stride bug anywhere else in the stack.
 * - **The viewport and the scissor box come from the drawable**, not from a
 *   constant, and they are fixed when the context is first attached to one.
 *   The draw and read buffers come from whether that drawable is double
 *   buffered.
 *
 * The type of a query is part of it. Reading a boolean as a float gives 1.0,
 * not the raw bit; reading a float as an integer rounds; and reading a colour
 * component as an integer maps the normalised range onto the full integer
 * range rather than truncating it to zero or one. `readState` is the only
 * place any of that is allowed to happen.
 */

import { GL } from './constants.js';
import { STACK_LIMITS } from './matrix.js';

/**
 * @typedef {Object} StateDefault
 * @property {number} query
 * @property {string} name
 * @property {'bool' | 'int' | 'enum' | 'float'} kind
 * @property {readonly number[]} value
 * @property {boolean} [normalised]
 *           A colour or normal component, whose integer form is the mapped
 *           range rather than the rounded number.
 * @property {'drawable' | 'buffer'} [dependsOn]
 *           Names what the value is derived from, in which case `value` is
 *           only the placeholder `resolveStateDefault` replaces.
 */

/**
 * @typedef {Object} StateInputs
 * @property {number} width           the drawable's width when first attached
 * @property {number} height
 * @property {boolean} doubleBuffered
 */

/**
 * The capabilities, whose enumerant is also the query that reads them back.
 *
 * @type {readonly StateDefault[]}
 */
export const DEFAULT_ENABLES = Object.freeze([
    { query: GL.DITHER, name: 'GL_DITHER', kind: 'bool', value: [1] },
    { query: GL.ALPHA_TEST, name: 'GL_ALPHA_TEST', kind: 'bool', value: [0] },
    { query: GL.BLEND, name: 'GL_BLEND', kind: 'bool', value: [0] },
    { query: GL.COLOR_MATERIAL, name: 'GL_COLOR_MATERIAL', kind: 'bool', value: [0] },
    { query: GL.CULL_FACE, name: 'GL_CULL_FACE', kind: 'bool', value: [0] },
    { query: GL.DEPTH_TEST, name: 'GL_DEPTH_TEST', kind: 'bool', value: [0] },
    { query: GL.FOG, name: 'GL_FOG', kind: 'bool', value: [0] },
    { query: GL.LIGHTING, name: 'GL_LIGHTING', kind: 'bool', value: [0] },
    { query: GL.LIGHT0, name: 'GL_LIGHT0', kind: 'bool', value: [0] },
    { query: GL.LINE_SMOOTH, name: 'GL_LINE_SMOOTH', kind: 'bool', value: [0] },
    { query: GL.NORMALIZE, name: 'GL_NORMALIZE', kind: 'bool', value: [0] },
    { query: GL.POINT_SMOOTH, name: 'GL_POINT_SMOOTH', kind: 'bool', value: [0] },
    { query: GL.POLYGON_OFFSET_FILL, name: 'GL_POLYGON_OFFSET_FILL', kind: 'bool', value: [0] },
    { query: GL.POLYGON_SMOOTH, name: 'GL_POLYGON_SMOOTH', kind: 'bool', value: [0] },
    { query: GL.SCISSOR_TEST, name: 'GL_SCISSOR_TEST', kind: 'bool', value: [0] },
    { query: GL.STENCIL_TEST, name: 'GL_STENCIL_TEST', kind: 'bool', value: [0] },
    { query: GL.TEXTURE_1D, name: 'GL_TEXTURE_1D', kind: 'bool', value: [0] },
    { query: GL.TEXTURE_2D, name: 'GL_TEXTURE_2D', kind: 'bool', value: [0] },
]);

/** @type {readonly StateDefault[]} */
export const DEFAULT_STATE = Object.freeze([
    ...DEFAULT_ENABLES,

    // --- current vertex attributes ---
    {
        query: GL.CURRENT_COLOR, name: 'GL_CURRENT_COLOR', kind: 'float',
        value: [1, 1, 1, 1], normalised: true,
    },
    { query: GL.CURRENT_INDEX, name: 'GL_CURRENT_INDEX', kind: 'float', value: [1] },
    {
        query: GL.CURRENT_NORMAL, name: 'GL_CURRENT_NORMAL', kind: 'float',
        value: [0, 0, 1], normalised: true,
    },
    {
        query: GL.CURRENT_TEXTURE_COORDS, name: 'GL_CURRENT_TEXTURE_COORDS', kind: 'float',
        value: [0, 0, 0, 1],
    },

    // --- the framebuffer clear values ---
    {
        query: GL.COLOR_CLEAR_VALUE, name: 'GL_COLOR_CLEAR_VALUE', kind: 'float',
        value: [0, 0, 0, 0], normalised: true,
    },
    { query: GL.DEPTH_CLEAR_VALUE, name: 'GL_DEPTH_CLEAR_VALUE', kind: 'float', value: [1] },
    { query: GL.STENCIL_CLEAR_VALUE, name: 'GL_STENCIL_CLEAR_VALUE', kind: 'int', value: [0] },
    { query: GL.INDEX_CLEAR_VALUE, name: 'GL_INDEX_CLEAR_VALUE', kind: 'float', value: [0] },
    {
        query: GL.ACCUM_CLEAR_VALUE, name: 'GL_ACCUM_CLEAR_VALUE', kind: 'float',
        value: [0, 0, 0, 0], normalised: true,
    },

    // --- the fragment pipeline ---
    { query: GL.BLEND_SRC, name: 'GL_BLEND_SRC', kind: 'enum', value: [GL.ONE] },
    { query: GL.BLEND_DST, name: 'GL_BLEND_DST', kind: 'enum', value: [GL.ZERO] },
    { query: GL.DEPTH_FUNC, name: 'GL_DEPTH_FUNC', kind: 'enum', value: [GL.LESS] },
    { query: GL.DEPTH_WRITEMASK, name: 'GL_DEPTH_WRITEMASK', kind: 'bool', value: [1] },
    { query: GL.DEPTH_RANGE, name: 'GL_DEPTH_RANGE', kind: 'float', value: [0, 1] },
    { query: GL.ALPHA_TEST_FUNC, name: 'GL_ALPHA_TEST_FUNC', kind: 'enum', value: [GL.ALWAYS] },
    { query: GL.ALPHA_TEST_REF, name: 'GL_ALPHA_TEST_REF', kind: 'float', value: [0] },
    { query: GL.STENCIL_FUNC, name: 'GL_STENCIL_FUNC', kind: 'enum', value: [GL.ALWAYS] },
    { query: GL.STENCIL_REF, name: 'GL_STENCIL_REF', kind: 'int', value: [0] },
    {
        query: GL.STENCIL_VALUE_MASK, name: 'GL_STENCIL_VALUE_MASK', kind: 'int',
        value: [0xffffffff],
    },
    { query: GL.STENCIL_WRITEMASK, name: 'GL_STENCIL_WRITEMASK', kind: 'int', value: [0xffffffff] },
    { query: GL.STENCIL_FAIL, name: 'GL_STENCIL_FAIL', kind: 'enum', value: [GL.KEEP] },
    {
        query: GL.STENCIL_PASS_DEPTH_FAIL, name: 'GL_STENCIL_PASS_DEPTH_FAIL', kind: 'enum',
        value: [GL.KEEP],
    },
    {
        query: GL.STENCIL_PASS_DEPTH_PASS, name: 'GL_STENCIL_PASS_DEPTH_PASS', kind: 'enum',
        value: [GL.KEEP],
    },
    { query: GL.COLOR_WRITEMASK, name: 'GL_COLOR_WRITEMASK', kind: 'bool', value: [1, 1, 1, 1] },

    // --- rasterisation ---
    { query: GL.CULL_FACE_MODE, name: 'GL_CULL_FACE_MODE', kind: 'enum', value: [GL.BACK] },
    { query: GL.FRONT_FACE, name: 'GL_FRONT_FACE', kind: 'enum', value: [GL.CCW] },
    { query: GL.SHADE_MODEL, name: 'GL_SHADE_MODEL', kind: 'enum', value: [GL.SMOOTH] },
    { query: GL.POLYGON_MODE, name: 'GL_POLYGON_MODE', kind: 'enum', value: [GL.FILL, GL.FILL] },
    { query: GL.POINT_SIZE, name: 'GL_POINT_SIZE', kind: 'float', value: [1] },
    { query: GL.LINE_WIDTH, name: 'GL_LINE_WIDTH', kind: 'float', value: [1] },

    // --- fog and lighting ---
    { query: GL.FOG_MODE, name: 'GL_FOG_MODE', kind: 'enum', value: [GL.EXP] },
    { query: GL.FOG_DENSITY, name: 'GL_FOG_DENSITY', kind: 'float', value: [1] },
    { query: GL.FOG_START, name: 'GL_FOG_START', kind: 'float', value: [0] },
    { query: GL.FOG_END, name: 'GL_FOG_END', kind: 'float', value: [1] },
    { query: GL.FOG_INDEX, name: 'GL_FOG_INDEX', kind: 'float', value: [0] },
    {
        query: GL.FOG_COLOR, name: 'GL_FOG_COLOR', kind: 'float',
        value: [0, 0, 0, 0], normalised: true,
    },
    {
        query: GL.LIGHT_MODEL_AMBIENT, name: 'GL_LIGHT_MODEL_AMBIENT', kind: 'float',
        value: [0.2, 0.2, 0.2, 1], normalised: true,
    },
    {
        query: GL.LIGHT_MODEL_LOCAL_VIEWER, name: 'GL_LIGHT_MODEL_LOCAL_VIEWER', kind: 'bool',
        value: [0],
    },
    { query: GL.LIGHT_MODEL_TWO_SIDE, name: 'GL_LIGHT_MODEL_TWO_SIDE', kind: 'bool', value: [0] },

    // --- the transformation state that is not a matrix ---
    { query: GL.MATRIX_MODE, name: 'GL_MATRIX_MODE', kind: 'enum', value: [GL.MODELVIEW] },
    {
        query: GL.VIEWPORT, name: 'GL_VIEWPORT', kind: 'int',
        value: [0, 0, 0, 0], dependsOn: 'drawable',
    },
    {
        query: GL.SCISSOR_BOX, name: 'GL_SCISSOR_BOX', kind: 'int',
        value: [0, 0, 0, 0], dependsOn: 'drawable',
    },

    // --- pixel storage ---
    { query: GL.UNPACK_ALIGNMENT, name: 'GL_UNPACK_ALIGNMENT', kind: 'int', value: [4] },
    { query: GL.UNPACK_ROW_LENGTH, name: 'GL_UNPACK_ROW_LENGTH', kind: 'int', value: [0] },
    { query: GL.UNPACK_SKIP_ROWS, name: 'GL_UNPACK_SKIP_ROWS', kind: 'int', value: [0] },
    { query: GL.UNPACK_SKIP_PIXELS, name: 'GL_UNPACK_SKIP_PIXELS', kind: 'int', value: [0] },
    { query: GL.UNPACK_SWAP_BYTES, name: 'GL_UNPACK_SWAP_BYTES', kind: 'bool', value: [0] },
    { query: GL.UNPACK_LSB_FIRST, name: 'GL_UNPACK_LSB_FIRST', kind: 'bool', value: [0] },
    { query: GL.PACK_ALIGNMENT, name: 'GL_PACK_ALIGNMENT', kind: 'int', value: [4] },
    { query: GL.PACK_ROW_LENGTH, name: 'GL_PACK_ROW_LENGTH', kind: 'int', value: [0] },
    { query: GL.PACK_SKIP_ROWS, name: 'GL_PACK_SKIP_ROWS', kind: 'int', value: [0] },
    { query: GL.PACK_SKIP_PIXELS, name: 'GL_PACK_SKIP_PIXELS', kind: 'int', value: [0] },
    { query: GL.PACK_SWAP_BYTES, name: 'GL_PACK_SWAP_BYTES', kind: 'bool', value: [0] },
    { query: GL.PACK_LSB_FIRST, name: 'GL_PACK_LSB_FIRST', kind: 'bool', value: [0] },

    // --- texture and list bookkeeping ---
    { query: GL.TEXTURE_BINDING_1D, name: 'GL_TEXTURE_BINDING_1D', kind: 'int', value: [0] },
    { query: GL.TEXTURE_BINDING_2D, name: 'GL_TEXTURE_BINDING_2D', kind: 'int', value: [0] },
    { query: GL.LIST_BASE, name: 'GL_LIST_BASE', kind: 'int', value: [0] },
    { query: GL.LIST_INDEX, name: 'GL_LIST_INDEX', kind: 'int', value: [0] },
    { query: GL.LIST_MODE, name: 'GL_LIST_MODE', kind: 'enum', value: [0] },

    // --- the framebuffer a single-buffered format does not have ---
    {
        query: GL.DRAW_BUFFER, name: 'GL_DRAW_BUFFER', kind: 'enum',
        value: [0], dependsOn: 'buffer',
    },
    {
        query: GL.READ_BUFFER, name: 'GL_READ_BUFFER', kind: 'enum',
        value: [0], dependsOn: 'buffer',
    },

    // --- implementation limits ---
    { query: GL.MAX_TEXTURE_SIZE, name: 'GL_MAX_TEXTURE_SIZE', kind: 'int', value: [2048] },
    {
        query: GL.MAX_MODELVIEW_STACK_DEPTH, name: 'GL_MAX_MODELVIEW_STACK_DEPTH', kind: 'int',
        value: [STACK_LIMITS.modelview],
    },
    {
        query: GL.MAX_PROJECTION_STACK_DEPTH, name: 'GL_MAX_PROJECTION_STACK_DEPTH', kind: 'int',
        value: [STACK_LIMITS.projection],
    },
    {
        query: GL.MAX_TEXTURE_STACK_DEPTH, name: 'GL_MAX_TEXTURE_STACK_DEPTH', kind: 'int',
        value: [STACK_LIMITS.texture],
    },
]);

/**
 * @param {StateDefault} entry
 * @param {StateInputs} inputs
 * @returns {number[]}
 */
export function resolveStateDefault(entry, inputs){
    switch (entry.dependsOn)
    {
        case 'drawable':
            return [0, 0, inputs.width, inputs.height];
        case 'buffer':
            return [inputs.doubleBuffered ? GL.BACK : GL.FRONT];
        default:
            return [...entry.value];
    }
}

/**
 * @typedef {Object} StateRecord
 * @property {'bool' | 'int' | 'enum' | 'float'} kind
 * @property {number[]} values
 * @property {boolean} [normalised]
 */

/**
 * @param {StateInputs} inputs
 * @returns {Map<number, StateRecord>}
 */
export function createDefaultState(inputs){
    /** @type {Map<number, StateRecord>} */
    const state = new Map();
    for (const entry of DEFAULT_STATE)
    {
        state.set(entry.query, {
            kind: entry.kind,
            values: resolveStateDefault(entry, inputs),
            normalised: entry.normalised,
        });
    }
    return state;
}

/** The largest signed 32-bit value, which a normalised 1.0 maps onto. */
const INT_MAX = 0x7fffffff;

/**
 * Reads a state record the way a typed query would see it.
 *
 * @param {StateRecord} record
 * @param {'bool' | 'int' | 'float'} as
 * @returns {number[]}
 */
export function readState(record, as){
    if (as === 'bool')
    {
        return record.values.map(value=>(value !== 0 ? 1 : 0));
    }
    if (as === 'float')
    {
        return [...record.values];
    }
    if (record.kind !== 'float')
    {
        // Already integral. Not masked to a signed word: a program reads a
        // full write mask back as 0xffffffff, and truncating it to -1 makes
        // the comparison it does next fail.
        return [...record.values];
    }
    return record.values.map(value=>Math.round(record.normalised ? value * INT_MAX : value));
}
