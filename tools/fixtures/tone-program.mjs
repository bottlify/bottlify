/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Programs that play a tone of a known pitch and length, built by
 * `make-pe.mjs`, for the tests that check sound reaches the speaker whole
 * (`sound-delivery.itest.js`). Dev tooling: never imported by a package.
 */

import { buildExe } from './make-pe.mjs';
import { u32, push, pushArgs, call } from './gl-program.mjs';

export const RATE = 48000;
/** The tone: a second of 1 kHz, the period SDL hands WASAPI at a time. */
export const TONE_FRAMES = RATE;
export const TONE_HZ = 1000;
export const CHUNK = 480;

/** @param {number} frames @returns {number[]} a sine at TONE_HZ, signed 16-bit mono */
const tone = frames=>{
    const bytes = [];
    for (let n = 0; n < frames; n++)
    {
        const value = Math.round(Math.sin(2 * Math.PI * TONE_HZ * n / RATE) * 16000);
        bytes.push(value & 0xff, (value >> 8) & 0xff);
    }
    return bytes;
};

/** @param {string} text @returns {number[]} a GUID's sixteen bytes */
const guid = text=>{
    const hex = text.replace(/[{}-]/g, '');
    /** @type {number[]} */
    const bytes = [];
    /** A field of the GUID, little-endian. @param {number} from @param {number} length */
    const word = (from, length)=>{
        for (let at = from + length - 2; at >= from; at -= 2)
        {
            bytes.push(parseInt(hex.slice(at, at + 2), 16));
        }
    };
    word(0, 8);
    word(8, 4);
    word(12, 4);
    for (let at = 16; at < 32; at += 2) bytes.push(parseInt(hex.slice(at, at + 2), 16));
    return bytes;
};

/**
 * A program playing the tone as SDL 2 plays to WASAPI: a shared, event-driven
 * stream whose chunk is half the buffer GetBufferSize answers (SDL's
 * PrepDevice: "fill half of the DMA buffer on each run"), and on each event a
 * chunk written when no more than a chunk is still to play (its WaitDevice),
 * until the tone is out; then it waits for it to be heard and exits.
 *
 * Busy, the stream is fed from a thread of its own while the main thread waits
 * for its next frame as a game does - QueryPerformanceCounter and Sleep(1)
 * round and round - which is how a game's sound thread meets the scheduler.
 *
 * @param {{ busy?: boolean }} [options]
 */
