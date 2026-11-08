/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * mfplat's objects, as Wine's mfplat tests (test_attributes, test_media_type,
 * test_sample, test_system_memory_buffer, test_MFCreateMediaEvent,
 * test_IMFMediaType_GetRepresentation) say Windows answers.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mfMachine } from './machine.fixture.js';
import { IID, KEY, MAJOR, REPRESENTATION } from './objects.js';

const S_OK = 0;
const S_FALSE = 1;
const E_INVALIDARG = 0x80070057 | 0;
const E_NOINTERFACE = 0x80004002 | 0;
const E_UNEXPECTED = 0x8000ffff | 0;
const E_ACCESSDENIED = 0x80070005 | 0;
const E_NOT_SUFFICIENT_BUFFER = 0x8007007a | 0;
const MF_E_ATTRIBUTENOTFOUND = 0xc00d36e6 | 0;
const MF_E_INVALIDTYPE = 0xc00d36bd | 0;
const MF_E_BUFFERTOOSMALL = 0xc00d36b1 | 0;
const MF_E_NO_SAMPLE_TIMESTAMP = 0xc00d36c8 | 0;
const MF_E_UNSUPPORTED_REPRESENTATION = 0xc00d36b7 | 0;
const MF_E_BAD_STARTUP_VERSION = 0xc00d36e3 | 0;
const DUMMY1 = '{12345678-1234-1234-1234-123456789ABC}';
const DUMMY2 = '{12345678-1234-1234-1234-123456789ABD}';
const DUMMY3 = '{12345678-1234-1234-1234-123456789ABE}';
const PCM = '{00000001-0000-0010-8000-00AA00389B71}';
const RGB32 = '{00000016-0000-0010-8000-00AA00389B71}';

test('MFStartup takes Vista\'s and 7\'s SDK versions; MFShutdown past zero has no effect', ()=>{
    const { mf } = mfMachine();
    assert.equal(mf.table.MFStartup.handler([0xdead0070, 0]), MF_E_BAD_STARTUP_VERSION);
    assert.equal(mf.table.MFStartup.handler([0x20070, 0]), S_OK);
    assert.equal(mf.table.MFShutdown.handler(), S_OK);
    assert.equal(mf.table.MFShutdown.handler(), S_OK);
    assert.equal(mf.counts().started, 0);
});

test('MFTRegister is refused as for a user without the rights, and said', ()=>{
    const { mf, said } = mfMachine();
    assert.equal(mf.table.MFTRegister.handler(), E_ACCESSDENIED);
    assert.match(said[0].detail, /E_ACCESSDENIED/);
});

test('typed values: another type is MF_E_INVALIDTYPE with the out left alone', async()=>{
    const m = mfMachine();
    const a = await m.make('MFCreateAttributes', 3);
    const key = m.guid(DUMMY1);
    const value = m.out(8);
    assert.equal(await m.call(a, 'GetItemType', m.guid('{00000000-0000-0000-0000-000000000000}'),
        value), MF_E_ATTRIBUTENOTFOUND);
    assert.equal(await m.call(a, 'SetUINT32', key, 123), S_OK);
    assert.equal(await m.call(a, 'GetUINT32', key, value), S_OK);
    assert.equal(m.u32(value), 123);
    m.memory.fill(0xee, value, value + 8);
    assert.equal(await m.call(a, 'GetUINT64', key, value), MF_E_INVALIDTYPE);
    assert.equal(m.u32(value), 0xeeeeeeee);
    assert.equal(await m.call(a, 'SetUINT64', key, 65536, 0), S_OK);
    assert.equal(await m.call(a, 'GetItemType', key, value), S_OK);
    assert.equal(m.u32(value), 21);
    assert.equal(await m.call(a, 'GetCount', value), S_OK);
    assert.equal(m.u32(value), 1, 'a key set again keeps one item');
    // 22.0 as two stack words.
    assert.equal(await m.call(a, 'SetDouble', key, 0, 0x40360000), S_OK);
    assert.equal(await m.call(a, 'GetDouble', key, value), S_OK);
    assert.equal(m.view.getFloat64(value, true), 22);
});

