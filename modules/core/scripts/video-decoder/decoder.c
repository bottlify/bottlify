/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 *
 * The C side of the video decoder: a narrow, handle-based surface over the
 * curated FFmpeg build produced by build-decoder.sh.
 *
 * Everything crossing this boundary is an int32 or a pointer into linear
 * memory, because the caller is JavaScript reading the module's memory
 * directly. Nothing here knows about a container format by name, and nothing
 * here knows what the pixels are for.
 *
 * Ownership: the caller allocates with media_alloc(), copies the whole file
 * in, and hands the pointer to media_open(), which takes it over. media_close()
 * frees it. Pixel and PCM buffers belong to the clip and stay valid until the
 * next media_decode() / media_audio_read() on that clip.
 *
 * A second way in needs no container: media_open_audio() names a codec by its
 * WAVE format tag and media_feed_audio() hands it one packet at a time, for a
 * caller that already has the stream cut into frames and wants each one
 * decoded inside the call that fed it. The bytes fed are copied and stay the
 * caller's. Both kinds of clip share the FIFO, media_audio_pending(),
 * media_audio_read() and media_close().
 */

#include <stdint.h>
#include <stdio.h>   /* SEEK_SET / SEEK_CUR / SEEK_END, for the seek callback */
#include <stdlib.h>
#include <string.h>

#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/channel_layout.h>
#include <libswresample/swresample.h>
#include <libswscale/swscale.h>

/* How many clips may be open at once. A program plays one cinematic at a time;
 * the spare slots cover a renderer that opens the next clip before closing the
 * one it is finishing. */
#define MEDIA_MAX_CLIPS 8

/* What avio reads through in one go. */
#define MEDIA_IO_BUFFER 32768

/* Decoded PCM held for the caller between drains: about 1.5 seconds of 44.1 kHz
 * stereo S16. Enough that a caller draining once per video frame never loses a
 * sample, small enough that a clip costs a quarter of a megabyte. */
#define MEDIA_AUDIO_FIFO 262144

/* Nothing legitimate in this era is larger, and these numbers come out of a
 * container that may be malformed: they size an allocation, so they are bounded
 * here rather than trusted. */
#define MEDIA_MAX_DIMENSION 8192

/* media_decode() outcomes. */
#define MEDIA_FRAME      0  /* a video frame is ready in the pixel buffer */
#define MEDIA_END        1  /* the stream is exhausted */
#define MEDIA_AUDIO_FULL 2  /* stopped early: drain the audio and call again */

/* Failures. Distinct codes because "it did not open" is the question a bring-up
 * spends the most time on, and the answer should not need a rebuild to get. */
#define MEDIA_ERR_HANDLE (-1)
#define MEDIA_ERR_MEMORY (-2)
#define MEDIA_ERR_LIMIT  (-3)
#define MEDIA_ERR_FORMAT (-4)
#define MEDIA_ERR_STREAM (-5)
#define MEDIA_ERR_CODEC  (-6)
#define MEDIA_ERR_ARGUMENT (-7)
/* The FIFO could not take everything a feed produced: the rest is held inside
 * the resampler and comes out with the next feed or flush, once the caller has
 * read. Only reachable when a caller leaves more than MEDIA_AUDIO_FIFO minus
 * one frame pending between feeds, which the FIFO is sized to make unlikely:
 * the largest Layer 3 frame is 1152 stereo S16 samples, 4608 bytes. */
#define MEDIA_ERR_FULL   (-8)

/* Fields media_info() writes, in order. Mirrored on the JavaScript side. */
#define MEDIA_INFO_FIELDS 12
enum {
    INFO_WIDTH = 0,
    INFO_HEIGHT,
    INFO_PIXEL_FORMAT,
    INFO_CODEC_ID,
    INFO_FOURCC,
    INFO_FRAME_COUNT,
    INFO_FPS_NUM,
    INFO_FPS_DEN,
    INFO_SAMPLE_RATE,
    INFO_CHANNELS,
    INFO_HAS_VIDEO,
    INFO_HAS_AUDIO
};

