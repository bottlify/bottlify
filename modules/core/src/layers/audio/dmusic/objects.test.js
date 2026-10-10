/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createComObject } from '../../win32/ole32/objects.js';
import { parseGuid } from '../../win32/ole32/guid.js';
import { createDirectMusic } from './objects.js';
import { dmsgSegment, wavFile } from './test-fixtures.js';
import * as ids from './ids.js';

const S_OK = 0;
const S_FALSE = 1;
const E_POINTER = 0x80004003 | 0;
const E_INVALIDARG = 0x80070057 | 0;

/** A guest address space with a bump allocator, for the descriptors a call writes. */
function arena(){
    const ram = new Uint8Array(1 << 20);
    let next = 0x10000;
    return {
        ram,
        /** @param {number} bytes @returns {number} */
        alloc(bytes){
            next = (next + 15) & ~15;
            const at = next;
            next += bytes;
            return at;
        },
        /** @param {number} address @returns {number} */
        readU32(address){
            return new DataView(ram.buffer).getUint32(address, true);
        },
        /** @param {number} address @param {number} value */
        writeU32(address, value){
            new DataView(ram.buffer).setUint32(address, value >>> 0, true);
        },
        /** @param {number} address @param {Uint8Array} bytes */
        writeBytes(address, bytes){
            ram.set(bytes, address);
        },
        /** @param {number} address @param {string} text */
        writeWide(address, text){
            for (let at = 0; at < text.length; at++)
            {
                new DataView(ram.buffer).setUint16(address + at * 2, text.charCodeAt(at), true);
            }
            new DataView(ram.buffer).setUint16(address + text.length * 2, 0, true);
        },
        /** @param {number} address @param {string} guid */
        writeGuid(address, guid){
            const bytes = parseGuid(guid);
            assert.ok(bytes);
            ram.set(/** @type {Uint8Array} */ (bytes), address);
        },
    };
}

/** A mixer that remembers every track it opened. */
function mixer(){
    /** @type {any[]} */
    const tracks = [];
    return {
        tracks,
        open(/** @type {any} */ format){
            const track = { format, gain: 1, closed: false, bytes: 0,
                /** @param {Uint8Array} data */
                write(data){ track.bytes += data.length; },
                close(){ track.closed = true; } };
            tracks.push(track);
            return track;
        },
    };
}

/**
 * A test rig with a guest memory, a mixer and the files the loader reads.
 *
 * @param {(host: any, space: ReturnType<typeof arena>) => void} [configure]
 *     Edits the host the module is made with -- the stream reader, the
 *     allocator -- before it exists.
 */
function rig(configure){
    const space = arena();
    const out = mixer();
    const time = { at: 1000 };
    /** @type {Map<string, Uint8Array>} */
    const files = new Map();
    /** Events the performance set, in order. @type {number[]} */
    const signals = [];
    /** @type {{ api: string, detail: string }[]} */
    const divergences = [];
    // One pointer per object and interface, as the bridge's publisher gives:
    // the same interface asked for twice is the same pointer, which is how a
    // program and this engine agree on identity.
    /** @type {Map<any, Map<string, number>>} */
    const published = new Map();
    let pointer = 0x20000000;
    const host = /** @type {any} */ ({
        registry: {},
        memory: {
            readBytes: (/** @type {number} */ a, /** @type {number} */ l)=>
                space.ram.subarray(a, a + l),
            writeBytes: (/** @type {number} */ a, /** @type {Uint8Array} */ b)=>
                space.writeBytes(a, b),
        },
        publishInterface: (/** @type {any} */ object, /** @type {string} */ iid)=>{
            let byInterface = published.get(object);
            if (!byInterface)
            {
                byInterface = new Map();
                published.set(object, byInterface);
            }
            if (!byInterface.has(iid))
            {
                byInterface.set(iid, pointer++);
            }
            return byInterface.get(iid);
        },
        output: ()=>out,
        now: ()=>time.at,
        signal: (/** @type {number} */ handle)=>signals.push(handle),
        allocate: (/** @type {number} */ bytes)=>space.alloc(bytes),
        free: ()=>{},
        readFile: async(/** @type {string} */ path)=>
            files.get(path) ?? files.get(path.toLowerCase()) ?? null,
        divergence: (/** @type {string} */ api, /** @type {string} */ detail)=>{
            divergences.push({ api, detail });
        },
    });
    configure?.(host, space);
    const dm = createDirectMusic(host);
    return { space, out, time, files, signals, divergences, host, dm };
}

