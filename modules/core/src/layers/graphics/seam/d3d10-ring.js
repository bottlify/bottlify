/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A Direct3D 10 device's command ring, the host's side: the device's block
 * in guest memory (`shadow.js`'s layout, of which this uses the ring's words,
 * the host's flag and the lock), the ring after it, and the reader that
 * makes what the guest's routines (`d3d10-inguest.js`) wrote, in order, on
 * the device -- one call, `commands`, for a run, which a recording sends as
 * one call and its twin plays as the same calls.
 *
 * The host makes the ring's calls on its way into any method of its own
 * (`sync`): a call the program made after them then meets them made. And
 * before a count is read or lowered on the host, since a record may name the
 * object.
 */

import {
    COMMAND_RING_BYTES, FLAG_SLOW_PATH, HELD_HOST, SHADOW, createCommandReader, placeCommandRing,
} from './shadow.js';
import { D3D10_COMMANDS } from '../d3d10/commands.js';

const PAGE = 4096;

/**
 * Byte offsets within a dynamic buffer's block (`d3d10-inguest.js`,
 * `BufferMap`): the host's flag, the device's block, the storage the buffer
 * is on, its length, the map the guest holds (its type, 0 for none), how
 * many storages it has, which of them the host has let go of (a bit each),
 * and their addresses.
 */
export const BUFFER10 = Object.freeze({
    FLAGS: 0, DEVICE: 4, CURRENT: 8, LENGTH: 12, MAPPED: 16, COUNT: 20, FREE: 24, STORAGES: 28,
    MOST: 32, SIZE: 28 + 32 * 4,
});

/** The bytes of storages a buffer may be given in all: past it, its DISCARDs trap. */
const STORAGE_BYTES = 4 * 1024 * 1024;

/** D3D10_MAP_WRITE_DISCARD. */
const MAP_WRITE_DISCARD = 4;

/** How long the host waits for a routine on another executor to let the device go. */
const HELD_WAIT_MS = 200;

/**
 * @typedef {Object} RingMemory
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number) => number} readU32
 * @property {(address: number, expected: number, value: number) => number} [compareExchangeU32]
 * @property {(address: number) => number} [loadU32]
 */

/**
 * @param {Object} deps
 * @param {(bytes: number) => number} deps.allocate  guest memory, 0 when there is none
 * @param {RingMemory} deps.memory
 * @param {any} deps.device  the device whose calls the records are
 * @param {(pointer: number) => any} deps.objectAt  what a pointer the guest passed is
 * @param {(detail: string) => void} deps.refuse
 * @param {number} [deps.ringBytes]
 * @returns {{ address: () => number, sync: () => void, taken: () => number,
 *     attachBuffer: (buffer: any) => number, hostMap: (buffer: any, type: number) => void,
 *     hostUnmap: (buffer: any) => boolean, released: (buffer: any) => void } | null}
 *     null where there is no memory for one
 */
export function createDeviceRing(deps){
    const { memory, device, objectAt, refuse } = deps;
    const ringBytes = deps.ringBytes ?? COMMAND_RING_BYTES;
    // Pages of their own: a write near translated code drops what the
    // translator made of it, and the routines write the block every call.
    /** @param {number} bytes */
    const pages = bytes=>{
        const span = deps.allocate(bytes + PAGE);
        return span === 0 ? 0 : (span + PAGE - 1) & ~(PAGE - 1);
    };
    const block = pages(SHADOW.SIZE);
    const ring = block === 0 ? 0 : pages(ringBytes);
    if (block === 0 || ring === 0)
    {
        return null;
    }
    memory.writeMemory(block, new Uint8Array(SHADOW.SIZE));
    placeCommandRing(block, ring, memory.writeMemory, ringBytes);
    const reader = createCommandReader({
        block,
        ring,
        bytes: ringBytes,
        readWord: memory.readU32,
        readWords: (address, words)=>{
            const bytes = memory.readMemory(address, words * 4);
            return new Uint32Array(bytes.buffer.slice(bytes.byteOffset,
                bytes.byteOffset + words * 4));
        },
        writeMemory: memory.writeMemory,
        compareExchangeU32: memory.compareExchangeU32,
        loadU32: memory.loadU32,
        take: records=>{
            noteUnmaps(records);
            return device.commands(records, D3D10_COMMANDS.commandObjects(records, objectAt));
        },
        refuse,
    });

    /**
     * Each dynamic buffer's block, and the storage the host last took an
     * unmap of: the guest may move the buffer off the storages before it.
     *
     * @type {WeakMap<object, { block: number, last: number }>}
     */
    const buffers = new WeakMap();
    /** Blocks are carved out of pages of their own. */
    let pool = { at: 0, left: 0 };
    /** @param {number} address */
    const read = address=>memory.readU32(address);
    /** @param {number} address @param {number} value */
    const write = (address, value)=>memory.writeMemory(address, word(value >>> 0));
    /** @param {number} at  a buffer's block @param {number} base  one of its storages */
    const indexOf = (at, base)=>{
        const count = read(at + BUFFER10.COUNT);
        for (let index = 0; index < count; index++)
        {
            if (read(at + BUFFER10.STORAGES + index * 4) === base)
            {
                return index;
            }
        }
        return -1;
    };
    const unmapSlot = D3D10_COMMANDS.commandSlot('Buffer.Unmap');
    /**
     * The unmaps a run carries, in order: each lets go of the storage the
     * buffer was on before (the guest moved off it, and nothing after this
     * record reads it), which a DISCARD in the guest may then take.
     *
     * @param {Uint8Array} records
     */
    const noteUnmaps = records=>{
        const all = new Uint32Array(records.buffer, records.byteOffset, records.byteLength >>> 2);
        for (let at = 0; at < all.length;)
        {
            const length = all[at + 1] >>> 2;
            if (length === 0)
            {
                break;
            }
            if (all[at] === unmapSlot)
            {
                const held = buffers.get(objectAt(all[at + 2]));
                const storage = all[at + 3];
                if (held && storage !== held.last)
                {
                    const index = indexOf(held.block, held.last);
                    if (index >= 0)
                    {
                        write(held.block + BUFFER10.FREE,
                            read(held.block + BUFFER10.FREE) | (1 << index));
                    }
                    held.last = storage;
                }
            }
            at += length;
        }
    };
    /** @param {number} value */
    const word = value=>new Uint8Array(new Uint32Array([value]).buffer);
    let holds = 0;
    /**
     * The device's lock, taken for the host while it reads the ring: a
     * routine on another executor may be writing a record.
     */
    const hold = ()=>{
        if (holds++ !== 0 || memory.compareExchangeU32 === undefined)
        {
            return;
        }
        const at = block + SHADOW.HELD;
        const from = performance.now();
        while (memory.compareExchangeU32(at, 0, HELD_HOST) !== 0)
        {
            if (performance.now() - from > HELD_WAIT_MS)
            {
                memory.writeMemory(at, word(HELD_HOST));
                refuse(`a routine held the device past ${HELD_WAIT_MS} ms -- a thread that`
                    + ' faulted inside one: taken from it');
                break;
            }
        }
    };
    const letGo = ()=>{
        if (--holds !== 0 || memory.compareExchangeU32 === undefined)
        {
            return;
        }
        const at = block + SHADOW.HELD;
        for (let was = memory.readU32(at); ;)
        {
            const seen = memory.compareExchangeU32(at, was, 0);
            if (seen === was)
            {
                break;
            }
            was = seen;
        }
    };
    return {
        address: ()=>block,
        /**
         * A dynamic buffer's block, made for one whose bytes live in guest
         * memory, before the buffer is published: what the guest's map and
         * unmap read and write.
         *
         * @param {any} buffer
         * @returns {number} the block, 0 for none
         */
        attachBuffer(buffer){
            const base = buffer.base;
            const length = buffer.length;
            if (typeof base !== 'number' || typeof length !== 'number')
            {
                return 0;
            }
            if (pool.left < BUFFER10.SIZE)
            {
                const at = pages(PAGE);
                pool = { at, left: at === 0 ? 0 : PAGE };
                if (at === 0)
                {
                    return 0;
                }
            }
            const at = pool.at;
            pool = { at: at + BUFFER10.SIZE, left: pool.left - BUFFER10.SIZE };
            const words = new Uint32Array(BUFFER10.SIZE >>> 2);
            words[BUFFER10.DEVICE >>> 2] = block;
            words[BUFFER10.CURRENT >>> 2] = base;
            words[BUFFER10.LENGTH >>> 2] = length;
            words[BUFFER10.COUNT >>> 2] = 1;
            words[BUFFER10.STORAGES >>> 2] = base;
            memory.writeMemory(at, new Uint8Array(words.buffer));
            buffers.set(buffer, { block: at, last: base });
            return at;
        },
        /**
         * A buffer the program let go of: its storages go back with it, so
         * a pointer to it handed out again maps on the host.
         *
         * @param {any} buffer
         */
        released(buffer){
            const held = buffers.get(buffer);
            if (held)
            {
                write(held.block + BUFFER10.FLAGS, FLAG_SLOW_PATH);
            }
        },
        /**
         * A map the host makes: a DISCARD the guest could not make, for want
         * of a storage let go of, gives the buffer one more, so the next can.
         * The ring was played first, so the buffer is on the storage it is --
         * and the storages its unmaps held are free again by now, which is
         * why their being free says nothing: the guest ran out of them before
         * the host played the ring, and a buffer of two storages would
         * otherwise trap every other DISCARD for good.
         *
         * @param {any} buffer @param {number} type
         */
        hostMap(buffer, type){
            const held = buffers.get(buffer);
            if (!held || type !== MAP_WRITE_DISCARD)
            {
                return;
            }
            hold();
            try
            {
                const count = read(held.block + BUFFER10.COUNT);
                if (count >= BUFFER10.MOST
                    || (count + 1) * read(held.block + BUFFER10.LENGTH) > STORAGE_BYTES)
                {
                    return;
                }
                const base = buffer.AddStorage();
                if (base !== 0)
                {
                    write(held.block + BUFFER10.STORAGES + count * 4, base);
                    write(held.block + BUFFER10.COUNT, count + 1);
                    write(held.block + BUFFER10.FREE,
                        (read(held.block + BUFFER10.FREE) | (1 << count)) >>> 0);
                }
            }
            finally
            {
                letGo();
            }
        },
        /**
         * An unmap the host takes of a map the guest made, its ring full when
         * it unmapped: made here, as the ring's record would have made it.
         *
         * @param {any} buffer
         * @returns {boolean} whether it was the guest's map
         */
        hostUnmap(buffer){
            const held = buffers.get(buffer);
            const type = held ? read(held.block + BUFFER10.MAPPED) : 0;
            if (!held || type === 0)
            {
                return false;
            }
            hold();
            try
            {
                const storage = read(held.block + BUFFER10.CURRENT);
                write(held.block + BUFFER10.MAPPED, 0);
                if (storage !== held.last)
                {
                    const index = indexOf(held.block, held.last);
                    if (index >= 0)
                    {
                        write(held.block + BUFFER10.FREE,
                            read(held.block + BUFFER10.FREE) | (1 << index));
                    }
                    held.last = storage;
                }
                buffer.UnmapStorage(storage, type);
            }
            finally
            {
                letGo();
            }
            return true;
        },
        sync(){
            hold();
            try
            {
                reader.take();
            }
            finally
            {
                letGo();
            }
        },
        taken: ()=>reader.taken(),
    };
}
