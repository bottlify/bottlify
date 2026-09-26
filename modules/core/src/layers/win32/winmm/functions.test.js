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

test('PlaySound plays a WAVE image from memory, loops it, and null stops it', async()=>{
    const { createMixer } = await import('../../audio/output/mixer.js');
    const memory = new Uint8Array(0x10000);
    /** @type {string[]} */
    const diverged = [];
    const mixer = createMixer({ sampleRate: 48000 });
    const wave = /** @type {any} */ (createWinmmFunctions({
        /** @param {number} address @param {number} length */
        readMemory: (address, length)=>memory.slice(address, address + length),
        /** @param {number} address @param {Uint8Array} bytes */
        writeMemory: (address, bytes)=>memory.set(bytes, address),
        now: ()=>0,
        output: ()=>mixer,
        /** @param {string} api @param {string} detail */
        divergence: (api, detail)=>diverged.push(`${api}: ${detail}`),
    }));
    const winmm = wave.table;

    // A RIFF WAVE of eight stereo 16-bit frames at 44.1 kHz, with an odd-sized
    // chunk before the data so the pad byte is stepped over.
    const text = (/** @type {string} */ s)=>[...s].map(c=>c.charCodeAt(0));
    const le32 = (/** @type {number} */ v)=>[v & 0xff, v >>> 8 & 0xff, v >>> 16 & 0xff, v >>> 24 & 0xff];
    const fmt = [1, 0, 2, 0, ...le32(44100), ...le32(44100 * 4), 4, 0, 16, 0];
    const body = [...text('WAVE'), ...text('fmt '), ...le32(16), ...fmt,
        ...text('LIST'), ...le32(3), 1, 2, 3, 0,
        ...text('data'), ...le32(32), ...new Array(32).fill(0x40)];
    memory.set([...text('RIFF'), ...le32(body.length), ...body], 0x800);

    assert.equal(winmm.PlaySoundA.handler([0x800, 0, 0x0001 | 0x0004 | 0x0008]), 1);
    assert.equal(mixer.diagnostics().tracks, 1);
    const speaker = new Float32Array(64 * 2);
    for (let turn = 0; turn < 8; turn++)
    {
        mixer.pump();
        mixer.ring.read(speaker);
        wave.tick();
    }
    assert.ok(mixer.diagnostics().produced > 8 * 48000 / 44100 + 1,
        'a looped sound is heard past its own end');

    assert.equal(winmm.PlaySoundA.handler([0, 0, 0]), 1);
    assert.equal(mixer.diagnostics().tracks, 0, 'null stops what is playing');

    assert.equal(winmm.PlaySoundA.handler([0x800, 0, 0x00020000]), 0);
    assert.equal(diverged.length, 1, 'a file is refused out loud, not silently');
    assert.equal(winmm.PlaySoundA.argBytes, 12);
    assert.equal(winmm.sndPlaySoundA.argBytes, 8);
});

test('the timer reports the periods timeSetEvent accepts', ()=>{
    // timer.c test_timeGetDevCaps.
    const m = machine();
    const TIMERR_NOCANDO = 97;
    assert.equal(m.winmm.timeGetDevCaps.handler([0x400, 0]), TIMERR_NOCANDO);
    assert.equal(m.winmm.timeGetDevCaps.handler([0, 8]), TIMERR_NOCANDO);
    assert.equal(m.winmm.timeGetDevCaps.handler([0, 0]), TIMERR_NOCANDO);
    assert.equal(m.winmm.timeGetDevCaps.handler([0x400, 8]), 0);
    assert.deepEqual([m.get32(0x400), m.get32(0x404)], [1, 1000000],
        'wPeriodMin and wPeriodMax, the delays timeSetEvent takes');
    assert.equal(m.winmm.timeGetDevCaps.argBytes, 8);
});

