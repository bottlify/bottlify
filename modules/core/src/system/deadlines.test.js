/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDeadlines } from './deadlines.js';
import { bytesPerCall } from '../../../../tools/fixtures/allocation.mjs';

/**
 * The contract written the plain way: every deadline in an array kept sorted
 * by due time, then by the rank `add` gave it. What the heap answers must be
 * what this answers, call for call.
 *
 * @returns {import('./deadlines.js').Deadlines}
 */
function createReference(){
    /** @type {{ id: number, due: number, rank: number }[]} */
    let list = [];
    /** @type {Map<number, number>} */
    const ranks = new Map();
    /** @type {number[]} */
    const free = [];
    /** @type {Set<number>} */
    const claimed = new Set();
    /** @type {Set<number>} */
    let taken = new Set();
    let next = 0;
    let rank = 0;
    const sort = ()=>list.sort((a, b)=>a.due - b.due || a.rank - b.rank);
    /** @param {number} id */
    const held = id=>{
        if (!claimed.has(id))
        {
            throw new RangeError(`deadline id ${id} is not claimed`);
        }
    };
    /** @param {number} id */
    const drop = id=>{
        list = list.filter(entry=>entry.id !== id);
        taken.delete(id);
    };
    /** @param {number} id @param {number} due */
    const schedule = (id, due)=>{
        drop(id);
        list.push({ id, due, rank: /** @type {number} */ (ranks.get(id)) });
        sort();
    };
    return {
        claim(){
            const id = free.length > 0 ? /** @type {number} */ (free.pop()) : next++;
            claimed.add(id);
            ranks.set(id, -1);
            return id;
        },
        release(id){
            held(id);
            drop(id);
            claimed.delete(id);
            free.push(id);
        },
        add(due, id){
            held(id);
            ranks.set(id, rank++);
            schedule(id, due);
        },
        move(id, due){
            held(id);
            if (/** @type {number} */ (ranks.get(id)) < 0)
            {
                ranks.set(id, rank++);
            }
            schedule(id, due);
        },
        remove(id){
            held(id);
            drop(id);
        },
        has: id=>list.some(entry=>entry.id === id),
        due: id=>list.find(entry=>entry.id === id)?.due ?? Infinity,
        first: ()=>list[0]?.id ?? -1,
        soonest: ()=>list[0]?.due ?? Infinity,
        takeDue(now, visit){
            const due = list.filter(entry=>entry.due <= now);
            list = list.filter(entry=>entry.due > now);
            taken = new Set(due.map(entry=>entry.id));
            let at = 0;
            try
            {
                while (at < due.length)
                {
                    const entry = due[at++];
                    if (!taken.has(entry.id))
                    {
                        continue;
                    }
                    taken.delete(entry.id);
                    if (visit(entry.id, entry.due) === true)
                    {
                        break;
                    }
                }
            }
            finally
            {
                for (const entry of due.slice(at).filter(each=>taken.has(each.id)))
                {
                    list.push(entry);
                }
                taken = new Set();
                sort();
            }
        },
        size: ()=>list.length,
    };
}

/** A seeded generator: the same seed, the same program. @param {number} seed */
const random = seed=>{
    let state = seed >>> 0 || 1;
    return ()=>{
        state ^= state << 13;
        state >>>= 0;
        state ^= state >>> 17;
        state ^= state << 5;
        state >>>= 0;
        return state / 2 ** 32;
    };
};

/**
 * A random program of claims, releases, adds, moves, removes and takes, the
 * visits themselves moving, removing, adding and stopping, run on `impl`;
 * what it observed, in order. Due times are small integers so ties are many.
 *
 * @param {import('./deadlines.js').Deadlines} impl @param {number} seed
 */
