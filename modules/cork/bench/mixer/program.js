/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A software sound mixer's inner loops, written here as x87 code in the shapes
 * a 32-bit mixer of 2005-2012 compiled to, and the same computation in
 * JavaScript to judge the translated run by.
 *
 * - `mix`: a channel matrix, out[o] += sum over c of in[c] * level[o][c], per
 *   sample: an accumulator kept on the x87 stack across a short inner loop
 *   over the input channels (1 to 6 turns), the loop counters of the two outer
 *   loops in memory (`dec dword [ebp-x]`).
 * - `reverb`: a per-sample body of a delay-line reverb: a gain ramp through
 *   `fild qword`, two allpass stages and eight damped combs, each a ring buffer
 *   whose index lives in its struct (`dec [m]; and mask; store`), a butterfly
 *   network that reloads its two array pointers from the struct before every
 *   operation (what a compiler without `restrict` emits), and a wet test
 *   through `fcomp; fnstsw ax; test ah, 0x44; jp`. The loop flags of the
 *   allpass loop are set by an integer `dec` and read by `jne` across x87 work.
 * - `biquad`: a direct-form-I filter per sample, its state in a struct, two of
 *   its words moved through integer registers, an `fdiv` by a0 per sample and
 *   an anti-denormal constant in a global whose sign flips every sample.
 * - `synth`: a 16-tap synthesis window per output sample, alternating
 *   `fsubp`/`faddp`, a store and reload through a float, `fistp` and a clamp
 *   to 16 bits.
 *
 * The control word is 0x27f, a Win32 thread's default: x87 arithmetic is
 * double, so the reference is exact in JavaScript doubles, rounded to float
 * where the guest stores a float.
 */

export const IMAGE_BASE = 0x401000;
export const DATA = 0x500000;
export const DATA_SIZE = 0x70000;
/** Samples a call of `main` processes, the block a mixer mixes at once. */
export const SAMPLES = 1024;
export const KERNELS = /** @type {const} */ (['mix', 'reverb', 'biquad', 'synth']);

const EAX = 0, ECX = 1, EDX = 2, EBX = 3, ESP = 4, EBP = 5, ESI = 6, EDI = 7;
/** jcc condition codes */
const JE = 4, JNE = 5, JLE = 0xe, JL = 0xc, JGE = 0xd, JP = 0xa;

// The data, at DATA + offset.
const DENORM = 0x0, SCALE = 0x4, CONTROL = 0x8;
const MIX_IN = 0x1000, MIX_LEVELS = 0x9000, MIX_OUT = 0xa000;
const RV = 0x10000, RV_IN = 0x20000, RV_OUT = 0x21000, RV_BUFFERS = 0x30000;
const BQ = 0x50000, BQ_IN = 0x51000, BQ_OUT = 0x52000;
const SY_WIN = 0x60000, SY_BUF = 0x61000, SY_OUT = 0x66000;
/** The input channels of each `mix` call: a mono, two stereo and a 5.1 source. */
const MIX_SOURCES = [1, 2, 2, 6];
const COMBS = 8, COMB_LENGTH = 2048, ALLPASSES = 2, ALLPASS_LENGTH = 1024;

/**
 * A memory operand: [base + index * scale + disp].
 * @typedef {{ base?: number, index?: number, scale?: number, disp?: number }} Mem
 */

/** A fixed-width i386 assembler: just the forms the routines below use, jumps always rel32. */
class Assembler {
    constructor(){
        /** @type {number[]} */
        this.bytes = [];
        /** @type {Map<string, number>} */
        this.labels = new Map();
        /** @type {{ at: number, label: string }[]} */
        this.fixups = [];
    }

    get here(){
        return IMAGE_BASE + this.bytes.length;
    }

    /** @param {...number} values */
    emit(...values){
        this.bytes.push(...values);
        return this;
    }

    /** @param {number} value */
    d32(value){
        return this.emit(value & 0xff, value >> 8 & 0xff, value >> 16 & 0xff, value >>> 24);
    }