test('the wave-out volume is one level for the device, heard through every track', ()=>{
    const memory = new Uint8Array(0x1000);
    /** @type {{ gain: number }[]} */
    const tracks = [];
    const wave = /** @type {any} */ (createWinmmFunctions({
        /** @param {number} address @param {number} length */
        readMemory: (address, length)=>memory.slice(address, address + length),
        /** @param {number} address @param {Uint8Array} bytes */
        writeMemory: (address, bytes)=>memory.set(bytes, address),
        now: ()=>0,
        output: ()=>({
            open(){
                const track = {
                    gain: 1, playedBytes: ()=>0, write: ()=>0, close(){}, reset(){},
                };
                tracks.push(track);
                return track;
            },
        }),
    }));
    const winmm = wave.table;
    const view = new DataView(memory.buffer);
    view.setUint32(0x100, 1 | 2 << 16, true);
    view.setUint32(0x104, 22050, true);
    view.setUint32(0x108, 22050 * 4, true);
    view.setUint32(0x10c, 4 | 16 << 16, true);
    assert.equal(winmm.waveOutOpen.handler([0x200, 0, 0x100, 0, 0, 0]), 0);
    const device = view.getUint32(0x200, true);

    assert.equal(winmm.waveOutGetVolume.handler([device, 0]), 11, 'MMSYSERR_INVALPARAM');
    assert.equal(winmm.waveOutGetVolume.handler([device, 0x300]), 0);
    assert.equal(view.getUint32(0x300, true), 0xffffffff, 'full volume to start with');

    // One level: the low word, which is what a device without separate left
    // and right control takes, and what it says it has.
    assert.equal(winmm.waveOutSetVolume.handler([device, 0x2000_8000]), 0);
    assert.equal(tracks[0].gain, 0x8000 / 0xffff);
    assert.equal(winmm.waveOutGetVolume.handler([0, 0x300]), 0, 'the device by its id');
    assert.equal(view.getUint32(0x300, true), 0x8000_8000);
    assert.equal(winmm.waveOutGetDevCapsA.handler([0, 0x400, 52]), 0);
    assert.equal(view.getUint32(0x400 + 48, true) & 0x0008, 0, 'no WAVECAPS_LRVOLUME');
    assert.equal(view.getUint32(0x400 + 48, true) & 0x0001, 1, 'but WAVECAPS_VOLUME');

    // A device opened later plays at the level already set.
    assert.equal(winmm.waveOutSetVolume.handler([0xffffffff, 0x4000]), 0, 'WAVE_MAPPER');
    assert.equal(winmm.waveOutOpen.handler([0x204, 0, 0x100, 0, 0, 0]), 0);
    assert.deepEqual(tracks.map(track=>track.gain), [0x4000 / 0xffff, 0x4000 / 0xffff]);

    assert.equal(winmm.waveOutSetVolume.handler([1, 0]), 2, 'MMSYSERR_BADDEVICEID');
    assert.equal(winmm.waveOutSetVolume.handler([0x7fff0000, 0]), 5, 'MMSYSERR_INVALHANDLE');
    assert.deepEqual([winmm.waveOutGetVolume.argBytes, winmm.waveOutSetVolume.argBytes], [8, 8]);
});

test('an error code reads as text, cut to the buffer, and an unknown one is refused', ()=>{
    const m = machine();
    const MMSYSERR_BADERRNUM = 9;
    assert.equal(m.winmm.waveOutGetErrorTextA.handler([2, 0x400, 256]), 0);
    const text = String.fromCharCode(...m.memory.slice(0x400, m.memory.indexOf(0, 0x400)));
    assert.ok(text.length > 10, `MMSYSERR_BADDEVICEID reads as "${text}"`);
    assert.equal(m.winmm.waveOutGetErrorTextA.handler([34, 0x500, 256]), 0, 'WAVERR_UNPREPARED');
    assert.notEqual(m.memory[0x500], 0);

    m.memory.fill(0xaa, 0x600, 0x610);
    assert.equal(m.winmm.waveOutGetErrorTextA.handler([2, 0x600, 5]), 0);
    assert.deepEqual([...m.memory.slice(0x600, 0x606)],
        [...text.slice(0, 4)].map(c=>c.charCodeAt(0)).concat([0, 0xaa]),
        'four characters and the terminator');
    assert.equal(m.winmm.waveOutGetErrorTextA.handler([2, 0x600, 0]), 0, 'no room, no text');
    assert.equal(m.winmm.waveOutGetErrorTextA.handler([200, 0x600, 256]), MMSYSERR_BADERRNUM);

    assert.equal(m.winmm.waveOutGetErrorTextW.handler([2, 0x700, 256]), 0);
    const wide = [];
    for (let at = 0x700; m.memory[at] | m.memory[at + 1]; at += 2)
    {
        wide.push(m.memory[at] | m.memory[at + 1] << 8);
    }
    assert.equal(String.fromCharCode(...wide), text, 'the same text in UTF-16');
    assert.deepEqual([m.winmm.waveOutGetErrorTextA.argBytes, m.winmm.waveOutGetErrorTextW.argBytes],
        [12, 12]);
});

