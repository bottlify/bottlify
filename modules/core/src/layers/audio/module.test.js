/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * That a sound a program plays actually leaves the machine.
 *
 * The seam and the mixer are each tested beside themselves, and both passed
 * while nothing was audible: DirectSound never opened a track, so every cursor
 * advanced, every notification fired, and no sample ever reached the ring. This
 * is the join, and it is the only place that failure was visible.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audioModule } from './module.js';
import { DSBPLAY_LOOPING } from './dsound/buffers.js';
import {
    slotHeaderOffset, slotPcmOffset, SLOT_HEADER_INT32, SLOT_BYTES, RATE as SLOT_RATE,
    createSeam, resampleInto, mixBlock, KIND, KIND_DMA, BASE, LENGTH, PLAYING, LOOPING, POSITION,
    ARENA_OFFSET, ARENA_BYTES, GLOBAL_HEADER_INT32, SLOTS, STARVED_BLOCKS, BLOCKS,
} from './output/mix.js';
import {
    WAVEFORMATEX, DSBUFFERDESC, DS_OK, IID_IDirectSoundNotify,
} from './dsound/seam.js';
import { withPointers } from '../memory/pointers.fixture.js';
import { testCache } from '../cache/testing.fixture.js';
import { createStubApi } from '../../system/stub.js';

/**
 * A view of the sound output's table at `offset`, as the device makes one:
 * the table is a view of memory the run holds, so offsets count from its start.
 *
 * @template {Int32ArrayConstructor | Uint8ArrayConstructor} K
 * @param {K} Kind @param {Uint8Array} table @param {number} offset @param {number} length
 * @returns {InstanceType<K>}
 */
const tableView = (Kind, table, offset, length)=>/** @type {InstanceType<K>} */ (
    new Kind(/** @type {ArrayBuffer} */ (table.buffer), table.byteOffset + offset, length));

/** DSBCAPS_CTRLFREQUENCY, CTRLPAN and CTRLVOLUME together. */
const DSBCAPS_CTRLDEFAULT = 0x000000e0;
const DSBCAPS_CTRLPOSITIONNOTIFY = 0x00000100;

const FORMAT_AT = 0x100;
const DESC_AT = 0x200;
const OUT_AT = 0x300;

/** 22050 Hz, stereo, 16-bit. */
const RATE = 22050;
const CHANNELS = 2;
const BITS = 16;
const BUFFER_BYTES = RATE * CHANNELS * (BITS / 8); // one second

/**
 * The module, wired the way the assembling caller wires it, over flat memory.
 *
 * The publisher is the smallest thing that answers: it keeps the method list
 * each interface was described with, so a test can call a slot by name the way
 * the guest calls it by index.
 */
function fixture(){
    // Room for forty one-second buffers side by side: a session's worth.
    const bytes = new Uint8Array(0x800000);
    const view = new DataView(bytes.buffer);
    let ms = 1000;
    let nextAddress = 0x40000;
    /** @type {Map<number, { object: any, methods: any[] }>} */
    const byPointer = new Map();
    let nextPointer = 0x10000;

    const memory = withPointers({
        /** @param {number} address @param {number} length */
        readBytes: (address, length)=>bytes.subarray(address, address + length),
        /** @param {number} address @param {number} length */
        window: (address, length)=>bytes.subarray(address, address + length),
        /** @param {number} address @param {Uint8Array} data */
        writeBytes: (address, data)=>bytes.set(data, address),
    });

    return {
        bytes,
        view,
        memory,
        advance: (/** @type {number} */ by)=>{
            ms += by;
        },
        config: {
            now: ()=>ms,
            sampleRate: 48000,
            // A build with a device on the other end of the ring, which is what
            // every test here is about. Without one there is nothing to hear
            // and nothing to read out for.
            drained: true,
            allocate: (/** @type {number} */ size)=>{
                const address = nextAddress;
                nextAddress += (size + 0xfff) & ~0xfff;
                return address;
            },
            /** @param {any} object @param {string} id */
            publishInterface(object, id){
                const record = object.interfaceFor(id);
                if (!record)
                {
                    return 0;
                }
                const pointer = nextPointer;
                nextPointer += 4;
                byPointer.set(pointer, { object, methods: record.methods });
                return pointer;
            },
        },
        /**
         * The object behind a published pointer, so a test can ask it for a
         * second interface the way the bridge does.
         *
         * @param {number} pointer
         */
        objectAt(pointer){
            return byPointer.get(pointer)?.object;
        },
        /** @param {number} pointer @param {string} name @param {number[]} args */
        call(pointer, name, args = []){
            const entry = byPointer.get(pointer);
            assert.ok(entry, `nothing published at ${pointer}`);
            const method = entry.methods.find((/** @type {any} */ m)=>m.name === name);
            assert.ok(method?.invoke, `${name} is not implemented`);
            return method.invoke(entry.object, args) | 0;
        },
    };
}

/**
 * A module with one playing sound buffer full of something to hear.
 *
 * @param {{ silent?: boolean, drained?: boolean, memory?: any, cache?: any,
 *     divergence?: (api: string, detail: string) => void }} [options]
 *     `cache`: the run's cache the module is given (none: a machine built alone)
 */
