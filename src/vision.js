import * as p from '@clack/prompts';
import pc from 'picocolors';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import util from 'util';
import { runCompletion } from './ai.js';

const execPromise = util.promisify(exec);

export async function captureScreen() {
    const s = p.spinner();
    s.start('Capturing screenshot...');

    try {
        const tempPath = path.join(process.cwd(), '.rex', 'vision');
        if (!fs.existsSync(tempPath)) fs.mkdirSync(tempPath, { recursive: true });
        
        const filename = `screenshot_${Date.now()}.png`;
        const fullPath = path.join(tempPath, filename);

        let cmd = '';
        if (process.platform === 'win32') {
            // Using PowerShell to capture screen on Windows without external deps
            cmd = `powershell -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('{PRTSC}'); Add-Type -AssemblyName System.Drawing; $bmp = [System.Windows.Forms.Clipboard]::GetImage(); if ($bmp) { $bmp.Save('${fullPath}', [System.Drawing.Imaging.ImageFormat]::Png); } else { Write-Error 'Clipboard empty' }"`;
            // Note: PrtSc approach is a bit hacky, but works without extra packages. 
            // Better to use a proper screenshot tool if available.
            // Let's try a more direct PowerShell screen capture
            cmd = `powershell -Command "Add-Type -AssemblyName System.Windows.Forms, System.Drawing; $Screen = [System.Windows.Forms.Screen]::PrimaryScreen; $Width = $Screen.Bounds.Width; $Height = $Screen.Bounds.Height; $Left = $Screen.Bounds.Left; $Top = $Screen.Bounds.Top; $Bitmap = New-Object System.Drawing.Bitmap($Width, $Height); $Graphics = [System.Drawing.Graphics]::FromImage($Bitmap); $Graphics.CopyFromScreen($Left, $Top, 0, 0, $Bitmap.Size); $Bitmap.Save('${fullPath}', [System.Drawing.Imaging.ImageFormat]::Png); $Graphics.Dispose(); $Bitmap.Dispose();"`;
        } else if (process.platform === 'darwin') {
            cmd = `screencapture -x "${fullPath}"`;
        } else {
            cmd = `import -window root "${fullPath}"`; // Linux (requires imagemagick)
        }

        await execPromise(cmd);
        s.stop(`Screenshot saved to ${pc.cyan(filename)}`);
        return fullPath;
    } catch (err) {
        s.stop(pc.red('Screenshot failed.'));
        p.log.error(err.message);
        return null;
    }
}

export async function analyzeScreen(imagePath = null) {
    let targetPath = imagePath;
    if (!targetPath) {
        targetPath = await captureScreen();
    }
    if (!targetPath) return;

    const s = p.spinner();
    s.start('Rex is looking at the image...');

    try {
        // Since we can't easily send images to generic completion without specialized handlers
        // we'll describe it as a placeholder or use a vision-capable model if configured.
        // For now, let's assume Rex describes what he "sees" (simulated or via simple OCR if we add it)
        
        const prompt = `(Note: You are RexAI. You just received an image for analysis at ${targetPath}. 
        Since you are a text-based AI in this CLI, please tell the user that you've received the image and are ready to convert it to HTML/CSS or perform analysis. 
        In a real scenario with a Vision model integration, you would analyze the pixels here.)`;
        
        const res = await runCompletion(prompt, false);
        s.stop('Analysis complete.');
        p.note(res, 'Rex Vision');
        return res;
    } catch (err) {
        s.stop(pc.red('Analysis failed.'));
        p.log.error(err.message);
        return null;
    }
}

export async function visionMenu() {
    const choice = await p.select({
        message: 'Rex Vision:',
        options: [
            { value: 'capture', label: '📸 Capture Screen' },
            { value: 'analyze', label: '👁️ Analyze Screen' },
            { value: 'back', label: '⬅️ Back' }
        ]
    });

    if (p.isCancel(choice) || choice === 'back') return;

    if (choice === 'capture') await captureScreen();
    if (choice === 'analyze') await analyzeScreen();
}
