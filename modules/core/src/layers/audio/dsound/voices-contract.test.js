/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The contract between a DirectSound buffer and the voice the device plays it
 * through, as a gate.
 *
 * With shared memory a sound buffer is a voice: a slot in the table and a
 * mirror of the buffer that the audio thread reads on its own clock. From then
 * on what a program polls -- whether the buffer plays, where its cursor is --
 * is the device's answer, read back out of the slot. Each side is tested
 * beside itself; what neither tests is the two of them together, on the
 * sequences a program actually makes, with the device's blocks falling
 * between and inside its calls.
 *
 * So the real module is driven here -- the seam, the buffers, the pump that
 * attaches and closes voices, the shared mixer -- and the device is the real
 * mixing code over the same table, called the way `worklet.js` calls it, a
 * block at a time on a clock locked to the guest's. A program made of the
 * per-sound idiom (release the last buffer, create one, fill it, place it,
 * play it once or round, stop a round one a little later), with a thread
 * streaming into a buffer of its own beside it, is run on random seeds, and
 * these hold after every step:
 *
 * - a Play that does not loop ends: the status loses PLAYING within the
 *   sound's length and a few blocks;
 * - one that loops plays until it is stopped, and is stopped when it is;
 * - the cursor a program reads moves only forward while the buffer plays;
 * - no slot is held by two live buffers' voices, and a live buffer's voice is
 *   on an open slot;
 * - a voice that was closed writes nothing to the table again.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAudioModule } from '../module.js';
import { createMixer } from '../output/mixer.js';
import { DSBPLAY_LOOPING, DSBSTATUS_PLAYING, DSBSTATUS_LOOPING } from './buffers.js';
import { WAVEFORMATEX, DSBUFFERDESC, DS_OK, IID_IDirectSoundBuffer8 } from './seam.js';
import {
    slotHeaderOffset, slotPcmOffset, SLOT_HEADER_INT32, SLOT_BYTES, SLOTS, GLOBAL_HEADER_INT32,
    ARENA_OFFSET, ARENA_BYTES, OUTPUT_RATE, STATE, STATE_OPEN, createSeam, mixBlock,
} from '../output/mix.js';

const DEVICE_RATE = 48000;
/** The quantum WebAudio asks a worklet for. */
const BLOCK_FRAMES = 128;
const BLOCK_MS = BLOCK_FRAMES * 1000 / DEVICE_RATE;

/** The sound in the report: 44.1 kHz, 16-bit mono, 40 ms. */
const SOUND = { rate: 44100, channels: 1, bits: 16, bytes: 3528 };
/** The buffer a second thread streams into while the sounds play. */
const STREAM = { rate: 22050, channels: 2, bits: 16, bytes: 22050 * 4 / 5 };
const DSBCAPS_CTRLDEFAULT = 0x000000e0;
const DSBLOCK_FROMWRITECURSOR = 0x0001;

const FORMAT_AT = 0x100;
const DESC_AT = 0x200;
const OUT_AT = 0x300;
const STATUS_AT = 0x310;
const PLAY_AT = 0x314;
const WRITE_AT = 0x318;
const LOCK_AT = 0x320;

/**
 * How far past its length a one-shot may still read as playing: the block
 * the device is part way through when the length runs out, the one it is owed
 * and a turn's rounding.
 */
const END_SLACK_MS = 6 * BLOCK_MS;

/** @param {number} seed @returns {() => number} uniform in [0, 1) */
function random(seed){
    let state = (seed * 0x9e3779b9) >>> 0 || 1;
    return ()=>{
        state ^= state << 13;
        state >>>= 0;
        state ^= state >>> 17;
        state ^= state << 5;
        state >>>= 0;
        return state / 2 ** 32;
    };
}

/** @param {{ rate: number, channels: number, bits: number }} format */
const bytesPerMs = format=>format.rate * format.channels * (format.bits / 8) / 1000;

/**
 * The module over flat memory, published through a bridge that counts as the
 * real one does -- QueryInterface adds a reference to the interface asked for,
 * a Release to zero forgets every pointer of an object that says it is
 * destroyed -- and hands a forgotten pointer to the next interface published,
 * as the real heap does, so a new buffer is often at the old one's address.
 *
 * The device is `mixBlock` over the module's own table, as `worklet.js` runs
 * it. Every voice the pump opens is watched: a write to one after its close
 * is recorded.
 */
