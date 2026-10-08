/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A reference machine for Direct3D 9 shader bytecode, for tests. It exists so
 * that a compiler's output can be checked against something that did not
 * share the compiler's idea of what an instruction means: the same shader
 * runs through the compiler's source-level interpreter and through this
 * machine, and the floats are compared.
 *
 * It is written from the documented token layout and the documented
 * instruction pseudo-code, and it is deliberately strict where hardware is
 * forgiving, because a compiler bug that hardware papers over is still a bug:
 * a temporary component read before it was written, a constant or input the
 * caller did not supply, an operand count that disagrees with the length
 * field, a register beyond the version's file, an instruction the version
 * does not have -- each throws, naming the register and the instruction.
 *
 * Versions: vs_1_1, vs_2_0, vs_2_x, vs_3_0, ps_1_1, ps_1_2, ps_1_3, ps_1_4,
 * ps_2_0, ps_2_x, ps_3_0. The ps_1_x models are a different machine from the
 * later ones and are described in their own section below.
 *
 * Not supported, and rejected by decode() with a message saying so:
 * predication (the p0 register, the predicated bit of an opcode token, setp,
 * breakp), relative addressing of a destination, the constant ranges beyond
 * c255 (register types 11 to 13), half-precision temporaries (type 16), and,
 * outside the ps_1_x models, the `phase` marker, co-issue and destination
 * shift scales. Inside them: ps_1_0 (the documentation describes ps_1_1 and
 * later), and a read of a t# register by an arithmetic instruction in ps_1_4.
 *
 * What the machine does not do: it filters no texture (io.sample answers for
 * every sampler read), it models no rasteriser (interpolated inputs and the
 * pixel position are given), and, in the vs and ps_2 and later models, it
 * counts no instruction slots, because the documented slot weights of the
 * multi-slot instructions are not something it can verify.
 *
 * The ps_1_x models (ps_1_1 to ps_1_4)
 * ------------------------------------
 * The assembly spells write masks and swizzles in r, g, b, a there (`r0.rgb`,
 * `v0.a`); the xyzw spelling is accepted on input as well. A pixel shader of
 * these models has no dcl and no output register: the result is r0, reported
 * as outputs.oC0 with the components the program never wrote as NaN and the
 * written mask in written.oC0. A depth written by texdepth or texm3x2depth is
 * outputs.oDepth, component x, written.oDepth 1.
 *
 * Registers. v0 and v1 are the colour inputs, c0 to c7 the constants, r0 to r1
 * (ps_1_1 to ps_1_3) or r0 to r5 (ps_1_4) the temporaries, t0 to t3 (ps_1_1
 * to ps_1_3) or t0 to t5 (ps_1_4) the texture registers. Before the first
 * texture instruction a t# register holds its texture coordinate set
 * (io.inputs.t[n], four floats). In ps_1_1 to ps_1_3 a texture instruction
 * writes the texel (or the colour it computes) into the t# register of its own
 * stage, and an arithmetic instruction reads that t# afterwards like a
 * temporary; reading a t# no texture instruction filled throws. In ps_1_4 the
 * t# registers stay coordinates, are read only by texld, texcrd and texkill,
 * and the texture instructions write r#. The stage a texture instruction
 * samples is the number of the register it writes; io.sample receives it as
 * the sampler index.
 *
 * Where the machine clamps, and why. Only three places clamp, because they
 * are the places the documentation names:
 * - A constant is clamped to [-1, 1] whenever an instruction reads it, def'd
 *   or supplied: the ps_1_x constant registers hold values in that range. The
 *   value stored is left alone, so one clamp serves every reader.
 * - `_sat` clamps a result to [0, 1], after the destination shift scale.
 * - texcoord clamps the coordinates it copies to [0, 1], and texdepth and
 *   texm3x2depth clamp the depth they write to [0, 1] (a depth buffer cannot
 *   hold more).
 * Nothing else is clamped: the arithmetic range of real hardware
 * (D3DCAPS9::PixelShader1xMaxValue) is implementation-defined, so the machine
 * is an implementation with an unbounded one, and the interpolated colour
 * inputs are the caller's to keep inside [0, 1].
 *
 * Source modifiers (applied to each component after the swizzle selects it):
 * -x, x_bias (x - 0.5), -x_bias, x_bx2 (2 * (x - 0.5)), -x_bx2, 1-x, and, in
 * ps_1_4 only, x_x2 (2 * x) and -x_x2. The texld and texcrd sources of ps_1_4
 * also take _dz and _dw, which divide the coordinate by its third or fourth
 * component. There is no abs. No modifier clamps its input.
 *
 * Destination modifiers: _sat everywhere, and the shift scales _x2, _x4 and
 * _d2 (ps_1_1 to ps_1_3) or those and _x8, _d4 and _d8 (ps_1_4): the result is
 * multiplied by the scale and then saturated. An arithmetic instruction takes
 * a write mask of .rgb, .a or .rgba (ps_1_1 to ps_1_3) or any non-empty mask
 * (ps_1_4); a texture instruction takes no modifier.
 *
 * Swizzles. A source takes the identity, or a replicate of one component:
 * .a (and .b, but only where the instruction writes the alpha component alone)
 * in ps_1_1 to ps_1_3, any of .r .g .b .a in ps_1_4. The texld and texcrd
 * sources of ps_1_4 also take .xyz and .xyw, with _dz and _dw respectively.
 *
 * Co-issue. A `+` before an arithmetic instruction pairs it with the one
 * before it (bit 30 of the opcode token): one of the pair writes only red,
 * green and blue, the other only alpha. ps_1_1 to ps_1_3 take the colour
 * instruction first; ps_1_4 takes either order. The pair is one slot. Both
 * instructions of a pair read the registers as they were before the pair.
 *
 * Phases. ps_1_4 has one optional `phase` marker. Registers survive it. Only
 * in the second phase may texld and texcrd read an r# as their coordinates.
 *
 * Order and size. Texture instructions come before arithmetic ones (in each
 * phase). Slot counts are the named constants of PS1_SLOT_LIMITS: a texture
 * instruction is a texture slot, any other instruction (nop included) an
 * arithmetic slot, a co-issued pair one. def costs none.
 *
 * Texture instructions, by stage n (the register written) and source m:
 * - ps_1_1 to ps_1_3: tex tn; texcoord tn (u, v, w clamped, a = 1); texkill
 *   tn; texbem and texbeml tn, tm; texreg2ar, texreg2gb tn, tm and (ps_1_2 up)
 *   texreg2rgb; texm3x2pad + texm3x2tex or (ps_1_3) texm3x2depth; texm3x3pad,
 *   texm3x3pad + texm3x3tex, texm3x3spec (with a constant), texm3x3vspec, and
 *   (ps_1_2 up) texm3x3; (ps_1_2 up) texdp3 and texdp3tex.
 * - ps_1_4: texld rn, src; texcrd rn.rgb, src (no alpha is written); texkill;
 *   texdepth r5; and the arithmetic bem rn.rg, src0, src1.
 * The pad instructions must be consecutive with their closing instruction,
 * writing consecutive t# registers.
 * Each reads its stage's coordinates from io.inputs.t, may look up with
 * io.sample(stage, io.dimensions?.[stage] ?? '2d', coord, { kind: 'plain' }),
 * and takes the bump environment state of the stage (texbem, texbeml, bem)
 * from io.bump[stage].
 *
 * Decisions the documentation leaves open, all in one place so a mismatch
 * with hardware is easy to find:
 * - Floating point is IEEE single with the rounding applied to every
 *   operation's result; a product is rounded before it is added (mad and the
 *   dot products are not fused), and a dot product sums left to right.
 *   0 * Inf is NaN, as in IEEE, not 0.
 * - min is `a < b ? a : b` and max is `a >= b ? a : b`, so a NaN operand
 *   selects the second source in min and the second in max.
 * - rcp(0) and rsq(0) are +Inf whatever the sign of the zero; rsq and log
 *   take the absolute value of their operand; pow(a, b) is |a|^b.
 * - nrm scales every written component by rsq(dot3(src, src)), so w is
 *   src.w scaled, and a zero vector gives NaN (0 * Inf).
 * - crs writes 0 to a w that is asked for.
 * - lit clamps the exponent to +-127.9961.
 * - mova rounds half up (floor(x + 0.5)); vs_1_1's `mov a0.x` is floor(x).
 * - A relative constant address outside the register file throws instead of
 *   reading zero.
 * - vFace is +1 for a front-facing primitive and -1 for a back-facing one, in
 *   every component; vPos has x and y only.
 * - texkill reads x, y and z and kills when any of them is below zero; the
 *   pixel keeps executing and `killed` reports it.
 * - An abs source modifier is accepted in vs_2_0 and later and in ps_3_0.
 * - The two extra operands of sincos in the 2.x models and of sgn are
 *   decoded and validated but not read: they are scratch space for hardware
 *   that has no sincos or sgn unit.
 */

const f32 = Math.fround;
const F32 = new Float32Array(1);
const U32 = new Uint32Array(F32.buffer);

/** Where a runaway shader is stopped, in executed instructions. */
export const RUNAWAY_LIMIT = 1000000;
/** The deepest loop/rep nesting the models allow. */
export const MAX_LOOP_NESTING = 4;
/** The deepest if nesting the models with dynamic flow control allow. */
export const MAX_IF_NESTING = 24;
/** A guard of this machine, not a documented limit: runaway recursion. */
export const MAX_CALL_DEPTH = 64;
/** lit's exponent is clamped to the range an 8.8 fixed-point power can hold. */
const LIT_POWER_LIMIT = 127.9961;

const END_TOKEN = 0x0000ffff;
const COMMENT_CODE = 0xfffe;
const PHASE_CODE = 0xfffd;
const CTAB_FOURCC = 0x42415443;

/** The per-version register files. Every number here is one documented limit. */
export const VERSION_LIMITS = Object.freeze({
    // vs_1_1's constants: 96 is the least a device's caps promise; ours has 256
    // (MaxVertexShaderConst), and fxc places vs_1_1 constants that far (def c215).
    vs_1_1: Object.freeze({
        temps: 12, floatConsts: 256, intConsts: 0, boolConsts: 0,
        inputs: 16, texcoords: 0, outputs: 0, samplers: 0,
    }),
    vs_2_0: Object.freeze({
        temps: 12, floatConsts: 256, intConsts: 16, boolConsts: 16,
        inputs: 16, texcoords: 0, outputs: 0, samplers: 0,
    }),
    vs_2_x: Object.freeze({
        temps: 12, floatConsts: 256, intConsts: 16, boolConsts: 16,
        inputs: 16, texcoords: 0, outputs: 0, samplers: 0,
    }),
    vs_3_0: Object.freeze({
        temps: 32, floatConsts: 256, intConsts: 16, boolConsts: 16,
        inputs: 16, texcoords: 0, outputs: 12, samplers: 4,
    }),
    ps_1_1: Object.freeze({
        temps: 2, floatConsts: 8, intConsts: 0, boolConsts: 0,
        inputs: 2, texcoords: 4, outputs: 0, samplers: 4,
    }),
    ps_1_2: Object.freeze({
        temps: 2, floatConsts: 8, intConsts: 0, boolConsts: 0,
        inputs: 2, texcoords: 4, outputs: 0, samplers: 4,
    }),
    ps_1_3: Object.freeze({
        temps: 2, floatConsts: 8, intConsts: 0, boolConsts: 0,
        inputs: 2, texcoords: 4, outputs: 0, samplers: 4,
    }),
    ps_1_4: Object.freeze({
        temps: 6, floatConsts: 8, intConsts: 0, boolConsts: 0,
        inputs: 2, texcoords: 6, outputs: 0, samplers: 6,
    }),
    ps_2_0: Object.freeze({
        temps: 12, floatConsts: 32, intConsts: 0, boolConsts: 0,
        inputs: 2, texcoords: 8, outputs: 0, samplers: 16,
    }),
    ps_2_x: Object.freeze({
        temps: 32, floatConsts: 32, intConsts: 16, boolConsts: 16,
        inputs: 2, texcoords: 8, outputs: 0, samplers: 16,
    }),
    ps_3_0: Object.freeze({
        temps: 32, floatConsts: 224, intConsts: 16, boolConsts: 16,
        inputs: 10, texcoords: 0, outputs: 0, samplers: 16,
    }),
});

/**
 * The instruction slots of the ps_1_x models: texture addressing slots and
 * arithmetic slots, per phase. Only ps_1_4 has two phases.
 */
export const PS1_SLOT_LIMITS = Object.freeze({
    ps_1_1: Object.freeze({ texture: 4, arithmetic: 8, phases: 1 }),
    ps_1_2: Object.freeze({ texture: 4, arithmetic: 8, phases: 1 }),
    ps_1_3: Object.freeze({ texture: 4, arithmetic: 8, phases: 1 }),
    ps_1_4: Object.freeze({ texture: 6, arithmetic: 8, phases: 2 }),
});

/** The range a ps_1_x constant register holds; a read clamps to it. */
export const PS1_CONSTANT_LIMIT = 1;

/** D3DSPR, the register types. */
const REG = Object.freeze({
    TEMP: 0, INPUT: 1, CONST: 2, ADDR: 3, TEXTURE: 3, RASTOUT: 4, ATTROUT: 5,
    OUTPUT: 6, TEXCRDOUT: 6, CONSTINT: 7, COLOROUT: 8, DEPTHOUT: 9, SAMPLER: 10,
    CONST2: 11, CONST3: 12, CONST4: 13, CONSTBOOL: 14, LOOP: 15, TEMPFLOAT16: 16,
    MISC: 17, LABEL: 18, PREDICATE: 19,
});

/** D3DSPSM, the source modifiers this machine implements. */
const MOD = Object.freeze({
    NONE: 0, NEG: 1, BIAS: 2, BIASNEG: 3, SIGN: 4, SIGNNEG: 5, COMP: 6, X2: 7, X2NEG: 8,
    DZ: 9, DW: 10, ABS: 11, ABSNEG: 12,
});

/** How each ps_1_x source modifier is spelled: before the register, and after it. */
const PS1_MODIFIER_TEXT = new Map(/** @type {[number, string[]][]} */ ([
    [MOD.NEG, ['-', '']], [MOD.BIAS, ['', '_bias']], [MOD.BIASNEG, ['-', '_bias']],
    [MOD.SIGN, ['', '_bx2']], [MOD.SIGNNEG, ['-', '_bx2']], [MOD.COMP, ['1-', '']],
    [MOD.X2, ['', '_x2']], [MOD.X2NEG, ['-', '_x2']], [MOD.DZ, ['', '_dz']],
    [MOD.DW, ['', '_dw']],
]));

/** The destination shift scales, by the 4-bit field of the destination token. */
const SHIFT_NAMES = new Map([[1, 'x2'], [2, 'x4'], [3, 'x8'], [13, 'd8'], [14, 'd4'], [15, 'd2']]);
const SHIFT_SCALES = new Map([[1, 2], [2, 4], [3, 8], [13, 0.125], [14, 0.25], [15, 0.5]]);

const IDENTITY = 0xe4;
const COMPONENTS = 'xyzw';
const COMPARISONS = ['', 'gt', 'eq', 'ge', 'lt', 'ne', 'le'];
const USAGES = [
    'position', 'blendweight', 'blendindices', 'normal', 'psize', 'texcoord', 'tangent',
    'binormal', 'tessfactor', 'positiont', 'color', 'fog', 'depth', 'sample',
];
const SAMPLER_TYPES = new Map([[2, '2d'], [3, 'cube'], [4, 'volume']]);
const RASTOUT_NAMES = ['oPos', 'oFog', 'oPts'];

/**
 * @typedef {Object} OpInfo
 * @property {string} name
 * @property {number} code
 * @property {number} dst
 * @property {number} src      -1 where the count depends on the version or the length
 * @property {number | null} vsMin   Version as major * 10 + minor, null where not a vs op.
 * @property {number | null} psMin
 */

