/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What GLSL 1.20 declares before the first line of a shader (sections 7 and
 * 8 of the language specification): the built-in functions with every
 * overload, the built-in variables of each stage, the state uniforms and
 * their structs, and the implementation's constants.
 *
 * The limits are this implementation's and are answered by glGetIntegerv
 * too (`GLSL_LIMITS`), so a shader that sizes an array by
 * gl_MaxTextureCoords and a program that asks GL_MAX_TEXTURE_COORDS agree.
 */

import {
    BOOL, FLOAT, INT, VOID, arrayOf, basicType, matrixOf, vectorOf,
} from './glsl-types.js';

/** @typedef {import('./glsl-types.js').GlslType} GlslType */

/** The implementation's limits, as the shading language and the GL both report them. */
export const GLSL_LIMITS = Object.freeze({
    lights: 8,
    clipPlanes: 6,
    textureUnits: 4,
    textureCoords: 8,
    vertexAttribs: 16,
    vertexUniformComponents: 1024,
    varyingFloats: 32,
    vertexTextureImageUnits: 8,
    combinedTextureImageUnits: 8,
    textureImageUnits: 8,
    fragmentUniformComponents: 1024,
    drawBuffers: 4,
});

/**
 * @typedef {Object} BuiltinOverload
 * @property {string} name
 * @property {GlslType[]} params
 * @property {GlslType} returns
 * @property {'vertex' | 'fragment' | null} stage  the one stage that has it, or null
 */

/** @type {Map<string, BuiltinOverload[]>} */
export const BUILTIN_FUNCTIONS = new Map();

/**
 * @param {string} name @param {GlslType} returns @param {GlslType[]} params
 * @param {'vertex' | 'fragment' | null} [stage]
 */
const add = (name, returns, params, stage = null)=>{
    let list = BUILTIN_FUNCTIONS.get(name);
    if (!list)
    {
        list = [];
        BUILTIN_FUNCTIONS.set(name, list);
    }
    list.push({ name, params, returns, stage });
};

const GEN = [FLOAT, vectorOf('float', 2), vectorOf('float', 3), vectorOf('float', 4)];
const VEC = GEN.slice(1);
const IVEC = [2, 3, 4].map(n=>vectorOf('int', n));
const BVEC = [2, 3, 4].map(n=>vectorOf('bool', n));
const VEC2 = vectorOf('float', 2);
const VEC3 = vectorOf('float', 3);
const VEC4 = vectorOf('float', 4);
/** @param {string} name */
const named = name=>/** @type {GlslType} */ (basicType(name));

// 8.1 angles and trigonometry; 8.2 exponentials
for (const name of ['radians', 'degrees', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'exp',
    'log', 'exp2', 'log2', 'sqrt', 'inversesqrt', 'abs', 'sign', 'floor', 'ceil', 'fract',
    'normalize', 'dFdx', 'dFdy', 'fwidth'])
{
    const stage = name === 'dFdx' || name === 'dFdy' || name === 'fwidth' ? 'fragment' : null;
    for (const g of GEN)
    {
        add(name, g, [g], stage);
    }
}
for (const g of GEN)
{
    add('atan', g, [g, g]);
    add('pow', g, [g, g]);
    // 8.3 common functions
    add('mod', g, [g, FLOAT]);
    add('min', g, [g, FLOAT]);
    add('max', g, [g, FLOAT]);
    add('clamp', g, [g, FLOAT, FLOAT]);
    add('mix', g, [g, g, FLOAT]);
    add('step', g, [FLOAT, g]);
    add('smoothstep', g, [FLOAT, FLOAT, g]);
    if (g !== FLOAT)
    {
        add('mod', g, [g, g]);
        add('min', g, [g, g]);
        add('max', g, [g, g]);
        add('clamp', g, [g, g, g]);
        add('mix', g, [g, g, g]);
        add('step', g, [g, g]);
        add('smoothstep', g, [g, g, g]);
    }
    // 8.4 geometry
    add('length', FLOAT, [g]);
    add('distance', FLOAT, [g, g]);
    add('dot', FLOAT, [g, g]);
    add('faceforward', g, [g, g, g]);
    add('reflect', g, [g, g]);
    add('refract', g, [g, g, FLOAT]);
    // 8.9 noise
    add('noise1', FLOAT, [g]);
    add('noise2', VEC2, [g]);
    add('noise3', VEC3, [g]);
    add('noise4', VEC4, [g]);
}
add('cross', VEC3, [VEC3, VEC3]);
add('ftransform', VEC4, [], 'vertex');
// 8.5 matrices
for (const cols of [2, 3, 4])
{
    for (const rows of [2, 3, 4])
    {
        const m = matrixOf(cols, rows);
        add('matrixCompMult', m, [m, m]);
        add('transpose', matrixOf(rows, cols), [m]);
        add('outerProduct', m, [vectorOf('float', rows), vectorOf('float', cols)]);
    }
}
// 8.6 vector relations
for (let k = 0; k < 3; k++)
{
    for (const name of ['lessThan', 'lessThanEqual', 'greaterThan', 'greaterThanEqual'])
    {
        add(name, BVEC[k], [VEC[k], VEC[k]]);
        add(name, BVEC[k], [IVEC[k], IVEC[k]]);
    }
    for (const name of ['equal', 'notEqual'])
    {
        add(name, BVEC[k], [VEC[k], VEC[k]]);
        add(name, BVEC[k], [IVEC[k], IVEC[k]]);
        add(name, BVEC[k], [BVEC[k], BVEC[k]]);
    }
    add('any', BOOL, [BVEC[k]]);
    add('all', BOOL, [BVEC[k]]);
    add('not', BVEC[k], [BVEC[k]]);
}
// 8.7 texture lookups: the bias forms are the fragment stage's, the Lod
// forms the vertex stage's.
/**
 * @param {string} name @param {string} sampler @param {GlslType[]} coords
 * @param {GlslType} returns
 */
