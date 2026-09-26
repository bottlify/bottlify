/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVtables } from '../../bridge/internal/vtable.js';
import { IUNKNOWN_METHODS, IID_IUNKNOWN } from '../../win32/ole32/objects.js';
import {
    createDirectSound, createPublisher, describe,
    DS_OK, WAVEFORMATEX, DSBUFFERDESC, DSBCAPS, DSCAPS, DSCAPS_FLAGS, DSBPOSITIONNOTIFY,
    IID_IDirectSound, IID_IDirectSound8, IID_IDirectSoundBuffer,
    IID_IDirectSoundBuffer8, IID_IDirectSoundNotify, IID_IDirectSound3DBuffer,
    IDIRECTSOUND_SLOTS, IDIRECTSOUNDBUFFER_SLOTS, IDIRECTSOUNDBUFFER8_SLOTS,
} from './seam.js';
import { DSBSTATUS_PLAYING, DSBPLAY_LOOPING, DSBLOCK_ENTIREBUFFER } from './buffers.js';

const DSERR_INVALIDPARAM = 0x80070057 | 0;
const DSBCAPS_PRIMARYBUFFER = 0x00000001;

/** Flat guest memory, one megabyte, addressed from zero. */
function guestMemory(){
    const bytes = new Uint8Array(0x100000);
    return {
        bytes,
        /** @param {number} address @param {number} length */
        readMemory: (address, length)=>bytes.subarray(address, address + length),
        /** @param {number} address @param {Uint8Array} data */
        writeMemory: (address, data)=>bytes.set(data, address),
        /** @param {number} address */
        u32: address=>new DataView(bytes.buffer).getUint32(address, true),
        /** @param {number} address @param {number} value */
        setU32: (address, value)=>new DataView(bytes.buffer).setUint32(address, value, true),
        /** @param {number} address @param {number} value */
        setU16: (address, value)=>new DataView(bytes.buffer).setUint16(address, value, true),
    };
}

/**
 * A publisher that lays no vtable but records the method list it was given, so
 * a test can call a slot by name and by index -- which is what the guest does.
 */
function fakeBridge(){
    /** @type {Map<number, { object: any, id: string, methods: any[] }>} */
    const byPointer = new Map();
    /** One address per object and interface, as the real publisher promises. */
    const published = new WeakMap();
    let next = 0x10000;
    return {
        byPointer,
        /** @param {number} pointer */
        recordAt(pointer){
            const entry = byPointer.get(pointer);
            assert.ok(entry, `nothing published at ${pointer}`);
            return entry;
        },
        /** @param {any} object @param {string} id */
        publishInterface(object, id){
            const record = object.interfaceFor(id);
            if (!record)
            {
                return 0;
            }
            let byInterface = published.get(object);
            if (!byInterface)
            {
                byInterface = new Map();
                published.set(object, byInterface);
            }
            if (byInterface.has(id))
            {
                return byInterface.get(id);
            }
            const pointer = next;
            next += 4;
            byInterface.set(id, pointer);
            byPointer.set(pointer, { object, id, methods: record.methods });
            return pointer;
        },

        /**
         * QueryInterface, as the bridge implements it: a second interface on
         * the same object, at its own address.
         *
         * @param {number} pointer @param {string} id
         */
        query(pointer, id){
            const entry = byPointer.get(pointer);
            assert.ok(entry, `nothing published at ${pointer}`);
            return this.publishInterface(entry.object, id);
        },
        /**
         * Calls a method the way the bridge does: the interface pointer the
         * guest pushed identifies the object and is *not* passed on, so `args`
         * begins at the method's first declared argument. A fixture that hands
         * the pointer through as well shifts every argument by one and agrees
         * with an implementation that reads them at the wrong offsets.
         *
         * @param {number} pointer @param {string} name @param {number[]} args
         */
        call(pointer, name, args = []){
            const entry = byPointer.get(pointer);
            assert.ok(entry, `nothing published at ${pointer}`);
            const method = entry.methods.find((/** @type {any} */ m)=>m.name === name);
            assert.ok(method, `${entry.id} has no ${name}`);
            assert.ok(method.invoke, `${entry.id}::${name} is not implemented`);
            return method.invoke(entry.object, args) | 0;
        },
        /** @param {number} pointer */
        methodsOf: pointer=>byPointer.get(pointer)?.methods ?? [],
    };
}

/** A clock the test moves by hand. */
function clock(){
    let ms = 1000;
    return { now: ()=>ms, advance: (/** @type {number} */ by)=>{
        ms += by;
    } };
}

/** Everything a test needs, wired the way the module wires it. */
function fixture(){
    const memory = guestMemory();
    const bridge = fakeBridge();
    const time = clock();
    /** @type {number[]} */
    const signalled = [];
    let nextAddress = 0x50000;
    const dsound = createDirectSound({
        memory,
        allocate: (/** @type {number} */ bytes)=>{
            const address = nextAddress;
            nextAddress += (bytes + 0xfff) & ~0xfff;
            return address;
        },
        now: time.now,
        publishInterface: (object, id)=>bridge.publishInterface(object, id),
        signal: event=>signalled.push(event),
    });
    return { memory, bridge, time, dsound, signalled };
}

/** DirectSoundCreate, giving back the interface pointer. */
function createRoot(f = fixture()){
    const out = 0x1000;
    const result = f.dsound.libraries['DSOUND.dll'].DirectSoundCreate.handler([0, out, 0]);
    assert.equal(result, DS_OK);
    return { ...f, root: f.memory.u32(out) };
}