/** @type {[string, number, number, number, number | null, number | null][]} */
const OP_ROWS = [
    ['nop', 0, 0, 0, 11, 20], ['mov', 1, 1, 1, 11, 20], ['add', 2, 1, 2, 11, 20],
    ['sub', 3, 1, 2, 11, 20], ['mad', 4, 1, 3, 11, 20], ['mul', 5, 1, 2, 11, 20],
    ['rcp', 6, 1, 1, 11, 20], ['rsq', 7, 1, 1, 11, 20], ['dp3', 8, 1, 2, 11, 20],
    ['dp4', 9, 1, 2, 11, 20], ['min', 10, 1, 2, 11, 20], ['max', 11, 1, 2, 11, 20],
    ['slt', 12, 1, 2, 11, 20], ['sge', 13, 1, 2, 11, 20], ['exp', 14, 1, 1, 11, 20],
    ['log', 15, 1, 1, 11, 20], ['lit', 16, 1, 1, 11, null], ['dst', 17, 1, 2, 11, null],
    ['lrp', 18, 1, 3, 20, 20], ['frc', 19, 1, 1, 11, 20], ['m4x4', 20, 1, 2, 11, 20],
    ['m4x3', 21, 1, 2, 11, 20], ['m3x4', 22, 1, 2, 11, 20], ['m3x3', 23, 1, 2, 11, 20],
    ['m3x2', 24, 1, 2, 11, 20], ['call', 25, 0, 1, 20, 21], ['callnz', 26, 0, 2, 20, 21],
    ['loop', 27, 0, 2, 20, 21], ['ret', 28, 0, 0, 20, 21], ['endloop', 29, 0, 0, 20, 21],
    ['label', 30, 0, 1, 20, 21], ['dcl', 31, 0, 0, 11, 20], ['pow', 32, 1, 2, 20, 20],
    ['crs', 33, 1, 2, 20, 20], ['sgn', 34, 1, -1, 20, 20], ['abs', 35, 1, 1, 20, 20],
    ['nrm', 36, 1, 1, 20, 20], ['sincos', 37, 1, -1, 20, 20], ['rep', 38, 0, 1, 20, 21],
    ['endrep', 39, 0, 0, 20, 21], ['if', 40, 0, 1, 20, 21], ['ifc', 41, 0, 2, 21, 21],
    ['else', 42, 0, 0, 20, 21], ['endif', 43, 0, 0, 20, 21], ['break', 44, 0, 0, 21, 21],
    ['breakc', 45, 0, 2, 21, 21], ['mova', 46, 1, 1, 20, null], ['defb', 47, 1, 0, 20, 21],
    ['defi', 48, 1, 0, 20, 21], ['texkill', 65, 1, 0, null, 20], ['texld', 66, 1, 2, null, 20],
    ['expp', 78, 1, 1, 11, null], ['logp', 79, 1, 1, 11, null], ['def', 81, 1, 0, 11, 20],
    ['cmp', 88, 1, 3, null, 20], ['dp2add', 90, 1, 3, null, 20], ['dsx', 91, 1, 1, null, 21],
    ['dsy', 92, 1, 1, null, 21], ['texldd', 93, 1, 4, null, 21], ['setp', 94, 1, 2, 21, 21],
    ['texldl', 95, 1, 2, 30, 30], ['breakp', 96, 0, 1, 21, 21],
    // The ps_1_x instructions that no later model has; PS1_ROWS says which version has which.
    ['texcoord', 64, 1, 0, null, null], ['texbem', 67, 1, 1, null, null],
    ['texbeml', 68, 1, 1, null, null], ['texreg2ar', 69, 1, 1, null, null],
    ['texreg2gb', 70, 1, 1, null, null], ['texm3x2pad', 71, 1, 1, null, null],
    ['texm3x2tex', 72, 1, 1, null, null], ['texm3x3pad', 73, 1, 1, null, null],
    ['texm3x3tex', 74, 1, 1, null, null], ['texm3x3spec', 76, 1, 2, null, null],
    ['texm3x3vspec', 77, 1, 1, null, null], ['cnd', 80, 1, 3, null, null],
    ['texreg2rgb', 82, 1, 1, null, null], ['texdp3tex', 83, 1, 1, null, null],
    ['texm3x2depth', 84, 1, 1, null, null], ['texdp3', 85, 1, 1, null, null],
    ['texm3x3', 86, 1, 1, null, null], ['texdepth', 87, 1, 0, null, null],
    ['bem', 89, 1, 2, null, null],
];

/** @type {Map<number, OpInfo>} */
const OP_BY_CODE = new Map();
/** @type {Map<string, OpInfo>} */
const OP_BY_NAME = new Map();
for (const [name, code, dst, src, vsMin, psMin] of OP_ROWS)
{
    const info = Object.freeze({ name, code, dst, src, vsMin, psMin });
    OP_BY_CODE.set(code, info);
    OP_BY_NAME.set(name, info);
}

// ps_1_x spells two opcodes differently from the later models: tex is texld, and in ps_1_4
// texcrd is texcoord.
OP_BY_NAME.set('tex', /** @type {OpInfo} */ (OP_BY_NAME.get('texld')));
OP_BY_NAME.set('texcrd', /** @type {OpInfo} */ (OP_BY_NAME.get('texcoord')));

/**
 * @typedef {Object} Ps1Op
 * @property {string} name
 * @property {number} first   The lowest ps_1_N minor that has it.
 * @property {number} last
 * @property {'arith'|'tex'} kind  Which instruction slots it uses.
 * @property {number} src     Source operands; the destination is always there, except for nop.
 */

/** @type {[string, number, number, 'arith'|'tex', number][]} */
const PS1_ROWS = [
    ['nop', 1, 4, 'arith', 0], ['mov', 1, 4, 'arith', 1], ['add', 1, 4, 'arith', 2],
    ['sub', 1, 4, 'arith', 2], ['mul', 1, 4, 'arith', 2], ['mad', 1, 4, 'arith', 3],
    ['lrp', 1, 4, 'arith', 3], ['dp3', 1, 4, 'arith', 2], ['dp4', 2, 4, 'arith', 2],
    ['cmp', 2, 4, 'arith', 3], ['cnd', 1, 4, 'arith', 3], ['bem', 4, 4, 'arith', 2],
    ['tex', 1, 3, 'tex', 0], ['texcoord', 1, 3, 'tex', 0], ['texkill', 1, 4, 'tex', 0],
    ['texbem', 1, 3, 'tex', 1], ['texbeml', 1, 3, 'tex', 1], ['texreg2ar', 1, 3, 'tex', 1],
    ['texreg2gb', 1, 3, 'tex', 1], ['texreg2rgb', 2, 3, 'tex', 1],
    ['texm3x2pad', 1, 3, 'tex', 1], ['texm3x2tex', 1, 3, 'tex', 1],
    ['texm3x2depth', 3, 3, 'tex', 1], ['texm3x3pad', 1, 3, 'tex', 1],
    ['texm3x3tex', 1, 3, 'tex', 1], ['texm3x3spec', 1, 3, 'tex', 2],
    ['texm3x3vspec', 1, 3, 'tex', 1], ['texm3x3', 2, 3, 'tex', 1],
    ['texdp3', 2, 3, 'tex', 1], ['texdp3tex', 2, 3, 'tex', 1],
    ['texld', 4, 4, 'tex', 1], ['texcrd', 4, 4, 'tex', 1], ['texdepth', 4, 4, 'tex', 0],
    ['def', 1, 4, 'arith', 0],
];

/** @type {Map<string, Ps1Op>} */
const PS1_OPS = new Map();
for (const [name, first, last, kind, src] of PS1_ROWS)
{
    PS1_OPS.set(name, Object.freeze({ name, first, last, kind, src }));
}

/**
 * What an opcode is called in the ps_1_x model of the given minor version.
 * @param {number} code
 * @param {number} minor
 * @param {string} fallback
 */
function ps1Name(code, minor, fallback){
    if (code === 64)
    {
        return minor === 4 ? 'texcrd' : 'texcoord';
    }
    return code === 66 ? (minor === 4 ? 'texld' : 'tex') : fallback;
}

const UNSUPPORTED_OPS = new Set(['setp', 'breakp']);
const SCALAR_SOURCE_OPS = new Set(['rcp', 'rsq', 'exp', 'expp', 'log', 'logp']);

/**
 * @typedef {{ temps: number, floatConsts: number, intConsts: number, boolConsts: number,
 *   inputs: number, texcoords: number, outputs: number, samplers: number }} Limits
 */

/**
 * @typedef {Object} VersionInfo
 * @property {'vertex'|'pixel'} kind
 * @property {boolean} vs
 * @property {boolean} ps1      A ps_1_x model.
 * @property {number} major
 * @property {number} minor
 * @property {number} num       major * 10 + minor, 21 for the 2_x models; not comparable between
 *   the vs and the ps_1_x models, which test `ps1` first.
 * @property {string} name      "vs_2_0", "ps_2_x" ...
 * @property {Limits} limits
 */

/**
 * @param {number} token
 * @returns {VersionInfo}
 */
function parseVersion(token){
    const high = token >>> 16;
    const major = (token >>> 8) & 0xff;
    const minor = token & 0xff;
    if (high !== 0xfffe && high !== 0xffff)
    {
        throw new Error(`decode: token 0 (0x${token.toString(16)}) is not a shader version token`);
    }
    const vs = high === 0xfffe;
    const prefix = vs ? 'vs' : 'ps';
    const tail = major === 2 && minor === 1 ? 'x' : String(minor);
    const name = `${prefix}_${major}_${tail}`;
    const limits = /** @type {Record<string, Limits>} */ (
        /** @type {unknown} */ (VERSION_LIMITS))[name];
    if (!limits)
    {
        throw new Error(`decode: unsupported shader version ${prefix}_${major}_${minor}`);
    }
    return {
        kind: vs ? 'vertex' : 'pixel', vs, ps1: !vs && major === 1, major, minor,
        num: major * 10 + minor, name, limits,
    };
}

/**
 * @typedef {Object} Operand
 * @property {number} type          D3DSPR register type.
 * @property {number} index
 * @property {null | { type: number, index: number, swizzle: number }} relative
 * @property {number} writeMask     Four bits, x lowest; 0xf for a source.
 * @property {number} swizzle       Eight bits, two per component; 0xe4 for a destination.
 * @property {number} modifier      D3DSPSM; 0, 1 (neg), 11 (abs) or 12 (abs and neg).
 * @property {boolean} saturate
 * @property {boolean} partial
 * @property {boolean} centroid
 * @property {number} shift
 */

/**
 * @typedef {Object} Declaration
 * @property {string} register        "v0", "o2", "s1", "t0", "vPos" ...
 * @property {number} type
 * @property {number} index
 * @property {string | null} usage    "position" ... ; null where the model has no usage.
 * @property {number} usageIndex
 * @property {'2d'|'cube'|'volume'|null} samplerType
 * @property {number} mask
 * @property {boolean} centroid
 * @property {boolean} partial
 */

/**
 * @typedef {Object} Instruction
 * @property {number} opcode
 * @property {string} name        Mnemonic without modifiers: "texldp", "if" (a boolean), "ifc" ...
 * @property {number} control     The opcode token's control bits (a comparison, texld's p/b).
 * @property {Operand | null} dest
 * @property {Operand[]} sources
 * @property {Declaration} [declaration]
 * @property {number[]} [literals]  The raw dwords of a def, defi or defb.
 * @property {boolean} decl         True for dcl, def* and the phase marker, which do not
 *   execute.
 * @property {boolean} coissue      A ps_1_x instruction written with a `+`: the second of a pair.
 * @property {number} phase         ps_1_x: 0, or 1 after the `phase` marker of ps_1_4.
 * @property {number} ordinal       Position among the executing instructions, from 0.
 * @property {number} tokenOffset
 * @property {number} [endIdx]      if/else/loop/rep: index of the closing instruction.
 * @property {number} [elseIdx]     if: index of its else, or -1.
 * @property {number} [startIdx]    endloop/endrep: index of the opening instruction.
 * @property {number} [loopIdx]     break: index of the loop it leaves.
 * @property {number} [labelIdx]    call/callnz: index of the label instruction.
 */

/**
 * @typedef {Object} Program
 * @property {'vertex'|'pixel'} kind
 * @property {number} major
 * @property {number} minor
 * @property {string} version
 * @property {VersionInfo} info
 * @property {Instruction[]} instructions    Every instruction in stream order, dcl and def
 *   included.
 * @property {Declaration[]} declarations
 * @property {{ f: Map<number, number[]>, i: Map<number, number[]>, b: Map<number, boolean> }} defs
 * @property {Uint8Array | null} constantTable   The CTAB comment's payload, fourcc first.
 * @property {Map<number, '2d'|'cube'|'volume'>} samplers
 * @property {Map<string, Declaration>} declared   Keyed "type:index".
 * @property {Map<number, number>} labels          Label number to instruction index.
 * @property {{ texture: number[], arithmetic: number[] } | null} slots  ps_1_x: the slots used,
 *   per phase; null in the other models.
 */

/**
 * @param {number} type @param {number} index
 */
function declKey(type, index){
    return `${type}:${index}`;
}

/** @param {number} swizzle */
function isReplicate(swizzle){
    const s = swizzle & 3;
    return swizzle === s * 0x55;
}

/**
 * @param {VersionInfo} v
 * @param {number} type
 * @param {number} index
 * @returns {string}
 */
function registerName(v, type, index){
    switch (type)
    {
        case REG.TEMP: return `r${index}`;
        case REG.INPUT: return `v${index}`;
        case REG.CONST: return `c${index}`;
        case REG.ADDR: return v.vs ? `a${index}` : `t${index}`;
        case REG.RASTOUT: return RASTOUT_NAMES[index] ?? `oRast${index}`;
        case REG.ATTROUT: return `oD${index}`;
        case REG.OUTPUT: return v.vs && v.major < 3 ? `oT${index}` : `o${index}`;
        case REG.CONSTINT: return `i${index}`;
        case REG.COLOROUT: return `oC${index}`;
        case REG.DEPTHOUT: return 'oDepth';
        case REG.SAMPLER: return `s${index}`;
        case REG.CONSTBOOL: return `b${index}`;
        case REG.LOOP: return 'aL';
        case REG.MISC: return index === 0 ? 'vPos' : index === 1 ? 'vFace' : `vMisc${index}`;
        case REG.LABEL: return `l${index}`;
        case REG.PREDICATE: return 'p0';
        default: return `reg${type}_${index}`;
    }
}

/* ------------------------------------------------------------------ decode */

/**
 * @param {Uint32Array | ArrayLike<number>} t
 * @param {number} p
 * @param {number} limit
 * @param {VersionInfo} v
 * @param {boolean} isDest
 * @param {string} what
 * @returns {[Operand, number]}
 */
function readParam(t, p, limit, v, isDest, what){
    if (p >= limit)
    {
        throw new Error(`decode: truncated ${what} at token ${p}`);
    }
    const tok = t[p] >>> 0;
    if (!(tok & 0x80000000))
    {
        throw new Error(`decode: malformed ${what} at token ${p}: 0x${tok.toString(16)} `
            + 'has no parameter marker (bit 31)');
    }
    const type = ((tok >>> 28) & 7) | ((tok >>> 8) & 0x18);
    const index = tok & 0x7ff;
    /** @type {Operand['relative']} */
    let relative = null;
    let next = p + 1;
    if (tok & (1 << 13))
    {
        if (isDest)
        {
            throw new Error(`decode: relative addressing of a destination at token ${p} `
                + 'is not supported by this machine');
        }
        if (v.major >= 2)
        {
            if (next >= limit)
            {
                throw new Error(`decode: truncated relative address token at token ${next}`);
            }
            const rt = t[next] >>> 0;
            if (!(rt & 0x80000000))
            {
                throw new Error(`decode: malformed relative address token at token ${next}`);
            }
            const rtype = ((rt >>> 28) & 7) | ((rt >>> 8) & 0x18);
            relative = { type: rtype, index: rt & 0x7ff, swizzle: (rt >>> 16) & 0xff };
            next++;
        }
        else
        {
            relative = { type: REG.ADDR, index: 0, swizzle: 0 };
        }
    }
    if (type === REG.PREDICATE)
    {
        throw new Error(
            `decode: predicate register at token ${p} is not supported by this machine`);
    }
    if (type === REG.CONST2 || type === REG.CONST3 || type === REG.CONST4)
    {
        throw new Error(`decode: constant register beyond c${v.limits.floatConsts - 1} `
            + `(register type ${type}) at token ${p}`);
    }
    if (type === REG.TEMPFLOAT16)
    {
        throw new Error(`decode: half-precision temporary at token ${p} is not supported`);
    }
    /** @type {Operand} */
    const op = {
        type, index, relative, writeMask: 0xf, swizzle: IDENTITY, modifier: 0,
        saturate: false, partial: false, centroid: false, shift: 0,
    };
    if (isDest)
    {
        op.writeMask = (tok >>> 16) & 0xf;
        op.saturate = !!(tok & (1 << 20));
        op.partial = !!(tok & (2 << 20));
        op.centroid = !!(tok & (4 << 20));
        if (tok & (8 << 20))
        {
            throw new Error(`decode: reserved destination modifier bit at token ${p}`);
        }
        op.shift = (tok >>> 24) & 0xf;
    }
    else
    {
        op.swizzle = (tok >>> 16) & 0xff;
        op.modifier = (tok >>> 24) & 0xf;
    }
    return [op, next];
}

/**
 * @param {VersionInfo} v
 * @param {OpInfo} info
 */
function isAvailable(v, info){
    if (v.ps1)
    {
        const spec = PS1_OPS.get(ps1Name(info.code, v.minor, info.name));
        return !!spec && v.minor >= spec.first && v.minor <= spec.last;
    }
    const min = v.vs ? info.vsMin : info.psMin;
    return min !== null && v.num >= min;
}

/**
 * The kind of each source slot: what a register in it may be.
 * @param {string} name
 * @returns {string[]}
 */
function slotKinds(name){
    switch (name)
    {
        case 'loop': return ['loop', 'int'];
        case 'rep': return ['int'];
        case 'if': return ['bool'];
        case 'callnz': return ['label', 'bool'];
        case 'call': case 'label': return ['label'];
        case 'texld': case 'texldp': case 'texldb': case 'texldl':
            return ['value', 'sampler'];
        case 'texldd': return ['value', 'sampler', 'value', 'value'];
        default: return ['value', 'value', 'value', 'value'];
    }
}

/**
 * @param {VersionInfo} v
 * @param {Operand} op
 * @param {string} kind
 * @param {string} where
 */
