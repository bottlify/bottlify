/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The opcode tables: what each encoding is, what it operates on, which flags
 * it reads, writes and leaves undefined, and how it can fault.
 *
 * Written by hand from the architecture, in the manual's own operand-form
 * letters (`Ev,Gv`: an r/m operand and a register operand of the operand
 * size; `Ib`: an immediate byte; `Jz`: a relative target), so the table
 * reads like the reference it was written from and a form the resolver does
 * not know is a test failure, not a silent misdecode. The set is the
 * design's: what 32-bit Windows programs of 1995-2008 execute -- integer,
 * x87, MMX, SSE, SSE2, the string instructions, `cpuid`, `rdtsc`, the
 * `fs:` reads, and the few system instructions a user-mode program touches.
 * Anything else is absent, and the decoder refuses it by name so the set
 * grows from measured need rather than by guess.
 *
 * An entry is made with `I(op, forms, flags, faults)`; a group (`/r` selects
 * the instruction) with `G([...])`; a `0F` entry whose meaning the `66`,
 * `F3` and `F2` prefixes change with `S({ '': …, 66: …, f3: …, f2: … })`.
 * `null` is "not in the table"; `SYS` is "not user mode".
 */

// The six arithmetic flags, DF, and the reads a condition code makes.
export const CF = 1;
export const PF = 1 << 2;
export const AF = 1 << 4;
export const ZF = 1 << 6;
export const SF = 1 << 7;
export const DF = 1 << 10;
export const OF = 1 << 11;
export const ARITH_FLAGS = CF | PF | AF | ZF | SF | OF;

/**
 * @typedef {Object} Flags
 * @property {number} r  read
 * @property {number} w  written to a defined value
 * @property {number} u  written to an undefined value (a subset of w)
 */

/** @type {Record<string, Flags>} */
export const FLAG_CLASSES = Object.freeze({
    none: { r: 0, w: 0, u: 0 },
    arith: { r: 0, w: ARITH_FLAGS, u: 0 },
    // and/or/xor/test: CF and OF cleared, AF undefined.
    logic: { r: 0, w: ARITH_FLAGS, u: AF },
    // inc/dec keep CF.
    inc: { r: 0, w: PF | AF | ZF | SF | OF, u: 0 },
    // adc/sbb read CF.
    carry: { r: CF, w: ARITH_FLAGS, u: 0 },
    // shl/shr/sar: OF defined for a count of one only, AF undefined.
    shift: { r: 0, w: ARITH_FLAGS, u: AF | OF },
    // rol/ror: CF and OF only, OF defined for a count of one only.
    rotate: { r: 0, w: CF | OF, u: OF },
    // rcl/rcr rotate through CF.
    rotateCarry: { r: CF, w: CF | OF, u: OF },
    // mul/imul: CF and OF, the rest undefined.
    mul: { r: 0, w: ARITH_FLAGS, u: PF | AF | ZF | SF },
    // div/idiv leave every flag undefined.
    div: { r: 0, w: ARITH_FLAGS, u: ARITH_FLAGS },
    // bt/bts/btr/btc: CF, the rest but ZF undefined.
    bt: { r: 0, w: CF | PF | AF | SF | OF, u: PF | AF | SF | OF },
    // bsf/bsr: ZF, the rest undefined.
    bsf: { r: 0, w: ARITH_FLAGS, u: CF | PF | AF | SF | OF },
    // shld/shrd: like a shift.
    shiftDouble: { r: 0, w: ARITH_FLAGS, u: AF | OF },
    // cmpxchg: the compare's flags.
    cmpxchg: { r: 0, w: ARITH_FLAGS, u: 0 },
    // cmpxchg8b: ZF only.
    cmpxchg8b: { r: 0, w: ZF, u: 0 },
    // comiss/ucomiss/fcomi: ZF PF CF set, OF SF AF cleared.
    compareFloat: { r: 0, w: ARITH_FLAGS, u: 0 },
    // daa/das read CF and AF.
    decimalAdjust: { r: CF | AF, w: ARITH_FLAGS, u: OF },
    // aaa/aas read AF.
    asciiAdjust: { r: AF, w: ARITH_FLAGS, u: OF | SF | ZF | PF },
    // aam/aad.
    asciiMul: { r: 0, w: ARITH_FLAGS, u: OF | AF | CF },
    // The string compares read DF and write the arithmetic flags.
    stringCompare: { r: DF, w: ARITH_FLAGS, u: 0 },
    // The string moves read DF.
    stringMove: { r: DF, w: 0, u: 0 },
    // lahf / sahf.
    lahf: { r: SF | ZF | AF | PF | CF, w: 0, u: 0 },
    sahf: { r: 0, w: SF | ZF | AF | PF | CF, u: 0 },
    // pushf reads everything, popf writes everything.
    pushf: { r: ARITH_FLAGS | DF, w: 0, u: 0 },
    popf: { r: 0, w: ARITH_FLAGS | DF, u: 0 },
    clc: { r: 0, w: CF, u: 0 },
    cmc: { r: CF, w: CF, u: 0 },
    cld: { r: 0, w: DF, u: 0 },
    // into reads OF.
    into: { r: OF, w: 0, u: 0 },
});

/**
 * Which flags a condition code (the low nibble of jcc/setcc/cmovcc) reads.
 *
 * @param {number} cc
 */
export function conditionReads(cc){
    return [OF, CF, ZF, CF | ZF, SF, PF, SF | OF, ZF | SF | OF][cc >> 1];
}

/**
 * @typedef {Object} Entry
 * @property {string} op
 * @property {string[]} forms
 * @property {Flags} flags
 * @property {'none' | 'divide' | 'invalid' | 'trap' | 'halt'} faults
 * @property {number} [cc]  for jcc/setcc/cmovcc/fcmovcc: the condition code
 */

/**
 * @param {string} op
 * @param {string} [forms]   comma-separated operand forms; '' for none
 * @param {keyof typeof FLAG_CLASSES | Flags} [flags]
 * @param {Entry['faults']} [faults]
 * @param {number} [cc]
 * @returns {Entry}
 */
export function I(op, forms = '', flags = 'none', faults = 'none', cc){
    return {
        op,
        forms: forms === '' ? [] : forms.split(','),
        flags: typeof flags === 'string' ? FLAG_CLASSES[flags] : flags,
        faults,
        ...(cc === undefined ? {} : { cc }),
    };
}

/**
 * A group's slot whose meaning the ModRM byte's mod picks: one instruction
 * with a memory operand, another with none.
 */
