/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a version and profile of the language has: its keywords, the words it
 * reserves, and the features each version brought, so that the parser and
 * the checker ask one question ("does this shader's language have it?")
 * rather than comparing version numbers in a hundred places.
 *
 * The profiles (section 3.3): a 1.50 and later shader is core unless its
 * #version says compatibility, and a core shader has none of what the
 * specification marks "compatibility profile only" -- `attribute`,
 * `varying`, gl_FragColor, the fixed-function state and the texture2D()
 * family. Before 1.50 there are no profiles: 1.30 deprecated those features
 * and 1.40 kept them for ARB_compatibility, which this implementation has,
 * so both compile them.
 */

import { typeNames, typeSince } from './glsl-types.js';

/**
 * @typedef {'vertex' | 'tessControl' | 'tessEvaluation' | 'geometry' | 'fragment'
 *     | 'compute'} Stage
 */

/** The version each feature came with. */
const FEATURES = Object.freeze({
    /** `in` and `out` at global scope; flat, smooth and noperspective. */
    inOut: 130,
    uint: 130,
    switch: 130,
    /** %, <<, >>, &, |, ^ and ~. */
    bitwise: 130,
    /** texture(), texelFetch() and the other overloaded lookups. */
    texture: 130,
    /** A function's prototype must come before its call; 1.30 dropped nothing else. */
    uniformBlocks: 140,
    layout: 140,
    geometry: 150,
    /** Blocks for a stage's inputs and outputs. */
    ioBlocks: 150,
    explicitLocation: 330,
    /** A fragment output's `layout(index)`: the blend's second source. */
    dualSource: 330,
    double: 400,
    tessellation: 400,
    subroutine: 400,
    /** gl_SampleID, gl_SamplePosition and gl_SampleMask. */
    sampleShading: 400,
    /**
     * A geometry shader's invocations and streams, gl_SampleMaskIn, arrays
     * of samplers indexed at run time, and calls taking the best of several
     * overloads, an out parameter converting back to its argument.
     */
    gpuShader5: 400,
    /** A geometry shader's gl_ViewportIndex. */
    viewportArray: 410,
    /** Locations on every stage's inputs and outputs. */
    separateShaders: 410,
    /** int converts to uint, and anything numeric to double, implicitly. */
    implicitUint: 400,
    gather: 400,
    images: 420,
    atomicCounters: 420,
    /** A fragment shader's depth layouts (depth_greater and the others). */
    conservativeDepth: 420,
    binding: 420,
    /** const parameters and the .length() of vectors and matrices. */
    shadingLanguage420pack: 420,
    shaderStorage: 430,
    compute: 430,
    arraysOfArrays: 430,
    explicitUniformLocation: 430,
    /** A fragment shader's gl_Layer and gl_ViewportIndex. */
    fragmentLayerViewport: 430,
    /** offset, align, component and the xfb_ qualifiers. */
    enhancedLayouts: 440,
    cullDistance: 450,
    derivativeControl: 450,
    drawParameters: 460,
});

/** @typedef {keyof typeof FEATURES} Feature */

/**
 * @typedef {Object} ExtensionGift
 * @property {Feature[]} [features]
 * @property {string[]} [keywords]  words it makes keywords, types among them
 * @property {string[]} [functions]  later versions' built-in functions it
 *     brings, every overload of each (`glsl-library.js`); its own functions
 *     and variables are the library's too
 */

/**
 * What each extension a shader may enable (section 3.3) brings to a version
 * before the one that made it core: only what this implementation has of it,
 * so that an extension half here still compiles the half a shader uses.
 * Which of them the context reports is `extensions.js`'s to say.
 *
 * @type {Readonly<Record<string, ExtensionGift>>}
 */
