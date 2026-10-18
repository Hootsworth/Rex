import fs from 'fs';
import path from 'path';
import os from 'os';
import { loadConfig } from './config.js';

const DEFAULT_CARTESIA_API_KEY = 'sk_car_LR8Ze7pq8Yug9SpnbqUSjp';
const DEFAULT_CARTESIA_VOICE_ID = 'db6b0ed5-d5d3-463d-ae85-518a07d3c2b4';
const DEFAULT_CARTESIA_MODEL_ID = 'sonic-2';

/**
 * Clean markdown and code formatting from text for natural speech synthesis
 */
export function prepareTextForSpeech(text) {
    if (!text) return '';
    let cleaned = String(text);
    // Replace code blocks
    cleaned = cleaned.replace(/```[\s\S]*?```/g, ' [code omitted] ');
    // Remove inline code
    cleaned = cleaned.replace(/`([^`]+)`/g, '$1');
    // Remove links
    cleaned = cleaned.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
    // Remove markdown formatting characters
    cleaned = cleaned.replace(/[*_~#>|]/g, '');
    // Replace excessive whitespace
    cleaned = cleaned.replace(/\s+/g, ' ').trim();
    // Keep it reasonable for voice response
    return cleaned.slice(0, 1500);
}

/**
 * Generate speech audio file using Cartesia TTS API
 * @param {string} text - Text to speak
 * @param {string} outputPath - Output file path (.wav)
 * @param {object} options - Optional overrides
 * @returns {Promise<string>} - Path to output file
 */
export async function generateCartesiaSpeech(text, outputPath, options = {}) {
    const config = loadConfig();
    const apiKey = options.apiKey || config.cartesiaApiKey || process.env.CARTESIA_API_KEY || DEFAULT_CARTESIA_API_KEY;
    const voiceId = options.voiceId || config.cartesiaVoiceId || DEFAULT_CARTESIA_VOICE_ID;
    const modelId = options.modelId || config.cartesiaModelId || DEFAULT_CARTESIA_MODEL_ID;

    const speechText = prepareTextForSpeech(text);
    if (!speechText) {
        throw new Error('No readable text to speak.');
    }

    const response = await fetch('https://api.cartesia.ai/tts/bytes', {
        method: 'POST',
        headers: {
            'Cartesia-Version': '2024-06-10',
            'X-API-Key': apiKey,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model_id: modelId,
            transcript: speechText,
            voice: {
                mode: 'id',
                id: voiceId
            },
            output_format: {
                container: 'wav',
                encoding: 'pcm_s16le',
                sample_rate: 48000
            }
        })
    });

    if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(`Cartesia TTS error (${response.status}): ${errorText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    fs.writeFileSync(outputPath, Buffer.from(arrayBuffer));
    return outputPath;
}

/**
 * Convenience helper to synthesize text into a temporary WAV file
 */
export async function generateSpeechFile(text, options = {}) {
    const tmpPath = path.join(os.tmpdir(), `cartesia_${Date.now()}_${Math.random().toString(36).slice(2)}.wav`);
    return await generateCartesiaSpeech(text, tmpPath, options);
}

/**
 * Play text-to-speech through an active Discord voice connection audio player
 * Uses Cartesia TTS with fallback to edge-tts if needed
 * @param {object} player - @discordjs/voice AudioPlayer instance
 * @param {string} text - Text to synthesize and speak
 * @param {string} identifier - Unique ID for temporary file naming
 */
export async function playTtsToVoicePlayer(player, text, identifier = Date.now().toString()) {
    if (!player || !text) return;

    const tmpAudioPath = path.join(process.cwd(), `.rex_voice_output_${identifier}.wav`);
    let played = false;

    try {
        await generateCartesiaSpeech(text, tmpAudioPath);
        const { createAudioResource, AudioPlayerStatus } = await import('@discordjs/voice');
        const resource = createAudioResource(tmpAudioPath);
        player.play(resource);
        played = true;

        player.once(AudioPlayerStatus.Idle, () => {
            setTimeout(() => {
                try { fs.unlinkSync(tmpAudioPath); } catch {}
            }, 1000);
        });
    } catch (err) {
        console.warn(`[Cartesia TTS] Warning: ${err.message}. Trying edge-tts fallback...`);
        try {
            const { ttsSave } = await import('edge-tts');
            const fallbackPath = path.join(process.cwd(), `.rex_voice_fallback_${identifier}.mp3`);
            const fallbackText = prepareTextForSpeech(text);
            await ttsSave(fallbackText, fallbackPath, { voice: 'en-US-ChristopherNeural', rate: '+5%' });
            const { createAudioResource, AudioPlayerStatus } = await import('@discordjs/voice');
            const resource = createAudioResource(fallbackPath);
            player.play(resource);

            player.once(AudioPlayerStatus.Idle, () => {
                setTimeout(() => {
                    try { fs.unlinkSync(fallbackPath); } catch {}
                }, 1000);
            });
        } catch (fallbackErr) {
            console.error('[Voice TTS] Failed to play audio:', fallbackErr.message);
            try { fs.unlinkSync(tmpAudioPath); } catch {}
        }
    }
}
