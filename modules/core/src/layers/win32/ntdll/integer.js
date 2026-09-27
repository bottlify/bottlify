/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The 64-bit helpers a 32-bit compiler calls instead of emitting the arithmetic.
 *
 * A `long long` multiply, divide or remainder is a function call on this target,
 * and the compiler writes that call itself -- so the convention is the
 * compiler's, not one anybody chose or can look up in a header. Two things about
 * it are settled by what the call site does:
 *
 * - Both operands are pushed as two words each, low half first, so the argument
 *   list is sixteen bytes.
 * - Nothing adjusts the stack pointer after the CALL, so the callee pops all
 *   sixteen. That is stdcall's rule, and it is why these are declared with the
 *   same argBytes a stdcall function would use despite being spelled like C.
 *
 * The result is a 64-bit value, which on this processor means EDX:EAX; the
 * `dvrm` forms answer the remainder in EBX:ECX as well, EBX not kept. The
 * shifts take their operand in EDX:EAX and their count in CL and pop nothing.
 *
 * Each is code in the guest's own ntdll, assembled by hand below -- the
 * compiler's subset has no 64-bit integers, nor `mul` and `div` -- so a
 * program's `long long` arithmetic costs its instructions, not a crossing;
 * a division by zero faults in the guest, as the processor's `div` does. The
 * handlers beside the code are the same arithmetic in BigInts, for a host
 * that calls them directly, and what the code is tested against.
 */

import { assemble } from '../msvcrt/guest-code.js';

/**
 * The operands as the helpers find them once they have saved EBX, ESI, EDI
 * and EBP: `[esp+20]` a's low word ... `[esp+32]` b's high one.
 */
const A_LOW = 20;
const A_HIGH = 24;
const B_LOW = 28;
const B_HIGH = 32;

/**
 * The ModRM, SIB and displacement of a register and `[esp+disp8]`.
 *
 * @param {number} reg @param {number} disp
 */
const stackSlot = (reg, disp)=>[0x44 | reg << 3, 0x24, disp];

const EAX = 0;
const ECX = 1;
const EDX = 2;
const EBX = 3;
const ESI = 6;
const EDI = 7;

/** `mov reg, [esp+disp]` @param {number} reg @param {number} disp */
const load = (reg, disp)=>[0x8b, ...stackSlot(reg, disp)];
/** `mov [esp+disp], reg` @param {number} disp @param {number} reg */
const store = (disp, reg)=>[0x89, ...stackSlot(reg, disp)];
/** `neg hi; neg lo; sbb hi, 0`: a 64-bit negation. @param {number} high @param {number} low */
const negate = (high, low)=>[0xf7, 0xd8 | high, 0xf7, 0xd8 | low, 0x83, 0xd8 | high, 0x00];

/**
 * A division: `signed` reads its operands as two's complement (the
 * quotient's sign theirs apart, the remainder's the dividend's); `answer`
 * says what EDX:EAX holds, the quotient, the remainder, or the quotient with
 * the remainder in EBX:ECX too.
 *
 * The unsigned core: a divisor of one word divides the high word and then
 * the remainder with the low; a longer one is shifted right with the
 * dividend until it fits a word, the one `div` estimates the quotient, which
 * is exact or one too large -- one too large where the product with the
 * divisor passes the dividend (or 2^64) -- and the remainder is the dividend
 * less that product.
 *
 * @param {{ signed: boolean, answer: 'quotient' | 'remainder' | 'both' }} kind
 */