/**
 * Lays a WAVEFORMATEX and a DSBUFFERDESC in guest memory.
 *
 * @param {any} memory @param {any} [spec]
 */
function describeBuffer(memory, spec = {}){
    const { bytes = 8192, flags = 0, channels = 2, rate = 22050, bits = 16,
        format = 0x2000, descriptor = 0x2100 } = spec;
    memory.setU16(format + WAVEFORMATEX.wFormatTag, 1);
    memory.setU16(format + WAVEFORMATEX.nChannels, channels);
    memory.setU32(format + WAVEFORMATEX.nSamplesPerSec, rate);
    memory.setU16(format + WAVEFORMATEX.wBitsPerSample, bits);
    // Deliberately wrong: the model derives the frame size and must not read it.
    memory.setU16(format + WAVEFORMATEX.nBlockAlign, 999);

    memory.setU32(descriptor + DSBUFFERDESC.dwSize, DSBUFFERDESC.SIZE);
    memory.setU32(descriptor + DSBUFFERDESC.dwFlags, flags);
    memory.setU32(descriptor + DSBUFFERDESC.dwBufferBytes, bytes);
    memory.setU32(descriptor + DSBUFFERDESC.lpwfxFormat,
        (flags & DSBCAPS_PRIMARYBUFFER) !== 0 ? 0 : format);
    return descriptor;
}

/**
 * The buffer's IDirectSoundNotify, which is a different interface pointer on
 * the same object -- reached the way a program reaches it, by QueryInterface.
 *
 * @param {any} f @param {number} buffer
 */
const notifyOn = (f, buffer)=>f.bridge.query(buffer, IID_IDirectSoundNotify);

/**
 * Creates one secondary buffer and returns its interface pointer.
 *
 * @param {any} f @param {any} [spec]
 */
function createBuffer(f, spec = {}){
    const descriptor = describeBuffer(f.memory, spec);
    const out = 0x1800;
    const result = f.bridge.call(f.root, 'CreateSoundBuffer', [descriptor, out, 0]);
    assert.equal(result, DS_OK, 'CreateSoundBuffer');
    return f.memory.u32(out);
}

test('every declared slot counts `this` in its argument size', ()=>{
    for (const [name, slots] of [
        ['IDirectSound', IDIRECTSOUND_SLOTS],
        ['IDirectSoundBuffer', IDIRECTSOUNDBUFFER_SLOTS],
    ])
    {
        for (const [method, args] of /** @type {[string, number][]} */ (slots))
        {
            const declared = describe('{00000000-0000-0000-0000-000000000000}',
                [[method, args]]).methods[0];
            assert.equal(declared.argBytes, 4 + args * 4, `${name}::${method}`);
            assert.equal(declared.argBytes % 4, 0);
        }
    }
});

test('IDirectSoundBuffer8 keeps IDirectSoundBuffer\'s slots in the same places', ()=>{
    // A method that moves is a call into a different function, and nothing
    // reports it -- so the shared prefix is the whole safety property here.
    const base = IDIRECTSOUNDBUFFER_SLOTS.map(([name])=>name);
    const eight = IDIRECTSOUNDBUFFER8_SLOTS.map(([name])=>name);
    assert.deepEqual(eight.slice(0, base.length), base);
    assert.deepEqual(eight.slice(base.length),
        ['SetFX', 'AcquireResources', 'GetObjectInPath']);
});

test('a published vtable begins with IUnknown\'s three, in order', ()=>{
    const f = createRoot();
    const methods = f.bridge.methodsOf(f.root);
    assert.deepEqual(methods.slice(0, 3).map((/** @type {any} */ m)=>m.name),
        IUNKNOWN_METHODS.map(m=>m.name));
    assert.equal(methods[3].name, 'CreateSoundBuffer', 'and then the interface\'s own');
    assert.equal(methods.length, 3 + IDIRECTSOUND_SLOTS.length);
});

test('every slot is present, including the ones nothing implements', ()=>{
    const f = createRoot();
    const buffer = createBuffer(f);
    const names = f.bridge.methodsOf(buffer).slice(3).map((/** @type {any} */ m)=>m.name);
    assert.deepEqual(names, IDIRECTSOUNDBUFFER_SLOTS.map(([name])=>name));
    // Initialize is declared and unimplemented; leaving it out would shift
    // Lock, Play and everything after it. SetFormat used to be in this list,
    // and being unimplemented was not harmless: a sound library sets the
    // primary buffer's format to say what the mix should run at, reads the
    // refusal as a device it cannot drive, and abandons DirectSound.
    const method = f.bridge.methodsOf(buffer).find(
        (/** @type {any} */ m)=>m.name === 'Initialize');
    assert.ok(method, 'Initialize must occupy its slot');
    assert.equal(method.invoke, undefined);
});

test('one object has one identity however many times it is published', ()=>{
    const f = createRoot();
    const again = 0x1004;
    f.dsound.libraries['DSOUND.dll'].DirectSoundCreate.handler([0, again, 0]);
    assert.equal(f.memory.u32(again), f.root,
        'a second pointer is a second object to a program comparing them');
});