test('SetItem of a type the store does not hold keeps the key, empty', async()=>{
    const m = mfMachine();
    const a = await m.make('MFCreateAttributes', 0);
    const pv = m.out(16);
    m.memory.fill(0, pv, pv + 16);
    m.view.setUint16(pv, 3, true); // VT_I4
    m.putU32(pv + 8, 123);
    const key = m.guid(DUMMY2);
    assert.equal(await m.call(a, 'SetItem', key, pv), MF_E_INVALIDTYPE);
    const got = m.out(16);
    assert.equal(await m.call(a, 'GetItem', key, got), S_OK);
    assert.equal(m.view.getUint16(got, true), 0, 'VT_EMPTY');
    assert.equal(await m.call(a, 'GetItem', key, 0), S_OK, 'NULL asks only whether it is there');
    assert.equal(await m.call(a, 'DeleteItem', key), S_OK);
    assert.equal(await m.call(a, 'GetItem', key, 0), MF_E_ATTRIBUTENOTFOUND);
    assert.equal(await m.call(a, 'DeleteItem', key), S_OK, 'deleting what is not there');
    assert.equal(await m.call(a, 'GetItemByIndex', 100, m.out(16), m.out(16)), E_INVALIDARG);
});

test('strings: the length, a copy in task memory, a short buffer said with the length', async()=>{
    const m = mfMachine();
    const a = await m.make('MFCreateAttributes', 0);
    const key = m.guid(DUMMY1);
    assert.equal(await m.call(a, 'SetString', key, m.wide('Wine')), S_OK);
    const length = m.out(4);
    assert.equal(await m.call(a, 'GetStringLength', key, length), S_OK);
    assert.equal(m.u32(length), 4);
    const pointer = m.out(4);
    assert.equal(await m.call(a, 'GetAllocatedString', key, pointer, 0), S_OK);
    assert.equal(m.wideAt(m.u32(pointer)), 'Wine');
    const buffer = m.out(2);
    m.memory.fill(0, buffer, buffer + 2);
    m.putU32(length, 0);
    assert.equal(await m.call(a, 'GetString', key, buffer, 1, length), E_NOT_SUFFICIENT_BUFFER);
    assert.equal(m.view.getUint16(buffer, true), 0, 'nothing written');
    assert.equal(m.u32(length), 4);
    const room = m.out(32);
    assert.equal(await m.call(a, 'GetString', key, room, 4, 0), E_NOT_SUFFICIENT_BUFFER,
        'no room for the terminator');
    assert.equal(await m.call(a, 'GetString', key, room, 16, 0), S_OK);
    assert.equal(m.wideAt(room), 'Wine');
    m.putU32(length, 0xdeadbeef);
    assert.equal(await m.call(a, 'GetStringLength', m.guid(DUMMY2), length),
        MF_E_ATTRIBUTENOTFOUND);
    assert.equal(m.u32(length), 0xdeadbeef);
});

test('blobs: size, copy, allocated copy, a short buffer refused', async()=>{
    const m = mfMachine();
    const a = await m.make('MFCreateAttributes', 0);
    const key = m.guid(DUMMY1);
    const blob = m.out(6);
    m.memory.set([0, 1, 2, 3, 4, 5], blob);
    assert.equal(await m.call(a, 'SetBlob', key, blob, 6), S_OK);
    const size = m.out(4);
    assert.equal(await m.call(a, 'GetBlobSize', key, size), S_OK);
    assert.equal(m.u32(size), 6);
    const copy = m.out(16);
    assert.equal(await m.call(a, 'GetBlob', key, copy, 16, size), S_OK);
    assert.deepEqual([...m.memory.subarray(copy, copy + 6)], [0, 1, 2, 3, 4, 5]);
    assert.equal(await m.call(a, 'GetBlob', key, copy, 5, 0), E_NOT_SUFFICIENT_BUFFER);
    const pointer = m.out(4);
    assert.equal(await m.call(a, 'GetAllocatedBlob', key, pointer, 0), S_OK);
    assert.deepEqual([...m.memory.subarray(m.u32(pointer), m.u32(pointer) + 6)],
        [0, 1, 2, 3, 4, 5]);
});

