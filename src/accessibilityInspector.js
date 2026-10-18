/**
 * accessibilityInspector.js — macOS AXUIElement Semantic Tree Inspector
 *
 * Interfaces with native CoreGraphics/Accessibility binary (rex-ax-inspect) to query
 * exact bounding boxes and labels for buttons, inputs, sliders, and controls directly
 * from the macOS operating system without relying on guesswork or vision latency.
 */

import path from 'path';
import fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const BIN_PATH = path.join(process.cwd(), 'src', 'native', 'bin', 'rex-ax-inspect');

/**
 * Query accessibility elements for a target macOS application.
 * @param {string} appName e.g. "Zen", "Google Chrome", "DaVinci Resolve", "Terminal"
 * @param {string} [query=''] Optional text filter (e.g. "Search", "Send", "Export", "Save")
 * @returns {Promise<Array<{role: string, title: string, value: string, placeholder: string, x: number, y: number, width: number, height: number, enabled: boolean}>>}
 */
export async function findUiElements(appName, query = '') {
    if (process.platform !== 'darwin' || !fs.existsSync(BIN_PATH)) {
        return [];
    }

    try {
        const cleanApp = String(appName || '').replace(/"/g, '\\"');
        const cleanQuery = String(query || '').replace(/"/g, '\\"');
        const { stdout } = await execAsync(`"${BIN_PATH}" "${cleanApp}" "${cleanQuery}"`, { timeout: 3500 });
        const trimmed = stdout.trim();
        if (!trimmed.startsWith('[')) return [];
        return JSON.parse(trimmed);
    } catch {
        return [];
    }
}

/**
 * Find the single best clickable element matching a label or role.
 * @param {string} appName
 * @param {string} query
 * @param {string} [preferredRole] e.g. "AXButton", "AXTextField"
 */
export async function findBestUiElement(appName, query, preferredRole) {
    const elements = await findUiElements(appName, query);
    if (!elements || elements.length === 0) return null;

    if (preferredRole) {
        const exactRole = elements.find(e => e.role === preferredRole);
        if (exactRole) return exactRole;
    }

    // Sort by best match (title starting with query or exact match)
    const lowerQuery = query.toLowerCase().trim();
    elements.sort((a, b) => {
        const aTitle = a.title.toLowerCase();
        const bTitle = b.title.toLowerCase();
        if (aTitle === lowerQuery) return -1;
        if (bTitle === lowerQuery) return 1;
        if (aTitle.startsWith(lowerQuery)) return -1;
        if (bTitle.startsWith(lowerQuery)) return 1;
        return 0;
    });

    return elements[0];
}

/**
 * Retrieve all editable form input fields in an application, ordered from top to bottom.
 * @param {string} appName
 */
export async function getAllFormInputs(appName) {
    const elements = await findUiElements(appName, '');
    const inputs = elements.filter(e =>
        ['AXTextField', 'AXTextArea', 'AXSearchField', 'AXComboBox'].includes(e.role) && e.enabled
    );
    // Sort top to bottom, left to right
    inputs.sort((a, b) => {
        if (Math.abs(a.y - b.y) > 15) return a.y - b.y;
        return a.x - b.x;
    });
    return inputs;
}
