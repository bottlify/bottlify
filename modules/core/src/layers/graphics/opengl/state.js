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
import { PROGRAM_LIMITS } from './arb-program.js';

/**
 * How many texture units a context has: the larger of the coordinate sets
 * and the image units the specification's minimum requires, which is what
 * the unit selector ranges over.
 */
export const TEXTURE_UNITS = 8;

/**
 * How many units the conventional pipeline combines (GL_MAX_TEXTURE_UNITS):
 * the fixed rasterisation applies texture environments to the first four,
 * while the rest exist for the coordinates, matrices and image units a
 * program reads.
 */
export const CONVENTIONAL_UNITS = 4;

/**
 * @typedef {Object} StateDefault
 * @property {number} query
 * @property {string} name
 * @property {'bool' | 'int' | 'enum' | 'float'} kind
 * @property {readonly number[]} value
 * @property {boolean} [normalised]
 *           A colour or normal component, whose integer form is the mapped
 *           range rather than the rounded number.
 * @property {'drawable' | 'buffer' | 'depth' | 'double'} [dependsOn]
 *           Names what the value is derived from, in which case `value` is
 *           only the placeholder `resolveStateDefault` replaces.
 */

/**
 * @typedef {Object} StateInputs
 * @property {number} width           the drawable's width when first attached
 * @property {number} height
 * @property {boolean} doubleBuffered
 * @property {number} [depthBits]     what the pixel format promised; zero when
 *                                    it promised nothing, and then there is no
 *                                    depth buffer to test against
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
    { query: GL.LIGHT1, name: 'GL_LIGHT1', kind: 'bool', value: [0] },
    { query: GL.LIGHT2, name: 'GL_LIGHT2', kind: 'bool', value: [0] },
    { query: GL.LIGHT3, name: 'GL_LIGHT3', kind: 'bool', value: [0] },
    { query: GL.LIGHT4, name: 'GL_LIGHT4', kind: 'bool', value: [0] },
    { query: GL.LIGHT5, name: 'GL_LIGHT5', kind: 'bool', value: [0] },
    { query: GL.LIGHT6, name: 'GL_LIGHT6', kind: 'bool', value: [0] },
    { query: GL.LIGHT7, name: 'GL_LIGHT7', kind: 'bool', value: [0] },
    { query: GL.TEXTURE_CUBE_MAP, name: 'GL_TEXTURE_CUBE_MAP', kind: 'bool', value: [0] },
    { query: GL.TEXTURE_GEN_S, name: 'GL_TEXTURE_GEN_S', kind: 'bool', value: [0] },
    { query: GL.TEXTURE_GEN_T, name: 'GL_TEXTURE_GEN_T', kind: 'bool', value: [0] },
    { query: GL.TEXTURE_GEN_R, name: 'GL_TEXTURE_GEN_R', kind: 'bool', value: [0] },
    { query: GL.TEXTURE_GEN_Q, name: 'GL_TEXTURE_GEN_Q', kind: 'bool', value: [0] },
    { query: GL.CLIP_PLANE0, name: 'GL_CLIP_PLANE0', kind: 'bool', value: [0] },
    { query: GL.CLIP_PLANE1, name: 'GL_CLIP_PLANE1', kind: 'bool', value: [0] },
    { query: GL.CLIP_PLANE2, name: 'GL_CLIP_PLANE2', kind: 'bool', value: [0] },
    { query: GL.CLIP_PLANE3, name: 'GL_CLIP_PLANE3', kind: 'bool', value: [0] },
    { query: GL.CLIP_PLANE4, name: 'GL_CLIP_PLANE4', kind: 'bool', value: [0] },
    { query: GL.CLIP_PLANE5, name: 'GL_CLIP_PLANE5', kind: 'bool', value: [0] },
    { query: GL.COLOR_LOGIC_OP, name: 'GL_COLOR_LOGIC_OP', kind: 'bool', value: [0] },
    { query: GL.INDEX_LOGIC_OP, name: 'GL_INDEX_LOGIC_OP', kind: 'bool', value: [0] },
    { query: GL.POLYGON_OFFSET_POINT, name: 'GL_POLYGON_OFFSET_POINT', kind: 'bool', value: [0] },
    { query: GL.POLYGON_OFFSET_LINE, name: 'GL_POLYGON_OFFSET_LINE', kind: 'bool', value: [0] },
    { query: GL.LINE_STIPPLE, name: 'GL_LINE_STIPPLE', kind: 'bool', value: [0] },
    { query: GL.POLYGON_STIPPLE, name: 'GL_POLYGON_STIPPLE', kind: 'bool', value: [0] },
    { query: GL.RESCALE_NORMAL, name: 'GL_RESCALE_NORMAL', kind: 'bool', value: [0] },
    { query: GL.COLOR_SUM, name: 'GL_COLOR_SUM', kind: 'bool', value: [0] },
    { query: GL.AUTO_NORMAL, name: 'GL_AUTO_NORMAL', kind: 'bool', value: [0] },
    { query: GL.VERTEX_PROGRAM_ARB, name: 'GL_VERTEX_PROGRAM_ARB', kind: 'bool', value: [0] },
    { query: GL.FRAGMENT_PROGRAM_ARB, name: 'GL_FRAGMENT_PROGRAM_ARB', kind: 'bool', value: [0] },
    {
        query: GL.VERTEX_PROGRAM_POINT_SIZE_ARB, name: 'GL_VERTEX_PROGRAM_POINT_SIZE_ARB',
        kind: 'bool', value: [0],
    },
    {
        query: GL.VERTEX_PROGRAM_TWO_SIDE_ARB, name: 'GL_VERTEX_PROGRAM_TWO_SIDE_ARB',
        kind: 'bool', value: [0],
    },
]);

/**
 * The client-side arrays, which glEnableClientState turns on rather than
 * glEnable -- and which glIsEnabled still reports, because the specification
 * says it does.
 *
 * @type {readonly StateDefault[]}
 */
