/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Shader bytecode: what a program hands CreateVertexShader, read back into
 * something that can be checked, kept and -- by whoever translates it --
 * turned into a shader the GPU runs.
 *
 * The token stream is documented well enough to parse from its description: a
 * version token, then instructions, each an opcode token followed by its
 * operands, closed by an end token. What is not obvious, and is written down
 * here because it decides whether the stream is read correctly at all:
 *
 * - **The length field is only trustworthy from shader model 2.** Before that
 *   the field is zero and the operand count comes from the opcode itself, so
 *   the table below carries a count per opcode and is consulted whenever the
 *   field says nothing.
 * - **Relative addressing takes an extra token from model 2 on.** A vs_1_1
 *   source that addresses relatively means `a0.x` and says so in one bit; a
 *   vs_2_0 source that does so is followed by a whole second token naming
 *   the address register and its component.
 * - **Three opcodes carry literals rather than operands.** A float, integer
 *   or boolean definition is a destination followed by four, four or one raw
 *   dwords, and reading those as parameter tokens finds registers that do
 *   not exist.
 * - **The register type is split across the token.** Three bits at the top
 *   and two more in the middle, because the top three ran out.
 *
 * The constant register files are here too, because they are the other half
 * of what a shader is: a program sets constants by register number and reads
 * them back, and the bounds it is refused at are part of the contract.
 */

import { D3DERR_INVALIDCALL, D3D_OK } from './constants.js';

/** The two shader kinds, as the version token's high word spells them. */
export const SHADER_KIND = Object.freeze({ VERTEX: 'vertex', PIXEL: 'pixel' });

const VERSION_VERTEX = 0xfffe;
const VERSION_PIXEL = 0xffff;
export const END_TOKEN = 0x0000ffff;
const COMMENT_OPCODE = 0xfffe;

/** D3DSIO, the instruction opcodes. */
export const OPCODE = Object.freeze({
    NOP: 0, MOV: 1, ADD: 2, SUB: 3, MAD: 4, MUL: 5, RCP: 6, RSQ: 7, DP3: 8, DP4: 9,
    MIN: 10, MAX: 11, SLT: 12, SGE: 13, EXP: 14, LOG: 15, LIT: 16, DST: 17, LRP: 18,
    FRC: 19, M4x4: 20, M4x3: 21, M3x4: 22, M3x3: 23, M3x2: 24, CALL: 25, CALLNZ: 26,
    LOOP: 27, RET: 28, ENDLOOP: 29, LABEL: 30, DCL: 31, POW: 32, CRS: 33, SGN: 34,
    ABS: 35, NRM: 36, SINCOS: 37, REP: 38, ENDREP: 39, IF: 40, IFC: 41, ELSE: 42,
    ENDIF: 43, BREAK: 44, BREAKC: 45, MOVA: 46, DEFB: 47, DEFI: 48,
    TEXCOORD: 64, TEXKILL: 65, TEX: 66, TEXBEM: 67, TEXBEML: 68, TEXREG2AR: 69,
    TEXREG2GB: 70, TEXM3x2PAD: 71, TEXM3x2TEX: 72, TEXM3x3PAD: 73, TEXM3x3TEX: 74,
    TEXM3x3SPEC: 76, TEXM3x3VSPEC: 77, EXPP: 78, LOGP: 79, CND: 80, DEF: 81,
    TEXREG2RGB: 82, TEXDP3TEX: 83, TEXM3x2DEPTH: 84, TEXDP3: 85, TEXM3x3: 86,
    TEXDEPTH: 87, CMP: 88, BEM: 89, DP2ADD: 90, DSX: 91, DSY: 92, TEXLDD: 93,
    SETP: 94, TEXLDL: 95, BREAKP: 96, PHASE: 0xfffd,
});

