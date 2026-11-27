/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Linking the tessellation stages (OpenGL 4.0 sections 2.12 and 7.4.1, the
 * 4.00 language's sections 4.3.4 to 4.3.8): the layouts every shader object
 * of a stage says alike, and what each stage reads of the one before it,
 * matched by name.
 *
 * - The control stage reads the vertex stage's outputs a control point at a
 *   time; each of its inputs is an array, matched by its element.
 * - The evaluation stage reads a control point's values the same way, from
 *   the control stage's per-vertex outputs where there is one and from the
 *   vertex stage's where there is none, and the patch's values (`patch in`)
 *   from the control stage's `patch out`.
 */

import { glslName } from './glsl-types.js';
import { OUTPUT, PARTITIONING } from '../d3d10/tessellator.js';

/**
 * @typedef {import('./glsl-types.js').GlslType} GlslType
 * @typedef {import('./glsl-check.js').ShaderUnit} ShaderUnit
 * @typedef {import('./glsl-check.js').VariableSymbol} VariableSymbol
 */

/**
 * What linking reads of a stage merged from its shader objects (`glsl-link.js`
 * LinkedStage's part).
 *
 * @typedef {Object} LinkedStage
 * @property {string} stage
 * @property {VariableSymbol[]} globals
 * @property {Set<string>} uses
 */

/**
 * What the evaluation stage's layout declarations say, merged over its
 * shader objects, and the control stage's output vertices.
 *
 * @typedef {Object} TessLayout
 * @property {'triangles' | 'quads' | 'isolines'} mode
 * @property {'equal_spacing' | 'fractional_even_spacing' | 'fractional_odd_spacing'} spacing
 *     equal_spacing where none is said
 * @property {'ccw' | 'cw'} order  ccw where none is said
 * @property {boolean} pointMode
 * @property {number} vertices  the control stage's output vertices; 0 without one
 *     (the patch's own vertices are passed on)
 */

/**
 * A value one tessellation stage reads of the stage before it.
 *
 * @typedef {Object} TessInput
 * @property {string} name
 * @property {GlslType} type  a control point's, for a per-vertex value
 * @property {string} fromPath  what the stage before writes it through: `g_x`
 *     from the vertex stage, `g_x[]` or `g_b[].m_x` from the control stage
 *     (`[]` standing for the control point), `g_x` for a patch value
 * @property {string} path  what this stage reads it into, `[]` the control point
 */

/**
 * @typedef {Object} TessLinked
 * @property {TessLayout | null} tessLayout
 * @property {TessInput[]} controlInputs  what the control stage reads of the vertex stage's
 * @property {TessInput[]} evaluationInputs  what the evaluation stage reads a control
 *     point of: the control stage's per-vertex outputs, or the vertex stage's
 * @property {TessInput[]} patchInputs  what it reads of the control stage's patch outputs
 */

const MODES = new Set(['triangles', 'quads', 'isolines']);
const SPACINGS = new Set(['equal_spacing', 'fractional_even_spacing', 'fractional_odd_spacing']);
const ORDERS = new Set(['ccw', 'cw']);

/** The most control points a patch has (GL_MAX_PATCH_VERTICES, at least 32 in 4.0). */
export const MAX_PATCH_VERTICES = 32;

/**
 * A layout as the tessellator Direct3D 11 specifies takes it
 * (`../d3d10/tessellator.js`): its domain (0 isolines, 1 triangles, 2
 * quads), partitioning and output primitive.
 *
 * The levels need no remapping: GL's gl_TessLevelOuter and Inner (4.0
 * section 2.12.2) name the edges u = 0, v = 0, w = 0 (u = 1 and v = 1 for a
 * quad) and the isolines' count and segments in the order Direct3D's
 * factors do, and a domain point is (u, v). The orders are named from
 * opposite sides: GL's counter-clockwise is the order whose triangles turn
 * positively in (u, v), which Direct3D's tessellator makes for its
 * TRIANGLE_CW (`glsl-link-tess.test.js` pins it).
 *
 * @param {TessLayout} layout
 * @returns {{ domain: number, partitioning: number, output: number }}
 */
export function tessellatorKind(layout){
    const domain = layout.mode === 'isolines' ? 0 : layout.mode === 'triangles' ? 1 : 2;
    const partitioning = layout.spacing === 'fractional_odd_spacing' ? PARTITIONING.FRACTIONAL_ODD
        : layout.spacing === 'fractional_even_spacing' ? PARTITIONING.FRACTIONAL_EVEN
            : PARTITIONING.INTEGER;
    const output = layout.pointMode ? OUTPUT.POINT : layout.mode === 'isolines' ? OUTPUT.LINE
        : layout.order === 'ccw' ? OUTPUT.TRIANGLE_CW : OUTPUT.TRIANGLE_CCW;
    return { domain, partitioning, output };
}

/**
 * @param {{ vertex: LinkedStage | null, control: LinkedStage | null,
 *     evaluation: LinkedStage | null, controlUnits: ShaderUnit[],
 *     evaluationUnits: ShaderUnit[] }} given
 * @param {(message: string) => void} error
 * @returns {TessLinked}
 */
export function linkTessellation(given, error){
    const { vertex, control, evaluation } = given;
    /** @type {TessLinked} */
    const linked = { tessLayout: null, controlInputs: [], evaluationInputs: [], patchInputs: [] };
    if (!control && !evaluation)
    {
        return linked;
    }
    if (!evaluation)
    {
        // OpenGL 4.0 section 2.12: a control shader with no evaluation shader
        // does not link (4.0; later versions let it, and draw nothing).
        error('a tessellation control shader is attached with no tessellation evaluation'
            + ' shader');
        return linked;
    }
    if (!vertex)
    {
        error('a tessellation shader is attached with no vertex shader');
        return linked;
    }
    const vertices = control ? controlVertices(given.controlUnits, error) : 0;
    const layout = evaluationLayout(given.evaluationUnits, error);
    if (!layout || vertices === null)
    {
        return linked;
    }
    linked.tessLayout = { ...layout, vertices };

    const vertexOutputs = new Map(stageInterface(vertex, 'out', false)
        .map(entry=>[entry.name, entry]));
    if (control)
    {
        for (const input of stageInterface(control, 'in', true))
        {
            if (!input.used)
            {
                continue;
            }
            const from = vertexOutputs.get(input.name);
            if (!from || from.patch)
            {
                error(`tessellation control shader input '${input.name}' is not declared in the`
                    + ' vertex shader');
                continue;
            }
            if (glslName(from.type) !== glslName(input.type))
            {
                error(`input '${input.name}' has type ${glslName(from.type)} in the vertex`
                    + ` shader and ${glslName(input.type)}[] in the tessellation control shader`);
                continue;
            }
            linked.controlInputs.push({ name: input.name, type: input.type, fromPath: from.path,
                path: input.path });
        }
    }
    const before = control
        ? new Map(stageInterface(control, 'out', true).map(entry=>[entry.name, entry]))
        : vertexOutputs;
    const word = control ? 'tessellation control' : 'vertex';
    for (const input of stageInterface(evaluation, 'in', true))
    {
        if (!input.used)
        {
            continue;
        }
        const from = before.get(input.name);
        if (!from || from.patch !== input.patch)
        {
            error(`tessellation evaluation shader ${input.patch ? 'patch ' : ''}input`
                + ` '${input.name}' is not declared ${input.patch ? 'patch out ' : ''}in the`
                + ` ${word} shader`);
            continue;
        }
        if (glslName(from.type) !== glslName(input.type))
        {
            error(`input '${input.name}' has type ${glslName(from.type)} in the ${word} shader`
                + ` and ${glslName(input.type)} in the tessellation evaluation shader`);
            continue;
        }
        (input.patch ? linked.patchInputs : linked.evaluationInputs).push({ name: input.name,
            type: input.type, fromPath: from.path, path: input.path });
    }
    return linked;
}

/**
 * The control stage's output vertices, said by at least one of its shader
 * objects and the same by each that says it (4.00 language section 4.3.8.2).
 *
 * @param {ShaderUnit[]} units @param {(message: string) => void} error
 * @returns {number | null}
 */
function controlVertices(units, error){
    /** @type {number | null} */
    let vertices = null;
    for (const unit of units)
    {
        const said = /** @type {Record<string, any>} */ (unit.layouts.output).vertices;
        if (typeof said !== 'number')
        {
            continue;
        }
        if (vertices !== null && vertices !== said)
        {
            error('tessellation control shader: two shaders declare different output vertices');
        }
        vertices = said;
    }
    if (vertices === null)
    {
        error('tessellation control shader: no output vertices are declared');
        return null;
    }
    if (vertices < 1 || vertices > MAX_PATCH_VERTICES)
    {
        error(`tessellation control shader: ${vertices} output vertices, past the`
            + ` ${MAX_PATCH_VERTICES} a patch may have`);
        return null;
    }
    return vertices;
}

/**
 * The evaluation stage's primitive mode, spacing, order and point mode
 * (4.00 language section 4.3.8.1): a mode is said by at least one shader
 * object, and each of the four the same by every one that says it.
 *
 * @param {ShaderUnit[]} units @param {(message: string) => void} error
 * @returns {Omit<TessLayout, 'vertices'> | null}
 */
function evaluationLayout(units, error){
    /**
     * @param {Set<string>} names @param {string} what
     * @returns {string | null}
     */
    const said = (names, what)=>{
        /** @type {string | null} */
        let value = null;
        for (const unit of units)
        {
            for (const name of Object.keys(unit.layouts.input))
            {
                if (!names.has(name))
                {
                    continue;
                }
                if (value !== null && value !== name)
                {
                    error(`tessellation evaluation shader: two shaders declare different ${what}`);
                }
                value = name;
            }
        }
        return value;
    };
    const mode = said(MODES, 'primitive modes');
    const spacing = said(SPACINGS, 'spacings') ?? 'equal_spacing';
    const order = said(ORDERS, 'vertex orders') ?? 'ccw';
    const pointMode = units.some(unit=>'point_mode' in unit.layouts.input);
    if (mode === null)
    {
        error('tessellation evaluation shader: no primitive mode is declared');
        return null;
    }
    return {
        mode: /** @type {TessLayout['mode']} */ (mode),
        spacing: /** @type {TessLayout['spacing']} */ (spacing),
        order: /** @type {TessLayout['order']} */ (order),
        pointMode,
    };
}

/**
 * A stage's values between stages by the name the other stage matches: a
 * variable's own, a block member's `Block.member`. A per-vertex value of a
 * tessellation stage is an array a control point, matched by its element
 * (its path's `[]` the control point); a patch value is matched whole.
 *
 * @param {LinkedStage} stage @param {'in' | 'out'} direction
 * @param {boolean} arrayed  the stage's per-vertex values are arrays a control point
 * @returns {{ name: string, type: GlslType, path: string, used: boolean,
 *     patch: boolean }[]}
 */
function stageInterface(stage, direction, arrayed){
    /** @type {ReturnType<typeof stageInterface>} */
    const entries = [];
    for (const symbol of stage.globals)
    {
        if (symbol.storage !== direction && symbol.storage !== 'varying')
        {
            continue;
        }
        const used = stage.uses.has(symbol.name);
        const patch = !!symbol.qualifiers?.patch;
        const block = symbol.block;
        const vertexed = arrayed && !patch && symbol.type.kind === 'array';
        const each = vertexed ? '[]' : '';
        const type = vertexed ? /** @type {any} */ (symbol.type).element : symbol.type;
        if (block && block.instance === symbol.name)
        {
            const members = type.kind === 'struct' ? type.fields : block.members;
            for (const member of members)
            {
                entries.push({ name: `${block.name}.${member.name}`, type: member.type,
                    path: `g_${symbol.name}${each}.m_${member.name}`, used, patch });
            }
            continue;
        }
        entries.push({ name: block ? `${block.name}.${symbol.name}` : symbol.name, type,
            path: `g_${symbol.name}${each}`, used, patch });
    }
    return entries;
}
