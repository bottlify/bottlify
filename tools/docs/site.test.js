/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from './markdown.mjs';
import { build, graphSvg, htmlOf, navigation, projectGraph, rows, walkthrough } from './site.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

test('a page lands where its link expects it, a README as the folder\'s index', ()=>{
    assert.equal(htmlOf('docs/README.md'), 'index.html');
    assert.equal(htmlOf('docs/core/limits/README.md'), 'core/limits/index.html');
    assert.equal(htmlOf('docs/cork/how-it-works.md'), 'cork/how-it-works.html');
});

test('the navigation is the sections and the nested list of docs/README.md', ()=>{
    const nav = navigation('# Docs\n\nintro [x](x.md)\n\n## Use\n\n- [A](a.md)\n  - [B](sub/b.md)\n'
        + '- [C](c.md#part)\n\n## Inside\n\n- [D](d.md)\n');
    assert.deepEqual(nav.map(section=>section.title), ['Use', 'Inside']);
    assert.deepEqual(nav[0].items.map(item=>item.page), ['docs/a.md', 'docs/c.md']);
    assert.deepEqual(nav[0].items[0].children.map(item=>item.page), ['docs/sub/b.md']);
});

test('the layers stand in rows above what they require, a circle is refused', ()=>{
    const level = rows([{ name: 'log', requires: [] }, { name: 'cpu', requires: ['log'] },
        { name: 'kernel', requires: ['cpu', 'log'] }]);
    assert.deepEqual([...level], [['log', 0], ['cpu', 1], ['kernel', 2]]);
    assert.throws(()=>rows([{ name: 'a', requires: ['b'] }, { name: 'b', requires: ['a'] }]), /circle/);
});

test('an edge another path implies is marked so the graph can hide it', ()=>{
    const svg = graphSvg([{ name: 'log', requires: [], summary: '' },
        { name: 'cpu', requires: ['log'], summary: '' },
        { name: 'kernel', requires: ['cpu', 'log'], summary: '' }]);
    assert.match(svg, /class="edge implied" data-from="kernel" data-to="log"/);
    assert.match(svg, /class="edge" data-from="kernel" data-to="cpu"/);
});

test('render: tables with escaped pipes and code, nested lists, fences, links', ()=>{
    const html = render('# T\n\n| a | b |\n| --- | ---: |\n| `x \\| y` | 1 \\| 2 |\n\n'
        + '- one\n  - two\n- three\n\n```mermaid\nflowchart LR\n```\n\nSee [p](p.md).\n',
    { link: url=>url.replace('.md', '.html') });
    assert.match(html, /<h1 id="t">T/);
    assert.match(html, /<td><code>x \| y<\/code><\/td><td style="text-align:right">1 \| 2<\/td>/);
    assert.match(html.replace(/\n/g, ''), /<ul><li>one<ul><li>two<\/li><\/ul><\/li><li>three/);
    assert.match(html, /<pre class="mermaid">flowchart LR<\/pre>/);
    assert.match(html, /<a href="p.html">p<\/a>/);
});

test('the site builds from docs/, and every link inside it leads to a page that exists', async()=>{
    const out = mkdtempSync(join(tmpdir(), 'docs-site-'));
    try
    {
        const written = await build(ROOT, out);
        assert.ok(written.includes('index.html') && written.includes('modules.html'));
        const broken = [];
        for (const page of written)
        {
            const html = readFileSync(join(out, page), 'utf8');
            for (const [, href] of html.matchAll(/(?:href|src)="([^"#]+)(?:#[^"]*)?"/g))
            {
                if (/^([a-z]+:|\/\/)/i.test(href))
                {
                    continue;
                }
                if (!existsSync(join(out, posix.join(posix.dirname(page), href))))
                {
                    broken.push(`${page}: ${href}`);
                }
            }
        }
        assert.deepEqual(broken, []);
        const graph = readFileSync(join(out, 'modules.html'), 'utf8');
        for (const name of ['log', 'cpu', 'memory', 'kernel', 'bridge', 'win32', 'graphics'])
        {
            assert.match(graph, new RegExp(`data-name="${name}"`), `${name} in the graph`);
        }
    }
    finally
    {
        rmSync(out, { recursive: true, force: true });
    }
});

test('render leaves a comment out of the page', ()=>{
    const html = render('# T\n<!-- covers: a.js\n  b.js -->\n\nText.\n');
    assert.doesNotMatch(html, /covers/);
    assert.match(html, /<p>Text\.<\/p>/);
});

test('a walkthrough: its parts, each step\'s arrows and parts under its heading', ()=>{
    const page = '# Run\n<!-- nodes\npage 0 0 Page\nengine 1 0 Engine thread\ncork 0 1 cork\n-->\n'
        + '```\n### not a step\n```\n### 1. Start\n<!-- step: page>engine -->\nText.\n'
        + '### 2. Run\n<!-- step: engine>cork, page -->\n';
    const walk = walkthrough(page);
    assert.deepEqual(walk?.nodes.map(node=>[node.id, node.col, node.row, node.label]),
        [['page', 0, 0, 'Page'], ['engine', 1, 0, 'Engine thread'], ['cork', 0, 1, 'cork']]);
    assert.deepEqual(walk?.steps, [
        { anchor: '1-start', title: '1. Start', nodes: ['page', 'engine'],
            edges: [['page', 'engine']] },
        { anchor: '2-run', title: '2. Run', nodes: ['engine', 'cork', 'page'],
            edges: [['engine', 'cork']] },
    ]);
    assert.equal(walkthrough('# No walk\n'), null);
    assert.throws(()=>walkthrough(`${page}### 3. Odd\n<!-- step: page>gpu -->\n`), /names gpu/);
});

test('the project graph is read from the tree, and a line to no part fails', async()=>{
    const block = 'node page | Page | The browser page.\nlink page > worker/engine\n';
    const { nodes, links } = await projectGraph(ROOT, block);
    const ids = new Set(nodes.map(node=>node.id));
    for (const id of ['core', 'cork', 'core/win32', 'core/win32/user32', 'core/graphics/gdi',
        'cork/emit', 'worker/engine', 'worker/translator', 'page'])
    {
        assert.ok(ids.has(id), `${id} is a part`);
    }
    assert.ok(!ids.has('core/win32/common') && !ids.has('core/cpu/internal'), 'workings left out');
    const has = (/** @type {string} */ a, /** @type {string} */ b, /** @type {string} */ kind)=>
        links.some(link=>link.source === a && link.target === b && link.kind === kind);
    assert.ok(has('core/win32', 'core/bridge', 'requires'), 'a layer requires what its module says');
    assert.ok(has('core/win32', 'core/win32/user32', 'holds'));
    assert.ok(has('cork', 'worker/translator', 'holds'), 'a worker is held where its file is');
    assert.ok(has('page', 'worker/engine', 'runs'));
    await assert.rejects(projectGraph(ROOT, 'link page > core/gpu\n'), /reaches page|reaches core\/gpu/);
});
