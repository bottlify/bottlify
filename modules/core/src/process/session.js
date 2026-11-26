/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A run's session: the layer of the volume its writes go into, saved to the
 * origin's storage or a directory and opened again under the bottle's own
 * layers, and the volume furnished as a fresh Windows has it.
 */

import { coalescedSaver, normaliseSession, resolveStorage } from '../storage.js';
import {
    SESSION_LAYER, createSessionSource,
} from '../layers/filesystem/internal/session-source.js';
import { createUnionSource } from '../layers/filesystem/internal/union-source.js';
import { foldName } from '../layers/filesystem/internal/paths.js';
import { mountDiscs } from '../discs.js';
import { cacheSpace } from '../layers/cache/module.js';

/**
 * The session storage holds for a run, its registry laid into `registry`
 * before the program's first instruction, and what saves it from then on.
 *
 * One saver a run, on the thread that holds its volume and hive, with one
 * store. Every process of a thread hears every write to the volume, whichever
 * process made it, and a store's first save of a run writes the whole volume:
 * a saver a process made every process's write saved as many times as
 * processes stood, and each new process rewrote the whole volume -- ngen's
 * dozens of mscorsvw rewrote .NET 4's 600 MB of setup files ~25 times a minute,
 * ~3 GB a minute into the origin's storage. So the run's first process here
 * saves, a later one takes the saving over (the same store) when it ends, and a
 * process that joined the run's system across a link saves nothing: its
 * writes land on the volume that thread's saver hears.
 *
 * @param {{ options: import('../app-options.js').AppOptions, events: any, filesystem: any,
 *     registry: any,
 *     inherited: boolean, standing?: boolean, system?: any }} deps
 *     `standing`: the volume is the run's already, its files laid on it.
 *     `inherited`: the registry is the run's already, made by a process before
 *     this one. `system`: the run's system on this thread, whose saving it is
 */
export async function openSession(deps){
    const { options, events, filesystem, registry, inherited, standing = false } = deps;
    const system = deps.system ?? null;
    const remote = system?.remote === true;
    /** @type {{ storage: any, owner: object | null,
     *     waiting: { self: object, start: () => void }[] } | null} */
    const run = system && !remote
        ? (system.session ??= { storage: null, owner: null, waiting: [] }) : null;
    const storage = run?.storage ?? resolveStorage(options.storage, options.id ?? 'session');
    if (run)
    {
        run.storage = storage;
    }

    // Seeded before the program's first instruction, and awaited: a save that
    // arrives after the program has looked for it is a save that was not there.
    // A process standing on the run's drives and hive reads nothing: what was
    // saved is on them already, laid there by the process that made them, and
    // reading the folder while that process saves into it -- a launcher
    // starting a compiler for every shader -- catches an entry mid-write.
    const seeded = normaliseSession(standing && inherited ? null : await storage.load());
    // The registry first, and before the program's first instruction: its
    // settings and its name are here as often as in a file, and a program
    // that finds the key empty writes its defaults over them. The files wait
    // for the volume they belong on, which the bundle mount replaces.
    // A process the run started after the first has the run's registry
    // already, with what its parent wrote a moment before starting it -- a
    // write no save may have reached -- and reading the save back over it
    // would undo that.
    if (seeded.registry && !inherited)
    {
        registry.fromJSON(seeded.registry);
    }

    // One way out. What the program writes is announced once the writes settle;
    // nothing is ever pulled back in while it runs.
    const persist = remote ? null : storage.save;
    /** @type {ReturnType<typeof coalescedSaver> | null} */
    let saver = null;
    let stopSaving = ()=>{};
    const start = ()=>{
        if (!persist)
        {
            return;
        }
        saver = coalescedSaver({
            snapshot: ()=>({
                files: filesystem.export(),
                links: filesystem.exportLinks?.() ?? null,
                // The bottle's revision it was saved under rides with the hive.
                registry: { ...registry.toJSON(), revision: options.bundle?.revision ?? 0 },
            }),
            persist: (session, changes)=>Promise.resolve(persist(session, changes)).catch(
                (/** @type {Error} */ error)=>{
                    events.emit('error', { reason: 'session-save', error });
                }).finally(()=>{
                // A store of the engine's own has read the files it was handed
                // once its save settles; the writable layer stops keeping them
                // apart then, and its next write into one does not copy it
                // first. One of the caller's may read them later: they are let
                // go of when it lets go of them.
                for (const file of storage.readsWithinSave ? session.files : [])
                {
                    /** @type {any} */ (file).contents?.paged?.release();
                }
            }),
        });
        const pending = saver;
        /** @param {any[]} changes */
        const save = changes=>{
            events.emit('session', { changes });
            pending.note(changes);
        };
        filesystem.onChanged(save);
        // A registry write is a change to the session like a file write is,
        // announced without a path: the whole hive travels with every save.
        // The hive is the run's and outlives this machine: the subscription
        // goes with it (`dispose`).
        const stopRegistry = registry.onChanged(()=>save([{ kind: 'registry' }]));
        stopSaving = ()=>{
            filesystem.onChanged(()=>{});
            stopRegistry();
        };
    };
    const self = {};
    if (!run || run.owner === null)
    {
        if (run)
        {
            run.owner = self;
        }
        start();
    }
    else
    {
        run.waiting.push({ self, start });
    }
    // Its machine is about to go: what it noted is saved now, and the saving
    // passes to the next process standing here, the store with it.
    const stopSavingRegistry = ()=>{
        saver?.flush();
        stopSaving();
        saver = null;
        if (run && run.owner === self)
        {
            run.owner = null;
            const next = run.waiting.shift();
            if (next)
            {
                run.owner = next.self;
                next.start();
            }
        }
        else if (run)
        {
            run.waiting = run.waiting.filter(waiting=>waiting.self !== self);
        }
    };
    const flush = ()=>saver?.flush() ?? Promise.resolve();
    return { seeded, saver: { flush }, stopSavingRegistry };
}