/** D3DSPR, the register types. */
export const REGISTER = Object.freeze({
    TEMP: 0,
    INPUT: 1,
    CONST: 2,
    /** The address register in a vertex shader; a texture register in a 1.x pixel shader. */
    ADDR: 3,
    TEXTURE: 3,
    RASTOUT: 4,
    ATTROUT: 5,
    /** Texture coordinate output in vs_1_x/2_x; the general output in vs_3_0. */
    TEXCRDOUT: 6,
    OUTPUT: 6,
    CONSTINT: 7,
    COLOROUT: 8,
    DEPTHOUT: 9,
    SAMPLER: 10,
    CONST2: 11,
    CONST3: 12,
    CONST4: 13,
    CONSTBOOL: 14,
    LOOP: 15,
    TEMPFLOAT16: 16,
    MISCTYPE: 17,
    LABEL: 18,
    PREDICATE: 19,
});

/**
 * How many operands each opcode takes when the length field says nothing:
 * whether it writes a destination, and how many sources it reads.
 *
 * Shader model 1 is where this table is consulted, so the counts are 1.x's --
 * `tex` reads no source there where its 2.0 form reads two, and `sincos` in
 * 2.0 reads three where 3.0 reads one; from 2.0 on the length field decides
 * and the table is not looked at.
 *
 * @type {Readonly<Record<number, { name: string, dest: number, sources: number }>>}
 */
export const OPCODE_INFO = Object.freeze(Object.fromEntries(/** @type {[number, string, number, number][]} */ ([
    [0, 'nop', 0, 0], [1, 'mov', 1, 1], [2, 'add', 1, 2], [3, 'sub', 1, 2], [4, 'mad', 1, 3],
    [5, 'mul', 1, 2], [6, 'rcp', 1, 1], [7, 'rsq', 1, 1], [8, 'dp3', 1, 2], [9, 'dp4', 1, 2],
    [10, 'min', 1, 2], [11, 'max', 1, 2], [12, 'slt', 1, 2], [13, 'sge', 1, 2],
    [14, 'exp', 1, 1], [15, 'log', 1, 1], [16, 'lit', 1, 1], [17, 'dst', 1, 2],
    [18, 'lrp', 1, 3], [19, 'frc', 1, 1], [20, 'm4x4', 1, 2], [21, 'm4x3', 1, 2],
    [22, 'm3x4', 1, 2], [23, 'm3x3', 1, 2], [24, 'm3x2', 1, 2], [25, 'call', 0, 1],
    [26, 'callnz', 0, 2], [27, 'loop', 0, 2], [28, 'ret', 0, 0], [29, 'endloop', 0, 0],
    [30, 'label', 0, 1], [31, 'dcl', 1, 0], [32, 'pow', 1, 2], [33, 'crs', 1, 2],
    [34, 'sgn', 1, 3], [35, 'abs', 1, 1], [36, 'nrm', 1, 1], [37, 'sincos', 1, 3],
    [38, 'rep', 0, 1], [39, 'endrep', 0, 0], [40, 'if', 0, 1], [41, 'ifc', 0, 2],
    [42, 'else', 0, 0], [43, 'endif', 0, 0], [44, 'break', 0, 0], [45, 'breakc', 0, 2],
    [46, 'mova', 1, 1], [47, 'defb', 1, 0], [48, 'defi', 1, 0],
    [64, 'texcoord', 1, 0], [65, 'texkill', 1, 0], [66, 'tex', 1, 0], [67, 'texbem', 1, 1],
    [68, 'texbeml', 1, 1], [69, 'texreg2ar', 1, 1], [70, 'texreg2gb', 1, 1],
    [71, 'texm3x2pad', 1, 1], [72, 'texm3x2tex', 1, 1], [73, 'texm3x3pad', 1, 1],
    [74, 'texm3x3tex', 1, 1], [76, 'texm3x3spec', 1, 2], [77, 'texm3x3vspec', 1, 1],
    [78, 'expp', 1, 1], [79, 'logp', 1, 1], [80, 'cnd', 1, 3], [81, 'def', 1, 0],
    [82, 'texreg2rgb', 1, 1], [83, 'texdp3tex', 1, 1], [84, 'texm3x2depth', 1, 1],
    [85, 'texdp3', 1, 1], [86, 'texm3x3', 1, 1], [87, 'texdepth', 1, 0], [88, 'cmp', 1, 3],
    [89, 'bem', 1, 2], [90, 'dp2add', 1, 3], [91, 'dsx', 1, 1], [92, 'dsy', 1, 1],
    [93, 'texldd', 1, 4], [94, 'setp', 1, 2], [95, 'texldl', 1, 2], [96, 'breakp', 0, 1],
]).map(([opcode, name, dest, sources])=>[opcode, Object.freeze({ name, dest, sources })])));

