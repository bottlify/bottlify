/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The extension's manifest, one source for its two builds: `public` runs on
 * Bottlify's own sites alone, `dev` on any page, a local launcher's too.
 *
 * A host permission is the page's as well as the platform's: Chrome applies a
 * ruleset's header changes only to a request whose URL and whose initiator
 * the extension may both reach, so a page missing from them is silently left
 * as it was. `*://` does not cover `wss://`, which is listed for itself.
 */

/** The pages the bridge serves, by build. */
export const PAGES = Object.freeze({
    public: Object.freeze(['https://bottlify.app/*', 'https://play.bottlify.app/*']),
    // Any page: a launcher is reached as localhost, 127.0.0.1 or a machine's
    // address on its network, and a match pattern takes no wildcard inside an
    // address. The dev build is loaded by hand, never published.
    dev: Object.freeze(['<all_urls>']),
});

/**
 * The hosts a build's bridge answers on, by name, where its match patterns
 * cannot say it: the dev build, matched on every page, answers on a local
 * launcher's alone -- localhost, 127.x, a 192.168.x.x network address -- and
 * on Bottlify's sites. Null: every page the build is matched on.
 */
export const HOSTS = Object.freeze({
    public: null,
    dev: [String.raw`localhost|.+\.localhost`, String.raw`127\.\d+\.\d+\.\d+`,
        String.raw`192\.168\.\d+\.\d+`, String.raw`(play\.)?bottlify\.app`]
        .map(host=>`^(${host})$`).join('|'),
});

/**
 * Each platform: its ruleset (switched on and off as one) and the hosts the
 * ruleset and the bridge's own requests reach.
 */
export const PLATFORMS = Object.freeze({
    steam: Object.freeze({
        rules: 'rules/steam.json',
        hosts: Object.freeze(['wss://*.steamserver.net/*', 'https://api.steampowered.com/*',
            '*://*.steamcontent.com/*', '*://*.steampipe.akamaized.net/*',
            // Valve's client distribution: the client's own DLLs, which a DRM
            // wrapper reads as the installed client's (core's steam/client.js).
            'https://client-update.akamai.steamstatic.com/*',
            // The apps' art a library shows (core's steam/apps.js, STEAM_ART),
            // under the hosts Steam has served it from.
            'https://shared.steamstatic.com/*', 'https://shared.akamai.steamstatic.com/*',
            'https://shared.cloudflare.steamstatic.com/*', 'https://cdn.akamai.steamstatic.com/*',
            'https://cdn.cloudflare.steamstatic.com/*']),
    }),
});

/** What the content script imports, which the page may therefore load too. */
export const MODULES = Object.freeze(['bridge.js', 'protocol.js', 'platforms/*', 'steam/*', 'zstd.js']);

/**
 * @param {keyof typeof PAGES} build
 * @param {string} version
 */
export function manifestFor(build, version){
    const pages = [...PAGES[build]];
    return {
        manifest_version: 3,
        name: build === 'dev' ? 'Bottlify GameHub (dev)' : 'Bottlify GameHub',
        version,
        description: 'Connects Bottlify to your game libraries; sign-ins stay in the extension.',
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
