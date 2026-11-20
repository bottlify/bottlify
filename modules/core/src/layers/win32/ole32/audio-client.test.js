/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAudioClients, readStreamFormat, validateFormat } from './audio-client.js';
import { LONG_RSP, callLong } from '../../bridge/internal/long-machine.fixture.js';

const S_OK = 0;
const S_FALSE = 1;
const E_POINTER = 0x80004003 | 0;
const E_INVALIDARG = 0x80070057 | 0;
const AUDCLNT_E_NOT_INITIALIZED = 0x88890001 | 0;
const AUDCLNT_E_ALREADY_INITIALIZED = 0x88890002 | 0;
const AUDCLNT_E_NOT_STOPPED = 0x88890005 | 0;
const AUDCLNT_E_BUFFER_TOO_LARGE = 0x88890006 | 0;
const AUDCLNT_E_OUT_OF_ORDER = 0x88890007 | 0;
const AUDCLNT_E_UNSUPPORTED_FORMAT = 0x88890008 | 0;
const AUDCLNT_E_INVALID_SIZE = 0x88890009 | 0;
const AUDCLNT_E_EXCLUSIVE_MODE_NOT_ALLOWED = 0x8889000e | 0;
const AUDCLNT_E_EVENTHANDLE_NOT_SET = 0x88890014 | 0;
const EVENTCALLBACK = 0x40000;
const RATE = 48000;
const BLOCK = 8;

const OUT = 0x100;
const FORMAT = 0x200;
const IID = 0x300;
const GUID = 0x340;
const FLOATS = 0x380;

const IIDS = {
    IAudioRenderClient: 'F294ACFC-3146-4483-A7BF-ADDCA7C260E2',
    IAudioClock: 'CD63314F-3FBA-4A1B-812C-EF96358728E7',
    ISimpleAudioVolume: '87CE5498-68D6-44E5-9215-6DA47EF883D8',
    IAudioStreamVolume: '93014887-242D-4068-8A15-CF5E93B90FE3',
    IAudioSessionControl: 'F4B1A599-7266-4319-A8CA-E70ACB11E8CD',
};

/**
 * A WAVEFORMATEXTENSIBLE as bytes.
 *
 * @param {{ tag?: number, sub?: number, channels?: number, rate?: number, bits?: number,
 *     valid?: number, extensible?: boolean, block?: number }} [o]
 */
function format(o = {}){
    const channels = o.channels ?? 2;
    const bits = o.bits ?? 32;
    const rate = o.rate ?? RATE;
    const block = o.block ?? channels * bits / 8;
    const extensible = o.extensible ?? true;
    const bytes = new Uint8Array(40);
    const view = new DataView(bytes.buffer);
    view.setUint16(0, extensible ? 0xfffe : o.tag ?? 3, true);
    view.setUint16(2, channels, true);
    view.setUint32(4, rate, true);
    view.setUint32(8, block * rate, true);
    view.setUint16(12, block, true);
    view.setUint16(14, bits, true);
    view.setUint16(16, extensible ? 22 : 0, true);
    view.setUint16(18, o.valid ?? bits, true);
    view.setUint32(20, 3, true);
    view.setUint32(24, o.sub ?? 3, true);
    bytes.set([0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71], 28);
    return bytes;
}

/** A fake mixer track: what it was given, a play cursor the test moves. */
function fakeTrack(){
    return {
        /** @type {Uint8Array[]} */
        written: [],
        heard: 0,
        paused: false,
        gain: 1,
        balance: [1, 1],
        closed: 0,
        capacityFrames: RATE / 5,
        /** @param {Uint8Array} data */
        write(data){
            this.written.push(data);
            return data.length / BLOCK;
        },
        pending(){
            return this.written.reduce((sum, data)=>sum + data.length, 0) / BLOCK - this.heard / BLOCK;
        },
        playedBytes(){
            return this.heard;
        },
        reset(){
            this.written = [];
            this.heard = 0;
        },
        close(){
            this.closed++;
        },
    };
}

