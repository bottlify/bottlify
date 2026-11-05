/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Shader Model 4 to WGSL.
 *
 * The translation keeps the shader's own register model rather than inventing
 * a nicer one: every register is a `vec4<u32>` of bit patterns, and each
 * instruction reinterprets what it reads as the type the instruction is
 * defined over. That is not a stylistic choice. A Shader Model 4 register is
 * untyped by definition -- a program moves an integer comparison result into a
 * register and multiplies it as a float three instructions later -- and a
 * translator that assigns registers a type has to guess, and guesses wrong on
 * exactly the shaders that do interesting things. Bit patterns are kept in an
 * unsigned register because a float register can lose them: a comparison
 * result is all ones, all ones is a NaN when read as a float, and a NaN
 * stored in a float is not required to keep its payload.
 *
 * The other decision worth stating is how a vertex shader meets a pixel
 * shader. Direct3D links the two by semantic name, never by register: `COLOR0`
 * in one is `COLOR0` in the other whatever register each compiler chose. So a
 * shader is translated to a body that reads and writes named registers, and the
 * entry point around it -- the struct with the `@location` attributes -- is
 * written when a pair is linked, giving both halves the same numbering. The
 * body is the shader's; the interface is the pair's.
 *
 * What a first cut does not carry is listed rather than approximated: an
 * instruction this file has no translation for makes the whole shader
 * untranslatable, and the draw that would have used it is refused by name. A
 * plausible substitute would render a picture that is wrong in a way nothing
 * reports, which is the most expensive kind of wrong there is.
 */

import { DXGI_FORMAT } from './constants.js';
import { COMPONENT_TYPE, SHADER_KIND, SYSTEM_VALUE, parseSignature } from './dxbc.js';
import {
    CUSTOMDATA, MODIFIER, OPCODE, OPERAND, RESOURCE_DIMENSION, RETURN_TYPE, SAMPLER_MODE,
    SYNC_FLAG, decodeSm4,
} from './sm4.js';

/** Every register file is thirty-two bit patterns, four to a register. */
const REG = 'vec4<u32>';

const COMPONENT = ['x', 'y', 'z', 'w'];

/** Where each kind of resource is bound within a stage's group. */
export const BINDING = Object.freeze({
    CONSTANT_BUFFER: 0,
    TEXTURE: 16,
    SAMPLER: 144,
    // A buffer bound as a shader resource is storage at its texture binding,
    // and the view over it -- format, first element, element count, element
    // size -- a uniform here.
    BUFFER_VIEW: 160,
    // What a shader writes through (Shader Model 5): a buffer or a storage
    // texture, the view over a buffer as above, and an append counter.
    UAV: 288,
    UAV_VIEW: 352,
    UAV_COUNTER: 416,
});

/** WebGPU's `GPUShaderStage` bits, spelled out so nothing here reads a global. */
export const STAGE = Object.freeze({ VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 });

/** The texel formats a storage texture is written in, by DXGI format; the 32-bit
 *  single-channel ones are also read. */
export const STORAGE_TEXTURE_FORMAT = Object.freeze({
    [DXGI_FORMAT.R32_FLOAT]: 'r32float',
    [DXGI_FORMAT.R32_UINT]: 'r32uint',
    [DXGI_FORMAT.R32_SINT]: 'r32sint',
    [DXGI_FORMAT.R32G32_FLOAT]: 'rg32float',
    [DXGI_FORMAT.R32G32_UINT]: 'rg32uint',
    [DXGI_FORMAT.R32G32_SINT]: 'rg32sint',
    [DXGI_FORMAT.R32G32B32A32_FLOAT]: 'rgba32float',
    [DXGI_FORMAT.R32G32B32A32_UINT]: 'rgba32uint',
    [DXGI_FORMAT.R32G32B32A32_SINT]: 'rgba32sint',
    [DXGI_FORMAT.R16G16B16A16_FLOAT]: 'rgba16float',
    [DXGI_FORMAT.R16G16B16A16_UINT]: 'rgba16uint',
    [DXGI_FORMAT.R16G16B16A16_SINT]: 'rgba16sint',
    [DXGI_FORMAT.R8G8B8A8_UNORM]: 'rgba8unorm',
    [DXGI_FORMAT.R8G8B8A8_SNORM]: 'rgba8snorm',
    [DXGI_FORMAT.R8G8B8A8_UINT]: 'rgba8uint',
    [DXGI_FORMAT.R8G8B8A8_SINT]: 'rgba8sint',
    [DXGI_FORMAT.B8G8R8A8_UNORM]: 'bgra8unorm',
});

/**
 * A typed buffer element written from register bits, by the view's format:
 * the 32-bit-per-channel formats and the packed four-channel ones. The
 * dwords to write and how many; a format this cannot pack writes none.
 */
const STORE_ELEMENT = (()=>{
    const F = DXGI_FORMAT;
    /** @type {[number[], string, number][]} */
    const cases = [
        [[F.R32G32B32A32_FLOAT, F.R32G32B32A32_UINT, F.R32G32B32A32_SINT], 'v', 4],
        [[F.R32G32B32_FLOAT, F.R32G32B32_UINT, F.R32G32B32_SINT], 'v', 3],
        [[F.R32G32_FLOAT, F.R32G32_UINT, F.R32G32_SINT], 'v', 2],
        [[F.R32_FLOAT, F.R32_UINT, F.R32_SINT], 'v', 1],
        [[F.R8G8B8A8_UNORM], `${REG}(pack4x8unorm(bitcast<vec4<f32>>(v)), 0u, 0u, 0u)`, 1],
        [[F.R8G8B8A8_SNORM], `${REG}(pack4x8snorm(bitcast<vec4<f32>>(v)), 0u, 0u, 0u)`, 1],
        [[F.R8G8B8A8_UINT, F.R8G8B8A8_SINT], `${REG}(dot(v & ${REG}(0xffu), `
            + `${REG}(1u, 256u, 65536u, 16777216u)), 0u, 0u, 0u)`, 1],
        [[F.R16G16B16A16_FLOAT], `${REG}(pack2x16float(bitcast<vec4<f32>>(v).xy), `
            + 'pack2x16float(bitcast<vec4<f32>>(v).zw), 0u, 0u)', 2],
        [[F.R16G16B16A16_UINT, F.R16G16B16A16_SINT], `${REG}((v.x & 0xffffu) | (v.y << 16u), `
            + '(v.z & 0xffffu) | (v.w << 16u), 0u, 0u)', 2],
        [[F.R16G16_FLOAT], `${REG}(pack2x16float(bitcast<vec4<f32>>(v).xy), 0u, 0u, 0u)`, 1],
        [[F.R16G16_UINT, F.R16G16_SINT], `${REG}((v.x & 0xffffu) | (v.y << 16u), 0u, 0u, 0u)`,
            1],
    ];
    return [
        `fn storeElement(format: u32, v: ${REG}) -> vec4<u32> {`,
        '    switch (format) {',
        ...cases.map(([formats, value, count])=>`        case ${
            formats.map(format=>`${format}u`).join(', ')}: { let w = ${value}; `
            + `return vec4<u32>(w.x, w.y, w.z, ${count}u); }`),
        '        default: { return vec4<u32>(0u); }',
        '    }',
        '}',
        // The count rides in the fourth word where an element has fewer than
        // four; one of four words is told apart by its format.
        `fn storeElementCount(format: u32) -> u32 {`,
        '    switch (format) {',
        `        case ${[F.R32G32B32A32_FLOAT, F.R32G32B32A32_UINT, F.R32G32B32A32_SINT]
            .map(format=>`${format}u`).join(', ')}: { return 4u; }`,
        '        default: { return storeElement(format, vec4<u32>(0u)).w; }',
        '    }',
        '}',
    ];
})();

/**
 * How a buffer view's element of each format becomes register bits, given
 * the four dwords from the one it starts in (`w`) and, for an element
 * narrower than a dword, the bit it starts at (`s`). A float format answers
 * float bits and an integer one integers; components the format lacks read
 * as zero, and its alpha as one.
 */
function bufferElement(){
    const F = DXGI_FORMAT;
    const ONE = '0x3f800000u';
    /** @param {string} value a vec4<f32> */
    const floats = value=>`bitcast<${REG}>(${value})`;
    /** @param {string} value an i32 */
    const bits = value=>`bitcast<u32>(${value})`;
    /** @param {string} value a u32 holding a 16-bit integer */
    const signed16 = value=>bits(`bitcast<i32>(${value} << 16u) >> 16u`);
    /** @param {string} value a u32 holding an 8-bit integer */
    const signed8 = value=>bits(`bitcast<i32>(${value} << 24u) >> 24u`);
    const half = '((w.x >> s) & 0xffffu)';
    const pair = half;
    const byte = '((w.x >> s) & 0xffu)';
    /** @type {[number[], string][]} */
    const cases = [
        [[F.R32G32B32A32_FLOAT, F.R32G32B32A32_UINT, F.R32G32B32A32_SINT], 'w'],
        [[F.R32G32B32_FLOAT], `${REG}(w.xyz, ${ONE})`],
        [[F.R32G32B32_UINT, F.R32G32B32_SINT], `${REG}(w.xyz, 1u)`],
        [[F.R32G32_FLOAT], `${REG}(w.xy, 0u, ${ONE})`],
        [[F.R32G32_UINT, F.R32G32_SINT], `${REG}(w.xy, 0u, 1u)`],
        [[F.R32_FLOAT], `${REG}(w.x, 0u, 0u, ${ONE})`],
        [[F.R32_UINT, F.R32_SINT], `${REG}(w.x, 0u, 0u, 1u)`],
        [[F.R16G16B16A16_FLOAT],
            floats('vec4<f32>(unpack2x16float(w.x), unpack2x16float(w.y))')],
        [[F.R16G16B16A16_UNORM], floats('vec4<f32>(unpack2x16unorm(w.x), unpack2x16unorm(w.y))')],
        [[F.R16G16B16A16_SNORM], floats('vec4<f32>(unpack2x16snorm(w.x), unpack2x16snorm(w.y))')],
        [[F.R16G16B16A16_UINT], `${REG}(w.x & 0xffffu, w.x >> 16u, w.y & 0xffffu, w.y >> 16u)`],
        [[F.R16G16B16A16_SINT], `${REG}(${signed16('w.x')}, ${bits('bitcast<i32>(w.x) >> 16u')},`
            + ` ${signed16('w.y')}, ${bits('bitcast<i32>(w.y) >> 16u')})`],
        [[F.R16G16_FLOAT], floats('vec4<f32>(unpack2x16float(w.x), 0.0, 1.0)')],
        [[F.R16G16_UNORM], floats('vec4<f32>(unpack2x16unorm(w.x), 0.0, 1.0)')],
        [[F.R16G16_SNORM], floats('vec4<f32>(unpack2x16snorm(w.x), 0.0, 1.0)')],
        [[F.R16G16_UINT], `${REG}(w.x & 0xffffu, w.x >> 16u, 0u, 1u)`],
        [[F.R16G16_SINT],
            `${REG}(${signed16('w.x')}, ${bits('bitcast<i32>(w.x) >> 16u')}, 0u, 1u)`],
        [[F.R16_FLOAT], floats(`vec4<f32>(unpack2x16float(${half}).x, 0.0, 0.0, 1.0)`)],
        [[F.R16_UNORM], floats(`vec4<f32>(unpack2x16unorm(${half}).x, 0.0, 0.0, 1.0)`)],
        [[F.R16_SNORM], floats(`vec4<f32>(unpack2x16snorm(${half}).x, 0.0, 0.0, 1.0)`)],
        [[F.R16_UINT], `${REG}(${half}, 0u, 0u, 1u)`],
        [[F.R16_SINT], `${REG}(${signed16(half)}, 0u, 0u, 1u)`],
        [[F.R8G8B8A8_UNORM], floats('unpack4x8unorm(w.x)')],
        [[F.B8G8R8A8_UNORM], floats('unpack4x8unorm(w.x).zyxw')],
        [[F.R8G8B8A8_SNORM], floats('unpack4x8snorm(w.x)')],
        [[F.R8G8B8A8_UINT],
            `(${REG}(w.x) >> ${REG}(0u, 8u, 16u, 24u)) & ${REG}(0xffu)`],
        [[F.R8G8B8A8_SINT], `bitcast<${REG}>(bitcast<vec4<i32>>(${REG}(w.x)`
            + ` << ${REG}(24u, 16u, 8u, 0u)) >> ${REG}(24u))`],
        [[F.R8G8_UNORM], floats(`vec4<f32>(unpack4x8unorm(${pair}).xy, 0.0, 1.0)`)],
        [[F.R8G8_SNORM], floats(`vec4<f32>(unpack4x8snorm(${pair}).xy, 0.0, 1.0)`)],
        [[F.R8G8_UINT], `${REG}(${pair} & 0xffu, ${pair} >> 8u, 0u, 1u)`],
        [[F.R8G8_SINT], `${REG}(${signed8(`(${pair} & 0xffu)`)}, ${signed8(`(${pair} >> 8u)`)},`
            + ' 0u, 1u)'],
        [[F.R8_UNORM], floats(`vec4<f32>(unpack4x8unorm(${byte}).x, 0.0, 0.0, 1.0)`)],
        [[F.R8_SNORM], floats(`vec4<f32>(unpack4x8snorm(${byte}).x, 0.0, 0.0, 1.0)`)],
        [[F.R8_UINT], `${REG}(${byte}, 0u, 0u, 1u)`],
        [[F.R8_SINT], `${REG}(${signed8(byte)}, 0u, 0u, 1u)`],
        [[F.R10G10B10A2_UNORM], floats(`vec4<f32>((${REG}(w.x) >> ${REG}(0u, 10u, 20u, 30u))`
            + ` & ${REG}(0x3ffu, 0x3ffu, 0x3ffu, 3u)) / vec4<f32>(1023.0, 1023.0, 1023.0, 3.0)`)],
        [[F.R10G10B10A2_UINT], `(${REG}(w.x) >> ${REG}(0u, 10u, 20u, 30u))`
            + ` & ${REG}(0x3ffu, 0x3ffu, 0x3ffu, 3u)`],
    ];
    return {
        formats: new Set(cases.flatMap(([formats])=>formats)),
        text: [
            `fn bufferElement(format: u32, w: ${REG}, s: u32) -> ${REG} {`,
            '    switch (format) {',
            ...cases.map(([formats, value])=>`        case ${
                formats.map(format=>`${format}u`).join(', ')}: { return ${value}; }`),
            `        default: { return ${REG}(0u); }`,
            '    }',
            '}',
        ],
    };
}

const BUFFER_ELEMENT = bufferElement();

/**
 * The formats a buffer view can be read in.
 *
 * @type {ReadonlySet<number>}
 */
export const BUFFER_VIEW_FORMATS = BUFFER_ELEMENT.formats;

/**
 * Functions a translation may call, written into the module of a stage that
 * uses one, after the ones it calls. WGSL has no high half of a 32x32
 * multiply, so it is assembled from sixteen-bit halves, whose products and
 * partial sums all fit in 32 bits; the signed high half is the unsigned one
 * less each operand wherever the other is negative, modulo 2^32.
 *
 * @type {Readonly<Record<string, { needs: string[], text: string[] }>>}
 */
export const HELPERS = Object.freeze({
    umulhi: {
        needs: [],
        text: [
            `fn umulhi(a: ${REG}, b: ${REG}) -> ${REG} {`,
            `    let al = a & ${REG}(0xffffu);`,
            `    let ah = a >> ${REG}(16u);`,
            `    let bl = b & ${REG}(0xffffu);`,
            `    let bh = b >> ${REG}(16u);`,
            '    let middle1 = ah * bl;',
            '    let middle2 = al * bh;',
            `    let carry = (((al * bl) >> ${REG}(16u)) + (middle1 & ${REG}(0xffffu))`
                + ` + (middle2 & ${REG}(0xffffu))) >> ${REG}(16u);`,
            `    return ah * bh + (middle1 >> ${REG}(16u)) + (middle2 >> ${REG}(16u)) + carry;`,
            '}',
        ],
    },
    bufferElement: { needs: [], text: BUFFER_ELEMENT.text },
    storeElement: { needs: [], text: STORE_ELEMENT },

    imulhi: {
        needs: ['umulhi'],
        text: [
            `fn imulhi(a: ${REG}, b: ${REG}) -> ${REG} {`,
            `    let aNegative = (a >> ${REG}(31u)) != ${REG}(0u);`,
            `    let bNegative = (b >> ${REG}(31u)) != ${REG}(0u);`,
            `    return umulhi(a, b) - select(${REG}(0u), b, aNegative)`
                + ` - select(${REG}(0u), a, bNegative);`,
            '}',
        ],
    },
});

/**
 * @typedef {Object} ConstantBufferDecl
 * @property {number} slot
 * @property {number} size   In vec4 registers.
 */

/**
 * @typedef {Object} TextureDecl
 * @property {number} slot
 * @property {number} dimension    A RESOURCE_DIMENSION.
 * @property {number} returnType   A RETURN_TYPE.
 * @property {boolean} comparison  Read by a compare-sample, so declared as depth.
 * @property {boolean} [multisampled]  A TEXTURE2DMS bound to a texture of several samples.
 * @property {boolean} [depth]  A float texture bound to a depth buffer: declared as a depth
 *     texture, each read of it one float, made (d, 0, 0, 1) as Direct3D reads such a view.
 * @property {'raw' | 'structured'} [structure]  A buffer read by bytes or by structures.
 * @property {number} [stride]    Bytes a structure.
 */

/**
 * @typedef {Object} SamplerDecl
 * @property {number} slot
 * @property {boolean} comparison
 */