typedef struct {
    const uint8_t *data;
    int size;
    int pos;
} MemorySource;

typedef struct {
    int used;

    uint8_t *input;
    MemorySource source;
    AVIOContext *io;
    AVFormatContext *format;

    int videoStream;
    int audioStream;

    AVCodecContext *video;
    AVFrame *frame;
    struct SwsContext *scaler;
    uint8_t *pixels;
    int width;
    int height;

    AVCodecContext *audio;
    AVFrame *audioFrame;
    struct SwrContext *resampler;
    uint8_t *fifo;
    int fifoLength;
    int sampleRate;
    int channels;
} Clip;

static Clip clips[MEDIA_MAX_CLIPS];
static int initialized;

void media_close(int32_t id);

static Clip *clipOf(int32_t id){
    if (id < 0 || id >= MEDIA_MAX_CLIPS || !clips[id].used)
    {
        return NULL;
    }
    return &clips[id];
}

static int readSource(void *opaque, uint8_t *buffer, int wanted){
    MemorySource *source = (MemorySource *)opaque;
    int available = source->size - source->pos;
    if (available <= 0)
    {
        return AVERROR_EOF;
    }
    if (wanted > available)
    {
        wanted = available;
    }
    memcpy(buffer, source->data + source->pos, (size_t)wanted);
    source->pos += wanted;
    return wanted;
}

static int64_t seekSource(void *opaque, int64_t offset, int whence){
    MemorySource *source = (MemorySource *)opaque;
    int64_t target;
    if (whence == AVSEEK_SIZE)
    {
        return source->size;
    }
    if (whence == SEEK_SET)
    {
        target = offset;
    }
    else if (whence == SEEK_CUR)
    {
        target = source->pos + offset;
    }
    else if (whence == SEEK_END)
    {
        target = source->size + offset;
    }
    else
    {
        return AVERROR(EINVAL);
    }
    if (target < 0 || target > source->size)
    {
        return AVERROR(EINVAL);
    }
    source->pos = (int)target;
    return target;
}

/* Converts everything swr still holds, plus `input` if given, straight into the
 * FIFO. Converting into the FIFO rather than through a scratch buffer is what
 * keeps this copy-free; the price is that a full FIFO leaves samples inside swr,
 * which is the point of MEDIA_AUDIO_FULL. */
static void drainResampler(Clip *clip, AVFrame *input){
    const int frameBytes = clip->channels * 2;
    for (;;)
    {
        int capacity = (MEDIA_AUDIO_FIFO - clip->fifoLength) / frameBytes;
        if (capacity <= 0)
        {
            return;
        }
        uint8_t *out = clip->fifo + clip->fifoLength;
        int converted = swr_convert(
            clip->resampler, &out, capacity,
            input ? (const uint8_t **)input->data : NULL,
            input ? input->nb_samples : 0);
        if (converted <= 0)
        {
            return;
        }
        clip->fifoLength += converted * frameBytes;
        input = NULL;
    }
}

/* A resampler built from the first frame that comes out rather than from what
 * was declared. The container path declares everything up front and builds
 * one at open; a packet-fed stream declares a rate and a channel count and the
 * sample format is the decoder's to choose, so it is not known until a frame
 * exists. The output side is the clip's own rate and channels either way. */
static int ensureResampler(Clip *clip, const AVFrame *frame){
    if (clip->resampler)
    {
        return 1;
    }
    AVChannelLayout layout;
    av_channel_layout_default(&layout, clip->channels);
    int built = swr_alloc_set_opts2(
        &clip->resampler,
        &layout, AV_SAMPLE_FMT_S16, clip->sampleRate,
        &frame->ch_layout, (enum AVSampleFormat)frame->format, frame->sample_rate,
        0, NULL);
    av_channel_layout_uninit(&layout);
    if (built < 0 || swr_init(clip->resampler) < 0)
    {
        swr_free(&clip->resampler);
        return 0;
    }
    return 1;
}

