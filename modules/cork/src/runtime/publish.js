/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Publication: a formed or stored region made an entry of the run. A region
 * is stamped with its pages' generations, read again where the guest ran past
 * its forming, and published from the instance of its module
 * (`applyBuilt`); a relinked one is moved to its function in the new module
 * (`relinkOne`). A batch the store held is instantiated here; one it did not
 * is emitted on a worker or here and stored (`finishBatch`, `publishBatch`).
 * Where the work here is bounded (`holdMs`), what is ready waits in
 * `toPublish` and goes a credit's worth a call (`publishOn`), its store hits'
 * modules compiled off the thread first (`compileOn`).
 */

import { hashRegion } from '../region.js';
import { emitBatch } from './emit-built.js';
import { ANY_TOP, keyOf } from './entries.js';
import { PageFlag } from './pages.js';
import { Tables } from './layout.js';
import { packRegion } from './cache.js';
import { codeSpansOf, crtOf, emptiesOf, spansOf, summaryOf } from './summary.js';
import { usesX87 } from './variants.js';

/** @typedef {import('./state.js').RegionRecord} RegionRecord */
/** @typedef {import('./state.js').Pending} Pending */
/** @typedef {import('./state.js').Waiting} Waiting */
/** @typedef {import('./state.js').Publishing} Publishing */

/**
 * @param {object} state  the runtime's state (`state.js`), typed inside: its type is
 *     made of what this returns
 */