/** Sessions laid under a volume in this thread: each one's pieces under a name of its own. */
let sessionsLaid = 0;

/**
 * The run's read-only half with the session's files under C:'s writable layer
 * and over the bundle, where the store hands them out to be read when asked
 * (`LazySessionFile`): nothing of them is read before the program reads it
 * (`session-source.js`), and a miss of theirs is fetched by the run's `fetch`
 * as a bundle's block is. A file of another drive, and one that a link names,
 * which a restored link copies up at once, is laid on whole (`eager`).
 *
 * The pieces read are kept in the run's cache, in a space of their own
 * (`session/<n>/`): the run's one budget, read in place by every process
 * here, let go of idle or for room. Not a keeper of the session's own, as a
 * bundle has (`bundle/cache.js`): a bundle's keeper is one so that its disk
 * is the next run's, a layer every bottle stands on fetched once from the
 * network; a session's pieces are already on this machine, in the store they
 * are read from, so a disk would only write them a second time beside
 * themselves, and a keeper of their own a second budget beside the run's.
 * For the same reason they never go to the run cache's disk (`disk: 'never'`,
 * not `'run'` or `'kept'`): a piece is a body made again by reading the
 * session, which is the user's and is never lost by letting a piece go.
 *
 * @param {any} blocks  The run's bundle, or null.
 * @param {{ files: any[], links?: any[] | null }} seeded
 * @param {import('../../vendor/cellar/cellar.js').Reader | null} reader  the run's
 *     cache, or null: pieces held only from their fetch to the next
 * @returns {{ blocks: any, eager: any[] }}
 */
