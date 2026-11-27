/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What the Shader Model 4 build hands the back end: instructions over virtual registers,
 * and the shader's inputs, outputs, constant buffers, textures and samplers, and the profiles
 * the compiler targets.
 *
 * An instruction names its operation by the assembler's spelling of the opcode (`add`,
 * `iadd`, `movc`, `sample_l`, `breakc_nz`), so the encoder needs no table of its own beyond
 * the opcode numbers. A virtual register is written whole by one instruction, or in parts by
 * several (`cat`), or again and again when it is a loop's variable (`carried`); the back end
 * gives each a temporary of its own for as long as it lives.
 */

/**
 * @typedef {Object} VReg
 * @property {number} id
 * @property {number} width
 * @property {boolean} [carried]   A loop's variable: live through the whole loop.
 */

/**
 * @typedef {Object} CbVariable
 * @property {string} name
 * @property {number} offset       Bytes from the start of its buffer.
 * @property {number} size         Bytes, as reflection reports it.
 * @property {RdefType} type
 * @property {boolean} used
 * @property {number[] | null} defaults   Its default, as dwords over `size`, or null.
 */

/**
 * The type of a constant buffer variable as RDEF describes it: D3D10_SHADER_VARIABLE_CLASS
 * and _TYPE, the shape, and a structure's members at their offsets.
 *
 * @typedef {Object} RdefType
 * @property {number} cls
 * @property {number} type
 * @property {number} rows
 * @property {number} cols
 * @property {number} elements     0 for what is not an array.
 * @property {{ name: string, offset: number, type: RdefType }[]} members
 */

/**
 * @typedef {Object} ConstantBuffer
 * @property {string} name
 * @property {number} slot          The cb# register; -1 until the back end gives one.
 * @property {number | null} explicit   The register the program named.
 * @property {number} size          Bytes, a multiple of 16.
 * @property {CbVariable[]} variables
 * @property {boolean} used
 * @property {0 | 1} kind           D3D10_CBUFFER_TYPE: a cbuffer or a tbuffer.
 * @property {number} order
 */

/**
 * @typedef {Object} Resource
 * @property {string} name
 * @property {number} slot          t#; -1 until given.
 * @property {number | null} explicit
 * @property {number} count         Elements of an array of textures, 1 for one.
 * @property {string} dim           The checker's dimension ('2d', '2darray', 'buffer', ...).
 * @property {'f' | 'i' | 'u'} kind   What a texel's components are.
 * @property {number} components    1 to 4.
 * @property {number} samples       Of a multisampled texture; 0 for any other.
 * @property {boolean} used
 * @property {number} order
 */

/**
 * @typedef {Object} SamplerBinding
 * @property {string} name
 * @property {number} slot
 * @property {number | null} explicit
 * @property {number} count
 * @property {boolean} comparison
 * @property {boolean} used
 * @property {number} order
 */

/**
 * @typedef {{ kind: 'reg', reg: VReg, swz: number[], neg?: boolean, abs?: boolean }
 *   | { kind: 'imm', values: number[], t: 'f' | 'i' | 'u' | 'b' }
 *   | { kind: 'cb', buffer: ConstantBuffer, variable: CbVariable | null, row: number,
 *       rel?: Src | null, swz: number[], neg?: boolean, abs?: boolean }
 *   | { kind: 'input', input: Input, swz: number[], neg?: boolean, abs?: boolean }
 *   | { kind: 'resource', resource: Resource, element: number }
 *   | { kind: 'sampler', sampler: SamplerBinding, element: number }} Src
 */

/**
 * @typedef {{ kind: 'reg', reg: VReg, mask: number }
 *   | { kind: 'out', out: Output, mask: number }
 *   | { kind: 'null' }} Dest
 */

/**
 * @typedef {Object} Instr
 * @property {string} op
 * @property {Dest[]} dests     None for flow control, two for sincos, udiv and the like.
 * @property {Src[]} srcs
 * @property {boolean} [sat]
 * @property {number[]} [offset]   A texel offset of a read: u, v, w.
 * @property {boolean} [rcpFloat]  resinfo's _rcpFloat; `uint` for _uint.
 * @property {boolean} [uint]
 */

/**
 * A signature element read by the shader.
 *
 * @typedef {Object} Input
 * @property {string} name      The semantic as written, without its index.
 * @property {number} index
 * @property {number} width
 * @property {'f' | 'i' | 'u'} kind
 * @property {number} sv         D3D_NAME of a system value, 0 for none.
 * @property {'linear' | 'constant' | 'noperspective'} interpolation
 * @property {number} [used]     Components read; filled by the back end.
 * @property {number} [reg]
 */

/**
 * A signature element the shader writes.
 *
 * @typedef {Object} Output
 * @property {string} name
 * @property {number} index
 * @property {number} width
 * @property {'f' | 'i' | 'u'} kind
 * @property {number} sv         The system value the declaration names (`dcl_output_siv`).
 * @property {number} first      The first component the value lands in.
 * @property {boolean} [depth]   oDepth rather than a register.
 * @property {number} [target]   SV_Target's index: the register it must be.
 * @property {number} [written]
 * @property {number} [reg]
 */

/**
 * @typedef {Object} Profile4
 * @property {string} name
 * @property {'vs' | 'ps' | 'gs' | 'cs'} kind
 * @property {number} major
 * @property {number} minor
 * @property {true} sm4
 * @property {false} legacy
 */

/**
 * @typedef {Object} Program4
 * @property {Profile4} profile
 * @property {Instr[]} instrs
 * @property {Input[]} inputs
 * @property {Output[]} outputs
 * @property {ConstantBuffer[]} buffers
 * @property {Resource[]} resources
 * @property {SamplerBinding[]} samplers
 * @property {number} vregCount
 */

/** The shader models this compiler writes, by profile name. */
const PROFILES = Object.freeze({
    vs_4_0: ['vs', 4, 0], vs_4_1: ['vs', 4, 1], ps_4_0: ['ps', 4, 0], ps_4_1: ['ps', 4, 1],
    gs_4_0: ['gs', 4, 0], gs_4_1: ['gs', 4, 1], vs_5_0: ['vs', 5, 0], ps_5_0: ['ps', 5, 0],
    // The feature level 9 profiles write model 4 code for a lesser device.
    vs_4_0_level_9_1: ['vs', 4, 0], vs_4_0_level_9_3: ['vs', 4, 0],
    ps_4_0_level_9_1: ['ps', 4, 0], ps_4_0_level_9_3: ['ps', 4, 0],
});

/**
 * @param {string} name
 * @returns {Profile4 | null}
 */
export function profile4Of(name){
    const entry = /** @type {Record<string, [any, number, number]>} */ (
        /** @type {unknown} */ (PROFILES))[name];
    return entry ? { name, kind: entry[0], major: entry[1], minor: entry[2], sm4: true,
        legacy: false } : null;
}

/** Every profile name `profile4Of` knows. */
export const PROFILE_NAMES = Object.freeze(Object.keys(PROFILES));
