/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The entry points of GLSL tessellation shaders in WGSL (OpenGL 4.0 section
 * 2.12), over what `emitStage` makes of a stage's body (`glsl-wgsl.js`).
 *
 * - **The control shader is a compute pass**, a workgroup a patch and an
 *   invocation a control point it makes (gl_InvocationID). Its outputs are
 *   workgroup variables, so that what one invocation wrote another reads
 *   after barrier(), which is workgroupBarrier(); the language lets barrier()
 *   stand only in main, outside any control flow, which is the uniform
 *   control flow WGSL asks for. Each invocation stores its own control point
 *   once main has returned in every invocation; the first stores the patch's
 *   values and levels and its record for the tessellator.
 * - **The evaluation shader is the draw's vertex stage**, a vertex an index
 *   the tessellator wrote (Direct3D's domain shader, `../d3d10/wgsl.js`
 *   linkDomain): its patch found among the patches' first indices, its
 *   domain point, and the patch's control points and values read in.
 *
 * Between the passes a value takes a register a leaf (`registersOf`): a
 * control point gl_Position, gl_PointSize, then what the evaluation shader
 * reads by name; a patch its outer and inner levels, then its patch values.
 */

import { fromRegister, geometryInputRegisters, registersOf, toRegister } from './glsl-wgsl.js';
import { DOMAIN_BINDING } from '../d3d10/wgsl.js';
import { tessellatorKind } from './glsl-link-tess.js';
import { CLIP_REMAP } from './arb-wgsl.js';

/**
 * @typedef {import('./glsl-link.js').LinkedProgram} LinkedProgram
 * @typedef {import('./glsl-link.js').LinkedStage} LinkedStage
 * @typedef {import('./glsl-types.js').GlslType} GlslType
 */

/**
 * Group 1 of the control shader's pass: what the vertex pass wrote, the
 * control points, the patches' values and records it writes, its parameters.
 */
export const GLSL_TESS_CONTROL_BINDING = Object.freeze({
    inputs: 0, points: 1, constants: 2, patches: 3, params: 4,
});

/**
 * A patch's record for the tessellator (`../d3d10/tessellator-wgsl.js`
 * Patch, 48 bytes) made of its levels: the factors in the order the
 * tessellator takes them for the domain (`tessellatorKind`).
 */
export const TESS_RECORD_WGSL = /* wgsl */ `
struct TessRecord {
    kind: vec4u,
    f0: vec4f,
    f1: vec4f,
}

fn tessRecord(kind: vec4u, outer: vec4f, inner: vec4f) -> TessRecord {
    if (kind.x == 0u) {
        return TessRecord(kind, vec4f(outer.xy, 0.0, 0.0), vec4f(0.0));
    }
    if (kind.x == 1u) {
        return TessRecord(kind, vec4f(outer.xyz, inner.x), vec4f(0.0));
    }
    return TessRecord(kind, outer, vec4f(inner.xy, 0.0, 0.0));
}
`;

/** @param {{ type: GlslType }[]} values */
const registersOfAll = values=>values.reduce((n, value)=>n + registersOf(value.type), 0);

/**
 * The registers between the tessellation passes.
 *
 * @param {LinkedProgram} program
 * @returns {{ inputs: number, pointRegisters: number, patchRegisters: number }}
 *     `inputs`: what the vertex pass writes a control point; `pointRegisters`:
 *     a control point the evaluation shader reads; `patchRegisters`: a patch's
 */
export function tessRegisters(program){
    const evaluation = registersOfAll(program.evaluationInputs ?? []);
    return {
        inputs: geometryInputRegisters(program),
        pointRegisters: 2 + evaluation,
        patchRegisters: 2 + registersOfAll(program.patchInputs ?? []),
    };
}

/** @typedef {import('./glsl-wgsl.js').TessEntryContext} TessEntryContext */

/** @param {TessEntryContext} ctx @param {string} name */
const uses = (ctx, name)=>ctx.linked.uses.has(name);

/**
 * A control point's values read in: gl_in's and each named input's element
 * `index`, from the registers at `at` in `buffer`.
 *
 * @param {TessEntryContext} ctx @param {{ path: string, type: GlslType }[]} inputs
 * @param {string} buffer @param {string} index @param {string} at
 * @returns {string[]}
 */
function loadPoint(ctx, inputs, buffer, index, at){
    const { p } = ctx;
    /** @type {string[]} */
    const lines = [];
    if (uses(ctx, 'gl_in'))
    {
        lines.push(`        ${p}gl_in[${index}].m_gl_Position = bitcast<vec4f>(${buffer}[${at}]);`,
            `        ${p}gl_in[${index}].m_gl_PointSize = bitcast<f32>(${buffer}[${at} + 1u].x);`);
    }
    let register = 2;
    for (const input of inputs)
    {
        for (const leaf of ctx.leavesOf(`${p}${input.path.replace('[]', `[${index}]`)}`,
            input.type))
        {
            lines.push(`        ${leaf.code} = ${fromRegister(`${buffer}[${at} + ${register++}u]`,
                leaf.type)};`);
        }
    }
    return lines;
}

