/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The Shader Model 4 token stream, decoded into instructions.
 *
 * Every instruction is one opcode token followed by its operands, and every
 * operand is one token followed by its indices. The opcode token carries the
 * instruction's total length in dwords, which is what lets an instruction this
 * decoder does not understand be skipped rather than derailing everything
 * after it: the length is trusted, the opcode is kept by number, and the
 * translator decides what to say about it.
 *
 * Two things about the encoding are worth knowing before reading the operand
 * decoder, because they are where a reader's intuition is wrong:
 *
 * - **A register has no type.** `r0` holds thirty-two bit patterns, and whether
 *   an instruction reads them as floats or integers is the instruction's
 *   business. `add` is a float add, `iadd` an integer one, over the same
 *   register file. The decoder therefore never assigns a type to an operand.
 * - **The swizzle and the write mask share one field**, and which it is depends
 *   on the selection mode two bits below. A destination is nearly always a
 *   mask and a source nearly always a swizzle, but an immediate carries neither,
 *   and a one-component operand -- a sampler, a constant buffer index -- uses
 *   the third mode, a single selected component.
 */

/** Opcode numbers, as the token format assigns them. */
export const OPCODE = Object.freeze({
    ADD: 0,
    AND: 1,
    BREAK: 2,
    BREAKC: 3,
    CALL: 4,
    CALLC: 5,
    CASE: 6,
    CONTINUE: 7,
    CONTINUEC: 8,
    CUT: 9,
    DEFAULT: 10,
    DERIV_RTX: 11,
    DERIV_RTY: 12,
    DISCARD: 13,
    DIV: 14,
    DP2: 15,
    DP3: 16,
    DP4: 17,
    ELSE: 18,
    EMIT: 19,
    EMITTHENCUT: 20,
    ENDIF: 21,
    ENDLOOP: 22,
    ENDSWITCH: 23,
    EQ: 24,
    EXP: 25,
    FRC: 26,
    FTOI: 27,
    FTOU: 28,
    GE: 29,
    IADD: 30,
    IF: 31,
    IEQ: 32,
    IGE: 33,
    ILT: 34,
    IMAD: 35,
    IMAX: 36,
    IMIN: 37,
    IMUL: 38,
    INE: 39,
    INEG: 40,
    ISHL: 41,
    ISHR: 42,
    ITOF: 43,
    LABEL: 44,
    LD: 45,
    LD_MS: 46,
    LOG: 47,
    LOOP: 48,
    LT: 49,
    MAD: 50,
    MIN: 51,
    MAX: 52,
    CUSTOMDATA: 53,
    MOV: 54,
    MOVC: 55,
    MUL: 56,
    NE: 57,
    NOP: 58,
    NOT: 59,
    OR: 60,
    RESINFO: 61,
    RET: 62,
    RETC: 63,
    ROUND_NE: 64,
    ROUND_NI: 65,
    ROUND_PI: 66,
    ROUND_Z: 67,
    RSQ: 68,
    SAMPLE: 69,
    SAMPLE_C: 70,
    SAMPLE_C_LZ: 71,
    SAMPLE_L: 72,
    SAMPLE_D: 73,
    SAMPLE_B: 74,
    SQRT: 75,
    SWITCH: 76,
    SINCOS: 77,
    UDIV: 78,
    ULT: 79,
    UGE: 80,
    UMUL: 81,
    UMAD: 82,
    UMAX: 83,
    UMIN: 84,
    USHR: 85,
    UTOF: 86,
    XOR: 87,
    DCL_RESOURCE: 88,
    DCL_CONSTANT_BUFFER: 89,
    DCL_SAMPLER: 90,
    DCL_INDEX_RANGE: 91,
    DCL_GS_OUTPUT_PRIMITIVE_TOPOLOGY: 92,
    DCL_GS_INPUT_PRIMITIVE: 93,
    DCL_MAX_OUTPUT_VERTEX_COUNT: 94,
    DCL_INPUT: 95,
    DCL_INPUT_SGV: 96,
    DCL_INPUT_SIV: 97,
    DCL_INPUT_PS: 98,
    DCL_INPUT_PS_SGV: 99,
    DCL_INPUT_PS_SIV: 100,
    DCL_OUTPUT: 101,
    DCL_OUTPUT_SGV: 102,
    DCL_OUTPUT_SIV: 103,
    DCL_TEMPS: 104,
    DCL_INDEXABLE_TEMP: 105,
    DCL_GLOBAL_FLAGS: 106,
    LOD: 108,
    GATHER4: 109,
    SAMPLE_POS: 110,
    SAMPLE_INFO: 111,
    // Shader Model 5.
    HS_DECLS: 113,
    HS_CONTROL_POINT_PHASE: 114,
    HS_FORK_PHASE: 115,
    HS_JOIN_PHASE: 116,
    EMIT_STREAM: 117,
    CUT_STREAM: 118,
    EMITTHENCUT_STREAM: 119,
    INTERFACE_CALL: 120,
    BUFINFO: 121,
    DERIV_RTX_COARSE: 122,
    DERIV_RTX_FINE: 123,
    DERIV_RTY_COARSE: 124,
    DERIV_RTY_FINE: 125,
    GATHER4_C: 126,
    GATHER4_PO: 127,
    GATHER4_PO_C: 128,
    RCP: 129,
    F32TOF16: 130,
    F16TOF32: 131,
    UADDC: 132,
    USUBB: 133,
    COUNTBITS: 134,
    FIRSTBIT_HI: 135,
    FIRSTBIT_LO: 136,
    FIRSTBIT_SHI: 137,
    UBFE: 138,
    IBFE: 139,
    BFI: 140,
    BFREV: 141,
    SWAPC: 142,
    DCL_STREAM: 143,
    DCL_FUNCTION_BODY: 144,
    DCL_FUNCTION_TABLE: 145,
    DCL_INTERFACE: 146,
    DCL_INPUT_CONTROL_POINT_COUNT: 147,
    DCL_OUTPUT_CONTROL_POINT_COUNT: 148,
    DCL_TESS_DOMAIN: 149,
    DCL_TESS_PARTITIONING: 150,
    DCL_TESS_OUTPUT_PRIMITIVE: 151,
    DCL_HS_MAX_TESSFACTOR: 152,
    DCL_HS_FORK_PHASE_INSTANCE_COUNT: 153,
    DCL_HS_JOIN_PHASE_INSTANCE_COUNT: 154,
    DCL_THREAD_GROUP: 155,
    DCL_UAV_TYPED: 156,
    DCL_UAV_RAW: 157,
    DCL_UAV_STRUCTURED: 158,
    DCL_TGSM_RAW: 159,
    DCL_TGSM_STRUCTURED: 160,
    DCL_RESOURCE_RAW: 161,
    DCL_RESOURCE_STRUCTURED: 162,
    LD_UAV_TYPED: 163,
    STORE_UAV_TYPED: 164,
    LD_RAW: 165,
    STORE_RAW: 166,
    LD_STRUCTURED: 167,
    STORE_STRUCTURED: 168,
    ATOMIC_AND: 169,
    ATOMIC_OR: 170,
    ATOMIC_XOR: 171,
    ATOMIC_CMP_STORE: 172,
    ATOMIC_IADD: 173,
    ATOMIC_IMAX: 174,
    ATOMIC_IMIN: 175,
    ATOMIC_UMAX: 176,
    ATOMIC_UMIN: 177,
    IMM_ATOMIC_ALLOC: 178,
    IMM_ATOMIC_CONSUME: 179,
    IMM_ATOMIC_IADD: 180,
    IMM_ATOMIC_AND: 181,
    IMM_ATOMIC_OR: 182,
    IMM_ATOMIC_XOR: 183,
    IMM_ATOMIC_EXCH: 184,
    IMM_ATOMIC_CMP_EXCH: 185,
    IMM_ATOMIC_IMAX: 186,
    IMM_ATOMIC_IMIN: 187,
    IMM_ATOMIC_UMAX: 188,
    IMM_ATOMIC_UMIN: 189,
    SYNC: 190,
    // Double precision: two dwords a value, .xy and .zw of a register, low
    // dword first; 210-217 are the extended set (D3D11_OPTIONS).
    DADD: 191,
    DMAX: 192,
    DMIN: 193,
    DMUL: 194,
    DEQ: 195,
    DGE: 196,
    DLT: 197,
    DNE: 198,
    DMOV: 199,
    DMOVC: 200,
    DTOF: 201,
    FTOD: 202,
    EVAL_SNAPPED: 203,
    EVAL_SAMPLE_INDEX: 204,
    EVAL_CENTROID: 205,
    DCL_GS_INSTANCE_COUNT: 206,
    ABORT: 207,
    DEBUG_BREAK: 208,
    DDIV: 210,
    DFMA: 211,
    DRCP: 212,
    MSAD: 213,
    DTOI: 214,
    DTOU: 215,
    ITOD: 216,
    UTOD: 217,
});

