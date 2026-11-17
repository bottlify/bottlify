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
 * @property {() => 'frame' | 'end'} decode   The picture, by one frame.
 * @property {() => 'audio' | 'end'} decodeAudio
 *           The sound, on its own and by as much as the decoder holds: a file
 *           may lay its sound out seconds behind its picture, and it is read as
 *           far ahead as a device needs without decoding the picture there.
 * @property {() => Uint8Array | null} frame
 *           The current frame as BGRA. A view into the decoder's own memory,
 *           valid until the next call into it.
 * @property {() => Int16Array | null} readAudio
 *           Whatever PCM the decoder is holding, and null when it holds none.
 * @property {() => void} close
 */

export {};