test('wave-in reads wave-out\'s error text, and MIDI in and out read the MIDI codes', ()=>{
    // winmm.spec: waveInGetErrorTextA/W are waveOutGetErrorTextA/W, and
    // midiInGetErrorTextA/W are midiOutGetErrorTextA/W.
    const m = machine();
    const MMSYSERR_BADERRNUM = 9;
    const WAVERR_UNPREPARED = 34;
    const MIDIERR_UNPREPARED = 64;
    const MIDIERR_DONT_CONTINUE = 71;
    /** @param {number} at */
    const ansi = at=>String.fromCharCode(...m.memory.slice(at, m.memory.indexOf(0, at)));
    /** @param {number} at */
    const wide = at=>{
        const units = [];
        for (let unit = at; m.memory[unit] | m.memory[unit + 1]; unit += 2)
        {
            units.push(m.memory[unit] | m.memory[unit + 1] << 8);
        }
        return String.fromCharCode(...units);
    };
    /** @param {string} name @param {number} code @param {number} at */
    const text = (name, code, at)=>{
        m.memory.fill(0, at, at + 0x100);
        assert.equal(m.winmm[name].handler([code, at, 0x40]), 0, `${name}(${code})`);
        return name.endsWith('W') ? wide(at) : ansi(at);
    };

    const unprepared = text('waveOutGetErrorTextA', WAVERR_UNPREPARED, 0x400);
    assert.equal(text('waveInGetErrorTextA', WAVERR_UNPREPARED, 0x500), unprepared);
    assert.equal(text('waveInGetErrorTextW', WAVERR_UNPREPARED, 0x600), unprepared);

    const midi = text('midiOutGetErrorTextA', MIDIERR_UNPREPARED, 0x400);
    assert.ok(midi.length > 10 && midi !== unprepared, `MIDIERR_UNPREPARED reads as "${midi}"`);
    assert.equal(text('midiOutGetErrorTextW', MIDIERR_UNPREPARED, 0x500), midi);
    assert.equal(text('midiInGetErrorTextA', MIDIERR_UNPREPARED, 0x600), midi);
    assert.equal(text('midiInGetErrorTextW', MIDIERR_UNPREPARED, 0x700), midi);
    assert.ok(text('midiInGetErrorTextA', MIDIERR_DONT_CONTINUE, 0x400).length > 10);
    assert.equal(text('midiOutGetErrorTextA', 2, 0x400), text('waveInGetErrorTextA', 2, 0x500),
        'the shared codes read the same whichever family is asked');

    assert.equal(m.winmm.midiOutGetErrorTextA.handler([WAVERR_UNPREPARED, 0x400, 0x40]),
        MMSYSERR_BADERRNUM, 'a wave code is not a MIDI one');
    assert.equal(m.winmm.waveInGetErrorTextA.handler([MIDIERR_UNPREPARED, 0x400, 0x40]),
        MMSYSERR_BADERRNUM, 'nor a MIDI code a wave one');
    assert.deepEqual(['waveInGetErrorTextA', 'waveInGetErrorTextW', 'midiInGetErrorTextA',
        'midiInGetErrorTextW', 'midiOutGetErrorTextA', 'midiOutGetErrorTextW']
        .map(name=>m.winmm[name].argBytes), [12, 12, 12, 12, 12, 12]);
});