const lookup = (name, sampler, coords, returns = VEC4)=>{
    for (const coord of coords)
    {
        add(name, returns, [named(sampler), coord]);
        add(name, returns, [named(sampler), coord, FLOAT], 'fragment');
        add(`${name}Lod`, returns, [named(sampler), coord, FLOAT], 'vertex');
    }
};
lookup('texture1D', 'sampler1D', [FLOAT]);
lookup('texture1DProj', 'sampler1D', [VEC2, VEC4]);
lookup('texture2D', 'sampler2D', [VEC2]);
lookup('texture2DProj', 'sampler2D', [VEC3, VEC4]);
lookup('texture3D', 'sampler3D', [VEC3]);
lookup('texture3DProj', 'sampler3D', [VEC4]);
lookup('textureCube', 'samplerCube', [VEC3]);
lookup('shadow1D', 'sampler1DShadow', [VEC3]);
lookup('shadow2D', 'sampler2DShadow', [VEC3]);
lookup('shadow1DProj', 'sampler1DShadow', [VEC4]);
lookup('shadow2DProj', 'sampler2DShadow', [VEC4]);

// --- the state structs (section 7.5) ---

let structIds = -1;
/** @param {string} name @param {[string, GlslType][]} fields */
const struct = (name, fields)=>Object.freeze({
    kind: /** @type {'struct'} */ ('struct'), name, id: structIds--,
    fields: fields.map(([fieldName, type])=>({ name: fieldName, type })),
});

export const BUILTIN_STRUCTS = Object.freeze({
    depthRange: struct('gl_DepthRangeParameters', [['near', FLOAT], ['far', FLOAT],
        ['diff', FLOAT]]),
    point: struct('gl_PointParameters', [['size', FLOAT], ['sizeMin', FLOAT],
        ['sizeMax', FLOAT], ['fadeThresholdSize', FLOAT],
        ['distanceConstantAttenuation', FLOAT], ['distanceLinearAttenuation', FLOAT],
        ['distanceQuadraticAttenuation', FLOAT]]),
    material: struct('gl_MaterialParameters', [['emission', VEC4], ['ambient', VEC4],
        ['diffuse', VEC4], ['specular', VEC4], ['shininess', FLOAT]]),
    light: struct('gl_LightSourceParameters', [['ambient', VEC4], ['diffuse', VEC4],
        ['specular', VEC4], ['position', VEC4], ['halfVector', VEC4], ['spotDirection', VEC3],
        ['spotExponent', FLOAT], ['spotCutoff', FLOAT], ['spotCosCutoff', FLOAT],
        ['constantAttenuation', FLOAT], ['linearAttenuation', FLOAT],
        ['quadraticAttenuation', FLOAT]]),
    lightModel: struct('gl_LightModelParameters', [['ambient', VEC4]]),
    lightModelProducts: struct('gl_LightModelProducts', [['sceneColor', VEC4]]),
    lightProducts: struct('gl_LightProducts', [['ambient', VEC4], ['diffuse', VEC4],
        ['specular', VEC4]]),
    fog: struct('gl_FogParameters', [['color', VEC4], ['density', FLOAT], ['start', FLOAT],
        ['end', FLOAT], ['scale', FLOAT]]),
});

