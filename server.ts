import express from 'express';
import { Telegraf, Scenes, session, Context, Markup } from 'telegraf';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import 'dotenv/config';
import { humorMessages } from './messages.ts';

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
    await ctx.reply('👋 Welcome to the Security Check Bot.\n\nPlease send the **NGL Link** you want to test (e.g., `https://ngl.link/username`).', { parse_mode: 'Markdown' });
    return ctx.wizard.next();
  },
  async (ctx) => {
    if (!ctx.message || !('text' in ctx.message)) return;
    const text = (ctx.message as any).text.trim();
    
    if (!text.includes('ngl.link/')) {
      return ctx.reply('❌ Invalid link. Please provide a valid NGL link.');
    }

    const username = text.split('/').filter(Boolean).pop();
    await ctx.reply(`🔍 Validating username: \`${username}\`...`, { parse_mode: 'Markdown' });

    try {
      await axios.get(text, { 
        timeout: 8000,
        headers: {
            'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1',
            'Referer': text,
        }
      });
      ctx.session.nglLink = text;
      await ctx.reply('✅ Link validated! Now, do you want to use a **Custom Message** or **Random Humor List**?', 
        Markup.keyboard([['Custom Message', 'Random Humor']]).oneTime().resize()
      );
      return ctx.wizard.next();
    } catch (error: any) {
      let msg = '❌ Could not validate NGL link. Please check the URL or try again later.';
      if (error.response && error.response.status) {
        msg = `❌ Link validation failed (Code: ${error.response.status}). The username might not exist, or the profile is blocked.`;
      } else if (error.code === 'ECONNABORTED') {
        msg = '❌ Connection timed out. Please try again.';
      } else {
        msg = '❌ Failed to connect to the NGL link. The site might be down or blocking requests.';
      }
      return ctx.reply(msg);
    }
  },
  async (ctx) => {
    if (!ctx.message || !('text' in ctx.message)) return;
    const text = (ctx.message as any).text;

    if (text === 'Random Humor') {
      ctx.session.useRandom = true;
      ctx.session.customMessage = 'RANDOM_HUMOR_MODE';
      return finishSetup(ctx);
    } else if (text === 'Custom Message') {
      await ctx.reply('Please send the **Custom Message** you want to use for the test.', Markup.removeKeyboard());
      return ctx.wizard.next();
    } else {
      ctx.reply('Please use the buttons provided.');
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
  
  const modeText = ctx.session.useRandom ? 'Random Humor Mode' : `"${ctx.session.customMessage}"`;
  
  await ctx.reply(
    `✅ *Setup Complete!*\n\n` +
    `🎯 *Target:* \`${ctx.session.nglLink}\`\n` +
    `💬 *Message:* ${modeText}\n\n` +
    `Send /run to start the test.`,
    { parse_mode: 'Markdown', ...Markup.removeKeyboard() }
  );
  return ctx.scene.leave();
}

const stage = new Scenes.Stage<MyContext>([setupWizard]);

async function sendNglMessage(ctx: MyContext, username: string, message: string, deviceId: string) {
    // Add jitter
    await new Promise(resolve => setTimeout(resolve, Math.random() * 3000));
    try {
        const params = new URLSearchParams();
        params.append('username', username || '');
        params.append('question', message || '');
        params.append('deviceId', deviceId);
        params.append('gameSlug', '');
        params.append('referrer', '');

        await axios.post('https://ngl.link/api/submit', params, {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1',
                'Referer': `https://ngl.link/${username}`,
                'Origin': 'https://ngl.link'
            }
        });
        return { success: true };
    } catch (err: any) {
        let errorMsg = 'Unknown error';
        if (err.response) {
            switch (err.response.status) {
                case 404: errorMsg = 'Profile not found (404)'; break;
                case 429: errorMsg = 'Rate limited (429 - slow down)'; break;
                case 500: case 502: case 503: errorMsg = 'NGL server error'; break;
                default: errorMsg = `HTTP Error ${err.response.status}`;
            }
        } else if (err.code === 'ECONNABORTED') {
            errorMsg = 'Request timed out';
        }
        return { success: false, error: errorMsg };
    }
}

// --- BOT INITIALIZATION ---
const bot = new Telegraf<MyContext>(token || 'DUMMY_TOKEN');

bot.use(session());
bot.use(stage.middleware());

// Anti-flood Middleware
bot.use(async (ctx, next) => {
  if (ctx.from) {
    const now = Date.now();
    const lastTime = userLastMessageTimes.get(ctx.from.id) || 0;
    if (now - lastTime < BOT_FLOOD_LIMIT_MS) {
      return ctx.reply('⚠️ Please slow down...');
    }
    userLastMessageTimes.set(ctx.from.id, now);
  }
  return next();
});

// --- COMMANDS ---
bot.start((ctx) => ctx.scene.enter('SETUP_WIZARD'));

