/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What GLSL 1.30 to 4.60 declares before a shader's first line, beside the
 * 1.10 and 1.20 tables of `glsl-builtins.js` (which a shader of those
 * versions keeps exactly): the built-in functions of each version and stage,
 * the built-in variables of each stage, and the implementation's constants.
 *
 * The functions' prototypes are the 4.60 specification's (`glsl-catalog.js`);
 * the version each came with is written here (`SINCE`) from the earlier
 * specifications, and an overload is never older than its types. Which
 * stages have a function follows the specification's sections and notes:
 * the geometry stage's emits, the fragment stage's derivatives and implicit
 * level-of-detail bias, a compute or tessellation control stage's barrier.
 *
 * The constants (`GLSL_CONSTANTS`) are the minimums the 4.60 specification
 * gives; the implementation answers its own through `constants`, so that a
 * shader sizing an array by gl_MaxClipDistances and a program asking
 * GL_MAX_CLIP_DISTANCES agree.
 */

import { GLSL_CATALOG } from './glsl-catalog.js';
import { BUILTIN_STRUCTS, BUILTIN_VARIABLES } from './glsl-builtins.js';
import {
    BOOL, FLOAT, INT, UINT, arrayOf, basicType, typeSince, vectorOf,
} from './glsl-types.js';

/**
 * @typedef {import('./glsl-types.js').GlslType} GlslType
 * @typedef {import('./glsl-types.js').StructType} StructType
 * @typedef {import('./glsl-versions.js').Language} Language
 * @typedef {import('./glsl-versions.js').Stage} Stage
 * @typedef {import('./glsl-builtins.js').BuiltinVariable} BuiltinVariable
 */

/**
 * @typedef {Object} ModernOverload
 * @property {string} name
 * @property {GlslType[]} params
 * @property {('in' | 'out' | 'inout')[]} directions
 * @property {GlslType} returns
 * @property {number} since
 * @property {boolean} compatibility  the compatibility profile's alone
 * @property {ReadonlySet<Stage> | null} stages  the stages that have it, or null for all
 * @property {null} stage  the 1.x tables' field, never set here
 */

/** The version each function came with; one absent came with 1.10. */
const SINCE = /** @type {Record<string, number>} */ ({
    sinh: 130, cosh: 130, tanh: 130, asinh: 130, acosh: 130, atanh: 130, trunc: 130, round: 130,
    roundEven: 130, modf: 130, isnan: 130, isinf: 130, texture: 130, textureProj: 130,
    textureLod: 130, textureOffset: 130, texelFetch: 130, texelFetchOffset: 130,
    textureProjOffset: 130, textureLodOffset: 130, textureProjLod: 130, textureProjLodOffset: 130,
    textureGrad: 130, textureGradOffset: 130, textureProjGrad: 130, textureProjGradOffset: 130,
    textureSize: 130, outerProduct: 120, transpose: 120, determinant: 150, inverse: 150,
    EmitVertex: 150, EndPrimitive: 150, floatBitsToInt: 330, floatBitsToUint: 330,
    intBitsToFloat: 330, uintBitsToFloat: 330, fma: 400, frexp: 400, ldexp: 400,
    packUnorm2x16: 400, unpackUnorm2x16: 400, packUnorm4x8: 400, unpackUnorm4x8: 400,
    packSnorm4x8: 400, unpackSnorm4x8: 400, packDouble2x32: 400, unpackDouble2x32: 400,
    uaddCarry: 400, usubBorrow: 400, umulExtended: 400, imulExtended: 400,
    bitfieldExtract: 400, bitfieldInsert: 400, bitfieldReverse: 400, bitCount: 400,
    findLSB: 400, findMSB: 400, textureQueryLod: 400, textureGather: 400,
    textureGatherOffset: 400, textureGatherOffsets: 400, EmitStreamVertex: 400,
    EndStreamPrimitive: 400, interpolateAtCentroid: 400, interpolateAtSample: 400,
    interpolateAtOffset: 400, barrier: 400, packSnorm2x16: 420, unpackSnorm2x16: 420,
    packHalf2x16: 420, unpackHalf2x16: 420, atomicCounterIncrement: 420,
    atomicCounterDecrement: 420, atomicCounter: 420, imageLoad: 420, imageStore: 420,
    imageAtomicAdd: 420, imageAtomicMin: 420, imageAtomicMax: 420, imageAtomicAnd: 420,
    imageAtomicOr: 420, imageAtomicXor: 420, imageAtomicExchange: 420, imageAtomicCompSwap: 420,
    memoryBarrier: 420, textureQueryLevels: 430, imageSize: 430, atomicAdd: 430, atomicMin: 430,
    atomicMax: 430, atomicAnd: 430, atomicOr: 430, atomicXor: 430, atomicExchange: 430,
    atomicCompSwap: 430, memoryBarrierAtomicCounter: 430, memoryBarrierBuffer: 430,
    memoryBarrierShared: 430, memoryBarrierImage: 430, groupMemoryBarrier: 430,
    dFdxFine: 450, dFdyFine: 450, dFdxCoarse: 450, dFdyCoarse: 450, fwidthFine: 450,
    fwidthCoarse: 450, textureSamples: 450, imageSamples: 450, atomicCounterAdd: 460,
    atomicCounterSubtract: 460, atomicCounterMin: 460, atomicCounterMax: 460,
    atomicCounterAnd: 460, atomicCounterOr: 460, atomicCounterXor: 460,
    atomicCounterExchange: 460, atomicCounterCompSwap: 460, anyInvocation: 460,
    allInvocations: 460, allInvocationsEqual: 460,
});