    /** ModRM (and SIB, displacement) of `reg` and a register or memory operand. @param {number} reg @param {number | Mem} rm */
    modrm(reg, rm){
        if (typeof rm === 'number')
        {
            return this.emit(0xc0 | reg << 3 | rm);
        }
        const { base = -1, index = -1, scale = 1, disp = 0 } = rm;
        const ss = [1, 2, 4, 8].indexOf(scale);
        if (base < 0)
        {
            if (index < 0)
            {
                return this.emit(reg << 3 | 5).d32(disp);
            }
            return this.emit(reg << 3 | 4, ss << 6 | index << 3 | 5).d32(disp);
        }
        const mod = disp === 0 && base !== EBP ? 0 : disp >= -128 && disp < 128 ? 1 : 2;
        if (index >= 0 || base === ESP)
        {
            this.emit(mod << 6 | reg << 3 | 4, ss << 6 | (index < 0 ? 4 : index) << 3 | base);
        }
        else
        {
            this.emit(mod << 6 | reg << 3 | base);
        }
        return mod === 1 ? this.emit(disp & 0xff) : mod === 2 ? this.d32(disp) : this;
    }

    /** @param {string} name */
    label(name){
        this.labels.set(name, this.here);
        return this;
    }

    /** @param {number} cc @param {string} name */
    jcc(cc, name){
        this.emit(0x0f, 0x80 | cc);
        this.fixups.push({ at: this.bytes.length, label: name });
        return this.d32(0);
    }

    /** @param {string} name */
    jmp(name){
        this.emit(0xe9);
        this.fixups.push({ at: this.bytes.length, label: name });
        return this.d32(0);
    }

    /** @param {string} name */
    call(name){
        this.emit(0xe8);
        this.fixups.push({ at: this.bytes.length, label: name });
        return this.d32(0);
    }

    // Integer forms. `op` is the ALU row: add 0, or 1, and 4, sub 5, xor 6, cmp 7.
    /** @param {number} op @param {number} reg @param {number | Mem} rm  reg op= rm */
    alu(op, reg, rm){
        return this.emit(op << 3 | 3).modrm(reg, rm);
    }
    /** @param {number} op @param {Mem | number} rm @param {number} reg  rm op= reg */
    aluTo(op, rm, reg){
        return this.emit(op << 3 | 1).modrm(reg, rm);
    }
    /** @param {number} op @param {Mem | number} rm @param {number} value */
    aluImm(op, rm, value){
        return value >= -128 && value < 128 ? this.emit(0x83).modrm(op, rm).emit(value & 0xff)
            : this.emit(0x81).modrm(op, rm).d32(value);
    }
    /** @param {number} reg @param {Mem | number} rm */
    load(reg, rm){
        return this.emit(0x8b).modrm(reg, rm);
    }
    /** @param {Mem | number} rm @param {number} reg */
    store(rm, reg){
        return this.emit(0x89).modrm(reg, rm);
    }
    /** @param {number} reg @param {number} value */
    movImm(reg, value){
        return this.emit(0xb8 | reg).d32(value);
    }
    /** @param {Mem} rm @param {number} value */
    storeImm(rm, value){
        return this.emit(0xc7).modrm(0, rm).d32(value);
    }
    /** @param {number} reg @param {Mem} rm */
    lea(reg, rm){
        return this.emit(0x8d).modrm(reg, rm);
    }
    /** @param {Mem | number} rm */
    inc(rm){
        return typeof rm === 'number' ? this.emit(0x40 | rm) : this.emit(0xff).modrm(0, rm);
    }
    /** @param {Mem | number} rm */
    dec(rm){
        return typeof rm === 'number' ? this.emit(0x48 | rm) : this.emit(0xff).modrm(1, rm);
    }
    /** @param {number} reg @param {number} count */
    shl(reg, count){
        return this.emit(0xc1).modrm(4, reg).emit(count);
    }
    /** @param {number} left @param {number} right */
    test(left, right){
        return this.emit(0x85).modrm(right, left);
    }
    /** @param {number} reg */
    push(reg){
        return this.emit(0x50 | reg);
    }
    /** @param {number} value */
    pushImm(value){
        return this.emit(0x68).d32(value);
    }
    /** @param {number} reg */
    pop(reg){
        return this.emit(0x58 | reg);
    }
    /** @param {number} bytes */
    ret(bytes){
        return bytes === 0 ? this.emit(0xc3) : this.emit(0xc2, bytes & 0xff, bytes >> 8);
    }

