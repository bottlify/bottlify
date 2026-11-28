/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Gate: the guest memory port (`system/port.js`, the memory layer's `port`)
 * against a plain model of memory. Seeded programs of reads and writes of
 * every width and sign, aligned and not, blocks, fills and copies, at the
 * edges of regions that are not there or not for this, below and past 4 GiB
 * at both pointer widths, run through the port over the memory layer and
 * through the model; every answer, every fault (and that a faulting access
 * changed nothing), every byte of memory after, and which writes the machine
 * was told of (a write over code goes by the path the translator hears, any
 * other by the data path) must agree.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryModule } from './module.js';
import { cpuForMemory } from './cpu.fixture.js';
import { testLog } from '../log/testing.fixture.js';

/** @param {number} seed @returns {() => number} 0 up to 2^32 */
function random(seed){
    let state = seed >>> 0 || 1;
    return ()=>{
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return state >>> 0;
    };
}

const HIGH = 2 ** 32 + 0x20000;

/** The regions of a program, gaps between them: what is not there faults. */
const REGIONS = [
    { name: 'data', base: 0x10000, size: 0x2000, kind: 'heap', access: 'rw' },
    { name: 'rdata', base: 0x14000, size: 0x1000, kind: 'image', access: 'r' },
    { name: 'code', base: 0x18000, size: 0x1000, kind: 'image', access: 'rwx' },
    { name: 'high', base: HIGH, size: 0x2000, kind: 'heap', access: 'rw' },
];

/**
 * A machine's bytes as sparse pages anywhere below 2^53, and the writes it
 * was told of, by path.
 */
function machine(){
    /** @type {Map<number, Uint8Array>} */
    const pages = new Map();
    /** @param {number} at */
    const page = at=>{
        const key = Math.floor(at / 4096);
        let bytes = pages.get(key);
        if (!bytes)
        {
            bytes = new Uint8Array(4096);
            pages.set(key, bytes);
        }
        return bytes;
    };
    /** @param {number} at */
    const byte = at=>page(at)[at % 4096];
    /** @param {number} at @param {number} value */
    const put = (at, value)=>{
        page(at)[at % 4096] = value;
    };
    /** @type {string[]} */
    const told = [];
    return {
        told,
        cpu: {
            /** @param {number} address @param {number} length */
            readPhysical: (address, length)=>Uint8Array.from({ length }, (_, i)=>byte(address + i)),
            /** @param {number} address @param {Uint8Array} data */
            writePhysical: (address, data)=>{
                told.push(`code ${address} ${data.length}`);
                data.forEach((value, i)=>put(address + i, value));
            },
            /** @param {number} address @param {Uint8Array} data */
            writeData: (address, data)=>{
                told.push(`data ${address} ${data.length}`);
                data.forEach((value, i)=>put(address + i, value));
            },
            /** @param {number} address @param {number} value @param {number} length */
            fillData: (address, value, length)=>{
                told.push(`data ${address} ${length}`);
                for (let i = 0; i < length; i++)
                {
                    put(address + i, value);
                }
            },
            /** @param {number} address @param {number} value */
            writeU32Data: (address, value)=>{
                told.push(`data ${address} 4`);
                for (let i = 0; i < 4; i++)
                {
                    put(address + i, value >>> i * 8 & 0xff);
                }
            },
            /** @param {number} address */
            readU32: address=>(byte(address) | byte(address + 1) << 8 | byte(address + 2) << 16
                | byte(address + 3) << 24) >>> 0,
        },
    };
}

/**
 * The model: bytes in a map, regions as declared, every access checked byte
 * for byte, a value laid out little-endian by hand.
 */
