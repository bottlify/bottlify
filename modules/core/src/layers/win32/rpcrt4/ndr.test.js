/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The format-string engine, one format character at a time, against the
 * layouts NDR gives them: every expected buffer below is written out from the
 * rules (a referent ID for a unique pointer, the counts before a conformant
 * string or array, pointees after what holds them, alignment of the buffer
 * pointer), not read back from the engine.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FC, POINTER, RPC_STATUS, RpcException, STUB_MESSAGE, createNdr } from './ndr.js';

const MESSAGE = 0x100;
const FORMAT = 0x400;
const BUFFER = 0x1000;
const DATA = 0x4000;
const HEAP = 0x10000;

/** The first two referent IDs, as the engine numbers them. */
const ID1 = [0x00, 0x00, 0x02, 0x00];
const ID2 = [0x04, 0x00, 0x02, 0x00];

/** An IID, in its memory order. */
const IID = [0x10, 0x2f, 0x5e, 0x8c, 0x1d, 0x4b, 0x7a, 0x4e,
    0x9a, 0x61, 0x3d, 0x2f, 0x0c, 0x9b, 0x7e, 0x01];

/** @param {number} value */
const le32 = value=>[value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24];

/**
 * A stub message, a buffer, a heap and an OBJREF maker in one small memory.
 *
 * @param {{ client?: boolean }} [options]
 */
function harness({ client = true } = {}){
    const memory = new Uint8Array(0x20000);
    const view = new DataView(memory.buffer);
    let top = HEAP;
    /** @type {number[]} */
    const made = [];
    /** @type {number[]} */
    const freed = [];
    /** @type {number[]} */
    const released = [];
    /** @type {string[]} */
    const said = [];
    /** @type {{ pointer: number, iid: number[] }[]} */
    const exported = [];
    /** @type {{ objref: number[], iid: number[] | null }[]} */
    const imported = [];
    const ndr = createNdr({
        readMemory: (address, length)=>memory.subarray(address, address + length),
        writeMemory: (address, bytes)=>memory.set(bytes, address),
        allocate: (_call, bytes)=>{
            const at = (top + 7) & ~7;
            top = at + bytes;
            made.push(at);
            return at;
        },
        free: (_call, address)=>{
            freed.push(address);
        },
        marshalInterface: async(_call, pointer, iid)=>{
            exported.push({ pointer, iid: [...iid] });
            return Uint8Array.of(0x4d, 0x45, 0x4f, 0x57, pointer & 0xff, 0, 0, 0);
        },
        unmarshalInterface: async(_call, objref, iid)=>{
            imported.push({ objref: [...objref], iid: iid && [...iid] });
            return 0x7a00 + objref[4];
        },
        releaseInterface: (_call, pointer)=>{
            released.push(pointer);
        },
        interfaceBytes: 8,
        divergence: detail=>{
            said.push(detail);
        },
    });
    const call = { message: MESSAGE };
    /** @param {number} offset */
    const field = offset=>view.getUint32(MESSAGE + offset, true);
    /** @param {number} offset @param {number} value */
    const setField = (offset, value)=>view.setUint32(MESSAGE + offset, value >>> 0, true);
    /** @param {boolean} isClient */
    const side = isClient=>{
        memory[MESSAGE + STUB_MESSAGE.IS_CLIENT] = isClient ? 1 : 0;
    };
    side(client);
    return {
        memory, ndr, call, made, freed, released, said, exported, imported, field, setField, side,
        /** @param {number} at */
        u32: at=>view.getUint32(at, true),
        /** @param {number} at @param {number} value */
        w32: (at, value)=>view.setUint32(at, value >>> 0, true),
        /** @param {number} at @param {number[]} bytes */
        place: (at, bytes)=>{
            memory.set(bytes, at);
            return at;
        },
        /**
         * The sizing pass and then the marshal, into a buffer exactly as long
         * as the sizing asked for.
         *
         * @param {number} value @param {number} format
         * @param {number} [misalign]  Bytes already in the buffer.
         */
        async marshalled(value, format, misalign = 0){
            ndr.begin(MESSAGE);
            setField(STUB_MESSAGE.BUFFER_LENGTH, misalign);
            await ndr.bufferSize(call, value, format);
            const length = field(STUB_MESSAGE.BUFFER_LENGTH);
            memory.fill(0xee, BUFFER, BUFFER + 0x400);
            setField(STUB_MESSAGE.BUFFER, BUFFER + misalign);
            setField(STUB_MESSAGE.BUFFER_START, BUFFER);
            setField(STUB_MESSAGE.BUFFER_END, BUFFER + length);
            await ndr.marshall(call, value, format);
            const used = field(STUB_MESSAGE.BUFFER) - BUFFER;
            return { length, bytes: [...memory.subarray(BUFFER + misalign, BUFFER + used)] };
        },
        /**
         * @param {number[]} bytes  What the buffer holds.
         * @param {number} ppMemory @param {number} format
         * @param {boolean} [mustAlloc]
         * @returns {Promise<number>} how much of the buffer was read
         */
        async unmarshalled(bytes, ppMemory, format, mustAlloc = false){
            memory.set(bytes, BUFFER);
            setField(STUB_MESSAGE.BUFFER, BUFFER);
            setField(STUB_MESSAGE.BUFFER_START, BUFFER);
            setField(STUB_MESSAGE.BUFFER_END, BUFFER + bytes.length);
            await ndr.unmarshall(call, ppMemory, format, mustAlloc);
            return field(STUB_MESSAGE.BUFFER) - BUFFER;
        },
    };
}