function divisionCode({ signed, answer }){
    const remainder = answer !== 'quotient';
    return assemble([
        [0x53, 0x56, 0x57, 0x55],                                     // push ebx, esi, edi, ebp
        ...signed ? [
            [0x31, 0xed],                                             // xor ebp, ebp: the signs
            load(EAX, A_HIGH), [0x85, 0xc0],                          // test eax, eax
            { jump: [0x79], to: 'a', short: true },                   // jns
            [0xbd, 3, 0, 0, 0],                                       // mov ebp, 3: both negative
            load(EDX, A_LOW), negate(EAX, EDX), store(A_HIGH, EAX), store(A_LOW, EDX),
            'a',
            load(EAX, B_HIGH), [0x85, 0xc0],
            { jump: [0x79], to: 'b', short: true },
            [0x83, 0xf5, 0x01],                                       // xor ebp, 1: the quotient's
            load(EDX, B_LOW), negate(EAX, EDX), store(B_HIGH, EAX), store(B_LOW, EDX),
            'b',
        ] : [],
        load(EAX, B_HIGH), [0x85, 0xc0],                              // test eax, eax
        { jump: [0x0f, 0x85], to: 'long' },                           // jnz
        load(ECX, B_LOW), load(EAX, A_HIGH), [0x31, 0xd2],            // xor edx, edx
        [0xf7, 0xf1],                                                 // div ecx: the high word
        [0x89, 0xc7],                                                 // mov edi, eax
        load(EAX, A_LOW), [0xf7, 0xf1],                               // div ecx: the low word
        [0x89, 0xc6],                                                 // mov esi, eax
        [0x89, 0xd1, 0x31, 0xdb],                                     // mov ecx, edx; xor ebx, ebx
        { jump: [0xe9], to: 'signs' },
        'long',
        [0x89, 0xc1],                                                 // mov ecx, eax
        load(EBX, B_LOW), load(EDX, A_HIGH), load(EAX, A_LOW),
        'shift',
        [0xd1, 0xe9, 0xd1, 0xdb, 0xd1, 0xea, 0xd1, 0xd8],  // shr ecx; rcr ebx; shr edx; rcr eax
        [0x85, 0xc9],                                                 // test ecx, ecx
        { jump: [0x75], to: 'shift', short: true },
        [0xf7, 0xf3],                                                 // div ebx: the estimate
        [0x89, 0xc6],                                                 // mov esi, eax
        [0xf7, 0x64, 0x24, B_HIGH],                                   // mul dword [esp+B_HIGH]
        [0x85, 0xd2],                                                 // test edx, edx
        { jump: [0x75], to: 'over', short: true },
        [0x89, 0xc1],                                                 // mov ecx, eax
        load(EAX, B_LOW), [0xf7, 0xe6],                               // mul esi
        [0x01, 0xca],                                                 // add edx, ecx
        { jump: [0x72], to: 'over', short: true },                    // jc
        [0x3b, ...stackSlot(EDX, A_HIGH)],                            // cmp edx, a's high
        { jump: [0x77], to: 'over', short: true },                    // ja
        { jump: [0x72], to: 'fits', short: true },                    // jb
        [0x3b, ...stackSlot(EAX, A_LOW)],                             // cmp eax, a's low
        { jump: [0x76], to: 'fits', short: true },                    // jbe
        'over',
        [0x4e],                                                       // dec esi
        'fits',
        [0x31, 0xff],                                                 // xor edi, edi
        ...remainder ? [
            load(EAX, B_HIGH), [0xf7, 0xe6],                          // mul esi
            [0x89, 0xc1],                                             // mov ecx, eax
            load(EAX, B_LOW), [0xf7, 0xe6],                           // mul esi
            [0x01, 0xca],                                             // add edx, ecx
            load(ECX, A_LOW), load(EBX, A_HIGH),
            [0x29, 0xc1, 0x19, 0xd3],                                 // sub ecx, eax; sbb ebx, edx
        ] : [],
        'signs',
        ...signed ? [
            [0xf7, 0xc5, 1, 0, 0, 0],                                 // test ebp, 1
            { jump: [0x74], to: 'positive', short: true },            // jz
            negate(EDI, ESI),
            'positive',
            ...remainder ? [
                [0xf7, 0xc5, 2, 0, 0, 0],                             // test ebp, 2
                { jump: [0x74], to: 'kept', short: true },
                negate(EBX, ECX),
                'kept',
            ] : [],
        ] : [],
        answer === 'remainder' ? [0x89, 0xc8, 0x89, 0xda]             // mov eax, ecx; mov edx, ebx
            : [0x89, 0xf0, 0x89, 0xfa],                               // mov eax, esi; mov edx, edi
        [0x5d, 0x5f, 0x5e],                                           // pop ebp, edi, esi
        answer === 'both' ? [0x83, 0xc4, 0x04] : [0x5b],              // EBX answered, or popped
        [0xc2, 16, 0],                                                // ret 16
    ]);
}

/**
 * `_allmul`: the low 64 bits of the product, one multiply when both high
 * words are zero, three otherwise.
 */