export const DEFAULT_CLIENT_ENABLES = Object.freeze([
    { query: GL.VERTEX_ARRAY, name: 'GL_VERTEX_ARRAY', kind: 'bool', value: [0] },
    { query: GL.NORMAL_ARRAY, name: 'GL_NORMAL_ARRAY', kind: 'bool', value: [0] },
    { query: GL.COLOR_ARRAY, name: 'GL_COLOR_ARRAY', kind: 'bool', value: [0] },
    { query: GL.INDEX_ARRAY, name: 'GL_INDEX_ARRAY', kind: 'bool', value: [0] },
    { query: GL.TEXTURE_COORD_ARRAY, name: 'GL_TEXTURE_COORD_ARRAY', kind: 'bool', value: [0] },
    { query: GL.EDGE_FLAG_ARRAY, name: 'GL_EDGE_FLAG_ARRAY', kind: 'bool', value: [0] },
    {
        query: GL.SECONDARY_COLOR_ARRAY, name: 'GL_SECONDARY_COLOR_ARRAY', kind: 'bool',
        value: [0],
    },
    { query: GL.FOG_COORDINATE_ARRAY, name: 'GL_FOG_COORDINATE_ARRAY', kind: 'bool', value: [0] },
]);

/** @type {readonly StateDefault[]} */
export const DEFAULT_STATE = Object.freeze([
    ...DEFAULT_ENABLES,
    ...DEFAULT_CLIENT_ENABLES,

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
    {
        query: GL.CURRENT_SECONDARY_COLOR, name: 'GL_CURRENT_SECONDARY_COLOR', kind: 'float',
        value: [0, 0, 0, 1], normalised: true,
    },
    {
        query: GL.CURRENT_FOG_COORDINATE, name: 'GL_CURRENT_FOG_COORDINATE', kind: 'float',
        value: [0],
    },
    {
        query: GL.CURRENT_RASTER_POSITION, name: 'GL_CURRENT_RASTER_POSITION', kind: 'float',
        value: [0, 0, 0, 1],
    },
    {
        query: GL.CURRENT_RASTER_COLOR, name: 'GL_CURRENT_RASTER_COLOR', kind: 'float',
        value: [1, 1, 1, 1], normalised: true,
    },
    { query: GL.CURRENT_RASTER_INDEX, name: 'GL_CURRENT_RASTER_INDEX', kind: 'float', value: [1] },
    {
        query: GL.CURRENT_RASTER_TEXTURE_COORDS, name: 'GL_CURRENT_RASTER_TEXTURE_COORDS',
        kind: 'float', value: [0, 0, 0, 1],
    },
    {
        query: GL.CURRENT_RASTER_POSITION_VALID, name: 'GL_CURRENT_RASTER_POSITION_VALID',
        kind: 'bool', value: [1],
    },
    {
        query: GL.CURRENT_RASTER_DISTANCE, name: 'GL_CURRENT_RASTER_DISTANCE', kind: 'float',
        value: [0],
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
    { query: GL.LOGIC_OP_MODE, name: 'GL_LOGIC_OP_MODE', kind: 'enum', value: [GL.COPY] },
    {
        query: GL.BLEND_COLOR, name: 'GL_BLEND_COLOR', kind: 'float',
        value: [0, 0, 0, 0], normalised: true,
    },

    // --- rasterisation ---
    { query: GL.CULL_FACE_MODE, name: 'GL_CULL_FACE_MODE', kind: 'enum', value: [GL.BACK] },
    { query: GL.FRONT_FACE, name: 'GL_FRONT_FACE', kind: 'enum', value: [GL.CCW] },
    { query: GL.SHADE_MODEL, name: 'GL_SHADE_MODEL', kind: 'enum', value: [GL.SMOOTH] },
    { query: GL.POLYGON_MODE, name: 'GL_POLYGON_MODE', kind: 'enum', value: [GL.FILL, GL.FILL] },
    { query: GL.POINT_SIZE, name: 'GL_POINT_SIZE', kind: 'float', value: [1] },
    { query: GL.LINE_WIDTH, name: 'GL_LINE_WIDTH', kind: 'float', value: [1] },
    {
        query: GL.LINE_STIPPLE_PATTERN, name: 'GL_LINE_STIPPLE_PATTERN', kind: 'int',
        value: [0xffff],
    },
    { query: GL.LINE_STIPPLE_REPEAT, name: 'GL_LINE_STIPPLE_REPEAT', kind: 'int', value: [1] },
    {
        query: GL.POLYGON_OFFSET_FACTOR, name: 'GL_POLYGON_OFFSET_FACTOR', kind: 'float',
        value: [0],
    },
    { query: GL.POLYGON_OFFSET_UNITS, name: 'GL_POLYGON_OFFSET_UNITS', kind: 'float', value: [0] },
    { query: GL.RENDER_MODE, name: 'GL_RENDER_MODE', kind: 'enum', value: [GL.RENDER] },
    {
        query: GL.PERSPECTIVE_CORRECTION_HINT, name: 'GL_PERSPECTIVE_CORRECTION_HINT',
        kind: 'enum', value: [GL.DONT_CARE],
    },
    {
        query: GL.POINT_SMOOTH_HINT, name: 'GL_POINT_SMOOTH_HINT', kind: 'enum',
        value: [GL.DONT_CARE],
    },
    {
        query: GL.LINE_SMOOTH_HINT, name: 'GL_LINE_SMOOTH_HINT', kind: 'enum',
        value: [GL.DONT_CARE],
    },
    {
        query: GL.POLYGON_SMOOTH_HINT, name: 'GL_POLYGON_SMOOTH_HINT', kind: 'enum',
        value: [GL.DONT_CARE],
    },
    { query: GL.FOG_HINT, name: 'GL_FOG_HINT', kind: 'enum', value: [GL.DONT_CARE] },
    {
        query: GL.GENERATE_MIPMAP_HINT, name: 'GL_GENERATE_MIPMAP_HINT', kind: 'enum',
        value: [GL.DONT_CARE],
    },
    {
        query: GL.TEXTURE_COMPRESSION_HINT, name: 'GL_TEXTURE_COMPRESSION_HINT', kind: 'enum',
        value: [GL.DONT_CARE],
    },

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
    {
        query: GL.LIGHT_MODEL_COLOR_CONTROL, name: 'GL_LIGHT_MODEL_COLOR_CONTROL', kind: 'enum',
        value: [GL.SINGLE_COLOR],
    },
    {
        query: GL.COLOR_MATERIAL_FACE, name: 'GL_COLOR_MATERIAL_FACE', kind: 'enum',
        value: [GL.FRONT_AND_BACK],
    },
    {
        query: GL.COLOR_MATERIAL_PARAMETER, name: 'GL_COLOR_MATERIAL_PARAMETER', kind: 'enum',
        value: [GL.AMBIENT_AND_DIFFUSE],
    },
    {
        query: GL.FOG_COORDINATE_SOURCE, name: 'GL_FOG_COORDINATE_SOURCE', kind: 'enum',
        value: [GL.FRAGMENT_DEPTH],
    },

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

    // --- pixel transfer ---
    { query: GL.ZOOM_X, name: 'GL_ZOOM_X', kind: 'float', value: [1] },
    { query: GL.ZOOM_Y, name: 'GL_ZOOM_Y', kind: 'float', value: [1] },

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
    {
        query: GL.TEXTURE_BINDING_CUBE_MAP, name: 'GL_TEXTURE_BINDING_CUBE_MAP', kind: 'int',
        value: [0],
    },
    { query: GL.ACTIVE_TEXTURE, name: 'GL_ACTIVE_TEXTURE', kind: 'enum', value: [GL.TEXTURE0] },
    {
        query: GL.CLIENT_ACTIVE_TEXTURE, name: 'GL_CLIENT_ACTIVE_TEXTURE', kind: 'enum',
        value: [GL.TEXTURE0],
    },

    // --- vertex arrays ---
    { query: GL.VERTEX_ARRAY_SIZE, name: 'GL_VERTEX_ARRAY_SIZE', kind: 'int', value: [4] },
    { query: GL.VERTEX_ARRAY_TYPE, name: 'GL_VERTEX_ARRAY_TYPE', kind: 'enum', value: [GL.FLOAT] },
    { query: GL.VERTEX_ARRAY_STRIDE, name: 'GL_VERTEX_ARRAY_STRIDE', kind: 'int', value: [0] },
    { query: GL.NORMAL_ARRAY_TYPE, name: 'GL_NORMAL_ARRAY_TYPE', kind: 'enum', value: [GL.FLOAT] },
    { query: GL.NORMAL_ARRAY_STRIDE, name: 'GL_NORMAL_ARRAY_STRIDE', kind: 'int', value: [0] },
    { query: GL.COLOR_ARRAY_SIZE, name: 'GL_COLOR_ARRAY_SIZE', kind: 'int', value: [4] },
    { query: GL.COLOR_ARRAY_TYPE, name: 'GL_COLOR_ARRAY_TYPE', kind: 'enum', value: [GL.FLOAT] },
    { query: GL.COLOR_ARRAY_STRIDE, name: 'GL_COLOR_ARRAY_STRIDE', kind: 'int', value: [0] },
    { query: GL.INDEX_ARRAY_TYPE, name: 'GL_INDEX_ARRAY_TYPE', kind: 'enum', value: [GL.FLOAT] },
    { query: GL.INDEX_ARRAY_STRIDE, name: 'GL_INDEX_ARRAY_STRIDE', kind: 'int', value: [0] },
    {
        query: GL.TEXTURE_COORD_ARRAY_SIZE, name: 'GL_TEXTURE_COORD_ARRAY_SIZE', kind: 'int',
        value: [4],
    },
    {
        query: GL.TEXTURE_COORD_ARRAY_TYPE, name: 'GL_TEXTURE_COORD_ARRAY_TYPE', kind: 'enum',
        value: [GL.FLOAT],
    },
    {
        query: GL.TEXTURE_COORD_ARRAY_STRIDE, name: 'GL_TEXTURE_COORD_ARRAY_STRIDE', kind: 'int',
        value: [0],
    },
    {
        query: GL.EDGE_FLAG_ARRAY_STRIDE, name: 'GL_EDGE_FLAG_ARRAY_STRIDE', kind: 'int',
        value: [0],
    },
    {
        query: GL.SECONDARY_COLOR_ARRAY_SIZE, name: 'GL_SECONDARY_COLOR_ARRAY_SIZE', kind: 'int',
        value: [3],
    },
    {
        query: GL.SECONDARY_COLOR_ARRAY_TYPE, name: 'GL_SECONDARY_COLOR_ARRAY_TYPE', kind: 'enum',
        value: [GL.FLOAT],
    },
    {
        query: GL.SECONDARY_COLOR_ARRAY_STRIDE, name: 'GL_SECONDARY_COLOR_ARRAY_STRIDE',
        kind: 'int', value: [0],
    },
    {
        query: GL.FOG_COORDINATE_ARRAY_TYPE, name: 'GL_FOG_COORDINATE_ARRAY_TYPE', kind: 'enum',
        value: [GL.FLOAT],
    },
    {
        query: GL.FOG_COORDINATE_ARRAY_STRIDE, name: 'GL_FOG_COORDINATE_ARRAY_STRIDE',
        kind: 'int', value: [0],
    },
    { query: GL.ARRAY_BUFFER_BINDING, name: 'GL_ARRAY_BUFFER_BINDING', kind: 'int', value: [0] },
    {
        query: GL.ELEMENT_ARRAY_BUFFER_BINDING, name: 'GL_ELEMENT_ARRAY_BUFFER_BINDING',
        kind: 'int', value: [0],
    },
    {
        query: GL.VERTEX_ARRAY_BUFFER_BINDING, name: 'GL_VERTEX_ARRAY_BUFFER_BINDING',
        kind: 'int', value: [0],
    },
    {
        query: GL.NORMAL_ARRAY_BUFFER_BINDING, name: 'GL_NORMAL_ARRAY_BUFFER_BINDING',
        kind: 'int', value: [0],
    },
    {
        query: GL.COLOR_ARRAY_BUFFER_BINDING, name: 'GL_COLOR_ARRAY_BUFFER_BINDING',
        kind: 'int', value: [0],
    },
    {
        query: GL.INDEX_ARRAY_BUFFER_BINDING, name: 'GL_INDEX_ARRAY_BUFFER_BINDING',
        kind: 'int', value: [0],
    },
    {
        query: GL.TEXTURE_COORD_ARRAY_BUFFER_BINDING, name: 'GL_TEXTURE_COORD_ARRAY_BUFFER_BINDING',
        kind: 'int', value: [0],
    },
    {
        query: GL.ARRAY_ELEMENT_LOCK_FIRST, name: 'GL_ARRAY_ELEMENT_LOCK_FIRST', kind: 'int',
        value: [0],
    },
    {
        query: GL.ARRAY_ELEMENT_LOCK_COUNT, name: 'GL_ARRAY_ELEMENT_LOCK_COUNT', kind: 'int',
        value: [0],
    },
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

    // --- the framebuffer's own shape ---
    { query: GL.RED_BITS, name: 'GL_RED_BITS', kind: 'int', value: [8] },
    { query: GL.GREEN_BITS, name: 'GL_GREEN_BITS', kind: 'int', value: [8] },
    { query: GL.BLUE_BITS, name: 'GL_BLUE_BITS', kind: 'int', value: [8] },
    { query: GL.ALPHA_BITS, name: 'GL_ALPHA_BITS', kind: 'int', value: [8] },
    { query: GL.DEPTH_BITS, name: 'GL_DEPTH_BITS', kind: 'int', value: [0], dependsOn: 'depth' },
    { query: GL.STENCIL_BITS, name: 'GL_STENCIL_BITS', kind: 'int', value: [0] },
    { query: GL.INDEX_BITS, name: 'GL_INDEX_BITS', kind: 'int', value: [0] },
    { query: GL.ACCUM_RED_BITS, name: 'GL_ACCUM_RED_BITS', kind: 'int', value: [0] },
    { query: GL.ACCUM_GREEN_BITS, name: 'GL_ACCUM_GREEN_BITS', kind: 'int', value: [0] },
    { query: GL.ACCUM_BLUE_BITS, name: 'GL_ACCUM_BLUE_BITS', kind: 'int', value: [0] },
    { query: GL.ACCUM_ALPHA_BITS, name: 'GL_ACCUM_ALPHA_BITS', kind: 'int', value: [0] },
    { query: GL.AUX_BUFFERS, name: 'GL_AUX_BUFFERS', kind: 'int', value: [0] },
    { query: GL.SUBPIXEL_BITS, name: 'GL_SUBPIXEL_BITS', kind: 'int', value: [4] },
    {
        query: GL.DOUBLEBUFFER, name: 'GL_DOUBLEBUFFER', kind: 'bool', value: [0],
        dependsOn: 'double',
    },
    { query: GL.STEREO, name: 'GL_STEREO', kind: 'bool', value: [0] },
    { query: GL.RGBA_MODE, name: 'GL_RGBA_MODE', kind: 'bool', value: [1] },
    { query: GL.INDEX_MODE, name: 'GL_INDEX_MODE', kind: 'bool', value: [0] },

    // --- implementation limits ---
    { query: GL.MAX_TEXTURE_SIZE, name: 'GL_MAX_TEXTURE_SIZE', kind: 'int', value: [2048] },
    {
        query: GL.MAX_CUBE_MAP_TEXTURE_SIZE, name: 'GL_MAX_CUBE_MAP_TEXTURE_SIZE', kind: 'int',
        value: [2048],
    },
    {
        query: GL.MAX_TEXTURE_UNITS, name: 'GL_MAX_TEXTURE_UNITS', kind: 'int',
        value: [CONVENTIONAL_UNITS],
    },
    { query: GL.MAX_LIGHTS, name: 'GL_MAX_LIGHTS', kind: 'int', value: [8] },
    { query: GL.MAX_CLIP_PLANES, name: 'GL_MAX_CLIP_PLANES', kind: 'int', value: [6] },
    { query: GL.MAX_VIEWPORT_DIMS, name: 'GL_MAX_VIEWPORT_DIMS', kind: 'int', value: [4096, 4096] },
    {
        query: GL.MAX_ATTRIB_STACK_DEPTH, name: 'GL_MAX_ATTRIB_STACK_DEPTH', kind: 'int',
        value: [16],
    },
    {
        query: GL.MAX_CLIENT_ATTRIB_STACK_DEPTH, name: 'GL_MAX_CLIENT_ATTRIB_STACK_DEPTH',
        kind: 'int', value: [16],
    },
    { query: GL.ATTRIB_STACK_DEPTH, name: 'GL_ATTRIB_STACK_DEPTH', kind: 'int', value: [0] },
    {
        query: GL.CLIENT_ATTRIB_STACK_DEPTH, name: 'GL_CLIENT_ATTRIB_STACK_DEPTH', kind: 'int',
        value: [0],
    },
    { query: GL.MAX_LIST_NESTING, name: 'GL_MAX_LIST_NESTING', kind: 'int', value: [64] },
    { query: GL.MAX_NAME_STACK_DEPTH, name: 'GL_MAX_NAME_STACK_DEPTH', kind: 'int', value: [64] },
    { query: GL.MAX_EVAL_ORDER, name: 'GL_MAX_EVAL_ORDER', kind: 'int', value: [8] },
    { query: GL.MAX_PIXEL_MAP_TABLE, name: 'GL_MAX_PIXEL_MAP_TABLE', kind: 'int', value: [32] },
    {
        query: GL.MAX_ELEMENTS_VERTICES, name: 'GL_MAX_ELEMENTS_VERTICES', kind: 'int',
        value: [4096],
    },
    {
        query: GL.MAX_ELEMENTS_INDICES, name: 'GL_MAX_ELEMENTS_INDICES', kind: 'int',
        value: [4096],
    },
    { query: GL.POINT_SIZE_RANGE, name: 'GL_POINT_SIZE_RANGE', kind: 'float', value: [1, 64] },
    {
        query: GL.POINT_SIZE_GRANULARITY, name: 'GL_POINT_SIZE_GRANULARITY', kind: 'float',
        value: [1],
    },
    { query: GL.LINE_WIDTH_RANGE, name: 'GL_LINE_WIDTH_RANGE', kind: 'float', value: [1, 1] },
    {
        query: GL.LINE_WIDTH_GRANULARITY, name: 'GL_LINE_WIDTH_GRANULARITY', kind: 'float',
        value: [1],
    },
    {
        query: GL.ALIASED_POINT_SIZE_RANGE, name: 'GL_ALIASED_POINT_SIZE_RANGE', kind: 'float',
        value: [1, 64],
    },
    {
        query: GL.ALIASED_LINE_WIDTH_RANGE, name: 'GL_ALIASED_LINE_WIDTH_RANGE', kind: 'float',
        value: [1, 1],
    },
    {
        query: GL.NUM_COMPRESSED_TEXTURE_FORMATS, name: 'GL_NUM_COMPRESSED_TEXTURE_FORMATS',
        kind: 'int', value: [4],
    },
    {
        query: GL.COMPRESSED_TEXTURE_FORMATS, name: 'GL_COMPRESSED_TEXTURE_FORMATS', kind: 'enum',
        value: [
            GL.COMPRESSED_RGB_S3TC_DXT1_EXT, GL.COMPRESSED_RGBA_S3TC_DXT1_EXT,
            GL.COMPRESSED_RGBA_S3TC_DXT3_EXT, GL.COMPRESSED_RGBA_S3TC_DXT5_EXT,
        ],
    },
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

    // --- ARB program limits ---
    // One flat value per enum, derived from the parser's own limits so the
    // number a program is refused at and the number glGetIntegerv reports are
    // the same specification seen twice. The per-target counts a program
    // actually uses are GetProgramivARB's, answered in context-programs.js.
    {
        query: GL.MAX_VERTEX_ATTRIBS_ARB, name: 'GL_MAX_VERTEX_ATTRIBS_ARB', kind: 'int',
        value: [16],
    },
    // The selector's own range: a program's coordinate sets and image units
    // are the units the context holds, which the conventional count below
    // is the compatible subset of.
    {
        query: GL.MAX_TEXTURE_COORDS_ARB, name: 'GL_MAX_TEXTURE_COORDS_ARB', kind: 'int',
        value: [TEXTURE_UNITS],
    },
    {
        query: GL.MAX_TEXTURE_IMAGE_UNITS_ARB, name: 'GL_MAX_TEXTURE_IMAGE_UNITS_ARB',
        kind: 'int', value: [TEXTURE_UNITS],
    },
    {
        query: GL.MAX_PROGRAM_MATRICES_ARB, name: 'GL_MAX_PROGRAM_MATRICES_ARB', kind: 'int',
        value: [8],
    },
    {
        query: GL.MAX_PROGRAM_MATRIX_STACK_DEPTH_ARB, name: 'GL_MAX_PROGRAM_MATRIX_STACK_DEPTH_ARB',
        kind: 'int', value: [1],
    },
    {
        query: GL.MAX_PROGRAM_ENV_PARAMETERS_ARB, name: 'GL_MAX_PROGRAM_ENV_PARAMETERS_ARB',
        kind: 'int', value: [PROGRAM_LIMITS.vertex.envParameters],
    },
    {
        query: GL.MAX_PROGRAM_LOCAL_PARAMETERS_ARB, name: 'GL_MAX_PROGRAM_LOCAL_PARAMETERS_ARB',
        kind: 'int', value: [PROGRAM_LIMITS.vertex.localParameters],
    },
    {
        query: GL.MAX_PROGRAM_INSTRUCTIONS_ARB, name: 'GL_MAX_PROGRAM_INSTRUCTIONS_ARB',
        kind: 'int', value: [PROGRAM_LIMITS.vertex.instructions],
    },
    {
        query: GL.MAX_PROGRAM_NATIVE_INSTRUCTIONS_ARB,
        name: 'GL_MAX_PROGRAM_NATIVE_INSTRUCTIONS_ARB', kind: 'int',
        value: [PROGRAM_LIMITS.vertex.nativeInstructions],
    },
    {
        query: GL.MAX_PROGRAM_TEMPORARIES_ARB, name: 'GL_MAX_PROGRAM_TEMPORARIES_ARB',
        kind: 'int', value: [PROGRAM_LIMITS.vertex.temporaries],
    },
    {
        query: GL.MAX_PROGRAM_NATIVE_TEMPORARIES_ARB,
        name: 'GL_MAX_PROGRAM_NATIVE_TEMPORARIES_ARB', kind: 'int',
        value: [PROGRAM_LIMITS.vertex.nativeTemporaries],
    },
    {
        query: GL.MAX_PROGRAM_PARAMETERS_ARB, name: 'GL_MAX_PROGRAM_PARAMETERS_ARB', kind: 'int',
        value: [PROGRAM_LIMITS.vertex.parameters],
    },
    {
        query: GL.MAX_PROGRAM_NATIVE_PARAMETERS_ARB, name: 'GL_MAX_PROGRAM_NATIVE_PARAMETERS_ARB',
        kind: 'int', value: [PROGRAM_LIMITS.vertex.nativeParameters],
    },
    {
        query: GL.MAX_PROGRAM_ATTRIBS_ARB, name: 'GL_MAX_PROGRAM_ATTRIBS_ARB', kind: 'int',
        value: [PROGRAM_LIMITS.vertex.attribs],
    },
    {
        query: GL.MAX_PROGRAM_NATIVE_ATTRIBS_ARB, name: 'GL_MAX_PROGRAM_NATIVE_ATTRIBS_ARB',
        kind: 'int', value: [PROGRAM_LIMITS.vertex.nativeAttribs],
    },
    {
        query: GL.MAX_PROGRAM_ADDRESS_REGISTERS_ARB, name: 'GL_MAX_PROGRAM_ADDRESS_REGISTERS_ARB',
        kind: 'int', value: [PROGRAM_LIMITS.vertex.addressRegisters],
    },
    {
        query: GL.MAX_PROGRAM_NATIVE_ADDRESS_REGISTERS_ARB,
        name: 'GL_MAX_PROGRAM_NATIVE_ADDRESS_REGISTERS_ARB', kind: 'int',
        value: [PROGRAM_LIMITS.vertex.nativeAddressRegisters],
    },
    {
        query: GL.MAX_PROGRAM_ALU_INSTRUCTIONS_ARB, name: 'GL_MAX_PROGRAM_ALU_INSTRUCTIONS_ARB',
        kind: 'int', value: [PROGRAM_LIMITS.fragment.aluInstructions],
    },
    {
        query: GL.MAX_PROGRAM_NATIVE_ALU_INSTRUCTIONS_ARB,
        name: 'GL_MAX_PROGRAM_NATIVE_ALU_INSTRUCTIONS_ARB', kind: 'int',
        value: [PROGRAM_LIMITS.fragment.nativeAluInstructions],
    },
    {
        query: GL.MAX_PROGRAM_TEX_INSTRUCTIONS_ARB, name: 'GL_MAX_PROGRAM_TEX_INSTRUCTIONS_ARB',
        kind: 'int', value: [PROGRAM_LIMITS.fragment.texInstructions],
    },
    {
        query: GL.MAX_PROGRAM_NATIVE_TEX_INSTRUCTIONS_ARB,
        name: 'GL_MAX_PROGRAM_NATIVE_TEX_INSTRUCTIONS_ARB', kind: 'int',
        value: [PROGRAM_LIMITS.fragment.nativeTexInstructions],
    },
    {
        query: GL.MAX_PROGRAM_TEX_INDIRECTIONS_ARB, name: 'GL_MAX_PROGRAM_TEX_INDIRECTIONS_ARB',
        kind: 'int', value: [PROGRAM_LIMITS.fragment.texIndirections],
    },
    {
        query: GL.MAX_PROGRAM_NATIVE_TEX_INDIRECTIONS_ARB,
        name: 'GL_MAX_PROGRAM_NATIVE_TEX_INDIRECTIONS_ARB', kind: 'int',
        value: [PROGRAM_LIMITS.fragment.nativeTexIndirections],
    },
    {
        query: GL.PROGRAM_ERROR_POSITION_ARB, name: 'GL_PROGRAM_ERROR_POSITION_ARB', kind: 'int',
        value: [-1],
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
        case 'double':
            return [inputs.doubleBuffered ? 1 : 0];
        case 'depth':
            return [inputs.depthBits ?? 0];
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