/**
 * The version an overload came with where it is later than its name's: the
 * integer forms of the common functions and the selecting mix.
 *
 * @param {string} name @param {GlslType[]} params
 * @returns {number}
 */
function overloadSince(name, params){
    const bases = new Set(params.map(p=>(p.kind === 'scalar' || p.kind === 'vector'
        ? p.base : null)));
    if (name === 'mix' && bases.has('bool'))
    {
        // The float forms selecting by a boolean came with 1.30, the integer
        // and boolean ones with 4.50.
        return bases.has('int') || bases.has('uint') || params[0].kind === 'scalar'
            && params[0].base === 'bool' || params[0].kind === 'vector'
            && params[0].base === 'bool' ? 450 : 130;
    }
    if (['abs', 'sign', 'min', 'max', 'clamp'].includes(name)
        && (bases.has('int') || bases.has('uint')))
    {
        return 130;
    }
    if (['lessThan', 'lessThanEqual', 'greaterThan', 'greaterThanEqual', 'equal', 'notEqual']
        .includes(name) && bases.has('uint'))
    {
        return 130;
    }
    return 110;
}

/** The functions only the compatibility profile has (sections 8.9.5 and 8.5). */
const COMPATIBILITY_SECTIONS = new Set(['Texture1D', 'Texture2D', 'Texture3D', 'TextureCube',
    'Shadow', 'FTransform']);

/** @param {...Stage} stages */
const only = (...stages)=>Object.freeze(new Set(stages));
const FRAGMENT = only('fragment');
const GEOMETRY = only('geometry');
const COMPUTE = only('compute');

/** The stages that have a function, where not every stage does. */
const STAGES = /** @type {Record<string, ReadonlySet<Stage>>} */ ({
    EmitVertex: GEOMETRY, EndPrimitive: GEOMETRY, EmitStreamVertex: GEOMETRY,
    EndStreamPrimitive: GEOMETRY,
    dFdx: FRAGMENT, dFdy: FRAGMENT, fwidth: FRAGMENT, dFdxFine: FRAGMENT, dFdyFine: FRAGMENT,
    dFdxCoarse: FRAGMENT, dFdyCoarse: FRAGMENT, fwidthFine: FRAGMENT, fwidthCoarse: FRAGMENT,
    interpolateAtCentroid: FRAGMENT, interpolateAtSample: FRAGMENT,
    interpolateAtOffset: FRAGMENT, textureQueryLod: FRAGMENT,
    barrier: only('tessControl', 'compute'),
    memoryBarrierShared: COMPUTE, groupMemoryBarrier: COMPUTE,
    ftransform: only('vertex'),
});

/** @type {Map<string, ModernOverload[]>} */
const MODERN = new Map();
/** Prototypes whose types this implementation has none of (Vulkan's), kept for a test. */
export const SKIPPED_PROTOTYPES = /** @type {string[]} */ ([]);

/** @param {string} name @returns {GlslType | null} */
function typeNamed(name){
    if (name.endsWith('[]'))
    {
        const element = typeNamed(name.slice(0, -2));
        return element ? arrayOf(element, 4) : null;
    }
    return basicType(name) ?? null;
}