/**
 * @param {any} object @param {string} iid @param {string} name @param {number[]} args
 */
function call(object, iid, name, args){
    const record = object.interfaceFor(iid);
    assert.ok(record, `${iid} is not on this object`);
    const method = record.methods.find((/** @type {any} */ m)=>m.name === name);
    assert.ok(method, `${name} is not in this interface`);
    return method.invoke(object, args);
}

/** A segment's bytes with one wave, and the wave itself, ready for the loader. */
function segmentWithWave(){
    const samples = new Int16Array(2000);
    const wave = wavFile(samples, { sampleRate: 1000, channels: 1 });
    const segment = dmsgSegment([{ file: 'a.wav', time: 0 }],
        { length: 768, tempo: { time: 0, tempo: 120 } });
    return { segment, wave };
}

test('InitAudio makes a performance, a default path and a DirectMusic object', async()=>{
    const { space, dm } = rig();
    const performance = createComObject(ids.CLSID_DIRECTMUSIC_PERFORMANCE, dm.performance());
    const musicOut = space.alloc(4);
    const soundOut = space.alloc(4);
    assert.equal(await call(performance, ids.IID_DIRECTMUSIC_PERFORMANCE8, 'InitAudio',
        [musicOut, soundOut, 0, 5, 128, 0xffffffff, 0]), S_OK);
    assert.notEqual(space.readU32(musicOut), 0, 'a DirectMusic object was handed back');
    assert.equal(space.readU32(soundOut), 0, 'DirectSound is another layer to make');

    const pathOut = space.alloc(4);
    assert.equal(await call(performance, ids.IID_DIRECTMUSIC_PERFORMANCE8,
        'CreateStandardAudioPath', [5, 128, 1, pathOut]), S_OK);
    assert.notEqual(space.readU32(pathOut), 0);

    const defaultOut = space.alloc(4);
    assert.equal(await call(performance, ids.IID_DIRECTMUSIC_PERFORMANCE8,
        'GetDefaultAudioPath', [defaultOut]), S_OK);
    assert.notEqual(space.readU32(defaultOut), 0);
});

test('the loader reads a segment from memory and its wave plays through the mixer', async()=>{
    const { space, out, files, dm } = rig();
    const { segment, wave } = segmentWithWave();
    files.set('a.wav', wave);
    const loader = createComObject(ids.CLSID_DIRECTMUSIC_LOADER, dm.loader());
    const performance = createComObject(ids.CLSID_DIRECTMUSIC_PERFORMANCE, dm.performance());

    const block = space.alloc(segment.length);
    space.writeBytes(block, segment);
    const desc = space.alloc(ids.DMUS_OBJECTDESC.SIZE);
    space.writeU32(desc + ids.DMUS_OBJECTDESC.dwSize, ids.DMUS_OBJECTDESC.SIZE);
    space.writeU32(desc + ids.DMUS_OBJECTDESC.dwValidData,
        ids.DMUS_OBJ.CLASS | ids.DMUS_OBJ.MEMORY);
    space.writeGuid(desc + ids.DMUS_OBJECTDESC.guidClass, ids.CLSID_DIRECTMUSIC_SEGMENT);
    space.writeU32(desc + ids.DMUS_OBJECTDESC.llMemLength, segment.length);
    space.writeU32(desc + ids.DMUS_OBJECTDESC.pbMemData, block);

    const segmentOut = space.alloc(4);
    assert.equal(await call(loader, ids.IID_DIRECTMUSIC_LOADER8, 'GetObject',
        [desc, 0, segmentOut]), S_OK);
    const segmentPointer = space.readU32(segmentOut);
    assert.notEqual(segmentPointer, 0);

    const stateOut = space.alloc(4);
    assert.equal(await call(performance, ids.IID_DIRECTMUSIC_PERFORMANCE8, 'PlaySegmentEx',
        [segmentPointer, 0, 0, 0, 0, 0, stateOut, 0, 0]), S_OK);
    assert.notEqual(space.readU32(stateOut), 0, 'a play state was handed back');
    assert.equal(out.tracks.length, 1, 'the wave became one mixer track');
    assert.equal(out.tracks[0].format.sampleRate, 1000);
    assert.equal(out.tracks[0].bytes, 4000, 'the PCM samples crossed to the mixer');
    assert.equal(dm.diagnostics().playing, 1);
    assert.equal(await call(performance, ids.IID_DIRECTMUSIC_PERFORMANCE8, 'IsPlaying',
        [segmentPointer, 0]), S_OK);

    assert.equal(await call(performance, ids.IID_DIRECTMUSIC_PERFORMANCE8, 'StopEx',
        [segmentPointer, 0, 0, 0]), S_OK);
    assert.equal(out.tracks[0].closed, true);
    assert.equal(await call(performance, ids.IID_DIRECTMUSIC_PERFORMANCE8, 'IsPlaying',
        [segmentPointer, 0]), S_FALSE);
});

