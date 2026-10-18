import * as p from '@clack/prompts';
import pc from 'picocolors';
import { exec } from 'child_process';
import util from 'util';

const execPromise = util.promisify(exec);

export async function deployTools() {
    const deployer = await p.select({
        message: 'Where would you like to deploy instantly?',
        options: [
            { value: 'vercel', label: '▲ Vercel' },
            { value: 'netlify', label: '🔷 Netlify' },
            { value: 'cancel', label: '❌ Cancel' }
        ]
    });

    if (p.isCancel(deployer) || deployer === 'cancel') return;

    const s = p.spinner();

    if (deployer === 'vercel') {
        const prod = await p.confirm({ message: 'Deploy to Production? (otherwise deploys a preview)', initialValue: true });
        if (p.isCancel(prod)) return;

        s.start('Deploying to Vercel (Ensure you are logged in using `npx vercel login`)....');

        try {
            const cmd = prod ? 'npx vercel --prod --yes' : 'npx vercel --yes';
            const { stdout } = await execPromise(cmd);
            s.stop(pc.green('Vercel Deploy Complete!'));
            p.log.info(stdout);
        } catch (e) {
            s.stop(pc.red('Deploy failed. Note: Vercel requires interactive setup for new projects if `--yes` cannot detect settings.'));
            p.log.error(e.message);
        }
    } else if (deployer === 'netlify') {
        const prod = await p.confirm({ message: 'Deploy to Production?', initialValue: true });
        if (p.isCancel(prod)) return;

        s.start('Deploying to Netlify (Ensure you are logged in using `npx netlify-cli login`)....');

        try {
            const cmd = prod ? 'npx netlify-cli deploy --prod' : 'npx netlify-cli deploy';
            const { stdout } = await execPromise(cmd);
            s.stop(pc.green('Netlify Deploy Complete!'));
            p.log.info(stdout);
        } catch (e) {
            s.stop(pc.red('Deploy failed. Note: Netlify requires linked sites to auto-deploy non-interactively.'));
            p.log.error(e.message);
        }
    }
}
