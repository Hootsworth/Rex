import { exec } from 'child_process';
import util from 'util';
import path from 'path';
import fs from 'fs';
import pc from 'picocolors';
import * as p from '@clack/prompts';

const execAsync = util.promisify(exec);

/**
 * Check current macOS permissions for Accessibility and Screen Recording.
 * @param {boolean} prompt Whether to trigger the native macOS permission prompt if not granted
 * @returns {Promise<{ accessibility: boolean, screenRecording: boolean, allGranted: boolean }>}
 */
export async function checkMacosPermissions(prompt = false) {
    if (process.platform !== 'darwin') {
        return { accessibility: true, screenRecording: true, allGranted: true };
    }

    const swiftScript = `
import Foundation
import Cocoa
import ApplicationServices
import CoreGraphics

func run() {
    let shouldPrompt = CommandLine.arguments.contains("--prompt")
    let accessOpt = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: shouldPrompt] as CFDictionary
    let accessEnabled = AXIsProcessTrustedWithOptions(accessOpt)

    var screenEnabled = false
    if #available(macOS 10.15, *) {
        if shouldPrompt {
            if #available(macOS 11.0, *) {
                screenEnabled = CGRequestScreenCaptureAccess()
            } else {
                screenEnabled = CGPreflightScreenCaptureAccess()
            }
        } else {
            screenEnabled = CGPreflightScreenCaptureAccess()
        }
    }

    let json: [String: Any] = [
        "accessibility": accessEnabled,
        "screenRecording": screenEnabled,
        "allGranted": accessEnabled && screenEnabled
    ]

    if let data = try? JSONSerialization.data(withJSONObject: json, options: []),
       let str = String(data: data, encoding: .utf8) {
        print(str)
    }
}
run()
`;

    try {
        const cacheDir = path.join(process.cwd(), '.rex', 'cache');
        if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

        const scriptPath = path.join(cacheDir, 'perm_check.swift');
        fs.writeFileSync(scriptPath, swiftScript, 'utf8');

        const promptFlag = prompt ? '--prompt' : '';
        const cmd = `swift -module-cache-path "${cacheDir}" "${scriptPath}" ${promptFlag}`;
        const { stdout } = await execAsync(cmd, { timeout: 10000 });
        const trimmed = stdout.trim();
        const jsonLine = trimmed.split('\n').filter(l => l.trim().startsWith('{')).pop();
        if (jsonLine) {
            return JSON.parse(jsonLine);
        }
    } catch (err) {
        // Fallback: check screencapture command for Screen Recording
        let screenRecording = false;
        try {
            const testImg = path.join(process.cwd(), '.rex', 'cache', 'perm_test.png');
            await execAsync(`screencapture -x "${testImg}"`, { timeout: 3000 });
            if (fs.existsSync(testImg) && fs.statSync(testImg).size > 0) {
                screenRecording = true;
                fs.unlinkSync(testImg);
            }
        } catch {}

        return {
            accessibility: false,
            screenRecording,
            allGranted: false,
            error: err.message
        };
    }

    return { accessibility: false, screenRecording: false, allGranted: false };
}

/**
 * Open macOS System Settings directly to the appropriate privacy section.
 * @param {'accessibility'|'screenRecording'|'inputMonitoring'} type
 */
export async function openPrivacySettings(type) {
    if (process.platform !== 'darwin') return;

    let paneUrl = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';
    if (type === 'screenRecording') {
        paneUrl = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';
    } else if (type === 'inputMonitoring') {
        paneUrl = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent';
    }

    try {
        await execAsync(`open "${paneUrl}"`);
    } catch {
        // Fallback to opening System Settings
        await execAsync('open "/System/Applications/System Settings.app"').catch(() => {});
    }
}

/**
 * Interactive helper to ensure all necessary macOS permissions are granted.
 * Prompts the user and opens System Settings panes if required.
 * @param {object} options
 * @param {boolean} [options.silent] Don't log interactive clack banners
 * @returns {Promise<{ accessibility: boolean, screenRecording: boolean, allGranted: boolean }>}
 */
export async function ensureMacosPermissions(options = {}) {
    if (process.platform !== 'darwin') {
        return { accessibility: true, screenRecording: true, allGranted: true };
    }

    // Step 1: Query permissions and trigger native macOS system prompts
    const status = await checkMacosPermissions(true);

    if (options.silent) {
        return status;
    }

    const accessOk = status.accessibility;
    const screenOk = status.screenRecording;

    if (accessOk && screenOk) {
        p.log.success(pc.green('✔ macOS Permissions Verified: Accessibility & Screen Recording are granted!'));
        return status;
    }

    p.note(
        [
            `Rex Screen Cursor requires macOS system permissions to operate as a full-screen companion:\n`,
            `${accessOk ? pc.green('✔') : pc.red('✖')} ${pc.bold('Accessibility')}: Allows Rex to observe and mirror mouse positions, click across apps, and act as your second cursor.`,
            `${screenOk ? pc.green('✔') : pc.red('✖')} ${pc.bold('Screen Recording')}: Allows Rex to visually perceive the display for AI vision and spot UI elements.\n`,
            pc.dim('macOS may have displayed system authorization prompts. If not, click below to open System Settings.')
        ].join('\n'),
        'macOS Permissions Required'
    );

    if (!accessOk) {
        const openAccess = await p.confirm({
            message: 'Open System Settings to enable Accessibility for Terminal / Rex?',
            initialValue: true
        });
        if (openAccess && !p.isCancel(openAccess)) {
            await openPrivacySettings('accessibility');
            p.log.info(pc.cyan('👉 In System Settings > Privacy & Security > Accessibility, toggle your Terminal/App ON.'));
        }
    }

    if (!screenOk) {
        const openScreen = await p.confirm({
            message: 'Open System Settings to enable Screen Recording for Terminal / Rex?',
            initialValue: true
        });
        if (openScreen && !p.isCancel(openScreen)) {
            await openPrivacySettings('screenRecording');
            p.log.info(pc.cyan('👉 In System Settings > Privacy & Security > Screen Recording, toggle your Terminal/App ON.'));
        }
    }

    // Re-check status after user interaction
    const finalStatus = await checkMacosPermissions(false);
    return finalStatus;
}