/**
 * @typedef {Object} BuiltinVariable
 * @property {GlslType} type
 * @property {'uniform' | 'attribute' | 'in' | 'out' | 'const'} role
 *     what the program reads it as: state, a vertex's attribute, the stage's
 *     input, its output (which the stage may read back), or a constant
 * @property {number[]} [value]  a constant's
 */

const MAT2 = matrixOf(2, 2);
const MAT3 = matrixOf(3, 3);
const MAT4 = matrixOf(4, 4);
const L = GLSL_LIMITS;

/** @type {Record<string, BuiltinVariable>} */
const COMMON = {
    gl_MaxLights: { type: INT, role: 'const', value: [L.lights] },
    gl_MaxClipPlanes: { type: INT, role: 'const', value: [L.clipPlanes] },
    gl_MaxTextureUnits: { type: INT, role: 'const', value: [L.textureUnits] },
    gl_MaxTextureCoords: { type: INT, role: 'const', value: [L.textureCoords] },
    gl_MaxVertexAttribs: { type: INT, role: 'const', value: [L.vertexAttribs] },
    gl_MaxVertexUniformComponents: { type: INT, role: 'const',
        value: [L.vertexUniformComponents] },
    gl_MaxVaryingFloats: { type: INT, role: 'const', value: [L.varyingFloats] },
    gl_MaxVertexTextureImageUnits: { type: INT, role: 'const',
        value: [L.vertexTextureImageUnits] },
    gl_MaxCombinedTextureImageUnits: { type: INT, role: 'const',
        value: [L.combinedTextureImageUnits] },
    gl_MaxTextureImageUnits: { type: INT, role: 'const', value: [L.textureImageUnits] },
    gl_MaxFragmentUniformComponents: { type: INT, role: 'const',
        value: [L.fragmentUniformComponents] },
    gl_MaxDrawBuffers: { type: INT, role: 'const', value: [L.drawBuffers] },
    gl_ModelViewMatrix: { type: MAT4, role: 'uniform' },
    gl_ProjectionMatrix: { type: MAT4, role: 'uniform' },
    gl_ModelViewProjectionMatrix: { type: MAT4, role: 'uniform' },
    gl_TextureMatrix: { type: arrayOf(MAT4, L.textureCoords), role: 'uniform' },
    gl_NormalMatrix: { type: MAT3, role: 'uniform' },
    gl_NormalScale: { type: FLOAT, role: 'uniform' },
    gl_DepthRange: { type: BUILTIN_STRUCTS.depthRange, role: 'uniform' },
    gl_ClipPlane: { type: arrayOf(VEC4, L.clipPlanes), role: 'uniform' },
    gl_Point: { type: BUILTIN_STRUCTS.point, role: 'uniform' },
    gl_FrontMaterial: { type: BUILTIN_STRUCTS.material, role: 'uniform' },
    gl_BackMaterial: { type: BUILTIN_STRUCTS.material, role: 'uniform' },
    gl_LightSource: { type: arrayOf(BUILTIN_STRUCTS.light, L.lights), role: 'uniform' },
    gl_LightModel: { type: BUILTIN_STRUCTS.lightModel, role: 'uniform' },
    gl_FrontLightModelProduct: { type: BUILTIN_STRUCTS.lightModelProducts, role: 'uniform' },
    gl_BackLightModelProduct: { type: BUILTIN_STRUCTS.lightModelProducts, role: 'uniform' },
    gl_FrontLightProduct: { type: arrayOf(BUILTIN_STRUCTS.lightProducts, L.lights),
        role: 'uniform' },
    gl_BackLightProduct: { type: arrayOf(BUILTIN_STRUCTS.lightProducts, L.lights),
        role: 'uniform' },
    gl_TextureEnvColor: { type: arrayOf(VEC4, L.textureUnits), role: 'uniform' },
    gl_EyePlaneS: { type: arrayOf(VEC4, L.textureCoords), role: 'uniform' },
    gl_EyePlaneT: { type: arrayOf(VEC4, L.textureCoords), role: 'uniform' },
    gl_EyePlaneR: { type: arrayOf(VEC4, L.textureCoords), role: 'uniform' },
    gl_EyePlaneQ: { type: arrayOf(VEC4, L.textureCoords), role: 'uniform' },
    gl_ObjectPlaneS: { type: arrayOf(VEC4, L.textureCoords), role: 'uniform' },
    gl_ObjectPlaneT: { type: arrayOf(VEC4, L.textureCoords), role: 'uniform' },
    gl_ObjectPlaneR: { type: arrayOf(VEC4, L.textureCoords), role: 'uniform' },
    gl_ObjectPlaneQ: { type: arrayOf(VEC4, L.textureCoords), role: 'uniform' },
    gl_Fog: { type: BUILTIN_STRUCTS.fog, role: 'uniform' },
};
for (const name of ['gl_ModelViewMatrix', 'gl_ProjectionMatrix', 'gl_ModelViewProjectionMatrix',
    'gl_TextureMatrix'])
{
    for (const modifier of ['Inverse', 'Transpose', 'InverseTranspose'])
    {
        COMMON[`${name}${modifier}`] = { type: COMMON[name].type, role: 'uniform' };
    }
}

