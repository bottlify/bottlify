/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What the compiler's front half hands its back half, and the shader profiles
 * both are written against.
 *
 * The front half (`hlsl-lower.js`) turns the checked tree of one entry point
 * into straight-line code over *virtual registers*: functions are inlined,
 * loops unrolled, branches turned into selects, so there is no control flow to
 * reason about and a register's lifetime is an interval. The back half
 * (`hlsl-backend.js`) gives the virtual registers physical ones, the constants
 * and literals their registers, and writes the token stream.
 *
 * Lanes. An instruction's sources are read by *lane*, and what a lane means
 * depends on the opcode's class:
 *
 * - `comp`: componentwise. The result's component `c` is computed from lane
 *   `c` of every source; `c` is a component of the destination virtual
 *   register (or of the output register).
 * - `scalar`: lane 0 of each source is the operand; the result is replicated
 *   into every component the destination mask names.
 * - `lanes`: positional. `dp3` reads lanes 0 to 2 of both sources, `dp4` 0 to 3,
 *   `dp2add` lanes 0 and 1 of both and lane 0 of the third; a texture read
 *   takes the coordinate from lanes 0 to 3. The result is replicated.
 *
 * A source says which component of its register each lane reads (`swz`), so a
 * swizzle costs nothing: it is part of the operand.
 */

/** D3DXPARAMETER_CLASS. */
export const PC = Object.freeze({
    SCALAR: 0, VECTOR: 1, MATRIX_ROWS: 2, MATRIX_COLUMNS: 3, OBJECT: 4, STRUCT: 5,
});

/** D3DXPARAMETER_TYPE. */
export const PT = Object.freeze({
    VOID: 0, BOOL: 1, INT: 2, FLOAT: 3, STRING: 4, TEXTURE: 5, TEXTURE1D: 6, TEXTURE2D: 7,
    TEXTURE3D: 8, TEXTURECUBE: 9, SAMPLER: 10, SAMPLER1D: 11, SAMPLER2D: 12, SAMPLER3D: 13,
    SAMPLERCUBE: 14,
});

/** D3DXREGISTER_SET. */
export const RS = Object.freeze({ BOOL: 0, INT4: 1, FLOAT4: 2, SAMPLER: 3 });

/** D3DDECLUSAGE. */
export const USAGE = Object.freeze({
    POSITION: 0, BLENDWEIGHT: 1, BLENDINDICES: 2, NORMAL: 3, PSIZE: 4, TEXCOORD: 5,
    TANGENT: 6, BINORMAL: 7, TESSFACTOR: 8, POSITIONT: 9, COLOR: 10, FOG: 11, DEPTH: 12,
    SAMPLE: 13,
});

/**
 * A constant's type as the constant table records it.
 *
 * @typedef {Object} CtabType
 * @property {number} cls        PC.
 * @property {number} type       PT.
 * @property {number} rows
 * @property {number} cols
 * @property {number} elements   1 for what is not an array.
 * @property {{ name: string, type: CtabType }[]} [members]   For a structure.
 */

/**
 * The registers one instance of a type takes, as the constant table lays them
 * out: a column-packed matrix a register a column, a row-packed one a register
 * a row, a structure the sum of its members, an array the element times its
 * length.
 *
 * @param {CtabType} type
 * @returns {number}
 */
export function registersOf(type){
    let each;
    if (type.cls === PC.STRUCT)
    {
        each = (type.members ?? []).reduce((total, m)=>total + registersOf(m.type), 0);
    }
    else if (type.cls === PC.MATRIX_COLUMNS)
    {
        each = type.cols;
    }
    else if (type.cls === PC.MATRIX_ROWS)
    {
        each = type.rows;
    }
    else
    {
        each = 1;
    }
    return each * Math.max(type.elements, 1);
}

