/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
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
 * @param {() => number} [options.now]
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
    let reused = 0;
    /** Milliseconds from a module's creation until the compiler answered, summed. */
    let buildMs = 0;
    const now = options.now ?? (()=>performance.now());
    /** @type {Map<string, Map<string, Promise<any>>>} each shader's module, by label and code */
    const built = new Map();

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
        build(request){
            const label = request.label === undefined ? 'shader' : request.label;
            // One module for one shader's code, however many pipelines take it:
            // a draw state is a pipeline, and one shader is in many of them.
            const byCode = built.get(label) ?? new Map();
            built.set(label, byCode);
            let made = byCode.get(request.code);
            if (!made)
            {
                made = compile(label, request.code);
                byCode.set(request.code, made);
            }
            else
            {
                reused++;
            }
            return made;
        },

        /** @returns {any[]} oldest distinct message first. */
        messages(){
            return [...ring.values()];
        },

        stats(){
            return { builds, reused, buildMs: Math.round(buildMs), errors, warnings, dropped,
                distinct: ring.size };
        },
    };

    /**
     * @param {string} label @param {string} code
     * @returns {Promise<any>}
     */
    async function compile(label, code){
        const request = { label, code };
        const began = now();
        const module = options.device.createShaderModule({ label, code: request.code });
        builds++;
        const info = await module.getCompilationInfo();
        buildMs += now() - began;
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
                // The line it names, so that a report says what was refused.
                const line = request.code.split('\n')[message.lineNum - 1]?.trim() ?? '';
                fatal.push(`${message.lineNum}:${message.linePos} ${message.message}`
                    + (line ? ` in \`${line.slice(0, 160)}\`` : ''));
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
    }
}
