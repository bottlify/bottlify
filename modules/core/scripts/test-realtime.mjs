/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The tests that time what a page hears or sees against a clock - a worklet
 * taking sound a block at a time, the engine meeting its deadlines - run here,
 * one after another, where nothing else takes the processor from them: beside
 * the rest of the integration tests a gap was the neighbours', not the
 * engine's. In the parallel run they are skipped, saying they run here.
 */

import { spawnSync } from 'node:child_process';

const FILES = ['src/sound-delivery.itest.js'];
const run = spawnSync(process.execPath,
    ['--test', '--test-concurrency=1', '--test-timeout=1200000', ...FILES],
    { stdio: 'inherit', env: { ...process.env, BOTTLIFY_REALTIME: '1' } });
process.exit(run.status ?? 1);
