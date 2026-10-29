/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ZONE_KEYS, zoneForYear, zoneNames } from './timezones.js';

/**
 * A zone's year as the fields Windows answers: the biases, and each
 * transition's month and day.
 *
 * @param {string} key @param {number} year
 */
const rules = (key, year)=>{
    const bytes = zoneForYear(key, year);
    assert.ok(bytes !== null, key);
    const view = new DataView(bytes.buffer);
    return {
        bias: view.getInt32(0, true),
        standardBias: view.getInt32(84, true),
        daylightBias: view.getInt32(168, true),
        standard: [view.getUint16(70, true), view.getUint16(74, true)],
        daylight: [view.getUint16(154, true), view.getUint16(158, true)],
    };
};

test('a year with daylight time has the smaller offset standard, the larger daylight', ()=>{
    // Wine's time.c test_GetTimeZoneInformationForYear, as Windows 10 answers it.
    assert.deepEqual(rules('Greenland Standard Time', 2015), { bias: 180, standardBias: 0,
        daylightBias: -60, standard: [10, 24], daylight: [3, 28] });
    assert.deepEqual(rules('Easter Island Standard Time', 2014), { bias: 360, standardBias: 0,
        daylightBias: -60, standard: [4, 26], daylight: [9, 6] });
});

test('two daylight periods are one, first start to last end; midnight is the day before', ()=>{
    assert.deepEqual(rules('Egypt Standard Time', 2014), { bias: -120, standardBias: 0,
        daylightBias: -60, standard: [9, 25], daylight: [5, 15] });
});

test('a year without a change has none; a move for good is "daylight" from 1 January', ()=>{
    assert.deepEqual(rules('Egypt Standard Time', 2013), { bias: -120, standardBias: 0,
        daylightBias: -60, standard: [0, 0], daylight: [0, 0] });
    assert.deepEqual(rules('Easter Island Standard Time', 2015).bias, 300);
    assert.deepEqual(rules('Altai Standard Time', 2016), { bias: -420, standardBias: 0,
        daylightBias: 60, standard: [3, 27], daylight: [1, 1] });
});

test('only Windows\' keys are zones, listed in their order, named by their key', ()=>{
    assert.equal(zoneForYear('Greenland Daylight Time', 2015), null);
    assert.ok(ZONE_KEYS.includes('UTC'));
    assert.deepEqual([...ZONE_KEYS].sort(), ZONE_KEYS);
    assert.deepEqual(zoneNames('Greenland Standard Time'),
        { standard: 'Greenland Standard Time', daylight: 'Greenland Daylight Time' });
    assert.deepEqual(zoneNames('UTC-11'), { standard: 'UTC-11', daylight: 'UTC-11' });
});
