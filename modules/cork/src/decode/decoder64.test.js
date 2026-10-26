/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The decoder in long mode, judged by LLVM's disassembler on code a compiler
 * and an assembler made (`x64-objdump.txt.gz`, built by
 * `tools/x64-decode-fixture.mjs`): for every instruction shape, the length,
 * the mnemonic and each operand -- registers by name, memory by base, index,
 * scale and displacement (RIP-relative by its absolute target), immediates
 * by value at the operand's width.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { MODE_64, REGISTERS64, decode } from './decoder.js';

const FIXTURE = gunzipSync(readFileSync(new URL('./x64-objdump.txt.gz', import.meta.url)))
    .toString('utf8').trim().split('\n');

const LOW8 = ['al', 'cl', 'dl', 'bl', 'spl', 'bpl', 'sil', 'dil'];
const HIGH8 = ['ah', 'ch', 'dh', 'bh'];
/** @param {number} reg @param {number} size @param {boolean} [high] */
function registerName(reg, size, high = false){
    const wide = REGISTERS64[reg];
    switch (size)
    {
        case 8: return wide;
        case 4: return reg < 8 ? `e${wide.slice(1)}` : `${wide}d`;
        case 2: return reg < 8 ? wide.slice(1) : `${wide}w`;
        case 1: return high ? HIGH8[reg] : reg < 8 ? LOW8[reg] : `${wide}b`;
        default: throw new Error(`no register of size ${size}`);
    }
}
const PTR = /** @type {Record<number, string>} */ ({
    1: 'byte', 2: 'word', 4: 'dword', 8: 'qword', 10: 'tbyte', 16: 'xmmword',
});
const SEGMENTS = ['es', 'cs', 'ss', 'ds', 'fs', 'gs'];

/** A disassembler number, hex or decimal, signed. @param {string} text */
const number = text=>(text.startsWith('-') ? -BigInt(text.slice(1)) : BigInt(text));

/** @typedef {{ kind: string, [key: string]: any }} Shape */

/**
 * One of our operands as a shape to compare: memory's segment named only
 * where it is not the default (DS, or ES for a string destination, which the
 * disassembler names).
 *
 * @param {import('./decoder.js').Operand} operand
 * @param {import('./decoder.js').Instruction} instruction
 * @returns {Shape}
 */
function ours(operand, instruction){
    switch (operand.kind)
    {
        // pinsrw's register source is shown by its dword name.
        case 'reg': return { kind: 'reg', name: registerName(/** @type {number} */ (operand.reg),
            instruction.op === 'pinsrw' ? 4 : operand.size || 8, operand.high) };
        case 'xmm': return { kind: 'reg', name: `xmm${operand.reg}` };
        case 'mm': return { kind: 'reg', name: `mm${operand.reg}` };
        case 'x87': return { kind: 'reg', name: operand.reg === 0 ? 'st' : `st(${operand.reg})` };
        case 'seg': return { kind: 'reg', name: SEGMENTS[/** @type {number} */ (operand.reg)] };
        case 'imm':
        {
            const value = BigInt(/** @type {number} */ (operand.value) >>> 0)
                | BigInt(operand.upper ?? 0) << 32n;
            return { kind: 'imm', value: BigInt.asUintN(operand.size * 8, value) };
        }
        case 'rel': return { kind: 'imm', value: BigInt(/** @type {number} */ (operand.target)) };
        case 'mem':
        {
            const wide = operand.addressSize === 64;
            /** @param {number} reg */
            const name = reg=>registerName(reg, wide ? 8 : 4);
            const segment = /** @type {number} */ (operand.segment);
            return {
                kind: 'mem',
                ptr: instruction.op === 'lea' ? null : PTR[operand.size] ?? null,
                segment: segment === 4 || segment === 5 || (segment === 0 && isString(instruction))
                    ? SEGMENTS[segment] : null,
                base: operand.rip ? (wide ? 'rip' : 'eip') : operand.base === -1 ? null
                    : name(/** @type {number} */ (operand.base)),
                index: operand.index === -1 ? null : name(/** @type {number} */ (operand.index)),
                scale: operand.index === -1 ? 1 : operand.scale,
                disp: operand.upper === undefined
                    ? BigInt.asUintN(wide ? 64 : 32, BigInt(/** @type {number} */ (operand.disp)))
                    : BigInt(/** @type {number} */ (operand.disp)) | BigInt(operand.upper) << 32n,
            };
        }
        default: throw new Error(`operand kind ${operand.kind}`);
    }
}