/** @param {{ output?: boolean }} [options] */
function setup(options = {}){
    const bytes = new Uint8Array(0x100000);
    const view = new DataView(bytes.buffer);
    let time = 1000;
    let nextPointer = 0x80000;
    let nextBlock = 0x10000;
    /** @type {Map<number, any>} */
    const records = new Map();
    /** @type {any[]} */
    const timers = [];
    /** What each timer asks before it sets its event. @type {(undefined | (()=>boolean))[]} */
    const whens = [];
    /** @type {any[]} */
    const tracks = [];
    /** @param {any} object @param {string} id */
    const publish = (object, id)=>{
        const record = object.interfaceFor(id);
        if (!record)
        {
            return 0;
        }
        const known = [...records].find(([, one])=>one === record);
        if (known)
        {
            return known[0];
        }
        nextPointer += 0x10;
        records.set(nextPointer, record);
        return nextPointer;
    };
    const clients = createAudioClients({
        readMemory: (address, length)=>bytes.subarray(address, address + length),
        writeMemory: (address, data)=>bytes.set(data, address),
        readWideString: address=>{
            let text = '';
            for (let at = address; view.getUint16(at, true) !== 0; at += 2)
            {
                text += String.fromCharCode(view.getUint16(at, true));
            }
            return text;
        },
        heap: { allocate: size=>(nextBlock += size + 16) - size - 16 },
        vtables: { publish },
        writePointer: (at, value)=>view.setUint32(at, value >>> 0, true),
        now: ()=>time,
        output: options.output ? ()=>({
            open: (/** @type {any} */ wanted)=>{
                const track = Object.assign(fakeTrack(), { format: wanted });
                tracks.push(track);
                return track;
            },
        }) : undefined,
        timers: {
            set: (delay, target, user, flags, when)=>{
                timers.push({ delay, target, flags, live: true });
                whens.push(when);
                return timers.length;
            },
            kill: id=>{
                timers[id - 1].live = false;
                return 0;
            },
        },
        program: ()=>'\\Device\\HarddiskVolume1\\game.exe',
        processId: ()=>0x1000,
    }, { id: '{0.0.0.00000000}.{speakers}', rate: RATE, channels: 2, mixFormat: ()=>format() });

    /** @param {string} text */
    const guid = text=>{
        const [a, b, c, d, e] = text.split('-');
        const out = new Uint8Array(16);
        const v = new DataView(out.buffer);
        v.setUint32(0, parseInt(a, 16), true);
        v.setUint16(4, parseInt(b, 16), true);
        v.setUint16(6, parseInt(c, 16), true);
        (d + e).match(/../g)?.forEach((pair, index)=>{
            out[8 + index] = parseInt(pair, 16);
        });
        return out;
    };
    const s = {
        view, timers, whens, tracks,
        /** The same object's other interface. @param {number} pointer @param {string} id */
        as: (pointer, id)=>publish(records.get(pointer).object, `{${id}}`),
        /** @param {number} ms */
        advance: ms=>{
            time += ms;
        },
        /** A new client's pointer. */
        activate(){
            assert.equal(clients.activate(OUT), S_OK);
            return view.getUint32(OUT, true);
        },
        /**
         * A method called as a 64-bit program calls it, through the bridge's
         * x64 path: `this` in RCX, then RDX, R8, R9 and the stack.
         *
         * @param {number} pointer @param {string} name
         * @param {Parameters<typeof callLong>[2]} machine
         */
        callLong(pointer, name, machine){
            const record = records.get(pointer);
            const method = record.methods.find((/** @type {any} */ m)=>m.name === name);
            return callLong(method, record.object, machine);
        },
        /** @param {number} pointer @param {string} name @param {number[]} [args] */
        call(pointer, name, args = []){
            const record = records.get(pointer);
            assert.ok(record, `no interface at 0x${pointer.toString(16)}`);
            const method = record.methods.find((/** @type {any} */ m)=>m.name === name);
            if (method.builtin === 'release')
            {
                return record.object.release();
            }
            if (method.builtin === 'addRef')
            {
                return record.object.addRef();
            }
            return method.invoke(record.object, args);
        },
        /** A service of a client, its pointer. @param {number} client @param {keyof IIDS} name */
        service(client, name){
            bytes.set(guid(IIDS[name]), IID);
            assert.equal(s.call(client, 'GetService', [IID, OUT]), S_OK, name);
            return view.getUint32(OUT, true);
        },
        /**
         * A client initialized in shared mode with `f`, 500 ms long.
         *
         * @param {Uint8Array} [f] @param {number} [flags] @param {number} [session]
         */
        initialized(f = format(), flags = 0, session = 0){
            const client = s.activate();
            bytes.set(f, FORMAT);
            const args = [0, flags, 5000000, 0, 0, 0, FORMAT, session];
            assert.equal(s.call(client, 'Initialize', args), S_OK);
            return client;
        },
        /** Writes `frames` through the render client. @param {number} render @param {number} frames */
        write(render, frames){
            assert.equal(s.call(render, 'GetBuffer', [frames, OUT]), S_OK);
            const at = view.getUint32(OUT, true);
            bytes.fill(0x11, at, at + frames * BLOCK);
            assert.equal(s.call(render, 'ReleaseBuffer', [frames, 0]), S_OK);
        },
        /** @param {number} client */
        padding(client){
            assert.equal(s.call(client, 'GetCurrentPadding', [OUT]), S_OK);
            return view.getUint32(OUT, true);
        },
        /** @param {number} clock */
        position(clock){
            assert.equal(s.call(clock, 'GetPosition', [OUT, 0]), S_OK);
            return Number(view.getBigUint64(OUT, true));
        },
        guid,
        bytes,
    };
    return s;
}