/**
 * @typedef {Object} ShaderVersion
 * @property {string} kind   A SHADER_KIND.
 * @property {number} major
 * @property {number} minor
 */

/**
 * @param {number} token
 * @returns {ShaderVersion | null} null when the token is not a version token
 */
export function versionOf(token){
    const high = (token >>> 16) & 0xffff;
    if (high !== VERSION_VERTEX && high !== VERSION_PIXEL)
    {
        return null;
    }
    return {
        kind: high === VERSION_VERTEX ? SHADER_KIND.VERTEX : SHADER_KIND.PIXEL,
        major: (token >>> 8) & 0xff,
        minor: token & 0xff,
    };
}

/**
 * The version token for a shader of this kind and version, which is how a test
 * spells a shader without a compiler.
 *
 * @param {string} kind @param {number} major @param {number} minor
 */
export function versionToken(kind, major, minor){
    return (((kind === SHADER_KIND.VERTEX ? VERSION_VERTEX : VERSION_PIXEL) << 16)
        | (major << 8) | minor) >>> 0;
}

/**
 * @typedef {Object} Operand
 * @property {number} type         A REGISTER.
 * @property {number} index
 * @property {Operand | null} relative   The address register, when addressed relatively.
 * @property {number} writeMask    Four bits, x low, for a destination.
 * @property {number} swizzle      Eight bits, two per component, for a source.
 * @property {number} modifier     D3DSPSM, for a source.
 * @property {number} resultModifier   D3DSPDM bits, for a destination.
 * @property {number} shift        The destination's shift scale, signed nibble.
 */

/**
 * @typedef {Object} Instruction
 * @property {number} opcode
 * @property {string} name
 * @property {number} control      The opcode-specific control bits, e.g. a comparison.
 * @property {boolean} predicated
 * @property {boolean} coissue
 * @property {Operand | null} dest
 * @property {Operand[]} sources
 * @property {number[]} [literals]  The raw dwords of a def/defi/defb.
 * @property {{ usage: number, usageIndex: number } | { samplerType: number }} [declaration]
 */

/**
 * @typedef {Object} ParsedShader
 * @property {ShaderVersion} version
 * @property {Instruction[]} instructions
 * @property {string | null} error   Why parsing stopped, or null.
 */

const RELATIVE_BIT = 1 << 13;

/**
 * @param {number} token
 * @param {Operand | null} relative
 * @returns {Operand}
 */
function operandOf(token, relative){
    return {
        type: ((token >>> 28) & 7) | ((token >>> 8) & 0x18),
        index: token & 0x7ff,
        relative,
        writeMask: (token >>> 16) & 0xf,
        swizzle: (token >>> 16) & 0xff,
        modifier: (token >>> 24) & 0xf,
        resultModifier: (token >>> 20) & 0xf,
        shift: (token >>> 24) & 0xf,
    };
}

/** The x swizzle on all four components, which is what a 1.x relative address reads. */
const SWIZZLE_XXXX = 0x00;

/**
 * Reads one shader from its tokens.
 *
 * Never throws: a stream that cannot be read reports where it stopped and what
 * it had read up to there, because a program that hands over a malformed
 * shader is refused with a return code, and the refusal has to come from here.
 *
 * @param {Uint32Array | ArrayLike<number>} tokens
 * @returns {ParsedShader}
 */
