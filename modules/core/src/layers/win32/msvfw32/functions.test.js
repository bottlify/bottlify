/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ICINFO_SIZE, createMsvfwFunctions } from './functions.js';
import { DRIVERS32 } from './icm.js';
import { fourcc } from './codecs.js';

const VIDC = fourcc('vidc');
const ICERR_BADHANDLE = 0xfffffff8;
const ICM_GETINFO = 0x5002;

/** A machine of memory, a registry with the system's codecs and a heap that only grows. */
const machine = ({ calls = /** @type {any[]} */ ([]),
    answer = /** @type {(args: number[]) => number} */ (()=>1) } = {})=>{
    const memory = new Uint8Array(0x40000);
    let top = 0x1000;
    /** @type {Map<string, string>} */
    const registry = new Map([['vidc.cvid', 'iccvid.dll'], ['vidc.mrle', 'msrle32.dll'],
        ['vidc.msvc', 'msvidc32.dll']]);
    const drawn = /** @type {number[][]} */ ([]);
    const fns = createMsvfwFunctions({
        readMemory: (at, length)=>memory.subarray(at, at + length),
        writeMemory: (at, bytes)=>memory.set(bytes, at),
        readCString: at=>String.fromCharCode(...memory.subarray(at, memory.indexOf(0, at))),
        readWideString: ()=>'',
        drivers: {
            values: path=>(path === DRIVERS32 ? [...registry] : []),
            get: (_, name)=>registry.get(name) ?? null,
            set: (_, name, value)=>void registry.set(name, value),
            remove: (_, name)=>registry.delete(name),
        },
        call: async(entry, args)=>{
            calls.push([entry, ...args]);
            return answer(args);
        },
        allocate: bytes=>{
            const at = top;
            top += (bytes + 15) & ~15;
            return at;
        },
        free: ()=>{},
        stretchDIBits: args=>{
            drawn.push(args);
            return 1;
        },
    });
    const view = new DataView(memory.buffer);
    /**
     * @param {Partial<Record<'width'|'height'|'bitCount'|'compression'|'planes', number>>} fields
     */
    const header = fields=>{
        const at = top;
        top += 40 + 1024;
        view.setUint32(at, 40, true);
        view.setInt32(at + 4, fields.width ?? 32, true);
        view.setInt32(at + 8, fields.height ?? 8, true);
        view.setUint16(at + 12, fields.planes ?? 1, true);
        view.setUint16(at + 14, fields.bitCount ?? 8, true);
        view.setUint32(at + 16, fields.compression ?? 0, true);
        return at;
    };
    const alloc = (/** @type {number} */ bytes)=>{
        const at = top;
        top += (bytes + 15) & ~15;
        return at;
    };
    return { fns, memory, view, header, alloc, registry, drawn, calls };
};

test('ICInfo lists the system codecs by index and finds each by its FOURCC in any case', async()=>{
    const m = machine();
    const info = m.alloc(ICINFO_SIZE);
    /** @type {number[]} */
    const handlers = [];
    for (let i = 0; await m.fns.ICInfo.handler([0, i, info]); i++)
    {
        assert.equal(m.view.getUint32(info + 4, true), VIDC);
        assert.equal(m.view.getUint32(info + 20, true), 0x0104, 'ICVERSION');
        assert.equal(m.view.getUint16(info + 24, true), 0, 'no name without opening the codec');
        handlers.push(m.view.getUint32(info + 8, true));
    }
    assert.deepEqual(handlers, [fourcc('cvid'), fourcc('mrle'), fourcc('msvc')]);
    assert.equal(await m.fns.ICInfo.handler([VIDC, fourcc('MSVC'), info]), 1);
    assert.equal(await m.fns.ICInfo.handler([VIDC, fourcc('fake'), info]), 0);
    assert.equal(m.view.getUint32(info + 8, true), fourcc('fake'),
        'a failed lookup names what was asked');
});

test('ICOpen matches the FOURCC without regard to case; ICClose ends the handle', async()=>{
    const m = machine();
    for (const name of ['msvc', 'MSVC', 'mSvC'])
    {
        const hic = await m.fns.ICOpen.handler([fourcc('VIDC'), fourcc(name), 2]);
        assert.ok(hic, name);
        const info = m.alloc(ICINFO_SIZE);
        assert.equal(await m.fns.ICGetInfo.handler([hic, info, ICINFO_SIZE]), ICINFO_SIZE);
        const given = new Uint16Array(m.memory.slice(info + 24, info + 38).buffer);
        assert.equal(String.fromCharCode(...given), 'MS-CRAM');
        assert.equal(await m.fns.ICClose.handler([hic]), 0);
        assert.equal(await m.fns.ICClose.handler([hic]), ICERR_BADHANDLE, 'closed already');
    }
    assert.equal(await m.fns.ICOpen.handler([VIDC, fourcc('none'), 2]), 0);
});

test('ICLocate finds the codec a stream names as it spells it, a run-length frame bottom up only',
    async()=>{
        const m = machine();
        const out = m.header({ bitCount: 16 });
        assert.ok(await m.fns.ICLocate.handler([VIDC, 0, m.header({ bitCount: 16,
            compression: fourcc('MSVC') }), out, 2]));
        assert.equal(await m.fns.ICLocate.handler([VIDC, 0,
            m.header({ bitCount: 16, compression: fourcc('msvc') }), out, 2]), 0,
        'msvc in lower case is no stream\'s');
        const rle = m.header({ compression: 1 });
        assert.ok(await m.fns.ICLocate.handler([VIDC, 0, rle, m.header({}), 2]));
        assert.equal(await m.fns.ICLocate.handler([VIDC, 0, rle, m.header({ height: -8 }), 2]), 0);
    });