async function playing({ silent = false, drained = true, memory, cache, divergence } = {}){
    const f = fixture();
    /** @type {number[]} */
    const signalled = [];
    const api = await audioModule.create({
        ...f.config,
        drained,
        memory,
        ...(divergence ? { divergence } : {}),
        /** @param {number} handle */
        signal: handle=>signalled.push(handle),
    }, {
        requireApi: (/** @type {string} */ name)=>{
            if (name === 'bridge')
            {
                // The route into guest code. Nothing here calls one, but the
                // module asks for it the way the registry always binds it.
                return { callGuest: async()=>0 };
            }
            if (name === 'win32')
            {
                return {};
            }
            if (name === 'cache')
            {
                return cache ?? { space: ()=>({ hold: ()=>null }) };
            }
            assert.equal(name, 'memory');
            return f.memory;
        },
        provide: ()=>{},
    });

    f.view.setUint16(FORMAT_AT + WAVEFORMATEX.wFormatTag, 1, true);
    f.view.setUint16(FORMAT_AT + WAVEFORMATEX.nChannels, CHANNELS, true);
    f.view.setUint32(FORMAT_AT + WAVEFORMATEX.nSamplesPerSec, RATE, true);
    f.view.setUint16(FORMAT_AT + WAVEFORMATEX.wBitsPerSample, BITS, true);
    f.view.setUint16(FORMAT_AT + WAVEFORMATEX.nBlockAlign, CHANNELS * BITS / 8, true);
    f.view.setUint32(FORMAT_AT + WAVEFORMATEX.nAvgBytesPerSec, RATE * CHANNELS * BITS / 8, true);
    f.view.setUint32(DESC_AT + DSBUFFERDESC.dwSize, DSBUFFERDESC.SIZE, true);
    // The controls a program of this era asks for, and the positions it waits on.
    f.view.setUint32(DESC_AT + DSBUFFERDESC.dwFlags,
        DSBCAPS_CTRLDEFAULT | DSBCAPS_CTRLPOSITIONNOTIFY, true);
    f.view.setUint32(DESC_AT + DSBUFFERDESC.dwBufferBytes, BUFFER_BYTES, true);
    f.view.setUint32(DESC_AT + DSBUFFERDESC.lpwfxFormat, FORMAT_AT, true);

    const dsound = api.libraries()['DSOUND.dll'];
    assert.equal(dsound.DirectSoundCreate.handler([0, OUT_AT, 0]), DS_OK);
    const root = f.view.getUint32(OUT_AT, true);
    assert.equal(f.call(root, 'CreateSoundBuffer', [DESC_AT, OUT_AT + 4, 0]), DS_OK);
    const buffer = f.view.getUint32(OUT_AT + 4, true);

    // Something other than silence in the buffer's own bytes: a mixer that read
    // the wrong address would find zeroes and produce a block that is
    // indistinguishable from a correct one nobody can hear.
    const [held] = api.buffers();
    if (!silent)
    {
        f.bytes.fill(0x40, held.address, held.address + BUFFER_BYTES);
    }
    return { ...f, api, root, buffer, held, signalled };
}

/**
 * The lengths of the voices the device plays now, from the table it reads.
 *
 * @param {{ api: any }} f
 */
function playingVoices(f){
    const table = f.api.output().table;
    /** @type {number[]} */
    const lengths = [];
    for (let slot = 0; slot < SLOTS; slot++)
    {
        const header = tableView(Int32Array, table, slotHeaderOffset(slot), SLOT_HEADER_INT32);
        if (Atomics.load(header, KIND) === KIND_DMA && Atomics.load(header, PLAYING) !== 0)
        {
            lengths.push(Atomics.load(header, LENGTH));
        }
    }
    return lengths;
}

/**
 * The device reading the table for `ms` milliseconds, as the worklet does on
 * the audio thread: the cursors move where it reads.
 *
 * @param {{ api: any }} f @param {number} ms
 */
function deviceReads(f, ms){
    const table = f.api.output().table;
    const outputRate = f.api.output().sampleRate;
    const global = tableView(Int32Array, table, 0, GLOBAL_HEADER_INT32);
    const slots = Array.from({ length: SLOTS }, (_, slot)=>({
        header: tableView(Int32Array, table, slotHeaderOffset(slot), SLOT_HEADER_INT32),
        pcm: tableView(Uint8Array, table, slotPcmOffset(slot), SLOT_BYTES),
    }));
    const seams = slots.map(()=>createSeam());
    const arena = tableView(Uint8Array, table, ARENA_OFFSET, ARENA_BYTES);
    const block = new Float32Array(128 * 2);
    for (let at = 0; at < Math.ceil(outputRate * ms / 1000 / 128); at++)
    {
        mixBlock({ global, slots, seams, block, blockFrames: 128, outputRate, arena });
    }
}

