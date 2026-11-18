/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * RtlUshortByteSwap, RtlUlongByteSwap and RtlUlonglongByteSwap: 32-bit
 * ntdll's byte swaps, which are __fastcall. The short and long ones take
 * their value in ECX, which no trap is handed, and the long long one takes
 * its 64 bits on the stack, popping them, and answers in EDX:EAX: each is
 * the few instructions of its own the guest runs, so a call costs those and
 * not a crossing. A 64-bit ntdll exports none of them (the compiler inlines
 * them there).
 */

/** The code of each, by name. */
export const BYTE_SWAP_CODE = Object.freeze({
    // movzx eax, cx; xchg ah, al; ret
    RtlUshortByteSwap: new Uint8Array([0x0f, 0xb7, 0xc1, 0x86, 0xc4, 0xc3]),
    // mov eax, ecx; bswap eax; ret
    RtlUlongByteSwap: new Uint8Array([0x89, 0xc8, 0x0f, 0xc8, 0xc3]),
    // mov edx, [esp+4]; mov eax, [esp+8]; bswap edx; bswap eax; ret 8
    RtlUlonglongByteSwap: new Uint8Array([0x8b, 0x54, 0x24, 0x04, 0x8b, 0x44, 0x24, 0x08,
        0x0f, 0xca, 0x0f, 0xc8, 0xc2, 0x08, 0x00]),
});

/**
 * @typedef {Object} ByteSwapHost
 * @property {(values: Record<string, number>) => void} setRegisters
 */

/**
 * The three exports: their code, and for the stack one a handler that is the
 * same swap, what the code is tested against.
 *
 * @param {ByteSwapHost} host
 */
export function createByteSwapFunctions(host){
    /** @param {'RtlUshortByteSwap' | 'RtlUlongByteSwap'} name */
    const inRegister = name=>({
        argBytes: 0,
        code: ()=>BYTE_SWAP_CODE[name],
        handler: ()=>{
            throw new Error(`${name} swaps ECX, which only its code reads`);
        },
    });
    return {
        /** USHORT FASTCALL RtlUshortByteSwap(USHORT Source) */
        RtlUshortByteSwap: inRegister('RtlUshortByteSwap'),
        /** ULONG FASTCALL RtlUlongByteSwap(ULONG Source) */
        RtlUlongByteSwap: inRegister('RtlUlongByteSwap'),
        /** ULONGLONG FASTCALL RtlUlonglongByteSwap(ULONGLONG Source) */
        RtlUlonglongByteSwap: {
            argBytes: 8,
            quadwords: [0],
            code: ()=>BYTE_SWAP_CODE.RtlUlonglongByteSwap,
            /** @param {number[]} args */
            handler: ([low, high])=>{
                /** @param {number} value */
                const swap = value=>((value & 0xff) << 24 | (value >>> 8 & 0xff) << 16
                    | (value >>> 16 & 0xff) << 8 | value >>> 24) >>> 0;
                host.setRegisters({ edx: swap(low) });
                return swap(high);
            },
        },
    };
}
