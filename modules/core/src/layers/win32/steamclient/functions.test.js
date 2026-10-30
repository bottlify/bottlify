/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { announceSteamClient, createSteamclientFunctions } from './functions.js';
import { INTERFACES } from './interfaces.js';
import { createHive } from '../advapi32/registry.js';
import { createRegistryService } from '../advapi32/registry-service.js';

const ACCOUNT = { steamId: '76561197960287930', accountName: 'someone', apps: [400, 620],
    appId: 620 };

/** A guest of plain memory, and a Steam client over it whose placed methods are kept by address. */
function fixture(account = /** @type {any} */ (ACCOUNT)){
    const bytes = new Uint8Array(0x100000);
    const view = new DataView(bytes.buffer);
    let next = 0x1000;
    /** @type {Map<number, { name: string, fn: any }>} */
    const placed = new Map();
    let stub = 0x80000;
    /** @type {number[]} */
    const highs = [];
    const fns = createSteamclientFunctions({
        readMemory: (at, length)=>bytes.subarray(at, at + length),
        writeMemory: (at, data)=>bytes.set(data, at),
        readCString: (at, max)=>{
            let end = at;
            while (end - at < max && bytes[end] !== 0)
            {
                end++;
            }
            return new TextDecoder().decode(bytes.subarray(at, end));
        },
        allocate: size=>{
            const at = next;
            next += (size + 15) & ~15;
            return at;
        },
        register: (name, fn)=>{
            stub += 16;
            placed.set(stub, { name, fn });
            return stub;
        },
        answerHigh: high=>highs.push(high),
        environment: ()=>null,
        account,
    });
    /** @param {string} text */
    const put = text=>{
        const at = next;
        bytes.set(new TextEncoder().encode(`${text}\0`), at);
        next += text.length + 16;
        return at;
    };
    /** The method in a slot of an object's vtable. @param {number} object @param {number} index */
    const method = (object, index)=>{
        const table = view.getUint32(object, true);
        return /** @type {{ name: string, fn: any }} */ (
            placed.get(view.getUint32(table + index * 4, true)));
    };
    return { fns, view, put, method, highs };
}

test('CreateInterface answers a version the SDK declares, laid out as its header is', ()=>{
    const { fns, put, method, view } = fixture();
    const code = 0x9000;
    const client = fns.CreateInterface.handler([put('SteamClient020'), code]);
    assert.notEqual(client, 0);
    assert.equal(view.getUint32(code, true), 0, 'found');
    const slots = INTERFACES.SteamClient020.split(',');
    // The deprecated callback slots, a function pointer's parentheses and all,
    // keep the slots after them where the header has them.
    assert.equal(method(client, slots.indexOf('GetISteamVideo:12:i')).name,
        'SteamClient020.GetISteamVideo');
    assert.equal(method(client, 0).fn.convention, 'thiscall');
    assert.equal(fns.CreateInterface.handler([put('SteamNothing999'), code]), 0);
    assert.equal(view.getUint32(code, true), 1, 'none');
});

test('no account signed in, no client', ()=>{
    const { fns, put } = fixture(null);
    assert.equal(fns.CreateInterface.handler([put('SteamClient020'), 0]), 0);
});

test('a private method keeps its slot: GetAppID is the tenth of SteamUtils010', ()=>{
    // STEAM_PRIVATE_API( GetCSERIPPort ) sits before it; dropped, every later
    // slot is one early and steam_api reads the wrong method as the app id.
    const { fns, put, method } = fixture();
    const client = fns.CreateInterface.handler([put('SteamClient020'), 0]);
    const generic = method(client, INTERFACES.SteamClient020.split(',')
        .findIndex(entry=>entry.startsWith('GetISteamGenericInterface:')));
    const utils = generic.fn.handler([client, 1, 1, put('SteamUtils010')]);
    const appId = method(utils, 9);
    assert.equal(appId.name, 'SteamUtils010.GetAppID');
    assert.equal(appId.fn.handler([utils]), 620);
});

