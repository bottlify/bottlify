/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, Version 2.0
 * See LICENSE for details
 */

/**
 * The ARB program IR as WGSL: one stage at a time.
 *
 * The translation is literal, the way the Direct3D 9 translator is: every
 * temporary becomes a WGSL `var` of four floats, every instruction a `let`
 * for its sources, a `let` for its value and a write through the destination
 * mask. Nothing is optimised, so a generated stage can be read line by line
 * against the program text it came from.
 *
 * The contract with whoever assembles a pipeline from these stages:
 *
 * - **The fixed-function uniform block is in scope as `uniforms`.** A stage
 *   reads current attribute values, the modelview-projection (position
 *   invariance) and the fog parameters and colour from it, so the block the
 *   fixed path fills is bound in a program draw whether or not a fixed stage
 *   runs.
 * - **Program parameters live in one materialised array per stage**, at
 *   `vertexProgram` and `fragmentProgram`, bound past the last texture
 *   unit's pair. Every `PARAM` slot -- a program parameter, a constant, a
 *   state matrix row -- is
 *   one entry of it, listed in `needs.params` in block order, and the draw
 *   path fills exactly that list; relative addressing is then an index into
 *   one contiguous run, clamped to its declaration as the specification
 *   clamps it. State matrices are computed on the processor at draw time and
 *   arrive as the rows the slots name.
 * - **Vertex inputs arrive as `vertex.<name>` in the locations the caller
 *   lists**, with the canonical attribute names of the fixed layout plus
 *   `attribN` for the generic ones. An attribute the program reads and the
 *   caller does not list falls back to the current value: the fixed block's
 *   for a conventional binding, the stage's own `attribs` uniform for a
 *   generic one.
 * - **The varyings between the stages are the fixed path's set**: `color`,
 *   `secondary`, `fog`, then `tcN` per coordinate set in the order the caller
 *   names them, and `fogCoord` (the raw coordinate) when either stage needs
 *   it. A program vertex stage writes `result.color` into the fixed
 *   fragment's colour input and `result.texcoord[n]` into `tcN`; a program
 *   fragment stage reads them back the same way. Both stages must be told the
 *   same set, and a fragment stage's `VertexOut` is the one the assembler
 *   declares -- the vertex emitter's when the pair is two programs, the fixed
 *   generator's widened when one stage is fixed.
 * - **Textures keep the fixed path's binding slots**: unit n samples at
 *   bindings 1 + 2n and 2 + 2n, under the names `tNTexture` / `tNSampler`.
 *
 * A binding the GPU path cannot answer -- a non-matrix state parameter, a 3D
 * texture target, a coordinate set past the varyings -- refuses the stage
 * with the binding's own text as the reason, which the draw path reports as
 * a divergence rather than drawing something wrong.
 */

/** @typedef {import('./arb-program.js').ParsedProgram} ParsedProgram */
/** @typedef {import('./arb-program.js').Operand} Operand */
/** @typedef {import('./arb-program.js').Instruction} Instruction */
/** @typedef {import('./arb-program.js').Binding} Binding */
/** @typedef {import('./arb-program.js').ParamBinding} ParamBinding */
/** @typedef {import('./arb-program.js').ConstantBinding} ConstantBinding */
/** @typedef {import('./arb-program.js').FragmentBinding} FragmentBinding */

import { canonicalAttribName } from './arb-program.js';

export { canonicalAttribName };

/**
 * Where the two program uniform blocks sit, as the device answers them: a
 * pipeline stage that reads only some of a group's dynamic uniform bindings is
 * handed zero for its own, and the vertex stage reads no dynamic uniform block
 * outside group 0 at all. So the vertex block shares group 0 with the fixed
 * block, whose binding the vertex stage also reads, and the fragment block
 * gets a group of its own, which the fragment stage reads alone.
 */
export const VERTEX_PROGRAM_BINDING = 17;
export const FRAGMENT_PROGRAM_BINDING = 18;
export const VERTEX_PROGRAM_GROUP = 0;
export const FRAGMENT_PROGRAM_GROUP = 1;

/**
 * The texture coordinate sets a stage can pass through the varyings: the
 * specification's minimum for MAX_TEXTURE_COORDS_ARB, which is also the
 * number of texture units the context holds.
 */
export const VARYING_TEXCOORDS = 8;

/**
 * @typedef {Object} ParamSlot
 *     One vec4 of a stage's materialised parameter array.
 * @property {'local' | 'env' | 'constant' | 'matrix' | 'unsupported'} source
 * @property {number} [index]      the parameter number, for local and env
 * @property {readonly number[]} [values]  four floats, for a constant
 * @property {'modelview' | 'projection' | 'mvp' | 'texture'} [matrix]
 * @property {number} [number]     the modelview stack or texture unit
 * @property {'' | 'inverse' | 'transpose' | 'invtrans'} [modifier]
 * @property {number} [row]
 * @property {string} [text]       the binding as written, for unsupported
 */

/**
 * @typedef {Object} MatrixNeed
 * @property {'modelview' | 'projection' | 'mvp' | 'texture'} matrix
 * @property {number} number
 * @property {'' | 'inverse' | 'transpose' | 'invtrans'} modifier
 */