export class ByMod {
    /** @param {Entry | null} memory @param {Entry | null} register */
    constructor(memory, register){
        this.memory = memory;
        this.register = register;
    }
}

/** A `/r` group: eight entries, null where the encoding is invalid. */
export class Group {
    /** @param {(Entry | ByMod | null | typeof SYS)[]} entries */
    constructor(entries){
        if (entries.length !== 8)
        {
            throw new Error(`table: a group has eight rows, not ${entries.length}`);
        }
        this.entries = entries;
    }
}

/** @param {(Entry | ByMod | null | typeof SYS)[]} entries */
export const G = entries=>new Group(entries);

/** A `0F` entry whose meaning the mandatory prefix picks. */
export class Prefixed {
    /**
     * @param {{ ''?: Entry | Group, 66?: Entry | Group, f3?: Entry | Group,
     *     f2?: Entry | Group }} variants
     */
    constructor(variants){
        this.variants = variants;
    }
}

/** @param {ConstructorParameters<typeof Prefixed>[0]} variants */
export const S = variants=>new Prefixed(variants);

/** An encoding a user-mode program has no business executing. */
export const SYS = Symbol('not user mode');

/** The sixteen condition codes' mnemonics, by code. */
export const CONDITIONS = Object.freeze([
    'o', 'no', 'b', 'ae', 'e', 'ne', 'be', 'a', 's', 'ns', 'p', 'np', 'l', 'ge', 'le', 'g',
]);

/** @param {string} op @param {string} forms @param {number} cc */
const cond = (op, forms, cc)=>I(op, forms, { r: conditionReads(cc), w: 0, u: 0 }, 'none', cc);

/** The eight arithmetic operations in group-1 order. */
const ARITH = ['add', 'or', 'adc', 'sbb', 'and', 'sub', 'xor', 'cmp'];
/** @param {number} index */
const arithClass = index=>[
    'arith', 'logic', 'carry', 'carry', 'logic', 'arith', 'logic', 'arith',
][index];
/** The eight shifts and rotates in group-2 order. */
const SHIFTS = ['rol', 'ror', 'rcl', 'rcr', 'shl', 'shr', 'sal', 'sar'];
/** @param {number} index */
const shiftClass = index=>[
    'rotate', 'rotate', 'rotateCarry', 'rotateCarry', 'shift', 'shift', 'shift', 'shift',
][index];

/** @param {string} forms */
const group1 = forms=>G(ARITH.map((op, index)=>I(op, forms, arithClass(index))));
/** @param {string} forms */
const group2 = forms=>G(SHIFTS.map((op, index)=>I(op, forms, shiftClass(index))));

/**
 * The one-byte opcode map.
 * @type {(Entry | Group | typeof SYS | null)[]}
 */
export const ONE_BYTE = new Array(256).fill(null);