    // x87 forms. A memory operand is a float unless named otherwise.
    /** @param {Mem} m */ fld(m){ return this.emit(0xd9).modrm(0, m); }
    /** @param {Mem} m */ fst(m){ return this.emit(0xd9).modrm(2, m); }
    /** @param {Mem} m */ fstp(m){ return this.emit(0xd9).modrm(3, m); }
    /** @param {Mem} m */ fldcw(m){ return this.emit(0xd9).modrm(5, m); }
    /** @param {Mem} m */ fadd(m){ return this.emit(0xd8).modrm(0, m); }
    /** @param {Mem} m */ fmul(m){ return this.emit(0xd8).modrm(1, m); }
    /** @param {Mem} m */ fcomp(m){ return this.emit(0xd8).modrm(3, m); }
    /** @param {Mem} m */ fsub(m){ return this.emit(0xd8).modrm(4, m); }
    /** @param {Mem} m */ fsubr(m){ return this.emit(0xd8).modrm(5, m); }
    /** @param {Mem} m */ fdiv(m){ return this.emit(0xd8).modrm(6, m); }
    /** @param {Mem} m */ fild32(m){ return this.emit(0xdb).modrm(0, m); }
    /** @param {Mem} m */ fild64(m){ return this.emit(0xdf).modrm(5, m); }
    /** @param {Mem} m */ fistp32(m){ return this.emit(0xdb).modrm(3, m); }
    /** st0 = st(i) @param {number} i */ fldSt(i){ return this.emit(0xd9, 0xc0 + i); }
    /** st(i) = st0, pop @param {number} i */ fstpSt(i){ return this.emit(0xdd, 0xd8 + i); }
    /** st0 += st(i) @param {number} i */ faddSt(i){ return this.emit(0xd8, 0xc0 + i); }
    /** st0 *= st(i) @param {number} i */ fmulSt(i){ return this.emit(0xd8, 0xc8 + i); }
    /** st(i) += st0, pop @param {number} i */ faddp(i){ return this.emit(0xde, 0xc0 + i); }
    /** st(i) = st(i) - st0, pop @param {number} i */ fsubp(i){ return this.emit(0xde, 0xe8 + i); }
    fldz(){ return this.emit(0xd9, 0xee); }
    fld1(){ return this.emit(0xd9, 0xe8); }
    fchs(){ return this.emit(0xd9, 0xe0); }
    fnstswAx(){ return this.emit(0xdf, 0xe0); }

    /** The code, its jumps placed. */
    finish(){
        const out = Uint8Array.from(this.bytes);
        const view = new DataView(out.buffer);
        for (const { at, label } of this.fixups)
        {
            const target = this.labels.get(label);
            if (target === undefined)
            {
                throw new Error(`mixer: no label ${label}`);
            }
            view.setInt32(at, target - (IMAGE_BASE + at + 4), true);
        }
        return out;
    }
}

/** @param {number} offset */
const abs = offset=>({ disp: DATA + offset });

/**
 * mix(in, out, samples, inChannels, outChannels), stdcall.
 * @param {Assembler} a
 */
function emitMix(a){
    a.label('mix').push(EBP).store(EBP, ESP).aluImm(5, ESP, 0x20)
        .push(EBX).push(ESI).push(EDI)
        .load(EDI, { base: EBP, disp: 8 })
        .load(EBX, { base: EBP, disp: 0xc })
        .load(EDX, { base: EBP, disp: 0x14 })
        .label('mix.sample')
        .load(EAX, { base: EBP, disp: 0x18 })
        .movImm(ESI, DATA + MIX_LEVELS)
        .store({ base: EBP, disp: -0x10 }, EAX)
        .label('mix.out')
        .fldz()
        .alu(6, EAX, EAX)
        .fld({ base: EBX })
        .store(ECX, ESI)
        .label('mix.in')
        .fld({ base: EDI, index: EAX, scale: 4 })
        .fmul({ base: ECX })
        .inc(EAX)
        .aluImm(0, ECX, 4)
        .alu(7, EAX, EDX)
        .faddp(2)
        .jcc(JL, 'mix.in')
        .faddSt(1)
        .aluImm(0, ESI, 0x40)
        .fstp({ base: EBX })
        .aluImm(0, EBX, 4)
        .dec({ base: EBP, disp: -0x10 })
        .fstpSt(0)
        .jcc(JNE, 'mix.out')
        .lea(EAX, { index: EDX, scale: 4 })
        .alu(0, EDI, EAX)
        .dec({ base: EBP, disp: 0x10 })
        .jcc(JNE, 'mix.sample')
        .pop(EDI).pop(ESI).pop(EBX).store(ESP, EBP).pop(EBP).ret(0x14);
}

/**
 * reverb(in, out, samples), stdcall; its state at RV.
 * @param {Assembler} a
 */