test('the sound output is memory held in the run\'s cache: counted there, written in place, '
    + 'given back when the output closes', async()=>{
    const run = await testCache({ budget: 64 << 20, segmentBytes: 16 << 20 });
    const f = await playing({ cache: { space: (/** @type {string} */ name)=>run.space(name) } });
    const output = f.api.output();
    const { table } = output.memory;
    assert.deepEqual(Object.keys(output.memory), ['table'],
        'what crosses to a worker: the table alone');
    assert.ok(table instanceof Uint8Array, 'a view of memory, not a buffer of its own');
    assert.ok(run.keeper.segmentBuffers().includes(/** @type {any} */ (table.buffer)),
        'in one of the run cache\'s segments');
    assert.equal(run.keeper.under('sound/').hotBytes, table.byteLength, 'counted under sound/');
    f.call(f.buffer, 'Play', [0, 0, DSBPLAY_LOOPING]);
    f.api.pump();
    assert.deepEqual(playingVoices(f), [BUFFER_BYTES], 'a voice in it, read where it lies');
    // Many sweeps past every idle and abandon time: still the output's.
    for (let i = 0; i < 20; i++)
    {
        run.clock.time += 600_000;
        run.keeper.sweep();
    }
    assert.equal(run.keeper.under('sound/').hotBytes, table.byteLength, 'never taken back');
    output.release();
    assert.equal(run.keeper.under('sound/').bodies, 0, 'and given back once released');
});

