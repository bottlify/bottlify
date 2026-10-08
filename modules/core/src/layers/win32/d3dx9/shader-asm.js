/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Direct3D 9 shader assembly text to bytecode and back, for D3DXAssembleShader and
 * D3DXDisassembleShader.
 *
 * Both directions read one table, FORMS: an instruction's mnemonic, opcode, the kind of
 * destination and of each source, and the shader versions that have it. The token layout is
 * the documented one. An instruction token carries the opcode in bits 0 to 15, a control field
 * in 16 to 23 (the comparison of if/break/setp, the project and bias flags of texld), from
 * shader model 2 the count of tokens that follow in 24 to 27, the predicated flag in bit 28 and
 * the co-issue flag in bit 30. A parameter token has bit 31 set, the register number in bits 0
 * to 10, the register type split between bits 28 to 30 (low three) and 11 to 12 (high two) and
 * a relative-addressing flag in bit 13; a destination holds its write mask in 16 to 19, its
 * result modifiers in 20 to 23 and its shift scale in 24 to 27, a source its swizzle in 16 to
 * 23 and its source modifier in 24 to 27. A version token leads the stream, 0x0000FFFF ends it,
 * and a comment block (0xFFFE) carries data such as the constant table that no instruction
 * reads.
 */

const END_TOKEN = 0x0000ffff;
const PHASE_TOKEN = 0x0000fffd;
const COMMENT_OP = 0xfffe;
const CTAB_FOURCC = 0x42415443;
const OP_DCL = 31;
const OP_DEFB = 47;
const OP_DEFI = 48;
const OP_DEF = 81;
const OP_SUB = 3;
const OP_ADD = 2;
const IDENTITY = 0xe4;
/** The opcodes after which a listing indents, and those that bring it back (else does both). */
const BLOCK_OPEN = new Set([27, 38, 40, 41, 42]);
const BLOCK_CLOSE = new Set([29, 39, 42, 43]);

/** D3DSPR, the register types. */
const REG = Object.freeze({
    TEMP: 0, INPUT: 1, CONST: 2, ADDR: 3, TEXTURE: 3, RASTOUT: 4, ATTROUT: 5, OUTPUT: 6,
    CONSTINT: 7, COLOROUT: 8, DEPTHOUT: 9, SAMPLER: 10, CONST2: 11, CONST3: 12, CONST4: 13,
    CONSTBOOL: 14, LOOP: 15, TEMPFLOAT16: 16, MISC: 17, LABEL: 18, PREDICATE: 19,
});

/** D3DSPSM, the source modifiers. */
const MOD = Object.freeze({
    NONE: 0, NEG: 1, BIAS: 2, BIASNEG: 3, SIGN: 4, SIGNNEG: 5, COMP: 6, X2: 7, X2NEG: 8,
    DZ: 9, DW: 10, ABS: 11, ABSNEG: 12, NOT: 13,
});

/** The result-modifier bits of a destination token (D3DSPDM). */
const DM = Object.freeze({ SAT: 1 << 20, PP: 2 << 20, CENTROID: 4 << 20 });

/** D3DSPC, the comparison codes of if/break/setp. */
const COMPARISONS = ['', 'gt', 'eq', 'ge', 'lt', 'ne', 'le'];

/** D3DDECLUSAGE, in order. */
const USAGES = [
    'position', 'blendweight', 'blendindices', 'normal', 'psize', 'texcoord', 'tangent',
    'binormal', 'tessfactor', 'positiont', 'color', 'fog', 'depth', 'sample',
];

/** D3DSAMPLER_TEXTURE_TYPE, as the dcl names it, by the 4-bit field. */
const SAMPLER_TYPES = new Map([[2, '2d'], [3, 'cube'], [4, 'volume']]);

/** The destination shift scales: name and the signed 4-bit field. */
const SHIFTS = new Map([
    ['x2', 1], ['x4', 2], ['x8', 3], ['d8', 13], ['d4', 14], ['d2', 15],
]);
const SHIFT_NAMES = new Map([...SHIFTS].map(([name, field])=>[field, name]));

const F32 = new Float32Array(1);
const U32 = new Uint32Array(F32.buffer);

/* ------------------------------------------------------------------ versions */

/**
 * @typedef {Object} Version
 * @property {string} name     'vs_2_x'.
 * @property {boolean} vs
 * @property {number} major
 * @property {number} minor    As the token holds it; 0xff for the software models.
 * @property {boolean} sw
 * @property {number} vnum     What a form's version range compares: 11 for 1_1, 21 for 2_x and
 *                             2_sw, 30 for 3_0 and 3_sw.
 * @property {number} token
 */

/** @type {Map<string, Version>} */
const VERSION_BY_NAME = new Map();
/** @type {Map<number, Version>} */
const VERSION_BY_TOKEN = new Map();

for (const [stage, tails] of /** @type {[string, string[]][]} */ ([
    ['vs', ['1_0', '1_1', '2_0', '2_x', '2_sw', '3_0', '3_sw']],
    ['ps', ['1_0', '1_1', '1_2', '1_3', '1_4', '2_0', '2_x', '2_sw', '3_0', '3_sw']],
]))
{
    for (const tail of tails)
    {
        const [majorText, minorText] = tail.split('_');
        const major = Number(majorText);
        const sw = minorText === 'sw';
        const minor = sw ? 0xff : minorText === 'x' ? 1 : Number(minorText);
        const vnum = major === 1 ? 10 + minor : major === 2 ? 20 + (minor === 0 ? 0 : 1) : 30;
        const vs = stage === 'vs';
        const token = ((vs ? 0xfffe0000 : 0xffff0000) | (major << 8) | minor) >>> 0;
        const version = Object.freeze({
            name: `${stage}_${tail}`, vs, major, minor, sw, vnum, token,
        });
        VERSION_BY_NAME.set(version.name, version);
        VERSION_BY_TOKEN.set(token, version);
    }
}

/** @type {Map<string, Record<string, number>>} */
const LIMITS_CACHE = new Map();

/**
 * The register files, per class: how many registers the version has. A class that is absent
 * does not exist there. The numbers are the documented limits; the software models, which have
 * no hardware to fit, take the architectural ones.
 * @param {Version} v
 * @returns {Record<string, number>}
 */
function registerLimits(v){
    const cached = LIMITS_CACHE.get(v.name);
    if (cached)
    {
        return cached;
    }
    /** @type {Record<string, number>} */
    const lim = {};
    LIMITS_CACHE.set(v.name, lim);
    const flow = v.vnum >= 21 || (v.vs && v.major >= 2);
    if (v.vs)
    {
        lim.r = v.sw ? 4096 : v.vnum >= 21 ? 32 : 12;
        lim.v = 16;
        lim.c = v.sw ? 8192 : v.major >= 2 ? 256 : 96;
        lim.a = 1;
        if (v.major < 3)
        {
            Object.assign(lim, { oPos: 1, oFog: 1, oPts: 1, oD: 2, oT: 8 });
        }
        else
        {
            lim.o = 12;
            lim.s = 4;
        }
    }
    else
    {
        lim.r = v.sw ? 4096 : v.major === 3 || v.vnum === 21 ? 32 : v.vnum === 14 ? 6
            : v.major === 2 ? 12 : 2;
        lim.v = v.major === 3 ? 10 : 2;
        lim.c = v.sw ? 8192 : v.major === 1 ? 8 : v.vnum === 30 ? 224 : 32;
        if (v.major < 3)
        {
            lim.t = v.major === 2 ? 8 : v.vnum === 14 ? 6 : 4;
        }
        if (v.major >= 2)
        {
            lim.s = 16;
            lim.oC = 4;
            lim.oDepth = 1;
        }
        if (v.major === 3)
        {
            lim.vPos = 1;
            lim.vFace = 1;
        }
    }
    if (flow)
    {
        Object.assign(lim, { i: 16, b: 16, aL: 1, l: 2048 });
    }
    if (v.vnum >= 21)
    {
        lim.p = 1;
    }
    return lim;
}

/* ----------------------------------------------------------------- registers */

/**
 * The register classes by spelling: the type, the fixed number of the unnumbered ones.
 * @type {Record<string, { type: number, fixed?: number }>}
 */
const CLASSES = {
    r: { type: REG.TEMP }, v: { type: REG.INPUT }, c: { type: REG.CONST },
    a: { type: REG.ADDR }, t: { type: REG.TEXTURE }, i: { type: REG.CONSTINT },
    b: { type: REG.CONSTBOOL }, s: { type: REG.SAMPLER }, l: { type: REG.LABEL },
    p: { type: REG.PREDICATE }, oD: { type: REG.ATTROUT }, oT: { type: REG.OUTPUT },
    o: { type: REG.OUTPUT }, oC: { type: REG.COLOROUT },
    oPos: { type: REG.RASTOUT, fixed: 0 }, oFog: { type: REG.RASTOUT, fixed: 1 },
    oPts: { type: REG.RASTOUT, fixed: 2 }, oDepth: { type: REG.DEPTHOUT, fixed: 0 },
    aL: { type: REG.LOOP, fixed: 0 }, vPos: { type: REG.MISC, fixed: 0 },
    vFace: { type: REG.MISC, fixed: 1 },
};

