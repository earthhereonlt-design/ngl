import express from 'express';
import { Telegraf, Scenes, session, Context, Markup } from 'telegraf';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import 'dotenv/config';
import { humorMessages } from './messages.ts';
import { appendFile } from 'fs/promises';

const app = express();
const port = process.env.PORT || 3000;

const token = process.env.TELEGRAM_BOT_TOKEN;
const appUrl = process.env.APP_URL;

// --- TYPES ---
interface MySession {
  nglLink?: string;
  customMessage?: string;
  useRandom?: boolean;
  isRunning?: boolean;
  count?: number;
  startTime?: number;
  statusMessageId?: number;
  lastLog?: string;
  __scenes?: any; 
}

interface MyContext extends Context {
  session: MySession;
  scene: Scenes.SceneContextScene<MyContext, Scenes.WizardSessionData>;
  wizard: Scenes.WizardContextWizard<MyContext>;
}

// --- CONSTANTS ---
const BOT_FLOOD_LIMIT_MS = 1000;
const userLastMessageTimes: Map<number, number> = new Map();
const activeIntervals: Map<number, NodeJS.Timeout> = new Map();

// --- SCENES ---
const setupWizard = new Scenes.WizardScene<MyContext>(
  'SETUP_WIZARD',
  async (ctx) => {
    await ctx.reply('💠 *Terminal Setup*\n\n🔗 Please paste the target NGL link:\n_(e.g., https://ngl.link/username)_', { parse_mode: 'Markdown', ...Markup.forceReply() });
    return ctx.wizard.next();
  },
  async (ctx) => {
    if (!ctx.message || !('text' in ctx.message)) return;
    const text = (ctx.message as any).text.trim();
    
    if (!text.includes('ngl.link/')) {
      return ctx.reply('❌ Invalid link. Please provide a valid NGL link.');
    }

    // Skip validation
    ctx.session.nglLink = text;
    await ctx.reply('💠 *Payload Mode*\n\nSelect the type of payload to send:', 
      Markup.keyboard([['Custom Message', 'Spam Mode (Random)']]).oneTime().resize()
    );
    return ctx.wizard.next();
  },
  async (ctx) => {
    if (!ctx.message || !('text' in ctx.message)) return;
    const text = (ctx.message as any).text;

    if (text === 'Spam Mode (Random)' || text === 'Random Humor') {
      ctx.session.useRandom = true;
      ctx.session.customMessage = 'RANDOM_HUMOR_MODE';
      return finishSetup(ctx);
    } else if (text === 'Custom Message') {
      await ctx.reply('💠 Enter your custom message:\n\n_(This will be repeated)_', Markup.removeKeyboard());
      return ctx.wizard.next();
    } else {
      await ctx.reply('Please use the buttons provided.').catch(() => {});
    }
  },
  async (ctx) => {
    if (!ctx.message || !('text' in ctx.message)) return;
    ctx.session.customMessage = (ctx.message as any).text;
    ctx.session.useRandom = false;
    return finishSetup(ctx);
  }
);

async function finishSetup(ctx: MyContext) {
  ctx.session.count = 0;
  ctx.session.isRunning = false;
  
  const modeText = ctx.session.useRandom ? 'Spam Mode (Random)' : `"${ctx.session.customMessage}"`;
  
  await ctx.reply(
    `💠 *Configuration Saved*\n\n` +
    `*Target:* \`${ctx.session.nglLink}\`\n` +
    `*Mode:* ${modeText}\n\n` +
    `Ready to launch.`,
    { 
        parse_mode: 'Markdown', 
        ...Markup.inlineKeyboard([[Markup.button.callback('▶️ Start Terminal', 'action_run')]])
    }
  );
  
  // Clean up any stray reply keyboards just in case
  await ctx.reply('Terminal configured.', Markup.removeKeyboard()).then(m => {
    setTimeout(() => ctx.telegram.deleteMessage(ctx.chat!.id, m.message_id).catch(() => {}), 1000);
  });
  
  return ctx.scene.leave();
}

const stage = new Scenes.Stage<MyContext>([setupWizard]);