test('the wide MCI string calls answer as the ANSI ones do, in UTF-16', ()=>{
    const m = machine();
    const MCIERR_CANNOT_LOAD_DRIVER = 266;
    const MCI_ALL_DEVICE_ID = 0xffffffff;
    /** @param {string} text @param {number} at */
    const putWide = (text, at)=>{
        [...text].forEach((c, index)=>m.memory.set([c.charCodeAt(0) & 0xff,
            c.charCodeAt(0) >>> 8], at + index * 2));
        m.memory.set([0, 0], at + text.length * 2);
        return at;
    };

    m.memory.fill(0x55, 0x600, 0x640);
    assert.equal(m.winmm.mciSendStringW.handler([putWide('sysinfo all quantity', 0x400),
        0x600, 0x20, 0]), 0);
    assert.deepEqual([...m.memory.slice(0x600, 0x605)], [0x30, 0, 0, 0, 0x55],
        '"0" and a wide terminator');
    assert.equal(m.winmm.mciSendStringW.handler([putWide('open cdaudio alias cd', 0x400),
        0x600, 0x20, 0]), MCIERR_CANNOT_LOAD_DRIVER);
    assert.deepEqual([...m.memory.slice(0x600, 0x602)], [0, 0], 'emptied on an error');

    assert.equal(m.winmm.mciGetDeviceIDW.handler([putWide('cdaudio', 0x400)]), 0,
        'no device of that name is open');
    // mci.c: mciGetDeviceIDA("all") is MCI_ALL_DEVICE_ID.
    assert.equal(m.winmm.mciGetDeviceIDW.handler([putWide('all', 0x400)]), MCI_ALL_DEVICE_ID);
    m.memory.set([...'all'].map(c=>c.charCodeAt(0)).concat([0]), 0x480);
    assert.equal(m.winmm.mciGetDeviceIDA.handler([0x480]), MCI_ALL_DEVICE_ID);
    assert.deepEqual([m.winmm.mciSendStringW.argBytes, m.winmm.mciGetDeviceIDW.argBytes], [16, 4]);
});

test('MCI answers a command string as a machine with no MCI device does', ()=>{
    // mci.c test_mciParser for the parse errors; mcicda.c for what opening the
    // CD player gives where it cannot load; and nothing ever opens here.
    const m = machine();
    const MCIERR_UNRECOGNIZED_COMMAND = 261;
    const MCIERR_INVALID_DEVICE_NAME = 263;
    const MCIERR_CANNOT_LOAD_DRIVER = 266;
    const MCIERR_MISSING_COMMAND_STRING = 267;
    const MCIERR_CANNOT_USE_ALL = 279;
    const MCIERR_EXTENSION_NOT_FOUND = 281;
    const MCIERR_MISSING_DEVICE_NAME = 292;
    /** @param {string} command */
    const send = command=>{
        m.memory.set([...command].map(c=>c.charCodeAt(0)).concat([0]), 0x400);
        m.memory.fill(0x55, 0x600, 0x640);
        return m.winmm.mciSendStringA.handler([0x400, 0x600, 0x40, 0]);
    };
    /** The answer the return buffer holds. */
    const returned = ()=>String.fromCharCode(...m.memory.slice(0x600, m.memory.indexOf(0, 0x600)));

    assert.equal(send(''), MCIERR_MISSING_COMMAND_STRING);
    assert.equal(send('open'), MCIERR_MISSING_DEVICE_NAME);
    assert.equal(send('open cdaudio alias c notify shareable'), MCIERR_CANNOT_LOAD_DRIVER);
    assert.equal(returned(), '', 'the return buffer is emptied on an error');
    assert.equal(send('OPEN new type waveaudio alias mysound'), MCIERR_CANNOT_LOAD_DRIVER);
    assert.equal(send('open "C:\\Music\\track one.mid" alias music'), MCIERR_CANNOT_LOAD_DRIVER,
        'a sequence, by its extension');
    assert.equal(send('open C:\\data\\thing.xyz'), MCIERR_EXTENSION_NOT_FOUND);
    assert.equal(send('open nosuchdevice'), MCIERR_INVALID_DEVICE_NAME);
    assert.equal(send('play cdaudio from 1 to 2'), MCIERR_CANNOT_LOAD_DRIVER,
        'a command to a device by its type opens it first');
    assert.equal(send('play c'), MCIERR_INVALID_DEVICE_NAME, 'an alias nothing opened');
    assert.equal(send('status all time format'), MCIERR_CANNOT_USE_ALL);
    assert.equal(send('frobnicate c'), MCIERR_UNRECOGNIZED_COMMAND);
    assert.equal(send('close all'), 0, 'nothing open is nothing to close');
    assert.equal(send('sysinfo all quantity'), 0);
    assert.equal(returned(), '0');
    assert.equal(send('sysinfo cdaudio quantity open'), 0);
    assert.equal(returned(), '0');

    m.memory.set([...'cdaudio'].map(c=>c.charCodeAt(0)).concat([0]), 0x400);
    assert.equal(m.winmm.mciGetDeviceIDA.handler([0x400]), 0, 'no device of that name is open');
    assert.deepEqual([m.winmm.mciSendStringA.argBytes, m.winmm.mciGetDeviceIDA.argBytes], [16, 4]);

    // The command form's open agrees with the string form.
    const MCI_OPEN = 0x0803;
    const MCI_OPEN_TYPE = 0x2000;
    m.memory.set([...'cdaudio'].map(c=>c.charCodeAt(0)).concat([0]), 0x480);
    m.put32(0x500 + 8, 0x480);
    assert.equal(m.winmm.mciSendCommandA.handler([0, MCI_OPEN, MCI_OPEN_TYPE, 0x500]),
        MCIERR_CANNOT_LOAD_DRIVER);
});

