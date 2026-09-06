/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

/**
 * Shader modules, and asking the compiler what it thought of them.
 *
 * `getCompilationInfo()` never throws and is never consulted by accident, so a
 * module that was rejected -- or quietly degraded -- is invisible until the
 * frame comes out wrong. It is called after every build here, and what it said
 * is kept in a de-duplicating ring: the same warning from a shader rebuilt
 * hundreds of times is one row with a count, not hundreds of rows.
 *
 * An error-severity message fails the build. A module the compiler rejected
 * still exists as an object and still binds, and drawing with it produces a
 * wrong picture rather than a complaint -- far more expensive to chase than a
 * rejected promise at the point of the mistake.
 */

/**
 * @param {Object} options
 * @param {import('../contract.js').GpuDeviceLike} options.device
 * @param {number} [options.ringSize]
 * @returns {any}
 */
export function createShaderCache(options){
    const ringSize = options.ringSize === undefined ? 64 : options.ringSize;
    /** @type {Map<string, any>} */
    const ring = new Map();
    let dropped = 0;
    let errors = 0;
    let warnings = 0;
    let builds = 0;

    /** @param {any} message */
    const record = message=>{
        const key = `${message.label}|${message.type}|${message.lineNum}`
            + `|${message.linePos}|${message.message}`;
        const seen = ring.get(key);
        if (seen)
        {
            seen.count++;
            return;
        }
        if (ring.size >= ringSize)
        {
            const oldest = ring.keys().next().value;
            ring.delete(/** @type {string} */ (oldest));
            dropped++;
        }
        ring.set(key, { ...message, count: 1 });
    };

    return {
        /**
         * @param {{ code: string, label?: string }} request
         * @returns {Promise<any>}
         */
        async build(request){
            const label = request.label === undefined ? 'shader' : request.label;
            const module = options.device.createShaderModule({ label, code: request.code });
            builds++;
            const info = await module.getCompilationInfo();
            const messages = (info && info.messages) || [];
            /** @type {string[]} */
            const fatal = [];
            for (const message of messages)
            {
                record({
                    label,
                    type: message.type,
                    message: message.message,
                    lineNum: message.lineNum,
                    linePos: message.linePos,
                });
                if (message.type === 'error')
                {
                    errors++;
                    fatal.push(`${message.lineNum}:${message.linePos} ${message.message}`);
                }
                else if (message.type === 'warning')
                {
                    warnings++;
                }
            }
            if (fatal.length > 0)
            {
                throw new Error(`Shader "${label}" was rejected: ${fatal.join('; ')}`);
            }
            return module;
        },

        /** @returns {any[]} oldest distinct message first. */
        messages(){
            return [...ring.values()];
        },

        stats(){
            return { builds, errors, warnings, dropped, distinct: ring.size };
        },
    };
}
