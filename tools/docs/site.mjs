/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Builds the documentation site from docs/: a static page per markdown page,
 * the navigation from docs/README.md, a search index, and the module graph
 * read from each layer's module.js (its `requires` and the comment that says
 * what it is), so the graph cannot drift from the code. A link out of docs/
 * leads to the file on GitHub.
 *
 *     node tools/docs/site.mjs [--out dist/docs]
 *
 * Nothing here publishes; the folder is what a host serves.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync,
    writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pages } from './check.mjs';
import { headings, prose, render } from './markdown.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const ASSETS = fileURLToPath(new URL('assets/', import.meta.url));
const GITHUB = 'https://github.com/bottlify/bottlify';
const LAYERS = 'modules/core/src/layers';

/** The diagram script, loaded only by a page that has a diagram. */
const MERMAID = '<script type="module">import mermaid from '
    + '"https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs";'
    + 'mermaid.initialize({ startOnLoad: true, securityLevel: "strict" });</script>';

/** @param {string} text */
const escape = text=>text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * Where a docs page lands on the site: `README.md` is its folder's `index.html`.
 *
 * @param {string} page
 */
export const htmlOf = page=>page.replace(/^docs\//, '')
    .replace(/(^|\/)README\.md$/, '$1index.html')
    .replace(/\.md$/, '.html');

/**
 * @typedef {{ title: string, page: string | null, href?: string, children: NavItem[] }} NavItem
 * @typedef {{ title: string, items: NavItem[] }} NavSection
 * @typedef {{ name: string, requires: string[], summary: string, about: string,
 *     file: string }} Layer
 */

/**
 * The navigation docs/README.md lists: each `##` a section, each list item a
 * page, an indented item a page under the one above it.
 *
 * @param {string} text
 * @returns {NavSection[]}
 */
export function navigation(text){
    /** @type {NavSection[]} */
    const sections = [];
    /** @type {{ indent: number, item: NavItem }[]} */
    let stack = [];
    for (const line of prose(text))
    {
        const heading = /^##\s+(.+)$/.exec(line);
        if (heading)
        {
            sections.push({ title: heading[1].trim(), items: [] });
            stack = [];
            continue;
        }
        const entry = /^(\s*)[-*]\s+\[([^\]]+)\]\(([^)]+)\)/.exec(line);
        if (!entry || !sections.length)
        {
            continue;
        }
        const indent = entry[1].length;
        const page = posix.normalize(posix.join('docs', entry[3].split('#')[0]));
        /** @type {NavItem} */
        const item = { title: entry[2], page, children: [] };
        while (stack.length && stack[stack.length - 1].indent >= indent)
        {
            stack.pop();
        }
        const parent = stack.length ? stack[stack.length - 1].item.children
            : sections[sections.length - 1].items;
        parent.push(item);
        stack.push({ indent, item });
    }
    return sections;
}

/**
 * Each layer of @bottlify/core: its name, what it requires, and the comment in
 * its module.js that says what it is (the block opening `<name> — ...`).
 *
 * @param {string} root
 * @returns {Promise<Layer[]>}
 */
