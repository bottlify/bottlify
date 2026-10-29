/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * shlwapi's data block lists -- the extra data a shell link and a folder's
 * view state carry -- and the IStream helpers they are read and written
 * with.
 *
 * A list is one block of LocalAlloc's: DATABLOCK_HEADERs end to end, each its
 * cbSize long, then a DWORD of zero. A block whose size is no multiple of
 * four is kept inside a container of its own -- a header of signature ~0
 * sized to the next multiple, then the block -- so every header in the list
 * stays aligned; SHFindDataBlock answers the block, never the container
 * (Wine's shlwapi:clist).
 *
 * The streams are the program's own objects, so their methods are called
 * as the guest calls them, one step at a time.
 */

import { dword } from './text.js';

/** Each is [ordinal, name]. @type {readonly (readonly [number, string])[]} */
export const DATABLOCK_ORDINALS = Object.freeze([
    [17, 'SHWriteDataBlockList'], [18, 'SHReadDataBlockList'], [19, 'SHFreeDataBlockList'],
    [20, 'SHAddDataBlock'], [21, 'SHRemoveDataBlock'], [22, 'SHFindDataBlock'],
    [23, 'SHStringFromGUIDA'], [24, 'SHStringFromGUIDW'], [166, 'SHIsEmptyStream'],
    [184, 'IStream_Read'], [212, 'IStream_Write'], [213, 'IStream_Reset'], [214, 'IStream_Size'],
]);

const S_OK = 0;
const E_FAIL = 0x80004005 | 0;
const E_INVALIDARG = 0x80070057 | 0;
const E_OUTOFMEMORY = 0x8007000e | 0;
const STG_E_MEDIUMFULL = 0x80030070 | 0;

/** A container's signature. */
const CONTAINER = 0xffffffff;
const HEADER = 8;
/** The largest block SHReadDataBlockList takes in; a larger one is passed over. */
const MOST_BLOCK = 0xffff;
const LMEM_ZEROINIT = 0x40;

/** IStream's slots, IUnknown's three first. */
const READ = 3;
const WRITE = 4;
const SEEK = 5;
const STAT = 12;
const STATSTG_SIZE = 72;
const STATFLAG_NONAME = 1;
const STREAM_SEEK_SET = 0;
const STREAM_SEEK_CUR = 1;

/**
 * @typedef {Object} DataBlockHost
 * @property {(address: number, length: number) => Uint8Array} [readMemory]
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(bytes: number) => number} [allocate]
 * @property {(address: number) => void} [free]
 * @property {(library: string) => Record<string, { handler: (args: number[]) => any }>
 *     | undefined} [library]
 * @property {(steps: Generator<{ entry: number, args: number[] }, any, number>) => any} [drive]
 */

/** @param {Uint8Array} bytes @param {number} [at] */
const u32 = (bytes, at = 0)=>new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .getUint32(at, true);

/**
 * A block's bytes as the list stores it: itself, or inside a container when
 * its size is no multiple of four.
 *
 * @param {Uint8Array} block
 */
export function stored(block){
    if (block.length % 4 === 0)
    {
        return block;
    }
    const size = HEADER + ((block.length + 3) & ~3);
    const container = new Uint8Array(size);
    container.set(dword(size), 0);
    container.set(dword(CONTAINER), 4);
    container.set(block, HEADER);
    return container;
}

/**
 * The blocks of a list's bytes, each as it was added: a container's inside.
 *
 * @param {Uint8Array} bytes  The list, its terminator included.
 * @returns {{ at: number, block: Uint8Array, entry: number, size: number }[]}
 *     where each stored entry starts, its size, and the block in it
 */
export function blocksOf(bytes){
    const out = [];
    for (let at = 0; at + 4 <= bytes.length;)
    {
        const size = u32(bytes, at);
        if (size < HEADER || at + size > bytes.length)
        {
            break;
        }
        const inner = u32(bytes, at + 4) === CONTAINER
            ? at + HEADER : at;
        const blockSize = inner === at ? size : u32(bytes, inner);
        out.push({ at: inner, block: bytes.slice(inner, inner + blockSize), entry: at, size });
        at += size;
    }
    return out;
}

/**
 * @param {DataBlockHost} host
 */
export function createDataBlockFunctions(host){
    /** @param {number} address @param {number} length */
    const read = (address, length)=>(host.readMemory
        ? host.readMemory(address >>> 0, length).slice() : new Uint8Array(length));
    /** @param {number} address */
    const readU32 = address=>u32(read(address, 4));
    /**
     * kernel32's own call, made at once: the heap's are not ones that wait.
     *
     * @param {string} name @param {number[]} args
     */
    const kernel32 = (name, args)=>{
        const answer = host.library?.('KERNEL32.dll')?.[name]?.handler(args);
        return typeof answer === 'number' ? answer >>> 0 : 0;
    };

    /** A list's bytes, read to its terminator. @param {number} list */
    const listBytes = list=>{
        let at = list >>> 0;
        for (let size = readU32(at); size >= HEADER; size = readU32(at))
        {
            at += size;
        }
        return read(list, at - (list >>> 0) + 4);
    };

    /**
     * The list replaced by one of these blocks, freed when there are none.
     *
     * @param {number} slot  Where the caller keeps its list.
     * @param {Uint8Array[]} blocks
     */
    const replaceList = (slot, blocks)=>{
        const old = readU32(slot);
        if (blocks.length === 0)
        {
            if (old)
            {
                kernel32('LocalFree', [old]);
            }
            host.writeMemory(slot >>> 0, dword(0));
            return true;
        }
        const entries = blocks.map(stored);
        const total = entries.reduce((sum, entry)=>sum + entry.length, 0) + 4;
        const made = kernel32('LocalAlloc', [LMEM_ZEROINIT, total]);
        if (!made)
        {
            return false;
        }
        let at = made;
        for (const entry of entries)
        {
            host.writeMemory(at, entry);
            at += entry.length;
        }
        host.writeMemory(at, dword(0));
        if (old)
        {
            kernel32('LocalFree', [old]);
        }
        host.writeMemory(slot >>> 0, dword(made));
        return true;
    };
    /** @param {number} slot */
    const blocksIn = slot=>{
        const list = readU32(slot);
        return list ? blocksOf(listBytes(list)).map(found=>found.block) : [];
    };

    /**
     * A method of the program's stream.
     *
     * @param {number} stream @param {number} slot @param {...number} args
     * @returns {Generator<{ entry: number, args: number[] }, number, number>}
     */
    function* method(stream, slot, ...args){
        return yield { entry: readU32(readU32(stream) + slot * 4), args: [stream >>> 0, ...args] };
    }

    /**
     * Steps over scratch memory, freed when they end; without a way to call
     * the program's stream, E_NOTIMPL.
     *
     * @param {number} size @param {(at: number) => Generator<any, number, number>} body
     */
    const withScratch = (size, body)=>{
        if (!host.drive || !host.allocate)
        {
            return 0x80004001 | 0;
        }
        const at = host.allocate(size);
        if (!at)
        {
            return E_OUTOFMEMORY;
        }
        host.writeMemory(at, new Uint8Array(size));
        function* steps(){
            try
            {
                return yield* body(at);
            }
            finally
            {
                host.free?.(at);
            }
        }
        return host.drive(steps());
    };

    /**
     * A read of exactly `size` bytes into `buffer`: E_FAIL when fewer came.
     *
     * @param {number} stream @param {number} buffer @param {number} size @param {number} count
     */
    function* readExactly(stream, buffer, size, count){
        const status = yield* method(stream, READ, buffer, size, count);
        if (status < 0)
        {
            return status;
        }
        return readU32(count) === size ? S_OK : E_FAIL;
    }

    /** @param {boolean} wide */
    const stringFromGuid = wide=>({
        argBytes: 12,
        /** @param {number[]} args */
        handler: ([guid, buffer, room])=>{
            if ((guid >>> 0) === 0 || (buffer >>> 0) === 0 || (room | 0) < 39)
            {
                return E_FAIL;
            }
            const bytes = read(guid, 16);
            const view = new DataView(bytes.buffer);
            const hex = (/** @type {number} */ value, /** @type {number} */ digits)=>
                value.toString(16).toUpperCase().padStart(digits, '0');
            const tail = Array.from(bytes.subarray(8), b=>hex(b, 2)).join('');
            const text = `{${hex(view.getUint32(0, true), 8)}-${hex(view.getUint16(4, true), 4)}`
                + `-${hex(view.getUint16(6, true), 4)}-${tail.slice(0, 4)}-${tail.slice(4)}}`;
            const out = new Uint8Array((text.length + 1) * (wide ? 2 : 1));
            Array.from(text).forEach((c, i)=>{
                out[wide ? i * 2 : i] = c.charCodeAt(0);
            });
            host.writeMemory(buffer >>> 0, out);
            return S_OK;
        },
    });

    return {
        /**
         * BOOL SHAddDataBlock(LPDBLIST *lppList, const DATABLOCK_HEADER *lpNewItem)
         *
         * A copy of the block added at the end; a block smaller than its
         * header, or one claiming to be a container, is refused.
         */
        SHAddDataBlock: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([slot, item])=>{
                if ((slot >>> 0) === 0 || (item >>> 0) === 0)
                {
                    return 0;
                }
                const head = read(item, HEADER);
                const size = u32(head);
                if (size < HEADER || u32(head, 4) === CONTAINER)
                {
                    return 0;
                }
                return replaceList(slot, [...blocksIn(slot), read(item, size)]) ? 1 : 0;
            },
        },

        /** BOOL SHRemoveDataBlock(LPDBLIST *lppList, DWORD dwSignature) */
        SHRemoveDataBlock: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([slot, signature])=>{
                if ((slot >>> 0) === 0)
                {
                    return 0;
                }
                const blocks = blocksIn(slot);
                const at = blocks.findIndex(block=>u32(block, 4) === signature >>> 0);
                if (at < 0)
                {
                    return 0;
                }
                blocks.splice(at, 1);
                return replaceList(slot, blocks) ? 1 : 0;
            },
        },

        /**
         * DATABLOCK_HEADER *SHFindDataBlock(LPDBLIST lpList, DWORD dwSignature)
         *
         * Where in the list the block is -- inside its container when it has
         * one -- or NULL.
         */
        SHFindDataBlock: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([list, signature])=>{
                if ((list >>> 0) === 0)
                {
                    return 0;
                }
                const found = blocksOf(listBytes(list))
                    .find(entry=>u32(entry.block, 4) === signature >>> 0);
                return found ? (list >>> 0) + found.at : 0;
            },
        },

        /** void SHFreeDataBlockList(LPDBLIST lpList) */
        SHFreeDataBlockList: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([list])=>{
                if ((list >>> 0) !== 0)
                {
                    kernel32('LocalFree', [list]);
                }
                return 0;
            },
        },

        /**
         * HRESULT SHWriteDataBlockList(IStream *lpStream, LPDBLIST lpList)
         *
         * One Write of each block as it is stored, then one of the zero that
         * ends the list; a Write that fails is the answer, one that wrote
         * short STG_E_MEDIUMFULL.
         */
        SHWriteDataBlockList: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([stream, list])=>{
                if ((stream >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const entries = (list >>> 0) === 0 ? []
                    : blocksOf(listBytes(list)).map(found=>({ at: (list >>> 0) + found.entry,
                        size: found.size }));
                return withScratch(8, function* (count){
                    host.writeMemory(count + 4, dword(0));
                    for (const { at, size } of [...entries, { at: count + 4, size: 4 }])
                    {
                        const status = yield* method(stream, WRITE, at, size, count);
                        if (status < 0)
                        {
                            return status;
                        }
                        if (readU32(count) !== size)
                        {
                            return STG_E_MEDIUMFULL;
                        }
                    }
                    return S_OK;
                });
            },
        },

        /**
         * HRESULT SHReadDataBlockList(IStream *lpStream, LPDBLIST *lppList)
         *
         * Each block's size, then the rest of it, to the zero that ends the
         * list. A block larger than any list holds is passed over with two
         * seeks -- where the stream is, then past it -- and ends the reading.
         */
        SHReadDataBlockList: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([stream, slot])=>{
                if ((stream >>> 0) === 0 || (slot >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                return withScratch(16 + MOST_BLOCK, function* (scratch){
                    const count = scratch;
                    const position = scratch + 4;
                    const block = scratch + 16;
                    /** @type {Uint8Array[]} */
                    const blocks = [];
                    for (;;)
                    {
                        let status = yield* readExactly(stream, block, 4, count);
                        if (status < 0)
                        {
                            return status;
                        }
                        const size = readU32(block);
                        if (size === 0)
                        {
                            break;
                        }
                        if (size > MOST_BLOCK || size < HEADER)
                        {
                            status = yield* method(stream, SEEK, 0, 0, STREAM_SEEK_CUR, position);
                            if (status >= 0)
                            {
                                const next = readU32(position) + size - 4;
                                yield* method(stream, SEEK, next >>> 0, 0, STREAM_SEEK_SET, 0);
                            }
                            break;
                        }
                        status = yield* readExactly(stream, block + 4, size - 4, count);
                        if (status < 0)
                        {
                            return status;
                        }
                        blocks.push(read(block, size));
                    }
                    host.writeMemory(slot >>> 0, dword(0));
                    return replaceList(slot, blocks) ? S_OK : E_OUTOFMEMORY;
                });
            },
        },

        /** INT SHStringFromGUIDA(REFGUID guid, LPSTR lpszDest, INT cchMax) */
        SHStringFromGUIDA: stringFromGuid(false),
        SHStringFromGUIDW: stringFromGuid(true),

        /**
         * BOOL SHIsEmptyStream(IStream *lpStream)
         *
         * Whether its Stat says it is empty; when Stat cannot say, whether a
         * DWORD cannot be read from it -- one that can is put back with a
         * seek to the start (Wine's test_SHIsEmptyStream).
         */
        SHIsEmptyStream: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([stream])=>{
                if ((stream >>> 0) === 0)
                {
                    return 0;
                }
                return withScratch(STATSTG_SIZE + 8, function* (at){
                    if ((yield* method(stream, STAT, at, STATFLAG_NONAME)) >= 0)
                    {
                        return readU32(at + 8) === 0 && readU32(at + 12) === 0 ? 1 : 0;
                    }
                    const count = at + STATSTG_SIZE;
                    if ((yield* method(stream, READ, count + 4, 4, count)) < 0)
                    {
                        return 1;
                    }
                    yield* method(stream, SEEK, 0, 0, STREAM_SEEK_SET, 0);
                    return 0;
                });
            },
        },

        /** HRESULT IStream_Read(IStream *pstm, void *pv, ULONG cb): E_FAIL when short. */
        IStream_Read: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([stream, buffer, size])=>withScratch(4, function* (count){
                return yield* readExactly(stream, buffer, size >>> 0, count);
            }),
        },

        /** HRESULT IStream_Write(IStream *pstm, const void *pv, ULONG cb): E_FAIL when short. */
        IStream_Write: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([stream, buffer, size])=>withScratch(4, function* (count){
                const status = yield* method(stream, WRITE, buffer, size, count);
                return status < 0 ? status : readU32(count) === (size >>> 0) ? S_OK : E_FAIL;
            }),
        },

        /** HRESULT IStream_Reset(IStream *pstm): back to the start. */
        IStream_Reset: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([stream])=>withScratch(4, function* (){
                return yield* method(stream, SEEK, 0, 0, STREAM_SEEK_SET, 0);
            }),
        },

        /** HRESULT IStream_Size(IStream *pstm, ULARGE_INTEGER *pui): Stat's size. */
        IStream_Size: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([stream, out])=>withScratch(STATSTG_SIZE, function* (at){
                const status = yield* method(stream, STAT, at, STATFLAG_NONAME);
                if (status >= 0 && (out >>> 0) !== 0)
                {
                    host.writeMemory(out >>> 0, read(at + 8, 8));
                }
                return status;
            }),
        },
    };
}
