/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The Direct3D 8 and 9 tests, every device of them a recorded one with its
 * played twin behind it (`graphics/remote/loopback.js`): what passes so is
 * a call, an answer and a guest byte the replay carries as the device alone
 * would have made them.
 *
 *     node --import ./tools/graphics-loopback/register.mjs --test \
 *         "modules/core/src/layers/graphics/d3d9/*.test.js"
 *
 * One test sees the twin: `recorded: an unlocked buffer is read through a
 * window, not a copy` counts the reads of its own memory's window, and the
 * played device reads the bytes it was sent instead.
 */

import { register } from 'node:module';

register('./hooks.mjs', import.meta.url);