/* Every frame the audio decoder has ready, into the FIFO. */
static void receiveAudio(Clip *clip){
    while (avcodec_receive_frame(clip->audio, clip->audioFrame) == 0)
    {
        if (ensureResampler(clip, clip->audioFrame))
        {
            drainResampler(clip, clip->audioFrame);
        }
        av_frame_unref(clip->audioFrame);
    }
}

/* The pixel buffer follows the first decoded frame rather than the container's
 * header: a stream may declare nothing useful and only settle its dimensions
 * once a frame comes out. */
static int ensurePixels(Clip *clip, int width, int height){
    if (width <= 0 || height <= 0
        || width > MEDIA_MAX_DIMENSION || height > MEDIA_MAX_DIMENSION)
    {
        return 0;
    }
    if (clip->pixels && clip->width == width && clip->height == height)
    {
        return 1;
    }
    av_free(clip->pixels);
    clip->pixels = (uint8_t *)av_mallocz((size_t)width * (size_t)height * 4);
    if (!clip->pixels)
    {
        clip->width = 0;
        clip->height = 0;
        return 0;
    }
    clip->width = width;
    clip->height = height;
    return 1;
}

static int convertFrame(Clip *clip){
    AVFrame *frame = clip->frame;
    int ok = 0;
    if (ensurePixels(clip, frame->width, frame->height))
    {
        /* Source and destination are the same size, so the only work is the
         * pixel-format conversion and the resampling filter never runs: the
         * cheapest one is also the exact one. Cached rather than built at open
         * time because the decoder's pixel format is not always known before a
         * frame exists, and a stream may change it mid-way. */
        clip->scaler = sws_getCachedContext(
            clip->scaler,
            frame->width, frame->height, (enum AVPixelFormat)frame->format,
            frame->width, frame->height, AV_PIX_FMT_BGRA,
            SWS_POINT, NULL, NULL, NULL);
        if (clip->scaler)
        {
            uint8_t *planes[4] = { clip->pixels, NULL, NULL, NULL };
            int strides[4] = { clip->width * 4, 0, 0, 0 };
            sws_scale(clip->scaler,
                (const uint8_t *const *)frame->data, frame->linesize,
                0, frame->height, planes, strides);
            ok = 1;
        }
    }
    av_frame_unref(frame);
    return ok;
}

/** Reserves `bytes` of linear memory for the caller to copy a file into. */
void *media_alloc(int32_t bytes){
    if (bytes <= 0)
    {
        return NULL;
    }
    return malloc((size_t)bytes);
}

void media_free(void *block){
    free(block);
}

/**
 * Opens a container held in linear memory. Returns a clip id, or one of the
 * MEDIA_ERR_* codes.
 *
 * `data` becomes this module's, always -- on every failure as much as on
 * success. A caller that had to know which failures gave it back would leak on
 * the ones it got wrong.
 */
static void initialize(void){
    if (!initialized)
    {
        /* The browser console is not a log sink this project controls, and a
         * decoder that narrates every frame there drowns the one line that
         * matters. Failures still come back as return codes. */
        av_log_set_level(AV_LOG_ERROR);
        initialized = 1;
    }
}

/* A free slot, claimed, or MEDIA_ERR_LIMIT. */
static int32_t allocateClip(void){
    for (int i = 0; i < MEDIA_MAX_CLIPS; i++)
    {
        if (!clips[i].used)
        {
            Clip *clip = &clips[i];
            memset(clip, 0, sizeof(Clip));
            clip->used = 1;
            clip->videoStream = -1;
            clip->audioStream = -1;
            return i;
        }
    }
    return MEDIA_ERR_LIMIT;
}

