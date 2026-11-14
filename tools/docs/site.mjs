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
import { covered, pages } from './check.mjs';
import { headings, prose, render } from './markdown.mjs';
import { isMain } from '../lib/common.mjs';

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
 * @typedef {{ id: string, col: number, row: number, label: string }} WalkNode
 * @typedef {{ anchor: string, title: string, nodes: string[], edges: [string, string][] }} WalkStep
 */

/**
 * A walkthrough a page declares: its parts (`<!-- nodes` then `id col row label` a line) and,
 * under a heading, the parts a step takes (`<!-- step: a>b, c -->`: an arrow from a to b, or a
 * part alone). Null for a page that declares none. A step naming a part the page does not have
 * fails the build.
 *
 * @param {string} text
 * @returns {{ nodes: WalkNode[], steps: WalkStep[] } | null}
 */
export function walkthrough(text){
    const declared = /<!--\s*nodes\s*\n([\s\S]*?)-->/.exec(text);
    if (!declared)
    {
        return null;
    }
    const nodes = declared[1].split('\n').map(line=>line.trim()).filter(Boolean).map(line=>{
        const match = /^(\S+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
        if (!match)
        {
            throw new Error(`a walkthrough part is "id column row label": ${line}`);
        }
        return { id: match[1], col: Number(match[2]), row: Number(match[3]), label: match[4] };
    });
    const known = new Set(nodes.map(node=>node.id));
    const heads = headings(text);
    /** @type {WalkStep[]} */
    const steps = [];
    let at = -1;
    for (const line of prose(text))
    {
        if (/^(#{1,6})\s+(.+?)\s*#*\s*$/.test(line))
        {
            at++;
            continue;
        }
        const step = /^<!--\s*step:(.*?)-->/.exec(line.trim());
        if (!step)
        {
            continue;
        }
        const heading = heads[at];
        if (!heading)
        {
            throw new Error(`a step before any heading: ${line}`);
        }
        /** @type {WalkStep} */
        const entry = { anchor: heading.anchor, title: heading.text.replace(/`/g, ''), nodes: [],
            edges: [] };
        for (const item of step[1].split(',').map(part=>part.trim()).filter(Boolean))
        {
            const ends = item.split('>').map(part=>part.trim());
            for (const id of ends)
            {
                if (!known.has(id))
                {
                    throw new Error(`step "${entry.title}" names ${id}, which no part is`);
                }
            }
            if (ends.length === 2)
            {
                entry.edges.push([ends[0], ends[1]]);
            }
            entry.nodes.push(...ends.filter(id=>!entry.nodes.includes(id)));
        }
        steps.push(entry);
    }
    return { nodes, steps };
}

/**
 * The walkthrough's panel: the parts in their grid, every arrow any step draws,
 * and the controls; `walk.js` lights each step's parts and arrows.
 *
 * @param {{ nodes: WalkNode[], steps: WalkStep[] }} walk
 */
function walkPanel({ nodes, steps }){
    const W = 150;
    const H = 40;
    const GX = 34;
    const GY = 30;
    const P = 8;
    const cols = Math.max(...nodes.map(node=>node.col)) + 1;
    const rowCount = Math.max(...nodes.map(node=>node.row)) + 1;
    const width = cols * (W + GX) - GX + 2 * P;
    const height = rowCount * (H + GY) - GY + 2 * P;
    const by = new Map(nodes.map(node=>[node.id, node]));
    const centre = (/** @type {string} */ id)=>{
        const node = /** @type {WalkNode} */ (by.get(id));
        return { x: P + node.col * (W + GX) + W / 2, y: P + node.row * (H + GY) + H / 2 };
    };
    // Where the line from a box's centre towards (dx, dy) leaves the box.
    /** @param {{ x: number, y: number }} c @param {number} dx @param {number} dy */
    const edgeOf = (c, dx, dy)=>{
        const t = Math.min(dx ? (W / 2 + 3) / Math.abs(dx) : Infinity,
            dy ? (H / 2 + 3) / Math.abs(dy) : Infinity);
        return { x: c.x + dx * t, y: c.y + dy * t };
    };
    const keys = [...new Set(steps.flatMap(step=>step.edges.map(([a, b])=>`${a}>${b}`)))];
    const arrows = keys.map(key=>{
        const [a, b] = key.split('>');
        const from = centre(a);
        const to = centre(b);
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const start = edgeOf(from, dx, dy);
        const end = edgeOf(to, -dx, -dy);
        return `<line class="edge" data-key="${key}" x1="${start.x}" y1="${start.y}" `
            + `x2="${end.x}" y2="${end.y}" marker-end="url(#walk-arrow)"/>`;
    });
    const boxes = nodes.map(node=>{
        const c = centre(node.id);
        return `<g class="node" data-id="${node.id}" tabindex="0" role="button">`
            + `<rect x="${c.x - W / 2}" y="${c.y - H / 2}" width="${W}" height="${H}" rx="8"/>`
            + `<text x="${c.x}" y="${c.y + 5}" text-anchor="middle">${escape(node.label)}</text></g>`;
    });
    const data = JSON.stringify(steps).replace(/</g, '\\u003c');
    return '<div class="walk" id="walk"><div class="walk-bar">'
        + '<button type="button" data-go="-1" aria-label="Previous step">&#8249; Back</button>'
        + '<span class="walk-title" aria-live="polite"></span>'
        + '<button type="button" data-go="1" aria-label="Next step">Next &#8250;</button></div>'
        + `<svg class="walk-map" viewBox="0 0 ${width} ${height}" role="img" `
        + 'aria-label="The parts of Bottlify a step takes"><defs><marker id="walk-arrow" '
        + 'viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" '
        + 'orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z"/></marker></defs>'
        + `${arrows.join('')}${boxes.join('')}</svg></div>`
        + `<script type="application/json" id="walk-data">${data}</script>`;
}

/** The 3D graph's library: one bundle, with its own copy of three.js inside. */
const FORCE_GRAPH = 'https://cdn.jsdelivr.net/npm/3d-force-graph@1.79.1/dist/3d-force-graph.min.js';

/** A layer's or cork's folders that are its workings, not a part a reader looks for. */
const NOT_PARTS = new Set(['internal', 'common', 'testing']);

/**
 * @typedef {{ id: string, label: string, group: string, about: string, file: string | null,
 *     pages?: { title: string, href: string }[] }} GraphNode
 * @typedef {{ source: string, target: string, kind: string }} GraphLink
 */

/**
 * The whole project as points and lines, read from the tree: the packages and
 * what each depends on, the core's layers and what each requires, the folders
 * inside each layer and inside cork, and the workers (`*.worker.js`). A page's
 * `<!-- graph3d -->` block adds the parts outside the code (`node id | label |
 * [path |] about`) and the lines the code does not say (`link a > b`); a line
 * to a part that does not exist fails the build.
 *
 * @param {string} root
 * @param {string} block  The text of the page's `graph3d` block.
 * @returns {Promise<{ nodes: GraphNode[], links: GraphLink[] }>}
 */
export async function projectGraph(root, block){
    /** @type {Map<string, GraphNode>} */
    const nodes = new Map();
    /** @type {Map<string, GraphLink>} */
    const links = new Map();
    const add = (/** @type {GraphNode} */ node)=>void nodes.set(node.id, node);
    const connect = (/** @type {string} */ source, /** @type {string} */ target,
        /** @type {string} */ kind)=>void links.set(`${source}>${target}`, { source, target, kind });
    const folders = (/** @type {string} */ dir)=>existsSync(join(root, dir))
        ? readdirSync(join(root, dir)).filter(name=>!NOT_PARTS.has(name)
            && statSync(join(root, dir, name)).isDirectory()).sort()
        : [];
    // A folder with no code in it is data (recorded sessions, fixtures), not a part.
    const parts = (/** @type {string} */ dir)=>folders(dir)
        .filter(name=>readdirSync(join(root, dir, name)).some(file=>file.endsWith('.js')));
    for (const name of folders('modules'))
    {
        const file = join(root, 'modules', name, 'package.json');
        if (!existsSync(file))
        {
            continue;
        }
        const pkg = JSON.parse(readFileSync(file, 'utf8'));
        add({ id: name, label: pkg.name, group: 'package', about: pkg.description ?? '',
            file: `modules/${name}` });
        for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies }))
        {
            if (dep.startsWith('@bottlify/'))
            {
                connect(name, dep.slice('@bottlify/'.length), 'requires');
            }
        }
    }
    for (const layer of await layers(root))
    {
        const id = `core/${layer.name}`;
        const dir = `${LAYERS}/${layer.name}`;
        add({ id, label: layer.name, group: 'layer', about: layer.summary, file: dir });
        connect('core', id, 'holds');
        layer.requires.forEach(need=>connect(id, `core/${need}`, 'requires'));
        for (const part of parts(dir))
        {
            // What a layer holds reproduces Windows (its libraries and APIs) unless the page
            // names it as the project's own.
            add({ id: `${id}/${part}`, label: part, group: 'windows',
                about: `A part of Windows the ${layer.name} layer reproduces.`,
                file: `${dir}/${part}` });
            connect(id, `${id}/${part}`, 'holds');
        }
    }
    for (const part of parts('modules/cork/src'))
    {
        add({ id: `cork/${part}`, label: part, group: 'cork', about: 'Part of the translator.',
            file: `modules/cork/src/${part}` });
        connect('cork', `cork/${part}`, 'holds');
    }
    const workers = (/** @type {string} */ dir)=>existsSync(join(root, dir))
        ? readdirSync(join(root, dir)).filter(name=>name.endsWith('.worker.js'))
            .map(name=>`${dir}/${name}`)
        : [];
    for (const file of [...workers('modules/core/src/host'), ...workers('modules/cork/src/runtime'),
        ...readdirSync(join(root, LAYERS)).flatMap(layer=>workers(`${LAYERS}/${layer}/internal`))])
    {
        const name = posix.basename(file, '.worker.js');
        add({ id: `worker/${name}`, label: `${name} thread`, group: 'thread',
            about: `A worker of its own: ${file}.`, file });
        // Held by the layer or the package its file is in.
        const layer = file.startsWith(`${LAYERS}/`) ? file.split('/')[4] : null;
        connect(layer ? `core/${layer}` : file.split('/')[1], `worker/${name}`, 'holds');
    }
    for (const line of block.split('\n').map(text=>text.trim()).filter(Boolean))
    {
        const node = /^node\s+(\S+)\s*\|(.*)$/.exec(line);
        const link = /^link\s+(\S+)\s*>\s*(\S+)$/.exec(line);
        const own = /^ours\s+(\S+)\s*\|(.*)$/.exec(line);
        if (node)
        {
            const fields = node[2].split('|').map(field=>field.trim());
            const [label, file, about] = fields.length > 2 ? fields : [fields[0], null, fields[1]];
            add({ id: node[1], label, group: 'outside', about: about ?? '', file });
        }
        else if (link)
        {
            connect(link[1], link[2], 'runs');
        }
        else if (own)
        {
            const part = nodes.get(own[1]);
            if (!part)
            {
                throw new Error(`graph3d: ours ${own[1]} is no part of the project`);
            }
            part.group = part.group === 'cork' ? 'cork' : 'ours';
            part.about = own[2].trim();
        }
        else if (!/^route\s/.test(line))
        {
            throw new Error('graph3d: a line is "node id | label | about", "ours id | about", '
                + `"link a > b" or "route page.md": ${line}`);
        }
    }
    for (const { source, target } of links.values())
    {
        for (const end of [source, target])
        {
            if (!nodes.has(end))
            {
                throw new Error(`graph3d: a line ${source} > ${target} reaches ${end}, which is `
                    + 'no part of the project');
            }
        }
    }
    return { nodes: [...nodes.values()], links: [...links.values()] };
}

/**
 * The 3D graph's body: the graph's box and its data, the route a walkthrough
 * page takes through it (each step's arrows, as lines of their own), and every
 * part's docs pages (those that cover its folder or file).
 *
 * @param {string} root
 * @param {string} block
 * @param {string} href  The graph page's path on the site.
 */
async function graph3dBody(root, block, href){
    const graph = await projectGraph(root, block);
    const known = new Set(graph.nodes.map(node=>node.id));
    const route = /^\s*route\s+(\S+)/m.exec(block);
    /** @type {{ title: string, hops: [string, string][], nodes: string[] }[]} */
    const steps = [];
    if (route)
    {
        const page = posix.join('docs/architecture', route[1]);
        const walk = walkthrough(readFileSync(join(root, page), 'utf8'));
        for (const step of walk?.steps ?? [])
        {
            for (const id of step.nodes)
            {
                if (!known.has(id))
                {
                    throw new Error(`${page}: step "${step.title}" names ${id}, which the project `
                        + 'graph has no part for');
                }
            }
            steps.push({ title: step.title, hops: step.edges, nodes: step.nodes });
        }
    }
    const docs = pages(root, 'docs').map(page=>({ page, paths: covered(root, page),
        title: headings(readFileSync(join(root, page), 'utf8')).find(h=>h.level === 1)?.text
            .replace(/`/g, '') ?? page }));
    for (const node of graph.nodes)
    {
        const file = node.file;
        node.pages = file ? docs.filter(doc=>doc.paths.some(path=>path === file
            || path.startsWith(`${file}/`) || file.startsWith(`${path}/`)))
            .map(doc=>({ title: doc.title,
                href: posix.relative(posix.dirname(href), htmlOf(doc.page)) }))
            : [];
    }
    const data = JSON.stringify({ ...graph, steps, github: `${GITHUB}/tree/main/` })
        .replace(/</g, '\\u003c');
    return '<div class="graph3d" id="graph3d"><div class="g3-canvas"></div><div class="g3-labels"></div>'
        + '<div class="g3-bar"><button type="button" data-act="play">&#9654; Play</button>'
        + '<button type="button" data-act="back" aria-label="Previous step">&#8249;</button>'
        + '<button type="button" data-act="next" aria-label="Next step">&#8250;</button>'
        + '<span class="g3-caption" aria-live="polite">The hello world route</span>'
        + '<button type="button" data-act="full" aria-label="Full screen">&#x26F6;</button></div>'
        + '<div class="g3-card" hidden></div><ul class="g3-legend">'
        + '<li class="g3-package">package</li><li class="g3-layer">layer of the engine</li>'
        + '<li class="g3-ours">our part</li><li class="g3-cork">cork</li>'
        + '<li class="g3-thread">thread</li><li class="g3-windows">Windows, reproduced</li>'
        + '<li class="g3-outside">outside the code</li></ul>'
        + '<noscript>The graph needs JavaScript.</noscript></div>'
        + `<script type="application/json" id="graph3d-data">${data}</script>`;
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
        let body = render(text, { link });
        const tour = walkthrough(text);
        if (tour && tour.steps.length)
        {
            // The panel goes right above the first step, and stays in view under the header
            // while the steps scroll past it.
            const at = body.indexOf(`id="${tour.steps[0].anchor}"`);
            const cut = body.lastIndexOf('<', at);
            body = `${body.slice(0, cut)}${walkPanel(tour)}${body.slice(cut)}`;
        }
        const base = '../'.repeat(href.split('/').length - 1);
        const block = /<!--\s*graph3d\s*\n([\s\S]*?)-->/.exec(text);
        if (block)
        {
            body += await graph3dBody(root, block[1], href);
        }
        const scripts = (/^```mermaid/m.test(text) ? MERMAID : '')
            + (tour ? `<script src="${base}walk.js" defer></script>` : '')
            + (block ? `<script src="${FORCE_GRAPH}" defer></script>`
                + `<script src="${base}graph3d.js" defer></script>` : '');
        page(href, title, body, { source, toc: heads, scripts });
        search.push(...searchEntries(text, href, title));
    }
    page('modules.html', 'Module graph', modulesBody(list),
        { scripts: '<script src="graph.js" defer></script>' });

    for (const asset of ['style.css', 'search.js', 'graph.js', 'walk.js', 'graph3d.js'])
    {
        copyFileSync(join(ASSETS, asset), join(out, asset));
    }
    writeFileSync(join(out, 'search.json'), JSON.stringify(search));
    return written;
}

if (isMain(import.meta.url))
{
    const at = process.argv.indexOf('--out');
    const out = at > 0 ? process.argv[at + 1] : join(ROOT, 'dist', 'docs');
    const written = await build(ROOT, out);
    console.log(`${written.length} pages in ${out}`);
}
