/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Reservations past 4 GiB in a 64-bit process whose memory is the 4 GiB
 * window (the memory layer's `farSpace`): VirtualAlloc's reservations that the
 * window should not hold, or cannot, and their commits, decommits, releases,
 * protections and queries.
 *
 * A 64-bit Unity player reserves 512 MiB at a time and commits a megabyte of
 * each: 8 GiB and more of space for megabytes of pages. A memory that long is
 * collected without end by a browser that counts it against a thread's limit,
 * so the space is the far one, which no memory holds: each 64 KiB chunk of it
 * with a page committed is given a frame of the window's arena, and the
 * process's table of far chunks (the cpu layer's) sends an access there.
 * Everything else about a reservation - which pages are committed, their
 * protections - is kept here by page, and the pages of a frame are opened and
 * closed as the far pages they stand for are.
 *
 * A wide window's RAM past 4 GiB is a far space too, whose chunks below its
 * `direct` line are their own frames: no table, the memory holds them where
 * they are. What a 64-bit program needs past what 4 GiB holds is placed there,
 * found, committed, protected and queried by the same code.
 */

/** Allocation states and types, as MEMORY_BASIC_INFORMATION has them. */
const MEM_COMMIT = 0x1000;
const MEM_RESERVE = 0x2000;
const MEM_FREE = 0x10000;
const MEM_PRIVATE = 0x20000;
const PAGE_NOACCESS = 0x01;
const PAGE_GUARD = 0x100;
const PAGE = 4096;
const GRANULE = 0x10000;

/** The owner a frame's block carries in the arena's allocator. */
const FAR_FRAME = 'far frame';

/**
 * @typedef {{ base: number, span: number, protect: number, pages: Uint16Array,
 *     frames: Map<number, number> }} FarReservation
 *     `pages`: each page's protection where it is committed, 0 where only reserved;
 *     `frames`: by chunk index from `base`, the window's frame given that chunk
 */

/**
 * @param {{ space: { base: number, top: number, chunk: number, direct?: number,
 *         table?: number },
 *     allocator: { allocate: (bytes: number, options?: { alignment?: number, owner?: any })
 *         => number, free: (address: number) => void },
 *     mapFar: (address: number, frame: number) => void,
 *     room: (end: number) => boolean,
 *     charge?: (bytes: number) => boolean,
 *     inTheWay?: (from: number, to: number) => number,
 *     held?: (base: number, span: number, held: boolean) => void,
 *     fill: (address: number, value: number, length: number) => void,
 *     pageAccess?: (address: number, length: number, open: boolean) => boolean }} host
 *     `table`: where the table's chunks begin past a wide window, its last 64 KiB from
 *     `direct` on no one's;
 *     `room` grows the guest's memory to hold a frame's end and charges it, false where
 *     the machine has no room; `charge` takes a chunk of its own frame (below `direct`)
 *     from the machine's memory, false where it has no room; `inTheWay` is the end of
 *     what else the process has in [from, to) (an image), or 0; `held` says a
 *     reservation of the direct part made or released, for the process's map of its space
 */