/**
 * @typedef {Object} StageNeeds
 *     What the draw path has to provide for an emitted stage.
 * @property {'vertex' | 'fragment'} kind
 * @property {readonly ParamSlot[]} params  the uniform block's contents
 * @property {readonly MatrixNeed[]} matrices  the state matrices to compute
 * @property {readonly string[]} unsupported  the bindings that refuse the stage
 * @property {readonly number[]} genericFallbacks  the generic attribute numbers
 *           whose current value the vertex block must carry, in `attribs order`
 * @property {readonly number[]} namedAttribs  the canonical attributes the
 *           vertex stage reads, as generic attribute numbers
 * @property {readonly { unit: number, target: '1D' | '2D' | '3D' | 'CUBE' | 'RECT' }[]} textures
 * @property {boolean} writesDepth      the fragment writes result.depth
 * @property {boolean} writesFogCoord   the vertex writes result.fogcoord
 * @property {boolean} readsFogCoord    the fragment reads fragment.fogcoord
 * @property {boolean} writesPointSize  the vertex writes result.pointsize
 * @property {boolean} writesBackColour  the vertex writes a back colour result
 * @property {boolean} discards         the fragment can discard
 * @property {boolean} fogged           a fog option applies to result.color
 */

/**
 * @typedef {Object} StageInput
 *     One vertex attribute the pipeline binds, in location order.
 * @property {string} name  a canonical attribute name or `attribN`
 * @property {number} components
 * @property {'f32' | 'i32' | 'u32'} scalar
 */

/**
 * @typedef {Object} StageVaryings
 *     The varying set the assembler lays between the two stages.
 * @property {readonly number[]} texcoords  the coordinate sets with a varying
 * @property {boolean} fogCoord  the raw fog coordinate travels
 */

/**
 * @typedef {Object} EmittedStage
 * @property {string} code
 * @property {StageNeeds} needs
 */

/**
 * @typedef {{ error: string } | EmittedStage} EmitResult
 */

/**
 * The analysis both emitters run first: the parameter slots in block order
 * and the way every parameter reference resolves to one.
 *
 * @param {ParsedProgram} ir
 */
function analyse(ir){
    /** @type {ParamSlot[]} */
    const params = [];
    /** @type {Map<string, number>} slot key -> block index, inline slots only */
    const slotIndex = new Map();
    /** @type {MatrixNeed[]} */
    const matrices = [];
    /** @type {string[]} */
    const unsupported = [];

    /** @param {ParamSlot} slot */
    const note = slot=>{
        if (slot.source === 'matrix')
        {
            const need = {
                matrix: /** @type {MatrixNeed['matrix']} */ (slot.matrix),
                number: /** @type {number} */ (slot.number),
                modifier: /** @type {MatrixNeed['modifier']} */ (slot.modifier),
            };
            if (!matrices.some(m=>m.matrix === need.matrix && m.number === need.number
                && m.modifier === need.modifier))
            {
                matrices.push(need);
            }
        }
        if (slot.source === 'unsupported')
        {
            const text = /** @type {string} */ (slot.text);
            if (!unsupported.includes(text))
            {
                unsupported.push(text);
            }
        }
    };

    /**
     * @param {Binding} binding
     * @returns {ParamSlot}
     */
    const bindingSlot = binding=>{
        if (binding.kind === 'local' || binding.kind === 'env')
        {
            return { source: binding.kind, index: binding.index };
        }
        if (binding.kind === 'constant')
        {
            return { source: 'constant', values: binding.values };
        }
        if (binding.kind === 'state')
        {
            return binding.state === 'matrix'
                ? {
                    source: 'matrix', matrix: binding.matrix, number: binding.number,
                    modifier: binding.modifier, row: binding.row,
                }
                : { source: 'unsupported', text: binding.text };
        }
        return { source: 'unsupported', text: 'a non-parameter binding' };
    };

    // The declared parameter arrays occupy one contiguous run each, so a
    // relative address indexes a single range of the block.
    /** @type {Map<string, { offset: number, size: number }>} */
    const declared = new Map();
    for (const decl of ir.params)
    {
        const offset = params.length;
        for (const binding of decl.slots)
        {
            const slot = bindingSlot(binding);
            note(slot);
            params.push(slot);
        }
        declared.set(decl.name, { offset, size: decl.slots.length });
    }
    for (const alias of ir.aliases)
    {
        const target = declared.get(alias.target);
        if (target)
        {
            declared.set(alias.name, target);
        }
    }

    /**
     * The block index of an inline parameter reference, appended after the
     * declared arrays when it is new.
     *
     * @param {ParamBinding} binding
     * @returns {number}
     */
    const inlineSlot = binding=>{
        const slot = bindingSlot(binding);
        const key = JSON.stringify(slot);
        const existing = slotIndex.get(key);
        if (existing !== undefined)
        {
            return existing;
        }
        note(slot);
        const index = params.push(slot) - 1;
        slotIndex.set(key, index);
        return index;
    };

    /**
     * The block index an operand reads, or null when it is a constant literal.
     *
     * @param {Operand} operand
     * @param {(name: string) => string} resolve  alias to canonical name
     * @returns {number | null}
     */
    const paramSlotOf = (operand, resolve)=>{
        if (operand.name)
        {
            const decl = declared.get(resolve(operand.name));
            if (!decl)
            {
                return null;
            }
            return decl.offset + (operand.index ?? 0);
        }
        const binding = operand.binding;
        if (!binding || binding.kind === 'constant')
        {
            return null;
        }
        if (binding.kind === 'local' || binding.kind === 'env' || binding.kind === 'state')
        {
            return inlineSlot(binding);
        }
        return null;
    };

    return { params, declared, matrices, unsupported, paramSlotOf };
}