function checkSource(v, op, kind, where){
    const lim = v.limits;
    const name = registerName(v, op.type, op.index);
    const bad = (/** @type {string} */ why)=>new Error(`decode: ${why} (${where})`);
    const absOk = (v.vs && v.num >= 20) || (!v.vs && v.num === 30);
    if (op.modifier !== MOD.NONE)
    {
        if (kind !== 'value')
        {
            throw bad(`source modifier on ${name}`);
        }
        const abs = op.modifier === MOD.ABS || op.modifier === MOD.ABSNEG;
        if (op.modifier !== MOD.NEG && !(abs && absOk))
        {
            throw bad(`source modifier ${op.modifier} is not available in ${v.name}`);
        }
    }
    const range = (/** @type {number} */ count)=>{
        if (op.index >= count)
        {
            throw bad(`register ${name} is beyond the ${count} registers of its file in ${v.name}`);
        }
    };
    switch (kind)
    {
        case 'int':
            if (op.type !== REG.CONSTINT)
            {
                throw bad(`${name} is not an integer constant register`);
            }
            range(lim.intConsts);
            return;
        case 'bool':
            if (op.type !== REG.CONSTBOOL)
            {
                throw bad(`${name} is not a boolean constant register`);
            }
            range(lim.boolConsts);
            return;
        case 'label':
            if (op.type !== REG.LABEL)
            {
                throw bad(`${name} is not a label`);
            }
            return;
        case 'loop':
            if (op.type !== REG.LOOP)
            {
                throw bad(`${name} is not the loop counter aL`);
            }
            return;
        case 'sampler':
            if (op.type !== REG.SAMPLER)
            {
                throw bad(`${name} is not a sampler register`);
            }
            range(lim.samplers);
            if (op.swizzle !== IDENTITY)
            {
                throw bad(`swizzle on sampler ${name} is not supported by this machine`);
            }
            return;
        default:
            break;
    }
    switch (op.type)
    {
        case REG.TEMP: range(lim.temps); break;
        case REG.INPUT: range(lim.inputs); break;
        case REG.CONST: range(lim.floatConsts); break;
        case REG.TEXTURE:
            if (v.vs || v.major !== 2)
            {
                throw bad(`register ${name} cannot be read in ${v.name}`);
            }
            range(lim.texcoords);
            break;
        case REG.MISC:
            if (v.vs || v.major !== 3 || op.index > 1)
            {
                throw bad(`register ${name} cannot be read in ${v.name}`);
            }
            break;
        case REG.LOOP:
            if (!((v.vs && v.num >= 20) || (!v.vs && v.num >= 21)))
            {
                throw bad(`aL does not exist in ${v.name}`);
            }
            break;
        default:
            throw bad(`register ${name} cannot be a source in ${v.name}`);
    }
    if (op.relative)
    {
        const rel = op.relative;
        if (op.type !== REG.CONST && op.type !== REG.INPUT)
        {
            throw bad(`${name} cannot be addressed relatively`);
        }
        if (rel.type === REG.ADDR)
        {
            // vs_1_1's address register is a0.x alone; from vs_2_0 it has four components.
            if (!v.vs || op.type !== REG.CONST || rel.index !== 0
                || (v.num < 20 && (rel.swizzle & 3) !== 0))
            {
                throw bad(`only a0 can address constants, only a0.x in vs_1_1, and only in a`
                    + ` vertex shader (${name})`);
            }
        }
        else if (rel.type === REG.LOOP)
        {
            const ok = v.num >= 30 || (v.vs && v.num >= 20 && op.type === REG.CONST);
            if (!ok)
            {
                throw bad(`aL cannot address ${name} in ${v.name}`);
            }
        }
        else
        {
            throw bad('relative address register must be a0.x or aL');
        }
        if (op.type === REG.INPUT && (rel.type !== REG.LOOP || v.major < 3))
        {
            throw bad('inputs are addressed relatively only through aL in the 3.0 models');
        }
    }
}

/**
 * @param {VersionInfo} v
 * @param {Instruction} ins
 * @param {string} where
 */
function checkDest(v, ins, where){
    const op = /** @type {Operand} */ (ins.dest);
    const lim = v.limits;
    const name = registerName(v, op.type, op.index);
    const bad = (/** @type {string} */ why)=>new Error(`decode: ${why} (${where})`);
    if (op.writeMask === 0)
    {
        throw bad(`empty write mask on ${name}`);
    }
    if (op.shift !== 0)
    {
        throw bad(`destination shift scale on ${name} is not supported`);
    }
    if (op.saturate && v.vs)
    {
        throw bad(`_sat is not valid in a vertex shader (${name})`);
    }
    if ((op.saturate || op.partial || op.centroid) && v.num < 20)
    {
        throw bad(`destination modifiers do not exist in ${v.name}`);
    }
    const range = (/** @type {number} */ count)=>{
        if (op.index >= count)
        {
            throw bad(`register ${name} is beyond the ${count} registers of its file in ${v.name}`);
        }
    };
    switch (op.type)
    {
        case REG.TEMP: range(lim.temps); return;
        case REG.ADDR:
            if (!v.vs)
            {
                throw bad(`${name} cannot be written in ${v.name}`);
            }
            if (op.index !== 0 || (v.num < 20 && op.writeMask !== 1))
            {
                throw bad('the address register is written as a0.x only in vs_1_1');
            }
            if (ins.name === 'mov' && v.num >= 20)
            {
                throw bad(`mov to a0 is not valid in ${v.name}; use mova`);
            }
            if (ins.name !== 'mov' && ins.name !== 'mova')
            {
                throw bad(`${ins.name} cannot write the address register`);
            }
            return;
        case REG.RASTOUT:
            if (!v.vs || v.major >= 3)
            {
                throw bad(`${name} does not exist in ${v.name}`);
            }
            range(3);
            return;
        case REG.ATTROUT:
            if (!v.vs || v.major >= 3)
            {
                throw bad(`${name} does not exist in ${v.name}`);
            }
            range(2);
            return;
        case REG.OUTPUT:
            if (!v.vs)
            {
                throw bad(`${name} does not exist in ${v.name}`);
            }
            range(v.major >= 3 ? lim.outputs : 8);
            return;
        case REG.COLOROUT:
            if (v.vs)
            {
                throw bad(`${name} does not exist in ${v.name}`);
            }
            range(4);
            return;
        case REG.DEPTHOUT:
            if (v.vs)
            {
                throw bad(`oDepth does not exist in ${v.name}`);
            }
            range(1);
            return;
        default:
            throw bad(`register ${name} cannot be written in ${v.name}`);
    }
}

/**
 * Checks everything about one instruction that does not depend on another.
 * @param {VersionInfo} v
 * @param {Instruction} ins
 */
function checkInstruction(v, ins){
    const where = `token ${ins.tokenOffset}, ${ins.name}`;
    const bad = (/** @type {string} */ why)=>new Error(`decode: ${why} (${where})`);
    const src = ins.sources;
    const kinds = slotKinds(ins.name);
    if (ins.name === 'texkill')
    {
        const op = /** @type {Operand} */ (ins.dest);
        const okType = op.type === REG.TEMP || (op.type === REG.TEXTURE && v.major === 2)
            || op.type === REG.INPUT;
        if (!okType)
        {
            throw bad(`texkill cannot test ${registerName(v, op.type, op.index)}`);
        }
        if (op.writeMask === 0 || op.saturate || op.shift)
        {
            throw bad('texkill takes a plain register');
        }
        const file = op.type === REG.TEMP ? v.limits.temps
            : op.type === REG.INPUT ? v.limits.inputs : v.limits.texcoords;
        if (op.index >= file)
        {
            throw bad(`register ${registerName(v, op.type, op.index)} is out of range`);
        }
    }
    else if (ins.dest)
    {
        checkDest(v, ins, where);
    }
    src.forEach((op, k)=>{
        let kind = kinds[k] ?? 'value';
        if ((ins.name === 'sgn' || ins.name === 'sincos') && k > 0)
        {
            // Scratch operands: only their register file is checked.
            if (op.type !== REG.TEMP && (ins.name === 'sgn' || op.type !== REG.CONST))
            {
                throw bad(`${ins.name} scratch operand ${k} must be a temporary`
                    + `${ins.name === 'sgn' ? '' : ' or constant'}`);
            }
            kind = 'value';
        }
        checkSource(v, op, kind, where);
    });
    if (SCALAR_SOURCE_OPS.has(ins.name) || ins.name === 'pow' || ins.name === 'sincos')
    {
        const n = ins.name === 'pow' ? 2 : 1;
        for (let k = 0; k < n; k++)
        {
            if (!isReplicate(src[k].swizzle))
            {
                throw bad(`${ins.name} needs a replicate swizzle on source ${k}`);
            }
        }
    }
    const mask = ins.dest ? ins.dest.writeMask : 0;
    switch (ins.name)
    {
        case 'sincos':
            if (mask & 0xc)
            {
                throw bad('sincos writes x (cosine) and y (sine) only');
            }
            if ((v.major === 2 && src.length !== 3) || (v.major === 3 && src.length !== 1))
            {
                throw bad(`sincos takes ${v.major === 2 ? 3 : 1} sources in ${v.name}`);
            }
            break;
        case 'sgn':
            if (src.length !== 1 && src.length !== 3)
            {
                throw bad('sgn takes one source, or three with its two scratch registers');
            }
            break;
        case 'm4x3': case 'm3x3':
            if (mask & 8)
            {
                throw bad(`${ins.name} writes x, y and z only`);
            }
            break;
        case 'm3x2':
            if (mask & 0xc)
            {
                throw bad('m3x2 writes x and y only');
            }
            break;
        case 'ifc': case 'breakc':
            if (ins.control < 1 || ins.control > 6)
            {
                throw bad(`${ins.name} needs a comparison (gt, eq, ge, lt, ne, le)`);
            }
            for (const op of src)
            {
                if (!isReplicate(op.swizzle))
                {
                    throw bad(`${ins.name} needs replicate swizzles on both sources`);
                }
            }
            break;
        case 'texld': case 'texldp': case 'texldb':
            if (ins.control > 2)
            {
                throw bad('texld cannot be both projected and biased');
            }
            break;
        default:
            break;
    }
    if (ins.name !== 'ifc' && ins.name !== 'breakc' && ins.opcode !== 66 && ins.control !== 0)
    {
        throw bad(`unexpected control bits 0x${ins.control.toString(16)}`);
    }
}

/* -------------------------------------------------------------- ps_1_x checks */

/**
 * What decode() carries from one ps_1_x instruction to the next.
 * @typedef {Object} Ps1State
 * @property {number} phase
 * @property {boolean} sawArith     An arithmetic instruction was seen in this phase.
 * @property {number[]} texture     Texture slots used, per phase.
 * @property {number[]} arithmetic  Arithmetic slots used, per phase.
 * @property {Instruction | null} last  The instruction before the one being checked.
 * @property {null | { name: string, token: number, family: 'm3x2'|'m3x3', next: number,
 *   rows: number }} pending   A matrix-multiply pad waiting for its closing instruction.
 */

/** @returns {Ps1State} */
function newPs1State(){
    return {
        phase: 0, sawArith: false, texture: [0, 0], arithmetic: [0, 0], last: null, pending: null,
    };
}

const PS1_MODIFIERS = new Set([
    MOD.NONE, MOD.NEG, MOD.BIAS, MOD.BIASNEG, MOD.SIGN, MOD.SIGNNEG, MOD.COMP,
]);
const PS1_MODIFIERS_14 = new Set([...PS1_MODIFIERS, MOD.X2, MOD.X2NEG]);
const PS1_COORD_MODIFIERS = new Set([MOD.NONE, MOD.DZ, MOD.DW]);
/** The swizzles of a ps_1_4 coordinate source: .xyzw, .xyz, .xyw. */
const SWIZZLE_XYZ = 0xa4;
const SWIZZLE_XYW = 0xf4;
const M3X2_CLOSERS = ['texm3x2tex', 'texm3x2depth'];
const M3X3_CLOSERS = ['texm3x3tex', 'texm3x3spec', 'texm3x3vspec', 'texm3x3'];
const MASK_RGB = 7;
const MASK_ALPHA = 8;

/**
 * Everything the ps_1_x models say about one instruction: its register files,
 * modifiers, swizzles, write masks, pairing, order, slot counts and the pad
 * sequences of the matrix-multiply instructions.
 * @param {VersionInfo} v
 * @param {Instruction} ins
 * @param {Ps1State} state
 */
function checkPs1(v, ins, state){
    const where = `token ${ins.tokenOffset}, ${ins.name}`;
    const bad = (/** @type {string} */ why)=>new Error(`decode: ${why} (${where})`);
    const spec = /** @type {Ps1Op} */ (PS1_OPS.get(ins.name));
    const lim = v.limits;
    const late = v.minor === 4;
    const d = ins.dest;
    const src = ins.sources;
    ins.phase = state.phase;
    if (ins.control !== 0)
    {
        throw bad(`unexpected control bits 0x${ins.control.toString(16)}`);
    }
    const regName = (/** @type {Operand} */ op)=>registerName(v, op.type, op.index);

    if (d)
    {
        if (d.partial || d.centroid)
        {
            throw bad(`_pp and _centroid do not exist in ${v.name}`);
        }
        if (d.writeMask === 0)
        {
            throw bad(`empty write mask on ${regName(d)}`);
        }
        if (d.relative)
        {
            throw bad(`relative addressing does not exist in ${v.name}`);
        }
        if (d.shift !== 0)
        {
            const shift = SHIFT_NAMES.get(d.shift);
            if (!shift)
            {
                throw bad(`reserved destination shift ${d.shift}`);
            }
            if (!late && d.shift > 2 && d.shift !== 15)
            {
                throw bad(`_${shift} does not exist in ${v.name}`);
            }
        }
        if (spec.kind === 'tex' && (d.saturate || d.shift !== 0))
        {
            throw bad(`${ins.name} takes no destination modifier`);
        }
    }

    // The destination.
    const dest = (/** @type {Operand} */ op, /** @type {number} */ type)=>{
        const letter = type === REG.TEMP ? 'r' : 't';
        const count = type === REG.TEMP ? lim.temps : lim.texcoords;
        if (op.type !== type)
        {
            throw bad(`${ins.name} cannot write ${regName(op)} in ${v.name}; it writes a `
                + `${letter}# register`);
        }
        if (op.index >= count)
        {
            throw bad(`register ${regName(op)} is beyond the ${count} registers of its file `
                + `in ${v.name}`);
        }
    };
    if (d)
    {
        if (spec.kind === 'arith')
        {
            // Before 1.4 a texture register is a temporary once its stage has run: fxc
            // writes arithmetic into it (mov_sat t0.w, v0.w) when the two r# are taken.
            dest(d, !late && d.type === REG.TEXTURE ? REG.TEXTURE : REG.TEMP);
            if (ins.name === 'bem')
            {
                if (d.writeMask !== 3)
                {
                    throw bad('bem writes the red and green components only (.rg)');
                }
            }
            else if (!late && d.writeMask !== MASK_RGB && d.writeMask !== MASK_ALPHA
                && d.writeMask !== 0xf)
            {
                throw bad(`write mask ${maskText(d.writeMask, 'rgba')} is not available in `
                    + `${v.name}; use .rgb, .a or .rgba`);
            }
        }
        else if (!late)
        {
            dest(d, REG.TEXTURE);
            if (d.writeMask !== 0xf)
            {
                throw bad(`${ins.name} takes no write mask`);
            }
        }
        else if (ins.name === 'texkill')
        {
            if (d.type !== REG.TEMP && d.type !== REG.TEXTURE)
            {
                throw bad(`texkill cannot test ${regName(d)}`);
            }
            dest(d, d.type);
            if (d.writeMask !== 0xf)
            {
                throw bad('texkill takes no write mask');
            }
        }
        else if (ins.name === 'texdepth')
        {
            dest(d, REG.TEMP);
            if (d.index !== 5 || d.writeMask !== 0xf)
            {
                throw bad('texdepth reads r5 and takes no write mask');
            }
        }
        else
        {
            dest(d, REG.TEMP);
            if (ins.name === 'texcrd' && (d.writeMask & MASK_ALPHA))
            {
                throw bad('texcrd writes the red, green and blue components only');
            }
        }
    }

    // The sources.
    const register = (/** @type {Operand} */ op, /** @type {string} */ letters)=>{
        const letter = op.type === REG.TEMP ? 'r' : op.type === REG.INPUT ? 'v'
            : op.type === REG.CONST ? 'c' : op.type === REG.TEXTURE ? 't' : '';
        if (op.relative)
        {
            throw bad(`relative addressing does not exist in ${v.name}`);
        }
        if (!letter)
        {
            throw bad(`register ${regName(op)} cannot be a source in ${v.name}`);
        }
        if (letter === 't' && late && spec.kind === 'arith')
        {
            throw bad(`reading ${regName(op)} in an arithmetic instruction is not supported by `
                + 'this machine (ps_1_4 reads t# through texld, texcrd and texkill)');
        }
        if (!letters.includes(letter))
        {
            throw bad(`${regName(op)} cannot be a source of ${ins.name} in ${v.name}`);
        }
        const count = { r: lim.temps, v: lim.inputs, c: lim.floatConsts, t: lim.texcoords }[
            /** @type {'r'|'v'|'c'|'t'} */ (letter)];
        if (op.index >= count)
        {
            throw bad(`register ${regName(op)} is beyond the ${count} registers of its file `
                + `in ${v.name}`);
        }
    };
    const modifier = (/** @type {Operand} */ op, /** @type {Set<number>} */ allowed)=>{
        if (!allowed.has(op.modifier))
        {
            throw bad(`source modifier ${op.modifier} is not available in ${v.name}`);
        }
    };
    if (spec.kind === 'arith')
    {
        const mask = d ? d.writeMask : 0xf;
        for (const op of src)
        {
            register(op, 'rvct');
            modifier(op, late ? PS1_MODIFIERS_14 : PS1_MODIFIERS);
            if (op.swizzle === IDENTITY)
            {
                continue;
            }
            const text = swizzleText(op.swizzle, 'rgba');
            if (!isReplicate(op.swizzle))
            {
                throw bad(`swizzle ${text} is not available in ${v.name}; a source takes `
                    + 'one component replicated');
            }
            const c = op.swizzle & 3;
            if (!late && c !== 3 && !(c === 2 && mask === MASK_ALPHA))
            {
                throw bad(`swizzle ${text} is not available in ${v.name}; only .a, and .b on `
                    + 'an instruction that writes alpha alone');
            }
        }
        if (ins.name === 'cnd' && !late
            && (src[0].type !== REG.TEMP || src[0].index !== 0 || src[0].swizzle !== 0xff))
        {
            throw bad(`the first source of cnd must be r0.a in ${v.name}`);
        }
    }
    else if (!late)
    {
        for (let k = 0; k < src.length; k++)
        {
            const op = src[k];
            const closing = ins.name === 'texm3x3spec' && k === 1;
            register(op, closing ? 'c' : 't');
            modifier(op, closing ? new Set([MOD.NONE]) : PS1_MODIFIERS);
            if (op.swizzle !== IDENTITY)
            {
                throw bad(`${ins.name} takes its source without a swizzle`);
            }
        }
    }
    else if (src.length)
    {
        const op = src[0];
        if (op.type === REG.TEMP && state.phase === 0)
        {
            throw bad(`${ins.name} reads a t# register in the first phase; an r# source needs `
                + 'the phase marker before it');
        }
        register(op, 'rt');
        modifier(op, PS1_COORD_MODIFIERS);
        const sw = op.swizzle;
        const ok = op.modifier === MOD.DZ ? sw === IDENTITY || sw === SWIZZLE_XYZ
            : op.modifier === MOD.DW ? sw === IDENTITY || sw === SWIZZLE_XYW
                : sw === IDENTITY || sw === SWIZZLE_XYZ || sw === SWIZZLE_XYW;
        if (!ok)
        {
            throw bad(`swizzle ${swizzleText(sw, 'rgba')} is not available on a `
                + `${ins.name} source${op.modifier ? ' with that modifier' : ''}; `
                + 'it takes .xyzw, .xyz or .xyw (with _dz, .xyz; with _dw, .xyw)');
        }
    }

    // Pairing.
    if (ins.coissue)
    {
        const prev = state.last;
        const first = prev && prev.dest ? prev.dest.writeMask : 0;
        if (spec.kind !== 'arith')
        {
            throw bad('a texture instruction cannot be co-issued');
        }
        if (!prev || prev.decl || prev.coissue || prev.phase !== state.phase
            || PS1_OPS.get(prev.name)?.kind !== 'arith')
        {
            throw bad('a co-issued instruction (+) must directly follow an arithmetic '
                + 'instruction that is not co-issued itself');
        }
        const second = d ? d.writeMask : 0;
        const colour = (/** @type {number} */ m)=>m !== 0 && (m & MASK_ALPHA) === 0;
        // Either first, in every model 1 version: fxc writes a ps_1_1 pair alpha first
        // (mul t0.w, r1.w, t0.w + lrp t0.xyz, ...).
        if (!((colour(first) && second === MASK_ALPHA)
            || (first === MASK_ALPHA && colour(second))))
        {
            throw bad('a co-issued pair writes red, green and blue in one instruction and alpha '
                + 'alone in the other');
        }
    }

    // Matrix-multiply sequences: pads must run straight into their closing instruction.
    const pad = ins.name === 'texm3x2pad' || ins.name === 'texm3x3pad';
    const closer = M3X2_CLOSERS.includes(ins.name) || M3X3_CLOSERS.includes(ins.name);
    const pending = state.pending;
    if (pending)
    {
        const allowed = pending.family === 'm3x2' ? M3X2_CLOSERS
            : pending.rows === 1 ? ['texm3x3pad'] : M3X3_CLOSERS;
        if (!allowed.includes(ins.name))
        {
            throw bad(`${pending.name} at token ${pending.token} must be followed by `
                + allowed.join(' or '));
        }
        const index = /** @type {Operand} */ (d).index;
        if (index !== pending.next)
        {
            throw bad(`${ins.name} must write t${pending.next}, the register after its pad`);
        }
        if (pad)
        {
            pending.rows++;
            pending.next++;
        }
        else
        {
            state.pending = null;
        }
    }
    else if (closer)
    {
        throw bad(`${ins.name} needs its ${ins.name.startsWith('texm3x2') ? 'texm3x2pad'
            : 'two texm3x3pad'} instruction${ins.name.startsWith('texm3x2') ? '' : 's'} directly `
            + 'before it');
    }
    else if (pad)
    {
        state.pending = {
            name: ins.name, token: ins.tokenOffset, family: ins.name === 'texm3x2pad' ? 'm3x2'
                : 'm3x3', next: /** @type {Operand} */ (d).index + 1, rows: 1,
        };
    }

    // Order and size.
    const limits = PS1_SLOT_LIMITS[/** @type {keyof typeof PS1_SLOT_LIMITS} */ (v.name)];
    if (spec.kind === 'tex')
    {
        if (state.sawArith)
        {
            throw bad('a texture instruction cannot follow an arithmetic instruction');
        }
        if (++state.texture[state.phase] > limits.texture)
        {
            throw bad(`${v.name} has ${limits.texture} texture instruction slots per phase`);
        }
    }
    else
    {
        state.sawArith = true;
        if (!ins.coissue && ++state.arithmetic[state.phase] > limits.arithmetic)
        {
            throw bad(`${v.name} has ${limits.arithmetic} arithmetic instruction slots per phase`);
        }
    }
}

