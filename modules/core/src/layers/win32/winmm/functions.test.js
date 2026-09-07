/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWinmmFunctions } from './functions.js';

/** 44.1 kHz, 16 bit, stereo: 176400 bytes a second, which is the arithmetic below. */
const BYTES_PER_SECOND = 176400;

/** Somewhere for the guest's structures to live, and a clock we move by hand. */
function machine(){
    const memory = new Uint8Array(0x1000);
    let clock = 1000;
    /** @type {any[]} */
    const notices = [];

    const host = {
        /** @param {number} address @param {number} length */
        readMemory: (address, length)=>memory.slice(address, address + length),
        /** @param {number} address @param {Uint8Array} bytes */
        writeMemory: (address, bytes)=>memory.set(bytes, address),
        now: ()=>clock,
        /** @param {any} notice */
        notify: (/** @type {any} */ notice)=>notices.push(notice),
    };

    /** @param {number} at @param {number} value */
    const put32 = (at, value)=>memory.set(new Uint8Array([
        value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff,
    ]), at);
    /** @param {number} at */
    const get32 = at=>(memory[at] | memory[at + 1] << 8
        | memory[at + 2] << 16 | memory[at + 3] << 24) >>> 0;

    return {
        memory, host, notices, put32, get32,
        winmm: /** @type {any} */ (createWinmmFunctions(host)),
        /** @param {number} ms */
        tick: ms=>{
            clock += ms;
        },
        at: ()=>clock,
    };
}

/** A WAVEFORMATEX at 0x100 and an opened device. @param {any} m */
function opened(m, flags = 0){
    m.put32(0x100, 16 | 2 << 16); // wFormatTag = PCM, nChannels = 2
    m.put32(0x104, 44100);
    m.put32(0x108, BYTES_PER_SECOND);
    m.put32(0x10c, 4 | 16 << 16); // nBlockAlign, wBitsPerSample

    assert.equal(m.winmm.waveOutOpen.handler([0x200, 0, 0x100, 0, 0, flags]), 0);
    return m.get32(0x200);
}

/**
 * A prepared WAVEHDR at `at`, over `length` bytes.
 *
 * @param {any} m @param {number} device @param {number} at @param {number} length
 */
function header(m, device, at, length){
    m.put32(at + 0, 0x800); // lpData, which nothing here reads
    m.put32(at + 4, length);
    m.put32(at + 16, 0); // dwFlags
    assert.equal(m.winmm.waveOutPrepareHeader.handler([device, at, 32]), 0);
    return at;
}

const WHDR_DONE = 1;
const WHDR_INQUEUE = 16;

test('the clock a frame loop reads is the guest\'s own', ()=>{
    const m = machine();
    assert.equal(m.winmm.timeGetTime.handler([]), 1000);
    m.tick(250);
    assert.equal(m.winmm.timeGetTime.handler([]), 1250,
        'it moves with the guest, not with the host');
});

test('a buffer just written is queued, and is not yet done', ()=>{
    // The whole contract: a program refills on WHDR_DONE and on nothing else,
    // so a buffer that comes back the instant it was written makes it spin.
    const m = machine();
    const device = opened(m);
    const at = header(m, device, 0x300, BYTES_PER_SECOND / 10); // 100 ms of audio

    assert.equal(m.winmm.waveOutWrite.handler([device, at, 32]), 0);
    assert.equal(m.get32(at + 16) & WHDR_INQUEUE, WHDR_INQUEUE);
    assert.equal(m.get32(at + 16) & WHDR_DONE, 0, 'not done the moment it arrived');
});

test('a buffer comes back after the time its own bytes take', ()=>{
    const m = machine();
    const device = opened(m);
    const at = header(m, device, 0x300, BYTES_PER_SECOND / 10);
    m.winmm.waveOutWrite.handler([device, at, 32]);

    m.tick(50);
    m.winmm.waveOutGetID.handler([device, 0x210]);
    assert.equal(m.get32(at + 16) & WHDR_DONE, 0, 'half way through, still playing');

    m.tick(60);
    m.winmm.waveOutGetID.handler([device, 0x210]);
    assert.equal(m.get32(at + 16) & WHDR_DONE, WHDR_DONE);
    assert.equal(m.get32(at + 16) & WHDR_INQUEUE, 0, 'and the device has let it go');
    assert.equal(m.notices.length, 1, 'the caller was told once');
    assert.equal(m.notices[0].param, at, 'and told which buffer');
});

test('the cursor does not run while nothing is queued', ()=>{
    // A device that kept counting through silence would hand back the next
    // buffer written to it instantly, and the program would spin.
    const m = machine();
    const device = opened(m);
    m.tick(10000);

    const at = header(m, device, 0x300, BYTES_PER_SECOND / 10);
    m.winmm.waveOutWrite.handler([device, at, 32]);
    m.tick(1);
    m.winmm.waveOutGetID.handler([device, 0x210]);

    assert.equal(m.get32(at + 16) & WHDR_DONE, 0,
        'ten seconds of silence bought the buffer nothing');
});

test('a drained device does not keep counting', ()=>{
    // The position is what a program polls to decide how far ahead to write. A
    // device that kept counting through silence would report a cursor running
    // away from a queue that is empty.
    const m = machine();
    const device = opened(m);
    const at = header(m, device, 0x300, BYTES_PER_SECOND / 10);
    m.winmm.waveOutWrite.handler([device, at, 32]);

    m.tick(200);
    m.winmm.waveOutGetPosition.handler([device, 0x220, 8]);
    assert.equal(m.get32(0x220 + 4), 0, 'everything queued has been played');

    m.tick(5000);
    m.winmm.waveOutGetPosition.handler([device, 0x220, 8]);
    assert.equal(m.get32(0x220 + 4), 0, 'and five seconds of silence added nothing');
});