async function sendNglMessage(ctx: MyContext, username: string, message: string, deviceId: string) {
    let attempts = 0;
    const maxAttempts = 5;

    while (attempts < maxAttempts) {
        try {
            // Add jitter
            await new Promise(resolve => setTimeout(resolve, Math.random() * 2000));
            const currentUserAgent = USER_AGENTS[currentUserAgentIndex];
            currentUserAgentIndex = (currentUserAgentIndex + 1) % USER_AGENTS.length;
            
            const fakeIp = `${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;

            // 1. Warm up with GET request to get cookies/setup session
            const headers: any = {
                'User-Agent': currentUserAgent,
                'Accept-Language': 'en-US,en;q=0.9',
                'Referer': `https://ngl.link/${username}`,
                'X-Forwarded-For': fakeIp,
                'X-Real-IP': fakeIp
            };
            const response = await axios.get(`https://ngl.link/${username}`, { headers, validateStatus: () => true, timeout: 6000 });
            const cookies = response.headers['set-cookie']?.map(c => c.split(';')[0]).join('; ') || '';

            // 2. Post
            const params = new URLSearchParams();
            params.append('username', username || '');
            params.append('question', message || '');
            params.append('deviceId', deviceId);
            params.append('gameSlug', '');
            params.append('referrer', '');

            const postResponse = await axios.post('https://ngl.link/api/submit', params, {
                headers: {
                    ...headers,
                    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                    'Cookie': cookies,
                    'Origin': 'https://ngl.link'
                },
                validateStatus: () => true,
                timeout: 6000
            });
            
            if (postResponse.status === 200 || postResponse.status === 201) {
                return { success: true, attempts: attempts + 1 };
            } else {
                throw Object.assign(new Error(`HTTP ${postResponse.status}`), { response: postResponse });
            }
        } catch (err: any) {
            attempts++;
            let errorMsg = 'Unknown Error';
            if (err.response) {
                switch (err.response.status) {
                    case 404: errorMsg = 'Profile not found (404)'; break;
                    case 429: errorMsg = 'Rate limited (429)'; break;
                    case 500: case 502: case 503: errorMsg = 'NGL server error'; break;
                    default: errorMsg = `HTTP Error ${err.response.status}`;
                }
            } else if (err.code === 'ECONNABORTED') {
                errorMsg = 'Request timed out';
            } else {
                errorMsg = err.message || errorMsg;
            }

            if (attempts >= maxAttempts) {
                return { success: false, error: errorMsg, attempts };
            }
            
            // Notify UI of retry
            ctx.session.lastLog = `⚠️ Retry ${attempts}/${maxAttempts}... (${errorMsg})`;
            await updateDashboard(ctx);
            
            // Exponential backoff
            await new Promise(resolve => setTimeout(resolve, attempts * 2500));
        }
    }
    
    return { success: false, error: 'Max retries reached', attempts: maxAttempts };
}

let currentUserAgentIndex = 0;
const USER_AGENTS = [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Linux; Android 13; SM-S901B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36',
    'Mozilla/5.0 (iPad; CPU OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/113.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/113.0.0.0 Safari/537.36'
];

// --- LOGGING ---
async function logMessage(username: string, message: string, success: boolean, error?: string) {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] | User: ${username} | Success: ${success} | Message: ${message.replace(/\n/g, ' ')} | Error: ${error || 'None'}\n`;
    try {
        await appendFile('messages.log', logEntry);
    } catch (e) {
        console.error('Failed to write to log file:', e);
    }
}

// --- DASHBOARD UI ---
async function updateDashboard(ctx: MyContext) {
    if (!ctx.session.statusMessageId) return;

    const uptimeSeconds = Math.floor((Date.now() - (ctx.session.startTime || Date.now())) / 1000);
    const h = Math.floor(uptimeSeconds / 3600).toString().padStart(2, '0');
    const m = Math.floor((uptimeSeconds % 3600) / 60).toString().padStart(2, '0');
    const s = (uptimeSeconds % 60).toString().padStart(2, '0');
    const username = ctx.session.nglLink?.split('/').filter(Boolean).pop() || 'Unknown';
    const status = ctx.session.isRunning ? 'ACTIVE 🟢' : 'HALTED ⚪';

    const statusText = 
      `💠 *N G L   T E R M I N A L*\n` +
      `┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n` +
      `🎯 *Target*: \`@${username}\`\n` +
      `⏱ *Uptime*: \`${h}:${m}:${s}\`\n` +
      `📦 *Loaded*: \`${ctx.session.count} msgs\`\n` +
      `⚙️ *Status*: \`${status}\`\n` +
      `┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n` +
      `>_\`${ctx.session.lastLog || 'Awaiting commands...'}\``;

    const keyboard = ctx.session.isRunning 
        ? Markup.inlineKeyboard([[Markup.button.callback('🛑 Stop', 'action_stop')]])
        : Markup.inlineKeyboard([
            [Markup.button.callback('▶️ Start', 'action_run')],
            [Markup.button.callback('⚙️ Config', 'action_setup')]
          ]);

    try {
        await ctx.telegram.editMessageText(ctx.chat.id, ctx.session.statusMessageId, undefined, statusText, { parse_mode: 'Markdown', ...keyboard });
    } catch (e) {
        // Ignore message not modified exception
    }
}