int32_t media_open(uint8_t *data, int32_t size){
    initialize();
    if (!data || size <= 0)
    {
        free(data);
        return MEDIA_ERR_FORMAT;
    }

    int32_t id = allocateClip();
    if (id < 0)
    {
        free(data);
        return id;
    }

    Clip *clip = &clips[id];
    clip->input = data;
    clip->source.data = data;
    clip->source.size = size;

    uint8_t *ioBuffer = (uint8_t *)av_malloc(MEDIA_IO_BUFFER);
    if (!ioBuffer)
    {
        media_close(id);
        return MEDIA_ERR_MEMORY;
    }
    clip->io = avio_alloc_context(
        ioBuffer, MEDIA_IO_BUFFER, 0, &clip->source, readSource, NULL, seekSource);
    if (!clip->io)
    {
        av_free(ioBuffer);
        media_close(id);
        return MEDIA_ERR_MEMORY;
    }

    clip->format = avformat_alloc_context();
    if (!clip->format)
    {
        media_close(id);
        return MEDIA_ERR_MEMORY;
    }
    clip->format->pb = clip->io;
    clip->format->flags |= AVFMT_FLAG_CUSTOM_IO;
    /* Probing decodes frames to fill in what a header did not state, and on a
     * large file it will happily spend that time before the first frame is
     * shown. A guest thread is waiting on this call, so the budget is bounded:
     * a stream whose parameters are not settled inside it is played from what
     * the container itself declared. */
    clip->format->probesize = 1 << 20;
    clip->format->max_analyze_duration = AV_TIME_BASE / 2;

    if (avformat_open_input(&clip->format, NULL, NULL, NULL) < 0)
    {
        /* On failure avformat has already freed the context. */
        clip->format = NULL;
        media_close(id);
        return MEDIA_ERR_FORMAT;
    }
    avformat_find_stream_info(clip->format, NULL);

    clip->videoStream = av_find_best_stream(
        clip->format, AVMEDIA_TYPE_VIDEO, -1, -1, NULL, 0);
    clip->audioStream = av_find_best_stream(
        clip->format, AVMEDIA_TYPE_AUDIO, -1, clip->videoStream, NULL, 0);
    if (clip->videoStream < 0 && clip->audioStream < 0)
    {
        media_close(id);
        return MEDIA_ERR_STREAM;
    }

    if (clip->videoStream >= 0)
    {
        AVCodecParameters *par = clip->format->streams[clip->videoStream]->codecpar;
        const AVCodec *codec = avcodec_find_decoder(par->codec_id);
        if (!codec)
        {
            media_close(id);
            return MEDIA_ERR_CODEC;
        }
        clip->video = avcodec_alloc_context3(codec);
        clip->frame = av_frame_alloc();
        if (!clip->video || !clip->frame)
        {
            media_close(id);
            return MEDIA_ERR_MEMORY;
        }
        if (avcodec_parameters_to_context(clip->video, par) < 0
            || avcodec_open2(clip->video, codec, NULL) < 0)
        {
            media_close(id);
            return MEDIA_ERR_CODEC;
        }
        clip->width = par->width;
        clip->height = par->height;
    }

    /* Audio is optional in a way video is not: a clip whose soundtrack uses a
     * codec this build does not carry still plays, silently, which is a better
     * answer than refusing the file. */
    if (clip->audioStream >= 0)
    {
        AVCodecParameters *par = clip->format->streams[clip->audioStream]->codecpar;
        const AVCodec *codec = avcodec_find_decoder(par->codec_id);
        clip->audio = codec ? avcodec_alloc_context3(codec) : NULL;
        if (clip->audio
            && avcodec_parameters_to_context(clip->audio, par) >= 0
            && avcodec_open2(clip->audio, codec, NULL) >= 0)
        {
            clip->sampleRate = clip->audio->sample_rate;
            clip->channels = clip->audio->ch_layout.nb_channels;
            if (clip->channels < 1)
            {
                clip->channels = 1;
            }
            /* Mixed down to stereo: what consumes this is a Windows waveform
             * device, and nothing of this era asked for more. */
            if (clip->channels > 2)
            {
                clip->channels = 2;
            }

            AVChannelLayout layout;
            av_channel_layout_default(&layout, clip->channels);
            int built = swr_alloc_set_opts2(
                &clip->resampler,
                &layout, AV_SAMPLE_FMT_S16, clip->sampleRate,
                &clip->audio->ch_layout, clip->audio->sample_fmt,
                clip->audio->sample_rate, 0, NULL);
            av_channel_layout_uninit(&layout);

            clip->audioFrame = av_frame_alloc();
            clip->fifo = (uint8_t *)malloc(MEDIA_AUDIO_FIFO);
            if (built < 0 || swr_init(clip->resampler) < 0
                || !clip->audioFrame || !clip->fifo || clip->sampleRate <= 0)
            {
                /* Keep the clip; drop its audio. */
                swr_free(&clip->resampler);
                avcodec_free_context(&clip->audio);
                av_frame_free(&clip->audioFrame);
                free(clip->fifo);
                clip->fifo = NULL;
                clip->sampleRate = 0;
                clip->channels = 0;
                clip->audioStream = -1;
            }
        }
        else
        {
            avcodec_free_context(&clip->audio);
            clip->audioStream = -1;
        }
    }

    return id;
}