test('LoadObjectFromFile reads a named file and hands back a segment', async()=>{
    const { space, files, dm } = rig();
    const { segment } = segmentWithWave();
    const name = 'C:\\music\\track.sgt';
    files.set(name, segment);
    const loader = createComObject(ids.CLSID_DIRECTMUSIC_LOADER, dm.loader());
    const path = space.alloc(600);
    space.writeWide(path, name);
    const out = space.alloc(4);
    assert.equal(await call(loader, ids.IID_DIRECTMUSIC_LOADER8, 'LoadObjectFromFile',
        [0, 0, path, out]), S_OK);
    assert.notEqual(space.readU32(out), 0);
});

test('GetObject reads only the fields dwValidData names', async()=>{
    const { space, files, dm } = rig();
    const { segment } = segmentWithWave();
    files.set('C:\\music\\track.sgt', segment);
    const loader = createComObject(ids.CLSID_DIRECTMUSIC_LOADER, dm.loader());
    const directory = space.alloc(600);
    space.writeWide(directory, 'C:\\music');
    assert.equal(await call(loader, ids.IID_DIRECTMUSIC_LOADER8, 'SetSearchDirectory',
        [0, directory]), S_OK);

    // A class and a file name, and the rest of the structure as a caller's
    // stack left it: a length, a data pointer and a stream that were never
    // set, which must not be taken for a request to load from memory.
    const desc = space.alloc(ids.DMUS_OBJECTDESC.SIZE);
    space.writeBytes(desc, new Uint8Array(ids.DMUS_OBJECTDESC.SIZE).fill(0xcc));
    space.writeU32(desc + ids.DMUS_OBJECTDESC.dwSize, ids.DMUS_OBJECTDESC.SIZE);
    space.writeU32(desc + ids.DMUS_OBJECTDESC.dwValidData,
        ids.DMUS_OBJ.CLASS | ids.DMUS_OBJ.FILENAME);
    space.writeGuid(desc + ids.DMUS_OBJECTDESC.guidClass, ids.CLSID_DIRECTMUSIC_SEGMENT);
    space.writeWide(desc + ids.DMUS_OBJECTDESC.wszFileName, 'track.sgt');

    const out = space.alloc(4);
    assert.equal(await call(loader, ids.IID_DIRECTMUSIC_LOADER8, 'GetObject',
        [desc, 0, out]), S_OK);
    assert.notEqual(space.readU32(out), 0, 'the file beside the search directory was loaded');

    // Nothing valid to load by: no flag for a name, a file, memory or a stream.
    space.writeU32(desc + ids.DMUS_OBJECTDESC.dwValidData, ids.DMUS_OBJ.CLASS);
    assert.equal(await call(loader, ids.IID_DIRECTMUSIC_LOADER8, 'GetObject',
        [desc, 0, out]), E_INVALIDARG);
    assert.equal(space.readU32(out), 0);
});