test('an interface value: QueryInterface through it, NULL stored but not handed out', async()=>{
    const m = mfMachine();
    const a = await m.make('MFCreateAttributes', 0);
    const key = m.guid(DUMMY2);
    assert.equal(await m.call(a, 'SetUnknown', key, a), S_OK);
    const got = m.out(4);
    assert.equal(await m.call(a, 'GetUnknown', key, m.guid(m.IID_IUNKNOWN), got), S_OK);
    assert.equal(m.u32(got), a, 'one IUnknown');
    const stream = m.guid('{0000000C-0000-0000-C000-000000000046}');
    assert.equal(await m.call(a, 'GetUnknown', key, stream, got), E_NOINTERFACE);
    assert.equal(m.u32(got), 0);
    const empty = m.guid(DUMMY3);
    assert.equal(await m.call(a, 'SetUnknown', empty, 0), S_OK);
    assert.equal(await m.call(a, 'GetUnknown', empty, m.guid(m.IID_IUNKNOWN), got),
        MF_E_INVALIDTYPE);
    const owner = m.owners.get(a)?.object;
    const refs = owner.refCount;
    assert.equal(await m.call(a, 'DeleteItem', key), S_OK);
    assert.equal(owner.refCount, refs - 1, 'the stored reference given back');
});

test('CopyAllItems empties the destination first', async()=>{
    const m = mfMachine();
    const a = await m.make('MFCreateAttributes', 0);
    const b = await m.make('MFCreateAttributes', 0);
    await m.call(a, 'SetUINT32', m.guid(DUMMY1), 1);
    await m.call(b, 'SetUINT32', m.guid(DUMMY2), 2);
    await m.call(b, 'SetUINT32', m.guid(DUMMY3), 3);
    assert.equal(await m.call(a, 'CopyAllItems', b), S_OK);
    const count = m.out(4);
    await m.call(b, 'GetCount', count);
    assert.equal(m.u32(count), 1);
    const empty = await m.make('MFCreateAttributes', 0);
    assert.equal(await m.call(empty, 'CopyAllItems', a), S_OK);
    await m.call(a, 'GetCount', count);
    assert.equal(m.u32(count), 0);
});

test('Compare by every match type, as Wine\'s table holds', async()=>{
    const m = mfMachine();
    const a = await m.make('MFCreateAttributes', 0);
    const b = await m.make('MFCreateAttributes', 0);
    const result = m.out(4);
    /** @param {number} x @param {number} y @param {number} type */
    const cmp = async(x, y, type)=>{
        assert.equal(await m.call(x, 'Compare', y, type, result), S_OK);
        return m.u32(result);
    };
    assert.equal(await m.call(a, 'Compare', a, 5, result), E_INVALIDARG);
    for (let type = 0; type <= 4; type++)
    {
        assert.equal(await cmp(a, a, type), 1);
        assert.equal(await cmp(a, b, type), 1);
    }
    await m.call(a, 'SetUINT32', m.guid(DUMMY1), 1);
    assert.deepEqual([await cmp(a, b, 0), await cmp(a, b, 2), await cmp(a, b, 3),
        await cmp(a, b, 4)], [0, 0, 1, 1]);
    await m.call(b, 'SetUINT32', m.guid(DUMMY1), 2);
    for (let type = 0; type <= 4; type++)
    {
        assert.equal(await cmp(a, b, type), 0, `type ${type}`);
        assert.equal(await cmp(b, a, type), 0, `type ${type}`);
    }
    await m.call(b, 'SetUINT32', m.guid(DUMMY1), 1);
    await m.call(b, 'SetUINT32', m.guid(DUMMY2), 2);
    /** @param {number} x @param {number} y */
    const every = async(x, y)=>{
        const answers = [];
        for (let type = 0; type <= 4; type++)
        {
            answers.push(await cmp(x, y, type));
        }
        return answers;
    };
    assert.deepEqual(await every(a, b), [1, 0, 0, 1, 1]);
    assert.deepEqual(await every(b, a), [0, 1, 0, 1, 1]);
});

