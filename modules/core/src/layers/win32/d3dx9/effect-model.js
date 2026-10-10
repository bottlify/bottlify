/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * An effect file read into what ID3DXEffect describes: its parameters, with their
 * types, defaults and annotations; its techniques and passes, each pass a list of
 * state assignments; and the shaders those passes compile, compiled.
 *
 * Nothing here touches a guest or a device. `effect.js` builds the COM objects over
 * this description; a test can build one from source and look at it directly.
 *
 * The source goes through the same front end as D3DXCompileShader -- preprocessor,
 * parser, checker -- once for the whole file, so an error anywhere in it is an error
 * of the effect, as fxc makes it. Each `compile vs_2_0 f(...)` is then a compile of
 * one entry point (`hlsl-compile.js`) over the same source and the same included
 * files, its arguments bound to the uniform parameters of `f`.
 *
 * What fxc would read but this does not -- an `asm { }` shader, a state this table
 * does not list, a state value that is an expression of parameters (fxc's preshader)
 * -- is said in the messages as a warning and left out, rather than refusing the
 * whole effect; a pass whose shader does not compile makes its technique invalid,
 * which is what ValidateTechnique and FindNextValidTechnique report.
 */

import { preprocessTracked } from './preprocess.js';
import { HlslError, formatDiagnostic } from './hlsl-lexer.js';
import { parse } from './hlsl-parser.js';
import { check } from './hlsl-check.js';
import { D3DXSHADER, compileShader, withLineMarkers } from './hlsl-compile.js';
import { arrayOf, flatBases, flattenValue, fromTypeRef, scalarCount } from './hlsl-types.js';

/** @typedef {import('./hlsl-parser.js').Expr} Expr */
/** @typedef {import('./hlsl-parser.js').TypeRef} TypeRef */
/** @typedef {import('./hlsl-types.js').Type} Type */

/** D3DXPARAMETER_CLASS. */
export const PC = Object.freeze({ SCALAR: 0, VECTOR: 1, MATRIX_ROWS: 2, MATRIX_COLUMNS: 3,
    OBJECT: 4, STRUCT: 5 });

/** D3DXPARAMETER_TYPE. */
export const PT = Object.freeze({ VOID: 0, BOOL: 1, INT: 2, FLOAT: 3, STRING: 4, TEXTURE: 5,
    TEXTURE1D: 6, TEXTURE2D: 7, TEXTURE3D: 8, TEXTURECUBE: 9, SAMPLER: 10, SAMPLER1D: 11,
    SAMPLER2D: 12, SAMPLER3D: 13, SAMPLERCUBE: 14, PIXELSHADER: 15, VERTEXSHADER: 16 });

/** D3DX_PARAMETER_* flags. */
export const PARAMETER = Object.freeze({ SHARED: 1, LITERAL: 2, ANNOTATION: 4 });

/** @param {number} type */
export const isTexture = type=>type >= PT.TEXTURE && type <= PT.TEXTURECUBE;
/** @param {number} type */
export const isSampler = type=>type >= PT.SAMPLER && type <= PT.SAMPLERCUBE;
/** @param {number} type */
export const isShader = type=>type === PT.PIXELSHADER || type === PT.VERTEXSHADER;

/**
 * Where a state's value comes from: a constant known when the effect is read, a
 * parameter read each time the state is applied, a shader the effect compiled (or
 * none), or something this layer does not evaluate.
 *
 * @typedef {{ kind: 'const', words: number[] }
 *   | { kind: 'param', path: string }
 *   | { kind: 'shader', shader: number | null }} ValueSource
 */

/**
 * A state assignment, resolved against the table of states: what it sets and on
 * which stage, sampler, light or register.
 *
 * @typedef {Object} StateModel
 * @property {string} name     As written.
 * @property {StateKind} kind
 * @property {number} op       The D3DRS/D3DTSS/D3DSAMP/transform number, or the field.
 * @property {number} index    The `[n]` of the assignment, or -1 for none.
 * @property {ValueKind} value How the value is passed.
 * @property {ValueSource} source
 */

/**
 * @typedef {'render' | 'stage' | 'sampler' | 'texture' | 'setsampler' | 'vs' | 'ps'
 *     | 'transform' | 'lightenable' | 'light' | 'material' | 'fvf' | 'npatch'
 *     | 'vsconstf' | 'vsconsti' | 'vsconstb' | 'psconstf' | 'psconsti' | 'psconstb'} StateKind
 */

/**
 * How a state's value is passed: a DWORD, a float's bits, a D3DCOLOR, floats (a
 * vector, a matrix, float registers), integers (integer and boolean registers), or
 * an object's pointer.
 *
 * @typedef {'dword' | 'float' | 'color' | 'vector' | 'matrix' | 'ints' | 'object'} ValueKind
 */

/**
 * A parameter, an element of one, a member of one, or an annotation, as
 * D3DXPARAMETER_DESC describes it, with its default.
 *
 * @typedef {Object} ParamModel
 * @property {string} name
 * @property {string | null} semantic
 * @property {number} cls
 * @property {number} type
 * @property {number} rows
 * @property {number} columns
 * @property {number} elements
 * @property {number} flags
 * @property {number} bytes
 * @property {ParamModel[]} members   The elements of an array, else a structure's members.
 * @property {ParamModel[]} annotations
 * @property {Slot[]} init   Its default, a slot for each DWORD of its data.
 * @property {(StateModel[] | null)[]} samplers   A sampler's states, one list an element.
 * @property {Type | null} hlsl   The type it was declared with, for an element its element's.
 */

/**
 * One DWORD of a parameter's data as the effect starts with it: a number in the
 * parameter's own type, a string, or a shader the effect compiled.
 *
 * @typedef {{ word: number } | { string: string } | { shader: number | null }} Slot
 */

/**
 * @typedef {Object} PassModel
 * @property {string | null} name
 * @property {ParamModel[]} annotations
 * @property {StateModel[]} states
 */

/**
 * @typedef {Object} TechniqueModel
 * @property {string | null} name
 * @property {ParamModel[]} annotations
 * @property {PassModel[]} passes
 */

/**
 * A shader a `compile` expression names, and what came of compiling it.
 *
 * @typedef {Object} ShaderModel
 * @property {string} profile
 * @property {string} entry
 * @property {boolean} pixel
 * @property {Uint32Array | null} tokens
 * @property {Uint8Array | null} constantTable
 * @property {string} messages
 */

/**
 * @typedef {Object} EffectModel
 * @property {ParamModel[]} parameters
 * @property {TechniqueModel[]} techniques
 * @property {string[]} functions   Every function with a body, as the effect compiler lists them.
 * @property {ShaderModel[]} shaders
 */

/**
 * @typedef {Object} BuildOptions
 * @property {[string, string][]} [defines]
 * @property {(name: string, system: boolean) => Promise<string | null> | string | null} [include]
 * @property {number} [flags]   D3DXSHADER_* flags, for the compile of each shader.
 * @property {boolean} [compile]   False to leave the shaders uncompiled, as the effect
 *     compiler does until it is asked for one.
 * @property {(record: { profile: string, entry: string, messages: string,
 *     tokens: Uint32Array | null }) => void} [compiled]   Told of each shader compiled.
 */

/**
 * @typedef {Object} BuildResult
 * @property {EffectModel | null} model   Null when the source does not compile.
 * @property {string} messages   Errors and warnings, fxc's form, one to a line.
 * @property {{ name: string, system: boolean, text: string }[]} files   What was included.
 */

/** The render states, by the name an effect gives them: D3DRS number, how the value goes. */
const RENDER_STATES = /** @type {[string, number, ValueKind, string?][]} */ ([
    ['ZEnable', 7, 'dword', 'zb'], ['FillMode', 8, 'dword', 'fill'],
    ['ShadeMode', 9, 'dword', 'shade'], ['ZWriteEnable', 14, 'dword'],
    ['AlphaTestEnable', 15, 'dword'], ['LastPixel', 16, 'dword'],
    ['SrcBlend', 19, 'dword', 'blend'], ['DestBlend', 20, 'dword', 'blend'],
    ['CullMode', 22, 'dword', 'cull'], ['ZFunc', 23, 'dword', 'cmp'],
    ['AlphaRef', 24, 'dword'], ['AlphaFunc', 25, 'dword', 'cmp'],
    ['DitherEnable', 26, 'dword'], ['AlphaBlendEnable', 27, 'dword'],
    ['FogEnable', 28, 'dword'], ['SpecularEnable', 29, 'dword'],
    ['FogColor', 34, 'color'], ['FogTableMode', 35, 'dword', 'fog'],
    ['FogStart', 36, 'float'], ['FogEnd', 37, 'float'], ['FogDensity', 38, 'float'],
    ['RangeFogEnable', 48, 'dword'], ['StencilEnable', 52, 'dword'],
    ['StencilFail', 53, 'dword', 'stencil'], ['StencilZFail', 54, 'dword', 'stencil'],
    ['StencilPass', 55, 'dword', 'stencil'], ['StencilFunc', 56, 'dword', 'cmp'],
    ['StencilRef', 57, 'dword'], ['StencilMask', 58, 'dword'],
    ['StencilWriteMask', 59, 'dword'], ['TextureFactor', 60, 'color'],
    ['Wrap0', 128, 'dword', 'wrap'], ['Wrap1', 129, 'dword', 'wrap'],
    ['Wrap2', 130, 'dword', 'wrap'], ['Wrap3', 131, 'dword', 'wrap'],
    ['Wrap4', 132, 'dword', 'wrap'], ['Wrap5', 133, 'dword', 'wrap'],
    ['Wrap6', 134, 'dword', 'wrap'], ['Wrap7', 135, 'dword', 'wrap'],
    ['Clipping', 136, 'dword'], ['Lighting', 137, 'dword'], ['Ambient', 139, 'color'],
    ['FogVertexMode', 140, 'dword', 'fog'], ['ColorVertex', 141, 'dword'],
    ['LocalViewer', 142, 'dword'], ['NormalizeNormals', 143, 'dword'],
    ['DiffuseMaterialSource', 145, 'dword', 'mcs'], ['SpecularMaterialSource', 146, 'dword', 'mcs'],
    ['AmbientMaterialSource', 147, 'dword', 'mcs'], ['EmissiveMaterialSource', 148, 'dword', 'mcs'],
    ['VertexBlend', 151, 'dword', 'vblend'], ['ClipPlaneEnable', 152, 'dword'],
    ['PointSize', 154, 'float'], ['PointSize_Min', 155, 'float'],
    ['PointSpriteEnable', 156, 'dword'], ['PointScaleEnable', 157, 'dword'],
    ['PointScale_A', 158, 'float'], ['PointScale_B', 159, 'float'],
    ['PointScale_C', 160, 'float'], ['MultiSampleAntialias', 161, 'dword'],
    ['MultiSampleMask', 162, 'dword'], ['PatchEdgeStyle', 163, 'dword', 'patch'],
    ['DebugMonitorToken', 165, 'dword', 'debug'], ['PointSize_Max', 166, 'float'],
    ['IndexedVertexBlendEnable', 167, 'dword'], ['ColorWriteEnable', 168, 'dword', 'color'],
    ['TweenFactor', 170, 'float'], ['BlendOp', 171, 'dword', 'blendop'],
    ['PositionDegree', 172, 'dword', 'degree'], ['NormalDegree', 173, 'dword', 'degree'],
    ['ScissorTestEnable', 174, 'dword'], ['SlopeScaleDepthBias', 175, 'float'],
    ['AntialiasedLineEnable', 176, 'dword'], ['MinTessellationLevel', 178, 'float'],
    ['MaxTessellationLevel', 179, 'float'], ['AdaptiveTess_X', 180, 'float'],
    ['AdaptiveTess_Y', 181, 'float'], ['AdaptiveTess_Z', 182, 'float'],
    ['AdaptiveTess_W', 183, 'float'], ['EnableAdaptiveTessellation', 184, 'dword'],
    ['TwoSidedStencilMode', 185, 'dword'], ['CCW_StencilFail', 186, 'dword', 'stencil'],
    ['CCW_StencilZFail', 187, 'dword', 'stencil'], ['CCW_StencilPass', 188, 'dword', 'stencil'],
    ['CCW_StencilFunc', 189, 'dword', 'cmp'], ['ColorWriteEnable1', 190, 'dword', 'color'],
    ['ColorWriteEnable2', 191, 'dword', 'color'], ['ColorWriteEnable3', 192, 'dword', 'color'],
    ['BlendFactor', 193, 'color'], ['SRGBWriteEnable', 194, 'dword'],
    ['DepthBias', 195, 'float'], ['Wrap8', 198, 'dword', 'wrap'], ['Wrap9', 199, 'dword', 'wrap'],
    ['Wrap10', 200, 'dword', 'wrap'], ['Wrap11', 201, 'dword', 'wrap'],
    ['Wrap12', 202, 'dword', 'wrap'], ['Wrap13', 203, 'dword', 'wrap'],
    ['Wrap14', 204, 'dword', 'wrap'], ['Wrap15', 205, 'dword', 'wrap'],
    ['SeparateAlphaBlendEnable', 206, 'dword'], ['SrcBlendAlpha', 207, 'dword', 'blend'],
    ['DestBlendAlpha', 208, 'dword', 'blend'], ['BlendOpAlpha', 209, 'dword', 'blendop'],
]);

/** The texture stage states: D3DTSS number, how the value goes. */
const STAGE_STATES = /** @type {[string, number, ValueKind, string?][]} */ ([
    ['ColorOp', 1, 'dword', 'top'], ['ColorArg1', 2, 'dword', 'ta'],
    ['ColorArg2', 3, 'dword', 'ta'], ['AlphaOp', 4, 'dword', 'top'],
    ['AlphaArg1', 5, 'dword', 'ta'], ['AlphaArg2', 6, 'dword', 'ta'],
    ['BumpEnvMat00', 7, 'float'], ['BumpEnvMat01', 8, 'float'], ['BumpEnvMat10', 9, 'float'],
    ['BumpEnvMat11', 10, 'float'], ['TexCoordIndex', 11, 'dword', 'tci'],
    ['BumpEnvLScale', 22, 'float'], ['BumpEnvLOffset', 23, 'float'],
    ['TextureTransformFlags', 24, 'dword', 'ttff'], ['ColorArg0', 26, 'dword', 'ta'],
    ['AlphaArg0', 27, 'dword', 'ta'], ['ResultArg', 28, 'dword', 'ta'],
    ['Constant', 32, 'color'],
]);

/** The sampler states: D3DSAMP number, how the value goes. */
const SAMPLER_STATES = /** @type {[string, number, ValueKind, string?][]} */ ([
    ['AddressU', 1, 'dword', 'address'], ['AddressV', 2, 'dword', 'address'],
    ['AddressW', 3, 'dword', 'address'], ['BorderColor', 4, 'color'],
    ['MagFilter', 5, 'dword', 'filter'], ['MinFilter', 6, 'dword', 'filter'],
    ['MipFilter', 7, 'dword', 'filter'], ['MipMapLodBias', 8, 'float'],
    ['MaxMipLevel', 9, 'dword'], ['MaxAnisotropy', 10, 'dword'], ['SRGBTexture', 11, 'dword'],
    ['ElementIndex', 12, 'dword'], ['DMAPOffset', 13, 'dword'],
]);

/** The fields of D3DLIGHT9 a state sets: byte offset, how the value goes. */
const LIGHT_STATES = /** @type {[string, number, ValueKind, string?][]} */ ([
    ['LightType', 0, 'dword', 'light'], ['LightDiffuse', 4, 'vector'],
    ['LightSpecular', 20, 'vector'], ['LightAmbient', 36, 'vector'],
    ['LightPosition', 52, 'vector'], ['LightDirection', 64, 'vector'],
    ['LightRange', 76, 'float'], ['LightFalloff', 80, 'float'],
    ['LightAttenuation0', 84, 'float'], ['LightAttenuation1', 88, 'float'],
    ['LightAttenuation2', 92, 'float'], ['LightTheta', 96, 'float'], ['LightPhi', 100, 'float'],
]);

/** The fields of D3DMATERIAL9 a state sets: byte offset, how the value goes. */
const MATERIAL_STATES = /** @type {[string, number, ValueKind][]} */ ([
    ['MaterialDiffuse', 0, 'vector'], ['MaterialAmbient', 16, 'vector'],
    ['MaterialSpecular', 32, 'vector'], ['MaterialEmissive', 48, 'vector'],
    ['MaterialPower', 64, 'float'],
]);

/**
 * The names a state's value may be written with, each set in the order of its
 * D3D enumeration. Names are matched without regard to case, as fxc matches them.
 *
 * @type {Record<string, Record<string, number>>}
 */
const ENUMS = {
    bool: { false: 0, true: 1 },
    zb: { false: 0, true: 1, usew: 2 },
    fill: { point: 1, wireframe: 2, solid: 3 },
    shade: { flat: 1, gouraud: 2, phong: 3 },
    blend: { zero: 1, one: 2, srccolor: 3, invsrccolor: 4, srcalpha: 5, invsrcalpha: 6,
        destalpha: 7, invdestalpha: 8, destcolor: 9, invdestcolor: 10, srcalphasat: 11,
        bothsrcalpha: 12, bothinvsrcalpha: 13, blendfactor: 14, invblendfactor: 15 },
    cull: { none: 1, cw: 2, ccw: 3 },
    cmp: { never: 1, less: 2, equal: 3, lessequal: 4, greater: 5, notequal: 6,
        greaterequal: 7, always: 8 },
    fog: { none: 0, exp: 1, exp2: 2, linear: 3 },
    stencil: { keep: 1, zero: 2, replace: 3, incrsat: 4, decrsat: 5, invert: 6, incr: 7,
        decr: 8 },
    wrap: { u: 1, v: 2, w: 4, coord0: 1, coord1: 2, coord2: 4, coord3: 8 },
    mcs: { material: 0, color1: 1, color2: 2 },
    vblend: { disable: 0, '1weights': 1, '2weights': 2, '3weights': 3, tweening: 255,
        '0weights': 256 },
    patch: { discrete: 0, continuous: 1 },
    debug: { enable: 0, disable: 1 },
    color: { red: 1, green: 2, blue: 4, alpha: 8 },
    blendop: { add: 1, subtract: 2, revsubtract: 3, min: 4, max: 5 },
    degree: { linear: 1, quadratic: 2, cubic: 3, quintic: 5 },
    top: { disable: 1, selectarg1: 2, selectarg2: 3, modulate: 4, modulate2x: 5,
        modulate4x: 6, add: 7, addsigned: 8, addsigned2x: 9, subtract: 10, addsmooth: 11,
        blenddiffusealpha: 12, blendtexturealpha: 13, blendfactoralpha: 14,
        blendtexturealphapm: 15, blendcurrentalpha: 16, premodulate: 17,
        modulatealpha_addcolor: 18, modulatecolor_addalpha: 19, modulateinvalpha_addcolor: 20,
        modulateinvcolor_addalpha: 21, bumpenvmap: 22, bumpenvmapluminance: 23,
        dotproduct3: 24, multiplyadd: 25, lerp: 26 },
    ta: { diffuse: 0, current: 1, texture: 2, tfactor: 3, specular: 4, temp: 5, constant: 6,
        complement: 0x10, alphareplicate: 0x20 },
    tci: { passthru: 0, cameraspacenormal: 0x10000, cameraspaceposition: 0x20000,
        cameraspacereflectionvector: 0x30000, spheremap: 0x40000 },
    ttff: { disable: 0, count1: 1, count2: 2, count3: 3, count4: 4, projected: 256 },
    address: { wrap: 1, mirror: 2, clamp: 3, border: 4, mirroronce: 5 },
    filter: { none: 0, point: 1, linear: 2, anisotropic: 3, pyramidalquad: 6, gaussianquad: 7 },
    light: { point: 1, spot: 2, directional: 3 },
};

/**
 * Every state an effect pass may assign, by its name in lower case.
 *
 * @type {Map<string, { kind: StateKind, op: number, value: ValueKind, enumeration?: string }>}
 */
export const STATES = new Map([
    ...RENDER_STATES.map(([name, op, value, enumeration])=>
        [name, { kind: /** @type {StateKind} */ ('render'), op, value, enumeration }]),
    ...STAGE_STATES.map(([name, op, value, enumeration])=>
        [name, { kind: /** @type {StateKind} */ ('stage'), op, value, enumeration }]),
    ...SAMPLER_STATES.map(([name, op, value, enumeration])=>
        [name, { kind: /** @type {StateKind} */ ('sampler'), op, value, enumeration }]),
    ...LIGHT_STATES.map(([name, op, value, enumeration])=>
        [name, { kind: /** @type {StateKind} */ ('light'), op, value, enumeration }]),
    ...MATERIAL_STATES.map(([name, op, value])=>
        [name, { kind: /** @type {StateKind} */ ('material'), op, value }]),
    ['LightEnable', { kind: 'lightenable', op: 0, value: 'dword' }],
    ['Texture', { kind: 'texture', op: 0, value: 'object' }],
    ['Sampler', { kind: 'setsampler', op: 0, value: 'object' }],
    ['VertexShader', { kind: 'vs', op: 0, value: 'object' }],
    ['PixelShader', { kind: 'ps', op: 0, value: 'object' }],
    ['FVF', { kind: 'fvf', op: 0, value: 'dword' }],
    ['NPatchMode', { kind: 'npatch', op: 0, value: 'float' }],
    ['WorldTransform', { kind: 'transform', op: 256, value: 'matrix' }],
    ['ViewTransform', { kind: 'transform', op: 2, value: 'matrix' }],
    ['ProjectionTransform', { kind: 'transform', op: 3, value: 'matrix' }],
    ['TextureTransform', { kind: 'transform', op: 16, value: 'matrix' }],
    ['VertexShaderConstantF', { kind: 'vsconstf', op: 0, value: 'vector' }],
    ['VertexShaderConstantI', { kind: 'vsconsti', op: 0, value: 'ints' }],
    ['VertexShaderConstantB', { kind: 'vsconstb', op: 0, value: 'ints' }],
    ['VertexShaderConstant', { kind: 'vsconstf', op: 0, value: 'vector' }],
    ['VertexShaderConstant1', { kind: 'vsconstf', op: 0, value: 'vector' }],
    ['VertexShaderConstant2', { kind: 'vsconstf', op: 0, value: 'vector' }],
    ['VertexShaderConstant3', { kind: 'vsconstf', op: 0, value: 'vector' }],
    ['VertexShaderConstant4', { kind: 'vsconstf', op: 0, value: 'vector' }],
    ['PixelShaderConstantF', { kind: 'psconstf', op: 0, value: 'vector' }],
    ['PixelShaderConstantI', { kind: 'psconsti', op: 0, value: 'ints' }],
    ['PixelShaderConstantB', { kind: 'psconstb', op: 0, value: 'ints' }],
    ['PixelShaderConstant', { kind: 'psconstf', op: 0, value: 'vector' }],
    ['PixelShaderConstant1', { kind: 'psconstf', op: 0, value: 'vector' }],
    ['PixelShaderConstant2', { kind: 'psconstf', op: 0, value: 'vector' }],
    ['PixelShaderConstant3', { kind: 'psconstf', op: 0, value: 'vector' }],
    ['PixelShaderConstant4', { kind: 'psconstf', op: 0, value: 'vector' }],
].map(([name, entry])=>[/** @type {string} */(name).toLowerCase(),
    /** @type {{ kind: StateKind, op: number, value: ValueKind, enumeration?: string }} */
    (entry)]));

/** @param {number} value */
const floatBits = value=>new Uint32Array(Float32Array.of(value).buffer)[0];

/**
 * The value of an expression made only of literals -- numbers, `true`, strings,
 * constructors, `{ }` lists, unary and binary operators on them -- flattened, with
 * whether any number in it was written as a float. Null for anything else.
 *
 * @param {Expr | null | undefined} expr
 * @param {(name: string) => number | undefined} [named]  A name's value: an enumeration's.
 * @returns {{ numbers: number[], float: boolean, strings: string[] } | null}
 */
export function literalOf(expr, named){
    if (!expr)
    {
        return null;
    }
    /** @type {(one: any) => { numbers: number[], float: boolean, strings: string[] } | null} */
    const of = one=>literalOf(one, named);
    switch (expr.kind)
    {
        case 'num':
            return { numbers: [expr.value], float: expr.ntype === 'float' || expr.ntype === 'half'
                || expr.ntype === 'double', strings: [] };
        case 'bool':
            return { numbers: [expr.value ? 1 : 0], float: false, strings: [] };
        case 'string':
            return { numbers: [], float: false, strings: [expr.value] };
        case 'ident': {
            const lower = expr.name.toLowerCase();
            if (lower === 'true' || lower === 'false')
            {
                return { numbers: [lower === 'true' ? 1 : 0], float: false, strings: [] };
            }
            const value = named?.(expr.name);
            return value === undefined ? null : { numbers: [value], float: false, strings: [] };
        }
        case 'unary': {
            const inner = of(expr.operand);
            if (!inner || inner.numbers.length === 0)
            {
                return null;
            }
            const op = { '-': (/** @type {number} */ x)=>-x, '+': (/** @type {number} */ x)=>x,
                '!': (/** @type {number} */ x)=>(x ? 0 : 1),
                '~': (/** @type {number} */ x)=>~x }[expr.op];
            return op ? { ...inner, numbers: inner.numbers.map(op) } : null;
        }
        case 'binary': {
            const left = of(expr.left);
            const right = of(expr.right);
            if (!left || !right || left.numbers.length !== 1 || right.numbers.length !== 1)
            {
                return null;
            }
            const [a, b] = [left.numbers[0], right.numbers[0]];
            /** @type {Record<string, number>} */
            const results = { '|': a | b, '&': a & b, '^': a ^ b, '+': a + b, '-': a - b,
                '*': a * b, '/': b === 0 ? NaN : a / b, '<<': a << b, '>>': a >> b };
            const value = results[expr.op];
            return value === undefined ? null
                : { numbers: [value], float: left.float || right.float, strings: [] };
        }
        case 'construct':
        case 'initlist': {
            const items = expr.kind === 'construct' ? expr.args : expr.items;
            const parts = items.map(of);
            if (parts.some(p=>p === null))
            {
                return null;
            }
            const all = /** @type {{ numbers: number[], float: boolean, strings: string[] }[]} */
                (parts);
            return { numbers: all.flatMap(p=>p.numbers), strings: all.flatMap(p=>p.strings),
                float: expr.kind === 'construct' ? expr.type.scalar !== 'int'
                    && expr.type.scalar !== 'uint' && expr.type.scalar !== 'bool'
                    : all.some(p=>p.float) };
        }
        case 'cast':
            return of(expr.operand);
        default:
            return null;
    }
}

/**
 * The DWORDs of a parameter's data for these numbers, each converted to the
 * parameter's element type in the order its scalars are laid out.
 *
 * @param {number[]} numbers @param {('bool' | 'int' | 'float')[]} bases
 * @returns {number[]}
 */
function wordsOf(numbers, bases){
    return bases.map((base, i)=>{
        const value = numbers[i] ?? 0;
        if (base === 'float')
        {
            return floatBits(value);
        }
        if (base === 'bool')
        {
            return value ? 1 : 0;
        }
        return Math.trunc(value) | 0;
    });
}

/**
 * The words of a state's value as the device takes it: a DWORD state as an
 * integer, a float state as the float's bits, a colour as a D3DCOLOR when it is
 * given as a vector, and the rest -- a vector, a matrix -- as their floats.
 *
 * @param {number[]} numbers @param {boolean} float  Whether the numbers are floats.
 * @param {ValueKind} kind
 * @returns {number[]}
 */
export function stateWords(numbers, float, kind){
    const first = numbers[0] ?? 0;
    switch (kind)
    {
        case 'float':
            return [floatBits(first)];
        case 'color': {
            if (numbers.length < 3 && !float)
            {
                return [first >>> 0];
            }
            const byte = (/** @type {number} */ x)=>Math.max(0, Math.min(255,
                Math.round((x ?? 0) * 255)));
            const [r, g, b, a = 1] = numbers.length >= 3 ? numbers : [first, first, first, first];
            return [((byte(a) << 24) | (byte(r) << 16) | (byte(g) << 8) | byte(b)) >>> 0];
        }
        case 'vector':
        case 'matrix':
            return numbers.map(floatBits);
        case 'ints':
            return numbers.map(x=>Math.trunc(x) >>> 0);
        default:
            return [(float ? Math.trunc(first) : first) >>> 0];
    }
}

/**
 * The shape D3DX gives a parameter of this type, with its data laid out and its
 * default taken from `values` (a flattened value of the type, numbers or strings).
 *
 * @param {Type} type
 * @param {TypeRef | null} ref   As declared, for the kind of a shader.
 * @param {string} name @param {string | null} semantic @param {number} flags
 * @returns {ParamModel}
 */
export function shapeOf(type, ref, name, semantic, flags){
    /** @type {ParamModel} */
    const model = { name, semantic, cls: PC.OBJECT, type: PT.VOID, rows: 0, columns: 0,
        elements: 0, flags, bytes: 0, members: [], annotations: [], init: [], samplers: [],
        hlsl: type };
    switch (type.kind)
    {
        case 'array': {
            const one = shapeOf(type.elem, ref, name, semantic, flags);
            const members = Array.from({ length: type.length }, ()=>
                shapeOf(type.elem, ref, name, semantic, flags));
            return { ...one, elements: type.length, members, bytes: one.bytes * type.length,
                init: members.flatMap(m=>m.init), samplers: members.flatMap(m=>m.samplers),
                hlsl: type };
        }
        case 'struct': {
            const members = type.members.map(m=>shapeOf(m.type, null, m.name, m.semantic,
                flags));
            return { ...model, cls: PC.STRUCT, members,
                bytes: members.reduce((sum, m)=>sum + m.bytes, 0),
                init: members.flatMap(m=>m.init) };
        }
        case 'scalar':
        case 'vector':
        case 'matrix': {
            const rows = type.kind === 'matrix' ? type.rows : 1;
            const columns = type.kind === 'matrix' ? type.cols
                : type.kind === 'vector' ? type.n : 1;
            return { ...model, cls: type.kind === 'scalar' ? PC.SCALAR : type.kind === 'vector'
                ? PC.VECTOR : PC.MATRIX_ROWS,
            type: type.base === 'bool' ? PT.BOOL : type.base === 'int' ? PT.INT : PT.FLOAT,
            rows, columns, bytes: 4 * rows * columns,
            init: Array.from({ length: rows * columns }, ()=>({ word: 0 })) };
        }
        case 'string':
            return { ...model, type: PT.STRING, bytes: 4, init: [{ string: '' }] };
        case 'texture':
            return { ...model, type: { any: PT.TEXTURE, '1d': PT.TEXTURE1D, '2d': PT.TEXTURE2D,
                '3d': PT.TEXTURE3D, cube: PT.TEXTURECUBE }[type.dim], bytes: 4,
            init: [{ word: 0 }] };
        case 'sampler':
            return { ...model, type: { any: PT.SAMPLER, '1d': PT.SAMPLER1D, '2d': PT.SAMPLER2D,
                '3d': PT.SAMPLER3D, cube: PT.SAMPLERCUBE }[type.dim], bytes: 0, samplers: [null] };
        case 'shader':
            return { ...model, type: (ref?.name ?? '').toLowerCase() === 'pixelshader'
                ? PT.PIXELSHADER : PT.VERTEXSHADER, bytes: 4, init: [{ shader: null }] };
        default:
            return model;
    }
}

/**
 * Sets a parameter's default slots, and its elements' and members' with them.
 *
 * @param {ParamModel} model @param {Slot[]} slots
 */
function setInit(model, slots){
    model.init = slots.slice(0, model.init.length);
    let at = 0;
    for (const member of model.members)
    {
        setInit(member, slots.slice(at, at + member.init.length));
        at += member.init.length;
    }
}

/** @param {ParamModel} model @param {(StateModel[] | null)[]} lists */
function setSamplers(model, lists){
    model.samplers = lists;
    if (model.elements > 0)
    {
        model.members.forEach((member, i)=>{
            member.samplers = [lists[i] ?? null];
        });
    }
}

/**
 * Reads an effect.
 *
 * @param {string} source
 * @param {BuildOptions} [options]
 * @returns {Promise<BuildResult>}
 */
export async function buildEffect(source, options = {}){
    /** @type {string[]} */
    const messages = [];
    /** @type {{ name: string, system: boolean, text: string }[]} */
    const files = [];
    const include = options.include;
    /** @type {import('./preprocess.js').PreprocessOptions['include']} */
    const recorded = include && (async(name, system)=>{
        const text = await include(name, system);
        if (text !== null)
        {
            files.push({ name, system, text });
        }
        return text;
    });
    /** @returns {BuildResult} */
    const failed = ()=>({ model: null, messages: messages.map(m=>`${m}\n`).join(''), files });

    const expanded = await preprocessTracked(source, { defines: options.defines,
        include: recorded });
    if ('error' in expanded)
    {
        messages.push(expanded.error.replace(/^([^:]*?)(\(\d+\))?: /, (_, file, line)=>
            `${file}${line ?? ''}: error X3000: `));
        return failed();
    }
    let program;
    try
    {
        program = parse(withLineMarkers(expanded.text, expanded.origins));
    }
    catch (e){
        if (!(e instanceof HlslError))
        {
            throw e;
        }
        messages.push(formatDiagnostic({ code: e.code, message: e.message, pos: e.pos }));
        return failed();
    }

    // The initialisers of objects -- strings, textures, samplers, shaders -- are the
    // effect's to read; the checker of numeric code is not shown them.
    /** @type {Map<any, Expr>} */
    const objectInits = new Map();
    for (const decl of program.decls)
    {
        if (decl.kind === 'var' && decl.init && decl.type.cls !== 'scalar'
            && decl.type.cls !== 'vector' && decl.type.cls !== 'matrix'
            && decl.type.cls !== 'named')
        {
            objectInits.set(decl, decl.init);
            decl.init = null;
        }
    }

    const flags = options.flags ?? 0;
    // The bodies of the functions are checked by the compiles that name them: a function
    // no pass compiles is not this layer's to refuse the effect for.
    const { module, diagnostics } = check(program, { bodies: false,
        rowMajor: (flags & D3DXSHADER.PACKMATRIX_ROWMAJOR) !== 0 });
    for (const d of diagnostics)
    {
        messages.push(formatDiagnostic(d));
    }
    if (diagnostics.some(d=>d.severity === 'error'))
    {
        return failed();
    }

    /** @type {ShaderModel[]} */
    const shaders = [];
    /** @type {Map<string, number>} */
    const shaderKeys = new Map();
    /** @type {{ index: number, args: Expr[] }[]} */
    const pending = [];
    /**
     * A shader for a `compile` expression, the same one for the same entry,
     * target and arguments.
     *
     * @param {Expr & { kind: 'compile' }} expr
     * @returns {number}
     */
    const shaderFor = expr=>{
        const key = JSON.stringify([expr.target, expr.callee, expr.args], (k, v)=>(k === 'pos'
            ? undefined : v));
        const known = shaderKeys.get(key);
        if (known !== undefined)
        {
            return known;
        }
        const index = shaders.length;
        shaders.push({ profile: expr.target, entry: expr.callee,
            pixel: expr.target.toLowerCase().startsWith('ps'), tokens: null, constantTable: null,
            messages: '' });
        shaderKeys.set(key, index);
        if (expr.target === 'asm')
        {
            messages.push(`${posText(expr)}: warning X4710: a shader in an asm block is not `
                + 'assembled by this layer; its technique is not valid');
            return index;
        }
        pending.push({ index, args: expr.args });
        return index;
    };

    /** @param {string} name */
    const resolveNamed = name=>module.structs.get(name) ?? module.typedefs.get(name);
    /** A static constant's value, which a state may name. @param {string} name */
    const constantNamed = name=>{
        const sym = module.globals.find(g=>g.name === name && g.isStatic && g.isConst);
        const value = sym && typeof sym.constValue === 'number' ? sym.constValue : undefined;
        return value;
    };

    /**
     * The annotations a declaration carries, as parameters of their own.
     *
     * @param {import('./hlsl-parser.js').Annotation[]} annotations
     * @returns {ParamModel[]}
     */
    const annotationsOf = annotations=>annotations.flatMap(a=>{
        let type = fromTypeRef(a.type, resolveNamed);
        if (!type)
        {
            messages.push(`memory: warning X4717: annotation '${a.name}': unknown type`);
            return [];
        }
        for (const dim of [...(a.dims ?? [])].reverse())
        {
            const length = literalOf(dim)?.numbers[0] ?? 1;
            type = arrayOf(type, length);
        }
        const model = shapeOf(type, a.type, a.name, null, PARAMETER.ANNOTATION);
        const value = literalOf(a.value);
        if (value)
        {
            setInit(model, slotsFor(type, value.numbers, value.strings));
        }
        return [model];
    });

    /**
     * The default slots of a type from flattened numbers and strings.
     *
     * @param {Type} type @param {number[]} numbers @param {string[]} strings
     * @returns {Slot[]}
     */
    const slotsFor = (type, numbers, strings)=>{
        if (type.kind === 'string' || (type.kind === 'array' && type.elem.kind === 'string'))
        {
            const count = type.kind === 'array' ? type.length : 1;
            return Array.from({ length: count }, (_, i)=>({ string: strings[i] ?? '' }));
        }
        if (scalarCount(type) === 0)
        {
            return [];
        }
        return wordsOf(numbers, flatBases(type)).map(word=>({ word }));
    };

    /** The parameter a state's value names, by its path in the effect. */
    const paramNames = new Set(module.globals.filter(g=>!g.isStatic).map(g=>g.name));

    /**
     * A state's value from the expression written for it.
     *
     * @param {string} stateName @param {Expr} expr
     * @param {{ value: ValueKind, enumeration?: string, kind: StateKind }} entry
     * @returns {ValueSource | null}
     */
    const sourceOf = (stateName, expr, entry)=>{
        if (expr.kind === 'compile')
        {
            return { kind: 'shader', shader: shaderFor(expr) };
        }
        const path = pathOf(expr);
        if (path !== null && paramNames.has(path.split(/[.[]/)[0]))
        {
            return { kind: 'param', path };
        }
        if (expr.kind === 'ident' && expr.name.toUpperCase() === 'NULL')
        {
            return entry.kind === 'vs' || entry.kind === 'ps' ? { kind: 'shader', shader: null }
                : { kind: 'const', words: [0] };
        }
        const names = ENUMS[entry.enumeration ?? 'bool'] ?? {};
        const value = literalOf(expr, name=>names[name.toLowerCase()] ?? ENUMS.bool[
            name.toLowerCase()] ?? constantNamed(name));
        if (!value || value.numbers.length === 0)
        {
            messages.push(`${posText(expr)}: warning X4708: '${stateName}': the value is not `
                + 'a literal or a parameter; the state is left out');
            return null;
        }
        return { kind: 'const', words: stateWords(value.numbers, value.float, entry.value) };
    };

    /**
     * The states of a pass or a sampler, resolved against the table.
     *
     * @param {{ name: string, index?: Expr | null, value: Expr, pos?: any }[]} written
     * @param {boolean} inSampler
     * @returns {StateModel[]}
     */
    const statesOf = (written, inSampler)=>written.flatMap(one=>{
        const entry = STATES.get(one.name.toLowerCase());
        if (!entry || (inSampler && entry.kind !== 'sampler' && entry.kind !== 'texture'))
        {
            messages.push(`${posText(one.value)}: warning X4709: '${one.name}': this state is `
                + 'not applied by this layer');
            return [];
        }
        const index = one.index ? literalOf(one.index)?.numbers[0] ?? 0 : -1;
        const from = sourceOf(one.name, one.value, entry);
        if (!from)
        {
            return [];
        }
        return [{ name: one.name, kind: entry.kind, op: entry.op, index, value: entry.value,
            source: from }];
    });

    /** @type {ParamModel[]} */
    const parameters = [];
    for (const g of module.globals)
    {
        if (g.isStatic || g.type.kind === 'void' || g.type.kind === 'error')
        {
            continue;
        }
        const objectInit = objectInits.get(g.decl) ?? null;
        // `string list[] = {...}`: the checker never saw the list, taken out
        // above, so the length it leaves open is the list's. An open length
        // reaching the description would read as four billion elements.
        const type = g.type.kind === 'array' && g.type.length < 0 && objectInit
            ? { ...g.type, length: objectInit.kind === 'initlist' ? objectInit.items.length : 1 }
            : g.type;
        const model = shapeOf(type, g.decl.type, g.name, g.semantic,
            g.mods.includes('shared') ? PARAMETER.SHARED : 0);
        model.annotations = annotationsOf(g.decl.annotations);
        if (g.init)
        {
            const value = module.evaluateConstant(g.init);
            if (value !== undefined)
            {
                const bases = flatBases(g.type);
                setInit(model, wordsOf(flattenValue(value, g.type), bases).map(word=>({ word })));
            }
        }
        else if (objectInit)
        {
            const items = objectInit.kind === 'initlist' ? objectInit.items : [objectInit];
            if (model.type === PT.STRING)
            {
                setInit(model, items.map(item=>({ string: item.kind === 'string'
                    ? item.value : '' })));
            }
            else if (isShader(model.type))
            {
                setInit(model, items.map(item=>({ shader: item.kind === 'compile'
                    ? shaderFor(item) : null })));
            }
            else if (isSampler(model.type))
            {
                setSamplers(model, items.map(item=>(item.kind === 'samplerstate'
                    ? statesOf(item.entries, true) : null)));
            }
        }
        parameters.push(model);
    }

    /** @type {TechniqueModel[]} */
    const techniques = module.techniques.map(t=>({
        name: t.name,
        annotations: annotationsOf(t.annotations),
        passes: t.passes.map(p=>({ name: p.name, annotations: annotationsOf(p.annotations),
            states: statesOf(p.states, false) })),
    }));

    /** @type {string[]} */
    const functions = [];
    for (const decl of program.decls)
    {
        if (decl.kind === 'function' && decl.body && !functions.includes(decl.name))
        {
            functions.push(decl.name);
        }
    }

    if (options.compile !== false)
    {
        for (const { index, args } of pending)
        {
            const shader = shaders[index];
            const result = await compileShader(source, { profile: shader.profile,
                entry: shader.entry, flags, defines: options.defines, arguments: args,
                include: (name, system)=>files.find(f=>f.name === name && f.system === system)
                    ?.text ?? files.find(f=>f.name === name)?.text ?? null });
            shader.tokens = result.ok ? result.tokens : null;
            shader.constantTable = result.ok ? result.constantTable : null;
            shader.messages = result.messages;
            options.compiled?.({ profile: shader.profile, entry: shader.entry,
                messages: result.messages, tokens: shader.tokens });
            // A shader that does not compile leaves its technique invalid rather than the
            // effect unmade: its errors are told as warnings of the effect.
            for (const line of result.messages.split('\n'))
            {
                const told = line.replace(' error ', ' warning ');
                if (line !== '' && !messages.includes(told))
                {
                    messages.push(told);
                }
            }
        }
    }

    return { model: { parameters, techniques, functions, shaders },
        messages: messages.map(m=>`${m}\n`).join(''), files };
}

/**
 * The name of what an expression reads, as a parameter's full name: `a`, `a[1]`,
 * `a.b`, `<a>`, `(a)`; null for anything else.
 *
 * @param {Expr} expr
 * @returns {string | null}
 */
function pathOf(expr){
    switch (expr.kind)
    {
        case 'ident':
        case 'texref':
            return expr.name;
        case 'index': {
            const object = pathOf(expr.object);
            const index = literalOf(expr.index);
            return object !== null && index && index.numbers.length === 1
                ? `${object}[${index.numbers[0]}]` : null;
        }
        case 'member': {
            const object = pathOf(expr.object);
            return object === null ? null : `${object}.${expr.name}`;
        }
        case 'comma':
            return expr.exprs.length === 1 ? pathOf(expr.exprs[0]) : null;
        default:
            return null;
    }
}

/** Where an expression is, as a message gives it. @param {any} expr */
function posText(expr){
    const pos = expr?.pos;
    return pos ? `${pos.file}(${pos.line},${pos.col})` : 'memory';
}

/**
 * Whether a technique can run here: every shader its passes compile compiled.
 *
 * @param {EffectModel} model @param {TechniqueModel} technique
 */
export function techniqueCompiles(model, technique){
    return technique.passes.every(pass=>pass.states.every(state=>
        state.source.kind !== 'shader' || state.source.shader === null
        || model.shaders[state.source.shader].tokens !== null));
}
