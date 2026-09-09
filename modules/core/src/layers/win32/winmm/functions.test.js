/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWinmmFunctions } from './functions.js';
import { createWaveNotifier } from './notify.js';

const MM_WOM_OPEN = 0x3bb;
const MM_WOM_CLOSE = 0x3bc;
const MM_WOM_DONE = 0x3bd;

const CALLBACK_WINDOW = 0x00010000;
const CALLBACK_FUNCTION = 0x00030000;
const CALLBACK_EVENT = 0x00050000;

/** 44.1 kHz, 16 bit, stereo: 176400 bytes a second, which is the arithmetic below. */
const BYTES_PER_SECOND = 176400;

/** Somewhere for the guest's structures to live, and a clock we move by hand. */
function machine(){
    const memory = new Uint8Array(0x1000);
    let clock = 1000;
    /** @type {any[]} */
    const notices = [];

    const host = /** @type {import('./functions.js').WinmmHost} */ ({
        /** @param {number} address @param {number} length */
        readMemory: (address, length)=>memory.slice(address, address + length),
        /** @param {number} address @param {Uint8Array} bytes */
        writeMemory: (address, bytes)=>memory.set(bytes, address),
        now: ()=>clock,
        /** @param {any} notice */
        notify: notice=>{
            notices.push(notice);
        },
    });

    /** @param {number} at @param {number} value */
    const put32 = (at, value)=>memory.set(new Uint8Array([
        value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff,
    ]), at);
    /** @param {number} at */
    const get32 = at=>(memory[at] | memory[at + 1] << 8
        | memory[at + 2] << 16 | memory[at + 3] << 24) >>> 0;

    const engine = /** @type {any} */ (createWinmmFunctions(host));

    return {
        memory, host, notices, put32, get32,
        winmm: engine.table,
        /** What the machine's driver does from outside any guest call. */
        pulse: ()=>engine.tick(),
        /** @returns {any[]} */
        report: ()=>engine.diagnostics(),
        /** @param {number} ms */
        tick: ms=>{
            clock += ms;
        },
        /** Only the buffer-came-back ones; open and close are notices too. */
        done: ()=>notices.filter((/** @type {any} */ n)=>n.message === MM_WOM_DONE),
        at: ()=>clock,
    };
}