test('the wide MCI command, the element-id lookups and the error strings', ()=>{
    const m = machine();
    const MCI_OPEN = 0x0803;
    const MCI_PLAY = 0x0806;
    const MCI_OPEN_ELEMENT = 0x0200;
    const MCI_OPEN_TYPE_ID = 0x1000;
    const MCI_OPEN_TYPE = 0x2000;
    const MCIERR_INVALID_DEVICE_ID = 257;
    const MCIERR_CANNOT_LOAD_DRIVER = 266;
    const MCIERR_EXTENSION_NOT_FOUND = 281;
    const MCIERR_NULL_PARAMETER_BLOCK = 297;
    const MCIERR_CUSTOM_DRIVER_BASE = 512;
    /** @param {string} text @param {number} at */
    const putWide = (text, at)=>{
        [...text, '\0'].forEach((c, index)=>m.memory.set([c.charCodeAt(0) & 0xff,
            c.charCodeAt(0) >>> 8], at + index * 2));
        return at;
    };
    /** @param {number} at */
    const wideAt = at=>{
        const units = [];
        for (let unit = at; m.memory[unit] | m.memory[unit + 1]; unit += 2)
        {
            units.push(m.memory[unit] | m.memory[unit + 1] << 8);
        }
        return String.fromCharCode(...units);
    };

    // MCI_OPEN_PARMSW: the type at 8, the element at 12, both UTF-16.
    const parms = 0x500;
    m.put32(parms + 8, putWide('cdaudio', 0x400));
    assert.equal(m.winmm.mciSendCommandW.handler([0, MCI_OPEN, MCI_OPEN_TYPE, parms]),
        MCIERR_CANNOT_LOAD_DRIVER, 'as the ANSI command answers for the same type');
    m.put32(parms + 12, putWide('C:\\music\\song.mid', 0x600));
    assert.equal(m.winmm.mciSendCommandW.handler([0, MCI_OPEN, MCI_OPEN_ELEMENT, parms]),
        MCIERR_CANNOT_LOAD_DRIVER);
    m.put32(parms + 12, putWide('C:\\thing.xyz', 0x600));
    assert.equal(m.winmm.mciSendCommandW.handler([0, MCI_OPEN, MCI_OPEN_ELEMENT, parms]),
        MCIERR_EXTENSION_NOT_FOUND);
    m.put32(parms + 8, 0x204);
    assert.equal(m.winmm.mciSendCommandW.handler(
        [0, MCI_OPEN, MCI_OPEN_TYPE | MCI_OPEN_TYPE_ID, parms]), MCIERR_CANNOT_LOAD_DRIVER);
    assert.equal(m.winmm.mciSendCommandW.handler([0, MCI_OPEN, MCI_OPEN_TYPE, 0]),
        MCIERR_NULL_PARAMETER_BLOCK);
    assert.equal(m.winmm.mciSendCommandW.handler([1, MCI_PLAY, 0, parms]),
        MCIERR_INVALID_DEVICE_ID, 'no device is open to play');

    m.memory.set([...'cdaudio'].map(c=>c.charCodeAt(0)).concat([0]), 0x480);
    assert.equal(m.winmm.mciGetDeviceIDFromElementIDA.handler([1, 0x480]), 0,
        'no device of the type holds the element');
    assert.equal(m.winmm.mciGetDeviceIDFromElementIDW.handler([1, putWide('cdaudio', 0x400)]), 0);

    // TRUE with the text for an MCI error, FALSE for a code MCI has none for.
    m.memory.fill(0x55, 0x700, 0x800);
    assert.equal(m.winmm.mciGetErrorStringA.handler([MCIERR_CANNOT_LOAD_DRIVER, 0x700, 128]), 1);
    const text = String.fromCharCode(...m.memory.slice(0x700, m.memory.indexOf(0, 0x700)));
    assert.ok(text.length > 10, `MCIERR_CANNOT_LOAD_DRIVER reads as "${text}"`);
    assert.equal(m.winmm.mciGetErrorStringW.handler([MCIERR_CANNOT_LOAD_DRIVER, 0x800, 128]), 1);
    assert.equal(wideAt(0x800), text, 'the same text in UTF-16');
    m.memory.fill(0x55, 0x700, 0x710);
    assert.equal(m.winmm.mciGetErrorStringA.handler([MCIERR_CANNOT_LOAD_DRIVER, 0x700, 5]), 1);
    assert.deepEqual([...m.memory.slice(0x700, 0x706)],
        [...text.slice(0, 4)].map(c=>c.charCodeAt(0)).concat([0, 0x55]), 'cut to the buffer');
    for (const unknown of [5, 256 + 27, MCIERR_CUSTOM_DRIVER_BASE + 1])
    {
        m.memory.fill(0x55, 0x700, 0x710);
        assert.equal(m.winmm.mciGetErrorStringA.handler([unknown, 0x700, 128]), 0, `${unknown}`);
        assert.equal(m.memory[0x700], 0x55, 'and the buffer is left alone');
    }
    assert.deepEqual(['mciSendCommandW', 'mciGetDeviceIDFromElementIDA',
        'mciGetDeviceIDFromElementIDW', 'mciGetErrorStringA', 'mciGetErrorStringW']
        .map(name=>m.winmm[name].argBytes), [16, 8, 8, 12, 12]);
});