/**
 * What a stage needs, without emitting it: the same analysis the emitter
 * runs, for a draw path that builds its key and its uniform fills first.
 *
 * @param {ParsedProgram} ir
 * @returns {{ needs: StageNeeds } | { error: string }}
 */
export function needsOf(ir){
    const resolve = aliasResolver(ir);
    const analysed = analyse(ir);
    const needs = collectNeeds(ir, analysed, resolve);
    if (needs.unsupported.length > 0)
    {
        return { error: refuseReason(needs.unsupported) };
    }
    return { needs };
}

/**
 * @param {readonly string[]} unsupported
 * @returns {string}
 */
function refuseReason(unsupported){
    return `the program binds ${unsupported.join(', ')}, which has no value on the GPU path`;
}

/**
 * Alias names resolve to the declaration they stand for; the parser refuses
 * a cycle, so the walk terminates.
 *
 * @param {ParsedProgram} ir
 * @returns {(name: string) => string}
 */
function aliasResolver(ir){
    /** @type {Map<string, string>} */
    const of = new Map(ir.aliases.map(alias=>[alias.name, alias.target]));
    return name=>{
        let resolved = name;
        while (of.has(resolved))
        {
            resolved = /** @type {string} */ (of.get(resolved));
        }
        return resolved;
    };
}

/**
 * @param {ParsedProgram} ir
 * @param {ReturnType<typeof analyse>} analysed
 * @param {(name: string) => string} resolve
 * @returns {StageNeeds}
 */
function collectNeeds(ir, analysed, resolve){
    // Touch every parameter reference so the slots and refusals are complete.
    for (const instruction of ir.instructions)
    {
        for (const operand of instruction.src)
        {
            if (operand.kind === 'param')
            {
                analysed.paramSlotOf(operand, resolve);
            }
        }
    }
    /** @type {number[]} */
    const namedAttribs = [];
    /** @type {number[]} */
    const genericFallbacks = [];
    /** @type {{ unit: number, target: '1D' | '2D' | '3D' | 'CUBE' | 'RECT' }[]} */
    const textures = [];
    let writesDepth = false;
    let writesFogCoord = false;
    let readsFogCoord = false;
    let writesPointSize = false;
    let writesBackColour = false;
    let discards = false;

    /** @param {number} attrib */
    const noteAttrib = attrib=>{
        const canonical = canonicalAttribName(attrib);
        if (canonical.startsWith('attrib'))
        {
            if (!genericFallbacks.includes(attrib))
            {
                genericFallbacks.push(attrib);
            }
        }
        else if (!namedAttribs.includes(attrib))
        {
            namedAttribs.push(attrib);
        }
    };

    /** @param {Binding | null | undefined} binding */
    const noteBinding = binding=>{
        if (!binding)
        {
            return;
        }
        if (binding.kind === 'vertex' && binding.attrib !== null)
        {
            noteAttrib(binding.attrib);
        }
        if (binding.kind === 'fragment' && binding.name === 'fogcoord')
        {
            readsFogCoord = true;
        }
        if (binding.kind === 'result')
        {
            writesDepth = writesDepth || binding.name === 'depth';
            writesFogCoord = writesFogCoord || binding.name === 'fogcoord';
            writesPointSize = writesPointSize || binding.name === 'pointsize';
            writesBackColour = writesBackColour
                || (binding.name === 'color' && binding.face === 'back');
        }
    };

    /** @param {Operand} operand */
    const noteOperand = operand=>{
        noteBinding(operand.binding);
        if ((operand.kind === 'attrib' || operand.kind === 'output') && operand.name)
        {
            const name = resolve(operand.name);
            noteBinding(ir.attribs.find(a=>a.name === name)?.binding
                ?? ir.outputs.find(o=>o.name === name)?.binding ?? null);
        }
    };

    for (const attrib of ir.attribs)
    {
        noteBinding(attrib.binding);
    }
    for (const output of ir.outputs)
    {
        noteBinding(output.binding);
    }
    for (const instruction of ir.instructions)
    {
        if (instruction.op === 'KIL')
        {
            discards = true;
        }
        if (instruction.texture && !textures.some(t=>t.unit === instruction.texture?.unit))
        {
            textures.push(instruction.texture);
        }
        if (instruction.dst)
        {
            noteOperand(instruction.dst);
        }
        for (const operand of instruction.src)
        {
            noteOperand(operand);
        }
    }
    if (ir.fog !== null)
    {
        readsFogCoord = true;
    }
    return {
        kind: ir.kind,
        params: analysed.params,
        matrices: analysed.matrices,
        unsupported: analysed.unsupported,
        genericFallbacks,
        namedAttribs,
        textures,
        writesDepth,
        writesFogCoord,
        readsFogCoord,
        writesPointSize,
        writesBackColour,
        discards,
        fogged: ir.fog !== null,
    };
}

/** The four floats a constant literal writes. @param {readonly number[]} values */
const constantLiteral = values=>`vec4f(${values.map(floatLiteral).join(', ')})`;

/** @param {number} value */
function floatLiteral(value){
    const text = Object.is(value, -0) ? '0' : String(value);
    return /^-?[0-9]+$/.test(text) ? `${text}.0` : text;
}