test('two buffers come back in the order they were written', ()=>{
    const m = machine();
    const device = opened(m);
    const first = header(m, device, 0x300, BYTES_PER_SECOND / 10);
    const second = header(m, device, 0x340, BYTES_PER_SECOND / 10);
    m.winmm.waveOutWrite.handler([device, first, 32]);
    m.winmm.waveOutWrite.handler([device, second, 32]);

    m.tick(110);
    m.winmm.waveOutGetID.handler([device, 0x210]);
    assert.equal(m.get32(first + 16) & WHDR_DONE, WHDR_DONE);
    assert.equal(m.get32(second + 16) & WHDR_DONE, 0);

    m.tick(110);
    m.winmm.waveOutGetID.handler([device, 0x210]);
    assert.equal(m.get32(second + 16) & WHDR_DONE, WHDR_DONE);
    assert.deepEqual(m.notices.map((/** @type {any} */ n)=>n.param), [first, second]);
});

test('an unprepared buffer is refused, and a queued one cannot be unprepared', ()=>{
    // Preparing is what tells the caller its memory is about to be read by
    // something else; unpreparing while queued takes it back too early.
    const m = machine();
    const device = opened(m);
    m.put32(0x300 + 4, 1024);
    m.put32(0x300 + 16, 0);

    assert.equal(m.winmm.waveOutWrite.handler([device, 0x300, 32]), 34,
        'WAVERR_UNPREPARED');

    header(m, device, 0x300, BYTES_PER_SECOND);
    m.winmm.waveOutWrite.handler([device, 0x300, 32]);
    assert.equal(m.winmm.waveOutUnprepareHeader.handler([device, 0x300, 32]), 33,
        'WAVERR_STILLPLAYING');
});

test('closing with buffers outstanding is refused, and reset returns them', ()=>{
    const m = machine();
    const device = opened(m);
    const at = header(m, device, 0x300, BYTES_PER_SECOND);
    m.winmm.waveOutWrite.handler([device, at, 32]);

    assert.equal(m.winmm.waveOutClose.handler([device]), 33,
        'a program closes, sees this, resets, and closes again');

    assert.equal(m.winmm.waveOutReset.handler([device]), 0);
    assert.equal(m.get32(at + 16) & WHDR_DONE, WHDR_DONE,
        'a buffer the program is waiting on has to arrive, or the wait never ends');
    assert.equal(m.winmm.waveOutClose.handler([device]), 0);
    assert.equal(m.winmm.waveOutClose.handler([device]), 5, 'and the handle is gone');
});

test('a paused device holds its buffers', ()=>{
    const m = machine();
    const device = opened(m);
    const at = header(m, device, 0x300, BYTES_PER_SECOND / 10);
    m.winmm.waveOutWrite.handler([device, at, 32]);

    m.winmm.waveOutPause.handler([device]);
    m.tick(5000);
    m.winmm.waveOutGetID.handler([device, 0x210]);
    assert.equal(m.get32(at + 16) & WHDR_DONE, 0);

    m.winmm.waveOutRestart.handler([device]);
    m.tick(110);
    m.winmm.waveOutGetID.handler([device, 0x210]);
    assert.equal(m.get32(at + 16) & WHDR_DONE, WHDR_DONE);
});

test('a format query opens nothing', ()=>{
    const m = machine();
    m.put32(0x200, 0xdeadbeef);
    opened(m, 0x0001);
    assert.equal(m.get32(0x200), 0xdeadbeef, 'no handle was written');
});

test('the capabilities land on the fields a caller reads', ()=>{
    // szPname ends at 38 and dwFormats is a dword, so it starts at 40. A reader
    // that counts fields puts every later one two bytes early.
    const m = machine();
    assert.equal(m.winmm.waveOutGetDevCapsA.handler([0, 0x400, 52]), 0);
    assert.equal(m.memory[0x400 + 44], 2, 'wChannels, at 44 rather than 42');
    assert.notEqual(m.get32(0x400 + 40), 0, 'dwFormats, at 40 rather than 38');
    assert.equal(String.fromCharCode(...m.memory.slice(0x406, 0x40f)), 'Bottlify ');
});

test('the device families this build does not have say so', ()=>{
    const m = machine();
    assert.equal(m.winmm.waveOutGetNumDevs.handler([]), 1);
    for (const name of ['waveInGetNumDevs', 'midiOutGetNumDevs', 'mixerGetNumDevs',
        'auxGetNumDevs', 'joyGetNumDevs'])
    {
        assert.equal(m.winmm[name].handler([]), 0, `${name} reports none`);
    }
    assert.equal(m.winmm.waveInOpen.handler([0, 0, 0, 0, 0, 0]), 2, 'BADDEVICEID');
    assert.equal(m.winmm.midiOutOpen.handler([0, 0, 0, 0, 0, 0]), 2);
    assert.equal(m.winmm.mciSendCommandA.handler([0, 0, 0, 0]), 257);
});

test('a device with no byte rate in its format is refused, not stalled', ()=>{
    // A rate of zero would leave the cursor standing still and queue every
    // buffer for ever, which looks exactly like an audio device that hangs.
    const m = machine();
    for (let at = 0x100; at < 0x120; at++)
    {
        m.memory[at] = 0;
    }
    assert.equal(m.winmm.waveOutOpen.handler([0x200, 0, 0x100, 0, 0, 0]), 11,
        'MMSYSERR_INVALPARAM');
});
