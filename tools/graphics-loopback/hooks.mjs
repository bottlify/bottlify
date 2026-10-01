/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The loader hook `register.mjs` installs. The Direct3D 8 and 9 modules, as
 * anything imports them, export their root's factory wrapped in the
 * loopback; the recorded and the played device each come from a graph of the
 * graphics layer of their own (`?recorded`, `?played`, carried to every
 * module the first imports), as two threads would each have theirs.
 */

const FACTORIES = [
    { path: '/layers/graphics/d3d9/device.js', name: 'createDirect3D9' },
    { path: '/layers/graphics/d3d8/device.js', name: 'createDirect3D8' },
];
const TWINS = ['?recorded', '?played'];

/**
 * @param {string} specifier @param {any} context
 * @param {(specifier: string, context: any) => Promise<any>} next
 */
export async function resolve(specifier, context, next){
    const resolved = await next(specifier, context);
    const twin = TWINS.find(query=>context.parentURL?.endsWith(query));
    if (!twin || !resolved.url.startsWith('file:') || resolved.url.includes('?')
        || !resolved.url.includes('/layers/graphics/'))
    {
        return resolved;
    }
    return { ...resolved, url: resolved.url + twin };
}

/**
 * @param {string} url @param {any} context
 * @param {(url: string, context: any) => Promise<any>} next
 */
export async function load(url, context, next){
    const factory = FACTORIES.find(({ path })=>url.endsWith(path));
    if (!factory)
    {
        return next(url, context);
    }
    const { name } = factory;
    return {
        format: 'module',
        shortCircuit: true,
        source: [
            "export * from './device.js?recorded';",
            `import { ${name} as recorded } from './device.js?recorded';`,
            `import { ${name} as played } from './device.js?played';`,
            "import { loopbackDirect3D } from '../remote/loopback.js';",
            `export function ${name}(options){`,
            '    return loopbackDirect3D(recorded, options, played);',
            '}',
        ].join('\n'),
    };
}
