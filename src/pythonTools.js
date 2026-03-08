import { spawn } from 'child_process';

/**
 * Executes Python code and returns the output or error.
 * @param {string} code - The Python code to run
 * @param {AbortSignal} signal - Optional signal to abort the python task
 * @returns {string} - Output from Python
 */
export async function run_python(code, signal = null) {
    return new Promise((resolve) => {
        if (signal?.aborted) return resolve('Aborted');

        const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
        const child = spawn(pythonCmd, ['-c', code], { shell: true, timeout: 15000 });
        
        if (signal) {
            signal.addEventListener('abort', () => {
                child.kill();
                resolve('Aborted');
            });
        }

        let stdout = '';
        let stderr = '';
        
        child.stdout.on('data', (data) => stdout += data.toString());
        child.stderr.on('data', (data) => stderr += data.toString());
        
        child.on('close', (code) => {
            if (code === 0) {
                resolve(stdout || 'Python executed successfully with no output.');
            } else {
                resolve(`Python Error (Exit Code ${code}):\n${stderr || stdout}`);
            }
        });

        child.on('error', (err) => {
            if (err.code === 'ENOENT') {
                resolve(`Python Error: Python is not installed or not in your PATH. Please install Python to use this feature.`);
            } else {
                resolve(`Failed to start Python: ${err.message}`);
            }
        });
    });
}