test('with no cache the output is a buffer of its own, and that is said once', async()=>{
    /** @type {string[]} */
    const said = [];
    const f = await playing({ divergence: (api, detail)=>said.push(`${api}: ${detail}`) });
    assert.ok(f.api.output().memory.table instanceof Uint8Array);
    f.call(f.buffer, 'Play', [0, 0, DSBPLAY_LOOPING]);
    f.api.pump();
    assert.deepEqual(playingVoices(f), [BUFFER_BYTES], 'and it plays');
    assert.equal(said.filter(line=>/run's cache/.test(line)).length, 1, said.join('\n'));
});

test('a process that replaces another mixes into the same sound output', async()=>{
    // The table is the machine's, not the program's: the page was handed it
    // before the program changed and its worklet holds it across the change.
    // A child that made its own left that reader on a dead buffer -- audible
    // as a menu with no sound at all.
    const first = await playing();
    const inherited = { table: first.api.output().table };
    const f = await playing({ memory: inherited });
    assert.equal(f.api.output().table, inherited.table, 'the output the reader already holds');

    f.call(f.buffer, 'Play', [0, 0, DSBPLAY_LOOPING]);
    f.api.pump();
    assert.deepEqual(playingVoices(f), [BUFFER_BYTES],
        'and the child\'s buffer is a voice in it, which the reader that held it hears');
});
test('a build with nothing draining the ring does not read a buffer out', async()=>{
    // Every sample read out here would be mixed and then thrown away, and this
    // runs on every mix of every turn. The cursors still move -- that is
    // DirectSound's own business and the program watches them -- but there is
    // nothing on the other end for the sound to reach.
    const f = await playing({ drained: false });
    f.call(f.buffer, 'Play', [0, 0, DSBPLAY_LOOPING]);
    f.advance(50);
    f.api.pump();

    assert.equal(f.api.output().diagnostics().tracks, 0, 'no track was opened');
    assert.equal(f.api.output().diagnostics().produced, 0, 'and nothing was mixed');
});

test('a buffer nobody played contributes nothing', async()=>{
    const f = await playing();
    f.advance(50);
    assert.equal(f.api.pump(), 0);
    assert.equal(f.api.output().diagnostics().tracks, 0, 'and opens no track');
});

test('with shared memory, a playing buffer is a sound card\'s voice over the buffer\'s own bytes',
    async()=>{
        // Not converted, not silence, not pushed a turn at a time: the whole
        // buffer mirrored for the device to read on its own clock.
        const loud = await playing();
        loud.call(loud.buffer, 'Play', [0, 0, DSBPLAY_LOOPING]);
        loud.api.pump();

        const table = loud.api.output().table;
        const header = tableView(Int32Array, table, slotHeaderOffset(0), SLOT_HEADER_INT32);
        assert.equal(Atomics.load(header, KIND), KIND_DMA, 'a voice, not a queue');
        assert.equal(Atomics.load(header, LENGTH), BUFFER_BYTES, 'the whole buffer');
        assert.equal(Atomics.load(header, PLAYING), 1);
        assert.equal(Atomics.load(header, LOOPING), 1);
        const arena = tableView(Uint8Array, table, ARENA_OFFSET, ARENA_BYTES);
        const base = Atomics.load(header, BASE);
        assert.ok(arena.subarray(base, base + BUFFER_BYTES).every(byte=>byte === 0x40),
            'byte-equal to what the guest wrote');
    });

test('with shared memory, a buffer\'s voice plays from where Play found the cursor, not from where'
    + ' it stood at the next pump', async()=>{
    // The voice was opened at the next pump while the cursor ran on by the
    // clock from Play, and was put where it had got to: the first few
    // milliseconds of every sound were never heard (a streamed tone came out
    // 4-6 ms short).
    const loud = await playing();
    loud.call(loud.buffer, 'Play', [0, 0, DSBPLAY_LOOPING]);
    const header = tableView(Int32Array, loud.api.output().table,
        slotHeaderOffset(0), SLOT_HEADER_INT32);
    assert.equal(Atomics.load(header, KIND), KIND_DMA, 'the voice is there at Play');
    assert.equal(Atomics.load(header, PLAYING) !== 0, true);
    loud.advance(5);
    loud.api.pump();
    assert.equal(Atomics.load(header, POSITION), 0, 'from the start of the buffer');
});

test('with shared memory, a buffer\'s pan reaches its voice', async()=>{
    const f = await playing();
    f.call(f.buffer, 'SetPan', [10000]);
    f.call(f.buffer, 'Play', [0, 0, DSBPLAY_LOOPING]);
    f.api.pump();

    const table = f.api.output().table;
    const header = tableView(Int32Array, table, slotHeaderOffset(0), SLOT_HEADER_INT32);
    const pcm = tableView(Uint8Array, table, slotPcmOffset(0), SLOT_BYTES);
    const arena = tableView(Uint8Array, table, ARENA_OFFSET, ARENA_BYTES);
    const block = new Float32Array(2 * 2);
    resampleInto({ block, blockFrames: 2, header, pcm, arena, outputRate: 48000,
        seam: createSeam() });
    assert.equal(block[0], 0, 'DSBPAN_RIGHT leaves the left silent');
    assert.ok(block[1] > 0);
});

test('with shared memory, a volume or a pan changed while the buffer plays reaches its voice at'
    + ' the next turn, and only what changed is given again', async()=>{
    const f = await playing();
    f.call(f.buffer, 'Play', [0, 0, DSBPLAY_LOOPING]);
    f.api.pump();
    const table = f.api.output().table;
    const header = tableView(Int32Array, table, slotHeaderOffset(0), SLOT_HEADER_INT32);
    const pcm = tableView(Uint8Array, table, slotPcmOffset(0), SLOT_BYTES);
    const arena = tableView(Uint8Array, table, ARENA_OFFSET, ARENA_BYTES);
    const heard = ()=>{
        const block = new Float32Array(2 * 2);
        resampleInto({ block, blockFrames: 2, header, pcm, arena, outputRate: 48000,
            seam: createSeam() });
        return [...block.subarray(0, 2)];
    };
    const [left, right] = heard();
    assert.ok(left > 0 && right > 0);
    f.api.pump();
    assert.deepEqual(heard(), [left, right], 'a turn with nothing changed changes nothing');
    f.call(f.buffer, 'SetVolume', [-10000]);
    f.api.pump();
    assert.deepEqual(heard(), [0, 0], 'DSBVOLUME_MIN silences it');
    f.call(f.buffer, 'SetVolume', [0]);
    f.call(f.buffer, 'SetPan', [-10000]);
    f.api.pump();
    const [panned, silent] = heard();
    assert.ok(panned > 0, 'its volume back');
    assert.equal(silent, 0, 'DSBPAN_LEFT leaves the right silent');
});

test('with shared memory, a retuned buffer\'s slot reads at its new rate', async()=>{
    const f = await playing();
    f.call(f.buffer, 'Play', [0, 0, DSBPLAY_LOOPING]);
    f.advance(50);
    f.api.pump();
    f.call(f.buffer, 'SetFrequency', [44100]);
    f.advance(20);
    f.api.pump();

    const header = tableView(Int32Array, f.api.output().table,
        slotHeaderOffset(0), SLOT_HEADER_INT32);
    assert.equal(Atomics.load(header, SLOT_RATE), 44100);
});

test('with shared memory, a stalled engine thread is not heard: the device plays on', async()=>{
    // The crackle a busy engine made: the bytes left for the audio thread only
    // when the engine ran, so a load or a translation that held it for a few
    // tens of milliseconds emptied the device while the program's own buffer
    // held most of a second. Now the device reads the buffer itself, the way
    // a sound card's DMA does, and the program's cursor is where it reads.
    const f = await playing();
    f.call(f.buffer, 'Play', [0, 0, DSBPLAY_LOOPING]);
    f.api.pump();

    const table = f.api.output().table;
    const outputRate = f.api.output().sampleRate;
    const global = tableView(Int32Array, table, 0, GLOBAL_HEADER_INT32);
    const slots = Array.from({ length: SLOTS }, (_, slot)=>({
        header: tableView(Int32Array, table, slotHeaderOffset(slot), SLOT_HEADER_INT32),
        pcm: tableView(Uint8Array, table, slotPcmOffset(slot), SLOT_BYTES),
    }));
    const seams = slots.map(()=>createSeam());
    const arena = tableView(Uint8Array, table, ARENA_OFFSET, ARENA_BYTES);
    const block = new Float32Array(128 * 2);
    // Three hundred milliseconds of device blocks, and not one pump.
    const blocks = Math.ceil(outputRate * 0.3 / 128);
    const starvedBefore = Atomics.load(global, STARVED_BLOCKS);
    for (let at = 0; at < blocks; at++)
    {
        mixBlock({ global, slots, seams, block, blockFrames: 128, outputRate, arena });
    }
    assert.equal(Atomics.load(global, STARVED_BLOCKS) - starvedBefore, 0,
        'every block had the program\'s sound in it');
    assert.equal(Atomics.load(global, BLOCKS) >= blocks, true);

    const position = Atomics.load(slots[0].header, POSITION);
    const expected = Math.floor(blocks * 128 * RATE / outputRate) * CHANNELS * (BITS / 8);
    assert.ok(Math.abs(position - expected) <= CHANNELS * (BITS / 8) * 2,
        `the device moved the cursor (${position} against ${expected})`);
    f.view.setUint32(OUT_AT, 0xffffffff, true);
    assert.equal(f.call(f.buffer, 'GetCurrentPosition', [OUT_AT, 0]), DS_OK);
    assert.equal(f.view.getUint32(OUT_AT, true), position,
        'and it is the cursor the program reads');
});

test('with shared memory, what the device plays and nobody wrote is counted stale', async()=>{
    // The device reads the buffer on its own clock, so a refill that comes
    // late is heard as the last lap again -- and counted, on this path too.
    const f = await playing();
    f.call(f.buffer, 'Play', [0, 0, DSBPLAY_LOOPING]);
    f.api.pump();
    const table = f.api.output().table;
    const outputRate = f.api.output().sampleRate;
    const global = tableView(Int32Array, table, 0, GLOBAL_HEADER_INT32);
    const slots = Array.from({ length: SLOTS }, (_, slot)=>({
        header: tableView(Int32Array, table, slotHeaderOffset(slot), SLOT_HEADER_INT32),
        pcm: tableView(Uint8Array, table, slotPcmOffset(slot), SLOT_BYTES),
    }));
    const seams = slots.map(()=>createSeam());
    const arena = tableView(Uint8Array, table, ARENA_OFFSET, ARENA_BYTES);
    const block = new Float32Array(128 * 2);
    for (let at = 0; at < Math.ceil(outputRate * 0.3 / 128); at++)
    {
        mixBlock({ global, slots, seams, block, blockFrames: 128, outputRate, arena });
    }
    f.advance(300);
    f.api.pump();
    // The fixture filled the buffer behind the program's back: nothing of it
    // was ever unlocked, so all the device played is stale.
    assert.ok(f.held.stale.bytes > 0, `stale ${f.held.stale.bytes}`);
});

test('with shared memory, a released DirectSound buffer frees its slot: 40 over a session '
    + 'never fall back', async()=>{
    // The seam never called track.close() when a buffer's references reached
    // zero, and neither `resampleInto` nor anything else ever freed a slot on
    // its own -- so the ceiling was not "32 buffers open at once" but "32
    // buffers played, ever, in the session": the ordinary DirectSound idiom of
    // creating and releasing a buffer per sound effect exhausted every slot
    // permanently the first time 32 had ever been played.
    const f = await playing();
    for (let i = 0; i < 40; i++)
    {
        assert.equal(f.call(f.root, 'CreateSoundBuffer', [DESC_AT, OUT_AT + 4, 0]), DS_OK);
        const pointer = f.view.getUint32(OUT_AT + 4, true);
        // f.objectAt() answers the publisher's adapter, not the raw buffer;
        // the raw buffer -- with `.address` and a plain, non-COM `.release()`
        // a test can call directly -- is the adapter's own `.api`.
        const raw = f.objectAt(pointer).api;
        f.bytes.fill(0x40, raw.address, raw.address + BUFFER_BYTES);

        f.call(pointer, 'Play', [0, 0, DSBPLAY_LOOPING]);
        f.advance(50);
        f.api.pump(); // opens the track and feeds it

        raw.release(); // the program is done with it
        f.api.pump(); // feedBuffers notices the release and closes the track

        // Only the reader (resampleInto, standing in for the worklet) frees
        // the slot back to STATE_FREE; every track in this test lands on
        // slot 0, the sole free slot each time.
        const table = f.api.output().table;
        const header = tableView(Int32Array, table, slotHeaderOffset(0), SLOT_HEADER_INT32);
        const pcm = tableView(Uint8Array, table, slotPcmOffset(0), SLOT_BYTES);
        resampleInto({
            block: new Float32Array(2), blockFrames: 1, header, pcm,
            outputRate: f.api.output().sampleRate, seam: createSeam(),
        });
    }
    assert.equal(f.api.output().diagnostics().fallbackTracks, 0,
        'no fallback after releasing every buffer before the next one opened');
});

test('buffers kept loaded and stopped leave the walk; the one played stays', async()=>{
    // A program that loads every sound it has once and plays a few at a time
    // was walked a thousand buffers, twice, on every turn.
    const f = await playing();
    /** @type {number[]} */
    const made = [];
    for (let i = 0; i < 40; i++)
    {
        assert.equal(f.call(f.root, 'CreateSoundBuffer', [DESC_AT, OUT_AT + 4, 0]), DS_OK);
        made.push(f.view.getUint32(OUT_AT + 4, true));
    }
    f.api.pump();
    f.api.pump();
    assert.ok(f.api.feeding().awake <= 1, `${f.api.feeding().awake} still walked`);
    f.call(made[20], 'Play', [0, 0, DSBPLAY_LOOPING]);
    f.advance(50);
    f.api.pump();
    f.api.pump();
    assert.equal(f.api.feeding().awake, 1, 'the one playing');
    assert.equal(f.api.buffers().length, 41, 'and every one is still there to be played');
});

test('with nothing listening, a released buffer still leaves the walk', async()=>{
    // A build with no sound device reads nothing out, but it still walks every
    // buffer before each mix for its notifications; one that never let go of a
    // released buffer walked everything the program had ever made.
    const f = await playing({ drained: false });
    for (let i = 0; i < 40; i++)
    {
        assert.equal(f.call(f.root, 'CreateSoundBuffer', [DESC_AT, OUT_AT + 4, 0]), DS_OK);
        const pointer = f.view.getUint32(OUT_AT + 4, true);
        f.call(pointer, 'Play', [0, 0, DSBPLAY_LOOPING]);
        f.objectAt(pointer).api.release();
        f.api.pump();
    }
    assert.equal(f.api.buffers().length, 1, 'only the buffer the program still holds');
    assert.equal(f.api.feeding().refusedFills, 40, 'and still nothing was read out');
});

/** Somewhere to put a DSBPOSITIONNOTIFY the guest would have filled in. */
const NOTIFY_AT = 0x400;

/** @param {any} f @param {number} event */
function askToBeWokenHalfWay(f, event){
    f.view.setUint32(NOTIFY_AT, BUFFER_BYTES / 2, true);
    f.view.setUint32(NOTIFY_AT + 4, event, true);
    const notify = f.config.publishInterface(f.objectAt(f.buffer), IID_IDirectSoundNotify);
    assert.ok(notify !== 0, 'the buffer offers the notify interface');
    assert.equal(f.call(notify, 'SetNotificationPositions', [1, NOTIFY_AT]), DS_OK);
}

test('a position a program asked to be woken at wakes it', async()=>{
    // A program that streams into a sound buffer does not poll it: it asks to be
    // told when playback reaches a position and waits on an event, and the
    // thread that refills the buffer is that wait. Nothing ever tested those
    // positions, so the wake never came, the refill never happened, and a title
    // that had set its sound up correctly sat in silence with several threads
    // blocked for ever.
    const f = await playing();
    const EVENT = 0x4058;
    askToBeWokenHalfWay(f, EVENT);
    f.call(f.buffer, 'Play', [0, 0, DSBPLAY_LOOPING]);

    f.advance(1);
    deviceReads(f, 1);
    f.api.pump();
    assert.deepEqual(f.signalled, [], 'not before playback reaches it');

    // Past the half-second mark the position sits at, as far as the device read.
    f.advance(600);
    deviceReads(f, 600);
    f.api.pump();
    assert.deepEqual(f.signalled, [EVENT], 'and exactly once when it does');
});
test('a program is woken even when nothing is listening to the sound', async()=>{
    // The wake is owed whether or not anything drains the ring. A build with no
    // sound device must not hang the program that asked for one.
    const f = await playing({ drained: false });
    const EVENT = 0x4060;
    askToBeWokenHalfWay(f, EVENT);
    f.call(f.buffer, 'Play', [0, 0, DSBPLAY_LOOPING]);
    f.advance(600);
    f.api.pump();

    assert.deepEqual(f.signalled, [EVENT]);
});

test('the MPEG provider is a library beside DirectSound, with an entry point', async()=>{
    // A sound library of this era loads the provider itself and expects its
    // DllMain to register with it; a table without one would load and stay
    // silent, which the program reads as "no decoder for this file".
    const f = await playing();
    const provider = f.api.libraries()['Mp3dec.asi'];
    assert.ok(provider, 'listed with the rest');
    assert.deepEqual(f.api.runtimes(), ['Mp3dec.asi'],
        'and a runtime the engine answers for, whoever brought a copy');
    assert.equal(provider?.DllMain.argBytes, 12);
    assert.ok(provider?.ASI_stream_open && provider?.ASI_stream_process);
    assert.deepEqual(audioModule.diagnostics().metrics?.mp3, {
        registered: false, provider: 0, opens: 0, failedOpens: 0, open: 0, samplesOut: 0,
        waits: 0, lastError: '', recent: [], streams: [],
    });
});

test('DirectSound\'s ordinals are offered beside its table', async()=>{
    // The assembling caller synthesises every library with the numbers its
    // layer declares, and a program that imports by number needs Windows'.
    const f = await playing();
    const ordinals = f.api.ordinals()['DSOUND.dll'];
    assert.equal(ordinals[1], 'DirectSoundCreate');
    assert.equal(ordinals[2], 'DirectSoundEnumerateA');
    assert.equal(ordinals[11], 'DirectSoundCreate8');
});

test('the MPEG provider can be left out, for a run to compare against', async()=>{
    const f = fixture();
    const api = await audioModule.create({ ...f.config, mp3: false }, {
        requireApi: (/** @type {string} */ name)=>
            name === 'bridge' ? { callGuest: async()=>0 } : f.memory,
        provide: ()=>{},
    });
    assert.deepEqual(Object.keys(api.libraries()), ['DSOUND.dll']);
    assert.deepEqual(api.runtimes(), [], 'and then the copy the program brought is what loads');
});

test('the decoder behind the provider follows the configuration', async()=>{
    const f = fixture();
    const host = {
        requireApi: (/** @type {string} */ name)=>
            name === 'bridge' ? { callGuest: async()=>0 } : f.memory,
        provide: ()=>{},
    };
    // Nothing offered: the hosted minimp3, which answers inside the call.
    let api = await audioModule.create({ ...f.config }, host);
    assert.deepEqual(api.decoder(), { name: 'minimp3', opens: 0, paddedFrames: 0 });
    assert.deepEqual(audioModule.diagnostics().metrics?.decoder,
        { name: 'minimp3', opens: 0, paddedFrames: 0 });

    // A test's own decoder wins.
    api = await audioModule.create({ ...f.config, decoder: {
        open: ()=>({ feed: ()=>{}, flush: ()=>Promise.resolve(), close: ()=>{} }),
    } }, host);
    assert.deepEqual(api.decoder(), { name: 'custom' });
});

/**
 * A mixer fed as a guest mixing thread feeds one: every 5 ms it writes, 1424
 * bytes at a time, up to 65 ms past the play cursor it reads -- until the
 * machine running it stalls for `stallMs` in its second lap, when it writes
 * nothing and the device plays on. Answers what the device played that
 * nobody had written since the lap before, and how far the cursor moved over
 * the stall.
 *
 * @param {number} stallMs
 */
async function refillAcrossAStall(stallMs){
    const f = await playing();
    const [held] = f.api.buffers();
    const table = f.api.output().table;
    const outputRate = f.api.output().sampleRate;
    const global = tableView(Int32Array, table, 0, GLOBAL_HEADER_INT32);
    const slots = Array.from({ length: SLOTS }, (_, slot)=>({
        header: tableView(Int32Array, table, slotHeaderOffset(slot), SLOT_HEADER_INT32),
        pcm: tableView(Uint8Array, table, slotPcmOffset(slot), SLOT_BYTES),
    }));
    const seams = slots.map(()=>createSeam());
    const arena = tableView(Uint8Array, table, ARENA_OFFSET, ARENA_BYTES);
    const block = new Float32Array(128 * 2);
    const bytesPerMs = RATE * CHANNELS * (BITS / 8) / 1000;
    const LOCK_AT = 0x380;
    /** @param {number} from @param {number} length */
    const write = (from, length)=>{
        assert.equal(f.call(f.buffer, 'Lock',
            [from, length, LOCK_AT, LOCK_AT + 4, LOCK_AT + 8, LOCK_AT + 12, 0]), DS_OK);
        const [a, al, b, bl] = [0, 4, 8, 12].map(at=>f.view.getUint32(LOCK_AT + at, true));
        assert.equal(f.call(f.buffer, 'Unlock', [a, al, b, bl]), DS_OK);
    };
    const cursor = ()=>{
        assert.equal(f.call(f.buffer, 'GetCurrentPosition', [OUT_AT, OUT_AT + 4]), DS_OK);
        return f.view.getUint32(OUT_AT, true);
    };
    // Primed whole before it plays, as a program primes a streaming buffer.
    write(0, BUFFER_BYTES);
    f.call(f.buffer, 'Play', [0, 0, DSBPLAY_LOOPING]);
    f.api.pump();
    const staleBefore = held.stale.bytes;
    let written = BUFFER_BYTES;
    let played = 0;
    let last = 0;
    let movedInStall = 0;
    for (let ms = 0; ms < 1700; ms += 5)
    {
        for (let frames = 0; frames < outputRate * 0.005; frames += 128)
        {
            mixBlock({ global, slots, seams, block, blockFrames: 128, outputRate, arena });
        }
        f.advance(5);
        if (ms >= 1200 && ms < 1200 + stallMs)
        {
            continue;
        }
        f.api.pump();
        const play = cursor();
        const moved = (play - last + BUFFER_BYTES) % BUFFER_BYTES;
        if (ms === 1200 + stallMs)
        {
            movedInStall = moved;
        }
        played += moved;
        last = play;
        while (written < played + 65 * bytesPerMs)
        {
            const at = written % BUFFER_BYTES;
            const length = Math.min(1424, BUFFER_BYTES - at);
            write(at, length);
            written += length;
        }
    }
    return { stale: held.stale.bytes - staleBefore, movedInStallMs: movedInStall / bytesPerMs };
}

test('a streaming buffer whose writer stalls is held where it was written, not replayed', async()=>{
    // A guest thread mixes into a looping buffer a few tens of milliseconds
    // past the play cursor, and the machine that runs it can stall for longer
    // than that -- a load, a translation. Played on round the circle, the
    // device replays the lap before: the crackle. A buffer the program writes
    // into while it plays is a stream, and the device waits at the end of
    // what was written, as a stream waits for its data, silent meanwhile.
    const steady = await refillAcrossAStall(0);
    assert.equal(steady.stale, 0, 'a writer that keeps up is never waited for');
    const stalled = await refillAcrossAStall(120);
    assert.equal(stalled.stale, 0, 'nothing the program had not written is played');
    assert.ok(stalled.movedInStallMs < 80,
        `the cursor stops where the writing did (${stalled.movedInStallMs.toFixed(0)} ms on)`);
});

test('a stream whose writer stalls for longer than a quarter second is still not replayed',
    async()=>{
        // Given up on after 250 ms, the device played on round the circle --
        // the lap before, a passage heard twice -- while the writer was only
        // late: until it has been gone a whole lap, what lies ahead is stale.
        const stalled = await refillAcrossAStall(600);
        assert.equal(stalled.stale, 0, 'nothing the program had not written is played');
    });

test('a sound device made again after the last one was let go of is heard', async()=>{
    // TRON 2.0 makes its device again for each level: the stream buffer and
    // the device are released, the primary buffer it played is not, and a new
    // device's primary and stream buffer are made and played. The new stream
    // has to be a voice the device plays, as the first was.
    const f = await playing();
    const PRIMARY_DESC = 0x500;
    f.view.setUint32(PRIMARY_DESC + DSBUFFERDESC.dwSize, DSBUFFERDESC.SIZE, true);
    f.view.setUint32(PRIMARY_DESC + DSBUFFERDESC.dwFlags, 1, true);
    assert.equal(f.call(f.root, 'SetCooperativeLevel', [0x1c, 2]), DS_OK);
    assert.equal(f.call(f.root, 'CreateSoundBuffer', [PRIMARY_DESC, OUT_AT + 8, 0]), DS_OK);
    const primary = f.view.getUint32(OUT_AT + 8, true);
    assert.equal(f.call(primary, 'Play', [0, 0, DSBPLAY_LOOPING]), DS_OK);
    f.call(f.buffer, 'Play', [0, 0, DSBPLAY_LOOPING]);
    f.advance(50);
    f.api.pump();
    assert.ok(playingVoices(f).includes(BUFFER_BYTES), 'the first device is heard');

    f.call(f.buffer, 'Stop', []);
    // The bridge's IUnknown, which this fixture does not have: the objects'
    // own counts, as a release through it reaches them.
    assert.equal(f.objectAt(f.buffer).release(), 0);
    assert.equal(f.objectAt(f.root).release(), 0);

    const dsound = f.api.libraries()['DSOUND.dll'];
    assert.equal(dsound.DirectSoundCreate.handler([0, OUT_AT, 0]), DS_OK);
    const root = f.view.getUint32(OUT_AT, true);
    assert.equal(f.call(root, 'SetCooperativeLevel', [0x1c, 2]), DS_OK);
    assert.equal(f.call(root, 'CreateSoundBuffer', [PRIMARY_DESC, OUT_AT + 8, 0]), DS_OK);
    assert.equal(f.call(f.view.getUint32(OUT_AT + 8, true), 'Play', [0, 0, DSBPLAY_LOOPING]),
        DS_OK);
    assert.equal(f.call(root, 'CreateSoundBuffer', [DESC_AT, OUT_AT + 4, 0]), DS_OK);
    const stream = f.view.getUint32(OUT_AT + 4, true);
    const held = f.api.buffers().at(-1);
    f.bytes.fill(0x40, held.address, held.address + BUFFER_BYTES);
    assert.equal(f.call(stream, 'Play', [0, 0, DSBPLAY_LOOPING]), DS_OK);
    f.advance(50);
    f.api.pump();
    assert.ok(playingVoices(f).includes(BUFFER_BYTES), 'the second device is heard too');
});

test('a program that writes the primary buffer itself is heard from it', async()=>{
    // At DSSCL_WRITEPRIMARY there is no secondary buffer: the program mixes
    // into the primary one and plays it. Passed over as the mix target, the
    // device was given nothing.
    const f = await playing();
    const PRIMARY_DESC = 0x500;
    f.view.setUint32(PRIMARY_DESC + DSBUFFERDESC.dwSize, DSBUFFERDESC.SIZE, true);
    f.view.setUint32(PRIMARY_DESC + DSBUFFERDESC.dwFlags, 1, true);
    for (const [level, heard] of /** @type {[number, boolean][]} */ ([[2, false], [4, true]]))
    {
        assert.equal(f.call(f.root, 'SetCooperativeLevel', [0x1c, level]), DS_OK);
        assert.equal(f.call(f.root, 'CreateSoundBuffer', [PRIMARY_DESC, OUT_AT + 8, 0]), DS_OK);
        const primary = f.view.getUint32(OUT_AT + 8, true);
        const held = f.api.buffers().find((/** @type {any} */ b)=>b.primary);
        f.bytes.fill(0x40, held.address, held.address + held.bytes);
        assert.equal(f.call(primary, 'Play', [0, 0, DSBPLAY_LOOPING]), DS_OK);
        f.advance(50);
        f.api.pump();
        assert.equal(playingVoices(f).includes(held.bytes), heard, `level ${level}`);
    }
});

test('a stubbed win32 leaves DirectMusic and the MP3 codec out; a real one refusing is a failure',
    async()=>{
        /** @param {any} win32 */
        const create = win32=>{
            const f = fixture();
            return audioModule.create({ ...f.config, drained: true }, {
                requireApi: (/** @type {string} */ name)=>({
                    bridge: { callGuest: async()=>0 }, win32,
                    cache: { space: ()=>({ hold: ()=>null }) }, memory: f.memory,
                })[name],
                provide: ()=>{},
            });
        };
        const api = await create(createStubApi('win32'));
        assert.ok(api.libraries()['DSOUND.dll'], 'DirectSound is there without win32');
        await assert.rejects(create({ com: ()=>{
            throw new Error('the class registry is not made yet');
        } }), /the class registry is not made yet/);
        await assert.rejects(create({ installAcmCodec: ()=>{
            throw new Error('the codec manager refused it');
        } }), /the codec manager refused it/);
    });
