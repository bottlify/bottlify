/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * GLU32's routines on cork's test machine, OPENGL32's entry points stood in
 * for by stubs that log what they are handed: each routine's GL calls, with
 * their arguments to the bit, against the same composition of the arithmetic's
 * source (under double precision) or of its x87 model (under single) -- and
 * the stack, EBX, ESI, EDI and EBP as a stdcall callee leaves them.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createTestMachine } from '../../../../../cork/src/testing/machine.js';
import { doubleWords, random } from '../../../../scripts/guest-code/equivalence.mjs';
import { loadModel } from '../../../../scripts/guest-code/model.mjs';
import { guestMemory } from '../../win32/msvcrt/guest-code.js';
import * as sources from './inguest.js';
import {
    lookAtCode, ortho2DCode, perspectiveCode, pickMatrixCode, unProject4Code, unProjectCode,
} from './code.js';

const SOURCE = new URL('./inguest.js', import.meta.url);
const model = await loadModel(await readFile(SOURCE, 'utf8'), {
    file: 'inguest.js', url: SOURCE.href, values: sources,
});

const CODE = 0x10000;
const HALT = 0x0f00;
const STACK = 0x80000;
const LOG = 0x40000;
const LOG_AT = 0x3fffc;
const DATA = 0x50000;
const SAVED = { ebx: 0x11111111, esi: 0x22222222, edi: 0x33333333, ebp: 0x44444444 };

/** @param {number} value */
const dword = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];

/**
 * A stub of a stdcall GL entry point: its tag and the `words` it logs -- its
 * arguments, or with `pointer` the ones its one argument points at.
 *
 * @param {number} tag @param {number} words @param {boolean} pointer @param {number} pops
 */
const stub = (tag, words, pointer, pops)=>[
    0x56, 0x57,                                                   // push esi; push edi
    ...pointer ? [0x8b, 0x74, 0x24, 0x0c] : [0x8d, 0x74, 0x24, 0x0c], // mov/lea esi, [esp+12]
    0x8b, 0x3d, ...dword(LOG_AT),                                 // mov edi, [LOG_AT]
    0xc7, 0x07, ...dword(tag),                                    // mov dword [edi], tag
    0x83, 0xc7, 0x04,                                             // add edi, 4
    0xb9, ...dword(words),                                        // mov ecx, words
    0xf3, 0xa5,                                                   // rep movsd
    0x89, 0x3d, ...dword(LOG_AT),                                 // mov [LOG_AT], edi
    0x5f, 0x5e,                                                   // pop edi; pop esi
    0xc2, pops, 0x00,                                             // ret pops
];

const GL = { glMultMatrixd: 0x2000, glTranslated: 0x2100, glScaled: 0x2200, glOrtho: 0x2300 };
const TAGS = { glMultMatrixd: 1, glTranslated: 2, glScaled: 3, glOrtho: 4 };

function machine(){
    const m = createTestMachine({ ramSize: 1 << 20 });
    m.write(HALT, [0xf4]);
    m.write(GL.glMultMatrixd, stub(TAGS.glMultMatrixd, 32, true, 4));
    m.write(GL.glTranslated, stub(TAGS.glTranslated, 6, false, 24));
    m.write(GL.glScaled, stub(TAGS.glScaled, 6, false, 24));
    m.write(GL.glOrtho, stub(TAGS.glOrtho, 12, false, 48));
    return m;
}

/**
 * Runs a routine with its arguments and answers EAX and the GL calls it made,
 * each as its tag and the doubles it was handed.
 *
 * @param {ReturnType<typeof machine>} m @param {Uint8Array} code @param {number[]} stack
 * @param {number} control @param {number} pops
 */
