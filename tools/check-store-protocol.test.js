/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storeProtocolIssues } from './check-store-protocol.mjs';

/** @param {Record<string, string>} files */
function issuesOf(files){
    const dir = mkdtempSync(join(tmpdir(), 'store-protocol-'));
    try
    {
        const paths = Object.entries(files).map(([name, code])=>{
            writeFileSync(join(dir, name), code);
            return join(dir, name);
        });
        return storeProtocolIssues(paths, dir);
    }
    finally
    {
        rmSync(dir, { recursive: true, force: true });
    }
}

test('a store\'s protocol in core or the launcher is found, in each of its shapes', ()=>{
    const found = issuesOf({
        'a.js': "import { logOn } from '../../bridge/src/stores/steam/session.js';",
        'b.js': 'const link = await connectCm({ endpoint });',
        'c.js': 'connection.send(EMsg.ClientLogon, ClientLogon, body);',
        'd.js': "fetch('https://api.steampowered.com/ISteamDirectory/GetCMListForConnect/v1/');",
        'e.js': ['const ws = new WebSocket(`wss://$', '{host}/cmsocket/`);'].join(''),
        'f.js': "call('Authentication.BeginAuthSessionViaQR#1')",
        'g.js': "call('ContentServerDirectory.GetManifestRequestCode#1')",
        'h.js': 'ask("steam.depotKey", { app, depot });',
        'i.js': ['ask(`steam.$', '{op}`, args);'].join(''),
    });
    assert.deepEqual(found.map(line=>line.split(' ')[0]),
        ['a.js', 'b.js', 'c.js', 'c.js', 'd.js', 'e.js', 'f.js', 'g.js', 'h.js', 'i.js']);
});

test('the store-neutral ops, a format, and words in a comment pass', ()=>{
    assert.deepEqual(issuesOf({
        'a.js': 'ask("download", { store: "steam", game: "70" });',
        'b.js': "import { manifest, downloadChunk } from '@bottlify/core/steam';",
        'c.js': '// the CM logon (ClientLogon, EMsg 5514) is GameHub\'s\nconst x = 1;',
        'd.js': '/* connectCm, steamserver.net */\nexport const y = "https://example.com/a";',
    }), []);
});