/**
 * @typedef {Object} TranslatedShader
 * @property {number} kind                       A SHADER_KIND.
 * @property {import('./dxbc.js').SignatureElement[]} inputs
 * @property {import('./dxbc.js').SignatureElement[]} outputs
 * @property {ConstantBufferDecl[]} constantBuffers
 * @property {TextureDecl[]} textures
 * @property {SamplerDecl[]} samplers
 * @property {number} temps
 * @property {{ index: number, size: number }[]} indexableTemps
 * @property {number[][]} immediateConstants       The icb, one vec4 per row.
 * @property {(string | { ret: true })[]} body     Statements; `ret` is filled at link.
 * @property {number} inputRegisters               How many `v` registers the body reads.
 * @property {number} outputRegisters              How many `o` registers the body writes.
 * @property {boolean} writesDepth
 * @property {string[]} unsupported                Opcode names with no translation.
 * @property {string[]} helpers                    HELPERS the body calls, callees first.
 * @property {number[]} threadGroup                A compute shader's group, x by y by z.
 * @property {UavDecl[]} uavs                      What the shader writes through.
 * @property {SharedDecl[]} sharedMemory           Its thread-group shared memory.
 */

/**
 * @typedef {Object} UavDecl
 * @property {number} slot
 * @property {'typed' | 'raw' | 'structured'} structure
 * @property {number} dimension   A RESOURCE_DIMENSION, for a typed view.
 * @property {number} returnType  A RETURN_TYPE, for a typed view.
 * @property {number} stride      Bytes a structure, for a structured view.
 * @property {boolean} counter    Whether it has an append counter.
 * @property {boolean} atomic     Whether the shader adds, swaps or compares in it.
 * @property {boolean} loaded     Whether the shader reads it as well as writes it.
 * @property {string} [format]    A typed texture's storage format (`uavFormats`).
 * @property {Set<string>} [atomicOps]  The atomic operations made on it.
 * @property {boolean} [counted]  Whether its append counter is used.
 */

/**
 * @typedef {Object} SharedDecl
 * @property {number} slot
 * @property {number} words       Its size, in dwords.
 * @property {number} stride      Bytes a structure, or 0 for raw memory.
 * @property {boolean} atomic
 * @property {Set<string>} [atomicOps]
 */

/**
 * The pixel stage of a draw with no pixel shader bound. Direct3D still
 * rasterises such a draw -- a depth pre-pass or a shadow map is drawn this way
 * -- and writes depth and stencil, but no render target; this stage reads
 * nothing and writes nothing, so linked with any vertex shader its fragment
 * entry point is empty and every target's write mask is zero.
 *
 * @type {Readonly<TranslatedShader>}
 */
export const NO_PIXEL_SHADER = Object.freeze({
    kind: SHADER_KIND.PIXEL,
    inputs: [],
    outputs: [],
    constantBuffers: [],
    textures: [],
    samplers: [],
    temps: 0,
    indexableTemps: [],
    immediateConstants: [],
    body: [],
    inputRegisters: 0,
    outputRegisters: 0,
    writesDepth: false,
    unsupported: [],
    helpers: [],
    threadGroup: [1, 1, 1],
    uavs: [],
    sharedMemory: [],
});

/** @param {number} mask @returns {string} the components a mask names */
function maskComponents(mask){
    return COMPONENT.filter((_, index)=>(mask & (1 << index)) !== 0).join('');
}

/** @param {readonly number[]} swizzle */
function swizzleText(swizzle){
    return swizzle.map(index=>COMPONENT[index]).join('');
}

/** @param {number} dword @returns {string} a WGSL u32 literal */
const u32Literal = dword=>`${dword >>> 0}u`;
/** A float exactly, as WGSL spells one: its bits. @param {number} value */
const floatLiteral = value=>
    `bitcast<f32>(${new Uint32Array(new Float32Array([value]).buffer)[0]}u)`;

/**
 * Translates one shader's instruction stream. The entry point is not written
 * here -- see `linkProgram` -- because its `@location` numbering belongs to the
 * pair, not to the shader.
 *
 * A texture the shader declares as two-dimensional and multisampled is read
 * as a one-sample texture -- its sample 0 -- unless `multisampled` names its
 * slot: the view bound there is of a texture with more samples than one, and
 * WebGPU binds that only as a multisampled texture, read by sample.
 *
 * A float texture whose slot `depth` names is bound to a depth buffer -- a
 * shadow map read as R32_FLOAT, a depth read back as R24_UNORM_X8 -- which
 * WebGPU binds only as a depth texture: it is declared as one, and each read
 * of it answers (d, 0, 0, 1), as Direct3D answers a view of one channel. A
 * depth texture has no sample with a bias or gradients: those read at the
 * level the plain sample would, or the top one.
 *
 * A typed view a shader writes a texture through is a storage texture of
 * the bound view's format, which `uavFormats` names by slot.
 *
 * @param {import('./dxbc.js').DxbcContainer} container
 * A hull shader is translated a phase at a time (`hull.js`): `tokens` is the
 * stream of one phase, its declarations before it, and `outputName` the array
 * its outputs are written into.
 *
 * @param {import('./dxbc.js').DxbcContainer} container
 * `samplerBias` is the MipLODBias of the sampler bound at each slot that has
 * one: WebGPU's samplers have none, so the shader adds it to every level it
 * samples by.
 *
 * @param {import('./dxbc.js').DxbcContainer} container
 * @param {{ multisampled?: readonly number[], depth?: readonly number[],
 *     uavFormats?: Readonly<Record<number, string>>, tokens?: Uint32Array,
 *     outputName?: string, samplerBias?: Readonly<Record<number, number>> }} [options]
 * @returns {TranslatedShader}
 */
