/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { createDecoder, decoderSession } from './internal/decoder.js';
import { createIjlLibrary } from './internal/ijl.js';

/**
 * media -- the video and audio inside a cinematic, decoded.
 *
 * A thin module over one wasm binary. Everything interesting is in
 * internal/decoder.js and in the C behind it; this file only decides when the
 * binary is instantiated and what a build without one does.
 *
 * Nothing is instantiated until someone opens a clip. Assembling the module
 * graph has to stay cheap, and a program that never plays a video should not
 * pay several megabytes of compilation for the possibility.
 *
 * The instance is a service of the run rather than of the machine: a decoder
 * built by another machine -- the process this one replaced -- is handed in as
 * `config.instance` and used without instantiating, and `dispose` closes only
 * the clips this machine opened, leaving the instance for the next one.
 */

/**
 * The most recently created instance, for `diagnostics()` alone.
 *
 * The module contract puts `diagnostics()` on the module rather than on the
 * api, so something outside a `create()` call has to be able to see in. That
 * is the only reason this exists, and it holds a reference rather than the
 * state itself -- the binary, the decoder view and the given instance belong
 * to the closure `create()` returns, so a second instance in one realm cannot
 * take the first one's clips. Disposing marks the instance closed, so a call
 * still in flight when the machine went away gets the refusal a build with no
 * decoder binary gets instead of dereferencing what is gone.
 *
 * @type {any}
 */
let current = null;