/**
 * @typedef {Object} StageContext
 * @property {ParsedProgram} ir
 * @property {ReturnType<typeof analyse>} analysed
 * @property {(name: string) => string} resolve
 * @property {string} block  the uniform block's WGSL name
 * @property {Map<string, string>} temps  declared name -> the WGSL variable
 * @property {Map<number, number>} genericFallbacks  attrib number -> uniform index
 * @property {StageInput[]} inputs
 * @property {StageVaryings} varyings
 * @property {number} viewportHeight  the render target's rows, for fragment.position
 * @property {() => number} next
 * @property {(operand: Operand) => string} source
 */

/**
 * The expression a source operand reads, before its swizzle.
 *
 * @param {StageContext} ctx
 * @param {Operand} operand
 * @returns {string}
 */
function sourceBase(ctx, operand){
    switch (operand.kind)
    {
        case 'temp':
            return /** @type {string} */ (
                ctx.temps.get(ctx.resolve(/** @type {string} */ (operand.name))));
        case 'constant':
            return constantLiteral(/** @type {ConstantBinding} */ (operand.binding).values);
        case 'param':
        {
            const slot = ctx.analysed.paramSlotOf(operand, ctx.resolve);
            if (slot === null)
            {
                return operand.binding?.kind === 'constant'
                    ? constantLiteral(operand.binding.values)
                    : 'vec4f(0.0)';
            }
            if (operand.relative !== null)
            {
                const decl = ctx.analysed.declared.get(
                    ctx.resolve(/** @type {string} */ (operand.name)));
                const offset = decl?.offset ?? 0;
                const size = decl?.size ?? 1;
                const index = operand.relative === 0
                    ? `i32(a0.x) + ${offset}`
                    : `i32(a0.x) + ${offset + operand.relative}`;
                return `${ctx.block}.params[clamp(${index}, ${offset}, ${offset + size - 1})]`;
            }
            return `${ctx.block}.params[${slot}]`;
        }
        case 'attrib':
            return ctx.ir.kind === 'vertex'
                ? vertexAttribExpression(ctx, operand)
                : fragmentAttribExpression(ctx, operand);
        default:
            return 'vec4f(0.0)';
    }
}

/**
 * @param {StageContext} ctx
 * @param {Operand} operand
 * @returns {string}
 */
function vertexAttribExpression(ctx, operand){
    const declared = operand.name
        ? ctx.ir.attribs.find(a=>a.name === ctx.resolve(/** @type {string} */ (operand.name)))
        : null;
    const binding = operand.binding ?? declared?.binding ?? null;
    if (!binding || binding.kind !== 'vertex' || binding.attrib === null)
    {
        return 'vec4f(0.0)';
    }
    const name = canonicalAttribName(binding.attrib);
    const input = ctx.inputs.find(entry=>entry.name === name);
    if (input)
    {
        return widen(`vertex.${name}`, input);
    }
    if (name.startsWith('attrib'))
    {
        const index = ctx.genericFallbacks.get(binding.attrib);
        return index === undefined ? 'vec4f(0.0)' : `${ctx.block}.attribs[${index}]`;
    }
    return canonicalFallback(name);
}

/**
 * @param {StageContext} ctx
 * @param {Operand} operand
 * @returns {string}
 */
function fragmentAttribExpression(ctx, operand){
    const declared = operand.name
        ? ctx.ir.attribs.find(a=>a.name === ctx.resolve(/** @type {string} */ (operand.name)))
        : null;
    const binding = operand.binding ?? declared?.binding ?? null;
    if (!binding || binding.kind !== 'fragment')
    {
        return 'vec4f(0.0)';
    }
    return fragmentInputExpression(ctx, binding);
}

/** @param {StageContext} ctx @param {FragmentBinding} binding */
function fragmentInputExpression(ctx, binding){
    switch (binding.name)
    {
        case 'position':
            // GL's fragment.position is measured from the lower-left corner of
            // the window; WGSL's @builtin(position) from the upper-left. The
            // correction needs the target's height, which is baked here and so
            // folded into the pipeline key.
            return `vec4f(input.position.x, ${ctx.viewportHeight}.0 - input.position.y,`
                + ' input.position.z, input.position.w)';
        case 'color-primary':
            return 'input.color';
        case 'color-secondary':
            return 'input.secondary';
        case 'fogcoord':
            return 'vec4f(input.fogCoord)';
        default:
            return binding.index < VARYING_TEXCOORDS
                ? `input.tc${binding.index}`
                : 'vec4f(0.0)';
    }
}

/**
 * The current value a conventional attribute reads when no array feeds it.
 *
 * @param {string} name
 */
function canonicalFallback(name){
    if (/^texCoord[0-7]$/.test(name))
    {
        return `uniforms.texCoord[${Number(name.slice('texCoord'.length))}]`;
    }
    switch (name)
    {
        case 'color':
            return 'uniforms.color';
        case 'secondary':
            return 'uniforms.secondary';
        case 'normal':
            return 'uniforms.normal';
        case 'fogCoord':
            return 'vec4f(uniforms.fogParams.w)';
        default:
            return 'vec4f(0.0, 0.0, 0.0, 1.0)';
    }
}

/**
 * An input widened to a vec4f, its integer kinds converted.
 *
 * @param {string} reference
 * @param {StageInput} input
 */
function widen(reference, input){
    const scalar = input.scalar;
    const value = scalar === 'f32'
        ? reference
        : `${input.components === 1 ? 'f32' : `vec${input.components}f`}(${reference})`;
    if (input.components === 4)
    {
        return value;
    }
    const fill = [0, 0, 0, 1].slice(input.components).map(v=>`${v}.0`);
    return `vec4f(${value}, ${fill.join(', ')})`;
}