/** @param {import('./decoder.js').Instruction} instruction */
const isString = instruction=>['movs', 'cmps', 'stos', 'lods', 'scas'].includes(instruction.op);

/**
 * One of the disassembler's operands as a shape. A RIP-relative operand's
 * displacement is the target its comment names.
 *
 * @param {string} text @param {number} width  the operand's width in bits, for an immediate
 * @param {bigint | null} ripTarget
 * @param {bigint} next  the address after the instruction
 * @param {boolean} string  whether it is a string instruction
 * @returns {Shape}
 */
function theirs(text, width, ripTarget, next, string){
    const memory =
        /^(?:(byte|word|dword|qword|tbyte|xmmword) ptr )?(?:(es|cs|ss|ds|fs|gs):)?\[(.*)\]$/
            .exec(text);
    if (memory)
    {
        const [, ptr = null, named = null, inside] = memory;
        // Long mode ignores the CS, DS, SS and ES overrides, which LLVM still
        // shows; ES is meant only as a string destination's.
        const segment = named === 'fs' || named === 'gs' || (named === 'es' && string)
            ? named : null;
        /** @type {Shape} */
        const shape = { kind: 'mem', ptr, segment, base: null, index: null, scale: 1, disp: 0n };
        let sign = 1n;
        for (const term of inside.split(' '))
        {
            if (term === '+' || term === '-')
            {
                sign = term === '-' ? -1n : 1n;
                continue;
            }
            const scaled = /^(\d)\*([a-z0-9]+)$/.exec(term);
            if (scaled)
            {
                shape.scale = Number(scaled[1]);
                shape.index = scaled[2];
            }
            else if (/^-?(0x[0-9a-f]+|\d+)$/.test(term))
            {
                shape.disp += sign * number(term);
            }
            else if (shape.base === null && !/^\d/.test(term))
            {
                shape.base = term;
            }
            else
            {
                shape.index = term;
            }
        }
        const wide = !/^e/.test(shape.base ?? shape.index ?? 'r');
        if (shape.base === 'rip' || shape.base === 'eip')
        {
            // The comment names a RIP-relative target; an EIP-relative one
            // has none, and is made here from the next instruction's address.
            shape.disp = ripTarget ?? next + shape.disp;
        }
        shape.disp = BigInt.asUintN(wide ? 64 : 32, shape.disp);
        return shape;
    }
    if (/^-?(0x[0-9a-f]+|\d+)$/.test(text))
    {
        return { kind: 'imm', value: BigInt.asUintN(width, number(text)) };
    }
    return { kind: 'reg', name: text.replace(/^st\(0\)$/, 'st') };
}

/**
 * The disassembler's mnemonic for our record: the string operations by their
 * size suffix, the width-named conversions, `movabs` for a 64-bit immediate or
 * offset, and the forms LLVM names apart (`pause`, `tzcnt`).
 *
 * @param {import('./decoder.js').Instruction} instruction
 */
function mnemonicOf(instruction){
    const { op, size, operands, prefixes } = instruction;
    const suffix = /** @type {Record<number, string>} */ ({ 1: 'b', 2: 'w', 4: 'd', 8: 'q' });
    if (isString(instruction))
    {
        return `${op}${suffix[operands[0].size]}`;
    }
    switch (op)
    {
        case 'cwde': return { 2: 'cbw', 4: 'cwde', 8: 'cdqe' }[size];
        case 'cdq': return { 2: 'cwd', 4: 'cdq', 8: 'cqo' }[size];
        case 'pushf': case 'popf': return size === 8 ? `${op}q` : op;
        case 'jecxz': return prefixes.address ? 'jecxz' : 'jrcxz';
        case 'nop': return prefixes.rep && operands.length === 0 ? 'pause' : 'nop';
        case 'bsf': return prefixes.rep ? 'tzcnt' : 'bsf';
        case 'movd': return size === 8 || operands.some(one=>one.size === 8) ? 'movq' : 'movd';
        case 'mov':
            // An 8-byte immediate (b8+r with REX.W) or a 64-bit offset (a0..a3).
            return (/^b[89a-f]$/.test(instruction.opcode) && size === 8)
                || (/^a[0-3]$/.test(instruction.opcode) && !prefixes.address) ? 'movabs' : 'mov';
        default: return op;
    }
}