/** The spelling of each class, lower-cased, for the case-insensitive lookup. */
const CLASS_BY_LOWER = new Map(Object.keys(CLASSES).map(name=>[name.toLowerCase(), name]));

/** The numbered classes that have exactly one register. */
const SINGLE = new Set(['a', 'p']);

/**
 * @typedef {Object} Reg
 * @property {string} cls   A key of CLASSES.
 * @property {number} num
 */

/**
 * @param {string} cls
 * @param {number} num
 * @returns {string}
 */
function registerText(cls, num){
    return 'fixed' in CLASSES[cls] ? cls : `${cls}${num}`;
}

/** @param {number} type */
function typeBits(type){
    return (((type & 7) << 28) | ((type & 0x18) << 8)) >>> 0;
}

/**
 * The type and number a register is written with in a token. The constants beyond c2047 live
 * in three further register types.
 * @param {Reg} reg
 * @returns {{ type: number, num: number }}
 */
function tokenRegister(reg){
    const info = CLASSES[reg.cls];
    if (reg.cls === 'c')
    {
        const bank = Math.min(reg.num >> 11, 3);
        return { type: bank === 0 ? REG.CONST : REG.CONST2 + bank - 1, num: reg.num & 0x7ff };
    }
    return { type: info.type, num: info.fixed ?? reg.num };
}

/**
 * The class a register type means in a given version: the type numbers alone do not say whether
 * 3 is a0 or t#, or 6 oT# or o#.
 * @param {number} type
 * @param {number} num
 * @param {Version} v
 * @returns {Reg}
 */
function registerOfToken(type, num, v){
    switch (type)
    {
        case REG.TEMP: return { cls: 'r', num };
        case REG.INPUT: return { cls: 'v', num };
        case REG.CONST: return { cls: 'c', num };
        case REG.ADDR: return { cls: v.vs ? 'a' : 't', num };
        case REG.RASTOUT:
            if (num > 2)
            {
                throw new Error(`invalid rasterizer output register ${num}`);
            }
            return { cls: ['oPos', 'oFog', 'oPts'][num], num };
        case REG.ATTROUT: return { cls: 'oD', num };
        case REG.OUTPUT: return { cls: v.major >= 3 ? 'o' : 'oT', num };
        case REG.CONSTINT: return { cls: 'i', num };
        case REG.COLOROUT: return { cls: 'oC', num };
        case REG.DEPTHOUT: return { cls: 'oDepth', num };
        case REG.SAMPLER: return { cls: 's', num };
        case REG.CONST2: case REG.CONST3: case REG.CONST4:
            return { cls: 'c', num: num + ((type - REG.CONST2 + 1) << 11) };
        case REG.CONSTBOOL: return { cls: 'b', num };
        case REG.LOOP: return { cls: 'aL', num };
        case REG.MISC:
            if (num > 1)
            {
                throw new Error(`invalid miscellaneous register ${num}`);
            }
            return { cls: num === 0 ? 'vPos' : 'vFace', num };
        case REG.LABEL: return { cls: 'l', num };
        case REG.PREDICATE: return { cls: 'p', num };
        default: throw new Error(`unsupported register type ${type}`);
    }
}

/* ------------------------------------------------------------------ the table */

/**
 * @typedef {Object} Form
 * @property {string} name     The mnemonic, without modifiers or a comparison.
 * @property {number} code     D3DSIO.
 * @property {string} dst      '' none; d general; T texture-stage destination; K texkill
 *                             destination; p predicate; A the address register.
 * @property {string[]} srcs   The kinds of sources, one string per accepted operand count:
 *                             f float; l label; i integer constant; b boolean constant or
 *                             predicate; p predicate; a loop counter; S sampler.
 * @property {number[] | null} vs   Lowest and highest vnum having the form, null where none.
 * @property {number[] | null} ps
 * @property {boolean} cmp     Takes a comparison suffix (the control field).
 * @property {number | null} ctl   A fixed control field (texldp is texld with 1).
 * @property {number} defMask  The write mask a bare destination means.
 */

const ANY = [10, 30];
const SM2 = [20, 30];
const SM2X = [21, 30];
const SM3 = [30, 30];
const PS14 = [14, 14];
const PS1_3 = [10, 13];

/**
 * The instruction set: name, opcode, destination, sources, vs versions, ps versions, extras.
 * @type {[string, number, string, string, number[] | null, number[] | null,
 *   { cmp?: boolean, ctl?: number, defMask?: number }?][]}
 */
const FORM_ROWS = [
    ['nop', 0, '', '', ANY, ANY],
    ['mov', 1, 'd', 'f', ANY, ANY],
    ['add', 2, 'd', 'ff', ANY, ANY],
    ['sub', 3, 'd', 'ff', ANY, ANY],
    ['mad', 4, 'd', 'fff', ANY, ANY],
    ['mul', 5, 'd', 'ff', ANY, ANY],
    ['rcp', 6, 'd', 'f', ANY, SM2],
    ['rsq', 7, 'd', 'f', ANY, SM2],
    ['dp3', 8, 'd', 'ff', ANY, ANY],
    ['dp4', 9, 'd', 'ff', ANY, [12, 30]],
    ['min', 10, 'd', 'ff', ANY, SM2],
    ['max', 11, 'd', 'ff', ANY, SM2],
    ['slt', 12, 'd', 'ff', ANY, SM2],
    ['sge', 13, 'd', 'ff', ANY, SM2],
    ['exp', 14, 'd', 'f', ANY, SM2],
    ['log', 15, 'd', 'f', ANY, SM2],
    ['lit', 16, 'd', 'f', ANY, null],
    ['dst', 17, 'd', 'ff', ANY, null],
    ['lrp', 18, 'd', 'fff', SM2, ANY],
    ['frc', 19, 'd', 'f', ANY, SM2],
    ['m4x4', 20, 'd', 'ff', ANY, SM2],
    ['m4x3', 21, 'd', 'ff', ANY, SM2],
    ['m3x4', 22, 'd', 'ff', ANY, SM2],
    ['m3x3', 23, 'd', 'ff', ANY, SM2],
    ['m3x2', 24, 'd', 'ff', ANY, SM2],
    ['call', 25, '', 'l', SM2, SM2X],
    ['callnz', 26, '', 'lb', SM2, SM2X],
    ['loop', 27, '', 'ai', SM2, SM2X],
    ['ret', 28, '', '', SM2, SM2X],
    ['endloop', 29, '', '', SM2, SM2X],
    ['label', 30, '', 'l', SM2, SM2X],
    ['pow', 32, 'd', 'ff', SM2, SM2],
    ['crs', 33, 'd', 'ff', SM2, SM2],
    ['sgn', 34, 'd', 'fff|f', SM2, null],
    ['abs', 35, 'd', 'f', SM2, SM2],
    ['nrm', 36, 'd', 'f', SM2, SM2],
    ['sincos', 37, 'd', 'fff', [20, 21], [20, 21]],
    ['sincos', 37, 'd', 'f', SM3, SM3],
    ['rep', 38, '', 'i', SM2, SM2X],
    ['endrep', 39, '', '', SM2, SM2X],
    ['if', 40, '', 'b', SM2, SM2X],
    ['if', 41, '', 'ff', SM2X, SM2X, { cmp: true }],
    ['else', 42, '', '', SM2, SM2X],
    ['endif', 43, '', '', SM2, SM2X],
    ['break', 44, '', '', SM2X, SM2X],
    ['break', 45, '', 'ff', SM2X, SM2X, { cmp: true }],
    ['mova', 46, 'A', 'f', SM2, null],
    ['texcoord', 64, 'T', '', null, PS1_3],
    ['texcrd', 64, 'T', 'f', null, PS14, { defMask: 7 }],
    ['texkill', 65, 'K', '', null, ANY],
    ['tex', 66, 'T', '', null, PS1_3],
    ['texld', 66, 'T', 'f', null, PS14],
    ['texld', 66, 'd', 'fS', null, SM2, { ctl: 0 }],
    ['texldp', 66, 'd', 'fS', null, SM2, { ctl: 1 }],
    ['texldb', 66, 'd', 'fS', null, SM2, { ctl: 2 }],
    ['texbem', 67, 'T', 'f', null, PS1_3],
    ['texbeml', 68, 'T', 'f', null, PS1_3],
    ['texreg2ar', 69, 'T', 'f', null, PS1_3],
    ['texreg2gb', 70, 'T', 'f', null, PS1_3],
    ['texm3x2pad', 71, 'T', 'f', null, PS1_3],
    ['texm3x2tex', 72, 'T', 'f', null, PS1_3],
    ['texm3x3pad', 73, 'T', 'f', null, PS1_3],
    ['texm3x3tex', 74, 'T', 'f', null, PS1_3],
    ['texm3x3spec', 76, 'T', 'ff', null, PS1_3],
    ['texm3x3vspec', 77, 'T', 'f', null, PS1_3],
    ['expp', 78, 'd', 'f', ANY, null],
    ['logp', 79, 'd', 'f', ANY, null],
    ['cnd', 80, 'd', 'fff', null, [10, 14]],
    ['texreg2rgb', 82, 'T', 'f', null, [12, 13]],
    ['texdp3tex', 83, 'T', 'f', null, [12, 13]],
    ['texm3x2depth', 84, 'T', 'f', null, [13, 13]],
    ['texdp3', 85, 'T', 'f', null, [12, 13]],
    ['texm3x3', 86, 'T', 'f', null, [12, 13]],
    ['texdepth', 87, 'd', '', null, PS14],
    ['cmp', 88, 'd', 'fff', null, [12, 30]],
    ['bem', 89, 'd', 'ff', null, PS14],
    ['dp2add', 90, 'd', 'fff', null, SM2],
    ['dsx', 91, 'd', 'f', null, SM2X],
    ['dsy', 92, 'd', 'f', null, SM2X],
    ['texldd', 93, 'd', 'fSff', null, SM2X],
    ['setp', 94, 'p', 'ff', SM2X, SM2X, { cmp: true }],
    ['texldl', 95, 'd', 'fS', SM3, SM3],
    ['breakp', 96, '', 'p', SM2X, SM2X],
];

