/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check } from './check.mjs';
import { headings, links } from './markdown.mjs';

/** @param {Record<string, string>} files */
function tree(files){
    const root = mkdtempSync(join(tmpdir(), 'docs-check-'));
    for (const [path, text] of Object.entries(files))
    {
        mkdirSync(join(root, path, '..'), { recursive: true });
        writeFileSync(join(root, path), text);
    }
    return root;
}

test('headings take GitHub\'s anchors, a repeated one numbered, code skipped', ()=>{
    const page = '# Inside `cork`\n## 5. cork, the core\n'
        + '```\n# not a heading\n```\n## Notes\n## Notes\n';
    assert.deepEqual(headings(page).map(heading=>heading.anchor),
        ['inside-cork', '5-cork-the-core', 'notes', 'notes-1']);
});

test('links outside code are read, inside code they are not', ()=>{
    const page = 'See [a](a.md#x) and `[b](b.md)`.\n```\n[c](c.md)\n```\n<img src="p.svg">\n';
    assert.deepEqual(links(page).map(link=>link.url), ['a.md#x', 'p.svg']);
});

test('a sound tree passes, and each kind of break is named', ()=>{
    const good = {
        'README.md': '[docs](docs/README.md)\n',
        'docs/README.md': '- [A](a.md)\n- [B](sub/b.md)\n',
        'docs/a.md': '# A\n## Part one\nSee [B](sub/b.md#end).\n',
        'docs/sub/b.md': '# B\n## End\nBack to [part one](../a.md#part-one).\n',
    };
    const root = tree(good);
    try
    {
        assert.deepEqual(check(root), []);
        writeFileSync(join(root, 'docs/a.md'), '# A\n## Part one\nSee [B](sub/b.md#start) and [C](c.md).\n');
        writeFileSync(join(root, 'docs/stray.md'), '# Stray\n');
        writeFileSync(join(root, 'README.md'),
            '[gone](https://github.com/bottlify/bottlify/blob/main/docs/gone.md)\n');
        const problems = check(root);
        assert.equal(problems.length, 4, problems.join('\n'));
        assert.match(problems.join('\n'), /no heading #start in docs\/sub\/b\.md/);
        assert.match(problems.join('\n'), /c\.md: no such file/);
        assert.match(problems.join('\n'), /gone\.md: no such file/);
        assert.match(problems.join('\n'), /docs\/stray\.md: not in docs\/README\.md/);
    }
    finally
    {
        rmSync(root, { recursive: true, force: true });
    }
});