export function translateShader(container, options = {}){
    const program = /** @type {import('./dxbc.js').ShaderProgram} */ (container.shader);
    const instructions = decodeSm4(options.tokens ?? program.tokens);
    const isPixel = program.kind === SHADER_KIND.PIXEL;
    const isCompute = program.kind === SHADER_KIND.COMPUTE;
    // A hull shader's phases write their outputs as an array a register may
    // be indexed into (a fork phase's instances write o[vForkInstanceID + n]),
    // the one its linker names (`hull.js`).
    const isHull = program.kind === SHADER_KIND.HULL;
    const outputArray = options.outputName ?? 'o';

    /** @type {TranslatedShader} */
    const result = {
        kind: program.kind,
        inputs: container.inputs,
        outputs: container.outputs,
        constantBuffers: [],
        textures: [],
        samplers: [],
        temps: 0,
        indexableTemps: [],
        immediateConstants: [],
        body: [],
        inputRegisters: 0,
        outputRegisters: 0,
        writesDepth: false,
        unsupported: [],
        helpers: [],
        threadGroup: [1, 1, 1],
        uavs: [],
        sharedMemory: [],
    };
    let nextTemp = 0;
    let depth = 1;
    // Not `t`: that is a texture's name, and a `let` of the same name would
    // hide the texture from every instruction after it in the block.
    const held = ()=>`held${nextTemp++}`;

    /** @param {string} line */
    const emit = line=>{
        result.body.push(`${'    '.repeat(depth)}${line}`);
    };

    /** @param {number} slot */
    const textureOf = slot=>result.textures.find(texture=>texture.slot === slot) ?? null;

    /**
     * @param {import('./sm4.js').Operand} operand
     * @param {number} at  Which of the operand's indices.
     * @returns {string} an index expression, resolving a relative part
     */
    const indexExpression = (operand, at)=>{
        const index = operand.indices[at];
        if (!index)
        {
            return '0u';
        }
        if (!index.relative)
        {
            return u32Literal(index.value);
        }
        const relative = `${untyped(index.relative)}.${COMPONENT[index.relative.swizzle[0]]}`;
        return index.value === 0 ? relative : `(${u32Literal(index.value)} + ${relative})`;
    };

    /**
     * The bit patterns an operand names, swizzled, before any type is put on
     * them.
     *
     * @param {import('./sm4.js').Operand} operand
     * @returns {string}
     */
    const untyped = operand=>{
        const swizzle = swizzleText(operand.swizzle);
        switch (operand.type)
        {
            case OPERAND.TEMP:
                return `r${operand.indices[0].value}.${swizzle}`;
            case OPERAND.INPUT:
                return `v${operand.indices[0].value}.${swizzle}`;
            case OPERAND.OUTPUT:
                return isHull ? `${outputArray}[${indexExpression(operand, 0)}].${swizzle}`
                    : `o${operand.indices[0].value}.${swizzle}`;
            case OPERAND.INPUT_CONTROL_POINT:
                return `vicp[${indexExpression(operand, 0)}][${indexExpression(operand, 1)}]`
                    + `.${swizzle}`;
            case OPERAND.OUTPUT_CONTROL_POINT:
                return `vocp[${indexExpression(operand, 0)}][${indexExpression(operand, 1)}]`
                    + `.${swizzle}`;
            case OPERAND.INPUT_PATCH_CONSTANT:
                return `vpc[${indexExpression(operand, 0)}].${swizzle}`;
            case OPERAND.OUTPUT_CONTROL_POINT_ID:
                return `${REG}(hsControlPoint).${swizzle}`;
            case OPERAND.INPUT_FORK_INSTANCE_ID:
            case OPERAND.INPUT_JOIN_INSTANCE_ID:
                return `${REG}(hsInstance).${swizzle}`;
            case OPERAND.INPUT_PRIMITIVE_ID:
                if (isHull || program.kind === SHADER_KIND.DOMAIN)
                {
                    return `${REG}(primitiveId).${swizzle}`;
                }
                result.unsupported.push(`operand type ${operand.type}`);
                return `${REG}(0u)`;
            case OPERAND.INPUT_DOMAIN_POINT:
                return `dsDomain.${swizzle}`;
            case OPERAND.INDEXABLE_TEMP:
                return `x${operand.indices[0].value}[${indexExpression(operand, 1)}].${swizzle}`;
            case OPERAND.CONSTANT_BUFFER:
                return `cb${operand.indices[0].value}[${indexExpression(operand, 1)}].${swizzle}`;
            case OPERAND.IMMEDIATE_CONSTANT_BUFFER:
                return `icb[${indexExpression(operand, 0)}].${swizzle}`;
            case OPERAND.INPUT_THREAD_ID:
                return `csThread.${swizzle}`;
            case OPERAND.INPUT_THREAD_GROUP_ID:
                return `csGroup.${swizzle}`;
            case OPERAND.INPUT_THREAD_ID_IN_GROUP:
                return `csLocal.${swizzle}`;
            case OPERAND.INPUT_THREAD_ID_IN_GROUP_FLATTENED:
                return `${REG}(csFlat).${swizzle}`;
            case OPERAND.IMMEDIATE32:
                if (operand.immediate.length === 1)
                {
                    return `${REG}(${u32Literal(operand.immediate[0])})`;
                }
                return `${REG}(${operand.immediate.map(u32Literal).join(', ')})`;
            default:
                result.unsupported.push(`operand type ${operand.type}`);
                return `${REG}(0u)`;
        }
    };

    /**
     * @param {import('./sm4.js').Operand} operand
     * @param {'f' | 'i' | 'u'} type
     * @returns {string} the operand read as that type, with its modifier applied
     */
    const typed = (operand, type)=>{
        const bits = untyped(operand);
        let value = type === 'u' ? bits : `bitcast<vec4<${type}32>>(${bits})`;
        if (operand.modifier === MODIFIER.ABS || operand.modifier === MODIFIER.ABSNEG)
        {
            value = `abs(${value})`;
        }
        if (operand.modifier === MODIFIER.NEG || operand.modifier === MODIFIER.ABSNEG)
        {
            // WGSL negates no unsigned value: an unsigned read negated is
            // its two's complement, zero less it.
            value = type === 'u' ? `(${REG}(0u) - ${value})` : `(-${value})`;
        }
        return value;
    };

    /** @param {import('./sm4.js').Operand} operand */
    const modifiedRead = operand=>(operand.modifier ?? MODIFIER.NONE) !== MODIFIER.NONE;
    /** @param {import('./sm4.js').Operand} operand */
    const f = operand=>typed(operand, 'f');
    /**
     * A source a move copies: its bits, or the float it is with its modifier.
     *
     * @param {import('./sm4.js').Operand} operand
     */
    const moved = operand=>(modifiedRead(operand) ? fromFloat(f(operand), false) : u(operand));
    /** @param {import('./sm4.js').Operand} operand */
    const i = operand=>typed(operand, 'i');
    /** @param {import('./sm4.js').Operand} operand */
    const u = operand=>typed(operand, 'u');

    /**
     * Stores four bit patterns into a destination through its write mask. The
     * value is evaluated once into a `let`, because a swap like
     * `mov r0.xy, r0.yx` reads what it is about to overwrite.
     *
     * @param {import('./sm4.js').Operand} dest
     * @param {string} value  A `vec4<u32>` expression.
     */
    const store = (dest, value)=>{
        if (dest.type === OPERAND.NULL)
        {
            return;
        }
        if (dest.type === OPERAND.OUTPUT_DEPTH)
        {
            result.writesDepth = true;
            emit(`oDepth = bitcast<f32>((${value}).x);`);
            return;
        }
        const target = untyped({ ...dest, swizzle: [0, 1, 2, 3] }).replace(/\.xyzw$/, '');
        if (dest.type === OPERAND.OUTPUT)
        {
            result.outputRegisters = Math.max(result.outputRegisters, dest.indices[0].value + 1);
        }
        if (dest.mask === 0xf)
        {
            emit(`${target} = ${value};`);
            return;
        }
        const temp = held();
        emit(`let ${temp} = ${value};`);
        for (const component of maskComponents(dest.mask))
        {
            emit(`${target}.${component} = ${temp}.${component};`);
        }
    };

    /** @param {string} value a `vec4<f32>` expression @param {boolean} saturate */
    const fromFloat = (value, saturate)=>`bitcast<${REG}>(${saturate
        ? `clamp(${value}, vec4<f32>(0.0), vec4<f32>(1.0))`
        : value})`;
    /** @param {string} value a `vec4<i32>` expression */
    const fromInt = value=>`bitcast<${REG}>(${value})`;
    /** @param {string} condition a `vec4<bool>` expression */
    const fromBool = condition=>`select(${REG}(0u), ${REG}(0xffffffffu), ${condition})`;
    /** @param {string} scalar an `f32` expression */
    const splat = scalar=>`vec4<f32>(${scalar})`;

    /**
     * @param {import('./sm4.js').Operand} operand
     * @param {number} count
     * @returns {string} the first `count` components of a float read
     */
    const floats = (operand, count)=>`${f(operand)}.${'xyzw'.slice(0, count)}`;

    /**
     * The coordinate a texture instruction samples at, sized to the texture,
     * and the array index when it has one. A one-dimensional texture is kept
     * as a two-dimensional one a row high (see `textureType`), and read at the
     * middle of that row, or at row zero by an integer address.
     *
     * @param {TextureDecl} texture
     * @param {string} coordinate a vec4<f32> or vec4<i32> expression
     * @param {boolean} [integer]  An address rather than a coordinate.
     * @returns {{ coordinate: string, layer: string | null, width: number,
     *             row: boolean } | null}
     */
    const coordinateFor = (texture, coordinate, integer = false)=>{
        const row = integer ? `vec2<i32>(${coordinate}.x, 0)` : `vec2<f32>(${coordinate}.x, 0.5)`;
        switch (texture.dimension)
        {
            case RESOURCE_DIMENSION.TEXTURE1D:
                return { coordinate: row, layer: null, width: 2, row: true };
            case RESOURCE_DIMENSION.TEXTURE2D:
            case RESOURCE_DIMENSION.TEXTURE2DMS:
                return { coordinate: `${coordinate}.xy`, layer: null, width: 2, row: false };
            case RESOURCE_DIMENSION.TEXTURE3D:
            case RESOURCE_DIMENSION.TEXTURECUBE:
                return { coordinate: `${coordinate}.xyz`, layer: null, width: 3, row: false };
            case RESOURCE_DIMENSION.TEXTURE1DARRAY:
                return { coordinate: row, layer: `${coordinate}.y`, width: 2, row: true };
            case RESOURCE_DIMENSION.TEXTURE2DARRAY:
            case RESOURCE_DIMENSION.TEXTURE2DMSARRAY:
                return {
                    coordinate: `${coordinate}.xy`, layer: `${coordinate}.z`, width: 2, row: false,
                };
            case RESOURCE_DIMENSION.TEXTURECUBEARRAY:
                return {
                    coordinate: `${coordinate}.xyz`, layer: `${coordinate}.w`, width: 3, row: false,
                };
            default:
                return null;
        }
    };

    /**
     * What `resinfo` answers for each shape, before its level is checked:
     * the sizes a level has, then what the third component is when it is
     * not a size.
     *
     * @param {TextureDecl} texture
     * @param {string} size  The level's `textureDimensions`.
     * @param {string} name  The texture.
     * @returns {{ sizes: string[], layers: string | null } | null}
     */
    const extentFor = (texture, size, name)=>{
        switch (texture.dimension)
        {
            case RESOURCE_DIMENSION.TEXTURE1D:
                return { sizes: [`${size}.x`], layers: null };
            case RESOURCE_DIMENSION.TEXTURE1DARRAY:
                return { sizes: [`${size}.x`], layers: `textureNumLayers(${name})` };
            case RESOURCE_DIMENSION.TEXTURE2D:
            case RESOURCE_DIMENSION.TEXTURE2DMS:
            case RESOURCE_DIMENSION.TEXTURECUBE:
                return { sizes: [`${size}.x`, `${size}.y`], layers: null };
            case RESOURCE_DIMENSION.TEXTURE2DARRAY:
            case RESOURCE_DIMENSION.TEXTURE2DMSARRAY:
            case RESOURCE_DIMENSION.TEXTURECUBEARRAY:
                return { sizes: [`${size}.x`, `${size}.y`], layers: `textureNumLayers(${name})` };
            case RESOURCE_DIMENSION.TEXTURE3D:
                return { sizes: [`${size}.x`, `${size}.y`, `${size}.z`], layers: null };
            default:
                return null;
        }
    };

    /**
     * A read of a depth texture, one float, as the four Direct3D answers of a
     * view of one channel; any other read as it is.
     *
     * @param {TextureDecl} texture @param {string} read
     */
    const depthRead = (texture, read)=>(texture.depth
        ? `vec4<f32>(${read}, 0.0, 0.0, 1.0)` : read);

    /**
     * A sampled result, as the register file holds it: the texture's swizzle
     * applied, then the bits kept as they are for an integer texture and
     * reinterpreted for a float one.
     *
     * @param {TextureDecl} texture
     * @param {import('./sm4.js').Operand} operand  The `t#` operand, for its swizzle.
     * @param {string} sampled
     */
    const sampledBits = (texture, operand, sampled)=>{
        const swizzled = `(${sampled}).${swizzleText(operand.swizzle)}`;
        if (texture.returnType === RETURN_TYPE.UINT)
        {
            return swizzled;
        }
        return `bitcast<${REG}>(${swizzled})`;
    };

    /**
     * @param {import('./sm4.js').Instruction} instruction
     * @param {(texture: TextureDecl, coordinate: { coordinate: string, layer: string | null,
     *          width: number, row: boolean }, sampler: string, bias: string | null) => string}
     *     call  `bias` the sampler's MipLODBias as a WGSL float, null for none
     */
    const sampleWith = (instruction, call)=>{
        const [dest, coordinate, resource, sampler] = instruction.operands;
        const bias = sampler ? options.samplerBias?.[sampler.indices[0].value] ?? 0 : 0;
        const texture = textureOf(resource.indices[0].value);
        const shaped = texture ? coordinateFor(texture, f(coordinate)) : null;
        if (!texture || !shaped)
        {
            result.unsupported.push(`${instruction.name} on an undeclared or unsupported texture`);
            return;
        }
        if (shaped.layer !== null)
        {
            shaped.layer = `i32(${shaped.layer})`;
        }
        const samplerName = sampler ? `s${sampler.indices[0].value}` : '';
        store(dest, sampledBits(texture, resource, call(texture, shaped, samplerName,
            bias ? floatLiteral(bias) : null)));
    };

    /** @param {string} name */
    const unsupported = name=>{
        result.unsupported.push(name);
    };

    /** @param {string} name  A HELPERS entry the body is about to call. */
    const need = name=>{
        if (result.helpers.includes(name))
        {
            return;
        }
        HELPERS[name].needs.forEach(need);
        result.helpers.push(name);
    };

    /**
     * Two-destination integer multiplies and divides: the destination that is
     * `null` is simply not stored.
     *
     * @param {import('./sm4.js').Instruction} instruction
     * @param {string} high
     * @param {string} low
     */
    const storePair = (instruction, high, low)=>{
        const pair = instruction.operands;
        const first = pair[0];
        if (first.type === OPERAND.NULL || pair[1].type === OPERAND.NULL)
        {
            store(first, high);
            store(pair[1], low);
            return;
        }
        // Both results are read before either is written: `udiv r0, r1, r0,
        // r2` divides the r0 it is about to replace.
        const second = held();
        emit(`let ${second} = ${low};`);
        store(first, high);
        store(pair[1], second);
    };

    /**
     * The subroutines after the main program, by label. A call is translated
     * by writing the subroutine's body where the call is: Shader Model 4
     * forbids recursion, so every call graph unrolls, and the body then works
     * on the caller's registers as the hardware's does.
     *
     * @type {Map<number, import('./sm4.js').Instruction[]>}
     */
    const subroutines = new Map();
    const firstLabel = instructions.findIndex(entry=>entry.opcode === OPCODE.LABEL);
    /** @type {import('./sm4.js').Instruction[]} */
    let subroutine = [];
    for (const entry of firstLabel < 0 ? [] : instructions.slice(firstLabel))
    {
        if (entry.opcode === OPCODE.LABEL)
        {
            subroutine = [];
            subroutines.set(entry.operands[0]?.indices[0]?.value ?? -1, subroutine);
            continue;
        }
        subroutine.push(entry);
    }
    /** @type {Set<number>} */
    const calling = new Set();

    /**
     * The switches being written. A run of `case`s with nothing between them
     * shares one body, so a clause is opened only when its first statement
     * arrives, with every selector gathered by then.
     *
     * @type {{ selectors: string[], open: boolean, hasDefault: boolean }[]}
     */
    const switches = [];

    const openClause = ()=>{
        const current = switches.at(-1);
        if (!current || current.selectors.length === 0)
        {
            return;
        }
        emit(current.selectors.length === 1 && current.selectors[0] === 'default'
            ? 'default: {'
            : `case ${current.selectors.join(', ')}: {`);
        depth++;
        current.selectors = [];
        current.open = true;
    };

    const closeClause = ()=>{
        const current = switches.at(-1);
        if (current?.open)
        {
            depth--;
            emit('}');
            current.open = false;
        }
    };

    /**
     * Where a `ret` goes. The main program's returns from the entry point; a
     * subroutine written in place whose only `ret` is its last needs nothing;
     * one that returns early runs inside a loop of one pass, and its `ret`
     * sets a flag and breaks, the flag carried out through every loop and
     * switch of the subroutine that the break leaves it inside.
     *
     * @typedef {{ returned: string | null, main: boolean }} Frame
     */

    /**
     * @param {import('./sm4.js').Instruction[]} list
     * @param {Frame} frame
     */
    const translateBlock = (list, frame)=>{
        for (const instruction of list)
        {
            translateOne(instruction, frame);
        }
    };

    /** @param {number} index */
    const callSubroutine = index=>{
        const body = subroutines.get(index);
        if (!body)
        {
            unsupported(`a call to label ${index}, which the program does not have`);
            return;
        }
        if (calling.has(index))
        {
            unsupported('a recursive call');
            return;
        }
        calling.add(index);
        const block = body.at(-1)?.opcode === OPCODE.RET ? body.slice(0, -1) : body;
        const early = block.some(entry=>entry.opcode === OPCODE.RET
            || entry.opcode === OPCODE.RETC);
        if (!early)
        {
            translateBlock(block, { returned: null, main: false });
        }
        else
        {
            const returned = `returned${nextTemp++}`;
            emit(`var ${returned} = false;`);
            emit('loop {');
            depth++;
            translateBlock(block, { returned, main: false });
            emit('break;');
            depth--;
            emit('}');
        }
        calling.delete(index);
    };

    /**
     * After a loop or a switch closes inside a subroutine that returns early:
     * a `ret` inside it broke out of it and no further.
     *
     * @param {Frame} frame
     */
    const carryReturn = frame=>{
        if (frame.returned)
        {
            emit(`if (${frame.returned}) { break; }`);
        }
    };

    /**
     * @param {string} test  The condition, as WGSL.
     * @param {Frame} frame
     */
    const conditionalReturn = (test, frame)=>{
        emit(`if (${test}) {`);
        depth++;
        if (frame.main)
        {
            result.body.push({ ret: true });
        }
        else
        {
            emit(`${frame.returned} = true;`);
            emit('break;');
        }
        depth--;
        emit('}');
    };

    /**
     * Memory a Shader Model 5 instruction reads or writes by the dword: a
     * view written through, thread-group shared memory, or a buffer read by
     * bytes or structures. Its accessors (`<name>_word`, `<name>_put`,
     * `<name>_atomic_<op>`) are declared once the whole shader is known, so
     * that memory an atomic touches is declared atomic and read through it.
     *
     * @param {import('./sm4.js').Operand} operand
     * @returns {{ name: string, stride: number, uav: UavDecl | null,
     *     shared: SharedDecl | null, texture: TextureDecl | null } | null}
     */
    const memoryOf = operand=>{
        const slot = operand.indices[0]?.value ?? -1;
        if (operand.type === OPERAND.UNORDERED_ACCESS_VIEW)
        {
            const uav = result.uavs.find(entry=>entry.slot === slot) ?? null;
            return uav ? { name: `u${slot}`, stride: uav.stride, uav, shared: null,
                texture: null } : null;
        }
        if (operand.type === OPERAND.THREAD_GROUP_SHARED_MEMORY)
        {
            const shared = result.sharedMemory.find(entry=>entry.slot === slot) ?? null;
            return shared ? { name: `g${slot}`, stride: shared.stride, uav: null, shared,
                texture: null } : null;
        }
        if (operand.type === OPERAND.RESOURCE)
        {
            const texture = textureOf(slot);
            return texture?.structure ? { name: `t${slot}`, stride: texture.stride ?? 0,
                uav: null, shared: null, texture } : null;
        }
        return null;
    };

    /**
     * The dword an access starts at: a byte address for raw memory, or a
     * structure's index and the byte within it.
     *
     * @param {{ stride: number }} memory @param {string} first @param {string | null} within
     */
    const wordOf = (memory, first, within)=>{
        const at = held();
        emit(`let ${at} = (${within === null ? first
            : `${first} * ${memory.stride}u + ${within}`}) / 4u;`);
        return at;
    };

    /**
     * An atomic operation on a dword of memory, which then is atomic: the
     * value it held before.
     *
     * @param {NonNullable<ReturnType<typeof memoryOf>>} memory
     * @param {string} op @param {string} word @param {string} value @param {string} compare
     */
    const atomicOn = (memory, op, word, value, compare)=>{
        const declared = memory.uav ?? memory.shared;
        if (!declared || memory.texture)
        {
            unsupported(`an atomic ${op} on a read-only resource`);
            return '0u';
        }
        declared.atomic = true;
        (declared.atomicOps ??= new Set()).add(op);
        return `${memory.name}_atomic_${op}(${word}, ${value}, ${compare})`;
    };

    /** The storage-texture coordinate of a typed view's address. @param {UavDecl} uav @param {string} address */
    const storageCoordinate = (uav, address)=>{
        switch (uav.dimension)
        {
            case RESOURCE_DIMENSION.TEXTURE1D:
                return { coordinate: `vec2<i32>(i32(${address}.x), 0)`, layer: null };
            case RESOURCE_DIMENSION.TEXTURE2D:
                return { coordinate: `vec2<i32>(${address}.xy)`, layer: null };
            case RESOURCE_DIMENSION.TEXTURE1DARRAY:
                return { coordinate: `vec2<i32>(i32(${address}.x), 0)`,
                    layer: `i32(${address}.y)` };
            case RESOURCE_DIMENSION.TEXTURE2DARRAY:
                return { coordinate: `vec2<i32>(${address}.xy)`, layer: `i32(${address}.z)` };
            case RESOURCE_DIMENSION.TEXTURE3D:
                return { coordinate: `vec3<i32>(${address}.xyz)`, layer: null };
            default:
                return null;
        }
    };

    /** The scalar a storage format's texels are. @param {string} format */
    const storageScalar = format=>(/uint$/.test(format) ? 'u32'
        : /sint$/.test(format) ? 'i32' : 'f32');

    /**
     * Each component of four through a scalar function of each operand's.
     *
     * @param {(...parts: string[]) => string} each @param {string[]} values
     */
    const perComponent = (each, values)=>{
        const named = values.map(value=>{
            const name = held();
            emit(`let ${name} = ${value};`);
            return name;
        });
        return `${REG}(${COMPONENT.map(component=>each(...named.map(name=>
            `${name}.${component}`))).join(', ')})`;
    };

    /**
     * @param {import('./sm4.js').Instruction} instruction
     * @param {Frame} frame
     */
    const translateOne = (instruction, frame)=>{
        const [dest, a, b, c] = instruction.operands;
        const sat = instruction.saturate;
        if (instruction.opcode !== OPCODE.CASE && instruction.opcode !== OPCODE.DEFAULT
            && instruction.opcode !== OPCODE.ENDSWITCH)
        {
            openClause();
        }
        switch (instruction.opcode)
        {
            // --- declarations ---
            // The tessellation stages' declarations (what the stage is, which
            // the hull linker reads from the stream itself) and the global flags.
            case OPCODE.DCL_GLOBAL_FLAGS:
            case OPCODE.HS_DECLS:
            case OPCODE.HS_CONTROL_POINT_PHASE:
            case OPCODE.HS_FORK_PHASE:
            case OPCODE.HS_JOIN_PHASE:
            case OPCODE.DCL_INPUT_CONTROL_POINT_COUNT:
            case OPCODE.DCL_OUTPUT_CONTROL_POINT_COUNT:
            case OPCODE.DCL_TESS_DOMAIN:
            case OPCODE.DCL_TESS_PARTITIONING:
            case OPCODE.DCL_TESS_OUTPUT_PRIMITIVE:
            case OPCODE.DCL_HS_MAX_TESSFACTOR:
            case OPCODE.DCL_HS_FORK_PHASE_INSTANCE_COUNT:
            case OPCODE.DCL_HS_JOIN_PHASE_INSTANCE_COUNT:
            case OPCODE.DCL_INPUT_SGV:
            case OPCODE.DCL_INPUT_PS_SGV:
            case OPCODE.DCL_OUTPUT_SGV:
            case OPCODE.NOP:
                break;
            case OPCODE.DCL_TEMPS:
                result.temps = instruction.extra[0] ?? 0;
                break;
            case OPCODE.DCL_INDEXABLE_TEMP:
                result.indexableTemps.push({
                    index: instruction.extra[0], size: instruction.extra[1],
                });
                break;
            case OPCODE.DCL_CONSTANT_BUFFER:
                result.constantBuffers.push({
                    slot: dest.indices[0].value,
                    size: dest.indices[1] ? dest.indices[1].value : 0,
                });
                break;
            case OPCODE.DCL_SAMPLER:
                result.samplers.push({
                    slot: dest.indices[0].value,
                    comparison: (instruction.control & 0xf) === SAMPLER_MODE.COMPARISON,
                });
                break;
            case OPCODE.DCL_RESOURCE:
                result.textures.push({
                    slot: dest.indices[0].value,
                    dimension: instruction.control & 0x1f,
                    returnType: (instruction.extra[0] ?? 0) & 0xf,
                    comparison: false,
                    ...((instruction.control & 0x1f) === RESOURCE_DIMENSION.TEXTURE2DMS
                        && (options.multisampled ?? []).includes(dest.indices[0].value)
                        ? { multisampled: true }
                        : {}),
                    ...((options.depth ?? []).includes(dest.indices[0].value)
                        ? { depth: true } : {}),
                });
                if ((instruction.control & 0x1f) === RESOURCE_DIMENSION.BUFFER)
                {
                    need('bufferElement');
                }
                break;
            case OPCODE.DCL_INPUT:
            case OPCODE.DCL_INPUT_SIV:
            case OPCODE.DCL_INPUT_PS:
            case OPCODE.DCL_INPUT_PS_SIV:
                if (dest.type === OPERAND.INPUT)
                {
                    result.inputRegisters = Math.max(result.inputRegisters,
                        dest.indices[0].value + 1);
                }
                break;
            case OPCODE.DCL_OUTPUT:
            case OPCODE.DCL_OUTPUT_SIV:
                if (dest.type === OPERAND.OUTPUT)
                {
                    result.outputRegisters = Math.max(result.outputRegisters,
                        dest.indices[0].value + 1);
                }
                break;
            case OPCODE.DCL_THREAD_GROUP:
                result.threadGroup = instruction.extra.slice(0, 3);
                break;
            case OPCODE.DCL_UAV_TYPED:
            case OPCODE.DCL_UAV_RAW:
            case OPCODE.DCL_UAV_STRUCTURED: {
                const slot = dest.indices[0].value;
                const isTyped = instruction.opcode === OPCODE.DCL_UAV_TYPED;
                const format = isTyped ? options.uavFormats?.[slot] : undefined;
                result.uavs.push({
                    slot,
                    structure: isTyped ? 'typed'
                        : instruction.opcode === OPCODE.DCL_UAV_RAW ? 'raw' : 'structured',
                    dimension: isTyped ? instruction.control & 0x1f : RESOURCE_DIMENSION.BUFFER,
                    returnType: isTyped ? (instruction.extra[0] ?? 0) & 0xf : RETURN_TYPE.UINT,
                    stride: instruction.opcode === OPCODE.DCL_UAV_STRUCTURED
                        ? instruction.extra[0] ?? 0 : 0,
                    counter: instruction.opcode === OPCODE.DCL_UAV_STRUCTURED
                        && ((instruction.control >>> 12) & 1) === 1,
                    atomic: false,
                    loaded: false,
                    ...(format ? { format } : {}),
                });
                if (isTyped && (instruction.control & 0x1f) === RESOURCE_DIMENSION.BUFFER)
                {
                    need('bufferElement');
                    need('storeElement');
                }
                break;
            }
            case OPCODE.DCL_TGSM_RAW:
                result.sharedMemory.push({ slot: dest.indices[0].value,
                    words: Math.ceil((instruction.extra[0] ?? 0) / 4), stride: 0, atomic: false });
                break;
            case OPCODE.DCL_TGSM_STRUCTURED:
                result.sharedMemory.push({ slot: dest.indices[0].value,
                    words: Math.ceil((instruction.extra[0] ?? 0) * (instruction.extra[1] ?? 0) / 4),
                    stride: instruction.extra[0] ?? 0, atomic: false });
                break;
            case OPCODE.DCL_RESOURCE_RAW:
            case OPCODE.DCL_RESOURCE_STRUCTURED:
                result.textures.push({
                    slot: dest.indices[0].value,
                    dimension: RESOURCE_DIMENSION.BUFFER,
                    returnType: RETURN_TYPE.UINT,
                    comparison: false,
                    structure: instruction.opcode === OPCODE.DCL_RESOURCE_RAW ? 'raw'
                        : 'structured',
                    stride: instruction.opcode === OPCODE.DCL_RESOURCE_STRUCTURED
                        ? instruction.extra[0] ?? 0 : 0,
                });
                break;
            case OPCODE.CUSTOMDATA:
                if (instruction.control === CUSTOMDATA.IMMEDIATE_CONSTANT_BUFFER)
                {
                    const data = instruction.customData ?? [];
                    for (let row = 0; row + 4 <= data.length; row += 4)
                    {
                        result.immediateConstants.push(data.slice(row, row + 4));
                    }
                }
                break;

            // --- moves ---
            // A move copies bits; a source modifier makes it a float's move.
            case OPCODE.MOV:
                store(dest, sat || modifiedRead(a) ? fromFloat(f(a), sat) : u(a));
                break;
            case OPCODE.MOVC:
                store(dest, `select(${moved(c)}, ${moved(b)}, ${u(a)} != ${REG}(0u))`);
                break;

            // --- float arithmetic ---
            case OPCODE.ADD:
                store(dest, fromFloat(`(${f(a)} + ${f(b)})`, sat));
                break;
            case OPCODE.MUL:
                store(dest, fromFloat(`(${f(a)} * ${f(b)})`, sat));
                break;
            case OPCODE.DIV:
                store(dest, fromFloat(`(${f(a)} / ${f(b)})`, sat));
                break;
            case OPCODE.MAD:
                store(dest, fromFloat(`(${f(a)} * ${f(b)} + ${f(c)})`, sat));
                break;
            case OPCODE.MIN:
                store(dest, fromFloat(`min(${f(a)}, ${f(b)})`, sat));
                break;
            case OPCODE.MAX:
                store(dest, fromFloat(`max(${f(a)}, ${f(b)})`, sat));
                break;
            case OPCODE.DP2:
                store(dest, fromFloat(splat(`dot(${floats(a, 2)}, ${floats(b, 2)})`), sat));
                break;
            case OPCODE.DP3:
                store(dest, fromFloat(splat(`dot(${floats(a, 3)}, ${floats(b, 3)})`), sat));
                break;
            case OPCODE.DP4:
                store(dest, fromFloat(splat(`dot(${f(a)}, ${f(b)})`), sat));
                break;
            case OPCODE.EXP:
                store(dest, fromFloat(`exp2(${f(a)})`, sat));
                break;
            case OPCODE.LOG:
                store(dest, fromFloat(`log2(${f(a)})`, sat));
                break;
            case OPCODE.RSQ:
                store(dest, fromFloat(`inverseSqrt(${f(a)})`, sat));
                break;
            case OPCODE.SQRT:
                store(dest, fromFloat(`sqrt(${f(a)})`, sat));
                break;
            case OPCODE.FRC:
                store(dest, fromFloat(`fract(${f(a)})`, sat));
                break;
            case OPCODE.ROUND_NE:
                store(dest, fromFloat(`round(${f(a)})`, sat));
                break;
            case OPCODE.ROUND_NI:
                store(dest, fromFloat(`floor(${f(a)})`, sat));
                break;
            case OPCODE.ROUND_PI:
                store(dest, fromFloat(`ceil(${f(a)})`, sat));
                break;
            case OPCODE.ROUND_Z:
                store(dest, fromFloat(`trunc(${f(a)})`, sat));
                break;
            case OPCODE.SINCOS:
                storePair(instruction, fromFloat(`sin(${f(b)})`, sat),
                    fromFloat(`cos(${f(b)})`, sat));
                break;
            case OPCODE.DERIV_RTX:
                store(dest, fromFloat(`dpdx(${f(a)})`, sat));
                break;
            case OPCODE.DERIV_RTY:
                store(dest, fromFloat(`dpdy(${f(a)})`, sat));
                break;

            // --- float comparisons: all ones or all zeros, per component ---
            case OPCODE.LT:
                store(dest, fromBool(`(${f(a)} < ${f(b)})`));
                break;
            case OPCODE.GE:
                store(dest, fromBool(`(${f(a)} >= ${f(b)})`));
                break;
            case OPCODE.EQ:
                store(dest, fromBool(`(${f(a)} == ${f(b)})`));
                break;
            case OPCODE.NE:
                store(dest, fromBool(`(${f(a)} != ${f(b)})`));
                break;

            // --- integer arithmetic ---
            case OPCODE.IADD:
                store(dest, fromInt(`(${i(a)} + ${i(b)})`));
                break;
            case OPCODE.IMAD:
                store(dest, fromInt(`(${i(a)} * ${i(b)} + ${i(c)})`));
                break;
            case OPCODE.UMAD:
                store(dest, `(${u(a)} * ${u(b)} + ${u(c)})`);
                break;
            case OPCODE.IMUL:
                if (dest.type !== OPERAND.NULL)
                {
                    need('imulhi');
                }
                storePair(instruction, `imulhi(${fromInt(i(b))}, ${fromInt(i(c))})`,
                    fromInt(`(${i(b)} * ${i(c)})`));
                break;
            case OPCODE.UMUL:
                if (dest.type !== OPERAND.NULL)
                {
                    need('umulhi');
                }
                storePair(instruction, `umulhi(${u(b)}, ${u(c)})`, `(${u(b)} * ${u(c)})`);
                break;
            case OPCODE.UDIV: {
                // Division by zero answers all ones in both halves; WGSL's
                // answers the dividend and zero.
                const byZero = `${u(c)} == ${REG}(0u)`;
                storePair(instruction,
                    `select((${u(b)} / ${u(c)}), ${REG}(0xffffffffu), ${byZero})`,
                    `select((${u(b)} % ${u(c)}), ${REG}(0xffffffffu), ${byZero})`);
                break;
            }
            case OPCODE.IMAX:
                store(dest, fromInt(`max(${i(a)}, ${i(b)})`));
                break;
            case OPCODE.IMIN:
                store(dest, fromInt(`min(${i(a)}, ${i(b)})`));
                break;
            case OPCODE.UMAX:
                store(dest, `max(${u(a)}, ${u(b)})`);
                break;
            case OPCODE.UMIN:
                store(dest, `min(${u(a)}, ${u(b)})`);
                break;
            case OPCODE.INEG:
                store(dest, fromInt(`(-${i(a)})`));
                break;
            case OPCODE.ISHL:
                store(dest, `(${u(a)} << (${u(b)} & ${REG}(31u)))`);
                break;
            case OPCODE.ISHR:
                store(dest, fromInt(`(${i(a)} >> (${u(b)} & ${REG}(31u)))`));
                break;
            case OPCODE.USHR:
                store(dest, `(${u(a)} >> (${u(b)} & ${REG}(31u)))`);
                break;
            case OPCODE.AND:
                store(dest, `(${u(a)} & ${u(b)})`);
                break;
            case OPCODE.OR:
                store(dest, `(${u(a)} | ${u(b)})`);
                break;
            case OPCODE.XOR:
                store(dest, `(${u(a)} ^ ${u(b)})`);
                break;
            case OPCODE.NOT:
                store(dest, `(~${u(a)})`);
                break;
            case OPCODE.IEQ:
                store(dest, fromBool(`(${i(a)} == ${i(b)})`));
                break;
            case OPCODE.INE:
                store(dest, fromBool(`(${i(a)} != ${i(b)})`));
                break;
            case OPCODE.IGE:
                store(dest, fromBool(`(${i(a)} >= ${i(b)})`));
                break;
            case OPCODE.ILT:
                store(dest, fromBool(`(${i(a)} < ${i(b)})`));
                break;
            case OPCODE.UGE:
                store(dest, fromBool(`(${u(a)} >= ${u(b)})`));
                break;
            case OPCODE.ULT:
                store(dest, fromBool(`(${u(a)} < ${u(b)})`));
                break;

            // --- conversions ---
            case OPCODE.ITOF:
                store(dest, fromFloat(`vec4<f32>(${i(a)})`, sat));
                break;
            case OPCODE.UTOF:
                store(dest, fromFloat(`vec4<f32>(${u(a)})`, sat));
                break;
            case OPCODE.FTOI:
                store(dest, fromInt(`vec4<i32>(${f(a)})`));
                break;
            case OPCODE.FTOU:
                store(dest, `${REG}(${f(a)})`);
                break;

            // --- flow control ---
            case OPCODE.IF:
                emit(`if (${u(dest)}.x ${instruction.testNonZero ? '!=' : '=='} 0u) {`);
                depth++;
                break;
            case OPCODE.ELSE:
                depth--;
                emit('} else {');
                depth++;
                break;
            case OPCODE.ENDIF:
                depth--;
                emit('}');
                break;
            case OPCODE.LOOP:
                emit('loop {');
                depth++;
                break;
            case OPCODE.ENDLOOP:
                depth--;
                emit('}');
                carryReturn(frame);
                break;
            case OPCODE.SWITCH:
                emit(`switch (${u(dest)}.x) {`);
                depth++;
                switches.push({ selectors: [], open: false, hasDefault: false });
                break;
            case OPCODE.CASE:
            case OPCODE.DEFAULT: {
                const current = switches.at(-1);
                if (!current)
                {
                    unsupported(`${instruction.name} outside a switch`);
                    break;
                }
                closeClause();
                if (instruction.opcode === OPCODE.DEFAULT)
                {
                    current.selectors.push('default');
                    current.hasDefault = true;
                }
                else
                {
                    current.selectors.push(u32Literal(dest.immediate[0] ?? 0));
                }
                break;
            }
            case OPCODE.ENDSWITCH: {
                const current = switches.at(-1);
                if (!current)
                {
                    unsupported('endswitch outside a switch');
                    break;
                }
                // Trailing cases with no body of their own do nothing.
                openClause();
                closeClause();
                if (!current.hasDefault)
                {
                    emit('default: {}');
                }
                switches.pop();
                depth--;
                emit('}');
                carryReturn(frame);
                break;
            }
            case OPCODE.CALL:
                callSubroutine(dest.indices[0]?.value ?? -1);
                break;
            case OPCODE.CALLC:
                emit(`if (${u(dest)}.x ${instruction.testNonZero ? '!=' : '=='} 0u) {`);
                depth++;
                callSubroutine(a.indices[0]?.value ?? -1);
                depth--;
                emit('}');
                break;
            case OPCODE.BREAK:
                emit('break;');
                break;
            case OPCODE.BREAKC:
                emit(`if (${u(dest)}.x ${instruction.testNonZero ? '!=' : '=='} 0u) { break; }`);
                break;
            case OPCODE.CONTINUE:
                emit('continue;');
                break;
            case OPCODE.CONTINUEC:
                emit(`if (${u(dest)}.x ${instruction.testNonZero ? '!=' : '=='} 0u) { continue; }`);
                break;
            case OPCODE.DISCARD:
                if (!isPixel)
                {
                    unsupported('discard outside a pixel shader');
                    break;
                }
                emit(`if (${u(dest)}.x ${instruction.testNonZero ? '!=' : '=='} 0u) { discard; }`);
                break;
            case OPCODE.RET:
                if (frame.main)
                {
                    result.body.push({ ret: true });
                }
                else
                {
                    emit(`${frame.returned} = true;`);
                    emit('break;');
                }
                break;
            case OPCODE.RETC:
                conditionalReturn(`${u(dest)}.x ${instruction.testNonZero ? '!=' : '=='} 0u`,
                    frame);
                break;

            // --- textures ---
            case OPCODE.SAMPLE:
                if (!isPixel)
                {
                    unsupported('sample outside a pixel shader');
                    break;
                }
                sampleWith(instruction, (texture, shaped, sampler, bias)=>depthRead(texture,
                    `${bias && !texture.depth ? 'textureSampleBias' : 'textureSample'}`
                    + `(t${texture.slot}, ${sampler}, ${shaped.coordinate}`
                    + `${shaped.layer === null ? '' : `, ${shaped.layer}`}`
                    + `${bias && !texture.depth ? `, ${bias}` : ''})`));
                break;
            case OPCODE.SAMPLE_L:
                // A depth texture's level is a whole number.
                sampleWith(instruction, (texture, shaped, sampler, bias)=>{
                    const lod = `${f(instruction.operands[4])}.x${bias ? ` + ${bias}` : ''}`;
                    return depthRead(texture,
                        `textureSampleLevel(t${texture.slot}, ${sampler}, ${shaped.coordinate}`
                        + `${shaped.layer === null ? '' : `, ${shaped.layer}`}`
                        + `, ${texture.depth ? `i32(round(${lod}))` : lod})`);
                });
                break;
            case OPCODE.SAMPLE_B:
                if (!isPixel)
                {
                    unsupported('sample_b outside a pixel shader');
                    break;
                }
                sampleWith(instruction, (texture, shaped, sampler, bias)=>(texture.depth
                    ? depthRead(texture, `textureSample(t${texture.slot}, ${sampler}`
                        + `, ${shaped.coordinate}`
                        + `${shaped.layer === null ? '' : `, ${shaped.layer}`})`)
                    : `textureSampleBias(t${texture.slot}, ${sampler}, ${shaped.coordinate}`
                    + `${shaped.layer === null ? '' : `, ${shaped.layer}`}`
                    + `, ${f(instruction.operands[4])}.x${bias ? ` + ${bias}` : ''})`));
                break;
            case OPCODE.SAMPLE_D:
                sampleWith(instruction, (texture, shaped, sampler, bias)=>{
                    if (texture.depth)
                    {
                        return depthRead(texture, `textureSampleLevel(t${texture.slot}`
                            + `, ${sampler}, ${shaped.coordinate}`
                            + `${shaped.layer === null ? '' : `, ${shaped.layer}`}, 0)`);
                    }
                    /** @param {import('./sm4.js').Operand} operand */
                    // A bias of b is gradients 2^b as long.
                    const gradient = operand=>`${shaped.row
                        ? `vec2<f32>(${f(operand)}.x, 0.0)`
                        : floats(operand, shaped.width)}${bias ? ` * exp2(${bias})` : ''}`;
                    return `textureSampleGrad(t${texture.slot}, ${sampler}, ${shaped.coordinate}`
                        + `${shaped.layer === null ? '' : `, ${shaped.layer}`}`
                        + `, ${gradient(instruction.operands[4])}`
                        + `, ${gradient(instruction.operands[5])})`;
                });
                break;
            case OPCODE.SAMPLE_C:
            case OPCODE.SAMPLE_C_LZ: {
                const compareTexture = textureOf(instruction.operands[2].indices[0].value);
                if (compareTexture)
                {
                    compareTexture.comparison = true;
                }
                const level = instruction.opcode === OPCODE.SAMPLE_C_LZ;
                if (!level && !isPixel)
                {
                    unsupported('sample_c outside a pixel shader');
                    break;
                }
                // A compare-sample answers one float; the register file wants
                // four, and the texture's swizzle picks among them.
                sampleWith(instruction, (texture, shaped, sampler)=>
                    `vec4<f32>(${level ? 'textureSampleCompareLevel' : 'textureSampleCompare'}`
                    + `(t${texture.slot}, ${sampler}, ${shaped.coordinate}`
                    + `${shaped.layer === null ? '' : `, ${shaped.layer}`}`
                    + `, ${f(instruction.operands[4])}.x))`);
                break;
            }
            case OPCODE.LD:
            case OPCODE.LD_MS: {
                const [target, address, resource, sampleIndex] = instruction.operands;
                const texture = textureOf(resource.indices[0].value);
                if (texture?.dimension === RESOURCE_DIMENSION.BUFFER
                    && instruction.opcode === OPCODE.LD)
                {
                    store(target, `(loadt${texture.slot}(${u(address)}.x))`
                        + `.${swizzleText(resource.swizzle)}`);
                    break;
                }
                const shaped = texture ? coordinateFor(texture, i(address), true) : null;
                if (!texture || !shaped
                    || texture.dimension === RESOURCE_DIMENSION.TEXTURECUBE
                    || texture.dimension === RESOURCE_DIMENSION.TEXTURECUBEARRAY)
                {
                    unsupported(`${instruction.name} on an undeclared or unsupported texture`);
                    break;
                }
                if (texture.multisampled)
                {
                    const sample = instruction.opcode === OPCODE.LD_MS && sampleIndex
                        ? `${i(sampleIndex)}.x`
                        : '0';
                    store(target, sampledBits(texture, resource,
                        `textureLoad(t${texture.slot}, ${shaped.coordinate}, ${sample})`));
                    break;
                }
                // A multisample view here is of a one-sample texture, whose
                // one level is its only level and whose sample 0 is its only
                // sample; any other sample reads as zero, as one out of
                // range does.
                const multisample = texture.dimension === RESOURCE_DIMENSION.TEXTURE2DMS
                    || texture.dimension === RESOURCE_DIMENSION.TEXTURE2DMSARRAY;
                const level = multisample ? '0' : `${i(address)}.w`;
                // An address past the level, the layers or the levels reads
                // zero in Direct3D; WebGPU answers any texel or zero.
                const name = `t${texture.slot}`;
                const at = held();
                const mip = held();
                emit(`let ${at} = ${shaped.coordinate};`);
                emit(`let ${mip} = ${level};`);
                const layer = shaped.layer === null ? null : held();
                if (layer)
                {
                    emit(`let ${layer} = ${shaped.layer};`);
                }
                const inside = [`u32(${mip}) < textureNumLevels(${name})`,
                    `all(vec${shaped.width}<u32>(${at}) < textureDimensions(${name}, u32(${mip})))`,
                    ...(layer ? [`u32(${layer}) < textureNumLayers(${name})`] : [])].join(' && ');
                const loaded = sampledBits(texture, resource, depthRead(texture,
                    `textureLoad(${name}, ${at}${layer === null ? '' : `, ${layer}`}, ${mip})`));
                const kept = `select(${REG}(0u), ${loaded}, ${inside})`;
                store(target, instruction.opcode === OPCODE.LD_MS && sampleIndex
                    ? `select(${kept}, ${REG}(0u), ${u(sampleIndex)}.x != 0u)`
                    : kept);
                break;
            }
            case OPCODE.RESINFO: {
                const [target, level, resource] = instruction.operands;
                const texture = textureOf(resource.indices[0].value);
                const name = texture ? `t${texture.slot}` : '';
                // A multisampled texture has one level and is measured without
                // naming it.
                const levels = texture?.multisampled ? '1u' : `textureNumLevels(${name})`;
                const wanted = `${u(level)}.x`;
                const size = held();
                const extent = texture ? extentFor(texture, size, name) : null;
                if (!texture || !extent)
                {
                    unsupported('resinfo on an undeclared or unsupported texture');
                    break;
                }
                // A level past the last answers zero for its sizes; the
                // array size and the level count are still the texture's.
                emit(texture.multisampled
                    ? `let ${size} = textureDimensions(${name});`
                    : `let ${size} = textureDimensions(${name}, min(${wanted}, ${levels} - 1u));`);
                const sizes = extent.sizes.map(component=>
                    `select(0u, ${component}, ${wanted} < ${levels})`);
                const mode = instruction.control & 0x3;
                /** @type {string[]} */
                const components = [...sizes];
                if (extent.layers)
                {
                    components.push(extent.layers);
                }
                while (components.length < 3)
                {
                    components.push('0u');
                }
                components.push(levels);
                let value;
                if (mode === 2)
                {
                    value = `${REG}(${components.join(', ')})`;
                }
                else
                {
                    // resinfo_rcpFloat answers the reciprocal of each size,
                    // and zero where there is no size to take it of.
                    const floated = components.map((component, index)=>(mode === 1
                        && index < sizes.length
                        ? `select(0.0, 1.0 / f32(${component}), ${component} != 0u)`
                        : `f32(${component})`));
                    value = `bitcast<${REG}>(vec4<f32>(${floated.join(', ')}))`;
                }
                store(target, `(${value}).${swizzleText(resource.swizzle)}`);
                break;
            }
            case OPCODE.GATHER4: {
                const gathered = textureOf(instruction.operands[2].indices[0].value);
                if (gathered && (gathered.returnType === RETURN_TYPE.UINT
                    || gathered.returnType === RETURN_TYPE.SINT
                    || gathered.dimension === RESOURCE_DIMENSION.TEXTURE1D
                    || gathered.dimension === RESOURCE_DIMENSION.TEXTURE1DARRAY
                    || gathered.dimension === RESOURCE_DIMENSION.TEXTURE3D))
                {
                    unsupported('gather4 on an integer, one- or three-dimensional texture');
                    break;
                }
                // The four texels' first components, in the order WGSL and
                // Direct3D agree on.
                // A depth texture gathers its one channel, named by no component.
                sampleWith(instruction, (texture, shaped, sampler)=>
                    `textureGather(${texture.depth ? '' : '0, '}t${texture.slot}, ${sampler}`
                    + `, ${shaped.coordinate}`
                    + `${shaped.layer === null ? '' : `, ${shaped.layer}`})`);
                break;
            }

            // --- Shader Model 5: memory read and written by the dword ---
            case OPCODE.LD_RAW:
            case OPCODE.LD_STRUCTURED: {
                const structured = instruction.opcode === OPCODE.LD_STRUCTURED;
                const source = structured ? c : b;
                const memory = memoryOf(source);
                if (!memory)
                {
                    unsupported(`${instruction.name} from undeclared memory`);
                    break;
                }
                if (memory.uav)
                {
                    memory.uav.loaded = true;
                }
                const word = wordOf(memory, `${u(a)}.x`, structured ? `${u(b)}.x` : null);
                const words = [0, 1, 2, 3].map(k=>`${memory.name}_word(${word}`
                    + `${k === 0 ? '' : ` + ${k}u`})`).join(', ');
                store(dest, `${REG}(${words}).${swizzleText(source.swizzle)}`);
                break;
            }
            case OPCODE.STORE_RAW:
            case OPCODE.STORE_STRUCTURED: {
                const structured = instruction.opcode === OPCODE.STORE_STRUCTURED;
                const memory = memoryOf(dest);
                if (!memory || memory.texture)
                {
                    unsupported(`${instruction.name} into undeclared memory`);
                    break;
                }
                const word = wordOf(memory, `${u(a)}.x`, structured ? `${u(b)}.x` : null);
                const value = held();
                emit(`let ${value} = ${u(structured ? c : b)};`);
                // The mask's components go to consecutive dwords.
                [...maskComponents(dest.mask)].forEach((component, k)=>{
                    emit(`${memory.name}_put(${word}${k === 0 ? '' : ` + ${k}u`},`
                        + ` ${value}.${COMPONENT[k]});`);
                });
                break;
            }
            case OPCODE.LD_UAV_TYPED: {
                const memory = memoryOf(b);
                const uav = memory?.uav;
                if (!memory || !uav)
                {
                    unsupported('ld_uav_typed from an undeclared view');
                    break;
                }
                uav.loaded = true;
                if (uav.dimension === RESOURCE_DIMENSION.BUFFER)
                {
                    store(dest, `${memory.name}_element(${u(a)}.x).${swizzleText(b.swizzle)}`);
                    break;
                }
                const at = storageCoordinate(uav, u(a));
                if (!at || !uav.format || !/^r32/.test(uav.format))
                {
                    unsupported('ld_uav_typed from a texture not of one 32-bit channel');
                    break;
                }
                const loaded = `textureLoad(${memory.name}, ${at.coordinate}`
                    + `${at.layer === null ? '' : `, ${at.layer}`})`;
                store(dest, `(${storageScalar(uav.format) === 'u32' ? loaded
                    : `bitcast<${REG}>(${loaded})`}).${swizzleText(b.swizzle)}`);
                break;
            }
            case OPCODE.STORE_UAV_TYPED: {
                const memory = memoryOf(dest);
                const uav = memory?.uav;
                if (!memory || !uav)
                {
                    unsupported('store_uav_typed into an undeclared view');
                    break;
                }
                if (uav.dimension === RESOURCE_DIMENSION.BUFFER)
                {
                    emit(`${memory.name}_storeElement(${u(a)}.x, ${u(b)});`);
                    break;
                }
                const at = storageCoordinate(uav, u(a));
                if (!at || !uav.format)
                {
                    unsupported('store_uav_typed into a texture of a format with no storage');
                    break;
                }
                const scalar = storageScalar(uav.format);
                const texel = scalar === 'u32' ? u(b) : `bitcast<vec4<${scalar}>>(${u(b)})`;
                emit(`textureStore(${memory.name}, ${at.coordinate}`
                    + `${at.layer === null ? '' : `, ${at.layer}`}, ${texel});`);
                break;
            }
            case OPCODE.ATOMIC_AND:
            case OPCODE.ATOMIC_OR:
            case OPCODE.ATOMIC_XOR:
            case OPCODE.ATOMIC_CMP_STORE:
            case OPCODE.ATOMIC_IADD:
            case OPCODE.ATOMIC_IMAX:
            case OPCODE.ATOMIC_IMIN:
            case OPCODE.ATOMIC_UMAX:
            case OPCODE.ATOMIC_UMIN:
            case OPCODE.IMM_ATOMIC_IADD:
            case OPCODE.IMM_ATOMIC_AND:
            case OPCODE.IMM_ATOMIC_OR:
            case OPCODE.IMM_ATOMIC_XOR:
            case OPCODE.IMM_ATOMIC_EXCH:
            case OPCODE.IMM_ATOMIC_CMP_EXCH:
            case OPCODE.IMM_ATOMIC_IMAX:
            case OPCODE.IMM_ATOMIC_IMIN:
            case OPCODE.IMM_ATOMIC_UMAX:
            case OPCODE.IMM_ATOMIC_UMIN: {
                const immediate = instruction.opcode >= OPCODE.IMM_ATOMIC_IADD;
                const [target, ...rest] = immediate ? instruction.operands.slice(1)
                    : instruction.operands;
                const op = instruction.name.replace(/^(imm_)?atomic_/, '').replace('cmp_store',
                    'cmp_exch');
                const memory = memoryOf(target);
                if (!memory)
                {
                    unsupported(`${instruction.name} on undeclared memory`);
                    break;
                }
                const address = rest[0];
                const structured = memory.stride > 0;
                const typedView = memory.uav?.structure === 'typed';
                // A typed view's address is an element: a dword, its format one
                // channel of 32 bits.
                const word = typedView ? `${u(address)}.x`
                    : wordOf(memory, `${u(address)}.x`, structured ? `${u(address)}.y` : null);
                const compare = op === 'cmp_exch' ? `${u(rest[1])}.x` : '0u';
                const value = `${u(rest[op === 'cmp_exch' ? 2 : 1])}.x`;
                const old = atomicOn(memory, op, word, value, compare);
                if (immediate)
                {
                    store(dest, `${REG}(${old})`);
                }
                else
                {
                    emit(`_ = ${old};`);
                }
                break;
            }
            case OPCODE.IMM_ATOMIC_ALLOC:
            case OPCODE.IMM_ATOMIC_CONSUME: {
                const memory = memoryOf(a);
                if (!memory?.uav || !memory.uav.counter)
                {
                    unsupported(`${instruction.name} on a view with no counter`);
                    break;
                }
                memory.uav.counted = true;
                store(dest, instruction.opcode === OPCODE.IMM_ATOMIC_ALLOC
                    ? `${REG}(atomicAdd(&${memory.name}count, 1u))`
                    : `${REG}(atomicSub(&${memory.name}count, 1u) - 1u)`);
                break;
            }
            case OPCODE.SYNC: {
                const flags = instruction.control & 0xf;
                if (!isCompute)
                {
                    // A pixel shader fences its own writes, which WGSL's
                    // fragment stage keeps in order already.
                    break;
                }
                if ((flags & (SYNC_FLAG.UAV_MEMORY_GROUP | SYNC_FLAG.UAV_MEMORY_GLOBAL)) !== 0)
                {
                    emit('storageBarrier();');
                }
                if ((flags & (SYNC_FLAG.THREADS_IN_GROUP | SYNC_FLAG.THREAD_GROUP_SHARED_MEMORY))
                    !== 0)
                {
                    emit('workgroupBarrier();');
                }
                break;
            }
            case OPCODE.BUFINFO: {
                const memory = memoryOf(a);
                const uav = memory?.uav;
                if (!memory || (uav && uav.dimension !== RESOURCE_DIMENSION.BUFFER))
                {
                    unsupported('bufinfo on what is not a buffer');
                    break;
                }
                const count = memory.stride > 0 ? `(${memory.name}view.z)`
                    : memory.uav?.structure === 'typed' ? `${memory.name}view.z`
                        : `(${memory.name}view.z * ${memory.name}view.w)`;
                store(dest, `${REG}(${count})`);
                break;
            }

            // --- Shader Model 5: bits and halves ---
            case OPCODE.COUNTBITS:
                store(dest, `countOneBits(${u(a)})`);
                break;
            case OPCODE.FIRSTBIT_HI:
                // Counted from the high bit, as the instruction does; none set is ~0.
                store(dest, `select(countLeadingZeros(${u(a)}), ${REG}(0xffffffffu),`
                    + ` ${u(a)} == ${REG}(0u))`);
                break;
            case OPCODE.FIRSTBIT_SHI: {
                const value = held();
                emit(`let ${value} = ${u(a)};`);
                const flipped = `(${value} ^ bitcast<${REG}>(bitcast<vec4<i32>>(${value})`
                    + ` >> ${REG}(31u)))`;
                store(dest, `select(countLeadingZeros(${flipped}), ${REG}(0xffffffffu),`
                    + ` ${flipped} == ${REG}(0u))`);
                break;
            }
            case OPCODE.FIRSTBIT_LO:
                store(dest, `firstTrailingBit(${u(a)})`);
                break;
            case OPCODE.UBFE:
                store(dest, perComponent((width, offset, value)=>
                    `extractBits(${value}, ${offset} & 31u, ${width} & 31u)`, [u(a), u(b), u(c)]));
                break;
            case OPCODE.IBFE:
                store(dest, perComponent((width, offset, value)=>`bitcast<u32>(extractBits(`
                    + `bitcast<i32>(${value}), ${offset} & 31u, ${width} & 31u))`,
                [u(a), u(b), u(c)]));
                break;
            case OPCODE.BFI:
                store(dest, perComponent((width, offset, insert, base)=>
                    `insertBits(${base}, ${insert}, ${offset} & 31u, ${width} & 31u)`,
                [u(a), u(b), u(c), u(instruction.operands[4])]));
                break;
            case OPCODE.BFREV:
                store(dest, `reverseBits(${u(a)})`);
                break;
            case OPCODE.UADDC:
            case OPCODE.USUBB: {
                const [sum, carry, left, right] = instruction.operands;
                const x = held();
                const y = held();
                emit(`let ${x} = ${u(left)};`);
                emit(`let ${y} = ${u(right)};`);
                const add = instruction.opcode === OPCODE.UADDC;
                const result2 = held();
                emit(`let ${result2} = ${add ? `${x} + ${y}` : `${x} - ${y}`};`);
                store(sum, result2);
                store(carry, `select(${REG}(0u), ${REG}(1u), ${add ? `${result2} < ${x}`
                    : `${x} < ${y}`})`);
                break;
            }
            case OPCODE.F32TOF16:
                store(dest, perComponent(value=>
                    `(pack2x16float(vec2<f32>(bitcast<f32>(${value}), 0.0)) & 0xffffu)`, [u(a)]));
                break;
            case OPCODE.F16TOF32:
                store(dest, perComponent(value=>
                    `bitcast<u32>(unpack2x16float(${value} & 0xffffu).x)`, [u(a)]));
                break;
            case OPCODE.RCP:
                store(dest, fromFloat(`(vec4<f32>(1.0) / ${f(a)})`, sat));
                break;
            case OPCODE.SWAPC: {
                const [first, second, condition, left, right] = instruction.operands;
                const test = held();
                const x = held();
                const y = held();
                emit(`let ${test} = ${u(condition)} != ${REG}(0u);`);
                emit(`let ${x} = ${moved(left)};`);
                emit(`let ${y} = ${moved(right)};`);
                store(first, `select(${x}, ${y}, ${test})`);
                store(second, `select(${y}, ${x}, ${test})`);
                break;
            }
            case OPCODE.DERIV_RTX_COARSE:
                store(dest, fromFloat(`dpdxCoarse(${f(a)})`, sat));
                break;
            case OPCODE.DERIV_RTX_FINE:
                store(dest, fromFloat(`dpdxFine(${f(a)})`, sat));
                break;
            case OPCODE.DERIV_RTY_COARSE:
                store(dest, fromFloat(`dpdyCoarse(${f(a)})`, sat));
                break;
            case OPCODE.DERIV_RTY_FINE:
                store(dest, fromFloat(`dpdyFine(${f(a)})`, sat));
                break;

            // A range of registers indexed into: a hull shader's outputs are an
            // array already; anywhere else a relative input or output is not
            // carried, and is refused here rather than read at its base.
            case OPCODE.DCL_INDEX_RANGE:
                if (!isHull)
                {
                    unsupported(instruction.name);
                }
                break;

            default:
                unsupported(instruction.name);
                break;
        }
    };

    translateBlock(firstLabel < 0 ? instructions : instructions.slice(0, firstLabel),
        { returned: null, main: true });
    return result;
}

