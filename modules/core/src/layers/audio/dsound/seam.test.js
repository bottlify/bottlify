/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVtables } from '../../bridge/internal/vtable.js';
import { synthesiseModule } from '../../loader/internal/synth.js';
import { IUNKNOWN_METHODS, IID_IUNKNOWN } from '../../win32/ole32/objects.js';
import { writeGuid } from '../../win32/ole32/guid.js';
import {
    createDirectSound, createPublisher, describe,
    DS_OK, WAVEFORMATEX, DSBUFFERDESC, DSBCAPS, DSCAPS, DSCAPS_FLAGS, DSBPOSITIONNOTIFY,
    IID_IDirectSound, IID_IDirectSound8, IID_IDirectSoundBuffer,
    IID_IDirectSoundBuffer8, IID_IDirectSoundNotify, IID_IDirectSound3DBuffer, IID_IKsPropertySet,
    IID_IDirectSound3DListener,
    IDIRECTSOUND_SLOTS, IDIRECTSOUND8_SLOTS, IDIRECTSOUNDBUFFER_SLOTS,
    IDIRECTSOUNDBUFFER8_SLOTS,
} from './seam.js';
import { DSBSTATUS_PLAYING, DSBPLAY_LOOPING, DSBLOCK_ENTIREBUFFER } from './buffers.js';

const DSERR_INVALIDPARAM = 0x80070057 | 0;
const DSERR_CONTROLUNAVAIL = 0x8878001e | 0;
const DSERR_INVALIDCALL = 0x88780032 | 0;
const DSERR_NODRIVER = 0x88780078 | 0;
const DS_UNCERTIFIED = 1;
const DSBCAPS_PRIMARYBUFFER = 0x00000001;
const DSBCAPS_LOCHARDWARE = 0x00000004;
const DSBCAPS_LOCSOFTWARE = 0x00000008;
const DSBCAPS_CTRLFREQUENCY = 0x00000020;
const DSBCAPS_CTRLPAN = 0x00000040;
const DSBCAPS_CTRLVOLUME = 0x00000080;
const DSBCAPS_CTRLPOSITIONNOTIFY = 0x00000100;
const DSBCAPS_CTRLFX = 0x00000200;
const DSBCAPS_GETCURRENTPOSITION2 = 0x00010000;

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
    const mta = { users: 0, enter(){
        mta.users++;
    }, leave(){
        mta.users--;
    } };
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
        mtaUsage: mta,
    });
    return { memory, bridge, time, dsound, signalled, mta };
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
    memory.setU16(format + WAVEFORMATEX.nBlockAlign, channels * bits / 8);
    memory.setU32(format + WAVEFORMATEX.nAvgBytesPerSec, rate * channels * bits / 8);

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
        ['IDirectSound8', IDIRECTSOUND8_SLOTS],
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
    // A secondary buffer is reached through IDirectSoundBuffer8's table,
    // which begins with IDirectSoundBuffer's.
    assert.deepEqual(names, IDIRECTSOUNDBUFFER8_SLOTS.map(([name])=>name));
    assert.equal(f.bridge.recordAt(buffer).object.interfaceFor(IID_IDirectSoundBuffer).sharedWith,
        IID_IDirectSoundBuffer8, 'one pointer for both');
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

test('one object has one identity however many times it is asked for', ()=>{
    const f = createRoot();
    assert.equal(f.bridge.query(f.root, IID_IDirectSound), f.root,
        'a second pointer is a second object to a program comparing them');
});

test('each DirectSoundCreate makes an object of its own, counting its own references', ()=>{
    // Wine's dsound tests release every object they create and expect zero
    // back, and two objects' primary buffers are independent.
    const f = createRoot();
    const again = 0x1004;
    f.dsound.libraries['DSOUND.dll'].DirectSoundCreate.handler([0, again, 0]);
    assert.notEqual(f.memory.u32(again), f.root);

    const device = f.bridge.recordAt(f.root).object;
    assert.equal(device.addRef(), 2);
    assert.equal(device.release(), 1);
    assert.equal(device.release(), 0);
    assert.equal(device.release(), 0, 'and never below');
});

test('a device\'s IUnknown counts apart from IDirectSound, and an over-release frees nothing', ()=>{
    // Wine's dsound8.c test_COM.
    const f = createRoot();
    const device = f.bridge.recordAt(f.root).object;
    assert.equal(device.addRef(IID_IUNKNOWN), 1);
    assert.equal(device.addRef(IID_IUNKNOWN), 2);
    assert.equal(device.addRef(IID_IDirectSound), 2, 'the device\'s own count');
    assert.equal(device.release(IID_IDirectSound), 1);
    assert.equal(device.release(IID_IDirectSound), 0);
    assert.equal(device.release(IID_IUNKNOWN), 1);
    assert.equal(device.release(IID_IUNKNOWN), 0);
    assert.equal(device.release(IID_IUNKNOWN), 0, 'and never below');
    assert.equal(device.api.references, 0);
});

test('an initialized device holds the multithreaded apartment open while it lives', ()=>{
    // Wine's dsound.c test_apttype: a thread in no apartment is in the MTA
    // implicitly while a device exists, and in none once it is gone.
    const f = createRoot();
    assert.equal(f.mta.users, 1);
    const device = f.bridge.recordAt(f.root).object;
    device.addRef(IID_IUNKNOWN);
    device.release(IID_IDirectSound);
    assert.equal(f.mta.users, 1, 'its IUnknown still holds it');
    device.release(IID_IUNKNOWN);
    assert.equal(f.mta.users, 0);
});

test('DirectSoundCreate\'s object is IDirectSound alone; DirectSoundCreate8\'s is both', ()=>{
    // Wine's dsound IDirectSound_test: QueryInterface for IID_IDirectSound8 on
    // what DirectSoundCreate returned is E_NOINTERFACE; its dsound8 counterpart
    // answers both on what DirectSoundCreate8 returned.
    const f = createRoot();
    const device = f.bridge.recordAt(f.root).object;
    assert.ok(device.interfaceFor(IID_IDirectSound));
    assert.equal(device.interfaceFor(IID_IDirectSound8), null);
    assert.equal(f.bridge.query(f.root, IID_IDirectSound8), 0);

    const out = 0x1008;
    f.dsound.libraries['DSOUND.dll'].DirectSoundCreate8.handler([0, out, 0]);
    const eight = f.memory.u32(out);
    assert.notEqual(f.bridge.query(eight, IID_IDirectSound), 0);
    assert.equal(f.bridge.query(eight, IID_IDirectSound8), eight);
});

test('an object answers QueryInterface for what it has and refuses what it has not', ()=>{
    const f = createRoot();
    const buffer = createBuffer(f, { flags: DSBCAPS_CTRLPOSITIONNOTIFY });
    const adapter = f.bridge.recordAt(buffer).object;
    assert.ok(adapter.interfaceFor(IID_IDirectSoundBuffer));
    assert.ok(adapter.interfaceFor(IID_IDirectSoundBuffer8));
    assert.ok(adapter.interfaceFor(IID_IDirectSoundNotify));
    assert.ok(adapter.interfaceFor(IID_IUNKNOWN), 'every object has IUnknown');
    assert.equal(adapter.interfaceFor(IID_IDirectSound3DBuffer), null,
        'a short vtable is worse than E_NOINTERFACE');
});

test('IDirectSound8 is IDirectSound with one slot more', ()=>{
    const f = fixture();
    const out = 0x1000;
    f.dsound.libraries['DSOUND.dll'].DirectSoundCreate8.handler([0, out, 0]);
    const adapter = f.bridge.recordAt(f.memory.u32(out)).object;
    assert.equal(adapter.interfaceFor(IID_IDirectSound8).methods.length,
        adapter.interfaceFor(IID_IDirectSound).methods.length + 1,
        'IDirectSound8 is IDirectSound with VerifyCertification appended');
});