export function wasapiTone({ busy = false } = {}){
    return buildExe({
        imports: {
            'ole32.dll': ['CoInitialize', 'CoCreateInstance'],
            'KERNEL32.dll': ['CreateEventA', 'WaitForSingleObject', 'Sleep', 'ExitProcess',
                'CreateThread', 'QueryPerformanceCounter'],
        },
        codeSize: 0x400,
        data: {
            clsidEnumerator: guid('{BCDE0395-E52F-467C-8E3D-C4579291692E}'),
            iidEnumerator: guid('{A95664D2-9614-4F35-A746-DE8DB63617E6}'),
            iidClient: guid('{1CB9AD4C-DBFA-4C32-B178-C2F568A703B2}'),
            iidRender: guid('{F294ACFC-3146-4483-A7BF-ADDCA7C260E2}'),
            // WAVEFORMATEX: PCM, mono, 48 kHz, 16 bits.
            format: [1, 0, 1, 0, ...u32(RATE), ...u32(RATE * 2), 2, 0, 16, 0, 0, 0],
            enumerator: u32(0), device: u32(0), client: u32(0), render: u32(0),
            event: u32(0), padding: u32(0), data: u32(0), cursor: u32(0), left: u32(0),
            chunk: u32(0), counter: [...u32(0), ...u32(0)],
            // The tone, and silence behind it for a last chunk that runs past.
            tone: [...tone(TONE_FRAMES), ...new Array(RATE).fill(0)],
        },
        code: ({ iat, at, code })=>{
            /** @type {number[]} */
            const bytes = [];
            let step = 0;
            /** An HRESULT or a handle of zero ends the program with the step's number. */
            const check = (/** @type {boolean} */ zeroIsBad = false)=>{
                step++;
                bytes.push(0x85, 0xc0, zeroIsBad ? 0x75 : 0x74, 11, ...push(step),
                    0xff, 0x15, ...u32(iat('ExitProcess')));
            };
            /** `object->method(...)`, its arguments already pushed, stdcall through its vtable. */
            const comPushed = (/** @type {string} */ object, /** @type {number} */ slot)=>{
                bytes.push(0xa1, ...u32(at(object)), 0x50, 0x8b, 0x08,
                    0xff, 0x91, ...u32(slot * 4));
                check();
            };
            /** `object->method(args)` */
            const com = (/** @type {string} */ object, /** @type {number} */ slot,
                /** @type {number[]} */ args)=>
            {
                bytes.push(...pushArgs(args));
                comPushed(object, slot);
            };
            /** `push dword [name]` */
            const pushAt = (/** @type {string} */ name)=>bytes.push(0xff, 0x35, ...u32(at(name)));
            bytes.push(...call(iat, 'CoInitialize', [0]));
            bytes.push(...call(iat, 'CoCreateInstance', [at('clsidEnumerator'), 0, 0x17,
                at('iidEnumerator'), at('enumerator')]));
            check();
            com('enumerator', 4, [0, 0, at('device')]);
            com('device', 3, [at('iidClient'), 0x17, 0, at('client')]);
            // Initialize(SHARED, EVENTCALLBACK | AUTOCONVERTPCM, duration 0,
            // period 0, format, no session): mono 16-bit, converted to the mix.
            com('client', 3, [0, 0x80040000, 0, 0, 0, 0, at('format'), 0]);
            // chunk = GetBufferSize() / 2
            com('client', 4, [at('chunk')]);
            bytes.push(0xd1, 0x2d, ...u32(at('chunk')));
            bytes.push(...call(iat, 'CreateEventA', [0, 0, 0, 0]), 0xa3, ...u32(at('event')));
            check(true);
            bytes.push(0xff, 0x35, ...u32(at('event')));
            com('client', 13, []);
            com('client', 14, [at('iidRender'), at('render')]);
            com('client', 10, []);
            bytes.push(0xc7, 0x05, ...u32(at('cursor')), ...u32(at('tone')));
            bytes.push(0xc7, 0x05, ...u32(at('left')), ...u32(TONE_FRAMES));
            // Busy: jump over the stream's loop to the main thread's, which starts it.
            const over = bytes.length;
            if (busy)
            {
                bytes.push(0xe9, 0, 0, 0, 0);
            }
            const loop = bytes.length;
            bytes.push(...push(1000), 0xff, 0x35, ...u32(at('event')),
                0xff, 0x15, ...u32(iat('WaitForSingleObject')));
            com('client', 6, [at('padding')]);
            // More than a chunk still to play: wait for the next event.
            bytes.push(0xa1, ...u32(at('padding')), 0x3b, 0x05, ...u32(at('chunk')), 0x0f, 0x87);
            bytes.push(...u32(loop - (bytes.length + 4)));
            // GetBuffer(chunk, &data)
            bytes.push(...push(at('data')));
            pushAt('chunk');
            comPushed('render', 3);
            // the chunk's 16-bit frames from the tone
            bytes.push(0x8b, 0x35, ...u32(at('cursor')), 0x8b, 0x3d, ...u32(at('data')),
                0x8b, 0x0d, ...u32(at('chunk')), 0xd1, 0xe1, 0xf3, 0xa4,
                0x89, 0x35, ...u32(at('cursor')));
            // ReleaseBuffer(chunk, 0)
            bytes.push(...push(0));
            pushAt('chunk');
            comPushed('render', 4);
            bytes.push(0xa1, ...u32(at('left')), 0x2b, 0x05, ...u32(at('chunk')),
                0xa3, ...u32(at('left')), 0x0f, 0x8f);
            bytes.push(...u32(loop - (bytes.length + 4)));
            bytes.push(...call(iat, 'Sleep', [400]), ...call(iat, 'ExitProcess', [0]));
            if (busy)
            {
                bytes.splice(over + 1, 4, ...u32(bytes.length - (over + 5)));
                // CreateThread(NULL, 0, the stream's loop, NULL, 0, NULL)
                bytes.push(...call(iat, 'CreateThread', [0, 0, code(loop), 0, 0, 0]));
                check(true);
                const spin = bytes.length;
                bytes.push(...call(iat, 'QueryPerformanceCounter', [at('counter')]),
                    ...call(iat, 'Sleep', [1]), 0xe9);
                bytes.push(...u32(spin - (bytes.length + 4)));
            }
            return bytes;
        },
    });
}

