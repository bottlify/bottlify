/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { spawnSync } from 'node:child_process';

/**
 * Downloads one asset of a GitHub release by whichever route can reach it.
 *
 * A release of a private repository answers 404 on its plain download URL to
 * anyone without credentials. With a token the API is asked instead; on a
 * developer machine a logged-in `gh` is the last resort. Every route in the
 * plan is tried in turn, and a failure names all of them.
 */

/**
 * @typedef {'api' | 'url' | 'gh'} Route
 * @typedef {typeof fetch} FetchLike
 * @typedef {{ repo: string, tag: string, name: string, token?: string | null,
 *             ghAvailable?: boolean, fetchImpl?: FetchLike }} Asset
 */

/**
 * The routes worth an attempt, in order. The plain URL is always one request
 * away and is all a public release needs; the API needs a token and `gh` needs
 * to be on PATH.
 *
 * @param {{ token?: string | null, ghAvailable?: boolean }} options
 * @returns {Route[]}
 */
export function planRoutes({ token, ghAvailable }){
    /** @type {Route[]} */
    const routes = [];
    if (token)
    {
        routes.push('api');
    }
    routes.push('url');
    if (ghAvailable)
    {
        routes.push('gh');
    }
    return routes;
}

/** @param {string} repo @param {string} tag @param {string} name @returns {string} */
export const releaseUrl = (repo, tag, name)=>
    `https://github.com/${repo}/releases/download/${tag}/${name}`;

/**
 * @param {FetchLike} fetchImpl @param {string} url @param {HeadersInit} [headers]
 * @returns {Promise<Response>}
 */
async function fetchOk(fetchImpl, url, headers){
    const response = await fetchImpl(url, { redirect: 'follow', headers });
    if (!response.ok)
    {
        throw new Error(`${url}: HTTP ${response.status}`);
    }
    return response;
}

/**
 * Through the API: the release by tag, the asset by name, its bytes by id.
 * The asset request redirects to a storage host whose signed URL refuses a
 * request that also carries Authorization; fetch drops that header on a
 * cross-origin redirect by itself, which the test beside this file pins.
 *
 * @param {Asset} asset @returns {Promise<Uint8Array>}
 */
export async function downloadViaApi({ repo, tag, name, token, fetchImpl = fetch }){
    const base = `https://api.github.com/repos/${repo}/releases`;
    const auth = { Authorization: `Bearer ${token}` };
    const release = await (await fetchOk(fetchImpl, `${base}/tags/${tag}`,
        { ...auth, Accept: 'application/vnd.github+json' })).json();
    const found = (release.assets ?? []).find(
        (/** @type {{ id: number, name: string }} */ a)=>a.name === name);
    if (!found)
    {
        throw new Error(`${repo}@${tag} has no asset named ${name}`);
    }
    const response = await fetchOk(fetchImpl, `${base}/assets/${found.id}`,
        { ...auth, Accept: 'application/octet-stream' });
    return new Uint8Array(await response.arrayBuffer());
}

/** @param {Asset} asset @returns {Promise<Uint8Array>} */
export async function downloadViaUrl({ repo, tag, name, fetchImpl = fetch }){
    const response = await fetchOk(fetchImpl, releaseUrl(repo, tag, name));
    return new Uint8Array(await response.arrayBuffer());
}

/**
 * `gh release download` writes a single asset to stdout with `--output -`.
 * @param {Asset} asset @returns {Uint8Array}
 */
export function downloadViaGh({ repo, tag, name }){
    const result = spawnSync('gh',
        ['release', 'download', tag, '--repo', repo, '--pattern', name, '--output', '-'],
        { maxBuffer: 256 * 1024 * 1024 });
    if (result.error || result.status !== 0)
    {
        throw new Error(result.error?.message ?? String(result.stderr).trim());
    }
    return new Uint8Array(result.stdout);
}

/** @returns {boolean} */
export const ghAvailable = ()=>spawnSync('gh', ['--version']).status === 0;

const ROUTES = {
    api: downloadViaApi,
    url: downloadViaUrl,
    gh: async(/** @type {Asset} */ asset)=>downloadViaGh(asset),
};

/** @param {Asset} asset @returns {Promise<Uint8Array>} */
export async function downloadAsset(asset){
    const failures = [];
    for (const route of planRoutes(asset))
    {
        try
        {
            return await ROUTES[route](asset);
        }
        catch (e){
            failures.push(`${route}: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    if (!asset.token)
    {
        failures.unshift('api: skipped, no token in the environment');
    }
    if (!asset.ghAvailable)
    {
        failures.push('gh: skipped, not on PATH');
    }
    throw new Error(`${asset.name} could not be downloaded from ${asset.repo}@${asset.tag}\n`
        + failures.map(line=>`  ${line}`).join('\n'));
}