export async function layers(root){
    const dir = join(root, LAYERS);
    const out = [];
    for (const name of readdirSync(dir).filter(n=>statSync(join(dir, n)).isDirectory()).sort())
    {
        const file = `${LAYERS}/${name}/module.js`;
        const module = await import(pathToFileURL(join(root, file)).href);
        const requires = [...module[`${name}Module`]?.requires ?? []];
        const source = readFileSync(join(root, file), 'utf8').replace(/\r\n/g, '\n');
        const opening = new RegExp(`^${name} (—|--) `);
        const block = [...source.matchAll(/\/\*\*\n([\s\S]*?)\*\//g)]
            .map(match=>match[1].split('\n').map(line=>line.replace(/^\s*\* ?/, '')).join('\n').trim())
            .find(text=>opening.test(text));
        if (!block)
        {
            throw new Error(`${file}: no comment opening "${name} — " says what the layer is`);
        }
        const about = block.replace(opening, '');
        const summary = about.split(/\n\s*\n/)[0].replace(/\s+/g, ' ');
        out.push({ name, requires, summary, about, file });
    }
    return out;
}

/**
 * Layers in rows: a layer one row above the highest it requires.
 *
 * @param {{ name: string, requires: string[] }[]} list
 */
export function rows(list){
    const by = new Map(list.map(layer=>[layer.name, layer]));
    /** @type {Map<string, number>} */
    const level = new Map();
    const of = (/** @type {string} */ name, seen = new Set())=>{
        if (level.has(name))
        {
            return /** @type {number} */ (level.get(name));
        }
        if (seen.has(name))
        {
            throw new Error(`the layers require each other in a circle through ${name}`);
        }
        seen.add(name);
        const needs = by.get(name)?.requires ?? [];
        const value = needs.length ? 1 + Math.max(...needs.map(need=>of(need, seen))) : 0;
        level.set(name, value);
        return value;
    };
    list.forEach(layer=>of(layer.name));
    return level;
}

/**
 * The module graph as an SVG: rows from the bottom (what requires nothing) up,
 * an edge from a layer down to each layer it requires. An edge another path
 * already implies is marked `implied` and drawn only when one of its ends is
 * picked: with every edge drawn, the long ones cross the boxes between.
 *
 * @param {{ name: string, requires: string[], summary: string }[]} list
 */
export function graphSvg(list){
    const level = rows(list);
    const height = Math.max(...level.values()) + 1;
    const W = 112;
    const H = 34;
    const GAP_X = 24;
    const GAP_Y = 46;
    /** @type {Map<number, string[]>} */
    const inRow = new Map();
    for (const layer of list)
    {
        const row = /** @type {number} */ (level.get(layer.name));
        inRow.set(row, [...inRow.get(row) ?? [], layer.name]);
    }
    const widest = Math.max(...[...inRow.values()].map(names=>names.length));
    const width = widest * (W + GAP_X) + GAP_X;
    const total = height * (H + GAP_Y) + GAP_Y / 2;
    /** @type {Map<string, { x: number, y: number }>} */
    const at = new Map();
    for (const [row, names] of inRow)
    {
        const span = names.length * (W + GAP_X) - GAP_X;
        names.forEach((name, k)=>at.set(name, {
            x: (width - span) / 2 + k * (W + GAP_X),
            y: total - (row + 1) * (H + GAP_Y) + GAP_Y / 2,
        }));
    }
    const by = new Map(list.map(layer=>[layer.name, layer]));
    const reach = (/** @type {string} */ name, seen = new Set())=>{
        for (const need of by.get(name)?.requires ?? [])
        {
            if (!seen.has(need))
            {
                seen.add(need);
                reach(need, seen);
            }
        }
        return seen;
    };
    const implied = (/** @type {string} */ from, /** @type {string} */ to)=>
        (by.get(from)?.requires ?? []).some(other=>other !== to && reach(other).has(to));
    const place = (/** @type {string} */ name)=>
        /** @type {{ x: number, y: number }} */ (at.get(name));
    const edges = list.flatMap(layer=>layer.requires.map(need=>{
        const a = place(layer.name);
        const b = place(need);
        const [x1, y1, x2, y2] = [a.x + W / 2, a.y + H, b.x + W / 2, b.y];
        const mid = (y1 + y2) / 2;
        const kind = implied(layer.name, need) ? 'edge implied' : 'edge';
        return `<path class="${kind}" data-from="${layer.name}" data-to="${need}" `
            + `d="M${x1},${y1} C${x1},${mid} ${x2},${mid} ${x2},${y2 - 6}" `
            + 'marker-end="url(#arrow)"/>';
    }));
    const nodes = list.map(layer=>{
        const { x, y } = place(layer.name);
        return `<g class="node" data-name="${layer.name}" tabindex="0" role="button">`
            + `<title>${escape(layer.summary)}</title>`
            + `<rect x="${x}" y="${y}" width="${W}" height="${H}" rx="8"/>`
            + `<text x="${x + W / 2}" y="${y + H / 2 + 5}" text-anchor="middle">${layer.name}</text></g>`;
    });
    return `<svg class="graph" viewBox="0 0 ${width} ${total}" width="${width}" role="img" `
        + 'aria-label="The layers of @bottlify/core and what each requires">'
        + '<defs><marker id="arrow" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="7" '
        + 'markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z"/></marker></defs>'
        + `${edges.join('')}${nodes.join('')}</svg>`;
}

/**
 * The module graph's page body: the graph, a card per layer, the data the
 * graph script reads.
 *
 * @param {Layer[]} list
 */
function modulesBody(list){
    const names = (/** @type {string[]} */ of)=>of.map(name=>`<code>${name}</code>`).join(', ')
        || 'nothing';
    const users = (/** @type {string} */ name)=>list.filter(other=>other.requires.includes(name))
        .map(other=>other.name);
    const cards = list.map(layer=>`<template id="about-${layer.name}"><h2>${layer.name}</h2>`
        + `<p><b>Requires:</b> ${names(layer.requires)}. <b>Required by:</b> `
        + `${names(users(layer.name))}.</p>`
        + render(layer.about)
        + `<p><a href="${GITHUB}/blob/main/${layer.file}">${layer.file}</a></p></template>`).join('');
    const data = JSON.stringify(list.map(({ name, requires })=>({ name, requires })))
        .replace(/</g, '\\u003c');
    return '<h1>Module graph</h1>'
        + '<p>The layers of <code>@bottlify/core</code>. A layer reaches another only through '
        + '<code>host.requireApi(name)</code> for a name in its own <code>requires</code>, and '
        + '<code>npm run check:boundaries</code> holds the code to it. This graph is read from '
        + 'each layer\'s <code>module.js</code> when the site is built.</p>'
        + '<p class="legend">Pick a layer: what it requires is shaded with a dashed border, what '
        + 'requires it is shaded, and its edges are drawn bold.</p>'
        + `${graphSvg(list)}<div class="layer-card" id="card"></div>${cards}`
        + `<script type="application/json" id="layers">${data}</script>`;
}

/**
 * One search entry per section of a page, so a hit leads to its heading.
 *
 * @param {string} text
 * @param {string} href
 * @param {string} title
 */
function searchEntries(text, href, title){
    const heads = headings(text);
    let current = { url: href, title, text: '' };
    const entries = [current];
    for (const line of prose(text))
    {
        const heading = /^(#{2,3})\s+(.+)$/.exec(line);
        if (heading)
        {
            const anchor = heads.find(h=>h.text === heading[2])?.anchor ?? '';
            current = { url: `${href}#${anchor}`, title: heading[2].replace(/`/g, ''), text: '' };
            entries.push(current);
        }
        else
        {
            current.text += ` ${line}`;
        }
    }
    return entries.map(entry=>({ url: entry.url, title: escape(entry.title), page: escape(title),
        text: entry.text.replace(/[`*_|#>[\]()]/g, ' ').replace(/\s+/g, ' ').toLowerCase()
            .slice(0, 4000) }));
}

/**
 * Builds the site into `out`.
 *
 * @param {string} root
 * @param {string} out
 * @returns {Promise<string[]>} the pages written
 */
export async function build(root, out){
    const read = (/** @type {string} */ file)=>readFileSync(join(root, file), 'utf8');
    const sections = navigation(read('docs/README.md'));
    const list = await layers(root);
    sections.push({ title: 'Reference', items: [
        { title: 'Module graph', page: null, href: 'modules.html', children: [] },
    ] });
    const hrefOf = (/** @type {NavItem} */ item)=>item.href ?? htmlOf(/** @type {string} */ (item.page));
    /** @type {{ title: string, href: string }[]} */
    const order = [{ title: 'Home', href: 'index.html' }];
    const walk = (/** @type {NavItem[]} */ items)=>items.forEach(item=>{
        order.push({ title: item.title, href: hrefOf(item) });
        walk(item.children);
    });
    sections.forEach(section=>walk(section.items));

    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    /** @type {{ url: string, title: string, page: string, text: string }[]} */
    const search = [];
    /** @type {string[]} */
    const written = [];

    /**
     * @param {string} href  The page's path on the site.
     * @param {string} title
     * @param {string} body  The page's HTML.
     * @param {{ source?: string, toc?: { level: number, text: string, anchor: string }[],
     *     scripts?: string }} [extra]
     */
    const page = (href, title, body, extra = {})=>{
        const base = '../'.repeat(href.split('/').length - 1);
        const navList = (/** @type {NavItem[]} */ items)=>`<ul>${items.map(item=>{
            const target = hrefOf(item);
            const here = target === href ? ' class="here"' : '';
            const children = item.children.length ? navList(item.children) : '';
            return `<li><a href="${base}${target}"${here}>${escape(item.title)}</a>${children}</li>`;
        }).join('')}</ul>`;
        const side = sections
            .map(section=>`<h4>${escape(section.title)}</h4>${navList(section.items)}`).join('');
        const at = order.findIndex(entry=>entry.href === href);
        const prev = at > 0 ? order[at - 1] : null;
        const next = at >= 0 && at < order.length - 1 ? order[at + 1] : null;
        const pager = '<div class="pager">'
            + (prev ? `<a href="${base}${prev.href}"><small>Previous</small>${escape(prev.title)}</a>`
                : '<span></span>')
            + (next ? `<a class="next" href="${base}${next.href}"><small>Next</small>`
                + `${escape(next.title)}</a>` : '')
            + '</div>';
        const toc = (extra.toc ?? []).filter(h=>h.level === 2 || h.level === 3);
        const aside = toc.length > 1
            ? `<aside class="toc"><b>On this page</b>${toc.map(h=>`<a class="l${h.level}" `
                + `href="#${h.anchor}">${escape(h.text.replace(/`/g, ''))}</a>`).join('')}</aside>`
            : '<aside class="toc"></aside>';
        const edit = extra.source ? `<p class="edit"><a href="${GITHUB}/blob/main/${extra.source}">`
            + 'Edit this page on GitHub</a></p>' : '';
        const html = `<!doctype html><html lang="en" data-base="${base}">`
            + '<head><meta charset="utf-8">'
            + '<meta name="viewport" content="width=device-width,initial-scale=1">'
            + `<title>${escape(title)} - Bottlify docs</title>`
            + `<link rel="stylesheet" href="${base}style.css"></head><body>`
            + '<input type="checkbox" id="menu" hidden>'
            + '<header><label for="menu" class="menu" aria-label="Pages">&#9776;</label>'
            + `<a class="brand" href="${base}index.html">Bottlify <span>documentation</span></a>`
            + '<div class="search"><input id="q" type="search" placeholder="Search  /" '
            + 'autocomplete="off" aria-label="Search the documentation"><div id="results"></div></div>'
            + `</header><div class="layout"><nav class="side" aria-label="Pages">${side}</nav>`
            + `<main>${body}${edit}${pager}</main>${aside}</div>`
            + `<script src="${base}search.js" defer></script>${extra.scripts ?? ''}</body></html>`;
        mkdirSync(dirname(join(out, href)), { recursive: true });
        writeFileSync(join(out, href), html);
        written.push(href);
    };

    for (const source of pages(root, 'docs'))
    {
        const href = htmlOf(source);
        const text = read(source);
        const link = (/** @type {string} */ url)=>{
            if (/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(url))
            {
                return url;
            }
            const [path, anchor = ''] = url.split(/(?=#)/);
            const target = posix.normalize(posix.join(posix.dirname(source), path)).replace(/\/$/, '');
            const from = posix.dirname(href);
            if (target.startsWith('docs/') && target.endsWith('.md'))
            {
                return posix.relative(from, htmlOf(target)) + anchor;
            }
            if (target.startsWith('docs/'))
            {
                const asset = target.slice('docs/'.length);
                mkdirSync(dirname(join(out, asset)), { recursive: true });
                copyFileSync(join(root, target), join(out, asset));
                return posix.relative(from, asset) + anchor;
            }
            const whole = join(root, target);
            const folder = existsSync(whole) && statSync(whole).isDirectory();
            return `${GITHUB}/${folder ? 'tree' : 'blob'}/main/${target}${anchor}`;
        };
        const heads = headings(text);
        const title = heads.find(h=>h.level === 1)?.text.replace(/`/g, '') ?? source;
        page(href, title, render(text, { link }), {
            source,
            toc: heads,
            scripts: /^```mermaid/m.test(text) ? MERMAID : '',
        });
        search.push(...searchEntries(text, href, title));
    }
    page('modules.html', 'Module graph', modulesBody(list),
        { scripts: '<script src="graph.js" defer></script>' });

    for (const asset of ['style.css', 'search.js', 'graph.js'])
    {
        copyFileSync(join(ASSETS, asset), join(out, asset));
    }
    writeFileSync(join(out, 'search.json'), JSON.stringify(search));
    return written;
}

if (process.argv[1] === fileURLToPath(import.meta.url))
{
    const at = process.argv.indexOf('--out');
    const out = at > 0 ? process.argv[at + 1] : join(ROOT, 'dist', 'docs');
    const written = await build(ROOT, out);
    console.log(`${written.length} pages in ${out}`);
}