// --- BOT INITIALIZATION ---
const bot = new Telegraf<MyContext>(token || 'DUMMY_TOKEN');

bot.catch((err, ctx) => {
    console.error(`Telegram Bot Error (Update type: ${ctx.updateType}):`, err);
});

bot.use(session());
bot.use(stage.middleware());

// Anti-flood Middleware
bot.use(async (ctx, next) => {
  if (ctx.from) {
    const now = Date.now();
    const lastTime = userLastMessageTimes.get(ctx.from.id) || 0;
    if (now - lastTime < BOT_FLOOD_LIMIT_MS) {
      // Silently ignore to avoid rate limits
      return;
    }
    userLastMessageTimes.set(ctx.from.id, now);
  }
  return next();
});

function getUptimeString(uptimeSeconds: number) {
  const h = Math.floor(uptimeSeconds / 3600).toString().padStart(2, '0');
  const m = Math.floor((uptimeSeconds % 3600) / 60).toString().padStart(2, '0');
  const s = (uptimeSeconds % 60).toString().padStart(2, '0');
  return `${h}:${m}:${s}`;
}

async function startTerminal(ctx: MyContext) {
  if (!ctx.session.nglLink || !ctx.session.customMessage) {
    try { await ctx.reply('⚠️ Setup not complete. Send /start to begin.'); } catch(e) {}
    return;
  }

  if (ctx.session.isRunning) {
    try { await ctx.reply('▶️ Test is already running.'); } catch(e) {}
    return;
  }

  ctx.session.isRunning = true;
  ctx.session.startTime = Date.now();
  ctx.session.count = 0;
  ctx.session.lastLog = 'Initializing terminal core...';

  // Clean UI: Delete previous messages
  if (ctx.message && 'message_id' in ctx.message) {
      try { await ctx.deleteMessage().catch(() => {}); } catch(e) {}
  }
  if (ctx.session.statusMessageId) {
      try { await ctx.telegram.deleteMessage(ctx.chat!.id, ctx.session.statusMessageId).catch(() => {}); } catch(e) {}
  }

  try {
    const initialStatus = await ctx.reply('💠 *N G L   T E R M I N A L*\n`Booting sequence...`', { parse_mode: 'Markdown' });
    ctx.session.statusMessageId = initialStatus.message_id;
    await updateDashboard(ctx);
  } catch (e: any) {
    if (e.response && e.response.error_code === 429) {
        console.error('Rate limited by Telegram:', e.response.description);
    }
  }

  const interval = setInterval(async () => {
    if (!ctx.session.isRunning) {
      clearInterval(interval);
      return;
    }

    // 5-minute reset logic
    const elapsed = Date.now() - (ctx.session.startTime || Date.now());
    if (elapsed >= 5 * 60 * 1000) {
        ctx.session.startTime = Date.now();
        ctx.session.count = 0;
        ctx.session.lastLog = '🔄 Cycle reset (5m heartbeat)...';
        await updateDashboard(ctx);
        return; 
    }
    
    // Initialize data
    const username = ctx.session.nglLink?.split('/').filter(Boolean).pop() || 'Unknown';
    const deviceId = uuidv4();

    let currentMsg = ctx.session.customMessage;
    if (ctx.session.useRandom) {
      const randomIndex = Math.floor(Math.random() * humorMessages.length);
      currentMsg = humorMessages[randomIndex];
      
      const prefixes = ["Oye, ", "Bro, ", "Bhai, ", "", "", "Yo, "];
      const suffixes = [" 😂", " 🔥", " ✨", " 😭", "", ""];
      const randomPrefix = prefixes[Math.floor(Math.random() * prefixes.length)];
      const randomSuffix = suffixes[Math.floor(Math.random() * suffixes.length)];
      
      currentMsg = `${randomPrefix}${currentMsg}${randomSuffix}`;
    }

    // Optional: Just process without preparing state to save Telegram edit API calls
    const result = await sendNglMessage(ctx, username, currentMsg || '', deviceId);
    
    if (result.success) {
        ctx.session.count = (ctx.session.count || 0) + 1;
    }
    
    // Log the result
    await logMessage(username, currentMsg || '', result.success, result.error);
    
    // Result state
    if (!result.success) {
        ctx.session.lastLog = `❌ Failed: ${result.error}`;
    } else {
        ctx.session.lastLog = `✅ Sent: "${currentMsg?.substring(0, 30)}${currentMsg && currentMsg.length > 30 ? '...' : ''}"`;
    }
    await updateDashboard(ctx);
  }, 10000); // 10s intervals for better stability and less block likelihood

  activeIntervals.set(ctx.from!.id, interval);
}