test('a format is held to the rules Windows applies in shared mode', ()=>{
    /** @param {Uint8Array} bytes @param {boolean} [compatible] */
    const judge = (bytes, compatible = true)=>validateFormat(
        readStreamFormat((at, length)=>bytes.subarray(at, at + length), 0), compatible);
    assert.equal(judge(format()), S_OK, 'the mix format');
    assert.equal(judge(format({ sub: 1, bits: 16 })), S_OK, '16-bit PCM');
    assert.equal(judge(format({ sub: 1, bits: 32, valid: 24 })), S_OK, '24 valid in 32');
    assert.equal(judge(format({ sub: 1, bits: 32, valid: 16 })), AUDCLNT_E_UNSUPPORTED_FORMAT);
    assert.equal(judge(format({ bits: 64 })), AUDCLNT_E_UNSUPPORTED_FORMAT, '64-bit float');
    assert.equal(judge(format({ sub: 6, bits: 8 })), AUDCLNT_E_UNSUPPORTED_FORMAT, 'A-law');
    assert.equal(judge(format({ sub: 1, bits: 12 })), E_INVALIDARG);
    assert.equal(judge(format({ block: 4 })), E_INVALIDARG, 'a block that is not the samples');
    assert.equal(judge(format({ extensible: false, tag: 1, bits: 16, channels: 4 })), E_INVALIDARG,
        'a plain format carries at most two channels');
    assert.equal(judge(format({ extensible: false, tag: 1, bits: 16 })), S_OK);
    assert.equal(judge(format(), false), AUDCLNT_E_UNSUPPORTED_FORMAT, 'another rate or count');
});

test('a client is uninitialized until it is, and once only; exclusive mode is not allowed', ()=>{
    const s = setup();
    const client = s.activate();
    assert.equal(s.call(client, 'GetBufferSize', [OUT]), AUDCLNT_E_NOT_INITIALIZED);
    assert.equal(s.call(client, 'Start'), AUDCLNT_E_NOT_INITIALIZED);
    s.bytes.set(format(), FORMAT);
    assert.equal(s.call(client, 'Initialize', [1, 0, 5000000, 0, 0, 0, FORMAT, 0]),
        AUDCLNT_E_EXCLUSIVE_MODE_NOT_ALLOWED);
    assert.equal(s.call(client, 'Initialize', [0, 0, 5000000, 0, 0, 0, 0, 0]), E_POINTER);
    assert.equal(s.call(client, 'Initialize', [0, 0, 5000000, 0, 0, 0, FORMAT, 0]), S_OK);
    assert.equal(s.call(client, 'Initialize', [0, 0, 5000000, 0, 0, 0, FORMAT, 0]),
        AUDCLNT_E_ALREADY_INITIALIZED);
    assert.equal(s.call(client, 'GetBufferSize', [OUT]), S_OK);
    assert.equal(s.view.getUint32(OUT, true), RATE / 2, 'half a second at the mix rate');

    s.bytes.set(format({ rate: 44100 }), FORMAT);
    assert.equal(s.call(client, 'IsFormatSupported', [0, FORMAT, OUT]), S_FALSE);
    assert.notEqual(s.view.getUint32(OUT, true), 0, 'the mix format, suggested');
    s.bytes.set(format({ sub: 1, bits: 16 }), FORMAT);
    assert.equal(s.call(client, 'IsFormatSupported', [0, FORMAT, OUT]), S_OK);
    assert.equal(s.view.getUint32(OUT, true), 0);
});

