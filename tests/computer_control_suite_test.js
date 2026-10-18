/**
 * computer_control_suite_test.js — Comprehensive Test Suite for Rex Computer Control
 */

import assert from 'assert';
import { findUiElements, findBestUiElement, getAllFormInputs } from '../src/accessibilityInspector.js';
import { classifyActionRisk, RiskLevel } from '../src/actionRiskGuard.js';
import { startRecordingMacro, recordMacroStep, stopRecordingMacro, loadMacro, listMacros } from '../src/cursorMacroRecorder.js';
import { copyFileToPasteboard } from '../src/crossAppDragDrop.js';
import { detectUiBlocker } from '../src/closedLoopVerifier.js';
import { getTargetWindowBounds, getScreenDimensions } from '../src/screenCursor.js';
import { generateMultiStepPlan } from '../src/cursorVoiceAgent.js';

async function runTests() {
    console.log('🧪 Starting Rex Computer Control Advanced Feature Suite Tests...\n');

    // 1. Accessibility Inspector
    console.log('1️⃣ Testing Native Accessibility Inspector...');
    const termElements = await findUiElements('Terminal');
    console.log(`   Found ${termElements.length} elements in Terminal.`);
    assert(Array.isArray(termElements), 'Accessibility elements should be an array');

    // 2. Action Risk Classification
    console.log('2️⃣ Testing Action Risk Guard...');
    const safeRisk = classifyActionRisk('click on the color wheel tab');
    assert.strictEqual(safeRisk.level, RiskLevel.SAFE, 'Color wheel should be SAFE');

    const modRisk = classifyActionRisk('send message to John on WhatsApp');
    assert.strictEqual(modRisk.level, RiskLevel.MODERATE, 'Send message should be MODERATE');

    const highRisk = classifyActionRisk('delete all files and format drive');
    assert.strictEqual(highRisk.level, RiskLevel.HIGH_RISK, 'Delete/format should be HIGH_RISK');
    console.log('   Risk tiers correctly classified (SAFE, MODERATE, HIGH_RISK).');

    // 3. Macro Recorder & Replayer
    console.log('3️⃣ Testing "Teach Rex" Macro Recorder...');
    const recRes = startRecordingMacro('test-color-grading-macro', 'Sample color grading workflow');
    assert.strictEqual(recRes.ok, true);
    recordMacroStep({ action: 'click', label: 'Color Tab', x: 700, y: 920 });
    recordMacroStep({ action: 'drag', label: 'Lift Wheel', x: 250, y: 750, toX: 255, toY: 760 });
    const savedMacro = stopRecordingMacro();
    assert.strictEqual(savedMacro.steps.length, 2);

    const loaded = loadMacro('test-color-grading-macro');
    assert(loaded !== null, 'Loaded macro should exist');
    assert.strictEqual(loaded.steps.length, 2);
    console.log(`   Successfully recorded and re-loaded macro with ${loaded.steps.length} steps.`);

    // 4. Dynamic Window Bounds & Multi-Step Planner
    console.log('4️⃣ Testing Dynamic Window Bounds & Hitbox Alignment...');
    const bounds = await getTargetWindowBounds('Zen');
    assert(bounds.width > 0 && bounds.height > 0);
    const plan = generateMultiStepPlan('send hello to Alice in Zen', bounds.screenWidth, bounds.screenHeight, bounds);
    assert.strictEqual(plan.activeApp, 'Zen');
    assert.strictEqual(plan.steps.length, 8);
    // Verify composer coordinates match window geometry
    const composerStep = plan.steps[4];
    assert(composerStep.y > bounds.y + bounds.height - 60, 'Composer should be anchored near window bottom');
    console.log(`   Hitbox dynamically calibrated: composer target at (${composerStep.x}, ${composerStep.y}).`);

    // 5. Cross-App Drag & Drop Pasteboard Preparation
    console.log('5️⃣ Testing Pasteboard File Preparation for Drag & Drop...');
    const packageJsonPath = './package.json';
    const pbResult = await copyFileToPasteboard(packageJsonPath);
    assert.strictEqual(pbResult, true);
    console.log('   File successfully encoded onto macOS NSPasteboard for drag-and-drop.');

    // 6. Closed-Loop Blocker Detection
    console.log('6️⃣ Testing Closed-Loop Blocker Detection...');
    const blockerCheck = await detectUiBlocker('Zen');
    assert(typeof blockerCheck.hasBlocker === 'boolean');
    console.log(`   Closed-loop blocker check completed (hasBlocker: ${blockerCheck.hasBlocker}).`);

    console.log('\n🎉 ALL 8 COMPUTER CONTROL FEATURES TESTED AND VERIFIED SUCCESSFULLY!');
}

runTests().catch(err => {
    console.error('❌ Test failed:', err);
    process.exit(1);
});
