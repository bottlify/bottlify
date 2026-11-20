/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A process's library loader: an import resolved to where its library lies,
 * a library loaded at run time (its file found, mapped, its imports bound,
 * its thread-local storage given, DllMain run in order under the loader's
 * lock and the dll notifications told), one let go, and a file loaded as data.
 * What it works on is the process's (`app.js`), handed in as `deps`; what it
 * keeps is its own.
 */

import { watchedArgument } from '../watch-arguments.js';
import { describeAddress } from '../trace.js';
import { parsePe, readExports, readImports } from '../layers/loader/internal/pe.js';
import { readTls } from '../layers/loader/internal/tls.js';
import { mapImage } from '../layers/loader/internal/image.js';
import { blockLayouts } from '../layers/win32/kernel32/teb.js';
import { DEBUG_EVENT } from '../layers/win32/kernel32/debug-events.js';
import { searchesBesideProgram } from '../layers/win32/kernel32/modules.js';
import { DLL_PROCESS_ATTACH, DLL_PROCESS_DETACH } from '../layers/loader/internal/init.js';
import { pathKey } from './module-table.js';
import {
    DONT_RESOLVE_DLL_REFERENCES, ERROR_BAD_EXE_FORMAT, ERROR_DLL_INIT_FAILED, ERROR_FILE_INVALID,
    ERROR_FILE_NOT_FOUND, ERROR_MOD_NOT_FOUND, ERROR_NOT_ENOUGH_MEMORY, ERROR_PROC_NOT_FOUND,
    ERROR_SHARING_VIOLATION, FORWARD_HOPS, ISOLATIONAWARE_MANIFEST,
    LDR_DLL_NOTIFICATION_REASON_LOADED, LDR_DLL_NOTIFICATION_REASON_UNLOADED, LIBRARY_ALIGN,
    LOAD_AS_DATA, LOAD_LIBRARY_AS_DATAFILE_EXCLUSIVE, LOAD_LIBRARY_AS_IMAGE_RESOURCE,
    LOAD_WITH_ALTERED_SEARCH_PATH, PAGE_SIZE, RT_MANIFEST, SYSTEM_LIBRARY_DIRECTORIES,
    createMissingImports, exportTables, libraryCandidates, missingImportCall, moduleKeyOf,
    pathDirectories, placeLibrary, readWholeFile, resourceOfImage, searchedDirectories,
    withLibraryExtension,
} from './libraries.js';

/**
 * @param {Record<string, any> & { threadBlocks: () => any, blocks: () => any }} deps
 *     the process's parts the loader works on, by the names `app.js` gives
 *     them; `threadBlocks` and `blocks`, made after the loader, asked for
 */
