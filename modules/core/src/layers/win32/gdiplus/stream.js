/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A program's IStream, read and written through its own vtable: GDI+ loads
 * an image from where the stream stands and saves one there, as Windows'
 * does (IStream::Read is slot 3, Write 4).
 */

/** How much one IStream::Read asks for. */
const CHUNK = 0x10000;

/**
 * @typedef {Object} StreamHost
 * @property {(entry: number, args: number[]) => Promise<number>} callGuest
 * @property {(bytes: number) => number} allocate  zero when none is left
 * @property {(address: number) => void} free
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, length: number) => Uint8Array} readMemory
 */

/** @param {StreamHost} host */
export function createGuestStreams(host){
    /** @param {number} address */
    const u32 = address=>new DataView(host.readMemory(address >>> 0, 4).slice().buffer)
        .getUint32(0, true);
    /**
     * The method in `slot` of the stream's vtable, its HRESULT.
     *
     * @param {number} stream @param {number} slot @param {number[]} args
     */
    const method = async(stream, slot, args)=>
        (await host.callGuest(u32(u32(stream) + slot * 4), [stream >>> 0,
            ...args.map(a=>a >>> 0)])) | 0;
    /**
     * Memory of `bytes` for the length of `use`; null when none is left.
     *
     * @template T
     * @param {number} bytes @param {(at: number) => Promise<T>} use
     * @returns {Promise<T | null>}
     */
    const withBlock = async(bytes, use)=>{
        const at = host.allocate(bytes);
        if (at === 0)
        {
            return null;
        }
        try
        {
            return await use(at);
        }
        finally
        {
            host.free(at);
        }
    };
    return {
        /**
         * Every byte from where the stream stands to its end; null when a read
         * failed or no memory was left.
         *
         * @param {number} stream
         * @returns {Promise<Uint8Array | null>}
         */
        read: stream=>withBlock(CHUNK + 4, async at=>{
            /** @type {Uint8Array[]} */
            const parts = [];
            let total = 0;
            for (;;)
            {
                const hr = await method(stream, 3, [at + 4, CHUNK, at]);
                if (hr < 0)
                {
                    return null;
                }
                const got = Math.min(u32(at), CHUNK);
                parts.push(host.readMemory(at + 4, got).slice());
                total += got;
                if (got < CHUNK)
                {
                    break;
                }
            }
            const out = new Uint8Array(total);
            let offset = 0;
            for (const part of parts)
            {
                out.set(part, offset);
                offset += part.length;
            }
            return out;
        }),
        /**
         * Bytes written where the stream stands, whole: the HRESULT, or
         * E_OUTOFMEMORY when no memory was left to pass them in.
         *
         * @param {number} stream @param {Uint8Array} bytes
         */
        write: async(stream, bytes)=>(await withBlock(bytes.length + 4, async at=>{
            host.writeMemory(at + 4, bytes);
            const hr = await method(stream, 4, [at + 4, bytes.length, at]);
            return hr < 0 || u32(at) === bytes.length ? hr : 0x80030070 | 0;
        })) ?? (0x8007000e | 0),
    };
}