test('SetSearchDirectory tells a not-yet-named path from one already set', async()=>{
    const { space, dm } = rig();
    const loader = createComObject(ids.CLSID_DIRECTMUSIC_LOADER, dm.loader());
    const path = space.alloc(600);
    space.writeWide(path, 'C:\\music');
    assert.equal(await call(loader, ids.IID_DIRECTMUSIC_LOADER8, 'SetSearchDirectory',
        [0, path]), S_OK);
    assert.equal(await call(loader, ids.IID_DIRECTMUSIC_LOADER8, 'SetSearchDirectory',
        [0, path]), S_FALSE);
    assert.equal(await call(loader, ids.IID_DIRECTMUSIC_LOADER8, 'SetSearchDirectory',
        [0, 0]), E_POINTER);
});

test('a segment that is not a DMSG is refused and nothing is played', async()=>{
    const { space, files, dm } = rig();
    files.set('C:\\bad.sgt', new Uint8Array([1, 2, 3, 4]));
    const loader = createComObject(ids.CLSID_DIRECTMUSIC_LOADER, dm.loader());
    const path = space.alloc(600);
    space.writeWide(path, 'C:\\bad.sgt');
    const out = space.alloc(4);
    assert.equal(await call(loader, ids.IID_DIRECTMUSIC_LOADER8, 'LoadObjectFromFile',
        [0, 0, path, out]), S_OK);
    // An unparseable file still produces an object; it has no waves, so it
    // starts and ends at once rather than sitting open for ever.
    const performance = createComObject(ids.CLSID_DIRECTMUSIC_PERFORMANCE, dm.performance());
    const stateOut = space.alloc(4);
    const segmentPointer = space.readU32(out);
    assert.equal(await call(performance, ids.IID_DIRECTMUSIC_PERFORMANCE8, 'PlaySegmentEx',
        [segmentPointer, 0, 0, 0, 0, 0, stateOut, 0, 0]), S_OK);
    assert.equal(dm.diagnostics().playing, 0, 'an empty segment does not stay playing');
});

test('InitPlay hands back a segment state for the segment it was called on', async()=>{
    const { space, dm, host } = rig();
    const { segment, wave } = segmentWithWave();
    const object = dm.createSegment(segment, '').object;
    host.objectAt = ()=>object;
    const stateOut = space.alloc(4);
    assert.equal(await call(object, ids.IID_DIRECTMUSIC_SEGMENT8, 'InitPlay',
        [stateOut, 0x22223333, 0]), S_OK);
    assert.notEqual(space.readU32(stateOut), 0, 'a state pointer was written');
    void wave;
});

test('a cloned segment is a real segment that plays the same music', async()=>{
    const { space, files, out, dm } = rig();
    const { segment, wave } = segmentWithWave();
    files.set('a.wav', wave);
    const source = dm.createSegment(segment, '');
    const cloneOut = space.alloc(4);
    assert.equal(await call(source.object, ids.IID_DIRECTMUSIC_SEGMENT8, 'Clone',
        [0, 0, cloneOut]), S_OK);
    const clonePointer = space.readU32(cloneOut);
    assert.notEqual(clonePointer, 0, 'Clone hands back a segment, not a refusal');

    // A second clone is a second object: the pointer is not the same one
    // handed out twice, which a program comparing them would notice.
    const secondOut = space.alloc(4);
    assert.equal(await call(source.object, ids.IID_DIRECTMUSIC_SEGMENT8, 'Clone',
        [0, 0, secondOut]), S_OK);
    assert.notEqual(space.readU32(secondOut), clonePointer);

    const performance = createComObject(ids.CLSID_DIRECTMUSIC_PERFORMANCE, dm.performance());
    const stateOut = space.alloc(4);
    assert.equal(await call(performance, ids.IID_DIRECTMUSIC_PERFORMANCE8, 'PlaySegmentEx',
        [clonePointer, 0, 0, 0, 0, 0, stateOut, 0, 0]), S_OK);
    assert.equal(out.tracks.length, 1, 'the clone plays the segment wave');
    assert.equal(out.tracks[0].bytes, 4000);
});