/**
 * A constant the shader reads: a uniform, or a sampler. The back half gives it
 * its register.
 *
 * @typedef {Object} Const
 * @property {string} name
 * @property {'f' | 'i' | 'b' | 's'} set   float4, int4, bool, sampler registers.
 * @property {CtabType} type
 * @property {number} [explicit]   The register the program asked for, or undefined.
 * @property {number[]} [defaults] The register data of its default: four floats a register.
 * @property {number} [index]      Assigned by the back half.
 * @property {number} [dim]        For a sampler: the D3DSAMPLER_TEXTURE_TYPE.
 */

/**
 * A virtual register: written by one or more instructions, each a different
 * part of it, and read by later ones. It has a `width` of components the
 * allocator gives a physical home to.
 *
 * @typedef {Object} VReg
 * @property {number} id
 * @property {number} width
 * @property {number} [fixed]      Must occupy components 0 to fixed-1 of its register: a
 *                                 `sincos` result (2), the argument of a `texkill` (3).
 * @property {string} [name]
 * @property {boolean} [uniform]  Holds one value in all four components: a model 1 pixel
 *                                shader reads it through any swizzle as it stands.
 * @property {{ file: 't' | 'r', index?: number, sampler?: Const }} [pin]   Must live in this
 *           register of a model 1 pixel shader: where a texture read leaves its texel.
 */

/**
 * @typedef {{ kind: 'reg', reg: VReg, swz: number[], neg?: boolean, abs?: boolean,
 *     mod?: string }} SrcReg
 * A virtual register read through a swizzle.
 *
 * @typedef {{ kind: 'imm', values: number[], neg?: boolean, abs?: boolean }} SrcImm
 * A literal, one value per lane; the back half puts it in a `def` register.
 *
 * @typedef {{ kind: 'const', cst: Const, offset: number, swz: number[], neg?: boolean,
 *     abs?: boolean, relative?: boolean, mod?: string }} SrcConst
 * Register `offset` of a constant. `relative` adds the address register a0.x.
 *
 * @typedef {{ kind: 'input', input: Input, swz: number[], neg?: boolean, abs?: boolean,
 *     mod?: string }} SrcInput
 * A shader input, read through a swizzle (components of the input's own register).
 *
 * @typedef {{ kind: 'sampler', cst: Const }} SrcSampler
 * @typedef {{ kind: 'misc', which: 'vpos' | 'vface', swz: number[], mod?: string }} SrcMisc
 * @typedef {{ kind: 'creg', file: 'f' | 'i' | 'b', index: number, swz: number[],
 *     neg?: boolean, abs?: boolean, relative?: boolean, mod?: string }} SrcCreg
 * A constant register by number: what the back half turns a literal into.
 *
 * @typedef {SrcReg | SrcImm | SrcConst | SrcInput | SrcSampler | SrcMisc | SrcCreg} Src
 */

/**
 * A shader input: a vertex attribute or an interpolated pixel input, named by
 * the semantic it arrives under.
 *
 * @typedef {Object} Input
 * @property {number} usage        USAGE.
 * @property {number} index
 * @property {number} width        Components the shader declares for it.
 * @property {number} [used]       Bitmask of the components that are read; filled by the back half.
 * @property {number} [reg]        Assigned by the back half.
 * @property {'v' | 't'} [file]   Which register file the back half gave it.
 */

/**
 * A shader output, named by semantic.
 *
 * @typedef {Object} Output
 * @property {number} usage        USAGE; COLOR in a pixel shader is a target, DEPTH the depth.
 * @property {number} index
 * @property {number} width
 * @property {number} [written]    Bitmask of components written; filled by the back half.
 * @property {number} [reg]
 */

/**
 * @typedef {{ kind: 'reg', reg: VReg, mask: number }
 *   | { kind: 'out', out: Output, mask: number }
 *   | { kind: 'addr' }
 *   | { kind: 'none' }} Dest
 */

/**
 * @typedef {Object} Instr
 * @property {string} op      A hardware opcode name ('mov', 'texld', ...).
 * @property {Dest} dest      Where the result goes; `none` for texkill.
 * @property {Src[]} srcs
 * @property {boolean} [sat]  Clamp the result to [0, 1] (pixel shaders only).
 * @property {'project' | 'bias' | undefined} [texMode]   For texld.
 * @property {boolean} [pp]   Partial precision.
 * @property {number} [shift]  A scale of the result, as the token holds it (model 1 only).
 */