/** @type {Form[]} */
const FORMS = FORM_ROWS.map(([name, code, dst, srcs, vs, ps, extra])=>Object.freeze({
    name, code, dst, srcs: srcs.split('|'), vs, ps,
    cmp: extra?.cmp ?? false, ctl: extra?.ctl ?? null, defMask: extra?.defMask ?? 0xf,
}));

/** @type {Map<string, Form[]>} */
const FORMS_BY_NAME = new Map();
/** @type {Map<number, Form[]>} */
const FORMS_BY_CODE = new Map();
for (const form of FORMS)
{
    for (const [map, key] of /** @type {[Map<any, Form[]>, string | number][]} */ ([
        [FORMS_BY_NAME, form.name], [FORMS_BY_CODE, form.code],
    ]))
    {
        const list = map.get(key);
        if (list)
        {
            list.push(form);
        }
        else
        {
            map.set(key, [form]);
        }
    }
}

/**
 * @param {Form} form
 * @param {Version} v
 */
function formInVersion(form, v){
    const range = v.vs ? form.vs : form.ps;
    return range !== null && v.vnum >= range[0] && v.vnum <= range[1];
}

/** The words after a mnemonic's underscore that are modifiers and not a comparison. */
const MODIFIER_NAMES = new Set(['sat', 'pp', 'centroid', ...SHIFTS.keys()]);

/* -------------------------------------------------------------------- errors */

class AsmError extends Error {}

/**
 * @param {string} message
 * @returns {AsmError}
 */
function fail(message){
    return new AsmError(message);
}

/* -------------------------------------------------------------------- literals */

/**
 * A float written in a def: decimal, with an optional exponent and an f suffix, or a hexadecimal
 * word that is the IEEE bits themselves.
 * @param {string} text
 * @returns {number} the bits
 */
function parseFloatBits(text){
    const s = text.trim();
    if (/^0x[0-9a-f]{1,8}$/i.test(s))
    {
        return Number.parseInt(s, 16) >>> 0;
    }
    if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?f?$/i.test(s))
    {
        throw fail(`bad number "${s}"`);
    }
    F32[0] = Number(s.replace(/f$/i, ''));
    return U32[0];
}

/**
 * @param {string} text
 * @returns {number} the 32-bit pattern
 */
function parseIntBits(text){
    const s = text.trim();
    let value;
    if (/^[-+]?\d+$/.test(s))
    {
        value = Number(s);
    }
    else if (/^0x[0-9a-f]{1,8}$/i.test(s))
    {
        value = Number.parseInt(s, 16);
    }
    else
    {
        throw fail(`bad integer "${s}"`);
    }
    if (value < -0x80000000 || value > 0xffffffff)
    {
        throw fail(`integer "${s}" does not fit in 32 bits`);
    }
    return value >>> 0;
}

/* ------------------------------------------------------------------- operands */

/**
 * Splits the operands at the commas that are not inside brackets.
 * @param {string} text
 * @returns {string[]}
 */
function splitOperands(text){
    if (text.trim() === '')
    {
        return [];
    }
    const out = [];
    let depth = 0;
    let cur = '';
    for (const ch of text)
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
            out.push(cur.trim());
            cur = '';
        }
        else
        {
            cur += ch;
        }
    }
    out.push(cur.trim());
    if (out.some(piece=>piece === ''))
    {
        throw fail('an operand is empty');
    }
    return out;
}

/**
 * A swizzle or write mask letter list as component indices: xyzw or rgba, not mixed.
 * @param {string} letters
 * @param {boolean} ordered   A write mask lists its components in order, once each.
 * @returns {number[]}
 */
function componentList(letters, ordered){
    const lower = letters.toLowerCase();
    const set = /^[xyzw]{1,4}$/.test(lower) ? 'xyzw' : /^[rgba]{1,4}$/.test(lower) ? 'rgba' : '';
    if (!set)
    {
        throw fail(`bad ${ordered ? 'write mask' : 'swizzle'} ".${letters}"`);
    }
    const comps = [...lower].map(ch=>set.indexOf(ch));
    if (ordered)
    {
        for (let k = 1; k < comps.length; k++)
        {
            if (comps[k] <= comps[k - 1])
            {
                throw fail(`write mask ".${letters}" must list its components in order`);
            }
        }
    }
    return comps;
}

/**
 * @param {string} letters
 * @returns {number} the 8-bit swizzle field
 */
function swizzleBits(letters){
    const comps = componentList(letters, false);
    while (comps.length < 4)
    {
        comps.push(comps[comps.length - 1]);
    }
    return comps.reduce((acc, c, k)=>acc | (c << (2 * k)), 0);
}

/**
 * @param {string} letters
 * @returns {number} the 4-bit write mask
 */
function maskBits(letters){
    return componentList(letters, true).reduce((acc, c)=>acc | (1 << c), 0);
}

/**
 * @typedef {Object} Operand
 * @property {string} cls
 * @property {number} num
 * @property {string} relName     'a0' or 'aL' for a register addressed relatively, else ''.
 * @property {number} relComp     The component of a0 that addresses it: x in vs_1_1, any from
 *                                vs_2_0, whose address register has four.
 * @property {string} swizzle     The letters after the dot, '' for none.
 * @property {string} suffix      The modifier written after the register, '' for none.
 * @property {string} indexText   What was between the brackets, '' if no brackets.
 */

const OPERAND_PATTERN = /^([a-z]+)(\d*)\s*(?:\[([^\]]*)\])?(?:_([a-z0-9]+))?(?:\.([a-z]+))?$/i;

/**
 * Reads a register with its optional relative index, modifier suffix and swizzle.
 * @param {string} text
 * @param {Version} v
 * @returns {Operand}
 */
function parseOperand(text, v){
    const m = OPERAND_PATTERN.exec(text.trim());
    if (!m)
    {
        throw fail(`bad operand "${text}"`);
    }
    const cls = CLASS_BY_LOWER.get(m[1].toLowerCase());
    if (cls === undefined)
    {
        throw fail(`unknown register "${m[1]}${m[2]}"`);
    }
    const fixed = 'fixed' in CLASSES[cls];
    if (fixed ? m[2] !== '' : m[2] === '' && m[3] === undefined)
    {
        throw fail(`bad register "${m[1]}${m[2]}"`);
    }
    if (m[2].length > 5)
    {
        throw fail(`register number "${m[2]}" is too large`);
    }
    let num = m[2] === '' ? 0 : Number(m[2]);
    if (SINGLE.has(cls) && num !== 0 && m[3] === undefined)
    {
        throw fail(`there is only ${cls}0, not ${cls}${num}`);
    }
    let relName = '';
    let relComp = 0;
    if (m[3] !== undefined)
    {
        if (!['c', 'v', 'o'].includes(cls))
        {
            throw fail(`${cls} cannot be addressed relatively`);
        }
        const rel = parseRelativeIndex(m[3], v);
        relName = rel.name;
        relComp = rel.comp;
        if (rel.offset !== null)
        {
            if (m[2] !== '')
            {
                throw fail('give the register offset either before the bracket or inside it');
            }
            num = rel.offset;
        }
    }
    return {
        cls, num, relName, relComp, swizzle: m[5] ?? '', suffix: (m[4] ?? '').toLowerCase(),
        indexText: m[3] ?? '',
    };
}