/**
 * The expression of a whole source operand: its base through its normalised
 * components.
 *
 * @param {StageContext} ctx
 * @param {Operand} operand
 * @returns {string}
 */
function sourceExpression(ctx, operand){
    const base = sourceBase(ctx, operand);
    const components = operand.components ?? ['x', 'y', 'z', 'w'];
    if (components.join('') === 'xyzw')
    {
        return base;
    }
    if (components.every(c=>c === components[0]) && /^[xyzw]$/.test(components[0]))
    {
        return `vec4f(${base}.${components[0]})`;
    }
    const parts = components.map(c=>{
        if (c === '0' || c === '-0')
        {
            return '0.0';
        }
        if (c === '1')
        {
            return '1.0';
        }
        if (c === '-1')
        {
            return '-1.0';
        }
        return c.startsWith('-') ? `-${base}.${c.slice(1)}` : `${base}.${c}`;
    });
    return `vec4f(${parts.join(', ')})`;
}

/**
 * What a destination operand writes: the WGSL target text, and whether it is
 * the clip position, whose depth the write remaps. Null for a result this
 * pipeline has no storage for, which the write then drops.
 *
 * @param {StageContext} ctx
 * @param {Operand} operand
 * @returns {{ text: string, position: boolean } | null}
 */
function destinationOf(ctx, operand){
    if (operand.kind === 'address')
    {
        return { text: 'a0', position: false };
    }
    if (operand.kind === 'temp')
    {
        const variable = ctx.temps.get(ctx.resolve(/** @type {string} */ (operand.name)));
        return variable === undefined ? null : { text: variable, position: false };
    }
    const declared = operand.kind === 'output' && operand.name
        ? ctx.ir.outputs.find(o=>o.name === ctx.resolve(/** @type {string} */ (operand.name)))
        : null;
    const binding = operand.binding ?? declared?.binding ?? null;
    if (!binding || binding.kind !== 'result')
    {
        return null;
    }
    if (ctx.ir.kind === 'fragment')
    {
        if (binding.name === 'color')
        {
            return { text: 'resultColor', position: false };
        }
        return binding.name === 'depth' ? { text: 'resultDepth', position: false } : null;
    }
    switch (binding.name)
    {
        case 'position':
            return { text: 'out.position', position: true };
        case 'color':
            return binding.colour === 'secondary'
                ? { text: 'out.secondary', position: false }
                : { text: 'out.color', position: false };
        case 'fogcoord':
            return { text: 'out.fogCoord', position: false };
        case 'texcoord':
            return binding.index < VARYING_TEXCOORDS
                    && ctx.varyings.texcoords.includes(binding.index)
                ? { text: `out.tc${binding.index}`, position: false }
                : null;
        default:
            return null;
    }
}

/**
 * The write of an instruction's value through its destination mask. The clip
 * position's depth is not remapped here: z and w may be written by different
 * instructions, so `emitVertex` remaps once after the whole program.
 *
 * @param {Operand} dst
 * @param {{ text: string, position: boolean }} destination
 * @param {string} value  a vec4f expression, already saturated
 * @param {string[]} lines
 */
function writeDestination(dst, destination, value, lines){
    if (dst.mask === 'xyzw')
    {
        lines.push(`    ${destination.text} = ${value};`);
        return;
    }
    for (const c of /** @type {string} */ (dst.mask))
    {
        lines.push(`    ${destination.text}.${c} = ${value}.${c};`);
    }
}

/**
 * The value expression of one instruction from its bound source names, with
 * any `let` lines it needs.
 *
 * @param {Instruction} instruction
 * @param {string[]} src  one expression per source
 * @param {number} id  the instruction's counter, for let names
 * @param {string[]} lines  extra `let` lines the value needs
 * @returns {string}
 */