export function parseShader(tokens){
    /** @type {Instruction[]} */
    const instructions = [];
    const version = tokens.length > 0 ? versionOf(tokens[0]) : null;
    if (!version)
    {
        return {
            version: { kind: SHADER_KIND.VERTEX, major: 0, minor: 0 },
            instructions,
            error: 'the first token is not a version token',
        };
    }
    const modelTwo = version.major >= 2;
    let at = 1;
    let ended = false;
    /** @param {string} why @param {number} where */
    const stop = (why, where)=>({ version, instructions, error: `${why} at token ${where}` });

    /** @returns {Operand | null} */
    const readOperand = ()=>{
        if (at >= tokens.length)
        {
            return null;
        }
        const token = tokens[at++] >>> 0;
        if ((token & 0x80000000) === 0)
        {
            return null;
        }
        /** @type {Operand | null} */
        let relative = null;
        if ((token & RELATIVE_BIT) !== 0)
        {
            if (modelTwo)
            {
                if (at >= tokens.length)
                {
                    return null;
                }
                relative = operandOf(tokens[at++] >>> 0, null);
            }
            else
            {
                relative = {
                    type: REGISTER.ADDR, index: 0, relative: null, writeMask: 0,
                    swizzle: SWIZZLE_XXXX, modifier: 0, resultModifier: 0, shift: 0,
                };
            }
        }
        return operandOf(token, relative);
    };

    while (at < tokens.length && !ended)
    {
        const token = tokens[at] >>> 0;
        if (token === END_TOKEN)
        {
            ended = true;
            at++;
            break;
        }
        const opcode = token & 0xffff;
        if (opcode === COMMENT_OPCODE)
        {
            at += 1 + ((token >>> 16) & 0x7fff);
            continue;
        }
        if (opcode === OPCODE.PHASE)
        {
            at++;
            instructions.push({
                opcode, name: 'phase', control: 0, predicated: false, coissue: false,
                dest: null, sources: [],
            });
            continue;
        }
        const info = OPCODE_INFO[opcode];
        if (!info)
        {
            return stop(`unknown opcode ${opcode}`, at);
        }
        const start = at;
        at++;
        const length = modelTwo ? (token >>> 24) & 0xf : 0;
        /** @type {Instruction} */
        const instruction = {
            opcode,
            name: info.name,
            control: (token >>> 16) & 0xff,
            predicated: (token & (1 << 28)) !== 0,
            coissue: (token & (1 << 30)) !== 0,
            dest: null,
            sources: [],
        };

        if (opcode === OPCODE.DCL)
        {
            // The token after the opcode describes what is declared; the
            // destination that follows says where it arrives.
            if (at + 1 >= tokens.length)
            {
                return stop('truncated dcl', start);
            }
            const what = tokens[at++] >>> 0;
            const dest = readOperand();
            if (!dest)
            {
                return stop('dcl without a register', start);
            }
            instruction.dest = dest;
            instruction.declaration = dest.type === REGISTER.SAMPLER
                ? { samplerType: (what >>> 27) & 0xf }
                : { usage: what & 0x1f, usageIndex: (what >>> 16) & 0xf };
            instructions.push(instruction);
            continue;
        }
        if (opcode === OPCODE.DEF || opcode === OPCODE.DEFI || opcode === OPCODE.DEFB)
        {
            const dest = readOperand();
            const count = opcode === OPCODE.DEFB ? 1 : 4;
            if (!dest || at + count > tokens.length)
            {
                return stop('truncated definition', start);
            }
            instruction.dest = dest;
            instruction.literals = Array.from({ length: count }, (_, i)=>tokens[at + i] >>> 0);
            at += count;
            instructions.push(instruction);
            continue;
        }
        if (instruction.predicated)
        {
            // The predicate register comes first, before the destination,
            // and is a source like any other.
            const predicate = readOperand();
            if (!predicate)
            {
                return stop('predicated without a predicate', start);
            }
            instruction.sources.push(predicate);
        }
        if (info.dest > 0)
        {
            const dest = readOperand();
            if (!dest)
            {
                return stop(`${info.name} without a destination`, start);
            }
            instruction.dest = dest;
        }
        if (modelTwo)
        {
            const end = start + 1 + length;
            if (end > tokens.length)
            {
                return stop(`${info.name} runs past the end`, start);
            }
            // A source is one token, or two when addressed relatively, so
            // the count is not known until each is read.
            let remaining = end - at;
            while (remaining > 0)
            {
                const before = at;
                const source = readOperand();
                if (!source)
                {
                    return stop(`${info.name} has a malformed source`, start);
                }
                instruction.sources.push(source);
                remaining -= at - before;
            }
        }
        else
        {
            // ps_1_4's texld and texcrd read a source where 1.0 to 1.3's tex
            // and texcoord read none.
            const sources = version.kind === SHADER_KIND.PIXEL && version.minor >= 4
                && (opcode === OPCODE.TEX || opcode === OPCODE.TEXCOORD)
                ? 1
                : info.sources;
            for (let index = 0; index < sources; index++)
            {
                const source = readOperand();
                if (!source)
                {
                    return stop(`${info.name} is short of a source`, start);
                }
                instruction.sources.push(source);
            }
        }
        instructions.push(instruction);
    }
    return { version, instructions, error: ended ? null : 'no end token' };
}

