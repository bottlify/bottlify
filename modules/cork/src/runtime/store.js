/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The store: where formed regions and their batches' modules are kept across
 * runs and between the runtimes sharing it. A region's key (`regionKey`) holds
 * everything its code depends on - the translator's version, the features,
 * the layout, the variant and the modes it was formed in - and a record names
 * its batch's module; `accepted` takes a record only where the bytes it was
 * formed from are the bytes now. Lookups happen before forming where the store
 * answers at once (`recordBefore`, `prefetch`), a credit's worth a call after
 * it (`lookUpOn`), or a turn later; each formed region is then settled as a
 * hit or a miss (`settle`). The map of blocks to their regions (`storedBlocks`)
 * lets a candidate inside a stored region be formed as that region, and
 * `flushStore` puts back what this run added to it.
 */

import { formRegion } from '../region.js';
import { CallStack } from '../emit/region.js';
import { ANY_TOP, keyOf } from './entries.js';
import { sharedFormsOf } from './shared-forms.js';
import { cacheKey, moduleKey, packRegion, unpackRegion } from './cache.js';
import { regionOfSummary, summaryOf } from './summary.js';
import { usesX87 } from './variants.js';
import { StoredBlocks } from './stored-blocks.js';

/** @typedef {import('./state.js').Lookup} Lookup */
/** @typedef {import('./state.js').Forming} Forming */

/**
 * The least share of the store's map of blocks to regions (`storedBlocks`) a
 * runtime adds before it puts the map again: one part in this many.
 */
const MAP_SHARE = 64;

/**
 * @param {object} state  the runtime's state (`state.js`), typed inside: its type is
 *     made of what this returns
 */
