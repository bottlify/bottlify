/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The extension's manifest, one source for its two builds: `public` runs on
 * Bottlify's own sites alone, `dev` on a local launcher too.
 *
 * A host permission is the page's as well as the platform's: Chrome applies a
 * ruleset's header changes only to a request whose URL and whose initiator
 * the extension may both reach, so a page missing from them is silently left
 * as it was. `*://` does not cover `wss://`, which is listed for itself.
 */

/** The pages the bridge serves, by build. */
export const PAGES = Object.freeze({
    public: Object.freeze(['https://bottlify.app/*', 'https://play.bottlify.app/*']),
    dev: Object.freeze(['https://bottlify.app/*', 'https://play.bottlify.app/*',
        '*://*.localhost/*', 'http://127.0.0.1/*']),
});

/**
 * Each platform: its ruleset (switched on and off as one) and the hosts the
 * ruleset and the bridge's own requests reach.
 */
export const PLATFORMS = Object.freeze({
    steam: Object.freeze({
        rules: 'rules/steam.json',
        hosts: Object.freeze(['wss://*.steamserver.net/*', 'https://api.steampowered.com/*',
            '*://*.steamcontent.com/*', '*://*.steampipe.akamaized.net/*']),
    }),
});

/** What the content script imports, which the page may therefore load too. */
export const MODULES = Object.freeze(['bridge.js', 'protocol.js', 'steam/*', 'zstd.js']);

/**
 * @param {keyof typeof PAGES} build
 * @param {string} version
 */
export function manifestFor(build, version){
    const pages = [...PAGES[build]];
    return {
        manifest_version: 3,
        name: build === 'dev' ? 'Bottlify bridge (dev)' : 'Bottlify bridge',
        version,
        description: 'Lets a Bottlify page talk to Steam; the session stays in the extension.',
        permissions: ['declarativeNetRequest', 'storage'],
        host_permissions: [...pages,
            ...Object.values(PLATFORMS).flatMap(platform=>platform.hosts)],
        background: { service_worker: 'worker.js', type: 'module' },
        content_scripts: [{ matches: pages, js: ['content.js'], run_at: 'document_start' }],
        web_accessible_resources: [{ resources: [...MODULES], matches: pages }],
        declarative_net_request: {
            rule_resources: Object.entries(PLATFORMS).map(([id, platform])=>(
                { id, enabled: true, path: platform.rules })),
        },
    };
}