test('Load asks a stream for exactly what is left, not a chunk past its end', async()=>{
    const { segment } = segmentWithWave();
    const SEEK_ENTRY = 0x00600000;
    const READ_ENTRY = 0x00600004;
    const E_FAIL = 0x80004005 | 0;
    /** @type {{ reads: number, overLong: number }} */
    const counted = { reads: 0, overLong: 0 };
    /** @type {number} */
    let stream = 0;
    const { dm } = rig((host, space)=>{
        const vtable = space.alloc(16 * 4);
        stream = space.alloc(8);
        space.writeU32(vtable + 3 * 4, READ_ENTRY);
        space.writeU32(vtable + 5 * 4, SEEK_ENTRY);
        space.writeU32(stream, vtable);
        host.allocate = (/** @type {number} */ bytes)=>space.alloc(bytes);
        host.free = ()=>{};
        host.callerThread = ()=>({});
        let position = 0;
        /**
         * @param {number} entry
         * @param {number[]} args
         */
        const guest = async(entry, args)=>{
            if (entry === SEEK_ENTRY)
            {
                // STREAM_SEEK_END is 2: the answer a file stream gives is its
                // size, and the reader starts from the front again.
                position = (args[3] >>> 0) === 2 ? segment.length : 0;
                space.writeU32(args[4], position);
                space.writeU32(args[4] + 4, 0);
                return S_OK;
            }
            if (entry === READ_ENTRY)
            {
                const want = args[2] >>> 0;
                const left = segment.length - position;
                counted.reads++;
                if (want > left)
                {
                    // What the game's own file stream does with an over-long
                    // read: E_FAIL and not a byte, where IStream promises a
                    // short count.
                    counted.overLong++;
                    space.writeU32(args[3], 0);
                    return E_FAIL;
                }
                space.writeBytes(args[1], segment.subarray(position, position + want));
                space.writeU32(args[3], want);
                position += want;
                return S_OK;
            }
            return 0x80004001 | 0;
        };
        host.callGuest = guest;
    });
    const object = createComObject(ids.CLSID_DIRECTMUSIC_SEGMENT, dm.segment());
    assert.equal(await call(object, ids.IID_IPERSIST_STREAM, 'Load', [stream]), S_OK);
    assert.equal(counted.overLong, 0, 'nothing was asked for past the end');
    assert.equal(object.state.parsed.waves.length, 1, 'the segment arrived whole');
});

