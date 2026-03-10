import fs from 'fs';
import path from 'path';
import os from 'os';

const CONFIG_DIR = path.join(os.homedir(), '.power-cli');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
export const MODELS_DIR = path.join(CONFIG_DIR, 'models');

const DEFAULT_CONFIG = {
  aiModel: 'ollama', // 'ollama', 'openai', or 'local-llama'
  openaiKey: '',
  geminiKey: '',
  claudeKey: '',
  deepseekKey: '',
  ollamaModel: 'llama3:latest', // Default model
  selectedLocalModel: 'rex-fast', // Default local model ID
  multiModelAgentEnabled: false,
  agentRunnerProvider: 'openai',
  agentRunnerModel: 'gpt-5-mini',
  agentPlannerOpenAIModel: 'gpt-4o-mini',
  agentPlannerGeminiModel: 'gemini-2.5-flash',
  agentPermission: 'safe', // 'safe' (ask config) or 'auto-pilot' (autonomous)
  slackWebhookUrl: '',
  discordWebhookUrl: '',
  smtpHost: '',
  smtpPort: 587,
  smtpUser: '',
  smtpPass: ''
};

// Model aliases for quick switching
const MODEL_ALIASES = {
  'fast': 'ollama',       // Cheapest/fastest — fully local
  'smart': 'gemini',      // Best quality available via cloud
  'local': 'local-llama', // Fully offline
  'cheap': 'ollama',      // Synonym for fast
  'best': 'claude'        // Highest quality
};

export function resolveModelAlias(modelName) {
  return MODEL_ALIASES[modelName] || modelName;
}

export function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    return DEFAULT_CONFIG;
  }
  try {
    const data = fs.readFileSync(CONFIG_FILE, 'utf-8');
    return { ...DEFAULT_CONFIG, ...JSON.parse(data) };
  } catch (err) {
    return DEFAULT_CONFIG;
  }
}

export function saveConfig(config) {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}
