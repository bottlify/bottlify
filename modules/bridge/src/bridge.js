/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The bridge's answers to a page (protocol.js): `hello` and `cancel`, and each
 * platform's own ops, named `<platform>.<op>` and answered by that platform's
 * module (platforms/steam.js) -- a platform the site has switched off is not
 * spoken to at all. A store added later is a module of ops, its entries in the
 * protocol and its ruleset (manifest.js); nothing here changes for it.
 */

/** @typedef {import('./protocol.js').Request} Request */

/**
 * A platform's ops by name: each given its checked arguments, a way to send
 * events before its answer, and a signal the page's `cancel` aborts.
 *
 * @typedef {Record<string, (args: Record<string, any>, emit: (event: string, data: object) => void,
 *     signal: AbortSignal) => Promise<any>>} PlatformOps
 */

/**
 * @param {Object} options
 * @param {string} options.version
 * @param {Record<string, boolean>} options.platforms  What the site has switched on.
 * @param {Record<string, PlatformOps>} options.ops  Each platform's.
 */
export function createBridge({ version, platforms, ops }){
    /** Requests going on, by the id they were asked with. @type {Map<number, AbortController>} */
    const going = new Map();
    return {
        /**
         * Answers a request; `emit` sends an op's events before its answer.
         *
         * @param {Request} request
         * @param {(event: string, data: object) => void} emit
         */
        async handle({ id, op, args }, emit){
            if (op === 'hello')
            {
                return { version, platforms: { ...platforms } };
            }
            if (op === 'cancel')
            {
                going.get(args.target)?.abort(new Error('cancelled by the page'));
                return {};
            }
            const [platform, name] = op.split('.');
            // Switched off, a platform is not spoken to at all: the site's
            // configuration is how a platform's request to stop is honoured
            // (roadmap/decisions.md).
            if (!platforms[platform])
            {
                throw new Error(`${platform} is switched off for this site`);
            }
            const stop = new AbortController();
            going.set(id, stop);
            try
            {
                return await ops[platform][name](args, emit, stop.signal);
            }
            finally
            {
                going.delete(id);
            }
        },
    };
}