/**
 * The control shader as a compute pass (`createGlTessellation`'s second):
 * a workgroup a patch, `tcParams` the patches, the patches an instance and
 * the control points a patch has.
 *
 * @param {TessEntryContext} ctx
 * @returns {string}
 */
export function controlEntry(ctx){
    const { program, p } = ctx;
    const layout = /** @type {import('./glsl-link-tess.js').TessLayout} */ (program.tessLayout);
    const vertices = layout.vertices;
    const registers = tessRegisters(program);
    const kind = tessellatorKind(layout);
    const b = GLSL_TESS_CONTROL_BINDING;
    ctx.declarations.push([
        TESS_RECORD_WGSL,
        'struct TcParams { patches: u32, perInstance: u32, points: u32, pad: u32, }',
        `@group(1) @binding(${b.inputs}) var<storage, read> tcIn: array<vec4u>;`,
        `@group(1) @binding(${b.points}) var<storage, read_write> tcPoints: array<vec4u>;`,
        `@group(1) @binding(${b.constants}) var<storage, read_write> tcConstants: array<vec4u>;`,
        `@group(1) @binding(${b.patches}) var<storage, read_write> tcPatches: array<TessRecord>;`,
        `@group(1) @binding(${b.params}) var<uniform> tcParams: TcParams;`,
    ].join('\n'));
    const controlInputs = (program.controlInputs ?? []).map(input=>({ path: input.path,
        type: input.type }));
    /** @type {string[]} */
    const stores = [
        `    let tcPoint = (tcPatch * ${vertices}u + tcInvocation) * ${registers.pointRegisters}u;`,
        uses(ctx, 'gl_out')
            ? `    tcPoints[tcPoint] = bitcast<vec4u>(${p}gl_out[tcInvocation].m_gl_Position);`
            : '    tcPoints[tcPoint] = vec4u(0u);',
        uses(ctx, 'gl_out')
            ? `    tcPoints[tcPoint + 1u] = vec4u(bitcast<u32>(`
                + `${p}gl_out[tcInvocation].m_gl_PointSize), 0u, 0u, 0u);`
            : '    tcPoints[tcPoint + 1u] = vec4u(bitcast<u32>(1.0f), 0u, 0u, 0u);',
    ];
    let register = 2;
    for (const input of program.evaluationInputs ?? [])
    {
        for (const leaf of ctx.leavesOf(`${p}${input.fromPath.replace('[]', '[tcInvocation]')}`,
            input.type))
        {
            stores.push(`    tcPoints[tcPoint + ${register++}u] = ${toRegister(leaf.code,
                leaf.type)};`);
        }
    }
    /** @param {string} name @param {number} count */
    const levels = (name, count)=>(uses(ctx, name)
        ? `vec4f(${Array.from({ length: 4 }, (_, k)=>(k < count ? `${p}${name}[${k}]`
            : '0.0f')).join(', ')})` : 'vec4f(0.0f)');
    /** @type {string[]} */
    const patch = [
        `        let tcAt = tcPatch * ${registers.patchRegisters}u;`,
        `        let tcOuter = ${levels('gl_TessLevelOuter', 4)};`,
        `        let tcInner = ${levels('gl_TessLevelInner', 2)};`,
        '        tcConstants[tcAt] = bitcast<vec4u>(tcOuter);',
        '        tcConstants[tcAt + 1u] = bitcast<vec4u>(tcInner);',
    ];
    register = 2;
    for (const input of program.patchInputs ?? [])
    {
        for (const leaf of ctx.leavesOf(`${p}${input.fromPath}`, input.type))
        {
            patch.push(`        tcConstants[tcAt + ${register++}u] = ${toRegister(leaf.code,
                leaf.type)};`);
        }
    }
    patch.push('        tcPatches[tcPatch] = tessRecord(vec4u('
        + `${kind.domain}u, ${kind.partitioning}u, ${kind.output}u, 0u), tcOuter, tcInner);`);
    return `@compute @workgroup_size(${vertices})
fn controlMain(@builtin(workgroup_id) tcGroup: vec3u,
    @builtin(local_invocation_index) tcInvocation: u32) {
    let tcPatch = tcGroup.x + tcGroup.y * 65535u;
    if (tcPatch >= tcParams.patches) { return; }
    let tcCount = min(tcParams.points, 32u);
    for (var tcJ = 0u; tcJ < tcCount; tcJ++) {
        let tcFrom = (tcPatch * tcParams.points + tcJ) * ${registers.inputs}u;
${loadPoint(ctx, controlInputs, 'tcIn', 'tcJ', 'tcFrom').join('\n')}
    }
${[...uses(ctx, 'gl_PatchVerticesIn') ? [`    ${p}gl_PatchVerticesIn = i32(tcParams.points);`]
        : [],
    ...uses(ctx, 'gl_PrimitiveID')
        ? [`    ${p}gl_PrimitiveID = i32(tcPatch % max(1u, tcParams.perInstance));`] : [],
    ...uses(ctx, 'gl_InvocationID') ? [`    ${p}gl_InvocationID = i32(tcInvocation);`] : [],
    ...ctx.initial, `    ${p}main();`,
    // Every invocation's outputs are written before any is stored.
    '    workgroupBarrier();',
    ...stores,
    '    if (tcInvocation == 0u) {', ...patch, '    }'].join('\n')}
}`;
}

