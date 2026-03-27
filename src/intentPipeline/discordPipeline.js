import { parseIntent } from './intentParser.js';
import { runAction } from './actionRouter.js';
import { getAllowedDirs, isDiscordUserAllowed } from './security.js';
import { rememberCommand, getRecentMemory } from './memoryStore.js';

function shouldUseIntentPipeline(messageText = '') {
    const lower = String(messageText || '').toLowerCase();
    if (lower.startsWith('rex legacy')) return false;

    // Keep automation rare: only trigger for explicit actionable phrasing.
    const explicitPrefixes = [
        'rex do',
        'rex action',
        'do this:',
        'action:'
    ];
    if (explicitPrefixes.some((p) => lower.startsWith(p))) return true;

    const actionSignals = [
        /\bsend\b.*\b(file|pdf|docx|homework|hw|notes?)\b/i,
        /\b(read|open|summarize)\b.*\b(file|pdf|docx|txt|note)\b/i,
        /\b(transcribe|transcription)\b.*\b(audio|voice|recording|note)\b/i,
        /\b(index|reindex)\b.*\b(files?|documents?)\b/i,
        /\b(search|find)\b.*\b(index|files?)\b/i,
        /\bconfirm\b.*\b(send|file)\b/i
    ];

    return actionSignals.some((re) => re.test(lower));
}

export async function tryHandleIntentPipelineMessage({ message, cleanContent, config }) {
    if (!shouldUseIntentPipeline(cleanContent)) {
        return { handled: false };
    }

    const intent = await parseIntent(cleanContent, config);

    // If parser says "help" or unknown, this is normal conversation.
    if (!intent?.action || intent.action === 'help') {
        return { handled: false };
    }

    if (!isDiscordUserAllowed(config, message.author?.id)) {
        await message.reply('Access denied: your Discord user ID is not whitelisted for automation actions.');
        return { handled: true };
    }

    rememberCommand(intent);

    const allowedDirs = getAllowedDirs(config);
    const ctx = {
        config,
        message,
        allowedDirs,
        recentMemory: getRecentMemory()
    };

    const result = await runAction(intent, ctx);

    const response = result.text;

    if (!result.ok) {
        await message.reply(response);
        return { handled: true, success: false, intent, result };
    }

    if (intent.action !== 'send_file') {
        await message.reply(response);
    }

    return { handled: true, success: true, intent, result };
}