// 00..3F: the arithmetic block, six encodings per operation, then the
// segment pushes/pops and decimal adjusts in the gaps.
ARITH.forEach((op, index)=>{
    const base = index << 3;
    const flags = arithClass(index);
    ONE_BYTE[base] = I(op, 'Eb,Gb', flags);
    ONE_BYTE[base + 1] = I(op, 'Ev,Gv', flags);
    ONE_BYTE[base + 2] = I(op, 'Gb,Eb', flags);
    ONE_BYTE[base + 3] = I(op, 'Gv,Ev', flags);
    ONE_BYTE[base + 4] = I(op, 'AL,Ib', flags);
    ONE_BYTE[base + 5] = I(op, 'eAX,Iz', flags);
});
ONE_BYTE[0x06] = I('push', 'ES');
ONE_BYTE[0x07] = I('pop', 'ES');
ONE_BYTE[0x0e] = I('push', 'CS');
ONE_BYTE[0x16] = I('push', 'SS');
ONE_BYTE[0x17] = I('pop', 'SS');
ONE_BYTE[0x1e] = I('push', 'DS');
ONE_BYTE[0x1f] = I('pop', 'DS');
ONE_BYTE[0x27] = I('daa', '', 'decimalAdjust');
ONE_BYTE[0x2f] = I('das', '', 'decimalAdjust');
ONE_BYTE[0x37] = I('aaa', '', 'asciiAdjust');
ONE_BYTE[0x3f] = I('aas', '', 'asciiAdjust');
// 40..5F: inc/dec/push/pop by register in the opcode.
for (let reg = 0; reg < 8; reg++)
{
    ONE_BYTE[0x40 + reg] = I('inc', 'Zv', 'inc');
    ONE_BYTE[0x48 + reg] = I('dec', 'Zv', 'inc');
    ONE_BYTE[0x50 + reg] = I('push', 'Zv');
    ONE_BYTE[0x58 + reg] = I('pop', 'Zv');
}
ONE_BYTE[0x60] = I('pushad');
ONE_BYTE[0x61] = I('popad');
// bound's second operand is a memory pair (`Ma`) on paper, but a lost thread
// running the entry vector's bytes reaches the register form (`62 d0`) too.
// `Ev` decodes both; the model and the emitter treat the whole instruction as
// a no-op, which neither reads the pair nor raises #BR.
ONE_BYTE[0x62] = I('bound', 'Gv,Ev', 'none', 'trap');
// arpl: legal at every privilege level, and in the corpus; it adjusts a
// selector's requested privilege and says whether it did.
ONE_BYTE[0x63] = I('arpl', 'Ew,Gw', { r: 0, w: ZF, u: 0 });
// 64..67 are prefixes; 68..6F immediates and imul, ins/outs are system.
ONE_BYTE[0x68] = I('push', 'Iz');
ONE_BYTE[0x69] = I('imul', 'Gv,Ev,Iz', 'mul');
ONE_BYTE[0x6a] = I('push', 'Ibs');
ONE_BYTE[0x6b] = I('imul', 'Gv,Ev,Ibs', 'mul');
ONE_BYTE[0x6c] = SYS;
ONE_BYTE[0x6d] = SYS;
ONE_BYTE[0x6e] = SYS;
ONE_BYTE[0x6f] = SYS;
for (let cc = 0; cc < 16; cc++)
{
    ONE_BYTE[0x70 + cc] = cond(`j${CONDITIONS[cc]}`, 'Jb', cc);
}
ONE_BYTE[0x80] = group1('Eb,Ib');
ONE_BYTE[0x81] = group1('Ev,Iz');
ONE_BYTE[0x82] = group1('Eb,Ib');
ONE_BYTE[0x83] = group1('Ev,Ibs');
ONE_BYTE[0x84] = I('test', 'Eb,Gb', 'logic');
ONE_BYTE[0x85] = I('test', 'Ev,Gv', 'logic');
ONE_BYTE[0x86] = I('xchg', 'Eb,Gb');
ONE_BYTE[0x87] = I('xchg', 'Ev,Gv');
ONE_BYTE[0x88] = I('mov', 'Eb,Gb');
ONE_BYTE[0x89] = I('mov', 'Ev,Gv');
ONE_BYTE[0x8a] = I('mov', 'Gb,Eb');
ONE_BYTE[0x8b] = I('mov', 'Gv,Ev');
ONE_BYTE[0x8c] = I('mov', 'Ew,Sw');
ONE_BYTE[0x8d] = I('lea', 'Gv,M');
ONE_BYTE[0x8e] = I('mov', 'Sw,Ew');
ONE_BYTE[0x8f] = G([I('pop', 'Ev'), null, null, null, null, null, null, null]);
ONE_BYTE[0x90] = I('nop');
for (let reg = 1; reg < 8; reg++)
{
    ONE_BYTE[0x90 + reg] = I('xchg', 'eAX,Zv');
}
ONE_BYTE[0x98] = I('cwde');
ONE_BYTE[0x99] = I('cdq');
ONE_BYTE[0x9a] = SYS; // call far
ONE_BYTE[0x9b] = I('fwait');
ONE_BYTE[0x9c] = I('pushf', '', 'pushf');
ONE_BYTE[0x9d] = I('popf', '', 'popf');
ONE_BYTE[0x9e] = I('sahf', '', 'sahf');
ONE_BYTE[0x9f] = I('lahf', '', 'lahf');
ONE_BYTE[0xa0] = I('mov', 'AL,Ob');
ONE_BYTE[0xa1] = I('mov', 'eAX,Ov');
ONE_BYTE[0xa2] = I('mov', 'Ob,AL');
ONE_BYTE[0xa3] = I('mov', 'Ov,eAX');
ONE_BYTE[0xa4] = I('movs', 'Yb,Xb', 'stringMove');
ONE_BYTE[0xa5] = I('movs', 'Yv,Xv', 'stringMove');
ONE_BYTE[0xa6] = I('cmps', 'Xb,Yb', 'stringCompare');
ONE_BYTE[0xa7] = I('cmps', 'Xv,Yv', 'stringCompare');
ONE_BYTE[0xa8] = I('test', 'AL,Ib', 'logic');
ONE_BYTE[0xa9] = I('test', 'eAX,Iz', 'logic');
ONE_BYTE[0xaa] = I('stos', 'Yb,AL', 'stringMove');
ONE_BYTE[0xab] = I('stos', 'Yv,eAX', 'stringMove');
ONE_BYTE[0xac] = I('lods', 'AL,Xb', 'stringMove');
ONE_BYTE[0xad] = I('lods', 'eAX,Xv', 'stringMove');
ONE_BYTE[0xae] = I('scas', 'AL,Yb', 'stringCompare');
ONE_BYTE[0xaf] = I('scas', 'eAX,Yv', 'stringCompare');
for (let reg = 0; reg < 8; reg++)
{
    ONE_BYTE[0xb0 + reg] = I('mov', 'Zb,Ib');
    ONE_BYTE[0xb8 + reg] = I('mov', 'Zv,Iv');
}
ONE_BYTE[0xc0] = group2('Eb,Ib');
ONE_BYTE[0xc1] = group2('Ev,Ib');
ONE_BYTE[0xc2] = I('ret', 'Iw');
ONE_BYTE[0xc3] = I('ret');
ONE_BYTE[0xc4] = SYS; // les
ONE_BYTE[0xc5] = SYS; // lds
ONE_BYTE[0xc6] = G([I('mov', 'Eb,Ib'), null, null, null, null, null, null, null]);
ONE_BYTE[0xc7] = G([I('mov', 'Ev,Iz'), null, null, null, null, null, null, null]);
ONE_BYTE[0xc8] = I('enter', 'Iw,Ib');
ONE_BYTE[0xc9] = I('leave');
ONE_BYTE[0xca] = SYS; // retf imm
ONE_BYTE[0xcb] = SYS; // retf
ONE_BYTE[0xcc] = I('int3', '', 'none', 'trap');
ONE_BYTE[0xcd] = I('int', 'Ib', 'none', 'trap');
ONE_BYTE[0xce] = I('into', '', 'into', 'trap');
ONE_BYTE[0xcf] = SYS; // iret
ONE_BYTE[0xd0] = group2('Eb,1');
ONE_BYTE[0xd1] = group2('Ev,1');
ONE_BYTE[0xd2] = group2('Eb,CL');
ONE_BYTE[0xd3] = group2('Ev,CL');
ONE_BYTE[0xd4] = I('aam', 'Ib', 'asciiMul', 'divide');
ONE_BYTE[0xd5] = I('aad', 'Ib', 'asciiMul');
ONE_BYTE[0xd6] = I('salc', '', { r: CF, w: 0, u: 0 });
ONE_BYTE[0xd7] = I('xlat', 'Xlat');
// D8..DF are the x87 escapes, decoded from X87 below.
ONE_BYTE[0xe0] = I('loopne', 'Jb', { r: ZF, w: 0, u: 0 });
ONE_BYTE[0xe1] = I('loope', 'Jb', { r: ZF, w: 0, u: 0 });
ONE_BYTE[0xe2] = I('loop', 'Jb');
ONE_BYTE[0xe3] = I('jecxz', 'Jb');
ONE_BYTE[0xe4] = I('in', 'AL,Ib', 'none', 'trap');
ONE_BYTE[0xe5] = I('in', 'eAX,Ib', 'none', 'trap');
ONE_BYTE[0xe6] = I('out', 'Ib,AL', 'none', 'trap');
ONE_BYTE[0xe7] = I('out', 'Ib,eAX', 'none', 'trap');
ONE_BYTE[0xe8] = I('call', 'Jz');
ONE_BYTE[0xe9] = I('jmp', 'Jz');
ONE_BYTE[0xea] = SYS; // jmp far
ONE_BYTE[0xeb] = I('jmp', 'Jb');
ONE_BYTE[0xec] = I('in', 'AL,DX', 'none', 'trap');
ONE_BYTE[0xed] = I('in', 'eAX,DX', 'none', 'trap');
ONE_BYTE[0xee] = I('out', 'DX,AL', 'none', 'trap');
ONE_BYTE[0xef] = I('out', 'DX,eAX', 'none', 'trap');
// F0..F3 are prefixes.
ONE_BYTE[0xf4] = I('hlt', '', 'none', 'halt');
ONE_BYTE[0xf5] = I('cmc', '', 'cmc');
ONE_BYTE[0xf6] = G([
    I('test', 'Eb,Ib', 'logic'), I('test', 'Eb,Ib', 'logic'), I('not', 'Eb'),
    I('neg', 'Eb', 'arith'),
    I('mul', 'Eb', 'mul'), I('imul', 'Eb', 'mul'),
    I('div', 'Eb', 'div', 'divide'), I('idiv', 'Eb', 'div', 'divide'),
]);
ONE_BYTE[0xf7] = G([
    I('test', 'Ev,Iz', 'logic'), I('test', 'Ev,Iz', 'logic'), I('not', 'Ev'),
    I('neg', 'Ev', 'arith'),
    I('mul', 'Ev', 'mul'), I('imul', 'Ev', 'mul'),
    I('div', 'Ev', 'div', 'divide'), I('idiv', 'Ev', 'div', 'divide'),
]);
ONE_BYTE[0xf8] = I('clc', '', 'clc');
ONE_BYTE[0xf9] = I('stc', '', 'clc');
ONE_BYTE[0xfa] = I('cli', '', 'none', 'trap');
ONE_BYTE[0xfb] = I('sti', '', 'none', 'trap');
ONE_BYTE[0xfc] = I('cld', '', 'cld');
ONE_BYTE[0xfd] = I('std', '', 'cld');
ONE_BYTE[0xfe] = G([
    I('inc', 'Eb', 'inc'), I('dec', 'Eb', 'inc'), null, null, null, null, null, null,
]);
ONE_BYTE[0xff] = G([
    I('inc', 'Ev', 'inc'), I('dec', 'Ev', 'inc'), I('call', 'Ev'), SYS,
    I('jmp', 'Ev'), SYS, I('push', 'Ev'), null,
]);

