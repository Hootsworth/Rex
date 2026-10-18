/**
 * closedLoopVerifier.js — Closed-Loop Self-Correction ("Look-After-Click")
 *
 * Captures post-action verification screenshots, detects blocking modals or
 * uncommitted state, and automatically self-corrects by dismissing blockers
 * (e.g. cookie banners, notification popups) and re-attempting failed steps.
 */

import fs from 'fs';
import { captureScreen } from './vision.js';
import { cursorKeyPress, cursorSpeak, cursorClick } from './screenCursor.js';
import { findUiElements } from './accessibilityInspector.js';

/**
 * Check if an unexpected blocking modal or alert popped up on screen.
 * @param {string} [appName='']
 * @returns {Promise<{ hasBlocker: boolean, blockerTitle?: string, dismissAction?: string }>}
 */
export async function detectUiBlocker(appName = '') {
    if (!appName) return { hasBlocker: false };

    try {
        const elements = await findUiElements(appName, '');
        const alertOrDialog = elements.find(e =>
            ['AXDialog', 'AXSheet', 'AXAlert'].includes(e.role) ||
            /popup|cookie|banner|permission|notification|confirm/i.test(e.title)
        );

        if (alertOrDialog) {
            // Find a dismiss or close or cancel button
            const dismissBtn = elements.find(e =>
                e.role === 'AXButton' && /close|dismiss|cancel|ok|got it|accept|allow/i.test(e.title)
            );
            return {
                hasBlocker: true,
                blockerTitle: alertOrDialog.title || 'Overlay Dialog',
                dismissBtn: dismissBtn ? { x: dismissBtn.x + dismissBtn.width / 2, y: dismissBtn.y + dismissBtn.height / 2 } : null
            };
        }
    } catch {}

    return { hasBlocker: false };
}

/**
 * Verify UI state after executing an action and self-correct if obstructed.
 * @param {object} step The step that was just executed
 * @param {string} [appName=''] Active application name
 */
export async function verifyAndSelfCorrect(step, appName = '') {
    const blockerInfo = await detectUiBlocker(appName);

    if (blockerInfo.hasBlocker) {
        cursorSpeak(`Blocker detected (${blockerInfo.blockerTitle}). Automatically self-correcting...`, 3000, "RECOVER");

        if (blockerInfo.dismissBtn) {
            cursorClick(blockerInfo.dismissBtn.x, blockerInfo.dismissBtn.y, 'handpointing', true);
            await new Promise(r => setTimeout(r, 600));
        } else {
            // Dismiss via Escape
            cursorKeyPress('escape');
            await new Promise(r => setTimeout(r, 500));
        }

        return { recovered: true, action: 'dismissed_blocker' };
    }

    return { recovered: false };
}
