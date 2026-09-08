/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { createDecoder } from './internal/decoder.js';

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
 */

/** @type {any} */
let decoder = null;
/** @type {BufferSource | null} */
let binary = null;
/** @type {Promise<any> | null} */
let loading = null;
/** @type {string[]} */
let issues = [];

export const mediaModule = {
    name: 'media',
    version: '0.1.0',
    requires: /** @type {readonly string[]} */ (['log']),

    /**
     * @param {any} config
     * @returns {Promise<any>}
     */
    async create(config){
        decoder = null;
        loading = null;
        issues = [];
        binary = config?.wasmBytes ?? null;
        if (!binary)
        {
            issues.push('No decoder binary was configured: nothing can be played.');
        }

        /** Built on first use, once, however many callers ask at once. */
        const load = ()=>{
            if (!binary)
            {
                throw new Error('media: this build has no decoder binary');
            }
            loading ??= createDecoder(binary).then(built=>{
                decoder = built;
                return built;
            });
            return loading;
        };

        return {
            /** Whether this build can decode at all. */
            available: ()=>binary !== null,

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

            closeAll(){
                decoder?.closeAll();
            },
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
                configured: binary !== null,
                ...(decoder ? decoder.diagnostics() : {}),
            },
            issues: [...issues],
        };
    },

    async dispose(){
        decoder?.closeAll();
        decoder = null;
        loading = null;
        binary = null;
        issues = [];
    },
};