test('IDirectSound8 has its twelfth slot, VerifyCertification, and answers it', ()=>{
    // dsound.h declares it after Initialize. A table that ends one short has a
    // program that calls it jump through whatever word follows the table.
    assert.deepEqual(IDIRECTSOUND8_SLOTS.map(([name])=>name),
        [...IDIRECTSOUND_SLOTS.map(([name])=>name), 'VerifyCertification']);

    const f = fixture();
    const out = 0x1000;
    assert.equal(
        f.dsound.libraries['DSOUND.dll'].DirectSoundCreate8.handler([0, out, 0]), DS_OK);
    const root = f.memory.u32(out);
    assert.equal(f.bridge.recordAt(root).id, IID_IDirectSound8,
        'DirectSoundCreate8 hands out the table IDirectSound8 is called through');
    const methods = f.bridge.methodsOf(root);
    assert.equal(methods.length, 12);
    assert.equal(methods[11].name, 'VerifyCertification');
    assert.equal(methods[11].argBytes, 8);

    // The answer agrees with GetCaps, which does not report DSCAPS_CERTIFIED;
    // Wine's dsound8 test accepts DS_OK here.
    const certified = 0x1100;
    f.memory.setU32(certified, 0xdeadbeef);
    assert.equal(f.bridge.call(root, 'VerifyCertification', [certified]), DS_OK);
    assert.equal(f.memory.u32(certified), DS_UNCERTIFIED);
    assert.equal(f.bridge.call(root, 'VerifyCertification', [0]), DSERR_INVALIDPARAM);
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

test('through DirectSound 8, a 3D buffer is mono and has no pan', ()=>{
    // Wine's ds3d8 test_secondary8: a stereo DSBCAPS_CTRL3D buffer, and a mono
    // one with CTRLPAN as well, are DSERR_INVALIDPARAM; a mono one is made.
    const f = fixture();
    const out = 0x1000;
    f.dsound.libraries['DSOUND.dll'].DirectSoundCreate8.handler([0, out, 0]);
    const eight = { ...f, root: f.memory.u32(out) };
    const at = 0x1800;
    /** @param {any} on @param {any} spec */
    const create = (on, spec)=>{
        f.memory.setU32(at, 0xdeadbeef);
        const result = f.bridge.call(on.root, 'CreateSoundBuffer',
            [describeBuffer(f.memory, spec), at, 0]);
        return { result, pointer: f.memory.u32(at) };
    };
    const DSBCAPS_CTRL3D = 0x00000010;
    const stereo3d = create(eight, { flags: DSBCAPS_CTRL3D, channels: 2 });
    assert.deepEqual(stereo3d, { result: DSERR_INVALIDPARAM, pointer: 0 });
    const panned3d = create(eight, { flags: DSBCAPS_CTRL3D | DSBCAPS_CTRLPAN, channels: 1 });
    assert.deepEqual(panned3d, { result: DSERR_INVALIDPARAM, pointer: 0 });
    assert.equal(create(eight, { flags: DSBCAPS_CTRL3D, channels: 1 }).result, DS_OK);

    // Wine's ds3d test_secondary makes both through DirectSoundCreate's object:
    // the rule is DirectSound 8's.
    const older = createRoot(f);
    const both = create(older, { flags: DSBCAPS_CTRL3D | DSBCAPS_CTRLPAN, channels: 2 });
    assert.equal(both.result, DS_OK);
});

test('a primary buffer described with a format is refused', ()=>{
    // Wine's dsound test_primary: DSBCAPS_PRIMARYBUFFER with a non-null
    // lpwfxFormat is DSERR_INVALIDPARAM and a null pointer back -- its format
    // is set afterwards, through SetFormat.
    const f = createRoot();
    const out = 0x1800;
    f.memory.setU32(out, 0xdeadbeef);
    const descriptor = describeBuffer(f.memory,
        { flags: DSBCAPS_PRIMARYBUFFER | DSBCAPS_CTRLVOLUME });
    f.memory.setU32(descriptor + DSBUFFERDESC.lpwfxFormat, 0x2000);
    assert.equal(f.bridge.call(f.root, 'CreateSoundBuffer', [descriptor, out, 0]),
        DSERR_INVALIDPARAM);
    assert.equal(f.memory.u32(out), 0);
    assert.equal(f.dsound.buffers().length, 0, 'nothing was made');

    // And not handed the one that exists either.
    createBuffer(f, { flags: DSBCAPS_PRIMARYBUFFER, descriptor: 0x2200 });
    assert.equal(f.bridge.call(f.root, 'CreateSoundBuffer', [descriptor, out, 0]),
        DSERR_INVALIDPARAM);
    assert.equal(f.memory.u32(out), 0);
});

test('a device has one primary buffer, handed out again with its count raised', ()=>{
    // Wine's dsound test_primary and test_hw_buffers: a second primary is the
    // first, whatever the second description says, and releasing it leaves
    // one reference; the primary is no IDirectSoundBuffer8 and cannot be
    // duplicated.
    const f = createRoot();
    const primary = createBuffer(f, { flags: DSBCAPS_PRIMARYBUFFER | DSBCAPS_CTRLVOLUME });
    const second = createBuffer(f, { flags: DSBCAPS_PRIMARYBUFFER | DSBCAPS_LOCSOFTWARE });
    assert.equal(second, primary);
    const buffer = f.bridge.recordAt(primary).object;
    assert.equal(buffer.release(), 1);
    assert.equal(f.dsound.buffers().filter(b=>b.primary).length, 1);

    const caps = 0x1a00;
    f.memory.setU32(caps + DSBCAPS.dwSize, DSBCAPS.SIZE);
    f.bridge.call(primary, 'GetCaps', [caps]);
    assert.equal(f.memory.u32(caps + DSBCAPS.dwFlags),
        DSBCAPS_PRIMARYBUFFER | DSBCAPS_CTRLVOLUME, 'the first description stands');

    assert.equal(buffer.interfaceFor(IID_IDirectSoundBuffer8), null);
    assert.equal(f.bridge.query(primary, IID_IDirectSoundBuffer8), 0);
    assert.equal(f.bridge.call(f.root, 'DuplicateSoundBuffer', [primary, 0x1e00, 0]),
        DSERR_INVALIDCALL);

    // Released to nothing and never below; asked for again, it is the same
    // buffer with the format it was given.
    assert.equal(buffer.release(), 0);
    assert.equal(buffer.release(), 0);
    assert.equal(buffer.addRef(), 1);
    assert.equal(buffer.release(), 0);
    createBuffer(f, { flags: DSBCAPS_PRIMARYBUFFER });
    assert.equal(f.dsound.buffers().filter(b=>b.primary).length, 1);
    assert.equal(f.dsound.buffers().find(b=>b.primary).references, 1);
});

test('a primary buffer is dropped once nothing can reach it, and not before', ()=>{
    // Its device holds it: a count of zero is not the end of it while the
    // device lives. Once both are gone it leaves the walk, or every object a
    // program creates leaves a buffer behind for the rest of the session.
    const f = createRoot();
    const device = f.bridge.recordAt(f.root).object;
    const primary = f.bridge.recordAt(createBuffer(f, { flags: DSBCAPS_PRIMARYBUFFER })).object;
    const primaries = ()=>f.dsound.buffers().filter(b=>b.primary).length;

    assert.equal(primary.release(), 0);
    f.dsound.pruneReleased();
    assert.equal(primaries(), 1, 'its device still has it');
    assert.equal(device.release(), 0);
    f.dsound.pruneReleased();
    assert.equal(primaries(), 0);

    // The other order: the program still holds the primary when the device goes.
    const other = 0x1004;
    f.dsound.libraries['DSOUND.dll'].DirectSoundCreate.handler([0, other, 0]);
    const second = { ...f, root: f.memory.u32(other) };
    const held = f.bridge.recordAt(createBuffer(second, { flags: DSBCAPS_PRIMARYBUFFER })).object;
    assert.equal(f.bridge.recordAt(second.root).object.release(), 0);
    f.dsound.pruneReleased();
    assert.equal(primaries(), 1, 'the program still holds it');
    assert.equal(held.release(), 0);
    f.dsound.pruneReleased();
    assert.equal(primaries(), 0);
});

test('two DirectSound objects have primary buffers of their own', ()=>{
    // Wine's dsound test_primary_independent.
    const f = createRoot();
    const first = createBuffer(f, { flags: DSBCAPS_PRIMARYBUFFER });
    const other = 0x1004;
    f.dsound.libraries['DSOUND.dll'].DirectSoundCreate.handler([0, other, 0]);
    const second = createBuffer({ ...f, root: f.memory.u32(other) },
        { flags: DSBCAPS_PRIMARYBUFFER | DSBCAPS_CTRLVOLUME });
    assert.notEqual(second, first);
    assert.equal(f.bridge.call(second, 'GetVolume', [0x1c00]), DS_OK);
    assert.equal(f.bridge.call(first, 'GetVolume', [0x1c00]), DSERR_CONTROLUNAVAIL);
});

test('CreateSoundBuffer reads a description of either size and refuses any other', ()=>{
    // Wine's dsound test_primary: a dwSize one short of DSBUFFERDESC is
    // DSERR_INVALIDPARAM with a null pointer back. The DirectX 3 layout,
    // DSBUFFERDESC1, is the same without guid3DAlgorithm and is read the same.
    const f = createRoot();
    const out = 0x1800;
    const descriptor = describeBuffer(f.memory, { bytes: 4096 });
    for (const size of [0, DSBUFFERDESC.SIZE - 1, DSBUFFERDESC.SIZE_DX8 - 1,
        DSBUFFERDESC.SIZE_DX8 + 1])
    {
        f.memory.setU32(out, 0xdeadbeef);
        f.memory.setU32(descriptor + DSBUFFERDESC.dwSize, size);
        assert.equal(f.bridge.call(f.root, 'CreateSoundBuffer', [descriptor, out, 0]),
            DSERR_INVALIDPARAM, `dwSize ${size}`);
        assert.equal(f.memory.u32(out), 0, `dwSize ${size} writes a null back`);
    }
    assert.equal(f.dsound.buffers().length, 0);
    for (const size of [DSBUFFERDESC.SIZE, DSBUFFERDESC.SIZE_DX8])
    {
        f.memory.setU32(descriptor + DSBUFFERDESC.dwSize, size);
        assert.equal(f.bridge.call(f.root, 'CreateSoundBuffer', [descriptor, out, 0]), DS_OK,
            `dwSize ${size}`);
    }
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

test('DSBLOCK_ENTIREBUFFER locks a whole lap from the offset', ()=>{
    const f = createRoot();
    const buffer = createBuffer(f, { bytes: 4096 });
    const base = f.dsound.buffers()[0].address;
    const [p1, n1, p2, n2] = [0x1900, 0x1904, 0x1908, 0x190c];
    assert.equal(f.bridge.call(buffer, 'Lock',
        [3000, 8, p1, n1, p2, n2, DSBLOCK_ENTIREBUFFER]), DS_OK);
    assert.equal(f.memory.u32(p1), base + 3000);
    assert.equal(f.memory.u32(n1), 1096);
    assert.equal(f.memory.u32(p2), base);
    assert.equal(f.memory.u32(n2), 3000);
});

test('Lock refuses as Windows does, and says so in what it hands back', ()=>{
    // Wine's dsound.c test_lock.
    const f = createRoot();
    const buffer = createBuffer(f, { bytes: 4096 });
    const [p1, n1, p2, n2] = [0x1900, 0x1904, 0x1908, 0x190c];
    const fill = ()=>[p1, n1, p2, n2].forEach(at=>f.memory.setU32(at, 0xdeadbeef));
    for (const [offset, bytes] of [[100, 0], [4096, 0], [4096, 8], [0, 4097]])
    {
        fill();
        assert.equal(f.bridge.call(buffer, 'Lock', [offset, bytes, p1, n1, p2, n2, 0]),
            DSERR_INVALIDPARAM, `${offset}+${bytes}`);
        assert.deepEqual([p1, n1, p2, n2].map(at=>f.memory.u32(at)), [0, 0, 0, 0]);
    }
    fill();
    assert.equal(f.bridge.call(buffer, 'Lock', [0, 64, 0, n1, p2, n2, 0]), DSERR_INVALIDPARAM);
    assert.deepEqual([n1, p2, n2].map(at=>f.memory.u32(at)), [0xdeadbeef, 0xdeadbeef, 0xdeadbeef],
        'no pointer for the first range: nothing is written');
    assert.equal(f.bridge.call(buffer, 'Lock', [0, 64, p1, 0, p2, n2, 0]), DSERR_INVALIDPARAM);
    assert.equal(f.memory.u32(p1), 0, 'a pointer with no size beside it comes back null');
    assert.equal(f.memory.u32(p2), 0xdeadbeef);
    // A wrapping lock takes either half of the second range alone.
    assert.equal(f.bridge.call(buffer, 'Lock', [3000, 4096, p1, n1, 0, n2, 0]), DS_OK);
    assert.equal(f.memory.u32(n2), 3000);
    assert.equal(f.bridge.call(buffer, 'Lock', [0, 8, p1, n1, p2, n2, 0]), DSERR_INVALIDPARAM,
        'over a range still held');
});

test('Unlock lets go of the ranges it is handed back, by pointer, and of nothing twice', ()=>{
    const f = createRoot();
    const buffer = createBuffer(f, { bytes: 4096 });
    const base = f.dsound.buffers()[0].address;
    f.bridge.call(buffer, 'Lock', [0, 64, 0x1900, 0x1904, 0x1908, 0x190c, 0]);
    assert.equal(f.bridge.call(buffer, 'Unlock', [base, 0, 0, 0]), DS_OK,
        'the size is not looked at');
    assert.equal(f.bridge.call(buffer, 'Unlock', [base, 64, 0, 0]), DSERR_INVALIDPARAM);
    f.bridge.call(buffer, 'Lock', [3000, 4096, 0x1900, 0x1904, 0x1908, 0x190c, 0]);
    assert.equal(f.bridge.call(buffer, 'Unlock', [base + 3000, 4096, 0, 0]), DS_OK);
    assert.equal(f.bridge.call(buffer, 'Unlock', [base, 0xdeadbeef, 0, 0]), DS_OK,
        'the second range on its own');
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
    assert.equal(f.memory.u32(caps + DSBCAPS.dwFlags), DSBCAPS_LOCSOFTWARE,
        'asked for nothing, it is mixed in software and says so');
});

test('a deferred buffer is placed in software once acquired; the primary takes no effects', ()=>{
    // Wine's dsound8.c test_AcquireResources and test_primary_flags.
    const f = createRoot();
    const DSBCAPS_LOCDEFER = 0x40000;
    const pointer = createBuffer(f, { flags: DSBCAPS_LOCDEFER });
    const status = 0x1f00;
    f.bridge.call(pointer, 'GetStatus', [status]);
    assert.equal(f.memory.u32(status), 0);
    assert.equal(f.bridge.call(pointer, 'AcquireResources', [0, 0, 0]), DS_OK);
    f.bridge.call(pointer, 'GetStatus', [status]);
    assert.equal(f.memory.u32(status), 0x10, 'DSBSTATUS_LOCSOFTWARE');
    const descriptor = describeBuffer(f.memory, { flags: DSBCAPS_PRIMARYBUFFER | 0x200, bytes: 0 });
    assert.equal(f.bridge.call(f.root, 'CreateSoundBuffer', [descriptor, 0x1800, 0]),
        DSERR_INVALIDPARAM, 'DSBCAPS_CTRLFX on the primary');
});

test('GetCaps reports the flags a buffer was created with, and where it is mixed', ()=>{
    const f = createRoot();
    const caps = 0x1a00;
    f.memory.setU32(caps + DSBCAPS.dwSize, DSBCAPS.SIZE);
    /** @param {number} buffer */
    const flagsOf = buffer=>{
        assert.equal(f.bridge.call(buffer, 'GetCaps', [caps]), DS_OK);
        return f.memory.u32(caps + DSBCAPS.dwFlags);
    };

    // A program branches on these -- Wine's ds3d test calls SetVolume only when
    // CTRLVOLUME comes back -- so an answer of nothing says it may not.
    const controls = DSBCAPS_CTRLVOLUME | DSBCAPS_CTRLPAN | DSBCAPS_CTRLFREQUENCY
        | DSBCAPS_CTRLPOSITIONNOTIFY | DSBCAPS_GETCURRENTPOSITION2;
    const plain = createBuffer(f, { flags: controls });
    assert.equal(flagsOf(plain), controls | DSBCAPS_LOCSOFTWARE);

    const soft = createBuffer(f, { flags: controls | DSBCAPS_LOCSOFTWARE });
    assert.equal(flagsOf(soft), controls | DSBCAPS_LOCSOFTWARE);

    // Accepted in hardware, so reported in hardware (Wine's dsound test of
    // hardware buffers checks exactly this bit), and never in both places.
    const hard = createBuffer(f, { flags: DSBCAPS_LOCHARDWARE | DSBCAPS_CTRLVOLUME });
    assert.equal(flagsOf(hard), DSBCAPS_LOCHARDWARE | DSBCAPS_CTRLVOLUME);

    const out = 0x1e00;
    assert.equal(f.bridge.call(f.root, 'DuplicateSoundBuffer', [plain, out, 0]), DS_OK);
    assert.equal(flagsOf(f.memory.u32(out)), controls | DSBCAPS_LOCSOFTWARE,
        'a duplicate has the capabilities of its original');

    const primary = createBuffer(f, { flags: DSBCAPS_PRIMARYBUFFER | DSBCAPS_CTRLVOLUME });
    assert.equal(flagsOf(primary) & (DSBCAPS_PRIMARYBUFFER | DSBCAPS_CTRLVOLUME),
        DSBCAPS_PRIMARYBUFFER | DSBCAPS_CTRLVOLUME);
});

test('SetFX is refused as a control the buffer was not created with', ()=>{
    // Wine's dsound8 test_effects: SetFX on a buffer without DSBCAPS_CTRLFX.
    const f = createRoot();
    const effects = 0x1c00;
    const results = 0x1c40;
    const plain = f.bridge.query(createBuffer(f), IID_IDirectSoundBuffer8);
    assert.equal(f.bridge.call(plain, 'SetFX', [1, effects, results]), DSERR_CONTROLUNAVAIL);

    // With the control, the arguments are checked as the same test checks them,
    // and a buffer that is playing refuses a change to its effects.
    const fx = f.bridge.query(createBuffer(f, { flags: DSBCAPS_CTRLFX }), IID_IDirectSoundBuffer8);
    assert.equal(f.bridge.call(fx, 'SetFX', [1, 0, 0]), DSERR_INVALIDPARAM);
    assert.equal(f.bridge.call(fx, 'SetFX', [0, effects, 0]), DSERR_INVALIDPARAM);
    assert.equal(f.bridge.call(fx, 'SetFX', [0, 0, results]), DSERR_INVALIDPARAM);
    assert.equal(f.bridge.call(fx, 'SetFX', [0, 0, 0]), DS_OK,
        'clearing the effects of a buffer that has none is done');
    f.bridge.call(fx, 'Play', [0, 0, DSBPLAY_LOOPING]);
    assert.equal(f.bridge.call(fx, 'SetFX', [0, 0, 0]), DSERR_INVALIDCALL);
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

test('GetFormat hands back the structure the program gave', ()=>{
    const f = createRoot();
    const buffer = createBuffer(f, { channels: 2, rate: 44100, bits: 16 });
    const out = 0x1b00;
    const written = 0x1bff;
    assert.equal(f.bridge.call(buffer, 'GetFormat',
        [out, WAVEFORMATEX.SIZE, written]), DS_OK);
    assert.equal(f.memory.u32(out + WAVEFORMATEX.nSamplesPerSec), 44100);
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
    const buffer = createBuffer(f, {
        rate: 22050, flags: DSBCAPS_CTRLVOLUME | DSBCAPS_CTRLPAN | DSBCAPS_CTRLFREQUENCY,
    });
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

test('a control the buffer was not created with is refused, and changes nothing', ()=>{
    // Wine's ds3d test_buffer: GetVolume without DSBCAPS_CTRLVOLUME and GetPan
    // without CTRLPAN answer DSERR_CONTROLUNAVAIL; a frequency without
    // CTRLFREQUENCY likewise.
    const f = createRoot();
    const out = 0x1c00;
    const controls = /** @type {[number, string, string, number][]} */ ([
        [DSBCAPS_CTRLVOLUME, 'SetVolume', 'GetVolume', -1200],
        [DSBCAPS_CTRLPAN, 'SetPan', 'GetPan', 2500],
        [DSBCAPS_CTRLFREQUENCY, 'SetFrequency', 'GetFrequency', 11025],
    ]);
    for (const [flag, set, get, value] of controls)
    {
        // Every control but this one: each is its own.
        const others = controls.reduce((all, [bit])=>all | bit, 0) & ~flag;
        const without = createBuffer(f, { flags: others | DSBCAPS_GETCURRENTPOSITION2 });
        assert.equal(f.bridge.call(without, set, [value]), DSERR_CONTROLUNAVAIL, set);
        assert.equal(f.bridge.call(without, get, [out]), DSERR_CONTROLUNAVAIL, get);

        const withIt = createBuffer(f, { flags: flag });
        assert.equal(f.bridge.call(withIt, set, [value]), DS_OK, set);
        assert.equal(f.bridge.call(withIt, get, [out]), DS_OK, get);
        assert.equal(f.memory.u32(out) | 0, value);
    }
    const [plain] = f.dsound.buffers();
    assert.equal(plain.gain, 1, 'a refused SetVolume is not heard');
});

test('the primary buffer has volume and pan if asked for, and never a frequency', ()=>{
    // Wine's ds3d test_buffer on the primary: GetFrequency answers
    // DSERR_CONTROLUNAVAIL whatever it was created with, GetVolume and GetPan
    // succeed on one created with CTRLVOLUME and CTRLPAN; a null is still a
    // null first.
    const f = createRoot();
    const primary = createBuffer(f, { flags: DSBCAPS_PRIMARYBUFFER | DSBCAPS_CTRLVOLUME
        | DSBCAPS_CTRLPAN | DSBCAPS_CTRLFREQUENCY });
    const out = 0x1c00;
    assert.equal(f.bridge.call(primary, 'GetVolume', [out]), DS_OK);
    assert.equal(f.bridge.call(primary, 'SetPan', [-500]), DS_OK);
    assert.equal(f.bridge.call(primary, 'GetFrequency', [0]), DSERR_INVALIDPARAM);
    assert.equal(f.bridge.call(primary, 'GetFrequency', [out]), DSERR_CONTROLUNAVAIL);
    assert.equal(f.bridge.call(primary, 'SetFrequency', [22050]), DSERR_CONTROLUNAVAIL);
});

test('the getters refuse a null rather than writing to address zero', ()=>{
    const f = createRoot();
    const buffer = createBuffer(f);
    for (const name of ['GetVolume', 'GetPan', 'GetFrequency'])
    {
        assert.equal(f.bridge.call(buffer, name, [0]), DSERR_INVALIDPARAM, name);
    }
});

test('IDirectSoundNotify is there only on a buffer created to notify', ()=>{
    // Wine's dsound test_notifications: without DSBCAPS_CTRLPOSITIONNOTIFY the
    // interface is E_NOINTERFACE, with it DS_OK -- a program that asks is
    // finding out which kind of buffer it holds.
    const f = createRoot();
    const plain = createBuffer(f, { flags: DSBCAPS_GETCURRENTPOSITION2 });
    assert.equal(f.bridge.recordAt(plain).object.interfaceFor(IID_IDirectSoundNotify), null);
    assert.equal(notifyOn(f, plain), 0);

    const notifying = createBuffer(f, { flags: DSBCAPS_CTRLPOSITIONNOTIFY });
    assert.notEqual(notifyOn(f, notifying), 0);

    const out = 0x1e00;
    assert.equal(f.bridge.call(f.root, 'DuplicateSoundBuffer', [plain, out, 0]), DS_OK);
    assert.equal(notifyOn(f, f.memory.u32(out)), 0, 'a duplicate has what its original has');
});

test('a buffer\'s notify interface counts its references on its own', ()=>{
    // Wine's dsound.c test_notify: the notify interface is released to zero
    // while the buffer is still held, and holds the buffer until it is.
    const f = createRoot();
    const pointer = createBuffer(f, { flags: DSBCAPS_CTRLPOSITIONNOTIFY });
    const adapter = f.bridge.recordAt(pointer).object;
    assert.notEqual(notifyOn(f, pointer), 0);
    // What QueryInterface adds, which the fixture's query leaves out.
    assert.equal(adapter.addRef(IID_IDirectSoundNotify), 1);
    assert.equal(adapter.addRef(IID_IDirectSoundNotify), 2);
    assert.equal(adapter.addRef(IID_IDirectSoundBuffer), 2, 'the buffer\'s own count');
    assert.equal(adapter.release(IID_IDirectSoundBuffer), 1);
    assert.equal(adapter.release(IID_IDirectSoundBuffer), 0);
    assert.equal(f.dsound.buffers()[0].destroyed, false, 'the notify interface holds it');
    assert.equal(adapter.release(IID_IDirectSoundNotify), 1);
    assert.equal(adapter.release(IID_IDirectSoundNotify), 0);
    assert.equal(f.dsound.buffers()[0].destroyed, true);
});

test('SetCurrentPosition past the end of the buffer is refused and moves nothing', ()=>{
    const f = createRoot();
    const pointer = createBuffer(f, { bytes: 4096 });
    assert.equal(f.bridge.call(pointer, 'SetCurrentPosition', [4096]), DSERR_INVALIDPARAM);
    assert.equal(f.bridge.call(pointer, 'SetCurrentPosition', [4000]), DS_OK);
});

test('DirectSoundCreate names the playback device and refuses a capture one', ()=>{
    const f = createRoot();
    const guid = 0x2800;
    // DSDEVID_DefaultVoiceCapture, {DEF00003-9C6D-47ED-AAF1-4DDA8F2B5C03}.
    f.memory.writeMemory(guid, new Uint8Array([3, 0, 0xf0, 0xde, 0x6d, 0x9c, 0xed, 0x47,
        0xaa, 0xf1, 0x4d, 0xda, 0x8f, 0x2b, 0x5c, 0x03]));
    const create = f.dsound.libraries['DSOUND.dll'].DirectSoundCreate.handler;
    assert.equal(create([guid, 0x2900, 0]), 0x88780078 | 0);
    f.memory.bytes[guid] = 2; // DSDEVID_DefaultVoicePlayback
    assert.equal(create([guid, 0x2900, 0]), DS_OK);
    // GUID_NULL, which FMOD copies for the enumeration's primary driver.
    f.memory.writeMemory(guid, new Uint8Array(16));
    assert.equal(create([guid, 0x2900, 0]), DS_OK);
});

test('SetNotificationPositions reads an array of DSBPOSITIONNOTIFY', ()=>{
    const f = createRoot();
    const buffer = createBuffer(f, { bytes: 88200, flags: DSBCAPS_CTRLPOSITIONNOTIFY });
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
    const buffer = createBuffer(f, { flags: DSBCAPS_CTRLPOSITIONNOTIFY });
    assert.equal(f.bridge.call(notifyOn(f, buffer), 'SetNotificationPositions', [3, 0]),
        DSERR_INVALIDPARAM);
    assert.equal(f.bridge.call(notifyOn(f, buffer), 'SetNotificationPositions', [0, 0]), DS_OK,
        'clearing them needs no array');
});

test('a notification the cursor passed is signalled when the buffer is next read', ()=>{
    const f = createRoot();
    const buffer = createBuffer(f, { bytes: 88200, flags: DSBCAPS_CTRLPOSITIONNOTIFY });
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

test('Stop signals DSBPN_OFFSETSTOP in the call, and only the stopped buffer\'s', ()=>{
    // Wine's dsound test_duplicate/test_notify: Play, Stop, GetStatus reads 0,
    // and the event is already set -- the duplicate's own, not the original's.
    const f = createRoot();
    const original = createBuffer(f, { bytes: 4410, flags: DSBCAPS_CTRLPOSITIONNOTIFY });
    const array = 0x1d00;
    f.memory.setU32(array + DSBPOSITIONNOTIFY.dwOffset, 0xffffffff);
    f.memory.setU32(array + DSBPOSITIONNOTIFY.hEventNotify, 0x70);
    f.bridge.call(notifyOn(f, original), 'SetNotificationPositions', [1, array]);

    const out = 0x1e00;
    assert.equal(f.bridge.call(f.root, 'DuplicateSoundBuffer', [original, out, 0]), DS_OK);
    const copy = f.memory.u32(out);
    f.memory.setU32(array + DSBPOSITIONNOTIFY.hEventNotify, 0x71);
    f.bridge.call(notifyOn(f, copy), 'SetNotificationPositions', [1, array]);

    const status = 0x1f00;
    f.bridge.call(copy, 'SetCurrentPosition', [0]);
    f.bridge.call(copy, 'Play', [0, 0, 0]);
    f.bridge.call(copy, 'GetStatus', [status]);
    assert.equal(f.memory.u32(status), DSBSTATUS_PLAYING);
    f.bridge.call(copy, 'Stop');
    f.bridge.call(copy, 'GetStatus', [status]);
    assert.equal(f.memory.u32(status), 0);
    assert.deepEqual(f.signalled, [0x71]);

    f.bridge.call(original, 'Play', [0, 0, DSBPLAY_LOOPING]);
    f.time.advance(300);
    f.bridge.call(original, 'GetCurrentPosition', [0x1900, 0x1904]);
    assert.deepEqual(f.signalled, [0x71], 'a loop going round is not a stop');
    f.bridge.call(original, 'Stop');
    assert.deepEqual(f.signalled, [0x71, 0x70]);
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

test('the library\'s entry points keep the ordinals Windows gives them', ()=>{
    // dsound.spec: a program that imports by number binds to these, and a
    // table numbered in its own declaration order gives it another function
    // with another argument count -- DirectSoundCreate8 where it compiled
    // against DirectSoundEnumerateA.
    const f = fixture();
    /** @type {Record<string, unknown>} */
    const table = f.dsound.libraries['DSOUND.dll'];
    const pinned = f.dsound.ordinals['DSOUND.dll'];
    assert.deepEqual(pinned, {
        1: 'DirectSoundCreate', 2: 'DirectSoundEnumerateA', 3: 'DirectSoundEnumerateW',
        6: 'DirectSoundCaptureCreate', 7: 'DirectSoundCaptureEnumerateA',
        8: 'DirectSoundCaptureEnumerateW', 9: 'GetDeviceID', 10: 'DirectSoundFullDuplexCreate',
        11: 'DirectSoundCreate8',
        12: 'DirectSoundCaptureCreate8',
    });
    for (const name of Object.values(pinned))
    {
        assert.ok(table[name], `${name} is an export, not a number bound to nothing`);
    }

    // Through the synthesiser, declared the way the assembling caller declares
    // them, and read back from the image's own export directory.
    const declared = new Map(Object.entries(pinned).map(([n, name])=>[name, Number(n)]));
    const module = synthesiseModule({
        name: 'DSOUND.dll',
        base: 0x10000000,
        exports: Object.keys(table).map((name, at)=>({
            name, ordinal: declared.get(name), target: 0x20000000 + at * 16,
        })),
    });
    for (const [ordinal, name] of Object.entries(pinned))
    {
        assert.equal(module.ordinalOf(name), Number(ordinal), name);
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

test('the primary buffer answers through its pointer after its last release', ()=>{
    // Wine's dsound test_primary: Release to zero, AddRef answers one, two
    // Releases answer zero, and QueryInterface still answers -- E_NOINTERFACE
    // for IDirectSoundNotify, not E_POINTER -- because the device keeps it.
    const g = guestMachine();
    g.dsound.libraries['DSOUND.dll'].DirectSoundCreate.handler([0, 0x1000, 0]);
    const device = g.memory.u32(0x1000);
    const descriptor = describeBuffer(g.memory, { flags: DSBCAPS_PRIMARYBUFFER });
    assert.equal(g.call(device, slotOf(IDIRECTSOUND_SLOTS, 'CreateSoundBuffer'),
        [descriptor, 0x1100, 0]), DS_OK);
    const primary = g.memory.u32(0x1100);
    const [ADDREF, RELEASE] = [1, 2];
    assert.equal(g.call(primary, RELEASE), 0);
    assert.equal(g.call(primary, ADDREF), 1);
    assert.equal(g.call(primary, RELEASE), 0);
    assert.equal(g.call(primary, RELEASE), 0);
    const iid = 0x1200;
    g.memory.writeMemory(iid, new Uint8Array([
        0x83, 0x07, 0x21, 0xb0, 0xcd, 0x89, 0xd0, 0x11,
        0xaf, 0x08, 0x00, 0xa0, 0xc9, 0x25, 0xcd, 0x16,
    ]));
    assert.equal(g.call(primary, 0, [iid, 0x1300]) >>> 0, 0x80004002, 'E_NOINTERFACE');

    // Asked for again, it is the same buffer behind the same pointer.
    assert.equal(g.call(device, slotOf(IDIRECTSOUND_SLOTS, 'CreateSoundBuffer'),
        [descriptor, 0x1100, 0]), DS_OK);
    assert.equal(g.memory.u32(0x1100), primary);
    assert.equal(g.call(primary, RELEASE), 0);

    // Once its device is gone as well, the pointer is let go.
    assert.equal(g.call(device, RELEASE), 0);
    assert.equal(g.call(primary, ADDREF) >>> 0, 0x80004003, 'E_POINTER');
});

/** IID_IUnknown, as a program lays it out for QueryInterface. */
const IUNKNOWN_BYTES = new Uint8Array([
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0xc0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46,
]);

test('a buffer whose last reference goes is gone through every interface it was asked for', ()=>{
    // Released first through the pointer CreateSoundBuffer answered, then
    // through the IUnknown asked for later: neither may reach it after.
    const g = guestMachine();
    g.dsound.libraries['DSOUND.dll'].DirectSoundCreate.handler([0, 0x1000, 0]);
    const device = g.memory.u32(0x1000);
    assert.equal(g.call(device, slotOf(IDIRECTSOUND_SLOTS, 'CreateSoundBuffer'),
        [describeBuffer(g.memory, { bytes: 4096 }), 0x1100, 0]), DS_OK);
    const buffer = g.memory.u32(0x1100);
    g.memory.writeMemory(0x1200, IUNKNOWN_BYTES);
    assert.equal(g.call(buffer, 0, [0x1200, 0x1300]), DS_OK);
    const unknown = g.memory.u32(0x1300);
    const [ADDREF, RELEASE] = [1, 2];

    assert.equal(g.call(buffer, RELEASE), 1);
    assert.equal(g.call(unknown, RELEASE), 0);
    assert.equal(g.call(buffer, ADDREF) >>> 0, 0x80004003, 'E_POINTER');
    assert.equal(g.call(unknown, ADDREF) >>> 0, 0x80004003);
});

test('the primary buffer keeps every pointer it was asked for while its device lives', ()=>{
    const g = guestMachine();
    g.dsound.libraries['DSOUND.dll'].DirectSoundCreate.handler([0, 0x1000, 0]);
    const device = g.memory.u32(0x1000);
    assert.equal(g.call(device, slotOf(IDIRECTSOUND_SLOTS, 'CreateSoundBuffer'),
        [describeBuffer(g.memory, { flags: DSBCAPS_PRIMARYBUFFER }), 0x1100, 0]), DS_OK);
    const primary = g.memory.u32(0x1100);
    g.memory.writeMemory(0x1200, IUNKNOWN_BYTES);
    assert.equal(g.call(primary, 0, [0x1200, 0x1300]), DS_OK);
    const unknown = g.memory.u32(0x1300);
    const [ADDREF, RELEASE] = [1, 2];

    assert.equal(g.call(primary, RELEASE), 1);
    assert.equal(g.call(unknown, RELEASE), 0);
    assert.equal(g.call(unknown, ADDREF), 1, 'the device keeps it');
    assert.equal(g.call(unknown, RELEASE), 0);

    assert.equal(g.call(device, RELEASE), 0);
    assert.equal(g.call(primary, ADDREF) >>> 0, 0x80004003, 'and then neither pointer is kept');
    assert.equal(g.call(unknown, ADDREF) >>> 0, 0x80004003);
});

test('a pointer the bridge let go of names no buffer any more, and a kept one still does', ()=>{
    // DuplicateSoundBuffer and SetNotificationPositions take pointers back:
    // one whose words went back to the heap must not find the released
    // buffer, while a primary buffer its device keeps is still that buffer.
    const g = guestMachine();
    g.dsound.libraries['DSOUND.dll'].DirectSoundCreate.handler([0, 0x1000, 0]);
    const device = g.memory.u32(0x1000);
    assert.equal(g.call(device, slotOf(IDIRECTSOUND_SLOTS, 'CreateSoundBuffer'),
        [describeBuffer(g.memory, { bytes: 4096 }), 0x1100, 0]), DS_OK);
    const buffer = g.memory.u32(0x1100);
    assert.equal(g.call(device, slotOf(IDIRECTSOUND_SLOTS, 'CreateSoundBuffer'),
        [describeBuffer(g.memory, { flags: DSBCAPS_PRIMARYBUFFER }), 0x1100, 0]), DS_OK);
    const primary = g.memory.u32(0x1100);
    const { publisher } = g.dsound;
    const RELEASE = 2;

    assert.equal(g.call(buffer, RELEASE), 0);
    assert.equal(publisher.objectAt(buffer), null);
    assert.equal(g.call(primary, RELEASE), 0);
    assert.notEqual(publisher.objectAt(primary), null, 'the device keeps its primary');
    assert.equal(g.call(device, RELEASE), 0);
    assert.equal(publisher.objectAt(primary), null);
    assert.equal(publisher.objectAt(device), null);
});

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
    f.memory.setU16(wanted + WAVEFORMATEX.nBlockAlign, 4);
    f.memory.setU32(wanted + WAVEFORMATEX.nAvgBytesPerSec, 44100 * 4);

    assert.equal(f.bridge.call(primary, 'SetFormat', [wanted]), DS_OK);

    const read = 0x2500;
    assert.equal(f.bridge.call(primary, 'GetFormat', [read, WAVEFORMATEX.SIZE, 0]), DS_OK);
    assert.equal(f.memory.u32(read + WAVEFORMATEX.nSamplesPerSec), 44100,
        'and reports back what it was given');
});

test('a format is checked as DirectSound checks it, and handed back as it was given', ()=>{
    // Wine's dsound.c perform_invalid_fmt_tests.
    const f = createRoot();
    const create = (/** @type {(at: number) => void} */ spoil)=>{
        const descriptor = describeBuffer(f.memory, { channels: 2, rate: 44100, bits: 16 });
        spoil(0x2000);
        return f.bridge.call(f.root, 'CreateSoundBuffer', [descriptor, 0x1800, 0]);
    };
    for (const [field, value] of /** @type {[keyof typeof WAVEFORMATEX, number][]} */ ([
        ['nChannels', 0], ['wBitsPerSample', 12], ['nSamplesPerSec', 0],
        ['nBlockAlign', 3], ['nBlockAlign', 5]]))
    {
        assert.equal(create(at=>f.memory.setU16(at + WAVEFORMATEX[field], value)),
            DSERR_INVALIDPARAM, `${field}=${value}`);
    }
    assert.equal(create(at=>f.memory.setU32(at + WAVEFORMATEX.nAvgBytesPerSec, 0)),
        DSERR_INVALIDPARAM);
    // More than stereo is said with WAVEFORMATEXTENSIBLE, not plain PCM.
    assert.equal(create(at=>{
        f.memory.setU16(at + WAVEFORMATEX.nChannels, 4);
        f.memory.setU16(at + WAVEFORMATEX.nBlockAlign, 8);
    }), DSERR_INVALIDPARAM);
    // A byte rate that disagrees with the rest is kept as given.
    assert.equal(create(at=>f.memory.setU32(at + WAVEFORMATEX.nAvgBytesPerSec, 44100 * 4 + 1)),
        DS_OK);
    const buffer = f.memory.u32(0x1800);
    assert.equal(f.bridge.call(buffer, 'GetFormat', [0x2600, WAVEFORMATEX.SIZE, 0]), DS_OK);
    assert.equal(f.memory.u32(0x2600 + WAVEFORMATEX.nAvgBytesPerSec), 44100 * 4 + 1);
    // A tag DirectSound takes on trust comes back as itself.
    assert.equal(create(at=>f.memory.setU16(at + WAVEFORMATEX.wFormatTag, 6)), DS_OK); // A-law
    assert.equal(f.bridge.call(f.memory.u32(0x1800), 'GetFormat',
        [0x2600, WAVEFORMATEX.SIZE, 0]), DS_OK);
    assert.equal(f.memory.bytes[0x2600 + WAVEFORMATEX.wFormatTag], 6);
});

test('the primary buffer answers more than stereo in plain PCM as a mix it will not take', ()=>{
    const f = createRoot();
    const primary = createBuffer(f, { flags: DSBCAPS_PRIMARYBUFFER, bytes: 0 });
    const wanted = 0x2400;
    f.memory.setU16(wanted + WAVEFORMATEX.wFormatTag, 1);
    f.memory.setU16(wanted + WAVEFORMATEX.nChannels, 6);
    f.memory.setU32(wanted + WAVEFORMATEX.nSamplesPerSec, 44100);
    f.memory.setU16(wanted + WAVEFORMATEX.wBitsPerSample, 16);
    f.memory.setU16(wanted + WAVEFORMATEX.nBlockAlign, 12);
    f.memory.setU32(wanted + WAVEFORMATEX.nAvgBytesPerSec, 44100 * 12);
    assert.equal(f.bridge.call(primary, 'SetFormat', [wanted]), 0x8878000a | 0);
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

test('GetDeviceID answers the device a default names, and a device as itself', async()=>{
    // dsound.h's DSDEVID_Default{Playback,Capture,VoicePlayback,VoiceCapture}
    // are aliases for whichever device is the default; this machine has one
    // playback device, the one DirectSoundEnumerate describes after the
    // primary driver, and no capture device at all.
    const f = withGuest([1, 1]);
    await f.dsound.libraries['DSOUND.dll'].DirectSoundEnumerateA.handler([0x9000, 0]);
    const enumerated = [...f.memory.bytes.subarray(f.calls[1].args[0], f.calls[1].args[0] + 16)];
    const getDeviceID = f.dsound.libraries['DSOUND.dll'].GetDeviceID;
    assert.equal(getDeviceID.argBytes, 8);

    const source = 0x3000;
    const dest = 0x3100;
    /** @param {number[]} bytes */
    const ask = bytes=>{
        f.memory.writeMemory(source, new Uint8Array(bytes));
        f.memory.bytes.fill(0xcc, dest, dest + 16);
        return getDeviceID.handler([source, dest]);
    };
    const answered = ()=>[...f.memory.bytes.subarray(dest, dest + 16)];
    /** @param {number} which  DEF0000n: Playback, Capture, VoicePlayback, VoiceCapture */
    const alias = which=>[which, 0x00, 0xf0, 0xde, 0x6d, 0x9c, 0xed, 0x47,
        0xaa, 0xf1, 0x4d, 0xda, 0x8f, 0x2b, 0x5c, 0x03];
    for (const which of [0, 2])
    {
        assert.equal(ask(alias(which)), DS_OK, `DSDEVID playback default ${which}`);
        assert.deepEqual(answered(), enumerated);
    }
    // As Wine's dsound test expects DirectSoundCreate to answer for a capture
    // default: the default names a device that is not there.
    for (const which of [1, 3])
    {
        assert.equal(ask(alias(which)), DSERR_NODRIVER, `DSDEVID capture default ${which}`);
        assert.ok(answered().every(byte=>byte === 0xcc), 'and nothing is written');
    }
    assert.equal(ask(enumerated), DS_OK, 'a device is its own id');
    assert.deepEqual(answered(), enumerated);

    // Anything else is no device: GUID_NULL, a default with one byte off.
    for (const other of [new Array(16).fill(0), alias(4)])
    {
        assert.equal(ask(other), DSERR_INVALIDPARAM);
        assert.ok(answered().every(byte=>byte === 0xcc), 'and nothing is written');
    }
    assert.equal(getDeviceID.handler([0, dest]), DSERR_INVALIDPARAM);
    assert.equal(getDeviceID.handler([source, 0]), DSERR_INVALIDPARAM);
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

test('the primary buffer is the listener, and a DSBCAPS_CTRL3D buffer has a place in space', ()=>{
    const f = createRoot();
    const primary = createBuffer(f, { flags: DSBCAPS_PRIMARYBUFFER, bytes: 0 });
    assert.ok(f.bridge.recordAt(primary).object.interfaceFor(IID_IDirectSound3DListener));
    const placed = createBuffer(f, { flags: 0x10, channels: 1 });
    assert.ok(f.bridge.recordAt(placed).object.interfaceFor(IID_IDirectSound3DBuffer));
});

test('what a program asked the device for is kept whole: buffers and refused interfaces', ()=>{
    // The event ring is short and turns over in seconds of mixing; what a
    // sound library asked for while starting up is the record that says why
    // it chose the path it did, so it is kept apart and never dropped.
    const f = createRoot();
    const buffer = createBuffer(f, { bytes: 4096 });
    assert.equal(f.bridge.recordAt(buffer).object.interfaceFor(IID_IDirectSound3DBuffer), null,
        'a buffer created without DSBCAPS_CTRL3D has no place in space');
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

test('every buffer has IKsPropertySet, which has no property set to offer', ()=>{
    // Wine's dsound ds3d test asks the primary buffer for it; a program asking
    // after EAX through it is told the device has none.
    const f = createRoot();
    const buffer = createBuffer(f, { flags: DSBCAPS_GETCURRENTPOSITION2 });
    const adapter = f.bridge.recordAt(buffer).object;
    const record = adapter.interfaceFor(IID_IKsPropertySet);
    assert.ok(record);
    assert.deepEqual(record.methods.slice(3).map((/** @type {any} */ method)=>method.name),
        ['Get', 'Set', 'QuerySupport']);
    const support = 0x1f00;
    f.memory.writeMemory(support, Uint8Array.of(0xff, 0xff, 0xff, 0xff));
    const querySupport = record.methods[5].invoke;
    assert.equal(querySupport(adapter.api ?? adapter, [0x1f10, 0, support]) >>> 0, 0x80070490);
    assert.equal(f.memory.u32(support), 0, 'the caller\'s flags are cleared');
});

test('DllGetClassObject has no class but DirectSound\'s to hand out, and clears the pointer', ()=>{
    const f = createRoot();
    const out = 0x1f20;
    f.memory.writeMemory(out, Uint8Array.of(1, 2, 3, 4));
    assert.equal(f.dsound.libraries['DSOUND.dll'].DllGetClassObject.handler([0x1f30, 0x1f40, out])
        >>> 0, 0x80040111);
    assert.equal(f.memory.u32(out), 0);
});

test('DirectSound\'s class object makes objects that wait for Initialize', ()=>{
    // Wine's dsound IDirectSound_tests: CoGetClassObject, then CoCreateInstance
    // through the class object, then an object that answers DSERR_UNINITIALIZED
    // until Initialize, and DSERR_ALREADYINITIALIZED after.
    const g = guestMachine();
    const dll = g.dsound.libraries['DSOUND.dll'];
    const CLSID = 0x1e00;
    const IID = 0x1e20;
    const out = 0x1e40;
    writeGuid(g.memory, CLSID, '{47D4D946-62E8-11CF-93BC-444553540000}');
    writeGuid(g.memory, IID, '{00000001-0000-0000-C000-000000000046}');
    assert.equal(dll.DllGetClassObject.handler([CLSID, IID, out]), DS_OK);
    const factory = g.memory.u32(out);
    assert.notEqual(factory, 0);

    writeGuid(g.memory, IID, IID_IDirectSound);
    assert.equal(g.call(factory, 3, [0x5000, IID, out]) >>> 0, 0x80040110,
        'CLASS_E_NOAGGREGATION');
    assert.equal(g.call(factory, 3, [0, IID, out]), DS_OK, 'CreateInstance');
    const sound = g.memory.u32(out);
    const caps = 0x1f00;
    const DSERR_UNINITIALIZED = 0x887800aa;
    assert.equal(g.call(sound, slotOf(IDIRECTSOUND_SLOTS, 'GetCaps'), [caps]) >>> 0,
        DSERR_UNINITIALIZED);
    assert.equal(g.call(sound, slotOf(IDIRECTSOUND_SLOTS, 'Compact')) >>> 0,
        DSERR_UNINITIALIZED);
    assert.equal(g.call(sound, slotOf(IDIRECTSOUND_SLOTS, 'Initialize'), [0]), DS_OK);
    assert.equal(g.call(sound, slotOf(IDIRECTSOUND_SLOTS, 'Initialize'), [0]) >>> 0, 0x88780082,
        'DSERR_ALREADYINITIALIZED');
    g.memory.setU32(caps, 96);
    assert.equal(g.call(sound, slotOf(IDIRECTSOUND_SLOTS, 'GetCaps'), [caps]), DS_OK);
    assert.equal(g.call(sound, slotOf(IDIRECTSOUND_SLOTS, 'Initialize'), [0]) >>> 0, 0x88780082,
        'and one DirectSoundCreate made is named already');
});

test('capture and full duplex objects are made, and initializing one finds no driver', ()=>{
    // Wine's capture.c and duplex.c, on a machine with no capture device.
    const g = guestMachine();
    const dll = g.dsound.libraries['DSOUND.dll'];
    const CLSID = 0x1e00;
    const IID = 0x1e20;
    const out = 0x1e40;
    for (const [clsid, iid, initialize] of [
        ['{B0210780-89CD-11D0-AF08-00A0C925CD16}', '{B0210781-89CD-11D0-AF08-00A0C925CD16}',
            [0x1e60]],
        ['{FEA4300C-7959-4147-B26A-2377B9E7A91D}', '{EDCB4C7A-DAAB-4216-A42E-6C50596DDC1D}',
            [0, 0, 0, 0, 0, 0, 0x1f00, 0x1f04]],
    ])
    {
        writeGuid(g.memory, CLSID, /** @type {string} */ (clsid));
        writeGuid(g.memory, IID, '{00000001-0000-0000-C000-000000000046}');
        assert.equal(dll.DllGetClassObject.handler([CLSID, IID, out]), DS_OK);
        const factory = g.memory.u32(out);
        writeGuid(g.memory, IID, IID_IDirectSound);
        assert.equal(g.call(factory, 3, [0, IID, out]) >>> 0, 0x80004002, 'E_NOINTERFACE');
        writeGuid(g.memory, IID, /** @type {string} */ (iid));
        assert.equal(g.call(factory, 3, [0, IID, out]), DS_OK);
        const object = g.memory.u32(out);
        // Initialize is the last slot of either.
        const slot = String(clsid).startsWith('{B02') ? 5 : 3;
        assert.equal(g.call(object, slot, /** @type {number[]} */ (initialize)) >>> 0,
            0x88780078, 'DSERR_NODRIVER');
    }
    assert.equal(dll.DirectSoundFullDuplexCreate.handler([0, 0, 0, 0, 0, 0, out, 0, 0, 0]) >>> 0,
        0x88780078);
    assert.equal(g.memory.u32(out), 0);
});

test('there is no capture device, as Windows says of a machine without one', ()=>{
    const f = createRoot();
    const dll = f.dsound.libraries['DSOUND.dll'];
    const out = 0x1f20;
    f.memory.setU32(out, 0xdeadbeef);
    assert.equal(dll.DirectSoundCaptureCreate.handler([0, out, 0x5000]) >>> 0, 0x80040110,
        'an aggregation is refused first');
    assert.equal(f.memory.u32(out), 0xdeadbeef, 'with the pointer left alone');
    assert.equal(dll.DirectSoundCaptureCreate8.handler([0, out, 0]) >>> 0, 0x88780078,
        'DSERR_NODRIVER');
    assert.equal(f.memory.u32(out), 0);
    assert.equal(/** @type {any} */ (dll.DirectSoundCaptureEnumerateA).handler([0x7000, 0]),
        DS_OK);
});