test('GetSteamID returns the class through the hidden pointer the caller pushed', ()=>{
    const { fns, put, method, view } = fixture();
    const client = fns.CreateInterface.handler([put('SteamClient020'), 0]);
    const user = method(client, 5).fn.handler([client, 1, 1, put('SteamUser021')]);
    const getSteamId = method(user, 2);
    assert.equal(getSteamId.name, 'SteamUser021.GetSteamID');
    assert.equal(getSteamId.fn.argBytes, 8, 'this and the hidden pointer');
    const out = 0xa000;
    assert.equal(getSteamId.fn.handler([user, out]), out);
    assert.equal(view.getBigUint64(out, true), 76561197960287930n);
});

test('an app is owned only when the account\'s licences grant it', ()=>{
    const { fns, put, method } = fixture();
    const client = fns.CreateInterface.handler([put('SteamClient020'), 0]);
    const apps = method(client, 15).fn.handler([client, 1, 1,
        put('STEAMAPPS_INTERFACE_VERSION008')]);
    const slots = INTERFACES.STEAMAPPS_INTERFACE_VERSION008.split(',');
    const subscribed = method(apps, slots.findIndex(entry=>entry.startsWith('BIsSubscribedApp:')));
    assert.equal(subscribed.fn.handler([apps, 620]), 1);
    assert.equal(subscribed.fn.handler([apps, 70]), 0, 'not granted');
    assert.equal(method(apps, 0).fn.handler([apps]), 1, 'BIsSubscribed: the app running');
});

test('a method returning eight bytes answers the high half in EDX', ()=>{
    const { fns, put, method, highs } = fixture();
    const client = fns.CreateInterface.handler([put('SteamClient020'), 0]);
    const user = method(client, 5).fn.handler([client, 1, 1, put('SteamUser021')]);
    const slots = INTERFACES.SteamUser021.split(',');
    const ticket = method(user,
        slots.findIndex(entry=>entry.startsWith('RequestEncryptedAppTicket:')));
    assert.equal(ticket.fn.argBytes, 12);
    assert.equal(ticket.fn.handler([user, 0, 0]), 0, 'not answered: zero');
    assert.deepEqual(highs, [0]);
});

test('RequestCurrentStats leaves a UserStatsReceived_t for the game to pump', ()=>{
    const { fns, put, method, view } = fixture();
    const client = fns.CreateInterface.handler([put('SteamClient020'), 0]);
    const stats = method(client, 13).fn.handler([client, 1, 1,
        put('STEAMUSERSTATS_INTERFACE_VERSION012')]);
    assert.equal(method(stats, 0).fn.handler([stats]), 1);
    const out = 0xb000;
    assert.equal(fns.Steam_BGetCallback.handler([1, out, 0]), 1);
    assert.equal(view.getInt32(out + 4, true), 1101);
    const data = view.getUint32(out + 8, true);
    assert.equal(view.getBigUint64(data, true), 620n, 'the game');
    assert.equal(view.getUint32(data + 8, true), 1, 'k_EResultOK');
    assert.equal(fns.Steam_BGetCallback.handler([1, out, 0]), 0, 'and nothing more');
});

test('a running client is announced as Steam writes it: its pid and its library', ()=>{
    const hive = createRegistryService(createHive());
    announceSteamClient(hive, { pid: 0x2040, account: ACCOUNT });
    const active = /** @type {number} */ (hive.open(/** @type {number} */ (
        hive.root(0x80000001)), 'Software\\Valve\\Steam\\ActiveProcess'));
    /** @param {string} name */
    const value = name=>/** @type {{ data: Uint8Array }} */ (hive.getValue(active, name)).data;
    assert.equal(new DataView(value('pid').buffer).getUint32(0, true), 0x2040);
    assert.equal(new TextDecoder().decode(value('SteamClientDll')),
        'C:\\Program Files (x86)\\Steam\\steamclient.dll\0', 'narrow, as the hive keeps a string');
});

test('a method a PlayStation 3 build alone has is no slot of the Windows vtable', ()=>{
    // GetISteamPS3OverlayRender sits under #ifdef _PS3 in SteamClient012's
    // header; counted, every later slot is one late, and steam_api's call for
    // HTTP lands on it with its three arguments left on the stack.
    const slots = INTERFACES.SteamClient012.split(',').map(entry=>entry.split(':')[0]);
    assert.equal(slots.includes('GetISteamPS3OverlayRender'), false);
    assert.equal(slots.indexOf('GetISteamHTTP'), slots.indexOf('BShutdownIfAllPipesClosed') + 1);
});