/**
 * @param {TextureDecl} texture
 * @returns {{ type: string, sampleType: string, viewDimension: string,
 *             multisampled?: boolean } | null}
 */
function textureType(texture){
    const sampled = texture.returnType === RETURN_TYPE.UINT
        ? { scalar: 'u32', sampleType: 'uint' }
        : texture.returnType === RETURN_TYPE.SINT
            ? { scalar: 'i32', sampleType: 'sint' }
            : { scalar: 'f32', sampleType: 'float' };
    // WebGPU's one-dimensional texture has one level and no layers, so a
    // Direct3D one, which may have both, is kept as a two-dimensional texture
    // one row high; and every texture here has one sample, so a multisample
    // view of one is a plain view of it.
    /** @type {Record<number, [string, string]>} */
    const shapes = {
        [RESOURCE_DIMENSION.TEXTURE1D]: ['2d', '2d'],
        [RESOURCE_DIMENSION.TEXTURE1DARRAY]: ['2d_array', '2d-array'],
        [RESOURCE_DIMENSION.TEXTURE2D]: ['2d', '2d'],
        [RESOURCE_DIMENSION.TEXTURE2DMS]: ['2d', '2d'],
        [RESOURCE_DIMENSION.TEXTURE3D]: ['3d', '3d'],
        [RESOURCE_DIMENSION.TEXTURECUBE]: ['cube', 'cube'],
        [RESOURCE_DIMENSION.TEXTURE2DARRAY]: ['2d_array', '2d-array'],
        [RESOURCE_DIMENSION.TEXTURE2DMSARRAY]: ['2d_array', '2d-array'],
        [RESOURCE_DIMENSION.TEXTURECUBEARRAY]: ['cube_array', 'cube-array'],
    };
    const shape = shapes[texture.dimension];
    if (!shape)
    {
        return null;
    }
    if (texture.multisampled)
    {
        // A multisampled float texture is never filtered, and WebGPU binds it
        // only as unfilterable.
        return texture.comparison ? null : {
            type: `texture_multisampled_2d<${sampled.scalar}>`,
            sampleType: sampled.sampleType === 'float' ? 'unfilterable-float' : sampled.sampleType,
            viewDimension: '2d',
            multisampled: true,
        };
    }
    if (texture.comparison || texture.depth)
    {
        return {
            type: `texture_depth_${shape[0]}`, sampleType: 'depth', viewDimension: shape[1],
        };
    }
    return {
        type: `texture_${shape[0]}<${sampled.scalar}>`,
        sampleType: sampled.sampleType,
        viewDimension: shape[1],
    };
}