function valueOf(instruction, src, id, lines){
    const [a, b, c] = src;
    switch (instruction.op)
    {
        case 'ABS':
            return `abs(${a})`;
        case 'ADD':
            return `${a} + ${b}`;
        case 'SUB':
            return `${a} - ${b}`;
        case 'MUL':
            return `${a} * ${b}`;
        case 'MAD':
            return `${a} * ${b} + ${c}`;
        case 'MIN':
            return `min(${a}, ${b})`;
        case 'MAX':
            return `max(${a}, ${b})`;
        case 'MOV':
            return a;
        case 'FLR':
            return `floor(${a})`;
        case 'FRC':
            return `fract(${a})`;
        case 'DP3':
            return `vec4f(dot(${a}.xyz, ${b}.xyz))`;
        case 'DP4':
            return `vec4f(dot(${a}, ${b}))`;
        case 'DPH':
            return `vec4f(dot(vec4f(${a}.xyz, 1.0), ${b}))`;
        case 'DST':
            return `vec4f(1.0, ${a}.x * ${b}.x, ${a}.y, ${b}.y)`;
        case 'SLT':
            return `select(vec4f(0.0), vec4f(1.0), ${a} < ${b})`;
        case 'SGE':
            return `select(vec4f(0.0), vec4f(1.0), ${a} >= ${b})`;
        case 'XPD':
            return `vec4f(cross(${a}.xyz, ${b}.xyz), 1.0)`;
        case 'RCP':
            return `vec4f(1.0 / ${a}.x)`;
        case 'RSQ':
            return `vec4f(1.0 / sqrt(${a}.x))`;
        case 'EX2':
            return `vec4f(exp2(${a}.x))`;
        case 'LG2':
            return `vec4f(log2(${a}.x))`;
        case 'POW':
            return `vec4f(pow(${a}.x, ${b}.x))`;
        case 'SIN':
            return `vec4f(sin(${a}.x))`;
        case 'COS':
            return `vec4f(cos(${a}.x))`;
        case 'SCS':
            return `vec4f(cos(${a}.x), sin(${a}.x), 0.0, 0.0)`;
        case 'LRP':
            return `${a} * ${b} + (vec4f(1.0) - ${a}) * ${c}`;
        case 'CMP':
            return `select(${c}, ${b}, ${a}.x < 0.0)`;
        case 'EXP':
            lines.push(`    let e${id} = ${a}.x;`);
            return `vec4f(exp2(floor(e${id})), e${id} - floor(e${id}), exp2(e${id}), 1.0)`;
        case 'LOG':
            lines.push(`    let l${id} = abs(${a}.x);`);
            lines.push(`    let lf${id} = floor(log2(l${id}));`);
            return `vec4f(lf${id}, l${id} / exp2(lf${id}), log2(l${id}), 1.0)`;
        case 'LIT':
            lines.push(`    let t${id} = ${a};`);
            return `vec4f(1.0, max(t${id}.x, 0.0), select(0.0,`
                + ` pow(max(t${id}.y, 0.0), clamp(t${id}.w, -128.0, 128.0)), t${id}.x > 0.0), 1.0)`;
        case 'ARL':
            return `vec4f(floor(${a}.x))`;
        default:
            return a;
    }
}

/**
 * The statement lines of one instruction.
 *
 * @param {StageContext} ctx
 * @param {Instruction} instruction
 * @param {string[]} lines
 */
function emitInstruction(ctx, instruction, lines){
    if (instruction.op === 'KIL')
    {
        lines.push(`    if (any(${ctx.source(instruction.src[0])} < vec4f(0.0)))`);
        lines.push('    {');
        lines.push('        discard;');
        lines.push('    }');
        return;
    }
    const dst = instruction.dst;
    const destination = dst ? destinationOf(ctx, dst) : null;
    if (dst && !destination)
    {
        // A result this pipeline has no varying for: written and dropped,
        // which is what the fixed path does with a stage it does not run.
        return;
    }
    const id = ctx.next();
    /** @type {string[]} */
    const statement = [];
    /** @type {string[]} */
    const src = [];
    if (instruction.texture)
    {
        const name = `s${id}_0`;
        statement.push(`    let ${name} = ${ctx.source(instruction.src[0])};`);
        src.push(name);
    }
    else if (instruction.op === 'SWZ')
    {
        const operand = instruction.src[0];
        const base = sourceBase(ctx, operand);
        const parts = (operand.components ?? []).map(c=>{
            if (c === '0' || c === '-0')
            {
                return '0.0';
            }
            if (c === '1')
            {
                return '1.0';
            }
            if (c === '-1')
            {
                return '-1.0';
            }
            return c.startsWith('-') ? `-${base}.${c.slice(1)}` : `${base}.${c}`;
        });
        src.push(`vec4f(${parts.join(', ')})`);
    }
    else
    {
        instruction.src.forEach((operand, i)=>{
            const name = `s${id}_${i}`;
            statement.push(`    let ${name} = ${ctx.source(operand)};`);
            src.push(name);
        });
    }
    /** @type {string[]} */
    const pre = [];
    const value = instruction.texture
        ? sampleCall(instruction, src[0])
        : valueOf(instruction, src, id, pre);
    statement.push(...pre);
    const saturated = instruction.saturate ? `clamp(${value}, vec4f(0.0), vec4f(1.0))` : value;
    const name = `v${id}`;
    statement.push(`    let ${name} = ${saturated};`);
    if (dst && destination)
    {
        writeDestination(dst, destination, name, statement);
    }
    lines.push(...statement);
}

/**
 * The texture call of a sample instruction, from its bound coordinate.
 *
 * @param {Instruction} instruction
 * @param {string} source  the coordinate's let name
 * @returns {string}
 */
function sampleCall(instruction, source){
    const texture = /** @type {NonNullable<Instruction['texture']>} */ (instruction.texture);
    const cube = texture.target === 'CUBE';
    const projective = instruction.op === 'TXP';
    /** @type {string} */
    let coords;
    if (cube)
    {
        coords = projective ? `${source}.xyz / ${source}.w` : `${source}.xyz`;
    }
    else if (texture.target === '1D')
    {
        coords = projective
            ? `vec2f(select(0.0, ${source}.x / ${source}.w, ${source}.w != 0.0), 0.5)`
            : `vec2f(${source}.x, 0.5)`;
    }
    else
    {
        // A zero q samples at the origin rather than dividing: what a real
        // device's projected sample of a zero q draws, as Wine's d3d visual
        // test expects it. A cube's zero q stays the specification's divide,
        // which no test of theirs pins.
        coords = projective
            ? `select(vec2f(0.0), ${source}.xy / ${source}.w, ${source}.w != 0.0)`
            : `${source}.xy`;
    }
    const sample = `t${texture.unit}Texture, t${texture.unit}Sampler, ${coords}`;
    return instruction.op === 'TXB'
        ? `textureSampleBias(${sample}, ${source}.w)`
        : `textureSample(${sample})`;
}