/**
 * @typedef {Object} IrProgram
 * @property {Profile} profile
 * @property {Instr[]} instrs
 * @property {Input[]} inputs
 * @property {Output[]} outputs
 * @property {Const[]} constants   In declaration order; only those the shader reads.
 * @property {number} vregCount
 */

/**
 * What a target can do. `tokenMajor/Minor` are what the version token holds
 * (ps_2_a and ps_2_b are both 2.1).
 *
 * @typedef {Object} Profile
 * @property {string} name
 * @property {'vs' | 'ps'} kind
 * @property {number} major
 * @property {number} minor
 * @property {number} tokenMinor
 * @property {number} maxTemps
 * @property {number} maxConsts        Float constant registers.
 * @property {number} maxArith         Instruction slots (all of them for a vertex shader).
 * @property {number} maxTex           Texture instruction slots; 0 for no separate limit.
 * @property {boolean} absModifier     |r0| on a source.
 * @property {boolean} absOp           The abs instruction.
 * @property {boolean} satDest         The _sat destination modifier.
 * @property {boolean} cmp             The cmp instruction.
 * @property {boolean} lrp
 * @property {boolean} pow
 * @property {boolean} sincos
 * @property {boolean} sincosConstants Two constant operands after the source.
 * @property {boolean} mova
 * @property {boolean} dp2add
 * @property {boolean} derivatives     dsx, dsy.
 * @property {boolean} texldd          Gradients.
 * @property {boolean} texldl          A level of detail.
 * @property {boolean} texldb          A bias.
 * @property {boolean} oneConstPerInstr   At most one distinct c# among an instruction's sources.
 * @property {boolean} oneInputPerInstr   At most one distinct v# among them.
 * @property {number} maxInputs
 * @property {number} maxOutputs
 * @property {number} maxSamplers
 * @property {boolean} [legacy]    Pixel shader model 1: two temporaries, texture stages, results
 *                                 and constants held to a small range, a few instructions.
 * @property {ReadonlySet<string>} [ops]   The only opcodes a legacy target has.
 */

/** What the target cannot do, found while building for it. */
export class TargetError extends Error {
    /** @param {string} code @param {string} message */
    constructor(code, message){
        super(message);
        this.name = 'TargetError';
        this.code = code;
    }
}