/**
 * @param {VersionInfo} v
 * @param {number} usageToken
 * @param {Operand} d
 * @param {number} at
 * @returns {Declaration}
 */
function decodeDeclaration(v, usageToken, d, at){
    const bad = (/** @type {string} */ why)=>new Error(`decode: ${why} (dcl at token ${at})`);
    const name = registerName(v, d.type, d.index);
    const samplerCode = (usageToken >>> 27) & 0xf;
    const mask = d.writeMask;
    if (mask === 0)
    {
        throw bad(`empty write mask on ${name}`);
    }
    /** @type {Declaration} */
    const decl = {
        register: name, type: d.type, index: d.index, usage: null, usageIndex: 0,
        samplerType: null, mask, centroid: d.centroid, partial: d.partial,
    };
    if (d.type === REG.SAMPLER)
    {
        const st = SAMPLER_TYPES.get(samplerCode);
        if (!st)
        {
            throw bad(`sampler ${name} has texture type ${samplerCode}; need 2d, cube or volume`);
        }
        if (d.index >= v.limits.samplers)
        {
            throw bad(`sampler ${name} is beyond the ${v.limits.samplers} of ${v.name}`);
        }
        decl.samplerType = /** @type {Declaration['samplerType']} */ (st);
        return decl;
    }
    if (samplerCode !== 0)
    {
        throw bad(`texture type on non-sampler ${name}`);
    }
    const usage = usageToken & 0x1f;
    const usageIndex = (usageToken >>> 16) & 0xf;
    const lim = v.limits;
    if (v.vs)
    {
        const isOut = d.type === REG.OUTPUT && v.major === 3;
        if (d.type !== REG.INPUT && !isOut)
        {
            throw bad(`${name} cannot be declared in ${v.name}`);
        }
        if (d.index >= (isOut ? lim.outputs : lim.inputs))
        {
            throw bad(`${name} is beyond its register file in ${v.name}`);
        }
    }
    else if (d.type === REG.TEXTURE && v.major === 2)
    {
        if (d.index >= lim.texcoords)
        {
            throw bad(`${name} is beyond its register file in ${v.name}`);
        }
        if (usageToken & 0x1f || usageIndex)
        {
            throw bad(`${name} takes no usage in ${v.name}`);
        }
        return decl;
    }
    else if (d.type === REG.INPUT)
    {
        if (d.index >= lim.inputs)
        {
            throw bad(`${name} is beyond its register file in ${v.name}`);
        }
        if (v.major === 2)
        {
            if (usage || usageIndex)
            {
                throw bad(`${name} takes no usage in ${v.name}`);
            }
            return decl;
        }
    }
    else if (d.type === REG.MISC && v.major === 3 && d.index <= 1)
    {
        if (usage || usageIndex)
        {
            throw bad(`${name} takes no usage`);
        }
        return decl;
    }
    else
    {
        throw bad(`${name} cannot be declared in ${v.name}`);
    }
    if (usage >= USAGES.length)
    {
        throw bad(`unknown usage ${usage}`);
    }
    decl.usage = USAGES[usage];
    decl.usageIndex = usageIndex;
    return decl;
}

/**
 * Reads a shader's tokens into a Program, rejecting anything the version does
 * not allow.
 *
 * @param {ArrayLike<number>} tokens
 * @returns {Program}
 */
export function decode(tokens){
    const t = tokens;
    const n = t.length;
    if (n < 2)
    {
        throw new Error('decode: shader too short; it needs a version token and an END token');
    }
    const v = parseVersion(t[0] >>> 0);
    /** @type {Program} */
    const program = {
        kind: v.kind, major: v.major, minor: v.minor, version: v.name, info: v,
        instructions: [], declarations: [],
        defs: { f: new Map(), i: new Map(), b: new Map() },
        constantTable: null, samplers: new Map(), declared: new Map(), labels: new Map(),
        slots: null,
    };
    const ps1 = v.ps1 ? newPs1State() : null;
    if (ps1)
    {
        program.slots = { texture: ps1.texture, arithmetic: ps1.arithmetic };
    }
    /** @type {{ kind: string, idx: number }[]} */
    const stack = [];
    let ifDepth = 0;
    let loopDepth = 0;
    let ordinal = 0;
    let ended = false;
    let pos = 1;
    while (pos < n)
    {
        const tok = t[pos] >>> 0;
        if (ended)
        {
            throw new Error(`decode: tokens after END at token ${pos}`);
        }
        if (tok === END_TOKEN)
        {
            ended = true;
            pos++;
            continue;
        }
        const code = tok & 0xffff;
        if (code === COMMENT_CODE)
        {
            const size = (tok >>> 16) & 0x7fff;
            if (pos + 1 + size > n)
            {
                throw new Error(`decode: comment at token ${pos} runs past the end of the shader`);
            }
            if (size > 0 && !program.constantTable && (t[pos + 1] >>> 0) === CTAB_FOURCC)
            {
                const bytes = new Uint8Array(size * 4);
                const view = new DataView(bytes.buffer);
                for (let k = 0; k < size; k++)
                {
                    view.setUint32(k * 4, t[pos + 1 + k] >>> 0, true);
                }
                program.constantTable = bytes;
            }
            pos += 1 + size;
            continue;
        }
        if (code === PHASE_CODE)
        {
            if (v.name !== 'ps_1_4')
            {
                throw new Error(`decode: phase marker at token ${pos} is not supported`
                    + `${v.ps1 ? ` in ${v.name}; only ps_1_4 has phases` : ''}`);
            }
            if (!ps1 || ps1.phase !== 0)
            {
                throw new Error(
                    `decode: second phase marker at token ${pos}; ps_1_4 has two phases`);
            }
            if (ps1.pending)
            {
                throw new Error(`decode: ${ps1.pending.name} at token ${ps1.pending.token} is `
                    + 'never closed');
            }
            ps1.phase = 1;
            ps1.sawArith = false;
            /** @type {Instruction} */
            const marker = {
                opcode: PHASE_CODE, name: 'phase', control: 0, dest: null, sources: [], decl: true,
                coissue: false, phase: 1, ordinal: -1, tokenOffset: pos,
            };
            program.instructions.push(marker);
            ps1.last = marker;
            pos++;
            continue;
        }
        if (tok & 0x80000000)
        {
            throw new Error(`decode: token ${pos} (0x${tok.toString(16)}) is a parameter token `
                + 'where an instruction was expected');
        }
        const info = OP_BY_CODE.get(code);
        if (!info)
        {
            throw new Error(`decode: unknown opcode ${code} at token ${pos}`);
        }
        const name = v.ps1 ? ps1Name(code, v.minor, info.name) : info.name;
        if (!isAvailable(v, info))
        {
            throw new Error(`decode: ${name} is not available in ${v.name} (token ${pos})`);
        }
        if (UNSUPPORTED_OPS.has(info.name))
        {
            throw new Error(`decode: ${info.name} (predication) is not supported by this machine`);
        }
        if (v.ps1)
        {
            if (tok & ((1 << 28) | (1 << 29)))
            {
                throw new Error(`decode: reserved bits 0x${(tok & 0x30000000).toString(16)} in `
                    + `the opcode token at token ${pos}`);
            }
        }
        else if (tok & (1 << 30))
        {
            throw new Error(`decode: predicated instruction at token ${pos} `
                + 'is not supported by this machine');
        }
        else if (tok & (1 << 28))
        {
            throw new Error(`decode: co-issued instruction at token ${pos} is not supported`);
        }
        const control = (tok >>> 16) & 0xff;
        let end = n;
        if (v.major >= 2)
        {
            const len = (tok >>> 24) & 0xf;
            end = pos + 1 + len;
            if (end > n)
            {
                throw new Error(`decode: instruction ${info.name} at token ${pos} is truncated: `
                    + `its length field says ${len} operand tokens and the shader ends first`);
            }
        }
        const mismatch = (/** @type {number} */ cursor)=>new Error(
            `decode: ${info.name} at token ${pos} has a length field of ${end - pos - 1} but `
            + `its operands take ${cursor - pos - 1} tokens`);

        /** @type {Instruction} */
        const ins = {
            opcode: code, name, control, dest: null, sources: [], decl: false,
            coissue: v.ps1 && !!(tok & (1 << 30)), phase: ps1 ? ps1.phase : 0,
            ordinal: -1, tokenOffset: pos,
        };
        let cursor = pos + 1;
        if (info.name === 'dcl')
        {
            if (v.major < 2 && !v.vs)
            {
                throw new Error(`decode: dcl does not exist in ${v.name}`);
            }
            if (v.major >= 2 && end - pos - 1 !== 2)
            {
                throw new Error(`decode: dcl at token ${pos} must have 2 operand tokens`);
            }
            const [d] = readParam(t, pos + 2, end, v, true, 'dcl register');
            const decl = decodeDeclaration(v, t[pos + 1] >>> 0, d, pos);
            const key = declKey(d.type, d.index);
            if (program.declared.has(key))
            {
                throw new Error(`decode: ${decl.register} is declared twice (token ${pos})`);
            }
            program.declared.set(key, decl);
            program.declarations.push(decl);
            if (decl.samplerType)
            {
                program.samplers.set(d.index, decl.samplerType);
            }
            ins.dest = d;
            ins.declaration = decl;
            ins.decl = true;
            cursor = v.major >= 2 ? end : pos + 3;
        }
        else if (info.name === 'def' || info.name === 'defi' || info.name === 'defb')
        {
            const count = info.name === 'defb' ? 1 : 4;
            const [d, next] = readParam(t, cursor, end, v, true, `${info.name} register`);
            if (v.major >= 2 && end - next !== count)
            {
                throw new Error(
                    `decode: ${info.name} at token ${pos} needs ${count} literal tokens`);
            }
            const want = info.name === 'def' ? REG.CONST
                : info.name === 'defi' ? REG.CONSTINT : REG.CONSTBOOL;
            const limit = info.name === 'def' ? v.limits.floatConsts
                : info.name === 'defi' ? v.limits.intConsts : v.limits.boolConsts;
            if (d.type !== want || d.index >= limit)
            {
                throw new Error(`decode: ${info.name} of ${registerName(v, d.type, d.index)} `
                    + `is not a register of ${v.name} (token ${pos})`);
            }
            if (next + count > n)
            {
                throw new Error(`decode: ${info.name} at token ${pos} is truncated`);
            }
            const lits = [];
            for (let k = 0; k < count; k++)
            {
                lits.push(t[next + k] >>> 0);
            }
            ins.dest = d;
            ins.literals = lits;
            ins.decl = true;
            if (info.name === 'def')
            {
                program.defs.f.set(d.index, lits.map(b=>{
                    U32[0] = b;
                    return F32[0];
                }));
            }
            else if (info.name === 'defi')
            {
                program.defs.i.set(d.index, lits.map(b=>b | 0));
            }
            else
            {
                program.defs.b.set(d.index, lits[0] !== 0);
            }
            cursor = next + count;
            if (v.major >= 2 && cursor !== end)
            {
                throw mismatch(cursor);
            }
        }
        else
        {
            /** @param {number} srcCount @returns {[Operand | null, Operand[], number]} */
            const parse = srcCount=>{
                let c = pos + 1;
                /** @type {Operand | null} */
                let dest = null;
                if (info.dst)
                {
                    [dest, c] = readParam(t, c, end, v, true, 'destination');
                }
                const sources = [];
                for (let k = 0; k < srcCount; k++)
                {
                    const [op, next] = readParam(t, c, end, v, false, `source ${k}`);
                    sources.push(op);
                    c = next;
                }
                return [dest, sources, c];
            };
            let counts = [v.ps1 ? /** @type {Ps1Op} */ (PS1_OPS.get(name)).src : info.src];
            if (info.src < 0)
            {
                counts = info.name === 'sgn' ? [1, 3] : v.major === 2 ? [3] : [1];
            }
            /** @type {[Operand | null, Operand[], number] | null} */
            let parsed = null;
            /** @type {unknown} */
            let failure = null;
            for (const count of counts)
            {
                try
                {
                    const attempt = parse(count);
                    if (v.major < 2 || attempt[2] === end)
                    {
                        parsed = attempt;
                        break;
                    }
                    failure = mismatch(attempt[2]);
                }
                catch (e){
                    failure = e;
                }
            }
            if (!parsed)
            {
                throw failure;
            }
            [ins.dest, ins.sources, cursor] = parsed;
            if (ps1)
            {
                checkPs1(v, ins, ps1);
            }
            else
            {
                if (info.code === 66)
                {
                    ins.name = ins.control === 1 ? 'texldp'
                        : ins.control === 2 ? 'texldb' : 'texld';
                }
                checkInstruction(v, ins);
            }
            ins.ordinal = ordinal++;
        }
        const idx = program.instructions.length;
        program.instructions.push(ins);
        if (ps1)
        {
            ps1.last = ins;
        }
        pos = cursor;

        switch (ins.name)
        {
            case 'if': case 'ifc':
                stack.push({ kind: 'if', idx });
                ins.elseIdx = -1;
                if (++ifDepth > MAX_IF_NESTING)
                {
                    throw new Error(`decode: if nesting deeper than ${MAX_IF_NESTING} `
                        + `(token ${ins.tokenOffset})`);
                }
                break;
            case 'else': {
                const top = stack[stack.length - 1];
                const opener = top && top.kind === 'if' ? program.instructions[top.idx] : null;
                if (!opener || opener.elseIdx !== -1)
                {
                    throw new Error(`decode: else without if (token ${ins.tokenOffset})`);
                }
                opener.elseIdx = idx;
                ins.startIdx = top.idx;
                break;
            }
            case 'endif': {
                const top = stack.pop();
                if (!top || top.kind !== 'if')
                {
                    throw new Error(`decode: endif without if (token ${ins.tokenOffset})`);
                }
                ifDepth--;
                const opener = program.instructions[top.idx];
                opener.endIdx = idx;
                ins.startIdx = top.idx;
                if (opener.elseIdx !== undefined && opener.elseIdx >= 0)
                {
                    program.instructions[opener.elseIdx].endIdx = idx;
                }
                break;
            }
            case 'loop': case 'rep':
                stack.push({ kind: ins.name, idx });
                if (++loopDepth > MAX_LOOP_NESTING)
                {
                    throw new Error(`decode: loop/rep nesting deeper than ${MAX_LOOP_NESTING} `
                        + `(token ${ins.tokenOffset})`);
                }
                break;
            case 'endloop': case 'endrep': {
                const want = ins.name === 'endloop' ? 'loop' : 'rep';
                const top = stack.pop();
                if (!top || top.kind !== want)
                {
                    throw new Error(
                        `decode: ${ins.name} without ${want} (token ${ins.tokenOffset})`);
                }
                loopDepth--;
                program.instructions[top.idx].endIdx = idx;
                ins.startIdx = top.idx;
                break;
            }
            case 'break': case 'breakc': {
                let k = stack.length - 1;
                while (k >= 0 && stack[k].kind === 'if')
                {
                    k--;
                }
                if (k < 0)
                {
                    throw new Error(
                        `decode: ${ins.name} outside a loop (token ${ins.tokenOffset})`);
                }
                ins.loopIdx = stack[k].idx;
                break;
            }
            case 'label': {
                if (stack.length)
                {
                    throw new Error(`decode: label inside control flow (token ${ins.tokenOffset})`);
                }
                const id = ins.sources[0].index;
                if (program.labels.has(id))
                {
                    throw new Error(`decode: label l${id} is defined twice`);
                }
                program.labels.set(id, idx);
                break;
            }
            default:
                break;
        }
    }
    if (!ended)
    {
        throw new Error('decode: missing END token');
    }
    if (stack.length)
    {
        const open = program.instructions[stack[stack.length - 1].idx];
        throw new Error(`decode: ${open.name} at token ${open.tokenOffset} is never closed`);
    }
    if (ps1 && ps1.pending)
    {
        throw new Error(`decode: ${ps1.pending.name} at token ${ps1.pending.token} is never `
            + 'closed');
    }
    for (const ins of program.instructions)
    {
        if (ins.name === 'call' || ins.name === 'callnz')
        {
            const target = program.labels.get(ins.sources[0].index);
            if (target === undefined)
            {
                throw new Error(`decode: ${ins.name} of undefined label l${ins.sources[0].index}`);
            }
            ins.labelIdx = target;
        }
    }
    checkDeclarations(program);
    return program;
}