/**
 * The `0F` map.
 * @type {(Entry | Group | Prefixed | typeof SYS | null)[]}
 */
export const TWO_BYTE = new Array(256).fill(null);

// The descriptor-table and machine-status stores read nothing privileged
// back but the system's own tables' places, and run in user mode (Windows
// answers them itself where the processor refuses them, UMIP).
TWO_BYTE[0x00] = G([I('sldt', 'Ew'), I('str', 'Ew'), SYS, SYS, SYS, SYS, SYS, SYS]);
TWO_BYTE[0x01] = G([I('sgdt', 'Mq'), I('sidt', 'Mq'), SYS, SYS, I('smsw', 'Ew'), SYS, SYS,
    SYS]);
TWO_BYTE[0x02] = SYS; // lar
TWO_BYTE[0x03] = SYS; // lsl
TWO_BYTE[0x05] = SYS; // syscall
TWO_BYTE[0x06] = SYS; // clts
TWO_BYTE[0x08] = SYS; // invd
TWO_BYTE[0x09] = SYS; // wbinvd
TWO_BYTE[0x0b] = I('ud2', '', 'none', 'invalid');
// The prefetch hints take any r/m: a register form is a no-op, not a fault.
TWO_BYTE[0x0d] = G([
    I('prefetch', 'Eb'), I('prefetchw', 'Eb'), I('prefetch', 'Eb'), I('prefetch', 'Eb'),
    I('prefetch', 'Eb'), I('prefetch', 'Eb'), I('prefetch', 'Eb'), I('prefetch', 'Eb'),
]);
TWO_BYTE[0x10] = S({
    '': I('movups', 'Vps,Wps'), 66: I('movupd', 'Vpd,Wpd'), f3: I('movss', 'Vss,Wss'),
    f2: I('movsd', 'Vsd,Wsd'),
});
TWO_BYTE[0x11] = S({
    '': I('movups', 'Wps,Vps'), 66: I('movupd', 'Wpd,Vpd'), f3: I('movss', 'Wss,Vss'),
    f2: I('movsd', 'Wsd,Vsd'),
});
TWO_BYTE[0x12] = S({
    '': I('movlps', 'Vq,Wq'), 66: I('movlpd', 'Vq,Mq'), f3: I('movsldup', 'Vps,Wps'),
    f2: I('movddup', 'Vpd,Wsd'),
});
TWO_BYTE[0x13] = S({ '': I('movlps', 'Mq,Vq'), 66: I('movlpd', 'Mq,Vq') });
TWO_BYTE[0x14] = S({ '': I('unpcklps', 'Vps,Wps'), 66: I('unpcklpd', 'Vpd,Wpd') });
TWO_BYTE[0x15] = S({ '': I('unpckhps', 'Vps,Wps'), 66: I('unpckhpd', 'Vpd,Wpd') });
TWO_BYTE[0x16] = S({
    '': I('movhps', 'Vq,Wq'), 66: I('movhpd', 'Vq,Mq'), f3: I('movshdup', 'Vps,Wps'),
});
TWO_BYTE[0x17] = S({ '': I('movhps', 'Mq,Vq'), 66: I('movhpd', 'Mq,Vq') });
TWO_BYTE[0x18] = G([
    I('prefetchnta', 'Eb'), I('prefetcht0', 'Eb'), I('prefetcht1', 'Eb'), I('prefetcht2', 'Eb'),
    I('nop', 'Ev'), I('nop', 'Ev'), I('nop', 'Ev'), I('nop', 'Ev'),
]);
for (let opcode = 0x19; opcode <= 0x1f; opcode++)
{
    TWO_BYTE[opcode] = I('nop', 'Ev');
}
TWO_BYTE[0x20] = SYS; // mov r, crN
TWO_BYTE[0x21] = SYS;
TWO_BYTE[0x22] = SYS;
TWO_BYTE[0x23] = SYS;
TWO_BYTE[0x28] = S({ '': I('movaps', 'Vps,Wps'), 66: I('movapd', 'Vpd,Wpd') });
TWO_BYTE[0x29] = S({ '': I('movaps', 'Wps,Vps'), 66: I('movapd', 'Wpd,Vpd') });
TWO_BYTE[0x2a] = S({
    '': I('cvtpi2ps', 'Vps,Qq'), 66: I('cvtpi2pd', 'Vpd,Qq'), f3: I('cvtsi2ss', 'Vss,Ey'),
    f2: I('cvtsi2sd', 'Vsd,Ey'),
});
TWO_BYTE[0x2b] = S({ '': I('movntps', 'Mdq,Vps'), 66: I('movntpd', 'Mdq,Vpd') });
TWO_BYTE[0x2c] = S({
    '': I('cvttps2pi', 'Pq,Wq'), 66: I('cvttpd2pi', 'Pq,Wpd'), f3: I('cvttss2si', 'Gy,Wss'),
    f2: I('cvttsd2si', 'Gy,Wsd'),
});
TWO_BYTE[0x2d] = S({
    '': I('cvtps2pi', 'Pq,Wq'), 66: I('cvtpd2pi', 'Pq,Wpd'), f3: I('cvtss2si', 'Gy,Wss'),
    f2: I('cvtsd2si', 'Gy,Wsd'),
});
TWO_BYTE[0x2e] = S({
    '': I('ucomiss', 'Vss,Wss', 'compareFloat'), 66: I('ucomisd', 'Vsd,Wsd', 'compareFloat'),
});
TWO_BYTE[0x2f] = S({
    '': I('comiss', 'Vss,Wss', 'compareFloat'), 66: I('comisd', 'Vsd,Wsd', 'compareFloat'),
});
TWO_BYTE[0x30] = SYS; // wrmsr
TWO_BYTE[0x31] = I('rdtsc');
TWO_BYTE[0x32] = SYS; // rdmsr
TWO_BYTE[0x33] = SYS; // rdpmc
TWO_BYTE[0x34] = SYS; // sysenter
TWO_BYTE[0x35] = SYS; // sysexit
for (let cc = 0; cc < 16; cc++)
{
    TWO_BYTE[0x40 + cc] = cond(`cmov${CONDITIONS[cc]}`, 'Gv,Ev', cc);
    TWO_BYTE[0x80 + cc] = cond(`j${CONDITIONS[cc]}`, 'Jz', cc);
    TWO_BYTE[0x90 + cc] = cond(`set${CONDITIONS[cc]}`, 'Eb', cc);
}
TWO_BYTE[0x50] = S({ '': I('movmskps', 'Gy,Ups'), 66: I('movmskpd', 'Gy,Upd') });
TWO_BYTE[0x51] = S({
    '': I('sqrtps', 'Vps,Wps'), 66: I('sqrtpd', 'Vpd,Wpd'), f3: I('sqrtss', 'Vss,Wss'),
    f2: I('sqrtsd', 'Vsd,Wsd'),
});
TWO_BYTE[0x52] = S({ '': I('rsqrtps', 'Vps,Wps'), f3: I('rsqrtss', 'Vss,Wss') });
TWO_BYTE[0x53] = S({ '': I('rcpps', 'Vps,Wps'), f3: I('rcpss', 'Vss,Wss') });
TWO_BYTE[0x54] = S({ '': I('andps', 'Vps,Wps'), 66: I('andpd', 'Vpd,Wpd') });
TWO_BYTE[0x55] = S({ '': I('andnps', 'Vps,Wps'), 66: I('andnpd', 'Vpd,Wpd') });
TWO_BYTE[0x56] = S({ '': I('orps', 'Vps,Wps'), 66: I('orpd', 'Vpd,Wpd') });
TWO_BYTE[0x57] = S({ '': I('xorps', 'Vps,Wps'), 66: I('xorpd', 'Vpd,Wpd') });
/** @param {number} opcode @param {string} op */
const packedArith = (opcode, op)=>{
    TWO_BYTE[opcode] = S({
        '': I(`${op}ps`, 'Vps,Wps'), 66: I(`${op}pd`, 'Vpd,Wpd'), f3: I(`${op}ss`, 'Vss,Wss'),
        f2: I(`${op}sd`, 'Vsd,Wsd'),
    });
};
packedArith(0x58, 'add');
packedArith(0x59, 'mul');
TWO_BYTE[0x5a] = S({
    '': I('cvtps2pd', 'Vpd,Wq'), 66: I('cvtpd2ps', 'Vps,Wpd'), f3: I('cvtss2sd', 'Vsd,Wss'),
    f2: I('cvtsd2ss', 'Vss,Wsd'),
});
TWO_BYTE[0x5b] = S({
    '': I('cvtdq2ps', 'Vps,Wdq'), 66: I('cvtps2dq', 'Vdq,Wps'), f3: I('cvttps2dq', 'Vdq,Wps'),
});
packedArith(0x5c, 'sub');
packedArith(0x5d, 'min');
packedArith(0x5e, 'div');
packedArith(0x5f, 'max');
/**
 * An MMX/SSE2 integer operation: mm with a 64-bit source, xmm with 66.
 * @param {number} opcode @param {string} op
 */