test('an object answers QueryInterface for what it has and refuses what it has not', ()=>{
    const f = createRoot();
    const buffer = createBuffer(f);
    const adapter = f.bridge.recordAt(buffer).object;
    assert.ok(adapter.interfaceFor(IID_IDirectSoundBuffer));
    assert.ok(adapter.interfaceFor(IID_IDirectSoundBuffer8));
    assert.ok(adapter.interfaceFor(IID_IDirectSoundNotify));
    assert.ok(adapter.interfaceFor(IID_IUNKNOWN), 'every object has IUnknown');
    assert.equal(adapter.interfaceFor(IID_IDirectSound3DBuffer), null,
        'a short vtable is worse than E_NOINTERFACE');
});

test('the root answers to both IDirectSound and IDirectSound8', ()=>{
    const f = createRoot();
    const adapter = f.bridge.recordAt(f.root).object;
    assert.equal(adapter.interfaceFor(IID_IDirectSound8).methods.length,
        adapter.interfaceFor(IID_IDirectSound).methods.length);
});

test('CreateSoundBuffer refuses a descriptor with no size or no format', ()=>{
    const f = createRoot();
    const out = 0x1800;
    const noSize = describeBuffer(f.memory, { bytes: 0 });
    assert.equal(f.bridge.call(f.root, 'CreateSoundBuffer', [noSize, out, 0]),
        DSERR_INVALIDPARAM);
    assert.equal(f.memory.u32(out), 0, 'and zeroes the pointer it refused to fill');

    f.memory.setU32(noSize + DSBUFFERDESC.dwBufferBytes, 4096);
    f.memory.setU32(noSize + DSBUFFERDESC.lpwfxFormat, 0);
    assert.equal(f.bridge.call(f.root, 'CreateSoundBuffer', [noSize, out, 0]),
        DSERR_INVALIDPARAM);
});

test('a primary buffer needs neither a size nor a format', ()=>{
    const f = createRoot();
    const descriptor = describeBuffer(f.memory,
        { bytes: 0, flags: DSBCAPS_PRIMARYBUFFER });
    const out = 0x1800;
    assert.equal(f.bridge.call(f.root, 'CreateSoundBuffer', [descriptor, out, 0]), DS_OK);
    assert.notEqual(f.memory.u32(out), 0);
    assert.equal(f.dsound.buffers()[0].primary, true);
});

test('CreateSoundBuffer refuses null pointers rather than dereferencing them', ()=>{
    const f = createRoot();
    assert.equal(f.bridge.call(f.root, 'CreateSoundBuffer', [0, 0x1800, 0]),
        DSERR_INVALIDPARAM);
    assert.equal(f.bridge.call(f.root, 'CreateSoundBuffer', [0x2100, 0, 0]),
        DSERR_INVALIDPARAM);
});

test('GetCurrentPosition writes both cursors, and the write cursor leads', ()=>{
    const f = createRoot();
    const buffer = createBuffer(f, { bytes: 88200 });
    f.bridge.call(buffer, 'Play', [0, 0, DSBPLAY_LOOPING]);
    f.time.advance(100);

    const play = 0x1900;
    const write = 0x1904;
    assert.equal(f.bridge.call(buffer, 'GetCurrentPosition', [play, write]), DS_OK);
    assert.ok(f.memory.u32(write) > f.memory.u32(play));
});

test('GetCurrentPosition accepts a null for either cursor', ()=>{
    const f = createRoot();
    const buffer = createBuffer(f);
    // A program that only wants the play cursor passes NULL for the other, and
    // writing through it would be a fault rather than a wrong number.
    assert.equal(f.bridge.call(buffer, 'GetCurrentPosition', [0x1900, 0]), DS_OK);
    assert.equal(f.bridge.call(buffer, 'GetCurrentPosition', [0, 0x1904]), DS_OK);
});

test('GetStatus reports playing, and a null pointer is refused', ()=>{
    const f = createRoot();
    const buffer = createBuffer(f);
    const status = 0x1900;
    assert.equal(f.bridge.call(buffer, 'GetStatus', [status]), DS_OK);
    assert.equal(f.memory.u32(status), 0);
    f.bridge.call(buffer, 'Play', [0, 0, DSBPLAY_LOOPING]);
    f.bridge.call(buffer, 'GetStatus', [status]);
    assert.equal(f.memory.u32(status) & DSBSTATUS_PLAYING, DSBSTATUS_PLAYING);
    assert.equal(f.bridge.call(buffer, 'GetStatus', [0]), DSERR_INVALIDPARAM);
});

test('Lock hands back guest addresses, and the wrap as a second range', ()=>{
    const f = createRoot();
    const buffer = createBuffer(f, { bytes: 4096 });
    const [p1, n1, p2, n2] = [0x1900, 0x1904, 0x1908, 0x190c];
    assert.equal(f.bridge.call(buffer, 'Lock', [4000, 200, p1, n1, p2, n2, 0]), DS_OK);

    const base = f.dsound.buffers()[0].address;
    assert.equal(f.memory.u32(p1), base + 4000);
    assert.equal(f.memory.u32(n1), 96);
    assert.equal(f.memory.u32(p2), base, 'the wrap continues at the buffer\'s start');
    assert.equal(f.memory.u32(n2), 104);
});

test('Lock always writes the second range, even when it is empty', ()=>{
    const f = createRoot();
    const buffer = createBuffer(f, { bytes: 4096 });
    const [p1, n1, p2, n2] = [0x1900, 0x1904, 0x1908, 0x190c];
    // Left over from an earlier lock. A program that reads these without
    // checking splices audio from somewhere else into its stream.
    f.memory.setU32(p2, 0xdeadbeef);
    f.memory.setU32(n2, 1234);
    f.bridge.call(buffer, 'Lock', [0, 100, p1, n1, p2, n2, 0]);
    assert.equal(f.memory.u32(p2), 0);
    assert.equal(f.memory.u32(n2), 0);
});

