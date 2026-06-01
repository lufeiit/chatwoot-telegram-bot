import { Telegraf } from 'telegraf';
import { config } from './config';

/**
 * Telegraf 实例单例。
 * 单独成文件避免 bot.ts ↔ topics.ts / attachments.ts 形成循环依赖。
 */
export const bot = new Telegraf(config.telegramToken);