/** The name each opcode number prints as, for a divergence or a dump. */
export const OPCODE_NAME = Object.freeze(Object.fromEntries(
    Object.entries(OPCODE).map(([name, code])=>[code, name.toLowerCase()])));

/** What an operand token names. */
export const OPERAND = Object.freeze({
    TEMP: 0,
    INPUT: 1,
    OUTPUT: 2,
    INDEXABLE_TEMP: 3,
    IMMEDIATE32: 4,
    IMMEDIATE64: 5,
    SAMPLER: 6,
    RESOURCE: 7,
    CONSTANT_BUFFER: 8,
    IMMEDIATE_CONSTANT_BUFFER: 9,
    LABEL: 10,
    INPUT_PRIMITIVE_ID: 11,
    OUTPUT_DEPTH: 12,
    NULL: 13,
    RASTERIZER: 14,
    OUTPUT_COVERAGE_MASK: 15,
    // Shader Model 5: class linkage (fb#, ft#, fp#, this[#]), the
    // tessellation stages' own, then the rest.
    FUNCTION_BODY: 17,
    FUNCTION_TABLE: 18,
    INTERFACE: 19,
    FUNCTION_INPUT: 20,
    FUNCTION_OUTPUT: 21,
    OUTPUT_CONTROL_POINT_ID: 22,
    INPUT_FORK_INSTANCE_ID: 23,
    INPUT_JOIN_INSTANCE_ID: 24,
    INPUT_CONTROL_POINT: 25,
    OUTPUT_CONTROL_POINT: 26,
    INPUT_PATCH_CONSTANT: 27,
    INPUT_DOMAIN_POINT: 28,
    THIS_POINTER: 29,
    UNORDERED_ACCESS_VIEW: 30,
    THREAD_GROUP_SHARED_MEMORY: 31,
    INPUT_THREAD_ID: 32,
    INPUT_THREAD_GROUP_ID: 33,
    INPUT_THREAD_ID_IN_GROUP: 34,
    INPUT_COVERAGE_MASK: 35,
    INPUT_THREAD_ID_IN_GROUP_FLATTENED: 36,
    INPUT_GS_INSTANCE_ID: 37,
    OUTPUT_DEPTH_GREATER_EQUAL: 38,
    OUTPUT_DEPTH_LESS_EQUAL: 39,
});

