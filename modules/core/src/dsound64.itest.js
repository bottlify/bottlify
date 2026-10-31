/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * DirectSound from a 64-bit program through `createApp`, as SDL2's backend
 * drives it: DirectSoundCreate8, a secondary buffer described by the 40-byte
 * DSBUFFERDESC, Lock, samples written through the pointer it hands back,
 * Unlock and a looping Play. Every pointer slot the program passes starts as
 * 0xefefefefefefefef, so a pointer written four bytes wide leaves a high half
 * the program then calls or writes through. The program exits with the step
 * that failed, or 0.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/make-pe.mjs';

/** @param {number} value @returns {number[]} */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];
/** @param {number} value @returns {number[]} */
const u16 = value=>[value & 0xff, value >>> 8 & 0xff];
/** @param {number} bytes */
const unset = bytes=>new Array(bytes).fill(0xef);

const EXIT = 0x1c0;
/** DSBCAPS_GETCURRENTPOSITION2 | DSBCAPS_GLOBALFOCUS, SDL's flags. */
const FLAGS = 0x18000;
const BUFFER_BYTES = 32768;
const SAMPLE = 0x1000;

const program = buildExe({
    bits: 64, codeSize: 0x200,
    imports: { 'DSOUND.dll': ['DirectSoundCreate8'], 'KERNEL32.dll': ['ExitProcess'] },
    data: {
        device: unset(8), buffer: unset(8), p1: unset(8), n1: unset(4), p2: unset(8),
        n2: unset(4),
        // DSBUFFERDESC at 64 bits: lpwfxFormat at 0x10 (set by the code), the
        // GUID at 0x18.
        desc: [...u32(40), ...u32(FLAGS), ...u32(BUFFER_BYTES), ...u32(0), ...unset(8),
            ...new Array(16).fill(0)],
        // WAVEFORMATEX: PCM, stereo, 44100, 16 bits.
        format: [...u16(1), ...u16(2), ...u32(44100), ...u32(176400), ...u16(4), ...u16(16),
            ...u16(0)],
    },
    code: ({ iat, at, code })=>{
        /** @type {number[]} */
        const bytes = [];
        /** @param {number[]} op @param {number} to */
        const rip = (op, to)=>bytes.push(...op, ...u32(to - (code(bytes.length) + op.length + 4)));
        /** mov ecx, step; jne exit */
        const fail = (/** @type {number} */ step)=>{
            bytes.push(0xb9, ...u32(step));
            rip([0x0f, 0x85], code(EXIT));
        };
        /** the high half of a pointer slot is zero */
        const wholePointer = (/** @type {string} */ name, /** @type {number} */ step)=>{
            rip([0x8b, 0x05], at(name) + 4); // mov eax, [name+4]
            bytes.push(0x85, 0xc0); fail(step);
        };
        bytes.push(0x48, 0x83, 0xec, 0x58); // sub rsp, 0x58
        // DirectSoundCreate8(NULL, &device, NULL)
        bytes.push(0x31, 0xc9, 0x45, 0x31, 0xc0);
        rip([0x48, 0x8d, 0x15], at('device'));
        rip([0xff, 0x15], iat('DirectSoundCreate8'));
        bytes.push(0x85, 0xc0); fail(1);
        wholePointer('device', 2);
        // desc.lpwfxFormat = &format
        rip([0x48, 0x8d, 0x05], at('format'));
        rip([0x48, 0x89, 0x05], at('desc') + 0x10);
        // device->CreateSoundBuffer(&desc, &buffer, NULL): slot 3
        rip([0x48, 0x8b, 0x0d], at('device'));
        rip([0x48, 0x8d, 0x15], at('desc'));
        rip([0x4c, 0x8d, 0x05], at('buffer'));
        bytes.push(0x45, 0x31, 0xc9, 0x48, 0x8b, 0x01, 0xff, 0x50, 0x18);
        bytes.push(0x85, 0xc0); fail(3);
        wholePointer('buffer', 4);
        // buffer->Lock(0, 4096, &p1, &n1, &p2, &n2, 0): slot 11
        rip([0x48, 0x8b, 0x0d], at('buffer'));
        bytes.push(0x31, 0xd2, 0x41, 0xb8, ...u32(4096));
        rip([0x4c, 0x8d, 0x0d], at('p1'));
        rip([0x48, 0x8d, 0x05], at('n1'));
        bytes.push(0x48, 0x89, 0x44, 0x24, 0x20);
        rip([0x48, 0x8d, 0x05], at('p2'));
        bytes.push(0x48, 0x89, 0x44, 0x24, 0x28);
        rip([0x48, 0x8d, 0x05], at('n2'));
        bytes.push(0x48, 0x89, 0x44, 0x24, 0x30);
        bytes.push(0x48, 0xc7, 0x44, 0x24, 0x38, 0, 0, 0, 0);
        bytes.push(0x48, 0x8b, 0x01, 0xff, 0x50, 0x58);
        bytes.push(0x85, 0xc0); fail(5);
        wholePointer('p1', 6);
        wholePointer('p2', 7);
        // the samples, through the locked pointer
        rip([0x48, 0x8b, 0x3d], at('p1')); // mov rdi, [p1]
        bytes.push(0xb9, ...u32(1024), 0xb8, ...u32(SAMPLE * 0x10001), 0xf3, 0xab);
        // buffer->Unlock(p1, n1, p2, n2): slot 19
        rip([0x48, 0x8b, 0x0d], at('buffer'));
        rip([0x48, 0x8b, 0x15], at('p1'));
        rip([0x44, 0x8b, 0x05], at('n1'));
        rip([0x4c, 0x8b, 0x0d], at('p2'));
        rip([0x8b, 0x05], at('n2'));
        bytes.push(0x48, 0x89, 0x44, 0x24, 0x20);
        bytes.push(0x48, 0x8b, 0x01, 0xff, 0x90, ...u32(19 * 8));
        bytes.push(0x85, 0xc0); fail(8);
        // buffer->Play(0, 0, DSBPLAY_LOOPING): slot 12
        rip([0x48, 0x8b, 0x0d], at('buffer'));
        bytes.push(0x31, 0xd2, 0x45, 0x31, 0xc0, 0x41, 0xb9, ...u32(1));
        bytes.push(0x48, 0x8b, 0x01, 0xff, 0x50, 0x60);
        bytes.push(0x85, 0xc0); fail(9);
        bytes.push(0x31, 0xc9); // xor ecx, ecx
        assert.ok(bytes.length <= EXIT);
        bytes.push(...new Array(EXIT - bytes.length).fill(0x90));
        rip([0xff, 0x15], iat('ExitProcess'));
        return bytes;
    },
});

test('a 64-bit program opens a DirectSound buffer, fills it through Lock and plays it',
    { timeout: 60000 }, async t=>{
        const app = await createApp({ executable: program, engine: 'cork' });
        t.after(()=>app.dispose());
        assert.equal(await app.run({ timeoutMs: 50000 }), 0, 'the step that failed');
        const audio = app.diagnostics().find((/** @type {any} */ layer)=>layer.name === 'audio')
            ?.metrics;
        assert.deepEqual(audio.creations,
            [`CreateSoundBuffer flags=0x${FLAGS.toString(16)} bytes=${BUFFER_BYTES} fmt=44100/16/2`]);
        assert.equal(audio.playing, 1);
        assert.deepEqual(audio.contents.map((/** @type {any} */ buffer)=>[buffer.peak,
            buffer.nonzero]), [[SAMPLE, 4096 / 2]], 'the samples written through the lock');
    });
