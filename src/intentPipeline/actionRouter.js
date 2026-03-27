import { sendFile } from './actions/sendFile.js';
import { readFileAction } from './actions/readFileAction.js';
import { transcribeAudioAction } from './actions/transcribeAudio.js';
import { indexFilesAction } from './actions/indexFiles.js';
import { searchFilesAction } from './actions/searchFiles.js';

const ACTIONS = {
    send_file: sendFile,
    read_file: readFileAction,
    transcribe_audio: transcribeAudioAction,
    index_files: indexFilesAction,
    search_files: searchFilesAction,
    help: async () => ({
        ok: true,
        text: 'Available actions: send_file, read_file, transcribe_audio, index_files, search_files.'
    })
};

export async function runAction(intent, ctx) {
    const handler = ACTIONS[intent.action] || ACTIONS.help;
    return await handler(intent, ctx);
}