export function createFarSpace(host){
    const { space, allocator } = host;
    const { chunk } = space;
    const direct = space.direct ?? space.base;
    /**
     * The end of what lies in [from, to) that is no reservation's: what the
     * process has in its direct part itself (an image), or the space between a
     * wide window's RAM and the table's first chunk; 0 for none. Past the window
     * the far space is all its own.
     *
     * @param {number} from @param {number} to
     */
    const inTheWay = (from, to)=>(space.table !== undefined && direct < to && space.table > from
        ? space.table : from < direct ? host.inTheWay?.(from, Math.min(to, direct)) ?? 0 : 0);
    /** Chunks of their own frames ever charged: given once, the tab's for good. @type {Set<number>} */
    const charged = new Set();
    // Nothing of the direct part reads as committed before it is.
    if (direct > space.base)
    {
        host.pageAccess?.(space.base, direct - space.base, false);
    }
    /** Reservations by base, and their bases in order for placing and finding. @type {Map<number, FarReservation>} */
    const reservations = new Map();
    /** @type {number[]} */
    const bases = [];
    let frames = 0;

    /** The reservation holding an address, or null. @param {number} address */
    const find = address=>{
        let low = 0;
        let high = bases.length - 1;
        while (low <= high)
        {
            const middle = (low + high) >> 1;
            const found = /** @type {FarReservation} */ (reservations.get(bases[middle]));
            if (address < found.base)
            {
                high = middle - 1;
            }
            else if (address >= found.base + found.span)
            {
                low = middle + 1;
            }
            else
            {
                return found;
            }
        }
        return null;
    };

    /** Whether [from, to) is free of reservations and inside the space. @param {number} from @param {number} to */
    const free = (from, to)=>from >= space.base && to <= space.top
        && inTheWay(from, to) === 0
        && !bases.some(base=>{
            const other = /** @type {FarReservation} */ (reservations.get(base));
            return other.base < to && other.base + other.span > from;
        });

    /** @param {number} base @param {number} span @param {number} protect */
    const make = (base, span, protect)=>{
        /** @type {FarReservation} */
        const made = { base, span, protect, pages: new Uint16Array(span / PAGE),
            frames: new Map() };
        reservations.set(base, made);
        if (base < direct)
        {
            host.held?.(base, span, true);
        }
        bases.push(base);
        bases.sort((a, b)=>a - b);
        return made;
    };

    /**
     * Opens or closes a far range's pages where they have frames, as their
     * commits and protections say.
     *
     * @param {FarReservation} reservation @param {number} from @param {number} to
     */
    const settle = (reservation, from, to)=>{
        if (host.pageAccess === undefined)
        {
            return;
        }
        for (let page = from; page < to; page += PAGE)
        {
            const frame = reservation.frames.get(Math.floor((page - reservation.base) / chunk));
            if (frame === undefined)
            {
                continue;
            }
            const protection = reservation.pages[(page - reservation.base) / PAGE];
            host.pageAccess(frame + (page - reservation.base) % chunk, PAGE,
                protection !== 0 && (protection & 0xff) !== PAGE_NOACCESS
                    && (protection & PAGE_GUARD) === 0);
        }
    };

    return {
        space,
        find,

        /**
         * A new reservation of `span` bytes, a multiple of 64 KiB, at the lowest
         * place from `from` it fits; 0 where none does.
         *
         * @param {number} span @param {number} protect @param {number} [from]
         */
        reserve(span, protect, from = space.base){
            let at = from;
            for (const base of bases)
            {
                const other = /** @type {FarReservation} */ (reservations.get(base));
                if (other.base + other.span <= at)
                {
                    continue;
                }
                if (at + span <= base)
                {
                    break;
                }
                at = Math.max(at, Math.ceil((other.base + other.span) / GRANULE) * GRANULE);
            }
            // Past what the process has there of its own (a wide window's image),
            // and past any reservation that then lies in the way.
            for (let end = inTheWay(at, at + span); end > 0; end = inTheWay(at, at + span))
            {
                at = Math.ceil(end / GRANULE) * GRANULE;
                const after = bases.find(base=>{
                    const other = /** @type {FarReservation} */ (reservations.get(base));
                    return other.base < at + span && other.base + other.span > at;
                });
                if (after !== undefined)
                {
                    const other = /** @type {FarReservation} */ (reservations.get(after));
                    at = Math.ceil((other.base + other.span) / GRANULE) * GRANULE;
                }
            }
            if (at + span > space.top)
            {
                return 0;
            }
            make(at, span, protect);
            return at;
        },

        /**
         * A new reservation where the program asks for it: false where any of it
         * is taken or outside the space.
         *
         * @param {number} base @param {number} span @param {number} protect
         */
        reserveAt(base, span, protect){
            if (!free(base, base + span))
            {
                return false;
            }
            make(base, span, protect);
            return true;
        },

        /**
         * Commits [from, to), whole pages of one reservation, with `protect`: a
         * frame for each chunk it reaches that has none, the frame's pages
         * zero. False where the window has no room for a frame.
         *
         * @param {FarReservation} reservation @param {number} from @param {number} to
         * @param {number} protect
         */
        commit(reservation, from, to, protect){
            const first = Math.floor((from - reservation.base) / chunk);
            const last = Math.floor((to - 1 - reservation.base) / chunk);
            for (let index = first; index <= last; index++)
            {
                if (reservation.frames.has(index))
                {
                    continue;
                }
                const address = reservation.base + index * chunk;
                if (address < direct)
                {
                    if (!charged.has(address) && host.charge?.(chunk) === false)
                    {
                        return false;
                    }
                    // Fresh RAM reads as zero already; one given before is zeroed.
                    if (charged.has(address))
                    {
                        host.fill(address, 0, chunk);
                    }
                    charged.add(address);
                    reservation.frames.set(index, address);
                    frames++;
                    continue;
                }
                const frame = allocator.allocate(chunk, { alignment: chunk, owner: FAR_FRAME });
                if (frame === 0 || !host.room(frame + chunk))
                {
                    if (frame !== 0)
                    {
                        allocator.free(frame);
                    }
                    return false;
                }
                host.fill(frame, 0, chunk);
                host.pageAccess?.(frame, chunk, false);
                reservation.frames.set(index, frame);
                host.mapFar(address, frame);
                frames++;
            }
            for (let page = from; page < to; page += PAGE)
            {
                const at = (page - reservation.base) / PAGE;
                // A page committed already keeps its protection, as on Windows.
                if (reservation.pages[at] === 0)
                {
                    reservation.pages[at] = protect;
                }
            }
            settle(reservation, from, to);
            return true;
        },

        /**
         * Decommits [from, to): the pages read as reserved, and a chunk with no
         * page committed left gives its frame back.
         *
         * @param {FarReservation} reservation @param {number} from @param {number} to
         */
        decommit(reservation, from, to){
            reservation.pages.fill(0, (from - reservation.base) / PAGE,
                (to - reservation.base) / PAGE);
            settle(reservation, from, to);
            const first = Math.floor((from - reservation.base) / chunk);
            const last = Math.floor((to - 1 - reservation.base) / chunk);
            for (let index = first; index <= last; index++)
            {
                const frame = reservation.frames.get(index);
                const pages = reservation.pages.subarray(index * chunk / PAGE,
                    Math.min(reservation.pages.length, (index + 1) * chunk / PAGE));
                if (frame !== undefined && pages.every(page=>page === 0))
                {
                    // A chunk of its own frame stays closed where it is.
                    if (frame >= direct || frame !== reservation.base + index * chunk)
                    {
                        host.mapFar(reservation.base + index * chunk, -1);
                        host.pageAccess?.(frame, chunk, true);
                        allocator.free(frame);
                    }
                    reservation.frames.delete(index);
                    frames--;
                }
            }
        },

        /**
         * Releases the whole reservation.
         *
         * @param {FarReservation} reservation
         */
        release(reservation){
            this.decommit(reservation, reservation.base, reservation.base + reservation.span);
            reservations.delete(reservation.base);
            if (reservation.base < direct)
            {
                host.held?.(reservation.base, reservation.span, false);
            }
            bases.splice(bases.indexOf(reservation.base), 1);
        },

        /**
         * Changes the protection of committed pages [from, to): the first page's
         * old one back, or -1 where a page of the range is not committed.
         *
         * @param {FarReservation} reservation @param {number} from @param {number} to
         * @param {number} protect
         */
        protect(reservation, from, to, protect){
            const first = (from - reservation.base) / PAGE;
            const pages = reservation.pages.subarray(first, (to - reservation.base) / PAGE);
            if (pages.some(page=>page === 0))
            {
                return -1;
            }
            const old = reservation.pages[first];
            pages.fill(protect);
            settle(reservation, from, to);
            return old;
        },

        /**
         * VirtualQuery's answer at a far address: [base, allocation base,
         * allocation protection, size, state, protection, type].
         *
         * @param {number} address
         * @returns {[number, number, number, number, number, number, number]}
         */
        query(address){
            const page = Math.floor(address / PAGE) * PAGE;
            const reservation = find(page);
            if (reservation === null)
            {
                const next = bases.find(base=>base > page) ?? space.top;
                return [page, 0, 0, next - page, MEM_FREE, PAGE_NOACCESS, 0];
            }
            const at = (page - reservation.base) / PAGE;
            const state = reservation.pages[at];
            let end = at + 1;
            while (end < reservation.pages.length && reservation.pages[end] === state)
            {
                end++;
            }
            return [page, reservation.base, reservation.protect, (end - at) * PAGE,
                state === 0 ? MEM_RESERVE : MEM_COMMIT, state, MEM_PRIVATE];
        },

        /** What the far space holds: its reservations and the frames given. */
        diagnostics: ()=>({ reservations: reservations.size, frames,
            reserved: [...reservations.values()].reduce((total, one)=>total + one.span, 0) }),
    };
}
