/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Tessellation's state and calls (OpenGL 4.0 section 2.12,
 * GL_ARB_tessellation_shader): the control points a patch has, the levels a
 * patch is tessellated at where no control shader says them, the limits, and
 * what a program linked with tessellation shaders answers about them.
 *
 * - **A patch is drawn only through a tessellation evaluation shader**: GL_PATCHES
 *   with a program that has none, or any other mode with one that has, is
 *   INVALID_OPERATION (section 2.12.1).
 * - **The default levels are kept as given**; the tessellator clamps and rounds
 *   them by the spacing when a draw reads them (section 2.12.2).
 */

import { GL } from './constants.js';
import { BLOCK_LIMITS } from './glsl-link.js';
import { MAX_PATCH_VERTICES } from './glsl-link-tess.js';
import { GLSL_CONSTANTS } from './glsl-library.js';

/** The enumerants of OpenGL 4.0's tessellation (GL_ARB_tessellation_shader). */
export const TESS = Object.freeze({
    PATCHES: 0x000e,
    PATCH_VERTICES: 0x8e72,
    PATCH_DEFAULT_INNER_LEVEL: 0x8e73,
    PATCH_DEFAULT_OUTER_LEVEL: 0x8e74,
    TESS_CONTROL_OUTPUT_VERTICES: 0x8e75,
    TESS_GEN_MODE: 0x8e76,
    TESS_GEN_SPACING: 0x8e77,
    TESS_GEN_VERTEX_ORDER: 0x8e78,
    TESS_GEN_POINT_MODE: 0x8e79,
    ISOLINES: 0x8e7a,
    FRACTIONAL_ODD: 0x8e7b,
    FRACTIONAL_EVEN: 0x8e7c,
    MAX_PATCH_VERTICES: 0x8e7d,
    MAX_TESS_GEN_LEVEL: 0x8e7e,
    MAX_TESS_CONTROL_UNIFORM_COMPONENTS: 0x8e7f,
    MAX_TESS_EVALUATION_UNIFORM_COMPONENTS: 0x8e80,
    MAX_TESS_CONTROL_TEXTURE_IMAGE_UNITS: 0x8e81,
    MAX_TESS_EVALUATION_TEXTURE_IMAGE_UNITS: 0x8e82,
    MAX_TESS_CONTROL_OUTPUT_COMPONENTS: 0x8e83,
    MAX_TESS_PATCH_COMPONENTS: 0x8e84,
    MAX_TESS_CONTROL_TOTAL_OUTPUT_COMPONENTS: 0x8e85,
    MAX_TESS_EVALUATION_OUTPUT_COMPONENTS: 0x8e86,
    TESS_EVALUATION_SHADER: 0x8e87,
    TESS_CONTROL_SHADER: 0x8e88,
    MAX_TESS_CONTROL_UNIFORM_BLOCKS: 0x8e89,
    MAX_TESS_EVALUATION_UNIFORM_BLOCKS: 0x8e8a,
    MAX_TESS_CONTROL_INPUT_COMPONENTS: 0x886c,
    MAX_TESS_EVALUATION_INPUT_COMPONENTS: 0x886d,
    MAX_COMBINED_TESS_CONTROL_UNIFORM_COMPONENTS: 0x8e1e,
    MAX_COMBINED_TESS_EVALUATION_UNIFORM_COMPONENTS: 0x8e1f,
    UNIFORM_BLOCK_REFERENCED_BY_TESS_CONTROL_SHADER: 0x84f0,
    UNIFORM_BLOCK_REFERENCED_BY_TESS_EVALUATION_SHADER: 0x84f1,
});

/** What TESS_GEN_MODE, TESS_GEN_SPACING and TESS_GEN_VERTEX_ORDER answer, by the layout's word. */
export const TESS_GEN_ANSWERS = Object.freeze(/** @type {Record<string, number>} */ ({
    triangles: GL.TRIANGLES, quads: GL.QUADS, isolines: TESS.ISOLINES,
    equal_spacing: GL.EQUAL, fractional_odd_spacing: TESS.FRACTIONAL_ODD,
    fractional_even_spacing: TESS.FRACTIONAL_EVEN, ccw: GL.CCW, cw: GL.CW,
}));

/** The most level the tessellator takes (GL_MAX_TESS_GEN_LEVEL), Direct3D's 64 too. */
export const MAX_TESS_GEN_LEVEL = 64;