test('Compare reads a foreign store through GetCount and GetItemByIndex', async()=>{
    const m = mfMachine();
    const a = await m.make('MFCreateAttributes', 0);
    await m.call(a, 'SetUINT32', m.guid(DUMMY1), 7);
    // A store of the program's own: 30 methods, of which GetCount (30) and
    // GetItemByIndex (31) answer.
    /** @type {((args: number[]) => number)[]} */
    const methods = Array.from({ length: 30 }, ()=>()=>0x80004001);
    methods[27] = ([count])=>{
        m.putU32(count, 1);
        return 0;
    };
    methods[28] = ([index, key, value])=>{
        m.memory.set(m.memory.subarray(m.guid(DUMMY1), m.guid(DUMMY1) + 16), key);
        m.memory.fill(0, value, value + 16);
        m.view.setUint16(value, 19, true);
        m.putU32(value + 8, index === 0 ? 7 : 0);
        return 0;
    };
    const theirs = m.foreign(methods);
    const result = m.out(4);
    assert.equal(await m.call(a, 'Compare', theirs.pointer, 2, result), S_OK);
    assert.equal(m.u32(result), 1);
});

test('a media type: compressed unless every sample is independent; IsEqual\'s flags', async()=>{
    const m = mfMachine();
    const t = await m.make('MFCreateMediaType');
    const flag = m.out(4);
    assert.equal(await m.call(t, 'GetMajorType', m.out(16)), MF_E_ATTRIBUTENOTFOUND);
    assert.equal(await m.call(t, 'IsCompressedFormat', flag), S_OK);
    assert.equal(m.u32(flag), 1);
    await m.call(t, 'SetUINT32', m.guid(KEY.ALL_SAMPLES_INDEPENDENT), 1);
    assert.equal(await m.call(t, 'IsCompressedFormat', flag), S_OK);
    assert.equal(m.u32(flag), 0);
    await m.call(t, 'SetGUID', m.guid(KEY.MAJOR_TYPE), m.guid(MAJOR.VIDEO));

    const u = await m.make('MFCreateMediaType');
    const flags = m.out(4);
    assert.equal(await m.call(t, 'IsEqual', u, flags), E_INVALIDARG);
    assert.equal(m.u32(flags), 0);
    await m.call(u, 'SetGUID', m.guid(KEY.MAJOR_TYPE), m.guid(MAJOR.AUDIO));
    assert.equal(await m.call(t, 'IsEqual', u, flags), S_FALSE);
    assert.equal(m.u32(flags), 2 | 8);
    await m.call(u, 'SetGUID', m.guid(KEY.MAJOR_TYPE), m.guid(MAJOR.VIDEO));
    assert.equal(await m.call(t, 'IsEqual', u, flags), S_OK);
    assert.equal(m.u32(flags), 15);
    const data = m.out(4);
    await m.call(t, 'SetBlob', m.guid(KEY.USER_DATA), data, 4);
    assert.equal(await m.call(t, 'IsEqual', u, flags), S_FALSE);
    assert.equal(m.u32(flags), 1 | 2 | 4);
    await m.call(t, 'DeleteItem', m.guid(KEY.USER_DATA));
    await m.call(t, 'SetGUID', m.guid(KEY.SUBTYPE), m.guid(RGB32));
    assert.equal(await m.call(t, 'IsEqual', u, flags), S_FALSE);
    assert.equal(m.u32(flags), 1 | 4 | 8);
});

test('a media type answers its video or audio interface by its major type, one IUnknown', async()=>{
    const m = mfMachine();
    const t = await m.make('MFCreateMediaType');
    const got = m.out(4);
    assert.equal(await m.call(t, 'QueryInterface', m.guid(IID.VIDEO_MEDIA_TYPE), got),
        E_NOINTERFACE);
    assert.equal(await m.call(t, 'QueryInterface', m.guid(IID.ATTRIBUTES), got), S_OK);
    assert.equal(m.u32(got), t);
    await m.call(t, 'SetGUID', m.guid(KEY.MAJOR_TYPE), m.guid(MAJOR.VIDEO));
    assert.equal(await m.call(t, 'QueryInterface', m.guid(IID.VIDEO_MEDIA_TYPE), got), S_OK);
    const video = m.u32(got);
    assert.equal(await m.call(video, 'QueryInterface', m.guid(m.IID_IUNKNOWN), got), S_OK);
    assert.equal(m.u32(got), t);
    assert.equal(await m.call(t, 'QueryInterface', m.guid(IID.AUDIO_MEDIA_TYPE), got),
        E_NOINTERFACE);
    await m.call(t, 'DeleteAllItems');
    assert.equal(await m.call(t, 'QueryInterface', m.guid(IID.VIDEO_MEDIA_TYPE), got),
        E_NOINTERFACE);
});