/**
 * @typedef {Object} BindGroupLayoutEntry
 * @property {number} binding
 * @property {number} visibility
 * @property {{ type: string, minBindingSize?: number }} [buffer]
 * @property {{ access: string, format: string, viewDimension: string }} [storageTexture]
 * @property {{ sampleType: string, viewDimension: string, multisampled?: boolean }} [texture]
 * @property {{ type: string }} [sampler]
 */

/**
 * The module-scope declarations of one stage: its bindings and its immediate
 * constants.
 *
 * @param {TranslatedShader} shader
 * @param {number} group
 * @param {number} visibility
 * @returns {{ text: string[], entries: BindGroupLayoutEntry[], unsupported: string[] }}
 */
function declarations(shader, group, visibility){
    /** @type {string[]} */
    const text = [];
    /** @type {BindGroupLayoutEntry[]} */
    const entries = [];
    /** @type {string[]} */
    const problems = [];
    for (const buffer of shader.constantBuffers)
    {
        const binding = BINDING.CONSTANT_BUFFER + buffer.slot;
        text.push(`@group(${group}) @binding(${binding}) var<uniform> cb${buffer.slot}: `
            + `array<${REG}, ${Math.max(1, buffer.size)}>;`);
        // The bytes the declaration reads: what a binding must have at least,
        // which the renderer holds a smaller buffer to (`render.js`).
        entries.push({ binding, visibility,
            buffer: { type: 'uniform', minBindingSize: Math.max(1, buffer.size) * 16 } });
    }
    for (const texture of shader.textures)
    {
        if (texture.structure)
        {
            const name = `t${texture.slot}`;
            text.push(
                `@group(${group}) @binding(${BINDING.TEXTURE + texture.slot})`
                    + ` var<storage, read> ${name}: array<u32>;`,
                `@group(${group}) @binding(${BINDING.BUFFER_VIEW + texture.slot})`
                    + ` var<uniform> ${name}view: ${REG};`,
                ...wordAccessors(name, false, `${name}view`));
            entries.push({ binding: BINDING.TEXTURE + texture.slot, visibility,
                buffer: { type: 'read-only-storage' } });
            entries.push({ binding: BINDING.BUFFER_VIEW + texture.slot, visibility,
                buffer: { type: 'uniform' } });
            continue;
        }
        if (texture.dimension === RESOURCE_DIMENSION.BUFFER)
        {
            // The element is found and bounds-checked here, where the
            // binding's name is known, and decoded by the shared helper. An
            // index past the view reads zero, as Direct3D defines it.
            const binding = BINDING.TEXTURE + texture.slot;
            const view = BINDING.BUFFER_VIEW + texture.slot;
            const name = `t${texture.slot}`;
            text.push(
                `@group(${group}) @binding(${binding}) var<storage, read> ${name}: array<u32>;`,
                `@group(${group}) @binding(${view}) var<uniform> ${name}view: ${REG};`,
                `fn load${name}(index: u32) -> ${REG} {`,
                `    if (index >= ${name}view.z) { return ${REG}(0u); }`,
                `    let byte = (${name}view.y + index) * ${name}view.w;`,
                '    let at = byte / 4u;',
                `    let last = arrayLength(&${name}) - 1u;`,
                `    let words = ${REG}(${name}[min(at, last)], ${name}[min(at + 1u, last)],`
                    + ` ${name}[min(at + 2u, last)], ${name}[min(at + 3u, last)]);`,
                `    return bufferElement(${name}view.x, words, (byte % 4u) * 8u);`,
                '}');
            entries.push({ binding, visibility, buffer: { type: 'read-only-storage' } });
            entries.push({ binding: view, visibility, buffer: { type: 'uniform' } });
            continue;
        }
        const type = textureType(texture);
        if (!type)
        {
            problems.push(`texture dimension ${texture.dimension}`);
            continue;
        }
        const binding = BINDING.TEXTURE + texture.slot;
        text.push(`@group(${group}) @binding(${binding}) var t${texture.slot}: ${type.type};`);
        entries.push({
            binding,
            visibility,
            texture: type.multisampled
                ? { sampleType: type.sampleType, viewDimension: type.viewDimension,
                    multisampled: true }
                : { sampleType: type.sampleType, viewDimension: type.viewDimension },
        });
    }
    for (const sampler of shader.samplers)
    {
        const binding = BINDING.SAMPLER + sampler.slot;
        text.push(`@group(${group}) @binding(${binding}) var s${sampler.slot}: `
            + `${sampler.comparison ? 'sampler_comparison' : 'sampler'};`);
        entries.push({
            binding, visibility, sampler: { type: sampler.comparison ? 'comparison' : 'filtering' },
        });
    }
    for (const uav of shader.uavs ?? [])
    {
        const name = `u${uav.slot}`;
        const binding = BINDING.UAV + uav.slot;
        if (uav.dimension !== RESOURCE_DIMENSION.BUFFER)
        {
            const shape = /** @type {Record<number, string[]>} */ (STORAGE_SHAPE)[uav.dimension];
            if (!uav.format || !shape)
            {
                problems.push(`a typed view of dimension ${uav.dimension} in no storage format`);
                continue;
            }
            const access = uav.loaded ? 'read_write' : 'write';
            text.push(`@group(${group}) @binding(${binding}) var ${name}: `
                + `texture_storage_${shape[0]}<${uav.format}, ${access}>;`);
            entries.push({ binding, visibility, storageTexture: {
                access: uav.loaded ? 'read-write' : 'write-only', format: uav.format,
                viewDimension: shape[1] } });
            continue;
        }
        text.push(`@group(${group}) @binding(${binding}) var<storage, read_write> ${name}: `
            + `array<${uav.atomic ? 'atomic<u32>' : 'u32'}>;`,
        `@group(${group}) @binding(${BINDING.UAV_VIEW + uav.slot}) var<uniform> ${name}view:`
            + ` ${REG};`,
        ...wordAccessors(name, uav.atomic, `${name}view`),
        ...[...uav.atomicOps ?? []].flatMap(op=>atomicAccessor(name, op, uav.atomic,
            `${name}view`)));
        entries.push({ binding, visibility, buffer: { type: 'storage' } });
        entries.push({ binding: BINDING.UAV_VIEW + uav.slot, visibility,
            buffer: { type: 'uniform' } });
        if (uav.structure === 'typed')
        {
            text.push(
                `fn ${name}_element(index: u32) -> ${REG} {`,
                `    let byte = index * ${name}view.w;`,
                '    let w = byte / 4u;',
                `    if (index >= ${name}view.z) { return ${REG}(0u); }`,
                `    return bufferElement(${name}view.x, ${REG}(${name}_word(w), `
                    + `${name}_word(w + 1u), ${name}_word(w + 2u), ${name}_word(w + 3u)),`
                    + ' (byte % 4u) * 8u);',
                '}',
                `fn ${name}_storeElement(index: u32, value: ${REG}) {`,
                `    if (index >= ${name}view.z) { return; }`,
                `    let e = storeElement(${name}view.x, value);`,
                `    let n = storeElementCount(${name}view.x);`,
                `    let w = (index * ${name}view.w) / 4u;`,
                `    if (n > 0u) { ${name}_put(w, e.x); }`,
                `    if (n > 1u) { ${name}_put(w + 1u, e.y); }`,
                `    if (n > 2u) { ${name}_put(w + 2u, e.z); }`,
                `    if (n > 3u) { ${name}_put(w + 3u, e.w); }`,
                '}');
        }
        if (uav.counted)
        {
            text.push(`@group(${group}) @binding(${BINDING.UAV_COUNTER + uav.slot})`
                + ` var<storage, read_write> ${name}count: atomic<u32>;`);
            entries.push({ binding: BINDING.UAV_COUNTER + uav.slot, visibility,
                buffer: { type: 'storage' } });
        }
    }
    for (const shared of shader.sharedMemory ?? [])
    {
        const name = `g${shared.slot}`;
        text.push(`var<workgroup> ${name}: array<${shared.atomic ? 'atomic<u32>' : 'u32'}, `
            + `${Math.max(1, shared.words)}>;`,
        ...wordAccessors(name, shared.atomic, null, shared.words),
        ...[...shared.atomicOps ?? []].flatMap(op=>atomicAccessor(name, op, shared.atomic,
            null, shared.words)));
    }
    if (shader.immediateConstants.length > 0)
    {
        const rows = shader.immediateConstants
            .map(row=>`${REG}(${row.map(u32Literal).join(', ')})`);
        text.push(`const icb = array<${REG}, ${rows.length}>(${rows.join(', ')});`);
    }
    for (const helper of shader.helpers)
    {
        text.push(...HELPERS[helper].text);
    }
    return { text, entries, unsupported: problems };
}