function emitReverb(a){
    const pairs = [
        [[0, 1], [2, 3], [4, 5], [6, 7]],
        [[0, 2], [1, 3], [4, 6], [5, 7]],
        [[0, 4], [1, 5], [2, 6], [3, 7]],
    ];
    a.label('reverb').push(EBP).store(EBP, ESP).aluImm(5, ESP, 0x40)
        .push(EBX).push(ESI).push(EDI)
        .movImm(ESI, DATA + RV)
        .load(EDI, { base: EBP, disp: 8 })
        .load(EAX, { base: EBP, disp: 0xc })
        .store({ base: EBP, disp: -0x14 }, EAX)
        .label('reverb.sample')
        // The input's gain, ramped: a counter made a float through a qword.
        .load(EAX, { base: ESI, disp: 0x10 })
        .store({ base: EBP, disp: -0x20 }, EAX)
        .aluImm(4, { base: EBP, disp: -0x1c }, 0)
        .fild64({ base: EBP, disp: -0x20 })
        .fmul({ base: ESI, disp: 8 })
        .fadd({ base: ESI, disp: 0xc })
        .fmul({ base: EDI })
        .test(EAX, EAX)
        .jcc(JE, 'reverb.ramped')
        .dec({ base: ESI, disp: 0x10 })
        .label('reverb.ramped')
        // Two allpass stages.
        .lea(EAX, { base: ESI, disp: 0x100 })
        .storeImm({ base: EBP, disp: -0x10 }, ALLPASSES)
        .label('reverb.allpass')
        .load(ECX, { base: EAX, disp: 4 })
        .load(EDX, { base: EAX, disp: 8 })
        .load(EBX, { base: EAX, disp: 0xc })
        .dec(ECX).alu(4, ECX, EBX)
        .dec(EDX).alu(4, EDX, EBX)
        .load(EBX, { base: EAX })
        .store({ base: EAX, disp: 4 }, ECX)
        .store({ base: EAX, disp: 8 }, EDX)
        .fldSt(0)
        .fmul({ base: ESI, disp: 0x1c })
        .aluImm(0, EAX, 0x20)
        .dec({ base: EBP, disp: -0x10 })
        .fsubr({ base: EBX, index: EDX, scale: 4 })
        .fst({ base: EBP, disp: -4 })
        .fmul({ base: ESI, disp: 0x1c })
        .faddSt(1)
        .fstp({ base: EBX, index: ECX, scale: 4 })
        .fstpSt(0)
        .fld({ base: EBP, disp: -4 })
        .jcc(JNE, 'reverb.allpass')
        // Eight damped combs, each tap kept for the network.
        .lea(EAX, { base: ESI, disp: 0x200 })
        .alu(6, EBX, EBX)
        .label('reverb.comb')
        .dec({ base: EAX, disp: 4 })
        .load(EDX, { base: EAX, disp: 4 })
        .alu(4, EDX, { base: EAX, disp: 8 })
        .store({ base: EAX, disp: 4 }, EDX)
        .load(ECX, { base: EAX })
        .fld({ base: ECX, index: EDX, scale: 4 })
        .emit(0x80).modrm(7, { base: EAX, disp: 0x18 }).emit(0)
        .jcc(JE, 'reverb.steady')
        // Modulated: a path the data never takes, there as a compiler leaves it.
        .fild32({ base: EAX, disp: 0x1c })
        .fmulSt(1)
        .faddp(1)
        .label('reverb.steady')
        .fld1()
        .fsub({ base: EAX, disp: 0x10 })
        .fmulSt(1)
        .fld({ base: EAX, disp: 0xc })
        .fmul({ base: EAX, disp: 0x10 })
        .faddp(1)
        .fst({ base: EAX, disp: 0xc })
        .fmul({ base: EAX, disp: 0x14 })
        .faddSt(2)
        .fstp({ base: ECX, index: EDX, scale: 4 })
        .load(ECX, { base: ESI, disp: 0x24 })
        .fstp({ base: ECX, index: EBX, scale: 4 })
        .aluImm(0, EAX, 0x20)
        .inc(EBX)
        .alu(7, EBX, { base: ESI, disp: 0x18 })
        .jcc(JL, 'reverb.comb')
        .fld({ base: ESI, disp: 0x14 });
    // The network: both pointers read from the struct again before each use.
    pairs.forEach((stage, at)=>{
        const [from, to] = at % 2 === 0 ? [0x24, 0x28] : [0x28, 0x24];
        for (const [i, j] of stage)
        {
            a.load(EAX, { base: ESI, disp: from }).fldSt(0).fmul({ base: EAX, disp: j * 4 })
                .fadd({ base: EAX, disp: i * 4 })
                .load(EAX, { base: ESI, disp: to }).fstp({ base: EAX, disp: i * 4 })
                .load(EAX, { base: ESI, disp: from }).fldSt(0).fmul({ base: EAX, disp: i * 4 })
                .fsubr({ base: EAX, disp: j * 4 })
                .load(EAX, { base: ESI, disp: to }).fstp({ base: EAX, disp: j * 4 });
        }
    });
    a.fstpSt(0)
        // Two output channels, four taps each, wet and dry.
        .load(ECX, { base: ESI, disp: 0x28 })
        .load(EDX, { base: EBP, disp: -0x14 })
        .storeImm({ base: EBP, disp: -0x18 }, 2)
        .label('reverb.channel')
        .fldz()
        .storeImm({ base: EBP, disp: -0x20 }, 4)
        .label('reverb.tap')
        .fadd({ base: ECX })
        .aluImm(0, ECX, 4)
        .dec({ base: EBP, disp: -0x20 })
        .jcc(JNE, 'reverb.tap')
        .fld({ base: ESI })
        .fcomp({ base: ESI, disp: 0x20 })
        .fnstswAx()
        .emit(0xf6, 0xc4, 0x44)
        .jcc(JP, 'reverb.scaled')
        .fldSt(1).fmul({ base: ESI, disp: 4 }).faddp(1)
        .jmp('reverb.mixed')
        .label('reverb.scaled')
        .fmul({ base: ESI })
        .fldSt(1).fmul({ base: ESI, disp: 4 }).faddp(1)
        .label('reverb.mixed')
        .fstp({ base: EDX })
        .aluImm(0, EDX, 4)
        .dec({ base: EBP, disp: -0x18 })
        .jcc(JNE, 'reverb.channel')
        .fstpSt(0)
        .store({ base: EBP, disp: -0x14 }, EDX)
        .aluImm(0, EDI, 4)
        .dec({ base: EBP, disp: 0x10 })
        .jcc(JNE, 'reverb.sample')
        .pop(EDI).pop(ESI).pop(EBX).store(ESP, EBP).pop(EBP).ret(0xc);
}

