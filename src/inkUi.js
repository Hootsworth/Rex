import React, { useState, useEffect, useRef } from 'react';
import { render, Box, Text, useInput, useApp } from 'ink';
import Spinner from 'ink-spinner';
import TextInput from 'ink-text-input';
import Gradient from 'ink-gradient';
import chalk from 'chalk';
import boxen from 'boxen';
import figlet from 'figlet';
import { Marked } from 'marked';
import TerminalRenderer from 'marked-terminal';

const marked = new Marked();
marked.setOptions({
    renderer: new TerminalRenderer({
        reflowText: true,
        width: 80
    })
});

// Helper to format markdown nicely
function formatMarkdown(text) {
    try {
        return marked.parse(text).trim();
    } catch {
        return text;
    }
}

/** Detect /btw or "btw " prefix (case insensitive) */
function isBtwInput(val) {
    const v = val.trim().toLowerCase();
    return v.startsWith('/btw ') || v.startsWith('btw ');
}

/** Strip the btw prefix and return the raw question */
function extractBtwQuestion(val) {
    const v = val.trim();
    if (v.toLowerCase().startsWith('/btw ')) return v.slice(5).trim();
    if (v.toLowerCase().startsWith('btw ')) return v.slice(4).trim();
    return v;
}

function InkApp({ initialHistory, onStartSession, onBtwQuery }) {
    const { exit } = useApp();
    const [messages, setMessages] = useState([]);
    const [isThinking, setIsThinking] = useState(false);
    const [currentAction, setCurrentAction] = useState('');
    const [inputVal, setInputVal] = useState('');
    const [confirmPrompt, setConfirmPrompt] = useState(null); // { message, resolve }
    const [splashComplete, setSplashComplete] = useState(false);
    const [figletText, setFigletText] = useState('');
    const [btwThinking, setBtwThinking] = useState(false); // side-channel in progress

    // Initial load of messages & figlet splash
    useEffect(() => {
        figlet('REXAI', { font: 'Standard' }, (err, data) => {
            if (!err) setFigletText(data);
        });

        // Load initial history, parsing assistant messages with marked
        const formatted = (initialHistory || []).map(m => {
            if (m.role === 'assistant') {
                return { role: m.role, content: formatMarkdown(m.content) };
            }
            return m;
        });
        setMessages(formatted);

        // Show splash screen for 1.8 seconds
        const timer = setTimeout(() => {
            setSplashComplete(true);
        }, 1800);

        return () => clearTimeout(timer);
    }, []);

    // Handle Ctrl+C or Escape to exit
    useInput((input, key) => {
        if (key.escape || (key.ctrl && input === 'c')) {
            exit();
            process.exit(0);
        }
    });

    const addMessage = (role, content, isMarkdown = false) => {
        const text = isMarkdown ? formatMarkdown(content) : content;
        setMessages(prev => [...prev, { role, content: text }]);
    };

    // ──────────────────────────────────────────────
    //  Side-channel BTW handler (non-blocking)
    // ──────────────────────────────────────────────
    const handleBtwSubmit = async (question) => {
        addMessage('btw_user', `💬 BTW: ${question}`);
        setBtwThinking(true);
        try {
            let answer = '';
            if (typeof onBtwQuery === 'function') {
                answer = await onBtwQuery(question);
            } else {
                answer = '(BTW handler not connected)';
            }
            addMessage('btw_reply', answer, true);
        } catch (err) {
            addMessage('btw_reply', `⚠️ BTW error: ${err.message}`);
        } finally {
            setBtwThinking(false);
        }
    };

    const handleInputSubmit = async (val) => {
        if (!val.trim()) return;
        setInputVal('');

        // If there's an active confirmation prompt
        if (confirmPrompt) {
            const answer = val.trim().toLowerCase();
            const isYes = answer === 'y' || answer === 'yes' || answer === '';
            const resolveFn = confirmPrompt.resolve;
            setConfirmPrompt(null);
            resolveFn(isYes);
            return;
        }

        // ── BTW intercept: fire parallel side-channel while thinking ──
        if (isThinking && isBtwInput(val)) {
            const question = extractBtwQuestion(val);
            if (question) {
                handleBtwSubmit(question); // non-blocking, intentionally not awaited
            }
            return;
        }

        // If still thinking but not a btw command, quietly queue or ignore
        if (isThinking) {
            addMessage('system_log', `⏳ Rex is still working. Use "btw <question>" to ask something on the side, or wait for Rex to finish.`);
            return;
        }

        // Standard user prompt
        addMessage('user', val);
        setIsThinking(true);
        setCurrentAction('Thinking...');

        // Start agent session in background
        try {
            await onStartSession(val, {
                onStepStart: (info) => {
                    setCurrentAction(info || 'Thinking...');
                },
                onToolStart: (toolName, args) => {
                    addMessage('tool_start', `⚡ Executing ${toolName}...`);
                    setCurrentAction(`Running ${toolName}...`);
                },
                onToolResult: (toolName, result) => {
                    const strRes = typeof result === 'object' ? JSON.stringify(result) : String(result);
                    const truncated = strRes.length > 300 ? strRes.substring(0, 300) + '... (truncated)' : strRes;
                    addMessage('tool_result', `✔ Output:\n${truncated}`);
                },
                onAssistantMessage: (text) => {
                    addMessage('assistant', text, true);
                },
                confirm: (message) => {
                    return new Promise((resolve) => {
                        setConfirmPrompt({ message, resolve });
                    });
                }
            });
        } catch (err) {
            addMessage('system_log', `❌ Error: ${err.message}`);
        } finally {
            setIsThinking(false);
            setCurrentAction('');
        }
    };

    // Render Splash Screen
    if (!splashComplete) {
        return React.createElement(
            Box,
            { flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: 12, margin: 2 },
            figletText && React.createElement(
                Gradient,
                { name: 'pastel' },
                React.createElement(Text, null, figletText)
            ),
            React.createElement(
                Text,
                { color: 'cyan', bold: true },
                'Your Autonomous AI Developer Intern'
            ),
            React.createElement(
                Text,
                { color: 'gray' },
                'Loading circuits...'
            )
        );
    }

    // Render Main Chat Interface (show last 15 messages to avoid overflow)
    const visibleMessages = messages.slice(-15);

    // Compose input prompt label based on state
    const inputLabel = confirmPrompt
        ? 'Confirm (Y/n) › '
        : isThinking
            ? '💬 BTW › '
            : 'INPUT › ';
    const inputLabelColor = confirmPrompt ? 'magenta' : isThinking ? 'yellow' : 'green';
    const inputPlaceholder = confirmPrompt
        ? '(y/n)'
        : isThinking
            ? 'Type "btw <question>" to ask something on the side...'
            : 'Type a prompt...';

    return React.createElement(
        Box,
        { flexDirection: 'column', padding: 1 },
        // Header bar
        React.createElement(
            Box,
            { borderStyle: 'round', borderColor: 'cyan', paddingX: 1, flexDirection: 'column' },
            React.createElement(
                Text,
                { bold: true, color: 'blue' },
                '🦖 REXAI SESSION ONLINE | Type /help for commands | Ctrl+C to quit'
            )
        ),
        // Message history
        React.createElement(
            Box,
            { flexDirection: 'column', marginY: 1 },
            visibleMessages.map((msg, index) => {
                if (msg.role === 'user') {
                    return React.createElement(
                        Text,
                        { key: index },
                        React.createElement(Text, { color: 'green', bold: true }, 'You › '),
                        React.createElement(Text, null, msg.content)
                    );
                } else if (msg.role === 'assistant') {
                    return React.createElement(
                        Text,
                        { key: index },
                        React.createElement(Text, { color: 'cyan', bold: true }, 'Rex ›\n'),
                        React.createElement(Text, null, msg.content)
                    );
                } else if (msg.role === 'btw_user') {
                    // BTW user question — styled differently
                    return React.createElement(
                        Text,
                        { key: index },
                        React.createElement(Text, { color: 'yellow', bold: true }, '💬 You BTW › '),
                        React.createElement(Text, { color: 'yellow' }, msg.content.replace('💬 BTW: ', ''))
                    );
                } else if (msg.role === 'btw_reply') {
                    return React.createElement(
                        Box,
                        { key: index, flexDirection: 'column', borderStyle: 'single', borderColor: 'yellow', paddingX: 1, marginY: 0 },
                        React.createElement(Text, { color: 'yellow', bold: true }, '🦖 Rex (side-channel) ›'),
                        React.createElement(Text, { color: 'white' }, msg.content)
                    );
                } else if (msg.role === 'tool_start') {
                    return React.createElement(
                        Text,
                        { key: index, color: 'yellow' },
                        msg.content
                    );
                } else if (msg.role === 'tool_result') {
                    return React.createElement(
                        Text,
                        { key: index, color: 'gray' },
                        msg.content
                    );
                } else {
                    return React.createElement(
                        Text,
                        { key: index, color: 'blue' },
                        msg.content
                    );
                }
            })
        ),
        // Main thinking spinner
        isThinking && React.createElement(
            Box,
            { marginY: 1 },
            React.createElement(
                Text,
                { color: 'yellow' },
                React.createElement(Spinner, { type: 'dots' }),
                ` ${currentAction}`
            )
        ),
        // BTW side-channel spinner (separate from main)
        btwThinking && React.createElement(
            Box,
            { marginBottom: 0 },
            React.createElement(
                Text,
                { color: 'yellow', dimColor: true },
                React.createElement(Spinner, { type: 'arc' }),
                ' Side-channel thinking...'
            )
        ),
        // Confirm prompt banner
        confirmPrompt && React.createElement(
            Text,
            { color: 'magenta', bold: true },
            `⚠️ ${confirmPrompt.message}`
        ),
        // Always-visible input (even while thinking)
        React.createElement(
            Box,
            null,
            React.createElement(Text, { color: inputLabelColor, bold: true }, inputLabel),
            React.createElement(TextInput, {
                value: inputVal,
                onChange: setInputVal,
                onSubmit: handleInputSubmit,
                placeholder: inputPlaceholder
            })
        )
    );
}

export function runInkUi(initialHistory, onStartSession, onBtwQuery) {
    const { waitUntilExit } = render(React.createElement(InkApp, { initialHistory, onStartSession, onBtwQuery }));
    return waitUntilExit();
}
