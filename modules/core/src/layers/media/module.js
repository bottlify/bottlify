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

/** @type {any} */
let decoderInstance = null;
/**
 * This machine's own view of the instance, which closes only the clips this
 * machine opened and leaves the instance itself alive.
 *
 * @type {any}
 */
let decoder = null;
/** @type {BufferSource | null} */
let binary = null;
/** @type {Promise<any> | null} */
let loading = null;
/** @type {string[]} */
let issues = [];
/** @type {ReturnType<typeof createIjlLibrary> | null} */
let ijl = null;

export const mediaModule = {
    name: 'media',
    version: '0.1.0',
    requires: /** @type {readonly string[]} */ (['log']),

    /**
     * @param {any} config
     * @returns {Promise<any>}
     */
    async create(config){
        decoderInstance = null;
        decoder = null;
        loading = null;
        issues = [];
        binary = config?.wasmBytes ?? null;
        // A decoder another machine in this run already made. Given, this
        // machine's clips are opened over its memory and codecs instead of a
        // second instantiation of the same binary.
        const given = config?.instance ?? null;
        // The JPEG library a program ships beside itself, hosted: it reaches
        // guest memory through the thunks the assembling caller hands down,
        // the same way the sound layer's hosted provider does.
        ijl = config?.readMemory && config?.writeMemory && config?.allocate
            ? createIjlLibrary({
                readMemory: config.readMemory, writeMemory: config.writeMemory,
                allocate: config.allocate, warn: config.warn,
            })
            : null;
        if (!binary && !given)
        {
            issues.push('No decoder binary was configured: nothing can be played.');
        }

        /**
         * Takes an instance under this machine's name: shared, readied, wrapped.
         *
         * @param {any} built
         */
        const adopt = built=>{
            decoderInstance = built;
            decoder = decoderSession(built);
            if (!built.audioCapable())
            {
                issues.push('The decoder binary has no packet-fed audio path: '
                    + 'sound streams fall back to the platform decoder.');
            }
            return decoder;
        };
        if (given)
        {
            adopt(given);
        }

        /** Built on first use, once, however many callers ask at once. */
        const load = ()=>{
            if (given)
            {
                return Promise.resolve(decoder);
            }
            if (!binary)
            {
                throw new Error('media: this build has no decoder binary');
            }
            loading ??= createDecoder(binary).then(adopt, e=>{
                issues.push(`The decoder binary could not be instantiated: ${
                    e instanceof Error ? e.message : String(e)}`);
                throw e;
            });
            return loading;
        };

        return {
            /** Whether this build can decode at all. */
            available: ()=>binary !== null || given !== null,

            /**
             * Instantiates the decoder without opening anything, so that a
             * caller can pay that cost when it suits rather than on the frame
             * a cinematic starts.
             */
            prepare: ()=>load().then(()=>undefined),

            /**
             * Opens a clip from the whole file in memory.
             *
             * @param {Uint8Array} bytes
             * @returns {Promise<any>}
             */
            open: async bytes=>(await load()).open(bytes),

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
                if (decoder)
                {
                    return decoder.openAudio(shape);
                }
                if (!binary && !given)
                {
                    return null;
                }
                load().catch(()=>undefined);
                return null;
            },

            closeAll(){
                decoder?.closeAll();
            },

            /**
             * The decoder this machine uses, shared with the run: the next
             * machine attaches to the same instance rather than compiling the
             * binary again, and the counters of everything decoded through it
             * keep counting.
             */
            instance: ()=>decoderInstance,

            /** The libraries this layer stands in for, keyed as an import names them. */
            libraries: ()=>({ ...(ijl?.libraries ?? {}) }),
            /** Their exports by ordinal, for a program that imports by number. */
            ordinals: ()=>({ ...(ijl?.ordinals ?? {}) }),
        };
    },

    /** @returns {import('../../system/contract.js').ModuleDiagnostics} */
    diagnostics(){
        return {
            name: 'media',
            version: '0.1.0',
            status: decoder ? 'ready' : 'created',
            metrics: {
                // Separately from whether anything was decoded: a build with a
                // binary that nothing ever asked to use looks the same as one
                // with no binary at all until this is read.
                configured: binary !== null || decoderInstance !== null,
                ...(decoder ? decoder.diagnostics() : {}),
                // Which libraries a program can reach this layer through,
                // reported the way every other exporting layer reports its
                // own: a tally of what the loader synthesised is taken across
                // all of them, and a library missing here is an image nobody
                // accounts for.
                libraries: ijl ? Object.keys(ijl.libraries) : [],
                jpeg: ijl ? ijl.diagnostics() : null,
            },
            issues: [...issues],
        };
    },

    async dispose(){
        // Only this machine's clips close. The instance itself is not this
        // machine's to end: the process that replaces it -- or the next game in
        // the session -- attaches to the same compiled module and memory.
        decoder?.closeAll();
        decoder = null;
        decoderInstance = null;
        loading = null;
        binary = null;
        issues = [];
        ijl = null;
    },
};
