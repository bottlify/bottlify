/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Writes into code, and where code may be formed: a store into a page that
 * holds translated code drops the regions made of a byte it changed
 * (`storedInto`, judged against the bytes they were formed from), a page
 * written over too often is left to the other executor for a while
 * (`volatileUntil`) or taken for stubs (`STUB_WRITES`), and the pages'
 * generations tell a region formed before a write from one formed after. The
 * host's ways in -- its own writes (`stored`), the stores an executor met
 * (`codeWritten`, `takeCodeWrites`), the write watch (`takeWrites`,
 * `markWritten`) and the threads' stacks (`noteStack`) -- all end here.
 */

import { PageFlag } from './pages.js';
import { SharedSwitch } from './shared-code.js';

/** @typedef {import('./state.js').RegionRecord} RegionRecord */

/**
 * @param {object} state  the runtime's state (`state.js`), typed inside: its type is
 *     made of what this returns
 */
export function createCodeWrites(state){
    const rt = /** @type {import('./state.js').State} */ (state);
    const { codeBase, codePages, codeShared, guestBytes, nowMs, pages, read, settings
    } = /** @type {import('./state.js').Base} */ (state);
    const { WATCH_KEYS, barren, byPage, counts, pageKeys, readsFaulted, stackCodeSeen, stackPages,
        unpublish, unqueue, watchable, watched } = rt;
    /** @type {Map<number, number>} page → times invalidated, the stamp a batch checks */
    const generation = new Map();
    /**
     * By page, the writes that dropped its regions: how many since `since`, the window's
     * start, how many in all (`costs`), and how many times it was left volatile.
     * @type {Map<number, { times: number, since: number, left: number, costs: number }>}
     */
    const dropped = new Map();
    /**
     * Writes that cost a page its regions, in all, past which it is a page of stubs: code a
     * program patches one piece at a time (a managed runtime's precode, each stub written
     * when its method is first called), never enough at once to be volatile, while every
     * write dropped each region that ran into a stub there.
     */
    const STUB_WRITES = 2;
    /** By volatile page, when it is translated again. @type {Map<number, number>} */
    const volatileUntil = new Map();
    /**
     * By volatile page, the entries of the regions writes dropped there, with
     * their tops: code that ran hot enough to be translated, which the
     * interpreter's own counts -- saturated long before the page is let go --
     * would not hand over again.
     * @type {Map<number, Map<number, number>>}
     */
    const leftEntries = new Map();
    /** The pages whose hold is over go back to the translator. */
    const liftVolatile = ()=>{
        if (volatileUntil.size === 0)
        {
            return;
        }
        const at = nowMs();
        for (const [page, until] of volatileUntil)
        {
            if (at >= until)
            {
                volatileUntil.delete(page);
                codePages.clear(page, PageFlag.VOLATILE);
                // What was asked for there while it was left formed nothing: asked
                // again, it is translated.
                for (const key of pageKeys.get(page) ?? [])
                {
                    barren.delete(key);
                }
                for (const [entry, top] of leftEntries.get(page) ?? [])
                {
                    rt.runtimeApi?.noteHot(entry, top, 256);
                }
                leftEntries.delete(page);
                const record = dropped.get(page);
                if (record !== undefined)
                {
                    record.times = 0;
                    record.since = at;
                }
            }
        }
    };

    /** @param {Set<number>} of */
    const stamp = of=>[...of].map(page=>generation.get(page) ?? 0).join(',');

    /**
     * @param {number} page
     * @param {RegionRecord[]} [only]  the regions on it that go; every one by default
     * @returns {RegionRecord[]}  the regions that went, unless the page was left volatile
     */
    const invalidatePage = (page, only)=>{
        if (watched[page] === 0)
        {
            return [];
        }
        const on = byPage.get(page);
        const going = only ?? (on ? [...on] : []);
        const cost = going.length;
        if (cost > 0)
        {
            unpublish(going);
            counts.invalidations += cost;
        }
        const notes = pageKeys.get(page);
        if (notes)
        {
            counts.queueDrops += notes.size;
            for (const key of notes)
            {
                unqueue(key);
                barren.delete(key);
            }
            pageKeys.delete(page);
            watched[page] &= ~WATCH_KEYS;
        }
        generation.set(page, (generation.get(page) ?? 0) + 1);
        // Only a write that cost a region counts towards volatility: the
        // loader placing an image writes a page many times before anything
        // on it is hot, and that is not a page that mixes code with data.
        if (cost === 0)
        {
            return going;
        }
        const at = nowMs();
        let record = dropped.get(page);
        if (record === undefined)
        {
            record = { times: 0, since: at, left: 0, costs: 0 };
            dropped.set(page, record);
        }
        record.costs++;
        if (at - record.since > settings.volatileWindowMs)
        {
            record.times = 0;
            record.since = at;
        }
        record.times++;
        if (record.times === settings.volatileAfter && !volatileUntil.has(page))
        {
            codePages.set(page, PageFlag.VOLATILE);
            volatileUntil.set(page, at + settings.volatileHoldMs * 2 ** Math.min(record.left, 5));
            leftEntries.set(page, new Map(going.map(one=>[one.entry, one.entryTop])));
            record.left++;
            counts.volatilePages++;
            return [];
        }
        return going;
    };

    /**
     * Whether a byte of `sources` in `[address, end)` reads otherwise now.
     * @param {{ start: number, bytes: Uint8Array }[]} sources @param {number} address
     * @param {number} end
     */
    const sourcesChanged = (sources, address, end)=>{
        for (const { start, bytes } of sources)
        {
            const from = Math.max(start, address);
            const to = Math.min(start + bytes.length, end);
            const now = from < to ? guestBytes(from, to) : null;
            if (now !== null)
            {
                for (let k = 0, at = from - start; k < now.length; k++, at++)
                {
                    if (now[k] !== bytes[at])
                    {
                        return true;
                    }
                }
                continue;
            }
            for (let at = from; at < to; at++)
            {
                if (read(at) !== bytes[at - start])
                {
                    return true;
                }
            }
        }
        return false;
    };

    /**
     * Whether `sources` hold a byte of `[address, end)`.
     * @param {{ start: number, bytes: Uint8Array }[]} sources @param {number} address
     * @param {number} end
     */
    const sourcesMet = (sources, address, end)=>sources.some(({ start, bytes })=>
        start < end && address < start + bytes.length);

    /**
     * The bytes of each page a store into code has met, as the last store
     * there left them: what a store into none of the page's regions is judged
     * by. Only a choice of speed rides on it -- whether the page stays code --
     * since every region's own bytes are judged by its copy (`sources`).
     *
     * @type {Map<number, Uint8Array>}
     */
    const pageBytes = new Map();

    /**
     * Whether the store over `[address, end)` changed a byte of `page` from
     * what the page's copy holds, the copy taken up to date. A page met for
     * the first time has no copy to judge by: changed.
     *
     * @param {number} page @param {number} address @param {number} end
     */
    const pageChanged = (page, address, end)=>{
        const base = page * 4096;
        const copy = pageBytes.get(page);
        if (!copy)
        {
            const whole = guestBytes(base, base + 4096);
            if (whole !== null)
            {
                pageBytes.set(page, whole.slice());
                return true;
            }
            const made = new Uint8Array(4096);
            for (let at = 0; at < 4096; at++)
            {
                made[at] = read(base + at);
            }
            pageBytes.set(page, made);
            return true;
        }
        let changed = false;
        const to = Math.min(end, base + 4096);
        const from = Math.max(address, base);
        const current = from < to ? guestBytes(from, to) : null;
        if (current !== null)
        {
            for (let k = 0, at = from - base; k < current.length; k++, at++)
            {
                if (copy[at] !== current[k])
                {
                    copy[at] = current[k];
                    changed = true;
                }
            }
            return changed;
        }
        for (let at = from; at < to; at++)
        {
            const now = read(at);
            if (copy[at - base] !== now)
            {
                copy[at - base] = now;
                changed = true;
            }
        }
        return changed;
    };

    /** @param {any} record */
    const sourcesOf = record=>
        /** @type {{ start: number, bytes: Uint8Array }[]} */ (record.sources);
    /**
     * Bytes at `[address, address + size)` were written while code stood on
     * their pages. A region goes when a byte it was made from now differs:
     * a program that writes its code over with the bytes already there -- a
     * mixer setting every voice's patch on each call, most of them as they
     * were -- keeps its translations, and one that changes a byte loses the
     * regions made of that byte and no other on the page. A page with a region
     * that kept no copy of its bytes goes whole, as every page did before its
     * first such store; the regions formed on it again keep theirs.
     *
     * The page's generation moves either way, so a region in flight from it
     * is checked again at its publication rather than trusted.
     *
     * @param {number} address @param {number} size
     * @param {boolean} [own]  the program's own store, whose dropped code is asked for again
     *     at once; a host's write (a file read, a loader) places bytes nothing has run yet,
     *     which run first where cold code runs
     */
    const storedInto = (address, size, own = true)=>{
        if (size <= 0)
        {
            return;
        }
        const end = address + size;
        const last = (end - 1) >>> 12;
        for (let page = address >>> 12; page <= last; page++)
        {
            // No region and no candidate on the page: nothing a store there can
            // make wrong. Nearly every host write is an answer into a stack or
            // a buffer, and judging it would keep a copy of every page the host
            // ever wrote -- a game's files read, page for page -- to compare
            // the next write against.
            if (watched[page] === 0)
            {
                continue;
            }
            const on = byPage.get(page);
            // With other executors beside this one a page goes whole, as before:
            // their stores reach this one's regions only when it next looks
            // (`takeCodeWrites`), and keeping regions across that gap is not
            // yet judged by the executors' gate.
            // Walked rather than copied: every host write into a watched page
            // comes here, the arguments of every call into the guest among
            // them, and a copy of the page's regions per write was garbage.
            let whole = codeShared !== null || on === undefined || on.size === 0;
            if (!whole && on !== undefined)
            {
                for (const record of on)
                {
                    if (record.sources === undefined)
                    {
                        whole = true;
                        break;
                    }
                }
            }
            /** @type {any[] | undefined} */
            let met;
            if (!whole && on !== undefined)
            {
                met = [];
                for (const record of on)
                {
                    if (sourcesMet(sourcesOf(record), address, end))
                    {
                        met.push(record);
                    }
                }
            }
            // Into none of the page's regions' bytes: no translation is wrong
            // for it, and what is left to decide is whether the page stays
            // code. A store that changed what was there is data beside the
            // code -- a variable between two functions, written on every turn
            // of a loop -- and kept as code the page would send every such
            // store to the interpreter, ten times the loop's cost in the
            // measured case; it goes whole, as before any store was judged by
            // its bytes, and nothing is asked for again. One that wrote the
            // bytes already there is a patch set again over code no region
            // took in, and the page stays.
            if (met !== undefined && met.length === 0 && pageChanged(page, address, end))
            {
                invalidatePage(page);
                continue;
            }
            if (whole)
            {
                // The copy a later store into none of the regions is judged by.
                pageChanged(page, address, end);
            }
            if (met !== undefined && met.length > 0 && pageBytes.has(page))
            {
                // Kept up to date for the next store into none of them.
                pageChanged(page, address, end);
            }
            const changed = met?.filter(record=>sourcesChanged(sourcesOf(record), address, end));
            if (changed === undefined || changed.length > 0)
            {
                // Code hot enough to have been translated runs on as it is now,
                // on the interpreter, whose counts of it are long saturated: it
                // is asked for again at once, so the bytes written are what is
                // translated next.
                for (const one of invalidatePage(page, changed))
                {
                    if (own && codeShared === null)
                    {
                        rt.runtimeApi?.noteHot(one.entry, one.entryTop, 256);
                    }
                }
                continue;
            }
            counts.storesKept++;
            generation.set(page, (generation.get(page) ?? 0) + 1);
        }
    };
    /**
     * `storedInto` for a store the host tells of, at its address in the window: the
     * translator's code is the code block's (`codeBase`), and a store outside the
     * block reaches none of it.
     *
     * @param {number} address @param {number} size @param {boolean} [own]
     */
    const storeIntoBlock = (address, size, own = true)=>{
        const offset = address - codeBase;
        if (codeBase === 0 || (offset > -size && offset < 2 ** 32))
        {
            storedInto(offset, size, own);
        }
    };

    /** @param {number} address */
    const translatable = address=>(codePages.get(address >>> 12)
        & (PageFlag.VOLATILE | PageFlag.INACCESSIBLE | PageFlag.NO_EXECUTE)) === 0
        // A diagnostic: a range left to the interpreter, to find which code a
        // translation goes wrong in by halving it.
        && !(settings.interpretRange && address >= settings.interpretRange[0]
            && address < settings.interpretRange[1]);
    /** @param {number} page */
    const stubPage = page=>(dropped.get(page)?.costs ?? 0) >= STUB_WRITES;
    /**
     * What a region formed from `entry` may form on: a page of stubs (`STUB_WRITES`) holds
     * only regions entered there, which stay on it, so a write to a stub drops the stub's
     * own small region and none that ran into it from elsewhere.
     *
     * @param {number} entry
     * @returns {(address: number) => boolean}
     */
    const formableFrom = entry=>{
        const home = entry >>> 12;
        return stubPage(home) ? address=>address >>> 12 === home && translatable(address)
            : address=>!stubPage(address >>> 12) && translatable(address);
    };
    /**
     * `[address, address + size)` was written over code: the regions made of
     * a byte it changed go (`storedInto`).
     *
     * @param {number} address @param {number} size
     * @param {boolean} [own]  a store of the program's own, met by the host's
     *     interpreter, rather than the host's write
     */
    const stored = (address, size, own = false)=>{
        pages.markWrittenRange(address, size);
        storeIntoBlock(address, size, own);
    };
    /**
     * A store this executor met reached code: `stored` as the program's own,
     * and the other executors of the process are told their translations of
     * the pages go too.
     *
     * @param {number} address @param {number} size
     */
    const codeWritten = (address, size)=>{
        if (size <= 0)
        {
            return;
        }
        stored(address, size, true);
        codeShared?.publish(address, size);
    };
    /**
     * The pages of `[address, address + length)` written since they were
     * armed, or never armed, each armed from now: a store finds an armed
     * page by the flag its page check already reads (`PageFlag.WATCH`),
     * and only its first store after the arming does more than any store
     * does. A page on a thread's stack is always among them while stores
     * through esp go untested (`looseStacks`): no store there would mark
     * it. A store another executor tested before this call and makes after
     * it lands unmarked, and arming a page wipes its mark for every caller:
     * the host's write watch (`write-clock.js` in the cpu layer) answers both.
     *
     * @param {number} address @param {number} length
     * @returns {number[]}
     */
    const takeWrites = (address, length)=>{
        /** @type {number[]} */
        const written = [];
        const last = length > 0 ? (address + length - 1) >>> 12 : address >>> 12;
        for (let page = address >>> 12; page <= last; page++)
        {
            if (!watchable(page) || pages.takeWritten(page))
            {
                written.push(page);
            }
        }
        return written;
    };
    /**
     * Bytes another thread wrote into guest memory in place, outside every
     * path a write takes here: the armed pages they reach are marked.
     *
     * @param {number} address @param {number} length
     */
    const markWritten = (address, length)=>{
        pages.markWrittenRange(address, length);
    };
    /**
     * The stores into code the process's other executors met since this
     * one last looked: its translations of those pages go. Asked before
     * each slice.
     */
    const takeCodeWrites = ()=>{
        // A switch another executor flipped is this one's too.
        const raised = codeShared?.switches() ?? 0;
        if ((raised & SharedSwitch.STACKS_TESTED) !== 0)
        {
            stackCodeSeen();
        }
        if ((raised & SharedSwitch.READS_CHECKED) !== 0)
        {
            readsFaulted();
        }
        return codeShared?.take((address, size)=>{
            if (size === 0xffffffff)
            {
                for (const page of [...byPage.keys()])
                {
                    invalidatePage(page);
                }
                return;
            }
            storedInto(address, size);
        }) ?? 0;
    };
    /**
     * A thread's stack the host names, `[base, base + size)`: its pages are kept as a
     * stack's (`watchable`), and code already on one ends the untested stores through
     * esp (`stackCodeSeen`).
     *
     * @param {number} base @param {number} size
     */
    const noteStack = (base, size)=>{
        const first = base >>> 12;
        const last = (base + Math.max(size, 1) - 1) >>> 12;
        // The other executors are not told: they read it where every
        // executor's stacks are kept.
        codeShared?.noteStack(first, last);
        for (let page = first; page <= last; page++)
        {
            stackPages.add(page);
            if ((pages.get(page) & PageFlag.HAS_CODE) !== 0)
            {
                stackCodeSeen();
            }
        }
    };
    return {
        dropped,
        STUB_WRITES,
        volatileUntil,
        liftVolatile,
        stamp,
        invalidatePage,
        sourcesChanged,
        pageBytes,
        storedInto,
        translatable,
        stubPage,
        formableFrom,
        stored,
        codeWritten,
        takeWrites,
        markWritten,
        takeCodeWrites,
        noteStack,
    };
}
