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
import { build, graphSvg, htmlOf, navigation, rows } from './site.mjs';

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