/** A WAVEFORMATEX at 0x100 and an opened device. @param {any} m */
function opened(m, flags = 0, callback = 0){
    m.put32(0x100, 16 | 2 << 16); // wFormatTag = PCM, nChannels = 2
    m.put32(0x104, 44100);
    m.put32(0x108, BYTES_PER_SECOND);
    m.put32(0x10c, 4 | 16 << 16); // nBlockAlign, wBitsPerSample

    // A callback form is owed MM_WOM_OPEN, and delivering that means running
    // guest code -- so the answer may be a promise. The handle is written
    // before either way, which is the point of the ordering.
    const answer = m.winmm.waveOutOpen.handler([0x200, 0, 0x100, callback, 0x1234, flags]);
    assert.ok(answer === 0 || typeof answer?.then === 'function', 'the device opened');
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
    assert.equal(m.done().length, 1, 'the caller was told once');
    assert.equal(m.done()[0].param, at, 'and told which buffer');
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
    assert.deepEqual(m.done().map((/** @type {any} */ n)=>n.param), [first, second]);
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

test('a driven device retires buffers without the program asking anything', ()=>{
    // The one that matters. A program may wait for a buffer by spinning on
    // WHDR_DONE in its own header -- on Windows another thread sets it -- and
    // while it spins it calls nothing at all. Nothing inside the guest would
    // ever move the cursor, so without a tick from outside the wait is a
    // deadlock by construction.
    const m = machine();
    const device = opened(m);
    const at = header(m, device, 0x300, BYTES_PER_SECOND / 10);
    m.winmm.waveOutWrite.handler([device, at, 32]);

    m.tick(150);
    m.pulse();
    assert.equal(m.get32(at + 16) & WHDR_DONE, WHDR_DONE,
        'the flag the program is spinning on was set with no call from it');
    assert.equal(m.done().length, 1, 'and the notification went out too');
});

test('a tick on a device with nothing queued costs nothing', ()=>{
    const m = machine();
    const device = opened(m);
    m.tick(5000);
    m.pulse();
    m.pulse();

    const at = header(m, device, 0x300, BYTES_PER_SECOND / 10);
    m.winmm.waveOutWrite.handler([device, at, 32]);
    m.tick(1);
    m.pulse();
    assert.equal(m.get32(at + 16) & WHDR_DONE, 0,
        'five seconds of ticking through silence bought the buffer nothing');
});

test('the open and close of a device are notices of their own', ()=>{
    const m = machine();
    const device = opened(m);
    assert.deepEqual(m.notices.map((/** @type {any} */ n)=>n.message), [MM_WOM_OPEN]);
    assert.equal(m.notices[0].device, device, 'and it names the handle just handed out');

    assert.equal(m.winmm.waveOutClose.handler([device]), 0);
    assert.deepEqual(m.notices.map((/** @type {any} */ n)=>n.message),
        [MM_WOM_OPEN, MM_WOM_CLOSE]);
});

test('reset returns every queued buffer, in order, with a notice each', ()=>{
    const m = machine();
    const device = opened(m);
    const first = header(m, device, 0x300, BYTES_PER_SECOND);
    const second = header(m, device, 0x340, BYTES_PER_SECOND);
    m.winmm.waveOutWrite.handler([device, first, 32]);
    m.winmm.waveOutWrite.handler([device, second, 32]);

    assert.equal(m.winmm.waveOutReset.handler([device]), 0);
    assert.deepEqual(m.done().map((/** @type {any} */ n)=>n.param), [first, second]);
});

test('a build with no notify behaves exactly as it did', ()=>{
    // The flags are the contract; the notification is on top of it. A host that
    // cannot reach guest code is not a broken one, and a program that polls
    // must not be able to tell the difference.
    const memory = new Uint8Array(0x1000);
    let clock = 1000;
    const winmm = /** @type {any} */ (createWinmmFunctions({
        /** @param {number} address @param {number} length */
        readMemory: (address, length)=>memory.slice(address, address + length),
        /** @param {number} address @param {Uint8Array} bytes */
        writeMemory: (address, bytes)=>memory.set(bytes, address),
        now: ()=>clock,
    })).table;

    /** @param {number} at @param {number} value */
    const put32 = (at, value)=>memory.set(new Uint8Array([
        value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff,
    ]), at);
    put32(0x100, 16 | 2 << 16);
    put32(0x104, 44100);
    put32(0x108, BYTES_PER_SECOND);
    put32(0x10c, 4 | 16 << 16);
    assert.equal(winmm.waveOutOpen.handler([0x200, 0, 0x100, 0x9000, 0, CALLBACK_FUNCTION]), 0);

    const device = memory[0x200] | memory[0x201] << 8;
    put32(0x300, 0x800);
    put32(0x304, BYTES_PER_SECOND / 10);
    put32(0x310, 0);
    assert.equal(winmm.waveOutPrepareHeader.handler([device, 0x300, 32]), 0);
    assert.equal(winmm.waveOutWrite.handler([device, 0x300, 32]), 0,
        'a plain number, not a promise');

    clock += 150;
    assert.equal(winmm.waveOutGetID.handler([device, 0x210]), 0);
    assert.equal(memory[0x310] & WHDR_DONE, WHDR_DONE, 'and the flag still arrives');
});

test('a callback that runs guest code parks the entry point that retired the buffer', async()=>{
    // The callback form is the only one that cannot answer at once: running
    // guest code means stopping the thread that called, which a handler can
    // only do by returning a promise.
    const m = machine();
    /** @type {any[]} */
    const calls = [];
    /** @type {(value: number) => void} */
    let answer = ()=>{};
    m.host.notify = (/** @type {any} */ notice)=>{
        calls.push(notice);
        return new Promise(resolve=>{
            answer = resolve;
        });
    };

    const device = opened(m, CALLBACK_FUNCTION, 0x38230b0);
    assert.equal(calls.length, 1, 'the open notice went first');
    answer(0);
    await Promise.resolve();

    const at = header(m, device, 0x300, BYTES_PER_SECOND / 10);
    m.winmm.waveOutWrite.handler([device, at, 32]);
    m.tick(150);

    const pending = m.winmm.waveOutGetID.handler([device, 0x210]);
    assert.equal(typeof pending.then, 'function', 'the entry point is waiting');
    assert.equal(m.get32(at + 16) & WHDR_DONE, WHDR_DONE,
        'and the flag was set before the callback was entered, not after');
    answer(0);
    assert.equal(await pending, 0, 'then it answers what it always would have');
});

test('several buffers retiring at once are delivered one at a time, in order', async()=>{
    const m = machine();
    /** @type {number[]} */
    const entered = [];
    /** @type {(() => void)[]} */
    const waiting = [];
    m.host.notify = (/** @type {any} */ notice)=>{
        if (notice.message !== MM_WOM_DONE)
        {
            return;
        }
        entered.push(notice.param);
        return new Promise(resolve=>waiting.push(()=>resolve(0)));
    };

    const device = opened(m, CALLBACK_FUNCTION, 0x9000);
    const first = header(m, device, 0x300, BYTES_PER_SECOND / 10);
    const second = header(m, device, 0x340, BYTES_PER_SECOND / 10);
    m.winmm.waveOutWrite.handler([device, first, 32]);
    m.winmm.waveOutWrite.handler([device, second, 32]);

    m.tick(500);
    const pending = m.winmm.waveOutGetID.handler([device, 0x210]);
    assert.deepEqual(entered, [first],
        'the second is not entered while the first is still running');

    waiting.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(entered, [first, second], 'and then it is');
    waiting.shift()?.();
    assert.equal(await pending, 0);
});

test('a tick defers the callback form and delivers the rest', async()=>{
    // A tick has no guest thread stopped anywhere, so it cannot run guest code.
    // The flag is still set -- that is what a spinning program needs -- and the
    // callback goes out from the next entry point, which does have a thread.
    const m = machine();
    /** @type {any[]} */
    const calls = [];
    m.host.notify = (/** @type {any} */ notice)=>{
        calls.push(notice);
        return notice.kind === CALLBACK_FUNCTION ? Promise.resolve(0) : undefined;
    };

    const device = opened(m, CALLBACK_FUNCTION, 0x9000);
    await new Promise(resolve=>setTimeout(resolve, 0));
    calls.length = 0;
    const at = header(m, device, 0x300, BYTES_PER_SECOND / 10);
    m.winmm.waveOutWrite.handler([device, at, 32]);

    m.tick(150);
    m.pulse();
    assert.equal(m.get32(at + 16) & WHDR_DONE, WHDR_DONE, 'the flag is set anyway');
    assert.equal(calls.length, 0, 'and nothing was called with no thread to call on');

    await m.winmm.waveOutGetID.handler([device, 0x210]);
    assert.deepEqual(calls.map((/** @type {any} */ n)=>n.param), [at],
        'the notice was kept and delivered at the first chance');
});

test('the notifier sends each form somewhere different', async()=>{
    /** @type {any[]} */
    const posted = [];
    /** @type {number[]} */
    const signalled = [];
    /** @type {any[]} */
    const called = [];
    const notify = createWaveNotifier({
        callGuest: (entry, args)=>{
            called.push({ entry, args });
            return Promise.resolve(0);
        },
        post: message=>posted.push(message),
        signal: handle=>signalled.push(handle),
    });

    const notice = {
        instance: 0x1234, device: 0x1000, message: MM_WOM_DONE, param: 0x300,
    };

    notify({ ...notice, kind: CALLBACK_WINDOW, target: 0x77 });
    assert.deepEqual(posted, [{
        hwnd: 0x77, message: MM_WOM_DONE, wParam: 0x1000, lParam: 0x300,
    }], 'the window form carries the device and the header, and no instance');

    notify({ ...notice, kind: CALLBACK_EVENT, target: 0x88 });
    assert.deepEqual(signalled, [0x88], 'the event form says only that something happened');
    assert.equal(posted.length, 1, 'and posts nothing');

    assert.equal(await notify({ ...notice, kind: CALLBACK_FUNCTION, target: 0x99 }), 0);
    assert.deepEqual(called, [{
        entry: 0x99,
        // waveOutProc(hwo, uMsg, dwInstance, dwParam1, dwParam2)
        args: [0x1000, MM_WOM_DONE, 0x1234, 0x300, 0],
    }]);

    notify({ ...notice, kind: 0, target: 0x99 });
    assert.equal(called.length, 1, 'CALLBACK_NULL is owed nothing');
    assert.equal(posted.length, 1);
    assert.equal(signalled.length, 1);
});

test('the report counts a buffer out and back, and names the cursor driving it', ()=>{
    // A program that stops because a buffer did not come back says nothing
    // about it; from outside the machine only looks slow. `written` against
    // `retired` is what tells a stall from a slow run, and `cursor` is what
    // says which of the two paths ran -- a page with the sound off exercises
    // only one of them, so a defect in the other is invisible without it.
    const m = machine();
    const device = opened(m);

    assert.deepEqual(m.report().map((/** @type {any} */ d)=>
        [d.handle, d.cursor, d.written, d.retired]), [[device, 'clock', 0, 0]]);

    m.winmm.waveOutWrite.handler([device, header(m, device, 0x300, 176400), 32]);
    assert.deepEqual(m.report()[0].written, 1);
    assert.deepEqual(m.report()[0].retired, 0, 'still with the device');
    assert.equal(m.report()[0].queued, 1);
    assert.equal(m.report()[0].bytesWritten, 176400);

    m.tick(1000);
    m.pulse();
    assert.equal(m.report()[0].retired, 1, 'a second of sound, and it is back');
    assert.equal(m.report()[0].bytesRetired, 176400);
    assert.equal(m.report()[0].queued, 0);
});

test('a callback nobody can deliver is reported as owed, not as delivered', ()=>{
    // The buffer came back and the program has not been told. A callback is
    // guest code and needs a thread stopped somewhere known, which a tick has
    // not got, so it waits for the next winmm call the program makes -- and a
    // program that made its last one is never told again. That is a real
    // divergence from Windows, which delivers on a system thread, and this is
    // the only place it is visible.
    const m = machine();
    const device = opened(m, CALLBACK_FUNCTION, 0x9000);
    m.winmm.waveOutWrite.handler([device, header(m, device, 0x300, 176400), 32]);

    m.tick(1000);
    m.pulse();

    const flags = m.get32(0x300 + 16);
    assert.ok((flags & WHDR_DONE) !== 0, 'the flag is set from the tick');
    assert.equal(m.done().length, 0, 'and the program has not been told');
    assert.equal(m.report()[0].owed, 1);
    assert.equal(m.report()[0].deferred, true, 'because only a thread can run it');

    // The next call the program makes is the first moment there is one.
    m.winmm.waveOutGetID.handler([device, 0x210]);
    assert.equal(m.done().length, 1);
    assert.equal(m.report()[0].owed, 0);
    assert.equal(m.report()[0].deferred, false);
});

test('a device with a real mixer retires even a very small buffer', async()=>{
    // Miles opens a wave device and writes one tiny buffer as a probe, then
    // waits for WOM_DONE before it will write anything else. A device that
    // never retires that buffer leaves the program spinning for ever with
    // nothing drawn -- which from outside is a black window, not a silent one.
    const { createMixer } = await import('../../audio/output/mixer.js');
    const memory = new Uint8Array(0x10000);
    let clock = 0;

    const mixer = createMixer({ sampleRate: 48000 });
    const wave = /** @type {any} */ (createWinmmFunctions({
        /** @param {number} address @param {number} length */
        readMemory: (address, length)=>memory.slice(address, address + length),
        /** @param {number} address @param {Uint8Array} bytes */
        writeMemory: (address, bytes)=>memory.set(bytes, address),
        now: ()=>clock,
        output: ()=>mixer,
    }));
    const winmm = wave.table;

    /** @param {number} at @param {number} value */
    const put32 = (at, value)=>memory.set(new Uint8Array([
        value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff,
    ]), at);
    // WAVEFORMATEX: PCM, stereo, 44100 Hz, 16 bits -- what a program of this
    // era opens with, and 32 bytes of it is eight frames.
    put32(0x100, 1 | 2 << 16);
    put32(0x104, 44100);
    put32(0x108, 44100 * 4);
    put32(0x10c, 4 | 16 << 16);
    assert.equal(winmm.waveOutOpen.handler([0x200, 0, 0x100, 0, 0, 0]), 0);
    const device = memory[0x200] | memory[0x201] << 8;

    put32(0x300, 0x800);
    put32(0x304, 32);
    assert.equal(winmm.waveOutPrepareHeader.handler([device, 0x300, 32]), 0);
    assert.equal(winmm.waveOutWrite.handler([device, 0x300, 32]), 0);

    // The device plays it and the ring drains, as a running worklet would,
    // and the driver's own tick moves the cursor between guest calls.
    const speaker = new Float32Array(256 * 2);
    for (let turn = 0; turn < 16; turn++)
    {
        mixer.pump();
        mixer.ring.read(speaker);
        clock += 50;
        wave.tick();
    }

    const flags = memory[0x300 + 16] | memory[0x300 + 17] << 8;
    assert.ok((flags & 0x00000001) !== 0, `the buffer came back (flags 0x${flags.toString(16)})`);
    // And the report says which of the two cursors did it, which is the only
    // way to tell this path from the one a page with the sound off takes.
    assert.equal(wave.diagnostics()[0].cursor, 'device');
    assert.equal(wave.diagnostics()[0].retired, 1);
});

test('every notice of a burst is delivered on the thread whose call it answers', async()=>{
    // Delivering one means running guest code: the caller parks on a promise
    // while it does, and the loop gives every other thread its turns. By the
    // time the next notice goes out the thread on the processor is somebody
    // else -- and a callback frame built on a stranger's stack is a crash with
    // no author, which is exactly how one arrived.
    const m = machine();
    /** @type {{ message: number, thread: string | undefined }[]} */
    const delivered = [];
    /** @type {((value: number) => void)[]} */
    const waiting = [];
    let current = { name: 'main' };
    m.host.currentThread = ()=>current;
    /** @param {any} notice @param {any} thread */
    m.host.notify = (notice, thread)=>{
        delivered.push({ message: notice.message, thread: thread?.name });
        return new Promise(resolve=>waiting.push(resolve));
    };

    const device = opened(m, CALLBACK_FUNCTION, 0x38230b0);
    assert.deepEqual(delivered.map(one=>one.thread), ['main'],
        'the open notice went out on the thread that opened');

    // The loop handed the processor to somebody else while that was running.
    current = { name: 'thread-7' };
    waiting.shift()?.(0);
    await Promise.resolve();
    await Promise.resolve();

    assert.ok(delivered.every(one=>one.thread === 'main'),
        'and every notice after it still belongs to the thread whose call it answers');
    assert.ok(device > 0);
});

test('a callback-form WOM_DONE goes to the notice thread, never to the caller', ()=>{
    // The device's driver delivers WOM_DONE from a thread of its own. A program
    // is written against that: its write path and its callback take one lock,
    // which is a recursion on the caller's stack and a handoff on two threads.
    const m = machine();
    /** @type {any[]} */
    const threaded = [];
    m.host.deliverDone = (/** @type {any} */ notice)=>threaded.push(notice);

    const device = opened(m, CALLBACK_FUNCTION, 0x38230b0);
    assert.equal(m.notices.length, 1, 'the open notice still goes out on the caller');
    assert.equal(m.notices[0].message, MM_WOM_OPEN);

    const at = header(m, device, 0x300, BYTES_PER_SECOND / 10);
    m.winmm.waveOutWrite.handler([device, at, 32]);
    m.tick(150);
    m.pulse();

    assert.equal(m.get32(at + 16) & WHDR_DONE, WHDR_DONE, 'the flag is set first');
    assert.deepEqual(threaded.map((/** @type {any} */ n)=>[n.message, n.param, n.target]),
        [[MM_WOM_DONE, at, 0x38230b0]], 'and the done notice went to the thread, from the tick');
    assert.equal(m.notices.length, 1, 'not to the caller');
    assert.equal(m.report()[0].owed, 0, 'nothing is held back');
    assert.equal(m.report()[0].deferred, false);

    const answer = m.winmm.waveOutGetID.handler([device, 0x210]);
    assert.equal(answer, 0, 'and no entry point is parked for it');
});