/**
 * The shared half of both emitters.
 *
 * @param {ParsedProgram} ir
 * @param {StageInput[]} inputs
 * @param {StageVaryings} varyings
 * @param {ReturnType<typeof analyse>} analysed
 * @param {string} block
 * @param {number} [viewportHeight]  the render target's rows, for fragment.position
 * @returns {StageContext}
 */
function createContext(ir, inputs, varyings, analysed, block, viewportHeight = 0){
    const resolve = aliasResolver(ir);
    /** @type {Map<string, string>} */
    const temps = new Map();
    ir.temporaries.forEach((name, index)=>temps.set(name, `tmp${index}`));
    /** @type {Map<number, number>} */
    const genericFallbacks = new Map();
    collectNeeds(ir, analysed, resolve)
        .genericFallbacks.forEach((attrib, index)=>genericFallbacks.set(attrib, index));
    let next = 0;
    /** @type {StageContext} */
    const ctx = {
        ir,
        analysed,
        resolve,
        block,
        temps,
        genericFallbacks,
        inputs,
        varyings,
        viewportHeight,
        next: ()=>next++,
        source: operand=>sourceExpression(ctx, operand),
    };
    return ctx;
}

/**
 * The vertex stage of one program.
 *
 * @param {ParsedProgram} ir
 * @param {StageInput[]} inputs  the attributes the pipeline binds, in location order
 * @param {StageVaryings} varyings  the coordinate sets and the fog coordinate
 *        the assembler gives the pair of stages
 * @param {number} [group]  the bind group the block sits in
 * @returns {EmitResult}
 */
export function emitVertex(ir, inputs, varyings, group = VERTEX_PROGRAM_GROUP){
    const analysed = analyse(ir);
    const resolve = aliasResolver(ir);
    const needs = collectNeeds(ir, analysed, resolve);
    if (needs.unsupported.length > 0)
    {
        return { error: refuseReason(needs.unsupported) };
    }
    const ctx = createContext(ir, inputs, varyings, analysed, 'vertexProgram');
    /** @type {string[]} */
    const lines = [];
    let writesPosition = false;
    for (const instruction of ir.instructions)
    {
        const destination = instruction.dst ? destinationOf(ctx, instruction.dst) : null;
        if (destination?.position)
        {
            writesPosition = true;
        }
        emitInstruction(ctx, instruction, lines);
    }

    const inputFields = inputs
        .map((input, location)=>{
            const scalar = input.scalar;
            const type = input.components === 1 ? scalar : `vec${input.components}<${scalar}>`;
            return `    @location(${location}) ${input.name}: ${type},`;
        })
        .join('\n');
    const varyingFields = [
        '    @builtin(position) position: vec4f,',
        '    @location(0) color: vec4f,',
        '    @location(1) secondary: vec4f,',
        '    @location(2) fog: f32,',
        ...varyings.texcoords.map((set, i)=>`    @location(${3 + i}) tc${set}: vec4f,`),
        ...(varyings.fogCoord
            ? [`    @location(${3 + varyings.texcoords.length}) fogCoord: f32,`]
            : []),
    ].join('\n');

    /** @type {string[]} */
    const body = [];
    body.push('    var out: VertexOut;');
    body.push('    out.position = vec4f(0.0, 0.0, 0.0, 1.0);');
    body.push('    out.color = uniforms.color;');
    body.push('    out.secondary = uniforms.secondary;');
    body.push('    out.fog = 1.0;');
    // A result attribute starts at (0, 0, 0, 1), not at a current value: a
    // set the program writes only partly then carries w = 1 into a TXP, and
    // a set it never writes is not the fixed pipeline's coordinate.
    for (const set of varyings.texcoords)
    {
        body.push(`    out.tc${set} = vec4f(0.0, 0.0, 0.0, 1.0);`);
    }
    if (varyings.fogCoord)
    {
        body.push('    out.fogCoord = uniforms.fogParams.w;');
    }
    for (const name of ir.temporaries)
    {
        body.push(`    var ${/** @type {string} */ (ctx.temps.get(name))} = vec4f(0.0);`);
    }
    if (ir.address !== null)
    {
        body.push('    var a0 = vec4f(0.0);');
    }
    if (ir.positionInvariant)
    {
        // The position the specification's option computes: the fixed
        // modelview-projection of the position attribute, depth remapped.
        const position = inputs.find(input=>input.name === 'position');
        const source = position ? widen('vertex.position', position)
            : canonicalFallback('position');
        // The same two lines the fixed stage emits, so the option's promise --
        // the program's position is the fixed pipeline's -- holds bit for bit
        // on the device, not only in intent.
        body.push(`    let clip = uniforms.modelViewProjection * ${source};`);
        body.push('    out.position = vec4f(clip.x, clip.y, (clip.z + clip.w) * 0.5, clip.w);');
    }
    body.push(...lines);
    if (!ir.positionInvariant && writesPosition)
    {
        // GL's clip z runs -w..w and WebGPU's 0..w. The program may write the
        // position one component at a time (a DP4 per matrix row), so the
        // remap runs once here, against the w the program actually wrote.
        body.push('    out.position.z = (out.position.z + out.position.w) * 0.5;');
    }
    body.push('    return out;');

    const paramCount = Math.max(1, analysed.params.length);
    const genericCount = needs.genericFallbacks.length;
    const uniformFields = [
        `    params: array<vec4f, ${paramCount}>,`,
        ...(genericCount > 0 ? [`    attribs: array<vec4f, ${genericCount}>,`] : []),
    ].join('\n');
    const code = `struct VertexProgramUniforms {
${uniformFields}
};
@group(${group}) @binding(${VERTEX_PROGRAM_BINDING}) var<uniform>`
        + ` vertexProgram: VertexProgramUniforms;

struct VertexIn {
${inputFields}
};

struct VertexOut {
${varyingFields}
};

@vertex
fn vertexMain(vertex: VertexIn) -> VertexOut {
${body.join('\n')}
}
`;
    return { code, needs };
}