export function createLibraryLoader(deps){
    const {
        allLibraries, win32, events, journal, moduleUnderContext, markLoaded, findModule,
        modules, options, bridge, cpu, memory, kernel, freeLocalIndex, giveBackBlocks,
        threadLocalImages, dllNotifications, processBits, debuggerNow, attachOrder, librarySpace,
        isKnownDll, answersPath, activation, filesystem, faceFor, loader, dataFiles, standsAt,
    } = deps;

    /**
     * An import's address, wherever the library that provides it came from.
     *
     * By ordinal as well as by name, because a library may be imported either
     * way and some are imported only by number -- a descriptor that gives an
     * ordinal and no name is not exotic, it is how a whole class of libraries
     * has always been linked against.
     *
     * @param {string} dll
     * @param {string | null} name
     * @param {number | null} ordinal
     * @param {any} [holder]  The library loaded at run time that imports it.
     */
    const resolveImport = (dll, name, ordinal, holder = null)=>{
        const module = moduleUnderContext(dll);
        if (!module)
        {
            return null;
        }
        markLoaded(module);
        // A library loaded at run time holds what it imports from, given
        // back when it is unloaded, as Windows counts a dependency; the
        // program's own imports, and an engine library, stay for the run.
        if (holder && typeof module.references === 'number')
        {
            holdOn(holder, module);
        }
        else
        {
            module.pinned = true;
        }
        // A forwarded import's target is held by the library that forwards
        // to it, pinned where that one is (`holdOn`).
        const found = /** @type {{ address: number, module: any } | { error: number }} */ (
            exportOf(module, name, ordinal, null));
        return 'error' in found ? null : watched(dll, name, ordinal, found.address);
    };

    /**
     * An export of a module, followed through its forwarders (PE/COFF 6.3.2):
     * "LIB.Name" or "LIB.#7" is LIB's export of that name or ordinal, LIB
     * loaded when it is not yet - by the module that forwards to it, which
     * then holds it (`holdOn`): Windows' loader records the forwarder's
     * target as the forwarding module's dependency, so a program that frees
     * the target by name does not unload it while the forwarder stands.
     *
     * One resolver for GetProcAddress, LdrGetProcedureAddress and the import
     * tables. The tables are bound where nothing can wait (`loader.bind`), so
     * they pass no `load`: a target not loaded there is an import not found,
     * and a library loaded at run time has its forwarded imports' targets
     * loaded before it is bound (`loadForwardedImports`).
     *
     * @param {any} module
     * @param {string | null} name
     * @param {number | null} ordinal
     * @param {((library: string, from: any) => number | Promise<number>) | null} load
     * @param {number} [hops]
     * @returns {{ address: number, module: any } | { error: number }
     *     | Promise<{ address: number, module: any } | { error: number }>}
     */
    const exportOf = (module, name, ordinal, load, hops = 0)=>{
        const address = name !== null ? module.addressOf(name)
            : ordinal === null ? null : module.addressOfOrdinal(ordinal);
        if (address !== null)
        {
            return { address, module };
        }
        const forward = module.forwardOf?.(name, ordinal) ?? null;
        if (forward === null)
        {
            return { error: ERROR_PROC_NOT_FOUND };
        }
        if (hops >= FORWARD_HOPS)
        {
            return { error: ERROR_BAD_EXE_FORMAT };
        }
        const dot = forward.lastIndexOf('.');
        const library = withLibraryExtension(forward.slice(0, Math.max(dot, 0)));
        const exported = forward.slice(dot + 1);
        const byNumber = exported.startsWith('#');
        /** @param {any} target */
        const next = target=>{
            holdOn(module, target);
            return exportOf(target, byNumber ? null : exported,
                byNumber ? Number(exported.slice(1)) >>> 0 : null, load, hops + 1);
        };
        const target = dot <= 0 ? null : findModule(library);
        if (target)
        {
            markLoaded(target);
            return next(target);
        }
        if (dot <= 0 || !load)
        {
            return { error: ERROR_MOD_NOT_FOUND };
        }
        return Promise.resolve(load(library, module)).then(got=>{
            const loaded = got ? modules.atBase(got) : null;
            if (!loaded)
            {
                return { error: ERROR_MOD_NOT_FOUND };
            }
            // The load's own reference is the forwarding module's hold.
            holdingSet(module).add(loaded);
            return next(loaded);
        });
    };

    /** What a module holds loaded (`holdOn`). @param {any} holder @returns {Set<any>} */
    const holdingSet = holder=>(holder.holds ??= new Set());

    /**
     * Records that `holder` keeps `held` loaded, taking a reference on it once:
     * given back when `holder` is unloaded (`releaseLibrary`). A library of
     * the engine's, or one pinned, needs no reference.
     *
     * @param {any} holder @param {any} held
     */
    const holdOn = (holder, held)=>{
        if (holder === held || held.pinned || typeof held.references !== 'number')
        {
            return;
        }
        if (holder.pinned)
        {
            held.pinned = true;
            return;
        }
        const holds = holdingSet(holder);
        if (!holds.has(held))
        {
            holds.add(held);
            held.references++;
        }
    };

    /**
     * Which imports to stand in front of, and what each one's arguments are.
     * One stub per import, kept because a library is imported by many others
     * and a second stub for the same function would report the same call twice.
     *
     * @type {Map<string, number>}
     */
    const watches = new Map();

    /**
     * Puts a watch in front of an import when the caller asked for one.
     *
     * Only a guest module's exports are worth watching: a call into one of our
     * own is already a trap and already recorded, and pointing a watch at a
     * stub would trap twice for one call.
     *
     * @param {string} dll @param {string | null} name
     * @param {number | null} ordinal @param {number} address
     * @returns {number}
     */
    const watched = (dll, name, ordinal, address)=>{
        if (!options.watchImport)
        {
            return address;
        }
        const asked = options.watchImport(dll, name, ordinal);
        if (!asked)
        {
            return address;
        }
        return installWatch(`${dll}!${name ?? `#${ordinal}`}`, asked.args * 4, address,
            asked.strings ?? []);
    };

    /**
     * A watch stub in front of `target`, one per label.
     *
     * @param {string} label @param {number} argBytes @param {number} target
     * @param {(number | string)[]} [strings]  Which arguments to report as C strings.
     * @returns {number} the stub's address, to be called in place of the target
     */
    const installWatch = (label, argBytes, target, strings = [])=>{
        const already = watches.get(label);
        if (already !== undefined)
        {
            return already;
        }
        const stub = bridge.watch(label, {
            argBytes,
            target,
            // The call is about to reach the real function, which will leave
            // its own result in EAX; nothing here answers it. What this does
            // instead is arrange to be told what that answer was, by sending
            // the function home through a stub of ours.
            /** @param {number[]} _args @param {{ callerStack: number, freeStack: number }} frame */
            handler: (_args, frame)=>{
                const esp = frame.callerStack >>> 0;
                // ECX is untouched by the stub; EDX was spent on the trap and
                // sits in the block the stub saved, third from the top.
                /** @type {import('../watch-arguments.js').WatchedCall} */
                const call = { esp, ecx: cpu.readReg32('ecx') >>> 0,
                    edx: memory.readU32((frame.freeStack >>> 0) + 20) >>> 0,
                    readU32: at=>memory.readU32(at),
                    readBytes: (at, length)=>memory.readBytes(at, length),
                    readCString: (at, max)=>memory.readCString(at, max) };
                const named = strings.map(where=>watchedArgument(where, call));
                pending.push({ label, esp, returnTo: memory.readU32(esp), named,
                    thread: kernel.currentThread() });
                memory.writeU32(esp, catcher());
                return 0;
            },
        });
        watches.set(label, stub);
        return stub;
    };

    /**
     * Watched calls that have not returned yet, innermost last, each with the
     * thread that made it.
     *
     * A stack rather than a map, because a return address is not enough to tell
     * two calls apart and the answer is wanted per call; and searched for the
     * returning thread's own innermost call, because threads interleave inside
     * watched calls -- a worker woken by one runs before it returns -- and a
     * return taken from another thread's frame sends this one into that
     * thread's caller.
     *
     * @type {{ label: string, esp: number, returnTo: number, named: string[],
     *     thread: any }[]}
     */
    const pending = [];

    /** @type {number | null} */
    let catcherStub = null;

    /**
     * Where a watched function returns to instead of its caller: a stub that
     * reports the answer and then sends it the rest of the way.
     *
     * Reached by the callee's own `ret`, so the return address is gone from the
     * stack by the time this runs and has to be put back for the stub's own
     * `ret` to find. EAX is the answer and is preserved into ECX by the stub,
     * because the trap needs EAX to say which stub fired.
     */
    const catcher = ()=>{
        catcherStub ??= bridge.register('<watch-return>', {
            argBytes: 0,
            preserveResult: true,
            handler: ()=>{
                const answer = cpu.readReg32('ecx') >>> 0;
                const thread = kernel.currentThread();
                let at = pending.length - 1;
                while (at >= 0 && pending[at].thread !== thread)
                {
                    at--;
                }
                if (at < 0)
                {
                    return answer;
                }
                const [frame] = pending.splice(at, 1);
                events.emit('guest-return', frame.named.length
                    ? { name: frame.label, strings: frame.named, result: answer }
                    : { name: frame.label, result: answer });
                const esp = (cpu.readReg32('esp') >>> 0) - 4;
                memory.writeU32(esp, frame.returnTo);
                cpu.writeReg32('esp', esp);
                return answer;
            },
        });
        return catcherStub;
    };

    /**
     * Libraries that could not be given room. Remembered, because asking
     * again cannot change the answer until something mapped is unmapped and
     * its room is free -- forgotten then, as the room may be what one of them
     * wanted; a library that was merely not there is not remembered, since a
     * program puts one in place and asks again -- an installer does exactly
     * that with a library it brought.
     *
     * @type {Set<string>}
     */
    const absentLibraries = new Set();
    /**
     * Libraries whose last load failed for a reason of its own, and LoadLibrary's
     * error for it in place of ERROR_MOD_NOT_FOUND: a file that is no image for
     * this process (not a PE, or the other machine's) is ERROR_BAD_EXE_FORMAT, an
     * image the machine's memory has no room for ERROR_NOT_ENOUGH_MEMORY.
     *
     * @type {Map<string, number>}
     */
    const loadErrors = new Map();
    /** Where the next runtime library goes. Set once the shipped ones are placed. */
    let nextLibraryBase = 0;

    /**
     * A library loaded at run time is given what the startup stub gives one
     * the program imports: the lowest free index in the thread-local array
     * (`freeLocalIndex`), written into the dword its directory names, and a
     * copy of its block at that index of every thread -- those there are now,
     * the one loading it among them, and every one made after (`threadLocals`).
     *
     * @param {number} base
     * @param {import('../layers/loader/internal/tls.js').TlsDirectory} directory
     * @returns {boolean} false, with nothing kept, when the index is past the
     *     thread-local array or there is no room for every thread's copy
     */
    const giveThreadLocals = (base, directory)=>{
        const local = {
            slot: freeLocalIndex(), template: directory.template,
            size: directory.templateSize + directory.zeroFillSize,
        };
        // Threads that are gone take no copy.
        giveBackBlocks();
        if (!deps.threadBlocks()?.addThreadLocal(local))
        {
            return false;
        }
        memory.writeU32(base + directory.indexRva, local.slot);
        threadLocalImages.set(base, {
            index: local.slot, template: local.template, size: local.size,
            callbacks: directory.callbackRvas.map(rva=>base + rva),
        });
        return true;
    };

    /**
     * Tells every callback LdrRegisterDllNotification registered that a
     * library came or went (`reason`: 1 loaded, 2 unloaded), in the order
     * they were registered, on `thread`: with an LDR_DLL_NOTIFICATION_DATA
     * naming it by its loader entry's two names, its base and its size.
     * Windows tells them after a library is mapped and before its DllMain,
     * and after its DllMain on the way out, before it is unmapped.
     *
     * @param {number} reason @param {any} held @param {any} thread
     * @returns {Promise<void> | void}
     */
    const tellNotified = (reason, held, thread)=>{
        const entry = deps.threadBlocks()?.entryOf(held.base) ?? 0;
        if (dllNotifications.size === 0 || entry === 0)
        {
            return;
        }
        const pointer = processBits === 64 ? 8 : 4;
        const layout = blockLayouts(pointer).entry;
        const data = win32.heap().allocate(pointer * 5);
        const fields = [0, entry + layout.FULL_DLL_NAME, entry + layout.BASE_DLL_NAME,
            held.base, held.size ?? 0];
        fields.forEach((value, at)=>memory.writePointer(data + at * pointer, value, pointer));
        return (async()=>{
            try
            {
                for (const { callback, context } of [...dllNotifications.values()])
                {
                    await bridge.callGuest({ entry: callback, args: [reason, data, context],
                        thread });
                }
            }
            finally
            {
                win32.heap().free(data);
            }
        })();
    };

    /**
     * FreeLibrary: gives back one of the references LoadLibrary took on a
     * library the program loaded by name. The last one tells its TLS
     * callbacks and then its DllMain of the detach, on the thread that asked
     * and with lpvReserved NULL, and unloads it -- its thread-local slot and
     * every thread's copy of its block are given back, a library read off the
     * volume is unmapped and forgotten, one of ours stops being loaded, and
     * what it held (its imports and forwarders' targets, `holdOn`) is given
     * back after. A library the program itself imports is pinned and never
     * unloaded.
     *
     * @param {any} held
     * @returns {number | Promise<number>}
     */
    const releaseLibrary = held=>{
        if (held.pinned || !(held.references > 0))
        {
            return 1;
        }
        held.references--;
        if (held.references > 0)
        {
            return 1;
        }
        const unload = ()=>{
            const thread = kernel.currentThread();
            const told = tellNotified(LDR_DLL_NOTIFICATION_REASON_UNLOADED, held, thread);
            // Its debugger hears of it before it is unmapped, the thread
            // waiting for the answer.
            const debugged = debuggerNow()?.report({ code: DEBUG_EVENT.UNLOAD_DLL,
                threadId: thread?.id >>> 0, base: held.base });
            const before = told && debugged ? told.then(()=>debugged) : told ?? debugged;
            return before ? before.then(forget) : forget();
        };
        const forget = ()=>{
            const local = threadLocalImages.get(held.base);
            if (local)
            {
                threadLocalImages.delete(held.base);
                deps.threadBlocks()?.removeThreadLocal(local.index);
            }
            deps.threadBlocks()?.removeModule(held.base);
            const at = attachOrder.indexOf(held);
            if (at >= 0)
            {
                attachOrder.splice(at, 1);
            }
            if (held.fromFile)
            {
                modules.remove(held);
                memory.unregister(held.region);
                librarySpace.giveBack(held.base);
                // Room given back: a library refused for want of it may fit now.
                absentLibraries.clear();
            }
            else
            {
                held.loaded = false;
                held.attached = false;
            }
            events.emit('library-unloaded', { name: held.name, base: held.base });
            // Then what it held (`holdOn`), each given back its reference.
            const holds = [...held.holds ?? []];
            held.holds = undefined;
            let after = /** @type {number | Promise<number>} */ (/** @type {unknown} */ (1));
            for (const other of holds)
            {
                after = after instanceof Promise ? after.then(()=>releaseLibrary(other))
                    : releaseLibrary(other);
            }
            return after instanceof Promise ? after.then(()=>1) : 1;
        };
        const routines = held.attached === false ? [] : [
            ...threadLocalImages.get(held.base)?.callbacks ?? [],
            ...held.entryPoint && held.entryPoint !== held.base ? [held.entryPoint] : [],
        ];
        if (routines.length > 0)
        {
            return win32.callEntryPoint({
                routines, base: held.base, reason: DLL_PROCESS_DETACH, reserved: 0,
                thread: kernel.currentThread(),
            }).then(unload);
        }
        return unload();
    };

    /** The libraries this build synthesises, as opposed to ones a program brings. */
    const systemLibraries = new Set(Object.keys(allLibraries).map(moduleKeyOf));

    /**
     * The path a program named for a library answered from the table in place
     * of its copy, by module key: a table that reads what the copy's package
     * carries beside it -- DSETUP the licence in dsetup32.dll -- looks there.
     *
     * @type {Map<string, string>}
     */
    const broughtCopies = new Map();

    /**
     * Those of them that are Windows' own, by file name: a copy an installation
     * left in system32 would be mapped in place of the engine's, so a bottle
     * carries none (`@bottlify/installer`'s `collect`). The redistributables a
     * table only stands in for -- the D3DX helpers -- are not among them.
     */
    const redistributables = new Set(
        (/** @type {() => string[]} */ (win32.redistributables)?.() ?? []).map(moduleKeyOf));
    const windowsLibraries = Object.keys(allLibraries)
        .filter(name=>!redistributables.has(moduleKeyOf(name)));

    // Where a call to an import nothing claims lands. The branch that returns
    // and the branch that faults are made in `createMissingImports`; what it
    // needs from this closure is the evidence that decides between them.
    const { bind: missingImport, calls: missingCalls } = createMissingImports({
        register: (name, spec)=>bridge.register(name, spec),
        events,
        journal,
        classify: (dll, name)=>{
            const own = !systemLibraries.has(moduleKeyOf(dll)) && findModule(dll) !== null;
            // A name a library the program brought does not export is a
            // mismatch between two of its own files, not a gap in this build:
            // it is reported as the program's own. The full list of what
            // nothing claims is already said at bind time, as
            // `import-unresolved`; the call is the one that matters.
            return {
                own,
                ...missingImportCall(name,
                    { own, cdeclLibrary: win32.libraryConvention(dll) === 'cdecl' }),
            };
        },
        fault: (label, frame)=>{
            // The argument bytes are what nobody knows; the words above
            // the return address are the next best thing, since a reader
            // who knows the function can count them.
            const esp = frame.callerStack >>> 0;
            const words = [0, 1, 2, 3].map(word=>{
                const held = memory.readU32(esp + 4 + word * 4) >>> 0;
                return `0x${held.toString(16).padStart(8, '0')}`;
            });
            const from = describeAddress({ cpu, memory, kernel, bridge }, frame.hostReturn);
            cpu.raiseFault({
                name: 'unimplemented import',
                eip: frame.hostReturn,
                calledFrom: frame.hostReturn,
                detail: `unimplemented import ${label}, called from ${from};`
                    + ` argument bytes unknown, the stack holds ${words.join(' ')}`,
            });
            // The stub's `ret` goes into the park loop, whose halt ends
            // the slice before the caller runs another instruction.
            kernel.holdThread();
            return 0;
        },
    });

    // Binds the sidecar's entries for one image, once the sidecar is set up
    // (below); until then a library loaded at run time has nothing to bind.
    /** @type {((image: { name: string, base: number, sizeOfImage: number,
     *   timeDateStamp: number }) => void) | null} */
    let bindSidecar = null;

    /**
     * LoadLibrary, for a library nothing has loaded yet.
     *
     * Synchronous unless a PE actually has to be read, because the dispatcher
     * treats a promise as "park the guest thread" and the two cheap answers --
     * already here, known absent -- must not cost that.
     *
     * `flags` are LoadLibraryEx's. With DONT_RESOLVE_DLL_REFERENCES the library
     * is mapped and becomes a module, but nothing it imports is loaded or bound
     * and its entry point never runs -- and a later LoadLibrary hands back that
     * same module as it is, as Wine's loader test has it. A program, as against
     * a library, is loaded the same way whatever the flags say.
     *
     * @param {string} requested  The name as asked for, with or without its extension.
     * @param {number} [flags]
     * @param {any} [thread]  Whose LoadLibrary this answers, for a library loaded
     *     as another's dependency: by then the processor is someone else's.
     * @param {number} [importer]  The base of the library whose import this is:
     *     its own activation context is looked in first.
     * @param {import('../layers/win32/kernel32/modules.js').LibrarySearch | null} [search]
     *     LoadLibraryEx's LOAD_LIBRARY_SEARCH_* flags, the places looked in
     *     instead of the standard search: for the library and, as Windows
     *     does, for its imports.
     * @returns {number | Promise<number>}
     */
    const loadLibraryAtRuntime = (requested, flags = 0, thread, importer = 0, search = null)=>{
        const name = withLibraryExtension(requested);
        const only = searchedDirectories(search, options.imagePath ?? 'C:\\app.exe');
        if ((flags & LOAD_AS_DATA) !== 0)
        {
            return loadAsData(name, flags, only);
        }
        // Read now, before anything is awaited: this is the thread whose
        // LoadLibrary call is being answered, and it is the one whose stack the
        // library's entry point has to run on -- the dependencies' entry points
        // too, which are loaded after awaits, when the thread on the processor
        // is any other.
        const asked = thread ?? kernel.currentThread();
        const unresolved = (flags & DONT_RESOLVE_DLL_REFERENCES) !== 0;
        const key = name.toLowerCase().replace(/\.dll$/, '');
        loadErrors.delete(key);
        if (isKnownDll(name) && /[\\/]/.test(name))
        {
            broughtCopies.set(moduleKeyOf(name), name);
        }
        if (absentLibraries.has(key))
        {
            return 0;
        }
        // A KnownDLL is always ours, and a file of that name beside the
        // program is ignored; for every other name the program's own file wins
        // and our table is only the fallback. So the file is looked for before
        // the table is consulted, save for a library already mapped out of one,
        // which is what a second LoadLibrary must get back.
        //
        // A library already here is handed back rather than loaded again, which
        // is what Windows does: LoadLibrary on a loaded module raises its
        // reference count and returns the handle it already has.
        //
        // Loading it twice is not merely wasteful. A program that asks for the
        // same library in a loop -- and they do, because asking is how a
        // program checks something is there -- gets a second copy of the image
        // at a second address every time: its exports resolve to code whose
        // globals are not the ones the first copy's callers hold, the address
        // space fills until there is no room left, and re-reading, re-parsing,
        // re-mapping and re-binding a megabyte of library is most of what the
        // machine then does with its time.
        const named = findModule(name);
        const loaded = answersPath(name, named, only) ? named : null;
        const searched = searchesBesideProgram(isKnownDll(name), Boolean(loaded?.fromFile));
        // A bare name an activation context redirects is that assembly's
        // file -- or the engine's own, when the engine answers it -- and is
        // looked for nowhere else.
        const redirected = searched && !/[\\/]/.test(name)
            ? activation?.redirect(name, activation.moduleContext(importer)) ?? null : null;
        // The importer's directory, where it was loaded with
        // LOAD_WITH_ALTERED_SEARCH_PATH (or brought in by one that was), and
        // the directories PATH names now: a program that puts its own folder
        // of libraries on PATH and loads one of them by its path has that
        // library's imports found there.
        const importing = importer ? modules.atBase(importer) : null;
        const pathValue = Object.entries(win32.environment?.() ?? {})
            .find(([variable])=>variable.toUpperCase() === 'PATH')?.[1];
        const candidates = !searched ? []
            : redirected ? (redirected.source === null ? [] : [redirected.source])
                : libraryCandidates(name, options.imagePath ?? 'C:\\app.exe',
                    filesystem.currentDirectory(), {
                        ours: loaded !== null, from: importing?.searchFrom,
                        path: pathDirectories(pathValue), only,
                    });
        if (candidates.length > 0)
        {
            // Looked for before anything is awaited: a title probes for
            // hardware support once a frame by asking for a library that does
            // not exist, and a probe that has to wait is a stall per frame. The
            // volume's index answers at once, and answers afresh each time, so a
            // library put in place since the last ask is found.
            const wanted = candidates.find(candidate=>{
                try
                {
                    const entry = filesystem.stat(candidate);
                    return entry && !entry.directory;
                }
                catch {
                    return false;
                }
            });
            if (wanted !== undefined)
            {
                return (async()=>{
                    const file = await readWholeFile(filesystem, deps.blocks(), wanted,
                        undefined, code=>{
                            if (code === 'SHARING_VIOLATION')
                            {
                                loadErrors.set(key, ERROR_SHARING_VIOLATION);
                            }
                        });
                    if (!file)
                    {
                        events.emit('library-missing', { name, path: wanted });
                        return 0;
                    }

                    let image;
                    try
                    {
                        image = parsePe(file, { bits: processBits });
                    }
                    catch (e){
                        // A file that is not an image -- a program does load
                        // one, by mistake or to find out -- or one of the other
                        // machine is a library it cannot have, not a fault in
                        // the machine: the load fails with ERROR_BAD_EXE_FORMAT,
                        // as Windows fails it.
                        events.emit('library-missing', {
                            name, path: wanted, reason: /** @type {Error} */ (e).message,
                        });
                        loadErrors.set(key, ERROR_BAD_EXE_FORMAT);
                        return 0;
                    }
                    const place = placeLibrary(image, { next: nextLibraryBase, ...librarySpace });
                    if ('refused' in place)
                    {
                        absentLibraries.add(key);
                        events.emit('libraries-missing', { names: [name], reason: place.refused });
                        return 0;
                    }

                    const base = place.base;
                    // Its region is named by the file, not by the name asked
                    // for: a table of the same name (the D3DX helpers) has its
                    // own region from the start, and a name has one owner.
                    const region = wanted;
                    let mapped;
                    try
                    {
                        mapped = loader.map(file, { base, name: region, bits: processBits });
                    }
                    catch (e){
                        const code = /** @type {any} */ (e)?.code;
                        if (code !== 'MACHINE_MEMORY' && code !== 'BAD_EXE_FORMAT')
                        {
                            throw e;
                        }
                        // The machine's memory full, or a file no image can be
                        // laid out of: the load fails, as Windows fails a view
                        // it cannot commit or an invalid image, and the program
                        // goes on with the error to read. Thrown, it ended the
                        // process.
                        librarySpace.giveBack(base);
                        loadErrors.set(key, code === 'MACHINE_MEMORY' ? ERROR_NOT_ENOUGH_MEMORY
                            : ERROR_BAD_EXE_FORMAT);
                        events.emit('library-missing', {
                            name, path: wanted, reason: /** @type {Error} */ (e).message,
                        });
                        return 0;
                    }
                    const { exports } = readExports(file, image);

                    // Only a library's imports are resolved and its entry
                    // point run: a program loaded by name is mapped for what
                    // it holds, and its entry point is its main.
                    const inert = unresolved || !image.library;
                    // Where it is: the assembly's directory for one a context
                    // redirected, whichever file its bytes were read from.
                    const path = redirected?.path ?? wanted;
                    // Its own activation context, from its manifest: where its
                    // own imports are looked for first. One whose assemblies
                    // cannot be found is refused, as Windows refuses the load.
                    const own = inert || !activation ? null
                        : await activation.moduleContextFrom(
                            resourceOfImage(file, RT_MANIFEST, ISOLATIONAWARE_MANIFEST), path);
                    if (own && 'refused' in own)
                    {
                        memory.unregister(region);
                        librarySpace.giveBack(base);
                        events.emit('libraries-missing', { names: [name], reason: own.refused });
                        return 0;
                    }
                    if (own)
                    {
                        activation.bindModule(base, own.handle);
                    }
                    const held = {
                        name, base, size: image.sizeOfImage, region,
                        ...exportTables(exports, base),
                        entryPoint: mapped.record.entryPoint,
                        // As above: its resources are read where it lies.
                        fromFile: true,
                        image,
                        path,
                        searchFrom: (flags & LOAD_WITH_ALTERED_SEARCH_PATH) !== 0
                            && /[\\/]/.test(name) ? path.slice(0, path.lastIndexOf('\\'))
                            : importing?.searchFrom,
                    };
                    // Registered before its own imports are bound, so a library
                    // that imports back into itself -- or into one still being
                    // loaded -- finds an address rather than nothing.
                    Object.assign(held, {
                        references: 1,
                        /** @returns {number | Promise<number>} */
                        release: ()=>releaseLibrary(held),
                    }, inert ? { inert, attached: false } : {});
                    // A bare name finds the first module of its name, as
                    // Windows walks its modules in the order they loaded.
                    modules.add(held, moduleKeyOf(name), 'first');
                    // Joins PEB->Ldr's own module list the same moment: a
                    // program that walks it right after this LoadLibraryA
                    // returns is not told the library it just asked for was
                    // never loaded.
                    deps.threadBlocks()?.addModule(held);
                    if (image.relocatable)
                    {
                        nextLibraryBase = base
                            + Math.ceil(image.sizeOfImage / LIBRARY_ALIGN) * LIBRARY_ALIGN;
                    }

                    /** The libraries loaded for it, given back if it is refused. @type {any[]} */
                    const brought = [];

                    // Its own libraries first, then binding.
                    //
                    // The order is the whole of it. A library brought in by
                    // this one is where half of this one's imports come from, so
                    // binding before they are loaded leaves every one of those
                    // slots unclaimed -- and a program that calls through such a
                    // slot does not fail at the call, it runs whatever bytes the
                    // slot happened to name. What is seen is an invalid opcode
                    // at an address belonging to nothing.
                    if (!inert)
                    {
                        // A library one of whose own libraries is nowhere --
                        // not on the volume, not one the engine provides --
                        // is refused whole, with ERROR_MOD_NOT_FOUND, as
                        // Windows refuses it: a program asking at run time is
                        // asking whether it may have the library, and a "yes"
                        // whose imports fault when called takes away the
                        // fallback it has for "no" (its own resources, another
                        // renderer).
                        /** @type {string[]} */
                        const absent = [];

                        for (const dependency of readImports(file, image))
                        {
                            if (findModule(dependency.dll) === null)
                            {
                                const got = await loadLibraryAtRuntime(dependency.dll, 0, asked,
                                    base, search && { ...search, from: search.loadDirectory
                                        ? path.slice(0, path.lastIndexOf('\\')) : undefined });
                                if (got === 0)
                                {
                                    absent.push(dependency.dll);
                                }
                                else
                                {
                                    // Its load's reference is this library's hold.
                                    const dependencyHeld = modules.atBase(got);
                                    brought.push(dependencyHeld);
                                    if (dependencyHeld && dependencyHeld !== held)
                                    {
                                        holdingSet(held).add(dependencyHeld);
                                    }
                                }
                            }
                        }
                        /** @param {string} reason */
                        const refuse = async reason=>{
                            deps.threadBlocks()?.removeModule(base);
                            modules.remove(held);
                            memory.unregister(region);
                            librarySpace.giveBack(base);
                            for (const other of brought)
                            {
                                if (other)
                                {
                                    await releaseLibrary(other);
                                }
                            }
                            events.emit('libraries-missing', { names: [name], reason });
                            return 0;
                        };
                        if (absent.length > 0)
                        {
                            return refuse(`it imports ${absent.join(', ')}`);
                        }

                        // What its imports reach through a forwarder, loaded
                        // before it is bound, as Windows' loader snaps a
                        // forwarded import by loading the forwarder's target.
                        for (const dependency of readImports(file, image))
                        {
                            const provider = moduleUnderContext(dependency.dll);
                            for (const entry of provider ? dependency.entries : [])
                            {
                                const found = exportOf(provider, entry.name, entry.ordinal,
                                    (library, from)=>loadLibraryAtRuntime(library, 0, asked,
                                        from.base ?? 0));
                                if (found instanceof Promise)
                                {
                                    await found;
                                }
                            }
                        }
                        loader.bind(mapped, (/** @type {string} */ dll,
                            /** @type {string | null} */ imported,
                            /** @type {number | null} */ ordinal)=>
                            resolveImport(dll, imported, ordinal, held), missingImport);
                        // Both tables, and in this order: the delay-load pass
                        // adds to what the first one recorded rather than
                        // replacing it.
                        loader.bindDelayed(mapped, resolveImport, missingImport);

                        // Its thread-local storage, before any of it runs, as
                        // Windows gives a library loaded at run time since
                        // Vista: Wine's loader test reads the slot and the
                        // calling thread's copy of the block as soon as
                        // LoadLibrary returns, and a thread made afterwards
                        // finds its own.
                        const directory = readTls(file, image,
                            (rva, length)=>memory.readBytes(base + rva, length));
                        if (directory && !giveThreadLocals(base, directory))
                        {
                            return refuse('no thread-local slot, or no room for every'
                                + ' thread\'s copy of its block');
                        }
                        if (directory)
                        {
                            deps.threadBlocks()?.hasThreadLocals(base);
                        }
                    }
                    // Before DllMain: a sidecar entry for this library patches
                    // its code, which must happen before any of it has run
                    // or been compiled.
                    bindSidecar?.({
                        // By file name, as the sidecar names an image; the
                        // program may have asked for the library by path.
                        name: name.slice(
                            Math.max(name.lastIndexOf('\\'), name.lastIndexOf('/')) + 1),
                        base, sizeOfImage: image.sizeOfImage,
                        timeDateStamp: image.timeDateStamp,
                    });

                    // Mapped and bound: its copy-on-write pages are the
                    // program's to write from here on (A248).
                    win32.imageMapped(base);
                    // The callbacks LdrRegisterDllNotification registered, after it
                    // is mapped and bound and before any of its code runs.
                    await tellNotified(LDR_DLL_NOTIFICATION_REASON_LOADED, held, asked);
                    // And its debugger, when its parent debugs this process.
                    await debuggerNow()?.report({ code: DEBUG_EVENT.LOAD_DLL,
                        threadId: asked?.id >>> 0, base });

                    // Its TLS callbacks, then its DllMain, lpvReserved NULL as
                    // for any library loaded by name. On the thread that asked
                    // for the library, which by now is not the one on the
                    // processor: mapping it awaited a file and a range
                    // request, and the loop gave every other thread its turns
                    // while that was outstanding. Running a DllMain on whoever
                    // happens to be current builds its frame on a stranger's
                    // stack.
                    const routines = inert ? [] : [
                        ...threadLocalImages.get(base)?.callbacks ?? [],
                        ...held.entryPoint && held.entryPoint !== base ? [held.entryPoint] : [],
                    ];
                    // Under its own activation context, or the one it was
                    // found through, as Windows runs a DllMain: a runtime that
                    // checks how it was loaded looks itself up in it.
                    const teb = asked?.tebAddress ?? 0;
                    const cookie = routines.length === 0 || !activation ? 0
                        : activation.activate(activation.moduleContext(base)
                            || redirected?.context || 0, teb);
                    // Inside the loader's own frame, as Windows' loader calls
                    // them: an exception one of them leaves fails the load and
                    // never reaches the program's handlers, and a DllMain that
                    // answers FALSE fails it too - told DLL_PROCESS_DETACH and
                    // unloaded, as the DllMain contract says - with
                    // ERROR_DLL_INIT_FAILED either way.
                    /** @type {number | null} */
                    let raised = null;
                    /** @type {number} */
                    let answer;
                    try
                    {
                        answer = routines.length === 0 ? 1 : await win32.callEntryPoint({
                            routines, base, reason: DLL_PROCESS_ATTACH, reserved: 0,
                            thread: asked, raised: (/** @type {number} */ code)=>{
                                raised = code;
                            },
                        });
                    }
                    finally
                    {
                        activation?.deactivate(cookie, teb);
                    }
                    if (routines.length > 0)
                    {
                        attachOrder.push(held);
                    }
                    const entryRan = routines.at(-1) === held.entryPoint;
                    if (raised !== null || (entryRan && answer === 0))
                    {
                        // An exception leaves nothing to detach: its DllMain
                        // never answered.
                        if (raised !== null)
                        {
                            Object.assign(held, { attached: false });
                        }
                        Object.assign(held, { references: 1 });
                        await releaseLibrary(held);
                        for (const other of brought)
                        {
                            if (other)
                            {
                                await releaseLibrary(other);
                            }
                        }
                        loadErrors.set(key, ERROR_DLL_INIT_FAILED);
                        events.emit('libraries-missing', { names: [name],
                            reason: raised !== null ? `its initialisation raised 0x${
                                (raised >>> 0).toString(16)}` : 'its DllMain answered FALSE' });
                        return 0;
                    }
                    events.emit('library-loaded', { name, base });
                    return base;
                })();
            }
        }
        // Under a LoadLibraryEx search, the engine's own library is the system
        // directory's: found only where that is searched, or when it is a
        // KnownDLL or already loaded, which Windows finds by name first.
        const table = faceFor(name, redirected) ?? (!search || search.system
            || isKnownDll(name) || loaded?.loaded !== false ? loaded : null);
        if (table)
        {
            markLoaded(table);
            table.references = (table.references ?? 0) + 1;
            // One of ours asked for unresolved is left unattached, and a later
            // load attaches it: its entry point is our own setup, which the
            // rest of it relies on.
            if (table.attached !== false || !table.entryPoint || table.inert || unresolved)
            {
                return table.base;
            }
            // Its first LoadLibrary: the entry point runs now, on the thread
            // that asked, exactly as a library read off the volume gets its
            // DllMain above. Marked first, so a load the entry point itself
            // provokes does not run it twice.
            table.attached = true;
            return bridge.callGuest({
                entry: table.entryPoint,
                args: [table.base, DLL_PROCESS_ATTACH, 0],
                thread: asked,
            }).then(()=>{
                attachOrder.push(table);
                return table.base;
            });
        }
        // Said out loud, because this is the failure a program reports as
        // "could not open" and then exits on. Without it the only trace is a
        // zero, and a zero says nothing about which path was tried -- which is
        // the whole question.
        events.emit('library-missing', {
            name,
            path: isKnownDll(name) ? 'KnownDLLs' : candidates.join(';'),
        });
        return 0;
    };

    /**
     * FreeLibrary on a data file's handle: the last one unmaps the view.
     *
     * @param {number} handle
     */
    const releaseData = handle=>{
        const held = dataFiles.get(handle);
        if (!held)
        {
            return 0;
        }
        held.references--;
        if (held.references === 0)
        {
            dataFiles.delete(handle);
            if (held.hold)
            {
                filesystem.close(held.hold);
            }
            if (held.region)
            {
                memory.unregister(held.region);
                librarySpace.giveBack(held.base);
                absentLibraries.clear();
            }
        }
        return 1;
    };

    /**
     * LoadLibraryEx with a flag that loads a library as data, for its
     * resources: nothing in it is bound or run.
     *
     * A library already loaded as a module is answered with its module handle,
     * and counted, as Wine's loader test has it. Any other is mapped apart and
     * is no module -- GetModuleHandle does not find it -- and its handle is its
     * base with a low bit set: one for a view of the file as it lies on disk,
     * two for one laid out as an image (LOAD_LIBRARY_AS_IMAGE_RESOURCE). Each
     * such load is a view of its own.
     *
     * @param {string} name
     * @param {number} flags
     * @param {string[]} [only]  A LoadLibraryEx search's places (`searchedDirectories`).
     * @returns {number | Promise<number>}
     */
    const loadAsData = (name, flags, only = undefined)=>{
        const key = name.toLowerCase().replace(/\.dll$/, '');
        loadErrors.delete(key);
        const named = findModule(name);
        // A path is a file: one of ours answers it in the system directory,
        // where Windows has it, or where a file of it stands.
        const directory = name.slice(0,
            Math.max(name.lastIndexOf('\\'), name.lastIndexOf('/')) + 1);
        const loaded = answersPath(name, named, only)
            && (!/[\\/]/.test(name) || named?.fromFile || standsAt(name)
                || pathKey(directory) === pathKey(SYSTEM_LIBRARY_DIRECTORIES[0])) ? named : null;
        if (loaded && loaded.loaded !== false)
        {
            loaded.references = (loaded.references ?? 0) + 1;
            return loaded.base;
        }
        const layout = (flags & LOAD_LIBRARY_AS_IMAGE_RESOURCE) !== 0 ? 2 : 1;
        /**
         * @param {any} held  What was mapped, and where.
         * @returns {number}
         */
        const record = held=>{
            const handle = (held.base | layout) >>> 0;
            dataFiles.set(handle, {
                ...held, references: 1, release: ()=>releaseData(handle),
            });
            return handle;
        };
        const wanted = libraryCandidates(name, options.imagePath ?? 'C:\\app.exe',
            filesystem.currentDirectory(), { only }).find(standsAt);
        if (wanted === undefined)
        {
            // One of ours nothing has loaded: there is no file to view, and
            // the image it has holds no resources.
            if (loaded)
            {
                return record({ name, base: loaded.base, image: null,
                    flat: false, region: null });
            }
            // A path names its file, which CreateFile does not find.
            if (/[\\/]/.test(name))
            {
                loadErrors.set(key, ERROR_FILE_NOT_FOUND);
            }
            events.emit('library-missing', { name, path: 'as data' });
            return 0;
        }
        return (async()=>{
            const file = await readWholeFile(filesystem, deps.blocks(), wanted, undefined, code=>{
                if (code === 'SHARING_VIOLATION')
                {
                    loadErrors.set(key, ERROR_SHARING_VIOLATION);
                }
            });
            let image;
            try
            {
                // Any machine: a library loaded for its data is never run.
                image = file ? parsePe(file, { wide: true }) : null;
            }
            catch {
                image = null;
            }
            if (!file || !image)
            {
                // An empty file is no view; any other that is no image is
                // refused as Windows refuses its format.
                if (file)
                {
                    loadErrors.set(key, file.length === 0 ? ERROR_FILE_INVALID
                        : ERROR_BAD_EXE_FORMAT);
                }
                events.emit('library-missing', { name, path: wanted, reason: 'not an image' });
                return 0;
            }
            // LOAD_LIBRARY_AS_DATAFILE_EXCLUSIVE keeps writers off the file
            // while it is loaded: an open of it, reading and sharing all but
            // writing, held until its last FreeLibrary.
            let hold = null;
            if ((flags & LOAD_LIBRARY_AS_DATAFILE_EXCLUSIVE) !== 0)
            {
                try
                {
                    hold = filesystem.open(wanted, { read: true, shareRead: true,
                        shareWrite: false, shareDelete: true });
                }
                catch (e){
                    loadErrors.set(key, /** @type {any} */ (e)?.code === 'SHARING_VIOLATION'
                        ? ERROR_SHARING_VIOLATION : ERROR_FILE_NOT_FOUND);
                    return 0;
                }
            }
            const bytes = layout === 1 ? file
                : mapImage(file, image.imageBase, { wide: true }).bytes;
            const size = Math.ceil(bytes.length / PAGE_SIZE) * PAGE_SIZE;
            const place = placeLibrary({ relocatable: true, imageBase: 0, sizeOfImage: size },
                { next: nextLibraryBase, ...librarySpace });
            if ('refused' in place)
            {
                if (hold)
                {
                    filesystem.close(hold);
                }
                events.emit('libraries-missing', { names: [name], reason: place.refused });
                return 0;
            }
            const region = `${name} as data at 0x${place.base.toString(16)}`;
            memory.register({
                name: region, base: place.base, size,
                kind: memory.RegionKind.IMAGE, access: memory.Access.READ_WRITE,
            });
            memory.writeBytes(place.base, bytes);
            // Read-only once filled, as a view of a data file is mapped.
            memory.protect(region, memory.Access.READ);
            // Its resources are read where it lies (`resourceLookup`): a flat
            // view is the file's own layout, as long as the file.
            return record({ name, base: place.base, image, flat: layout === 1,
                fileSize: file.length, region, path: wanted, hold });
        })();
    };

    return {
        resolveImport, missingImport, loadLibraryAtRuntime, exportOf, loadErrors, broughtCopies,
        systemLibraries, releaseLibrary, installWatch, windowsLibraries, missingCalls, watches,
        /** Where the next library is placed when its own base is taken. */
        get nextLibraryBase(){
            return nextLibraryBase;
        },
        set nextLibraryBase(base){
            nextLibraryBase = base;
        },
        /** What binds a library brought beside the program, once there is one. */
        get bindSidecar(){
            return bindSidecar;
        },
        set bindSidecar(bind){
            bindSidecar = bind;
        },
    };
}
