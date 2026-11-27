/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Deadlines - the one list of due times: which is soonest, and every one
 * the clock has passed, in order.
 *
 * A thread's timed wait, a waitable timer, a window's WM_TIMER and a
 * multimedia timer are all asked the same two questions every turn, and each
 * of them answered by walking its own table. Here they are a binary min-heap
 * over typed arrays: the soonest is read in place, a due time added, moved or
 * taken out costs a logarithm of how many there are, and nothing is made per
 * deadline or per tick - the caller keeps its own record under the id it
 * was handed (`claim`), and this keeps only the due time.
 *
 * Two deadlines due at the same time come out in the order they were added:
 * a rank given at `add` and kept by `move`, so a periodic timer moved on keeps
 * its place among the timers due with it, as a table walked in insertion
 * order kept it.
 */

/** An id that is claimed and not scheduled. */
const IDLE = -1;
/** An id `takeDue` has taken out and not yet visited. */
const TAKEN = -2;
/** An id nobody holds. */
const FREE = -3;

/**
 * @typedef {Object} Deadlines
 * @property {() => number} claim  An id for a new record, the last released
 *     one reused first: it indexes the caller's own table.
 * @property {(id: number) => void} release  The record is gone: its deadline
 *     goes, and the id may be handed out again.
 * @property {(due: number, id: number) => void} add  Schedules `id` at `due`,
 *     ranked after every deadline added before it; one already scheduled is
 *     ranked again, as a new one.
 * @property {(id: number, due: number) => void} move  A new due time, keeping
 *     the rank `add` gave it last (one never added is ranked as `add` would);
 *     one not scheduled is scheduled again.
 * @property {(id: number) => void} remove  Unschedules `id`, which stays claimed.
 * @property {(id: number) => boolean} has  Whether `id` is scheduled.
 * @property {(id: number) => number} due  When `id` is due, Infinity if it is not scheduled.
 * @property {() => number} first  The id due soonest, or -1.
 * @property {() => number} soonest  The soonest due time, or Infinity.
 * @property {(now: number, visit: (id: number, due: number) => boolean | void) => void} takeDue
 *     Takes out every deadline due at or before `now` and visits each in
 *     order. A deadline removed, moved or added again while the visits run is
 *     not visited; `visit` may schedule its own id again, which is not visited
 *     twice. A visit that answers true stops: the deadlines not yet visited go
 *     back as they were. Not called again from inside a visit.
 * @property {() => number} size  How many are scheduled.
 */

/**
 * @param {number} [capacity]  How many ids to make room for at first; more
 *     are made as they are claimed.
 * @returns {Deadlines}
 */