test('an audio type\'s AM_MEDIA_TYPE carries its WAVEFORMATEX; others refused as Windows does',
    async()=>{
        const m = mfMachine();
        const t = await m.make('MFCreateMediaType');
        const rep = (/** @type {string} */ guid)=>{
            const at = m.guid(guid);
            return [0, 4, 8, 12].map(o=>m.u32(at + o));
        };
        const out = m.out(4);
        /** @param {string} guid */
        const get = guid=>m.call(t, 'GetRepresentation', ...rep(guid), out);
        assert.equal(await get('{00000000-0000-0000-0000-000000000000}'),
            MF_E_UNSUPPORTED_REPRESENTATION);
        assert.equal(await get(REPRESENTATION.AM_MEDIA_TYPE), MF_E_ATTRIBUTENOTFOUND);
        await m.call(t, 'SetGUID', m.guid(KEY.MAJOR_TYPE), m.guid(MAJOR.AUDIO));
        assert.equal(await get(REPRESENTATION.AM_MEDIA_TYPE), MF_E_ATTRIBUTENOTFOUND);
        await m.call(t, 'SetGUID', m.guid(KEY.SUBTYPE), m.guid(PCM));
        await m.call(t, 'SetUINT32', m.guid(KEY.AUDIO_NUM_CHANNELS), 2);
        await m.call(t, 'SetUINT32', m.guid(KEY.AUDIO_SAMPLES_PER_SECOND), 44100);
        await m.call(t, 'SetUINT32', m.guid(KEY.AUDIO_BITS_PER_SAMPLE), 16);
        assert.equal(await get(REPRESENTATION.VIDEO_INFO), E_INVALIDARG);
        assert.equal(await get(REPRESENTATION.AM_MEDIA_TYPE), S_OK);
        const am = m.u32(out);
        assert.equal(m.guidAt(am), MAJOR.AUDIO);
        assert.equal(m.guidAt(am + 16), PCM);
        assert.equal(m.guidAt(am + 44), REPRESENTATION.WAVE_FORMAT_EX);
        assert.equal(m.u32(am + 64), 18, 'sizeof(WAVEFORMATEX)');
        const wave = m.u32(am + 68);
        assert.deepEqual([m.view.getUint16(wave, true), m.view.getUint16(wave + 2, true),
            m.u32(wave + 4), m.view.getUint16(wave + 14, true)], [1, 2, 44100, 16]);
        assert.equal(await m.call(t, 'FreeRepresentation', ...rep(m.IID_IUNKNOWN), am), S_OK);
        assert.ok(m.freed.has(am) && m.freed.has(wave));
    });

test('a memory buffer: one block, locked any number of times; lengths held to the maximum',
    async()=>{
        const m = mfMachine();
        assert.equal(m.mf.table.MFCreateMemoryBuffer.handler([1024, 0]), E_INVALIDARG);
        const b = await m.make('MFCreateMemoryBuffer', 1024);
        const length = m.out(4);
        const max = m.out(4);
        const data = m.out(4);
        assert.equal(await m.call(b, 'GetMaxLength', 0), E_INVALIDARG);
        assert.equal(await m.call(b, 'GetMaxLength', max), S_OK);
        assert.equal(m.u32(max), 1024);
        assert.equal(await m.call(b, 'SetCurrentLength', 1025), E_INVALIDARG);
        assert.equal(await m.call(b, 'SetCurrentLength', 10), S_OK);
        m.putU32(length, 0);
        assert.equal(await m.call(b, 'Lock', 0, length, max), E_INVALIDARG);
        assert.equal(m.u32(length), 0, 'a refused lock writes nothing');
        assert.equal(await m.call(b, 'Lock', data, max, length), S_OK);
        assert.deepEqual([m.u32(max), m.u32(length)], [1024, 10]);
        const first = m.u32(data);
        assert.equal(await m.call(b, 'Lock', data, 0, 0), S_OK);
        assert.equal(m.u32(data), first);
        assert.equal(await m.call(b, 'Unlock'), S_OK);
        assert.equal(await m.call(b, 'Unlock'), S_OK);
        assert.equal(await m.call(b, 'Unlock'), S_OK, 'an extra Unlock');
        const aligned = await m.make('MFCreateAlignedMemoryBuffer', 64, 0xff);
        assert.equal(await m.call(aligned, 'Lock', data, 0, 0), S_OK);
        assert.equal(m.u32(data) & 0xff, 0);
    });