const BLOCK_COMPONENTS = BLOCK_LIMITS.perStage * BLOCK_LIMITS.size / 4;

/** The limits, at the 4.0 minimums the language's gl_Max* constants say too. */
const LIMITS = /** @type {[number, string, number][]} */ ([
    [TESS.MAX_PATCH_VERTICES, 'GL_MAX_PATCH_VERTICES', MAX_PATCH_VERTICES],
    [TESS.MAX_TESS_GEN_LEVEL, 'GL_MAX_TESS_GEN_LEVEL', MAX_TESS_GEN_LEVEL],
    [TESS.MAX_TESS_CONTROL_UNIFORM_COMPONENTS, 'GL_MAX_TESS_CONTROL_UNIFORM_COMPONENTS',
        GLSL_CONSTANTS.gl_MaxTessControlUniformComponents],
    [TESS.MAX_TESS_EVALUATION_UNIFORM_COMPONENTS, 'GL_MAX_TESS_EVALUATION_UNIFORM_COMPONENTS',
        GLSL_CONSTANTS.gl_MaxTessEvaluationUniformComponents],
    [TESS.MAX_TESS_CONTROL_TEXTURE_IMAGE_UNITS, 'GL_MAX_TESS_CONTROL_TEXTURE_IMAGE_UNITS',
        GLSL_CONSTANTS.gl_MaxTessControlTextureImageUnits],
    [TESS.MAX_TESS_EVALUATION_TEXTURE_IMAGE_UNITS, 'GL_MAX_TESS_EVALUATION_TEXTURE_IMAGE_UNITS',
        GLSL_CONSTANTS.gl_MaxTessEvaluationTextureImageUnits],
    [TESS.MAX_TESS_CONTROL_OUTPUT_COMPONENTS, 'GL_MAX_TESS_CONTROL_OUTPUT_COMPONENTS',
        GLSL_CONSTANTS.gl_MaxTessControlOutputComponents],
    [TESS.MAX_TESS_PATCH_COMPONENTS, 'GL_MAX_TESS_PATCH_COMPONENTS',
        GLSL_CONSTANTS.gl_MaxTessPatchComponents],
    [TESS.MAX_TESS_CONTROL_TOTAL_OUTPUT_COMPONENTS, 'GL_MAX_TESS_CONTROL_TOTAL_OUTPUT_COMPONENTS',
        GLSL_CONSTANTS.gl_MaxTessControlTotalOutputComponents],
    [TESS.MAX_TESS_EVALUATION_OUTPUT_COMPONENTS, 'GL_MAX_TESS_EVALUATION_OUTPUT_COMPONENTS',
        GLSL_CONSTANTS.gl_MaxTessEvaluationOutputComponents],
    [TESS.MAX_TESS_CONTROL_UNIFORM_BLOCKS, 'GL_MAX_TESS_CONTROL_UNIFORM_BLOCKS',
        BLOCK_LIMITS.perStage],
    [TESS.MAX_TESS_EVALUATION_UNIFORM_BLOCKS, 'GL_MAX_TESS_EVALUATION_UNIFORM_BLOCKS',
        BLOCK_LIMITS.perStage],
    [TESS.MAX_TESS_CONTROL_INPUT_COMPONENTS, 'GL_MAX_TESS_CONTROL_INPUT_COMPONENTS',
        GLSL_CONSTANTS.gl_MaxTessControlInputComponents],
    [TESS.MAX_TESS_EVALUATION_INPUT_COMPONENTS, 'GL_MAX_TESS_EVALUATION_INPUT_COMPONENTS',
        GLSL_CONSTANTS.gl_MaxTessEvaluationInputComponents],
    [TESS.MAX_COMBINED_TESS_CONTROL_UNIFORM_COMPONENTS,
        'GL_MAX_COMBINED_TESS_CONTROL_UNIFORM_COMPONENTS',
        GLSL_CONSTANTS.gl_MaxTessControlUniformComponents + BLOCK_COMPONENTS],
    [TESS.MAX_COMBINED_TESS_EVALUATION_UNIFORM_COMPONENTS,
        'GL_MAX_COMBINED_TESS_EVALUATION_UNIFORM_COMPONENTS',
        GLSL_CONSTANTS.gl_MaxTessEvaluationUniformComponents + BLOCK_COMPONENTS],
]);

