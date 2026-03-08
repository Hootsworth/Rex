import { exec } from 'child_process';
import util from 'util';
import * as p from '@clack/prompts';
import pc from 'picocolors';

const execPromise = util.promisify(exec);

export async function quickDockerPush() {
    const imageName = await p.text({
        message: 'Enter the docker image name (e.g., username/repo:tag):',
        validate: (value) => {
            if (value.trim() === '') return 'Image name is required';
        }
    });

    if (p.isCancel(imageName)) {
        p.log.warn('Docker process cancelled.');
        return;
    }

    const dockerfile = await p.text({
        message: 'Path to Dockerfile (leave empty for current directory):',
        initialValue: '.',
    });

    if (p.isCancel(dockerfile)) {
        p.log.warn('Docker process cancelled.');
        return;
    }

    const s = p.spinner();

    try {
        s.start(`Building Docker image ${imageName}...`);
        await execPromise(`docker build -t ${imageName} ${dockerfile}`);
        s.stop(pc.green(`Successfully built image: ${imageName}`));

        const shouldPush = await p.confirm({
            message: `Do you want to push ${imageName} to DockerHub?`,
            initialValue: true
        });

        if (p.isCancel(shouldPush)) {
            p.log.warn('Push cancelled.');
            return;
        }

        if (shouldPush) {
            s.start(`Pushing ${imageName} to DockerHub...`);
            await execPromise(`docker push ${imageName}`);
            s.stop(pc.green(`Successfully pushed ${imageName} to DockerHub!`));
        }
    } catch (err) {
        s.stop(pc.red('Docker operation failed!'));
        p.log.error(err.message);
        if (err.message.includes('permission denied') || err.message.includes('connect')) {
            p.log.info(pc.yellow('Make sure Docker Desktop is running and you are logged in using `docker login`.'));
        } else if (err.message.includes('denied')) {
            p.log.info(pc.yellow('DockerHub access denied. Are you logged in to the correct repository? Use `docker login`.'));
        }
    }
}
