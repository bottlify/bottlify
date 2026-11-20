/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { FIRST_PROCESS_ID } from './process-layout.js';
import { createSyncObjects } from '../layers/kernel/internal/sync.js';
import { STILL_ACTIVE } from '../layers/kernel/internal/processes.js';
import { STEAM_PATH, announceSteamClient } from '../layers/win32/steamclient/functions.js';
import { createLinkMemory, openLink } from '../system/link.js';
import { comHandlers } from '../com-link.js';
import { pipeHandlers } from '../system-pipes.js';
import { objectHandlers } from '../system-objects.js';
import { systemHandlers } from '../system-link.js';
import { storeHandlers } from '../layers/cpu/internal/store-link.js';
import { eventFrom } from '../system/events-across.js';
import { crossingFiles, handedFiles, inheritedOpen } from '../system/inherited-files.js';
import { connectGraphicsWorker, portEnd } from '../layers/graphics/remote/connect.js';
import { openProcessWorker } from '../host/process-worker.js';
import { teardown } from '../teardown.js';
import { diagnosticsSummary } from '../events.js';

/** @typedef {import('../host/pool/pool.js').PoolProcess} PoolProcess */
/** @typedef {import('../app-options.js').SpareMemory} SpareMemory */

/**
 * beside - the processes a run starts beside its first: each in a worker of
 * its own or in this one, the facade speaking for whichever stands.
 */

/**
 * @param {Record<string, any>} deps  the parts of the process it works on, by the
 *     names `app.js` gives them; asked for, since they are made or set later:
 *     `audioMemory`, `current`, `imagePath`, `logSequence`, `own`, `runOptionsNow`
 */