/**
 * Whether a token stream is a shader of the given kind that a device of the
 * given version accepts.
 *
 * The three things a create refuses: bytecode that is not of the kind asked
 * for, bytecode that cannot be read to its end, and a version past what the
 * device advertises -- a program that asks for a vs_3_0 on a device reporting
 * vs_2_0 is told no, as it would be on a card of that generation.
 *
 * @param {Uint32Array | ArrayLike<number>} tokens
 * @param {string} kind   A SHADER_KIND.
 * @param {{ major: number, minor: number }} supported
 * @returns {number} D3D_OK or D3DERR_INVALIDCALL
 */
export function validateShader(tokens, kind, supported){
    const parsed = parseShader(tokens);
    if (parsed.error || parsed.version.kind !== kind)
    {
        return D3DERR_INVALIDCALL;
    }
    const { major, minor } = parsed.version;
    if (major > supported.major || (major === supported.major && minor > supported.minor))
    {
        return D3DERR_INVALIDCALL;
    }
    return D3D_OK;
}

/**
 * The tokens of a shader up to and including its end token, which is what a
 * program gets back from GetFunction however long the buffer it passed was.
 *
 * @param {Uint32Array | ArrayLike<number>} tokens
 * @returns {Uint32Array}
 */
export function functionOf(tokens){
    let length = tokens.length;
    for (let at = 1; at < tokens.length; at++)
    {
        const token = tokens[at] >>> 0;
        if ((token & 0xffff) === COMMENT_OPCODE)
        {
            at += (token >>> 16) & 0x7fff;
            continue;
        }
        if (token === END_TOKEN)
        {
            length = at + 1;
            break;
        }
    }
    return Uint32Array.from({ length }, (_, at)=>tokens[at] >>> 0);
}

/**
 * @typedef {Object} Shader
 * @property {number} id      Distinct per shader object, for a pipeline key.
 * @property {string} kind
 * @property {ShaderVersion} version
 * @property {Uint32Array} tokens   The function, end token included.
 * @property {ParsedShader} parsed
 * @property {number} refCount
 * @property {() => number} addRef
 * @property {() => number} release
 * @property {(out: { bytes?: number, tokens?: Uint32Array }, room?: number | null) => number}
 *           GetFunction
 */

/** Shader ids are never reused: a pipeline keyed by one must not find another. */
let lastShaderId = 0;

/**
 * A shader object: the bytecode it was made from, read once.
 *
 * @param {Object} options
 * @param {string} options.kind
 * @param {Uint32Array | ArrayLike<number>} options.tokens
 * @param {import('./resources.js').ReferenceCount} options.count
 * @returns {Shader}
 */