/** A typed view's WGSL storage shape, by its RESOURCE_DIMENSION; one dimension is a row. */
const STORAGE_SHAPE = Object.freeze({
    [RESOURCE_DIMENSION.TEXTURE1D]: ['2d', '2d'],
    [RESOURCE_DIMENSION.TEXTURE2D]: ['2d', '2d'],
    [RESOURCE_DIMENSION.TEXTURE1DARRAY]: ['2d_array', '2d-array'],
    [RESOURCE_DIMENSION.TEXTURE2DARRAY]: ['2d_array', '2d-array'],
    [RESOURCE_DIMENSION.TEXTURE3D]: ['3d', '3d'],
});

/**
 * A memory's dword accessors: a read past its end answers zero and a write
 * past it is dropped, as Direct3D defines an access out of bounds. A view
 * reaches from its first element for its count of them; shared memory is
 * all of itself.
 *
 * @param {string} name @param {boolean} atomic
 * @param {string | null} view  the uniform of the view's first element, count and size
 * @param {number} [words]  shared memory's size
 * @returns {string[]}
 */
function wordAccessors(name, atomic, view, words = 0){
    const bounds = view === null
        ? [`    if (i >= ${words}u) { return 0u; }`, '    let at = i;']
        : [`    if (i >= (${view}.z * ${view}.w) / 4u) { return 0u; }`,
            `    let at = (${view}.y * ${view}.w) / 4u + i;`,
            `    if (at >= arrayLength(&${name})) { return 0u; }`];
    const read = atomic ? `atomicLoad(&${name}[at])` : `${name}[at]`;
    const lines = [
        `fn ${name}_word(i: u32) -> u32 {`,
        ...bounds,
        `    return ${read};`,
        '}',
    ];
    if (view === null || !name.startsWith('t'))
    {
        lines.push(`fn ${name}_put(i: u32, value: u32) {`,
            ...bounds.map(line=>line.replace('return 0u;', 'return;')),
            atomic ? `    atomicStore(&${name}[at], value);` : `    ${name}[at] = value;`,
            '}');
    }
    return lines;
}

/**
 * One atomic operation on a memory's dword: the value it held before. A
 * signed minimum or maximum is a compare-and-swap loop over the unsigned
 * dword, and a compare-exchange retries the weak exchange WGSL has until it
 * either swapped or found another value.
 *
 * @param {string} name @param {string} op @param {boolean} atomic
 * @param {string | null} view @param {number} [words]
 * @returns {string[]}
 */
function atomicAccessor(name, op, atomic, view, words = 0){
    void atomic;
    const bounds = view === null
        ? [`    if (i >= ${words}u) { return 0u; }`, '    let at = i;']
        : [`    if (i >= (${view}.z * ${view}.w) / 4u) { return 0u; }`,
            `    let at = (${view}.y * ${view}.w) / 4u + i;`,
            `    if (at >= arrayLength(&${name})) { return 0u; }`];
    const pointer = `&${name}[at]`;
    /** @type {Record<string, string[]>} */
    const bodies = {
        iadd: [`    return atomicAdd(${pointer}, value);`],
        and: [`    return atomicAnd(${pointer}, value);`],
        or: [`    return atomicOr(${pointer}, value);`],
        xor: [`    return atomicXor(${pointer}, value);`],
        umax: [`    return atomicMax(${pointer}, value);`],
        umin: [`    return atomicMin(${pointer}, value);`],
        exch: [`    return atomicExchange(${pointer}, value);`],
        cmp_exch: [
            '    loop {',
            `        let r = atomicCompareExchangeWeak(${pointer}, compare, value);`,
            '        if (r.exchanged || r.old_value != compare) { return r.old_value; }',
            '    }',
        ],
        imax: signedLoop(pointer, 'max'),
        imin: signedLoop(pointer, 'min'),
    };
    return [
        `fn ${name}_atomic_${op}(i: u32, value: u32, compare: u32) -> u32 {`,
        ...bounds,
        ...bodies[op],
        '}',
    ];
}

/** @param {string} pointer @param {'max' | 'min'} which @returns {string[]} */
function signedLoop(pointer, which){
    return [
        '    loop {',
        `        let old = atomicLoad(${pointer});`,
        `        let next = bitcast<u32>(${which}(bitcast<i32>(old), bitcast<i32>(value)));`,
        `        let r = atomicCompareExchangeWeak(${pointer}, old, next);`,
        '        if (r.exchanged) { return old; }',
        '    }',
    ];
}

/**
 * A compute shader's module: its declarations, all in group 0, and the
 * entry point at its thread group's size, its thread ids the registers the
 * body reads them as.
 *
 * @param {TranslatedShader} cs
 * @returns {{ code: string, entries: BindGroupLayoutEntry[], unsupported: string[] }}
 */
export function linkCompute(cs){
    const declared = declarations(cs, 0, STAGE.COMPUTE);
    const [x, y, z] = cs.threadGroup.map(size=>Math.max(1, size >>> 0));
    const code = [
        ...declared.text,
        `@compute @workgroup_size(${x}, ${y}, ${z})`,
        'fn computeMain(@builtin(global_invocation_id) csThreadId: vec3<u32>,',
        '    @builtin(workgroup_id) csGroupId: vec3<u32>,',
        '    @builtin(local_invocation_id) csLocalId: vec3<u32>,',
        '    @builtin(local_invocation_index) csFlat: u32) {',
        `    let csThread = ${REG}(csThreadId, 0u);`,
        `    let csGroup = ${REG}(csGroupId, 0u);`,
        `    let csLocal = ${REG}(csLocalId, 0u);`,
        ...registerDeclarations(cs),
        ...bodyText(cs, null),
        '}',
    ].join('\n');
    return { code, entries: declared.entries,
        unsupported: [...cs.unsupported, ...declared.unsupported] };
}

/** @param {number} componentType @returns {string} */
function scalarOf(componentType){
    return componentType === COMPONENT_TYPE.UINT
        ? 'u32'
        : componentType === COMPONENT_TYPE.SINT ? 'i32' : 'f32';
}

/**
 * The registers a body declares and the `let`s that fill them, shared by both
 * entry points.
 *
 * @param {TranslatedShader} shader
 * @returns {string[]}
 */
function registerDeclarations(shader){
    /** @type {string[]} */
    const lines = [];
    for (let index = 0; index < shader.temps; index++)
    {
        lines.push(`    var r${index}: ${REG};`);
    }
    for (const temp of shader.indexableTemps)
    {
        lines.push(`    var x${temp.index}: array<${REG}, ${temp.size}>;`);
    }
    for (let index = 0; index < shader.outputRegisters; index++)
    {
        lines.push(`    var o${index}: ${REG};`);
    }
    return lines;
}

/**
 * @param {TranslatedShader} shader
 * @param {string | null} returnExpression  Null for an entry point that returns nothing.
 * @returns {string[]}
 */
function bodyText(shader, returnExpression){
    return shader.body.map(line=>(typeof line === 'string'
        ? line
        : `    return${returnExpression === null ? '' : ` ${returnExpression}`};`));
}

/** @param {import('./dxbc.js').SignatureElement} element */
const semanticKey = element=>`${element.name.toUpperCase()}${element.index}`;

/**
 * @typedef {Object} LinkedProgram
 * @property {string} vertex        WGSL, entry point `vertexMain`.
 * @property {string} fragment      WGSL, entry point `fragmentMain`.
 * @property {BindGroupLayoutEntry[][]} groups  One entry list per stage: vertex, then fragment.
 * @property {{ location: number, semantic: string, index: number, componentType: number }[]}
 *           attributes  The vertex inputs, for the input layout to match against.
 * @property {number[]} targets     The render targets the pixel shader writes.
 * @property {string[]} unsupported Why the pair cannot be built, if it cannot.
 */

/**
 * Writes the two entry points around a vertex and a pixel shader body, with the
 * interface between them numbered once for both.
 *
 * A render target the shader writes with nothing bound there is left out of
 * the fragment's outputs, so that a pipeline can be built for exactly the
 * targets a draw has -- none at all, for a pass that draws depth alone.
 *
 * @param {TranslatedShader} vs
 * @param {TranslatedShader} ps
 * @param {{ targets?: readonly number[], vertexLoad?: VertexLoad }} [options]  `targets`:
 *     the locations with a target bound; every location the shader writes when
 *     absent. `vertexLoad`: how the vertex stage fills its registers when they do not
 *     come from vertex buffers (a domain shader's, `linkDomain`).
 * @returns {LinkedProgram}
 */