test('a 64-bit program initializes a client: each REFERENCE_TIME one slot, then the format', ()=>{
    // SDL2's WASAPI in a 64-bit game: Initialize(mode, flags, duration, period,
    // format, session) is this in RCX, mode, flags and the duration in RDX, R8
    // and R9, the period, the format and the session on the stack.
    const s = setup();
    const client = s.activate();
    s.bytes.set(format(), FORMAT);
    const answer = s.callLong(client, 'Initialize', {
        registers: { rcx: BigInt(client), r11: 0n, r8: 0n, r9: 5000000n },
        words: new Map([[LONG_RSP + 0x28, 0], [LONG_RSP + 0x2c, 0],
            [LONG_RSP + 0x30, FORMAT], [LONG_RSP + 0x38, 0]]),
    });
    assert.equal(answer, S_OK, 'the format read from its own slot, not E_POINTER');
    assert.equal(s.call(client, 'GetBufferSize', [OUT]), S_OK);
    assert.equal(s.view.getUint32(OUT, true), RATE / 2, 'half a second: the duration whole');
});

test('with nothing listening a stream plays against the clock, padding falling as it plays', ()=>{
    const s = setup();
    const client = s.initialized();
    const render = s.service(client, 'IAudioRenderClient');
    const clock = s.service(client, 'IAudioClock');
    s.write(render, RATE / 2);
    assert.equal(s.padding(client), RATE / 2, 'all of it, before Start');
    assert.equal(s.call(render, 'GetBuffer', [1, OUT]), AUDCLNT_E_BUFFER_TOO_LARGE);
    s.advance(100);
    assert.equal(s.position(clock), 0, 'nothing plays before Start');

    assert.equal(s.call(client, 'Start'), S_OK);
    assert.equal(s.call(client, 'Start'), AUDCLNT_E_NOT_STOPPED);
    s.advance(100);
    assert.equal(s.position(clock), RATE / 10 * BLOCK, 'a tenth of a second, in bytes');
    assert.equal(s.padding(client), RATE / 2 - RATE / 10);
    assert.equal(s.call(client, 'Stop'), S_OK);
    s.advance(100);
    assert.equal(s.position(clock), RATE / 10 * BLOCK, 'stopped, it stands');
    assert.equal(s.call(client, 'Stop'), S_FALSE);

    assert.equal(s.call(client, 'Start'), S_OK);
    s.advance(1000);
    assert.equal(s.padding(client), 0, 'never past what was written');
    assert.equal(s.position(clock), RATE / 2 * BLOCK);
    assert.equal(s.call(client, 'Reset'), AUDCLNT_E_NOT_STOPPED);
    s.call(client, 'Stop');
    assert.equal(s.call(client, 'Reset'), S_OK);
    assert.equal(s.position(clock), 0);
});

test('a held buffer is released whole or in part, and nothing else is in order meanwhile', ()=>{
    const s = setup();
    const client = s.initialized();
    const render = s.service(client, 'IAudioRenderClient');
    assert.equal(s.call(render, 'GetBuffer', [480, OUT]), S_OK);
    assert.equal(s.call(render, 'GetBuffer', [0, OUT]), AUDCLNT_E_OUT_OF_ORDER);
    assert.equal(s.view.getUint32(OUT, true), 0);
    assert.equal(s.call(client, 'Reset'), 0x8889000b | 0, 'a buffer is pending');
    assert.equal(s.call(render, 'ReleaseBuffer', [481, 0]), AUDCLNT_E_INVALID_SIZE);
    assert.equal(s.call(render, 'ReleaseBuffer', [240, 2]), S_OK, 'part of it, silent');
    assert.equal(s.padding(client), 240);
    assert.equal(s.call(render, 'ReleaseBuffer', [240, 0]), AUDCLNT_E_OUT_OF_ORDER);
    assert.equal(s.call(render, 'ReleaseBuffer', [0, 0]), S_OK);
});