export function createShader(options){
    const tokens = functionOf(options.tokens);
    const parsed = parseShader(tokens);
    return {
        id: ++lastShaderId,
        kind: options.kind,
        version: parsed.version,
        tokens,
        parsed,
        get refCount(){
            return options.count.value;
        },
        addRef: ()=>options.count.addRef(),
        release: ()=>options.count.release(),

        /**
         * The bytecode, and how many bytes it is.
         *
         * `room` is the caller's buffer size in bytes, or null for a caller
         * only asking the size. A buffer too small is refused, and the size is
         * reported either way so the caller can come back with enough.
         *
         * @param {{ bytes?: number, tokens?: Uint32Array }} out
         * @param {number | null} [room]
         */
        GetFunction(out, room = null){
            out.bytes = tokens.length * 4;
            if (room === null)
            {
                return D3D_OK;
            }
            if (room < tokens.length * 4)
            {
                return D3DERR_INVALIDCALL;
            }
            out.tokens = tokens;
            return D3D_OK;
        },
    };
}

/**
 * @typedef {Object} ConstantFile
 *     The three register files a shader stage reads constants from.
 * @property {Float32Array} floats   Four per register.
 * @property {Int32Array} ints       Four per register.
 * @property {Uint32Array} bools     One per register.
 * @property {(start: number, values: ArrayLike<number>, count: number) => number} setF
 * @property {(start: number, count: number, out: { values?: Float32Array }) => number} getF
 * @property {(start: number, values: ArrayLike<number>, count: number) => number} setI
 * @property {(start: number, count: number, out: { values?: Int32Array }) => number} getI
 * @property {(start: number, values: ArrayLike<number>, count: number) => number} setB
 * @property {(start: number, count: number, out: { values?: Uint32Array }) => number} getB
 * @property {() => ConstantFile} copy
 * @property {(other: ConstantFile) => void} assign
 */

/**
 * The bounds of a stage's constant files, which are the numbers a set or get
 * is refused past. The float count is the one the capability block reports as
 * MaxVertexShaderConst; the pixel stage has its own, smaller, and the integer
 * and boolean files are sixteen each in both.
 */
export const CONSTANT_FILE = Object.freeze({
    vertex: Object.freeze({ floats: 256, ints: 16, bools: 16 }),
    pixel: Object.freeze({ floats: 224, ints: 16, bools: 16 }),
});

/**
 * @param {{ floats: number, ints: number, bools: number }} sizes
 * @returns {ConstantFile}
 */
export function createConstantFile(sizes){
    const floats = new Float32Array(sizes.floats * 4);
    const ints = new Int32Array(sizes.ints * 4);
    const bools = new Uint32Array(sizes.bools);

    /**
     * A range is refused when it reaches past the file. A count of zero is
     * accepted and does nothing, which is what a program that computes its
     * count and sometimes gets none relies on.
     *
     * @param {number} start @param {number} count @param {number} limit
     */
    const inRange = (start, count, limit)=>start >= 0 && count >= 0 && start + count <= limit;

    /**
     * @template {Float32Array | Int32Array | Uint32Array} T
     * @param {T} file @param {number} width @param {number} limit
     */
    const accessors = (file, width, limit)=>({
        /**
         * @param {number} start @param {ArrayLike<number>} values @param {number} count
         */
        set(start, values, count){
            if (!values || !inRange(start, count, limit))
            {
                return D3DERR_INVALIDCALL;
            }
            for (let index = 0; index < count * width; index++)
            {
                file[start * width + index] = values[index];
            }
            return D3D_OK;
        },
        /**
         * @param {number} start @param {number} count @param {{ values?: any }} out
         */
        get(start, count, out){
            if (!inRange(start, count, limit))
            {
                return D3DERR_INVALIDCALL;
            }
            out.values = file.slice(start * width, (start + count) * width);
            return D3D_OK;
        },
    });
    const f = accessors(floats, 4, sizes.floats);
    const i = accessors(ints, 4, sizes.ints);
    const b = accessors(bools, 1, sizes.bools);

    /** @type {ConstantFile} */
    const file = {
        floats,
        ints,
        bools,
        setF: f.set,
        getF: f.get,
        setI: i.set,
        getI: i.get,
        setB: b.set,
        getB: b.get,
        copy(){
            const made = createConstantFile(sizes);
            made.assign(file);
            return made;
        },
        /** @param {ConstantFile} other */
        assign(other){
            floats.set(other.floats);
            ints.set(other.ints);
            bools.set(other.bools);
        },
    };
    return file;
}
