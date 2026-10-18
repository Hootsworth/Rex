/**
 * cursorMacroRecorder.js — "Teach Rex" Workflow Recorder & Replay Engine
 *
 * Enables users to record repeatable workflows once and have Rex replay them
 * autonomously on demand across macOS (e.g. custom DaVinci color grading setups,
 * form submission sequences, spreadsheet exports, or media rendering).
 */

import fs from 'fs';
import path from 'path';

const MACRO_DIR = path.join(process.cwd(), '.rex', 'macros');

function ensureMacroDir() {
    if (!fs.existsSync(MACRO_DIR)) {
        fs.mkdirSync(MACRO_DIR, { recursive: true });
    }
}

let activeRecording = null;

/**
 * Start recording a new autonomous macro workflow.
 * @param {string} macroName Name of macro (e.g. "davinci-export", "crm-form")
 * @param {string} [description=''] Optional summary
 */
export function startRecordingMacro(macroName, description = '') {
    ensureMacroDir();
    const cleanName = String(macroName).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_');
    activeRecording = {
        name: cleanName,
        description: description || `User recorded workflow: ${cleanName}`,
        createdAt: new Date().toISOString(),
        steps: []
    };
    return { ok: true, name: cleanName };
}

/**
 * Append an action step to the currently active macro.
 * @param {object} step
 */
export function recordMacroStep(step) {
    if (!activeRecording) return false;
    activeRecording.steps.push({
        step: activeRecording.steps.length + 1,
        timestamp: Date.now(),
        ...step
    });
    return true;
}

/**
 * Finalize and persist the active macro to disk.
 */
export function stopRecordingMacro() {
    if (!activeRecording) return null;
    ensureMacroDir();
    const targetFile = path.join(MACRO_DIR, `${activeRecording.name}.json`);
    fs.writeFileSync(targetFile, JSON.stringify(activeRecording, null, 2), 'utf8');
    const saved = activeRecording;
    activeRecording = null;
    return saved;
}

/**
 * Check if macro recording is currently active.
 */
export function isRecordingMacro() {
    return activeRecording !== null;
}

/**
 * Load a previously saved macro by name.
 * @param {string} macroName
 */
export function loadMacro(macroName) {
    ensureMacroDir();
    const cleanName = String(macroName).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_');
    const targetFile = path.join(MACRO_DIR, `${cleanName}.json`);
    if (!fs.existsSync(targetFile)) return null;
    try {
        return JSON.parse(fs.readFileSync(targetFile, 'utf8'));
    } catch {
        return null;
    }
}

/**
 * List all saved macros.
 */
export function listMacros() {
    ensureMacroDir();
    const files = fs.readdirSync(MACRO_DIR).filter(f => f.endsWith('.json'));
    const list = [];
    for (const f of files) {
        try {
            const data = JSON.parse(fs.readFileSync(path.join(MACRO_DIR, f), 'utf8'));
            list.push({
                name: data.name,
                description: data.description,
                stepCount: data.steps?.length || 0,
                createdAt: data.createdAt
            });
        } catch {}
    }
    return list;
}