const packedInt = (opcode, op)=>{
    TWO_BYTE[opcode] = S({ '': I(op, 'Pq,Qq'), 66: I(op, 'Vdq,Wdq') });
};
[
    [0x60, 'punpcklbw'], [0x61, 'punpcklwd'], [0x62, 'punpckldq'], [0x63, 'packsswb'],
    [0x64, 'pcmpgtb'], [0x65, 'pcmpgtw'], [0x66, 'pcmpgtd'], [0x67, 'packuswb'],
    [0x68, 'punpckhbw'], [0x69, 'punpckhwd'], [0x6a, 'punpckhdq'], [0x6b, 'packssdw'],
    [0x74, 'pcmpeqb'], [0x75, 'pcmpeqw'], [0x76, 'pcmpeqd'],
    [0xd1, 'psrlw'], [0xd2, 'psrld'], [0xd3, 'psrlq'], [0xd4, 'paddq'], [0xd5, 'pmullw'],
    [0xd8, 'psubusb'], [0xd9, 'psubusw'], [0xda, 'pminub'], [0xdb, 'pand'],
    [0xdc, 'paddusb'], [0xdd, 'paddusw'], [0xde, 'pmaxub'], [0xdf, 'pandn'],
    [0xe0, 'pavgb'], [0xe1, 'psraw'], [0xe2, 'psrad'], [0xe3, 'pavgw'],
    [0xe4, 'pmulhuw'], [0xe5, 'pmulhw'],
    [0xe8, 'psubsb'], [0xe9, 'psubsw'], [0xea, 'pminsw'], [0xeb, 'por'],
    [0xec, 'paddsb'], [0xed, 'paddsw'], [0xee, 'pmaxsw'], [0xef, 'pxor'],
    [0xf1, 'psllw'], [0xf2, 'pslld'], [0xf3, 'psllq'], [0xf4, 'pmuludq'], [0xf5, 'pmaddwd'],
    [0xf6, 'psadbw'],
    [0xf8, 'psubb'], [0xf9, 'psubw'], [0xfa, 'psubd'], [0xfb, 'psubq'],
    [0xfc, 'paddb'], [0xfd, 'paddw'], [0xfe, 'paddd'],
].forEach(([opcode, op])=>packedInt(/** @type {number} */ (opcode), /** @type {string} */ (op)));
TWO_BYTE[0x6c] = S({ 66: I('punpcklqdq', 'Vdq,Wdq') });
TWO_BYTE[0x6d] = S({ 66: I('punpckhqdq', 'Vdq,Wdq') });
TWO_BYTE[0x6e] = S({ '': I('movd', 'Pq,Ey'), 66: I('movd', 'Vdq,Ey') });
TWO_BYTE[0x6f] = S({
    '': I('movq', 'Pq,Qq'), 66: I('movdqa', 'Vdq,Wdq'), f3: I('movdqu', 'Vdq,Wdq'),
});
TWO_BYTE[0x70] = S({
    '': I('pshufw', 'Pq,Qq,Ib'), 66: I('pshufd', 'Vdq,Wdq,Ib'), f3: I('pshufhw', 'Vdq,Wdq,Ib'),
    f2: I('pshuflw', 'Vdq,Wdq,Ib'),
});
/** The shift-by-immediate groups: 71 (words), 72 (dwords), 73 (qwords, and the 66 byte shifts). */
TWO_BYTE[0x71] = S({
    '': G([
        null, null, I('psrlw', 'Nq,Ib'), null, I('psraw', 'Nq,Ib'), null, I('psllw', 'Nq,Ib'), null,
    ]),
    66: G([
        null, null, I('psrlw', 'Udq,Ib'), null, I('psraw', 'Udq,Ib'), null,
        I('psllw', 'Udq,Ib'), null,
    ]),
});
TWO_BYTE[0x72] = S({
    '': G([
        null, null, I('psrld', 'Nq,Ib'), null, I('psrad', 'Nq,Ib'), null, I('pslld', 'Nq,Ib'), null,
    ]),
    66: G([
        null, null, I('psrld', 'Udq,Ib'), null, I('psrad', 'Udq,Ib'), null,
        I('pslld', 'Udq,Ib'), null,
    ]),
});
TWO_BYTE[0x73] = S({
    '': G([null, null, I('psrlq', 'Nq,Ib'), null, null, null, I('psllq', 'Nq,Ib'), null]),
    66: G([
        null, null, I('psrlq', 'Udq,Ib'), I('psrldq', 'Udq,Ib'), null, null,
        I('psllq', 'Udq,Ib'), I('pslldq', 'Udq,Ib'),
    ]),
});
TWO_BYTE[0x77] = I('emms');
TWO_BYTE[0x7c] = S({ 66: I('haddpd', 'Vpd,Wpd'), f2: I('haddps', 'Vps,Wps') });
TWO_BYTE[0x7d] = S({ 66: I('hsubpd', 'Vpd,Wpd'), f2: I('hsubps', 'Vps,Wps') });
TWO_BYTE[0x7e] = S({ '': I('movd', 'Ey,Pq'), 66: I('movd', 'Ey,Vdq'), f3: I('movq', 'Vq,Wq') });
TWO_BYTE[0x7f] = S({
    '': I('movq', 'Qq,Pq'), 66: I('movdqa', 'Wdq,Vdq'), f3: I('movdqu', 'Wdq,Vdq'),
});
TWO_BYTE[0xa0] = I('push', 'FS');
TWO_BYTE[0xa1] = I('pop', 'FS');
TWO_BYTE[0xa2] = I('cpuid');
TWO_BYTE[0xa3] = I('bt', 'Ev,Gv', 'bt');
TWO_BYTE[0xa4] = I('shld', 'Ev,Gv,Ib', 'shiftDouble');
TWO_BYTE[0xa5] = I('shld', 'Ev,Gv,CL', 'shiftDouble');
TWO_BYTE[0xa8] = I('push', 'GS');
TWO_BYTE[0xa9] = I('pop', 'GS');
TWO_BYTE[0xab] = I('bts', 'Ev,Gv', 'bt');
TWO_BYTE[0xac] = I('shrd', 'Ev,Gv,Ib', 'shiftDouble');
TWO_BYTE[0xad] = I('shrd', 'Ev,Gv,CL', 'shiftDouble');
// The fences are the register forms of /5../7; the memory form of /7 is
// clflush (CPUID's CLFSH), those of /5 and /6 xrstor and xsaveopt, which need
// an XSAVE CPUID does not report.
TWO_BYTE[0xae] = G([
    I('fxsave', 'M'), I('fxrstor', 'M'), I('ldmxcsr', 'Md'), I('stmxcsr', 'Md'),
    SYS, new ByMod(null, I('lfence')), new ByMod(null, I('mfence')),
    new ByMod(I('clflush', 'Mb'), I('sfence')),
]);
TWO_BYTE[0xaf] = I('imul', 'Gv,Ev', 'mul');
TWO_BYTE[0xb0] = I('cmpxchg', 'Eb,Gb', 'cmpxchg');
TWO_BYTE[0xb1] = I('cmpxchg', 'Ev,Gv', 'cmpxchg');
TWO_BYTE[0xb2] = SYS; // lss
TWO_BYTE[0xb3] = I('btr', 'Ev,Gv', 'bt');
TWO_BYTE[0xb4] = SYS; // lfs
TWO_BYTE[0xb5] = SYS; // lgs
TWO_BYTE[0xb6] = I('movzx', 'Gv,Eb');
TWO_BYTE[0xb7] = I('movzx', 'Gv,Ew');
// popcnt clears every flag but ZF, which says whether the source was zero.
TWO_BYTE[0xb8] = S({ f3: I('popcnt', 'Gv,Ev', { r: 0, w: ARITH_FLAGS, u: 0 }) });
TWO_BYTE[0xb9] = I('ud1', '', 'none', 'invalid');
TWO_BYTE[0xba] = G([
    null, null, null, null,
    I('bt', 'Ev,Ib', 'bt'), I('bts', 'Ev,Ib', 'bt'), I('btr', 'Ev,Ib', 'bt'),
    I('btc', 'Ev,Ib', 'bt'),
]);
TWO_BYTE[0xbb] = I('btc', 'Ev,Gv', 'bt');
TWO_BYTE[0xbc] = I('bsf', 'Gv,Ev', 'bsf');
TWO_BYTE[0xbd] = I('bsr', 'Gv,Ev', 'bsf');
TWO_BYTE[0xbe] = I('movsx', 'Gv,Eb');
TWO_BYTE[0xbf] = I('movsx', 'Gv,Ew');
TWO_BYTE[0xc0] = I('xadd', 'Eb,Gb', 'arith');
TWO_BYTE[0xc1] = I('xadd', 'Ev,Gv', 'arith');
TWO_BYTE[0xc2] = S({
    '': I('cmpps', 'Vps,Wps,Ib'), 66: I('cmppd', 'Vpd,Wpd,Ib'), f3: I('cmpss', 'Vss,Wss,Ib'),
    f2: I('cmpsd', 'Vsd,Wsd,Ib'),
});
TWO_BYTE[0xc3] = I('movnti', 'Md,Gy');
TWO_BYTE[0xc4] = S({ '': I('pinsrw', 'Pq,Ew,Ib'), 66: I('pinsrw', 'Vdq,Ew,Ib') });
TWO_BYTE[0xc5] = S({ '': I('pextrw', 'Gy,Nq,Ib'), 66: I('pextrw', 'Gy,Udq,Ib') });
TWO_BYTE[0xc6] = S({ '': I('shufps', 'Vps,Wps,Ib'), 66: I('shufpd', 'Vpd,Wpd,Ib') });
// rdrand: CPUID leaf 1 advertises it (`cpuid.js`), so it is decoded;
// a memory operand is #UD, and it leaves CF set and the other five clear.
TWO_BYTE[0xc7] = G([
    null, I('cmpxchg8b', 'Mq', 'cmpxchg8b'), null, null, null, null,
    I('rdrand', 'Ev', { r: 0, w: ARITH_FLAGS, u: 0 }), null,
]);
for (let reg = 0; reg < 8; reg++)
{
    TWO_BYTE[0xc8 + reg] = I('bswap', 'Zy');
}
TWO_BYTE[0xd0] = S({ 66: I('addsubpd', 'Vpd,Wpd'), f2: I('addsubps', 'Vps,Wps') });
TWO_BYTE[0xd6] = S({
    66: I('movq', 'Wq,Vq'), f3: I('movq2dq', 'Vdq,Nq'), f2: I('movdq2q', 'Pq,Uq'),
});
TWO_BYTE[0xd7] = S({ '': I('pmovmskb', 'Gy,Nq'), 66: I('pmovmskb', 'Gy,Udq') });
TWO_BYTE[0xe6] = S({
    66: I('cvttpd2dq', 'Vdq,Wpd'), f3: I('cvtdq2pd', 'Vpd,Wq'), f2: I('cvtpd2dq', 'Vdq,Wpd'),
});
TWO_BYTE[0xe7] = S({ '': I('movntq', 'Mq,Pq'), 66: I('movntdq', 'Mdq,Vdq') });
TWO_BYTE[0xf0] = S({ f2: I('lddqu', 'Vdq,Mdq') });
TWO_BYTE[0xf7] = S({ '': I('maskmovq', 'Pq,Nq'), 66: I('maskmovdqu', 'Vdq,Udq') });