/**
 * @param {Promise<unknown>} work @param {number} code
 */
async function raises(work, code){
    await assert.rejects(work, (/** @type {unknown} */ e)=>e instanceof RpcException
        && e.code === code);
}

test('a base type crosses as its bytes, aligned to its own size in the buffer', async()=>{
    const h = harness();
    const small = h.place(FORMAT, [FC.SMALL]);
    const long = h.place(FORMAT + 1, [FC.LONG]);
    const hyper = h.place(FORMAT + 2, [FC.HYPER]);
    h.place(DATA, [0x7f]);
    h.w32(DATA + 4, 0x11223344);
    h.place(DATA + 8, [1, 2, 3, 4, 5, 6, 7, 8]);

    h.setField(STUB_MESSAGE.BUFFER_LENGTH, 0);
    await h.ndr.bufferSize(h.call, DATA, small);
    await h.ndr.bufferSize(h.call, DATA + 4, long);
    await h.ndr.bufferSize(h.call, DATA + 8, hyper);
    assert.equal(h.field(STUB_MESSAGE.BUFFER_LENGTH), 16, '1, padded to 4, 4, padded to 8, 8');

    h.memory.fill(0xee, BUFFER, BUFFER + 16);
    h.setField(STUB_MESSAGE.BUFFER, BUFFER);
    h.setField(STUB_MESSAGE.BUFFER_END, BUFFER + 16);
    await h.ndr.marshall(h.call, DATA, small);
    await h.ndr.marshall(h.call, DATA + 4, long);
    await h.ndr.marshall(h.call, DATA + 8, hyper);
    assert.deepEqual([...h.memory.subarray(BUFFER, BUFFER + 16)], [
        0x7f, 0, 0, 0, 0x44, 0x33, 0x22, 0x11, 1, 2, 3, 4, 5, 6, 7, 8,
    ], 'the padding is cleared');

    h.setField(STUB_MESSAGE.BUFFER, BUFFER);
    h.setField(STUB_MESSAGE.BUFFER_END, BUFFER + 16);
    h.ndr.simple(h.call, DATA + 0x20, FC.SMALL, 'unmarshall');
    h.ndr.simple(h.call, DATA + 0x24, FC.LONG, 'unmarshall');
    assert.equal(h.memory[DATA + 0x20], 0x7f);
    assert.equal(h.u32(DATA + 0x24), 0x11223344);
    assert.equal(h.field(STUB_MESSAGE.BUFFER), BUFFER + 8);
});

test('an enum16 is an int in memory and two bytes in the buffer, and no more than 0x7fff',
    async()=>{
        const h = harness();
        const format = h.place(FORMAT, [FC.ENUM16]);
        h.w32(DATA, 5);
        const { bytes } = await h.marshalled(DATA, format);
        assert.deepEqual(bytes, [5, 0]);
        h.w32(DATA + 8, 0xffffffff);
        h.w32(DATA + 12, DATA + 8);
        await h.unmarshalled([0x34, 0x12], DATA + 12, format);
        assert.equal(h.u32(DATA + 8), 0x1234, 'the whole int is written');
        h.w32(DATA, 0x8000);
        await raises(h.marshalled(DATA, format), RPC_STATUS.X_ENUM_VALUE_OUT_OF_RANGE);
    });