export const GLSL_EXTENSIONS = Object.freeze({
    GL_ARB_uniform_buffer_object: { features: ['uniformBlocks', 'layout'], keywords: ['layout'] },
    GL_ARB_explicit_attrib_location: { features: ['explicitLocation', 'layout'],
        keywords: ['layout'] },
    GL_ARB_blend_func_extended: { features: ['dualSource', 'layout'], keywords: ['layout'] },
    // gl_InstanceIDARB (glsl-library.js).
    GL_ARB_draw_instanced: {},
    // Of its integer language: the bit operators, gl_VertexID and
    // gl_InstanceID; not its `unsigned int`, its integer samplers or its
    // texelFetch2D() family.
    GL_EXT_gpu_shader4: { features: ['bitwise'] },
    // Its samplers and texture2DRect() family (glsl-library.js).
    GL_ARB_texture_rectangle: { keywords: ['sampler2DRect', 'sampler2DRectShadow'] },
    GL_ARB_shading_language_packing: { functions: ['packSnorm2x16', 'unpackSnorm2x16',
        'packUnorm2x16', 'unpackUnorm2x16', 'packHalf2x16', 'unpackHalf2x16', 'packUnorm4x8',
        'unpackUnorm4x8', 'packSnorm4x8', 'unpackSnorm4x8'] },
    GL_ARB_gpu_shader5: { features: ['implicitUint', 'gather', 'gpuShader5'],
        keywords: ['precise', 'sample'],
        functions: ['bitfieldReverse', 'bitCount', 'findLSB', 'findMSB', 'fma',
            'packUnorm2x16', 'unpackUnorm2x16', 'packUnorm4x8', 'unpackUnorm4x8',
            'packSnorm4x8', 'unpackSnorm4x8', 'bitfieldExtract', 'bitfieldInsert', 'uaddCarry',
            'usubBorrow', 'umulExtended', 'imulExtended', 'frexp', 'ldexp', 'textureGather',
            'textureGatherOffset', 'textureGatherOffsets', 'interpolateAtCentroid',
            'interpolateAtSample', 'interpolateAtOffset', 'EmitStreamVertex',
            'EndStreamPrimitive'] },
    GL_ARB_texture_gather: { features: ['gather'],
        functions: ['textureGather', 'textureGatherOffset'] },
    GL_ARB_texture_cube_map_array: { keywords: ['samplerCubeArray', 'samplerCubeArrayShadow',
        'isamplerCubeArray', 'usamplerCubeArray'] },
    GL_ARB_gpu_shader_fp64: { features: ['double'],
        keywords: ['double', 'dvec2', 'dvec3', 'dvec4', 'dmat2', 'dmat3', 'dmat4', 'dmat2x2',
            'dmat2x3', 'dmat2x4', 'dmat3x2', 'dmat3x3', 'dmat3x4', 'dmat4x2', 'dmat4x3',
            'dmat4x4'],
        functions: ['packDouble2x32', 'unpackDouble2x32'] },
    GL_ARB_shader_subroutine: { features: ['subroutine'], keywords: ['subroutine'] },
    GL_ARB_tessellation_shader: { features: ['tessellation'], keywords: ['patch'],
        functions: ['barrier'] },
    GL_ARB_sample_shading: { features: ['sampleShading'] },
    GL_ARB_viewport_array: { features: ['viewportArray'] },
    GL_ARB_fragment_layer_viewport: { features: ['fragmentLayerViewport'] },
    GL_ARB_separate_shader_objects: { features: ['separateShaders', 'layout'],
        keywords: ['layout'] },
    GL_ARB_shading_language_420pack: { features: ['shadingLanguage420pack', 'binding',
        'layout'], keywords: ['layout'] },
    GL_ARB_explicit_uniform_location: { features: ['explicitUniformLocation', 'layout'],
        keywords: ['layout'] },
    GL_ARB_conservative_depth: { features: ['conservativeDepth', 'layout'],
        keywords: ['layout'] },
    GL_ARB_shader_image_load_store: { features: ['images', 'layout'],
        keywords: ['layout', 'coherent', 'volatile', 'restrict', 'readonly', 'writeonly',
            ...typeNames().filter(name=>/^[iu]?image/.test(name))],
        functions: ['imageLoad', 'imageStore', 'imageAtomicAdd', 'imageAtomicMin',
            'imageAtomicMax', 'imageAtomicAnd', 'imageAtomicOr', 'imageAtomicXor',
            'imageAtomicExchange', 'imageAtomicCompSwap', 'memoryBarrier'] },
    GL_ARB_shader_atomic_counters: { features: ['atomicCounters', 'layout'],
        keywords: ['layout', 'atomic_uint'],
        functions: ['atomicCounterIncrement', 'atomicCounterDecrement', 'atomicCounter'] },
    GL_ARB_shader_storage_buffer_object: { features: ['shaderStorage', 'layout'],
        keywords: ['layout', 'buffer', 'coherent', 'volatile', 'restrict', 'readonly',
            'writeonly'],
        functions: ['atomicAdd', 'atomicMin', 'atomicMax', 'atomicAnd', 'atomicOr', 'atomicXor',
            'atomicExchange', 'atomicCompSwap', 'memoryBarrierBuffer'] },
    GL_ARB_compute_shader: { features: ['compute', 'layout'], keywords: ['layout', 'shared'],
        functions: ['barrier', 'memoryBarrierShared', 'groupMemoryBarrier',
            'memoryBarrierAtomicCounter', 'memoryBarrierBuffer', 'memoryBarrierImage'] },
    GL_ARB_arrays_of_arrays: { features: ['arraysOfArrays'] },
    GL_ARB_enhanced_layouts: { features: ['enhancedLayouts', 'layout'], keywords: ['layout'] },
    GL_ARB_cull_distance: { features: ['cullDistance'] },
    GL_ARB_derivative_control: { functions: ['dFdxFine', 'dFdyFine', 'dFdxCoarse',
        'dFdyCoarse', 'fwidthFine', 'fwidthCoarse'] },
    GL_ARB_texture_query_levels: { functions: ['textureQueryLevels'] },
    // textureQueryLOD, the extension's spelling of 4.00's (glsl-library.js).
    GL_ARB_texture_query_lod: {},
    // gl_BaseVertexARB, gl_BaseInstanceARB and gl_DrawIDARB (glsl-library.js).
    GL_ARB_shader_draw_parameters: {},
    GL_ARB_shader_bit_encoding: { functions: ['floatBitsToInt', 'floatBitsToUint',
        'intBitsToFloat', 'uintBitsToFloat'] },
    GL_ARB_shader_texture_image_samples: { functions: ['textureSamples', 'imageSamples'] },
    // anyInvocationARB and the others, 4.60's under the extension's names.
    GL_ARB_shader_group_vote: {},
});