/** The built-in variables of each stage, by name. */
export const BUILTIN_VARIABLES = Object.freeze({
    /** @type {Record<string, BuiltinVariable>} */
    vertex: {
        ...COMMON,
        gl_Position: { type: VEC4, role: 'out' },
        gl_PointSize: { type: FLOAT, role: 'out' },
        gl_ClipVertex: { type: VEC4, role: 'out' },
        gl_Color: { type: VEC4, role: 'attribute' },
        gl_SecondaryColor: { type: VEC4, role: 'attribute' },
        gl_Normal: { type: VEC3, role: 'attribute' },
        gl_Vertex: { type: VEC4, role: 'attribute' },
        ...Object.fromEntries(Array.from({ length: 8 }, (_, unit)=>[`gl_MultiTexCoord${unit}`,
            { type: VEC4, role: 'attribute' }])),
        gl_FogCoord: { type: FLOAT, role: 'attribute' },
        gl_FrontColor: { type: VEC4, role: 'out' },
        gl_BackColor: { type: VEC4, role: 'out' },
        gl_FrontSecondaryColor: { type: VEC4, role: 'out' },
        gl_BackSecondaryColor: { type: VEC4, role: 'out' },
        gl_TexCoord: { type: arrayOf(VEC4, L.textureCoords), role: 'out' },
        gl_FogFragCoord: { type: FLOAT, role: 'out' },
    },
    /** @type {Record<string, BuiltinVariable>} */
    fragment: {
        ...COMMON,
        gl_FragCoord: { type: VEC4, role: 'in' },
        gl_FrontFacing: { type: BOOL, role: 'in' },
        gl_FragColor: { type: VEC4, role: 'out' },
        gl_FragData: { type: arrayOf(VEC4, L.drawBuffers), role: 'out' },
        gl_FragDepth: { type: FLOAT, role: 'out' },
        gl_PointCoord: { type: VEC2, role: 'in' },
        gl_Color: { type: VEC4, role: 'in' },
        gl_SecondaryColor: { type: VEC4, role: 'in' },
        gl_TexCoord: { type: arrayOf(VEC4, L.textureCoords), role: 'in' },
        gl_FogFragCoord: { type: FLOAT, role: 'in' },
    },
});

/** The conventional attribute each built-in attribute reads, by the layout's names. */
export const BUILTIN_ATTRIBUTES = Object.freeze({
    gl_Vertex: 'position',
    gl_Color: 'color',
    gl_SecondaryColor: 'secondary',
    gl_Normal: 'normal',
    gl_FogCoord: 'fogCoord',
    ...Object.fromEntries(Array.from({ length: 8 }, (_, unit)=>[`gl_MultiTexCoord${unit}`,
        `texCoord${unit}`])),
});

export { VOID, MAT2 };