/**
 * Every input, sampler and 3.0 output a shader touches must have been
 * declared, and a write must stay inside its declared components.
 * @param {Program} program
 */
function checkDeclarations(program){
    const v = program.info;
    const needsDcl = v.major >= 2;
    if (!needsDcl)
    {
        return;
    }
    for (const ins of program.instructions)
    {
        if (ins.decl)
        {
            continue;
        }
        const where = `instruction ${ins.ordinal}, ${ins.name}`;
        /** @type {Operand[]} */
        const reads = ins.sources.slice();
        if (ins.name === 'texkill' && ins.dest)
        {
            reads.push(ins.dest);
        }
        for (const op of reads)
        {
            const isIn = op.type === REG.INPUT || op.type === REG.MISC
                || (op.type === REG.TEXTURE && !v.vs);
            if (isIn && !op.relative && !program.declared.has(declKey(op.type, op.index)))
            {
                throw new Error(`decode: missing dcl for ${registerName(v, op.type, op.index)} `
                    + `(${where})`);
            }
            if (op.type === REG.SAMPLER && !program.samplers.has(op.index))
            {
                throw new Error(`decode: missing dcl for sampler s${op.index} (${where})`);
            }
        }
        const d = ins.dest;
        if (d && d.type === REG.OUTPUT && v.vs && v.major === 3 && ins.name !== 'texkill')
        {
            const decl = program.declared.get(declKey(d.type, d.index));
            if (!decl)
            {
                throw new Error(`decode: missing dcl for o${d.index} (${where})`);
            }
            if (d.writeMask & ~decl.mask)
            {
                throw new Error(`decode: ${ins.name} writes components of o${d.index} `
                    + `outside its declared mask (${where})`);
            }
        }
    }
}

/* ------------------------------------------------------------- disassemble */

/**
 * @param {number} swizzle
 * @param {string} [letters]  The four component names; "rgba" in the ps_1_x models.
 */
function swizzleText(swizzle, letters = COMPONENTS){
    if (swizzle === IDENTITY)
    {
        return '';
    }
    const parts = [];
    for (let k = 0; k < 4; k++)
    {
        parts.push(letters[(swizzle >> (2 * k)) & 3]);
    }
    while (parts.length > 1 && parts[parts.length - 1] === parts[parts.length - 2])
    {
        parts.pop();
    }
    return `.${parts.join('')}`;
}

/**
 * @param {number} mask
 * @param {string} [letters]
 */
function maskText(mask, letters = COMPONENTS){
    if (mask === 0xf)
    {
        return '';
    }
    let s = '.';
    for (let k = 0; k < 4; k++)
    {
        if (mask & (1 << k))
        {
            s += letters[k];
        }
    }
    return s;
}

/**
 * @param {VersionInfo} v
 * @param {Operand} op
 */
function sourceText(v, op){
    if (v.ps1)
    {
        const [before, after] = PS1_MODIFIER_TEXT.get(op.modifier) ?? ['', ''];
        return `${before}${registerName(v, op.type, op.index)}${after}`
            + swizzleText(op.swizzle, 'rgba');
    }
    let body;
    if (op.relative)
    {
        const prefix = op.type === REG.CONST ? 'c' : 'v';
        const rel = op.relative.type === REG.LOOP ? 'aL'
            : `a0.${COMPONENTS[op.relative.swizzle & 3]}`;
        body = op.index ? `${prefix}[${rel} + ${op.index}]` : `${prefix}[${rel}]`;
    }
    else
    {
        body = registerName(v, op.type, op.index);
    }
    body += swizzleText(op.swizzle);
    switch (op.modifier)
    {
        case MOD.NEG: return `-${body}`;
        case MOD.ABS: return `|${body}|`;
        case MOD.ABSNEG: return `-|${body}|`;
        default: return body;
    }
}

/** @param {number} value */
function floatText(value){
    if (Object.is(value, -0))
    {
        return '-0';
    }
    if (!Number.isFinite(value))
    {
        F32[0] = value;
        return `0x${U32[0].toString(16).padStart(8, '0')}`;
    }
    for (let digits = 1; digits <= 9; digits++)
    {
        const text = value.toPrecision(digits);
        if (f32(Number(text)) === value)
        {
            return String(Number(text));
        }
    }
    return String(value);
}

/**
 * One instruction as a line of shader assembly.
 * @param {Program} program
 * @param {Instruction} ins
 * @returns {string}
 */
function formatInstruction(program, ins){
    return (ins.coissue ? '+ ' : '') + formatBody(program, ins);
}

/**
 * @param {Program} program
 * @param {Instruction} ins
 * @returns {string}
 */
function formatBody(program, ins){
    const v = program.info;
    let name = ins.name;
    const operands = [];
    if (ins.name === 'phase')
    {
        return 'phase';
    }
    if (ins.name === 'dcl')
    {
        const decl = /** @type {Declaration} */ (ins.declaration);
        const d = /** @type {Operand} */ (ins.dest);
        let head = 'dcl';
        if (decl.samplerType)
        {
            head += `_${decl.samplerType}`;
        }
        else if (decl.usage)
        {
            head += `_${decl.usage}${decl.usageIndex || ''}`;
        }
        if (decl.partial)
        {
            head += '_pp';
        }
        if (decl.centroid)
        {
            head += '_centroid';
        }
        return `${head} ${registerName(v, d.type, d.index)}${maskText(decl.mask)}`;
    }
    if (ins.literals)
    {
        const d = /** @type {Operand} */ (ins.dest);
        const reg = registerName(v, d.type, d.index);
        if (ins.name === 'def')
        {
            const vals = ins.literals.map(b=>{
                U32[0] = b;
                return floatText(F32[0]);
            });
            return `def ${reg}, ${vals.join(', ')}`;
        }
        if (ins.name === 'defi')
        {
            return `defi ${reg}, ${ins.literals.map(b=>b | 0).join(', ')}`;
        }
        const b = ins.literals[0];
        return `defb ${reg}, ${b === 1 ? 'true' : b === 0 ? 'false' : b}`;
    }
    if (ins.name === 'ifc')
    {
        name = `if_${COMPARISONS[ins.control]}`;
    }
    else if (ins.name === 'breakc')
    {
        name = `break_${COMPARISONS[ins.control]}`;
    }
    const d = ins.dest;
    if (d)
    {
        if (v.ps1 && d.shift !== 0)
        {
            name += `_${SHIFT_NAMES.get(d.shift) ?? `shift${d.shift}`}`;
        }
        if (d.saturate)
        {
            name += '_sat';
        }
        if (d.partial)
        {
            name += '_pp';
        }
        if (d.centroid)
        {
            name += '_centroid';
        }
        operands.push(registerName(v, d.type, d.index)
            + maskText(d.writeMask, v.ps1 ? 'rgba' : COMPONENTS));
    }
    for (const op of ins.sources)
    {
        operands.push(sourceText(v, op));
    }
    return operands.length ? `${name} ${operands.join(', ')}` : name;
}

/**
 * The shader as assembly text, one instruction per line, comments dropped.
 *
 * @param {ArrayLike<number>} tokens
 * @returns {string}
 */
export function disassemble(tokens){
    const program = decode(tokens);
    const lines = [program.version];
    for (const ins of program.instructions)
    {
        lines.push(formatInstruction(program, ins));
    }
    return `${lines.join('\n')}\n`;
}

/* --------------------------------------------------------------- assemble */

/** @param {number} value */
function floatBits(value){
    F32[0] = value;
    return U32[0];
}

/**
 * @param {string} text
 * @returns {number}
 */
function parseFloatLiteral(text){
    const s = text.trim().toLowerCase();
    if (/^[-+]?0x[0-9a-f]{1,8}$/.test(s))
    {
        return Number.parseInt(s.replace('+', ''), 16) >>> 0;
    }
    if (s === 'inf' || s === '+inf')
    {
        return floatBits(Infinity);
    }
    if (s === '-inf')
    {
        return floatBits(-Infinity);
    }
    if (s === 'nan')
    {
        return 0x7fc00000;
    }
    if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/.test(s))
    {
        throw new Error(`bad number "${text}"`);
    }
    return floatBits(Number(s));
}

/**
 * @param {string} text
 * @returns {number}
 */
function parseIntLiteral(text){
    const s = text.trim();
    if (!/^[-+]?\d+$/.test(s))
    {
        throw new Error(`bad integer "${text}"`);
    }
    return Number(s) | 0;
}

/**
 * @param {VersionInfo} v
 * @param {string} letters
 * @param {string} digits
 * @param {string} full
 * @returns {{ type: number, index: number }}
 */
function parseRegister(v, letters, digits, full){
    const num = digits === '' ? -1 : Number(digits);
    const need = (/** @type {boolean} */ ok)=>{
        if (!ok)
        {
            throw new Error(`bad register "${full}"`);
        }
    };
    switch (letters)
    {
        case 'r': need(num >= 0); return { type: REG.TEMP, index: num };
        case 'v': need(num >= 0); return { type: REG.INPUT, index: num };
        case 'c': need(num >= 0); return { type: REG.CONST, index: num };
        case 'i': need(num >= 0); return { type: REG.CONSTINT, index: num };
        case 'b': need(num >= 0); return { type: REG.CONSTBOOL, index: num };
        case 's': need(num >= 0); return { type: REG.SAMPLER, index: num };
        case 'l': need(num >= 0); return { type: REG.LABEL, index: num };
        case 'a': need(num >= 0 && v.vs); return { type: REG.ADDR, index: num };
        case 't': need(num >= 0 && !v.vs); return { type: REG.TEXTURE, index: num };
        case 'aL': need(num < 0); return { type: REG.LOOP, index: 0 };
        case 'oPos': need(num < 0); return { type: REG.RASTOUT, index: 0 };
        case 'oFog': need(num < 0); return { type: REG.RASTOUT, index: 1 };
        case 'oPts': need(num < 0); return { type: REG.RASTOUT, index: 2 };
        case 'oD': need(num >= 0); return { type: REG.ATTROUT, index: num };
        case 'oT': need(num >= 0); return { type: REG.TEXCRDOUT, index: num };
        case 'o': need(num >= 0); return { type: REG.OUTPUT, index: num };
        case 'oC': need(num >= 0); return { type: REG.COLOROUT, index: num };
        case 'oDepth': need(num < 0); return { type: REG.DEPTHOUT, index: 0 };
        case 'vPos': need(num < 0); return { type: REG.MISC, index: 0 };
        case 'vFace': need(num < 0); return { type: REG.MISC, index: 1 };
        case 'p': throw new Error('predicate registers are not supported by this machine');
        default: throw new Error(`bad register "${full}"`);
    }
}

/**
 * @param {number} type
 * @returns {number} the type bits as they sit in a parameter token
 */
function typeBits(type){
    return (((type & 7) << 28) | ((type & 0x18) << 8)) >>> 0;
}

/**
 * @param {string} text
 * @returns {number}
 */
function parseSwizzle(text){
    if (!/^[xyzw]{1,4}$/.test(text))
    {
        throw new Error(`bad swizzle ".${text}"`);
    }
    const comps = [...text].map(ch=>COMPONENTS.indexOf(ch));
    while (comps.length < 4)
    {
        comps.push(comps[comps.length - 1]);
    }
    return comps.reduce((acc, c, k)=>acc | (c << (2 * k)), 0);
}

/**
 * @param {string} text
 * @returns {number}
 */
function parseMask(text){
    if (!/^[xyzw]{1,4}$/.test(text))
    {
        throw new Error(`bad write mask ".${text}"`);
    }
    let mask = 0;
    let last = -1;
    for (const ch of text)
    {
        const c = COMPONENTS.indexOf(ch);
        if (c <= last)
        {
            throw new Error(`write mask ".${text}" must list x, y, z, w in order`);
        }
        mask |= 1 << c;
        last = c;
    }
    return mask;
}

const OPERAND_PATTERN = /^([A-Za-z]+)(\d*)(?:\[\s*(a0\.[xyzw]|aL)\s*(?:\+\s*(\d+))?\s*\])?(?:\.([xyzwrgba]+))?$/;

/**
 * A swizzle or write mask in the xyzw spelling. The ps_1_x models spell it
 * rgba, and a shader of another model that does is told so.
 * @param {VersionInfo} v
 * @param {string} text
 * @param {string} what
 * @returns {string}
 */
function xyzwLetters(v, text, what){
    if (/^[xyzw]+$/.test(text))
    {
        return text;
    }
    if (!v.ps1 || !/^[rgba]+$/.test(text))
    {
        throw new Error(`bad ${what} ".${text}"`);
    }
    return text.replace(/./g, ch=>COMPONENTS['rgba'.indexOf(ch)]);
}

/** The destination shifts by the name the assembler gives them. */
const SHIFT_BY_NAME = new Map([...SHIFT_NAMES].map(([raw, name])=>[name, raw]));

/**
 * @param {VersionInfo} v
 * @param {string} text
 * @param {{ mods: Set<string>, defaultMask?: number }} mods
 * @returns {number[]} the destination token
 */
