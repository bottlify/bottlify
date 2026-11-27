/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A value per page of a reservation, kept as runs: sorted, apart, and a run
 * merged with a neighbour that touches it and holds the same value. What a
 * reservation's pages were given (VirtualAlloc's commit, VirtualProtect) is
 * a few runs however large the reservation; kept page by page, a collector
 * that commits a gigabyte again and again paid a million writes a call (a
 * .NET world generator at 55 ms a VirtualAlloc), where Windows pays nothing.
 */

/**
 * @template T
 * @typedef {{ from: number, to: number, value: T }} PageRun  `[from, to)`, addresses
 */

/**
 * @template T
 */
export function createPageRuns(){
    /** @type {PageRun<T>[]} */
    let runs = [];

    /** The index of the first run that ends past `address`. @param {number} address */
    const firstEndingAfter = address=>{
        let low = 0;
        let high = runs.length;
        while (low < high)
        {
            const middle = (low + high) >>> 1;
            if (runs[middle].to <= address)
            {
                low = middle + 1;
            }
            else
            {
                high = middle;
            }
        }
        return low;
    };

    /**
     * `[from, to)` given `value`, or nothing when `value` is undefined.
     *
     * @param {number} from @param {number} to @param {T | undefined} value
     */
    const put = (from, to, value)=>{
        if (to <= from)
        {
            return;
        }
        const first = firstEndingAfter(from);
        let last = first;
        /** @type {PageRun<T>[]} */
        const middle = [];
        while (last < runs.length && runs[last].from < to)
        {
            const run = runs[last];
            if (run.from < from)
            {
                middle.push({ from: run.from, to: from, value: run.value });
            }
            if (run.to > to)
            {
                middle.push({ from: to, to: run.to, value: run.value });
            }
            last++;
        }
        if (value !== undefined)
        {
            middle.push({ from, to, value });
            middle.sort((a, b)=>a.from - b.from);
        }
        // Merged with the runs on either side where they touch and agree.
        const start = first > 0 ? first - 1 : first;
        const end = last < runs.length ? last + 1 : last;
        /** @type {PageRun<T>[]} */
        const merged = [];
        for (const run of [...runs.slice(start, first), ...middle, ...runs.slice(last, end)])
        {
            const before = merged[merged.length - 1];
            if (before && before.to === run.from && before.value === run.value)
            {
                merged[merged.length - 1] = { from: before.from, to: run.to, value: run.value };
            }
            else
            {
                merged.push(run);
            }
        }
        runs = [...runs.slice(0, start), ...merged, ...runs.slice(end)];
    };

    return {
        /** @param {number} from @param {number} to @param {T} value */
        set: (from, to, value)=>put(from, to, value),
        /** @param {number} from @param {number} to */
        clear: (from, to)=>put(from, to, undefined),
        /**
         * The value of the page at `address`, or undefined.
         *
         * @param {number} address @returns {T | undefined}
         */
        get(address){
            const run = runs[firstEndingAfter(address)];
            return run && run.from <= address ? run.value : undefined;
        },
        /**
         * Where the stretch from `address` that reads as one value ends,
         * before `limit`: a page with no value reads as `fallback`.
         *
         * @param {number} address @param {number} limit @param {T} fallback
         * @returns {number}
         */
        extent(address, limit, fallback){
            let index = firstEndingAfter(address);
            /** @param {number} at */
            const valueAt = at=>{
                const run = runs[index];
                return run && run.from <= at ? run.value : fallback;
            };
            const value = valueAt(address);
            let at = address;
            while (at < limit)
            {
                const run = runs[index];
                if (run && run.from <= at)
                {
                    if (run.value !== value)
                    {
                        return at;
                    }
                    at = run.to;
                    index++;
                }
                else
                {
                    if (fallback !== value)
                    {
                        return at;
                    }
                    at = run ? run.from : limit;
                }
            }
            return Math.min(at, limit);
        },
        /**
         * The runs that reach into `[from, to)`, cut to it.
         *
         * @param {number} from @param {number} to @returns {PageRun<T>[]}
         */
        within(from, to){
            /** @type {PageRun<T>[]} */
            const found = [];
            for (let index = firstEndingAfter(from); index < runs.length && runs[index].from < to;
                index++)
            {
                const run = runs[index];
                found.push({ from: Math.max(run.from, from), to: Math.min(run.to, to),
                    value: run.value });
            }
            return found;
        },
        /** How many runs: what a value per page costs here. */
        get size(){
            return runs.length;
        },
    };
}