test('a unique pointer is a referent ID, zero for NULL, and what it points at after it',
    async()=>{
        const h = harness();
        const format = h.place(FORMAT, [FC.UP, POINTER.SIMPLE_POINTER, FC.LONG, FC.PAD]);
        h.w32(DATA, 0x11223344);
        assert.deepEqual(await h.marshalled(DATA, format),
            { length: 8, bytes: [...ID1, 0x44, 0x33, 0x22, 0x11] });
        assert.deepEqual(await h.marshalled(0, format), { length: 4, bytes: [0, 0, 0, 0] });

        h.w32(DATA + 0x10, 0);
        assert.equal(await h.unmarshalled([...ID1, 0x44, 0x33, 0x22, 0x11], DATA + 0x10, format),
            8);
        const pointee = h.u32(DATA + 0x10);
        assert.deepEqual(h.made, [pointee], 'the client allocates what it receives');
        assert.equal(h.u32(pointee), 0x11223344);
        await h.unmarshalled([0, 0, 0, 0], DATA + 0x10, format);
        assert.equal(h.u32(DATA + 0x10), 0, 'NULL comes back NULL');

        await h.ndr.free(h.call, pointee, format);
        assert.deepEqual(h.freed, [pointee]);
    });

test('a top-level reference pointer has no ID, and cannot be NULL', async()=>{
    const h = harness();
    const format = h.place(FORMAT, [FC.RP, POINTER.SIMPLE_POINTER, FC.SHORT, FC.PAD]);
    h.place(DATA, [0x34, 0x12]);
    assert.deepEqual(await h.marshalled(DATA, format), { length: 2, bytes: [0x34, 0x12] });
    await raises(h.marshalled(0, format), RPC_STATUS.X_NULL_REF_POINTER);
});

test('a conformant string is its maximum, offset and actual counts, then its characters',
    async()=>{
        const h = harness();
        const format = h.place(FORMAT, [FC.UP, POINTER.SIMPLE_POINTER, FC.C_CSTRING, FC.PAD]);
        h.place(DATA, [...'hello'].map(c=>c.charCodeAt(0)).concat(0));
        const wire = [...ID1, 6, 0, 0, 0, 0, 0, 0, 0, 6, 0, 0, 0, 0x68, 0x65, 0x6c, 0x6c, 0x6f, 0];
        assert.deepEqual(await h.marshalled(DATA, format), { length: 22, bytes: wire });

        // After a byte already in the buffer, the counts are aligned to four.
        const late = await h.marshalled(DATA, format, 1);
        assert.deepEqual(late.bytes, [0, 0, 0, ...wire]);

        h.side(false);
        h.w32(DATA + 0x20, 0);
        await h.unmarshalled(wire, DATA + 0x20, format);
        assert.equal(h.u32(DATA + 0x20), BUFFER + 16, 'a server reads it where it lies');
        assert.deepEqual(h.made, []);
        await h.ndr.free(h.call, h.u32(DATA + 0x20), format);
        assert.deepEqual(h.freed, [], 'and freeing it frees nothing');

        h.side(true);
        h.w32(DATA + 0x20, 0);
        await h.unmarshalled(wire, DATA + 0x20, format);
        const copy = h.u32(DATA + 0x20);
        assert.deepEqual(h.made, [copy], 'a client gets a copy of its own');
        assert.deepEqual([...h.memory.subarray(copy, copy + 6)], wire.slice(16));
    });

test('a wide string counts characters, not bytes', async()=>{
    const h = harness();
    const format = h.place(FORMAT, [FC.RP, POINTER.SIMPLE_POINTER, FC.C_WSTRING, FC.PAD]);
    h.place(DATA, [0x68, 0, 0x69, 0, 0, 0]);
    assert.deepEqual(await h.marshalled(DATA, format), { length: 18,
        bytes: [3, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0x68, 0, 0x69, 0, 0, 0] });
});