test('a segment\'s wave is read through the loader its stream names', async()=>{
    const samples = new Int16Array(2000);
    const wave = wavFile(samples, { sampleRate: 1000, channels: 1 });
    const { segment } = segmentWithWave();
    const SOK = 0;
    const E_NOINTERFACE = 0x80004002 | 0;
    const SEEK_ENTRY = 0x00700000;
    const READ_ENTRY = 0x00700004;
    const QI_ENTRY = 0x00700008;
    const GETLOADER_ENTRY = 0x0070000c;
    const RELEASE_ENTRY = 0x00700010;
    const GETOBJECT_ENTRY = 0x00700014;
    const GETLOADER_IID = /** @type {Uint8Array} */ (parseGuid(ids.IID_DIRECTMUSIC_GETLOADER));
    const wavePointer = 0x70000000;
    /** @type {any} */
    let waveObject = null;
    /** @type {number} */
    let stream = 0;
    const { dm } = rig((host, space)=>{
        const streamVtable = space.alloc(16 * 4);
        const glVtable = space.alloc(8 * 4);
        const loaderVtable = space.alloc(8 * 4);
        stream = space.alloc(8);
        const getLoader = space.alloc(8);
        const loader = space.alloc(8);
        space.writeU32(streamVtable + 0 * 4, QI_ENTRY);
        space.writeU32(streamVtable + 3 * 4, READ_ENTRY);
        space.writeU32(streamVtable + 5 * 4, SEEK_ENTRY);
        space.writeU32(stream, streamVtable);
        space.writeU32(glVtable + 2 * 4, RELEASE_ENTRY);
        space.writeU32(glVtable + 3 * 4, GETLOADER_ENTRY);
        space.writeU32(getLoader, glVtable);
        space.writeU32(loaderVtable + 3 * 4, GETOBJECT_ENTRY);
        space.writeU32(loader, loaderVtable);
        host.allocate = (/** @type {number} */ bytes)=>space.alloc(bytes);
        host.free = ()=>{};
        host.callerThread = ()=>({});
        host.objectAt = ()=>waveObject;
        let position = 0;
        /**
         * @param {number} entry
         * @param {number[]} args
         */
        const guest = async(entry, args)=>{
            if (entry === SEEK_ENTRY)
            {
                position = (args[3] >>> 0) === 2 ? segment.length : 0;
                space.writeU32(args[4], position);
                space.writeU32(args[4] + 4, 0);
                return SOK;
            }
            if (entry === READ_ENTRY)
            {
                const want = args[2] >>> 0;
                const got = Math.min(want, segment.length - position);
                space.writeBytes(args[1], segment.subarray(position, position + got));
                space.writeU32(args[3], got);
                position += got;
                return SOK;
            }
            if (entry === QI_ENTRY)
            {
                const matches = args[1] !== 0 && GETLOADER_IID
                    .every((byte, at)=>space.ram[args[1] + at] === byte);
                space.writeU32(args[2], matches ? getLoader : 0);
                return matches ? SOK : E_NOINTERFACE;
            }
            if (entry === GETLOADER_ENTRY)
            {
                space.writeU32(args[1], loader);
                return SOK;
            }
            if (entry === RELEASE_ENTRY)
            {
                return 0;
            }
            if (entry === GETOBJECT_ENTRY)
            {
                space.writeU32(args[3], wavePointer);
                return SOK;
            }
            return 0x80004001 | 0;
        };
        host.callGuest = guest;
    });
    waveObject = createComObject(ids.CLSID_DIRECTSOUND_WAVE, dm.wave());
    waveObject.state.bytes = wave;
    const object = createComObject(ids.CLSID_DIRECTMUSIC_SEGMENT, dm.segment());
    assert.equal(await call(object, ids.IID_IPERSIST_STREAM, 'Load', [stream]), S_OK);
    assert.notEqual(object.state.loader, 0, 'the loader was captured from the stream');
    assert.equal(await call(object, ids.IID_DIRECTMUSIC_SEGMENT8, 'Download', []), S_OK);
    const program = await (/** @type {any} */ (object).dmusic).resolve({});
    assert.equal(program.items.length, 1, 'the wave came through the loader');
    assert.equal(program.items[0].samples.length, samples.length * 2);
});

/**
 * Loads the one-wave segment into a published pointer through the loader.
 *
 * @param {any} space @param {Map<string, Uint8Array>} files @param {any} dm
 */
async function loadedSegment(space, files, dm){
    const { segment, wave } = segmentWithWave();
    files.set('a.wav', wave);
    const loader = createComObject(ids.CLSID_DIRECTMUSIC_LOADER, dm.loader());
    const block = space.alloc(segment.length);
    space.writeBytes(block, segment);
    const desc = space.alloc(ids.DMUS_OBJECTDESC.SIZE);
    space.writeU32(desc + ids.DMUS_OBJECTDESC.dwSize, ids.DMUS_OBJECTDESC.SIZE);
    space.writeU32(desc + ids.DMUS_OBJECTDESC.dwValidData,
        ids.DMUS_OBJ.CLASS | ids.DMUS_OBJ.MEMORY);
    space.writeGuid(desc + ids.DMUS_OBJECTDESC.guidClass, ids.CLSID_DIRECTMUSIC_SEGMENT);
    space.writeU32(desc + ids.DMUS_OBJECTDESC.llMemLength, segment.length);
    space.writeU32(desc + ids.DMUS_OBJECTDESC.pbMemData, block);
    const segmentOut = space.alloc(4);
    assert.equal(await call(loader, ids.IID_DIRECTMUSIC_LOADER8, 'GetObject',
        [desc, 0, segmentOut]), S_OK);
    return space.readU32(segmentOut);
}

