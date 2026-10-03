/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import {
    ARITH_MASK, BSS, BSS_SIZE, STATUS_MASK, TAG_ALL_INVALID,
    diffFixture, loadCorpus, parseElf32, parseFixture,
} from './corpus.js';

/**
 * A 32-bit ELF with two loadable segments, built byte by byte: the code
 * `[0x90, 0xf4]` at 0x80000 and an 8-byte .bss at 0x100000 with two bytes
 * of file content, so the zero fill is visible.
 */
function tinyElf(){
    const image = new Uint8Array(0x34 + 2 * 0x20 + 16);
    const view = new DataView(image.buffer);
    image.set([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1]);
    view.setUint16(0x10, 2, true);          // ET_EXEC
    view.setUint16(0x12, 3, true);          // EM_386
    view.setUint32(0x18, 0x80000, true);    // e_entry
    view.setUint32(0x1c, 0x34, true);       // e_phoff
    view.setUint16(0x2a, 0x20, true);       // e_phentsize
    view.setUint16(0x2c, 2, true);          // e_phnum
    const data = 0x34 + 2 * 0x20;
    image.set([0x90, 0xf4, 0xaa, 0xbb], data);
    /** @param {number} at @param {number[]} fields */
    const header = (at, fields)=>fields.forEach(
        (value, i)=>view.setUint32(at + i * 4, value, true));
    // p_type, p_offset, p_vaddr, p_paddr, p_filesz, p_memsz, p_flags, p_align
    header(0x34, [1, data, 0x80000, 0x80000, 2, 2, 5, 0x1000]);
    header(0x54, [1, data + 2, 0x100000, 0x100000, 2, 8, 6, 0x1000]);
    return image;
}

/** A recording as the debugger writes one. @param {Partial<Record<string, string>>} [over] */
function fixtureText({ prefix = 'Breakpoint 1, 0x00080002 in loop ()\n', st = '"invalid"',
    eflags = '582', ftag = '43690', fstat = '0' } = {})
{
    const values = [
        '1', '2', '3', '4', '1056768', '0', '0', '0',
        '524290',
        ...Array(8).fill(st),
        ...Array(16).fill('0'),
        ...Array(32).fill('0'),
        ...Array(BSS_SIZE / 4).fill('0'),
        eflags, ftag, fstat,
    ];
    return `${prefix}---BEGIN JSON---\n[\n    ${values.join(',\n    ')}\n]\n---END JSON---\n`;
}

test('an ELF32 loads its PT_LOAD segments at their addresses, zero-filled to memsz', ()=>{
    const { entry, segments } = parseElf32(tinyElf());
    assert.equal(entry, 0x80000);
    assert.equal(segments.length, 2);
    assert.equal(segments[0].address, 0x80000);
    assert.deepEqual([...segments[0].bytes], [0x90, 0xf4]);
    assert.equal(segments[1].address, 0x100000);
    assert.deepEqual([...segments[1].bytes], [0xaa, 0xbb, 0, 0, 0, 0, 0, 0]);
    assert.throws(()=>parseElf32(new Uint8Array(64)), /not an ELF/);
});

test('a recording parses, with the debugger\'s spellings of the unrepresentable', ()=>{
    const fixture = parseFixture(fixtureText({ st: '1.5000000000000000000e+00' }));
    assert.equal(fixture.exception, null);
    assert.deepEqual([...fixture.reg32], [1, 2, 3, 4, 0x102000, 0, 0, 0]);
    assert.equal(fixture.eip, 0x80002);
    assert.deepEqual(fixture.st, Array(8).fill(1.5));
    assert.equal(fixture.eflags, 582);
    assert.equal(fixture.ftag, TAG_ALL_INVALID);
    assert.equal(fixture.memory.length, BSS_SIZE / 4);

    const odd = parseFixture(fixtureText().replace('"invalid",\n    "invalid",\n    "invalid"',
        'inf,\n    -inf,\n    -nan'));
    assert.deepEqual(odd.st.slice(0, 4), [Infinity, -Infinity, NaN, 'invalid']);

    // A case that died: the debugger's catchpoint line, as the recordings have it.
    const died = parseFixture(fixtureText({
        prefix: 'Catchpoint 2 (signal SIGFPE), 0x00080000 in _start ()\n',
    }));
    assert.equal(died.exception, 'DE');
    assert.throws(()=>parseFixture(fixtureText({
        prefix: 'Program received signal SIGTRAP, Trace/breakpoint trap.\n',
    })), /killed by a signal the runner does not map/);
});