async function machine(){
    const bytes = new Uint8Array(0x800000);
    const view = new DataView(bytes.buffer);
    let ms = 1000;
    let nextAddress = 0x10000;
    const memory = {
        /** @param {number} address @param {number} length */
        readBytes: (address, length)=>bytes.subarray(address, address + length),
        /** @param {number} address @param {number} length */
        window: (address, length)=>bytes.subarray(address, address + length),
        /** @param {number} address @param {Uint8Array} data */
        writeBytes: (address, data)=>bytes.set(data, address),
    };

    /** @type {Map<number, { object: any, id: string, methods: any[] }>} */
    const owners = new Map();
    /** @type {WeakMap<any, Map<string, number>>} */
    const published = new WeakMap();
    /** @type {number[]} */
    const forgotten = [];
    let nextPointer = 0x8000;
    /** @param {any} object @param {string} asked */
    const publish = (object, asked)=>{
        const record = object.interfaceFor(asked);
        if (!record)
        {
            return 0;
        }
        const id = record.sharedWith ?? asked;
        const byId = published.get(object) ?? new Map();
        published.set(object, byId);
        const already = byId.get(id);
        if (already !== undefined)
        {
            return already;
        }
        const pointer = forgotten.pop() ?? (nextPointer += 16);
        byId.set(id, pointer);
        owners.set(pointer, { object, id, methods: record.methods });
        return pointer;
    };

    const api = await createAudioModule().create({
        now: ()=>ms,
        sampleRate: DEVICE_RATE,
        drained: true,
        shared: true,
        allocate: (/** @type {number} */ size)=>{
            const address = nextAddress;
            nextAddress += (size + 0xfff) & ~0xfff;
            return address;
        },
        publishInterface: publish,
    }, {
        requireApi: (/** @type {string} */ name)=>{
            if (name === 'bridge')
            {
                return { callGuest: async()=>0 };
            }
            return name === 'win32' ? {} : memory;
        },
        provide: ()=>{},
    });

    const mixer = api.output();
    /** @type {string[]} */
    const afterClose = [];
    const openVoice = mixer.openVoice.bind(mixer);
    mixer.openVoice = (/** @type {any} */ format)=>{
        const voice = openVoice(format);
        if (!voice)
        {
            return voice;
        }
        let closed = false;
        const writes = new Set(['play', 'stop', 'write', 'wrote', 'retune']);
        return new Proxy(voice, {
            get(target, key){
                const value = Reflect.get(target, key, target);
                if (typeof value !== 'function')
                {
                    return value;
                }
                return (/** @type {any[]} */ ...args)=>{
                    if (closed && writes.has(String(key)))
                    {
                        afterClose.push(`slot ${voice.slot}: ${String(key)} after close`);
                    }
                    closed ||= key === 'close';
                    return value.apply(target, args);
                };
            },
            set(target, key, value){
                if (closed)
                {
                    afterClose.push(`slot ${voice.slot}: ${String(key)} set after close`);
                }
                return Reflect.set(target, key, value, target);
            },
        });
    };

    const table = mixer.table;
    const global = new Int32Array(table, 0, GLOBAL_HEADER_INT32);
    const slots = Array.from({ length: SLOTS }, (_, slot)=>({
        header: new Int32Array(table, slotHeaderOffset(slot), SLOT_HEADER_INT32),
        pcm: new Uint8Array(table, slotPcmOffset(slot), SLOT_BYTES),
    }));
    const seams = slots.map(()=>createSeam());
    const arena = new Uint8Array(table, ARENA_OFFSET, ARENA_BYTES);
    const block = new Float32Array(BLOCK_FRAMES * 2);
    /** One device block, as the worklet's `process` makes it. */
    const deviceBlock = ()=>mixBlock({
        global, slots, seams, block, blockFrames: BLOCK_FRAMES,
        outputRate: Atomics.load(global, OUTPUT_RATE), arena,
    });

    /**
     * One device block with `action` made part way through it: after the
     * `at`th atomic access the block makes to the table, which is where the
     * audio thread may be when the engine thread runs.
     *
     * @param {number} at @param {() => void} action
     */
    const deviceBlockAround = (at, action)=>{
        const atomics = /** @type {any} */ (Atomics);
        const names = ['load', 'store', 'add', 'sub', 'exchange', 'compareExchange'];
        const own = Object.fromEntries(names.map(name=>[name, atomics[name]]));
        let count = 0;
        let done = false;
        for (const name of names)
        {
            atomics[name] = (/** @type {any[]} */ ...args)=>{
                if (!done && count++ === at)
                {
                    done = true;
                    for (const restore of names)
                    {
                        atomics[restore] = own[restore];
                    }
                    action();
                }
                return own[name](...args);
            };
        }
        try
        {
            deviceBlock();
        }
        finally
        {
            for (const restore of names)
            {
                atomics[restore] = own[restore];
            }
        }
        if (!done)
        {
            action();
        }
    };

    /**
     * A block's worth of guest time, with that block made around `action`.
     *
     * @param {number} at @param {() => void} action
     */
    const blockAround = (at, action)=>{
        ms += BLOCK_MS;
        deviceBlockAround(at, action);
    };

    let owed = 0;
    /** Guest time passes, and the device plays what that time is worth. @param {number} by */
    const pass = by=>{
        ms += by;
        owed += by * DEVICE_RATE / 1000;
        while (owed >= BLOCK_FRAMES)
        {
            owed -= BLOCK_FRAMES;
            deviceBlock();
        }
    };

    /**
     * A method through an interface pointer, as the bridge dispatches it.
     *
     * @param {number} pointer @param {string} name @param {any[]} [args]
     */
    const call = (pointer, name, args = [])=>{
        const owner = owners.get(pointer);
        assert.ok(owner, `${name} through ${pointer.toString(16)}, which holds nothing`);
        const { object, id } = owner;
        if (name === 'QueryInterface')
        {
            const wanted = publish(object, args[0]);
            object.addRef(object.interfaceFor(args[0])?.sharedWith ?? args[0]);
            view.setUint32(args[1], wanted, true);
            return wanted === 0 ? 0x80004002 : DS_OK;
        }
        if (name === 'Release')
        {
            const left = object.release(id);
            if (left === 0)
            {
                const ended = object.destroyed === true
                    ? [...published.get(object)?.keys() ?? []] : [id];
                for (const each of ended)
                {
                    if (!object.reachable?.(each))
                    {
                        const at = /** @type {number} */ (published.get(object)?.get(each));
                        published.get(object)?.delete(each);
                        owners.delete(at);
                        forgotten.push(at);
                        object.forgotten?.(at, each);
                    }
                }
            }
            return left;
        }
        const method = owner.methods.find((/** @type {any} */ m)=>m.name === name);
        assert.ok(method?.invoke, `${name} is not implemented`);
        return method.invoke(object, args) | 0;
    };

    assert.equal(api.libraries()['DSOUND.dll'].DirectSoundCreate.handler([0, OUT_AT, 0]), DS_OK);
    const root = view.getUint32(OUT_AT, true);

    /**
     * CreateSoundBuffer, filled whole through a lock as a program fills a
     * sound it loaded, and the pointer it answered.
     *
     * @param {{ rate: number, channels: number, bits: number, bytes: number }} format
     */
    const create = format=>{
        const align = format.channels * format.bits / 8;
        view.setUint16(FORMAT_AT + WAVEFORMATEX.wFormatTag, 1, true);
        view.setUint16(FORMAT_AT + WAVEFORMATEX.nChannels, format.channels, true);
        view.setUint32(FORMAT_AT + WAVEFORMATEX.nSamplesPerSec, format.rate, true);
        view.setUint16(FORMAT_AT + WAVEFORMATEX.wBitsPerSample, format.bits, true);
        view.setUint16(FORMAT_AT + WAVEFORMATEX.nBlockAlign, align, true);
        view.setUint32(FORMAT_AT + WAVEFORMATEX.nAvgBytesPerSec, format.rate * align, true);
        view.setUint32(DESC_AT + DSBUFFERDESC.dwSize, DSBUFFERDESC.SIZE, true);
        view.setUint32(DESC_AT + DSBUFFERDESC.dwFlags, DSBCAPS_CTRLDEFAULT, true);
        view.setUint32(DESC_AT + DSBUFFERDESC.dwBufferBytes, format.bytes, true);
        view.setUint32(DESC_AT + DSBUFFERDESC.lpwfxFormat, FORMAT_AT, true);
        assert.equal(call(root, 'CreateSoundBuffer', [DESC_AT, OUT_AT, 0]), DS_OK);
        return view.getUint32(OUT_AT, true);
    };

    /**
     * Lock, write something to hear, Unlock.
     *
     * @param {number} pointer @param {number} offset @param {number} length @param {number} flags
     */
    const fill = (pointer, offset, length, flags)=>{
        assert.equal(call(pointer, 'Lock',
            [offset, length, LOCK_AT, LOCK_AT + 4, LOCK_AT + 8, LOCK_AT + 12, flags]), DS_OK);
        const first = view.getUint32(LOCK_AT, true);
        const second = view.getUint32(LOCK_AT + 8, true);
        bytes.fill(0x30, first, first + view.getUint32(LOCK_AT + 4, true));
        bytes.fill(0x30, second, second + view.getUint32(LOCK_AT + 12, true));
        assert.equal(call(pointer, 'Unlock',
            [first, view.getUint32(LOCK_AT + 4, true), second, view.getUint32(LOCK_AT + 12, true)]),
        DS_OK);
    };

    /** @param {number} pointer */
    const status = pointer=>{
        assert.equal(call(pointer, 'GetStatus', [STATUS_AT]), DS_OK);
        return view.getUint32(STATUS_AT, true);
    };
    /** @param {number} pointer */
    const cursor = pointer=>{
        assert.equal(call(pointer, 'GetCurrentPosition', [PLAY_AT, WRITE_AT]), DS_OK);
        return view.getUint32(PLAY_AT, true);
    };
    /** The buffer behind a pointer. @param {number} pointer */
    const bufferAt = pointer=>owners.get(pointer)?.object.api;

    return {
        api, mixer, slots, view, root, call, create, fill, status, cursor, bufferAt,
        deviceBlock, blockAround, pass, afterClose, now: ()=>ms,
    };
}