/**
 * biquad(in, out, samples), stdcall; its state at BQ.
 * @param {Assembler} a
 */
function emitBiquad(a){
    a.label('biquad').push(EBP).store(EBP, ESP).push(EBX).push(ESI)
        .movImm(ESI, DATA + BQ)
        .load(EAX, { base: EBP, disp: 0xc })
        .load(EBX, { base: EBP, disp: 8 })
        .alu(5, EBX, EAX)
        .load(ECX, { base: EBP, disp: 0x10 })
        .label('biquad.sample')
        .fld(abs(DENORM))
        .fadd({ base: EBX, index: EAX, scale: 1 })
        .load(EDX, { base: ESI, disp: 0x18 })
        .fldSt(0)
        .fmul({ base: ESI })
        .fld({ base: ESI, disp: 4 })
        .fmul({ base: ESI, disp: 0x18 })
        .faddp(1)
        .fld({ base: ESI, disp: 0x1c })
        .fmul({ base: ESI, disp: 8 })
        .store({ base: ESI, disp: 0x1c }, EDX)
        .load(EDX, { base: ESI, disp: 0x20 })
        .faddp(1)
        .fld({ base: ESI, disp: 0x20 })
        .fmul({ base: ESI, disp: 0xc })
        .fsubp(1)
        .fld({ base: ESI, disp: 0x24 })
        .fmul({ base: ESI, disp: 0x10 })
        .store({ base: ESI, disp: 0x24 }, EDX)
        .fsubp(1)
        .fdiv({ base: ESI, disp: 0x14 })
        .fldSt(1)
        .fstp({ base: ESI, disp: 0x18 })
        .fst({ base: ESI, disp: 0x20 })
        .fstp({ base: EAX })
        .aluImm(0, EAX, 4)
        .dec(ECX)
        .fstpSt(0)
        .fld(abs(DENORM))
        .fchs()
        .fstp(abs(DENORM))
        .jcc(JNE, 'biquad.sample')
        .pop(ESI).pop(EBX).pop(EBP).ret(0xc);
}

/**
 * synth(window, buffer, out), stdcall: 16 output samples, each 16 taps.
 * @param {Assembler} a
 */