/**
 * The fragment stage of one program.
 *
 * @param {ParsedProgram} ir
 * @param {number} [group]  the bind group the block sits in
 * @param {number} [viewportHeight]  the render target's rows, for fragment.position
 * @returns {EmitResult}
 */
export function emitFragment(ir, group = FRAGMENT_PROGRAM_GROUP, viewportHeight = 0){
    const analysed = analyse(ir);
    const resolve = aliasResolver(ir);
    const needs = collectNeeds(ir, analysed, resolve);
    if (needs.unsupported.length > 0)
    {
        return { error: refuseReason(needs.unsupported) };
    }
    for (const texture of needs.textures)
    {
        if (texture.target === '3D')
        {
            return {
                error: `the program samples texture[${texture.unit}] as 3D,`
                    + ' and there is no 3D texture',
            };
        }
    }
    for (const instruction of ir.instructions)
    {
        for (const operand of instruction.src)
        {
            const binding = operand.binding;
            if (binding?.kind === 'fragment' && binding.name === 'texcoord'
                && binding.index >= VARYING_TEXCOORDS)
            {
                return {
                    error: `the program reads fragment.texcoord[${binding.index}], past the`
                        + ` ${VARYING_TEXCOORDS} coordinate sets the varyings carry`,
                };
            }
        }
    }
    const ctx = createContext(ir, [], {
        texcoords: Array.from({ length: VARYING_TEXCOORDS }, (unused, set)=>set),
        fogCoord: true,
    }, analysed, 'fragmentProgram', viewportHeight);
    /** @type {string[]} */
    const lines = [];
    for (const instruction of ir.instructions)
    {
        emitInstruction(ctx, instruction, lines);
    }

    /** @type {string[]} */
    const body = [];
    body.push('    var resultColor = vec4f(0.0, 0.0, 0.0, 1.0);');
    body.push('    var resultDepth = input.position.z;');
    for (const name of ir.temporaries)
    {
        body.push(`    var ${/** @type {string} */ (ctx.temps.get(name))} = vec4f(0.0);`);
    }
    body.push(...lines);
    body.push('    var finalColor = clamp(resultColor, vec4f(0.0), vec4f(1.0));');
    if (ir.fog !== null)
    {
        // The fog option: the specification's curve over the raw coordinate,
        // mixed into the clamped colour with the fixed path's fog uniforms.
        const factor = ir.fog === 'exp'
            ? 'exp(-uniforms.fogParams.x * fogC)'
            : ir.fog === 'exp2'
                ? 'exp(-(uniforms.fogParams.x * fogC) * (uniforms.fogParams.x * fogC))'
                : '(uniforms.fogParams.z - fogC)'
                    + ' / max(uniforms.fogParams.z - uniforms.fogParams.y, 1e-6)';
        body.push('    let fogC = input.fogCoord;');
        body.push(`    let fogF = clamp(${factor}, 0.0, 1.0);`);
        body.push('    finalColor = vec4f(mix(uniforms.fogColor.rgb, finalColor.rgb, fogF),'
            + ' finalColor.a);');
    }
    const textureDeclarations = needs.textures.map(texture=>{
        const type = texture.target === 'CUBE' ? 'texture_cube<f32>' : 'texture_2d<f32>';
        return `@group(0) @binding(${1 + texture.unit * 2}) var t${texture.unit}Texture: ${type};\n`
            + `@group(0) @binding(${2 + texture.unit * 2}) var t${texture.unit}Sampler: sampler;`;
    }).join('\n');

    const paramCount = Math.max(1, analysed.params.length);
    if (needs.writesDepth)
    {
        body.push('    var output: FragmentOut;');
        body.push('    output.color = finalColor;');
        body.push('    output.depth = clamp(resultDepth, 0.0, 1.0);');
        body.push('    return output;');
    }
    else
    {
        body.push('    return finalColor;');
    }
    const signature = needs.writesDepth
        ? '@fragment\nfn fragmentMain(input: VertexOut) -> FragmentOut {'
        : '@fragment\nfn fragmentMain(input: VertexOut) -> @location(0) vec4f {';
    const depthStruct = needs.writesDepth
        ? `struct FragmentOut {
    @location(0) color: vec4f,
    @builtin(frag_depth) depth: f32,
};

`
        : '';
    const textures = textureDeclarations ? `${textureDeclarations}\n\n` : '';
    const code = `struct FragmentProgramUniforms {
    params: array<vec4f, ${paramCount}>,
};
@group(${group}) @binding(${FRAGMENT_PROGRAM_BINDING}) var<uniform> fragmentProgram:`
    + ` FragmentProgramUniforms;

${textures}${depthStruct}${signature}
${body.join('\n')}
}
`;
    return { code, needs };
}