function run(impl, seed){
    const next = random(seed);
    const pick = (/** @type {number[]} */ from)=>from[Math.floor(next() * from.length)];
    /** @type {number[]} */
    const held = [];
    /** @type {unknown[]} */
    const log = [];
    let clock = 0;
    for (let step = 0; step < 600; step++)
    {
        const roll = next();
        if (roll < 0.15 || held.length === 0)
        {
            const id = impl.claim();
            held.push(id);
            log.push(['claim', id]);
        }
        else if (roll < 0.22)
        {
            const id = pick(held);
            held.splice(held.indexOf(id), 1);
            impl.release(id);
        }
        else if (roll < 0.45)
        {
            impl.add(clock + Math.floor(next() * 8), pick(held));
        }
        else if (roll < 0.6)
        {
            impl.move(pick(held), clock + Math.floor(next() * 8));
        }
        else if (roll < 0.68)
        {
            impl.remove(pick(held));
        }
        else
        {
            clock += Math.floor(next() * 4);
            impl.takeDue(clock, (id, due)=>{
                log.push(['visit', id, due]);
                const what = next();
                if (what < 0.2)
                {
                    impl.move(id, clock + 1 + Math.floor(next() * 4));
                }
                else if (what < 0.3)
                {
                    impl.remove(pick(held));
                }
                else if (what < 0.4)
                {
                    impl.add(clock - 1, pick(held));
                }
                else if (what < 0.45)
                {
                    impl.move(pick(held), clock);
                }
                return what > 0.9;
            });
        }
        log.push(['state', impl.size(), impl.first(), impl.soonest(),
            held.map(id=>[impl.has(id), impl.due(id)])]);
    }
    return log;
}

test('the heap answers as a sorted list: order, ties by when added, removal in a visit', ()=>{
    for (let seed = 1; seed <= 200; seed++)
    {
        assert.deepEqual(run(createDeadlines(1), seed), run(createReference(), seed),
            `seed ${seed}`);
    }
});

test('a visit that stops leaves the rest where they were, in order', ()=>{
    const deadlines = createDeadlines();
    const ids = [deadlines.claim(), deadlines.claim(), deadlines.claim()];
    ids.forEach(id=>deadlines.add(5, id));
    /** @type {number[]} */
    const seen = [];
    deadlines.takeDue(5, id=>{
        seen.push(id);
        return true;
    });
    assert.deepEqual(seen, [ids[0]]);
    assert.equal(deadlines.size(), 2);
    deadlines.takeDue(5, id=>{
        seen.push(id);
    });
    assert.deepEqual(seen, ids, 'the two left came out in the order they were added');
});

test('a periodic deadline moved on keeps its place among the ones due with it', ()=>{
    const deadlines = createDeadlines();
    const [early, late] = [deadlines.claim(), deadlines.claim()];
    deadlines.add(10, early);
    deadlines.add(20, late);
    deadlines.takeDue(10, id=>deadlines.move(id, 20));
    assert.equal(deadlines.first(), early, 'added first, it is first at the tie');
});

test('an id is reused after its release, and one not claimed is refused', ()=>{
    const deadlines = createDeadlines();
    const id = deadlines.claim();
    deadlines.add(3, id);
    deadlines.release(id);
    assert.equal(deadlines.soonest(), Infinity);
    assert.equal(deadlines.claim(), id);
    assert.throws(()=>deadlines.add(1, 99), RangeError);
    assert.throws(()=>deadlines.remove(-1), RangeError);
});

test('takeDue is not called from inside its own visit', ()=>{
    const deadlines = createDeadlines();
    const id = deadlines.claim();
    deadlines.add(1, id);
    deadlines.add(1, deadlines.claim());
    assert.throws(()=>deadlines.takeDue(1, ()=>deadlines.takeDue(1, ()=>{})),
        /inside its own visit/);
    assert.equal(deadlines.size(), 1, 'the one not visited went back');
});

test('a tick - the soonest asked, the due ones taken and moved on - makes nothing', async()=>{
    const deadlines = createDeadlines();
    for (let i = 0; i < 64; i++)
    {
        deadlines.add(i, deadlines.claim());
    }
    const clock = new Float64Array(1);
    /** @param {number} id @param {number} due */
    const periodic = (id, due)=>{
        deadlines.move(id, due + 64);
    };
    const bytes = await bytesPerCall(()=>{
        clock[0] += 1;
        if (deadlines.soonest() <= clock[0])
        {
            deadlines.takeDue(clock[0], periodic);
        }
    });
    assert.ok(bytes < 8, `${bytes.toFixed(1)} bytes a tick`);
});