function run(m, code, stack, control, pops){
    m.write(CODE, Array.from(code));
    m.writeU32(LOG_AT, LOG);
    m.writeU32(STACK, HALT);
    stack.forEach((word, i)=>m.writeU32(STACK + 4 + i * 4, word >>> 0));
    m.setReg('esp', STACK);
    for (const [reg, value] of Object.entries(SAVED))
    {
        m.setReg(reg, value);
    }
    m.setEflags(2);
    const view = new DataView(m.memory.buffer);
    view.setUint16(m.layout.x87Control, control, true);
    const exit = m.runProgram(CODE);
    assert.equal(exit.kind, 3, `ran to its return: ${JSON.stringify(exit)}`);
    assert.equal(m.eip(), HALT + 1, 'returned to its caller');
    assert.equal(m.reg('esp'), STACK + 4 + pops, 'popped its arguments');
    for (const [reg, value] of Object.entries(SAVED))
    {
        assert.equal(m.reg(reg), value, `kept ${reg}`);
    }
    assert.equal(view.getUint16(m.layout.x87Control, true), control, 'the control word kept');
    /** @type {{ tag: number, values: number[] }[]} */
    const calls = [];
    const words = { 1: 32, 2: 6, 3: 6, 4: 12 };
    for (let at = LOG; at < m.readU32(LOG_AT);)
    {
        const tag = m.readU32(at);
        const count = /** @type {Record<number, number>} */ (words)[tag];
        const bytes = m.read(at + 4, count * 4);
        calls.push({ tag,
            values: [...new Float64Array(bytes.buffer, bytes.byteOffset, count / 2)] });
        at += 4 + count * 4;
    }
    return { eax: m.reg('eax'), calls };
}

/** The arithmetic's functions under a control word: the source's, or the model's under single. @param {number} control */
const arithmetic = control=>{
    model.$.control = control;
    return /** @type {typeof sources} */ (/** @type {unknown} */ (
        (control & 0x300) === 0x300 || (control & 0x300) === 0x200 ? sources : model.module));
};

/**
 * A memory the arithmetic's reference reads and writes, laid out as the
 * machine's is.
 */
function referenceMemory(/** @type {ReturnType<typeof machine>} */ m){
    const bytes = m.read(0, 1 << 20);
    return {
        bytes,
        guest: guestMemory({
            readMemory: (address, length)=>bytes.subarray(address, address + length),
            writeMemory: (address, data)=>bytes.set(data, address),
        }),
    };
}

/** @param {() => number} next */
const value = next=>(next() % 20000 - 10000) / 64;

/** @param {number[]} a @param {number[]} b */
const sameBits = (a, b)=>a.length === b.length
    && a.every((x, i)=>Buffer.from(Float64Array.of(x).buffer)
        .equals(Buffer.from(Float64Array.of(b[i]).buffer)));

/** @param {{ tag: number, values: number[] }[]} got @param {{ tag: number, values: number[] }[]} want @param {string} what */
const sameCalls = (got, want, what)=>{
    assert.deepEqual(got.map(c=>c.tag), want.map(c=>c.tag), `${what}: the GL calls made`);
    got.forEach((c, i)=>assert.ok(sameBits(c.values, want[i].values),
        `${what}: call ${i} was handed ${c.values} where ${want[i].values} is wanted`));
};