export function createDeadlines(capacity = 8){
    /** The ids by heap position. */
    let heap = new Int32Array(capacity);
    /** Each id's heap position, or IDLE, TAKEN or FREE. */
    let place = new Int32Array(capacity).fill(FREE);
    let dueOf = new Float64Array(capacity);
    let rankOf = new Float64Array(capacity);
    /** Ids released, the last one handed out again first. */
    let free = new Int32Array(capacity);
    /** What `takeDue` took out, in order. */
    let taken = new Int32Array(capacity);
    // Counts in cells rather than in closure variables, so that a count past
    // a small integer is not a number boxed on every write.
    // [size, ids claimed ever, free ids, next rank, visiting]
    const counts = new Float64Array(5);
    const SIZE = 0;
    const CLAIMED = 1;
    const FREED = 2;
    const RANK = 3;
    const VISITING = 4;

    /** Room for `count` ids. @param {number} count */
    const grow = count=>{
        let length = heap.length;
        while (length < count)
        {
            length *= 2;
        }
        /** @template {Int32Array | Float64Array} T @param {T} from @returns {T} */
        const wider = from=>{
            const to = /** @type {T} */ (new /** @type {any} */ (from.constructor)(length));
            to.set(from);
            return to;
        };
        heap = wider(heap);
        const places = wider(place);
        places.fill(FREE, place.length);
        place = places;
        dueOf = wider(dueOf);
        rankOf = wider(rankOf);
        free = wider(free);
        taken = wider(taken);
    };

    /** Whether `a` comes before `b`. @param {number} a @param {number} b */
    const before = (a, b)=>dueOf[a] < dueOf[b] || (dueOf[a] === dueOf[b] && rankOf[a] < rankOf[b]);

    /** @param {number} at @param {number} id */
    const put = (at, id)=>{
        heap[at] = id;
        place[id] = at;
    };

    /** @param {number} at */
    const up = at=>{
        const id = heap[at];
        while (at > 0)
        {
            const parent = (at - 1) >> 1;
            if (!before(id, heap[parent]))
            {
                break;
            }
            put(at, heap[parent]);
            at = parent;
        }
        put(at, id);
    };

    /** @param {number} at */
    const down = at=>{
        const id = heap[at];
        const size = counts[SIZE];
        for (;;)
        {
            let child = at * 2 + 1;
            if (child >= size)
            {
                break;
            }
            if (child + 1 < size && before(heap[child + 1], heap[child]))
            {
                child++;
            }
            if (!before(heap[child], id))
            {
                break;
            }
            put(at, heap[child]);
            at = child;
        }
        put(at, id);
    };

    /** Puts an unscheduled id into the heap with the due and rank it holds. @param {number} id */
    const insert = id=>{
        const at = counts[SIZE]++;
        put(at, id);
        up(at);
    };

    /** Takes a scheduled id out of the heap. @param {number} id */
    const unlink = id=>{
        const at = place[id];
        place[id] = IDLE;
        const last = --counts[SIZE];
        if (at === last)
        {
            return;
        }
        const moved = heap[last];
        put(at, moved);
        up(at);
        down(place[moved]);
    };

    /** @param {number} id */
    const held = id=>{
        if (!(id >= 0 && id < place.length) || place[id] === FREE)
        {
            throw new RangeError(`deadline id ${id} is not claimed`);
        }
    };

    /** @param {number} id @param {number} due */
    const schedule = (id, due)=>{
        dueOf[id] = due;
        if (place[id] >= 0)
        {
            up(place[id]);
            down(place[id]);
        }
        else
        {
            insert(id);
        }
    };

    return {
        claim(){
            if (counts[FREED] > 0)
            {
                const id = free[--counts[FREED]];
                place[id] = IDLE;
                rankOf[id] = -1;
                return id;
            }
            const id = counts[CLAIMED]++;
            if (id >= place.length)
            {
                grow(id + 1);
            }
            place[id] = IDLE;
            rankOf[id] = -1;
            return id;
        },

        release(id){
            held(id);
            if (place[id] >= 0)
            {
                unlink(id);
            }
            place[id] = FREE;
            free[counts[FREED]++] = id;
        },

        add(due, id){
            held(id);
            rankOf[id] = counts[RANK]++;
            schedule(id, due);
        },

        move(id, due){
            held(id);
            if (rankOf[id] < 0)
            {
                rankOf[id] = counts[RANK]++;
            }
            schedule(id, due);
        },

        remove(id){
            held(id);
            if (place[id] >= 0)
            {
                unlink(id);
            }
            place[id] = IDLE;
        },

        has: id=>id >= 0 && id < place.length && place[id] >= 0,

        due: id=>(id >= 0 && id < place.length && place[id] >= 0 ? dueOf[id] : Infinity),

        first: ()=>(counts[SIZE] > 0 ? heap[0] : -1),

        soonest: ()=>(counts[SIZE] > 0 ? dueOf[heap[0]] : Infinity),

        takeDue(now, visit){
            if (counts[VISITING] !== 0)
            {
                throw new Error('takeDue called from inside its own visit');
            }
            if (counts[SIZE] === 0 || dueOf[heap[0]] > now)
            {
                return;
            }
            let count = 0;
            while (counts[SIZE] > 0 && dueOf[heap[0]] <= now)
            {
                const id = heap[0];
                unlink(id);
                place[id] = TAKEN;
                taken[count++] = id;
            }
            counts[VISITING] = 1;
            let at = 0;
            try
            {
                while (at < count)
                {
                    const id = taken[at++];
                    if (place[id] !== TAKEN)
                    {
                        continue;
                    }
                    place[id] = IDLE;
                    if (visit(id, dueOf[id]) === true)
                    {
                        break;
                    }
                }
            }
            finally
            {
                counts[VISITING] = 0;
                // What a stop or a throw left unvisited goes back as it was.
                while (at < count)
                {
                    const id = taken[at++];
                    if (place[id] === TAKEN)
                    {
                        insert(id);
                    }
                }
            }
        },

        size: ()=>counts[SIZE],
    };
}
