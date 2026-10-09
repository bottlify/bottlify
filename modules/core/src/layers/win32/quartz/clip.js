/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a filter graph plays, as the media layer hands it over: the graph's
 * window and its source filter both read one, so it is described once here.
 */

/**
 * @typedef {Object} VideoClip
 * @property {number} width
 * @property {number} height
 * @property {number} fps
 * @property {number} frameCount
 * @property {boolean} hasVideo
 * @property {boolean} hasAudio
 * @property {number} sampleRate  The film's own rate, not the device's.
 * @property {number} channels
 * @property {() => 'frame' | 'audio' | 'end'} decode
 * @property {() => Uint8Array | null} frame
 *           The current frame as BGRA. A view into the decoder's own memory,
 *           valid until the next call into it.
 * @property {(() => Int16Array | null) | undefined} [readAudio]
 *           Whatever PCM the decoder is holding, and null when it holds none.
 *           `decode` stops early to have this taken, and it is also read on its
 *           own to take what the decoder has not stopped for yet.
 * @property {() => void} close
 */

export {};