test('a machine with no MIDI input and no joystick says so on every call', ()=>{
    // midi.c: midiInOpen past the last device, the mapper included, is
    // MMSYSERR_BADDEVICEID; joystick.c: an id no slot answers to is JOYERR_PARMS.
    const m = machine();
    const MMSYSERR_BADDEVICEID = 2;
    const MMSYSERR_INVALHANDLE = 5;
    const JOYERR_PARMS = 165;
    assert.equal(m.winmm.midiInGetNumDevs.handler([]), 0);
    assert.equal(m.winmm.midiInOpen.handler([0x400, 0, 0, 0, 0]), MMSYSERR_BADDEVICEID);
    assert.equal(m.winmm.midiInOpen.handler([0x400, 0xffffffff, 0, 0, 0]), MMSYSERR_BADDEVICEID,
        'MIDIMAPPER');
    assert.equal(m.winmm.midiInGetDevCapsA.handler([0, 0x400, 76]), MMSYSERR_BADDEVICEID);
    assert.equal(m.winmm.midiInGetDevCapsW.handler([0, 0x400, 76]), MMSYSERR_BADDEVICEID);
    for (const name of ['midiInClose', 'midiInStart', 'midiInStop', 'midiInReset',
        'midiInAddBuffer', 'midiInPrepareHeader', 'midiInUnprepareHeader', 'midiInGetID',
        'midiInMessage'])
    {
        assert.equal(m.winmm[name].handler([0x1234, 0, 0, 0]), MMSYSERR_INVALHANDLE, name);
    }
    assert.equal(m.winmm.joyGetPos.handler([0, 0x400]), JOYERR_PARMS);
    assert.deepEqual(['midiInGetNumDevs', 'midiInOpen', 'midiInGetDevCapsA', 'midiInGetDevCapsW',
        'midiInClose', 'midiInStart', 'midiInStop', 'midiInReset', 'midiInAddBuffer',
        'midiInPrepareHeader', 'midiInUnprepareHeader', 'midiInGetID', 'midiInMessage',
        'joyGetPos'].map(name=>m.winmm[name].argBytes),
    [0, 20, 12, 12, 4, 4, 4, 4, 12, 12, 12, 8, 16, 8]);
});