for (const control of [0x27f, 0x07f])
{
    test(`gluPerspective, gluLookAt, gluOrtho2D and gluPickMatrix call OPENGL32 with what the`
        + ` arithmetic makes, under 0x${control.toString(16)}`, ()=>{
        const m = machine();
        const next = random(control);
        const math = arithmetic(control);
        const frame = 0x60000;
        for (let i = 0; i < 12; i++)
        {
            const persp = [i === 0 ? 0 : (next() % 1700) / 10, (next() % 300 + 1) / 97,
                (next() % 100 + 1) / 8, 1000 + next() % 1000];
            const got = run(m, perspectiveCode(GL), persp.flatMap(doubleWords), control, 32);
            const ref = referenceMemory(m);
            const made = math.gluPerspectiveMatrix(ref.guest, frame, persp[0], persp[1], persp[2],
                persp[3]) !== 0;
            sameCalls(got.calls, made ? [{ tag: TAGS.glMultMatrixd,
                values: [...new Float64Array(ref.bytes.slice(frame, frame + 128).buffer)] }] : [],
            'gluPerspective');

            const look = Array.from({ length: 9 }, ()=>value(next));
            const lookGot = run(m, lookAtCode(GL), look.flatMap(doubleWords), control, 72);
            const lookRef = referenceMemory(m);
            math.gluLookAtMatrix(lookRef.guest, frame, look[0], look[1], look[2], look[3], look[4],
                look[5], look[6], look[7], look[8]);
            const matrix = [...new Float64Array(lookRef.bytes.slice(frame, frame + 152).buffer)];
            sameCalls(lookGot.calls, [{ tag: TAGS.glMultMatrixd, values: matrix.slice(0, 16) },
                { tag: TAGS.glTranslated, values: matrix.slice(16) }], 'gluLookAt');

            const ortho = Array.from({ length: 4 }, ()=>value(next));
            sameCalls(run(m, ortho2DCode(GL), ortho.flatMap(doubleWords), control, 32).calls,
                [{ tag: TAGS.glOrtho, values: [...ortho, -1, 1] }], 'gluOrtho2D');

            const viewport = [next() % 64, next() % 64, next() % 800 + 1, next() % 600 + 1];
            m.write(DATA, new Uint8Array(Int32Array.from(viewport).buffer));
            const pick = [value(next), value(next), i === 1 ? 0 : (next() % 20 + 1) / 2,
                (next() % 20 + 1) / 2];
            const pickGot = run(m, pickMatrixCode(GL), [...pick.flatMap(doubleWords), DATA],
                control, 36);
            const pickRef = referenceMemory(m);
            const picked = math.gluPickMatrixArgs(pickRef.guest, frame, pick[0], pick[1], pick[2],
                pick[3], DATA) !== 0;
            const six = [...new Float64Array(pickRef.bytes.slice(frame, frame + 48).buffer)];
            sameCalls(pickGot.calls, picked ? [{ tag: TAGS.glTranslated, values: six.slice(0, 3) },
                { tag: TAGS.glScaled, values: six.slice(3) }] : [], 'gluPickMatrix');
        }
    });

    test(`gluUnProject and gluUnProject4 answer what the arithmetic does, under`
        + ` 0x${control.toString(16)}`, ()=>{
        const m = machine();
        const next = random(control + 1);
        const math = arithmetic(control);
        const [MODEL, PROJ, VIEWPORT, OBJ] = [DATA, DATA + 0x100, DATA + 0x200, DATA + 0x300];
        for (let i = 0; i < 12; i++)
        {
            const modelview = Array.from({ length: 16 }, ()=>value(next));
            const proj = Array.from({ length: 16 }, ()=>value(next));
            if (i === 0)
            {
                proj.fill(0);
            }
            m.write(MODEL, new Uint8Array(Float64Array.from(modelview).buffer));
            m.write(PROJ, new Uint8Array(Float64Array.from(proj).buffer));
            m.write(VIEWPORT, new Uint8Array(Int32Array.from([3, 4, 640, 480]).buffer));
            m.write(OBJ, new Uint8Array(32));
            const win = [value(next), value(next), (next() % 100) / 100];
            const before = referenceMemory(m);
            const got = run(m, unProjectCode(), [...win.flatMap(doubleWords), MODEL, PROJ, VIEWPORT,
                OBJ, OBJ + 8, OBJ + 16], control, 48);
            const wanted = math.gluUnProjectPoint(before.guest, 0x60000, MODEL, PROJ, VIEWPORT,
                win[0], win[1], win[2], 1, 0, 1) === 0 ? 0
                : math.gluUnProjectDivide(before.guest, 0x60000, OBJ, OBJ + 8, OBJ + 16);
            assert.equal(got.eax, wanted, 'gluUnProject answers as the arithmetic');
            assert.deepEqual(m.read(OBJ, 24), before.bytes.slice(OBJ, OBJ + 24),
                'gluUnProject writes what the arithmetic does');

            const four = [...win, value(next), (next() % 10) / 10, 1 + (next() % 10) / 10];
            m.write(OBJ, new Uint8Array(32));
            const before4 = referenceMemory(m);
            const got4 = run(m, unProject4Code(), [...four.slice(0, 4).flatMap(doubleWords), MODEL,
                PROJ, VIEWPORT, ...four.slice(4).flatMap(doubleWords), OBJ, OBJ + 8, OBJ + 16,
                OBJ + 24], control, 76);
            const wanted4 = math.gluUnProjectPoint(before4.guest, 0x60000, MODEL, PROJ, VIEWPORT,
                four[0], four[1], four[2], four[3], four[4], four[5]) === 0 ? 0
                : math.gluUnProjectStore(before4.guest, 0x60000, OBJ, OBJ + 8, OBJ + 16, OBJ + 24);
            assert.equal(got4.eax, wanted4, 'gluUnProject4 answers as the arithmetic');
            assert.deepEqual(m.read(OBJ, 32), before4.bytes.slice(OBJ, OBJ + 32),
                'gluUnProject4 writes what the arithmetic does');
        }
    });
}