/** `sync`'s flags, in its control bits. */
export const SYNC_FLAG = Object.freeze({
    THREADS_IN_GROUP: 0x1,
    THREAD_GROUP_SHARED_MEMORY: 0x2,
    UAV_MEMORY_GROUP: 0x4,
    UAV_MEMORY_GLOBAL: 0x8,
});

export const SELECTION = Object.freeze({
    MASK: 0,
    SWIZZLE: 1,
    SELECT1: 2,
});

export const MODIFIER = Object.freeze({
    NONE: 0,
    NEG: 1,
    ABS: 2,
    ABSNEG: 3,
});

/** The dimension field of `dcl_resource`. */
export const RESOURCE_DIMENSION = Object.freeze({
    UNKNOWN: 0,
    BUFFER: 1,
    TEXTURE1D: 2,
    TEXTURE2D: 3,
    TEXTURE2DMS: 4,
    TEXTURE3D: 5,
    TEXTURECUBE: 6,
    TEXTURE1DARRAY: 7,
    TEXTURE2DARRAY: 8,
    TEXTURE2DMSARRAY: 9,
    TEXTURECUBEARRAY: 10,
});

/** The per-component return type of `dcl_resource`. */
export const RETURN_TYPE = Object.freeze({
    UNORM: 1,
    SNORM: 2,
    SINT: 3,
    UINT: 4,
    FLOAT: 5,
    MIXED: 6,
});