/** The keywords every version has (section 3.6). */
const BASE_KEYWORDS = ['attribute', 'const', 'uniform', 'varying', 'centroid', 'break',
    'continue', 'do', 'for', 'while', 'if', 'else', 'in', 'out', 'inout', 'true', 'false',
    'invariant', 'discard', 'return', 'struct', 'lowp', 'mediump', 'highp', 'precision'];

/** The keywords later versions added, with the version. */
const LATER_KEYWORDS = /** @type {[string, number][]} */ ([
    ['flat', 130], ['smooth', 130], ['noperspective', 130], ['switch', 130], ['case', 130],
    ['default', 130], ['layout', 140], ['patch', 400], ['sample', 400], ['subroutine', 400],
    ['precise', 400], ['coherent', 420], ['volatile', 420], ['restrict', 420],
    ['readonly', 420], ['writeonly', 420], ['buffer', 430], ['shared', 430],
]);

/** What 1.10 and 1.20 reserve (section 3.6 of 1.20). */
const RESERVED_1X = ['asm', 'class', 'union', 'enum', 'typedef', 'template', 'this', 'packed',
    'goto', 'switch', 'default', 'inline', 'noinline', 'volatile', 'public', 'static', 'extern',
    'external', 'interface', 'long', 'short', 'double', 'half', 'fixed', 'unsigned', 'input',
    'output', 'hvec2', 'hvec3', 'hvec4', 'dvec2', 'dvec3', 'dvec4', 'fvec2', 'fvec3', 'fvec4',
    'sampler2DRect', 'sampler3DRect', 'sampler2DRectShadow', 'sizeof', 'cast', 'namespace',
    'using', 'case'];

/** What 1.30 and later reserve for future use (section 3.6 of 4.60). */
const RESERVED = ['common', 'partition', 'active', 'asm', 'class', 'union', 'enum', 'typedef',
    'template', 'this', 'resource', 'goto', 'inline', 'noinline', 'public', 'static', 'extern',
    'external', 'interface', 'long', 'short', 'half', 'fixed', 'unsigned', 'superp', 'input',
    'output', 'hvec2', 'hvec3', 'hvec4', 'fvec2', 'fvec3', 'fvec4', 'filter', 'sizeof', 'cast',
    'namespace', 'using', 'sampler3DRect'];