bot.command('run', async (ctx) => {
  if (!ctx.session.nglLink || !ctx.session.customMessage) {
    return ctx.reply('⚠️ Setup not complete. Use /start to begin.');
  }

  if (ctx.session.isRunning) {
    return ctx.reply('▶️ Test is already running.');
  }

  ctx.session.isRunning = true;
  ctx.session.startTime = Date.now();
  ctx.session.count = 0;
  ctx.session.lastLog = 'Initializing...';

  // Try to delete user's command message for clean UI
  try { ctx.deleteMessage().catch(() => {}); } catch(e) {}

  const initialStatus = await ctx.reply('🛰 *NGL EXPLORER TERMINAL v1.5.0*\nInitializing dashboard...', { parse_mode: 'Markdown' });
  ctx.session.statusMessageId = initialStatus.message_id;

  const interval = setInterval(async () => {
    if (!ctx.session.isRunning) {
      clearInterval(interval);
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

    // Update helper
    const updateDashboard = async () => {
        const uptimeSeconds = Math.floor((Date.now() - (ctx.session.startTime || Date.now())) / 1000);
        const h = Math.floor(uptimeSeconds / 3600).toString().padStart(2, '0');
        const m = Math.floor((uptimeSeconds % 3600) / 60).toString().padStart(2, '0');
        const s = (uptimeSeconds % 60).toString().padStart(2, '0');
        
        const statusText = 
          `*🛰 NGL EXPLORER TERMINAL v1.6.0*\n` +
          `─────────────────────────────\n` +
          `👤 *Target:* \`${username}\`\n` +
          `⏱ *Uptime:* \`${h}:${m}:${s}\`\n` +
          `📊 *Sent:* \`${ctx.session.count}\` messages 📨\n` +
          `🛡 *Status:* \`RUNNING 🟢\`\n` +
          `─────────────────────────────\n` +
          `📝 *Log:* \`${ctx.session.lastLog}\``;

        if (ctx.session.statusMessageId) {
            await ctx.telegram.editMessageText(ctx.chat.id, ctx.session.statusMessageId, undefined, statusText, { parse_mode: 'Markdown' }).catch(() => {});
        }
    };

    ctx.session.count = (ctx.session.count || 0) + 1;
    
    // Initial preparing state
    ctx.session.lastLog = `⏳ Preparing: "${currentMsg.substring(0, 20)}..."`;
    await updateDashboard();

    const result = await sendNglMessage(ctx, username, currentMsg || '', deviceId);
    
    // Result state
    if (!result.success) {
        ctx.session.lastLog = `❌ ${result.error}`;
    } else {
        ctx.session.lastLog = `✅ Sent: "${currentMsg.substring(0, 20)}..."`;
    }
    await updateDashboard();
  }, 10000);

  activeIntervals.set(ctx.from!.id, interval);
});


bot.command('stop', async (ctx) => {
  const interval = activeIntervals.get(ctx.from!.id);
  
  // Try to delete user's command message for clean UI
  try { ctx.deleteMessage().catch(() => {}); } catch(e) {}

  if (interval) {
    clearInterval(interval);
    activeIntervals.delete(ctx.from!.id);
    ctx.session.isRunning = false;

    // Update the final status
    if (ctx.session.statusMessageId) {
      const username = ctx.session.nglLink?.split('/').filter(Boolean).pop() || 'Unknown';
      const uptimeSeconds = Math.floor((Date.now() - (ctx.session.startTime || Date.now())) / 1000);
      const h = Math.floor(uptimeSeconds / 3600).toString().padStart(2, '0');
      const m = Math.floor((uptimeSeconds % 3600) / 60).toString().padStart(2, '0');
      const s = (uptimeSeconds % 60).toString().padStart(2, '0');
      
      const stoppedStatus = 
        `*🛰 NGL EXPLORER TERMINAL v1.6.0*\n` +
        `─────────────────────────────\n` +
        `👤 *Target:* \`${username}\`\n` +
        `⏱ *Uptime:* \`${h}:${m}:${s}\` (Final)\n` +
        `📊 *Sent:* \`${ctx.session.count}\` messages 📨\n` +
        `🛡 *Status:* \`OFFLINE 🔴\`\n` +
        `─────────────────────────────\n` +
        `📝 *Result:* \`Session Terminated by User\``;
      
      ctx.telegram.editMessageText(ctx.chat.id, ctx.session.statusMessageId, undefined, stoppedStatus, { parse_mode: 'Markdown' }).catch(() => {});
    }
  } else {
    ctx.reply('Test is not running.');
  }
});

bot.command('status', (ctx) => {
  const isRunning = ctx.session.isRunning;
  const link = ctx.session.nglLink || 'None';
  const msg = ctx.session.customMessage || 'None';
  const count = ctx.session.count || 0;
  
  let statusMsg = `📊 *Bot Status*\n\n`;
  statusMsg += `🔹 *State:* ${isRunning ? 'Running 🟢' : 'Idle ⚪'}\n`;
  statusMsg += `🔹 *Target:* \`${link}\`\n`;
  statusMsg += `🔹 *Message:* "${msg}"\n`;
  statusMsg += `🔹 *Cycles:* ${count}\n`;
  
  if (isRunning && ctx.session.startTime) {
    const elapsed = Math.floor((Date.now() - ctx.session.startTime) / 1000);
    statusMsg += `🔹 *Uptime:* ${elapsed}s\n`;
  }

  ctx.reply(statusMsg, { parse_mode: 'Markdown' });
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
  );
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