test('a sized string sends the size it was given as its maximum', async()=>{
    const h = harness();
    // size_is on a top-level parameter: the -Os stub sets MaxCount itself.
    const format = h.place(FORMAT, [FC.C_CSTRING, FC.STRING_SIZED, 0x20 | FC.LONG, 0, 0, 0]);
    h.place(DATA, [0x61, 0x62, 0]);
    h.setField(STUB_MESSAGE.MAX_COUNT, 10);
    const { bytes } = await h.marshalled(DATA, format);
    assert.deepEqual(bytes, [10, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0x61, 0x62, 0]);
    h.setField(STUB_MESSAGE.MAX_COUNT, 2);
    await raises(h.marshalled(DATA, format), RPC_STATUS.X_INVALID_BOUND);
});

test('a string whose counts disagree, or that has no terminator, is refused', async()=>{
    const h = harness();
    const format = h.place(FORMAT, [FC.C_CSTRING, FC.PAD]);
    h.w32(DATA, 0);
    await raises(h.unmarshalled([2, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0x61, 0x62, 0], DATA,
        format), RPC_STATUS.X_INVALID_BOUND);
    await raises(h.unmarshalled([3, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 0x61, 0], DATA, format),
        RPC_STATUS.X_INVALID_BOUND);
    await raises(h.unmarshalled([3, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0x61, 0x62, 0x63], DATA,
        format), RPC_STATUS.X_BAD_STUB_DATA);
    await raises(h.unmarshalled([9, 0, 0, 0, 0, 0, 0, 0, 9, 0, 0, 0, 0x61], DATA, format),
        RPC_STATUS.X_BAD_STUB_DATA);
});

test('a simple structure crosses as its bytes, where it lies on a server', async()=>{
    const h = harness();
    // FC_RP to FC_STRUCT, alignment 4, 8 bytes: two longs.
    const format = h.place(FORMAT, [FC.RP, 0, 2, 0,
        FC.STRUCT, 3, 8, 0, FC.LONG, FC.LONG, FC.PAD, FC.END]);
    const struct = FORMAT + 4;
    h.w32(DATA, 1);
    h.w32(DATA + 4, 2);
    const { bytes } = await h.marshalled(DATA, format, 2);
    assert.deepEqual(bytes, [0, 0, 1, 0, 0, 0, 2, 0, 0, 0], 'aligned to four, then copied');

    const wire = [...le32(10), ...le32(20)];
    h.side(false);
    h.w32(DATA + 0x10, 0);
    await h.unmarshalled(wire, DATA + 0x10, struct);
    assert.equal(h.u32(DATA + 0x10), BUFFER);
    await h.unmarshalled(wire, DATA + 0x10, struct, true);
    assert.notEqual(h.u32(DATA + 0x10), BUFFER, 'unless the stub asks for a copy');
    assert.equal(h.made.length, 1);

    h.side(true);
    h.w32(DATA + 0x10, DATA + 0x20);
    await h.unmarshalled(wire, DATA + 0x10, format);
    assert.equal(h.u32(DATA + 0x10), DATA + 0x20, 'a client fills the memory it named');
    assert.equal(h.u32(DATA + 0x24), 20);
});

/**
 * struct { long n; long *p; char *s; }: a pointer layout naming two unique
 * simple pointers at offsets 4 and 8.
 */
const PSTRUCT = [
    FC.PSTRUCT, 3, 12, 0,
    FC.PP, FC.PAD,
    FC.NO_REPEAT, FC.PAD, 4, 0, 4, 0, FC.UP, POINTER.SIMPLE_POINTER, FC.LONG, FC.PAD,
    FC.NO_REPEAT, FC.PAD, 8, 0, 8, 0, FC.UP, POINTER.SIMPLE_POINTER, FC.C_CSTRING, FC.PAD,
    FC.END,
    FC.LONG, FC.LONG, FC.LONG, FC.END,
];