export const mediaModule = {
    name: 'media',
    version: '0.1.0',
    requires: /** @type {readonly string[]} */ (['log']),

    /**
     * @param {any} config
     * @returns {Promise<any>}
     */
    async create(config){
        /**
         * Everything this instance owns, and whether it is still open.
         *
         * The calls an api hands out close over this object rather than over
         * module-level bindings, because `create()` may run more than once in
         * one realm -- a process replacement does, and the plan for more than
         * one machine in a worker needs two at once -- so each run keeps its
         * own decoder view.
         *
         * @type {{ decoderInstance: any, decoder: any, binary: BufferSource | null,
         *     loading: Promise<any> | null, issues: string[],
         *     ijl: ReturnType<typeof createIjlLibrary> | null, disposed: boolean }}
         */
        const state = {
            decoderInstance: null,
            decoder: null,
            binary: config?.wasmBytes ?? null,
            loading: null,
            issues: [],
            ijl: null,
            disposed: false,
        };
        // A decoder another machine in this run already made. Given, this
        // machine's clips are opened over its memory and codecs instead of a
        // second instantiation of the same binary.
        const given = config?.instance ?? null;
        // The JPEG library a program ships beside itself, hosted: it reaches
        // guest memory through the thunks the assembling caller hands down,
        // the same way the sound layer's hosted provider does.
        state.ijl = config?.readMemory && config?.writeMemory && config?.allocate
            ? createIjlLibrary({
                readMemory: config.readMemory, writeMemory: config.writeMemory,
                allocate: config.allocate, warn: config.warn,
            })
            : null;
        if (!state.binary && !given)
        {
            state.issues.push('No decoder binary was configured: nothing can be played.');
        }

        /**
         * Takes an instance under this machine's name: shared, readied, wrapped.
         *
         * @param {any} built
         */
        const adopt = built=>{
            state.decoderInstance = built;
            state.decoder = decoderSession(built);
            if (!built.audioCapable())
            {
                state.issues.push('The decoder binary has no packet-fed audio path: '
                    + 'sound streams fall back to the platform decoder.');
            }
            return state.decoder;
        };
        if (given)
        {
            adopt(given);
        }

        /** Built on first use, once, however many callers ask at once. */
        const load = ()=>{
            if (given)
            {
                return Promise.resolve(state.decoder);
            }
            if (!state.binary)
            {
                throw new Error('media: this build has no decoder binary');
            }
            state.loading ??= createDecoder(state.binary).then(adopt, e=>{
                state.issues.push(`The decoder binary could not be instantiated: ${
                    e instanceof Error ? e.message : String(e)}`);
                throw e;
            });
            return state.loading;
        };

        /**
         * Whether this instance is still open. A call that was in flight when
         * the machine was disposed must not find the decoder gone: a disposed
         * media can decode nothing, so it refuses the way a build with no
         * decoder binary does rather than dereferencing what disposal took
         * away.
         */
        const live = ()=>!state.disposed;

        current = state;
        return {
            /** Whether this build can decode at all. */
            available: ()=>live() && (state.binary !== null || given !== null),

            /**
             * Instantiates the decoder without opening anything, so that a
             * caller can pay that cost when it suits rather than on the frame
             * a cinematic starts.
             */
            prepare: ()=>live()
                ? load().then(()=>undefined)
                : Promise.reject(new Error('media: this build has no decoder binary')),

            /**
             * Opens a clip from the whole file in memory.
             *
             * @param {Uint8Array} bytes
             * @returns {Promise<any>}
             */
            open: async bytes=>{
                if (!live())
                {
                    throw new Error('media: this build has no decoder binary');
                }
                return (await load()).open(bytes);
            },

            /**
             * An elementary audio stream decoded a packet at a time, in the
             * call -- or null, when this build cannot: no binary, one built
             * without the path, or one not instantiated yet. Synchronous,
             * because the caller is answering a call that cannot wait; asking
             * before the decoder is up starts it, so the next stream finds it.
             *
             * @param {import('./internal/decoder.js').AudioStreamShape} shape
             * @returns {import('./internal/decoder.js').AudioStream | null}
             */
            openAudio(shape){
                if (!live())
                {
                    return null;
                }
                if (state.decoder)
                {
                    return state.decoder.openAudio(shape);
                }
                if (!state.binary && !given)
                {
                    return null;
                }
                load().catch(()=>undefined);
                return null;
            },

            closeAll(){
                if (live())
                {
                    state.decoder?.closeAll();
                }
            },

            /**
             * The decoder this machine uses, shared with the run: the next
             * machine attaches to the same instance rather than compiling the
             * binary again, and the counters of everything decoded through it
             * keep counting.
             */
            instance: ()=>live() ? state.decoderInstance : null,

            /** The libraries this layer stands in for, keyed as an import names them. */
            libraries: ()=>live() ? { ...(state.ijl?.libraries ?? {}) } : {},
            /**
             * Which of them are redistributable runtimes answered for whoever's
             * copy the program brought: all of them -- a decoder library a game
             * ships is the runtime this layer stands in for.
             */
            runtimes: ()=>live() ? Object.keys(state.ijl?.libraries ?? {}) : [],
            /** Their exports by ordinal, for a program that imports by number. */
            ordinals: ()=>live() ? { ...(state.ijl?.ordinals ?? {}) } : {},
        };
    },

    /** @returns {import('../../system/contract.js').ModuleDiagnostics} */
    diagnostics(){
        const instance = current;
        if (!instance || instance.disposed)
        {
            return {
                name: 'media',
                version: '0.1.0',
                status: 'created',
                metrics: { configured: false, libraries: [], jpeg: null },
                issues: [],
            };
        }
        return {
            name: 'media',
            version: '0.1.0',
            status: instance.decoder ? 'ready' : 'created',
            metrics: {
                // Separately from whether anything was decoded: a build with a
                // binary that nothing ever asked to use looks the same as one
                // with no binary at all until this is read.
                configured: instance.binary !== null || instance.decoderInstance !== null,
                ...(instance.decoder ? instance.decoder.diagnostics() : {}),
                // Which libraries a program can reach this layer through,
                // reported the way every other exporting layer reports its
                // own: a tally of what the loader synthesised is taken across
                // all of them, and a library missing here is an image nobody
                // accounts for.
                libraries: instance.ijl ? Object.keys(instance.ijl.libraries) : [],
                jpeg: instance.ijl ? instance.ijl.diagnostics() : null,
            },
            issues: [...instance.issues],
        };
    },

    async dispose(){
        // Only this machine's clips close. The instance itself is not this
        // machine's to end: the process that replaces it -- or the next game in
        // the session -- attaches to the same compiled module and memory.
        if (current)
        {
            current.decoder?.closeAll();
            current.disposed = true;
        }
        current = null;
    },
};