test('what a stream releases reaches its track, which says how far it has played', ()=>{
    const s = setup({ output: true });
    const client = s.initialized(format({ sub: 1, bits: 32, valid: 24 }));
    const [track] = s.tracks;
    assert.deepEqual(track.format, { sampleRate: RATE, channels: 2, bitsPerSample: 32 });
    assert.equal(track.paused, true, 'silent until Start');
    const render = s.service(client, 'IAudioRenderClient');
    s.write(render, RATE / 2);
    assert.equal(track.pending(), RATE / 5, 'a fifth of a second handed over; the rest waits');
    s.call(client, 'Start');
    assert.equal(track.paused, false);
    track.heard = RATE / 10 * BLOCK;
    assert.equal(s.padding(client), RATE / 2 - RATE / 10, 'the track played that much');
    assert.equal(track.pending(), RATE / 5, 'and was given more');

    const volume = s.service(client, 'IAudioStreamVolume');
    s.view.setFloat32(FLOATS, 0.5, true);
    s.view.setFloat32(FLOATS + 4, 0.25, true);
    assert.equal(s.call(volume, 'SetAllVolumes', [2, FLOATS]), S_OK);
    assert.deepEqual(track.balance, [0.5, 0.25]);
    const simple = s.service(client, 'ISimpleAudioVolume');
    assert.equal(s.call(simple, 'SetMute', [1, 0]), S_OK);
    assert.equal(track.gain, 0);
});

test('an event-driven stream has the engine look twice a period from Start until the client'
    + ' goes', ()=>{
    const s = setup({ output: true });
    const client = s.initialized(format(), EVENTCALLBACK);
    assert.equal(s.call(client, 'Start'), AUDCLNT_E_EVENTHANDLE_NOT_SET);
    assert.equal(s.call(client, 'SetEventHandle', [0x44]), S_OK);
    assert.equal(s.call(client, 'SetEventHandle', [0x44]), 0x8007007b | 0);
    assert.equal(s.call(client, 'Start'), S_OK);
    assert.deepEqual(s.timers, [{ delay: 5, target: 0x44, flags: 0x11, live: true }]);
    s.call(client, 'Stop');
    assert.equal(s.timers[0].live, true, 'on through Stop, as the engine goes on');
    assert.equal(s.call(client, 'Release'), 0);
    assert.equal(s.timers[0].live, false);
    assert.equal(s.tracks[0].closed, 1);
});

/**
 * The device's clock against the guest's, how much it takes at once, and how
 * late the engine's tick comes. The guest's clock is credited between turns
 * and the page's audio thread keeps its own: the two drift apart, and the
 * device is the one heard. It takes in bursts of its own, and a tick waits
 * behind whatever the engine's thread was doing.
 */
const DEVICES = [
    { rate: 0.97, burstMs: 1, lateMs: 0 },
    { rate: 1, burstMs: 1, lateMs: 0 },
    { rate: 1.03, burstMs: 1, lateMs: 0 },
    { rate: 1, burstMs: 10, lateMs: 10 },
    { rate: 1.03, burstMs: 20, lateMs: 10 },
    { rate: 1.03, burstMs: 20, lateMs: 40 },
];

/**
 * How a program refills at its event: as SDL does, half its buffer while
 * there is that much room; or a period at each event, as a mixer that makes a
 * period of sound a wake does - one that only keeps up if the events come as
 * often as the device plays a period.
 */
const WRITERS = ['half its buffer while it fits', 'a period an event'];

for (const writer of WRITERS)
{
    for (const { rate: deviceRate, burstMs, lateMs } of DEVICES)
    {
        test(`an event-driven stream written ${writer} keeps a device fed whose clock runs`
            + ` ${deviceRate}x the guest's, taking ${burstMs} ms at once, one tick in ten`
            + ` ${lateMs} ms late`, ()=>fed(writer === WRITERS[0], deviceRate, burstMs, lateMs));
    }
}

/**
 * @param {boolean} halves @param {number} deviceRate @param {number} burstMs
 * @param {number} lateMs
 */