/** The mode field of `dcl_sampler`. */
export const SAMPLER_MODE = Object.freeze({
    DEFAULT: 0,
    COMPARISON: 1,
    MONO: 2,
});

/** The class field of a `customdata` block. */
export const CUSTOMDATA = Object.freeze({
    IMMEDIATE_CONSTANT_BUFFER: 3,
});

/** The identity swizzle, `.xyzw`. */
export const IDENTITY_SWIZZLE = Object.freeze([0, 1, 2, 3]);

/**
 * @typedef {Object} OperandIndex
 * @property {number} value            The immediate part, zero when there is none.
 * @property {Operand | null} relative The register added to it, when the index is relative.
 */

/**
 * @typedef {Object} Operand
 * @property {number} type            An OPERAND.
 * @property {number} componentCount  0, 1 or 4.
 * @property {number} selection       A SELECTION.
 * @property {number} mask            The write mask, when selection is MASK.
 * @property {readonly number[]} swizzle  Four component numbers, when SWIZZLE or SELECT1.
 * @property {OperandIndex[]} indices
 * @property {number[]} immediate     The dwords of an immediate operand.
 * @property {number} modifier        A MODIFIER.
 */

/**
 * @typedef {Object} Instruction
 * @property {number} opcode
 * @property {string} name
 * @property {boolean} saturate
 * @property {boolean} testNonZero  For the conditional forms: branch when non-zero.
 * @property {number} control       Whatever the opcode keeps in bits 11..23, undecoded.
 * @property {Operand[]} operands
 * @property {number[]} extra       Dwords after the operands: a system value, a
 *                                  return type, a constant count.
 * @property {number[]} [customData] The payload of a customdata block.
 * @property {number[]} [offset]   A sample's immediate texel offset (`aoffimmi`), u, v
 *                                  and w, from its extended token; absent for none.
 * @property {number} [callSite]  `fcall`'s: which of a function table's bodies it calls,
 *                                  the dword before its interface operand.
 * @property {number} length        In dwords, this instruction and its operands.
 */

/**
 * @param {Uint32Array} tokens
 * @param {number} at
 * @returns {{ operand: Operand, next: number }}
 */
export function decodeOperand(tokens, at){
    const token = tokens[at];
    let next = at + 1;
    /** @type {number} */
    let modifier = MODIFIER.NONE;
    let extended = (token & 0x80000000) !== 0;
    while (extended)
    {
        const extra = tokens[next++];
        if ((extra & 0x3f) === 1)
        {
            modifier = (extra >>> 6) & 0xff;
        }
        extended = (extra & 0x80000000) !== 0;
    }
    const countCode = token & 0x3;
    const componentCount = countCode === 2 ? 4 : countCode;
    const selection = (token >>> 2) & 0x3;
    const field = (token >>> 4) & 0xff;
    const type = (token >>> 12) & 0xff;
    const indexDimension = (token >>> 20) & 0x3;

    let mask = 0xf;
    /** @type {readonly number[]} */
    let swizzle = IDENTITY_SWIZZLE;
    if (componentCount === 4)
    {
        if (selection === SELECTION.MASK)
        {
            mask = field & 0xf;
        }
        else if (selection === SELECTION.SWIZZLE)
        {
            swizzle = [field & 3, (field >>> 2) & 3, (field >>> 4) & 3, (field >>> 6) & 3];
        }
        else
        {
            const one = field & 3;
            swizzle = [one, one, one, one];
        }
    }

    /** @type {number[]} */
    const immediate = [];
    if (type === OPERAND.IMMEDIATE32)
    {
        const count = componentCount === 0 ? 1 : componentCount;
        for (let index = 0; index < count; index++)
        {
            immediate.push(tokens[next++]);
        }
    }
    else if (type === OPERAND.IMMEDIATE64)
    {
        // One double, or two (a vec4 of dwords): never four.
        const count = componentCount === 0 || componentCount === 1 ? 2 : 4;
        for (let index = 0; index < count; index++)
        {
            immediate.push(tokens[next++]);
        }
    }

    /** @type {OperandIndex[]} */
    const indices = [];
    for (let dimension = 0; dimension < indexDimension; dimension++)
    {
        const representation = (token >>> (22 + dimension * 3)) & 0x7;
        /** @type {number} */
        let value = 0;
        /** @type {Operand | null} */
        let relative = null;
        // 0 imm32, 1 imm64, 2 relative, 3 imm32 + relative, 4 imm64 + relative.
        if (representation === 0 || representation === 3)
        {
            value = tokens[next++];
        }
        else if (representation === 1 || representation === 4)
        {
            // The high dword of a 64-bit index is never meaningful for a
            // register file this small; the low one is the index.
            value = tokens[next];
            next += 2;
        }
        if (representation >= 2)
        {
            const decoded = decodeOperand(tokens, next);
            relative = decoded.operand;
            next = decoded.next;
        }
        indices.push({ value, relative });
    }

    return {
        operand: { type, componentCount, selection, mask, swizzle, indices, immediate, modifier },
        next,
    };
}