const MULTIPLY_CODE = assemble([
    [0x8b, 0x44, 0x24, 0x08, 0x8b, 0x4c, 0x24, 0x10],                 // eax = a hi; ecx = b hi
    [0x09, 0xc1],                                                     // or ecx, eax
    [0x8b, 0x4c, 0x24, 0x0c],                                         // mov ecx, b lo
    { jump: [0x75], to: 'long', short: true },
    [0x8b, 0x44, 0x24, 0x04, 0xf7, 0xe1],                             // mov eax, a lo; mul ecx
    [0xc2, 16, 0],
    'long',
    [0x53],                                                           // push ebx
    [0xf7, 0xe1, 0x89, 0xc3],                                         // mul ecx; mov ebx, eax
    [0x8b, 0x44, 0x24, 0x08, 0xf7, 0x64, 0x24, 0x14],                 // mov eax, a lo; mul b hi
    [0x01, 0xc3],                                                     // add ebx, eax
    [0x8b, 0x44, 0x24, 0x08, 0xf7, 0xe1],                             // mov eax, a lo; mul ecx
    [0x01, 0xda],                                                     // add edx, ebx
    [0x5b, 0xc2, 16, 0],                                              // pop ebx; ret 16
]);

/**
 * A shift of EDX:EAX by CL: `left`, or right with the sign (`arithmetic`) or
 * with zeros. A count of 64 or more leaves nothing but the sign; one of 32
 * or more moves a word across and shifts it by the rest.
 *
 * @param {'left' | 'arithmetic' | 'logical'} kind
 */
function shiftCode(kind){
    const past = kind === 'arithmetic'
        ? [0xc1, 0xfa, 0x1f, 0x89, 0xd0, 0xc3]                        // sar edx, 31; mov eax, edx
        : [0x31, 0xc0, 0x31, 0xd2, 0xc3];                             // xor eax, eax; xor edx, edx
    const across = kind === 'left'
        ? [0x89, 0xc2, 0x31, 0xc0, 0x80, 0xe1, 0x1f, 0xd3, 0xe2, 0xc3] // edx = eax << cl; eax = 0
        : kind === 'arithmetic'
            ? [0x89, 0xd0, 0xc1, 0xfa, 0x1f, 0x80, 0xe1, 0x1f, 0xd3, 0xf8, 0xc3]
            : [0x89, 0xd0, 0x31, 0xd2, 0x80, 0xe1, 0x1f, 0xd3, 0xe8, 0xc3];
    const within = kind === 'left'
        ? [0x0f, 0xa5, 0xc2, 0xd3, 0xe0, 0xc3]                        // shld edx, eax; shl eax
        : [0x0f, 0xad, 0xd0, 0xd3, kind === 'arithmetic' ? 0xfa : 0xea, 0xc3]; // shrd; sar/shr edx
    return assemble([
        [0x80, 0xf9, 0x40],                                           // cmp cl, 64
        { jump: [0x73], to: 'past', short: true },                    // jae
        [0x80, 0xf9, 0x20],                                           // cmp cl, 32
        { jump: [0x73], to: 'across', short: true },
        within,
        'across',
        across,
        'past',
        past,
    ]);
}

/**
 * The code of each helper, by name: what a program's call runs.
 *
 * @type {Readonly<Record<string, Uint8Array>>}
 */
export const INTEGER_CODE = Object.freeze({
    _allmul: MULTIPLY_CODE,
    _alldiv: divisionCode({ signed: true, answer: 'quotient' }),
    _allrem: divisionCode({ signed: true, answer: 'remainder' }),
    _alldvrm: divisionCode({ signed: true, answer: 'both' }),
    _aulldiv: divisionCode({ signed: false, answer: 'quotient' }),
    _aullrem: divisionCode({ signed: false, answer: 'remainder' }),
    _aulldvrm: divisionCode({ signed: false, answer: 'both' }),
    _allshl: shiftCode('left'),
    _allshr: shiftCode('arithmetic'),
    _aullshr: shiftCode('logical'),
});

/**
 * @typedef {Object} IntegerHost
 * @property {(values: Record<string, number>) => void} setRegisters
 */

/**
 * Builds the arithmetic half of the table: name -> { argBytes, handler }.
 *
 * @param {IntegerHost} host
 */