/**
 * The inside of the brackets of a relative address: a component of a0 or aL, plus an
 * optional constant.
 * @param {string} text
 * @param {Version} v
 * @returns {{ name: string, offset: number | null, comp: number }}
 */
function parseRelativeIndex(text, v){
    let name = '';
    let offset = null;
    let comp = 0;
    for (const raw of text.split('+'))
    {
        const term = raw.trim();
        if (/^\d+$/.test(term))
        {
            if (offset !== null)
            {
                throw fail(`bad relative index "[${text}]"`);
            }
            offset = Number(term);
        }
        else if (/^a0\.[xyzwrgba]$/i.test(term) || /^al$/i.test(term))
        {
            if (name !== '')
            {
                throw fail(`a relative index takes one address register, not "[${text}]"`);
            }
            name = /^al$/i.test(term) ? 'aL' : 'a0';
            comp = name === 'a0' ? 'xyzwrgba'.indexOf(term[3].toLowerCase()) & 3 : 0;
        }
        else if (/^a0$/i.test(term))
        {
            throw fail('the address register is addressed as a0.x');
        }
        else
        {
            throw fail(`bad relative index "[${text}]"`);
        }
    }
    if (name === '')
    {
        throw fail(`bad relative index "[${text}]"`);
    }
    if (name === 'a0' && !v.vs)
    {
        throw fail('a pixel shader has no address register a0');
    }
    if (name === 'a0' && v.major < 2 && comp !== 0)
    {
        throw fail(`${v.name} addresses relatively through a0.x only`);
    }
    if (name === 'aL' && v.major < 2)
    {
        throw fail(`${v.name} has no loop counter aL`);
    }
    return { name, offset, comp };
}

/**
 * Checks a register exists in the version and is in range.
 * @param {Reg} reg
 * @param {Version} v
 */
function checkRegister(reg, v){
    const limit = registerLimits(v)[reg.cls];
    const shown = registerText(reg.cls, reg.num);
    if (limit === undefined)
    {
        throw fail(`register ${shown} is not available in ${v.name}`);
    }
    if (reg.num >= limit && !('fixed' in CLASSES[reg.cls]))
    {
        throw fail(`register ${shown} is out of range for ${v.name} (it has ${limit} of them)`);
    }
}

/**
 * The source classes a float operand may name.
 * @param {Version} v
 * @returns {string[]}
 */
function floatSourceClasses(v){
    return v.vs ? ['r', 'v', 'c', 'aL'] : ['r', 'v', 'c', 't', 'vPos', 'vFace', 'aL'];
}

/**
 * The source modifiers a version knows.
 * @param {Version} v
 * @returns {Set<number>}
 */
function allowedModifiers(v){
    if (v.major >= 2)
    {
        const abs = v.vs || v.major === 3 ? [MOD.ABS, MOD.ABSNEG] : [];
        return new Set([MOD.NONE, MOD.NEG, MOD.NOT, ...abs]);
    }
    if (v.vs)
    {
        return new Set([MOD.NONE, MOD.NEG]);
    }
    const base = [MOD.NONE, MOD.NEG, MOD.BIAS, MOD.BIASNEG, MOD.SIGN, MOD.SIGNNEG, MOD.COMP];
    return new Set(v.vnum === 14 ? [...base, MOD.X2, MOD.X2NEG, MOD.DZ, MOD.DW] : base);
}

/**
 * The tokens of one source operand.
 * @param {string} text
 * @param {string} kind   A letter of Form.srcs.
 * @param {Version} v
 * @param {{ negate?: boolean }} [options]   Fold a sign into the operand (sub in a vs).
 * @returns {number[]}
 */
function assembleSource(text, kind, v, options = {}){
    let s = text.trim();
    let prefix = '';
    if (/^1\s*-/.test(s))
    {
        prefix = '1-';
        s = s.replace(/^1\s*-\s*/, '');
    }
    else if (s[0] === '-' || s[0] === '!')
    {
        prefix = s[0];
        s = s.slice(1).trim();
    }
    let bars = false;
    if (s[0] === '|')
    {
        if (s.length < 3 || !s.endsWith('|'))
        {
            throw fail(`bad operand "${text}"`);
        }
        bars = true;
        s = s.slice(1, -1).trim();
    }
    const operand = parseOperand(s, v);
    const swizzle = operand.swizzle === '' ? IDENTITY : swizzleBits(operand.swizzle);
    const negated = prefix === '-';
    /** @type {number} */
    let modifier = negated ? MOD.NEG : MOD.NONE;
    const suffix = bars ? 'abs' : operand.suffix;
    if (prefix === '1-')
    {
        modifier = MOD.COMP;
    }
    else if (prefix === '!')
    {
        modifier = MOD.NOT;
    }
    if (suffix !== '')
    {
        /** @type {Record<string, number[]>} */
        const pairs = {
            bias: [MOD.BIAS, MOD.BIASNEG], bx2: [MOD.SIGN, MOD.SIGNNEG],
            x2: [MOD.X2, MOD.X2NEG], abs: [MOD.ABS, MOD.ABSNEG],
            dz: [MOD.DZ, -1], dw: [MOD.DW, -1],
        };
        const pair = Object.hasOwn(pairs, suffix) ? pairs[suffix] : undefined;
        if (!pair)
        {
            throw fail(`unknown source modifier "_${suffix}"`);
        }
        if (prefix === '1-' || prefix === '!' || pair[negated ? 1 : 0] < 0)
        {
            throw fail(`"${text.trim()}" combines modifiers that have no encoding`);
        }
        modifier = pair[negated ? 1 : 0];
    }
    if (!allowedModifiers(v).has(modifier))
    {
        throw fail(`this source modifier is not available in ${v.name}`);
    }
    if (options.negate)
    {
        modifier = negateModifier(modifier);
    }
    return sourceTokens(operand, kind, swizzle, modifier, v);
}

/**
 * sub a, b becomes add a, -b in a vertex shader; a sign already there folds away.
 * @param {number} modifier
 */
function negateModifier(modifier){
    switch (modifier)
    {
        case MOD.NONE: return MOD.NEG;
        case MOD.NEG: return MOD.NONE;
        case MOD.ABS: return MOD.ABSNEG;
        case MOD.ABSNEG: return MOD.ABS;
        default: throw fail('sub cannot negate this source modifier');
    }
}

/**
 * @param {Operand} operand
 * @param {string} kind
 * @param {number} swizzle
 * @param {number} modifier
 * @param {Version} v
 * @returns {number[]}
 */
function sourceTokens(operand, kind, swizzle, modifier, v){
    const { cls } = operand;
    /** @type {Record<string, string[]>} */
    const classesOf = {
        f: floatSourceClasses(v), l: ['l'], i: ['i'], b: ['b', 'p'], p: ['p'], a: ['aL'],
        S: ['s'],
    };
    const allowed = classesOf[kind];
    if (!allowed.includes(cls))
    {
        throw fail(`${registerText(cls, operand.num)} cannot be used as this operand`);
    }
    const boolean = kind === 'b' || kind === 'p';
    if (modifier === MOD.NOT ? !boolean : (kind !== 'f' && modifier !== MOD.NONE))
    {
        throw fail(boolean ? 'bad modifier on a boolean register'
            : '! applies to a boolean or predicate register');
    }
    if (kind === 'S' && swizzle !== IDENTITY)
    {
        throw fail('a sampler takes no swizzle');
    }
    checkRegister(operand, v);
    return [...registerTokens(operand, v, swizzle << 16 | modifier << 24)];
}

/**
 * A register parameter's token and, from model 2 on, the token of its relative address.
 * @param {Operand} operand
 * @param {Version} v
 * @param {number} bits   Everything above the register: swizzle and modifier, or mask and more.
 * @returns {number[]}
 */
function registerTokens(operand, v, bits){
    const { type, num } = tokenRegister(operand);
    let token = (0x80000000 | typeBits(type) | num | bits) >>> 0;
    /** @type {number[]} */
    const extra = [];
    if (operand.relName !== '')
    {
        const relOk = operand.cls === 'c' ? v.vs || v.major === 3
            : operand.cls === 'v' ? v.major === 3 : v.vs && v.major === 3;
        if (!relOk)
        {
            throw fail(`${operand.cls} cannot be addressed by ${operand.relName} in ${v.name}`);
        }
        token = (token | (1 << 13)) >>> 0;
        if (v.major >= 2)
        {
            // The relative token's swizzle replicates the component of a0 it reads.
            extra.push(operand.relName === 'aL' ? 0xf0e40800
                : (0xb0000000 | operand.relComp * 0x55 << 16) >>> 0);
        }
        else if (operand.relName !== 'a0')
        {
            throw fail(`${v.name} addresses relatively through a0.x only`);
        }
    }
    return [token, ...extra];
}

