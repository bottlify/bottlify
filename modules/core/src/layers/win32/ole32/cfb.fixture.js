/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A compound file written by the Windows implementation of structured
 * storage, for the reader tests: a root with a class and state bits, a
 * stream short enough for the mini stream and one long enough for its own
 * sectors, nine more so the sibling tree has depth, a nested storage with a
 * class of its own, and inside it a stream and a second storage holding an
 * empty stream. Deflated, because a docfile is mostly padding.
 *
 * What it holds, as the writer made it:
 *   Small          100 bytes, byte i = i
 *   Big           5000 bytes, byte i = (i * 7) & 0xff
 *   n1 .. n9      n zero bytes each
 *   Sub            storage, class {0000000B-0000-0000-C000-000000000046}
 *     inner        1, 2, 3
 *     Deeper       storage
 *       empty      0 bytes
 * Root class {12345678-9ABC-DEF0-1234-56789ABCDEF0}, state bits 5.
 */

import { inflateSync } from 'node:zlib';

const PACKED = [
    'eNq7cF7wwcKNUg8Z0IAdAzPDv/+cDGxIYoxQDAYCDAxMUP6/////w4T/j4IhBf7+//+fDxqHggwMDKwMDOA4Z2dgYO',
    'BgYGDgZGBg4GJgYOBmYGDgYWBg4IWq5YckATD732gwDlkQxJDPkM9QwqDA4MqQx1DCUMRQyUAKEGNghed5UDqpCDMR',
    '2jPrwz0hk7CKWXvufWBFUpsgoa3V63yXkRnEYYaIBTPkMiQy5DDkMJAHeBiYGJH9Q6y+FCjtxJDJkM5APuBgYGLkRy',
    'r3iNHDAtTXIQzzfylDEkX2M8LLYRZoPgWBAxDKDTncYTQDWpkOy8PE4FEwvAADIxMzCysbOwcnFzcPLx+/gKCQsIio',
    'mLiEpJS0jKycvIKikrKKqpq6hqaWto6unr6BoZGxiamZuYWllbWNrZ29g6OTs4urm7uHp5e3j6+ff0BgUHBIaFh4RG',
    'RUdExsXHxCYlIyvvTLyMTMMAoGELDzicooaxla2Lv5hkQnZRaU17X2TJ61cMX6bXuPnL5088Hzd1//MHMJSsir6ZpY',
    'O3kGhMel5hRXNXb0T5u7ZPWmnQeOn7t65/Grjz/+s/GKSCtpGpjbufoERyVm5JfVtnRPmrlg+bqtew6funjj/rO3X3',
    '4zcQqIy6nqGFs5eviHxaZkF1U2tPdNnbN41cYd+4+dvXL70csP3/+x8ghLKWrom9m6eAdFJqTnldY0d02cMX/Z2i27',
    'D528cP3e0zeffzFy8IvJqmgbWTq4+4XGJGcVVtS39U6ZvWjlhu37jp65fOvhi/ff/rJwC0kqqOuZ2jh7BUbEp+WWVD',
    'd1Tpg+b+mazbsOnjh/7e6T159+jvp/1P+j/h/1/6j/R/0/6v9R/4/6f9T/o/4f9f+o/0f9P+r/Uf+P+n/U//Tw/0AN',
    '/2Uy5DHkMaQyFFE4/8IKnQMhRg8TYvqHwYUhlSGVoYBsF/AxMMLnXthwqME3/5HKkMtQwFBC4qwXZfNPyPPleQyGFM',
    'UfGxn2MyPN4+cxGFFsPzt0npiU+S8muP3GdPc/K1L6y2Mwodh+DnA6JN7/bNAwgNhvSnf/s0PDAGK/GaX2g+cceUnw',
    'Pwc0DCD2m9Pd/5zQMIDYb0Gx/TzQ9ESs/VzQMIDYb0lx+JPqf25oGIyCUQAAIT79eQ==',
].join('');

/** @returns {Uint8Array} the file's bytes */
export function windowsFixture(){
    return new Uint8Array(inflateSync(Buffer.from(PACKED, 'base64')));
}