test('a one-shot whose length is a whole number of device blocks stops at its end', async()=>{
    // The report, call for call: a fresh 40 ms buffer, filled whole, placed
    // at the start and played once, while the program polls its status
    // waiting for it to stop. The device takes it up at the next turn.
    const m = await machine();
    const sound = m.create(SOUND);
    assert.equal(m.call(sound, 'QueryInterface', [IID_IDirectSoundBuffer8, OUT_AT + 4]), DS_OK,
        'QueryInterface for IDirectSoundBuffer8');
    m.fill(sound, 0, SOUND.bytes, 0);
    assert.equal(m.call(sound, 'SetCurrentPosition', [0]), DS_OK);
    assert.equal(m.call(sound, 'Play', [0, 0, 0]), DS_OK);
    m.api.pump();
    assert.ok(m.bufferAt(sound).device, 'the device plays it');

    const lengthMs = SOUND.bytes / bytesPerMs(SOUND);
    let stoppedAt = -1;
    /** @type {number[]} */
    const cursors = [];
    for (let at = 0; at < 7000 && stoppedAt < 0; at += 10)
    {
        m.pass(10);
        m.api.pump();
        cursors.push(m.cursor(sound));
        if ((m.status(sound) & DSBSTATUS_PLAYING) === 0)
        {
            stoppedAt = at + 10;
        }
    }
    assert.ok(stoppedAt >= 0 && stoppedAt <= lengthMs + END_SLACK_MS,
        `a ${lengthMs} ms sound played once is still playing after ${stoppedAt < 0 ? 7000
            : stoppedAt} ms; cursors read ${cursors.slice(0, 12).join(', ')} ...`);
});