test('Lock refuses without somewhere to put the first range', ()=>{
    const f = createRoot();
    const buffer = createBuffer(f);
    assert.equal(f.bridge.call(buffer, 'Lock', [0, 16, 0, 0x1904, 0, 0, 0]),
        DSERR_INVALIDPARAM);
    assert.equal(f.bridge.call(buffer, 'Lock', [0, 16, 0x1900, 0, 0, 0, 0]),
        DSERR_INVALIDPARAM);
});

test('DSBLOCK_ENTIREBUFFER locks all of it from the start', ()=>{
    const f = createRoot();
    const buffer = createBuffer(f, { bytes: 4096 });
    const [p1, n1, p2, n2] = [0x1900, 0x1904, 0x1908, 0x190c];
    f.bridge.call(buffer, 'Lock',
        [3000, 8, p1, n1, p2, n2, DSBLOCK_ENTIREBUFFER]);
    assert.equal(f.memory.u32(p1), f.dsound.buffers()[0].address);
    assert.equal(f.memory.u32(n1), 4096);
    assert.equal(f.memory.u32(n2), 0);
});

test('Unlock succeeds once and then reports the mistake', ()=>{
    const f = createRoot();
    const buffer = createBuffer(f);
    f.bridge.call(buffer, 'Lock', [0, 64, 0x1900, 0x1904, 0x1908, 0x190c, 0]);
    assert.equal(f.bridge.call(buffer, 'Unlock', [0, 0, 0, 0]), DS_OK);
    assert.notEqual(f.bridge.call(buffer, 'Unlock', [0, 0, 0, 0]), DS_OK);
});

test('GetCaps fills DSBCAPS and refuses a header that does not declare its size', ()=>{
    const f = createRoot();
    const buffer = createBuffer(f, { bytes: 4096 });
    const caps = 0x1a00;
    assert.equal(f.bridge.call(buffer, 'GetCaps', [caps]), DSERR_INVALIDPARAM,
        'dwSize is zero, so the caller and we disagree about the layout');
    f.memory.setU32(caps + DSBCAPS.dwSize, DSBCAPS.SIZE);
    assert.equal(f.bridge.call(buffer, 'GetCaps', [caps]), DS_OK);
    assert.equal(f.memory.u32(caps + DSBCAPS.dwBufferBytes), 4096);
    assert.equal(f.memory.u32(caps + DSBCAPS.dwFlags), 0);
});

test('a size that splits a frame is rounded up to the next whole one', ()=>{
    // Wine's dsound test_block_align, which Windows passes: a second of 11025 Hz
    // 16-bit stereo plus one byte comes back as that second plus one frame.
    const f = createRoot();
    const buffer = createBuffer(f, { bytes: 44101, rate: 11025, channels: 2, bits: 16 });
    const caps = 0x1a00;
    f.memory.setU32(caps + DSBCAPS.dwSize, DSBCAPS.SIZE);
    assert.equal(f.bridge.call(buffer, 'GetCaps', [caps]), DS_OK);
    assert.equal(f.memory.u32(caps + DSBCAPS.dwBufferBytes), 44104);

    // A lap that ends on a frame boundary, or the second one reads its samples
    // one byte out of step, which is noise.
    const [sound] = f.dsound.buffers();
    assert.equal(sound.bytes % sound.format.blockAlign, 0);
    f.bridge.call(buffer, 'Lock', [0, 0, 0x1900, 0x1904, 0x1908, 0x190c, DSBLOCK_ENTIREBUFFER]);
    assert.equal(f.memory.u32(0x1904), 44104, 'the whole buffer is the rounded size');
});

test('GetFormat writes a WAVEFORMATEX derived from the format, not echoed back', ()=>{
    const f = createRoot();
    const buffer = createBuffer(f, { channels: 2, rate: 44100, bits: 16 });
    const out = 0x1b00;
    const written = 0x1bff;
    assert.equal(f.bridge.call(buffer, 'GetFormat',
        [out, WAVEFORMATEX.SIZE, written]), DS_OK);
    assert.equal(f.memory.u32(out + WAVEFORMATEX.nSamplesPerSec), 44100);
    // The descriptor said 999; the frame size is four, because that is what
    // two channels of sixteen bits actually occupy.
    assert.equal(f.memory.bytes[out + WAVEFORMATEX.nBlockAlign], 4);
    assert.equal(f.memory.u32(out + WAVEFORMATEX.nAvgBytesPerSec), 44100 * 4);
    assert.equal(f.memory.u32(written), WAVEFORMATEX.SIZE);
});

test('GetFormat with a buffer too small refuses rather than truncating', ()=>{
    const f = createRoot();
    const buffer = createBuffer(f);
    assert.equal(f.bridge.call(buffer, 'GetFormat', [0x1b00, 4, 0]), DSERR_INVALIDPARAM);
});

test('GetFormat with no structure answers only the size it would need', ()=>{
    const f = createRoot();
    const buffer = createBuffer(f);
    const written = 0x1bff;
    assert.equal(f.bridge.call(buffer, 'GetFormat', [0, 0, written]), DS_OK);
    assert.equal(f.memory.u32(written), WAVEFORMATEX.SIZE);
});