// --- ACTIONS ---
bot.action('action_run', async (ctx) => {
    await ctx.answerCbQuery('Starting Terminal... ▶️');
    startTerminal(ctx as unknown as MyContext);
});

bot.action('action_stop', async (ctx) => {
    const interval = activeIntervals.get(ctx.from!.id);
    if (interval) {
        clearInterval(interval);
        activeIntervals.delete(ctx.from!.id);
        const myCtx = ctx as unknown as MyContext;
        myCtx.session.isRunning = false;
        myCtx.session.lastLog = 'Session Terminated by User';
        await updateDashboard(myCtx);
        await ctx.answerCbQuery('Terminal Stopped! 🛑');
    } else {
        await ctx.answerCbQuery('Test is not running.');
    }
});

bot.action('action_setup', async (ctx) => {
    await ctx.answerCbQuery('Entering Settings ⚙️');
    await (ctx as unknown as MyContext).scene.enter('SETUP_WIZARD');
});

// --- COMMANDS ---
bot.start((ctx) => ctx.scene.enter('SETUP_WIZARD'));

bot.command('run', async (ctx) => {
  startTerminal(ctx);
});


bot.command('stop', async (ctx) => {
  const interval = activeIntervals.get(ctx.from!.id);
  
  // Try to delete user's command message for clean UI
  try { ctx.deleteMessage().catch(() => {}); } catch(e) {}

  if (interval) {
    clearInterval(interval);
    activeIntervals.delete(ctx.from!.id);
    ctx.session.isRunning = false;
    ctx.session.lastLog = 'Session Terminated by User';
    await updateDashboard(ctx);
  } else {
    ctx.reply('Test is not running.').catch(() => {});
  }
});

bot.command('status', (ctx) => {
  const isRunning = ctx.session.isRunning;
  const link = ctx.session.nglLink || 'None';
  const msg = ctx.session.customMessage || 'None';
  const count = ctx.session.count || 0;
  
  let statusMsg = `💠 *System Status*\n\n`;
  statusMsg += `🔹 *State:* ${isRunning ? 'Active 🟢' : 'Idle ⚪'}\n`;
  statusMsg += `🔹 *Target:* \`${link}\`\n`;
  statusMsg += `🔹 *Message:* "${msg}"\n`;
  statusMsg += `🔹 *Cycles:* ${count}\n`;
  
  if (isRunning && ctx.session.startTime) {
    const elapsed = Math.floor((Date.now() - ctx.session.startTime) / 1000);
    statusMsg += `🔹 *Uptime:* ${elapsed}s\n`;
  }

  ctx.reply(statusMsg, { parse_mode: 'Markdown' }).catch(() => {});
});

bot.help((ctx) => {
  ctx.reply(
    '🛠 *Available Commands*\n\n' +
    '/start - Configure bot settings\n' +
    '/run - Start the security test\n' +
    '/stop - Stop the security test\n' +
    '/status - Show current configuration and progress\n' +
    '/help - Show this message',
    { parse_mode: 'Markdown' }
  ).catch(() => {});
});

// --- SERVER SETUP ---
app.use(express.json());

app.get('/', (req, res) => {
  res.send('<h1>🤖 Telegram Bot is Running</h1><p>Status: OK</p>');
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', botActive: !!token, runningTests: activeIntervals.size });
});

if (token && appUrl) {
  const secretPath = `/bot-webhook-${token.slice(-8)}`;
  app.use(bot.webhookCallback(secretPath));
  bot.telegram.setWebhook(`${appUrl}${secretPath}`)
    .then(() => console.log('✅ Webhook registered'))
    .catch((err) => console.error('❌ Webhook error:', err));
} else if (token) {
  bot.launch().then(() => console.log('✅ Bot started (polling)'));
}

app.listen(port, () => console.log(`📡 Port ${port}`));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