for (const [section, name, returnName, paramNames, outs, bias] of GLSL_CATALOG)
{
    const returns = typeNamed(returnName);
    const params = paramNames.map(typeNamed);
    if (!returns || params.some(p=>!p))
    {
        SKIPPED_PROTOTYPES.push(`${name}(${paramNames.join(', ')})`);
        continue;
    }
    const typed = /** @type {GlslType[]} */ (params);
    /** @type {('in' | 'out' | 'inout')[]} */
    const directions = typed.map((_, k)=>(outs.includes(k * 2) ? 'out'
        : outs.includes(k * 2 + 1) ? 'inout' : 'in'));
    const since = Math.max(SINCE[name] ?? 110, overloadSince(name, typed),
        ...[returnName, ...paramNames].map(n=>typeSince(n.replace(/\[\]$/, '')) ?? 110));
    /** @type {ModernOverload} */
    const overload = Object.freeze({
        name, params: typed, directions, returns, since,
        compatibility: COMPATIBILITY_SECTIONS.has(section),
        // A lookup with an explicit bias computes a level of detail from
        // derivatives, which only fragments have.
        stages: bias ? FRAGMENT : STAGES[name] ?? null,
        stage: null,
    });
    let list = MODERN.get(name);
    if (!list)
    {
        list = [];
        MODERN.set(name, list);
    }
    list.push(overload);
}

/**
 * The overloads of a built-in function a shader of `language` has, in any
 * stage; the stage is the caller's to check (`stages`), so that a call in
 * the wrong one says so rather than "no such function".
 *
 * @param {string} name @param {Language} language
 * @returns {ModernOverload[]}
 */
export function modernOverloads(name, language){
    return (MODERN.get(name) ?? []).filter(o=>o.since <= language.version
        && (!o.compatibility || language.compatibility));
}

// --- constants ---

/** The 4.60 specification's minimums (section 7.3), by the constant's name. */
export const GLSL_CONSTANTS = Object.freeze({
    gl_MaxVertexAttribs: 16, gl_MaxVertexUniformVectors: 256,
    gl_MaxVertexUniformComponents: 1024, gl_MaxVertexOutputComponents: 64,
    gl_MaxVaryingComponents: 60, gl_MaxVaryingVectors: 15, gl_MaxVertexTextureImageUnits: 16,
    gl_MaxVertexImageUniforms: 0, gl_MaxVertexAtomicCounters: 0,
    gl_MaxVertexAtomicCounterBuffers: 0, gl_MaxTessPatchComponents: 120,
    gl_MaxPatchVertices: 32, gl_MaxTessGenLevel: 64, gl_MaxTessControlInputComponents: 128,
    gl_MaxTessControlOutputComponents: 128, gl_MaxTessControlTextureImageUnits: 16,
    gl_MaxTessControlUniformComponents: 1024, gl_MaxTessControlTotalOutputComponents: 4096,
    gl_MaxTessControlImageUniforms: 0, gl_MaxTessControlAtomicCounters: 0,
    gl_MaxTessControlAtomicCounterBuffers: 0, gl_MaxTessEvaluationInputComponents: 128,
    gl_MaxTessEvaluationOutputComponents: 128, gl_MaxTessEvaluationTextureImageUnits: 16,
    gl_MaxTessEvaluationUniformComponents: 1024, gl_MaxTessEvaluationImageUniforms: 0,
    gl_MaxTessEvaluationAtomicCounters: 0, gl_MaxTessEvaluationAtomicCounterBuffers: 0,
    gl_MaxGeometryInputComponents: 64, gl_MaxGeometryOutputComponents: 128,
    gl_MaxGeometryImageUniforms: 0, gl_MaxGeometryTextureImageUnits: 16,
    gl_MaxGeometryOutputVertices: 256, gl_MaxGeometryTotalOutputComponents: 1024,
    gl_MaxGeometryUniformComponents: 1024, gl_MaxGeometryVaryingComponents: 64,
    gl_MaxGeometryAtomicCounters: 0, gl_MaxGeometryAtomicCounterBuffers: 0,
    gl_MaxFragmentImageUniforms: 8, gl_MaxFragmentInputComponents: 128,
    gl_MaxFragmentUniformVectors: 256, gl_MaxFragmentUniformComponents: 1024,
    gl_MaxFragmentAtomicCounters: 8, gl_MaxFragmentAtomicCounterBuffers: 1,
    gl_MaxDrawBuffers: 8, gl_MaxTextureImageUnits: 16, gl_MinProgramTexelOffset: -8,
    gl_MaxProgramTexelOffset: 7, gl_MaxImageUnits: 8, gl_MaxSamples: 4, gl_MaxImageSamples: 0,
    gl_MaxClipDistances: 8, gl_MaxCullDistances: 8, gl_MaxViewports: 16,
    gl_MaxComputeImageUniforms: 8, gl_MaxComputeWorkGroupCount: [65535, 65535, 65535],
    gl_MaxComputeWorkGroupSize: [1024, 1024, 64], gl_MaxComputeUniformComponents: 1024,
    gl_MaxComputeTextureImageUnits: 16, gl_MaxComputeAtomicCounters: 8,
    gl_MaxComputeAtomicCounterBuffers: 8, gl_MaxCombinedTextureImageUnits: 96,
    gl_MaxCombinedImageUniforms: 48, gl_MaxCombinedImageUnitsAndFragmentOutputs: 8,
    gl_MaxCombinedShaderOutputResources: 16, gl_MaxCombinedAtomicCounters: 8,
    gl_MaxCombinedAtomicCounterBuffers: 1, gl_MaxCombinedClipAndCullDistances: 8,
    gl_MaxAtomicCounterBindings: 1, gl_MaxAtomicCounterBufferSize: 32,
    gl_MaxTransformFeedbackBuffers: 4, gl_MaxTransformFeedbackInterleavedComponents: 64,
    // The compatibility profile's (section 7.3.1).
    gl_MaxTextureUnits: 2, gl_MaxTextureCoords: 8, gl_MaxClipPlanes: 8, gl_MaxVaryingFloats: 60,
    gl_MaxLights: 8,
});