function model(){
    /** @type {Map<number, number>} */
    const bytes = new Map();
    /** @param {number} at @param {'read' | 'write'} mode */
    const allows = (at, mode)=>REGIONS.some(region=>at >= region.base
        && at < region.base + region.size && (mode === 'read' || region.access.includes('w')));
    /** @param {number} at @param {number} length @param {'read' | 'write'} mode */
    const check = (at, length, mode)=>{
        for (let i = 0; i < length; i++)
        {
            if (!allows(at + i, mode))
            {
                throw Object.assign(new Error('fault'), { code: 'GUEST_ACCESS' });
            }
        }
    };
    /** @param {number} at @param {number} length */
    const read = (at, length)=>{
        check(at, length, 'read');
        return Uint8Array.from({ length }, (_, i)=>bytes.get(at + i) ?? 0);
    };
    /** @param {number} at @param {ArrayLike<number>} data */
    const write = (at, data)=>{
        check(at, data.length, 'write');
        for (let i = 0; i < data.length; i++)
        {
            bytes.set(at + i, data[i] & 0xff);
        }
    };
    /** @param {number} at @param {number} length */
    const unsigned = (at, length)=>read(at, length)
        .reduceRight((value, byte)=>value * 256 + byte, 0);
    /** @param {number} at @param {number} length */
    const big = (at, length)=>read(at, length)
        .reduceRight((value, byte)=>value << 8n | BigInt(byte), 0n);
    /** @param {number} value @param {number} length */
    const le = (value, length)=>Array.from({ length }, (_, i)=>Math.floor(value / 256 ** i) % 256);
    /** @param {bigint} value */
    const le64 = value=>Array.from({ length: 8 },
        (_, i)=>Number(BigInt.asUintN(64, value) >> BigInt(i * 8) & 0xffn));
    const view = new DataView(new ArrayBuffer(8));
    return {
        bytes,
        /** @param {number} at */
        u8: at=>unsigned(at, 1),
        /** @param {number} at */
        i8: at=>unsigned(at, 1) << 24 >> 24,
        /** @param {number} at */
        u16: at=>unsigned(at, 2),
        /** @param {number} at */
        i16: at=>unsigned(at, 2) << 16 >> 16,
        /** @param {number} at */
        u32: at=>unsigned(at, 4),
        /** @param {number} at */
        i32: at=>unsigned(at, 4) | 0,
        /** @param {number} at */
        u64: at=>big(at, 8),
        /** @param {number} at */
        i64: at=>BigInt.asIntN(64, big(at, 8)),
        /** @param {number} at */
        f32: at=>{
            view.setUint32(0, unsigned(at, 4), true);
            return view.getFloat32(0, true);
        },
        /** @param {number} at */
        f64: at=>{
            read(at, 8).forEach((byte, i)=>view.setUint8(i, byte));
            return view.getFloat64(0, true);
        },
        /** @param {number} width */
        // Rounded once past 2^53, where no address is.
        ptr: width=>(/** @type {number} */ at)=>Number(big(at, width)),
        /** @param {number} at @param {number} value */
        set8: (at, value)=>write(at, le(value >>> 0 & 0xff, 1)),
        /** @param {number} at @param {number} value */
        set16: (at, value)=>write(at, le(value & 0xffff, 2)),
        /** @param {number} at @param {number} value */
        set32: (at, value)=>write(at, le(value >>> 0, 4)),
        /** @param {number} at @param {bigint} value */
        set64: (at, value)=>write(at, le64(value)),
        /** @param {number} at @param {number} value */
        setF32: (at, value)=>{
            view.setFloat32(0, value, true);
            write(at, le(view.getUint32(0, true), 4));
        },
        /** @param {number} at @param {number} value */
        setF64: (at, value)=>{
            view.setFloat64(0, value, true);
            write(at, Array.from({ length: 8 }, (_, i)=>view.getUint8(i)));
        },
        /** @param {number} width */
        setPtr: width=>(/** @type {number} */ at, /** @type {number} */ value)=>
            write(at, le(value < 0 ? value >>> 0 : value, width)),
        /** Consecutive dwords, each stored on its own as a loop of stores does. */
        set32s: (/** @type {number} */ at, /** @type {number[]} */ values)=>{
            values.forEach((value, i)=>write(at + i * 4, le(value >>> 0, 4)));
            return at + values.length * 4;
        },
        snapshot: read,
        view: read,
        setBytes: write,
        /** @param {number} at @param {number} value @param {number} length */
        fill: (at, value, length)=>write(at, new Array(length).fill(value & 0xff)),
        /** @param {number} to @param {number} from @param {number} length */
        copy: (to, from, length)=>write(to, read(from, length)),
    };
}

const READS = ['u8', 'i8', 'u16', 'i16', 'u32', 'i32', 'u64', 'i64', 'f32', 'f64', 'ptr',
    'snapshot', 'view'];