test('a voice that does not loop plays once, whichever block its end falls in', ()=>{
    // Every place a voice can be started from, in the formats the shared
    // mixer is most often asked for. The device's block boundaries fall at a
    // different frame of the sound for each; one of them is the last frame.
    // One table for all of them, as the device has one: each voice closed
    // and its slot freed by the device before the next is opened.
    const mixer = createMixer({ shared: true, sampleRate: DEVICE_RATE });
    const table = mixer.table;
    const global = new Int32Array(table, 0, GLOBAL_HEADER_INT32);
    const slots = [{
        header: new Int32Array(table, slotHeaderOffset(0), SLOT_HEADER_INT32),
        pcm: new Uint8Array(table, slotPcmOffset(0), SLOT_BYTES),
    }];
    const seams = [createSeam()];
    const arena = new Uint8Array(table, ARENA_OFFSET, ARENA_BYTES);
    const block = new Float32Array(BLOCK_FRAMES * 2);
    const deviceBlock = ()=>mixBlock({ global, slots, seams, block, blockFrames: BLOCK_FRAMES,
        outputRate: DEVICE_RATE, arena });
    /** @type {string[]} */
    const replayed = [];
    for (const format of [
        { rate: 44100, channels: 1, bits: 16, bytes: 3528 },
        { rate: 22050, channels: 2, bits: 16, bytes: 4410 },
        { rate: 48000, channels: 2, bits: 16, bytes: 7680 },
        { rate: 11025, channels: 1, bits: 8, bytes: 1103 },
    ])
    {
        const stride = format.channels * format.bits / 8;
        const frames = Math.floor(format.bytes / stride);
        for (let start = 0; start < frames; start++)
        {
            const voice = mixer.openVoice({ sampleRate: format.rate, channels: format.channels,
                bitsPerSample: format.bits, bytes: format.bytes });
            assert.equal(voice?.slot, 0);
            const laps = voice.laps;
            const ends = voice.ends;
            voice.position = start * stride;
            voice.play(false);
            const blocks = Math.ceil((frames - start) / format.rate * DEVICE_RATE / BLOCK_FRAMES) + 2;
            for (let at = 0; at < blocks; at++)
            {
                deviceBlock();
            }
            if (voice.playing || voice.laps !== laps || voice.ends !== ends + 1)
            {
                replayed.push(`${format.rate} Hz ${format.bytes} B from frame ${start}: `
                    + `playing=${voice.playing} laps=${voice.laps - laps} `
                    + `ends=${voice.ends - ends}`);
            }
            voice.close();
            deviceBlock();
        }
    }
    assert.equal(replayed.length, 0,
        `${replayed.length} starts went round, among them\n${replayed.slice(0, 6).join('\n')}`);
});