test('a structure\'s pointers cross as IDs in its place, and what they point at after it',
    async()=>{
        const h = harness();
        const format = h.place(FORMAT, PSTRUCT);
        h.w32(DATA, 7);
        h.w32(DATA + 4, DATA + 0x20);
        h.w32(DATA + 8, DATA + 0x30);
        h.w32(DATA + 0x20, 0x55);
        h.place(DATA + 0x30, [0x61, 0x62, 0]);
        const wire = [
            7, 0, 0, 0, ...ID1, ...ID2,
            0x55, 0, 0, 0,
            3, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0x61, 0x62, 0,
        ];
        assert.deepEqual(await h.marshalled(DATA, format), { length: wire.length, bytes: wire });

        h.w32(DATA + 4, 0);
        assert.deepEqual((await h.marshalled(DATA, format)).bytes, [
            7, 0, 0, 0, 0, 0, 0, 0, ...ID1,
            3, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0x61, 0x62, 0,
        ], 'a NULL one is a zero ID and nothing after');

        h.w32(DATA + 0x40, 0);
        await h.unmarshalled(wire, DATA + 0x40, format);
        const made = h.u32(DATA + 0x40);
        assert.equal(h.u32(made), 7);
        assert.equal(h.u32(h.u32(made + 4)), 0x55, 'each pointer is one of this process');
        assert.deepEqual([...h.memory.subarray(h.u32(made + 8), h.u32(made + 8) + 3)],
            [0x61, 0x62, 0]);
        assert.equal(h.made.length, 3);

        await h.ndr.free(h.call, made, format);
        assert.deepEqual(h.freed, [h.u32(made + 4), h.u32(made + 8)],
            'freeing a structure frees what it points at, not the structure');
    });

test('a conformant array is its count and then its elements', async()=>{
    const h = harness();
    // Top-level size_is: the count is what the stub put in MaxCount.
    const format = h.place(FORMAT, [FC.CARRAY, 3, 4, 0, 0x20 | FC.LONG, 0, 0, 0,
        FC.LONG, FC.END]);
    h.place(DATA, [...le32(1), ...le32(2), ...le32(3)]);
    h.setField(STUB_MESSAGE.MAX_COUNT, 3);
    assert.deepEqual(await h.marshalled(DATA, format),
        { length: 16, bytes: [3, 0, 0, 0, ...le32(1), ...le32(2), ...le32(3)] });

    h.side(false);
    h.w32(DATA + 0x20, 0);
    await h.unmarshalled([2, 0, 0, 0, 9, 0, 0, 0, 8, 0, 0, 0], DATA + 0x20, format);
    assert.equal(h.u32(DATA + 0x20), BUFFER + 4);
    await raises(h.unmarshalled([9, 0, 0, 0, 1, 0, 0, 0], DATA + 0x20, format),
        RPC_STATUS.X_BAD_STUB_DATA);
});

test('a conformance in the structure that holds the pointer is read from that structure',
    async()=>{
        const h = harness();
        // struct { long n; [size_is(n)] long *values; }
        const format = h.place(FORMAT, [
            FC.PSTRUCT, 3, 8, 0,
            FC.PP, FC.PAD,
            FC.NO_REPEAT, FC.PAD, 4, 0, 4, 0, FC.UP, 0, 6, 0,
            FC.END,
            FC.LONG, FC.LONG, FC.END,
            // at 20: the array, counted by the long at offset 0 of the structure
            FC.CARRAY, 3, 4, 0, 0x10 | FC.LONG, 0, 0, 0, FC.LONG, FC.END,
        ]);
        h.w32(DATA, 2);
        h.w32(DATA + 4, DATA + 0x10);
        h.place(DATA + 0x10, [...le32(0xa), ...le32(0xb)]);
        const wire = [2, 0, 0, 0, ...ID1, 2, 0, 0, 0, ...le32(0xa), ...le32(0xb)];
        assert.deepEqual(await h.marshalled(DATA, format), { length: 20, bytes: wire });

        h.w32(DATA + 0x40, 0);
        await h.unmarshalled(wire, DATA + 0x40, format);
        const made = h.u32(DATA + 0x40);
        assert.equal(h.u32(h.u32(made + 4) + 4), 0xb);
    });

test('a correlation can be a constant, or a field changed by its operator', async()=>{
    const h = harness();
    const constant = h.place(FORMAT, [FC.CARRAY, 0, 1, 0, 0x40, 0, 3, 0, FC.BYTE, FC.END]);
    h.place(DATA, [0x61, 0x62, 0x63]);
    assert.deepEqual((await h.marshalled(DATA, constant)).bytes, [3, 0, 0, 0, 0x61, 0x62, 0x63]);

    // struct { short n; [size_is(n + 1)] char *p; } -- FC_ADD_1 on a short.
    const added = h.place(FORMAT + 0x20, [
        FC.PSTRUCT, 3, 8, 0,
        FC.PP, FC.PAD,
        FC.NO_REPEAT, FC.PAD, 4, 0, 4, 0, FC.UP, 0, 6, 0,
        FC.END,
        FC.SHORT, FC.LONG, FC.END,
        FC.CARRAY, 0, 1, 0, 0x10 | FC.SHORT, FC.ADD_1, 0, 0, FC.BYTE, FC.END,
    ]);
    h.place(DATA + 0x10, [1, 0, 0, 0, ...le32(DATA)]);
    assert.deepEqual((await h.marshalled(DATA + 0x10, added)).bytes,
        [1, 0, 0, 0, ...ID1, 2, 0, 0, 0, 0x61, 0x62]);
});