function emitSynth(a){
    a.label('synth').push(EBP).store(EBP, ESP).aluImm(5, ESP, 0x10)
        .push(EBX).push(ESI).push(EDI)
        .load(EAX, { base: EBP, disp: 8 })
        .load(ECX, { base: EBP, disp: 0xc })
        .load(EDX, { base: EBP, disp: 0x10 })
        .movImm(EDI, 0x7fff)
        .movImm(EBX, 0x80)
        .storeImm({ base: EBP, disp: -8 }, 16)
        .label('synth.sample')
        .fld({ base: ECX }).fmul({ base: EAX });
    for (let k = 1; k < 16; k++)
    {
        a.fld({ base: ECX, disp: k * 4 }).fmul({ base: EAX, disp: k * 4 });
        if (k % 2 === 1)
        {
            a.fsubp(1);
        }
        else
        {
            a.faddp(1);
        }
    }
    a.fmul(abs(SCALE))
        .fstp({ base: EBP, disp: -4 })
        .fld({ base: EBP, disp: -4 })
        .fistp32({ base: EBP, disp: -0xc })
        .aluTo(7, { base: EBP, disp: -0xc }, EDI)
        .jcc(JLE, 'synth.below')
        .store({ base: EBP, disp: -0xc }, EDI)
        .label('synth.below')
        .aluImm(7, { base: EBP, disp: -0xc }, -0x8000)
        .jcc(JGE, 'synth.above')
        .storeImm({ base: EBP, disp: -0xc }, 0x8000)
        .label('synth.above')
        .emit(0x66).load(ESI, { base: EBP, disp: -0xc })
        .aluImm(0, EAX, 0x40)
        .emit(0x66).store({ base: EDX }, ESI)
        .aluImm(0, EDX, 4)
        .alu(0, ECX, EBX)
        .dec({ base: EBP, disp: -8 })
        .jcc(JNE, 'synth.sample')
        .pop(EDI).pop(ESI).pop(EBX).store(ESP, EBP).pop(EBP).ret(0xc);
}

/**
 * The image: `_start` sets the control word and calls `main`, which runs the
 * kernels named once over a block of SAMPLES, then halts; the next run goes on
 * from the halt into `_start` again.
 *
 * @param {readonly string[]} kernels
 */
export function assemble(kernels){
    const a = new Assembler();
    a.label('start').fldcw(abs(CONTROL)).call('main').emit(0xf4).jmp('start');
    a.label('main');
    if (kernels.includes('mix'))
    {
        for (const channels of MIX_SOURCES)
        {
            a.pushImm(2).pushImm(channels).pushImm(SAMPLES).pushImm(DATA + MIX_OUT)
                .pushImm(DATA + MIX_IN).call('mix');
        }
    }
    if (kernels.includes('reverb'))
    {
        a.pushImm(SAMPLES).pushImm(DATA + RV_OUT).pushImm(DATA + RV_IN).call('reverb');
    }
    if (kernels.includes('biquad'))
    {
        a.pushImm(SAMPLES).pushImm(DATA + BQ_OUT).pushImm(DATA + BQ_IN).call('biquad');
    }
    if (kernels.includes('synth'))
    {
        a.alu(6, ESI, ESI)
            .label('main.synth')
            .store(EAX, ESI).aluImm(4, EAX, 7).shl(EAX, 11).aluImm(0, EAX, DATA + SY_BUF)
            .store(ECX, ESI).shl(ECX, 6).aluImm(0, ECX, DATA + SY_OUT)
            .push(ECX).push(EAX).pushImm(DATA + SY_WIN).call('synth')
            .inc(ESI).aluImm(7, ESI, SAMPLES / 16).jcc(JL, 'main.synth');
    }
    a.ret(0);
    emitMix(a);
    emitReverb(a);
    emitBiquad(a);
    emitSynth(a);
    return a.finish();
}

/** @param {number} seed */
function random(seed){
    let state = seed >>> 0;
    return ()=>{
        state = (Math.imul(state, 1103515245) + 12345) >>> 0;
        return (state >>> 8) / 0x1000000 * 2 - 1;
    };
}