test('volume, pan and frequency round-trip through guest memory', ()=>{
    const f = createRoot();
    const buffer = createBuffer(f, { rate: 22050 });
    const out = 0x1c00;

    f.bridge.call(buffer, 'SetVolume', [-2500 | 0]);
    f.bridge.call(buffer, 'GetVolume', [out]);
    assert.equal(f.memory.u32(out) | 0, -2500);

    f.bridge.call(buffer, 'SetPan', [3000]);
    f.bridge.call(buffer, 'GetPan', [out]);
    assert.equal(f.memory.u32(out) | 0, 3000);

    f.bridge.call(buffer, 'SetFrequency', [11025]);
    f.bridge.call(buffer, 'GetFrequency', [out]);
    assert.equal(f.memory.u32(out), 11025);
});

test('the getters refuse a null rather than writing to address zero', ()=>{
    const f = createRoot();
    const buffer = createBuffer(f);
    for (const name of ['GetVolume', 'GetPan', 'GetFrequency'])
    {
        assert.equal(f.bridge.call(buffer, name, [0]), DSERR_INVALIDPARAM, name);
    }
});

test('SetNotificationPositions reads an array of DSBPOSITIONNOTIFY', ()=>{
    const f = createRoot();
    const buffer = createBuffer(f, { bytes: 88200 });
    const array = 0x1d00;
    f.memory.setU32(array + DSBPOSITIONNOTIFY.dwOffset, 44100);
    f.memory.setU32(array + DSBPOSITIONNOTIFY.hEventNotify, 0x77);
    f.memory.setU32(array + DSBPOSITIONNOTIFY.SIZE + DSBPOSITIONNOTIFY.dwOffset, 66000);
    f.memory.setU32(array + DSBPOSITIONNOTIFY.SIZE + DSBPOSITIONNOTIFY.hEventNotify, 0x88);

    assert.equal(f.bridge.call(notifyOn(f, buffer), 'SetNotificationPositions', [2, array]), DS_OK);
    assert.deepEqual(f.dsound.buffers()[0].notifications,
        [{ offset: 44100, event: 0x77 }, { offset: 66000, event: 0x88 }]);
});

test('SetNotificationPositions with a count and no array is refused', ()=>{
    const f = createRoot();
    const buffer = createBuffer(f);
    assert.equal(f.bridge.call(notifyOn(f, buffer), 'SetNotificationPositions', [3, 0]),
        DSERR_INVALIDPARAM);
    assert.equal(f.bridge.call(notifyOn(f, buffer), 'SetNotificationPositions', [0, 0]), DS_OK,
        'clearing them needs no array');
});

test('a notification the cursor passed is signalled when the buffer is next read', ()=>{
    const f = createRoot();
    const buffer = createBuffer(f, { bytes: 88200 });
    const array = 0x1d00;
    f.memory.setU32(array + DSBPOSITIONNOTIFY.dwOffset, 22000);
    f.memory.setU32(array + DSBPOSITIONNOTIFY.hEventNotify, 0x77);
    f.bridge.call(notifyOn(f, buffer), 'SetNotificationPositions', [1, array]);
    f.bridge.call(buffer, 'Play', [0, 0, DSBPLAY_LOOPING]);
    f.time.advance(500);

    assert.deepEqual(f.signalled, [], 'nothing fires on a timer nobody runs');
    f.bridge.call(buffer, 'GetCurrentPosition', [0x1900, 0x1904]);
    assert.deepEqual(f.signalled, [0x77],
        'a program that polls instead of waiting must still see its notifications');
});

test('DuplicateSoundBuffer shares the samples and not the cursor', ()=>{
    const f = createRoot();
    const original = createBuffer(f, { bytes: 88200 });
    const out = 0x1e00;
    assert.equal(f.bridge.call(f.root, 'DuplicateSoundBuffer', [original, out, 0]), DS_OK);
    const copy = f.memory.u32(out);
    assert.notEqual(copy, original, 'a duplicate is its own object');

    const [source, duplicate] = f.dsound.buffers();
    assert.equal(duplicate.address, source.address, 'the audio is not paid for twice');

    f.bridge.call(copy, 'Play', [0, 0, DSBPLAY_LOOPING]);
    f.time.advance(100);
    const position = 0x1900;
    f.bridge.call(original, 'GetCurrentPosition', [position, 0]);
    assert.equal(f.memory.u32(position), 0, 'playing one does not move the other');
});

test('DuplicateSoundBuffer refuses a pointer it never published', ()=>{
    const f = createRoot();
    assert.equal(f.bridge.call(f.root, 'DuplicateSoundBuffer', [0xbadf00d, 0x1e00, 0]),
        DSERR_INVALIDPARAM);
});

test('the device reports caps only into a header that declares its size', ()=>{
    const f = createRoot();
    const caps = 0x1f00;
    assert.equal(f.bridge.call(f.root, 'GetCaps', [caps]), DSERR_INVALIDPARAM);
    f.memory.setU32(caps + DSCAPS.dwSize, DSCAPS.SIZE);
    assert.equal(f.bridge.call(f.root, 'GetCaps', [caps]), DS_OK);
    assert.equal(f.memory.u32(caps + DSCAPS.dwPrimaryBuffers), 1);
});