function assembleDest(v, text, mods){
    const m = OPERAND_PATTERN.exec(text.trim());
    if (!m || m[3] !== undefined)
    {
        throw new Error(`bad destination "${text}"`);
    }
    const reg = parseRegister(v, m[1], m[2], text);
    const mask = m[5] === undefined ? mods.defaultMask ?? 0xf
        : parseMask(xyzwLetters(v, m[5], 'write mask'));
    let tok = (0x80000000 | typeBits(reg.type) | reg.index | (mask << 16)) >>> 0;
    const shifts = [...mods.mods].filter(mod=>SHIFT_BY_NAME.has(mod));
    if (shifts.length > 1)
    {
        throw new Error(`only one destination shift is allowed, not ${shifts.join(' and ')}`);
    }
    if (shifts.length)
    {
        tok |= /** @type {number} */ (SHIFT_BY_NAME.get(shifts[0])) << 24;
    }
    if (mods.mods.has('sat'))
    {
        tok |= 1 << 20;
    }
    if (mods.mods.has('pp'))
    {
        tok |= 2 << 20;
    }
    if (mods.mods.has('centroid'))
    {
        tok |= 4 << 20;
    }
    return [tok >>> 0];
}

/**
 * @param {VersionInfo} v
 * @param {string} text
 * @returns {number[]} the source token and, from model 2, its relative token
 */
function assembleSource(v, text){
    let s = text.trim();
    /** @type {number} */
    let modifier = MOD.NONE;
    const complement = /^1\s*-\s*/.exec(s);
    if (complement)
    {
        modifier = MOD.COMP;
        s = s.slice(complement[0].length);
    }
    else if (s.startsWith('-'))
    {
        modifier = MOD.NEG;
        s = s.slice(1).trim();
    }
    if (s.startsWith('|'))
    {
        if (!s.endsWith('|') || s.length < 3 || complement)
        {
            throw new Error(`bad source "${text}"`);
        }
        modifier = modifier === MOD.NEG ? MOD.ABSNEG : MOD.ABS;
        s = s.slice(1, -1).trim();
    }
    // The ps_1_x modifiers sit between the register and its swizzle: t0_bx2.rgb.
    const suffix = /^(.*?)_(bias|bx2|x2|dz|dw)((?:\.[a-z]+)?)$/i.exec(s);
    if (suffix)
    {
        s = suffix[1] + suffix[3];
        const name = suffix[2].toLowerCase();
        const negated = modifier === MOD.NEG;
        const table = /** @type {Record<string, number[]>} */ ({
            bias: [MOD.BIAS, MOD.BIASNEG], bx2: [MOD.SIGN, MOD.SIGNNEG],
            x2: [MOD.X2, MOD.X2NEG], dz: [MOD.DZ, -1], dw: [MOD.DW, -1],
        });
        const picked = table[name][negated ? 1 : 0];
        if ((modifier !== MOD.NONE && modifier !== MOD.NEG) || picked < 0)
        {
            throw new Error(`bad source "${text}"; _${name} cannot be combined with that`);
        }
        modifier = picked;
    }
    const m = OPERAND_PATTERN.exec(s);
    if (!m)
    {
        throw new Error(`bad source "${text}"`);
    }
    const swizzle = m[5] === undefined ? IDENTITY
        : parseSwizzle(xyzwLetters(v, m[5], 'swizzle'));
    let reg;
    /** @type {number[]} */
    const extra = [];
    let relBit = 0;
    if (m[3] !== undefined)
    {
        if ((m[1] !== 'c' && m[1] !== 'v') || m[2] !== '')
        {
            throw new Error(`only c and v can be addressed relatively: "${text}"`);
        }
        reg = { type: m[1] === 'c' ? REG.CONST : REG.INPUT, index: m[4] ? Number(m[4]) : 0 };
        relBit = 1 << 13;
        if (v.major >= 2)
        {
            const rtype = m[3] === 'aL' ? REG.LOOP : REG.ADDR;
            // The relative token's swizzle replicates the component of a0 it reads.
            const comp = rtype === REG.ADDR ? COMPONENTS.indexOf(m[3][3]) : 0;
            extra.push((0x80000000 | typeBits(rtype) | comp * 0x55 << 16) >>> 0);
        }
        else if (m[3] !== 'a0.x')
        {
            throw new Error(`${v.name} addresses relatively through a0.x only`);
        }
    }
    else
    {
        reg = parseRegister(v, m[1], m[2], text);
    }
    if (reg.index > 0x7ff)
    {
        throw new Error(`register index too large in "${text}"`);
    }
    const tok = (0x80000000 | typeBits(reg.type) | reg.index | relBit | (swizzle << 16)
        | (modifier << 24)) >>> 0;
    return [tok, ...extra];
}

/**
 * @param {string} line
 * @returns {string[]}
 */
function splitOperands(line){
    const out = [];
    let depth = 0;
    let cur = '';
    for (const ch of line)
    {
        if (ch === '[')
        {
            depth++;
        }
        else if (ch === ']')
        {
            depth--;
        }
        if (ch === ',' && depth === 0)
        {
            out.push(cur);
            cur = '';
        }
        else
        {
            cur += ch;
        }
    }
    if (cur.trim() !== '' || out.length)
    {
        out.push(cur);
    }
    return out.map(s=>s.trim());
}

/**
 * @param {string} word    mnemonic without a comparison, e.g. "dcl_texcoord1_pp"
 * @param {VersionInfo} v
 * @param {string[]} operands
 * @returns {number[]}
 */
function assembleDcl(word, v, operands){
    const parts = word.split('_').slice(1);
    const kind = parts.shift() ?? '';
    const mods = new Set(parts);
    for (const mod of mods)
    {
        if (mod !== 'pp' && mod !== 'centroid')
        {
            throw new Error(`bad dcl modifier "_${mod}"`);
        }
    }
    if (operands.length !== 1)
    {
        throw new Error('dcl takes one register');
    }
    let usageToken = 0x80000000;
    const typeNames = ['2d', 'cube', 'volume'];
    if (typeNames.includes(kind))
    {
        usageToken |= (2 + typeNames.indexOf(kind)) << 27;
    }
    else if (kind !== '')
    {
        const m = /^([a-z]+?)(\d*)$/.exec(kind);
        const usage = m ? USAGES.indexOf(m[1]) : -1;
        if (!m || usage < 0)
        {
            throw new Error(`bad dcl usage "${kind}"`);
        }
        usageToken |= usage | ((m[2] === '' ? 0 : Number(m[2])) << 16);
    }
    const [dest] = assembleDest(v, operands[0], { mods });
    return [(usageToken | 0) >>> 0, dest];
}

/**
 * Turns shader assembly text into tokens.
 *
 * `;` and `//` start comments. The first statement is the version
 * (`vs_2_0`, `ps_3_0` ...). Registers are r, v, c, i, b, s, t, a0, aL, oPos,
 * oFog, oPts, oD#, oT#, o#, oC#, oDepth, vPos and vFace; a constant or input
 * is addressed relatively as `c[a0.x + 3]` or `v[aL + 1]`; a source takes
 * `-`, `|...|` and `-|...|`; a destination takes `_sat`, `_pp` and
 * `_centroid`; comparisons spell `if_lt`, `break_ge` and so on.
 *
 * The ps_1_x models add the registers t# (texture) and v# as in ps_2, `phase`,
 * a `+` before a co-issued instruction, the destination shifts `_x2 _x4 _x8
 * _d2 _d4 _d8` beside `_sat`, rgba spellings of masks and swizzles, and the
 * source modifiers `-r0`, `1-r0`, `r0_bias`, `-r0_bias`, `r0_bx2`, `-r0_bx2`,
 * `r0_x2`, `-r0_x2`, `t0_dz` and `t0_dw`, written between the register and
 * its swizzle (`t0_dw.xyw`, `r0_bx2.a`). `tex` is ps_1_1 to ps_1_3's texld and
 * `texcrd` ps_1_4's texcoord.
 *
 * By default the result is run through decode(), so what comes back is a
 * shader the version allows; pass `{ validate: false }` to assemble a shader
 * that is meant to be rejected.
 *
 * @param {string} text
 * @param {{ validate?: boolean }} [options]
 * @returns {Uint32Array}
 */
export function assemble(text, options = {}){
    /** @type {number[]} */
    const out = [];
    /** @type {VersionInfo | null} */
    let v = null;
    const lines = text.split(/\r?\n/);
    for (let ln = 0; ln < lines.length; ln++)
    {
        const line = lines[ln].replace(/;.*$/, '').replace(/\/\/.*$/, '').trim();
        if (line === '')
        {
            continue;
        }
        try
        {
            if (!v)
            {
                const m = /^(vs|ps)_(\d)_(\d|x)$/i.exec(line);
                if (!m)
                {
                    throw new Error('the first statement must be the shader version');
                }
                const minor = m[3].toLowerCase() === 'x' ? 1 : Number(m[3]);
                const token = ((m[1].toLowerCase() === 'vs' ? 0xfffe0000 : 0xffff0000)
                    | (Number(m[2]) << 8) | minor) >>> 0;
                v = parseVersion(token);
                out.push(token);
                continue;
            }
            out.push(...assembleStatement(v, line));
        }
        catch (e){
            const message = e instanceof Error ? e.message : String(e);
            throw new Error(`assemble: line ${ln + 1}: ${message}`, { cause: e });
        }
    }
    if (!v)
    {
        throw new Error('assemble: no version statement');
    }
    out.push(END_TOKEN);
    const tokens = Uint32Array.from(out);
    if (options.validate !== false)
    {
        decode(tokens);
    }
    return tokens;
}

/**
 * @param {VersionInfo} v
 * @param {string} line
 * @returns {number[]}
 */
function assembleStatement(v, line){
    let coissue = false;
    if (line.startsWith('+'))
    {
        coissue = true;
        line = line.slice(1).trim();
    }
    const space = line.search(/\s/);
    const word = (space < 0 ? line : line.slice(0, space)).toLowerCase();
    const operands = splitOperands(space < 0 ? '' : line.slice(space + 1));
    const lengthField = (/** @type {number} */ count)=>{
        if (count > 15)
        {
            throw new Error('instruction too long');
        }
        return v.major >= 2 ? count << 24 : 0;
    };
    if (word === 'phase')
    {
        if (operands.length || coissue)
        {
            throw new Error('phase takes no operands and cannot be co-issued');
        }
        return [PHASE_CODE];
    }
    if (coissue && (word.startsWith('dcl') || word.startsWith('def')))
    {
        throw new Error(`${word} cannot be co-issued`);
    }
    if (word.startsWith('dcl'))
    {
        const body = assembleDcl(word, v, operands);
        return [(31 | lengthField(body.length)) >>> 0, ...body];
    }
    if (word === 'def' || word === 'defi' || word === 'defb')
    {
        const info = /** @type {OpInfo} */ (OP_BY_NAME.get(word));
        const count = word === 'defb' ? 1 : 4;
        if (operands.length !== count + 1)
        {
            throw new Error(`${word} takes a register and ${count} value${count > 1 ? 's' : ''}`);
        }
        const [dest] = assembleDest(v, operands[0], { mods: new Set() });
        const lits = operands.slice(1).map(s=>{
            if (word === 'def')
            {
                return parseFloatLiteral(s);
            }
            if (word === 'defi')
            {
                return parseIntLiteral(s) >>> 0;
            }
            if (s === 'true' || s === 'false')
            {
                return s === 'true' ? 1 : 0;
            }
            return parseIntLiteral(s) >>> 0;
        });
        return [(info.code | lengthField(1 + count)) >>> 0, dest, ...lits];
    }
    const parts = word.split('_');
    const base = parts[0];
    const mods = new Set();
    let control = 0;
    let name = base;
    for (const part of parts.slice(1))
    {
        if (part === 'sat' || part === 'pp' || part === 'centroid'
            || (v.ps1 && SHIFT_BY_NAME.has(part)))
        {
            mods.add(part);
        }
        else if (COMPARISONS.indexOf(part) > 0 && (base === 'if' || base === 'break'))
        {
            control = COMPARISONS.indexOf(part);
            name = base === 'if' ? 'ifc' : 'breakc';
        }
        else
        {
            throw new Error(`unknown instruction "${word}"`);
        }
    }
    if (base === 'texldp' || base === 'texldb')
    {
        name = 'texld';
        control = base === 'texldp' ? 1 : 2;
    }
    const info = OP_BY_NAME.get(name);
    const bareCompare = (name === 'ifc' || name === 'breakc') && control === 0;
    const spelling = (name === 'tex' || name === 'texcrd') && !v.ps1;
    if (!info || name === 'dcl' || name.startsWith('def') || bareCompare || spelling)
    {
        throw new Error(`unknown instruction "${word}"`);
    }
    /** @type {number[]} */
    const body = [];
    let rest = operands;
    if (info.dst)
    {
        if (!rest.length)
        {
            throw new Error(`${word} needs a destination`);
        }
        // texcrd has no alpha to give, so a bare register means the three it writes.
        body.push(...assembleDest(v, rest[0],
            { mods, defaultMask: name === 'texcrd' ? MASK_RGB : undefined }));
        rest = rest.slice(1);
    }
    else if (mods.size)
    {
        throw new Error(`${word} has no destination to modify`);
    }
    for (const s of rest)
    {
        body.push(...assembleSource(v, s));
    }
    const opcode = info.code | (control << 16) | lengthField(body.length)
        | (coissue ? 1 << 30 : 0);
    return [opcode >>> 0, ...body];
}

/* ---------------------------------------------------------------- execute */

/**
 * @typedef {Object} SampleMode
 * @property {'plain'|'bias'|'lod'|'grad'} kind
 * @property {number} [value]
 * @property {number[]} [ddx]
 * @property {number[]} [ddy]
 */

/**
 * @typedef {Object} MachineIO
 * @property {{ f?: ArrayLike<number>, i?: ArrayLike<number>,
 *   b?: ArrayLike<number | boolean> }} [constants]
 * @property {{ v?: number[][], t?: number[][] }} [inputs]
 * @property {[number, number]} [position]
 * @property {boolean} [frontFacing]
 * @property {(sampler: number, dimension: '2d'|'cube'|'volume', coord: number[],
 *   mode: SampleMode) => number[]} [sample]
 * @property {(axis: 'x'|'y', value: number[]) => number[]} [derivative]
 * @property {('2d'|'cube'|'volume')[]} [dimensions]  ps_1_x: what each stage's texture is, as
 *   io.sample is told; '2d' where a stage has no entry.
 * @property {{ m00: number, m01: number, m10: number, m11: number, lscale?: number,
 *   loffset?: number }[]} [bump]  ps_1_x: per stage, the bump environment matrix
 *   (D3DTSS_BUMPENVMAT00 to 11) and the luminance scale and offset (D3DTSS_BUMPENVLSCALE and
 *   BUMPENVLOFFSET) that texbem, texbeml and bem read.
 */

/**
 * @typedef {Object} Result
 * @property {Record<string, number[]>} outputs       Unwritten components are NaN.
 * @property {Record<string, number>} written         Per output, the components written.
 * @property {boolean} killed
 * @property {number} instructionsExecuted
 * @property {Record<string, { usage: string, index: number }>} semantics
 */

/**
 * @typedef {Object} Frame
 * @property {boolean} isLoop
 * @property {number} start
 * @property {number} end
 * @property {number} count
 * @property {number} iter
 * @property {number} aL
 * @property {number} step
 */

/**
 * Runs a shader once.
 *
 * @param {Program | ArrayLike<number>} subject
 * @param {MachineIO} io
 * @returns {Result}
 */