/**
 * Opens a decoder for an elementary audio stream, with no container around
 * it. Returns a clip id, or one of the MEDIA_ERR_* codes.
 *
 * The codec is named by its WAVE format tag (0x55 is Layer 3, 0x50 Layer 2)
 * through the same table FFmpeg reads a RIFF header with, so any tag that
 * table knows and this build carries a decoder for is served. What is not
 * served through here is a codec that needs more than a rate and a channel
 * count to start -- extradata, a block alignment -- because nothing carries
 * them across this call.
 *
 * The output is S16 at `sampleRate` with `channels` channels (at most two),
 * whatever the frames turn out to hold: the caller has already told whoever
 * consumes the PCM what shape it comes in.
 */
int32_t media_open_audio(int32_t formatTag, int32_t sampleRate, int32_t channels){
    initialize();
    if (sampleRate <= 0 || channels < 1)
    {
        return MEDIA_ERR_ARGUMENT;
    }
    const struct AVCodecTag *const tables[] = { avformat_get_riff_audio_tags(), NULL };
    const AVCodec *codec = avcodec_find_decoder(av_codec_get_id(tables, (unsigned)formatTag));
    if (!codec)
    {
        return MEDIA_ERR_CODEC;
    }

    int32_t id = allocateClip();
    if (id < 0)
    {
        return id;
    }
    Clip *clip = &clips[id];
    clip->sampleRate = sampleRate;
    clip->channels = channels > 2 ? 2 : channels;

    clip->audio = avcodec_alloc_context3(codec);
    clip->audioFrame = av_frame_alloc();
    clip->fifo = (uint8_t *)malloc(MEDIA_AUDIO_FIFO);
    if (!clip->audio || !clip->audioFrame || !clip->fifo)
    {
        media_close(id);
        return MEDIA_ERR_MEMORY;
    }
    /* A hint for a decoder that wants one before its first frame; the frames
     * themselves have the last word, which is why the resampler waits for one. */
    clip->audio->sample_rate = sampleRate;
    av_channel_layout_default(&clip->audio->ch_layout, channels);
    if (avcodec_open2(clip->audio, codec, NULL) < 0)
    {
        media_close(id);
        return MEDIA_ERR_CODEC;
    }
    return id;
}

/**
 * Decodes one packet -- a whole frame, as the caller cut it -- into the FIFO.
 * Returns the bytes now pending, or a MEDIA_ERR_* code. A packet the decoder
 * rejects yields nothing and is not an error here: the stream goes on, and a
 * caller that must account for every frame compares what it got with what it
 * fed.
 */
int32_t media_feed_audio(int32_t id, const uint8_t *data, int32_t size){
    Clip *clip = clipOf(id);
    if (!clip || !clip->audio)
    {
        return MEDIA_ERR_HANDLE;
    }
    if (!data || size <= 0)
    {
        return clip->fifoLength;
    }
    AVPacket *packet = av_packet_alloc();
    if (!packet)
    {
        return MEDIA_ERR_MEMORY;
    }
    /* Copied, because a packet the decoder is handed must carry FFmpeg's own
     * padding after its bytes and the caller's block has none. */
    if (av_new_packet(packet, size) < 0)
    {
        av_packet_free(&packet);
        return MEDIA_ERR_MEMORY;
    }
    memcpy(packet->data, data, (size_t)size);
    if (avcodec_send_packet(clip->audio, packet) == 0)
    {
        receiveAudio(clip);
    }
    av_packet_free(&packet);
    if (MEDIA_AUDIO_FIFO - clip->fifoLength < clip->channels * 2)
    {
        return MEDIA_ERR_FULL;
    }
    return clip->fifoLength;
}

