import { chromium, BrowserContext, Page } from 'playwright';
import TelegramBot from 'node-telegram-bot-api';
import * as fs from 'fs';
import * as dotenv from 'dotenv';
dotenv.config();
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN!, { polling: false });
const CHAT_ID = process.env.TELEGRAM_CHAT_ID!;
console.log("Agente iniciado!");
bot.sendMessage(CHAT_ID, "✅ Agente online e a funcionar!").then(() => {
  console.log("Mensagem enviada para Telegram!");
}).catch(console.error);