test('a function driver is opened through DRV_LOAD, DRV_ENABLE, DRV_OPEN; ICInfo asks it alone',
    async()=>{
        const calls = /** @type {any[]} */ ([]);
        const m = machine({ calls, answer: args=>(args[2] === 3 ? 0x77 : 1) });
        const proc = 0x00401000;
        assert.equal(m.fns.ICInstall.handler([VIDC, fourcc('test'), proc, 0, 1]), 1);
        const hic = await m.fns.ICOpen.handler([VIDC, fourcc('TEST'), 2]);
        assert.deepEqual(calls.map(call=>call[3]), [1, 2, 3], 'DRV_LOAD, DRV_ENABLE, DRV_OPEN');
        await m.fns.ICSendMessage.handler([hic, 0x400b, 5, 6]);
        assert.deepEqual(calls.at(-1), [proc, 0x77, hic, 0x400b, 5, 6],
            'the instance id the open answered');
        calls.length = 0;
        await m.fns.ICClose.handler([hic]);
        assert.deepEqual(calls.map(call=>call[3]), [4, 5, 6], 'DRV_CLOSE, DRV_DISABLE, DRV_FREE');
        calls.length = 0;
        const info = m.alloc(ICINFO_SIZE);
        assert.equal(await m.fns.ICInfo.handler([VIDC, fourcc('test'), info]), 1);
        assert.deepEqual(calls, [[proc, 0, 0, ICM_GETINFO, info, ICINFO_SIZE]]);
        assert.equal(m.fns.ICRemove.handler([VIDC, fourcc('test'), 0]), 1);
        assert.equal(await m.fns.ICInfo.handler([VIDC, fourcc('test'), info]), 0);
    });

test('ICInstall of a driver file writes the registry\'s value, and ICRemove deletes it', ()=>{
    const m = machine();
    const name = m.alloc(16);
    m.memory.set([...'bogus'].map(c=>c.charCodeAt(0)), name);
    assert.equal(m.fns.ICInstall.handler([fourcc('wine'), fourcc('test'), name, 0, 2]), 1);
    assert.equal(m.registry.get('wine.test'), 'bogus');
    assert.equal(m.fns.ICRemove.handler([fourcc('wine'), fourcc('test'), 0]), 1);
    assert.equal(m.registry.has('wine.test'), false);
});

test('sequence compression through msrle32 hands back key frames as Windows writes them', async()=>{
    const m = machine();
    const hic = await m.fns.ICOpen.handler([VIDC, fourcc('mrle'), 1]);
    const input = m.header({ width: 32, height: 1, bitCount: 8 });
    const pc = m.alloc(64);
    m.view.setUint32(pc, 64, true);
    m.view.setUint32(pc + 4, 1, true);
    m.view.setUint32(pc + 8, hic, true);
    m.view.setUint32(pc + 40, 1, true);
    const bits = m.alloc(32);
    m.memory.set([1, 2, 3, 3, 3, 3, 2, 3, 1], bits);
    assert.equal(await m.fns.ICSeqCompressFrameStart.handler([pc, input]), 1);
    const key = m.alloc(4);
    const size = m.alloc(4);
    for (let frame = 0; frame < 3; frame++)
    {
        const out = await m.fns.ICSeqCompressFrame.handler([pc, 0, bits, key, size]);
        assert.ok(out);
        assert.deepEqual([...m.memory.subarray(out, out + m.view.getUint32(size, true))],
            [1, 1, 1, 2, 4, 3, 0, 3, 2, 3, 1, 0, 23, 0, 0, 0, 0, 1]);
        assert.equal(m.view.getUint32(key, true), 1);
    }
    await m.fns.ICSeqCompressFrameEnd.handler([pc]);
    await m.fns.ICCompressorFree.handler([pc]);
    assert.equal(await m.fns.ICClose.handler([hic]), ICERR_BADHANDLE, 'ICCompressorFree closed it');
});

test('DrawDib draws a frame of a positive size, a destination of -1 the source\'s; not upside down',
    async()=>{
        const m = machine();
        const hdd = m.fns.DrawDibOpen.handler();
        const draw = (/** @type {number} */ info, /** @type {number} */ height)=>
            m.fns.DrawDibDraw.handler([hdd, 0x99, 0, 0, -1, -1, info, 0x2000, 0, 0, 16, height, 0]);
        assert.equal(await draw(m.header({ width: 16, height: 12, bitCount: 32 }), 12), 1);
        assert.deepEqual(m.drawn[0].slice(0, 9), [0x99, 0, 0, 16, 12, 0, 0, 16, 12]);
        assert.equal(await draw(m.header({ width: 16, height: -12, bitCount: 32 }), -12), 0);
        assert.equal(await m.fns.DrawDibClose.handler([hdd]), 1);
        assert.equal(await m.fns.DrawDibClose.handler([hdd]), 0);
    });

test('an MCIWnd is never made, and its class is not offered', ()=>{
    const { fns } = machine();
    assert.equal(fns.MCIWndCreateA.handler(), 0);
    assert.equal(fns.MCIWndCreateW.handler(), 0);
    assert.equal(fns.MCIWndRegisterClass.handler(), 0);
});