test('the device says what it can play, or a program has nothing to ask for', ()=>{
    // This is where Warcraft III's sound library stopped. It created the
    // device, asked what it could do, was told nothing at all -- neither mono
    // nor stereo, neither eight bits nor sixteen -- read the primary format
    // out of politeness, released everything and never opened a buffer. Four
    // times over, and then the game ran in silence.
    const f = createRoot();
    const caps = 0x1f00;
    f.memory.setU32(caps + DSCAPS.dwSize, DSCAPS.SIZE);
    assert.equal(f.bridge.call(f.root, 'GetCaps', [caps]), DS_OK);

    const flags = f.memory.u32(caps + DSCAPS.dwFlags);
    for (const [name, bit] of Object.entries(DSCAPS_FLAGS))
    {
        if (name === 'CERTIFIED' || name === 'EMULDRIVER')
        {
            continue;
        }
        assert.ok((flags & bit) !== 0, `the device claims ${name}`);
    }
    // And not the emulation flag: a sound middleware reading it decides the
    // DirectSound path is not really there, mixes through wave-out and refuses
    // the positional providers that carry a title's effects.
    assert.equal(flags & DSCAPS_FLAGS.EMULDRIVER, 0, 'a real device, not an emulated one');
    assert.deepEqual(f.dsound.diagnostics().events.filter((/** @type {string} */ e)=>!e.startsWith('b')),
        ['GetCaps'], 'the device-level call is in the sequence a diagnostic reads');
});

test('every field of DSCAPS is written, not only the ones anyone thought of', ()=>{
    // A field left alone is one the caller reads out of its own uninitialised
    // memory, and hardware voice counts are exactly what a sound library
    // consults before it decides how to open anything.
    const f = createRoot();
    const caps = 0x1f00;
    for (let at = 0; at < DSCAPS.SIZE; at += 4)
    {
        f.memory.setU32(caps + at, 0xdeadbeef);
    }
    f.memory.setU32(caps + DSCAPS.dwSize, DSCAPS.SIZE);
    assert.equal(f.bridge.call(f.root, 'GetCaps', [caps]), DS_OK);

    for (let at = 4; at < DSCAPS.SIZE; at += 4)
    {
        assert.notEqual(f.memory.u32(caps + at), 0xdeadbeef,
            `DSCAPS+0x${at.toString(16)} was left as the caller found it`);
    }
});

test('GetFormat leaves a null size pointer alone', ()=>{
    // The size written back is optional and a caller that wants only the
    // structure passes null -- which is what Miles passes. Writing through it
    // anyway puts four bytes at address zero.
    const f = createRoot();
    const buffer = createBuffer(f, { bytes: 4096 });
    assert.equal(f.bridge.call(buffer, 'GetFormat', [0x2000, WAVEFORMATEX.SIZE, 0]), DS_OK);
    assert.equal(f.memory.u32(0), 0, 'nothing was written at the null pointer');
});

test('the library exports the entry points a program links against', ()=>{
    const f = fixture();
    const table = f.dsound.libraries['DSOUND.dll'];
    assert.equal(table.DirectSoundCreate.argBytes, 12);
    assert.equal(table.DirectSoundCreate8.argBytes, 12);
    assert.equal(table.DirectSoundEnumerateA.argBytes, 8);
    assert.equal(table.DirectSoundCaptureCreate.argBytes, 12);
    for (const [name, entry] of Object.entries(table))
    {
        assert.equal(entry.argBytes % 4, 0, `${name} is not a whole number of slots`);
    }
});

test('DirectSoundCreate refuses to write through a null', ()=>{
    const f = fixture();
    assert.equal(
        f.dsound.libraries['DSOUND.dll'].DirectSoundCreate.handler([0, 0, 0]),
        DSERR_INVALIDPARAM);
});

test('with no bridge behind it the seam refuses instead of publishing nowhere', ()=>{
    const memory = guestMemory();
    const dsound = createDirectSound({
        memory,
        allocate: ()=>0x50000,
        now: ()=>0,
        publishInterface: ()=>0,
    });
    assert.equal(dsound.libraries['DSOUND.dll'].DirectSoundCreate.handler([0, 0x1000, 0]),
        DS_OK);
    assert.equal(memory.u32(0x1000), 0, 'and hands back a null the program can check');
});

test('the publisher keeps one adapter per object and can find it again', ()=>{
    let next = 0x9000;
    const publisher = createPublisher({ publishInterface: ()=>{
        next += 4;
        return next;
    } });
    const object = { addRef: ()=>1, release: ()=>0 };
    const interfaces = [describe(IID_IDirectSound, IDIRECTSOUND_SLOTS)];
    const first = publisher.publish(object, interfaces, IID_IDirectSound);
    const second = publisher.publish(object, interfaces, IID_IDirectSound);
    assert.equal(publisher.objectAt(first), object);
    assert.equal(publisher.objectAt(second), object);
    assert.equal(publisher.objectAt(0), null, 'a null pointer is a legitimate argument');
    assert.equal(publisher.count(), 2);
});

/**
 * The seam behind the bridge's own vtable publisher, over the same flat memory
 * and called by slot number -- which is the one path a guest actually takes.
 *
 * The fixture above stands in for the bridge and can therefore disagree with
 * it. This cannot: the publisher is the real one, so where a method's arguments
 * land is decided by the code that decides it in a running program.
 */