export function createIntegerFunctions(host){
    /**
     * One operand: two argument slots, low half first. The slots arrive signed,
     * so each has to be read back as the unsigned word it was on the stack
     * before the halves are joined.
     *
     * @param {number[]} args @param {number} slot
     */
    const operand = (args, slot)=>
        BigInt(args[slot] >>> 0) | BigInt(args[slot + 1] >>> 0) << 32n;

    /**
     * Places a 64-bit answer where the caller reads it from.
     *
     * @param {bigint} value
     * @returns {number} the low half, for the dispatcher to put in EAX
     */
    const wide = value=>{
        const bits = BigInt.asUintN(64, value);
        host.setRegisters({ edx: Number(bits >> 32n) });
        return Number(bits & 0xffffffffn);
    };

    /**
     * Dividing by zero traps on the processor, and this is the routine the trap
     * would have come from. There is no divisor to substitute that would not be
     * an answer the program never computed, so the failure is reported.
     *
     * @param {string} name @param {bigint} divisor
     */
    const nonZero = (name, divisor)=>{
        if (divisor === 0n)
        {
            throw new Error(`${name}: the guest divided a 64-bit value by zero`);
        }
        return divisor;
    };

    /**
     * @param {string} name
     * @param {(a: bigint, b: bigint) => bigint} arithmetic
     * @param {boolean} signed
     */
    const binary = (name, arithmetic, signed)=>({
        argBytes: 16,
        code: ()=>INTEGER_CODE[name],
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ args)=>{
            const a = operand(args, 0);
            const b = operand(args, 2);
            return wide(signed
                ? arithmetic(BigInt.asIntN(64, a), BigInt.asIntN(64, b))
                : arithmetic(a, b));
        },
    });

    /**
     * A division answering both: the quotient in EDX:EAX, the remainder in
     * EBX:ECX.
     *
     * @param {string} name @param {boolean} signed
     */
    const both = (name, signed)=>({
        argBytes: 16,
        code: ()=>INTEGER_CODE[name],
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ args)=>{
            const a = signed ? BigInt.asIntN(64, operand(args, 0)) : operand(args, 0);
            const divisor = operand(args, 2);
            const b = nonZero(name, signed ? BigInt.asIntN(64, divisor) : divisor);
            const rest = BigInt.asUintN(64, a % b);
            host.setRegisters({ ebx: Number(rest >> 32n), ecx: Number(rest & 0xffffffffn) });
            return wide(a / b);
        },
    });

    /**
     * A shift: its operand in EDX:EAX and its count in CL, which no handler
     * is passed -- so the code alone, which reads them where the caller left
     * them, and a handler that says so.
     *
     * @param {string} name
     */
    const shift = name=>({
        argBytes: 0,
        code: ()=>INTEGER_CODE[name],
        handler: ()=>{
            throw new Error(`${name} shifts EDX:EAX by CL, which only its code reads`);
        },
    });

    return {
        /**
         * __int64 _allmul(__int64 a, __int64 b)
         *
         * One multiply for both signednesses, because the low 64 bits of the
         * product are the same either way -- which is why the compiler emits this
         * for a signed and an unsigned multiply alike.
         */
        _allmul: binary('_allmul', (a, b)=>a * b, false),

        /**
         * __int64 _alldiv(__int64 a, __int64 b)
         *
         * BigInt division truncates towards zero and its remainder takes the sign
         * of the dividend, which is what C requires of both.
         */
        _alldiv: binary('_alldiv', (a, b)=>a / nonZero('_alldiv', b), true),

        /** __int64 _allrem(__int64 a, __int64 b) */
        _allrem: binary('_allrem', (a, b)=>a % nonZero('_allrem', b), true),

        /** unsigned __int64 _aulldiv(unsigned __int64 a, unsigned __int64 b) */
        _aulldiv: binary('_aulldiv', (a, b)=>a / nonZero('_aulldiv', b), false),

        /** unsigned __int64 _aullrem(unsigned __int64 a, unsigned __int64 b) */
        _aullrem: binary('_aullrem', (a, b)=>a % nonZero('_aullrem', b), false),

        /** _alldvrm and _aulldvrm: the quotient in EDX:EAX, the remainder in EBX:ECX. */
        _alldvrm: both('_alldvrm', true),
        _aulldvrm: both('_aulldvrm', false),

        /** EDX:EAX shifted left, right with the sign, or right with zeros, by CL. */
        _allshl: shift('_allshl'),
        _allshr: shift('_allshr'),
        _aullshr: shift('_aullshr'),
    };
}