/**
 * Ends a packet-fed stream: whatever the decoder and the resampler still hold
 * goes into the FIFO. Returns the bytes now pending, or a MEDIA_ERR_* code.
 * Nothing can be fed after this.
 */
int32_t media_flush_audio(int32_t id){
    Clip *clip = clipOf(id);
    if (!clip || !clip->audio)
    {
        return MEDIA_ERR_HANDLE;
    }
    if (avcodec_send_packet(clip->audio, NULL) == 0)
    {
        receiveAudio(clip);
    }
    if (clip->resampler)
    {
        drainResampler(clip, NULL);
    }
    if (MEDIA_AUDIO_FIFO - clip->fifoLength < clip->channels * 2)
    {
        return MEDIA_ERR_FULL;
    }
    return clip->fifoLength;
}

/**
 * Writes MEDIA_INFO_FIELDS int32 values describing the clip.
 * Returns 0, or MEDIA_ERR_HANDLE.
 */
int32_t media_info(int32_t id, int32_t *out){
    Clip *clip = clipOf(id);
    if (!clip || !out)
    {
        return MEDIA_ERR_HANDLE;
    }
    memset(out, 0, MEDIA_INFO_FIELDS * sizeof(int32_t));
    out[INFO_FPS_DEN] = 1;
    out[INFO_SAMPLE_RATE] = clip->sampleRate;
    out[INFO_CHANNELS] = clip->channels;
    out[INFO_HAS_AUDIO] = clip->audio ? 1 : 0;
    out[INFO_HAS_VIDEO] = clip->video ? 1 : 0;

    if (!clip->video)
    {
        return 0;
    }
    AVStream *stream = clip->format->streams[clip->videoStream];
    out[INFO_WIDTH] = clip->width;
    out[INFO_HEIGHT] = clip->height;
    out[INFO_PIXEL_FORMAT] = (int32_t)clip->video->pix_fmt;
    out[INFO_CODEC_ID] = (int32_t)clip->video->codec_id;
    out[INFO_FOURCC] = (int32_t)stream->codecpar->codec_tag;

    AVRational rate = stream->avg_frame_rate;
    if (rate.num <= 0 || rate.den <= 0)
    {
        rate = stream->r_frame_rate;
    }
    if (rate.num > 0 && rate.den > 0)
    {
        out[INFO_FPS_NUM] = rate.num;
        out[INFO_FPS_DEN] = rate.den;
    }

    /* Zero means "unknown", which is the honest answer for a container that
     * does not count its frames. A caller that needs a length can compute one
     * from the duration; a caller that only plays to the end does not. */
    int64_t frames = stream->nb_frames;
    if (frames <= 0 && stream->duration > 0 && out[INFO_FPS_NUM] > 0)
    {
        frames = (int64_t)(av_q2d(stream->time_base) * (double)stream->duration
            * (double)out[INFO_FPS_NUM] / (double)out[INFO_FPS_DEN] + 0.5);
    }
    out[INFO_FRAME_COUNT] = frames > 0 && frames < INT32_MAX ? (int32_t)frames : 0;
    return 0;
}

/** The decoder's short name, in a buffer valid until the next call. */
static char codecName[64];
const char *media_codec_name(int32_t id){
    Clip *clip = clipOf(id);
    codecName[0] = 0;
    if (clip && clip->video && clip->video->codec && clip->video->codec->name)
    {
        strncpy(codecName, clip->video->codec->name, sizeof(codecName) - 1);
        codecName[sizeof(codecName) - 1] = 0;
    }
    return codecName;
}

/**
 * Advances the clip: reads packets until one video frame is ready, the audio
 * held for the caller is full, or the stream ends. Audio met on the way is
 * decoded into the FIFO.
 *
 * Exactly one video frame per call, never a drained queue: a codec that
 * reorders frames emits several for one packet, and consuming them all here
 * while counting one loses the extras and ends the clip early.
 */