function guestMachine(){
    const memory = guestMemory();
    /** @type {Map<number, any>} */
    const traps = new Map();
    let nextTrap = 1;
    let heapNext = 0x8000;
    const vtables = createVtables({
        memory: {
            /** @param {number} at @param {number} length */
            readBytes: (at, length)=>memory.bytes.slice(at, at + length),
            /** @param {number} at @param {Uint8Array} value */
            writeBytes: (at, value)=>memory.bytes.set(value, at),
            /** @param {number} at */
            readU32: at=>memory.u32(at),
            /** @param {number} at @param {number} value */
            writeU32: (at, value)=>memory.setU32(at, value),
        },
        /** @param {string} name @param {any} fn */
        register: (name, fn)=>{
            const trap = nextTrap++;
            traps.set(trap, fn);
            return trap;
        },
        heap: {
            /** @param {number} size */
            allocate: size=>{
                const at = heapNext;
                heapNext += size + 16 & ~15;
                return at;
            },
        },
    });

    let storage = 0x60000;
    const dsound = createDirectSound({
        memory,
        allocate: (/** @type {number} */ bytes)=>{
            const at = storage;
            storage += bytes + 0xfff & ~0xfff;
            return at;
        },
        now: ()=>1000,
        publishInterface: (object, id)=>vtables.publish(object, id),
    });

    return {
        memory,
        dsound,
        /**
         * A call as the guest makes it: the interface pointer is pushed like
         * any other argument, and the publisher is what decides it is not one.
         *
         * @param {number} pointer @param {number} index @param {number[]} args
         */
        call(pointer, index, args = []){
            const entry = traps.get(memory.u32(memory.u32(pointer) + index * 4));
            assert.ok(entry, `slot ${index} has an implementation`);
            return entry.handler([pointer, ...args]) | 0;
        },
    };
}

/** @param {[string, number][]} slots @param {string} name */
const slotOf = (slots, name)=>{
    const index = slots.findIndex(([entry])=>entry === name);
    assert.ok(index >= 0, `${name} is a slot`);
    return 3 + index;
};

test('a method reaches the arguments the guest pushed, at the offsets it pushed them', ()=>{
    const g = guestMachine();
    const out = 0x1000;
    assert.equal(
        g.dsound.libraries['DSOUND.dll'].DirectSoundCreate.handler([0, out, 0]), DS_OK);
    const root = g.memory.u32(out);
    assert.notEqual(root, 0);

    // GetCaps(LPDSCAPS) takes one argument and it is the last one pushed, so a
    // handler reading one slot further along finds whatever is above it.
    const caps = 0x1200;
    g.memory.setU32(caps + DSCAPS.dwSize, DSCAPS.SIZE);
    assert.equal(g.call(root, slotOf(IDIRECTSOUND_SLOTS, 'GetCaps'), [caps]), DS_OK);
    assert.equal(g.memory.u32(caps + DSCAPS.dwPrimaryBuffers), 1);

    // CreateSoundBuffer(desc, out, outer): three arguments, and reading them
    // one late takes the descriptor for the buffer the caller asked for.
    const descriptor = describeBuffer(g.memory, { bytes: 8192 });
    const buffer = 0x1300;
    assert.equal(g.call(root, slotOf(IDIRECTSOUND_SLOTS, 'CreateSoundBuffer'),
        [descriptor, buffer, 0]), DS_OK);
    assert.notEqual(g.memory.u32(buffer), 0);
    assert.equal(g.dsound.buffers()[0].bytes, 8192);

    const bufferCaps = 0x1400;
    g.memory.setU32(bufferCaps + DSBCAPS.dwSize, DSBCAPS.SIZE);
    assert.equal(g.call(g.memory.u32(buffer),
        slotOf(IDIRECTSOUNDBUFFER_SLOTS, 'GetCaps'), [bufferCaps]), DS_OK);
    assert.equal(g.memory.u32(bufferCaps + DSBCAPS.dwBufferBytes), 8192);
});

test('diagnostics report what a run actually did', ()=>{
    const f = createRoot();
    const buffer = createBuffer(f);
    f.bridge.call(buffer, 'Play', [0, 0, DSBPLAY_LOOPING]);
    const report = f.dsound.diagnostics();
    assert.equal(report.buffers, 1);
    assert.equal(report.playing, 1);
    // It used to report `device: null` -- "nothing is heard, and it says so" --
    // which was true of the whole layer and is no longer: a playing buffer's
    // bytes are read out and mixed. What is heard is the mixer's to report, and
    // it does, so a second answer here could only ever disagree with it.
    assert.equal('device' in report, false);
});

test('DSCAPS is the ninety-six bytes a program declares, not a hundred', ()=>{
    // The literal, not the symbol: the test that used the symbol on both sides
    // agreed with a wrong number, and every correctly-filled structure was
    // refused. A sound library reads that refusal as no DirectSound at all.
    assert.equal(DSCAPS.SIZE, 96);

    const f = createRoot();
    const caps = 0x1f00;
    f.memory.setU32(caps + DSCAPS.dwSize, 96);
    assert.equal(f.bridge.call(f.root, 'GetCaps', [caps]), DS_OK);
});

test('the primary buffer takes the format a program sets on it', ()=>{
    // This is how a program says what the mix runs at. Refusing it is read as a
    // device that cannot be driven: the program releases everything and falls
    // back to wave-out, and DirectSound is never used again.
    const f = createRoot();
    const primary = createBuffer(f, { flags: DSBCAPS_PRIMARYBUFFER, bytes: 0 });
    const wanted = 0x2400;
    f.memory.setU16(wanted + WAVEFORMATEX.wFormatTag, 1);
    f.memory.setU16(wanted + WAVEFORMATEX.nChannels, 2);
    f.memory.setU32(wanted + WAVEFORMATEX.nSamplesPerSec, 44100);
    f.memory.setU16(wanted + WAVEFORMATEX.wBitsPerSample, 16);

    assert.equal(f.bridge.call(primary, 'SetFormat', [wanted]), DS_OK);

    const read = 0x2500;
    assert.equal(f.bridge.call(primary, 'GetFormat', [read, WAVEFORMATEX.SIZE, 0]), DS_OK);
    assert.equal(f.memory.u32(read + WAVEFORMATEX.nSamplesPerSec), 44100,
        'and reports back what it was given');
});

