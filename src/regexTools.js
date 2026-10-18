import * as p from '@clack/prompts';
import pc from 'picocolors';
import gradient from 'gradient-string';
import { runCompletion } from './ai.js';

export async function regexTools() {
    const prompt = await p.text({
        message: 'Describe what the regex should match (e.g., "valid email addresses", "IPv4 addresses only"):',
        validate: (val) => {
            if (val.trim() === '') return 'Description is required.';
        }
    });

    if (p.isCancel(prompt)) return;

    const s = p.spinner();
    s.start('Generating Regex pattern...');

    const systemPrompt = `You are an expert Regex generator. Given the user's requirement, generate ONLY the raw Regular Expression pattern string. DO NOT include bounding slashes (like /.../g) unless strictly part of the pattern string structure required by Javascript's new RegExp(). DO NOT provide explanations. JUST the raw regex text.`;

    let generatedRegexRaw = '';
    try {
        const aiPrompt = `${systemPrompt}\n\nRequirement: ${prompt}`;
        generatedRegexRaw = await runCompletion(aiPrompt, true);
        generatedRegexRaw = generatedRegexRaw.replace(/```[a-z]*\n?/gi, '').replace(/```/g, '').trim();

        // Strip leading and trailing slashes if AI still included them `/pattern/` -> `pattern`
        if (generatedRegexRaw.startsWith('/') && generatedRegexRaw.lastIndexOf('/') > 0) {
            generatedRegexRaw = generatedRegexRaw.substring(1, generatedRegexRaw.lastIndexOf('/'));
        }

    } catch (e) {
        s.stop(pc.red('Generation failed.'));
        p.log.error(e.message);
        return;
    }

    s.stop('Regex generated.');
    p.note(gradient.pastel(generatedRegexRaw), 'Generated Regex');

    let regexObj;
    try {
        regexObj = new RegExp(generatedRegexRaw, 'g');
    } catch (e) {
        p.log.error(`AI generated an invalid RegExp: ${e.message}`);
        return;
    }

    p.log.info(pc.cyan('Entering Interactive Regex Tester (Type "exit" to quit)'));

    let testing = true;
    while (testing) {
        const testStr = await p.text({
            message: '📝 Test string:'
        });

        if (p.isCancel(testStr) || testStr.toLowerCase() === 'exit') {
            testing = false;
            break;
        }

        // Must reset lastIndex for global regexes before testing again
        regexObj.lastIndex = 0;

        if (regexObj.test(testStr)) {
            p.log.success(`✅ ${pc.green('MATCH')}`);
        } else {
            p.log.error(`❌ ${pc.red('NO MATCH')}`);
        }
    }
}
