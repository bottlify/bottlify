#!/usr/bin/env node
/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Writes UI Automation's identifiers as UiaLookupId answers them: each GUID
 * a property, pattern, event, control type, text attribute, landmark,
 * annotation, change or style is named by, and the number it has.
 *
 *   node tools/uia-ids.mjs <include dir> [out]
 *
 * The include directory holds the SDK's uiautomationcoreapi.h (the GUIDs,
 * `DEFINE_GUID(<Name>_<Kind>_GUID, ...)`) and uiautomationclient.h (the
 * numbers, `#define UIA_<Name><Kind>Id (n)`); mingw-w64's are what this was
 * written against. The two are joined by name, underscores and case aside.
 * A GUID with no number, or a number with no GUID, is listed on stderr.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [dir, out = 'modules/core/src/layers/win32/uiautomationcore/ids.js'] = process.argv.slice(2);
if (!dir)
{
    console.error('usage: node tools/uia-ids.mjs <include dir> [out]');
    process.exit(2);
}

/** AutomationIdentifierType, and how each kind is spelled in the two headers. */
const KINDS = [
    { type: 0, guid: 'Property', id: 'PropertyId' },
    { type: 1, guid: 'Pattern', id: 'PatternId' },
    { type: 1, guid: 'Pattern2', id: 'Pattern2Id' },
    { type: 2, guid: 'Event', id: 'EventId' },
    { type: 3, guid: 'Control', id: 'ControlTypeId' },
    { type: 4, guid: 'Attribute', id: 'AttributeId' },
    { type: 5, guid: 'LandmarkType', id: 'LandmarkTypeId' },
    { type: 6, guid: 'AnnotationType', id: 'AnnotationTypeId' },
    { type: 7, guid: 'Changes', id: 'ChangeId' },
    { type: 8, guid: 'StyleId', id: 'StyleId' },
];
/** Names the headers spell two ways. */
const SPELLED = new Map([['tranform', 'transform']]);
/** GUIDs whose name is not the number's. */
const RENAMED = new Map([['NewNativeWindowHandle', 'NativeWindowHandle'],
    ['GridItem_Parent', 'GridItemContainingGrid']]);

const key = (/** @type {string} */ name)=>{
    let text = name.replace(/_/g, '').toLowerCase();
    for (const [wrong, right] of SPELLED)
    {
        text = text.replace(wrong, right);
    }
    return text;
};

const guids = readFileSync(join(dir, 'uiautomationcoreapi.h'), 'utf8');
const ids = readFileSync(join(dir, 'uiautomationclient.h'), 'utf8')
    + readFileSync(join(dir, 'uiautomationcoreapi.h'), 'utf8');

/** @type {Map<string, number>} */
const numbers = new Map();
for (const [, name, value] of ids.matchAll(/#define\s+UIA_(\w+?Id)\s+\(?\s*(\d+)\s*\)?/g))
{
    numbers.set(key(name), Number(value));
}

const hex = (/** @type {string} */ value, /** @type {number} */ width)=>
    Number(value).toString(16).toUpperCase().padStart(width, '0');

/** @type {[number, string, number, string][]} */
const rows = [];
const used = new Set();
for (const [, name, body] of guids.matchAll(/DEFINE_GUID\(\s*(\w+)_GUID\s*,([^)]*)\)/g))
{
    const words = body.split(',').map(word=>word.trim());
    const text = `{${hex(words[0], 8)}-${hex(words[1], 4)}-${hex(words[2], 4)}-`
        + `${words.slice(3, 5).map(word=>hex(word, 2)).join('')}-`
        + `${words.slice(5).map(word=>hex(word, 2)).join('')}}`;
    const kind = [...KINDS].sort((a, b)=>b.guid.length - a.guid.length)
        .find(entry=>name.endsWith(`_${entry.guid}`));
    if (!kind)
    {
        console.error(`no kind: ${name}`);
        continue;
    }
    const written = name.slice(0, -kind.guid.length - 1);
    const stem = RENAMED.get(written) ?? written;
    // An event's GUID may carry "Event" in its own name too (Text_TextChangedEvent).
    const spelled = [stem + kind.id, stem.replace(/Event$/, '') + kind.id]
        .find(each=>numbers.has(key(each))) ?? stem + kind.id;
    const id = numbers.get(key(spelled));
    if (id === undefined)
    {
        console.error(`no number: ${name}`);
        continue;
    }
    used.add(key(spelled));
    rows.push([kind.type, text, id, name]);
}
for (const name of numbers.keys())
{
    if (!used.has(name))
    {
        console.error(`no GUID: ${name}`);
    }
}
rows.sort((a, b)=>a[0] - b[0] || a[2] - b[2]);

const lines = [
    '/*',
    ' * Copyright © 2026 Bottlify Project',
    ' * Licensed under the Mozilla Public License, version 2.0',
    ' * See LICENSE for details',
    ' */',
    '',
    '// Written by tools/uia-ids.mjs from the SDK headers; do not edit.',
    '',
    '/**',
    ' * UI Automation\'s identifiers: [AutomationIdentifierType, GUID, number],',
    ' * the type 0 property, 1 pattern, 2 event, 3 control type, 4 text',
    ' * attribute, 5 landmark, 6 annotation, 7 change, 8 style.',
    ' *',
    ' * @type {ReadonlyArray<readonly [number, string, number]>}',
    ' */',
    'export const UIA_IDS = Object.freeze([',
    ...rows.flatMap(([type, text, id, name])=>{
        const row = `    [${type}, '${text}', ${id}],`;
        return row.length + name.length + 4 <= 100 ? [`${row} // ${name}`]
            : [`    // ${name}`, row];
    }),
    ']);',
    '',
];
writeFileSync(out, lines.join('\n'));
console.log(`${rows.length} identifiers written to ${out}`);
