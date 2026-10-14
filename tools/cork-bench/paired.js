/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A paired measurement of cork-bench, for node (`pair.mjs`) and the browser's
 * worker (`browser.mjs --paired`) alike: a host for every arm in one thread,
 * blocks of iterations alternated and their order turned round each round, so
 * the machine's drift -- a quarter of a run's time on a shared machine -- falls
 * on every arm of a round alike, and the ratio of one round's times holds what
 * separate processes' times lose in it.
 */

const IMAGE_BASE = 0x401000;
const ENTRY_VECTOR = 0x7000;

/**
 * A host over the image with one arm's engine, and its iteration: one call of
 * the program's main to its `hlt`, the translator fed between slices as
 * `bench.mjs` feeds it.
 *
 * @param {{ createCorkHost: Function, engine: object, cork?: object }} arm
 * @param {Uint8Array} image
 */
export function hostOf({ createCorkHost, engine, cork = {} }, image){
    const host = createCorkHost({
        engine, memorySize: 16 << 20, trapPort: 0xb077, entryVector: ENTRY_VECTOR,
        initialStack: 0x800000, cork,
    });
    host.writePhysical(IMAGE_BASE, image);
    const vector = new Uint8Array(4);
    new DataView(vector.buffer).setUint32(0, IMAGE_BASE, true);
    host.writePhysical(ENTRY_VECTOR, vector);
    const iteration = ()=>{
        let retired = host.runSlice(100_000);
        while (!host.halted())
        {
            host.cork().translatePending().catch(()=>{});
            retired += host.runSlice(100_000);
        }
        return retired;
    };
    return { host, iteration };
}

/**
 * Every arm warmed, then `rounds` rounds of `block` iterations each.
 *
 * @param {{ createCorkHost: Function, engine: object, cork?: object }[]} arms
 * @param {Uint8Array} image
 * @param {{ warm: number, rounds: number, block: number }} plan
 * @returns {{ times: number[][], eax: string[] }}  each round's microseconds an
 *     iteration, by arm, and the program's checksum each arm left
 */
export function paired(arms, image, { warm, rounds, block }){
    const hosts = arms.map(arm=>hostOf(arm, image));
    for (const { iteration } of hosts)
    {
        for (let i = 0; i < warm; i++)
        {
            iteration();
        }
    }
    /** @type {number[][]} */
    const times = hosts.map(()=>[]);
    for (let round = 0; round < rounds; round++)
    {
        const order = hosts.map((_, i)=>i);
        for (const at of round % 2 ? order.reverse() : order)
        {
            const startedAt = performance.now();
            for (let i = 0; i < block; i++)
            {
                hosts[at].iteration();
            }
            times[at].push((performance.now() - startedAt) * 1000 / block);
        }
    }
    return { times, eax: hosts.map(({ host })=>(host.readReg32('eax') >>> 0).toString(16)) };
}

/** @param {number[]} values @param {number} at  0 to 1 */
const quantile = (values, at)=>{
    const sorted = [...values].sort((a, b)=>a - b);
    const place = at * (sorted.length - 1);
    const low = Math.floor(place);
    const high = sorted[Math.min(low + 1, sorted.length - 1)];
    return sorted[low] + (high - sorted[low]) * (place - low);
};

/**
 * Each arm's median time and, against the first arm, the median of the rounds'
 * ratios with its quartiles.
 *
 * @param {string[]} labels @param {number[][]} times
 */
export function summarise(labels, times){
    return labels.map((label, at)=>{
        const ratios = times[at].map((time, round)=>time / times[0][round]);
        return { label, median: quantile(times[at], 0.5), ratio: quantile(ratios, 0.5),
            q25: quantile(ratios, 0.25), q75: quantile(ratios, 0.75) };
    });
}