test('a secondary buffer refuses to have its format set', ()=>{
    // Its format is fixed when it is created, and DirectSound says so.
    const f = createRoot();
    const buffer = createBuffer(f);
    assert.equal(f.bridge.call(buffer, 'SetFormat', [0x2000]), 0x88780032 | 0);
});

/**
 * A fixture with a route into guest code, recording every call made through it
 * and answering with whatever the test says the program's callback returned.
 *
 * @param {number[]} answers  One per expected callback, in order.
 */
function withGuest(answers){
    const memory = guestMemory();
    const bridge = fakeBridge();
    let nextAddress = 0x50000;
    /** @type {{ entry: number, args: number[] }[]} */
    const calls = [];
    const dsound = createDirectSound({
        memory,
        allocate: (/** @type {number} */ bytes)=>{
            const address = nextAddress;
            nextAddress += (bytes + 0xfff) & ~0xfff;
            return address;
        },
        now: ()=>0,
        publishInterface: (object, id)=>bridge.publishInterface(object, id),
        callGuest: async(entry, args)=>{
            calls.push({ entry, args });
            return answers[calls.length - 1] ?? 1;
        },
    });
    return { memory, dsound, calls };
}

/** @param {any} memory @param {number} address */
function textAt(memory, address){
    let out = '';
    for (let at = address; memory.bytes[at] !== 0; at++)
    {
        out += String.fromCharCode(memory.bytes[at]);
    }
    return out;
}

test('enumerating devices describes the primary driver first, with no guid', async()=>{
    const f = withGuest([1, 1]);
    const result = await f.dsound.libraries['DSOUND.dll']
        .DirectSoundEnumerateA.handler([0x9000, 0xabcd]);

    assert.equal(result, DS_OK);
    assert.equal(f.calls.length, 2, 'the primary driver, then the device itself');
    const [primary, device] = f.calls;
    assert.equal(primary.entry, 0x9000, 'the callback the program handed over is what runs');
    assert.equal(primary.args[0], 0, 'the primary driver has no guid, which is how it is known');
    assert.equal(textAt(f.memory, primary.args[1]), 'Primary Sound Driver');
    assert.equal(primary.args[3], 0xabcd, 'and the context it was given comes back to it');
    assert.notEqual(device.args[0], 0, 'a device of its own carries a guid');
});

test('a program that has seen enough is not handed the rest', async()=>{
    const f = withGuest([0]);
    const result = await f.dsound.libraries['DSOUND.dll']
        .DirectSoundEnumerateA.handler([0x9000, 0]);

    assert.equal(result, DS_OK);
    assert.equal(f.calls.length, 1, 'FALSE from the callback ends the enumeration');
});

test('enumerating with no callback is refused rather than ignored', ()=>{
    const f = withGuest([]);
    assert.equal(f.dsound.libraries['DSOUND.dll'].DirectSoundEnumerateA.handler([0, 0]),
        DSERR_INVALIDPARAM);
    assert.equal(f.calls.length, 0);
});

test('the wide spelling writes the names a wide caller reads', async()=>{
    const f = withGuest([0]);
    await f.dsound.libraries['DSOUND.dll'].DirectSoundEnumerateW.handler([0x9000, 0]);

    const at = f.calls[0].args[1];
    assert.equal(f.memory.bytes[at], 'P'.charCodeAt(0));
    assert.equal(f.memory.bytes[at + 1], 0, 'two bytes a character, so a wide read finds it');
    assert.equal(f.memory.bytes[at + 2], 'r'.charCodeAt(0));
});

test('what a program asked the device for is kept whole: buffers and refused interfaces', ()=>{
    // The event ring is short and turns over in seconds of mixing; what a
    // sound library asked for while starting up is the record that says why
    // it chose the path it did, so it is kept apart and never dropped.
    const f = createRoot();
    const buffer = createBuffer(f, { bytes: 4096 });
    assert.equal(f.bridge.recordAt(buffer).object.interfaceFor(IID_IDirectSound3DBuffer), null,
        'a positional buffer is refused');
    const diagnostics = f.dsound.diagnostics();
    assert.equal(diagnostics.creations.length, 1);
    assert.match(diagnostics.creations[0], /^CreateSoundBuffer flags=0x[0-9a-f]+ bytes=4096 fmt=/);
    assert.deepEqual(Object.values(diagnostics.refusedInterfaces), [1]);
});

test('two buffers share one method list, and a slot called through either acts on its own', ()=>{
    // A method list per object was a table of stubs per object in the bridge,
    // and the table those come out of is finite.
    const f = createRoot();
    const first = f.bridge.recordAt(createBuffer(f));
    const second = f.bridge.recordAt(createBuffer(f));
    assert.notEqual(first.object, second.object, 'two buffers');
    assert.equal(first.methods, second.methods, 'one list for IDirectSoundBuffer');
    assert.equal(first.object.interfaceFor(first.id).methods, first.methods,
        'the same list every time');
});