test('a conformant varying array sends the elements in its range', async()=>{
    const h = harness();
    const format = h.place(FORMAT, [FC.CVARRAY, 3, 4, 0,
        0x20 | FC.LONG, 0, 0, 0, 0x20 | FC.LONG, 0, 0, 0, FC.LONG, FC.END]);
    h.place(DATA, [...le32(1), ...le32(2), ...le32(3), ...le32(4), ...le32(5)]);
    h.setField(STUB_MESSAGE.MAX_COUNT, 5);
    h.setField(STUB_MESSAGE.OFFSET, 1);
    h.setField(STUB_MESSAGE.ACTUAL_COUNT, 2);
    const wire = [5, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, ...le32(2), ...le32(3)];
    assert.deepEqual(await h.marshalled(DATA, format), { length: 20, bytes: wire });

    h.w32(DATA + 0x40, 0);
    await h.unmarshalled(wire, DATA + 0x40, format);
    const made = h.u32(DATA + 0x40);
    assert.equal(h.made.length, 1);
    assert.deepEqual([h.u32(made + 4), h.u32(made + 8)], [2, 3], 'at the offset it was sent from');

    h.setField(STUB_MESSAGE.ACTUAL_COUNT, 5);
    await raises(h.marshalled(DATA, format), RPC_STATUS.X_INVALID_BOUND);
});

test('a fixed array is its bytes, aligned', async()=>{
    const h = harness();
    const format = h.place(FORMAT, [FC.SMFARRAY, 1, 6, 0, FC.SHORT, FC.END]);
    h.place(DATA, [1, 0, 2, 0, 3, 0]);
    const { bytes } = await h.marshalled(DATA, format, 1);
    assert.deepEqual(bytes, [0, 1, 0, 2, 0, 3, 0]);
});

test('an array of structures names each element\'s pointers by repeating them', async()=>{
    const h = harness();
    // struct { long *p; } items[2]: a fixed repeat of one pointer, every 4 bytes.
    const format = h.place(FORMAT, [FC.SMFARRAY, 3, 8, 0,
        FC.PP, FC.PAD,
        FC.FIXED_REPEAT, FC.PAD, 2, 0, 4, 0, 0, 0, 1, 0,
        0, 0, 0, 0, FC.UP, POINTER.SIMPLE_POINTER, FC.LONG, FC.PAD,
        FC.END,
        FC.LONG, FC.END]);
    h.w32(DATA, DATA + 0x10);
    h.w32(DATA + 4, DATA + 0x14);
    h.w32(DATA + 0x10, 0xaa);
    h.w32(DATA + 0x14, 0xbb);
    assert.deepEqual((await h.marshalled(DATA, format)).bytes,
        [...ID1, ...ID2, 0xaa, 0, 0, 0, 0xbb, 0, 0, 0]);
});

test('full pointers to the same memory cross once, and come back as one pointer', async()=>{
    const h = harness();
    const format = h.place(FORMAT, [
        FC.PSTRUCT, 3, 8, 0,
        FC.PP, FC.PAD,
        FC.NO_REPEAT, FC.PAD, 0, 0, 0, 0, FC.FP, POINTER.SIMPLE_POINTER, FC.LONG, FC.PAD,
        FC.NO_REPEAT, FC.PAD, 4, 0, 4, 0, FC.FP, POINTER.SIMPLE_POINTER, FC.LONG, FC.PAD,
        FC.END,
        FC.LONG, FC.LONG, FC.END,
    ]);
    h.w32(DATA, DATA + 0x10);
    h.w32(DATA + 4, DATA + 0x10);
    h.w32(DATA + 0x10, 0x99);
    const wire = [...ID1, ...ID1, 0x99, 0, 0, 0];
    assert.deepEqual(await h.marshalled(DATA, format), { length: 12, bytes: wire });

    h.ndr.begin(MESSAGE);
    h.w32(DATA + 0x40, 0);
    await h.unmarshalled(wire, DATA + 0x40, format);
    const made = h.u32(DATA + 0x40);
    assert.equal(h.u32(made), h.u32(made + 4));
    assert.equal(h.u32(h.u32(made)), 0x99);
});

