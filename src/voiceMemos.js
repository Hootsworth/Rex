/**
 * voiceMemos.js — Spontaneous & On-Demand Neural Voice Notes for Rex
 *
 * Capabilities:
 * - Synthesizes warm, natural voice notes using Cartesia neural TTS (sonic-2)
 * - Sends playable in-line .wav voice memos into Discord DMs or channels
 * - Supports on-demand memos ("send me a voice note about my day", "rex voice memo")
 * - Generates clean conversational scripts tailored for natural human-like speech
 */

import fs from 'fs';
import path from 'path';
import { AttachmentBuilder } from 'discord.js';
import pc from 'picocolors';
import { generateSpeechFile } from './cartesia.js';
import { runCompletion } from './ai.js';

/**
 * Synthesizes text into a voice memo and sends it directly to a Discord channel or user
 */
export async function sendVoiceMemo(targetDestination, speechText, caption = '') {
    if (!targetDestination || !speechText) return false;

    let tmpAudioPath = null;
    try {
        tmpAudioPath = await generateSpeechFile(speechText);
        if (!fs.existsSync(tmpAudioPath) || fs.statSync(tmpAudioPath).size === 0) {
            throw new Error('Generated voice memo file was empty.');
        }

        const attachment = new AttachmentBuilder(tmpAudioPath, { name: `rex_voice_memo_${Date.now()}.wav` });
        const messagePayload = {
            content: caption || `🦖🎙️ **Rex Voice Memo**:\n> *"${speechText.slice(0, 150)}${speechText.length > 150 ? '...' : ''}"*`,
            files: [attachment]
        };

        if (typeof targetDestination.reply === 'function') {
            await targetDestination.reply(messagePayload);
        } else if (typeof targetDestination.send === 'function') {
            await targetDestination.send(messagePayload);
        }

        return true;
    } catch (e) {
        console.error(pc.red(`Failed to send voice memo: ${e.message}`));
        return false;
    } finally {
        if (tmpAudioPath) {
            try { fs.unlinkSync(tmpAudioPath); } catch {}
        }
    }
}

/**
 * Generate a spoken script tailored specifically for human-like listening
 */
export async function createVoiceMemoScript(topic = 'morning check-in', context = '') {
    const prompt = `You are Rex, an enthusiastic, caring AI coding companion and personal butler.
Write a SHORT, natural, spoken voice memo to your creator, Aditya.
TOPIC: ${topic}
${context ? `CONTEXT: ${context}` : ''}

CRITICAL RULES FOR SPOKEN AUDIO:
1. Speak in first person, warmly and casually, as if leaving a quick 15-second audio message on WhatsApp/Telegram.
2. No bullet points, no markdown, no asterisks, no emojis, no code syntax.
3. Keep it between 2 to 4 sentences maximum.
4. Sound supportive, lively, and sincere.`;

    const messages = [{ role: 'user', content: prompt }];
    const text = await runCompletion(messages, null, 'high');
    return text ? text.replace(/[*_#>`]/g, '').trim() : "Hey Aditya! Just wanted to check in and say hope you're having an awesome day. Let's make some magic happen today!";
}

/**
 * Command handler for voice memo triggers
 */
export async function tryHandleVoiceMemoCommand({ message, cleanContent }) {
    const text = String(cleanContent || message.content || '').trim();
    if (!text) return { handled: false };

    // Matches: "rex voice memo", "send me a voice note", "!voicenote", "rex voice note about [topic]"
    const isVoiceMemoReq = /^(?:!voicenote|!(?:voice|memo)\b|(?:rex\s+)?(?:send\s*(?:me\s*)?(?:a\s*)?)?(?:voice\s*memo|voice\s*note)\b)/i.test(text);

    if (!isVoiceMemoReq) return { handled: false };

    // Extract optional topic
    const topicMatch = text.match(/(?:about|on|regarding)\s+(.+)$/i);
    const topic = topicMatch ? topicMatch[1].trim() : 'a quick encouraging check-in and project hype';

    await message.channel.sendTyping().catch(() => {});

    try {
        const script = await createVoiceMemoScript(topic);
        const sent = await sendVoiceMemo(message, script);
        if (!sent) {
            await message.reply("🦖🎙️ I tried to record a voice note for you, but my vocal cords tripped up! Here's what I wanted to say:\n\n" + script);
        }
    } catch (e) {
        await message.reply(`Failed to record voice memo: ${e.message}`);
    }

    return { handled: true };
}