/** @type {Record<string, Omit<Profile, 'name'>>} */
const PROFILE_TABLE = (()=>{
    /** @type {Omit<Profile, 'name' | 'kind' | 'major' | 'minor' | 'tokenMinor'>} */
    const none = {
        maxTemps: 12, maxConsts: 96, maxArith: 128, maxTex: 0, absModifier: false, absOp: false,
        satDest: false, cmp: false, lrp: false, pow: false, sincos: false,
        sincosConstants: false, mova: false, dp2add: false, derivatives: false, texldd: false,
        texldl: false, texldb: false, oneConstPerInstr: true, oneInputPerInstr: true,
        maxInputs: 16, maxOutputs: 0, maxSamplers: 0,
    };
    const vs2 = {
        ...none, maxConsts: 256, maxArith: 256, absModifier: true, absOp: true, lrp: true,
        pow: true, sincos: true, sincosConstants: true, mova: true,
    };
    const ps2 = {
        ...none, maxTemps: 12, maxConsts: 32, maxArith: 64, maxTex: 32, absOp: true,
        satDest: true, cmp: true, lrp: true, pow: true, sincos: true, sincosConstants: true,
        dp2add: true, texldb: true, oneConstPerInstr: false, oneInputPerInstr: false,
        maxInputs: 10, maxSamplers: 16,
    };
    const ps1 = {
        ...none, legacy: true, maxTemps: 2, maxConsts: 8, maxArith: 8, maxTex: 4,
        satDest: true, lrp: true, oneConstPerInstr: true, oneInputPerInstr: false,
        maxInputs: 2, maxOutputs: 1, maxSamplers: 4,
    };
    const legacyOps = ['mov', 'add', 'sub', 'mul', 'mad', 'lrp', 'dp3', 'cnd', 'tex', 'texcoord',
        'nop'];
    return {
        ps_1_1: { kind: 'ps', major: 1, minor: 1, tokenMinor: 1, ...ps1,
            ops: new Set(legacyOps) },
        ps_1_2: { kind: 'ps', major: 1, minor: 2, tokenMinor: 2, ...ps1, cmp: true,
            ops: new Set([...legacyOps, 'dp4', 'cmp']) },
        ps_1_3: { kind: 'ps', major: 1, minor: 3, tokenMinor: 3, ...ps1, cmp: true,
            ops: new Set([...legacyOps, 'dp4', 'cmp']) },
        ps_1_4: { kind: 'ps', major: 1, minor: 4, tokenMinor: 4, ...ps1, cmp: true,
            maxTemps: 6, maxTex: 6, maxSamplers: 6, maxInputs: 8,
            ops: new Set([...legacyOps, 'dp4', 'cmp', 'texld', 'texcrd', 'phase']) },
        vs_1_1: { kind: 'vs', major: 1, minor: 1, tokenMinor: 1, ...none, maxOutputs: 12 },
        vs_2_0: { kind: 'vs', major: 2, minor: 0, tokenMinor: 0, ...vs2, maxOutputs: 12 },
        vs_2_a: { kind: 'vs', major: 2, minor: 1, tokenMinor: 1, ...vs2, maxArith: 256,
            maxTemps: 13, maxOutputs: 12 },
        vs_3_0: { kind: 'vs', major: 3, minor: 0, tokenMinor: 0, ...vs2, maxTemps: 32,
            maxArith: 512, sincosConstants: false, maxOutputs: 12, texldl: true,
            maxSamplers: 4 },
        ps_2_0: { kind: 'ps', major: 2, minor: 0, tokenMinor: 0, ...ps2, maxOutputs: 4 },
        ps_2_a: { kind: 'ps', major: 2, minor: 1, tokenMinor: 1, ...ps2, maxTemps: 22,
            maxArith: 512, maxTex: 0, derivatives: true, texldd: true, maxOutputs: 4 },
        ps_2_b: { kind: 'ps', major: 2, minor: 1, tokenMinor: 1, ...ps2, maxTemps: 32,
            maxArith: 512, maxTex: 0, maxOutputs: 4 },
        ps_3_0: { kind: 'ps', major: 3, minor: 0, tokenMinor: 0, ...ps2, maxTemps: 32,
            maxConsts: 224, maxArith: 512, maxTex: 0, absModifier: true, derivatives: true,
            texldd: true, texldl: true, sincosConstants: false, maxOutputs: 4, maxInputs: 10 },
    };
})();

/** Names D3DX also accepts, which target the same hardware as another. */
const PROFILE_ALIASES = Object.freeze({
    vs_2_sw: 'vs_2_0', vs_3_sw: 'vs_3_0', ps_2_sw: 'ps_2_0', ps_3_sw: 'ps_3_0', vs_1_0: 'vs_1_1',
    vs_2_x: 'vs_2_a', ps_2_x: 'ps_2_a',
});

/**
 * @param {string} name   'vs_2_0' and the like, in any case.
 * @returns {Profile | null}   Null for a name that is no profile this compiler targets.
 */
export function profileOf(name){
    const lower = name.toLowerCase();
    const canonical = /** @type {Record<string, string>} */ (PROFILE_ALIASES)[lower] ?? lower;
    const entry = PROFILE_TABLE[canonical];
    return entry ? { name: canonical, ...entry } : null;
}

/** The version token a profile writes. @param {Profile} profile */
export function versionTokenOf(profile){
    return ((profile.kind === 'vs' ? 0xfffe0000 : 0xffff0000)
        | (profile.major << 8) | profile.tokenMinor) >>> 0;
}
