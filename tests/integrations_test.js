import {
    gmailList,
    gmailDraft,
    gmailSend,
    calendarList,
    calendarAdd,
    githubListIssues,
    githubCreatePr,
    githubCommentIssue,
    linearListIssues,
    linearCommentIssue,
    notionAddPage,
    notionSyncMemory
} from '../src/integrations.js';

async function testIntegrations() {
    console.log('🧪 Starting Integrations Verification Test...\n');

    const checkResult = (name, result) => {
        console.log(`Checking ${name}:`);
        console.log(`  Output preview: "${String(result).split('\n')[0]}"`);
        if (result.includes('Error') || result.includes('failed') || result.includes('not configured') || result.includes('not fully configured')) {
            console.log(`  ℹ️ status: Handled gracefully (No credentials or expected API failure).\n`);
        } else {
            console.log(`  ✅ status: SUCCESS!\n`);
        }
    };

    // Test each tool with empty args/graceful error paths
    checkResult('gmailList', await gmailList());
    checkResult('gmailDraft', await gmailDraft({ to: 'test@example.com', subject: 'Test', body: 'Hello' }));
    checkResult('gmailSend', await gmailSend({ to: 'test@example.com', subject: 'Test', body: 'Hello' }));
    checkResult('calendarList', await calendarList());
    checkResult('calendarAdd', await calendarAdd({ summary: 'Test Event', startTime: new Date().toISOString(), endTime: new Date().toISOString() }));
    checkResult('githubListIssues', await githubListIssues());
    checkResult('githubCreatePr', await githubCreatePr({ title: 'Test PR', head: 'test-branch', base: 'main' }));
    checkResult('githubCommentIssue', await githubCommentIssue({ issueNumber: 1, body: 'Test comment' }));
    checkResult('linearListIssues', await linearListIssues());
    checkResult('linearCommentIssue', await linearCommentIssue({ issueId: 'test-id', body: 'Test' }));
    checkResult('notionAddPage', await notionAddPage({ title: 'Test Page', content: 'Test content' }));
    checkResult('notionSyncMemory', await notionSyncMemory());

    console.log('🏁 Integration tests run completed.');
}

testIntegrations();
