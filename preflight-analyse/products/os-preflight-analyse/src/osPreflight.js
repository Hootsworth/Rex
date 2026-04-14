import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

function assertWindows() {
  if (process.platform !== 'win32') {
    throw new Error('os-preflight is supported on Windows only.');
  }
}

function getCursorStyles() {
  return ['default', 'handpointing', 'crosshair', 'beam', 'arrow'];
}

function chooseCursorStyle(type, action = {}) {
  if (action.cursorStyle) return String(action.cursorStyle).toLowerCase();
  if (type === 'click') return 'handpointing';
  if (type === 'type') return 'beam';
  if (type === 'move') return 'arrow';
  return 'default';
}

function toWindowsSendKeys(combo) {
  const value = String(combo || '').trim();
  if (!value) return '';

  const parts = value.split('+').map((x) => x.trim().toLowerCase()).filter(Boolean);
  const map = {
    ctrl: '^',
    control: '^',
    alt: '%',
    shift: '+',
    enter: '{ENTER}',
    tab: '{TAB}',
    esc: '{ESC}',
    escape: '{ESC}',
    delete: '{DELETE}',
    backspace: '{BACKSPACE}',
    space: ' '
  };

  let prefix = '';
  let key = '';
  for (const p of parts) {
    if (p in map && ['^', '%', '+'].includes(map[p])) prefix += map[p];
    else key = map[p] || p.toUpperCase();
  }

  return key ? `${prefix}${key}` : '';
}

function normalizeActionArgs(action = {}) {
  const input = { ...(action || {}) };
  const type = String(input.type || '').toLowerCase();
  const normalized = { ...input, type };

  if (type === 'open') {
    normalized.app = input.app || input.application || input.program || input.name || '';
    if (normalized.app && !String(normalized.app).toLowerCase().endsWith('.exe') && /^[a-z0-9_-]+$/i.test(String(normalized.app))) {
      normalized.app = `${normalized.app}.exe`;
    }
  }

  if (type === 'hotkey') {
    const comboInput = input.combo ?? input.keys ?? input.key ?? input.shortcut;
    if (Array.isArray(comboInput)) {
      normalized.combo = comboInput.map((x) => String(x || '').trim()).filter(Boolean).join('+');
    } else {
      normalized.combo = comboInput;
    }
  }

  if (type === 'click' && !normalized.button) normalized.button = 'left';

  normalized.visualCursor = Boolean(input.visualCursor);
  normalized.cursorStyle = input.cursorStyle || input.style || '';
  normalized.loading = Boolean(input.loading);

  return normalized;
}

async function runPowerShell(script, timeout = 8000) {
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', script], { timeout });
  return { stdout: String(stdout || '') };
}

async function getActiveWindowTitle() {
  const script = `
Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow(); [DllImport("user32.dll", CharSet=System.Runtime.InteropServices.CharSet.Unicode)] public static extern int GetWindowText(System.IntPtr hWnd, System.Text.StringBuilder text, int count);' -Name 'Win32' -Namespace 'Rex';
$h = [Rex.Win32]::GetForegroundWindow();
$sb = New-Object System.Text.StringBuilder 1024;
[void][Rex.Win32]::GetWindowText($h, $sb, $sb.Capacity);
$sb.ToString();
`;
  try {
    const { stdout } = await runPowerShell(script, 8000);
    return String(stdout || '').trim();
  } catch {
    return '';
  }
}

export async function runOsPreflight(action = {}) {
  assertWindows();
  const normalizedAction = normalizeActionArgs(action);
  const type = String(normalizedAction.type || '').toLowerCase();
  const activeWindowTitle = await getActiveWindowTitle();
  const warnings = [];
  const errors = [];
  const availableStyles = getCursorStyles();

  if (!type) errors.push('Missing action type.');
  if (type === 'open' && !normalizedAction.app) errors.push('open action requires app (e.g. "notepad.exe").');

  if (type === 'hotkey') {
    if (!normalizedAction.combo) {
      errors.push('hotkey action requires combo (e.g. "CTRL+S").');
    } else {
      const sendKeys = toWindowsSendKeys(normalizedAction.combo);
      if (!sendKeys) errors.push('Could not parse hotkey combo to SendKeys format.');
      normalizedAction._sendKeys = sendKeys;
    }
  }

  if ((type === 'type' || type === 'hotkey') && !activeWindowTitle) {
    warnings.push('No active window title detected; keyboard input may go to the wrong target.');
  }

  if (type === 'type' && activeWindowTitle && !/notepad/i.test(activeWindowTitle)) {
    warnings.push(`Active window is "${activeWindowTitle}"; text may not land in Notepad.`);
  }

  if (normalizedAction.visualCursor) {
    const desired = chooseCursorStyle(type, normalizedAction);
    if (!availableStyles.includes(String(desired).toLowerCase())) {
      warnings.push(`Cursor style "${desired}" is not present in assets; using default profile.`);
    }
  }

  return {
    ok: errors.length === 0,
    type,
    normalizedAction,
    availableCursorStyles: availableStyles,
    activeWindowTitle,
    warnings,
    errors
  };
}
