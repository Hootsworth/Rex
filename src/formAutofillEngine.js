/**
 * formAutofillEngine.js — Smart Multi-Field Accessibility Form Autofill
 *
 * Uses native macOS Accessibility inspection to detect all real form inputs
 * in top-to-bottom order and maps user profile data directly into the inputs
 * with pinpoint hardware clicks and typed text.
 */

import { getAllFormInputs, findBestUiElement } from './accessibilityInspector.js';
import {
    cursorClick,
    cursorType,
    cursorKeyPress,
    moveCursorTo,
    cursorHighlight,
    cursorSpeak,
    hideCursorHighlight,
    getTargetWindowBounds
} from './screenCursor.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Autonomously populate an active form using real accessibility hitboxes.
 * @param {string} appName e.g. "Zen", "Google Chrome", "Safari"
 * @param {object} formData Field values: { name, email, phone, company, message, ... }
 */
export async function autofillActiveForm(appName = '', formData = {}) {
    cursorSpeak(`Scanning ${appName || 'window'} for form input fields...`, 3000, "AUTOFILL");

    const inputs = await getAllFormInputs(appName);
    const win = await getTargetWindowBounds(appName);

    const values = [
        formData.fullName || formData.name || 'Rex Copilot',
        formData.email || 'rex.autonomous@power-cli.local',
        formData.phone || '+1 (555) 019-2834',
        formData.company || 'Power-CLI Autonomous',
        formData.notes || formData.message || 'Automated verification submission via Rex Screen Copilot.'
    ];

    if (inputs.length > 0) {
        cursorSpeak(`Identified ${inputs.length} native input fields. Populating fields...`, 3000, "AUTOFILL");

        for (let i = 0; i < Math.min(inputs.length, values.length); i++) {
            const input = inputs[i];
            const textToType = values[i];
            const targetX = Math.round(input.x + input.width / 2);
            const targetY = Math.round(input.y + input.height / 2);

            moveCursorTo(targetX, targetY, 350, 'handpointing');
            await sleep(380);

            cursorHighlight(input.x, input.y, input.width, input.height, input.placeholder || input.title || `Field ${i + 1}`);
            cursorSpeak(`Entering ${input.placeholder || 'data'}...`, 2500, `FIELD ${i + 1}`);

            // Double click into input to place cursor
            cursorClick(targetX, targetY, 'handpointing', true);
            await sleep(200);
            cursorClick(targetX, targetY, 'handpointing', true);
            await sleep(300);

            cursorType(textToType);
            await sleep(350);
        }

        // Locate submit button
        const submitBtn = await findBestUiElement(appName, 'submit', 'AXButton') ||
                          await findBestUiElement(appName, 'continue', 'AXButton') ||
                          await findBestUiElement(appName, 'next', 'AXButton');

        if (submitBtn) {
            const btnX = Math.round(submitBtn.x + submitBtn.width / 2);
            const btnY = Math.round(submitBtn.y + submitBtn.height / 2);
            moveCursorTo(btnX, btnY, 400, 'handpointing');
            await sleep(450);
            cursorHighlight(submitBtn.x, submitBtn.y, submitBtn.width, submitBtn.height, submitBtn.title || 'Submit');
            cursorSpeak('Finalizing form submission.', 3000, 'SUBMIT');
            cursorClick(btnX, btnY, 'handpointing', true);
            await sleep(400);
        }

        hideCursorHighlight();
        cursorSpeak('All form fields successfully completed!', 3500, 'READY');
        return { ok: true, fieldsCompleted: Math.min(inputs.length, values.length) };
    }

    // Fallback: window relative layout
    const winX = win.x;
    const winY = win.y;
    const winW = win.width;
    const winH = win.height;

    const fields = [
        { label: 'Name', x: winX + Math.round(winW * 0.5), y: winY + Math.round(winH * 0.30), val: values[0] },
        { label: 'Email', x: winX + Math.round(winW * 0.5), y: winY + Math.round(winH * 0.40), val: values[1] }
    ];

    for (const f of fields) {
        moveCursorTo(f.x, f.y, 350, 'handpointing');
        await sleep(380);
        cursorHighlight(f.x - 140, f.y - 20, 280, 40, f.label);
        cursorClick(f.x, f.y, 'handpointing', true);
        await sleep(250);
        cursorType(f.val);
        await sleep(300);
    }

    hideCursorHighlight();
    return { ok: true, fallback: true };
}