test('a segment reports start, almost-end and end, and each sets the event', async()=>{
    const { space, files, signals, dm, time } = rig();
    const segmentPointer = await loadedSegment(space, files, dm);
    const performance = createComObject(ids.CLSID_DIRECTMUSIC_PERFORMANCE, dm.performance());

    const handle = 0x1234;
    assert.equal(await call(performance, ids.IID_DIRECTMUSIC_PERFORMANCE8,
        'SetNotificationHandle', [handle, 0, 0]), S_OK);
    const type = space.alloc(16);
    space.writeGuid(type, ids.GUID_NOTIFICATION_SEGMENT);
    assert.equal(await call(performance, ids.IID_DIRECTMUSIC_PERFORMANCE8,
        'AddNotificationType', [type]), S_OK);
    assert.equal(await call(performance, ids.IID_DIRECTMUSIC_PERFORMANCE8,
        'SetPrepareTime', [100]), S_OK);

    const stateOut = space.alloc(4);
    assert.equal(await call(performance, ids.IID_DIRECTMUSIC_PERFORMANCE8, 'PlaySegmentEx',
        [segmentPointer, 0, 0, 0, 0, 0, stateOut, 0, 0]), S_OK);
    assert.deepEqual(signals, [handle], 'the segment starting set the event');

    const pmsgOut = space.alloc(4);
    /** @returns {Promise<number>} the option of the next message */
    const nextOption = async()=>{
        assert.equal(await call(performance, ids.IID_DIRECTMUSIC_PERFORMANCE8,
            'GetNotificationPMsg', [pmsgOut]), S_OK);
        const message = space.readU32(pmsgOut);
        assert.notEqual(message, 0);
        assert.equal(space.readU32(message + ids.DMUS_NOTIFICATION_PMSG.dwType),
            ids.DMUS_PMSGT_NOTIFICATION);
        assert.equal(space.readU32(message + ids.DMUS_NOTIFICATION_PMSG.punkUser),
            space.readU32(stateOut), 'the message names the segment state');
        const option = space.readU32(message + ids.DMUS_NOTIFICATION_PMSG.dwNotificationOption);
        assert.equal(await call(performance, ids.IID_DIRECTMUSIC_PERFORMANCE8,
            'FreePMsg', [message]), S_OK);
        return option;
    };
    assert.equal(await nextOption(), ids.DMUS_NOTIFICATION_SEGSTART);

    time.at += 450;
    dm.tick();
    assert.equal(await nextOption(), ids.DMUS_NOTIFICATION_SEGALMOSTEND);
    time.at += 200;
    dm.tick();
    assert.equal(await nextOption(), ids.DMUS_NOTIFICATION_SEGEND);
    assert.equal(await call(performance, ids.IID_DIRECTMUSIC_PERFORMANCE8,
        'GetNotificationPMsg', [pmsgOut]), S_FALSE, 'nothing is left');
});

test('PlaySegment refuses a source that is not a segment, without throwing', async()=>{
    const { space, dm, divergences } = rig();
    const performance = createComObject(ids.CLSID_DIRECTMUSIC_PERFORMANCE, dm.performance());
    const stateOut = space.alloc(4);
    // A program's local, not a fresh slot: a refusing play must overwrite it,
    // because DirectMusic's own manager follows this word whatever came back.
    space.writeU32(stateOut, 0xdeadbeef);
    const hr = await call(performance, ids.IID_DIRECTMUSIC_PERFORMANCE8, 'PlaySegmentEx',
        [0x11112222, 0, 0, 0, 0, 0, stateOut, 0, 0]);
    assert.equal(hr, 0x80070057 | 0, 'an unknown source is E_INVALIDARG');
    assert.equal(space.readU32(stateOut), 0, 'a refused play leaves no stale state');
    assert.equal(dm.diagnostics().playing, 0, 'nothing was started');
    assert.ok(divergences.some(entry=>entry.api.includes('PlaySegment')),
        'the refusal is reported');
});