export function processesBeside(deps){
    const {
        across, besides, bindLogLevels, borrowSound, build, classTable, endServices, events,
        facade, inWorker, keepMemory, keepSpare, lendSound, lentConfig, machineMemory, mainLine,
        mediaInstance, names, newProcessIds, noteLogSequence, noticeExit, options, ownSound,
        presenter, releaseHolder, replayLogLevels, retire, rootAcross, rootLibraries,
        routedInput, runDesktop, runMachine, runWindows, serverImage, servers, servicesAcross,
        serving, spareMemories, standing, standingAcross, standingBeside, starting, system,
        translationPool, translationStore,
    } = deps;
    const {
        audioMemory, current, imagePath, logSequence, own, runOptionsNow,
    } = deps;

    /**
     * The facade speaks for this process from now on, its input routed and a
     * tool's view of the windows and the screen the run's.
     *
     * @param {any} speaking
     */
    const stand = speaking=>{
        Object.assign(facade, speaking, own());
        facade.input = routedInput(speaking.input);
        if (speaking.debug)
        {
            // The first process by its id is the page's own line's, not the
            // facade's: that speaks for the child started last, and a run whose
            // program waits on its children read the child's tables twice.
            const firstProcess = ()=>(rootAcross ? speaking : mainLine.current);
            facade.debug = { ...speaking.debug,
                windows: ()=>runWindows() ?? speaking.debug.windows(),
                desktop: ()=>runDesktop(()=>speaking.debug.desktop()),
                // `diagnostics` answers for this process alone, and an
                // installer's work is often in a child its launcher started:
                // the run's processes, and any one's tables by its id.
                processes: ()=>[
                    { id: options.processId ?? FIRST_PROCESS_ID, image: options.imagePath ?? '' },
                    ...[...standingAcross].map(each=>({ id: each.id, image: each.image })),
                    ...[...standingBeside].map(each=>({ id: each.id, image: each.image,
                        beside: true })),
                ],
                /** @param {number} id */
                diagnosticsOf: id=>{
                    if (id === (options.processId ?? FIRST_PROCESS_ID))
                    {
                        return firstProcess().diagnostics();
                    }
                    const child = [...standingAcross, ...standingBeside].find(each=>each.id === id);
                    return child ? child.diagnostics()
                        : Promise.reject(new Error(`no process ${id} stands`));
                },
                /**
                 * Bytes of a process's memory by its id, the first's or one
                 * running beside it: an OVERLAPPED a program polls, a buffer it
                 * waits on.
                 *
                 * @param {number} id @param {number} address @param {number} length
                 */
                readOf: (id, address, length)=>{
                    if (id === (options.processId ?? FIRST_PROCESS_ID))
                    {
                        return firstProcess().debug.read(address, length);
                    }
                    const child = [...standingBeside].find(each=>each.id === id);
                    if (!child)
                    {
                        throw new Error(`no process ${id} stands beside`);
                    }
                    return child.read(address, length);
                },
                /**
                 * A watch in front of a routine of a process by its id (`hook`):
                 * the first's, or one running beside it, where a compiler or a
                 * setup's helper does the work.
                 *
                 * @param {number} id @param {number} address @param {any} how
                 */
                hookOf: (id, address, how)=>{
                    if (id === (options.processId ?? FIRST_PROCESS_ID))
                    {
                        return firstProcess().debug.hook(address, how);
                    }
                    const child = [...standingBeside].find(each=>each.id === id);
                    if (!child)
                    {
                        throw new Error(`no process ${id} stands beside`);
                    }
                    return child.hook(address, how);
                } };
        }
    };

    /**
     * The events the exits of processes in workers of their own set, made
     * here, where the run's directory of processes is: nothing blocks on this
     * table itself, since every thread that waits on one of them is woken by
     * its own scheduler (`sync.js`).
     */
    const processEvents = createSyncObjects({ scheduler: {
        block(){
            throw new Error('process events: a wait here is a thread\'s own, never a block');
        },
        wake(){},
        onTimeout(){},
    } });

    /**
     * A process in a worker of its own as the run's directory lists it: what
     * OpenProcess in any process of the run finds by its id, a wait on it
     * waits for, and GetExitCodeProcess reads.
     *
     * @param {any} request
     */
    const listedAcross = request=>({ kind: 'process', id: request.id,
        threadId: request.threadId ?? request.id + 1, imagePath: request.imagePath ?? '',
        commandLine: request.commandLine ?? '', suspended: false, started: true,
        completed: false, exitCode: STILL_ACTIVE,
        exited: processEvents.createEvent({ manualReset: true, signalled: false,
            name: `process ${request.id}` }) });

    // A run made with a signed-in Steam account has its client running, as a
    // game finds one. With every program in a worker of its own the registry
    // and the directory of processes are the system half's, made here before
    // any program: the client is listed and announced here, once, over what a
    // saved session left (a pid of a client long gone). On the run's thread
    // the first program's win32 does it, the hive being its own.
    if (rootAcross && options.win32?.steam)
    {
        const { processId } = newProcessIds();
        system.processDirectory?.set(processId,
            listedAcross({ id: processId, imagePath: `${STEAM_PATH}\\steam.exe` }));
        announceSteamClient(system.registry, { pid: processId, account: options.win32.steam });
    }

    /**
     * Runs a child in a worker of its own: its machine there, the run's
     * system half answered from here across a link (`system-link.js`), its
     * output the run's. Its exit code is the answer.
     *
     * @param {{ readImage: (path: string) => Promise<Uint8Array | null>,
     *     sound: () => ({ options: any, giveBack: () => void } | null),
     *     server?: boolean }} from  `server` for one COM started, whose code is no run's
     *     its parent, as the run reaches it: where its image is read, and the
     *     sound it lends
     * @param {any} request
     * @param {{ link: ReturnType<typeof openLink> | null, code: number | null,
     *     opened?: () => void }} [reach]
     *     how its parent's TerminateProcess reaches it: given its link once
     *     there is one, and the code it was ended with before then
     * @returns {Promise<{ code: number, diagnostics?: any, systemLibraries?: string[] }>}
     *     its exit code, its layers' diagnostics as it ended, and the system
     *     libraries it knew
     */
    const runAcross = async(from, request, reach)=>{
        const image = request.image
            ?? await from.readImage(request.imagePath).catch(()=>null);
        if (!image)
        {
            events.emit('divergence', { api: 'process',
                detail: `${request.imagePath} is not on the volume, and did not start` });
            return { code: 2 };
        }
        const memory = createLinkMemory();
        // Its classes, served to and from every other process of the run.
        const com = comHandlers(/** @type {any} */ (classTable), {
            call: (method, args)=>link.call('com', method, args),
            launch: serverAcross,
        });
        // The pipe ends it inherits, served here, where its parent holds them.
        const { dispose: forgetPipes, described: pipeEnds, pipes } =
            pipeHandlers(request.inheritedHandles);
        // In the run's directory of processes, where another process opens it
        // by id, unless its parent here put it there already.
        const directory = system.processDirectory;
        const listed = directory && !directory.has(request.id) ? listedAcross(request) : null;
        if (directory && listed)
        {
            directory.set(request.id, listed);
        }
        const { dispose: forgetObjects, ...objects } = objectHandlers({
            table: system.namedObjects,
            processes: system.processDirectory,
            wake: (token, result)=>link.call('kernel', 'wake', [token, result]) });
        /**
         * Its worker, once open: what the pool lends a process there through.
         *
         * @type {{ worker: import('../host/process-worker.js').ProcessWorker | null }}
         */
        const lending = { worker: null };
        /** The processes beside it in its worker the run's pool lends to, by id. */
        const lentBeside = new Set();
        /** The processes whose windows it answers for, by id: detached as it goes. @type {Set<number>} */
        const windowsAcross = new Set();
        const link = openLink(memory.a, {
            ...systemHandlers(/** @type {any} */ (system),
                (target, method, args)=>link.callWaiting(target, method, args), windowsAcross),
            ...objects,
            com: com.handlers,
            pipes,
            // The run's translation store, which only this thread can hold open.
            ...translationStore ? storeHandlers(translationStore) : {},
            process: {
                output: (/** @type {number} */ handle, /** @type {string} */ text)=>
                    events.emit('output', { handle, text }),
            },
            // Everything else that happens to it, for the page subscribed here.
            events: {
                emit: (/** @type {string} */ name, /** @type {any} */ payload)=>{
                    events.emit(name, eventFrom(payload));
                },
            },
            // A child it started beside itself in its worker, which the run had
            // no worker for: lent translators by the run's pool as any process
            // is, through its worker, named by its id.
            translators: {
                /** @param {number} id */
                add: id=>{
                    const through = lending.worker;
                    if (!translationPool || !through || lentBeside.has(id))
                    {
                        return false;
                    }
                    lentBeside.add(id);
                    translationPool.addProcess(id, /** @type {PoolProcess} */ ({
                        lend: (port, token)=>through.post({ type: 'translator', port, token,
                            process: id }, [port]),
                        recall: token=>through.post({ type: 'recall', token, process: id }),
                    })).catch(()=>{});
                    return true;
                },
                /** @param {number} id */
                remove: id=>{
                    if (lentBeside.delete(id))
                    {
                        translationPool?.removeProcess(id);
                    }
                },
            },
            // Its own children, which the run starts, counted with the rest.
            processes: {
                start: (/** @type {any} */ asked)=>startAcrossFor(link, asked),
                terminate: (/** @type {number} */ id, /** @type {number} */ code)=>
                    terminateBeside({ id }, code),
                ask: (/** @type {number} */ id, /** @type {any} */ call)=>
                    askBeside({ id }, call),
            },
            // The parent's open files the child inherited: one position, the
            // parent's open's, which the child's reads and writes move.
            inherited: {
                /** @param {number} handle */
                position: handle=>inheritedOpen(request.inheritedHandles, handle)?.position ?? 0,
                /** @param {number} handle @param {number} at */
                setPosition: (handle, at)=>{
                    const open = inheritedOpen(request.inheritedHandles, handle);
                    if (open)
                    {
                        open.position = at;
                    }
                },
            },
        });
        const answering = link.serve();
        /**
         * What the teardown lets go, as far as the start got: a start that
         * failed half-way - its worker refused - leaves nothing standing either.
         *
         * @type {{ worker: import('../host/process-worker.js').ProcessWorker | null,
         *     sound: { giveBack: () => void } | null, shown: { dispose: () => void } | null,
         *     display: MessageChannel | null, asked: any, holder?: number }}
         */
        const held = { worker: null, sound: null, shown: null, display: null, asked: null };
        /** The code it exited with, once it has. @type {number | null} */
        let ended = null;
        try
        {
            if (reach)
            {
                reach.link = link;
                reach.opened?.();
                if (reach.code !== null)
                {
                    terminateAcross(link, reach.code);
                }
            }
            // Its own way in to the run's graphics worker, where its Direct3D
            // devices draw; what they present comes back here, to the run's
            // presenter, as every root's frames do.
            const graphicsWorker = options.device?.worker;
            const graphics = graphicsWorker ? new MessageChannel() : null;
            if (graphics)
            {
                // Named by its id, which its end below tells the worker to forget.
                graphicsWorker.postMessage({ type: 'client', port: graphics.port2,
                    client: request.id }, [graphics.port2]);
            }
            // And the pictures of its own surfaces -- a DirectDraw primary, the
            // desktop its windows are drawn on -- which come in as the graphics
            // worker's frames do and are shown by the run's presenter.
            const display = presenter && options.device?.device ? new MessageChannel() : null;
            held.display = display;
            held.shown = display ? connectGraphicsWorker({ worker: portEnd(display.port1),
                device: options.device.device,
                presentTo: frame=>presenter.show({ ...frame, source: request.id }) }) : null;
            // Its sound goes onto the run's table, in a span its parent lends it,
            // where the table is shared memory a worker can be handed; elsewhere
            // the run's sound is mixed on this thread, and the child has none.
            const sound = from.sound();
            held.sound = sound;
            const worker = await openProcessWorker();
            held.worker = worker;
            lending.worker = worker;
            translationPool?.addProcess(request.id, /** @type {PoolProcess} */ ({
                lend: (port, token)=>worker.post({ type: 'translator', port, token }, [port]),
                recall: token=>worker.post({ type: 'recall', token }),
            })).catch(()=>{});
            // The page's input reaches it as the run routes it (`routedInput`).
            const asked = { image: request.imagePath, id: request.id, link,
                diagnostics: ()=>link.call('report', 'diagnostics', []),
                standing: (/** @type {number} */ journal)=>
                    link.call('report', 'standing', [journal]) };
            held.asked = asked;
            standingAcross.add(asked);
            events.emit('process-started', { image: request.imagePath, sequenceBase: logSequence(),
                worker: true });
            return await new Promise((resolve, reject)=>{
                worker.onMessage(data=>{
                    if (data?.type === 'exited')
                    {
                        // The memories it ran in, for the next process the run starts,
                        // and everything else it held given back.
                        if (held.holder === undefined)
                        {
                            (data.memories ?? []).forEach(keepSpare);
                        }
                        else
                        {
                            releaseHolder(held.holder, data.memories ?? []);
                            held.holder = undefined;
                        }
                        ended = data.code;
                        if (data.journal)
                        {
                            events.emit('process-journal', { image: request.imagePath,
                                id: request.id, entries: data.journal });
                        }
                        resolve({ code: data.code, diagnostics: data.diagnostics,
                            systemLibraries: data.systemLibraries });
                    }
                    else if (data?.type === 'failed')
                    {
                        reject(Object.assign(new Error(data.message),
                            { diagnostics: data.diagnostics }));
                    }
                    else if (data?.type === 'module')
                    {
                        translationStore?.hold?.(data.key, data.module, data.bytes);
                    }
                });
                worker.onLost(reason=>reject(new Error(reason)));
                // The graphics layer's knobs, not the run's presenter or a
                // callback: neither crosses, and the child shows nothing itself.
                const knobs = Object.fromEntries(Object.entries(options.graphics ?? {})
                    .filter(([key, value])=>key !== 'presenter' && typeof value !== 'function'));
                // A gone process's memory to run in, where the run keeps one: a
                // shared memory crosses to the worker, and comes back as it ends.
                const shareable = spareMemories.filter((/** @type {SpareMemory} */ spare)=>typeof SharedArrayBuffer
                    === 'function' && spare.memory.buffer instanceof SharedArrayBuffer);
                const handed = shareable.at(-1);
                if (handed)
                {
                    spareMemories.splice(spareMemories.indexOf(handed), 1);
                }
                // Its holder of the machine's memory, claimed here and given back
                // here once the worker is gone, whatever ended it: the memory it
                // was handed is its own from now on.
                if (machineMemory !== null)
                {
                    held.holder = machineMemory.claim();
                }
                worker.post({
                    type: 'start',
                    end: memory.b,
                    memories: handed ? [handed] : [],
                    volume: { revisions: system.volume.revisions ?? null,
                        sharing: system.volume.sharingMemory ?? null },
                    // The run's foreground window, focus and captured window,
                    // read where the run keeps them.
                    windowCells: system.windows?.cells ?? null,
                    graphics: graphics?.port1 ?? null,
                    display: display?.port2 ?? null,
                    options: {
                        ...portableOptions(options),
                        ...held.holder === undefined ? {} : { memoryHolder: held.holder },
                        // The run's machine, whatever this process's own width.
                        machine: runMachine,
                        executable: image,
                        imagePath: request.imagePath,
                        commandLine: request.commandLine,
                        ...request.service ? { service: request.service } : {},
                        startDirectory: request.startDirectory,
                        startup: request.startup ?? null,
                        parentProcessId: request.parentId ?? 0,
                        suspended: request.suspended === true,
                        ...request.parentId ? { startedBeside: true } : {},
                        ...request.environment ? { environment: request.environment } : {},
                        processId: request.id,
                        mainThreadId: request.threadId,
                        // Its open files as values: the position stays here.
                        inheritedFiles: crossingFiles(request.inheritedHandles),
                        // Its pipe ends by number, and which are its standard handles.
                        pipeEnds,
                        standardHandles: request.standardHandles,
                        consoleHandles: request.consoleHandles,
                        // The run tells the player the game is over, once.
                        exitNotice: false,
                        log: { categories: options.log?.categories,
                            capacity: options.log?.capacity, bytes: options.log?.bytes },
                        graphics: knobs,
                        audio: sound ? Object.fromEntries(Object.entries(sound.options)
                            .filter(([, value])=>typeof value !== 'function')) : undefined,
                        // The translator's store is the run's, asked across the
                        // link; the doorbell is this thread's.
                        cork: { config: { ...options.cork?.config, ...lentConfig,
                            store: translationStore ? 'run' : null, doorbell: undefined } },
                    },
                    run: {
                        maxTurns: runOptionsNow()?.maxTurns,
                        timeoutMs: runOptionsNow()?.timeoutMs,
                    },
                }, [...graphics ? [graphics.port1] : [], ...display ? [display.port2] : []]);
            });
        }
        finally
        {
            // Each step whatever the one before did: a step that threw and
            // took the rest with it left the worker standing - its machine and
            // its memory - and the sound span lent, for the rest of the run.
            // The worker goes first.
            await teardown([
                ()=>held.worker?.terminate(),
                // A worker ended without saying so: what it held goes with it.
                ()=>{
                    if (held.holder !== undefined)
                    {
                        machineMemory?.release(held.holder);
                        held.holder = undefined;
                    }
                },
                ()=>{
                    if (listed)
                    {
                        listed.completed = true;
                        listed.exitCode = (ended ?? -1) >>> 0;
                        processEvents.setEvent(listed.exited);
                    }
                },
                ()=>standingAcross.delete(held.asked),
                ()=>{
                    translationPool?.removeProcess(request.id);
                    for (const id of lentBeside)
                    {
                        translationPool?.removeProcess(id);
                    }
                    lentBeside.clear();
                },
                ()=>forgetObjects(),
                ()=>forgetPipes(),
                // Its windows, if it ended without saying so: this thread would
                // block for good asking a gone process about one.
                ()=>{
                    for (const id of windowsAcross)
                    {
                        system.windows?.detach(id);
                    }
                },
                ()=>com.gone(),
                async()=>{
                    link.close();
                    await answering;
                },
                ()=>held.sound?.giveBack(),
                ()=>held.shown?.dispose(),
                ()=>held.display?.port1.close(),
                ()=>options.device?.worker?.postMessage({ type: 'forget', client: request.id }),
                ()=>presenter?.forget?.(request.id),
            ], e=>events.emit('error', { reason: 'teardown', error: e }));
        }
    };
    /**
     * The children running beside their parents, by process id, from the
     * moment each is asked for: how its parent's TerminateProcess reaches it
     * wherever it runs, holding the code until it can take it.
     *
     * @type {Map<number, { terminate: (code: number) => void,
     *     ask: (call: any) => Promise<any> }>}
     */
    const reachable = new Map();

    /**
     * Tells a process in a worker of its own its parent ended it.
     *
     * @param {ReturnType<typeof openLink>} link @param {number} code
     */
    const terminateAcross = (link, code)=>{
        link.call('control', 'terminate', [code]).catch(()=>{
            // Gone already: its exit is on its way to its parent.
        });
    };

    /** The code the last of the run's processes beside another exited with. */
    let lastBesideCode = 0;
    /**
     * Tells the pacing the run shares how many machines take turns on this
     * thread: one of several may not block the thread to wait, which would
     * stop the others with it.
     */
    const noteMachines = ()=>{
        options.pacing?.machines?.(1 + besides.size + serving.size);
    };

    /**
     * Runs a child in a worker of its own, counted among the run's, and tells
     * `exited` its code when it is gone.
     *
     * @param {Parameters<typeof runAcross>[0]} from @param {any} request
     * @param {((code: number, ended: { systemLibraries?: string[] }) => void) | null}
     *     exited  its parent's; null for the run's own program, which resumes
     *     nothing
     * @param {(ended: { code: number, diagnostics?: any, systemLibraries?: string[] })
     *     => void} [over]
     *     told as it ends, whoever it was
     */
    const startAcross = (from, request, exited, over)=>{
        across.value++;
        /** @type {{ link: ReturnType<typeof openLink> | null, code: number | null,
         *     opened?: () => void }} */
        const reach = { link: null, code: null };
        const opened = settled();
        reachable.set(request.id, {
            terminate: code=>{
                reach.code = code;
                if (reach.link)
                {
                    terminateAcross(reach.link, code);
                }
            },
            // Asked across its link once there is one; null for a child that
            // went before it had one.
            ask: call=>opened.promise.then(()=>(reach.link
                ? reach.link.call('control', 'ask', [call]) : null)),
        });
        reach.opened = opened.settle;
        const running = (async()=>{
            /** @type {{ code: number, diagnostics?: any, systemLibraries?: string[] }} */
            let ended;
            try
            {
                ended = await runAcross(from, request, reach);
            }
            catch (e){
                const whole = /** @type {any} */ (e)?.diagnostics;
                if (whole !== undefined)
                {
                    // Its layers' numbers in the event; the whole goes on below.
                    /** @type {any} */ (e).diagnostics = diagnosticsSummary(whole);
                }
                events.emit('error', { reason: 'process', error: e });
                ended = { code: -1, diagnostics: whole };
            }
            finally
            {
                across.value--;
                reachable.delete(request.id);
                opened.settle();
            }
            const { code, diagnostics } = ended;
            // A server COM started - a service among them, ended with the run -
            // is nobody's game: an installer gone while the ngen service it
            // woke winds down ended with the installer's code, not the service's.
            if (!from.server)
            {
                lastBesideCode = code;
            }
            over?.(ended);
            if (exited)
            {
                exited(code, ended);
                events.emit('process-resumed', { image: request.imagePath, code,
                    diagnostics: diagnosticsSummary(diagnostics) });
            }
            return code;
        })();
        besides.add(running);
        noteMachines();
        running.finally(()=>{
            besides.delete(running);
            noteMachines();
        });
    };

    /**
     * A class's server a process in a worker of its own asked COM for,
     * started in a worker of its own while the run has room for one, with
     * `-Embedding` as COM starts one; null when there is no room, and the
     * process starts it beside itself.
     *
     * @param {{ command: string, clsid: string, service?: string }} request
     * @returns {{ exited: Promise<number> } | null}
     */
    const serverAcross = request=>{
        if (!inWorker())
        {
            return null;
        }
        const exited = (async()=>{
            const found = await serverImage(current(), request.command);
            if (!found)
            {
                events.emit('divergence', { api: 'COM',
                    detail: `the server ${request.command} of ${request.clsid}`
                        + ' is not on the volume' });
                return -1;
            }
            const { processId, mainThreadId } = newProcessIds();
            events.emit('process-server', { image: found.path, clsid: request.clsid });
            if (request.service)
            {
                servicesAcross.set(processId, request.service);
            }
            return new Promise(resolve=>{
                startAcross({ readImage: path=>current().readImage(path),
                    sound: ()=>lendSound(current()), server: true },
                { imagePath: found.path, commandLine: request.service ? request.command.trim()
                    : `${request.command.trim()} -Embedding`,
                ...request.service ? { service: request.service } : {},
                id: processId, threadId: mainThreadId }, null, ended=>{
                    servicesAcross.delete(processId);
                    events.emit('process-server-exit', { image: found.path, code: ended.code });
                    resolve(ended.code);
                });
            });
        })();
        return { exited };
    };

    /**
     * A child a process in a worker of its own asked for, started in a worker
     * of its own while the run has room for one; its parent is asked across
     * its link for the position of the files it handed on, and told when it
     * is gone. False when there is no room: the parent runs it
     * beside itself, in its own worker.
     *
     * @param {ReturnType<typeof openLink>} link  the parent's
     * @param {any} asked  the child, as values
     * @returns {boolean}
     */
    const startAcrossFor = (link, asked)=>{
        if (!inWorker())
        {
            return false;
        }
        // Its open files, as its parent's worker handed them: their position
        // asked of that worker, where the parent's opens keep it. Its pipe
        // ends are objects of that worker's and do not cross, nor do the
        // standard handles that name them.
        const files = handedFiles(asked.inheritedFiles,
            handle=>link.callWaiting('parent', 'position', [asked.id, handle]),
            (handle, at)=>link.callWaiting('parent', 'setPosition', [asked.id, handle, at]));
        const crossed = new Set(files.map(one=>one.handle));
        /** @param {Record<string, number> | undefined} named */
        const crossedOf = named=>named && Object.fromEntries(Object.entries(named)
            .filter(([, handle])=>crossed.has(handle)));
        const request = { ...asked, inheritedHandles: files, inheritedFiles: undefined,
            standardHandles: crossedOf(asked.standardHandles),
            consoleHandles: crossedOf(asked.consoleHandles) };
        startAcross({
            // Read from the run's volume, where the parent found it: a launcher
            // that starts its game and exits is gone before the game's image
            // would come back from it.
            readImage: path=>current().readImage(path),
            // Lent by the parent, and taken back there when it hears the
            // child is gone.
            sound: ()=>(asked.arena ? { options: { ...options.audio, memory: audioMemory(),
                beside: { arena: asked.arena } }, giveBack(){} } : null),
        }, request, code=>{
            link.call('parent', 'exited', [asked.id, code]).catch(()=>{
                // The parent went first: nothing of it waits on the code.
            });
        });
        return true;
    };

    /**
     * The children this process, joined to the run from a worker of its own,
     * had the run start in workers of their own: by process id, each with
     * the machine that asked and the sound it lent.
     *
     * @type {Map<number, { parent: any, request: any,
     *     sound: { giveBack: () => void } | null }>}
     */
    const childrenAcross = new Map();
    options.system?.processes?.answer({
        /** @param {number} id @param {number} handle */
        position: (id, handle)=>inheritedOpen(childrenAcross.get(id)?.request.inheritedHandles,
            handle)?.position ?? 0,
        /** @param {number} id @param {number} handle @param {number} at */
        setPosition: (id, handle, at)=>{
            const open = inheritedOpen(childrenAcross.get(id)?.request.inheritedHandles, handle);
            if (open)
            {
                open.position = at;
            }
        },
        /** @param {number} id @param {number} code */
        exited: (id, code)=>{
            const child = childrenAcross.get(id);
            if (!child)
            {
                return;
            }
            childrenAcross.delete(id);
            child.sound?.giveBack();
            child.parent.childExited(child.request, code);
        },
    });

    /**
     * Starts a child at once, beside the parent that asked for it, and runs
     * it alongside every other process until it exits: concurrency's
     * CreateProcess, as on Windows. The parent goes on running; a thread of
     * its waiting on the child, polling its exit code, or waiting on an
     * object the child sets, is answered as the child goes. The page sees
     * and drives the child while it stands, as it does one run in its
     * parent's place.
     *
     * @param {any} parent @param {any} request
     */
    const startBeside = (parent, request)=>{
        const shared = audioMemory() && 'table' in audioMemory()
            && typeof SharedArrayBuffer === 'function'
            && audioMemory().table instanceof SharedArrayBuffer;
        if (inWorker())
        {
            startAcross({
                readImage: path=>parent.readImage(path),
                sound: ()=>(shared ? lendSound(parent) : null),
            }, request, code=>parent.childExited(request, code));
            return;
        }
        // A process that joined the run's system from a worker of its own has
        // the run start its child, which counts the workers; the sound it
        // plays into is this process's to lend, and to take back when the
        // run says the child has gone.
        const processesAcross = options.system?.processes;
        // A child it debugs stays beside it, where its events reach it.
        if (processesAcross && !request.debugged)
        {
            const sound = shared ? lendSound(parent) : null;
            // Known before it is asked for: the run may ask for the position of
            // a file it was handed before the call that starts it returns.
            childrenAcross.set(request.id, { parent, request, sound });
            const placed = processesAcross.start({
                imagePath: request.imagePath,
                commandLine: request.commandLine,
                startDirectory: request.startDirectory,
                startup: request.startup ?? null,
                parentId: request.parentId ?? 0,
                suspended: request.suspended === true,
                ...request.environment ? { environment: request.environment } : {},
                id: request.id,
                threadId: request.threadId,
                // Its open files as values, the position kept here, and which
                // of its handles are its standard ones.
                inheritedFiles: crossingFiles(request.inheritedHandles),
                standardHandles: request.standardHandles,
                consoleHandles: request.consoleHandles,
                arena: sound?.options.beside.arena ?? null,
            });
            if (placed)
            {
                return;
            }
            childrenAcross.delete(request.id);
            sound?.giveBack();
        }
        events.emit('process-child', { image: request.imagePath,
            commandLine: request.commandLine });
        // Running from the moment it is asked for, not from when its machine
        // is built: a parent that waits on it at once is waiting on something
        // that will answer, not stuck.
        starting.value++;
        /** @type {{ line: { current: any } | null, code: number | null }} */
        const reach = { line: null, code: null };
        const built = settled();
        reachable.set(request.id, {
            terminate: code=>{
                if (reach.line)
                {
                    reach.line.current.terminate(code);
                }
                else
                {
                    reach.code = code;
                }
            },
            // Answered on a later microtask, once its machine is built: never
            // inside the parent's host call, and never inside a turn of its
            // own, which runs to its end before a microtask does. Null for a
            // child that did not start.
            ask: call=>built.promise.then(()=>(reach.line
                ? Promise.resolve().then(()=>reach.line?.current.answerCall(call)) : null)),
        });
        const running = (async()=>{
            /** @type {any} */
            let child = null;
            /** The code a child that never started ends with. */
            let failed = 2;
            // Where the run's output has nothing to lend -- the engine's own
            // mixer, in `compatible` mode -- a table of the child's own would
            // reach no speaker: it mixes onto its parent's output instead.
            const sound = !shared && parent.audio?.borrow ? borrowSound(parent) : ownSound();
            try
            {
                const image = request.image ?? await parent.readImage(request.imagePath);
                if (!image)
                {
                    events.emit('divergence', { api: 'process',
                        detail: `${request.imagePath} is not on the volume, and did not start` });
                }
                else
                {
                    noteLogSequence();
                    mediaInstance.value = parent.media.instance() ?? mediaInstance.value;
                    child = await build({
                        executable: image,
                        imagePath: request.imagePath,
                        commandLine: request.commandLine,
                        processId: request.id,
                        mainThreadId: request.threadId,
                        // Objects, which only a child on this thread can hold.
                        inheritedHandles: request.inheritedHandles,
                        standardHandles: request.standardHandles,
                        consoleHandles: request.consoleHandles,
                        startDirectory: request.startDirectory,
                        startup: request.startup ?? null,
                        parentProcessId: request.parentId ?? 0,
                        suspended: request.suspended === true,
                        startedBeside: true,
                        ...request.environment ? { environment: request.environment } : {},
                        // Its parent's ear: heard while its parent debugs it, from
                        // its start or since it attached (`debug-events.js`).
                        debugger: { report: (/** @type {any} */ report)=>
                            parent.debugEvent(request, report),
                        debugged: ()=>Boolean(request.debugged),
                        object: ()=>request.debugged?.object ?? null,
                        noInherit: ()=>Boolean(request.noDebugInherit) },
                        audio: sound.options,
                    });
                    sound.announce(child);
                }
            }
            catch (e){
                // A machine with no room for it: the child fails as a process
                // Windows had no memory for does, which its parent hears.
                if (/** @type {any} */ (e)?.code === 'MACHINE_MEMORY')
                {
                    failed = STATUS_NO_MEMORY;
                    events.emit('divergence', { api: 'process',
                        detail: `${request.imagePath}: ${/** @type {Error} */ (e).message}` });
                }
                else
                {
                    events.emit('error', { reason: 'process', error: e });
                }
            }
            finally
            {
                starting.value--;
            }
            if (!child)
            {
                reachable.delete(request.id);
                built.settle();
                sound.giveBack();
                parent.childExited(request, failed);
                events.emit('process-resumed', { image: request.imagePath, code: failed });
                return failed;
            }
            replayLogLevels();
            stand(child);
            bindLogLevels();
            events.emit('process-started', { image: request.imagePath,
                sequenceBase: logSequence() });
            const line = { current: child, main: false };
            reach.line = line;
            built.settle();
            if (reach.code !== null)
            {
                child.terminate(reach.code);
            }
            const listed = { id: request.id, image: request.imagePath, beside: /** @type {true} */ (true),
                diagnostics: ()=>line.current.diagnostics(),
                read: (/** @type {number} */ address, /** @type {number} */ length)=>
                    line.current.debug.read(address, length),
                hook: (/** @type {number} */ address, /** @type {any} */ how)=>
                    line.current.debug.hook(address, how) };
            standingBeside.add(listed);
            let code = -1;
            try
            {
                code = await runProcesses(runOptionsNow(), line, true);
            }
            catch (e){
                // A run the page ended under it is no failure of the child.
                if (/** @type {any} */ (e)?.reason !== 'disposed')
                {
                    events.emit('error', { reason: 'process', error: e });
                }
            }
            finally
            {
                reachable.delete(request.id);
                standingBeside.delete(listed);
            }
            // Its parent is told however the teardown goes.
            try
            {
                const ended = line.current;
                await retire(ended);
                noteLogSequence();
                mediaInstance.value = ended.media.instance() ?? mediaInstance.value;
                await ended.dispose();
                keepMemory(ended);
                sound.giveBack();
                // The page sees whoever stands in the main line again.
                replayLogLevels();
                stand(mainLine.current);
                bindLogLevels();
                presenter?.forget?.(request.id);
            }
            catch (e){
                events.emit('error', { reason: 'process', error: e });
            }
            finally
            {
                parent.childExited(request, code);
            }
            lastBesideCode = code;
            events.emit('process-resumed', { image: request.imagePath, code });
            return code;
        })();
        besides.add(running);
        noteMachines();
        running.finally(()=>{
            besides.delete(running);
            noteMachines();
        });
    };

    /**
     * A parent's call in a child it started (`cross-process.js`), made where
     * the child runs -- on this thread, in a worker of its own, or through
     * the run for a process that joined it from a worker -- and answered
     * there; null for a child the run does not have.
     *
     * @param {{ id: number }} request @param {any} call
     * @returns {Promise<any> | null}
     */
    function askBeside(request, call){
        const child = reachable.get(request.id);
        if (child)
        {
            return child.ask(call);
        }
        if (childrenAcross.has(request.id))
        {
            return options.system?.processes?.ask?.(request.id, call) ?? null;
        }
        return null;
    }

    /**
     * A parent's TerminateProcess on a child running beside it: ended where
     * it runs -- on this thread, in a worker of its own, or through the run
     * for a process that joined it from a worker -- and its parent told as
     * any child's exit is told. False for a child the run does not have.
     *
     * @param {{ id: number }} request @param {number} code
     * @returns {boolean}
     */
    function terminateBeside(request, code){
        const child = reachable.get(request.id);
        if (child)
        {
            child.terminate(code >>> 0);
            return true;
        }
        if (childrenAcross.has(request.id))
        {
            return options.system?.processes?.terminate?.(request.id, code) === true;
        }
        return false;
    }

    /**
     * Runs the live process, and each child that takes its place or runs
     * beside it, until one exits with nothing left to run.
     *
     * @param {any} runOptions
     * @param {{ current: any, main: boolean }} [line]  The line of processes:
     *        the page's, or a server's.
     * @param {boolean} [nested]  Run for a parent waiting on it.
     * @returns {Promise<number>} the last program's exit code
     */
    const runProcesses = async(runOptions, line = mainLine, nested = false)=>{
        const code = await line.current.run(runOptions);
        // Run out: nothing it holds wakes another process now.
        standing.delete(line.current);
        if (line.main && !nested)
        {
            // Its servers end with it: its references go back, and what they
            // write before they stop is its to keep.
            const ending = line.current;
            await classTable.ended(names.get(ending));
            endServices();
            while (servers.size > 0)
            {
                await Promise.allSettled([...servers]);
            }
            // A launcher that started its game and went is not the end of the
            // run: the game is, and its code is the run's.
            if (besides.size > 0)
            {
                while (besides.size > 0)
                {
                    await Promise.allSettled([...besides]);
                }
                noticeExit(lastBesideCode);
                return lastBesideCode;
            }
            noticeExit(code);
        }
        return code;
    };

    /**
     * Runs the run's program in a worker of its own, and every process it
     * starts, until the last of them is gone; the code is the last one's, as
     * a launcher that started its game and went leaves the game's.
     */
    const runRoot = async()=>{
        rootLibraries.value = [];
        startAcross({
            readImage: async()=>options.executable,
            // Half the output's arena: the rest is for what it starts.
            sound: ()=>lendSound(current(), 8 << 20),
        }, {
            imagePath: imagePath(),
            commandLine: options.commandLine,
            // The id it has in its worker, where none was handed in, as a
            // process built here has: its windows and its frames are told
            // apart by it.
            id: options.processId ?? FIRST_PROCESS_ID,
        }, null, ended=>{
            rootLibraries.value = ended.systemLibraries ?? [];
            current().ended(ended.diagnostics);
            endServices();
        });
        while (besides.size > 0)
        {
            await Promise.allSettled([...besides]);
        }
        noticeExit(lastBesideCode);
        return lastBesideCode;
    };

    return {
        askBeside, noteMachines, reachable, runProcesses, runRoot, stand, startBeside,
        terminateBeside,

    };
}


