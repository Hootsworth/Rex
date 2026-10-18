import path from 'path';
import fs from 'fs/promises';
import { AttachmentBuilder } from 'discord.js';
import { findBestFileMatch } from '../fileEngine.js';
import { rememberLastAccessedFile } from '../memoryStore.js';
import { hasConfirmation, isPathAllowed, requiresConfirmation } from '../security.js';

export async function sendFile(intent, ctx) {
    const { allowedDirs, message } = ctx;
    const match = await findBestFileMatch({ query: intent.query, time: intent.time }, allowedDirs);

    if (!match) {
        return {
            ok: false,
            text: 'I could not find a matching file in allowed folders.'
        };
    }

    if (!isPathAllowed(match.path, allowedDirs)) {
        return {
            ok: false,
            text: 'Matched file is outside allowed folders. Refusing to send it.'
        };
    }

    if (requiresConfirmation(intent) && !hasConfirmation(intent)) {
        return {
            ok: false,
            text: `Confirmation required. I found ${path.basename(match.path)}. Reply with "confirm send ${path.basename(match.path)}" to proceed.`
        };
    }

    try {
        await fs.access(match.path);
    } catch {
        return {
            ok: false,
            text: `I found ${path.basename(match.path)}, but it is no longer accessible on disk.`
        };
    }

    let stat;
    try {
        stat = await fs.stat(match.path);
    } catch {
        stat = null;
    }

    // Conservative default upload cap to avoid Discord 413/40005 failures.
    const uploadCapBytes = 8 * 1024 * 1024;
    if (stat && stat.size > uploadCapBytes) {
        return {
            ok: false,
            text: `I found ${path.basename(match.path)}, but it is too large to upload directly (${Math.ceil(stat.size / (1024 * 1024))} MB).`
        };
    }

    try {
        const attachment = new AttachmentBuilder(match.path, { name: path.basename(match.path) });
        await message.reply({ files: [attachment] });
    } catch (err) {
        const msg = String(err?.message || 'unknown error');
        return {
            ok: false,
            text: `I found ${path.basename(match.path)} but Discord rejected the upload (${msg}).`
        };
    }

    rememberLastAccessedFile(match.path, 'send_file');

    return {
        ok: true,
        text: `Sent file: ${path.basename(match.path)}`,
        data: { filePath: match.path }
    };
}