export function linkProgram(vs, ps, options = {}){
    /** @type {string[]} */
    const unsupported = [...vs.unsupported, ...ps.unsupported];
    const vsDecl = declarations(vs, 0, STAGE.VERTEX);
    const psDecl = declarations(ps, 1, STAGE.FRAGMENT);
    unsupported.push(...vsDecl.unsupported, ...psDecl.unsupported);

    // --- the vertex stage's inputs ---
    /** @type {string[]} */
    const vsIn = [];
    /** @type {string[]} */
    const vsLoad = [];
    /** @type {LinkedProgram['attributes']} */
    const attributes = [];
    for (let index = 0; index < vs.inputRegisters; index++)
    {
        vsLoad.push(`    var v${index}: ${REG} = ${REG}(0u);`);
    }
    vsLoad.push(...options.vertexLoad?.load ?? []);
    for (const element of options.vertexLoad ? [] : vs.inputs)
    {
        if (element.register >= vs.inputRegisters)
        {
            continue;
        }
        const scalar = scalarOf(element.componentType);
        if (element.systemValue === SYSTEM_VALUE.VERTEX_ID)
        {
            vsIn.push(`    @builtin(vertex_index) v${element.register}: u32,`);
            vsLoad.push(`    v${element.register}.x = in.v${element.register};`);
        }
        else if (element.systemValue === SYSTEM_VALUE.INSTANCE_ID)
        {
            vsIn.push(`    @builtin(instance_index) v${element.register}: u32,`);
            vsLoad.push(`    v${element.register}.x = in.v${element.register};`);
        }
        else if (element.systemValue === SYSTEM_VALUE.UNDEFINED)
        {
            vsIn.push(`    @location(${element.register}) v${element.register}: vec4<${scalar}>,`);
            vsLoad.push(`    v${element.register} = ${scalar === 'u32'
                ? `in.v${element.register}`
                : `bitcast<${REG}>(in.v${element.register})`};`);
            attributes.push({
                location: element.register,
                semantic: element.name,
                index: element.index,
                componentType: element.componentType,
            });
        }
        else
        {
            unsupported.push(`vertex input system value ${element.systemValue}`);
        }
    }

    // --- the interface between the stages, numbered by the vertex outputs ---
    /** @type {Map<string, { location: number, scalar: string }>} */
    const varyings = new Map();
    /**
     * The varying each output register is passed as: two semantics packed
     * into one register (TEXCOORD0 in .xy, TEXCOORD1 in .zw) are one varying.
     *
     * @type {Map<number, { location: number, scalar: string }>}
     */
    const byRegister = new Map();
    /** @type {string[]} */
    const vsOut = [];
    /** @type {string[]} */
    const vsReturn = [];
    let position = false;
    for (const element of vs.outputs)
    {
        const register = `o${element.register}`;
        const value = element.register < vs.outputRegisters ? register : `${REG}(0u)`;
        if (element.systemValue === SYSTEM_VALUE.POSITION)
        {
            position = true;
            vsOut.push('    @builtin(position) position: vec4<f32>,');
            vsReturn.push(`bitcast<vec4<f32>>(${value})`);
            continue;
        }
        if (element.systemValue !== SYSTEM_VALUE.UNDEFINED)
        {
            unsupported.push(`vertex output system value ${element.systemValue}`);
            continue;
        }
        const key = semanticKey(element);
        if (varyings.has(key))
        {
            continue;
        }
        const packed = byRegister.get(element.register);
        if (packed)
        {
            varyings.set(key, packed);
            continue;
        }
        const scalar = scalarOf(element.componentType);
        const location = byRegister.size;
        const varying = { location, scalar };
        varyings.set(key, varying);
        byRegister.set(element.register, varying);
        // An integer varying cannot be interpolated and WGSL says so; a
        // float one is interpolated the way the rasteriser always did.
        const interpolate = scalar === 'f32' ? '' : ' @interpolate(flat)';
        vsOut.push(`    @location(${location})${interpolate} ${register}: vec4<${scalar}>,`);
        vsReturn.push(scalar === 'u32' ? value : `bitcast<vec4<${scalar}>>(${value})`);
    }
    if (!position)
    {
        unsupported.push('a vertex shader that writes no SV_Position');
    }

    // --- the pixel stage's inputs, found by semantic among the vertex outputs ---
    /** @type {string[]} */
    const psIn = [];
    /** @type {string[]} */
    const psLoad = [];
    for (let index = 0; index < ps.inputRegisters; index++)
    {
        psLoad.push(`    var v${index}: ${REG} = ${REG}(0u);`);
    }
    /** The pixel stage's member each location arrives as. @type {Map<number, string>} */
    const arrived = new Map();
    for (const element of ps.inputs)
    {
        if (element.register >= ps.inputRegisters)
        {
            continue;
        }
        const name = `v${element.register}`;
        if (element.systemValue === SYSTEM_VALUE.POSITION)
        {
            psIn.push(`    @builtin(position) ${name}: vec4<f32>,`);
            psLoad.push(`    ${name} = bitcast<${REG}>(in.${name});`);
            continue;
        }
        if (element.systemValue === SYSTEM_VALUE.IS_FRONT_FACE)
        {
            psIn.push(`    @builtin(front_facing) ${name}: bool,`);
            psLoad.push(`    ${name}.x = select(0u, 0xffffffffu, in.${name});`);
            continue;
        }
        if (element.systemValue !== SYSTEM_VALUE.UNDEFINED)
        {
            unsupported.push(`pixel input system value ${element.systemValue}`);
            continue;
        }
        const varying = varyings.get(semanticKey(element));
        if (!varying)
        {
            // The vertex shader wrote nothing under this name, which Direct3D
            // refuses at draw time; here the register reads as zero and the
            // pair says why.
            unsupported.push(`pixel input ${semanticKey(element)} has no vertex output`);
            continue;
        }
        // A register two semantics share comes in once, as the first named it.
        const member = arrived.get(varying.location) ?? name;
        if (!arrived.has(varying.location))
        {
            arrived.set(varying.location, name);
            const interpolate = varying.scalar === 'f32' ? '' : ' @interpolate(flat)';
            psIn.push(`    @location(${varying.location})${interpolate} ${name}: `
                + `vec4<${varying.scalar}>,`);
        }
        psLoad.push(`    ${name} = ${varying.scalar === 'u32'
            ? `in.${member}`
            : `bitcast<${REG}>(in.${member})`};`);
    }

    // --- the pixel stage's outputs ---
    /** @type {string[]} */
    const psOut = [];
    /** @type {string[]} */
    const psReturn = [];
    /** @type {number[]} */
    const targets = [];
    for (const element of ps.outputs)
    {
        const value = element.register < ps.outputRegisters
            ? `o${element.register}`
            : `${REG}(0u)`;
        // An output with no system value -- COLOR0 from a shader compiled for
        // backwards compatibility (fxc /Gec) -- is the target its register names.
        if (element.systemValue === SYSTEM_VALUE.TARGET
            || element.systemValue === SYSTEM_VALUE.UNDEFINED)
        {
            const slot = element.systemValue === SYSTEM_VALUE.TARGET
                ? element.index : element.register;
            targets.push(slot);
            if (options.targets && !options.targets.includes(slot))
            {
                continue;
            }
            const scalar = scalarOf(element.componentType);
            psOut.push(`    @location(${slot}) target${slot}: vec4<${scalar}>,`);
            psReturn.push(scalar === 'u32' ? value : `bitcast<vec4<${scalar}>>(${value})`);
            continue;
        }
        if (element.systemValue === SYSTEM_VALUE.DEPTH)
        {
            psOut.push('    @builtin(frag_depth) depth: f32,');
            psReturn.push('oDepth');
            continue;
        }
        unsupported.push(`pixel output system value ${element.systemValue}`);
    }

    // WGSL has no empty struct, so a stage that reads nothing takes nothing.
    const vertex = [
        ...vsDecl.text,
        ...options.vertexLoad?.text ?? [],
        ...(vsIn.length > 0 ? ['struct VertexIn {', ...vsIn, '};'] : []),
        'struct VertexOut {',
        ...vsOut,
        '};',
        `@vertex fn vertexMain(${options.vertexLoad?.params
            ?? (vsIn.length > 0 ? 'in: VertexIn' : '')}) -> VertexOut {`,
        ...vsLoad,
        ...registerDeclarations(vs),
        ...bodyText(vs, `VertexOut(${vsReturn.join(', ')})`),
        '}',
    ].join('\n');

    // Direct3D leaves a derivative taken in divergent flow undefined rather
    // than refusing the shader, and compilers emit sample instructions inside
    // branches and loops that WGSL's uniformity analysis would reject.
    // A fragment stage with nothing to write -- depth alone, no target bound
    // -- still runs, for what it discards, and returns nothing.
    const writes = psOut.length > 0;
    const fragment = [
        'diagnostic(off, derivative_uniformity);',
        ...psDecl.text,
        ...(psIn.length > 0 ? ['struct FragmentIn {', ...psIn, '};'] : []),
        ...(writes ? ['struct FragmentOut {', ...psOut, '};'] : []),
        `@fragment fn fragmentMain(${psIn.length > 0 ? 'in: FragmentIn' : ''})`
            + `${writes ? ' -> FragmentOut' : ''} {`,
        ...psLoad,
        ...registerDeclarations(ps),
        ...(ps.writesDepth ? ['    var oDepth: f32 = 0.0;'] : []),
        ...bodyText(ps, writes ? `FragmentOut(${psReturn.join(', ')})` : null),
        '}',
    ].join('\n');

    return {
        vertex,
        fragment,
        groups: [vsDecl.entries, psDecl.entries],
        attributes,
        targets,
        unsupported,
    };
}

/** The tessellator's domains, partitionings and outputs as a hull shader declares them. */
const HULL_DOMAIN = Object.freeze({ 1: 'isoline', 2: 'tri', 3: 'quad' });

/**
 * @typedef {Object} LinkedHull
 * @property {string} code           WGSL, entry point `hullMain`: one invocation a patch,
 *     `hsParams` x the patches, y the patches an instance draws.
 * @property {BindGroupLayoutEntry[]} entries  Group 0, the shader's own resources; group 1
 *     is the stage's (`HULL_BINDING`).
 * @property {{ domain: 'isoline' | 'tri' | 'quad', partitioning: number, output: number,
 *     inputPoints: number, outputPoints: number, inputRegisters: number,
 *     outputRegisters: number, constantRegisters: number }} stage
 *     What the tessellator is told and how big each record is: partitioning and
 *     output as `tessellator.js` numbers them.
 * @property {string[]} unsupported
 */

/** Group 1 of a hull program: what it reads and writes per patch. */
export const HULL_BINDING = Object.freeze({
    inputs: 0, points: 1, constants: 2, patches: 3, params: 4,
});

/**
 * A hull shader as one compute program, one invocation a patch: the patch's
 * input control points (`inputs`, the vertex stage's outputs by the hull's
 * input registers), the control point phase run once for each output control
 * point (or, without one, the input points passed through), every fork phase
 * and then every join phase run once for each of its instances, and then the
 * output control points, the patch constants and the tessellator's record of
 * the patch (`tessellator-wgsl.js`'s `Patch`: the declared domain,
 * partitioning and output, the tess factors from the patch constants the PCSG
 * signature names) written out.
 *
 * Each phase is translated as a shader of its own, the declarations before
 * the first phase in front of it, into a function over the stage's private
 * registers: `vicp`, `vocp`, `vpc`, and the outputs it writes, an output
 * control point's (`cpo`) or the patch constants (`pc`).
 *
 * @param {import('./dxbc.js').DxbcContainer} container
 * @returns {LinkedHull}
 */