/**
 * @typedef {Object} Modifiers
 * @property {number} shift   The 4-bit field.
 * @property {boolean} sat
 * @property {boolean} pp
 * @property {boolean} centroid
 */

/**
 * The destination classes of each destination kind.
 * @param {string} kind
 * @param {Version} v
 * @returns {string[]}
 */
function destinationClasses(kind, v){
    switch (kind)
    {
        case 'p': return ['p'];
        case 'A': return ['a'];
        case 'K': return v.vnum >= 14 ? ['t', 'r'] : ['t'];
        case 'T': return v.vnum === 14 ? ['r'] : ['t'];
        default:
            if (v.vs)
            {
                return v.major >= 3 ? ['r', 'a', 'o']
                    : ['r', 'a', 'oPos', 'oFog', 'oPts', 'oD', 'oT'];
            }
            return v.major === 1 ? ['r'] : ['r', 'oC', 'oDepth'];
    }
}

/**
 * The token of a destination.
 * @param {string} text
 * @param {string} kind    A destination kind of Form.dst, or 'dcl' to allow what a dcl names.
 * @param {Version} v
 * @param {Modifiers} mods
 * @param {number} defMask
 * @returns {number[]}
 */
function assembleDestination(text, kind, v, mods, defMask){
    const operand = parseOperand(text, v);
    if (operand.suffix !== '')
    {
        throw fail(`bad destination "${text}"`);
    }
    if (kind !== 'dcl' && !destinationClasses(kind, v).includes(operand.cls))
    {
        throw fail(`${registerText(operand.cls, operand.num)} cannot be written here`);
    }
    checkRegister(operand, v);
    const mask = operand.swizzle === '' ? defMask : maskBits(operand.swizzle);
    if (operand.cls === 'a' && mask !== 1 && v.major < 2)
    {
        throw fail(`the address register is written as a0.x in ${v.name}`);
    }
    let bits = mask << 16;
    bits |= mods.shift << 24;
    bits |= (mods.sat ? DM.SAT : 0) | (mods.pp ? DM.PP : 0) | (mods.centroid ? DM.CENTROID : 0);
    return registerTokens(operand, v, bits);
}

/* ----------------------------------------------------------------- assembling */

/**
 * The text of each line with its comments cut, one entry per source line.
 * @param {string} text
 * @returns {string[]}
 */
function cleanLines(text){
    const out = [];
    let inBlock = false;
    for (const raw of text.split(/\r\n|\n|\r/))
    {
        let line = '';
        let i = 0;
        while (i < raw.length)
        {
            if (inBlock)
            {
                const end = raw.indexOf('*/', i);
                if (end < 0)
                {
                    i = raw.length;
                }
                else
                {
                    inBlock = false;
                    i = end + 2;
                    line += ' ';
                }
            }
            else if (raw[i] === ';' || (raw[i] === '/' && raw[i + 1] === '/'))
            {
                break;
            }
            else if (raw[i] === '/' && raw[i + 1] === '*')
            {
                inBlock = true;
                i += 2;
            }
            else
            {
                line += raw[i++];
            }
        }
        out.push(line.trim());
    }
    return out;
}

/**
 * @param {string} line
 * @returns {Version}
 */
function parseVersionLine(line){
    const m = /^(vs|ps)[_.](\d)[_.](\d|x|sw)$/i.exec(line);
    const version = m && VERSION_BY_NAME.get(`${m[1]}_${m[2]}_${m[3]}`.toLowerCase());
    if (!version)
    {
        throw fail('the first statement must be a shader version such as vs_1_1 or ps_2_0');
    }
    return version;
}

/**
 * The instruction word broken into its form and modifiers.
 * @param {string} word
 * @param {Version} v
 * @returns {{ form: Form, mods: Modifiers, control: number }}
 */
function resolveMnemonic(word, v){
    const parts = word.toLowerCase().split('_');
    const candidates = FORMS_BY_NAME.get(parts[0]);
    if (!candidates)
    {
        throw fail(`unknown instruction "${word}"`);
    }
    /** @type {Modifiers} */
    const mods = { shift: 0, sat: false, pp: false, centroid: false };
    let cc = 0;
    for (const part of parts.slice(1))
    {
        const compare = COMPARISONS.indexOf(part);
        if (MODIFIER_NAMES.has(part))
        {
            applyModifier(part, mods, v, word);
        }
        else if (compare > 0 && cc === 0)
        {
            cc = compare;
        }
        else
        {
            throw fail(`unknown instruction "${word}"`);
        }
    }
    const matching = candidates.filter(f=>f.cmp === (cc !== 0));
    if (matching.length === 0)
    {
        throw fail(cc ? `${parts[0]} takes no comparison` : `${parts[0]} needs a comparison`);
    }
    const form = matching.find(f=>formInVersion(f, v));
    if (!form)
    {
        throw fail(`${parts[0]} is not available in ${v.name}`);
    }
    if (form.dst === '' && (mods.sat || mods.pp || mods.centroid || mods.shift))
    {
        throw fail(`${word} has no destination to modify`);
    }
    return { form, mods, control: form.ctl ?? cc };
}

/**
 * @param {string} part
 * @param {Modifiers} mods
 * @param {Version} v
 * @param {string} word
 */
function applyModifier(part, mods, v, word){
    const shift = SHIFTS.get(part);
    if (shift !== undefined)
    {
        const wide = part === 'x8' || part === 'd4' || part === 'd8';
        if (v.vs || v.major !== 1 || (wide && v.vnum !== 14) || mods.shift)
        {
            throw fail(`"_${part}" is not available here: "${word}"`);
        }
        mods.shift = shift;
    }
    else if (part === 'sat')
    {
        if (v.vs && v.major < 2)
        {
            throw fail(`_sat is not available in ${v.name}`);
        }
        mods.sat = true;
    }
    else
    {
        if (v.major < 2)
        {
            throw fail(`_${part} is not available in ${v.name}`);
        }
        mods[/** @type {'pp' | 'centroid'} */ (part)] = true;
    }
}

/**
 * Which dcl registers a version has: the classes, and whether they take a semantic.
 * @param {Version} v
 * @returns {string[]}
 */
function dclClasses(v){
    if (v.vs)
    {
        return v.major === 3 ? ['v', 'o', 's'] : ['v'];
    }
    return v.major === 3 ? ['v', 's', 'vPos', 'vFace'] : v.major === 2 ? ['v', 't', 's'] : [];
}

/**
 * dcl_usage[N] register, dcl_2d s0, dcl t0, dcl vFace.
 * @param {string} word
 * @param {string[]} operands
 * @param {Version} v
 * @returns {number[]}
 */
function assembleDcl(word, operands, v){
    if (v.major < 2 && !(v.vs && v.major === 1))
    {
        throw fail(`dcl is not available in ${v.name}`);
    }
    const parts = word.toLowerCase().split('_').slice(1);
    /** @type {Modifiers} */
    const mods = { shift: 0, sat: false, pp: false, centroid: false };
    const kinds = [];
    for (const part of parts)
    {
        if (part === 'pp' || part === 'centroid')
        {
            if (v.major < 2)
            {
                throw fail(`_${part} is not available in ${v.name}`);
            }
            mods[part] = true;
        }
        else
        {
            kinds.push(part);
        }
    }
    if (kinds.length > 1)
    {
        throw fail(`bad declaration "${word}"`);
    }
    if (operands.length !== 1)
    {
        throw fail('dcl takes one register');
    }
    const operand = parseOperand(operands[0], v);
    if (!dclClasses(v).includes(operand.cls) || operand.relName !== '' || operand.suffix !== '')
    {
        throw fail(`${operands[0]} cannot be declared in ${v.name}`);
    }
    const kind = kinds[0] ?? '';
    let usageToken = 0x80000000;
    const typeNames = [...SAMPLER_TYPES.values()];
    if (operand.cls === 's')
    {
        if (!typeNames.includes(kind))
        {
            throw fail('a sampler is declared as dcl_2d, dcl_cube or dcl_volume');
        }
        usageToken |= (typeNames.indexOf(kind) + 2) << 27;
    }
    else if (kind !== '')
    {
        const m = /^([a-z]+?)(\d*)$/.exec(kind);
        const usage = m ? USAGES.indexOf(m[1]) : -1;
        const index = m && m[2] !== '' ? Number(m[2]) : 0;
        if (usage < 0 || index > 15)
        {
            throw fail(`unknown declaration usage "${kind}"`);
        }
        if (operand.cls === 'vPos' || operand.cls === 'vFace')
        {
            throw fail(`${operands[0]} takes no usage`);
        }
        usageToken |= usage | (index << 16);
    }
    else if (!(operand.cls === 'vPos' || operand.cls === 'vFace'
        || (!v.vs && v.major === 2 && (operand.cls === 'v' || operand.cls === 't'))))
    {
        throw fail(`dcl of ${operands[0]} needs a usage such as dcl_position`);
    }
    const dest = assembleDestination(operands[0], 'dcl', v, mods, 0xf);
    return [usageToken >>> 0, ...dest];
}