test('an interface pointer is a unique pointer to the OBJREF ole32 made for it', async()=>{
    const h = harness();
    const format = h.place(FORMAT, [FC.IP, FC.CONSTANT_IID, ...IID]);
    const wire = [...ID1, 8, 0, 0, 0, 8, 0, 0, 0, 0x4d, 0x45, 0x4f, 0x57, 0x23, 0, 0, 0];
    assert.deepEqual(await h.marshalled(0x7123, format), { length: 20, bytes: wire });
    assert.deepEqual(h.exported.at(-1), { pointer: 0x7123, iid: IID });
    assert.deepEqual(await h.marshalled(0, format), { length: 4, bytes: [0, 0, 0, 0] });

    h.w32(DATA, 0);
    await h.unmarshalled(wire, DATA, format);
    assert.equal(h.u32(DATA), 0x7a23);
    assert.deepEqual(h.imported, [{ objref: wire.slice(12), iid: null }],
        'the interface is the one the OBJREF carries');
    await h.ndr.free(h.call, 0x7a23, format);
    assert.deepEqual(h.released, [0x7a23], 'freeing one is a Release');

    const lying = [...wire];
    lying[4] = 9;
    await raises(h.unmarshalled(lying, DATA, format), RPC_STATUS.X_BAD_STUB_DATA);
});

test('iid_is names the interface through the IID a parameter points at', async()=>{
    const h = harness();
    const format = h.place(FORMAT, [FC.IP, FC.PAD, 0x20 | FC.LONG, 0, 0, 0]);
    const iid = h.place(DATA + 0x80, IID);
    h.setField(STUB_MESSAGE.MAX_COUNT, iid);
    await h.marshalled(0x7123, format);
    assert.deepEqual(h.exported.at(-1)?.iid, IID);
});

test('an iid_is interface pointer unmarshals with no IID set, as the OBJREF names it', async()=>{
    // Generated -Os code sets MaxCount to the IID only before sizing and
    // marshalling; an unmarshal that required it refused every such pointer
    // arriving with RPC_X_NULL_REF_POINTER.
    const h = harness();
    const format = h.place(FORMAT, [FC.IP, FC.PAD, 0x20 | FC.LONG, 0, 0, 0]);
    h.setField(STUB_MESSAGE.MAX_COUNT, 0);
    const wire = [...ID1, 8, 0, 0, 0, 8, 0, 0, 0, 0x4d, 0x45, 0x4f, 0x57, 0x31, 0, 0, 0];
    h.w32(DATA, 0);
    await h.unmarshalled(wire, DATA, format);
    assert.equal(h.u32(DATA), 0x7a31);
    assert.deepEqual(h.imported, [{ objref: wire.slice(12), iid: null }]);
});

test('an [out] interface pointer is a reference to a pointer that is dereferenced', async()=>{
    const h = harness({ client: false });
    // FC_RP [alloced_on_stack] [pointer_deref] to FC_IP, as a stub's IFoo ** is.
    const format = h.place(FORMAT, [FC.RP, POINTER.ALLOCED_ON_STACK | POINTER.DEREF, 2, 0,
        FC.IP, FC.CONSTANT_IID, ...IID]);
    h.w32(DATA, 0x7145);
    const { bytes } = await h.marshalled(DATA, format);
    assert.deepEqual(bytes, [...ID1, 8, 0, 0, 0, 8, 0, 0, 0,
        0x4d, 0x45, 0x4f, 0x57, 0x45, 0, 0, 0]);
    await h.ndr.free(h.call, DATA, format);
    assert.deepEqual(h.released, [0x7145], 'the stub\'s reference goes once it has crossed');
    assert.deepEqual(h.freed, [], 'the slot is the stub\'s own');

    h.side(true);
    h.w32(DATA + 0x10, DATA + 0x20);
    await h.unmarshalled(bytes, DATA + 0x10, format);
    assert.equal(h.u32(DATA + 0x20), 0x7a45, 'written through the caller\'s pointer');
});