function sessionUnder(blocks, seeded, reader){
    // A file a further name is given: the record of a file's number or
    // attributes alone gives none, and its file stays lazy.
    const linked = new Set((seeded.links ?? [])
        .filter(record=>!record.junction && !record.reparse && record.names.length > 0)
        .map(record=>foldName(record.owner)));
    /** @type {{ path: string, file: any }[]} */
    const lazy = [];
    const eager = [];
    for (const file of seeded.files)
    {
        if (typeof file.read === 'function' && /^c:\\/i.test(file.path)
            && !linked.has(foldName(file.path)))
        {
            lazy.push({ path: file.path.slice(3), file });
        }
        else
        {
            eager.push(file);
        }
    }
    if (lazy.length === 0)
    {
        return { blocks, eager };
    }
    const session = createSessionSource(lazy,
        { kept: cacheSpace(reader, `session/${++sessionsLaid}`, { disk: 'never' }) });
    return {
        eager,
        blocks: {
            ...blocks ?? { registry: undefined, stop(){}, ahead: ()=>0,
                refetched: ()=>({ blocks: 0, bytes: 0 }), ranges: ()=>({ requests: 0, bytes: 0 }),
                decoded: ()=>({ blocks: 0, bytes: 0, ms: 0 }) },
            source: blocks ? createUnionSource([session, blocks.source]) : session,
            /** @param {any[]} needed */
            fetch: needed=>{
                const own = needed.filter(block=>block.layer === SESSION_LAYER);
                const rest = needed.filter(block=>block.layer !== SESSION_LAYER);
                return Promise.all([own.length > 0 ? session.fetch(own) : null,
                    rest.length > 0 ? blocks?.fetch(rest) : null]).then(()=>{});
            },
            held: ()=>({ ...blocks?.held?.(), ...session.held() }),
            sessionReads: ()=>session.reads(),
        },
    };
}

/**
 * Lays down the run's volume before its first instruction: the bundle under
 * C:, the discs, the session's files and the page's own over them; and the
 * registry the installation wrote into `registry`, when there is one to fill.
 *
 * @param {{ options: import('../app-options.js').AppOptions, events: any, filesystem: any,
 *     blocks: any, reader?: import('../../vendor/cellar/cellar.js').Reader | null,
 *     seeded: { files: any[], registry?: any, links?: any[] | null }, registry: any }} deps
 *     `reader`: the run's cache, where the session's pieces are kept (`sessionUnder`)
 * @returns {Promise<any>}  The run's read-only half, the session's files in it
 *     (`sessionUnder`): what fetches every block a read of C: misses.
 */
export async function furnishVolume(deps){
    const { options, events, filesystem, blocks, reader = null, seeded, registry } = deps;
    // The session's files under the writable layer and over the bundle, so
    // that a saved file the bundle also carries is the one the program sees.
    const laid = sessionUnder(blocks, seeded, reader);
    if (laid.blocks)
    {
        filesystem.mount('C', { source: laid.blocks.source });
    }
    // What the installation wrote to the registry is the machine's before the
    // program's first instruction, as it was on the machine it was installed
    // on: a launcher finds its game installed by the key its setup made. What
    // the session saved since is kept over it -- unless the session was saved
    // under an earlier revision of the bottle, whose registry is then laid over
    // it, as a reinstall would: a corrected install path reaches a person who
    // ran the bottle before.
    const installedRegistry = await blocks?.registry;
    if (installedRegistry && registry)
    {
        registry.fillFromJSON(installedRegistry,
            (seeded.registry?.revision ?? 0) < (options.bundle?.revision ?? 0));
    }
    // The layers' hives under both, the first layer's over the next: what a
    // bottle or its session set of the same key stays as they set it.
    for (const layer of await blocks?.layerRegistries ?? [])
    {
        if (layer && registry)
        {
            registry.fillFromJSON(layer);
        }
    }
    // A disc is a drive of its own, and takes D: or the first letter nothing
    // holds once the machine's own disk is mounted.
    await mountDiscs({ discs: options.discs, filesystem, events });

    // The rest of the session's files, laid on whole: restored, not written,
    // so nothing is announced and nothing saves them again. One read lazily
    // is read a file at a time, never the whole session held at once.
    for (const file of laid.eager)
    {
        filesystem.apply([typeof file.read === 'function'
            ? { path: file.path, bytes: await file.read() } : file], { saved: true });
    }
    // The names a saved file had besides its own, once the files are down.
    if (seeded.links && seeded.links.length > 0)
    {
        filesystem.applyLinks(seeded.links, { saved: true });
    }
    // The person's own edits to the title's files -- a realm list, a config
    // line -- laid over the session's, so they win over what the program
    // last saved and never touch the bundle itself.
    if (options.files && options.files.length > 0)
    {
        filesystem.apply(options.files);
    }
    return laid.blocks;
}