export function linkHull(container){
    const program = /** @type {import('./dxbc.js').ShaderProgram} */ (container.shader);
    const instructions = decodeSm4(program.tokens);
    /** @type {string[]} */
    const unsupported = [];
    /** @type {{ kind: number, from: number, to: number }[]} */
    const phases = [];
    let globalsEnd = program.tokens.length;
    let at = 0;
    const stage = { domain: /** @type {'isoline' | 'tri' | 'quad'} */ ('tri'), partitioning: 0,
        output: 0, inputPoints: 0, outputPoints: 0 };
    for (const instruction of instructions)
    {
        const control = instruction.control;
        switch (instruction.opcode)
        {
            case OPCODE.HS_CONTROL_POINT_PHASE:
            case OPCODE.HS_FORK_PHASE:
            case OPCODE.HS_JOIN_PHASE:
                if (phases.length === 0)
                {
                    globalsEnd = at;
                }
                else
                {
                    phases[phases.length - 1].to = at;
                }
                phases.push({ kind: instruction.opcode, from: at + instruction.length,
                    to: program.tokens.length });
                break;
            case OPCODE.DCL_INPUT_CONTROL_POINT_COUNT:
                stage.inputPoints = control & 0x3f;
                break;
            case OPCODE.DCL_OUTPUT_CONTROL_POINT_COUNT:
                stage.outputPoints = control & 0x3f;
                break;
            case OPCODE.DCL_TESS_DOMAIN:
                stage.domain = HULL_DOMAIN[/** @type {1 | 2 | 3} */ (control & 3)] ?? 'tri';
                break;
            case OPCODE.DCL_TESS_PARTITIONING:
                // The token's are one past Direct3D's (0 is "undefined").
                stage.partitioning = Math.max(0, (control & 7) - 1);
                break;
            case OPCODE.DCL_TESS_OUTPUT_PRIMITIVE:
                stage.output = Math.max(0, (control & 7) - 1);
                break;
            default:
                break;
        }
        at += instruction.length;
    }
    const globals = program.tokens.subarray(0, globalsEnd);
    /** @param {import('./dxbc.js').SignatureElement[]} elements */
    const registersOf = elements=>Math.max(1, ...elements.map(element=>element.register + 1));
    const patchConstants = container.chunks.has('PCSG')
        ? parseSignature(/** @type {Uint8Array} */ (container.chunks.get('PCSG'))) : [];
    const inputRegisters = registersOf(container.inputs);
    const outputRegisters = registersOf(container.outputs);
    const constantRegisters = registersOf(patchConstants);
    const inputPoints = Math.max(1, stage.inputPoints);
    const outputPoints = Math.max(1, stage.outputPoints);

    /** @type {string[]} */
    const functions = [];
    /** @type {string[]} */
    const calls = [];
    /** @type {TranslatedShader[]} */
    const translated = [];
    let hasControlPointPhase = false;
    let joinStarted = false;
    phases.forEach((phase, index)=>{
        const tokens = new Uint32Array(globals.length + phase.to - phase.from);
        tokens.set(globals);
        tokens.set(program.tokens.subarray(phase.from, phase.to), globals.length);
        const isControlPoint = phase.kind === OPCODE.HS_CONTROL_POINT_PHASE;
        const shader = translateShader(container, { tokens,
            outputName: isControlPoint ? 'cpo' : 'pc' });
        translated.push(shader);
        unsupported.push(...shader.unsupported);
        const icb = `icb_p${index}`;
        const lines = [`fn hsPhase${index}() {`];
        if (shader.immediateConstants.length > 0)
        {
            const rows = shader.immediateConstants
                .map(row=>`${REG}(${row.map(u32Literal).join(', ')})`);
            functions.push(`const ${icb} = array<${REG}, ${rows.length}>(${rows.join(', ')});`);
        }
        for (let temp = 0; temp < shader.temps; temp++)
        {
            lines.push(`    var r${temp}: ${REG};`);
        }
        for (const temp of shader.indexableTemps)
        {
            lines.push(`    var x${temp.index}: array<${REG}, ${temp.size}>;`);
        }
        lines.push(...bodyText(shader, null).map(line=>line.replace(/\bicb\[/g, `${icb}[`)));
        lines.push('}');
        functions.push(lines.join('\n'));
        const instances = decodeSm4(program.tokens.subarray(phase.from, phase.to))
            .find(one=>one.opcode === OPCODE.DCL_HS_FORK_PHASE_INSTANCE_COUNT
                || one.opcode === OPCODE.DCL_HS_JOIN_PHASE_INSTANCE_COUNT)?.extra[0] ?? 1;
        if (isControlPoint)
        {
            hasControlPointPhase = true;
            calls.push(`    for (var cp = 0u; cp < ${outputPoints}u; cp++) {`,
                `        hsControlPoint = cp;`,
                `        cpo = array<${REG}, ${outputRegisters}>();`,
                `        hsPhase${index}();`,
                `        vocp[cp] = cpo;`,
                '    }');
            return;
        }
        if (phase.kind === OPCODE.HS_JOIN_PHASE && !joinStarted)
        {
            joinStarted = true;
            calls.push('    vpc = pc;');
        }
        calls.push(`    for (var i = 0u; i < ${instances}u; i++) {`,
            '        hsInstance = i;', `        hsPhase${index}();`, '    }');
    });
    if (!hasControlPointPhase)
    {
        // Without a control point phase the input points go on as they came.
        calls.unshift(`    for (var cp = 0u; cp < ${Math.min(inputPoints, outputPoints)}u; cp++) {`,
            `        for (var reg = 0u; reg < ${Math.min(inputRegisters, outputRegisters)}u;`
                + ' reg++) {',
            '            vocp[cp][reg] = vicp[cp][reg];', '        }', '    }');
    }

    // The tess factors, in the order the tessellator takes them.
    /** @type {string[]} */
    const factors = ['0.0', '0.0', '0.0', '0.0', '0.0', '0.0'];
    for (const element of patchConstants)
    {
        const component = [0, 1, 2, 3].find(c=>(element.mask & (1 << c)) !== 0) ?? 0;
        const value = `bitcast<f32>(pc[${element.register}].${COMPONENT[component]})`;
        const slot = {
            [SYSTEM_VALUE.QUAD_EDGE_TESSFACTOR]: element.index,
            [SYSTEM_VALUE.QUAD_INSIDE_TESSFACTOR]: 4 + element.index,
            [SYSTEM_VALUE.TRI_EDGE_TESSFACTOR]: element.index,
            [SYSTEM_VALUE.TRI_INSIDE_TESSFACTOR]: 3,
            [SYSTEM_VALUE.LINE_DENSITY_TESSFACTOR]: 0,
            [SYSTEM_VALUE.LINE_DETAIL_TESSFACTOR]: 1,
        }[element.systemValue];
        if (slot !== undefined && slot < 6)
        {
            factors[slot] = value;
        }
    }

    // Every phase's resources, declared once.
    /** @type {TranslatedShader} */
    const merged = { ...translated[0] ?? translateShader(container, { tokens: globals,
        outputName: 'pc' }), immediateConstants: [], body: [] };
    for (const shader of translated.slice(1))
    {
        for (const key of /** @type {const} */ (['constantBuffers', 'textures', 'samplers',
            'uavs']))
        {
            for (const item of shader[key])
            {
                if (!merged[key].some((/** @type {any} */ other)=>other.slot === item.slot))
                {
                    /** @type {any[]} */ (merged[key]).push(item);
                }
            }
        }
        merged.helpers = [...new Set([...merged.helpers, ...shader.helpers])];
    }
    const declared = declarations(merged, 0, STAGE.COMPUTE);
    unsupported.push(...declared.unsupported);
    const domainNumber = { isoline: 0, tri: 1, quad: 2 }[stage.domain];
    const code = [
        ...declared.text,
        'struct TessPatch { kind: vec4<u32>, f0: vec4<f32>, f1: vec4<f32>, }',
        `@group(1) @binding(${HULL_BINDING.inputs}) var<storage, read> hsIn: array<${REG}>;`,
        `@group(1) @binding(${HULL_BINDING.points}) var<storage, read_write> hsOutPoints: `
            + `array<${REG}>;`,
        `@group(1) @binding(${HULL_BINDING.constants}) var<storage, read_write> hsOutConstants: `
            + `array<${REG}>;`,
        `@group(1) @binding(${HULL_BINDING.patches}) var<storage, read_write> hsPatches: `
            + 'array<TessPatch>;',
        `@group(1) @binding(${HULL_BINDING.params}) var<uniform> hsParams: vec4<u32>;`,
        `var<private> vicp: array<array<${REG}, ${inputRegisters}>, ${inputPoints}>;`,
        `var<private> vocp: array<array<${REG}, ${outputRegisters}>, ${outputPoints}>;`,
        `var<private> cpo: array<${REG}, ${outputRegisters}>;`,
        `var<private> pc: array<${REG}, ${constantRegisters}>;`,
        `var<private> vpc: array<${REG}, ${constantRegisters}>;`,
        'var<private> hsControlPoint: u32;',
        'var<private> hsInstance: u32;',
        'var<private> primitiveId: u32;',
        ...functions,
        '@compute @workgroup_size(64)',
        'fn hullMain(@builtin(global_invocation_id) id: vec3<u32>) {',
        '    if (id.x >= hsParams.x) { return; }',
        '    let hsPatch = id.x;',
        // Patches of every instance in a row: SV_PrimitiveID counts each
        // instance's from zero.
        '    primitiveId = hsPatch % max(1u, hsParams.y);',
        `    for (var cp = 0u; cp < ${inputPoints}u; cp++) {`,
        `        for (var reg = 0u; reg < ${inputRegisters}u; reg++) {`,
        `            vicp[cp][reg] = hsIn[(hsPatch * ${inputPoints}u + cp) * ${inputRegisters}u`
            + ' + reg];',
        '        }',
        '    }',
        ...calls,
        `    for (var cp = 0u; cp < ${outputPoints}u; cp++) {`,
        `        for (var reg = 0u; reg < ${outputRegisters}u; reg++) {`,
        `            hsOutPoints[(hsPatch * ${outputPoints}u + cp) * ${outputRegisters}u + reg] `
            + '= vocp[cp][reg];',
        '        }',
        '    }',
        `    for (var reg = 0u; reg < ${constantRegisters}u; reg++) {`,
        `        hsOutConstants[hsPatch * ${constantRegisters}u + reg] = pc[reg];`,
        '    }',
        `    hsPatches[hsPatch] = TessPatch(vec4<u32>(${domainNumber}u, ${stage.partitioning}u, `
            + `${stage.output}u, 0u),`,
        `        vec4<f32>(${factors.slice(0, 4).join(', ')}), `
            + `vec4<f32>(${factors[4]}, ${factors[5]}, 0.0, 0.0));`,
        '}',
    ].join('\n');
    return {
        code,
        entries: declared.entries,
        stage: { ...stage, inputPoints, outputPoints, inputRegisters, outputRegisters,
            constantRegisters },
        unsupported: [...new Set(unsupported)],
    };
}

/**
 * @typedef {Object} VertexLoad
 * @property {string[]} text    Module-scope declarations the load reads.
 * @property {string} params    The vertex entry point's parameters.
 * @property {string[]} load    Statements filling the stage's registers.
 */

/** @param {number} mask @returns {number} */
const firstComponent = mask=>[0, 1, 2, 3].find(c=>(mask & (1 << c)) !== 0) ?? 0;

/**
 * Statements copying what one stage wrote into the registers the next reads,
 * element by element as their signatures name them: the same semantic may sit
 * in another register, or at other components of it, on either side. An
 * element the writer has no counterpart for is left as it was (zero).
 *
 * @param {import('./dxbc.js').SignatureElement[]} from
 * @param {import('./dxbc.js').SignatureElement[]} to
 * @param {(register: number) => string} read
 * @param {(register: number) => string} write
 * @returns {string[]}
 */
function copyBySemantic(from, to, read, write){
    /** @type {string[]} */
    const lines = [];
    for (const element of to)
    {
        const source = from.find(candidate=>semanticKey(candidate) === semanticKey(element));
        if (!source)
        {
            continue;
        }
        const toFirst = firstComponent(element.mask);
        const fromFirst = firstComponent(source.mask);
        for (let c = toFirst; c < 4; c++)
        {
            const fc = fromFirst + c - toFirst;
            if ((element.mask & (1 << c)) !== 0 && fc < 4)
            {
                lines.push(`${write(element.register)}.${COMPONENT[c]} = `
                    + `${read(source.register)}.${COMPONENT[fc]};`);
            }
        }
    }
    return lines;
}

/** A float's bits, as a register keeps them. @param {string} value */
const floatBits = value=>`bitcast<u32>(${value})`;

/**
 * How a vertex format is read out of a buffer's words: how many bytes an
 * element takes and the register it makes of the words that hold it, the
 * components it lacks filled as a vertex fetch fills them (0, 0, 0, 1).
 *
 * @param {string} format  A WebGPU vertex format (`gpuformats.js`'s `VERTEX_FORMAT`).
 * @returns {{ bytes: number, register: (words: string[]) => string } | null}
 */
export function vertexFetch(format){
    if (format === 'unorm10-10-10-2')
    {
        return {
            bytes: 4,
            register: ([word])=>`${REG}(${[0, 10, 20].map(shift=>
                floatBits(`f32(extractBits(${word}, ${shift}u, 10u)) / 1023.0`)).join(', ')}, `
                + `${floatBits(`f32(extractBits(${word}, 30u, 2u)) / 3.0`)})`,
        };
    }
    const bgra = format === 'unorm8x4-bgra';
    const match = /^(float|uint|sint|unorm|snorm)(8|16|32)(?:x(\d))?$/
        .exec(bgra ? 'unorm8x4' : format);
    if (!match)
    {
        return null;
    }
    const kind = match[1];
    const bits = Number(match[2]);
    const count = Number(match[3] ?? 1);
    const integer = kind === 'uint' || kind === 'sint';
    const one = integer ? '1u' : '0x3f800000u';
    return {
        bytes: (bits * count) / 8,
        register: words=>{
            /** @type {string[]} */
            const components = [];
            for (let c = 0; c < 4; c++)
            {
                if (c >= count)
                {
                    components.push(c === 3 ? one : '0u');
                    continue;
                }
                const word = words[Math.floor((c * bits) / 32)];
                const shift = (c * bits) % 32;
                const raw = bits === 32 ? word : `extractBits(${word}, ${shift}u, ${bits}u)`;
                const signed = bits === 32 ? `bitcast<i32>(${word})`
                    : `extractBits(bitcast<i32>(${word}), ${shift}u, ${bits}u)`;
                const max = 2 ** (bits - 1) - 1;
                components.push({
                    float: bits === 16 ? floatBits(`unpack2x16float(${raw}).x`) : raw,
                    uint: raw,
                    sint: `bitcast<u32>(${signed})`,
                    unorm: floatBits(`f32(${raw}) / ${2 ** bits - 1}.0`),
                    snorm: floatBits(`max(f32(${signed}) / ${max}.0, -1.0)`),
                }[kind] ?? raw);
            }
            if (bgra)
            {
                [components[0], components[2]] = [components[2], components[0]];
            }
            return `${REG}(${components.join(', ')})`;
        },
    };
}

/** Group 1 of a vertex shader run as compute (`linkVertexPatches`): what it reads and writes. */
export const VERTEX_PATCH_BINDING = Object.freeze({
    indices: 0, out: 1, params: 2, streams: 3,
});

/**
 * A vertex shader as one compute program, one invocation a control point of
 * a draw through the tessellator: the point's vertex found as the draw finds
 * it (`vsIndices`, the index buffer's words, or the first vertex counted on),
 * its elements read out of the vertex buffers' words (`vsStream<n>`, one a
 * buffer the input layout reads, `streams` as `render.js`'s `vertexLayouts`
 * gives them) and decoded as a vertex fetch decodes them, the shader's body
 * run, and what it wrote stored (`vsOut`) at the registers the hull shader
 * reads it from, matched by semantic. An element past the end of its buffer
 * reads zero.
 *
 * `vsParams`: the points, the points an instance draws, the index size in
 * bytes (0 for a draw without indices), the index buffer's byte offset, the
 * first index or vertex, the base vertex, the first instance; then, a buffer
 * each, its byte offset and stride.
 *
 * @param {TranslatedShader} vs
 * @param {import('./dxbc.js').SignatureElement[]} inputs  The hull shader's control point inputs.
 * @param {number} registers  The hull shader's input registers a point (`LinkedHull.stage`).
 * @param {{ stepMode: string, attributes: { shaderLocation: number, offset: number,
 *     format: string }[] }[]} streams
 * @returns {{ code: string, entries: BindGroupLayoutEntry[], unsupported: string[] }}
 */
export function linkVertexPatches(vs, inputs, registers, streams){
    const declared = declarations(vs, 0, STAGE.COMPUTE);
    /** @type {string[]} */
    const unsupported = [...vs.unsupported, ...declared.unsupported];
    /** @type {string[]} */
    const fetch = [];
    streams.forEach((stream, k)=>{
        const element = stream.stepMode === 'instance'
            ? 'vsParams.startInstance + vsInstance' : 'vsVertex';
        // An element far past the buffer's end (an index plus a negative base
        // vertex wraps to one) reads zero, its address never wrapped back in.
        fetch.push(`    let vsIn${k} = vsParams.streams[${k}].y == 0u || (${element})`
            + ` <= arrayLength(&vsStream${k}) * 4u / vsParams.streams[${k}].y;`);
        fetch.push(`    let vsAt${k} = vsParams.streams[${k}].x + (${element})`
            + ` * vsParams.streams[${k}].y;`);
        for (const attribute of stream.attributes)
        {
            const decoder = vertexFetch(attribute.format);
            if (!decoder)
            {
                unsupported.push(`vertex format ${attribute.format}`);
                continue;
            }
            const at = `vsAt${k} + ${attribute.offset}u`;
            const words = Array.from({ length: Math.ceil(decoder.bytes / 4) },
                (_, index)=>`vsWord${k}(${at} + ${index * 4}u)`);
            const within = `vsIn${k} && ${at} + ${decoder.bytes}u`
                + ` <= arrayLength(&vsStream${k}) * 4u`;
            fetch.push(`    if (${within}) {`,
                `        v${attribute.shaderLocation} = ${decoder.register(words)};`, '    }');
        }
    });
    for (const element of vs.inputs)
    {
        if (element.systemValue === SYSTEM_VALUE.VERTEX_ID)
        {
            fetch.push(`    v${element.register}.x = vsVertex;`);
        }
        else if (element.systemValue === SYSTEM_VALUE.INSTANCE_ID)
        {
            fetch.push(`    v${element.register}.x = vsInstance;`);
        }
        else if (element.systemValue !== SYSTEM_VALUE.UNDEFINED)
        {
            unsupported.push(`vertex input system value ${element.systemValue}`);
        }
    }
    const out = Math.max(1, registers);
    const code = [
        ...declared.text,
        'struct VsParams { count: u32, perInstance: u32, indexBytes: u32, indexOffset: u32,',
        '    first: u32, baseVertex: i32, startInstance: u32, pad: u32,',
        `    streams: array<${REG}, ${Math.max(1, streams.length)}>, }`,
        `@group(1) @binding(${VERTEX_PATCH_BINDING.indices}) var<storage, read> vsIndices: `
            + 'array<u32>;',
        `@group(1) @binding(${VERTEX_PATCH_BINDING.out}) var<storage, read_write> vsOut: `
            + `array<${REG}>;`,
        `@group(1) @binding(${VERTEX_PATCH_BINDING.params}) var<uniform> vsParams: VsParams;`,
        ...streams.map((_, k)=>`@group(1) @binding(${VERTEX_PATCH_BINDING.streams + k})`
            + ` var<storage, read> vsStream${k}: array<u32>;`),
        ...Array.from({ length: vs.inputRegisters }, (_, index)=>
            `var<private> v${index}: ${REG};`),
        ...Array.from({ length: vs.outputRegisters }, (_, index)=>
            `var<private> o${index}: ${REG};`),
        ...streams.map((_, k)=>[
            `fn vsWord${k}(b: u32) -> u32 {`,
            `    let w = b >> 2u;`,
            `    let n = arrayLength(&vsStream${k});`,
            '    if (w >= n) { return 0u; }',
            '    let s = (b & 3u) * 8u;',
            `    let lo = vsStream${k}[w];`,
            '    if (s == 0u) { return lo; }',
            `    let hi = select(0u, vsStream${k}[min(w + 1u, n - 1u)], w + 1u < n);`,
            '    return (lo >> s) | (hi << (32u - s));',
            '}'].join('\n')),
        'fn vsIndex(i: u32) -> u32 {',
        '    let b = vsParams.indexOffset + i * vsParams.indexBytes;',
        '    if ((b >> 2u) >= arrayLength(&vsIndices)) { return 0u; }',
        '    let word = vsIndices[b >> 2u];',
        '    if (vsParams.indexBytes == 2u) { return extractBits(word, (b & 2u) * 8u, 16u); }',
        '    return word;',
        '}',
        'fn vsBody() {',
        ...Array.from({ length: vs.temps }, (_, index)=>`    var r${index}: ${REG};`),
        ...vs.indexableTemps.map(temp=>`    var x${temp.index}: array<${REG}, ${temp.size}>;`),
        ...bodyText(vs, null),
        '}',
        '@compute @workgroup_size(64)',
        'fn vertexPatches(@builtin(global_invocation_id) id: vec3<u32>) {',
        '    if (id.x >= vsParams.count) { return; }',
        '    let vsInstance = id.x / max(1u, vsParams.perInstance);',
        '    let vsPoint = id.x % max(1u, vsParams.perInstance);',
        '    var vsVertex = vsParams.first + vsPoint;',
        '    if (vsParams.indexBytes != 0u) {',
        '        vsVertex = bitcast<u32>(bitcast<i32>(vsIndex(vsParams.first + vsPoint))'
            + ' + vsParams.baseVertex);',
        '    }',
        ...fetch,
        '    vsBody();',
        `    var hs: array<${REG}, ${out}>;`,
        ...copyBySemantic(vs.outputs.filter(element=>element.register < vs.outputRegisters),
            inputs, register=>`o${register}`, register=>`    hs[${register}]`),
        `    for (var reg = 0u; reg < ${out}u; reg++) {`,
        `        vsOut[id.x * ${out}u + reg] = hs[reg];`,
        '    }',
        '}',
    ].join('\n');
    return { code, entries: declared.entries, unsupported: [...new Set(unsupported)] };
}

/** Group 2 of a domain shader drawn as the vertex stage (`linkDomain`). */
export const DOMAIN_BINDING = Object.freeze({
    points: 0, constants: 1, domain: 2, indices: 3, offsets: 4, params: 5,
});

/**
 * A domain shader and a pixel shader as the two stages of a draw over what the
 * tessellator made, the domain shader as the vertex stage: a vertex is an
 * index the tessellator wrote (`dsIndices`), drawn in order without an index
 * buffer; its patch is found among the patches' first indices (`dsOffsets`,
 * the tessellator's offsets), its domain point (`dsDomain`) where the patch's
 * points start, and its control points and patch constants are what the hull
 * program wrote for that patch (`dsPoints`, `dsConstants`), read into the
 * registers the domain shader names for each semantic. `dsParams`: x the
 * patches, y the patches an instance draws.
 *
 * @param {TranslatedShader} ds
 * @param {import('./dxbc.js').DxbcContainer} dsContainer
 * @param {TranslatedShader} ps
 * @param {import('./dxbc.js').DxbcContainer} hull
 * @param {LinkedHull['stage']} stage
 * @param {{ targets?: readonly number[] }} [options]
 * @returns {LinkedProgram}
 */
export function linkDomain(ds, dsContainer, ps, hull, stage, options = {}){
    /** @param {import('./dxbc.js').DxbcContainer} container */
    const constantsOf = container=>(container.chunks.has('PCSG')
        ? parseSignature(/** @type {Uint8Array} */ (container.chunks.get('PCSG'))) : []);
    /** @param {import('./dxbc.js').SignatureElement[]} elements */
    const registersOf = elements=>Math.max(1, ...elements.map(element=>element.register + 1));
    const inputs = registersOf(ds.inputs);
    const constants = constantsOf(dsContainer);
    const points = stage.outputPoints;
    const third = stage.domain === 'tri' ? '1.0 - dsAt.x - dsAt.y' : '0.0';
    const linked = linkProgram(ds, ps, { ...options, vertexLoad: {
        text: [
            `@group(2) @binding(${DOMAIN_BINDING.points}) var<storage, read> dsPoints: `
                + `array<${REG}>;`,
            `@group(2) @binding(${DOMAIN_BINDING.constants}) var<storage, read> dsConstants: `
                + `array<${REG}>;`,
            `@group(2) @binding(${DOMAIN_BINDING.domain}) var<storage, read> dsUv: `
                + 'array<vec2<f32>>;',
            `@group(2) @binding(${DOMAIN_BINDING.indices}) var<storage, read> dsIndices: `
                + 'array<u32>;',
            `@group(2) @binding(${DOMAIN_BINDING.offsets}) var<storage, read> dsOffsets: `
                + 'array<vec2<u32>>;',
            `@group(2) @binding(${DOMAIN_BINDING.params}) var<uniform> dsParams: vec4<u32>;`,
            `var<private> vicp: array<array<${REG}, ${inputs}>, ${points}>;`,
            `var<private> vpc: array<${REG}, ${registersOf(constants)}>;`,
            `var<private> dsDomain: ${REG};`,
            'var<private> primitiveId: u32;',
        ],
        params: '@builtin(vertex_index) dsVertex: u32',
        load: [
            // The last patch whose indices start at or before this one: a
            // patch that made none starts where the next one does.
            '    var dsLow = 0u;',
            '    var dsHigh = max(dsParams.x, 1u) - 1u;',
            '    loop {',
            '        if (dsLow >= dsHigh) { break; }',
            '        let dsMid = (dsLow + dsHigh + 1u) / 2u;',
            '        if (dsOffsets[dsMid].y <= dsVertex) { dsLow = dsMid; }'
                + ' else { dsHigh = dsMid - 1u; }',
            '    }',
            '    let dsPatch = dsLow;',
            '    let dsAt = dsUv[dsOffsets[dsPatch].x + dsIndices[dsVertex]];',
            `    dsDomain = bitcast<${REG}>(vec4<f32>(dsAt.x, dsAt.y, ${third}, 0.0));`,
            '    primitiveId = dsPatch % max(1u, dsParams.y);',
            `    for (var cp = 0u; cp < ${points}u; cp++) {`,
            ...copyBySemantic(hull.outputs, ds.inputs,
                register=>`dsPoints[(dsPatch * ${points}u + cp) * ${stage.outputRegisters}u`
                    + ` + ${register}u]`,
                register=>`        vicp[cp][${register}]`),
            '    }',
            ...copyBySemantic(constantsOf(hull), constants,
                register=>`dsConstants[dsPatch * ${stage.constantRegisters}u + ${register}u]`,
                register=>`    vpc[${register}]`),
        ],
    } });
    return linked;
}