/**
 * The state entries (`state.js`): the patch's control points and default
 * levels (4.0 table 6.39, in no attribute group), then the limits.
 */
export const TESSELLATION_STATE = Object.freeze([
    { query: TESS.PATCH_VERTICES, name: 'GL_PATCH_VERTICES', kind: /** @type {'int'} */ ('int'),
        value: [3] },
    { query: TESS.PATCH_DEFAULT_OUTER_LEVEL, name: 'GL_PATCH_DEFAULT_OUTER_LEVEL',
        kind: /** @type {'float'} */ ('float'), value: [1, 1, 1, 1] },
    { query: TESS.PATCH_DEFAULT_INNER_LEVEL, name: 'GL_PATCH_DEFAULT_INNER_LEVEL',
        kind: /** @type {'float'} */ ('float'), value: [1, 1] },
    ...LIMITS.map(([query, name, value])=>({ query, name, kind: /** @type {'int'} */ ('int'),
        value: [value] })),
]);

/** Every query of `TESSELLATION_STATE`: none is in an attribute group. */
export const TESSELLATION_QUERIES = Object.freeze(TESSELLATION_STATE.map(entry=>entry.query));

/**
 * @param {any} context
 * @param {{ enter: (name: string, args: unknown[]) => boolean,
 *     setError: (error: number) => void,
 *     setState: (query: number, values: number[]) => void }} kernel
 *     the context's (`kernel.js`), named by its parts: the state table imports
 *     this file, and the kernel the state table
 */
export function installTessellationCalls(context, kernel){
    const { enter, setError, setState } = kernel;

    Object.assign(context, {
        /** @param {number} pname @param {number} value */
        glPatchParameteri(pname, value){
            if (!enter('glPatchParameteri', [pname, value]))
            {
                return;
            }
            if (pname !== TESS.PATCH_VERTICES)
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            if ((value | 0) <= 0 || (value | 0) > MAX_PATCH_VERTICES)
            {
                setError(GL.INVALID_VALUE);
                return;
            }
            setState(TESS.PATCH_VERTICES, [value | 0]);
        },

        /** @param {number} pname @param {readonly number[]} values */
        glPatchParameterfv(pname, values){
            if (!enter('glPatchParameterfv', [pname, values]))
            {
                return;
            }
            const count = pname === TESS.PATCH_DEFAULT_OUTER_LEVEL ? 4
                : pname === TESS.PATCH_DEFAULT_INNER_LEVEL ? 2 : 0;
            if (count === 0)
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            setState(pname, Array.from({ length: count }, (_, k)=>Number(values[k] ?? 0)));
        },
    });
}

/**
 * What glGetProgramiv answers of a program's tessellation: a program
 * linked with the stage the name asks about answers it, any other is
 * INVALID_OPERATION (4.0 section 6.1.18); undefined for a name not of these.
 *
 * @param {number} pname
 * @param {import('./glsl-link.js').LinkedProgram | null} linked  the last successful link's
 * @returns {number[] | 'invalid' | undefined}
 */
export function tessellationProgramAnswer(pname, linked){
    switch (pname)
    {
        case TESS.TESS_CONTROL_OUTPUT_VERTICES:
            return linked?.tessControl && linked.tessLayout ? [linked.tessLayout.vertices]
                : 'invalid';
        case TESS.TESS_GEN_MODE:
        case TESS.TESS_GEN_SPACING:
        case TESS.TESS_GEN_VERTEX_ORDER:
        case TESS.TESS_GEN_POINT_MODE: {
            const layout = linked?.tessEvaluation ? linked.tessLayout : null;
            if (!layout)
            {
                return 'invalid';
            }
            return pname === TESS.TESS_GEN_POINT_MODE ? [layout.pointMode ? 1 : 0]
                : [TESS_GEN_ANSWERS[pname === TESS.TESS_GEN_MODE ? layout.mode
                    : pname === TESS.TESS_GEN_SPACING ? layout.spacing : layout.order]];
        }
        default:
            return undefined;
    }
}

/**
 * Whether the program in use draws a mode by its tessellation (section
 * 2.12.1): patches only through an evaluation shader, nothing else through one.
 *
 * @param {number} mode
 * @param {import('./glsl-link.js').LinkedProgram | null | undefined} linked
 */
export function tessellationTakes(mode, linked){
    return (mode === TESS.PATCHES) === !!linked?.tessEvaluation;
}