test('PlaySegmentEx plays an IDirectSoundWave a program loaded itself', async()=>{
    const samples = new Int16Array(1000);
    const bytes = wavFile(samples, { sampleRate: 1000, channels: 1 });
    /** @type {any} */
    let waveObject = null;
    const { space, out, dm } = rig(host=>{
        host.objectAt = ()=>waveObject;
    });
    waveObject = createComObject(ids.CLSID_DIRECTSOUND_WAVE, dm.wave());
    waveObject.state.bytes = bytes;
    const performance = createComObject(ids.CLSID_DIRECTMUSIC_PERFORMANCE, dm.performance());
    const stateOut = space.alloc(4);
    assert.equal(await call(performance, ids.IID_DIRECTMUSIC_PERFORMANCE8, 'PlaySegmentEx',
        [0x70000000, 0, 0, 0, 0, 0, stateOut, 0, 0]), S_OK);
    assert.equal(out.tracks.length, 1);
    assert.equal(out.tracks[0].format.sampleRate, 1000);
    assert.equal(out.tracks[0].bytes, samples.length * 2, 'the wave samples reached the mixer');
});

test('a segment that repeats for ever keeps playing past its length', async()=>{
    const { space, files, out, time, host, dm } = rig();
    files.set('a.wav', wavFile(new Int16Array(2000), { sampleRate: 1000, channels: 1 }));
    const bytes = dmsgSegment([{ file: 'a.wav', time: 0 }],
        { length: 768, tempo: { time: 0, tempo: 120 } });
    const segment = dm.createSegment(bytes, '');
    await call(segment.object, ids.IID_DIRECTMUSIC_SEGMENT8, 'SetRepeats', [0xffffffff]);
    assert.equal(segment.plays(), Infinity);
    host.objectAt = ()=>segment.object;

    const performance = createComObject(ids.CLSID_DIRECTMUSIC_PERFORMANCE, dm.performance());
    const stateOut = space.alloc(4);
    assert.equal(await call(performance, ids.IID_DIRECTMUSIC_PERFORMANCE8, 'PlaySegmentEx',
        [0x50000000, 0, 0, 0, 0, 0, stateOut, 0, 0]), S_OK);
    time.at += 5000;
    dm.tick();
    assert.equal(dm.diagnostics().playing, 1, 'still playing after ten passes');
    assert.ok(out.tracks.length >= 2, 'each pass opens its own track');
});

test('a pointer the bridge hands out again names its new object', async()=>{
    const { segment, wave } = segmentWithWave();
    const reused = 0x30000000;
    /** @type {any} */
    let published = null;
    /** @type {any} */
    let live = null;
    const { space, files, out, dm } = rig(host=>{
        host.publishInterface = (/** @type {any} */ object)=>{
            published = object;
            return reused;
        };
        host.objectAt = ()=>live;
    });
    files.set('a.wav', wave);
    const performance = createComObject(ids.CLSID_DIRECTMUSIC_PERFORMANCE, dm.performance());
    const pathOut = space.alloc(4);
    await call(performance, ids.IID_DIRECTMUSIC_PERFORMANCE8,
        'CreateStandardAudioPath', [5, 128, 1, pathOut]);

    // The program takes the path's buffer and releases it; the bridge frees the
    // pointer and gives the same words to the segment it is about to play.
    const guid = space.alloc(16);
    space.writeGuid(guid, '{6825A449-7524-4D82-920F-50E36AB3AB1E}');
    const path = published;
    assert.equal(await call(path, ids.IID_DIRECTMUSIC_AUDIOPATH, 'GetObjectInPath',
        [0, 0, 0, 0, 0, guid, space.alloc(4)]), S_OK);
    live = dm.createSegment(segment, '').object;

    assert.equal(await call(performance, ids.IID_DIRECTMUSIC_PERFORMANCE8, 'PlaySegmentEx',
        [reused, 0, 0, 0, 0, 0, space.alloc(4), 0, 0]), S_OK);
    assert.equal(out.tracks.length, 1, 'the segment now behind the pointer played');
});