test('a one-shot the device plays stops where it is and plays on from there', async()=>{
    // What GetCurrentPosition answers after Stop is where playback stopped,
    // and Play continues from there, for a buffer that loops or not. The
    // same buffer before the device takes it up -- on the guest's clock --
    // already does this.
    /** @type {string[]} */
    const differ = [];
    const long = { rate: 44100, channels: 1, bits: 16, bytes: 17640 };
    for (const looping of [0, DSBPLAY_LOOPING])
    {
        for (const device of [false, true])
        {
            const m = await machine();
            const sound = m.create(long);
            m.fill(sound, 0, long.bytes, 0);
            m.call(sound, 'Play', [0, 0, looping]);
            if (device)
            {
                m.api.pump();
            }
            m.pass(50);
            const playing = m.cursor(sound);
            m.call(sound, 'Stop');
            const stopped = m.cursor(sound);
            m.call(sound, 'Play', [0, 0, looping]);
            const resumed = m.cursor(sound);
            const near = (/** @type {number} */ at)=>Math.abs(at - playing) <= BLOCK_MS * bytesPerMs(long) * 2;
            if (!near(stopped) || !near(resumed))
            {
                differ.push(`${looping ? 'looping' : 'one-shot'}, ${device ? 'on the device'
                    : 'on the guest clock'}: ${playing} playing, ${stopped} stopped, `
                    + `${resumed} played again`);
            }
        }
    }
    assert.equal(differ.length, 0, differ.join('\n'));
});

test('a call the program makes while the device is part way through a block is not undone '
    + 'by that block', async()=>{
    // The engine thread and the audio thread run at once, so the program's
    // call can land anywhere in the device's walk of the table. Tried at
    // every access the block makes to the one voice's slot -- the first, so
    // walked first: a reposition in the middle of a sound, and a sound
    // played again from the start in the block that ends it.
    /** @type {string[]} */
    const undone = [];
    const long = { rate: 44100, channels: 1, bits: 16, bytes: 17640 };
    for (let at = 0; at < 64; at++)
    {
        const m = await machine();
        const sound = m.create(long);
        m.fill(sound, 0, long.bytes, 0);
        m.call(sound, 'Play', [0, 0, 0]);
        m.api.pump();
        for (let block = 0; block < 20; block++)
        {
            m.pass(BLOCK_MS);
        }
        const before = m.cursor(sound);
        m.blockAround(at, ()=>{
            m.call(sound, 'SetCurrentPosition', [0]);
        });
        const after = m.cursor(sound);
        if (after >= before)
        {
            undone.push(`SetCurrentPosition(0) at access ${at}: the cursor read ${after}`);
        }
    }
    for (let at = 0; at < 64; at++)
    {
        const m = await machine();
        // A frame longer than fifteen blocks, so that the sixteenth ends it.
        const short = { ...SOUND, bytes: SOUND.bytes + 2 };
        const sound = m.create(short);
        m.fill(sound, 0, short.bytes, 0);
        m.call(sound, 'Play', [0, 0, 0]);
        m.api.pump();
        for (let block = 0; block < 15; block++)
        {
            m.pass(BLOCK_MS);
        }
        m.blockAround(at, ()=>{
            m.call(sound, 'SetCurrentPosition', [0]);
            m.call(sound, 'Play', [0, 0, 0]);
        });
        m.pass(SOUND.bytes / bytesPerMs(SOUND) / 2);
        m.api.pump();
        if ((m.status(sound) & DSBSTATUS_PLAYING) === 0)
        {
            undone.push(`Play again at access ${at}: stopped half way through`);
        }
    }
    assert.equal(undone.length, 0, undone.join('\n'));
});