export function execute(subject, io){
    const program = /** @type {Program} */ (
        'instructions' in subject ? subject : decode(subject));
    if (program.info.ps1)
    {
        return executePs1(program, io);
    }
    const v = program.info;
    const list = program.instructions;
    const consts = io.constants ?? {};
    const needsDcl = v.major >= 2;

    const temps = new Float32Array(v.limits.temps * 4);
    const tempsWritten = new Uint8Array(v.limits.temps * 4);
    const a0 = [0, 0, 0, 0];
    /** The components of a0 written so far. */
    let a0Written = 0;
    /** @type {Record<string, Float32Array>} */
    const outputs = {};
    /** @type {Record<string, number>} */
    const written = {};
    /** @type {Record<string, { usage: string, index: number }>} */
    const semantics = {};
    for (const decl of program.declarations)
    {
        if (decl.usage)
        {
            semantics[decl.register] = { usage: decl.usage, index: decl.usageIndex };
        }
        if (decl.type === REG.OUTPUT && v.vs && v.major === 3)
        {
            outputs[decl.register] = new Float32Array(4).fill(NaN);
            written[decl.register] = 0;
        }
    }
    let killed = false;
    let executed = 0;
    /** @type {Frame[]} */
    const frames = [];

    /** @type {Instruction} */
    let cur = list[0];
    /**
     * @param {string} message
     * @returns {never}
     */
    const fail = message=>{
        throw new Error(
            `${message} at instruction ${cur.ordinal}: ${formatInstruction(program, cur)}`);
    };

    const currentLoop = ()=>{
        for (let k = frames.length - 1; k >= 0; k--)
        {
            if (frames[k].isLoop)
            {
                return frames[k];
            }
        }
        return null;
    };

    /** @param {number} idx @param {number} c */
    const constFloat = (idx, c)=>{
        const def = program.defs.f.get(idx);
        if (def)
        {
            return def[c];
        }
        const arr = consts.f;
        const k = idx * 4 + c;
        if (!arr || k >= arr.length || typeof arr[k] !== 'number')
        {
            return fail(`read of unsupplied constant c${idx}.${COMPONENTS[c]}`);
        }
        return f32(arr[k]);
    };

    /** @param {number} idx @param {number} k */
    const constInt = (idx, k)=>{
        const def = program.defs.i.get(idx);
        if (def)
        {
            return def[k];
        }
        const arr = consts.i;
        if (!arr || idx * 4 + k >= arr.length)
        {
            return fail(`read of unsupplied integer constant i${idx}`);
        }
        return Number(arr[idx * 4 + k]) | 0;
    };

    /** @param {number} idx */
    const constBool = idx=>{
        const def = program.defs.b.get(idx);
        if (def !== undefined)
        {
            return def;
        }
        const arr = consts.b;
        if (!arr || idx >= arr.length || arr[idx] === undefined)
        {
            return fail(`read of unsupplied boolean constant b${idx}`);
        }
        return !!arr[idx];
    };

    /** @param {NonNullable<Operand['relative']>} rel */
    const relativeValue = rel=>{
        if (rel.type === REG.LOOP)
        {
            const frame = currentLoop();
            return frame ? frame.aL : fail('read of aL outside a loop');
        }
        const comp = rel.swizzle & 3;
        return (a0Written & 1 << comp) !== 0 ? a0[comp]
            : fail(`read of unwritten a0.${COMPONENTS[comp]}`);
    };

    /**
     * One component of a register, before swizzle and modifier.
     * @param {Operand} op @param {number} comp @param {number} offset
     * @returns {number}
     */
    const readRaw = (op, comp, offset)=>{
        let index = op.index + offset;
        if (op.relative)
        {
            index += relativeValue(op.relative);
        }
        const cname = COMPONENTS[comp];
        const checkDeclared = ()=>{
            if (!needsDcl)
            {
                return;
            }
            const decl = program.declared.get(declKey(op.type, index));
            if (!decl)
            {
                fail(`read of undeclared ${registerName(v, op.type, index)}`);
            }
            else if (!(decl.mask & (1 << comp)))
            {
                fail(`read of ${registerName(v, op.type, index)}.${cname}, `
                    + 'outside its declaration');
            }
        };
        switch (op.type)
        {
            case REG.TEMP: {
                if (index < 0 || index >= v.limits.temps)
                {
                    return fail(`temporary r${index} is out of range`);
                }
                const k = index * 4 + comp;
                if (!tempsWritten[k])
                {
                    return fail(`read of unwritten r${index}.${cname}`);
                }
                return temps[k];
            }
            case REG.INPUT: {
                if (index < 0 || index >= v.limits.inputs)
                {
                    return fail(`input v${index} is out of range`);
                }
                checkDeclared();
                const value = io.inputs?.v?.[index]?.[comp];
                if (typeof value !== 'number')
                {
                    return fail(`input v${index}.${cname} was not supplied`);
                }
                return f32(value);
            }
            case REG.TEXTURE: {
                if (index < 0 || index >= v.limits.texcoords)
                {
                    return fail(`texture register t${index} is out of range`);
                }
                checkDeclared();
                const value = io.inputs?.t?.[index]?.[comp];
                if (typeof value !== 'number')
                {
                    return fail(`input t${index}.${cname} was not supplied`);
                }
                return f32(value);
            }
            case REG.CONST:
                if (index < 0 || index >= v.limits.floatConsts)
                {
                    return fail(`constant address c${index} is outside the register file`);
                }
                return constFloat(index, comp);
            case REG.MISC:
                checkDeclared();
                if (index === 0)
                {
                    const p = io.position;
                    if (comp > 1 || !p)
                    {
                        return fail(`read of undefined vPos.${cname}`);
                    }
                    return f32(p[comp]);
                }
                if (io.frontFacing === undefined)
                {
                    return fail('vFace was not supplied');
                }
                return io.frontFacing ? 1 : -1;
            case REG.LOOP: {
                const frame = currentLoop();
                return frame ? frame.aL : fail('read of aL outside a loop');
            }
            default:
                return fail(`register ${registerName(v, op.type, index)} cannot be read`);
        }
    };

    /**
     * Component `pos` of a source after its swizzle and modifier.
     * @param {Operand} op @param {number} pos @param {number} [offset]
     */
    const src = (op, pos, offset = 0)=>{
        let value = readRaw(op, (op.swizzle >> (2 * pos)) & 3, offset);
        if (op.modifier !== MOD.NONE)
        {
            if (op.modifier === MOD.ABS || op.modifier === MOD.ABSNEG)
            {
                value = Math.abs(value);
            }
            if (op.modifier === MOD.NEG || op.modifier === MOD.ABSNEG)
            {
                value = -value;
            }
        }
        return value;
    };

    /**
     * @param {Operand} d
     * @returns {string}
     */
    const outputName = d=>registerName(v, d.type, d.index);

    /** @param {number[]} res */
    const commit = res=>{
        const d = /** @type {Operand} */ (cur.dest);
        const mask = d.writeMask;
        if (d.type === REG.ADDR)
        {
            for (let c = 0; c < 4; c++)
            {
                if ((mask & 1 << c) !== 0)
                {
                    const value = cur.name === 'mova' ? Math.floor(res[c] + 0.5)
                        : Math.floor(res[c]);
                    a0[c] = Number.isFinite(value) ? value | 0 : 0;
                }
            }
            a0Written |= mask;
            return;
        }
        /** @type {Float32Array | null} */
        let out = null;
        let outKey = '';
        if (d.type !== REG.TEMP)
        {
            outKey = outputName(d);
            out = outputs[outKey] ?? (outputs[outKey] = new Float32Array(4).fill(NaN));
            written[outKey] = written[outKey] ?? 0;
        }
        for (let c = 0; c < 4; c++)
        {
            if (!(mask & (1 << c)))
            {
                continue;
            }
            let value = res[c];
            if (d.saturate)
            {
                value = value > 1 ? 1 : value > 0 ? value : 0;
            }
            if (out)
            {
                out[c] = value;
                written[outKey] |= 1 << c;
            }
            else
            {
                const k = d.index * 4 + c;
                temps[k] = value;
                tempsWritten[k] = 1;
            }
        }
    };

    /**
     * Applies fn to each written component's operands, reading every source
     * before any result is stored.
     * @param {(c: number) => number} fn
     */
    const perComponent = fn=>{
        const mask = /** @type {Operand} */ (cur.dest).writeMask;
        const res = [0, 0, 0, 0];
        for (let c = 0; c < 4; c++)
        {
            if (mask & (1 << c))
            {
                res[c] = fn(c);
            }
        }
        commit(res);
    };

    /** @param {(s: number) => number} fn  A scalar function of the one source component. */
    const scalar = fn=>{
        const s = cur.sources[0];
        const value = fn(src(s, 0));
        perComponent(()=>value);
    };

    /** @param {number} sel */
    const compare = sel=>{
        const [a, b] = [src(cur.sources[0], 0), src(cur.sources[1], 0)];
        switch (sel)
        {
            case 1: return a > b;
            case 2: return a === b;
            case 3: return a >= b;
            case 4: return a < b;
            case 5: return a !== b;
            default: return a <= b;
        }
    };

    /**
     * @param {number} sampler
     * @returns {'2d'|'cube'|'volume'}
     */
    const samplerType = sampler=>{
        const type = program.samplers.get(sampler);
        return type ?? fail(`sampler s${sampler} is not declared`);
    };

    const rsq = (/** @type {number} */ x)=>x === 0 ? Infinity : f32(1 / Math.sqrt(Math.abs(x)));

    /**
     * Sums the products of `n` components of two sources, left to right.
     * @param {Operand} a @param {Operand} b @param {number} n @param {number} [bOffset]
     */
    const dot = (a, b, n, bOffset = 0)=>{
        let sum = f32(src(a, 0) * src(b, 0, bOffset));
        for (let k = 1; k < n; k++)
        {
            sum = f32(sum + f32(src(a, k) * src(b, k, bOffset)));
        }
        return sum;
    };

    /** @param {number} rows @param {number} n */
    const matrix = (rows, n)=>{
        const [a, b] = cur.sources;
        perComponent(c=>c < rows ? dot(a, b, n, c) : 0);
    };

    const exec = ()=>{
        const s = cur.sources;
        switch (cur.name)
        {
            case 'nop': break;
            case 'mov': perComponent(c=>src(s[0], c)); break;
            case 'mova': perComponent(c=>src(s[0], c)); break;
            case 'add': perComponent(c=>f32(src(s[0], c) + src(s[1], c))); break;
            case 'sub': perComponent(c=>f32(src(s[0], c) - src(s[1], c))); break;
            case 'mul': perComponent(c=>f32(src(s[0], c) * src(s[1], c))); break;
            case 'mad':
                perComponent(c=>f32(f32(src(s[0], c) * src(s[1], c)) + src(s[2], c)));
                break;
            case 'min':
                perComponent(c=>{
                    const [a, b] = [src(s[0], c), src(s[1], c)];
                    return a < b ? a : b;
                });
                break;
            case 'max':
                perComponent(c=>{
                    const [a, b] = [src(s[0], c), src(s[1], c)];
                    return a >= b ? a : b;
                });
                break;
            case 'slt': perComponent(c=>src(s[0], c) < src(s[1], c) ? 1 : 0); break;
            case 'sge': perComponent(c=>src(s[0], c) >= src(s[1], c) ? 1 : 0); break;
            case 'lrp':
                perComponent(c=>{
                    const [a, b, d] = [src(s[0], c), src(s[1], c), src(s[2], c)];
                    return f32(d + f32(a * f32(b - d)));
                });
                break;
            case 'frc': perComponent(c=>{
                const x = src(s[0], c);
                return f32(x - Math.floor(x));
            }); break;
            case 'abs': perComponent(c=>Math.abs(src(s[0], c))); break;
            case 'cmp':
                perComponent(c=>{
                    const a = src(s[0], c);
                    const [b, d] = [src(s[1], c), src(s[2], c)];
                    return a >= 0 ? b : d;
                });
                break;
            case 'sgn':
                perComponent(c=>{
                    const x = src(s[0], c);
                    return x > 0 ? 1 : x < 0 ? -1 : x === 0 ? 0 : NaN;
                });
                break;
            case 'dp3': { const r = dot(s[0], s[1], 3); perComponent(()=>r); break; }
            case 'dp4': { const r = dot(s[0], s[1], 4); perComponent(()=>r); break; }
            case 'dp2add': {
                const r = f32(dot(s[0], s[1], 2) + src(s[2], 0));
                perComponent(()=>r);
                break;
            }
            case 'rcp': scalar(x=>x === 0 ? Infinity : f32(1 / x)); break;
            case 'rsq': scalar(rsq); break;
            case 'exp': case 'expp': scalar(x=>f32(Math.pow(2, x))); break;
            case 'log': case 'logp': scalar(x=>f32(Math.log2(Math.abs(x)))); break;
            case 'pow': {
                const base = Math.abs(src(s[0], 0));
                const exponent = src(s[1], 0);
                const r = base === 1 ? 1 : f32(Math.pow(base, exponent));
                perComponent(()=>r);
                break;
            }
            case 'sincos': {
                const x = src(s[0], 0);
                perComponent(c=>c === 0 ? f32(Math.cos(x)) : f32(Math.sin(x)));
                break;
            }
            case 'nrm': {
                const r = rsq(dot(s[0], s[0], 3));
                perComponent(c=>f32(src(s[0], c) * r));
                break;
            }
            case 'crs': {
                const a = (/** @type {number} */ k)=>src(s[0], k);
                const b = (/** @type {number} */ k)=>src(s[1], k);
                const term = (/** @type {number} */ p, /** @type {number} */ q,
                    /** @type {number} */ r, /** @type {number} */ w)=>
                    f32(f32(a(p) * b(q)) - f32(a(r) * b(w)));
                perComponent(c=>c === 0 ? term(1, 2, 2, 1)
                    : c === 1 ? term(2, 0, 0, 2) : c === 2 ? term(0, 1, 1, 0) : 0);
                break;
            }
            case 'lit': {
                const mask = /** @type {Operand} */ (cur.dest).writeMask;
                const x = mask & 0x6 ? src(s[0], 0) : 0;
                const y = mask & 0x4 ? src(s[0], 1) : 0;
                const w = mask & 0x4 ? src(s[0], 3) : 0;
                perComponent(c=>{
                    if (c === 0 || c === 3)
                    {
                        return 1;
                    }
                    if (c === 1)
                    {
                        return x > 0 ? x : 0;
                    }
                    if (!(x > 0 && y > 0))
                    {
                        return 0;
                    }
                    const power = Math.min(Math.max(w, -LIT_POWER_LIMIT), LIT_POWER_LIMIT);
                    return f32(Math.pow(y, power));
                });
                break;
            }
            case 'dst':
                perComponent(c=>{
                    switch (c)
                    {
                        case 0: return 1;
                        case 1: return f32(src(s[0], 1) * src(s[1], 1));
                        case 2: return src(s[0], 2);
                        default: return src(s[1], 3);
                    }
                });
                break;
            case 'm4x4': matrix(4, 4); break;
            case 'm4x3': matrix(3, 4); break;
            case 'm3x4': matrix(4, 3); break;
            case 'm3x3': matrix(3, 3); break;
            case 'm3x2': matrix(2, 3); break;
            case 'dsx': case 'dsy': {
                if (!io.derivative)
                {
                    fail(`${cur.name} needs io.derivative`);
                }
                const mask = /** @type {Operand} */ (cur.dest).writeMask;
                const value = [0, 0, 0, 0];
                for (let c = 0; c < 4; c++)
                {
                    if (mask & (1 << c))
                    {
                        value[c] = src(s[0], c);
                    }
                }
                const answer = /** @type {NonNullable<MachineIO['derivative']>} */ (io.derivative)(
                    cur.name === 'dsx' ? 'x' : 'y', value);
                perComponent(c=>f32(answer[c]));
                break;
            }
            case 'texld': case 'texldp': case 'texldb': case 'texldl': case 'texldd': {
                if (!io.sample)
                {
                    fail(`${cur.name} needs io.sample`);
                }
                const sampler = s[1].index;
                const dimension = samplerType(sampler);
                const n = dimension === '2d' ? 2 : 3;
                const coord = [0, 0, 0, 0];
                for (let k = 0; k < n; k++)
                {
                    coord[k] = src(s[0], k);
                }
                /** @type {SampleMode} */
                let mode = { kind: 'plain' };
                if (cur.name === 'texldp')
                {
                    const w = src(s[0], 3);
                    for (let k = 0; k < n; k++)
                    {
                        coord[k] = f32(coord[k] / w);
                    }
                    coord[3] = w;
                }
                else if (cur.name === 'texldb' || cur.name === 'texldl')
                {
                    const w = src(s[0], 3);
                    coord[3] = w;
                    mode = { kind: cur.name === 'texldb' ? 'bias' : 'lod', value: w };
                }
                else if (cur.name === 'texldd')
                {
                    const ddx = [0, 0, 0, 0];
                    const ddy = [0, 0, 0, 0];
                    for (let k = 0; k < n; k++)
                    {
                        ddx[k] = src(s[2], k);
                        ddy[k] = src(s[3], k);
                    }
                    mode = { kind: 'grad', ddx, ddy };
                }
                const texel = io.sample(sampler, dimension, coord, mode);
                if (!texel || texel.length < 4)
                {
                    fail('io.sample must answer four components');
                }
                perComponent(c=>f32(texel[c]));
                break;
            }
            case 'texkill': {
                const d = /** @type {Operand} */ (cur.dest);
                for (let c = 0; c < 3; c++)
                {
                    if (readRaw(d, c, 0) < 0)
                    {
                        killed = true;
                    }
                }
                break;
            }
            default:
                fail(`instruction ${cur.name} is not implemented`);
        }
    };

    let pc = 0;
    /** @type {{ ret: number, depth: number }[]} */
    const calls = [];
    while (pc < list.length)
    {
        cur = list[pc];
        if (cur.decl)
        {
            pc++;
            continue;
        }
        if (++executed > RUNAWAY_LIMIT)
        {
            fail(`runaway shader: more than ${RUNAWAY_LIMIT} instructions executed`);
        }
        switch (cur.name)
        {
            case 'if': case 'ifc': {
                const ok = cur.name === 'if' ? constBool(cur.sources[0].index)
                    : compare(cur.control);
                if (ok)
                {
                    pc++;
                }
                else
                {
                    pc = /** @type {number} */ (cur.elseIdx) >= 0
                        ? /** @type {number} */ (cur.elseIdx) + 1 : /** @type {number} */ (cur.endIdx);
                }
                break;
            }
            case 'else':
                pc = /** @type {number} */ (cur.endIdx);
                break;
            case 'endif': case 'label':
                pc++;
                break;
            case 'rep': case 'loop': {
                const isLoop = cur.name === 'loop';
                const reg = cur.sources[isLoop ? 1 : 0].index;
                const count = constInt(reg, 0);
                if (count <= 0)
                {
                    pc = /** @type {number} */ (cur.endIdx) + 1;
                    break;
                }
                frames.push({
                    isLoop, start: pc, end: /** @type {number} */ (cur.endIdx), count, iter: 0,
                    aL: isLoop ? constInt(reg, 1) : 0, step: isLoop ? constInt(reg, 2) : 0,
                });
                pc++;
                break;
            }
            case 'endloop': case 'endrep': {
                const frame = frames[frames.length - 1];
                if (!frame || frame.end !== pc)
                {
                    fail(`${cur.name} reached outside its loop`);
                }
                frame.iter++;
                if (frame.iter < frame.count)
                {
                    frame.aL += frame.step;
                    pc = frame.start + 1;
                }
                else
                {
                    frames.pop();
                    pc++;
                }
                break;
            }
            case 'break': case 'breakc': {
                if (cur.name === 'breakc' && !compare(cur.control))
                {
                    pc++;
                    break;
                }
                const frame = frames[frames.length - 1];
                if (!frame || frame.start !== cur.loopIdx)
                {
                    fail('break outside its loop');
                }
                frames.pop();
                pc = frame.end + 1;
                break;
            }
            case 'call': case 'callnz': {
                if (cur.name === 'callnz' && !constBool(cur.sources[1].index))
                {
                    pc++;
                    break;
                }
                if (calls.length >= MAX_CALL_DEPTH)
                {
                    fail(`call nesting deeper than ${MAX_CALL_DEPTH}`);
                }
                calls.push({ ret: pc + 1, depth: frames.length });
                pc = /** @type {number} */ (cur.labelIdx);
                break;
            }
            case 'ret': {
                const call = calls.pop();
                if (!call)
                {
                    pc = list.length;
                    break;
                }
                frames.length = call.depth;
                pc = call.ret;
                break;
            }
            default:
                exec();
                pc++;
        }
    }

    /** @type {Record<string, number[]>} */
    const plain = {};
    for (const [name, values] of Object.entries(outputs))
    {
        plain[name] = Array.from(values);
    }
    return { outputs: plain, written, killed, instructionsExecuted: executed, semantics };
}