/**
 * The x87 maps, one per escape byte D8..DF: eight memory forms by `/r`, and
 * the register forms by the modrm byte itself -- a run of eight sharing an
 * `sti` operand (`base`), or one byte alone.
 *
 * @typedef {{ mem: (Entry | null)[], reg: Record<number, Entry> }} X87Map
 */

/** @param {Record<number, Entry>} into @param {number} base @param {Entry} entry */
const run = (into, base, entry)=>{
    for (let i = 0; i < 8; i++)
    {
        into[base + i] = entry;
    }
};
/** @param {string} op @param {string} forms @param {number} cc */
const fcmov = (op, forms, cc)=>I(op, forms, { r: conditionReads(cc), w: 0, u: 0 }, 'none', cc);

/** @type {X87Map[]} */
export const X87 = [
    { // D8
        mem: ['fadd', 'fmul', 'fcom', 'fcomp', 'fsub', 'fsubr', 'fdiv', 'fdivr']
            .map(op=>I(op, 'ST0,m32fp')),
        reg: {},
    },
    { // D9
        mem: [
            I('fld', 'ST,m32fp'), null, I('fst', 'm32fp,ST0'), I('fstp', 'm32fp,ST0'),
            I('fldenv', 'Menv'), I('fldcw', 'Mw'), I('fnstenv', 'Menv'), I('fnstcw', 'Mw'),
        ],
        reg: {},
    },
    { // DA
        mem: ['fiadd', 'fimul', 'ficom', 'ficomp', 'fisub', 'fisubr', 'fidiv', 'fidivr']
            .map(op=>I(op, 'ST0,m32int')),
        reg: {},
    },
    { // DB
        mem: [
            I('fild', 'ST,m32int'), I('fisttp', 'm32int,ST0'), I('fist', 'm32int,ST0'),
            I('fistp', 'm32int,ST0'), null, I('fld', 'ST,m80fp'), null, I('fstp', 'm80fp,ST0'),
        ],
        reg: {},
    },
    { // DC
        mem: ['fadd', 'fmul', 'fcom', 'fcomp', 'fsub', 'fsubr', 'fdiv', 'fdivr']
            .map(op=>I(op, 'ST0,m64fp')),
        reg: {},
    },
    { // DD
        mem: [
            I('fld', 'ST,m64fp'), I('fisttp', 'm64int,ST0'), I('fst', 'm64fp,ST0'),
            I('fstp', 'm64fp,ST0'), I('frstor', 'Msave'), null, I('fnsave', 'Msave'),
            I('fnstsw', 'Mw'),
        ],
        reg: {},
    },
    { // DE
        mem: ['fiadd', 'fimul', 'ficom', 'ficomp', 'fisub', 'fisubr', 'fidiv', 'fidivr']
            .map(op=>I(op, 'ST0,m16int')),
        reg: {},
    },
    { // DF
        mem: [
            I('fild', 'ST,m16int'), I('fisttp', 'm16int,ST0'), I('fist', 'm16int,ST0'),
            I('fistp', 'm16int,ST0'), I('fbld', 'ST,m80bcd'), I('fild', 'ST,m64int'),
            I('fbstp', 'm80bcd,ST0'), I('fistp', 'm64int,ST0'),
        ],
        reg: {},
    },
];
// D8 register forms: op ST0, ST(i).
['fadd', 'fmul', 'fcom', 'fcomp', 'fsub', 'fsubr', 'fdiv', 'fdivr'].forEach((op, i)=>{
    run(X87[0].reg, 0xc0 + i * 8, I(op, 'ST0,STi'));
});
// D9.
run(X87[1].reg, 0xc0, I('fld', 'ST,STi'));
run(X87[1].reg, 0xc8, I('fxch', 'ST0,STi'));
X87[1].reg[0xd0] = I('fnop');
// D9 D8+i: an undocumented alias of fstp st(i) every processor honours, and
// the corpus checks.
run(X87[1].reg, 0xd8, I('fstp', 'STi,ST0'));
Object.entries({
    0xe0: 'fchs', 0xe1: 'fabs', 0xe4: 'ftst', 0xe5: 'fxam',
    0xe8: 'fld1', 0xe9: 'fldl2t', 0xea: 'fldl2e', 0xeb: 'fldpi', 0xec: 'fldlg2', 0xed: 'fldln2',
    0xee: 'fldz', 0xf0: 'f2xm1', 0xf1: 'fyl2x', 0xf2: 'fptan', 0xf3: 'fpatan', 0xf4: 'fxtract',
    0xf5: 'fprem1', 0xf6: 'fdecstp', 0xf7: 'fincstp', 0xf8: 'fprem', 0xf9: 'fyl2xp1',
    0xfa: 'fsqrt', 0xfb: 'fsincos', 0xfc: 'frndint', 0xfd: 'fscale', 0xfe: 'fsin', 0xff: 'fcos',
}).forEach(([modrm, op])=>{
    X87[1].reg[Number(modrm)] = I(op);
});
// DA.
run(X87[2].reg, 0xc0, fcmov('fcmovb', 'ST0,STi', 2));
run(X87[2].reg, 0xc8, fcmov('fcmove', 'ST0,STi', 4));
run(X87[2].reg, 0xd0, fcmov('fcmovbe', 'ST0,STi', 6));
run(X87[2].reg, 0xd8, fcmov('fcmovu', 'ST0,STi', 10));
X87[2].reg[0xe9] = I('fucompp');
// DB.
run(X87[3].reg, 0xc0, fcmov('fcmovnb', 'ST0,STi', 3));
run(X87[3].reg, 0xc8, fcmov('fcmovne', 'ST0,STi', 5));
run(X87[3].reg, 0xd0, fcmov('fcmovnbe', 'ST0,STi', 7));
run(X87[3].reg, 0xd8, fcmov('fcmovnu', 'ST0,STi', 11));
// DB E0, E1, E4: fneni, fndisi and fsetpm, 8087/287 leftovers every later
// processor executes as no-ops.
X87[3].reg[0xe0] = I('fnop');
X87[3].reg[0xe1] = I('fnop');
X87[3].reg[0xe4] = I('fnop');
X87[3].reg[0xe2] = I('fnclex');
X87[3].reg[0xe3] = I('fninit');
run(X87[3].reg, 0xe8, I('fucomi', 'ST0,STi', 'compareFloat'));
run(X87[3].reg, 0xf0, I('fcomi', 'ST0,STi', 'compareFloat'));
// DC: op ST(i), ST0 -- with the subtract and divide senses reversed against D8.
['fadd', 'fmul', null, null, 'fsubr', 'fsub', 'fdivr', 'fdiv'].forEach((op, i)=>{
    if (op)
    {
        run(X87[4].reg, 0xc0 + i * 8, I(op, 'STi,ST0'));
    }
});
// DC D0+i and DC D8+i: undocumented aliases of fcom and fcomp st(i).
run(X87[4].reg, 0xd0, I('fcom', 'ST0,STi'));
run(X87[4].reg, 0xd8, I('fcomp', 'ST0,STi'));
// DD.
run(X87[5].reg, 0xc0, I('ffree', 'STi'));
// DD C8+i: an undocumented alias of fxch, like D9 D8+i above.
run(X87[5].reg, 0xc8, I('fxch', 'ST0,STi'));
run(X87[5].reg, 0xd0, I('fst', 'STi,ST0'));
run(X87[5].reg, 0xd8, I('fstp', 'STi,ST0'));
run(X87[5].reg, 0xe0, I('fucom', 'ST0,STi'));
run(X87[5].reg, 0xe8, I('fucomp', 'ST0,STi'));
// DE: the popping forms, senses reversed like DC.
['faddp', 'fmulp', null, null, 'fsubrp', 'fsubp', 'fdivrp', 'fdivp'].forEach((op, i)=>{
    if (op)
    {
        run(X87[6].reg, 0xc0 + i * 8, I(op, 'STi,ST0'));
    }
});
// DE D0+i: an undocumented alias of fcomp st(i); D9 among them stays fcompp.
run(X87[6].reg, 0xd0, I('fcomp', 'ST0,STi'));
X87[6].reg[0xd9] = I('fcompp');
// DF C0+i is ffreep (free and pop, undocumented but universal); DF C8+i,
// D0+i and D8+i alias fxch and fstp like the D9/DD forms above.
run(X87[7].reg, 0xc0, I('ffreep', 'STi'));
run(X87[7].reg, 0xc8, I('fxch', 'ST0,STi'));
run(X87[7].reg, 0xd0, I('fstp', 'STi,ST0'));
run(X87[7].reg, 0xd8, I('fstp', 'STi,ST0'));
// DF.
X87[7].reg[0xe0] = I('fnstsw', 'AX');
run(X87[7].reg, 0xe8, I('fucomip', 'ST0,STi', 'compareFloat'));
run(X87[7].reg, 0xf0, I('fcomip', 'ST0,STi', 'compareFloat'));

/**
 * Every operand form the tables use, so a test can check that the resolver
 * knows each one and the tables use nothing else.
 *
 * @returns {Set<string>}
 */
export function formsInUse(){
    const forms = new Set();
    /** @param {Entry | Group | ByMod | Prefixed | typeof SYS | null} entry */
    const visit = entry=>{
        if (entry === null || entry === SYS)
        {
            return;
        }
        if (entry instanceof Group)
        {
            entry.entries.forEach(visit);
        }
        else if (entry instanceof ByMod)
        {
            visit(entry.memory);
            visit(entry.register);
        }
        else if (entry instanceof Prefixed)
        {
            Object.values(entry.variants).forEach(visit);
        }
        else
        {
            entry.forms.forEach(form=>forms.add(form));
        }
    };
    ONE_BYTE.forEach(visit);
    TWO_BYTE.forEach(visit);
    for (const map of X87)
    {
        map.mem.forEach(visit);
        Object.values(map.reg).forEach(visit);
    }
    return forms;
}