/**
 * The evaluation shader as the draw's vertex stage: `teParams` the patches,
 * the patches an instance, the tessellator's room in points and indices,
 * then the control points a patch has.
 *
 * @param {TessEntryContext} ctx
 * @returns {string}
 */
export function evaluationEntry(ctx){
    const { program, p } = ctx;
    const layout = /** @type {import('./glsl-link-tess.js').TessLayout} */ (program.tessLayout);
    const registers = tessRegisters(program);
    const group = 2;
    const b = DOMAIN_BINDING;
    ctx.declarations.push([
        `@group(${group}) @binding(${b.points}) var<storage, read> tePoints: array<vec4u>;`,
        `@group(${group}) @binding(${b.constants}) var<storage, read> teConstants: array<vec4u>;`,
        `@group(${group}) @binding(${b.domain}) var<storage, read> teUv: array<vec2f>;`,
        `@group(${group}) @binding(${b.indices}) var<storage, read> teIndices: array<u32>;`,
        `@group(${group}) @binding(${b.offsets}) var<storage, read> teOffsets: array<vec2u>;`,
        `@group(${group}) @binding(${b.params}) var<uniform> teParams: array<vec4u, 2>;`,
    ].join('\n'));
    const third = layout.mode === 'triangles' ? '1.0f - teAt.x - teAt.y' : '0.0f';
    const inputs = (program.evaluationInputs ?? []).map(input=>({ path: input.path,
        type: input.type }));
    /** @type {string[]} */
    const patch = [`    let teAtPatch = tePatch * ${registers.patchRegisters}u;`];
    if (uses(ctx, 'gl_TessLevelOuter'))
    {
        patch.push('    let teOuter = bitcast<vec4f>(teConstants[teAtPatch]);',
            ...[0, 1, 2, 3].map(k=>`    ${p}gl_TessLevelOuter[${k}] = teOuter[${k}];`));
    }
    if (uses(ctx, 'gl_TessLevelInner'))
    {
        patch.push('    let teInner = bitcast<vec4f>(teConstants[teAtPatch + 1u]);',
            ...[0, 1].map(k=>`    ${p}gl_TessLevelInner[${k}] = teInner[${k}];`));
    }
    let register = 2;
    for (const input of program.patchInputs ?? [])
    {
        for (const leaf of ctx.leavesOf(`${p}${input.path}`, input.type))
        {
            patch.push(`    ${leaf.code} = ${fromRegister(`teConstants[teAtPatch + ${register++}u]`,
                leaf.type)};`);
        }
    }
    return `@vertex
fn vertexMain(@builtin(vertex_index) teVertex: u32) -> VertexOut {
    // The last patch whose indices start at or before this one: a patch
    // that made none starts where the next one does.
    var teLow = 0u;
    var teHigh = max(teParams[0].x, 1u) - 1u;
    loop {
        if (teLow >= teHigh) { break; }
        let teMid = (teLow + teHigh + 1u) / 2u;
        if (teOffsets[teMid].y <= teVertex) { teLow = teMid; } else { teHigh = teMid - 1u; }
    }
    let tePatch = teLow;
    let teAt = teUv[teOffsets[tePatch].x + teIndices[teVertex]];
    let tePerPatch = teParams[1].x;
    let teCount = min(tePerPatch, 32u);
    for (var teJ = 0u; teJ < teCount; teJ++) {
        let teFrom = (tePatch * tePerPatch + teJ) * ${registers.pointRegisters}u;
${loadPoint(ctx, inputs, 'tePoints', 'teJ', 'teFrom').join('\n')}
    }
${[...uses(ctx, 'gl_TessCoord') ? [`    ${p}gl_TessCoord = vec3f(teAt.x, teAt.y, ${third});`]
        : [],
    ...uses(ctx, 'gl_PatchVerticesIn') ? [`    ${p}gl_PatchVerticesIn = i32(tePerPatch);`] : [],
    ...uses(ctx, 'gl_PrimitiveID')
        ? [`    ${p}gl_PrimitiveID = i32(tePatch % max(1u, teParams[0].y));`] : [],
    ...patch, ...ctx.initial, `    ${p}main();`, '    var out: VertexOut;',
    `    let clip = ${p}gl_Position;`,
    `    out.position = ${CLIP_REMAP};`,
    ...ctx.out, '    return out;'].join('\n')}
}`;
}