/** The data the program starts from, DATA_SIZE bytes to lie at DATA. */
export function initialData(){
    const bytes = new Uint8Array(DATA_SIZE);
    const view = new DataView(bytes.buffer);
    const f32 = (/** @type {number} */ at, /** @type {number} */ value)=>view.setFloat32(at, value, true);
    const u32 = (/** @type {number} */ at, /** @type {number} */ value)=>view.setUint32(at, value, true);
    const next = random(0x5eed);
    f32(DENORM, 1e-20);
    f32(SCALE, 90000);
    view.setUint16(CONTROL, 0x27f, true);
    for (let i = 0; i < SAMPLES * 8; i++)
    {
        f32(MIX_IN + i * 4, next());
    }
    for (let o = 0; o < 2; o++)
    {
        for (let c = 0; c < 16; c++)
        {
            f32(MIX_LEVELS + o * 0x40 + c * 4, (next() + 1) * 0.25);
        }
    }
    // The reverb: wet, dry, ramp step and target, ramp, network coefficient,
    // combs, allpass gain, 1.0 for the wet test, the tap and work arrays.
    f32(RV, 0.5);
    f32(RV + 4, 0.7);
    f32(RV + 8, 1 / 4096);
    f32(RV + 0xc, 0.8);
    u32(RV + 0x10, 3000);
    f32(RV + 0x14, 0.6);
    u32(RV + 0x18, COMBS);
    f32(RV + 0x1c, 0.5);
    f32(RV + 0x20, 1);
    u32(RV + 0x24, DATA + RV + 0x40);
    u32(RV + 0x28, DATA + RV + 0x60);
    for (let j = 0; j < ALLPASSES; j++)
    {
        const at = RV + 0x100 + j * 0x20;
        u32(at, DATA + RV_BUFFERS + j * ALLPASS_LENGTH * 4);
        u32(at + 4, 0);
        u32(at + 8, 225 + j * 331);
        u32(at + 0xc, ALLPASS_LENGTH - 1);
    }
    for (let k = 0; k < COMBS; k++)
    {
        const at = RV + 0x200 + k * 0x20;
        u32(at, DATA + RV_BUFFERS + ALLPASSES * ALLPASS_LENGTH * 4 + k * COMB_LENGTH * 4);
        u32(at + 4, 1116 + k * 61);
        u32(at + 8, COMB_LENGTH - 1);
        f32(at + 0xc, 0);
        f32(at + 0x10, 0.2 + k * 0.025);
        f32(at + 0x14, 0.84 - k * 0.01);
        u32(at + 0x1c, 3);
    }
    for (let i = 0; i < SAMPLES; i++)
    {
        f32(RV_IN + i * 4, next() * 0.5);
        f32(BQ_IN + i * 4, next());
    }
    // A low-pass biquad with a0 left unnormalised, so the fdiv does something.
    [0.0675, 0.135, 0.0675, -1.143, 0.413, 1.25].forEach((value, i)=>f32(BQ + i * 4, value));
    for (let i = 0; i < 16 * 16; i++)
    {
        f32(SY_WIN + i * 4, next() * 0.2);
    }
    for (let i = 0; i < 8 * 16 * 32; i++)
    {
        f32(SY_BUF + i * 4, next());
    }
    return bytes;
}

/** Rounds to the nearest integer, ties to even: `fistp` under the default control word. @param {number} value */
function roundEven(value){
    const floor = Math.floor(value);
    const rest = value - floor;
    return rest > 0.5 || (rest === 0.5 && floor % 2 !== 0) ? floor + 1 : floor;
}

/**
 * One call of `main` on `bytes` (DATA's contents), as the guest computes it.
 *
 * @param {Uint8Array} bytes
 * @param {readonly string[]} kernels
 */