const WRITES = ['set8', 'set16', 'set32', 'set64', 'setF32', 'setF64', 'setPtr', 'set32s',
    'setBytes', 'fill', 'copy'];

/**
 * An address at a region's edge or inside it, or in a gap, unaligned as often
 * as not.
 *
 * @param {() => number} next @param {4 | 8} width
 */
function addressOf(next, width){
    const regions = width === 8 ? REGIONS : REGIONS.filter(region=>region.base < 2 ** 32);
    const region = regions[next() % regions.length];
    const where = next() % 4;
    const offset = next() % 64;
    return where === 0 ? region.base + offset
        : where === 1 ? region.base + region.size - 1 - offset
            : where === 2 ? region.base - 1 - offset % 8
                : region.base + next() % region.size;
}

/**
 * A call's answer as it is compared: a fault by its code alone, bytes as a
 * list, a float by its bits.
 *
 * @param {() => any} call
 */
function answer(call){
    try
    {
        const value = call();
        if (value instanceof Uint8Array)
        {
            return [...value];
        }
        return typeof value === 'number' && Number.isNaN(value) ? 'NaN' : value;
    }
    catch (e){
        return `fault ${/** @type {any} */ (e).code}`;
    }
}

for (const width of /** @type {(4 | 8)[]} */ ([4, 8]))
{
    test(`gate: the port at ${width * 8} bits answers every access as memory does`, async()=>{
        for (let seed = 1; seed <= 40; seed++)
        {
            const next = random(seed * 7919 + width);
            const m = machine();
            const log = await testLog();
            const memory = await memoryModule.create({}, /** @type {any} */ ({
                requireApi: (/** @type {string} */ name)=>(name === 'log' ? log
                    : cpuForMemory(m.cpu)),
                provide: ()=>{},
            }));
            REGIONS.forEach(region=>memory.register(region));
            const port = memory.port(width);
            const reference = model();
            /** @type {Record<string, any>} */
            const ref = { ...reference, ptr: reference.ptr(width),
                setPtr: reference.setPtr(width) };
            for (let step = 0; step < 300; step++)
            {
                const at = addressOf(next, width);
                const writing = next() % 2 === 0;
                const op = writing ? WRITES[next() % WRITES.length] : READS[next() % READS.length];
                const length = 1 + next() % 24;
                const value = next() * (next() % 2 ? 1 : -1);
                /** @type {any[]} */
                const args = op === 'set64' ? [at, BigInt(value) << 16n | BigInt(next())]
                    : op === 'setF32' || op === 'setF64' ? [at, value / 3]
                        : op === 'set32s' ? [at, Array.from({ length: 1 + length % 4 }, next)]
                            : op === 'setBytes' ? [at, Uint8Array.from({ length }, next)]
                                : op === 'fill' ? [at, value, length]
                                    : op === 'copy' ? [at, addressOf(next, width), length]
                                        : op === 'snapshot' || op === 'view' ? [at, length]
                                            : writing ? [at, value] : [at];
                m.told.length = 0;
                const got = answer(()=>/** @type {any} */ (port)[op](...args));
                const expected = answer(()=>ref[op](...args));
                const label = `seed ${seed} step ${step}: ${op}(${args.map(String).join(', ')})`;
                assert.deepEqual(got, expected, label);
                // What a write left, a faulting one most of all: nothing of it, as the processor.
                for (let byte = at; byte < (writing ? at + 32 : at); byte++)
                {
                    assert.equal(answer(()=>port.u8(byte)), answer(()=>reference.u8(byte)),
                        `${label}: the byte at ${byte} after it`);
                }
                if (writing && typeof got !== 'string')
                {
                    // Code is written by the path the translator hears, all else by the data path.
                    const code = REGIONS.find(region=>region.access === 'rwx'
                        && at >= region.base && at < region.base + region.size);
                    assert.ok(m.told.length > 0, `${label}: the machine was told`);
                    assert.ok(m.told.every(said=>said.startsWith(code ? 'code' : 'data')),
                        `${label}: ${m.told.join('; ')}`);
                }
            }
            for (const [address, byte] of reference.bytes)
            {
                assert.equal(port.u8(address), byte, `seed ${seed}: the byte at ${address}`);
            }
            await memoryModule.dispose();
        }
    });
}