test('an [out] string pointer is a pointer to a unique pointer to the string', async()=>{
    const h = harness();
    const format = h.place(FORMAT, [FC.RP, POINTER.DEREF, 2, 0,
        FC.UP, POINTER.SIMPLE_POINTER, FC.C_CSTRING, FC.PAD]);
    h.w32(DATA, DATA + 0x10);
    h.place(DATA + 0x10, [0x78, 0]);
    const { bytes } = await h.marshalled(DATA, format);
    assert.deepEqual(bytes, [...ID1, 2, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0x78, 0]);

    h.w32(DATA + 0x20, DATA + 0x30);
    h.w32(DATA + 0x30, 0);
    await h.unmarshalled(bytes, DATA + 0x20, format);
    const string = h.u32(DATA + 0x30);
    assert.deepEqual([...h.memory.subarray(string, string + 2)], [0x78, 0]);
});

test('a failed call clears its [out] parameters, freeing only what its unmarshal made',
    async()=>{
        const h = harness();
        const iface = h.place(FORMAT, [FC.RP, POINTER.DEREF, 2, 0,
            FC.IP, FC.CONSTANT_IID, ...IID]);
        h.w32(DATA, 0xdeadbeef);
        await h.ndr.clearOut(h.call, iface, DATA);
        assert.equal(h.u32(DATA), 0, 'what the caller\'s variable held is cleared');
        assert.deepEqual(h.released, [], 'and not released: it was never ours');

        const wire = [...ID1, 8, 0, 0, 0, 8, 0, 0, 0, 0x4d, 0x45, 0x4f, 0x57, 0x31, 0, 0, 0];
        h.w32(DATA + 0x10, DATA);
        await h.unmarshalled(wire, DATA + 0x10, iface);
        await h.ndr.clearOut(h.call, iface, DATA);
        assert.deepEqual(h.released, [0x7a31], 'what the unmarshal made is released');
        assert.equal(h.u32(DATA), 0);

        const long = h.place(FORMAT + 0x40, [FC.RP, POINTER.ALLOCED_ON_STACK
            | POINTER.SIMPLE_POINTER, FC.LONG, FC.PAD]);
        h.w32(DATA + 0x20, 0x1234);
        await h.ndr.clearOut(h.call, long, DATA + 0x20);
        assert.equal(h.u32(DATA + 0x20), 0);

        const struct = h.place(FORMAT + 0x60, [FC.RP, 0, 2, 0,
            FC.STRUCT, 3, 8, 0, FC.LONG, FC.LONG, FC.PAD, FC.END]);
        h.w32(DATA + 0x30, 1);
        h.w32(DATA + 0x34, 2);
        await h.ndr.clearOut(h.call, struct, DATA + 0x30);
        assert.deepEqual([h.u32(DATA + 0x30), h.u32(DATA + 0x34)], [0, 0]);
    });

test('what is not implemented says so and fails as RPC_S_CANNOT_SUPPORT', async()=>{
    const h = harness();
    const bogus = h.place(FORMAT, [FC.BOGUS_STRUCT, 3, 8, 0, 0, 0, 0, 0]);
    await raises(h.marshalled(DATA, bogus), RPC_STATUS.S_CANNOT_SUPPORT);
    assert.match(h.said[0], /0x1a/);

    const callback = h.place(FORMAT + 0x10, [FC.CARRAY, 0, 1, 0, 0x10 | FC.LONG, FC.CALLBACK,
        0, 0, FC.BYTE, FC.END]);
    await raises(h.marshalled(DATA, callback), RPC_STATUS.S_CANNOT_SUPPORT);
    assert.equal(h.said.length, 2);
});

test('an unmarshal that runs past the buffer fails as bad stub data', async()=>{
    const h = harness();
    const format = h.place(FORMAT, [FC.UP, POINTER.SIMPLE_POINTER, FC.LONG, FC.PAD]);
    h.w32(DATA, 0);
    await raises(h.unmarshalled([...ID1, 1, 2], DATA, format), RPC_STATUS.X_BAD_STUB_DATA);
    const reference = h.place(FORMAT + 8, [FC.PSTRUCT, 3, 4, 0,
        FC.PP, FC.PAD, FC.NO_REPEAT, FC.PAD, 0, 0, 0, 0, FC.RP, POINTER.SIMPLE_POINTER,
        FC.LONG, FC.PAD, FC.END, FC.LONG, FC.END]);
    h.w32(DATA, 0);
    await raises(h.unmarshalled([0, 0, 0, 0], DATA, reference), RPC_STATUS.X_BAD_STUB_DATA);
});