/**
 * How many operands each opcode takes. Declarations and the flow-control
 * opcodes are listed explicitly; anything absent is decoded with as many
 * operands as fit its length, which is right for every arithmetic opcode.
 *
 * @type {Readonly<Record<number, number>>}
 */
const OPERAND_COUNT = Object.freeze({
    [OPCODE.DCL_RESOURCE]: 1,
    [OPCODE.DCL_CONSTANT_BUFFER]: 1,
    [OPCODE.DCL_SAMPLER]: 1,
    [OPCODE.DCL_INPUT]: 1,
    [OPCODE.DCL_INPUT_SGV]: 1,
    [OPCODE.DCL_INPUT_SIV]: 1,
    [OPCODE.DCL_INPUT_PS]: 1,
    [OPCODE.DCL_INPUT_PS_SGV]: 1,
    [OPCODE.DCL_INPUT_PS_SIV]: 1,
    [OPCODE.DCL_OUTPUT]: 1,
    [OPCODE.DCL_OUTPUT_SGV]: 1,
    [OPCODE.DCL_OUTPUT_SIV]: 1,
    [OPCODE.DCL_TEMPS]: 0,
    [OPCODE.DCL_INDEXABLE_TEMP]: 0,
    [OPCODE.DCL_GLOBAL_FLAGS]: 0,
    [OPCODE.DCL_INDEX_RANGE]: 1,
    [OPCODE.DCL_GS_OUTPUT_PRIMITIVE_TOPOLOGY]: 0,
    [OPCODE.DCL_GS_INPUT_PRIMITIVE]: 0,
    [OPCODE.DCL_MAX_OUTPUT_VERTEX_COUNT]: 0,
    [OPCODE.DCL_THREAD_GROUP]: 0,
    [OPCODE.DCL_UAV_TYPED]: 1,
    [OPCODE.DCL_UAV_RAW]: 1,
    [OPCODE.DCL_UAV_STRUCTURED]: 1,
    [OPCODE.DCL_TGSM_RAW]: 1,
    [OPCODE.DCL_TGSM_STRUCTURED]: 1,
    [OPCODE.DCL_RESOURCE_RAW]: 1,
    [OPCODE.DCL_RESOURCE_STRUCTURED]: 1,
    [OPCODE.DCL_STREAM]: 1,
    [OPCODE.DCL_GS_INSTANCE_COUNT]: 0,
    [OPCODE.DCL_INPUT_CONTROL_POINT_COUNT]: 0,
    [OPCODE.DCL_OUTPUT_CONTROL_POINT_COUNT]: 0,
    [OPCODE.DCL_TESS_DOMAIN]: 0,
    [OPCODE.DCL_TESS_PARTITIONING]: 0,
    [OPCODE.DCL_TESS_OUTPUT_PRIMITIVE]: 0,
    [OPCODE.DCL_HS_MAX_TESSFACTOR]: 0,
    [OPCODE.DCL_HS_FORK_PHASE_INSTANCE_COUNT]: 0,
    [OPCODE.DCL_HS_JOIN_PHASE_INSTANCE_COUNT]: 0,
    [OPCODE.DCL_FUNCTION_BODY]: 0,
    [OPCODE.DCL_FUNCTION_TABLE]: 0,
    [OPCODE.DCL_INTERFACE]: 0,
    [OPCODE.SYNC]: 0,
});