/** waveOut's buffers: how many, and the frames of each. */
const WAVE_BUFFERS = 3;
const WAVE_FRAMES = 960;

/**
 * A program playing the tone as a game of the waveOut years does: three
 * buffers of 20 ms, written once and then each written again with the next
 * stretch of the tone as its WHDR_DONE comes back, woken by an event
 * (CALLBACK_EVENT), until the tone is out; then it waits for it to be heard
 * and exits.
 */
export function waveOutTone(){
    /** @type {Record<string, number[]>} */
    const buffers = {};
    for (let n = 0; n < WAVE_BUFFERS; n++)
    {
        // WAVEHDR: lpData, dwBufferLength, dwBytesRecorded, dwUser, dwFlags,
        // dwLoops, lpNext, reserved.
        buffers[`header${n}`] = new Array(32).fill(0);
        buffers[`buffer${n}`] = new Array(WAVE_FRAMES * 2).fill(0);
    }
    return buildExe({
        imports: {
            'WINMM.dll': ['waveOutOpen', 'waveOutPrepareHeader', 'waveOutWrite'],
            'KERNEL32.dll': ['CreateEventA', 'WaitForSingleObject', 'Sleep', 'ExitProcess'],
        },
        codeSize: 0x800,
        data: {
            // WAVEFORMATEX: PCM, mono, 48 kHz, 16 bits.
            format: [1, 0, 1, 0, ...u32(RATE), ...u32(RATE * 2), 2, 0, 16, 0, 0, 0],
            out: u32(0), event: u32(0), cursor: u32(0), left: u32(0),
            ...buffers,
            tone: [...tone(TONE_FRAMES), ...new Array(RATE).fill(0)],
        },
        code: ({ iat, at })=>{
            /** @type {number[]} */
            const bytes = [];
            let step = 0;
            /** An MMRESULT other than zero, or a handle of zero, ends the program with the step's number. */
            const check = (/** @type {boolean} */ zeroIsBad = false)=>{
                step++;
                bytes.push(0x85, 0xc0, zeroIsBad ? 0x75 : 0x74, 11, ...push(step),
                    0xff, 0x15, ...u32(iat('ExitProcess')));
            };
            /** Copies the next stretch of the tone into buffer n and writes its header. */
            const refill = (/** @type {number} */ n)=>{
                const code = [];
                code.push(0x8b, 0x35, ...u32(at('cursor')), 0xbf, ...u32(at(`buffer${n}`)),
                    0xb9, ...u32(WAVE_FRAMES * 2), 0xf3, 0xa4, 0x89, 0x35, ...u32(at('cursor')));
                // sub dword [left], WAVE_FRAMES
                code.push(0x81, 0x2d, ...u32(at('left')), ...u32(WAVE_FRAMES));
                code.push(...push(32), ...push(at(`header${n}`)), 0xff, 0x35, ...u32(at('out')),
                    0xff, 0x15, ...u32(iat('waveOutWrite')));
                return code;
            };
            bytes.push(...call(iat, 'CreateEventA', [0, 0, 0, 0]), 0xa3, ...u32(at('event')));
            check(true);
            // waveOutOpen(&out, WAVE_MAPPER, &format, event, 0, CALLBACK_EVENT)
            bytes.push(...push(0x50000), ...push(0), 0xff, 0x35, ...u32(at('event')),
                ...push(at('format')), ...push(0xffffffff), ...push(at('out')),
                0xff, 0x15, ...u32(iat('waveOutOpen')));
            check();
            bytes.push(0xc7, 0x05, ...u32(at('cursor')), ...u32(at('tone')));
            bytes.push(0xc7, 0x05, ...u32(at('left')), ...u32(TONE_FRAMES));
            for (let n = 0; n < WAVE_BUFFERS; n++)
            {
                const header = at(`header${n}`);
                bytes.push(0xc7, 0x05, ...u32(header), ...u32(at(`buffer${n}`)));
                bytes.push(0xc7, 0x05, ...u32(header + 4), ...u32(WAVE_FRAMES * 2));
                bytes.push(...push(32), ...push(header), 0xff, 0x35, ...u32(at('out')),
                    0xff, 0x15, ...u32(iat('waveOutPrepareHeader')));
                check();
                bytes.push(...refill(n));
                check();
            }
            const loop = bytes.length;
            bytes.push(...push(1000), 0xff, 0x35, ...u32(at('event')),
                0xff, 0x15, ...u32(iat('WaitForSingleObject')));
            for (let n = 0; n < WAVE_BUFFERS; n++)
            {
                // A buffer back (WHDR_DONE) while the tone has more: written again.
                const again = refill(n);
                const skip = again.length;
                // test dword [header+16], 1; jz past; cmp dword [left], 0; jle past
                bytes.push(0xf7, 0x05, ...u32(at(`header${n}`) + 16), ...u32(1), 0x74, skip + 9,
                    0x83, 0x3d, ...u32(at('left')), 0, 0x7e, skip);
                bytes.push(...again);
            }
            // cmp dword [left], 0; jg loop
            bytes.push(0x83, 0x3d, ...u32(at('left')), 0, 0x0f, 0x8f);
            bytes.push(...u32(loop - (bytes.length + 4)));
            bytes.push(...call(iat, 'Sleep', [400]), ...call(iat, 'ExitProcess', [0]));
            return bytes;
        },
    });
}

