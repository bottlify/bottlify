/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * SPIR-V, decoded: the header, the instruction stream, and what the module
 * says about itself before any of it is translated.
 *
 * The binary is a sequence of 32-bit words. Five of header -- the magic
 * number, the version, the generator, the id bound, a reserved zero -- and
 * then instructions, each led by one word whose high half is the
 * instruction's length in words (itself included) and whose low half is the
 * opcode. That is the whole physical format; everything else is what the
 * operands mean, and this file reads only the operands the loader needs
 * before a pipeline is made: which capabilities the module declares, and
 * which entry points it has under which execution model.
 *
 * A capability is the honest place to refuse. A module that declares
 * `Geometry` or `Tessellation` cannot run on WebGPU whatever its
 * instructions do, and saying so by name when the module is created is
 * what turns a pipeline that later fails to compile into a sentence a
 * reader can act on.
 */

/** The first word of every SPIR-V module, in the module's own endianness. */
export const SPIRV_MAGIC = 0x07230203;

/** The capabilities WebGPU can honour, by the registry's number. */
/** @type {Readonly<Record<number, string>>} */
export const SUPPORTED_CAPABILITIES = Object.freeze({
    0: 'Matrix',
    1: 'Shader',
    28: 'UniformBufferArrayDynamicIndexing',
    29: 'SampledImageArrayDynamicIndexing',
    30: 'StorageBufferArrayDynamicIndexing',
    31: 'StorageImageArrayDynamicIndexing',
    34: 'ImageCubeArray',
    35: 'SampleRateShading',
    43: 'Sampled1D',
    44: 'Image1D',
    45: 'SampledCubeArray',
    49: 'StorageImageExtendedFormats',
    50: 'ImageQuery',
    51: 'DerivativeControl',
    4427: 'DrawParameters',
});

/** The capabilities named so a refusal can say which, by the registry's number. */
/** @type {Readonly<Record<number, string>>} */
export const NAMED_CAPABILITIES = Object.freeze({
    ...SUPPORTED_CAPABILITIES,
    2: 'Geometry',
    3: 'Tessellation',
    4: 'Addresses',
    5: 'Linkage',
    6: 'Kernel',
    9: 'Float16',
    10: 'Float64',
    11: 'Int64',
    12: 'Int64Atomics',
    22: 'Int16',
    23: 'TessellationPointSize',
    24: 'GeometryPointSize',
    25: 'ImageGatherExtended',
    27: 'StorageImageMultisample',
    32: 'ClipDistance',
    33: 'CullDistance',
    36: 'ImageRect',
    37: 'SampledRect',
    39: 'Int8',
    40: 'InputAttachment',
    41: 'SparseResidency',
    42: 'MinLod',
    46: 'SampledBuffer',
    47: 'ImageBuffer',
    48: 'ImageMSArray',
    52: 'InterpolationFunction',
    53: 'TransformFeedback',
    54: 'GeometryStreams',
    55: 'StorageImageReadWithoutFormat',
    56: 'StorageImageWriteWithoutFormat',
    57: 'MultiViewport',
    4423: 'SubgroupBallotKHR',
    4431: 'SubgroupVoteKHR',
    4437: 'DeviceGroup',
    4439: 'MultiView',
});

/** Execution models, by the registry's number. */
/** @type {Readonly<Record<number, string>>} */
export const EXECUTION_MODELS = Object.freeze({
    0: 'Vertex',
    1: 'TessellationControl',
    2: 'TessellationEvaluation',
    3: 'Geometry',
    4: 'Fragment',
    5: 'GLCompute',
    6: 'Kernel',
});

/** The opcodes this decoder reads operands of. */
export const Op = Object.freeze({
    Capability: 17,
    EntryPoint: 15,
    ExecutionMode: 16,
});

/**
 * @typedef {Object} SpirvInstruction
 * @property {number} opcode
 * @property {number[]} operands   the words after the first
 */

/**
 * @typedef {Object} SpirvEntryPoint
 * @property {number} model   an EXECUTION_MODELS key
 * @property {number} id
 * @property {string} name
 * @property {number[]} interfaces
 */

/**
 * @typedef {Object} SpirvModule
 * @property {number} version   the header's, as `major << 16 | minor << 8`
 * @property {number} generator
 * @property {number} bound
 * @property {number[]} capabilities
 * @property {SpirvEntryPoint[]} entryPoints
 * @property {SpirvInstruction[]} instructions
 */

/**
 * Decodes a module, or explains why it is not one.
 *
 * @param {Uint8Array} bytes
 * @returns {{ module: SpirvModule } | { error: string }}
 */
export function decodeSpirv(bytes){
    if (bytes.length < 20 || bytes.length % 4 !== 0)
    {
        return { error: `${bytes.length} bytes is not a whole number of words with a header` };
    }
    const words = new Uint32Array(bytes.length / 4);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let index = 0; index < words.length; index++)
    {
        words[index] = view.getUint32(index * 4, true);
    }
    if (words[0] !== SPIRV_MAGIC)
    {
        return { error: `the magic number is 0x${words[0].toString(16)}, not SPIR-V's` };
    }
    /** @type {SpirvModule} */
    const module = {
        version: words[1],
        generator: words[2],
        bound: words[3],
        capabilities: [],
        entryPoints: [],
        instructions: [],
    };
    let at = 5;
    while (at < words.length)
    {
        const length = words[at] >>> 16;
        const opcode = words[at] & 0xffff;
        if (length === 0 || at + length > words.length)
        {
            return { error: `instruction at word ${at} claims ${length} words; ${words.length - at}`
                + ' remain' };
        }
        const operands = Array.from(words.subarray(at + 1, at + length));
        module.instructions.push({ opcode, operands });
        if (opcode === Op.Capability)
        {
            module.capabilities.push(operands[0]);
        }
        else if (opcode === Op.EntryPoint)
        {
            const { text, next } = literalString(operands, 2);
            module.entryPoints.push({
                model: operands[0],
                id: operands[1],
                name: text,
                interfaces: operands.slice(next),
            });
        }
        at += length;
    }
    return { module };
}

/**
 * A literal string: UTF-8, NUL-terminated, padded to a word.
 *
 * @param {number[]} operands @param {number} from
 * @returns {{ text: string, next: number }} the text and the operand after it
 */
export function literalString(operands, from){
    const bytes = [];
    let index = from;
    for (; index < operands.length; index++)
    {
        const word = operands[index];
        let ended = false;
        for (let shift = 0; shift < 32; shift += 8)
        {
            const byte = (word >>> shift) & 0xff;
            if (byte === 0)
            {
                ended = true;
                break;
            }
            bytes.push(byte);
        }
        if (ended)
        {
            index++;
            break;
        }
    }
    return { text: new TextDecoder().decode(new Uint8Array(bytes)), next: index };
}

/**
 * The capabilities a module declares that this path cannot honour, named.
 *
 * @param {SpirvModule} module
 * @returns {string[]}
 */
export function unsupportedCapabilities(module){
    return module.capabilities
        .filter(capability=>!(capability in SUPPORTED_CAPABILITIES))
        .map(capability=>NAMED_CAPABILITIES[capability] ?? `capability ${capability}`);
}

/** @param {number} version @returns {string} `1.5` for the header's encoding of it */
export function versionString(version){
    return `${version >>> 16}.${(version >>> 8) & 0xff}`;
}