function fed(halves, deviceRate, burstMs, lateMs){
    const s = setup({ output: true });
    const client = s.activate();
    s.bytes.set(format(), FORMAT);
    const shared = [0, EVENTCALLBACK, 0, 0, 0, 0, FORMAT, 0];
    assert.equal(s.call(client, 'Initialize', shared), S_OK);
    assert.equal(s.call(client, 'GetBufferSize', [OUT]), S_OK);
    const size = s.view.getUint32(OUT, true);
    const chunk = size / 2;
    const render = s.service(client, 'IAudioRenderClient');
    assert.equal(s.call(client, 'SetEventHandle', [0x44]), S_OK);
    s.write(render, size);
    assert.equal(s.call(client, 'Start'), S_OK);
    const [track] = s.tracks;
    const pull = /** @type {()=>boolean} */ (s.whens[0]);
    const every = s.timers[0].delay;
    const period = RATE / 100;
    let owed = 0;
    let starved = 0;
    let nextTick = every;
    let late = 0;
    let ticks = 0;
    for (let ms = 1; ms <= 3000; ms++)
    {
        s.advance(1);
        if (!track.paused)
        {
            owed += RATE / 1000 * deviceRate;
        }
        if (ms % burstMs === 0)
        {
            const want = Math.floor(owed);
            owed -= want;
            const heard = Math.min(want, track.pending());
            track.heard += heard * BLOCK;
            if (ms > 200)
            {
                starved += want - heard;
            }
        }
        if (ms >= nextTick + late)
        {
            if (pull())
            {
                if (halves)
                {
                    while (size - s.padding(client) >= chunk)
                    {
                        s.write(render, chunk);
                    }
                }
                else if (size - s.padding(client) >= period)
                {
                    s.write(render, period);
                }
            }
            // A periodic tick keeps its grid, and one gone by while it
            // was late is not made up.
            while (nextTick <= ms)
            {
                nextTick += every;
            }
            // One tick in ten waits the whole of it.
            ticks++;
            late = ticks % 10 === 9 ? lateMs : 0;
        }
    }
    assert.equal(starved, 0, 'no frame the device asked for found the track empty');
}


test('a service holds its client: the stream goes with the last of them', ()=>{
    const s = setup({ output: true });
    const client = s.initialized();
    const clock = s.service(client, 'IAudioClock');
    assert.notEqual(s.call(client, 'Release'), 0, 'the clock holds it');
    assert.equal(s.tracks[0].closed, 0);
    assert.equal(s.call(clock, 'Release'), 0);
    assert.equal(s.tracks[0].closed, 1);
});

test('streams in one session share its state, its volume and its control', ()=>{
    const s = setup({ output: true });
    s.bytes.set(s.guid('11111111-2222-3333-4444-555555555555'), GUID);
    const first = s.initialized(format(), 0, GUID);
    const second = s.initialized(format(), 0, GUID);
    const control = s.service(first, 'IAudioSessionControl');
    assert.equal(s.service(first, 'IAudioSessionControl'), control, 'one control a client');
    assert.equal(s.call(control, 'GetState', [OUT]), S_OK);
    assert.equal(s.view.getUint32(OUT, true), 0, 'inactive');
    s.call(second, 'Start');
    s.call(control, 'GetState', [OUT]);
    assert.equal(s.view.getUint32(OUT, true), 1, 'active while any stream in it plays');
    const simple = s.service(second, 'ISimpleAudioVolume');
    const half = new Uint32Array(Float32Array.of(0.5).buffer)[0];
    assert.equal(s.call(simple, 'SetMasterVolume', [half, 0]), S_OK);
    assert.deepEqual(s.tracks.map(track=>track.gain), [0.5, 0.5]);
    const control2 = s.as(control, 'BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D');
    assert.equal(s.call(control2, 'GetSessionIdentifier', [OUT]), S_OK);
    let text = '';
    for (let at = s.view.getUint32(OUT, true); s.view.getUint16(at, true) !== 0; at += 2)
    {
        text += String.fromCharCode(s.view.getUint16(at, true));
    }
    assert.equal(text, '{0.0.0.00000000}.{speakers}|\\Device\\HarddiskVolume1\\game.exe'
        + '%b{11111111-2222-3333-4444-555555555555}');
});