/**
 * def, defi, defb.
 * @param {string} word
 * @param {string[]} operands
 * @param {Version} v
 * @returns {number[]}
 */
function assembleDefinition(word, operands, v){
    const cls = word === 'def' ? 'c' : word === 'defi' ? 'i' : 'b';
    const count = word === 'defb' ? 1 : 4;
    if ((word !== 'def') && !(registerLimits(v)[cls]))
    {
        throw fail(`${word} is not available in ${v.name}`);
    }
    if (operands.length !== count + 1)
    {
        throw fail(`${word} takes a register and ${count} value${count > 1 ? 's' : ''}`);
    }
    const operand = parseOperand(operands[0], v);
    if (operand.cls !== cls || operand.swizzle !== '' || operand.relName !== ''
        || operand.suffix !== '')
    {
        throw fail(`${word} defines a ${cls}# register, not "${operands[0]}"`);
    }
    checkRegister(operand, v);
    const dest = registerTokens(operand, v, 0xf << 16);
    const values = operands.slice(1).map(text=>{
        if (word === 'def')
        {
            return parseFloatBits(text);
        }
        const lower = text.toLowerCase();
        if (word === 'defb' && (lower === 'true' || lower === 'false'))
        {
            return lower === 'true' ? 1 : 0;
        }
        return parseIntBits(text);
    });
    return [...dest, ...values];
}

/**
 * The predicate in front of an instruction, as a source token.
 * @param {string} text   What is inside the parentheses.
 * @param {Version} v
 * @returns {number}
 */
function assemblePredicate(text, v){
    const m = /^(!?)\s*p0(?:\.([a-z]{1,4}))?$/i.exec(text.trim());
    if (!m)
    {
        throw fail(`bad predicate "(${text})"`);
    }
    if (v.vnum < 21)
    {
        throw fail(`predication is not available in ${v.name}`);
    }
    const swizzle = m[2] === undefined ? IDENTITY : swizzleBits(m[2]);
    const modifier = m[1] === '!' ? MOD.NOT : MOD.NONE;
    return (0x80000000 | typeBits(REG.PREDICATE) | (swizzle << 16) | (modifier << 24)) >>> 0;
}

/**
 * One statement after the version.
 * @param {string} line
 * @param {Version} v
 * @param {{ count: number }} state
 * @returns {number[]}
 */
function assembleStatement(line, v, state){
    let s = line;
    let coissue = false;
    if (s[0] === '+')
    {
        if (v.vs || v.major !== 1)
        {
            throw fail(`co-issue is not available in ${v.name}`);
        }
        if (state.count === 1)
        {
            throw fail('the first instruction cannot be co-issued');
        }
        coissue = true;
        s = s.slice(1).trim();
    }
    let predicate = 0;
    if (s[0] === '(')
    {
        const close = s.indexOf(')');
        if (close < 0)
        {
            throw fail('unterminated predicate');
        }
        predicate = assemblePredicate(s.slice(1, close), v);
        s = s.slice(close + 1).trim();
    }
    const head = /^[a-z][a-z0-9_]*/i.exec(s);
    if (!head)
    {
        throw fail(`unknown instruction "${s.split(/\s/)[0]}"`);
    }
    const word = head[0];
    const rest = s.slice(word.length);
    if (rest !== '' && !/^\s/.test(rest))
    {
        throw fail(`unknown instruction "${s.split(/\s/)[0]}"`);
    }
    const operands = splitOperands(rest);
    const base = word.toLowerCase();
    const lengthField = (/** @type {number} */ count)=>{
        if (count > 15)
        {
            throw fail('the instruction is too long');
        }
        return v.major >= 2 ? count << 24 : 0;
    };
    if (base === 'phase')
    {
        if (v.vnum !== 14)
        {
            throw fail(`phase is not available in ${v.name}`);
        }
        if (operands.length || coissue || predicate)
        {
            throw fail('phase takes no operands and cannot be co-issued');
        }
        return [PHASE_TOKEN];
    }
    const declaring = base.startsWith('dcl') || base === 'def' || base === 'defi'
        || base === 'defb';
    if (declaring && (coissue || predicate))
    {
        throw fail(`${base} cannot be ${coissue ? 'co-issued' : 'predicated'}`);
    }
    if (base === 'dcl' || base.startsWith('dcl_'))
    {
        const body = assembleDcl(word, operands, v);
        return [(OP_DCL | lengthField(body.length)) >>> 0, ...body];
    }
    if (base === 'def' || base === 'defi' || base === 'defb')
    {
        const body = assembleDefinition(base, operands, v);
        const code = base === 'def' ? OP_DEF : base === 'defi' ? OP_DEFI : OP_DEFB;
        return [(code | lengthField(body.length)) >>> 0, ...body];
    }
    const { form, mods, control } = resolveMnemonic(word, v);
    const body = assembleOperands(form, mods, operands, predicate, v);
    let code = form.code;
    if (code === OP_SUB && v.vs)
    {
        code = OP_ADD;
    }
    const token = code | (control << 16) | lengthField(body.length) | (predicate ? 1 << 28 : 0)
        | (coissue ? 1 << 30 : 0);
    return [token >>> 0, ...body];
}

/**
 * The destination, predicate and sources of one instruction.
 * @param {Form} form
 * @param {Modifiers} mods
 * @param {string[]} operands
 * @param {number} predicate   The predicate token, 0 for none.
 * @param {Version} v
 * @returns {number[]}
 */
function assembleOperands(form, mods, operands, predicate, v){
    const want = (form.dst === '' ? 0 : 1);
    const kinds = form.srcs.find(k=>k.length + want === operands.length);
    if (kinds === undefined)
    {
        const counts = form.srcs.map(k=>k.length + want).join(' or ');
        throw fail(`${form.name} takes ${counts} operand${counts === '1' ? '' : 's'}, `
            + `not ${operands.length}`);
    }
    /** @type {number[]} */
    const out = [];
    if (form.dst !== '')
    {
        out.push(...assembleDestination(operands[0], form.dst, v, mods, form.defMask));
    }
    if (predicate)
    {
        out.push(predicate);
    }
    const flip = form.code === OP_SUB && v.vs;
    for (let k = 0; k < kinds.length; k++)
    {
        out.push(...assembleSource(operands[k + want], kinds[k], v,
            { negate: flip && k === 1 }));
    }
    return out;
}

/**
 * Turns shader assembly text into bytecode.
 *
 * The first statement is the version (`vs_1_1`, `ps_2_0`, `ps_3_sw`). Comments run from `;` or
 * `//` to the end of the line, or between slash-star and star-slash. Every error is reported
 * with its 1-based line and the assembly goes on with the next line; with any error `tokens` is
 * null.
 *
 * @param {string} text
 * @returns {{ tokens: Uint32Array | null, errors: { line: number, message: string }[] }}
 */
export function assembleShader(text){
    /** @type {{ line: number, message: string }[]} */
    const errors = [];
    /** @type {number[]} */
    const out = [];
    /** @type {Version | null} */
    let version = null;
    const state = { count: 0 };
    const lines = cleanLines(String(text));
    for (let k = 0; k < lines.length; k++)
    {
        const line = lines[k];
        if (line === '')
        {
            continue;
        }
        try
        {
            if (!version)
            {
                version = parseVersionLine(line);
                // D3DX writes a vs_1_0 or ps_1_0 source as 1_1: only bytecode that
                // came from a Direct3D 8 program carries the older version.
                out.push(version.major === 1 && version.minor === 0 ? version.token + 1
                    : version.token);
            }
            else if (/^(vs|ps)[_.]\d[_.](\d|x|sw)$/i.test(line))
            {
                throw fail('the version can be given only once, as the first statement');
            }
            else
            {
                state.count++;
                out.push(...assembleStatement(line, version, state));
            }
        }
        catch (e){
            const message = e instanceof Error ? e.message : String(e);
            errors.push({ line: k + 1, message });
            if (!version)
            {
                return { tokens: null, errors };
            }
        }
    }
    if (!version && errors.length === 0)
    {
        errors.push({ line: 1, message: 'no shader version' });
    }
    if (errors.length)
    {
        return { tokens: null, errors };
    }
    out.push(END_TOKEN);
    return { tokens: Uint32Array.from(out), errors };
}

