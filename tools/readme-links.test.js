/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { absoluteLinks } from './readme-links.mjs';

const BLOB = 'https://github.com/bottlify/bottlify/blob/abc123';

test('relative links point at the repository from the package folder', ()=>{
    const out = absoluteLinks([
        '[how](../../docs/architecture.md#threads) and [ru](README.ru.md),',
        '[installer](../installer/README.md), [tools](../../tools/)',
        '<img src="logo.png" alt="">',
    ].join('\n'), 'modules/core', 'abc123');
    assert.equal(out, [
        `[how](${BLOB}/docs/architecture.md#threads) and [ru](${BLOB}/modules/core/README.ru.md),`,
        `[installer](${BLOB}/modules/installer/README.md), [tools](${BLOB}/tools)`,
        `<img src="${BLOB}/modules/core/logo.png" alt="">`,
    ].join('\n'));
});

test('absolute links, anchors and code are left alone', ()=>{
    const text = [
        '[site](https://bottlify.app) [mail](mailto:a@b.c) [below](#without-cork-v86)',
        '`[not](a/link.md)`',
        '```html\n<img src="x.png"> [y](z.md)\n```',
    ].join('\n');
    assert.equal(absoluteLinks(text, 'modules/core', 'abc123'), text);
});