/** The DirectSound buffer's bytes: 100 ms, and the least it is topped up by: 10 ms. */
const DS_BYTES = RATE * 2 / 10;
const DS_LEAST = RATE * 2 / 100;

/**
 * A program playing the tone as a game streams to DirectSound: a looping
 * secondary buffer of 100 ms, filled before Play, then every 5 ms the stretch
 * the play cursor has left behind written again from the tone (two parts
 * where it wraps), until the tone and a buffer of silence after it are out;
 * then it waits for the buffer to be heard and exits.
 */
export function directSoundTone(){
    return buildExe({
        imports: {
            'DSOUND.dll': ['DirectSoundCreate'],
            'KERNEL32.dll': ['Sleep', 'ExitProcess'],
        },
        codeSize: 0x400,
        data: {
            // WAVEFORMATEX: PCM, mono, 48 kHz, 16 bits.
            format: [1, 0, 1, 0, ...u32(RATE), ...u32(RATE * 2), 2, 0, 16, 0, 0, 0],
            // DSBUFFERDESC: dwSize, GETCURRENTPOSITION2 | GLOBALFOCUS, the bytes,
            // reserved, the format (set by the code), the 3D algorithm.
            desc: [...u32(36), ...u32(0x18000), ...u32(DS_BYTES), ...u32(0), ...u32(0),
                ...new Array(16).fill(0)],
            device: u32(0), buffer: u32(0), p1: u32(0), n1: u32(0), p2: u32(0), n2: u32(0),
            play: u32(0), writer: u32(0), at: u32(0), amount: u32(0), cursor: u32(0),
            left: u32(0),
            tone: [...tone(TONE_FRAMES), ...new Array(RATE * 2).fill(0)],
        },
        code: ({ iat, at })=>{
            /** @type {number[]} */
            const bytes = [];
            let step = 0;
            const check = ()=>{
                step++;
                bytes.push(0x85, 0xc0, 0x74, 11, ...push(step),
                    0xff, 0x15, ...u32(iat('ExitProcess')));
            };
            /** `object->method(...)` with its arguments pushed, stdcall through its vtable. */
            const comPushed = (/** @type {string} */ object, /** @type {number} */ slot)=>{
                bytes.push(0xa1, ...u32(at(object)), 0x50, 0x8b, 0x08,
                    0xff, 0x91, ...u32(slot * 4));
                check();
            };
            const pushAt = (/** @type {string} */ name)=>bytes.push(0xff, 0x35, ...u32(at(name)));
            /** Locks [at] for [amount] bytes, copies the tone's next bytes into both parts, unlocks. */
            const write = ()=>{
                bytes.push(...push(0), ...push(at('n2')), ...push(at('p2')), ...push(at('n1')),
                    ...push(at('p1')));
                pushAt('amount');
                pushAt('at');
                comPushed('buffer', 11);
                bytes.push(0x8b, 0x35, ...u32(at('cursor')),
                    0x8b, 0x3d, ...u32(at('p1')), 0x8b, 0x0d, ...u32(at('n1')), 0xf3, 0xa4,
                    0x8b, 0x3d, ...u32(at('p2')), 0x8b, 0x0d, ...u32(at('n2')), 0xf3, 0xa4,
                    0x89, 0x35, ...u32(at('cursor')));
                pushAt('n2');
                pushAt('p2');
                pushAt('n1');
                pushAt('p1');
                comPushed('buffer', 19);
            };
            bytes.push(...pushArgs([0, at('device'), 0]),
                0xff, 0x15, ...u32(iat('DirectSoundCreate')));
            check();
            bytes.push(0xc7, 0x05, ...u32(at('desc') + 16), ...u32(at('format')));
            // CreateSoundBuffer(&desc, &buffer, NULL)
            bytes.push(...pushArgs([at('desc'), at('buffer'), 0]));
            comPushed('device', 3);
            // The whole buffer filled first.
            bytes.push(0xc7, 0x05, ...u32(at('cursor')), ...u32(at('tone')));
            bytes.push(0xc7, 0x05, ...u32(at('at')), ...u32(0));
            bytes.push(0xc7, 0x05, ...u32(at('amount')), ...u32(DS_BYTES));
            write();
            // What is left to write: the rest of the tone, and a buffer of silence behind it.
            bytes.push(0xc7, 0x05, ...u32(at('left')), ...u32(TONE_FRAMES * 2));
            // Play(0, 0, DSBPLAY_LOOPING)
            bytes.push(...push(1), ...push(0), ...push(0));
            comPushed('buffer', 12);
            const loop = bytes.length;
            bytes.push(...call(iat, 'Sleep', [5]));
            bytes.push(...push(at('writer')), ...push(at('play')));
            comPushed('buffer', 4);
            // amount = (play - at) mod size
            bytes.push(0xa1, ...u32(at('play')), 0x2b, 0x05, ...u32(at('at')), 0x79, 5,
                0x05, ...u32(DS_BYTES));
            // under the least: look again later
            bytes.push(0x3d, ...u32(DS_LEAST), 0x0f, 0x82);
            bytes.push(...u32(loop - (bytes.length + 4)));
            bytes.push(0xa3, ...u32(at('amount')));
            write();
            // at = (at + amount) mod size
            bytes.push(0xa1, ...u32(at('at')), 0x03, 0x05, ...u32(at('amount')),
                0x3d, ...u32(DS_BYTES), 0x72, 5, 0x2d, ...u32(DS_BYTES), 0xa3, ...u32(at('at')));
            // left -= amount, round again while there is more
            bytes.push(0xa1, ...u32(at('left')), 0x2b, 0x05, ...u32(at('amount')),
                0xa3, ...u32(at('left')), 0x0f, 0x8f);
            bytes.push(...u32(loop - (bytes.length + 4)));
            // What is still in the buffer heard before it goes.
            bytes.push(...call(iat, 'Sleep', [300]), ...call(iat, 'ExitProcess', [0]));
            return bytes;
        },
    });
}