export function createPublish(state){
    const rt = /** @type {import('./state.js').State} */ (state);
    const { cacheVersion, clock, codePages, codeShared, emitLayout, entries, formOptions, found,
        read, settings, table } = /** @type {import('./state.js').Base} */ (state);
    const { EVICT_HOLD, GRANULES, WATCH_REGIONS, barrenAdd, batchInstances, byPage, checkedAt,
        closedIn, closedPages, compiledBytes, countExtents, counts, cover, coverKeys, crtFormed,
        dropped, emitCache, emitOptions, evictedKeys, freeTable, freeTranslator, heldStarts,
        inFlight, instantiate, joinHeld, joinModule, keepBatch, leaveModule, noteWay, ownKeys,
        placedOf,
        precisionFlags, precisionJob, precisionOf, recordAt, recordOf, refused, refusedWhy,
        regions, relaxedFlagReads, roundedKeys, shapeOf, share, sourcesChanged, stackCodeSeen,
        stackPages, stamp, storeKey, storeModule, storeTrace, storeVersionFor, throughStack, trace,
        uncoverKeys, unpublish, watched } = rt;
    // The milliseconds emitted on this thread, read on every build: what a
    // host's pool takes as a want for a worker (`translatedHere`). The
    // translator's phase timings are a diagnostic and read 0 in a shipped
    // build, and a pool going by them never lent a process its worker again
    // once it had given it back.
    let emittedHereMs = 0;
    /** @type {Publishing[]} */
    const toPublish = [];
    let workerRequest = 0;

    /** Folds what the emitter left out into the run's refusal maps, the reads of
     * flags the fast default leaves undefined into theirs, and the x87 status-word
     * reads it let see what it relaxed into their count.
     * @param {{ unsupported?: [string, number][], refusals?: [string, number][],
     *     relaxedReads?: [string, number][], x87RelaxedReads?: number }} built */
    const foldTranslation = built=>{
        counts.x87RelaxedReads += built.x87RelaxedReads ?? 0;
        for (const [opcode, times] of built.relaxedReads ?? [])
        {
            relaxedFlagReads[opcode] = (relaxedFlagReads[opcode] ?? 0) + times;
        }
        for (const [opcode, times] of built.unsupported ?? [])
        {
            refused[opcode] = (refused[opcode] ?? 0) + times;
        }
        for (const [key, times] of built.refusals ?? [])
        {
            refusedWhy[key] = (refusedWhy[key] ?? 0) + times;
        }
    };
    /** Batch modules instantiated since the last relink began. */
    let modulesSinceRelink = 0;
    // What the translated code had retired when the last of them was published: a
    // relink waits until none has come for a while (`relinkQuiet`).
    let modulePublishedAt = 0;

    /**
     * Stamps a built or stored region and publishes every block start as an
     * entry: its function out of the instance of the module that holds it.
     * The whole of the publish half of the old batch loop, so a worker's
     * answer and an inline emission take the same path.
     *
     * @param {{ region: import('../region.js').Region, entryTop: number, stamp: string,
     *     wide?: boolean, narrow?: boolean, floats?: boolean, checked?: boolean,
     *     ownWindows?: boolean, copies?: boolean,
     *     loose?: boolean, wrapped?: boolean, anyTop?: boolean, byHash?: boolean,
     *     replaces?: RegionRecord, targets?: [number, number[]][], copying?: boolean,
     *     sites?: number[], waited?: boolean }} one
     *     replaces: the region it is formed again from, with the callees of its indirect calls
     *     (`targets`), or with copies of the blocks inside its loops (`copying`); sites: the
     *     indirect calls it was formed again for, each spending one of its own reforms;
     *     waited: the guest ran between its forming and now
     * @param {{ labels: [number, number][], cut: number[], closed?: number[], entryTop: number,
     *     exportName?: string, linked?: boolean }} built
     * @param {WebAssembly.Instance} instance
     * @returns {number} 1 when a region was published, 0 when it was dropped
     */
    const applyBuilt = (one, built, instance)=>{
        const { region } = one;
        inFlight.delete(keyOf(region.entry, one.entryTop));
        const eip = region.entry;
        const publishAt = clock();
        // An x87 region built for a precision control before another was seen
        // would only leave at once: its bytes are translated again for that.
        // So would one built to test the stack's shape once its test had failed.
        // A write moves a page's generation only once code is published on it,
        // so a region the guest ran past before this -- its lookups out, its
        // batch on the worker -- is also read again: a guest store into a page
        // whose first region was in flight is otherwise seen by nothing.
        // A region that keeps the bytes it read (`storedInto`) is checked
        // against them whatever its stamp says: another executor's store moves
        // this one's generations only when it next looks (`takeCodeWrites`).
        // The bytes are every one forming read, a jump's target looked past
        // included, which its hash does not cover.
        const keepsSources = region.sources !== undefined
            && [...region.pages].some(page=>dropped.has(page));
        const moved = one.stamp !== stamp(region.pages) || one.waited === true || keepsSources;
        if ((moved && (region.sources !== undefined
            ? sourcesChanged(region.sources, 0, 0x100000000)
            : one.stamp !== stamp(region.pages) || hashRegion(read, region) !== region.hash))
            || ((one.wide === true || one.narrow === true)
                && precisionOf(region) !== (one.wide === true ? 'wide' : 'narrow'))
            || (one.floats === true && roundedKeys.has(keyOf(region.entry, one.entryTop)))
            || (one.loose && !rt.loose)
            || (one.wrapped && rt.readsChecked)
            || (one.checked !== true && checkedAt(region, one.entryTop))
            || (one.ownWindows !== true && ownKeys.has(keyOf(region.entry, one.entryTop))))
        {
            // A page of it was written while the batch was built.
            counts.publishMs += clock() - publishAt;
            counts.dropped++;
            return 0;
        }
        const fn = /** @type {(label: number, budget: number) => number} */ (
            instance.exports[built.exportName ?? 'r0']);
        const cut = new Set(built.cut);
        const closed = built.closed ?? [];
        const closedSet = new Set(closed);
        // Entries for every block start but the cut ones; a region with x87
        // in it is keyed by the top it was compiled for. A block closed in a
        // loop is no x87 matter.
        // One with none is the same code at every top: where a block that is no
        // entry keys it by one all the same, that is the top it was asked at, not
        // the one its record was stored under - a store's hit entered at the
        // stored top left the asked one with no entry, and the exit came again.
        const withX87 = usesX87(region);
        const top = withX87 ? built.entryTop
            : built.labels.some(([start, label])=>cut.has(label) && !closedSet.has(start))
                ? one.entryTop : ANY_TOP;
        const starts = built.labels.filter(([, label])=>!cut.has(label));
        if (starts.length === 0)
        {
            // Every block leaves at once (an instruction the other executor's
            // first): nothing to enter, nothing to keep.
            counts.publishMs += clock() - publishAt;
            barrenAdd(eip, top, 'every block cut');
            return 0;
        }
        /** @type {Map<number, [number, number]>} */
        const extents = new Map();
        const code = codeSpansOf(region);
        for (const [start, end] of code)
        {
            if (end <= start)
            {
                continue;
            }
            // As `markCode` takes the span: the granules of its first and last
            // byte on each page it touches.
            const first = start >>> 12;
            const last = (end - 1) >>> 12;
            for (let page = first; page <= last; page++)
            {
                const from = page === first
                    ? (start & 0xfff) >>> Tables.CODE_GRANULE_SHIFT : 0;
                const to = page === last
                    ? (((end - 1) & 0xfff) >>> Tables.CODE_GRANULE_SHIFT) + 1 : GRANULES;
                const extent = extents.get(page);
                if (extent === undefined)
                {
                    extents.set(page, [from, to]);
                }
                else
                {
                    extent[0] = Math.min(extent[0], from);
                    extent[1] = Math.max(extent[1], to);
                }
            }
        }
        // Kept for the record a relink stores this region under again.
        const summary = settings.summaries === false ? null
            : summaryOf(region, one.entryTop);
        /** @type {RegionRecord} */
        const record = {
            entry: region.entry, pages: region.pages, reads: region.reads,
            formable: region.formable, slots: [], table: -1,
            spans: summary?.plan.spans ?? spansOf(region), extents,
            ...(summary === null ? {} : { summary }),
            entryTop: one.entryTop, hash: region.hash, labels: JSON.stringify(built.labels),
            linked: built.linked === true, wide: one.wide === true, loose: one.loose === true,
            wrapped: one.wrapped === true,
            narrow: one.narrow === true, floats: one.floats === true,
            checked: one.checked === true, ownWindows: one.ownWindows === true,
            copies: one.copies === true, closed, blocks: built.labels.length,
            anyTop: one.anyTop ?? !usesX87(region),
            ...((one.byHash ?? one.replaces?.byHash) === true ? { byHash: true } : {}),
            ...(one.targets === undefined ? {} : { targets: one.targets }),
        };
        if (keepsSources)
        {
            // A store into code met this page before: what forming read is kept,
            // so the next store there is judged by what it changes (`storedInto`).
            record.sources = region.sources;
        }
        if (one.replaces !== undefined)
        {
            // Formed again with its indirect calls' callees, or with copies:
            // the old region's entries give way to this one's.
            record.targets = one.targets;
            record.unformed = one.replaces.unformed;
            record.reforms = new Map(one.replaces.reforms ?? []);
            for (const site of one.copying === true ? [] : one.sites ?? [])
            {
                record.reforms.set(site, (record.reforms.get(site) ?? 0) + 1);
            }
            // The same code for the merges' bounds: formed again, it would
            // otherwise start over at none.
            record.merged = one.replaces.merged;
            record.movedAlone = one.replaces.movedAlone;
            if (regions.has(one.replaces))
            {
                unpublish([one.replaces]);
            }
        }
        const placed = placedOf.get(instance);
        if (table)
        {
            let index = placed === undefined ? freeTable.pop()
                : placed.base + Number((built.exportName ?? 'r0').slice(1));
            if (index === undefined)
            {
                index = rt.nextTable++;
                if (index >= table.length)
                {
                    table.grow(256);
                }
            }
            table.set(index, fn);
            record.table = index;
            recordAt.set(index, record);
        }
        if (placed !== undefined)
        {
            joinModule(record, placed);
        }
        const empties = settings.emptyCalls !== false ? emptiesOf(region) : null;
        for (const [start, label] of starts)
        {
            // A block that left held when entered at its start (`heldOnEntry`) is
            // no entry of a region that formed it in, published again or relinked.
            if (start !== region.entry && heldStarts.has(start * 16 + top))
            {
                entries.noteStart(start);
                continue;
            }
            // An address another region's entry already holds stays that
            // region's: the record keeps only the entries it made, or a relink
            // of it would put its function under the other's label (and a drop
            // of it would take the other's entry away) -- unless there it is
            // a copy of a block inside a loop (a label past twice its blocks,
            // `emitCopies`) and here it is not: a run entered there goes on in
            // this region's loops rather than in a flat dispatch.
            const empty = empties?.get(start) ?? 0;
            noteWay(start, 'published');
            let slot = entries.add(start, fn, label, top, record.table, empty);
            const held = entries.at(slot);
            const holder = recordOf.get(slot);
            if (held.fn !== fn && holder !== undefined && held.top === top
                && held.label >= 2 * (holder.blocks ?? Infinity) && label < 2 * built.labels.length)
            {
                entries.remove(slot);
                recordOf.delete(slot);
                holder.slots = holder.slots.filter(other=>other !== slot);
                slot = entries.add(start, fn, label, top, record.table, empty);
            }
            // The same function there already -- this region published again
            // from an instance a running record of it holds -- stays that
            // record's: an entry two records list is taken away by the first
            // dropped (`evict`) and named still by the other.
            const owner = recordOf.get(slot);
            if (entries.at(slot).fn === fn && (owner === undefined || !regions.has(owner)))
            {
                record.slots.push(slot);
                recordOf.set(slot, record);
            }
        }
        // A cut block start has no entry here: an address the runtime must
        // answer for with a region of its own at the machine's top, so a miss
        // there is a candidate, not an unknown address. A block closed in a
        // loop is this region's to answer for, formed again with copies once
        // translated code keeps leaving for it (`missAt`); the interpreter
        // runs through it to the loop's head, which has an entry.
        for (const [start, label] of built.labels)
        {
            if (cut.has(label) && !closedSet.has(start))
            {
                entries.noteStart(start);
            }
        }
        for (const start of closed)
        {
            let holders = closedIn.get(start);
            if (holders === undefined)
            {
                holders = new Set();
                closedIn.set(start, holders);
                const page = start >>> 12;
                closedPages.set(page, (closedPages.get(page) ?? 0) + 1);
                codePages.set(page, PageFlag.CLOSED);
            }
            holders.add(record);
        }
        for (const [start, end] of code)
        {
            codePages.markCode(start, end - start);
        }
        if (rt.loose && (stackPages.size > 0 || codeShared !== null)
            && [...region.pages].some(page=>stackPages.has(page)
                || codeShared?.onStack(page) === true))
        {
            stackCodeSeen();
        }
        for (const page of region.pages)
        {
            let set = byPage.get(page);
            if (!set)
            {
                set = new Set();
                byPage.set(page, set);
            }
            set.add(record);
            watched[page] |= WATCH_REGIONS;
        }
        countExtents(record, 1);
        regions.add(record);
        for (const [name, times] of crtOf(region))
        {
            crtFormed[name] = (crtFormed[name] ?? 0) + times;
        }
        if (record.loose && !rt.loose && throughStack(region))
        {
            // Its own code lies on a stack (`stackCodeSeen` above, which ran before
            // it was among the regions): its stores through esp, untested, could
            // write it. Asked for again, it is formed tested.
            unpublish([record]);
            counts.dropped++;
            counts.publishMs += clock() - publishAt;
            return 0;
        }
        // With other executors, the bytes are read again now that the pages say
        // there is code on them: a store another executor made before its check
        // could see that is caught here, one after it by the check. Its own
        // slices do not tell this one (`waited`), and the store moved no
        // generation while the pages held no code.
        if (codeShared !== null && (region.sources !== undefined
            ? sourcesChanged(region.sources, 0, 0x100000000)
            : hashRegion(read, region) !== region.hash))
        {
            unpublish([record]);
            counts.dropped++;
            counts.publishMs += clock() - publishAt;
            return 0;
        }
        joinHeld(record, instance);
        const bounced = evictedKeys.get(keyOf(region.entry, one.entryTop));
        if (bounced !== undefined && record.held !== undefined)
        {
            // Let go and asked for again: something still runs it, which the
            // marks may not show (a tail call into it from another module), so
            // its module stays a while, longer each time, and a relink takes
            // it with the hot.
            counts.broughtBack++;
            record.heat = (record.heat ?? 0) + 1;
            record.held.keepUntil = Math.max(record.held.keepUntil,
                rt.corkRetired + EVICT_HOLD * 2 ** Math.min(bounced - 1, 6));
        }
        counts.publishMs += clock() - publishAt;
        return 1;
    };

    /**
     * An emitted batch: its module instantiated once, kept under its own key
     * with a record per region naming it, and every region published from it.
     *
     * @param {any[]} metas  the formed regions, in the batch's order
     * @param {import('./emit-built.js').BuiltBatch} batch
     * @param {WebAssembly.Module | null} compiled  the module, when the worker compiled it
     * @param {any} store
     * @param {boolean} [later]  the regions published a credit's worth a call
     *     (`publishOn`) rather than in this one
     * @param {number[]} [covers]  what the regions cover until they are published
     *     (`coveredOut`)
     * @returns {number} regions published
     */
    const publishBatch = (metas, batch, compiled, store, later = false, covers = [])=>{
        const built = batch.results.filter(result=>result.ok);
        /** @type {any[]} */
        const apart = [];
        for (let i = 0; i < metas.length; i++)
        {
            const result = batch.results[i];
            if (!result.ok && result.message === 'changed'
                && metas[i].stamp === stamp(metas[i].region.pages))
            {
                // The worker formed it otherwise though nobody wrote its bytes: the
                // region formed here is the one that runs, emitted here. Barren, it
                // would never be translated, its bytes never written (CLR's
                // hottest functions, `relinkBatch`).
                refused[`formed apart at ${metas[i].region.entry.toString(16)}`] = 1;
                counts.formedApart++;
                apart.push(metas[i]);
            }
            else if (!result.ok)
            {
                refused[`emit at ${metas[i].region.entry.toString(16)}: ${result.message}`] = 1;
                // Done with, as a region the emitter took is: left in flight,
                // a candidate the emitter failed on was sent again once overdue
                // and failed again, and translated code left for it all the while.
                // Barren until its page is written, which forms it again.
                inFlight.delete(keyOf(metas[i].region.entry, metas[i].entryTop));
                barrenAdd(metas[i].region.entry, metas[i].entryTop, `emit: ${result.message}`);
                counts.emitFailures++;
            }
        }
        const here = apart.length === 0 ? 0 : publishBatch(apart, emitBatch(apart.map(one=>({
            region: one.region, entryTop: one.entryTop, checked: one.checked,
            copies: one.copies === true, ...precisionJob(one) })), emitLayout, found, emitOptions(),
        emitCache), null, store);
        if (built.length === 0)
        {
            uncoverKeys(covers);
            return here;
        }
        counts.moduleBytes += batch.module.length;
        /** @type {string | undefined} */
        let key;
        if (store !== null)
        {
            const storeAt = clock();
            key = storeModule(store, batch);
            counts.storeMs += clock() - storeAt;
        }
        const instance = instantiate(compiled ?? batch.module, batch.module.length, key);
        modulesSinceRelink++;
        modulePublishedAt = rt.corkRetired;
        if (key !== undefined && instance !== null)
        {
            keepBatch(key, instance);
        }
        let published = 0;
        /** @type {Waiting[] | null} */
        const waiting = later && instance !== null ? [] : null;
        for (let i = 0; i < metas.length; i++)
        {
            const result = batch.results[i];
            if (!result.ok)
            {
                continue;
            }
            foldTranslation(result.region);
            if (store !== null)
            {
                const storeAt = clock();
                trace(storeTrace.put, metas[i]);
                store.put(storeKey(metas[i]), packRegion({ ...result.region,
                    module: new Uint8Array(0), moduleKey: key, shape: shapeOf(metas[i]) },
                cacheVersion),
                key === undefined ? undefined : { needs: key }).catch(()=>{});
                counts.storeMs += clock() - storeAt;
            }
            if (waiting !== null)
            {
                waiting.push({ one: metas[i], built: result.region, instance });
            }
            else if (instance !== null)
            {
                published += place(metas[i], result.region, instance);
            }
        }
        if (waiting !== null && waiting.length > 0)
        {
            publishLater(waiting, covers);
        }
        else
        {
            uncoverKeys(covers);
        }
        return published + here;
    };

    /**
     * A relinked chunk: its module instantiated once, and every region of it
     * still running switched to its function there -- the same labels, so the
     * entries and the table slot stand and only the function under them moves.
     * The old batch modules go when no region uses them any more -- in the
     * store as well: each region's record names the relinked module from then
     * on, and a batch module no record names is dead there. A later run takes
     * the relinked regions as they are and relinks only what it adds.
     *
     * @param {RegionRecord[]} records  the chunk, in the order its jobs went
     * @param {import('./emit-built.js').BuiltBatch} batch
     * @param {WebAssembly.Module | null} compiled
     * @param {any} store
     * @param {boolean} [later]  the regions moved a credit's worth a call
     *     (`publishOn`) rather than in this one
     */
    const applyRelink = (records, batch, compiled, store, later = false)=>{
        if (!batch.results.some(result=>result.ok))
        {
            return;
        }
        counts.moduleBytes += batch.module.length;
        /** @type {string | undefined} */
        const key = store === null ? undefined : storeModule(store, batch);
        const instance = instantiate(compiled ?? batch.module, batch.module.length, key);
        if (instance === null)
        {
            return;
        }
        if (key !== undefined)
        {
            keepBatch(key, instance);
        }
        // A region left on its old module until it is moved runs the same
        // code there: each moves on its own.
        /** @type {Waiting[] | null} */
        const waiting = later ? [] : null;
        for (let i = 0; i < records.length; i++)
        {
            const result = batch.results[i];
            if (!result.ok)
            {
                continue;
            }
            if (waiting !== null)
            {
                waiting.push({ one: records[i], built: result.region, instance,
                    relink: { store, key } });
                continue;
            }
            place(records[i], result.region, instance, { store, key });
        }
        if (waiting !== null && waiting.length > 0)
        {
            publishLater(waiting);
        }
    };

    /**
     * Moves a running region to its function in a relinked module, should it
     * still run the code the relink formed again, and stores it as that.
     *
     * @param {RegionRecord} record @param {any} region  its translation in the module
     * @param {WebAssembly.Instance} instance @param {any} store
     * @param {string | undefined} key  where the store keeps the module
     */
    const relinkOne = (record, region, instance, store, key)=>{
        if (!regions.has(record) || JSON.stringify(region.labels) !== record.labels)
        {
            return;
        }
        const fn = /** @type {(label: number, budget: number) => number} */ (
            instance.exports[region.exportName]);
        const placed = placedOf.get(instance);
        if (table && record.table >= 0)
        {
            if (placed === undefined)
            {
                table.set(record.table, fn);
            }
            else
            {
                // Its index in the relinked module's range, which that
                // module's transfers reach directly.
                table.set(record.table, null);
                recordAt.delete(record.table);
                if (record.module === undefined)
                {
                    freeTable.push(record.table);
                }
                leaveModule(record);
                record.table = placed.base + Number(region.exportName.slice(1));
                table.set(record.table, fn);
                recordAt.set(record.table, record);
                joinModule(record, placed);
            }
        }
        for (const slot of record.slots)
        {
            entries.retable(slot, fn, record.table);
        }
        joinHeld(record, instance);
        record.linked = true;
        counts.relinked++;
        if (store !== null)
        {
            const one = { region: { entry: record.entry, hash: record.hash },
                entryTop: record.entryTop, wide: record.wide, narrow: record.narrow,
                floats: record.floats, checked: record.checked, copies: record.copies,
                ownWindows: record.ownWindows, loose: record.loose,
                wrapped: record.wrapped, targets: record.targets,
                anyTop: record.anyTop, byHash: record.byHash, summary: record.summary };
            store.put(storeKey(one), packRegion({ ...region,
                module: new Uint8Array(0), moduleKey: key, linked: true, shape: shapeOf(one) },
            cacheVersion), key === undefined ? undefined : { needs: key }).catch(()=>{});
        }
    };
    /**
     * Publishes one region whose module is instantiated, at once or when its
     * turn comes (`publishOn`): a relinked one moves to its function there
     * (`relinkOne`), any other is published from it (`applyBuilt`). A batch
     * emitted here or on a worker, a relink and a store hit all end here.
     *
     * @param {any} one @param {any} built  its translation in the module
     * @param {WebAssembly.Instance} instance
     * @param {Waiting['relink']} [relink]  where the store keeps a relinked module
     * @returns {number} 1 when a region was published, 0 otherwise
     */
    const place = (one, built, instance, relink)=>{
        if (relink !== undefined)
        {
            relinkOne(one, built, instance, relink.store, relink.key);
            return 0;
        }
        return applyBuilt(one, built, instance);
    };

    /**
     * A batch's regions to publish a credit's worth a call (`publishOn`). A
     * store hit whose module this run has not instantiated waits for it to be
     * compiled off this thread (`compileOn`), once for every hit naming it --
     * by its batch's key, or by itself for a module of its own.
     *
     * @param {Waiting[]} waiting
     * @param {number[]} [covers]  what the regions cover until they are published
     *     (`coveredOut`)
     */
    const publishLater = (waiting, covers = [])=>{
        /** @type {Publishing['compile']} */
        const compile = [];
        /** @type {Set<string | object>} */
        const named = new Set();
        /** @type {Publishing['compiled']} */
        const compiled = new Map();
        for (const { instance, source, bytes } of waiting)
        {
            if (instance === null && source !== undefined && bytes !== undefined
                && !named.has(source))
            {
                named.add(source);
                // Compiled already by a runtime sharing the store.
                if (bytes instanceof WebAssembly.Module)
                {
                    compiled.set(source, bytes);
                }
                else
                {
                    compile.push({ source, bytes });
                }
            }
        }
        toPublish.push({ waiting, next: 0, ready: compile.length === 0, compile, started: [],
            compiled, instances: new Map(), covers });
        queueMicrotask(rt.sendNext);
    };

    /**
     * Starts compiling the modules of the first batch with any not started, a
     * credit's worth a call: `WebAssembly.compile` copies and hashes a module's
     * bytes on this thread before it lets go, a dozen milliseconds for a
     * batch's modules started at once. The batch is ready once every one of
     * them is compiled.
     *
     * @returns {number} regions published: none
     */
    const compileOn = ()=>{
        const batch = /** @type {Publishing} */ (toPublish.find(one=>one.compile.length > 0));
        if (rt.workerClosed)
        {
            batch.compile.length = 0;
            batch.ready = true;
            return 0;
        }
        const left = rt.holding() ? rt.creditNow() : Infinity;
        if (left <= 0)
        {
            counts.heldBack++;
            rt.resumeWanted = true;
            return 0;
        }
        const until = performance.now() + left;
        while (batch.compile.length > 0)
        {
            const { source, bytes } = /** @type {Publishing['compile'][number]} */ (
                batch.compile.shift());
            counts.compiledApart++;
            batch.started.push(WebAssembly.compile(/** @type {Uint8Array<ArrayBuffer>} */ (bytes))
                .then(module=>{
                    compiledBytes.set(module, bytes.length);
                    batch.compiled.set(source, module);
                    if (typeof source === 'string')
                    {
                        share(source, module, bytes.length);
                    }
                }, (/** @type {unknown} */ e)=>{
                    refused.batch = (refused.batch ?? 0) + 1;
                    refused[`batch: ${String(e).slice(0, 120)}`] = 1;
                    batch.compiled.set(source, null);
                }));
            if (performance.now() >= until)
            {
                break;
            }
        }
        if (batch.compile.length > 0)
        {
            rt.resumeWanted = true;
            return 0;
        }
        Promise.all(batch.started).then(()=>{
            batch.ready = true;
            rt.sendNext();
        });
        return 0;
    };

    /**
     * The instance of a store hit's module, made as the first region naming it
     * is published: made as each was compiled, a batch's modules were all
     * instantiated in the turn the last compile came back.
     *
     * @param {Publishing} batch @param {string | object | undefined} source
     * @returns {WebAssembly.Instance | null}
     */
    const instanceFor = (batch, source)=>{
        if (source === undefined)
        {
            return null;
        }
        let made = batch.instances.get(source);
        if (made === undefined)
        {
            const module = batch.compiled.get(source) ?? null;
            made = module === null ? null : instantiate(module);
            batch.instances.set(source, made);
            if (made !== null && typeof source === 'string')
            {
                keepBatch(source, made);
                modulesSinceRelink++;
                modulePublishedAt = rt.corkRetired;
            }
        }
        return made;
    };

    /**
     * Publishes the batches `toPublish` holds from where it stopped, while
     * the first is ready, until they are all published or the call has taken
     * the credit; then the next batch may go.
     *
     * @returns {number} regions published
     */
    const publishOn = ()=>{
        const left = rt.holding() ? rt.creditNow() : Infinity;
        if (left <= 0 && !rt.workerClosed)
        {
            counts.heldBack++;
            rt.resumeWanted = true;
            return 0;
        }
        const until = performance.now() + left;
        let published = 0;
        let any = false;
        while (toPublish[0]?.ready === true)
        {
            const batch = toPublish[0];
            // The machine gone, nothing is published.
            const end = rt.workerClosed ? batch.next : batch.waiting.length;
            for (; batch.next < end; batch.next++)
            {
                if (any && performance.now() >= until)
                {
                    counts.publishedInPart++;
                    rt.resumeWanted = true;
                    return published;
                }
                any = true;
                const entry = batch.waiting[batch.next];
                const { one, built, relink } = entry;
                const instance = entry.instance ?? instanceFor(batch, entry.source);
                if (instance !== null)
                {
                    published += place(one, built, instance, relink);
                }
            }
            uncoverKeys(batch.covers);
            toPublish.shift();
        }
        // The asks owed while they waited: as after a batch the store answered
        // whole, the next goes after this turn.
        queueMicrotask(rt.sendNext);
        return published;
    };

    /**
     * The publish half of a batch, when its store lookups are back (or at
     * once, without a store or with one that answers at once): the regions
     * the store held are instantiated and published, and the rest are
     * emitted -- on the worker if there is one, inline otherwise -- stored and
     * published.
     *
     * @param {any[]} formed
     * @param {any} store
     * @returns {number} regions published
     */
    const finishBatch = (formed, store)=>{
        if (rt.workerClosed)
        {
            // The machine went away while the store's bytes were in flight.
            return 0;
        }
        let published = 0;
        // Where the work here is bounded (`holding`), the hits wait for `publishOn`:
        // their modules compiled off this thread, then published a credit's
        // worth a call. A module compiled here held the thread for its whole
        // size, ten milliseconds for one of five megabytes.
        /** @type {Waiting[] | null} */
        const waiting = rt.holding() ? [] : null;
        for (const one of formed)
        {
            if (one.cached === null)
            {
                continue;
            }
            // A stored region is a function of its batch's module, instantiated
            // once for every region of it; a record with a module of its own
            // is that module alone.
            const key = one.cached.moduleKey;
            let instance = key === undefined ? undefined
                : one.batchInstance ?? batchInstances.get(key);
            one.batchInstance = undefined;
            if (waiting !== null)
            {
                // The guest runs before it is published; the entry holds the
                // instance found until then, as `batchInstance` did.
                one.waited = true;
                waiting.push({ one, built: one.cached, instance: instance ?? null,
                    source: key ?? one,
                    bytes: key === undefined ? one.cached.module : one.moduleBytes });
                continue;
            }
            if (instance === undefined)
            {
                instance = instantiate(key === undefined ? one.cached.module : one.moduleBytes,
                    undefined, key) ?? undefined;
                if (instance !== undefined && key !== undefined)
                {
                    keepBatch(key, instance);
                    modulesSinceRelink++;
                    modulePublishedAt = rt.corkRetired;
                }
            }
            if (instance !== undefined)
            {
                published += place(one, one.cached, instance);
            }
        }
        if (waiting !== null && waiting.length > 0)
        {
            publishLater(waiting, cover(waiting.flatMap(({ one })=>coverKeys(one))));
        }
        const unbuilt = formed.filter(one=>one.cached === null);
        // Built as the region's precision and the shape tests now say, whatever
        // they said when formed.
        for (const one of unbuilt)
        {
            Object.assign(one, precisionFlags(one.region, one.entryTop));
            one.loose = rt.loose;
            one.wrapped = !rt.readsChecked;
            one.checked = checkedAt(one.region, one.entryTop);
        }
        const translator = unbuilt.length > 0 ? freeTranslator() : null;
        if (translator !== null)
        {
            // Off the frame thread: post the batch and answer with it later.
            // The records are kept until then; nothing here waits.
            // The worker forms the regions again from a copy of their pages, as
            // a relink does, and keeps each one only when its bytes hash as they
            // did here.
            /** @type {Pending} */
            const pending = { id: ++workerRequest, metas: unbuilt, store, at: performance.now(),
                alone: rt.postingAlone, covers: cover(unbuilt.flatMap(coverKeys)) };
            translator.pending = pending;
            for (const one of unbuilt)
            {
                one.waited = true;
                for (const block of one.region.blocks)
                {
                    noteWay(block.start, 'sent');
                }
            }
            const copies = rt.copyPages(unbuilt.map(one=>one.region.reads ?? one.region.pages));
            translator.adapter.post({
                id: pending.id,
                relink: {
                    jobs: unbuilt.map(one=>({ entry: one.region.entry, entryTop: one.entryTop,
                        hash: one.region.hash, checked: one.checked, copies: one.copies === true,
                        ...precisionJob(one),
                        ...(one.targets === undefined ? {} : { targets: one.targets }),
                        formable: [...one.region.formable ?? one.region.pages] })),
                    pages: [...copies],
                    form: formOptions,
                },
                layout: emitLayout, features: found, options: emitOptions(),
                ...storeVersionFor(store),
            }, [...copies.values()].map(bytes=>bytes.buffer));
            return published;
        }
        if (unbuilt.length > 0)
        {
            // The batch in one module, as the worker would have made it; a
            // region the emitter fails on is named in the report and the
            // program runs on without it.
            const jobs = unbuilt.map(one=>({ region: one.region, entryTop: one.entryTop,
                checked: one.checked, copies: one.copies === true, ...precisionJob(one) }));
            const emittedAt = performance.now();
            const batch = emitBatch(jobs, emitLayout, found, emitOptions(), emitCache);
            emittedHereMs += performance.now() - emittedAt;
            counts.emitMs += batch.emitMs;
            counts.encodeMs += batch.encodeMs;
            published += publishBatch(unbuilt, batch, null, store);
        }
        return published;
    };
    return {
        get emittedHereMs(){ return emittedHereMs; },
        set emittedHereMs(value){ emittedHereMs = value; },
        toPublish,
        get workerRequest(){ return workerRequest; },
        set workerRequest(value){ workerRequest = value; },
        get modulesSinceRelink(){ return modulesSinceRelink; },
        set modulesSinceRelink(value){ modulesSinceRelink = value; },
        get modulePublishedAt(){ return modulePublishedAt; },
        publishBatch,
        applyRelink,
        compileOn,
        publishOn,
        finishBatch,
    };
}