/**
 * What the program expects of one buffer it holds, from the calls it made.
 *
 * @typedef {{ pointer: number, format: typeof SOUND, playing: boolean,
 *     looping: boolean, deadline: number, cursor: number, cursorAt: number,
 *     stopAt: number }} Held
 */

/**
 * One random program, `steps` long, against one machine. Answers what broke,
 * with the calls that led to it.
 *
 * @param {number} seed @param {number} steps
 * @param {{ races: boolean, oneShots: boolean }} check
 *     `races` puts program calls and turns inside device blocks; `oneShots`
 *     checks that a one-shot ends and that its cursor never goes back.
 */
async function program(seed, steps, check){
    const next = random(seed);
    const m = await machine();
    /** @type {string[]} */
    const trail = [];
    /** @param {string} line */
    const note = line=>{
        trail.push(`${(m.now() - 1000).toFixed(1)} ms: ${line}`);
        if (trail.length > 40)
        {
            trail.shift();
        }
    };
    /** @type {string[]} */
    const broken = [];

    // The streaming thread's buffer: looping from the start, topped up from
    // the write cursor every few polls.
    const stream = m.create(STREAM);
    m.fill(stream, 0, STREAM.bytes, 0);
    m.call(stream, 'Play', [0, 0, DSBPLAY_LOOPING]);
    /** @type {Held[]} */
    const held = [{ pointer: stream, format: STREAM, playing: true, looping: true,
        deadline: Infinity, cursor: -1, cursorAt: 0, stopAt: Infinity }];
    /** Four voices of the program's own, each its current sound and the pointers to it. */
    const players = Array.from({ length: 4 }, ()=>({ sound: /** @type {Held | null} */ (null) }));

    /** A turn, or a device block, or neither, between two of the program's calls. */
    const between = ()=>{
        const roll = next();
        if (roll < 0.08)
        {
            m.api.pump();
            note('turn');
        }
        else if (roll < 0.16)
        {
            m.pass(BLOCK_MS * next());
        }
    };

    /** @param {Held} sound */
    const forget = sound=>{
        const at = held.indexOf(sound);
        if (at >= 0)
        {
            held.splice(at, 1);
        }
    };

    /**
     * The per-sound idiom.
     *
     * @param {number} which @param {boolean} looping
     */
    const newSound = (which, looping)=>{
        const player = players[which];
        if (player.sound)
        {
            // IDirectSoundBuffer and the IDirectSoundBuffer8 asked for.
            m.call(player.sound.pointer, 'Release');
            between();
            m.call(player.sound.pointer, 'Release');
            note(`p${which} released ${player.sound.pointer.toString(16)}`);
            forget(player.sound);
            between();
        }
        const pointer = m.create(SOUND);
        assert.equal(m.call(pointer, 'QueryInterface', [IID_IDirectSoundBuffer8, OUT_AT + 4]),
            DS_OK);
        between();
        m.fill(pointer, 0, SOUND.bytes, 0);
        between();
        m.call(pointer, 'SetPan', [Math.round((next() - 0.5) * 4000)]);
        m.call(pointer, 'SetVolume', [-Math.round(next() * 2000)]);
        between();
        m.call(pointer, 'SetCurrentPosition', [0]);
        between();
        m.call(pointer, 'Play', [0, 0, looping ? DSBPLAY_LOOPING : 0]);
        /** @type {Held} */
        const sound = { pointer, format: SOUND, playing: true, looping,
            deadline: m.now() + SOUND.bytes / bytesPerMs(SOUND) + END_SLACK_MS,
            cursor: -1, cursorAt: 0, stopAt: m.now() + 20 + next() * 60 };
        player.sound = sound;
        held.push(sound);
        note(`p${which} ${looping ? 'loops' : 'plays once'} ${pointer.toString(16)}`);
    };

    /** @param {number} which */
    const stopRound = which=>{
        const sound = players[which].sound;
        if (!sound?.looping || !sound.playing || m.now() < sound.stopAt)
        {
            return;
        }
        m.call(sound.pointer, 'Stop');
        sound.playing = false;
        sound.cursor = -1;
        between();
        m.call(sound.pointer, 'SetCurrentPosition', [0]);
        note(`p${which} stopped ${sound.pointer.toString(16)}`);
    };

    /** @param {number} which */
    const again = which=>{
        const sound = players[which].sound;
        if (!sound || sound.looping)
        {
            return;
        }
        m.call(sound.pointer, 'SetCurrentPosition', [0]);
        between();
        m.call(sound.pointer, 'Play', [0, 0, 0]);
        sound.playing = true;
        sound.cursor = -1;
        sound.deadline = m.now() + SOUND.bytes / bytesPerMs(SOUND) + END_SLACK_MS;
        note(`p${which} played again ${sound.pointer.toString(16)}`);
    };

    /** A second copy of a player's sound, played once and let go of a while later. */
    const duplicate = (/** @type {number} */ which)=>{
        const sound = players[which].sound;
        if (!sound)
        {
            return;
        }
        const stale = held.find(each=>each.stopAt === -1 && !each.playing);
        if (stale)
        {
            m.call(stale.pointer, 'Release');
            forget(stale);
            note(`released duplicate ${stale.pointer.toString(16)}`);
        }
        assert.equal(m.call(m.root, 'DuplicateSoundBuffer', [sound.pointer, OUT_AT + 8]), DS_OK);
        const pointer = m.view.getUint32(OUT_AT + 8, true);
        m.call(pointer, 'SetCurrentPosition', [0]);
        m.call(pointer, 'Play', [0, 0, 0]);
        held.push({ pointer, format: SOUND, playing: true, looping: false,
            deadline: m.now() + SOUND.bytes / bytesPerMs(SOUND) + END_SLACK_MS,
            cursor: -1, cursorAt: 0, stopAt: -1 });
        note(`p${which} duplicated into ${pointer.toString(16)}`);
    };

    const refill = ()=>{
        m.cursor(stream);
        m.fill(stream, 0, STREAM.bytes / 8, DSBLOCK_FROMWRITECURSOR);
    };

    /** One of the program's moves, picked at random. */
    const move = ()=>{
        const which = Math.floor(next() * players.length);
        const roll = next();
        if (roll < 0.4)
        {
            newSound(which, next() < 0.3);
        }
        else if (roll < 0.6)
        {
            stopRound(which);
        }
        else if (roll < 0.7)
        {
            again(which);
        }
        else if (roll < 0.8)
        {
            duplicate(which);
        }
        else
        {
            refill();
        }
    };

    /** Everything the program can see, against what it was promised. */
    const audit = ()=>{
        for (const sound of held)
        {
            const now = m.now();
            const playing = (m.status(sound.pointer) & DSBSTATUS_PLAYING) !== 0;
            const name = `${sound.pointer.toString(16)} (${sound.looping ? 'loops' : 'once'})`;
            if (sound.looping && sound.playing && m.status(sound.pointer)
                !== (DSBSTATUS_PLAYING | DSBSTATUS_LOOPING))
            {
                broken.push(`${name} stopped by itself`);
            }
            if (!sound.playing && playing)
            {
                broken.push(`${name} plays after Stop`);
            }
            if (!sound.looping && sound.playing)
            {
                if (!playing)
                {
                    sound.playing = false;
                }
                else if (check.oneShots && now > sound.deadline)
                {
                    broken.push(`${name} still plays ${(now - sound.deadline + END_SLACK_MS)
                        .toFixed(1)} ms after its length ran out`);
                }
            }
            if (!sound.playing || !playing)
            {
                sound.cursor = -1;
                continue;
            }
            const at = m.cursor(sound.pointer);
            const length = sound.format.bytes;
            if (sound.cursor >= 0 && (sound.looping || check.oneShots))
            {
                const elapsed = (now - sound.cursorAt) * bytesPerMs(sound.format);
                const forward = sound.looping ? (at - sound.cursor + length) % length
                    : at - sound.cursor;
                if (elapsed < length / 4 && (forward < 0 || forward > length / 2))
                {
                    broken.push(`${name}'s cursor went from ${sound.cursor} to ${at} in `
                        + `${(now - sound.cursorAt).toFixed(1)} ms`);
                }
            }
            sound.cursor = at;
            sound.cursorAt = now;
        }
        /** @type {Map<number, any>} */
        const owner = new Map();
        for (const buffer of m.api.buffers())
        {
            const voice = buffer.device;
            if (buffer.primary || buffer.references === 0 || !voice)
            {
                continue;
            }
            if (owner.has(voice.slot))
            {
                broken.push(`slot ${voice.slot} is two live buffers' voice`);
            }
            owner.set(voice.slot, buffer);
            if (Atomics.load(m.slots[voice.slot].header, STATE) !== STATE_OPEN)
            {
                broken.push(`a live buffer's voice is on slot ${voice.slot}, which is not open`);
            }
        }
        broken.push(...m.afterClose.splice(0));
    };

    for (let step = 0; step < steps && broken.length === 0; step++)
    {
        const roll = next();
        if (roll < 0.35)
        {
            move();
        }
        else if (roll < 0.7)
        {
            m.pass(next() * 6);
        }
        else if (roll < 0.85 || !check.races)
        {
            m.api.pump();
            note('turn');
        }
        else
        {
            // Inside a block: the audio thread part way through its walk of
            // the table when the engine thread calls or turns.
            const at = Math.floor(next() * 400);
            const turn = next() < 0.3;
            m.blockAround(at, ()=>(turn ? m.api.pump() : move()));
            note(`(inside a device block at access ${at})`);
        }
        audit();
    }
    return broken.length === 0 ? null
        : `seed ${seed}: ${broken.join('; ')}\n  ${trail.join('\n  ')}`;
}