test('a sample: flags, times, buffers by reference, its total the buffers\' current lengths',
    async()=>{
        const m = mfMachine();
        const s = await m.make('MFCreateSample');
        const word = m.out(8);
        assert.equal(await m.call(s, 'GetBufferCount', 0), E_INVALIDARG);
        assert.equal(await m.call(s, 'GetSampleTime', word), MF_E_NO_SAMPLE_TIMESTAMP);
        assert.equal(await m.call(s, 'GetBufferByIndex', 0, word), E_INVALIDARG);
        assert.equal(await m.call(s, 'RemoveBufferByIndex', 0), E_INVALIDARG);
        const b = await m.make('MFCreateMemoryBuffer', 16);
        const buffer = m.owners.get(b)?.object;
        assert.equal(await m.call(s, 'AddBuffer', b), S_OK);
        assert.equal(await m.call(s, 'AddBuffer', b), S_OK);
        assert.equal(buffer.refCount, 3);
        assert.equal(await m.call(s, 'GetBufferByIndex', 0, word), S_OK);
        assert.equal(m.u32(word), b);
        await m.call(b, 'Release');
        await m.call(b, 'SetCurrentLength', 2);
        assert.equal(await m.call(s, 'GetTotalLength', word), S_OK);
        assert.equal(m.u32(word), 4);
        assert.equal(await m.call(s, 'RemoveBufferByIndex', 1), S_OK);
        assert.equal(await m.call(s, 'GetTotalLength', word), S_OK);
        assert.equal(m.u32(word), 2);
        assert.equal(await m.call(s, 'SetSampleTime', 1, 0), S_OK);
        assert.equal(await m.call(s, 'GetSampleTime', word), S_OK);
        assert.equal(m.u32(word), 1);
        assert.equal(await m.call(s, 'GetCount', word), S_OK);
        assert.equal(m.u32(word), 0, 'times are not attributes');
        await m.call(b, 'Release');
        await m.call(s, 'Release');
        assert.equal(buffer.destroyed, true, 'the sample gave its reference back');
    });

test('CopyToBuffer: the buffers one after another; one that does not fit empties the target',
    async()=>{
        const m = mfMachine();
        const s = await m.make('MFCreateSample');
        const target = await m.make('MFCreateMemoryBuffer', 16);
        const length = m.out(4);
        await m.call(target, 'SetCurrentLength', 1);
        assert.equal(await m.call(s, 'CopyToBuffer', target), S_OK);
        await m.call(target, 'GetCurrentLength', length);
        assert.equal(m.u32(length), 0);
        const source = await m.make('MFCreateMemoryBuffer', 8);
        const data = m.out(4);
        await m.call(source, 'Lock', data, 0, 0);
        m.putU32(m.u32(data), 0x11111111);
        await m.call(source, 'SetCurrentLength', 4);
        await m.call(s, 'AddBuffer', source);
        await m.call(s, 'AddBuffer', source);
        assert.equal(await m.call(s, 'CopyToBuffer', target), S_OK);
        await m.call(target, 'GetCurrentLength', length);
        assert.equal(m.u32(length), 8);
        await m.call(target, 'Lock', data, 0, 0);
        assert.deepEqual([m.u32(m.u32(data)), m.u32(m.u32(data) + 4)], [0x11111111, 0x11111111]);
        await m.call(source, 'SetCurrentLength', 8);
        await m.call(s, 'AddBuffer', source);
        m.putU32(m.u32(data), 0x22222222);
        assert.equal(await m.call(s, 'CopyToBuffer', target), MF_E_BUFFERTOOSMALL);
        assert.equal(m.u32(m.u32(data)), 0x22222222);
        await m.call(target, 'GetCurrentLength', length);
        assert.equal(m.u32(length), 0);
    });