/**
 * Words reserved until the version that made them keywords or types: the
 * ones the earlier specifications listed, so that a 1.30 shader naming a
 * variable `double` fails as one did then.
 *
 * @type {[string, number][]}
 */
const RESERVED_UNTIL = [
    ['packed', 140], ['volatile', 420], ['double', 400], ['dvec2', 400], ['dvec3', 400],
    ['dvec4', 400], ['dmat2', 400], ['dmat3', 400], ['dmat4', 400], ['sampler2DRect', 140],
    ['sampler2DRectShadow', 140], ['samplerBuffer', 140], ['sampler2DMS', 150],
    ['image1D', 420], ['image2D', 420], ['image3D', 420], ['imageCube', 420],
    ['imageBuffer', 420], ['image1DArray', 420], ['image2DArray', 420],
    ['iimage1D', 420], ['iimage2D', 420], ['uimage1D', 420], ['uimage2D', 420],
];

/**
 * @typedef {Object} Language
 * @property {number} version
 * @property {'core' | 'compatibility' | null} profile  null before 1.50
 * @property {boolean} compatibility  whether the compatibility profile's
 *     features are there: before 1.50 always, after it as #version says
 * @property {ReadonlySet<string>} keywords  the words that are not names, the
 *     types of the version among them
 * @property {ReadonlySet<string>} reserved  words no shader may use
 * @property {(feature: Feature) => boolean} has
 * @property {ReadonlySet<string>} extensions  the extensions #extension enabled
 * @property {ReadonlySet<string>} functions  the later built-in functions those
 *     extensions brought
 */

/** @type {Map<string, Language>} */
const MADE = new Map();

/**
 * @param {number} version
 * @param {'core' | 'compatibility' | null} [profile]  null before 1.50
 * @param {Iterable<string>} [extensions]
 * @returns {Language}
 */
export function languageOf(version, profile = null, extensions = []){
    const enabled = new Set([...extensions].filter(name=>name in GLSL_EXTENSIONS));
    const gifts = [...enabled].map(name=>GLSL_EXTENSIONS[name]);
    const features = new Set(gifts.flatMap(gift=>gift.features ?? []));
    const key = `${version}:${profile}:${[...enabled].sort().join(',')}`;
    const known = MADE.get(key);
    if (known)
    {
        return known;
    }
    const keywords = new Set([...BASE_KEYWORDS,
        ...LATER_KEYWORDS.filter(([, since])=>since <= version).map(([word])=>word),
        ...typeNames().filter(name=>(typeSince(name) ?? Infinity) <= version),
        ...gifts.flatMap(gift=>gift.keywords ?? [])]);
    const reserved = new Set(version < 130 ? RESERVED_1X : [...RESERVED,
        ...RESERVED_UNTIL.filter(([, until])=>version < until).map(([word])=>word)]);
    for (const word of keywords)
    {
        reserved.delete(word);
    }
    /** @type {Language} */
    const language = Object.freeze({
        version,
        profile: version >= 150 ? profile ?? 'core' : null,
        compatibility: version < 150 || profile === 'compatibility',
        keywords, reserved, extensions: enabled,
        functions: new Set(gifts.flatMap(gift=>gift.functions ?? [])),
        has: (/** @type {Feature} */ feature)=>FEATURES[feature] <= version
            || features.has(feature),
    });
    MADE.set(key, language);
    return language;
}

/** The version a feature came with. @param {Feature} feature */
export const featureSince = feature=>FEATURES[feature];

/**
 * The stages a version compiles: tessellation from 4.00, geometry from 1.50,
 * compute from 4.30.
 *
 * @param {Stage} stage @param {Language} language
 */
export function hasStage(stage, language){
    switch (stage)
    {
        case 'geometry':
            return language.has('geometry');
        case 'tessControl':
        case 'tessEvaluation':
            return language.has('tessellation');
        case 'compute':
            return language.has('compute');
        default:
            return true;
    }
}