/* --------------------------------------------------------------- disassembling */

/**
 * @typedef {Object} Param
 * @property {Reg} reg
 * @property {number} mask       A destination's write mask.
 * @property {number} resultMod  A destination's result modifiers, bits 20 to 23.
 * @property {number} shift
 * @property {number} swizzle
 * @property {number} modifier
 * @property {{ cls: string, swizzle: number } | null} rel
 * @property {number} next       The position after the parameter and its relative token.
 */

/**
 * @param {ArrayLike<number>} tokens
 * @param {number} pos
 * @param {number} end    One past the last token the instruction may use.
 * @param {Version} v
 * @returns {Param}
 */
function readParam(tokens, pos, end, v){
    if (pos >= end)
    {
        throw new Error('instruction is shorter than its operands');
    }
    const token = tokens[pos] >>> 0;
    if (token >>> 31 === 0)
    {
        throw new Error(`token ${pos} (0x${token.toString(16)}) is not a parameter token`);
    }
    const type = ((token >>> 28) & 7) | (((token >>> 11) & 3) << 3);
    const reg = registerOfToken(type, token & 0x7ff, v);
    let next = pos + 1;
    let rel = null;
    if ((token >>> 13) & 1)
    {
        if (v.major >= 2)
        {
            if (next >= end)
            {
                throw new Error('instruction is shorter than its operands');
            }
            const relToken = tokens[next++] >>> 0;
            const relType = ((relToken >>> 28) & 7) | (((relToken >>> 11) & 3) << 3);
            rel = {
                cls: registerOfToken(relType, relToken & 0x7ff, v).cls,
                swizzle: (relToken >>> 16) & 0xff,
            };
            if (rel.cls !== 'a' && rel.cls !== 'aL')
            {
                throw new Error('relative addressing through a register that is not a0 or aL');
            }
        }
        else
        {
            rel = { cls: 'a', swizzle: 0 };
        }
    }
    return {
        reg, rel, next,
        mask: (token >>> 16) & 0xf, resultMod: (token >>> 20) & 0xf,
        shift: (token >>> 24) & 0xf, swizzle: (token >>> 16) & 0xff,
        modifier: (token >>> 24) & 0xf,
    };
}

/**
 * @param {Reg} reg
 * @param {Param['rel']} rel
 */
function regName(reg, rel){
    if (!rel)
    {
        return registerText(reg.cls, reg.num);
    }
    const component = rel.cls === 'a' ? `.${'xyzw'[rel.swizzle & 3]}` : '';
    return `${reg.cls}${reg.num}[${rel.cls === 'a' ? 'a0' : 'aL'}${component}]`;
}

/** @param {number} swizzle */
function swizzleText(swizzle){
    if (swizzle === IDENTITY)
    {
        return '';
    }
    const comps = [0, 1, 2, 3].map(k=>(swizzle >> (2 * k)) & 3);
    while (comps.length > 1 && comps[comps.length - 1] === comps[comps.length - 2])
    {
        comps.pop();
    }
    return `.${comps.map(c=>'xyzw'[c]).join('')}`;
}

/** @param {number} mask */
function maskText(mask){
    let out = '.';
    for (let k = 0; k < 4; k++)
    {
        if (mask & (1 << k))
        {
            out += 'xyzw'[k];
        }
    }
    return out;
}

/**
 * @param {Param} p
 * @returns {string}
 */
function sourceText(p){
    const name = regName(p.reg, p.rel);
    const swz = swizzleText(p.swizzle);
    switch (p.modifier)
    {
        case MOD.NONE: return name + swz;
        case MOD.NEG: return `-${name}${swz}`;
        case MOD.BIAS: return `${name}_bias${swz}`;
        case MOD.BIASNEG: return `-${name}_bias${swz}`;
        case MOD.SIGN: return `${name}_bx2${swz}`;
        case MOD.SIGNNEG: return `-${name}_bx2${swz}`;
        case MOD.COMP: return `1-${name}${swz}`;
        case MOD.X2: return `${name}_x2${swz}`;
        case MOD.X2NEG: return `-${name}_x2${swz}`;
        case MOD.DZ: return `${name}_dz${swz}`;
        case MOD.DW: return `${name}_dw${swz}`;
        case MOD.ABS: return `${name}_abs${swz}`;
        case MOD.ABSNEG: return `-${name}_abs${swz}`;
        case MOD.NOT: return `!${name}${swz}`;
        default: throw new Error(`invalid source modifier ${p.modifier}`);
    }
}

/**
 * The shortest decimal that is the float exactly, at the nine significant digits a float needs.
 * @param {number} bits
 * @returns {string}
 */
function floatText(bits){
    U32[0] = bits;
    const x = F32[0];
    if (!Number.isFinite(x))
    {
        return `0x${bits.toString(16).padStart(8, '0')}`;
    }
    if (x === 0)
    {
        return Object.is(x, -0) ? '-0' : '0';
    }
    const [mantissa, exponentText] = x.toExponential(8).split('e');
    const exponent = Number(exponentText);
    if (exponent < -4 || exponent >= 9)
    {
        const trimmed = mantissa.replace(/\.?0+$/, '');
        const digits = String(Math.abs(exponent)).padStart(3, '0');
        return `${trimmed}e${exponent < 0 ? '-' : '+'}${digits}`;
    }
    const fixed = x.toPrecision(9);
    return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
}

/**
 * @param {Form} form
 * @param {number} control
 * @returns {string}
 */
function mnemonicText(form, control){
    if (!form.cmp)
    {
        return form.name;
    }
    if (control < 1 || control > 6)
    {
        throw new Error(`${form.name} has the invalid comparison ${control}`);
    }
    return `${form.name}_${COMPARISONS[control]}`;
}

/**
 * Picks the form an opcode means in this version.
 * @param {number} code
 * @param {number} control
 * @param {Version} v
 * @returns {Form}
 */
function findForm(code, control, v){
    const form = (FORMS_BY_CODE.get(code) ?? []).find(f=>formInVersion(f, v)
        && (f.cmp ? control >= 1 && control <= 6 : f.ctl === null || f.ctl === control));
    if (!form)
    {
        throw new Error(`opcode ${code} with control ${control} is not an instruction of `
            + `${v.name}`);
    }
    return form;
}

/**
 * Decodes the text of a comment block's words.
 * @param {ArrayLike<number>} tokens
 * @param {number} from
 * @param {number} count
 * @returns {string[] | null}  The lines, or null for the constant table or data that is not text.
 */
function commentLines(tokens, from, count){
    if (count > 0 && tokens[from] >>> 0 === CTAB_FOURCC)
    {
        return null;
    }
    const bytes = [];
    for (let k = 0; k < count; k++)
    {
        const word = tokens[from + k] >>> 0;
        bytes.push(word & 0xff, (word >>> 8) & 0xff, (word >>> 16) & 0xff, word >>> 24);
    }
    while (bytes.length && bytes[bytes.length - 1] === 0)
    {
        bytes.pop();
    }
    if (bytes.some(b=>b === 0 || (b < 32 && b !== 10 && b !== 13 && b !== 9) || b > 126))
    {
        return [`(${count * 4} bytes of binary data)`];
    }
    return String.fromCharCode(...bytes).split(/\r\n|\n|\r/);
}

/**
 * @param {string} line
 * @returns {string}
 */
function commentText(line){
    return line === '' ? '//' : `// ${line}`;
}

/**
 * Turns bytecode into assembly text in the style of D3DX: lowercase mnemonics, one instruction
 * per line, the version line indented four spaces, blocks indented two further. Comment blocks
 * come out as // lines, except the constant table, which is left out. The instruction-slot
 * summary D3DX appends is not produced. Text from `options.comments` leads the listing, as
 * D3DXDisassembleShader's pComments does.
 *
 * The listing assembles back to the same tokens, comments aside. Bytecode that is not a valid
 * shader (a bad version token, an instruction cut short, an opcode the version does not have)
 * throws an Error that says where.
 *
 * @param {ArrayLike<number>} tokens
 * @param {{ comments?: string }} [options]
 * @returns {string}
 */
