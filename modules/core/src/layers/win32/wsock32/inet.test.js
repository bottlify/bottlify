/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatIpv6Text, parseIpv4Text, parseIpv6Text } from './inet.js';

test('IPv4 text is four decimal parts and nothing else', ()=>{
    assert.deepEqual([...(parseIpv4Text('192.168.1.10') ?? [])], [192, 168, 1, 10]);
    for (const bad of ['1.2.3', '1.2.3.256', '0x1.2.3.4', '1.2.3.4 ', '', '1..2.3'])
    {
        assert.equal(parseIpv4Text(bad), null, bad);
    }
});

test('IPv6 text reads in each form and writes in the canonical one', ()=>{
    const cases = [
        ['::', '::'],
        ['::1', '::1'],
        ['2001:DB8:0:0:0:0:2:1', '2001:db8::2:1'],
        ['2001:db8:0:1:1:1:1:1', '2001:db8:0:1:1:1:1:1'],
        ['2001:0:0:1:0:0:0:1', '2001:0:0:1::1'],
        ['fe80:0:0:0:1::', 'fe80::1:0:0:0'],
        ['::ffff:192.0.2.1', '::ffff:192.0.2.1'],
        ['1:2:3:4:5:6:7:8', '1:2:3:4:5:6:7:8'],
    ];
    for (const [text, canonical] of cases)
    {
        const bytes = parseIpv6Text(text);
        assert.ok(bytes, text);
        assert.equal(formatIpv6Text(bytes), canonical, text);
    }
    for (const bad of ['1::2::3', '1:2:3:4:5:6:7', '1:2:3:4:5:6:7:8:9', '12345::', 'g::',
        '1.2.3.4::', '::1.2.3', '1:2:3:4:5:6:7::8'])
    {
        assert.equal(parseIpv6Text(bad), null, bad);
    }
});
