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
      await axios.get(text, { timeout: 5000 });
      ctx.session.nglLink = text;
      await ctx.reply('✅ Link validated! Now, do you want to use a **Custom Message** or **Random Humor List**?', 
        Markup.keyboard([['Custom Message', 'Random Humor']]).oneTime().resize()
      );
      return ctx.wizard.next();
    } catch (error) {
      return ctx.reply('❌ Could not validate NGL link. The username might not exist.');
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

bot.command('run', (ctx) => {
  if (!ctx.session.nglLink || !ctx.session.customMessage) {
    return ctx.reply('⚠️ Setup not complete. Use /start to begin.');
  }

  if (ctx.session.isRunning) {
    return ctx.reply('▶️ Test is already running.');
  }

  ctx.session.isRunning = true;
  ctx.session.startTime = Date.now();
  ctx.session.count = 0;

  ctx.reply('🚀 *Security Test Started*', { parse_mode: 'Markdown' });

  const interval = setInterval(() => {
    if (!ctx.session.isRunning) {
      clearInterval(interval);
      return;
    }
    
    ctx.session.count = (ctx.session.count || 0) + 1;
    
    let messageToSend = ctx.session.customMessage;
    if (ctx.session.useRandom) {
      const randomIndex = Math.floor(Math.random() * humorMessages.length);
      messageToSend = humorMessages[randomIndex];
    }

    const username = ctx.session.nglLink?.split('/').filter(Boolean).pop();
    const deviceId = uuidv4();

    console.log(`[TEST] ${ctx.from?.id} -> ${ctx.session.nglLink} | MSG: "${messageToSend}" (Count: ${ctx.session.count})`);
    
    // Actual submission logic
    const params = new URLSearchParams();
    params.append('username', username || '');
    params.append('question', messageToSend || '');
    params.append('deviceId', deviceId);
    params.append('gameSlug', '');
    params.append('referrer', '');

    axios.post('https://ngl.link/api/submit', params, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      }
    }).then(response => {
      console.log(`✅ Success for ${username}: ${response.status}`);
    }).catch(err => {
      console.error(`❌ Error for ${username}: ${err.message}`);
    });
  }, 3000);

  activeIntervals.set(ctx.from!.id, interval);
});


bot.command('stop', (ctx) => {
  const interval = activeIntervals.get(ctx.from!.id);
  if (interval) {
    clearInterval(interval);
    activeIntervals.delete(ctx.from!.id);
    ctx.session.isRunning = false;
    ctx.reply('🛑 *Test Stopped*', { parse_mode: 'Markdown' });
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