export function createStore(state){
    const rt = /** @type {import('./state.js').State} */ (state);
    const { cacheVersion, emitLayout, entries, formHere, formOptions, found, leaveOut, profiling,
        guestBytes, read, readBytes, settings, sharedMemory, sharesStore
    } = /** @type {import('./state.js').Base} */ (state);
    const { batchInstances, checkedAt, counts, formableFrom, inFlight, precisionAt, precisionFlags,
        precisionOf, regions, sharedModule, stamp, stubPage, trace,
        translatable } = rt;
    // The store is opened (a directory store reads its index) while the host
    // is still starting, so it can answer the first batch's lookups at once.
    if (leaveOut.size === 0 && !profiling)
    {
        settings.store?.prepare?.()?.catch(()=>{});
    }
    // The settings that change emitted code but not a region's bytes, in the
    // store's keys: precise, the transfer count, the modules' placing and the
    // call profile, the trap port -- each as the emitter reads it. 'S' heads every
    // variant: the records stores hold were put under it. The entry hash and the
    // tier's resume follow from the features and the layout, which the key names
    // beside these. 'W'
    // marks reads wrapped into a RAM that is not a power of two, which a store
    // made before they were (each read tested) holds under the same layout.
    const variant = 'S'
        + ((emitLayout.ramSize & emitLayout.ramSize - 1) !== 0 ? 'W' : '')
        + (settings.precise === true ? 'P' : '') + (settings.countTransfers ? 'T' : '')
        + (settings.dispatch === true ? 'D' : '') + (settings.callTargets === true ? 'C' : '')
        + (settings.callReturn === true ? 'R' : '') + (sharedMemory ? 'M' : '')
        + (settings.linkedCalls !== false ? 'L' : '')
        + (settings.crossTailCalls === false ? 'X' : '')
        + (settings.callReturn === true && settings.callDepth !== CallStack.LIMIT
            ? `d${settings.callDepth}` : '')
        + (settings.atomic === true ? 'A' : '')
        + `p${(settings.trapPort ?? 0).toString(16)}`;
    /**
     * The store key of one formed region: its entry, its top, and the run's modes its
     * code is made for -- what a run knows before it forms the region. The region stored
     * there stands for it, and one a lookup found of other bytes than that record's goes
     * beside it (`storeKey`); what forming made of it is in its record (`shapeOf`).
     * A region with no x87 in it is the same code at every top, and is kept at any
     * (`anyTop`, found once for the formed region): of a warm Far Cry run's 2 072 misses,
     * 362 were entries the store had at another top.
     * @param {{ region: { entry: number, blocks?: import('../region.js').Block[] },
     *     entryTop: number, loose?: boolean, wrapped?: boolean, anyTop?: boolean }} one */
    const regionKey = one=>{
        // A candidate not formed yet is named by its entry alone, and asked at both.
        one.anyTop ??= ('summary' in one.region || one.region.blocks !== undefined)
            && !usesX87(/** @type {import('../region.js').Region} */ (one.region));
        return cacheKey({
            version: cacheVersion, features: found, variant, layoutId: emitLayout.id,
            bundleId: settings.bundleId ?? 'unknown', entry: one.region.entry,
            kept: `${one.anyTop ? 'x' : one.entryTop}${one.loose ? '-s' : ''}`
                + `${one.wrapped === false ? '-q' : ''}`,
        });
    };
    /**
     * Where a region's record is put: under its key, or beside the record there under its
     * own bytes' hash too, where that record is of other bytes (`byHash`, which a region
     * formed again inherits from the one it replaces). An entry whose code reaches a stub
     * the program patches as it runs - a .NET runtime's call to its prestub, made a jump
     * to the method once that is prepared - is formed in two versions every run, and one
     * record under its key had the later version overwrite the earlier: the next run met
     * the earlier first and missed, and so on every start (The Swapper: 8 400 regions,
     * 4 128 of them in mscorlib's native image). Kept apart, each version is a hit.
     * @param {Parameters<typeof regionKey>[0] & { region: { hash: string },
     *     byHash?: boolean, replaces?: { byHash?: boolean } }} one */
    const storeKey = one=>regionKey(one)
        + ((one.byHash ?? one.replaces?.byHash) === true ? `/${one.region.hash}` : '');
    /**
     * The key to ask for a formed region's own version (`storeKey`) where the record under
     * its key is of other bytes, or null.
     * @param {{ region: { hash: string } }} one @param {string} key  its `regionKey`
     * @param {import('./cache.js').CachedRegion | null | undefined} cached  the record there
     */
    const besideKey = (one, key, cached)=>(cached?.shape !== undefined
        && cached.shape.hash !== one.region.hash ? `${key}/${one.region.hash}` : null);
    /**
     * What forming made of a region and what it is compiled as, for its record.
     * @param {{ region: { entry: number, hash: string }, entryTop: number,
     *     targets?: [number, number[]][],
     *     wide?: boolean, narrow?: boolean, floats?: boolean, checked?: boolean,
     *     ownWindows?: boolean,
     *     copies?: boolean, summary?: import('./summary.js').RegionSummary }} one
     * @returns {import('./cache.js').RegionShape}
     */
    const shapeOf = one=>({ hash: one.region.hash,
        ...((precisionAt.get(one.region.entry)?.misses ?? 0) > 0 ? { moved: true } : {}),
        ...(one.targets === undefined ? {} : { targets: one.targets }),
        ...(one.wide === true ? { wide: true } : {}),
        ...(one.narrow === true ? { narrow: true } : {}),
        ...(one.floats === true ? { floats: true } : {}),
        ...(one.checked === true ? { checked: true } : {}),
        ...(one.ownWindows === true ? { ownWindows: true } : {}),
        ...(one.copies === true ? { copies: true } : {}),
        ...summed(one) });
    /** A region's summary as its record's shape holds it: the formed region's, or
     * the one a running region's record kept (`RegionRecord.summary`).
     * @param {{ region: any, entryTop: number,
     *     summary?: import('./summary.js').RegionSummary }} one */
    const summed = one=>{
        const summary = settings.summaries === false ? null
            : one.summary ?? summaryOf(one.region, one.entryTop);
        return summary === null ? {} : { summary };
    };
    /**
     * The formed regions of the runtimes sharing the store and forming as this
     * one does (`sharedFormed`), by entry and the callees formed in. None for a
     * run that keeps no store, where no other runtime of this thread would take
     * them (and a region formed to be kept is formed without what the rest of
     * its call decoded), and for a diagnostic range left to the interpreter,
     * which `translatable` answers by address rather than by page.
     * @type {ReturnType<typeof sharedFormsOf> | null}
     */
    const sharedForms = settings.interpretRange || leaveOut.size > 0 || profiling ? null
        : sharedFormsOf(sharesStore, JSON.stringify(formOptions), settings.sharedFormed);
    /**
     * Whether a region formed earlier would be formed the same here now: every
     * page forming asked about answers as it did, and every byte it read is as
     * it was.
     *
     * @param {import('./shared-forms.js').Formed} formed
     */
    const formsAsBefore = ({ region, answers })=>{
        const formable = formableFrom(region.entry);
        for (const [page, yes] of answers)
        {
            if (formable(page * 4096) !== yes)
            {
                return false;
            }
        }
        for (const { start, bytes } of region.sources ?? [])
        {
            const now = readBytes?.(start, start + bytes.length);
            for (let at = 0; at < bytes.length; at++)
            {
                if ((now === undefined ? read(start + at) : now[at]) !== bytes[at])
                {
                    return false;
                }
            }
        }
        return true;
    };
    /**
     * A region formed at `eip` with these callees formed in (`callTargets`), or
     * the one a runtime sharing the store formed so where it forms the same
     * (`formsAsBefore`). One formed to be kept shares what the other regions of
     * the call decoded as any does (`shared`): what it takes from there it reads
     * and asks about as the one that found it did, so its own reads are all of
     * them.
     *
     * @param {number} eip @param {[number, number[]][] | undefined} targets
     * @param {import('../region.js').FormShared} [shared]
     * @returns {import('../region.js').Region}
     */
    const formAt = (eip, targets, shared)=>{
        const called = targets === undefined ? {} : { callTargets: new Map(targets) };
        const formable = formableFrom(eip);
        // What forming finds shared between the regions of a call is found under their
        // own pages: a region entered on a page of stubs may form on less than the others.
        const sharing = stubPage(eip >>> 12) ? undefined : shared;
        if (sharedForms === null)
        {
            return formRegion(read, eip, { ...formHere, translatable: formable, shared: sharing,
                ...called });
        }
        const key = `${eip}/${targets === undefined ? '' : JSON.stringify(targets)}`;
        const known = sharedForms.get(key);
        if (known !== undefined && formsAsBefore(known))
        {
            counts.formedShared++;
            return known.region;
        }
        /** @type {Map<number, boolean>} */
        const answers = new Map();
        const region = formRegion(read, eip, { ...formHere, ...called, shared: sharing,
            translatable: address=>{
                const page = Math.floor(address / 4096);
                let yes = answers.get(page);
                if (yes === undefined)
                {
                    yes = formable(address);
                    answers.set(page, yes);
                }
                return yes;
            } });
        sharedForms.set(key, { region, answers });
        return region;
    };

    /**
     * The stored region for a formed one, or null. Formed here beside other
     * regions than the run that stored it had, or before the callees it was
     * formed with were known, a region is formed again as its record says
     * first; it is taken when its bytes hash as they did, compiled for the
     * precision this run gives its entry, with floats only where this run
     * keeps them and with the shape tests unless this run checks its stack.
     * An entry whose precision control this run has not moved yet takes the
     * one the record was compiled for where the run that stored it moved it
     * (`moved`, `precisionAt`): it learned what the entry runs under. A record
     * compiled for the control its run first met there is no such lesson, and
     * is taken only for that control -- a region compiled for another leaves
     * at its first rounding instruction. Taken, the formed region is the one
     * the record was made of. A record of other bytes is passed over for the one kept
     * beside it under the formed region's hash (`beside`, `storeKey`).
     *
     * @param {any} one @param {import('./cache.js').CachedRegion | null} cached
     * @param {import('./cache.js').CachedRegion | null} [beside]  the record at `besideKey`
     * @returns {import('./cache.js').CachedRegion | null}
     */
    const accepted = (one, cached, beside = null)=>{
        const stood = one.region.summary === undefined ? null : one.region;
        const before = stood === null ? null : REFUSALS.map(name=>counts[name]);
        const taken = acceptedAs(one, cached, beside);
        if (taken !== null || stood === null)
        {
            return taken;
        }
        // Refused as its record stands for it: the region is formed, and translated
        // as one formed in the first place.
        const region = formAt(stood.entry, one.targets);
        if (one.formedRegion === stood)
        {
            one.formedRegion = region;
        }
        one.region = region;
        one.stamp = stamp(region.pages);
        Object.assign(one, precisionFlags(region, one.entryTop),
            { checked: checkedAt(region, one.entryTop) });
        if (region.hash === stood.hash)
        {
            // The same region: what refused the one that stood for it refuses it.
            return null;
        }
        // Formed otherwise than its record says: judged again, and counted once.
        REFUSALS.forEach((name, at)=>{
            counts[name] = /** @type {number[]} */ (before)[at];
        });
        return acceptedAs(one, cached, beside);
    };
    /** What `acceptedAs` counts a refusal under. */
    const REFUSALS = /** @type {const} */ (['missChanged', 'missBytes', 'missFormedOther',
        'missModes', 'missPrecision', 'missFloats', 'hitsFormedAgain']);
    /**
     * The region a candidate's record stands for, taken without forming it where
     * the record says what publishing asks (`summary.js`) and the bytes are as it
     * hashed them; null for a record with no summary, or of other bytes.
     *
     * @param {{ key: string, shape: import('./cache.js').RegionShape } | null} record
     * @param {number} eip
     * @returns {import('./summary.js').SummedRegion | null}
     */
    const regionOfRecord = (record, eip)=>{
        const summary = settings.summaries === false ? undefined : record?.shape.summary;
        if (record === null || summary === undefined)
        {
            return null;
        }
        const region = regionOfSummary(eip, record.shape.hash, summary, {
            read,
            bytesOf: (start, end)=>guestBytes(start, end)
                ?? Uint8Array.from({ length: end - start }, (_, at)=>read(start + at)),
            formable: formableFrom(eip),
            form: ()=>formAt(eip, record.shape.targets),
        });
        if (region !== null)
        {
            counts.takenUnformed++;
        }
        return region;
    };
    /** @type {typeof accepted} */
    const acceptedAs = (one, cached, beside = null)=>{
        let shape = cached?.shape;
        if (cached === null || shape === undefined)
        {
            return null;
        }
        let region = one.region;
        if (region.hash !== shape.hash && beside !== null && beside.shape !== undefined
            && beside.shape.hash === region.hash)
        {
            cached = beside;
            shape = beside.shape;
            one.byHash = true;
        }
        if (region.hash !== shape.hash && one.formedAs !== undefined
            && one.formedAs === regionKey(one))
        {
            // Formed as this record says already (`recordBefore`): other bytes.
            counts.missChanged++;
            counts.missBytes++;
            one.storedOther = true;
            one.byHash = true;
            return null;
        }
        if (region.hash !== shape.hash)
        {
            region = formAt(region.entry, shape.targets);
            if (region.hash !== shape.hash)
            {
                counts.missChanged++;
                counts.missFormedOther++;
                one.storedOther = true;
                one.byHash = true;
                return null;
            }
            counts.hitsFormedAgain++;
        }
        precisionOf(region);
        const known = precisionAt.get(region.entry);
        if (known !== undefined && known.misses === 0 && shape.moved === true)
        {
            known.precision = shape.wide === true ? 'wide' : shape.narrow === true ? 'narrow'
                : 'mixed';
        }
        const flags = precisionFlags(region, one.entryTop);
        const otherPrecision = flags.wide !== (shape.wide === true)
            || flags.narrow !== (shape.narrow === true);
        const otherFloats = shape.floats === true && !flags.floats;
        if (otherPrecision || otherFloats
            || (shape.ownWindows !== true && flags.ownWindows)
            || (shape.checked !== true && checkedAt(region, one.entryTop)))
        {
            counts.missChanged++;
            counts.missModes++;
            counts.missPrecision += otherPrecision ? 1 : 0;
            counts.missFloats += !otherPrecision && otherFloats ? 1 : 0;
            one.storedOther = true;
            return null;
        }
        if (region !== one.region)
        {
            one.region = region;
            one.stamp = stamp(region.pages);
        }
        one.wide = shape.wide === true;
        one.narrow = shape.narrow === true;
        one.floats = shape.floats === true;
        one.checked = shape.checked === true;
        one.ownWindows = shape.ownWindows === true;
        one.copies = shape.copies === true;
        if (shape.targets !== undefined)
        {
            one.targets = shape.targets;
        }
        if (one.formedAs !== undefined && region === one.formedRegion)
        {
            counts.formedAsRecorded++;
        }
        return cached;
    };
    /**
     * Where the stored regions have entries: by `keyOf` of a block and the top its
     * entry is keyed at (`ANY_TOP` for a region with no x87 in it), the region's own
     * entry and top as `keyOf` packs them. A run that meets a block of a stored region
     * before the region's entry -- a call's return, a loop entered from outside --
     * forms the region it belongs to, which the store answers, rather than another
     * there: of a warm Far Cry run's 2 072 misses, 803 were such blocks. Read from the
     * store as the runtime starts, written back with this run's regions when it
     * flushes. null until read.
     * @type {StoredBlocks | null}
     */
    let storedBlocks = null;
    const blocksKey = ()=>cacheKey({ version: cacheVersion, features: found, variant,
        layoutId: emitLayout.id, bundleId: settings.bundleId ?? 'unknown', entry: 0,
        kept: 'blocks' });
    /**
     * The store this runtime keeps its translations in: none for a diagnostic run
     * with classes left out or a block profile.
     * @returns {any}
     */
    const storeHere = ()=>(leaveOut.size > 0 || profiling
        ? null : (settings.store ?? null));
    /** The read of `storedBlocks`, which a flush waits for before it writes them back. */
    const blocksRead = (async()=>{
        const store = storeHere();
        try
        {
            const bytes = store === null || typeof store.get !== 'function' ? null
                : await store.get(blocksKey());
            storedBlocks = bytes === null ? StoredBlocks.empty() : StoredBlocks.fromBytes(bytes);
        }
        catch {
            storedBlocks = StoredBlocks.empty();
        }
    })();
    /**
     * The candidates sent on to the stored region holding them (`storedOwner`), by
     * key: once each. A region the store names that this run cannot publish - its
     * entry formed nothing over the bytes now there, its record refused - gives the
     * block no entry, and sent to it at every batch the block was never translated
     * though left for all run long.
     * @type {Set<number>}
     */
    const sentToOwner = new Set();
    const SENT_CAP = 1 << 16;
    /**
     * The region a candidate is a block of in the store, where that region is
     * neither published nor on its way: its entry and top as `keyOf` packs them, or
     * -1. `taking` notes the candidate as sent there: asked again, it is its own.
     * @param {number} eip @param {number} top @param {boolean} [taking]
     */
    const storedOwner = (eip, top, taking = false)=>{
        const owner = storedBlocks?.get(keyOf(eip, top)) ?? storedBlocks?.get(keyOf(eip, ANY_TOP));
        if (owner === undefined || Math.floor(owner / 16) === eip)
        {
            return -1;
        }
        const at = Math.floor(owner / 16);
        if (entries.entryOf(at, owner % 16) >= 0 || inFlight.has(owner) || !translatable(at)
            || sentToOwner.has(keyOf(eip, top)))
        {
            return -1;
        }
        if (taking)
        {
            if (sentToOwner.size >= SENT_CAP)
            {
                sentToOwner.clear();
            }
            sentToOwner.add(keyOf(eip, top));
        }
        return owner;
    };

    /** What asks a translator to digest and pack the module it answers with, where it is to be
     * stored. @param {any} store */
    const storeVersionFor = store=>(store === null ? {} : { storeVersion: cacheVersion });

    /**
     * Puts a batch's module in the store, as the translation worker digested
     * and packed it where it did, and answers the key it is kept under.
     *
     * @param {any} store @param {import('./emit-built.js').BuiltBatch} batch
     * @returns {string}
     */
    const storeModule = (store, batch)=>{
        const key = moduleKey({ version: cacheVersion, features: found, variant,
            layoutId: emitLayout.id, bundleId: settings.bundleId ?? 'unknown' }, batch.module,
        batch.digest);
        store.put(key, batch.packed ?? packRegion({ module: batch.module, labels: [], cut: [],
            entryTop: 0, instructions: 0 }, cacheVersion)).catch(()=>{});
        return key;
    };

    /**
     * Takes a formed region's record as the store answered it: none, one
     * whose batch module this run has an instance of (`moduleBytes`
     * undefined), or one with its batch module's bytes -- a miss when those
     * are gone.
     *
     * @param {any} one  a formed region
     * @param {import('./cache.js').CachedRegion | null} cached
     * @param {Uint8Array | WebAssembly.Module | null} [moduleBytes]  compiled
     *     already where a runtime sharing the store compiled it
     */
    const settle = (one, cached, moduleBytes)=>{
        one.cached = cached;
        if (cached === null)
        {
            if (one.storedOther !== true)
            {
                counts.missNoRecord++;
            }
        }
        else if (moduleBytes !== undefined)
        {
            one.moduleBytes = moduleBytes;
            if (moduleBytes === null)
            {
                counts.missNoModule++;
                one.cached = null;
            }
        }
        else if (cached.moduleKey !== undefined)
        {
            // Its batch's instance, held until the region is published. The
            // module is not read for it, and counts as used all the same.
            one.batchInstance = batchInstances.get(cached.moduleKey);
            if (one.batchInstance === undefined)
            {
                counts.missNoModule++;
                one.cached = null;
            }
            else
            {
                settings.store?.touch?.(cached.moduleKey);
            }
        }
        if (one.cached !== null)
        {
            counts.cacheHits++;
        }
        else
        {
            counts.cacheMisses++;
            trace('missed', one);
        }
    };

    /**
     * Whether another executor waits for this thread's answer (`awaited`):
     * forming and looking up stop at the next region, as when the credit runs
     * out. Every region formed here is an answer that thread waited out --
     * thousands a second from a render thread, a third of a millisecond each.
     */
    const waitedFor = ()=>{
        if (settings.awaited?.() !== true)
        {
            return false;
        }
        counts.answeredFirst++;
        return true;
    };

    /**
     * The batch module a store hit still needs read, by its key: none for a region
     * with a module of its own or a batch this run has an instance of. What
     * `lookUpOn` and `lookUpLater` both settle a hit by.
     *
     * @param {import('./cache.js').CachedRegion | null | undefined} cached
     * @returns {string | undefined}
     */
    const moduleWanted = cached=>{
        const key = cached?.moduleKey;
        return key !== undefined && !batchInstances.has(key) ? key : undefined;
    };
    /** A batch module's record as the store answered it: its module's bytes, or none.
     * @param {Uint8Array | null} bytes */
    const moduleIn = bytes=>(bytes === null
        ? null : unpackRegion(bytes, cacheVersion)?.module ?? null);
    /**
     * A record of the store's as `step` read it, once a key.
     *
     * @param {Forming} step @param {string} key @param {Uint8Array} bytes
     */
    const unpackedOf = (step, key, bytes)=>{
        const unpacked = step.unpacked ??= new Map();
        let cached = unpacked.get(key);
        if (cached === undefined)
        {
            cached = unpackRegion(bytes, cacheVersion);
            unpacked.set(key, cached);
        }
        return cached;
    };
    /** A candidate's store key at the top it is entered at, or at any top.
     * @param {number} eip @param {number} entryTop @param {boolean} anyTop */
    const candidateKey = (eip, entryTop, anyTop)=>regionKey({ region: { entry: eip }, entryTop,
        loose: rt.loose, wrapped: !rt.readsChecked, anyTop });
    /**
     * The keys of the batch's candidates from `from` on, both of each (its top's and
     * any top's), that the step has no answer for yet.
     *
     * @param {Forming} step @param {number} from
     */
    const keysFrom = (step, from)=>{
        /** @type {string[]} */
        const keys = [];
        for (let at = from; at < step.batch.length; at++)
        {
            const [key, eip] = step.batch[at];
            const owner = storedOwner(eip, key % 16);
            const entry = owner >= 0 ? Math.floor(owner / 16) : eip;
            const top = owner >= 0 ? owner % 16 : key % 16;
            for (const one of [candidateKey(entry, top, false), candidateKey(entry, top, true)])
            {
                if (step.known?.has(one) !== true)
                {
                    keys.push(one);
                }
            }
        }
        return keys;
    };
    /**
     * As `prefetch`, of a store that answers only a turn later (another executor's,
     * reached through its process): the records are asked, the step waits
     * (`asking`), and `answered` is called once they are all back - a key with no
     * record known as that. Without it such a runtime formed every region its
     * store held before it learned the store held it: an executor of a process
     * started warm formed some twenty thousand regions a run it then took whole.
     * Answers whether anything was asked.
     *
     * @param {Forming} step @param {any} store @param {number} from
     * @param {() => void} answered
     */
    const askBefore = (step, store, from, answered)=>{
        const keys = keysFrom(step, from);
        if (keys.length === 0)
        {
            return false;
        }
        step.asking = true;
        counts.askedBefore++;
        Promise.all(keys.map(key=>Promise.resolve().then(()=>store.get(key)).catch(()=>null)))
            .then(answers=>{
                for (let at = 0; at < keys.length; at++)
                {
                    step.known?.set(keys[at], answers[at] ?? null);
                }
                step.asking = false;
                answered();
            });
        return true;
    };
    /**
     * The batch's candidates' records asked of a store across a link before
     * they are formed, in one wait, at both keys each (`recordBefore`).
     *
     * @param {Forming} step @param {any} store
     * @param {number} [from]  the first candidate asked for: the callees a region just
     *     formed added to the batch are asked for together as it is formed, one wait a
     *     region - formed first and looked up after, a process started again formed two
     *     regions of three it then took from the store
     */
    const prefetch = (step, store, from = step.next)=>{
        const keys = keysFrom(step, from);
        try
        {
            /** @type {(Uint8Array | null | undefined)[] | undefined} */
            const answers = keys.length === 0 ? undefined : store.getManyNow(keys);
            for (let at = 0; at < (answers?.length ?? 0); at++)
            {
                const bytes = answers?.[at];
                if (bytes !== undefined)
                {
                    step.known?.set(keys[at], bytes);
                }
            }
        }
        catch {
            // Asked again after forming, as without this.
        }
    };
    /**
     * A candidate's record before it is formed, where the store answers at
     * once: at the top it is entered at, then at any top. A region the store
     * holds is then formed once, as its record says (`accepted`), where it was
     * formed first as this run's regions and callees had it and then again
     * as the record says: on eight executors, each forming what it reaches
     * beside regions of its own, two of three hits were formed twice. A store
     * across a link was asked as the batch began, and for a region's callees
     * as they joined it (`prefetch`).
     *
     * @param {Forming} step @param {any} store @param {number} eip @param {number} entryTop
     * @returns {{ key: string, shape: import('./cache.js').RegionShape } | null}
     */
    const recordBefore = (step, store, eip, entryTop)=>{
        const known = step.known;
        if (store === null || known === undefined)
        {
            return null;
        }
        for (const anyTop of [false, true])
        {
            const key = candidateKey(eip, entryTop, anyTop);
            let bytes = known.get(key);
            if (bytes === undefined && typeof store.getManyNow !== 'function'
                && typeof store.getNow === 'function')
            {
                try
                {
                    bytes = store.getNow(key) ?? undefined;
                }
                catch {
                    bytes = undefined;
                }
                if (bytes !== undefined)
                {
                    known.set(key, bytes);
                }
            }
            const shape = bytes === undefined || bytes === null ? undefined
                : unpackedOf(step, key, bytes)?.shape;
            if (shape !== undefined)
            {
                return { key, shape };
            }
        }
        return null;
    };

    /**
     * A batch's lookups answered at once, where the store can answer without
     * a turn of the event loop (`getNow`: a directory store in a worker reads
     * its records file through a synchronous handle). The batch is then
     * published as soon as it is answered, as without a store, where a turn
     * later -- with no batch formed meanwhile -- a first run went on
     * interpreted, formed other regions and emitted more than the store
     * saved. Answered a credit's worth a call, the guest running between, a
     * record or a module at a time: a batch's hundreds of records read and
     * unpacked at once held the thread for ten milliseconds. Each region is
     * settled once all are answered. 'later', with nothing settled, when a
     * lookup cannot be answered so.
     *
     * @param {Forming} step @param {any} store
     * @param {number} until  when the call's share is spent
     * @param {boolean} any  whether the call has done work already, so it may stop at once
     * @returns {'done' | 'part' | 'later'}
     */
    const lookUpOn = (step, store, until, any)=>{
        if (typeof store.getNow !== 'function')
        {
            return 'later';
        }
        const { formed } = step;
        const known = step.known ??= new Map();
        /** @type {Lookup} */
        const lookup = step.lookup ?? { records: null, cached: [], wanted: null,
            modules: new Map(), done: false };
        step.lookup = lookup;
        if (lookup.done)
        {
            return 'done';
        }
        const keys = lookup.keys ??= formed.map(region=>regionKey(region));
        // A store across a link answers the batch's names in one wait - each
        // region's key and its own version's beside it (`storeKey`); any other
        // is asked a name at a time. A name answered before its region was
        // formed (`recordBefore`) is not asked again.
        const linked = typeof store.getManyNow === 'function';
        /** @type {(key: string) => Uint8Array | null | undefined} */
        const one = linked ? key=>store.getManyNow([key])?.[0] : key=>store.getNow(key);
        /** @param {string} key */
        const answer = key=>(known.has(key) ? known.get(key) : one(key));
        try
        {
            if (linked && lookup.records === null)
            {
                const asked = [...keys, ...keys.map((key, at)=>`${key}/${formed[at].region.hash}`)]
                    .filter(key=>!known.has(key));
                const answers = asked.length === 0 ? [] : store.getManyNow(asked) ?? null;
                if (answers === null || answers.some((/** @type {any} */ bytes)=>
                    bytes === undefined))
                {
                    return 'later';
                }
                asked.forEach((key, at)=>known.set(key, answers[at]));
                lookup.records = keys.map(key=>known.get(key) ?? null);
            }
            while (lookup.cached.length < formed.length)
            {
                if (any && (performance.now() >= until || waitedFor()))
                {
                    return 'part';
                }
                any = true;
                const at = lookup.cached.length;
                const bytes = lookup.records !== null ? lookup.records[at] : answer(keys[at]);
                if (bytes === undefined)
                {
                    return 'later';
                }
                const cached = bytes === null ? null : unpackedOf(step, keys[at], bytes);
                const other = besideKey(formed[at], keys[at], cached);
                const besideBytes = other === null ? null : answer(other);
                if (besideBytes === undefined)
                {
                    return 'later';
                }
                lookup.cached.push(accepted(formed[at], cached, besideBytes === null ? null
                    : unpackedOf(step, /** @type {string} */ (other), besideBytes)));
            }
            /** A batch module's bytes are read once for every record naming it. */
            lookup.wanted ??= [...new Set(lookup.cached.map(moduleWanted)
                .filter(/** @returns {key is string} */ key=>key !== undefined))];
            while (lookup.modules.size < lookup.wanted.length)
            {
                if (any && (performance.now() >= until || waitedFor()))
                {
                    return 'part';
                }
                any = true;
                const key = lookup.wanted[lookup.modules.size];
                const compiled = sharedModule(key);
                if (compiled !== undefined)
                {
                    lookup.modules.set(key, compiled);
                    continue;
                }
                const bytes = one(key);
                if (bytes === undefined)
                {
                    return 'later';
                }
                lookup.modules.set(key, moduleIn(bytes));
            }
        }
        catch {
            return 'later';
        }
        formed.forEach((region, at)=>{
            const cached = lookup.cached[at];
            const batchKey = moduleWanted(cached);
            settle(region, cached, batchKey !== undefined
                ? lookup.modules.get(batchKey) ?? null : undefined);
        });
        lookup.done = true;
        return 'done';
    };
    /** Writes whatever the store keeps aside from its records, so the
     * names of this run's regions are on disk before the run ends and the
     * next run's index can find them. The store stays open: it is its
     * opener's to close, and a run hands one store to the machine of every
     * process it starts, so a machine that goes would otherwise take it
     * from the processes still running. */
    const flushStore = async()=>{
        const store = storeHere();
        if (store !== null && regions.size > 0)
        {
            // Where this run's regions have entries, beside what the store
            // holds now -- not what it held when this runtime started: every
            // process of the run has a runtime of its own, and a program that
            // runs a tool again and again (Far Cry, its shader compiler 45
            // times a run) would have each one put back the map it read,
            // dropping what the others added since, and put it whole even
            // when it added nothing: 46 maps of 2.5 MB a run.
            await blocksRead;
            let now = storedBlocks ?? StoredBlocks.empty();
            try
            {
                const bytes = await store.get(blocksKey());
                now = bytes === null ? now : StoredBlocks.fromBytes(bytes);
            }
            catch {
                // The map read at the start stands for it.
            }
            /** @type {Map<number, number>} */
            const ours = new Map();
            for (const record of regions)
            {
                for (const slot of record.slots)
                {
                    const { eip, top } = entries.at(slot);
                    ours.set(keyOf(eip, top), keyOf(record.entry, record.entryTop));
                }
            }
            const { blocks, changed } = now.with(ours);
            // Put whole, the map is worth it only for what this runtime adds to
            // it: a tool's process adding a few blocks to a game's map of
            // 200 000 wrote 2.5 MB for each of its runs.
            if (changed > 0 && changed * MAP_SHARE >= blocks.size)
            {
                await store.put(blocksKey(), blocks.bytes()).catch(()=>{});
            }
        }
        await settings.store?.flush?.();
    };
    /**
     * A batch's lookups where the store cannot answer at once (`lookUpOn` said
     * 'later'): every region's record, the record beside it and its batch's
     * module are asked, the slice goes on, and `answered` is called once every
     * region is settled - between frames, as instantiation already is.
     *
     * @param {any[]} formed @param {any} store @param {() => void} answered
     * @param {Map<string, Uint8Array | null>} [known]  the records the step asked for
     */
    const lookUpLater = (formed, store, answered, known)=>{
        // A batch module's bytes are read once for every record naming it.
        /** @type {Map<string, Promise<Uint8Array | WebAssembly.Module | null>>} */
        const modules = new Map();
        /** @param {string} key */
        const moduleBytes = key=>{
            let pending = modules.get(key);
            if (pending === undefined)
            {
                const compiled = sharedModule(key);
                pending = compiled !== undefined ? Promise.resolve(compiled)
                    : /** @type {Promise<Uint8Array | null>} */ (store.get(key).then(moduleIn));
                modules.set(key, pending);
            }
            return pending;
        };
        Promise.all(formed.map(async one=>{
            try
            {
                const key = regionKey(one);
                // Asked before it was formed (`askBefore`): not asked again.
                const got = (/** @type {string} */ name)=>(known?.has(name) === true
                    ? known.get(name) ?? null : store.get(name));
                const bytes = await got(key);
                const record = bytes === null ? null : unpackRegion(bytes, cacheVersion);
                const other = besideKey(one, key, record);
                const besideBytes = other === null ? null : await got(other);
                const cached = accepted(one, record, besideBytes === null ? null
                    : unpackRegion(besideBytes, cacheVersion));
                const batchKey = moduleWanted(cached);
                // Its batch's module, unless this run instantiated it already.
                settle(one, cached,
                    batchKey !== undefined ? await moduleBytes(batchKey) : undefined);
            }
            catch {
                settle(one, null);
            }
        })).then(answered, answered);
    };
    return {
        regionKey,
        storeKey,
        besideKey,
        shapeOf,
        sharedForms,
        formAt,
        accepted,
        storeHere,
        storedOwner,
        storeVersionFor,
        storeModule,
        settle,
        waitedFor,
        prefetch,
        askBefore,
        recordBefore,
        regionOfRecord,
        lookUpOn,
        lookUpLater,
        flushStore,
    };
}