/**
 * @param {Uint32Array} tokens
 * @returns {Instruction[]}
 */
export function decodeSm4(tokens){
    /** @type {Instruction[]} */
    const instructions = [];
    let at = 0;
    while (at < tokens.length)
    {
        const token = tokens[at];
        const opcode = token & 0x7ff;

        if (opcode === OPCODE.CUSTOMDATA)
        {
            // A customdata block carries its length in the next dword rather
            // than in the opcode token, and its class where other opcodes keep
            // their controls.
            const length = tokens[at + 1];
            instructions.push({
                opcode,
                name: OPCODE_NAME[opcode],
                saturate: false,
                testNonZero: false,
                control: token >>> 11,
                operands: [],
                extra: [],
                customData: Array.from(tokens.subarray(at + 2, at + length)),
                length,
            });
            at += Math.max(length, 2);
            continue;
        }

        const length = (token >>> 24) & 0x7f;
        const end = at + Math.max(length, 1);
        let next = at + 1;
        let extended = (token & 0x80000000) !== 0;
        /** @type {number[]} */
        const extendedTokens = [];
        /** @type {number[] | undefined} */
        let offset;
        while (extended && next < end)
        {
            const extra = tokens[next++];
            extendedTokens.push(extra);
            extended = (extra & 0x80000000) !== 0;
            // Sample controls: three signed four-bit texel offsets.
            if ((extra & 0x3f) === 1)
            {
                offset = [9, 13, 17].map(shift=>((extra >>> shift) & 0xf) << 28 >> 28);
            }
        }

        // `fcall` names the call site before its operand.
        const callSite = opcode === OPCODE.INTERFACE_CALL && next < end ? tokens[next++] : null;
        const wanted = OPERAND_COUNT[opcode] ?? Infinity;
        /** @type {Operand[]} */
        const operands = [];
        while (next < end && operands.length < wanted)
        {
            const decoded = decodeOperand(tokens, next);
            operands.push(decoded.operand);
            next = decoded.next;
        }

        instructions.push({
            opcode,
            name: OPCODE_NAME[opcode] ?? `opcode_${opcode}`,
            saturate: (token & 0x2000) !== 0,
            testNonZero: (token & 0x40000) !== 0,
            control: (token >>> 11) & 0x1fff,
            operands,
            extra: [...extendedTokens, ...Array.from(tokens.subarray(next, end))],
            length: end - at,
            ...(offset && offset.some(Boolean) ? { offset } : {}),
            ...(callSite === null ? {} : { callSite }),
        });
        at = end;
    }
    return instructions;
}

/** @param {Operand} operand @returns {string} a register the way the assembler spells it */
export function registerName(operand){
    const prefix = {
        [OPERAND.TEMP]: 'r',
        [OPERAND.INPUT]: 'v',
        [OPERAND.OUTPUT]: 'o',
        [OPERAND.INDEXABLE_TEMP]: 'x',
        [OPERAND.SAMPLER]: 's',
        [OPERAND.RESOURCE]: 't',
        [OPERAND.CONSTANT_BUFFER]: 'cb',
        [OPERAND.IMMEDIATE_CONSTANT_BUFFER]: 'icb',
        [OPERAND.OUTPUT_DEPTH]: 'oDepth',
        [OPERAND.NULL]: 'null',
        [OPERAND.UNORDERED_ACCESS_VIEW]: 'u',
        [OPERAND.THREAD_GROUP_SHARED_MEMORY]: 'g',
    }[operand.type] ?? `op${operand.type}`;
    const first = operand.indices[0];
    return first ? `${prefix}${first.value}` : prefix;
}
