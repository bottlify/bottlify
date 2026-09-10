/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * One browser, many sessions: a lease that serialises everything driving the
 * live browser on port 9333.
 *
 * A person watches that browser, so two scripts navigating it at once would
 * ruin both runs and the watching. Every run that drives the page goes through
 * here:
 *
 *   node tools/cdp_test/lease.mjs <who> -- node tools/cdp_test/watch.mjs 60
 *
 * It waits for the holder to finish, runs the command, and releases even when
 * the command fails. A lease older than the hold limit is taken over, because a
 * script that was killed must not block the queue for ever.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIRECTORY = join(tmpdir(), 'bottlify-browser-lease');
const HOLD_MS = 10 * 60 * 1000;
const WAIT_MS = 45 * 60 * 1000;

/** @param {number} ms */
const sleep = ms=>new Promise(resolve=>setTimeout(resolve, ms));

const argv = process.argv.slice(2);
const separator = argv.indexOf('--');
const who = (separator === -1 ? argv : argv.slice(0, separator)).join(' ') || 'anonymous';
const command = separator === -1 ? [] : argv.slice(separator + 1);
if (command.length === 0)
{
    console.error('usage: lease.mjs <who> -- <command...>');
    process.exit(2);
}

/** Who holds the lease, as far as the file says. @returns {string} */
const holder = ()=>{
    try
    {
        return JSON.parse(readFileSync(join(DIRECTORY, 'who.json'), 'utf8')).who;
    }
    catch {
        return 'someone';
    }
};

// The directory is the lock: creating one is atomic, so whoever creates it wins
// and everyone else sees the failure rather than a half-written file.
const deadline = Date.now() + WAIT_MS;
for (;;)
{
    try
    {
        mkdirSync(DIRECTORY);
        break;
    }
    catch {
        if (Date.now() - statSync(DIRECTORY).mtimeMs > HOLD_MS)
        {
            console.error(`lease: taking over a stale lease held by ${holder()}`);
            rmSync(DIRECTORY, { recursive: true, force: true });
            continue;
        }
        if (Date.now() > deadline)
        {
            console.error('lease: gave up waiting');
            process.exit(3);
        }
        console.error(`lease: browser busy (${holder()}), waiting...`);
        await sleep(5000);
    }
}
writeFileSync(join(DIRECTORY, 'who.json'),
    JSON.stringify({ who, pid: process.pid, since: new Date().toISOString() }));
console.error(`lease: acquired by ${who}`);

const release = ()=>{
    try
    {
        rmSync(DIRECTORY, { recursive: true, force: true });
    }
    catch {
        // Already gone: a takeover removed it, which is not this run's problem.
    }
};

process.on('exit', release);
for (const signal of ['SIGINT', 'SIGTERM'])
{
    process.on(signal, ()=>{
        release();
        process.exit(130);
    });
}

const child = spawn(command[0], command.slice(1),
    { stdio: 'inherit', shell: process.platform === 'win32' });
const code = await new Promise(resolve=>child.on('exit', status=>resolve(status ?? 1)));
release();
console.error(`lease: released by ${who}`);
process.exit(code);