/** @typedef {Record<keyof typeof GLSL_CONSTANTS, number | number[]>} GlslConstants */

/** The version each constant came with; one absent came with 1.10. */
const CONSTANT_SINCE = /** @type {Record<string, number>} */ ({
    gl_MaxVertexOutputComponents: 150, gl_MaxVaryingComponents: 130,
    gl_MaxClipDistances: 130, gl_MinProgramTexelOffset: 130, gl_MaxProgramTexelOffset: 130,
    gl_MaxVertexUniformVectors: 410, gl_MaxFragmentUniformVectors: 410,
    gl_MaxVaryingVectors: 410, gl_MaxFragmentInputComponents: 150,
    gl_MaxCullDistances: 450, gl_MaxCombinedClipAndCullDistances: 450,
    gl_MaxViewports: 410, gl_MaxSamples: 450,
    gl_MaxTransformFeedbackBuffers: 400, gl_MaxTransformFeedbackInterleavedComponents: 400,
});

/**
 * Whether a constant belongs to a version: the tessellation ones from 4.00,
 * the geometry ones from 1.50, the images', atomic counters' and compute's
 * with theirs, the compatibility profile's in that profile alone.
 *
 * @param {string} name @param {Language} language
 */
function constantHas(name, language){
    const v = language.version;
    if (CONSTANT_SINCE[name])
    {
        return CONSTANT_SINCE[name] <= v;
    }
    if (/^gl_Max(TextureUnits|TextureCoords|ClipPlanes|VaryingFloats|Lights)$/.test(name))
    {
        return language.compatibility;
    }
    if (/Tess|PatchVertices/.test(name))
    {
        return v >= 400;
    }
    if (/Geometry/.test(name))
    {
        return v >= 150;
    }
    if (/Compute/.test(name))
    {
        return v >= 430;
    }
    if (/Image|ShaderOutputResources/.test(name))
    {
        return v >= 420;
    }
    if (/AtomicCounter/.test(name))
    {
        return v >= 420;
    }
    return true;
}

// --- variables ---

const VEC2 = vectorOf('float', 2);
const VEC3 = vectorOf('float', 3);
const VEC4 = vectorOf('float', 4);
const UVEC3 = vectorOf('uint', 3);

let structIds = -100;
/** @param {string} name @param {[string, GlslType][]} fields @returns {StructType} */
const struct = (name, fields)=>Object.freeze({
    kind: /** @type {'struct'} */ ('struct'), name, id: structIds--,
    fields: fields.map(([fieldName, type])=>({ name: fieldName, type })),
});

/** @type {Map<string, StructType>} */
const PER_VERTEX = new Map();

/**
 * The gl_PerVertex block of a stage's vertices (section 7.1): position,
 * point size, clip and cull distances, and in the compatibility profile the
 * fixed-function outputs too.
 *
 * @param {Language} language @param {GlslConstants} constants
 * @returns {StructType}
 */