int32_t media_decode(int32_t id){
    Clip *clip = clipOf(id);
    if (!clip)
    {
        return MEDIA_ERR_HANDLE;
    }
    /* A packet-fed clip has no container to read from; it is advanced by
     * media_feed_audio() and is over whenever nobody feeds it. */
    if (!clip->format)
    {
        return MEDIA_END;
    }

    if (clip->video && avcodec_receive_frame(clip->video, clip->frame) == 0)
    {
        return convertFrame(clip) ? MEDIA_FRAME : MEDIA_ERR_MEMORY;
    }

    AVPacket *packet = av_packet_alloc();
    if (!packet)
    {
        return MEDIA_ERR_MEMORY;
    }

    int32_t status = MEDIA_END;
    for (;;)
    {
        if (av_read_frame(clip->format, packet) < 0)
        {
            if (clip->video && avcodec_send_packet(clip->video, NULL) == 0
                && avcodec_receive_frame(clip->video, clip->frame) == 0)
            {
                status = convertFrame(clip) ? MEDIA_FRAME : MEDIA_ERR_MEMORY;
            }
            break;
        }

        if (clip->video && packet->stream_index == clip->videoStream)
        {
            if (avcodec_send_packet(clip->video, packet) == 0
                && avcodec_receive_frame(clip->video, clip->frame) == 0)
            {
                status = convertFrame(clip) ? MEDIA_FRAME : MEDIA_ERR_MEMORY;
            }
        }
        else if (clip->audio && packet->stream_index == clip->audioStream)
        {
            if (avcodec_send_packet(clip->audio, packet) == 0)
            {
                receiveAudio(clip);
            }
        }
        av_packet_unref(packet);

        if (status != MEDIA_END)
        {
            break;
        }
        if (clip->audio && MEDIA_AUDIO_FIFO - clip->fifoLength < clip->channels * 2)
        {
            status = MEDIA_AUDIO_FULL;
            break;
        }
    }

    av_packet_free(&packet);
    return status;
}

/** The current frame as BGRA, width * height * 4 bytes, or NULL. */
const uint8_t *media_frame(int32_t id){
    Clip *clip = clipOf(id);
    return clip ? clip->pixels : NULL;
}

/** Bytes of interleaved S16 PCM waiting to be read. */
int32_t media_audio_pending(int32_t id){
    Clip *clip = clipOf(id);
    return clip ? clip->fifoLength : 0;
}

/** Moves up to `max` bytes of PCM out of the clip. Returns bytes written. */
int32_t media_audio_read(int32_t id, uint8_t *out, int32_t max){
    Clip *clip = clipOf(id);
    if (!clip || !out || max <= 0)
    {
        return 0;
    }
    int count = clip->fifoLength < max ? clip->fifoLength : max;
    if (count <= 0)
    {
        return 0;
    }
    memcpy(out, clip->fifo, (size_t)count);
    clip->fifoLength -= count;
    memmove(clip->fifo, clip->fifo + count, (size_t)clip->fifoLength);
    return count;
}

void media_close(int32_t id){
    if (id < 0 || id >= MEDIA_MAX_CLIPS)
    {
        return;
    }
    Clip *clip = &clips[id];

    sws_freeContext(clip->scaler);
    swr_free(&clip->resampler);
    avcodec_free_context(&clip->video);
    avcodec_free_context(&clip->audio);
    av_frame_free(&clip->frame);
    av_frame_free(&clip->audioFrame);
    if (clip->format)
    {
        /* AVFMT_FLAG_CUSTOM_IO leaves pb to us; the context is closed first so
         * nothing reads through the AVIOContext after it is gone. */
        avformat_close_input(&clip->format);
    }
    if (clip->io)
    {
        av_freep(&clip->io->buffer);
        avio_context_free(&clip->io);
    }
    av_free(clip->pixels);
    free(clip->fifo);
    free(clip->input);

    memset(clip, 0, sizeof(Clip));
}