export function reference(bytes, kernels){
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const f = (/** @type {number} */ at)=>view.getFloat32(at, true);
    const setF = (/** @type {number} */ at, /** @type {number} */ value)=>view.setFloat32(at, value, true);
    const u = (/** @type {number} */ at)=>view.getUint32(at, true);
    const setU = (/** @type {number} */ at, /** @type {number} */ value)=>view.setUint32(at, value >>> 0, true);
    /** A guest pointer as an offset into DATA. @param {number} at */
    const p = at=>u(at) - DATA;
    if (kernels.includes('mix'))
    {
        for (const channels of MIX_SOURCES)
        {
            for (let s = 0; s < SAMPLES; s++)
            {
                for (let o = 0; o < 2; o++)
                {
                    const out = MIX_OUT + (s * 2 + o) * 4;
                    let sum = 0;
                    for (let c = 0; c < channels; c++)
                    {
                        sum += f(MIX_IN + (s * channels + c) * 4)
                            * f(MIX_LEVELS + o * 0x40 + c * 4);
                    }
                    setF(out, f(out) + sum);
                }
            }
        }
    }
    if (kernels.includes('reverb'))
    {
        for (let s = 0; s < SAMPLES; s++)
        {
            const ramp = u(RV + 0x10);
            let x = (ramp * f(RV + 8) + f(RV + 0xc)) * f(RV_IN + s * 4);
            if (ramp !== 0)
            {
                setU(RV + 0x10, ramp - 1);
            }
            const g = f(RV + 0x1c);
            for (let j = 0; j < ALLPASSES; j++)
            {
                const at = RV + 0x100 + j * 0x20;
                const mask = u(at + 0xc);
                const w = u(at + 4) - 1 & mask;
                const r = u(at + 8) - 1 & mask;
                setU(at + 4, w);
                setU(at + 8, r);
                const buffer = p(at);
                const y = f(buffer + r * 4) - x * g;
                setF(buffer + w * 4, y * g + x);
                x = Math.fround(y);
            }
            const taps = p(RV + 0x24);
            for (let k = 0; k < COMBS; k++)
            {
                const at = RV + 0x200 + k * 0x20;
                const index = u(at + 4) - 1 & u(at + 8);
                setU(at + 4, index);
                const tap = p(at) + index * 4;
                const y = f(tap);
                const damp = f(at + 0x10);
                const low = (1 - damp) * y + f(at + 0xc) * damp;
                setF(at + 0xc, low);
                setF(tap, low * f(at + 0x14) + x);
                setF(taps + k * 4, y);
            }
            const c = f(RV + 0x14);
            for (let stage = 0; stage < 3; stage++)
            {
                const [from, to] = stage % 2 === 0 ? [p(RV + 0x24), p(RV + 0x28)]
                    : [p(RV + 0x28), p(RV + 0x24)];
                const span = 1 << stage;
                for (let i = 0; i < 8; i++)
                {
                    if ((i & span) !== 0)
                    {
                        continue;
                    }
                    const j = i + span;
                    setF(to + i * 4, c * f(from + j * 4) + f(from + i * 4));
                    setF(to + j * 4, f(from + j * 4) - c * f(from + i * 4));
                }
            }
            const work = p(RV + 0x28);
            const wet = f(RV), dry = f(RV + 4);
            for (let ch = 0; ch < 2; ch++)
            {
                let sum = 0;
                for (let t = 0; t < 4; t++)
                {
                    sum += f(work + (ch * 4 + t) * 4);
                }
                setF(RV_OUT + (s * 2 + ch) * 4, (wet === f(RV + 0x20) ? sum : sum * wet) + x * dry);
            }
        }
    }
    if (kernels.includes('biquad'))
    {
        const [b0, b1, b2, a1, a2, a0] = [0, 4, 8, 0xc, 0x10, 0x14].map(at=>f(BQ + at));
        for (let s = 0; s < SAMPLES; s++)
        {
            const x = f(DENORM) + f(BQ_IN + s * 4);
            const [x1, x2, y1, y2] = [0x18, 0x1c, 0x20, 0x24].map(at=>f(BQ + at));
            const y = (x * b0 + b1 * x1 + x2 * b2 - y1 * a1 - y2 * a2) / a0;
            view.setUint32(BQ + 0x1c, u(BQ + 0x18), true);
            view.setUint32(BQ + 0x24, u(BQ + 0x20), true);
            setF(BQ + 0x18, x);
            setF(BQ + 0x20, y);
            setF(BQ_OUT + s * 4, y);
            setF(DENORM, -f(DENORM));
        }
    }
    if (kernels.includes('synth'))
    {
        for (let call = 0; call < SAMPLES / 16; call++)
        {
            const buffer = SY_BUF + (call & 7) * 0x800;
            for (let n = 0; n < 16; n++)
            {
                let sum = f(buffer + n * 0x80) * f(SY_WIN + n * 0x40);
                for (let k = 1; k < 16; k++)
                {
                    const term = f(buffer + n * 0x80 + k * 4) * f(SY_WIN + n * 0x40 + k * 4);
                    sum = k % 2 === 1 ? sum - term : sum + term;
                }
                const value = roundEven(Math.fround(sum * f(SCALE)));
                const clamped = value > 0x7fff ? 0x7fff : value < -0x8000 ? 0x8000 : value;
                view.setUint16(SY_OUT + (call * 16 + n) * 4, clamped & 0xffff, true);
            }
        }
    }
}