export function disassembleShader(tokens, options = {}){
    const first = tokens.length ? tokens[0] >>> 0 : 0;
    const v = VERSION_BY_TOKEN.get(first);
    if (!v)
    {
        throw new Error(`token 0 (0x${first.toString(16)}) is not a shader version`);
    }
    /** @type {string[]} */
    const leading = [];
    if (options.comments)
    {
        leading.push(...options.comments.split(/\r\n|\n|\r/).map(commentText));
    }
    /** @type {string[]} */
    const body = [];
    let depth = 0;
    let seenInstruction = false;
    let pos = 1;
    while (pos < tokens.length)
    {
        const token = tokens[pos] >>> 0;
        const code = token & 0xffff;
        if (token === END_TOKEN || (code === 0xffff && token >>> 16 === 0))
        {
            break;
        }
        if (code === COMMENT_OP && (token >>> 31) === 0)
        {
            const count = (token >>> 16) & 0x7fff;
            if (pos + 1 + count > tokens.length)
            {
                throw new Error(`comment at token ${pos} runs past the end of the shader`);
            }
            const lines = commentLines(tokens, pos + 1, count);
            (seenInstruction ? body : leading).push(...(lines ?? []).map(commentText));
            pos += 1 + count;
            continue;
        }
        seenInstruction = true;
        if (code === 0xfffd)
        {
            body.push('    phase');
            pos++;
            continue;
        }
        const decoded = decodeInstruction(tokens, pos, v);
        pos = decoded.next;
        if (decoded.closes)
        {
            depth = Math.max(0, depth - 1);
        }
        const pad = ' '.repeat(4 + 2 * depth);
        body.push(decoded.coissue ? `${pad.slice(2)}+ ${decoded.text}` : pad + decoded.text);
        if (decoded.opens)
        {
            depth++;
        }
    }
    return [...leading, `    ${v.name}`, ...body].join('\n') + '\n';
}

/**
 * @param {ArrayLike<number>} tokens
 * @param {number} pos
 * @param {Version} v
 * @returns {{ text: string, next: number, coissue: boolean, opens: boolean, closes: boolean }}
 */
function decodeInstruction(tokens, pos, v){
    const token = tokens[pos] >>> 0;
    const code = token & 0xffff;
    const control = (token >>> 16) & 0xff;
    const long = v.major >= 2;
    const length = long ? (token >>> 24) & 0xf : -1;
    const end = long ? pos + 1 + length : tokens.length;
    if (end > tokens.length)
    {
        throw new Error(`instruction at token ${pos} runs past the end of the shader`);
    }
    const coissue = ((token >>> 30) & 1) === 1;
    const predicated = long && ((token >>> 28) & 1) === 1;
    const at = `instruction at token ${pos}`;
    /** @type {{ text: string, next: number }} */
    let result;
    if (code === OP_DCL)
    {
        result = decodeDcl(tokens, pos + 1, end, v);
    }
    else if (code === OP_DEF || code === OP_DEFI || code === OP_DEFB)
    {
        result = decodeDefinition(tokens, code, pos + 1, long ? end : -1, v);
    }
    else
    {
        const form = findForm(code, control, v);
        result = decodeForm(tokens, form, control, pos + 1, end, predicated, long, v);
    }
    if (long && result.next !== end)
    {
        throw new Error(`${at} has length ${length} but its operands take `
            + `${result.next - pos - 1}`);
    }
    return {
        text: result.text, next: result.next, coissue,
        opens: BLOCK_OPEN.has(code), closes: BLOCK_CLOSE.has(code),
    };
}

/**
 * @param {ArrayLike<number>} tokens
 * @param {Form} form
 * @param {number} control
 * @param {number} start
 * @param {number} end
 * @param {boolean} predicated
 * @param {boolean} long
 * @param {Version} v
 * @returns {{ text: string, next: number }}
 */
function decodeForm(tokens, form, control, start, end, predicated, long, v){
    /** @type {Error | null} */
    let lastError = null;
    const alternatives = [...form.srcs].sort((a, b)=>b.length - a.length);
    for (const kinds of long ? alternatives : [form.srcs[0]])
    {
        try
        {
            const decoded = decodeOperands(tokens, form, control, kinds, start, end, predicated,
                v);
            if (!long || decoded.next === end)
            {
                return decoded;
            }
        }
        catch (e){
            lastError = e instanceof Error ? e : new Error(String(e));
        }
    }
    throw lastError ?? new Error(`${form.name} operands do not fit the instruction length`);
}

/**
 * @param {ArrayLike<number>} tokens
 * @param {Form} form
 * @param {number} control
 * @param {string} kinds
 * @param {number} start
 * @param {number} end
 * @param {boolean} predicated
 * @param {Version} v
 * @returns {{ text: string, next: number }}
 */
function decodeOperands(tokens, form, control, kinds, start, end, predicated, v){
    let pos = start;
    let name = mnemonicText(form, control);
    /** @type {string[]} */
    const operands = [];
    let predicate = '';
    if (form.dst !== '')
    {
        const d = readParam(tokens, pos, end, v);
        pos = d.next;
        const shift = d.shift;
        if (shift)
        {
            const shiftName = SHIFT_NAMES.get(shift);
            if (!shiftName)
            {
                throw new Error(`invalid destination shift ${shift}`);
            }
            name += `_${shiftName}`;
        }
        name += (d.resultMod & 1 ? '_sat' : '') + (d.resultMod & 2 ? '_pp' : '')
            + (d.resultMod & 4 ? '_centroid' : '');
        // A form whose bare destination means less than all four prints its mask always.
        const showMask = form.defMask === 0xf ? d.mask !== 0xf : true;
        operands.push(regName(d.reg, d.rel) + (showMask ? maskText(d.mask) : ''));
    }
    if (predicated)
    {
        const p = readParam(tokens, pos, end, v);
        pos = p.next;
        predicate = `(${p.modifier === MOD.NOT ? '!' : ''}p0${swizzleText(p.swizzle)}) `;
    }
    for (let k = 0; k < kinds.length; k++)
    {
        const s = readParam(tokens, pos, end, v);
        pos = s.next;
        operands.push(sourceText(s));
    }
    const text = operands.length ? `${name} ${operands.join(', ')}` : name;
    return { text: predicate + text, next: pos };
}

/**
 * @param {ArrayLike<number>} tokens
 * @param {number} start
 * @param {number} end
 * @param {Version} v
 * @returns {{ text: string, next: number }}
 */
function decodeDcl(tokens, start, end, v){
    if (start >= tokens.length)
    {
        throw new Error('dcl is cut short');
    }
    const usageToken = tokens[start] >>> 0;
    const d = readParam(tokens, start + 1, end < 0 ? tokens.length : end, v);
    const usage = usageToken & 0x1f;
    const index = (usageToken >>> 16) & 0xf;
    const type = (usageToken >>> 27) & 0xf;
    let head = 'dcl';
    if (d.reg.cls === 's')
    {
        const typeName = SAMPLER_TYPES.get(type);
        if (!typeName)
        {
            throw new Error(`dcl of a sampler with the unknown texture type ${type}`);
        }
        head += `_${typeName}`;
    }
    else if (d.reg.cls !== 'vPos' && d.reg.cls !== 'vFace')
    {
        const bare = v.major === 2 && !v.vs && usage === 0 && index === 0
            && (d.reg.cls === 'v' || d.reg.cls === 't');
        if (!bare)
        {
            if (usage >= USAGES.length)
            {
                throw new Error(`dcl with the unknown usage ${usage}`);
            }
            head += `_${USAGES[usage]}${index ? index : ''}`;
        }
    }
    head += (d.resultMod & 2 ? '_pp' : '') + (d.resultMod & 4 ? '_centroid' : '');
    const mask = d.mask === 0xf ? '' : maskText(d.mask);
    return { text: `${head} ${regName(d.reg, d.rel)}${mask}`, next: d.next };
}

/**
 * @param {ArrayLike<number>} tokens
 * @param {number} code
 * @param {number} start
 * @param {number} end    -1 where the length is not in the token (shader model 1).
 * @param {Version} v
 * @returns {{ text: string, next: number }}
 */
function decodeDefinition(tokens, code, start, end, v){
    const count = code === OP_DEFB ? 1 : 4;
    const limit = end < 0 ? tokens.length : end;
    const d = readParam(tokens, start, limit, v);
    if (d.next + count > limit)
    {
        throw new Error('definition is cut short');
    }
    const raw = [];
    for (let k = 0; k < count; k++)
    {
        raw.push(tokens[d.next + k] >>> 0);
    }
    let values;
    if (code === OP_DEF)
    {
        values = raw.map(floatText);
    }
    else if (code === OP_DEFI)
    {
        values = raw.map(w=>String(w | 0));
    }
    else
    {
        values = raw.map(w=>w === 1 ? 'true' : w === 0 ? 'false' : String(w | 0));
    }
    const name = code === OP_DEF ? 'def' : code === OP_DEFI ? 'defi' : 'defb';
    return {
        text: `${name} ${regName(d.reg, d.rel)}, ${values.join(', ')}`,
        next: d.next + count,
    };
}
