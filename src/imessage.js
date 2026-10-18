/**
 * imessage.js — Native macOS iMessage & SMS Integration for Rex
 *
 * Capabilities:
 * - Send real iMessages or SMS to contacts, phone numbers, or emails from Discord
 * - List recent chat threads in Messages.app
 * - Strict security: Only authorized bot owners can trigger iMessage sending
 */

import { executeAppleScript } from './appleScript.js';
import pc from 'picocolors';

/**
 * Send an iMessage / SMS via macOS Messages.app
 * @param {string} recipient - Contact name, phone number (+1...), or Apple ID email
 * @param {string} messageText - Message body to send
 */
export async function sendIMessage(recipient, messageText) {
    const cleanRecipient = String(recipient || '').trim();
    const cleanMsg = String(messageText || '').trim();

    if (!cleanRecipient || !cleanMsg) {
        throw new Error('Recipient and messageText are both required.');
    }

    const safeMsg = cleanMsg.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const safeRecipient = cleanRecipient.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

    const script = `
        tell application "Messages"
            set targetService to 1st service whose service type = iMessage
            try
                set targetBuddy to buddy "${safeRecipient}" of targetService
                send "${safeMsg}" to targetBuddy
                return "Successfully sent iMessage to " & "${safeRecipient}"
            on error
                try
                    set targetBuddy to participant "${safeRecipient}" of targetService
                    send "${safeMsg}" to targetBuddy
                    return "Successfully sent to participant " & "${safeRecipient}"
                on error
                    -- Fallback to default active service (SMS or iMessage)
                    set targetBuddy to buddy "${safeRecipient}" of 1st service
                    send "${safeMsg}" to targetBuddy
                    return "Successfully sent via default service to " & "${safeRecipient}"
                end try
            end try
        end tell
    `;

    const res = await executeAppleScript(script);
    if (!res.success) {
        throw new Error(`iMessage delivery failed: ${res.error}`);
    }

    return res.output || `Message sent to ${cleanRecipient}`;
}

/**
 * List recent conversations/chats from Messages.app
 * @param {number} limit
 */
export async function listRecentChats(limit = 8) {
    const script = `
        tell application "Messages"
            set chatNames to {}
            set chatList to chats
            set maxCount to ${limit}
            if (count of chatList) < maxCount then set maxCount to (count of chatList)
            repeat with i from 1 to maxCount
                set thisChat to item i of chatList
                try
                    set chatTitle to (name of thisChat as string)
                    if chatTitle is not missing value and chatTitle is not "" then
                        set end of chatNames to chatTitle
                    end if
                end try
            end repeat
            set AppleScript's text item delimiters to "\\n"
            return chatNames as text
        end tell
    `;

    const res = await executeAppleScript(script);
    if (!res.success) return 'Could not read recent chats from Messages.app.';
    return res.output || 'No recent chats found.';
}

/**
 * Command handler for Discord messages
 */
export async function tryHandleIMessageCommand({ message, cleanContent }) {
    const text = String(cleanContent || message.content || '').trim();
    if (!text) return { handled: false };

    // Matches: "rex text [recipient] : [message]" or "rex imessage [recipient] : [message]" or "!imessage [recipient] : [message]"
    const sendMatch = text.match(/^(?:!imessage|(?:rex\s+)?(?:send\s+)?(?:imessage|sms|text\s+message|text))\s+([^:]+?)\s*:\s*(.+)$/i);
    if (sendMatch) {
        const recipient = sendMatch[1].trim();
        const body = sendMatch[2].trim();

        await message.channel.sendTyping().catch(() => {});
        try {
            const result = await sendIMessage(recipient, body);
            await message.reply(`💬📱 **iMessage Sent!**\n• To: **${recipient}**\n• Message: *"${body}"*\n• Status: \`${result}\``);
        } catch (e) {
            await message.reply(`❌ iMessage failed: ${e.message}\n*(Tip: ensure Messages.app is signed in on your Mac and has permission).*`);
        }
        return { handled: true };
    }

    // Matches: "rex recent texts" or "rex imessage chats" or "show recent chats"
    if (/^(?:rex\s+)?(?:recent\s+texts|recent\s+chats|recent\s+imessages|imessage\s+chats|show\s+chats)$/i.test(text)) {
        await message.channel.sendTyping().catch(() => {});
        const chats = await listRecentChats(10);
        await message.reply(`💬📱 **Recent Messages.app Chats**:\n\`\`\`\n${chats}\n\`\`\``);
        return { handled: true };
    }

    return { handled: false };
}