/* ------------------------------------------------------------ execute, ps_1_x */

/**
 * Runs a ps_1_x shader once. The semantics are in the header of this file.
 *
 * @param {Program} program
 * @param {MachineIO} io
 * @returns {Result}
 */
function executePs1(program, io){
    const v = program.info;
    const late = v.minor === 4;
    const list = program.instructions;
    const consts = io.constants ?? {};
    const RGBA = 'rgba';
    const temps = new Float32Array(v.limits.temps * 4);
    const tempsWritten = new Uint8Array(v.limits.temps * 4);
    const texels = new Float32Array(v.limits.texcoords * 4);
    const texelsWritten = new Uint8Array(v.limits.texcoords);
    let killed = false;
    let executed = 0;
    /** @type {number | null} */
    let depth = null;
    /** @type {number[]} */
    let rows = [];

    /** @type {Instruction} */
    let cur = list[0];
    /**
     * @param {string} message
     * @returns {never}
     */
    const fail = message=>{
        throw new Error(
            `${message} at instruction ${cur.ordinal}: ${formatInstruction(program, cur)}`);
    };
    const saturate = (/** @type {number} */ x)=>x > 1 ? 1 : x > 0 ? x : 0;

    /** @param {number} index @param {number} c */
    const constant = (index, c)=>{
        const def = program.defs.f.get(index);
        let x;
        if (def)
        {
            x = def[c];
        }
        else
        {
            const arr = consts.f;
            const k = index * 4 + c;
            if (!arr || k >= arr.length || typeof arr[k] !== 'number')
            {
                return fail(`read of unsupplied constant c${index}.${RGBA[c]}`);
            }
            x = f32(arr[k]);
        }
        return x > PS1_CONSTANT_LIMIT ? PS1_CONSTANT_LIMIT
            : x < -PS1_CONSTANT_LIMIT ? -PS1_CONSTANT_LIMIT : x;
    };

    /** One component of a texture coordinate set. @param {number} n @param {number} c */
    const coordinate = (n, c)=>{
        const x = io.inputs?.t?.[n]?.[c];
        return typeof x === 'number' ? f32(x)
            : fail(`input t${n}.${COMPONENTS[c]} was not supplied`);
    };

    /** One component of a register, before swizzle and modifier. @param {Operand} op */
    const readRaw = (op, /** @type {number} */ c)=>{
        switch (op.type)
        {
            case REG.TEMP: {
                const k = op.index * 4 + c;
                return tempsWritten[k] ? temps[k]
                    : fail(`read of unwritten r${op.index}.${RGBA[c]}`);
            }
            case REG.INPUT: {
                const x = io.inputs?.v?.[op.index]?.[c];
                return typeof x === 'number' ? f32(x)
                    : fail(`input v${op.index}.${RGBA[c]} was not supplied`);
            }
            case REG.CONST:
                return constant(op.index, c);
            case REG.TEXTURE:
                if (late)
                {
                    return coordinate(op.index, c);
                }
                return texelsWritten[op.index] ? texels[op.index * 4 + c]
                    : fail(`read of unwritten t${op.index}.${RGBA[c]}`);
            default:
                return fail(`register ${registerName(v, op.type, op.index)} cannot be read`);
        }
    };

    /** @param {number} modifier @param {number} x */
    const modify = (modifier, x)=>{
        switch (modifier)
        {
            case MOD.NEG: return -x;
            case MOD.BIAS: return f32(x - 0.5);
            case MOD.BIASNEG: return f32(0.5 - x);
            case MOD.SIGN: return f32(f32(x - 0.5) * 2);
            case MOD.SIGNNEG: return f32(f32(0.5 - x) * 2);
            case MOD.COMP: return f32(1 - x);
            case MOD.X2: return f32(x * 2);
            case MOD.X2NEG: return -f32(x * 2);
            default: return x;
        }
    };

    /** Component `pos` of a source after its swizzle and modifier. */
    const src = (/** @type {Operand} */ op, /** @type {number} */ pos)=>
        modify(op.modifier, readRaw(op, (op.swizzle >> (2 * pos)) & 3));

    /** @param {Operand} a @param {Operand} b @param {number} n */
    const dot = (a, b, n)=>{
        let sum = f32(src(a, 0) * src(b, 0));
        for (let k = 1; k < n; k++)
        {
            sum = f32(sum + f32(src(a, k) * src(b, k)));
        }
        return sum;
    };

    /**
     * Stores a result in the temporaries -- or, before 1.4, a texture register -- the shift
 * scale, then _sat, then the mask.
     * @param {Instruction} ins @param {number[]} res
     */
    const store = (ins, res)=>{
        const d = /** @type {Operand} */ (ins.dest);
        const scale = SHIFT_SCALES.get(d.shift) ?? 1;
        for (let c = 0; c < 4; c++)
        {
            if (!(d.writeMask & (1 << c)))
            {
                continue;
            }
            let x = res[c];
            if (scale !== 1)
            {
                x = f32(x * scale);
            }
            if (d.saturate)
            {
                x = saturate(x);
            }
            if (d.type === REG.TEXTURE)
            {
                texels[d.index * 4 + c] = x;
                texelsWritten[d.index] = 1;
                continue;
            }
            temps[d.index * 4 + c] = x;
            tempsWritten[d.index * 4 + c] = 1;
        }
    };

    /** @param {number} stage */
    const dimension = stage=>{
        const dim = io.dimensions?.[stage] ?? '2d';
        if (dim !== '2d' && dim !== 'cube' && dim !== 'volume')
        {
            return fail(`io.dimensions[${stage}] is "${dim}"; it must be 2d, cube or volume`);
        }
        return dim;
    };
    /** Coordinates a lookup of the stage reads. @param {number} stage */
    const needed = stage=>dimension(stage) === '2d' ? 2 : 3;

    /** @param {number} stage @param {number[]} coord */
    const sample = (stage, coord)=>{
        if (!io.sample)
        {
            fail(`${cur.name} needs io.sample`);
        }
        const texel = /** @type {NonNullable<MachineIO['sample']>} */ (io.sample)(
            stage, dimension(stage), coord, { kind: 'plain' });
        if (!texel || texel.length < 4)
        {
            fail('io.sample must answer four components');
        }
        return [f32(texel[0]), f32(texel[1]), f32(texel[2]), f32(texel[3])];
    };

    /**
     * The coordinate set of a stage as four floats; the first `count` must have
     * been supplied, the rest are taken if they were.
     * @param {number} n @param {number} count
     */
    const coordinates = (n, count)=>{
        const out = [0, 0, 0, 0];
        for (let c = 0; c < 4; c++)
        {
            const x = io.inputs?.t?.[n]?.[c];
            if (c < count)
            {
                out[c] = coordinate(n, c);
            }
            else if (typeof x === 'number')
            {
                out[c] = f32(x);
            }
        }
        return out;
    };

    /** Writes a t# register of ps_1_1 to ps_1_3. @param {number} n @param {number[]} value */
    const fill = (n, value)=>{
        for (let c = 0; c < 4; c++)
        {
            texels[n * 4 + c] = value[c];
        }
        texelsWritten[n] = 1;
    };

    /** The bump environment state of a stage. @param {number} stage */
    const bump = stage=>{
        const b = io.bump?.[stage];
        return b ?? fail(`${cur.name} needs io.bump[${stage}]`);
    };
    /** @param {Record<string, number | undefined>} b @param {string} key */
    const bumpValue = (b, key)=>{
        const x = b[key];
        return typeof x === 'number' ? f32(x) : fail(`io.bump needs a number ${key}`);
    };

    /** Row of a matrix multiply: the stage's (u, v, w) against the rgb of a source. */
    const row = (/** @type {number} */ n, /** @type {Operand} */ op)=>{
        let sum = f32(coordinate(n, 0) * src(op, 0));
        for (let k = 1; k < 3; k++)
        {
            sum = f32(sum + f32(coordinate(n, k) * src(op, k)));
        }
        return sum;
    };

    /** The coordinates a ps_1_4 texld or texcrd takes from its source, with _dz or _dw applied. */
    const vector = (/** @type {Operand} */ op, /** @type {number} */ count)=>{
        const out = [0, 0, 0, 0];
        const at = (/** @type {number} */ k)=>readRaw(op, (op.swizzle >> (2 * k)) & 3);
        const place = op.modifier === MOD.DZ ? 2 : op.modifier === MOD.DW ? 3 : -1;
        const divisor = place < 0 ? 1 : at(place);
        for (let k = 0; k < count; k++)
        {
            out[k] = place < 0 ? at(k) : f32(at(k) / divisor);
        }
        return out;
    };

    /** @param {number} z @param {number} w */
    const writeDepth = (z, w)=>{
        depth = w === 0 ? 1 : saturate(f32(z / w));
    };

    /**
     * Executes one instruction. An arithmetic instruction answers its result so a
     * co-issued pair can read before either stores; a texture instruction writes
     * its register itself.
     * @param {Instruction} ins
     * @returns {number[] | null}
     */
    const run = ins=>{
        cur = ins;
        executed++;
        const s = ins.sources;
        const d = ins.dest;
        const mask = d ? d.writeMask : 0;
        const res = [0, 0, 0, 0];
        const each = (/** @type {(c: number) => number} */ fn)=>{
            for (let c = 0; c < 4; c++)
            {
                if (mask & (1 << c))
                {
                    res[c] = fn(c);
                }
            }
            return res;
        };
        const n = d ? d.index : 0;
        switch (ins.name)
        {
            case 'nop': return null;
            case 'mov': return each(c=>src(s[0], c));
            case 'add': return each(c=>f32(src(s[0], c) + src(s[1], c)));
            case 'sub': return each(c=>f32(src(s[0], c) - src(s[1], c)));
            case 'mul': return each(c=>f32(src(s[0], c) * src(s[1], c)));
            case 'mad': return each(c=>f32(f32(src(s[0], c) * src(s[1], c)) + src(s[2], c)));
            case 'lrp':
                return each(c=>{
                    const [a, b, e] = [src(s[0], c), src(s[1], c), src(s[2], c)];
                    return f32(e + f32(a * f32(b - e)));
                });
            case 'dp3': { const r = dot(s[0], s[1], 3); return each(()=>r); }
            case 'dp4': { const r = dot(s[0], s[1], 4); return each(()=>r); }
            case 'cmp': return each(c=>src(s[0], c) >= 0 ? src(s[1], c) : src(s[2], c));
            case 'cnd': return each(c=>src(s[0], c) > 0.5 ? src(s[1], c) : src(s[2], c));
            case 'bem': {
                const b = bump(n);
                const [sr, sg] = [src(s[1], 0), src(s[1], 1)];
                return each(c=>c === 0
                    ? f32(f32(src(s[0], 0) + f32(bumpValue(b, 'm00') * sr))
                        + f32(bumpValue(b, 'm10') * sg))
                    : f32(f32(src(s[0], 1) + f32(bumpValue(b, 'm01') * sr))
                        + f32(bumpValue(b, 'm11') * sg)));
            }
            case 'tex':
                fill(n, sample(n, coordinates(n, needed(n))));
                return null;
            case 'texcoord':
                fill(n, [saturate(coordinate(n, 0)), saturate(coordinate(n, 1)),
                    saturate(coordinate(n, 2)), 1]);
                return null;
            case 'texkill': {
                const reg = /** @type {Operand} */ (d);
                for (let c = 0; c < 3; c++)
                {
                    let x;
                    if (reg.type === REG.TEMP)
                    {
                        x = readRaw(reg, c);
                    }
                    else
                    {
                        x = !late && texelsWritten[reg.index] ? texels[reg.index * 4 + c]
                            : coordinate(reg.index, c);
                    }
                    if (x < 0)
                    {
                        killed = true;
                    }
                }
                return null;
            }
            case 'texbem': case 'texbeml': {
                const b = bump(n);
                const [sr, sg] = [src(s[0], 0), src(s[0], 1)];
                const coord = coordinates(n, needed(n));
                const u = f32(f32(coord[0] + f32(bumpValue(b, 'm00') * sr))
                    + f32(bumpValue(b, 'm10') * sg));
                const w = f32(f32(coord[1] + f32(bumpValue(b, 'm01') * sr))
                    + f32(bumpValue(b, 'm11') * sg));
                const texel = sample(n, [u, w, coord[2], coord[3]]);
                if (ins.name === 'texbeml')
                {
                    const lum = saturate(f32(f32(src(s[0], 2) * bumpValue(b, 'lscale'))
                        + bumpValue(b, 'loffset')));
                    for (let c = 0; c < 3; c++)
                    {
                        texel[c] = f32(texel[c] * lum);
                    }
                }
                fill(n, texel);
                return null;
            }
            case 'texreg2ar':
                fill(n, sample(n, [src(s[0], 3), src(s[0], 0), 0, 0]));
                return null;
            case 'texreg2gb':
                fill(n, sample(n, [src(s[0], 1), src(s[0], 2), 0, 0]));
                return null;
            case 'texreg2rgb':
                fill(n, sample(n, [src(s[0], 0), src(s[0], 1), src(s[0], 2), 0]));
                return null;
            case 'texm3x2pad': case 'texm3x3pad':
                rows.push(row(n, s[0]));
                return null;
            case 'texm3x2tex': {
                const point = [rows[0], row(n, s[0]), 0, 0];
                rows = [];
                fill(n, sample(n, point));
                return null;
            }
            case 'texm3x2depth': {
                const z = rows[0];
                rows = [];
                writeDepth(z, row(n, s[0]));
                return null;
            }
            case 'texm3x3tex': case 'texm3x3': case 'texm3x3spec': case 'texm3x3vspec': {
                const normal = [rows[0], rows[1], row(n, s[0])];
                rows = [];
                if (ins.name === 'texm3x3')
                {
                    fill(n, [...normal, 1]);
                    return null;
                }
                if (ins.name === 'texm3x3tex')
                {
                    fill(n, sample(n, [...normal, 0]));
                    return null;
                }
                const eye = ins.name === 'texm3x3spec' ? [0, 1, 2].map(k=>src(s[1], k))
                    : [coordinate(n - 2, 3), coordinate(n - 1, 3), coordinate(n, 3)];
                let nn = f32(normal[0] * normal[0]);
                let ne = f32(normal[0] * eye[0]);
                for (let k = 1; k < 3; k++)
                {
                    nn = f32(nn + f32(normal[k] * normal[k]));
                    ne = f32(ne + f32(normal[k] * eye[k]));
                }
                const k = f32(f32(2 * ne) / nn);
                fill(n, sample(n, [0, 1, 2].map(c=>f32(f32(k * normal[c]) - eye[c])).concat(0)));
                return null;
            }
            case 'texdp3': case 'texdp3tex': {
                const x = row(n, s[0]);
                fill(n, ins.name === 'texdp3' ? [x, x, x, x] : sample(n, [x, 0, 0, 0]));
                return null;
            }
            case 'texld':
                store(ins, sample(n, vector(s[0], needed(n))));
                return null;
            case 'texcrd':
                store(ins, [...vector(s[0], 3), 0]);
                return null;
            case 'texdepth': {
                const reg = /** @type {Operand} */ (d);
                writeDepth(readRaw(reg, 0), readRaw(reg, 1));
                return null;
            }
            default:
                return fail(`instruction ${ins.name} is not implemented`);
        }
    };

    let i = 0;
    while (i < list.length)
    {
        const ins = list[i];
        if (ins.decl)
        {
            i++;
            continue;
        }
        const partner = list[i + 1];
        if (partner && partner.coissue)
        {
            // Both halves read the registers as they were before either wrote.
            const first = run(ins);
            const second = run(partner);
            if (first)
            {
                store(ins, first);
            }
            if (second)
            {
                store(partner, second);
            }
            i += 2;
            continue;
        }
        const res = run(ins);
        if (res)
        {
            store(ins, res);
        }
        i++;
    }

    const r0 = [0, 1, 2, 3].map(c=>tempsWritten[c] ? temps[c] : NaN);
    let r0Mask = 0;
    for (let c = 0; c < 4; c++)
    {
        r0Mask |= tempsWritten[c] << c;
    }
    /** @type {Record<string, number[]>} */
    const outputs = { oC0: r0 };
    /** @type {Record<string, number>} */
    const written = { oC0: r0Mask };
    if (depth !== null)
    {
        outputs.oDepth = [depth, NaN, NaN, NaN];
        written.oDepth = 1;
    }
    return { outputs, written, killed, instructionsExecuted: executed, semantics: {} };
}