/** The predicates `cmpss`/`cmpsd`/`cmpps`/`cmppd` are named by. */
const PREDICATES = ['eq', 'lt', 'le', 'unord', 'neq', 'nlt', 'nle', 'ord'];

/**
 * The operands a disassembler line names, with the implicit ones LLVM leaves
 * out put back in our tables' order: x87's ST0 beside a memory operand, a
 * shift's count of one, a comparison predicate as its immediate.
 *
 * @param {string} mnemonic @param {string} text
 */
function splitOperands(mnemonic, text){
    const parts = text === '' ? [] : text.split(', ');
    const predicate = /^cmp(eq|lt|le|unord|neq|nlt|nle|ord)(ss|sd|ps|pd)$/.exec(mnemonic);
    if (predicate)
    {
        return { mnemonic: `cmp${predicate[2]}`,
            parts: [...parts, `0x${PREDICATES.indexOf(predicate[1]).toString(16)}`] };
    }
    return { mnemonic, parts };
}

/**
 * Our operands as the disassembler shows them: x87's implicit ST beside a
 * memory operand and a shift's count of one left out, as LLVM leaves them.
 *
 * @param {import('./decoder.js').Instruction} instruction
 */
function shownOperands(instruction){
    const { operands, opcode } = instruction;
    if (/^d[89a-f] /.test(opcode) && operands.some(one=>one.kind === 'mem'))
    {
        return operands.filter(one=>one.kind !== 'x87');
    }
    if (/^d[01] /.test(opcode))
    {
        return operands.slice(0, 1);
    }
    return operands;
}