export function perVertexOf(language, constants){
    const key = `${language.version}:${language.compatibility}:${constants.gl_MaxClipDistances}`
        + `:${constants.gl_MaxCullDistances}:${constants.gl_MaxTextureCoords}`;
    const known = PER_VERTEX.get(key);
    if (known)
    {
        return known;
    }
    /** @type {[string, GlslType][]} */
    const fields = [['gl_Position', VEC4], ['gl_PointSize', FLOAT],
        ['gl_ClipDistance', arrayOf(FLOAT, Number(constants.gl_MaxClipDistances))]];
    if (language.version >= 450)
    {
        fields.push(['gl_CullDistance', arrayOf(FLOAT, Number(constants.gl_MaxCullDistances))]);
    }
    if (language.compatibility)
    {
        fields.push(['gl_ClipVertex', VEC4], ['gl_FrontColor', VEC4], ['gl_BackColor', VEC4],
            ['gl_FrontSecondaryColor', VEC4], ['gl_BackSecondaryColor', VEC4],
            ['gl_TexCoord', arrayOf(VEC4, Number(constants.gl_MaxTextureCoords))],
            ['gl_FogFragCoord', FLOAT]);
    }
    const made = struct('gl_PerVertex', fields);
    PER_VERTEX.set(key, made);
    return made;
}

/** @type {Map<string, Record<string, BuiltinVariable>>} */
const VARIABLES = new Map();

/**
 * The built-in variables of a stage in a version and profile: the 1.x
 * tables for 1.10 and 1.20, the specification's chapter 7 for later ones.
 * A variable of `gl_PerVertex` is a field of it; gl_in and gl_out are arrays
 * of it, unsized (length 0) where the stage's layout sizes them.
 *
 * @param {Stage} stage @param {Language} language
 * @param {GlslConstants} [constants]
 * @returns {Record<string, BuiltinVariable>}
 */