test('random programs of the per-sound idiom keep the voice contract: slots, Stop, '
    + 'looping, closed voices', async()=>{
    for (let seed = 1; seed <= 8; seed++)
    {
        const failure = await program(seed, 1500, { races: false, oneShots: false });
        assert.equal(failure, null);
    }
});

test('random programs of the per-sound idiom: every one-shot ends, and its cursor never '
    + 'goes back', async()=>{
    for (let seed = 1; seed <= 8; seed++)
    {
        const failure = await program(seed, 1500, { races: false, oneShots: true });
        assert.equal(failure, null);
    }
});

test('random programs with calls and turns inside device blocks keep the voice contract',
    async()=>{
        for (let seed = 101; seed <= 108; seed++)
        {
            const failure = await program(seed, 1500, { races: true, oneShots: false });
            assert.equal(failure, null);
        }
    });

test('a stream fed behind its cursor and counted by its moves plays to its end', async()=>{
    // A sound longer than its buffer, the way a program streams one: the
    // buffer filled with the first lap, played round, and each poll refills
    // what the cursor has just left with the next bytes of the sound. The
    // program counts what has played by how far the cursor moved since the
    // last poll, round the circle, and stops the buffer once that count is
    // the sound's length. A cursor that ever steps back reads as a whole lap
    // played, and the sound is stopped a lap early.
    const BUFFER = { rate: 22050, channels: 2, bits: 16, bytes: 0x40980 };
    for (let seed = 1; seed <= 12; seed++)
    {
        const next = random(seed);
        const m = await machine();
        const stream = m.create(BUFFER);
        const total = BUFFER.bytes * 3 + Math.floor(next() * BUFFER.bytes / 4) * 4;
        m.fill(stream, 0, BUFFER.bytes, 0);
        let given = BUFFER.bytes;
        assert.equal(m.call(stream, 'Play', [0, 0, DSBPLAY_LOOPING]), DS_OK);
        let last = 0;
        let counted = 0;
        /** @type {string[]} */
        const backwards = [];
        let at = 0;
        while (at < 30000 && counted < total)
        {
            const step = 8 + Math.floor(next() * 6);
            at += step;
            if (next() < 0.3)
            {
                m.blockAround(Math.floor(next() * 40), ()=>m.api.pump());
                m.pass(Math.max(0, step - BLOCK_MS));
            }
            else
            {
                m.pass(step);
                m.api.pump();
            }
            const now = m.cursor(stream);
            const moved = (now - last + BUFFER.bytes) % BUFFER.bytes;
            if (moved > BUFFER.bytes / 2)
            {
                backwards.push(`${at} ms: ${last} -> ${now}`);
            }
            counted += moved;
            if (moved > 0 && given < total)
            {
                const length = Math.min(moved, total - given);
                m.fill(stream, last, length, 0);
                given += length;
            }
            last = now;
        }
        const device = m.bufferAt(stream).device;
        const mixed = device ? device.laps * BUFFER.bytes + device.position : -1;
        assert.equal(m.call(stream, 'Stop', []), DS_OK);
        assert.deepEqual(backwards, [], `seed ${seed}: the cursor stepped back`);
        assert.ok(mixed >= total - 4 * BLOCK_FRAMES * 4,
            `seed ${seed}: stopped after ${counted} counted, ${mixed} played of ${total}`);
    }
});
