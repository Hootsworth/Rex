import path from 'path';
import fs from 'fs';
import OpenAI from 'openai';
import { findBestFileMatch } from '../fileEngine.js';
import { rememberLastAccessedFile } from '../memoryStore.js';
import { isPathAllowed } from '../security.js';

async function transcribeWithWhisperApi(filePath, config) {
    if (!config.openaiKey) {
        throw new Error('OpenAI key is required for Whisper API transcription.');
    }
    const openai = new OpenAI({ apiKey: config.openaiKey });
    const res = await openai.audio.transcriptions.create({
        file: fs.createReadStream(filePath),
        model: 'whisper-1'
    });
    return res.text || '';
}

async function transcribeWithLocalService(filePath, config) {
    const endpoint = String(config.whisperServiceUrl || '').trim();
    if (!endpoint) {
        throw new Error('Local whisper service URL is not configured.');
    }

    const body = { filePath };
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        throw new Error(`Local whisper service failed (${response.status}).`);
    }

    const payload = await response.json();
    return String(payload.text || '');
}

export async function transcribeAudioAction(intent, ctx) {
    const { allowedDirs, config } = ctx;
    const directPath = intent.file_path ? path.resolve(intent.file_path) : '';
    const match = directPath
        ? { path: directPath, name: path.basename(directPath) }
        : await findBestFileMatch({ query: intent.query, time: intent.time }, allowedDirs);

    if (!match) {
        return { ok: false, text: 'Could not find an audio note to transcribe.' };
    }

    if (!isPathAllowed(match.path, allowedDirs)) {
        return { ok: false, text: 'Audio file is outside allowed folders.' };
    }

    const mode = String(config.voiceTranscriptionMode || 'openai').toLowerCase();
    const transcript = mode === 'local'
        ? await transcribeWithLocalService(match.path, config)
        : await transcribeWithWhisperApi(match.path, config);

    rememberLastAccessedFile(match.path, 'transcribe_audio');
    return {
        ok: true,
        text: `Transcript for ${path.basename(match.path)}\n\n${transcript.slice(0, 1800)}`,
        data: { filePath: match.path }
    };
}