export function builtinVariablesFor(stage, language, constants = GLSL_CONSTANTS){
    if (language.version < 130 && (stage === 'vertex' || stage === 'fragment'))
    {
        return BUILTIN_VARIABLES[stage];
    }
    const key = `${stage}:${language.version}:${language.compatibility}`;
    if (constants === GLSL_CONSTANTS)
    {
        const known = VARIABLES.get(key);
        if (known)
        {
            return known;
        }
    }
    const v = language.version;
    /** @type {Record<string, BuiltinVariable>} */
    const vars = {};
    for (const [name, value] of Object.entries(constants))
    {
        if (constantHas(name, language))
        {
            vars[name] = Array.isArray(value)
                ? { type: vectorOf('int', 3), role: 'const', value: [...value] }
                : { type: INT, role: 'const', value: [value] };
        }
    }
    // State every stage reads (section 7.4): the depth range in both profiles,
    // and in the compatibility profile all of 1.x's state.
    vars.gl_DepthRange = { type: BUILTIN_STRUCTS.depthRange, role: 'uniform' };
    if (v >= 450)
    {
        vars.gl_NumSamples = { type: INT, role: 'uniform' };
    }
    if (language.compatibility)
    {
        for (const [name, variable] of Object.entries(BUILTIN_VARIABLES.vertex))
        {
            if (variable.role === 'uniform')
            {
                vars[name] = variable;
            }
        }
    }
    const perVertex = perVertexOf(language, constants);
    /** @param {Record<string, BuiltinVariable>} into @param {'in' | 'out'} role */
    const perVertexFields = (into, role)=>{
        for (const field of perVertex.fields)
        {
            into[field.name] = { type: field.type, role };
        }
    };
    const patchVertices = Number(constants.gl_MaxPatchVertices);
    switch (stage)
    {
        case 'vertex':
            vars.gl_VertexID = { type: INT, role: 'in' };
            if (v >= 140)
            {
                vars.gl_InstanceID = { type: INT, role: 'in' };
            }
            if (v >= 460)
            {
                vars.gl_DrawID = { type: INT, role: 'in' };
                vars.gl_BaseVertex = { type: INT, role: 'in' };
                vars.gl_BaseInstance = { type: INT, role: 'in' };
            }
            perVertexFields(vars, 'out');
            if (language.compatibility)
            {
                for (const [name, variable] of Object.entries(BUILTIN_VARIABLES.vertex))
                {
                    if (variable.role === 'attribute')
                    {
                        vars[name] = variable;
                    }
                }
            }
            break;
        case 'tessControl':
            vars.gl_in = { type: arrayOf(perVertex, patchVertices), role: 'in' };
            vars.gl_PatchVerticesIn = { type: INT, role: 'in' };
            vars.gl_PrimitiveID = { type: INT, role: 'in' };
            vars.gl_InvocationID = { type: INT, role: 'in' };
            vars.gl_out = { type: arrayOf(perVertex, 0), role: 'out' };
            vars.gl_TessLevelOuter = { type: arrayOf(FLOAT, 4), role: 'out', patch: true };
            vars.gl_TessLevelInner = { type: arrayOf(FLOAT, 2), role: 'out', patch: true };
            break;
        case 'tessEvaluation':
            vars.gl_in = { type: arrayOf(perVertex, patchVertices), role: 'in' };
            vars.gl_PatchVerticesIn = { type: INT, role: 'in' };
            vars.gl_PrimitiveID = { type: INT, role: 'in' };
            vars.gl_TessCoord = { type: VEC3, role: 'in' };
            vars.gl_TessLevelOuter = { type: arrayOf(FLOAT, 4), role: 'in', patch: true };
            vars.gl_TessLevelInner = { type: arrayOf(FLOAT, 2), role: 'in', patch: true };
            perVertexFields(vars, 'out');
            break;
        case 'geometry':
            vars.gl_in = { type: arrayOf(perVertex, 0), role: 'in' };
            vars.gl_PrimitiveIDIn = { type: INT, role: 'in' };
            if (v >= 400)
            {
                vars.gl_InvocationID = { type: INT, role: 'in' };
            }
            perVertexFields(vars, 'out');
            vars.gl_PrimitiveID = { type: INT, role: 'out' };
            vars.gl_Layer = { type: INT, role: 'out' };
            if (v >= 410)
            {
                vars.gl_ViewportIndex = { type: INT, role: 'out' };
            }
            break;
        case 'fragment':
            vars.gl_FragCoord = { type: VEC4, role: 'in' };
            vars.gl_FrontFacing = { type: BOOL, role: 'in' };
            vars.gl_ClipDistance = { type: arrayOf(FLOAT, Number(constants.gl_MaxClipDistances)),
                role: 'in' };
            if (v >= 450)
            {
                vars.gl_CullDistance = { type: arrayOf(FLOAT,
                    Number(constants.gl_MaxCullDistances)), role: 'in' };
                vars.gl_HelperInvocation = { type: BOOL, role: 'in' };
            }
            vars.gl_PointCoord = { type: VEC2, role: 'in' };
            if (v >= 150)
            {
                vars.gl_PrimitiveID = { type: INT, role: 'in' };
            }
            if (v >= 400)
            {
                vars.gl_SampleID = { type: INT, role: 'in' };
                vars.gl_SamplePosition = { type: VEC2, role: 'in' };
                vars.gl_SampleMaskIn = { type: arrayOf(INT, 1), role: 'in' };
                vars.gl_SampleMask = { type: arrayOf(INT, 1), role: 'out' };
            }
            if (v >= 430)
            {
                vars.gl_Layer = { type: INT, role: 'in' };
                vars.gl_ViewportIndex = { type: INT, role: 'in' };
            }
            vars.gl_FragDepth = { type: FLOAT, role: 'out' };
            if (language.compatibility)
            {
                for (const name of ['gl_FragColor', 'gl_FragData', 'gl_Color', 'gl_SecondaryColor',
                    'gl_TexCoord', 'gl_FogFragCoord'])
                {
                    vars[name] = BUILTIN_VARIABLES.fragment[name];
                }
                vars.gl_FragData = { type: arrayOf(VEC4, Number(constants.gl_MaxDrawBuffers)),
                    role: 'out' };
            }
            break;
        case 'compute':
            vars.gl_NumWorkGroups = { type: UVEC3, role: 'in' };
            vars.gl_WorkGroupSize = { type: UVEC3, role: 'const', value: [1, 1, 1] };
            vars.gl_WorkGroupID = { type: UVEC3, role: 'in' };
            vars.gl_LocalInvocationID = { type: UVEC3, role: 'in' };
            vars.gl_GlobalInvocationID = { type: UVEC3, role: 'in' };
            vars.gl_LocalInvocationIndex = { type: UINT, role: 'in' };
            break;
        default:
            break;
    }
    if (constants === GLSL_CONSTANTS)
    {
        VARIABLES.set(key, vars);
    }
    return vars;
}