test('the document gunzips into cases', ()=>{
    const document = {
        commit: 'abc', cases: [{
            name: 'tiny', image: Buffer.from(tinyElf()).toString('base64'), fixture: fixtureText(),
        }],
    };
    const corpus = loadCorpus(gzipSync(Buffer.from(JSON.stringify(document))));
    assert.equal(corpus.commit, 'abc');
    assert.equal(corpus.cases.length, 1);
    assert.equal(corpus.cases[0].name, 'tiny');
    assert.equal(corpus.cases[0].entry, 0x80000);
    assert.equal(corpus.cases[0].expected.reg32[0], 1);
});

/** An outcome that matches the plain recording exactly. @returns {import('./corpus.js').Outcome} */
function matchingOutcome(){
    return {
        exception: null, halted: true,
        reg32: Int32Array.from([1, 2, 3, 4, 0x102000, 0, 0, 0]), eip: 0x80002,
        st: Array(8).fill('invalid'), fstat: 0,
        mm: new Int32Array(16), xmm: new Int32Array(32), memory: new Int32Array(BSS_SIZE / 4),
        eflags: 582,
    };
}

test('the diff follows the runner: registers, the x87 or MMX branch, xmm, memory, flags', ()=>{
    const expected = parseFixture(fixtureText());
    assert.deepEqual(diffFixture(expected, matchingOutcome()), []);

    const ecx = matchingOutcome();
    ecx.reg32[1] = 7;
    assert.deepEqual(diffFixture(expected, ecx), [{ name: 'ecx', expected: 2, actual: 7 }]);

    // Every register empty in the recording: the MMX words are compared and
    // the x87 stack is not, so a stale st value goes unremarked.
    const mmx = matchingOutcome();
    mmx.mm[3] = -1;
    mmx.st[0] = 1;
    assert.deepEqual(diffFixture(expected, mmx),
        [{ name: 'mm1.int32[1]', expected: 0, actual: -1 }]);

    // A register held: the x87 branch, with the runner's seven digits and
    // the status word under its mask; the MMX words are not looked at.
    const held = parseFixture(fixtureText({ st: '2.0e+00', ftag: '0', fstat: '14336' }));
    const x87 = matchingOutcome();
    x87.st = Array(8).fill(2.00000001);
    x87.fstat = 0x3800 | 1 << 9;
    x87.mm[0] = 5;
    assert.deepEqual(diffFixture(held, x87), []);
    x87.st[2] = 2.001;
    x87.fstat = 0x3800 | 1 << 10;
    assert.deepEqual(diffFixture(held, x87), [
        { name: 'st2', expected: 2, actual: 2.001 },
        { name: 'fpu status word', expected: 0x3800 & STATUS_MASK,
            actual: (0x3800 | 1 << 10) & STATUS_MASK },
    ]);

    const rest = matchingOutcome();
    rest.xmm[5] = 1;
    rest.memory[BSS_SIZE / 4 - 1] = 9;
    rest.eflags = 582 | 1 << 10;
    assert.deepEqual(diffFixture(expected, rest).map(d=>d.name),
        ['xmm1.int32[1]', `mem[0x${(BSS + BSS_SIZE - 4).toString(16)}]`]);
    rest.eflags = 582 ^ 1;
    assert.deepEqual(diffFixture(expected, rest).pop(),
        { name: 'eflags', expected: 582 & ARITH_MASK, actual: (582 ^ 1) & ARITH_MASK });

    const running = matchingOutcome();
    running.halted = false;
    assert.equal(diffFixture(expected, running)[0].name, 'halted');
});

test('a case that died compares the faulting address and nothing else', ()=>{
    const died = parseFixture(fixtureText({
        prefix: 'Catchpoint 3 (signal SIGILL), 0x00080002 in _start ()\n',
    }));
    const outcome = matchingOutcome();
    outcome.reg32[0] = 0x1234;
    assert.deepEqual(diffFixture(died, outcome),
        [{ name: 'exception', expected: 'UD', actual: 'none' }]);
    outcome.exception = { name: 'UD', eip: 0x80002 };
    assert.deepEqual(diffFixture(died, outcome), []);
    outcome.exception.eip = 0x80005;
    assert.deepEqual(diffFixture(died, outcome),
        [{ name: 'exception eip', expected: 0x80002, actual: 0x80005 }]);

    const alive = parseFixture(fixtureText());
    assert.deepEqual(diffFixture(alive, outcome),
        [{ name: 'exception', expected: 'none', actual: 'UD at 0x80005' }]);
});
