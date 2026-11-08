/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The RTL_BITMAP routines: a bitmap is { ULONG SizeOfBitMap; PULONG Buffer; },
 * bit n the (n % 8)th of byte n / 8 of the buffer. A program's allocator of
 * slots (WPF's renderer keeps its handles in one) sets, clears and finds runs
 * through these.
 *
 * The contract is Wine's rtlbitmap test (what Windows answers): setting or
 * clearing all bits takes the size up to whole ULONGs and no further; a
 * search for bits starts at the hint and goes round to the start; the runs a
 * search reports are the first ones, or with `LocateLongestRuns` the longest
 * ones; bits past the size are not looked at.
 */

/** RtlFind*Bits' answer when nothing is found. */
const NOT_FOUND = 0xffffffff;

/**
 * @typedef {Object} BitmapHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 */

/**
 * @param {BitmapHost} host
 */
export function createBitmapFunctions(host){
    /** @param {number} at */
    const u32 = at=>{
        const b = host.readMemory(at >>> 0, 4);
        return (b[0] | b[1] << 8 | b[2] << 16 | b[3] << 24) >>> 0;
    };
    /** @param {number} at @param {number[]} values */
    const putU32s = (at, values)=>host.writeMemory(at >>> 0,
        new Uint8Array(new Uint32Array(values.map(v=>v >>> 0)).buffer));

    /**
     * A bitmap's bits as bytes, and how to write the ones changed back.
     *
     * @param {number} header
     */
    const open = header=>{
        const size = u32(header);
        const buffer = u32(header + 4);
        const bytes = host.readMemory(buffer, Math.ceil(size / 8)).slice();
        return {
            size, bytes,
            /** @param {number} n */
            get: n=>(bytes[n >> 3] >> (n & 7) & 1) === 1,
            /** @param {number} start @param {number} count @param {boolean} on */
            fill: (start, count, on)=>{
                for (let n = start; n < start + count; n++)
                {
                    bytes[n >> 3] = on ? bytes[n >> 3] | 1 << (n & 7)
                        : bytes[n >> 3] & ~(1 << (n & 7));
                }
                host.writeMemory(buffer + (start >> 3),
                    bytes.subarray(start >> 3, ((start + count - 1) >> 3) + 1));
            },
            buffer,
        };
    };

    /** @param {boolean} on */
    const all = on=>({
        argBytes: 4,
        /** @param {number[]} args */
        handler: ([header])=>{
            // Whole ULONGs, as the buffer is laid out in them.
            const bytes = Math.ceil(u32(header) / 32) * 4;
            host.writeMemory(u32(header + 4), new Uint8Array(bytes).fill(on ? 0xff : 0));
            return 0;
        },
    });

    /** @param {boolean} on */
    const range = on=>({
        argBytes: 12,
        /** @param {number[]} args */
        handler: ([header, start, count])=>{
            if ((count >>> 0) !== 0)
            {
                open(header).fill(start >>> 0, count >>> 0, on);
            }
            return 0;
        },
    });

    /** @param {boolean} on */
    const are = on=>({
        argBytes: 12,
        /** @param {number[]} args */
        handler: ([header, start, count])=>{
            const map = open(header);
            const [from, n] = [start >>> 0, count >>> 0];
            if (from + n > map.size)
            {
                return 0;
            }
            for (let i = from; i < from + n; i++)
            {
                if (map.get(i) !== on)
                {
                    return 0;
                }
            }
            return 1;
        },
    });

    /** @param {boolean} on */
    const number = on=>({
        argBytes: 4,
        /** @param {number[]} args */
        handler: ([header])=>{
            const map = open(header);
            let count = 0;
            for (let n = 0; n < map.size; n++)
            {
                count += map.get(n) === on ? 1 : 0;
            }
            return count;
        },
    });

    /**
     * The first run of `count` bits of a value from the hint on, round to the
     * start: its index, or NOT_FOUND.
     *
     * @param {ReturnType<typeof open>} map @param {number} count @param {number} hint
     * @param {boolean} on
     */
    const find = (map, count, hint, on)=>{
        if (count === 0)
        {
            return hint < map.size ? hint : 0;
        }
        const from = hint < map.size ? hint : 0;
        for (const [begin, end] of [[from, map.size], [0, from + count - 1]])
        {
            let run = 0;
            for (let n = begin; n < Math.min(end, map.size); n++)
            {
                run = map.get(n) === on ? run + 1 : 0;
                if (run === count)
                {
                    return n - count + 1;
                }
            }
        }
        return NOT_FOUND;
    };

    /** @param {boolean} on @param {boolean} flip  set (or clear) what was found */
    const finder = (on, flip)=>({
        argBytes: 12,
        /** @param {number[]} args */
        handler: ([header, count, hint])=>{
            const map = open(header);
            const at = find(map, count >>> 0, hint >>> 0, on);
            if (flip && at !== NOT_FOUND && (count >>> 0) !== 0)
            {
                map.fill(at, count >>> 0, !on);
            }
            return at;
        },
    });

    /**
     * Every run of bits of a value, in order: [start, length].
     *
     * @param {ReturnType<typeof open>} map @param {boolean} on @param {number} [from]
     */
    const runsOf = (map, on, from = 0)=>{
        /** @type {[number, number][]} */
        const runs = [];
        let start = -1;
        for (let n = from; n <= map.size; n++)
        {
            const inRun = n < map.size && map.get(n) === on;
            if (inRun && start < 0)
            {
                start = n;
            }
            else if (!inRun && start >= 0)
            {
                runs.push([start, n - start]);
                start = -1;
            }
        }
        return runs;
    };

    /** @param {boolean} on */
    const findRuns = on=>({
        argBytes: 16,
        /** @param {number[]} args */
        handler: ([header, out, most, longest])=>{
            let runs = runsOf(open(header), on);
            if (longest & 0xff)
            {
                runs = [...runs].sort((a, b)=>b[1] - a[1]);
            }
            runs = runs.slice(0, most >>> 0);
            putU32s(out, runs.flat());
            return runs.length;
        },
    });

    /** @param {boolean} on */
    const nextRun = on=>({
        argBytes: 12,
        /** @param {number[]} args */
        handler: ([header, from, startOut])=>{
            const [run] = runsOf(open(header), on, from >>> 0);
            putU32s(startOut, [run ? run[0] : 0]);
            return run ? run[1] : 0;
        },
    });

    /** @param {boolean} on */
    const longestRun = on=>({
        argBytes: 8,
        /** @param {number[]} args */
        handler: ([header, startOut])=>{
            const runs = runsOf(open(header), on);
            const best = runs.reduce((a, b)=>(b[1] > a[1] ? b : a), [0, 0]);
            if (runs.length > 0)
            {
                putU32s(startOut, [best[0]]);
            }
            return best[1];
        },
    });

    /** @param {boolean} most */
    const significant = most=>({
        argBytes: 8,
        /** @param {number[]} args */
        handler: ([low, high])=>{
            const value = BigInt(high >>> 0) << 32n | BigInt(low >>> 0);
            if (value === 0n)
            {
                return 0xff;
            }
            if (most)
            {
                return value.toString(2).length - 1;
            }
            let n = 0;
            while (((value >> BigInt(n)) & 1n) === 0n)
            {
                n++;
            }
            return n;
        },
    });

    return {
        /** VOID RtlInitializeBitMap(PRTL_BITMAP, PULONG Buffer, ULONG SizeOfBitMap) */
        RtlInitializeBitMap: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([header, buffer, size])=>{
                putU32s(header, [size, buffer]);
                return 0;
            },
        },
        RtlSetAllBits: all(true),
        RtlClearAllBits: all(false),
        /** VOID RtlSetBits(PRTL_BITMAP, ULONG StartingIndex, ULONG NumberToSet) */
        RtlSetBits: range(true),
        RtlClearBits: range(false),
        /** BOOLEAN RtlAreBitsSet(PRTL_BITMAP, ULONG StartingIndex, ULONG Length) */
        RtlAreBitsSet: are(true),
        RtlAreBitsClear: are(false),
        /** BOOLEAN RtlCheckBit(PRTL_BITMAP, ULONG BitPosition) */
        RtlCheckBit: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([header, at])=>(open(header).get(at >>> 0) ? 1 : 0),
        },
        RtlNumberOfSetBits: number(true),
        RtlNumberOfClearBits: number(false),
        /** ULONG RtlFindSetBits(PRTL_BITMAP, ULONG NumberToFind, ULONG HintIndex) */
        RtlFindSetBits: finder(true, false),
        RtlFindClearBits: finder(false, false),
        RtlFindSetBitsAndClear: finder(true, true),
        RtlFindClearBitsAndSet: finder(false, true),
        /**
         * ULONG RtlFindSetRuns(PRTL_BITMAP, PRTL_BITMAP_RUN RunArray,
         *     ULONG SizeOfRunArray, BOOLEAN LocateLongestRuns)
         */
        RtlFindSetRuns: findRuns(true),
        RtlFindClearRuns: findRuns(false),
        /** ULONG RtlFindNextForwardRunSet(PRTL_BITMAP, ULONG FromIndex, PULONG StartingRunIndex) */
        RtlFindNextForwardRunSet: nextRun(true),
        RtlFindNextForwardRunClear: nextRun(false),
        /** ULONG RtlFindLongestRunSet(PRTL_BITMAP, PULONG StartingIndex) */
        RtlFindLongestRunSet: longestRun(true),
        RtlFindLongestRunClear: longestRun(false),
        /** CCHAR RtlFindMostSignificantBit(ULONGLONG), and the least: -1 for none. */
        RtlFindMostSignificantBit: significant(true),
        RtlFindLeastSignificantBit: significant(false),
    };
}