test('ConvertToContiguousBuffer: the only buffer, or one new buffer holding them all', async()=>{
    const m = mfMachine();
    const s = await m.make('MFCreateSample');
    const got = m.out(4);
    assert.equal(await m.call(s, 'ConvertToContiguousBuffer', got), E_UNEXPECTED);
    const first = await m.make('MFCreateMemoryBuffer', 16);
    await m.call(s, 'AddBuffer', first);
    assert.equal(await m.call(s, 'ConvertToContiguousBuffer', got), S_OK);
    assert.equal(m.u32(got), first);
    await m.call(first, 'SetCurrentLength', 3);
    const second = await m.make('MFCreateMemoryBuffer', 16);
    await m.call(second, 'SetCurrentLength', 4);
    await m.call(s, 'AddBuffer', second);
    assert.equal(await m.call(s, 'ConvertToContiguousBuffer', got), S_OK);
    const joined = m.u32(got);
    assert.notEqual(joined, first);
    const word = m.out(4);
    await m.call(joined, 'GetMaxLength', word);
    assert.equal(m.u32(word), 7);
    await m.call(joined, 'GetCurrentLength', word);
    assert.equal(m.u32(word), 7);
    await m.call(s, 'GetBufferCount', word);
    assert.equal(m.u32(word), 1);
});

test('a sample works a foreign buffer through its own methods', async()=>{
    const m = mfMachine();
    const s = await m.make('MFCreateSample');
    const memory = m.out(8);
    m.putU32(memory, 0x33333333);
    let current = 4;
    const buffer = m.foreign([
        ([data, max, cur])=>{
            m.putU32(data, memory);
            if (max)
            {
                m.putU32(max, 8);
            }
            if (cur)
            {
                m.putU32(cur, current);
            }
            return 0;
        },
        ()=>0,
        ([out])=>{
            m.putU32(out, current);
            return 0;
        },
        ([n])=>{
            current = n;
            return 0;
        },
        ([out])=>{
            m.putU32(out, 8);
            return 0;
        },
    ]);
    assert.equal(await m.call(s, 'AddBuffer', buffer.pointer), S_OK);
    assert.equal(buffer.state.refs, 2);
    const word = m.out(4);
    assert.equal(await m.call(s, 'GetTotalLength', word), S_OK);
    assert.equal(m.u32(word), 4);
    const target = await m.make('MFCreateMemoryBuffer', 16);
    assert.equal(await m.call(s, 'CopyToBuffer', target), S_OK);
    const data = m.out(4);
    await m.call(target, 'Lock', data, 0, 0);
    assert.equal(m.u32(m.u32(data)), 0x33333333);
    await m.call(s, 'Release');
    assert.equal(buffer.state.refs, 1, 'the dying sample\'s Release made through the guest');
});

test('an event keeps its type, extended type, status and a copy of its value', async()=>{
    /** @type {number[]} */
    const cleared = [];
    const m = mfMachine({ propVariant: {
        copy: (/** @type {number} */ dest, /** @type {number} */ src)=>{
            m.memory.copyWithin(dest, src, src + 16);
            return 0;
        },
        clear: (/** @type {number} */ at)=>{
            cleared.push(at);
            return 0;
        },
    } });
    const value = m.out(16);
    m.memory.fill(0, value, value + 16);
    m.view.setUint16(value, 13, true);
    const e = await m.make('MFCreateMediaEvent', 1, 0, 0x80004005, value);
    const word = m.out(16);
    assert.equal(await m.call(e, 'GetType', word), S_OK);
    assert.equal(m.u32(word), 1);
    assert.equal(await m.call(e, 'GetExtendedType', word), S_OK);
    assert.equal(m.guidAt(word), '{00000000-0000-0000-0000-000000000000}');
    assert.equal(await m.call(e, 'GetStatus', word), S_OK);
    assert.equal(m.u32(word), 0x80004005);
    assert.equal(await m.call(e, 'GetValue', word), S_OK);
    assert.equal(m.view.getUint16(word, true), 13);
    await m.call(e, 'Release');
    assert.equal(cleared.length, 1, 'the value cleared as the event goes');
});