test('every instruction shape LLVM disassembles from 64-bit code decodes as LLVM reads it', ()=>{
    /** @type {string[]} */
    const wrong = [];
    for (const line of FIXTURE)
    {
        const [address, hex, ...fields] = line.split('\t');
        // `rep stosb`, `lock cmpxchg`: the prefix is a field of its own; a
        // prefix LLVM shows alone, its instruction on the next line, is no
        // instruction to decode.
        const prefixed = ['rep', 'repne', 'lock'].includes(fields[0]);
        if (prefixed && (fields[1] ?? '').trim() === '')
        {
            continue;
        }
        const mnemonic = fields[prefixed ? 1 : 0];
        let operandText = fields[prefixed ? 2 : 1] ?? '';
        const comment = /#\s*(0x[0-9a-f]+)/.exec(operandText);
        operandText = operandText.replace(/\s*#.*$/, '').trim();
        const bytes = Uint8Array.from(hex.match(/../g) ?? [], byte=>parseInt(byte, 16));
        const eip = parseInt(address, 16);
        const result = decode(where=>bytes[where - eip] ?? 0, eip, MODE_64);
        const label = `${address}: ${hex} ${fields.join(' ')}`;
        if ('refused' in result)
        {
            wrong.push(`${label} -- refused: ${result.reason}`);
            continue;
        }
        if (result.length !== bytes.length)
        {
            wrong.push(`${label} -- length ${result.length}`);
            continue;
        }
        const expected = splitOperands(mnemonic, operandText);
        const ourMnemonic = mnemonicOf(result);
        if (ourMnemonic !== expected.mnemonic)
        {
            wrong.push(`${label} -- mnemonic ${ourMnemonic}`);
            continue;
        }
        const shown = shownOperands(result);
        if (shown.length !== expected.parts.length)
        {
            wrong.push(`${label} -- ${shown.length} operands`);
            continue;
        }
        const ripTarget = comment ? BigInt(comment[1]) : null;
        shown.forEach((operand, index)=>{
            const a = ours(operand, result);
            const b = theirs(expected.parts[index], (operand.size || 8) * 8, ripTarget,
                BigInt(eip + bytes.length), isString(result));
            if (JSON.stringify(a, (_, v)=>(typeof v === 'bigint' ? `0x${v.toString(16)}` : v))
                !== JSON.stringify(b, (_, v)=>(typeof v === 'bigint' ? `0x${v.toString(16)}` : v)))
            {
                wrong.push(`${label} -- operand ${index}: ours ${JSON.stringify(a,
                    (_, v)=>(typeof v === 'bigint' ? `0x${v.toString(16)}` : v))}`);
            }
        });
    }
    assert.ok(FIXTURE.length > 6000, `${FIXTURE.length} shapes`);
    assert.deepEqual(wrong.slice(0, 40), [], `${wrong.length} of ${FIXTURE.length} wrong`);
});

/** Decodes the bytes in long mode at `eip`. @param {number[]} bytes @param {number} [eip] */
function at(bytes, eip = 0x140001000){
    const image = Uint8Array.from(bytes);
    return decode(address=>image[address - eip] ?? 0x00, eip, MODE_64);
}

test('long mode refuses as #UD the one-byte encodings it dropped', ()=>{
    for (const opcode of [0x06, 0x07, 0x0e, 0x16, 0x17, 0x1e, 0x1f, 0x27, 0x2f, 0x37, 0x3f,
        0x60, 0x61, 0x62, 0x82, 0x9a, 0xc4, 0xc5, 0xce, 0xd4, 0xd5, 0xd6, 0xea])
    {
        const result = at([opcode, 0xc0, 0, 0, 0, 0, 0]);
        assert.ok('refused' in result && result.invalid, `${opcode.toString(16)} is #UD`);
    }
    // The same bytes are instructions in 32-bit mode.
    assert.equal(/** @type {any} */ (decode(()=>0x60, 0)).op, 'pushad');
});

test('a REX prefix counts right before the opcode, and REX.W outweighs the operand-size prefix',
    ()=>{
        const add = /** @type {any} */ (at([0x48, 0x01, 0xc8])); // add rax, rcx
        assert.equal(add.size, 8);
        assert.equal(add.prefixes.rex, 0x48);
        // A legacy prefix after REX voids it: 48 66 01 c8 is add ax, cx.
        const voided = /** @type {any} */ (at([0x48, 0x66, 0x01, 0xc8]));
        assert.equal(voided.size, 2);
        assert.equal(voided.prefixes.rex, 0);
        // 66 before REX.W: the REX.W stands.
        assert.equal(/** @type {any} */ (at([0x66, 0x48, 0x01, 0xc8])).size, 8);
        // Two REX bytes: the last one counts.
        const last = /** @type {any} */ (at([0x41, 0x48, 0x01, 0xc8]));
        assert.deepEqual(last.operands.map((/** @type {any} */ one)=>one.reg), [0, 1]);
        assert.equal(last.size, 8);
        // 40..4F are never inc/dec in long mode.
        assert.equal(/** @type {any} */ (at([0x40, 0x90])).op, 'nop');
    });

test('the stack operations and near branches default to 64 bits', ()=>{
    assert.equal(/** @type {any} */ (at([0x50])).size, 8, 'push rax');
    assert.equal(/** @type {any} */ (at([0x66, 0x50])).size, 2, 'push ax');
    assert.equal(/** @type {any} */ (at([0xff, 0xd0])).operands[0].size, 8, 'call rax');
    const jump = /** @type {any} */ (at([0xeb, 0xfe], 0x140001000));
    assert.equal(jump.operands[0].target, 0x140001000, 'a jump to itself, past 4 GiB');
    const back = /** @type {any} */ (at([0xe8, 0x00, 0xf0, 0xff, 0xff], 0x140001000));
    assert.equal(back.operands[0].target, 0x140001005 - 0x1000);
    const ret = /** @type {any} */ (at([0xc3]));
    assert.equal(ret.size, 8);
});

test('a RIP-relative operand carries its absolute address; a 64-bit immediate its halves', ()=>{
    const load = /** @type {any} */ (at([0x48, 0x8b, 0x05, 0x10, 0x00, 0x00, 0x00], 0x140001000));
    assert.equal(load.operands[1].rip, true);
    assert.equal(load.operands[1].disp, 0x140001007 + 0x10);
    const wide = /** @type {any} */ (at([0x48, 0xb8, 0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11]));
    assert.deepEqual([wide.operands[1].value, wide.operands[1].upper], [0x55667788, 0x11223344]);
    const signed = /** @type {any} */ (at([0x48, 0x83, 0xc0, 0xff])); // add rax, -1
    assert.deepEqual([signed.operands[1].value, signed.operands[1].upper],
        [0xffffffff, 0xffffffff]);
});
