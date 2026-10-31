/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/** A session's token sealed at rest: what the database keeps holds no token. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newKey, seal, unseal } from './vault.js';

const TOKEN = 'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiI3NjU2MTE5Nzk2MDI2NTcyOSJ9.secret-signature';

test('a sealed session holds no token and opens with its unreadable key alone', async()=>{
    const key = await newKey();
    assert.equal(key.extractable, false);
    await assert.rejects(crypto.subtle.exportKey('raw', key));
    const session = { accountName: 'someone', id: 'a', refreshToken: TOKEN };
    const sealed = await seal(key, session);
    const kept = JSON.stringify(sealed, (_, one)=>(one instanceof Uint8Array
        ? new TextDecoder('latin1').decode(one) : one));
    assert.doesNotMatch(kept, /secret-signature|eyJ/);
    assert.deepEqual(Object.keys(sealed).sort(), ['accountName', 'id', 'iv', 'sealed']);
    assert.deepEqual(await unseal(key, sealed), session);
    await assert.rejects(unseal(await newKey(), sealed), 'another key opens nothing');
    const again = await seal(key, session);
    assert.notDeepEqual(again.iv, sealed.iv, 'a new nonce each time');
});