/**
 * A promise and the means to settle it, for what waits on something that is
 * made later -- a child's machine, its link.
 *
 * @returns {{ promise: Promise<void>, settle: () => void }}
 */
export function settled(){
    /** @type {() => void} */
    let settle = ()=>{};
    const promise = new Promise(resolve=>{
        settle = ()=>resolve(undefined);
    });
    return { promise, settle };
}

/** What a process Windows found no memory for ends with (STATUS_NO_MEMORY). */
export const STATUS_NO_MEMORY = 0xc0000017;

/**
 * What of a run's options never goes to a process in a worker of its own:
 * the system's -- its drives, session, bundle, devices and bus -- which the
 * process reaches across its link, and what a process is handed of its own.
 */
export const SYSTEM_OPTIONS = new Set(['system', 'relay', 'pacing', 'device', 'bundle', 'storage',
    'discs', 'files', 'seed', 'events', 'spawned', 'logSinks', 'win32', 'watchImport', 'hooks',
    'executable', 'inheritedFiles', 'startup', 'fallback', 'graphics', 'audio', 'cork', 'log',
    'com', 'memoryCredit', 'memoryHolder']);

/**
 * A value as it crosses to another thread's start: data -- numbers, strings,
 * bytes, arrays and plain objects of those -- and nothing that is a function
 * or an object of a class, which a structured clone refuses or empties.
 *
 * @param {any} value @param {number} [depth]
 * @returns {any}
 */
export function portable(value, depth = 0){
    if (value === null || typeof value !== 'object')
    {
        return typeof value === 'function' || typeof value === 'symbol' ? undefined : value;
    }
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer
        || (typeof SharedArrayBuffer === 'function' && value instanceof SharedArrayBuffer))
    {
        return value;
    }
    if (depth > 8)
    {
        return undefined;
    }
    if (Array.isArray(value))
    {
        return value.map(item=>portable(item, depth + 1) ?? null);
    }
    if (Object.getPrototypeOf(value) !== Object.prototype)
    {
        return undefined;
    }
    return Object.fromEntries(Object.entries(value).map(([key, item])=>
        [key, portable(item, depth + 1)]).filter(([, item])=>item !== undefined));
}

/**
 * The run's options a process in a worker of its own starts with: the
 * engine, the mode, the Windows, the display, the knobs, the decoders'
 * binaries.
 *
 * @param {import('../app-options.js').AppOptions} options
 */
export function portableOptions(options){
    return portable(Object.fromEntries(Object.entries(options)
        .filter(([key])=>!SYSTEM_OPTIONS.has(key))));
}
