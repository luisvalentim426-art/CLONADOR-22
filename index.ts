import { chromium, BrowserContext, Page } from 'playwright';
import TelegramBot from 'node-telegram-bot-api';
import * as fs from 'fs';
import * as https from 'https';
import * as http from 'http';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config();

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN!, { polling: true });
const CHAT_ID = process.env.TELEGRAM_CHAT_ID!;

// ─── Config ───────────────────────────────────────────────────────────────────
const MAX_ADS_COLLECT    = 15;
const MAX_ADS_SEND       = 10;
const KEYWORD_GAP_MS     = 15 * 60 * 1000;
const HISTORY_FILE       = 'history.json';
const DETAILED_HISTORY_FILE = 'detailed_history.json';
const PROGRESS_FILE      = 'progress.json';
const HISTORY_TTL_MS     = 23 * 60 * 60 * 1000;
const HISTORY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const CATEGORIES_PER_DAY = 3;
const RUN_HOUR_UTC       = 5;
const MIN_VIDEO_BYTES    = 50_000;
const MIN_IMAGE_BYTES    = 5_000;

const KEYWORD_CATEGORIES: Record<string, string[]> = {
  'PDF':       ['PDF por apenas 9,99', 'PDF por apenas 10', 'PDF por apenas 17', 'PDF por apenas 27', 'PDF por apenas 37', 'PDF por apenas 47'],
  'Receitas':  ['Receitas por apenas 9,99', 'Receitas por apenas 10', 'Receitas por apenas 17', 'Receitas por apenas 27', 'Receitas por apenas 37'],
  'Planner':   ['Planner por apenas 9,99', 'Planner por apenas 10', 'Planner por apenas 17', 'Planner por apenas 27', 'Planner por apenas 37'],
  'Apostila':  ['Apostila por apenas 9,99', 'Apostila por apenas 10', 'Apostila por apenas 17', 'Apostila por apenas 27'],
  'Moldes':    ['Moldes por apenas 10', 'Moldes por apenas 17', 'Moldes por apenas 27'],
  'Kit':       ['Kit completo por apenas 10', 'Kit completo por apenas 17', 'Kit completo por apenas 27', 'Kit completo por apenas 37'],
  'Aulas':     ['Aulas prontas por apenas 17', 'Aulas prontas por apenas 27', 'Aulas prontas por apenas 37'],
  'Material':  ['Material pronto por apenas 17', 'Material pronto por apenas 27'],
  'Pacote':    ['Pacote por apenas 9,99', 'Pacote por apenas 10', 'Pacote por apenas 17', 'Pacote por apenas 27'],
  'Dinamicas': ['Dinâmicas por apenas 17', 'Dinâmicas por apenas 27'],
  'Baixe':     ['Baixe agora por apenas 9,99', 'Baixe agora por apenas 10', 'Baixe agora por apenas 17'],
};

// Black / PLR digital — only run on last day of rotation, after all low-ticket finish
const BLACK_PLR_CATEGORIES: Record<string, string[]> = {
  'BlackPLR': [
    'Choquei', 'Antes e depois', 'Promoção', 'Oferta', '90 off',
    'Últimas vagas', 'Só até meia-noite', 'Acaba hoje', 'Restam poucas unidades',
    'Não perca', 'Emagreça kg em', 'Ganhe R$', 'Fature em casa',
    'Sem precisar de', 'Do zero a', 'Cansado de', 'Chega de',
    'Você já tentou', 'Por que você ainda', 'Mais de pessoas já',
    'Funciona mesmo para', 'Resultados reais', 'Para quem é iniciante',
    'Para mães que', 'Para quem não tem tempo',
  ],
};

const COUNTRIES = ['BR'];
const MZ_COUNTRY = 'MZ';

// Domains that should never be followed as funnel targets
const FUNNEL_DOMAIN_BLACKLIST = [
  'facebook.com', 'fb.com', 'instagram.com', 'google.com', 'youtube.com',
  'twitter.com', 'x.com', 'tiktok.com', 'amazon.com', 'amazon.com.br',
  'ebay.com', 'mercadolivre.com', 'mercadolibre.com', 'olx.com.br',
  'olx.pt', 'linkedin.com', 'pinterest.com', 'reddit.com',
  'play.google.com', 'apps.apple.com', 'apple.com',
  'adjust.com', 'onelink.to', 'branch.io', 'firebase.com',
  'wa.me', 'whatsapp.com', 'l.facebook.com', 'lm.facebook.com',
  'bit.ly', 'tinyurl.com', 'shorturl.at', 'cutt.ly',
];

// Mozambique: just detect tech + checkout presence, no price filter
const MZ_TECH_PATTERNS  = ['lovable', 'vercel', 'bolt.new', 'bolt.diy'];
const MZ_CHECKOUT_PATTERNS = ['escalepay', 'escale.pay', 'ratixpay', 'ratix.pay', 'lojou', 'kambafy', 'zenofy'];

// ─── Types ────────────────────────────────────────────────────────────────────

interface ScoredAd {
  advertiser: string;
  keyword: string;
  country: string;
  score: number;
  price: string;
  priceNum: number | null;
  creativeType: string;
  dateText: string | null;
  hasVSL: boolean;
  hasQuiz: boolean;
  hasUpsell: boolean;
  hasDownsell: boolean;
  hasCheckout: boolean;
  hasLongCopy: boolean;
  funnelSteps: number;
  funnelType: string;
  domains: string[];
  platform: string;
  funnelUrl: string;
  landingDomain: string;
  cleanCopy: string;
  creativePath: string | null;
  creativeIsVideo: boolean;
  funnelStepData: any[];
  offerAnalysis: OfferAnalysis;
  similarCount: number;
  offerAngle: string;
  creativeStyle: string;
  funnelComplexity: 'simples' | 'médio' | 'avançado';
  performanceConfidence: 'baixo' | 'médio' | 'alto';
  recommendationLevel: string;
  offerTitle: string;   // real product name extracted from funnel page
  isMozambique?: boolean;
  mzTech?: string;
  mzCheckout?: string;
}

interface OfferAnalysis {
  product: string;
  mainPromise: string;
  hasBonus: boolean;
  hasUrgency: boolean;
  hasRecurring: boolean;
  hasGuarantee: boolean;
  ctaStrength: 'fraco' | 'médio' | 'forte';
}

// ─── Bot state (for Telegram commands) ────────────────────────────────────────

let botRunning             = false;
let currentKeyword: string | null = null;
let nextKeywordHint: string | null = null;  // upcoming keyword name for /proxima display
let offersFoundToday       = 0;
let skipCurrentKeyword     = false;
let waitUntilMs: number | null = null;
let skipWaitUntilNextRun   = false;

// Global in-memory dedup history — reset by /resetarsemana without needing a file delete
let globalHistory: History = {};

// ─── Detailed History (for /historico) ────────────────────────────────────────

interface DetailedHistoryEntry {
  date: string;
  keyword: string;
  country: string;
  advertiser: string;
  offerTitle: string;
  score: number;
  funnelUrl: string;
  platform: string;
  funnelType: string;
  offerAngle: string;
  origin?: 'auto' | 'url_manual';
  analyzedAt?: number;
}

function loadDetailedHistory(): DetailedHistoryEntry[] {
  try {
    if (fs.existsSync(DETAILED_HISTORY_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DETAILED_HISTORY_FILE, 'utf8'));
      return Array.isArray(raw) ? raw : [];
    }
  } catch {}
  return [];
}

function saveDetailedHistory(entries: DetailedHistoryEntry[]) {
  try {
    const trimmed = entries.slice(-200);
    fs.writeFileSync(DETAILED_HISTORY_FILE, JSON.stringify(trimmed, null, 2));
  } catch {}
}

function appendDetailedHistory(ad: ScoredAd, origin: 'auto' | 'url_manual' = 'auto') {
  const entries = loadDetailedHistory();
  entries.push({
    date: new Date().toISOString().split('T')[0],
    keyword: ad.keyword,
    country: ad.country,
    advertiser: ad.advertiser,
    offerTitle: ad.offerTitle,
    score: ad.score,
    funnelUrl: ad.funnelUrl,
    platform: ad.platform,
    funnelType: ad.funnelType,
    offerAngle: ad.offerAngle,
    origin,
    analyzedAt: Date.now(),
  });
  saveDetailedHistory(entries);
}

// ─── History ──────────────────────────────────────────────────────────────────

type HistoryEntry = { lastSeen: number; score: number; advertiser: string };
type History = Record<string, HistoryEntry>;

function loadHistory(): History {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const raw = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
      const createdAt: number = raw._meta?.createdAt ?? Date.now();
      const ageMs = Date.now() - createdAt;
      if (ageMs > HISTORY_MAX_AGE_MS) {
        console.log(`[HISTORY] ${Math.round(ageMs / 86400000)} days old — clearing for fresh start`);
        return {};
      }
      const { _meta, ...entries } = raw;
      return entries as History;
    }
  } catch {}
  return {};
}

function saveHistory(h: History) {
  try {
    let createdAt = Date.now();
    try {
      if (fs.existsSync(HISTORY_FILE)) {
        const prev = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
        if (prev._meta?.createdAt && (Date.now() - prev._meta.createdAt) <= HISTORY_MAX_AGE_MS)
          createdAt = prev._meta.createdAt;
      }
    } catch {}
    fs.writeFileSync(HISTORY_FILE, JSON.stringify({ _meta: { createdAt }, ...h }, null, 2));
  } catch {}
}

function wasRecentlyAnalyzed(h: History, key: string): boolean {
  const e = h[key];
  return !!e && (Date.now() - e.lastSeen) < HISTORY_TTL_MS;
}

function markAnalyzed(h: History, key: string, score: number, advertiser: string) {
  h[key] = { lastSeen: Date.now(), score, advertiser };
}

// ─── Progress ─────────────────────────────────────────────────────────────────

const ALL_CATEGORY_NAMES = Object.keys(KEYWORD_CATEGORIES);

interface Progress {
  nextCategoryIndex: number;
  runDate: string;
  todayCategories: string[];
  completedToday: string[];
  rotationDay: number;
}

function todayUTC(): string {
  return new Date().toISOString().split('T')[0];
}

function loadProgress(): Progress {
  try {
    if (fs.existsSync(PROGRESS_FILE)) return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
  } catch {}
  return { nextCategoryIndex: 0, runDate: '', todayCategories: [], completedToday: [], rotationDay: 0 };
}

function saveProgress(p: Progress) {
  try { fs.writeFileSync(PROGRESS_FILE, JSON.stringify(p, null, 2)); } catch {}
}

function isLastDayOfRotation(p: Progress): boolean {
  const totalCats = ALL_CATEGORY_NAMES.length;
  return (p.nextCategoryIndex + CATEGORIES_PER_DAY) >= totalCats;
}

function planTodayCategories(p: Progress): Progress {
  const today = todayUTC();
  if (p.runDate === today && p.todayCategories.length > 0) {
    return p;
  }
  const n = ALL_CATEGORY_NAMES.length;
  const cats: string[] = [];
  for (let i = 0; i < CATEGORIES_PER_DAY; i++) {
    cats.push(ALL_CATEGORY_NAMES[(p.nextCategoryIndex + i) % n]);
  }
  const newRotationDay = (p.rotationDay || 0) + 1;
  const next: Progress = {
    nextCategoryIndex: (p.nextCategoryIndex + CATEGORIES_PER_DAY) % n,
    runDate: today,
    todayCategories: cats,
    completedToday: [],
    rotationDay: newRotationDay,
  };
  saveProgress(next);
  return next;
}

async function waitUntilNextRun() {
  const now = new Date();
  const next = new Date();
  next.setUTCHours(RUN_HOUR_UTC, 0, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  const ms = next.getTime() - now.getTime();
  const h  = Math.floor(ms / 3600000);
  const m  = Math.floor((ms % 3600000) / 60000);
  waitUntilMs = next.getTime();
  skipWaitUntilNextRun = false;
  console.log(`[SCHEDULE] Sleeping ${h}h ${m}m until 05:00 UTC`);
  await sendToTelegram(`⏰ <b>Análise diária concluída.</b>\nPróxima execução em <b>${h}h ${m}m</b> (05:00 UTC / 07:00 Moçambique).`);
  // Interruptible wait — /proximodia can break out early
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (skipWaitUntilNextRun) { skipWaitUntilNextRun = false; break; }
    await delay(5000);
  }
  waitUntilMs = null;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function delay(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function sendToTelegram(message: string) {
  try {
    await bot.sendMessage(CHAT_ID, message.substring(0, 4096), { parse_mode: 'HTML', disable_web_page_preview: true });
  } catch (err) { console.error('TG msg error:', err); }
}

async function sendPhoto(filePath: string, caption: string) {
  try {
    if (!fs.existsSync(filePath)) return;
    const stat = fs.statSync(filePath);
    if (stat.size < MIN_IMAGE_BYTES) { fs.unlinkSync(filePath); return; }
    try {
      await bot.sendPhoto(CHAT_ID, filePath, { caption: caption.substring(0, 1024) });
    } catch (photoErr: any) {
      const errStr = String(photoErr?.message || photoErr || '');
      const isPhotoErr = errStr.includes('PHOTO_INVALID') || errStr.includes('PHOTO_SAVE') || errStr.includes('400');
      if (isPhotoErr) {
        try { await bot.sendDocument(CHAT_ID, filePath, { caption: caption.substring(0, 1024) }); }
        catch { }
      } else { throw photoErr; }
    }
    fs.unlinkSync(filePath);
  } catch (err) { console.error('Photo error:', err); safeDelete(filePath); }
}

async function sendScreenshot(filePath: string, caption: string) {
  try {
    if (!fs.existsSync(filePath)) return;
    const stat = fs.statSync(filePath);
    if (stat.size < MIN_IMAGE_BYTES) { fs.unlinkSync(filePath); return; }
    await bot.sendDocument(CHAT_ID, filePath, { caption: caption.substring(0, 1024) });
    fs.unlinkSync(filePath);
  } catch (err) { console.error('Screenshot error:', err); safeDelete(filePath); }
}

async function sendVideo(filePath: string, caption: string) {
  try {
    if (!fs.existsSync(filePath)) return;
    const stat = fs.statSync(filePath);
    if (stat.size < MIN_VIDEO_BYTES) { fs.unlinkSync(filePath); return; }
    try {
      await bot.sendVideo(CHAT_ID, filePath, { caption: caption.substring(0, 1024) });
    } catch (videoErr: any) {
      const errStr = String(videoErr?.message || videoErr || '');
      if (errStr.includes('400') || errStr.includes('VIDEO_INVALID')) {
        try { await bot.sendDocument(CHAT_ID, filePath, { caption: caption.substring(0, 1024) }); }
        catch {}
      } else { throw videoErr; }
    }
    fs.unlinkSync(filePath);
  } catch (err) { console.error('Video error:', err); safeDelete(filePath); }
}

function safeDelete(filePath: string) {
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
}

// Normalize a URL for deduplication: keep host+path, strip query params and tracking tokens
function normalizeUrlForDedup(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const path = u.pathname.toLowerCase().replace(/\/$/, '');
    return `${u.hostname.toLowerCase()}${path}`;
  } catch {
    return url.toLowerCase().substring(0, 150);
  }
}

function isDomainBlacklisted(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return FUNNEL_DOMAIN_BLACKLIST.some(d => hostname === d || hostname.endsWith('.' + d));
  } catch { return false; }
}

function downloadFile(url: string, dest: string, minBytes = 0, depth = 0): Promise<boolean> {
  if (depth > 5) return Promise.resolve(false);
  return new Promise((resolve) => {
    const file = fs.createWriteStream(dest);
    const protocol = url.startsWith('https') ? https : http;
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://www.facebook.com/',
        'Accept': '*/*',
      }
    };
    const req = protocol.get(url, options, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close(); fs.unlink(dest, () => {});
        downloadFile(res.headers.location!, dest, minBytes, depth + 1).then(resolve);
        return;
      }
      if (res.statusCode && res.statusCode !== 200) {
        file.close(); fs.unlink(dest, () => {}); resolve(false); return;
      }
      res.pipe(file);
      file.on('finish', () => {
        file.close();
        try {
          const size = fs.statSync(dest).size;
          if (minBytes > 0 && size < minBytes) { fs.unlinkSync(dest); resolve(false); }
          else resolve(true);
        } catch { resolve(false); }
      });
    });
    req.on('error', () => { fs.unlink(dest, () => {}); resolve(false); });
    req.setTimeout(45000, () => { req.destroy(); fs.unlink(dest, () => {}); resolve(false); });
  });
}

// ─── Intelligence Functions ───────────────────────────────────────────────────

function extractPrice(text: string): number | null {
  const patterns = [
    /R\$\s*(\d+[.,]\d{0,2})/gi,
    /por apenas\s*R?\$?\s*(\d+[.,]\d{0,2})/gi,
    /apenas\s*R?\$?\s*(\d+[.,]\d{0,2})/gi,
    /(\d+[.,]\d{0,2})\s*reais/gi,
  ];
  for (const p of patterns) {
    p.lastIndex = 0;
    const m = p.exec(text);
    if (m) {
      const price = parseFloat(m[1].replace(',', '.'));
      if (price >= 5 && price <= 200) return price;
    }
  }
  return null;
}

function calculateScore(d: {
  hasVSL: boolean; hasQuiz: boolean; hasUpsell: boolean; hasDownsell: boolean;
  funnelSteps: number; hasCTA: boolean; hasCheckout: boolean; hasLongCopy: boolean;
}): number {
  let s = 0;
  if (d.hasVSL)                      s += 2;
  if (d.hasQuiz)                     s += 2;
  if (d.hasUpsell || d.hasDownsell)  s += 2;
  if (d.funnelSteps > 1)             s += 1;
  if (d.hasCTA)                      s += 1;
  if (d.hasCheckout)                 s += 1;
  if (d.hasLongCopy)                 s += 1;
  return Math.max(1, Math.min(s, 10));
}

function detectPlatform(url: string, text: string): string {
  const u = url.toLowerCase(), t = text.toLowerCase();
  if (u.includes('hotmart') || t.includes('hotmart'))         return 'Hotmart';
  if (u.includes('kiwify') || t.includes('kiwify'))           return 'Kiwify';
  if (u.includes('eduzz') || t.includes('eduzz'))             return 'Eduzz';
  if (u.includes('cakto') || t.includes('cakto'))             return 'Cakto';
  if (u.includes('kirvano') || t.includes('kirvano'))         return 'Kirvano';
  if (u.includes('perfectpay') || t.includes('perfectpay') || u.includes('perfect-pay') || t.includes('perfect pay')) return 'Perfect Pay';
  if (u.includes('zenofy') || t.includes('zenofy'))           return 'Zenofy';
  if (u.includes('monetizze') || t.includes('monetizze'))     return 'Monetizze';
  if (u.includes('pepper.com') || t.includes('pepper'))       return 'Pepper';
  if (u.includes('braip') || t.includes('braip'))             return 'Braip';
  if (u.includes('wa.me') || u.includes('whatsapp'))          return 'WhatsApp';
  if (u.includes('/checkout') || u.includes('pay.'))          return 'Checkout direto';
  return 'Direto';
}

function detectTechnology(url: string, html: string): string {
  const u = url.toLowerCase(), h = html.toLowerCase();
  if (u.includes('lovable') || h.includes('lovable'))         return 'Lovable';
  if (u.includes('bolt.new') || u.includes('bolt.diy') || h.includes('bolt.new')) return 'Bolt';
  if (u.includes('vercel.app') || h.includes('_next/static') || h.includes('vercel')) return 'Vercel';
  return '';
}

function detectMzCheckout(url: string, text: string): string {
  const u = url.toLowerCase(), t = text.toLowerCase();
  if (u.includes('escalepay') || t.includes('escale pay') || t.includes('escalepay')) return 'Escale Pay';
  if (u.includes('ratixpay') || t.includes('ratix pay') || t.includes('ratixpay'))   return 'Ratix Pay';
  if (u.includes('lojou') || t.includes('lojou'))             return 'Lojou';
  if (u.includes('kambafy') || t.includes('kambafy'))         return 'Kambafy';
  if (u.includes('zenofy') || t.includes('zenofy'))           return 'Zenofy';
  return '';
}

function classifyPage(text: string, hasVideo: boolean, radioInputs: number, url: string): string {
  const lower = text.toLowerCase();
  const isCheckoutUrl = url.includes('checkout') || url.includes('pagamento') || url.includes('pay.') || url.includes('/cart');
  const hasCheckoutSignals = lower.includes('finalizar compra') || lower.includes('dados do cartão') || lower.includes('cartão de crédito') || lower.includes('número do cartão') || lower.includes('cvv') || lower.includes('boleto') || lower.includes('pix') || isCheckoutUrl;

  if (hasCheckoutSignals)  return 'CHECKOUT';
  if (hasVideo)            return 'VSL';
  if (lower.includes('upsell') || lower.includes('leve também') || lower.includes('adicione ao pedido')) return 'UPSELL';
  if ((lower.includes('espera') && (lower.includes('sair') || lower.includes('chance'))) || lower.includes('última chance')) return 'DOWNSELL';
  const hasQuizContent = lower.includes('quiz') || lower.includes('próxima pergunta') || lower.includes('qual é o seu') || lower.includes('como você se sente');
  if ((radioInputs >= 2 && hasQuizContent) || (lower.includes('quiz') && !hasCheckoutSignals)) return 'QUIZ';
  if (lower.includes('whatsapp') || lower.includes('wa.me')) return 'WHATSAPP';
  return 'LANDING';
}

function analyzeOffer(copy: string, funnelText: string): OfferAnalysis {
  const all = (copy + ' ' + funnelText).toLowerCase();

  const product = (() => {
    const m = copy.match(/(pdf|planner|apostila|kit|curso|treinamento|receitas|moldes|aulas|pacote|guia|método|programa|mentoria)[^.!?\n]{0,60}/i);
    return m ? m[0].trim().substring(0, 80) : 'Produto digital';
  })();

  const mainPromise = (() => {
    const patterns = [/descubra[^.!?\n]{0,80}/i, /aprenda[^.!?\n]{0,80}/i, /transforme[^.!?\n]{0,80}/i, /conquiste[^.!?\n]{0,80}/i, /emagreça[^.!?\n]{0,80}/i, /ganhe[^.!?\n]{0,80}/i];
    for (const p of patterns) { const m = copy.match(p); if (m) return m[0].trim(); }
    const first = copy.split('\n').find(l => l.length > 30);
    return first ? first.substring(0, 80) : 'Transformação prometida';
  })();

  const hasBonus     = /bônus|brinde|grátis|presente|extra/i.test(all);
  const hasUrgency   = /últimas vagas|apenas hoje|acaba em|restam|limitad|promoção termina|corre/i.test(all);
  const hasRecurring = /mensal|assinatura|plano|por mês|\/mês/i.test(all);
  const hasGuarantee = /garantia|reembolso|devolvemos|dinheiro de volta/i.test(all);

  const ctaStrong = /clique agora|garantir minha|quero acesso|comprar agora|baixar agora|sim, quero/i.test(all);
  const ctaMedium = /clique|garantir|acessar|baixar|comprar|quero/i.test(all);
  const ctaStrength: OfferAnalysis['ctaStrength'] = ctaStrong ? 'forte' : ctaMedium ? 'médio' : 'fraco';

  return { product, mainPromise, hasBonus, hasUrgency, hasRecurring, hasGuarantee, ctaStrength };
}

function buildCloneReasons(ad: ScoredAd): string {
  const reasons: string[] = [];
  if (ad.hasVSL)     reasons.push('🎬 VSL presente — maior tempo de atenção e conversão');
  if (ad.hasQuiz)    reasons.push('🧩 Quiz flow — qualifica leads antes do checkout');
  if (ad.hasUpsell)  reasons.push('⬆️ Upsell estruturado — maximiza ticket médio');
  if (ad.hasCheckout) reasons.push('🛒 Checkout integrado — funil completo');
  if (ad.hasLongCopy) reasons.push('📝 Copy longa — alto poder persuasivo');
  if (ad.offerAnalysis.hasBonus) reasons.push('🎁 Bônus presente — aumenta valor percebido');
  if (ad.offerAnalysis.hasUrgency) reasons.push('⏰ Urgência/escassez — impulsiona decisão');
  if (ad.offerAnalysis.hasGuarantee) reasons.push('🛡️ Garantia explícita — reduz fricção');
  if (ad.offerAnalysis.ctaStrength === 'forte') reasons.push('💪 CTA forte — ação direta');
  if (ad.funnelSteps > 2) reasons.push(`📊 Funil de ${ad.funnelSteps} etapas — alta sofisticação`);
  return reasons.length > 0 ? reasons.join('\n') : '✅ Melhor score geral na keyword';
}

function detectOfferAngle(copy: string, funnelText: string): string {
  const all = (copy + ' ' + funnelText).toLowerCase();

  if (/últimas vagas|acaba hoje|apenas hoje|termina em|restam \d|vagas limitadas|corre que|só até/i.test(all))
    return '⏰ Urgência';
  if (/segredo|você não vai acreditar|descubra o que|ninguém te conta|método proibido|hack|truque/i.test(all))
    return '🤫 Curiosidade';
  if (/antes.*depois|resultado real|comprovado|perdeu \d|eliminei|emagreci|consegui|mudou minha/i.test(all))
    return '🔄 Antes/depois';
  if (/cansad[ao] de|frustrad[ao]|dificuldade|sofrendo|sem conseguir|tentei tudo|não funciona|dor de/i.test(all))
    return '😣 Baseado em dor';
  if (/transforme|mude sua vida|nova versão|nova fase|conquiste|evolução|mudança real/i.test(all))
    return '✨ Transformação';
  if (/ganhe dinheiro|renda extra|liberdade financeira|faturar|lucro|monetize|independência financeira/i.test(all))
    return '💰 Financeiro';
  if (/especialista|anos de experiência|formad[ao]|certificad[ao]|médico|nutricionista|coach|autoridade/i.test(all))
    return '🏆 Autoridade';
  if (/família|filho|amor|emoção|conexão|felicidade|sonho|história|depoimento/i.test(all))
    return '❤️ Emocional';
  if (/aproveite|oportunidade única|chance|agora é a hora|não perca essa|momento certo/i.test(all))
    return '🚀 Oportunidade';
  return '💡 Informativo';
}

function detectCreativeStyle(hasVideo: boolean, imageCount: number, copy: string): string {
  const c = copy.toLowerCase();
  if (!hasVideo) {
    if (/antes.*depois|resultado.*\d+(kg|dias|semanas)/i.test(c)) return '🔄 Antes/depois';
    if (imageCount > 1)                                             return '🖼️ Slideshow';
    return '🖼️ Banner estático';
  }
  if (/tutorial|passo a passo|como fazer|veja como|tela do/i.test(c)) return '🖥️ Screen recording';
  if (/depoimento|resultado real|cliente|usou|funcionou pra mim|minha experiência/i.test(c)) return '💬 Testemunho';
  if (/gerado por ia|feito com ia|ia criou|ai generated/i.test(c)) return '🤖 IA gerado';
  if (/câmera|filmagem|produção|estúdio|profissional|cinematográf/i.test(c)) return '🎬 Cinemático';
  if (/olha|aqui|to mostrando|fiz isso|eu mesm[ao]|gravei aqui/i.test(c)) return '📱 UGC';
  return '🎙️ Talking head';
}

function detectFunnelComplexity(ad: Pick<ScoredAd, 'funnelSteps' | 'hasQuiz' | 'hasVSL' | 'hasUpsell' | 'hasDownsell' | 'domains'>): 'simples' | 'médio' | 'avançado' {
  const { funnelSteps, hasQuiz, hasVSL, hasUpsell, hasDownsell, domains } = ad;
  const quizAndUpsell = hasQuiz && (hasUpsell || hasDownsell);
  const multiDomain   = domains.length > 1;
  if (quizAndUpsell || funnelSteps >= 4 || (hasVSL && hasUpsell && funnelSteps >= 3) || (multiDomain && funnelSteps >= 3)) return 'avançado';
  if (funnelSteps >= 2 || hasQuiz || hasUpsell || hasVSL) return 'médio';
  return 'simples';
}

function detectPerformanceConfidence(ad: Pick<ScoredAd, 'score' | 'similarCount' | 'funnelComplexity' | 'hasVSL' | 'offerAnalysis'>): 'baixo' | 'médio' | 'alto' {
  let points = 0;
  if (ad.score >= 7)                                    points += 3;
  else if (ad.score >= 5)                               points += 2;
  else if (ad.score >= 3)                               points += 1;
  if (ad.similarCount >= 3)                             points += 2;
  else if (ad.similarCount >= 2)                        points += 1;
  if (ad.funnelComplexity === 'avançado')               points += 2;
  else if (ad.funnelComplexity === 'médio')             points += 1;
  if (ad.hasVSL)                                        points += 1;
  if (ad.offerAnalysis.ctaStrength === 'forte')         points += 1;
  if (ad.offerAnalysis.hasUrgency && ad.offerAnalysis.hasBonus) points += 1;

  if (points >= 8) return 'alto';
  if (points >= 4) return 'médio';
  return 'baixo';
}

function computeRecommendationLevel(ad: ScoredAd): string {
  const conf = ad.performanceConfidence;
  const cplx = ad.funnelComplexity;
  if (conf === 'alto' && cplx === 'avançado') return '🔥 Clonar agora';
  if (conf === 'alto')                         return '✅ Alta prioridade';
  if (conf === 'médio' && cplx !== 'simples')  return '👀 Vale testar';
  if (conf === 'médio')                         return '📌 Monitorar';
  return '⚪ Referência apenas';
}

async function sendComparisonTable(ads: ScoredAd[], keyword: string, country: string) {
  if (ads.length === 0) return;
  const countryName = country === 'BR' ? '🇧🇷' : '🇲🇿';
  const confIcon = (c: string) => c === 'alto' ? '🟢' : c === 'médio' ? '🟡' : '🔴';
  const yn       = (b: boolean) => b ? '✅' : '❌';

  let table = `📊 <b>TABELA COMPARATIVA — ${keyword} ${countryName}</b>\n\n`;
  table += `<code>`;
  table += `#  Anunciante             Sc  VSL Quiz Up  Etps Plat       CTA    Conf\n`;
  table += `${'─'.repeat(78)}\n`;

  for (let i = 0; i < ads.length; i++) {
    const a   = ads[i];
    const num = String(i + 1).padEnd(3);
    const adv = a.advertiser.substring(0, 20).padEnd(21);
    const sc  = `${a.score}/10`.padEnd(4);
    const vsl = yn(a.hasVSL).padEnd(4);
    const qz  = yn(a.hasQuiz).padEnd(4);
    const up  = yn(a.hasUpsell).padEnd(4);
    const stp = String(a.funnelSteps).padEnd(4);
    const plt = a.platform.substring(0, 10).padEnd(11);
    const cta = a.offerAnalysis.ctaStrength.padEnd(6);
    const cf  = confIcon(a.performanceConfidence);
    table += `${num}${adv}${sc}${vsl}${qz}${up}${stp}${plt}${cta}${cf}\n`;
  }

  table += `</code>\n\n`;
  table += `<b>Detalhes:</b>\n`;
  for (let i = 0; i < ads.length; i++) {
    const a = ads[i];
    const badge = i === 0 ? '🏆' : `#${i + 1}`;
    table += `${badge} <b>${a.advertiser.substring(0, 25)}</b>\n`;
    table += `   Produto: ${a.offerTitle.substring(0, 50)}\n`;
    table += `   Ângulo: ${a.offerAngle} | Estilo: ${a.creativeStyle}\n`;
    table += `   Complexidade: ${a.funnelComplexity} | Preço: ${a.price}\n`;
    table += `   Recomendação: <b>${a.recommendationLevel}</b>\n\n`;
  }

  const best = ads[0];
  table += `\n🏆 <b>MELHOR OFERTA PARA CLONAR:</b>\n`;
  table += `<b>${best.advertiser}</b> — ${best.offerTitle.substring(0, 60)}\n`;
  table += `Score ${best.score}/10 | ${best.offerAngle} | ${best.creativeStyle}\n`;
  table += `Funil: ${best.funnelComplexity} | Confiança: ${best.performanceConfidence}\n`;
  table += `CTA: ${best.offerAnalysis.ctaStrength} | Plataforma: ${best.platform}`;

  await sendToTelegram(table);
}

function extractSalesCopy(rawText: string, advertiserName?: string): string {
  const lines = rawText.split('\n').map(l => l.trim()).filter(Boolean);
  const skip: RegExp[] = [
    /^\d{5,}$/,
    /^[\d\s\-_|•·]{3,}$/,
    /^(ac|al|am|ap|ba|ce|df|es|go|ma|mg|ms|mt|pa|pb|pe|pi|pr|rj|rn|ro|rr|rs|sc|se|sp|to)$/i,
    /^(home|menu|início|sobre|contato|política|privacidade|termos|copyright|©|\d{4})/i,
    /^(carrinho|minha conta|entrar|sair|cadastro|login|buscar|pesquisar|fechar|voltar)$/i,
    /^(aceitar|cookies|ok|sim|não|próximo|anterior|pular)$/i,
    /^(facebook|instagram|youtube|twitter|tiktok|whatsapp|telegram)$/i,
    /^(patrocinado|sponsored|ver mais|see more)$/i,
    /^.{1,12}$/, /^[^a-záàâãéêíóôõúç]*$/,
    /biblioteca de anúncios|relatório da biblioteca|página de facebook/i,
    /cpf|cnpj|cep|\d{3}\.\d{3}\.\d{3}-\d{2}/i,
  ];
  if (advertiserName) {
    const esc = advertiserName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    skip.push(new RegExp(`^${esc}$`, 'i'));
  }
  const salesOk = [
    /apenas|por apenas|somente|desconto|oferta|promoção|grátis|bônus|exclusiv/i,
    /aprenda|descubra|transforme|conquiste|garanta|acesse|baixe|receba/i,
    /método|técnica|estratégia|passo a passo|guia|manual|curso|treinamento/i,
    /resultado|comprovado|garantido|testado|funciona|eficaz/i,
    /R\$|\d+\s*(reais|dias|horas|semanas|meses|anos)/i,
    /clique|acesse|compre|inscreva|cadastre|garanta|quero|começar/i,
    /você|seu|sua|aproveite|não perca|última/i,
  ];
  const seen = new Set<string>(), out: string[] = [];
  for (const l of lines) {
    if (seen.has(l)) continue; seen.add(l);
    if (skip.some(p => p.test(l))) continue;
    if (salesOk.some(p => p.test(l)) || l.length > 40) out.push(l);
  }
  return out.slice(0, 18).join('\n');
}

// Extract the real offer title from funnel page metadata / headings
function extractRealOfferTitle(pageHtml: string, h1Text: string, ogTitle: string, titleTag: string): string {
  const cta = ['saiba mais', 'comprar', 'baixe agora', 'quero', 'acessar', 'garantir', 'clique aqui',
               'ver mais', 'obter', 'assinar', 'clique aqui', 'clique aqui para', 'continue',
               'avançar', 'próximo', 'sim, quero', 'quero agora'];
  const fbNoise = ['biblioteca de anúncios', 'facebook', 'meta ads', 'ad library', 'patrocinado'];

  const candidates = [ogTitle, h1Text, titleTag].map(s => s?.trim() || '');
  for (const c of candidates) {
    if (!c) continue;
    const lower = c.toLowerCase();
    if (cta.some(k => lower === k || lower.startsWith(k + ' '))) continue;
    if (fbNoise.some(k => lower.includes(k))) continue;
    if (c.length > 3 && c.length < 150) return c;
  }
  return 'Título não encontrado';
}

async function downloadCreative(rawCard: any): Promise<{ path: string | null; isVideo: boolean }> {
  // Video first: try all video sources
  if (rawCard.videos && rawCard.videos.length > 0) {
    for (const videoUrl of rawCard.videos) {
      if (!videoUrl || !videoUrl.startsWith('http')) continue;
      const p = `creative_${Date.now()}.mp4`;
      const ok = await downloadFile(videoUrl, p, MIN_VIDEO_BYTES);
      if (ok) {
        // Validate mp4 header
        try {
          const buf = Buffer.alloc(12);
          const fd = fs.openSync(p, 'r');
          fs.readSync(fd, buf, 0, 12, 0);
          fs.closeSync(fd);
          const isMp4 = buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70;
          const isOther = buf[0] === 0x1a || buf[0] === 0x00;
          if (!isMp4 && !isOther) { fs.unlinkSync(p); continue; }
        } catch { safeDelete(p); continue; }
        return { path: p, isVideo: true };
      }
    }
  }

  // Images: prefer highest resolution via srcset width values
  const candidates: string[] = [
    ...(rawCard.images || []),
    ...(rawCard.backgroundImages || []),
  ].filter((u: string) => u && u.startsWith('http'));

  // Sort by width hint in URL params (higher = better quality)
  candidates.sort((a: string, b: string) => {
    const wa = parseInt(new URLSearchParams(a.split('?')[1] || '').get('_nc_ht') || '0');
    const wb = parseInt(new URLSearchParams(b.split('?')[1] || '').get('_nc_ht') || '0');
    // Also sort by any width/height params
    const sa = parseInt(new URLSearchParams(a.split('?')[1] || '').get('width') || '0');
    const sb = parseInt(new URLSearchParams(b.split('?')[1] || '').get('width') || '0');
    return (wb + sb) - (wa + sa);
  });

  for (const imgUrl of candidates) {
    const ext = imgUrl.includes('.webp') ? 'webp' : imgUrl.includes('.png') ? 'png' : 'jpg';
    const p = `creative_${Date.now()}.${ext}`;
    const ok = await downloadFile(imgUrl, p, MIN_IMAGE_BYTES);
    if (ok) return { path: p, isVideo: false };
  }

  return { path: null, isVideo: false };
}

async function downloadVSL(videoSrc: string): Promise<string | null> {
  if (!videoSrc || !videoSrc.startsWith('http')) return null;
  const skip = ['youtube.com', 'youtu.be', 'vimeo.com', 'wistia.com', 'pandavideo'];
  if (skip.some(s => videoSrc.includes(s))) return null;

  const p = `vsl_${Date.now()}.mp4`;
  const ok = await downloadFile(videoSrc, p, MIN_VIDEO_BYTES);
  if (!ok) return null;

  try {
    const buf = Buffer.alloc(12);
    const fd = fs.openSync(p, 'r');
    fs.readSync(fd, buf, 0, 12, 0);
    fs.closeSync(fd);
    const isMp4 = buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70;
    const isOther = buf[0] === 0x1a || buf[0] === 0x00;
    if (!isMp4 && !isOther) {
      fs.unlinkSync(p);
      return null;
    }
  } catch { safeDelete(p); return null; }

  return p;
}

async function crawlFunnel(context: BrowserContext, startUrl: string): Promise<any[]> {
  const steps: any[] = [];
  const visited = new Set<string>();
  let currentUrl = startUrl;
  let depth = 0;

  while (currentUrl && depth < 4 && !visited.has(currentUrl)) {
    visited.add(currentUrl);
    const page = await context.newPage();
    try {
      await page.setViewportSize({ width: 1920, height: 1080 });
      await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
      try { await page.waitForLoadState('networkidle', { timeout: 8000 }); } catch {}
      await delay(2500);

      const realUrl = page.url();
      const domain = (() => { try { return new URL(realUrl).hostname; } catch { return realUrl; } })();

      const screenshotPath = `funnel_${domain.replace(/[^a-z0-9]/gi, '_')}_${Date.now()}_${depth + 1}.png`;
      await page.screenshot({ path: screenshotPath, fullPage: true });

      const pageData = await page.evaluate(() => {
        const skip = new Set<Node>();
        ['nav', 'footer', 'aside', 'header', '[aria-hidden="true"]', '[class*="cookie"]',
         '[class*="nav"]', '[class*="footer"]', '[class*="menu"]', '[class*="header"]',
         'script', 'style', 'noscript'].forEach(sel => {
          try { document.querySelectorAll(sel).forEach(el => skip.add(el)); } catch {}
        });

        function getVisibleText(root: Element): string {
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
              let el = node.parentElement;
              while (el) {
                if (skip.has(el)) return NodeFilter.FILTER_REJECT;
                const s = window.getComputedStyle(el);
                if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return NodeFilter.FILTER_REJECT;
                el = el.parentElement;
              }
              return NodeFilter.FILTER_ACCEPT;
            }
          });
          const parts: string[] = [];
          let n: Node | null;
          while ((n = walker.nextNode())) { const t = (n.textContent || '').trim(); if (t.length > 2) parts.push(t); }
          return parts.join('\n');
        }

        const mainEl = document.querySelector('main, article, [role="main"], .main, #main, section') || document.body;
        const rawText = getVisibleText(mainEl as Element);
        const fullText = document.body.innerText || '';
        const lower = fullText.toLowerCase();

        // Extract real offer title: og:title > <title> > h1
        const ogTitle = (document.querySelector('meta[property="og:title"]') as HTMLMetaElement)?.content || '';
        const titleTag = document.title || '';
        const h1Text = (document.querySelector('h1') as HTMLElement)?.innerText?.trim() || '';
        const pageHtml = document.documentElement.outerHTML.substring(0, 5000);

        const hasVideo = !!(document.querySelector('video') ||
          document.querySelector('iframe[src*="youtube"]') || document.querySelector('iframe[src*="vimeo"]') ||
          document.querySelector('iframe[src*="wistia"]') || document.querySelector('iframe[src*="panda"]'));

        const videoSrc =
          (document.querySelector('video source') as HTMLSourceElement)?.src ||
          (document.querySelector('video') as HTMLVideoElement)?.src ||
          (document.querySelector('iframe[src*="panda"]') as HTMLIFrameElement)?.src ||
          (document.querySelector('iframe[src*="youtube"]') as HTMLIFrameElement)?.src ||
          (document.querySelector('iframe[src*="vimeo"]') as HTMLIFrameElement)?.src || null;

        const radioInputs = document.querySelectorAll('input[type="radio"]').length;
        const hasUpsell   = lower.includes('leve também') || lower.includes('adicione ao pedido') || lower.includes('aproveite também');
        const hasDownsell = (lower.includes('espera') && (lower.includes('sair') || lower.includes('chance'))) || lower.includes('última chance');
        const hasCheckout = lower.includes('finalizar compra') || lower.includes('dados do cartão') || lower.includes('cartão de crédito') || lower.includes('número do cartão') || lower.includes('cvv') || lower.includes('boleto') || lower.includes('pix');
        const hasQuizContent = lower.includes('quiz') || lower.includes('próxima pergunta') || lower.includes('qual é o seu') || lower.includes('como você se sente');
        const isQuiz = !hasCheckout && ((radioInputs >= 2 && hasQuizContent) || (lower.includes('quiz') && !hasCheckout));
        const hasLongCopy = rawText.length > 500;

        const ctaKeywords = ['saiba mais', 'comprar', 'baixe', 'quero', 'acessar', 'garantir', 'clique', 'próximo', 'continuar', 'começar', 'inscrever'];
        const ctaLinks = Array.from(document.querySelectorAll('a, button'))
          .filter((el: any) => { const t = (el.innerText || '').toLowerCase(); return ctaKeywords.some(k => t.includes(k)); })
          .map((el: any) => el.href || null)
          .filter((h: string | null): h is string => !!h && !h.includes('javascript:'));

        const waLinks = Array.from(document.querySelectorAll('a'))
          .map((a: any) => a.href as string)
          .filter((h: string) => h && (h.includes('wa.me') || h.includes('whatsapp.com/send')));

        return { rawText: rawText.substring(0, 3000), hasVideo, videoSrc, radioInputs, hasUpsell, hasDownsell, hasCheckout, isQuiz, hasLongCopy, ctaLinks: ctaLinks.slice(0, 3), waLinks: waLinks.slice(0, 2), ogTitle, titleTag, h1Text, pageHtml };
      });

      const pageType = classifyPage(pageData.rawText, pageData.hasVideo, pageData.radioInputs, realUrl);
      const cleanCopy = extractSalesCopy(pageData.rawText);
      const platform  = detectPlatform(realUrl, pageData.rawText);
      const technology = detectTechnology(realUrl, pageData.pageHtml || '');
      const offerTitle = extractRealOfferTitle(pageData.pageHtml || '', pageData.h1Text, pageData.ogTitle, pageData.titleTag);

      steps.push({ url: realUrl, domain, type: pageType, screenshotPath, videoSrc: pageData.videoSrc, hasVideo: pageData.hasVideo, hasUpsell: pageData.hasUpsell, hasDownsell: pageData.hasDownsell, hasCheckout: pageData.hasCheckout, isQuiz: pageData.isQuiz, hasLongCopy: pageData.hasLongCopy, copy: cleanCopy, platform, technology, offerTitle, rawText: pageData.rawText.substring(0, 1000) });

      let nextUrl: string | null = null;
      if (pageData.waLinks.length > 0)       nextUrl = pageData.waLinks[0];
      else if (pageData.ctaLinks.length > 0)  nextUrl = pageData.ctaLinks[0];

      if (nextUrl && !visited.has(nextUrl) && !nextUrl.includes('facebook.com')) currentUrl = nextUrl;
      else break;
      depth++;
    } catch (e) { console.error('crawlFunnel step error:', e); break; }
    finally { await page.close(); }
  }
  return steps;
}

function deduplicateRawCards(rawCards: any[]): any[] {
  const seen = new Map<string, { card: any; count: number }>();
  for (const card of rawCards) {
    const funnelUrl = (card.ctaLinks?.[0] || card.links?.[0] || '').toLowerCase();
    let landingDomain = '';
    try { landingDomain = new URL(funnelUrl).hostname; } catch {}
    const key = `${card.advertiser.toLowerCase()}||${landingDomain}`;
    const existing = seen.get(key);
    if (existing) { existing.count++; }
    else { seen.set(key, { card, count: 1 }); }
  }
  return Array.from(seen.values()).map(({ card, count }) => ({ ...card, similarCount: count }));
}

async function collectAd(
  context: BrowserContext,
  rawCard: any,
  keyword: string,
  country: string,
  history: History
): Promise<ScoredAd | null> {
  try {
    if (!rawCard || rawCard.text.length < 30) return null;
    if (rawCard.text.includes('Biblioteca de Anúncios da Meta')) return null;

    const funnelUrl: string | null = rawCard.ctaLinks?.[0] || rawCard.links?.[0] || null;
    const landingDomain = (() => { try { return new URL(funnelUrl || '').hostname; } catch { return ''; } })();

    // Dedup key: use normalized URL path (advertiser-agnostic) so same advertiser can
    // appear for DIFFERENT products/keywords without being blocked
    const normalizedUrl = normalizeUrlForDedup(funnelUrl);
    const histKey = normalizedUrl || `${rawCard.advertiser.toLowerCase()}||${landingDomain}`;

    if (funnelUrl && wasRecentlyAnalyzed(history, histKey)) {
      console.log(`[SKIP dedup] ${histKey}`);
      return null;
    }

    // Blacklisted domains: skip funnel crawl, but keep the ad (don't discard it)
    const funnelBlacklisted = funnelUrl ? isDomainBlacklisted(funnelUrl) : false;
    if (funnelBlacklisted) {
      console.log(`[BLACKLIST] Will skip funnel crawl for: ${landingDomain}`);
    }

    const priceNum = extractPrice(rawCard.text);
    const price    = priceNum ? `R$ ${priceNum.toFixed(2)} ✅` : '💡 Não identificado';

    const creative = await downloadCreative(rawCard);

    let funnelStepData: any[] = [];
    if (funnelUrl && !funnelUrl.includes('facebook.com') && !funnelBlacklisted) {
      console.log(`[CRAWL] Accessing: ${funnelUrl}`);
      try {
        funnelStepData = await crawlFunnel(context, funnelUrl);
        console.log(`[CRAWL] OK — ${funnelStepData.length} step(s) from ${funnelUrl}`);
      } catch (crawlErr) {
        console.error(`[CRAWL] Failed: ${funnelUrl}`, crawlErr);
      }
    } else if (funnelUrl && !funnelBlacklisted) {
      console.log(`[CRAWL] Skipped (Facebook link): ${funnelUrl}`);
    }

    const hasVSL      = funnelStepData.some(s => s.type === 'VSL') || rawCard.hasVideo;
    const hasQuiz     = funnelStepData.some(s => s.isQuiz);
    const hasUpsell   = funnelStepData.some(s => s.hasUpsell);
    const hasDownsell = funnelStepData.some(s => s.hasDownsell);
    const hasCheckout = funnelStepData.some(s => s.hasCheckout);
    const hasLongCopy = funnelStepData.some(s => s.hasLongCopy) || rawCard.text.length > 300;
    const hasCTA      = (rawCard.ctaLinks?.length > 0) || funnelStepData.length > 0;

    const score      = calculateScore({ hasVSL, hasQuiz, hasUpsell, hasDownsell, funnelSteps: funnelStepData.length, hasCTA, hasCheckout, hasLongCopy });
    const domains    = [...new Set(funnelStepData.map((s: any) => s.domain))] as string[];
    const platform   = funnelStepData.length > 0 ? (funnelStepData[0].platform || 'Direto') : detectPlatform(funnelUrl || '', rawCard.text);
    const funnelType = funnelStepData.length > 0 ? funnelStepData.map((s: any) => s.type).join(' → ') : 'Direto';
    const cleanCopy  = extractSalesCopy(rawCard.text, rawCard.advertiser);
    const allFunnelText = funnelStepData.map((s: any) => s.rawText || '').join(' ');
    const offerAnalysis = analyzeOffer(cleanCopy, allFunnelText);

    const offerAngle    = detectOfferAngle(cleanCopy, allFunnelText);
    const creativeStyle = detectCreativeStyle(rawCard.hasVideo, (rawCard.images || []).length, rawCard.text);

    // Real offer title: prefer first page's og:title / title / h1, then fall back to analyzeOffer
    // Never use Facebook copy or CTA text as the title
    const rawOfferTitle = funnelStepData.length > 0 ? (funnelStepData[0].offerTitle || '') : '';
    const isPlaceholder = !rawOfferTitle || rawOfferTitle === 'Título não encontrado';
    const offerTitle = isPlaceholder
      ? (offerAnalysis.product && offerAnalysis.product.length > 4 ? offerAnalysis.product : 'Título não encontrado')
      : rawOfferTitle;

    // Mozambique-specific detection
    const allTech = funnelStepData.map((s: any) => s.technology || '').join(' ');
    const mzTech = MZ_TECH_PATTERNS.find(p => allTech.toLowerCase().includes(p) || (funnelUrl || '').toLowerCase().includes(p)) || '';
    const mzCheckout = detectMzCheckout(funnelUrl || '', allFunnelText);

    const partial = {
      hasVSL, hasQuiz, hasUpsell, hasDownsell,
      funnelSteps: funnelStepData.length,
      domains,
      score,
      similarCount: rawCard.similarCount || 1,
      offerAnalysis,
    };
    const funnelComplexity      = detectFunnelComplexity(partial);
    const performanceConfidence = detectPerformanceConfidence({ ...partial, funnelComplexity });

    markAnalyzed(history, histKey, score, rawCard.advertiser);

    const baseAd: Omit<ScoredAd, 'recommendationLevel'> = {
      advertiser: rawCard.advertiser,
      keyword,
      country,
      score,
      price,
      priceNum,
      creativeType: rawCard.hasVideo ? '🎥 Vídeo' : '🖼️ Imagem',
      dateText: rawCard.dateText,
      hasVSL, hasQuiz, hasUpsell, hasDownsell, hasCheckout, hasLongCopy,
      funnelSteps: funnelStepData.length,
      funnelType,
      domains,
      platform,
      funnelUrl: funnelUrl || 'N/A',
      landingDomain,
      cleanCopy,
      creativePath: creative.path,
      creativeIsVideo: creative.isVideo,
      funnelStepData,
      offerAnalysis,
      similarCount: rawCard.similarCount || 1,
      offerAngle,
      creativeStyle,
      funnelComplexity,
      performanceConfidence,
      offerTitle,
      isMozambique: country === MZ_COUNTRY,
      mzTech,
      mzCheckout,
    };
    const ad: ScoredAd = { ...baseAd, recommendationLevel: computeRecommendationLevel(baseAd as ScoredAd) };

    appendDetailedHistory(ad);
    return ad;
  } catch (err) {
    console.error('collectAd error:', err);
    return null;
  }
}

async function sendAdReport(ad: ScoredAd, rank: number, isBest: boolean) {
  const countryName = ad.country === 'BR' ? 'Brasil 🇧🇷' : 'Moçambique 🇲🇿';
  const dupNote     = ad.similarCount > 1 ? `\n⚠️ Anunciante roda <b>${ad.similarCount} anúncios similares</b>` : '';
  const bestHeader  = isBest ? '\n🏆 <b>MELHOR OFERTA PARA CLONAR</b>' : '';

  if (ad.creativePath) {
    const cap = `${isBest ? '🏆 ' : ''}#${rank} ${ad.advertiser} | ${ad.keyword}`;
    if (ad.creativeIsVideo) await sendVideo(ad.creativePath, cap);
    else                    await sendPhoto(ad.creativePath, cap);
  }

  const offer   = ad.offerAnalysis;
  const confIcon = ad.performanceConfidence === 'alto' ? '🟢' : ad.performanceConfidence === 'médio' ? '🟡' : '🔴';
  const cplxIcon = ad.funnelComplexity === 'avançado' ? '🔷' : ad.funnelComplexity === 'médio' ? '🔹' : '⬜';

  // Mozambique special report
  if (ad.isMozambique) {
    await sendToTelegram(`\
🗺️ <b>#${rank} | MOÇAMBIQUE 🇲🇿 | ${ad.keyword}</b>${bestHeader}${dupNote}

🏢 <b>Anunciante:</b> ${ad.advertiser}
📦 <b>Produto:</b> ${ad.offerTitle}
🛠️ <b>Tecnologia detectada:</b> ${ad.mzTech || 'Não identificada'}
🛒 <b>Checkout detectado:</b> ${ad.mzCheckout || 'Não identificado'}
🏪 <b>Plataforma:</b> ${ad.platform}
🔗 <b>Funil:</b> ${ad.funnelUrl}`);
    return;
  }

  await sendToTelegram(`\
🎯 <b>#${rank} | ${ad.keyword} | ${countryName}</b>${bestHeader}${dupNote}

⭐ <b>Score: ${ad.score}/10</b> | ${confIcon} Confiança: <b>${ad.performanceConfidence}</b>
🏢 <b>Anunciante:</b> ${ad.advertiser}
📦 <b>Produto:</b> ${ad.offerTitle}
💰 <b>Preço:</b> ${ad.price}
🎨 <b>Criativo:</b> ${ad.creativeType} — ${ad.creativeStyle}
🏪 <b>Plataforma:</b> ${ad.platform}
📅 <b>Data início:</b> ${ad.dateText || 'Desconhecida'}

🎭 <b>Ângulo da oferta:</b> ${ad.offerAngle}
💡 <b>Promessa:</b> ${offer.mainPromise}
${offer.hasBonus ? '🎁 Bônus: ✅' : ''} ${offer.hasUrgency ? '⏰ Urgência: ✅' : ''} ${offer.hasGuarantee ? '🛡️ Garantia: ✅' : ''} ${offer.hasRecurring ? '🔄 Recorrente: ✅' : ''}
💪 <b>CTA:</b> ${offer.ctaStrength}

${cplxIcon} <b>Complexidade:</b> ${ad.funnelComplexity} | <b>Funil (${ad.funnelSteps} etapas):</b> ${ad.funnelType}
🎬 VSL: ${ad.hasVSL ? '✅' : '❌'} | 🧩 Quiz: ${ad.hasQuiz ? '✅' : '❌'}
⬆️ Upsell: ${ad.hasUpsell ? '✅' : '❌'} | ⬇️ Downsell: ${ad.hasDownsell ? '✅' : '❌'}
🛒 Checkout: ${ad.hasCheckout ? '✅' : '❌'} | 📝 Copy longa: ${ad.hasLongCopy ? '✅' : '❌'}
🌐 <b>Domínios:</b> ${ad.domains.length > 0 ? ad.domains.join(', ') : 'N/A'}
📌 <b>Recomendação:</b> ${ad.recommendationLevel}
🔗 <b>Funil:</b> ${ad.funnelUrl}`);

  if (ad.cleanCopy.length > 20) {
    await sendToTelegram(`📝 <b>COPY DO ANÚNCIO:</b>\n${ad.cleanCopy.substring(0, 600)}`);
  }

  if (isBest) {
    const reasons = buildCloneReasons(ad);
    await sendToTelegram(`🏆 <b>POR QUE CLONAR ESTA OFERTA:</b>\n${reasons}`);
  }

  for (let i = 0; i < ad.funnelStepData.length; i++) {
    const step = ad.funnelStepData[i];
    if (step.type === 'VSL' && step.videoSrc) {
      const vslPath = await downloadVSL(step.videoSrc);
      if (vslPath) {
        await sendVideo(vslPath, `🎬 VSL — Etapa ${i + 1} | ${step.domain}`);
      } else {
        if (step.screenshotPath) await sendScreenshot(step.screenshotPath, `📸 VSL — Etapa ${i + 1} | ${step.domain}`);
      }
    } else {
      if (step.screenshotPath) await sendScreenshot(step.screenshotPath, `📸 Etapa ${i + 1} — ${step.type} | ${step.domain}`);
    }
    if (i === 0 && step.copy && step.copy.length > 30) {
      await sendToTelegram(`📝 <b>COPY DA PÁGINA (${step.type}):</b>\n${step.copy.substring(0, 600)}`);
    }
  }

  await sendToTelegram('━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  await delay(1500);
}

async function scrapeKeyword(
  keyword: string,
  country: string,
  context: BrowserContext,
  page: Page,
  history: History,
  keywordScores: Map<string, number[]>
): Promise<ScoredAd[]> {
  currentKeyword = `${keyword} (${country})`;
  const countryName = country === 'BR' ? 'Brasil 🇧🇷' : 'Moçambique 🇲🇿';
  const searchUrl   = `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=${country}&q=${encodeURIComponent(keyword)}&search_type=keyword_unordered`;

  try {
    await sendToTelegram(`🔎 <b>PESQUISANDO:</b> ${keyword} — ${countryName}`);
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await delay(4000);
    await page.evaluate(() => window.scrollBy(0, 800));
    await delay(3000);

    const libShot = `lib_${Date.now()}.png`;
    await page.screenshot({ path: libShot });
    await sendScreenshot(libShot, `🔍 ${keyword} — ${countryName}`);

    const sponsoredLocator = page.getByText('Patrocinado', { exact: true });
    let count = 0;
    try {
      await sponsoredLocator.first().waitFor({ timeout: 12000 });
      count = Math.min(await sponsoredLocator.count(), MAX_ADS_COLLECT);
    } catch {
      try {
        const eng = page.getByText('Sponsored', { exact: true });
        await eng.first().waitFor({ timeout: 5000 });
        count = Math.min(await eng.count(), MAX_ADS_COLLECT);
      } catch {}
    }

    if (count === 0) {
      await sendToTelegram(`⚠️ Nenhum anúncio para <b>${keyword}</b> em ${countryName}`);
      return [];
    }

    await sendToTelegram(`⏳ <b>${count} anúncios encontrados.</b> Coletando e analisando...`);

    const rawCards: any[] = [];
    for (let i = 0; i < count; i++) {
      try {
        const sponsored = sponsoredLocator.nth(i);
        const card = sponsored.locator('xpath=ancestor::div[.//a[@role="link"]][1]');

        const raw = await card.evaluate((el: HTMLElement) => {
          const blockedDomains = ['facebook.com','fb.com','instagram.com','play.google.com','apps.apple.com','youtube.com','google.com','apple.com','adjust.com','onelink.to','app.adjust','branch.io'];

          function realUrl(href: string): string | null {
            if (!href) return null;
            if (href.includes('l.facebook.com/l.php') || href.includes('lm.facebook.com')) {
              try { const u = new URL(href).searchParams.get('u'); if (u) return decodeURIComponent(u); } catch {}
              return null;
            }
            if (href.startsWith('http') && !blockedDomains.some(d => href.includes(d))) return href;
            return null;
          }

          const ctaBtns = ['saiba mais','comprar','baixe','quero','acessar','garantir','clique','ver mais','obter','assinar','inscrever','começar'];
          const allRoleLinks = Array.from(el.querySelectorAll('a[role="link"]')) as HTMLElement[];
          const advertiserEl = allRoleLinks.find(a => {
            const t = (a.innerText || '').toLowerCase().trim();
            return t.length > 0 && t.length < 60 && !ctaBtns.some(k => t.includes(k));
          }) || null;
          const advertiser = advertiserEl?.innerText?.trim() || 'Desconhecido';

          let text = '';
          el.childNodes.forEach(node => {
            if (node !== advertiserEl && !(node as HTMLElement).contains?.(advertiserEl)) {
              text += (node as HTMLElement).innerText || node.textContent || '';
            }
          });
          if (!text.trim()) {
            text = el.innerText || '';
            if (advertiser && text.startsWith(advertiser)) text = text.slice(advertiser.length);
          }

          const images: string[] = [];
          el.querySelectorAll('img').forEach((img: any) => {
            const src = img.getAttribute('src') || img.getAttribute('data-src') || '';
            if (src && src.startsWith('https://') && !src.includes('emoji') && !src.includes('static') && src.length > 50) images.push(src);
            const ss = img.getAttribute('srcset') || '';
            if (ss) {
              const biggest = ss.split(',').map((s: string) => s.trim()).filter((s: string) => s)
                .map((s: string) => { const [u, w] = s.split(' '); return { u, w: parseInt(w || '0') }; })
                .sort((a: any, b: any) => b.w - a.w)[0];
              if (biggest?.u && biggest.u.startsWith('http')) images.push(biggest.u);
            }
          });

          const bgImages: string[] = [];
          el.querySelectorAll('[style*="background"]').forEach((node: any) => {
            const m = (node.style.backgroundImage || '').match(/url\(["']?(https?[^"')]+)["']?\)/);
            if (m && m[1]) bgImages.push(m[1]);
          });

          const videos = Array.from(el.querySelectorAll('video')).map((v: any) => v.src as string).filter(Boolean);

          const ctaKeys = ['saiba mais', 'comprar', 'baixe', 'quero', 'acessar', 'garantir', 'clique', 'continuar', 'começar', 'ver mais', 'obter', 'inscrever', 'assinar'];
          const ctaLinks = Array.from(el.querySelectorAll('a'))
            .filter((a: any) => { const t = (a.innerText || '').toLowerCase(); return ctaKeys.some(k => t.includes(k)); })
            .map((a: any) => realUrl(a.href)).filter((h: any): h is string => h !== null);
          const allLinks = Array.from(el.querySelectorAll('a')).map((a: any) => realUrl(a.href)).filter((h: any): h is string => h !== null);
          const waLinks  = Array.from(el.querySelectorAll('a')).map((a: any) => a.href as string).filter((h: string) => h && (h.includes('wa.me') || h.includes('whatsapp.com/send')));
          const dateMatch = text.match(/(\d+)\s*de\s*(jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)/i);

          return { text: text.substring(0, 1000), images: [...new Set(images)].slice(0, 3), backgroundImages: bgImages.slice(0, 2), videos: videos.slice(0, 2), hasVideo: videos.length > 0, advertiser, dateText: dateMatch ? dateMatch[0] : null, ctaLinks: ctaLinks.slice(0, 3), links: allLinks.slice(0, 3), waLinks: waLinks.slice(0, 2) };
        });

        rawCards.push(raw);
      } catch (err) { console.error(`Card ${i} read error:`, err); }
    }

    const dedupedCards = deduplicateRawCards(rawCards);
    console.log(`[${keyword}] ${rawCards.length} raw → ${dedupedCards.length} unique after dedup`);

    const scored: ScoredAd[] = [];
    for (const raw of dedupedCards) {
      const result = await collectAd(context, raw, keyword, country, history);
      if (result) {
        scored.push(result);
        offersFoundToday++;
      }
      await delay(1500);
    }

    if (scored.length === 0) {
      await sendToTelegram(`⚠️ Nenhum anúncio novo/válido para <b>${keyword}</b>`);
      return [];
    }

    scored.sort((a, b) => b.score - a.score);
    const topAds = scored.slice(0, MAX_ADS_SEND);

    const kKey = `${country}::${keyword}`;
    if (!keywordScores.has(kKey)) keywordScores.set(kKey, []);
    topAds.forEach(a => keywordScores.get(kKey)!.push(a.score));

    const rankingLines = topAds.map((a, i) => `${i + 1}. <b>${a.advertiser}</b> — ${a.score}/10${a.similarCount > 1 ? ` (${a.similarCount} ads similares)` : ''}`).join('\n');
    await sendToTelegram(`📊 <b>RANKING — ${keyword} | ${countryName}</b>\n${rankingLines}\n\n🏆 Melhor para clonar: <b>${topAds[0].advertiser}</b> — ${topAds[0].offerTitle.substring(0, 50)}`);

    for (let i = 0; i < topAds.length; i++) {
      await sendAdReport(topAds[i], i + 1, i === 0);
    }

    await sendComparisonTable(topAds, keyword, country);

    saveHistory(history);

    await sendToTelegram(`✅ <b>CONCLUÍDO:</b> ${keyword} — ${topAds.length} ads enviados (${scored.length} únicos analisados de ${rawCards.length} encontrados)`);

    return topAds;

  } catch (err) {
    console.error(`Keyword error "${keyword}":`, err);
    return [];
  } finally {
    currentKeyword = null;
  }
}

function freqMap(items: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const it of items) m.set(it, (m.get(it) || 0) + 1);
  return m;
}

function sortedFreq(m: Map<string, number>): Array<[string, number]> {
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

function pct(n: number, total: number) { return total > 0 ? Math.round((n / total) * 100) : 0; }

async function sendCompetitiveGapAnalysis(allAds: ScoredAd[]) {
  if (allAds.length < 3) return;

  const total = allAds.length;

  const angles    = freqMap(allAds.map(a => a.offerAngle));
  const styles    = freqMap(allAds.map(a => a.creativeStyle));
  const platforms = freqMap(allAds.map(a => a.platform));
  const ctas      = freqMap(allAds.map(a => a.offerAnalysis.ctaStrength));

  const vslCount    = allAds.filter(a => a.hasVSL).length;
  const quizCount   = allAds.filter(a => a.hasQuiz).length;
  const upsellCount = allAds.filter(a => a.hasUpsell).length;
  const strongCTA   = (ctas.get('forte') || 0);
  const weakCTA     = (ctas.get('fraco') || 0);

  const combos = freqMap(allAds.map(a =>
    `${a.hasVSL ? 'VSL' : 'noVSL'}+${a.hasQuiz ? 'Quiz' : 'noQuiz'}+${a.offerAngle}+${a.creativeStyle}`
  ));
  const topCombos = sortedFreq(combos).slice(0, 3);

  const rareHighPerf: string[] = [];
  for (const [combo, cnt] of combos.entries()) {
    if (cnt <= 2) {
      const comboAds = allAds.filter(a =>
        `${a.hasVSL ? 'VSL' : 'noVSL'}+${a.hasQuiz ? 'Quiz' : 'noQuiz'}+${a.offerAngle}+${a.creativeStyle}` === combo
      );
      const avgScore = comboAds.reduce((s, a) => s + a.score, 0) / comboAds.length;
      if (avgScore >= 6) rareHighPerf.push(`${combo.replace(/\+/g, ' + ')} (score médio: ${avgScore.toFixed(1)})`);
    }
  }

  const highConfSimple = allAds.filter(a =>
    a.performanceConfidence === 'alto' && a.funnelComplexity === 'simples'
  );

  const angleAvgScore = new Map<string, number>();
  for (const [angle] of angles.entries()) {
    const group = allAds.filter(a => a.offerAngle === angle);
    angleAvgScore.set(angle, group.reduce((s, a) => s + a.score, 0) / group.length);
  }
  const underusedHighScore = [...angles.entries()]
    .filter(([, cnt]) => cnt === 1)
    .map(([angle]) => ({ angle, avg: angleAvgScore.get(angle)! }))
    .filter(x => x.avg >= 6)
    .sort((a, b) => b.avg - a.avg);

  const bestAngle = [...angleAvgScore.entries()].sort((a, b) => b[1] - a[1])[0];
  const worstAngle = [...angleAvgScore.entries()].sort((a, b) => a[1] - b[1])[0];

  const styleAvgScore = new Map<string, number>();
  for (const [style] of styles.entries()) {
    const group = allAds.filter(a => a.creativeStyle === style);
    styleAvgScore.set(style, group.reduce((s, a) => s + a.score, 0) / group.length);
  }
  const bestStyle  = [...styleAvgScore.entries()].sort((a, b) => b[1] - a[1])[0];
  const topStyles  = [...styleAvgScore.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);

  const recs: string[] = [];
  if (vslCount > total * 0.6)  recs.push('🔴 VSL supersaturado — considere quiz ou landing page simples');
  if (quizCount < total * 0.2) recs.push('💎 Quiz subutilizado — diferenciação com quiz pode ganhar mercado');
  if (upsellCount < total * 0.3) recs.push('💎 Upsell raro — adicionar upsell pode elevar ticket médio facilmente');
  if (weakCTA > total * 0.5)   recs.push('🔴 CTAs fracos dominam — anúncio com CTA forte se destaca');
  if (strongCTA < total * 0.2) recs.push('💎 CTA forte é raridade — copywriting agressivo vira diferencial');
  const [topAngle, topAngleCount] = sortedFreq(angles)[0] || ['', 0];
  if (topAngleCount > total * 0.5) recs.push(`🔴 Ângulo "${topAngle}" saturado — ${pct(topAngleCount, total)}% dos anúncios usam o mesmo ângulo`);
  const [topStyle, topStyleCount] = sortedFreq(styles)[0] || ['', 0];
  if (topStyleCount > total * 0.5) recs.push(`🔴 Estilo "${topStyle}" dominante — formatos alternativos têm menos concorrência`);
  if (highConfSimple.length > 0) recs.push(`💎 ${highConfSimple.length} anúncio(s) de alta confiança com funil SIMPLES — adicionar quiz/upsell pode dobrar conversão`);
  if (rareHighPerf.length > 0) recs.push(`🌟 Combinações raras mas eficazes detectadas — prime opportunity para first-mover`);
  if (recs.length === 0) recs.push('✅ Mercado equilibrado — diferencie em copy e criativo');

  const topAnglesStr  = sortedFreq(angles).slice(0, 4).map(([a, n]) => `  ${a}: ${n}x (${pct(n, total)}%)`).join('\n');
  const topStylesStr  = sortedFreq(styles).slice(0, 4).map(([s, n]) => `  ${s}: ${n}x (${pct(n, total)}%)`).join('\n');
  const topPlatsStr   = sortedFreq(platforms).slice(0, 4).map(([p, n]) => `  ${p}: ${n}x (${pct(n, total)}%)`).join('\n');

  await sendToTelegram(
`📈 <b>ANÁLISE DE MERCADO — ${total} anúncios analisados no ciclo</b>

⚠️ <b>SATURAÇÃO DE MERCADO</b>

🎭 <b>Ângulos mais usados:</b>
${topAnglesStr}

🎨 <b>Estilos criativos:</b>
${topStylesStr}

🏪 <b>Plataformas:</b>
${topPlatsStr}

📊 Funil: VSL ${pct(vslCount, total)}% | Quiz ${pct(quizCount, total)}% | Upsell ${pct(upsellCount, total)}%
💪 CTA: Forte ${pct(strongCTA, total)}% | Médio ${pct(ctas.get('médio')||0, total)}% | Fraco ${pct(weakCTA, total)}%`
  );

  const winComboStr = topCombos.map(([c, n], i) =>
    `${i + 1}. ${c.replace(/\+/g, ' + ')} — ${n}x`
  ).join('\n');

  const rareStr = rareHighPerf.slice(0, 3).map(r => `  🌟 ${r}`).join('\n') || '  Nenhuma detectada ainda';
  const underStr = underusedHighScore.slice(0, 3).map(u =>
    `  💎 ${u.angle} — score médio ${u.avg.toFixed(1)}/10 (usado apenas 1x)`
  ).join('\n') || '  Sem gaps claros ainda';
  const highConfStr = highConfSimple.slice(0, 3).map(a =>
    `  📌 ${a.advertiser} (${a.platform}) — score ${a.score}/10 sem upsell/quiz`
  ).join('\n') || '  Nenhum detectado';

  await sendToTelegram(
`🔥 <b>PADRÕES VENCEDORES (combinações mais recorrentes):</b>
${winComboStr}

💎 <b>OPORTUNIDADES INEXPLORADAS:</b>
${underStr}

🌟 <b>COMBINAÇÕES RARAS MAS EFICAZES:</b>
${rareStr}

📌 <b>ALTO POTENCIAL SEM EXPLORAR FUNIL:</b>
${highConfStr}`
  );

  const topStylesPerf = topStyles.map(([s, avg]) => `  ${s}: ${avg.toFixed(1)}/10`).join('\n');
  const recsStr = recs.map(r => `• ${r}`).join('\n');

  await sendToTelegram(
`🎯 <b>PERFORMANCE POR ÂNGULO:</b>
  🏆 Melhor: ${bestAngle?.[0] || 'N/A'} (${bestAngle?.[1]?.toFixed(1) || '—'}/10)
  ⚠️ Pior: ${worstAngle?.[0] || 'N/A'} (${worstAngle?.[1]?.toFixed(1) || '—'}/10)

📹 <b>ESTILOS MAIS PERFORMÁTICOS:</b>
${topStylesPerf}

🧠 <b>RECOMENDAÇÕES ESTRATÉGICAS:</b>
${recsStr}

🎯 <b>POSICIONAMENTO SUGERIDO:</b>
✅ Clonar: ${bestAngle?.[0] || 'N/A'} + ${bestStyle?.[0] || 'N/A'}
🔴 Evitar: ${worstAngle?.[0] || 'N/A'} (baixa performance)
💎 Diferenciação: ${underusedHighScore[0]?.angle || rareHighPerf[0]?.split('(')[0]?.trim() || 'Quiz + ângulo alternativo'}`
  );
}

async function sendKeywordRanking(keywordScores: Map<string, number[]>) {
  if (keywordScores.size === 0) return;
  const ranked = Array.from(keywordScores.entries())
    .map(([k, scores]) => ({ key: k, avg: scores.reduce((a, b) => a + b, 0) / scores.length, max: Math.max(...scores) }))
    .sort((a, b) => b.avg - a.avg);

  let msg = `🔥 <b>RANKING FINAL DE KEYWORDS DO CICLO</b>\n\n`;
  ranked.slice(0, 15).forEach((k, i) => {
    const [country, ...kwParts] = k.key.split('::');
    msg += `${i + 1}. <b>${kwParts.join('::')}</b> (${country})\n`;
    msg += `   Avg score: ${k.avg.toFixed(1)}/10 | Melhor: ${k.max}/10\n\n`;
  });
  msg += `\n🔥 <b>MELHOR KEYWORD PARA COMEÇAR:</b> ${(() => { const [, ...p] = ranked[0].key.split('::'); return p.join('::'); })()}`;
  await sendToTelegram(msg);
}

async function runCycle(
  history: History,
  keywordScores: Map<string, number[]>,
  allAds: ScoredAd[],
  categoriesToRun: string[],
  onCategoryComplete?: (category: string) => void
) {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    for (const category of categoriesToRun) {
      const keywords = KEYWORD_CATEGORIES[category] || BLACK_PLR_CATEGORIES[category];
      if (!keywords) continue;

      const isBlackPLR = !!BLACK_PLR_CATEGORIES[category];
      const runCountries = isBlackPLR ? [MZ_COUNTRY, ...COUNTRIES] : COUNTRIES;

      for (const country of runCountries) {
        const countryName = country === 'BR' ? 'Brasil 🇧🇷' : 'Moçambique 🇲🇿';
        await sendToTelegram(`\n📂 <b>CATEGORIA: ${category}</b>${isBlackPLR ? ' 🖤 Black/PLR' : ''} | ${countryName}`);

        const context = await browser.newContext({
          locale: country === 'BR' ? 'pt-BR' : 'pt-MZ',
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
          viewport: { width: 1920, height: 1080 },
        });
        const page = await context.newPage();

        for (let kwIdx = 0; kwIdx < keywords.length; kwIdx++) {
          const keyword = keywords[kwIdx];
          nextKeywordHint = keywords[kwIdx + 1] ?? null;  // pre-announce next keyword

          const kwAds = await scrapeKeyword(keyword, country, context, page, history, keywordScores);
          allAds.push(...kwAds);

          // If /proxima was pressed during this keyword's analysis, skip the wait
          if (skipCurrentKeyword) {
            skipCurrentKeyword = false;
            const nextKw = nextKeywordHint || '(próxima categoria)';
            console.log(`[SKIP] /proxima — jumping to: ${nextKw}`);
            if (kwIdx + 1 < keywords.length) {
              await sendToTelegram(`⏭️ <b>A avançar para próxima palavra-chave:</b> <b>${nextKw}</b>`);
            }
            continue;
          }

          // Last keyword in category — no gap needed
          if (kwIdx === keywords.length - 1) continue;

          const nextKw = nextKeywordHint || '(próxima)';
          console.log(`[WAIT] 15 min before next keyword: ${nextKw}`);
          await sendToTelegram(`⏱️ Aguardando 15 min antes da próxima keyword: <b>${nextKw}</b>`);

          // Interruptible wait: check skipCurrentKeyword every 5 seconds
          const gapEnd = Date.now() + KEYWORD_GAP_MS;
          while (Date.now() < gapEnd) {
            if (skipCurrentKeyword) {
              skipCurrentKeyword = false;
              const nk = nextKeywordHint || '(próxima categoria)';
              await sendToTelegram(`⏭️ <b>A avançar para próxima palavra-chave:</b> <b>${nk}</b>`);
              break;
            }
            await delay(5000);
          }
        }
        nextKeywordHint = null;

        await context.close();
      }

      onCategoryComplete?.(category);
    }
  } finally {
    await browser.close();
  }
}

// ─── Manual URL Analysis ──────────────────────────────────────────────────────

const MANUAL_URL_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function wasRecentlyAnalyzedByUrl(url: string): boolean {
  try {
    const entries = loadDetailedHistory();
    const norm = url.toLowerCase().replace(/\/$/, '');
    return entries.some(e =>
      e.funnelUrl.toLowerCase().replace(/\/$/, '') === norm &&
      e.origin === 'url_manual' &&
      !!e.analyzedAt && (Date.now() - e.analyzedAt) < MANUAL_URL_TTL_MS
    );
  } catch { return false; }
}

async function analyzeUrlManual(targetUrl: string, force = false) {
  if (!targetUrl.startsWith('http')) {
    await sendToTelegram(`❌ URL inválido: <code>${targetUrl}</code>`);
    return;
  }

  if (!force && wasRecentlyAnalyzedByUrl(targetUrl)) {
    await sendToTelegram(
      `⚠️ Este URL já foi analisado nos últimos 30 dias.\nUse <code>/analisar -f ${targetUrl}</code> para forçar nova análise.`
    );
    return;
  }

  await sendToTelegram(`🔍 <b>Analisando URL manual:</b>\n<code>${targetUrl}</code>`);

  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const context = await browser.newContext({
      locale: 'pt-BR',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
    });

    const funnelStepData = await crawlFunnel(context, targetUrl);
    await context.close();

    if (funnelStepData.length === 0) {
      await sendToTelegram(`⚠️ Não foi possível aceder à página: <code>${targetUrl}</code>`);
      return;
    }

    const hasVSL      = funnelStepData.some((s: any) => s.type === 'VSL');
    const hasQuiz     = funnelStepData.some((s: any) => s.isQuiz);
    const hasUpsell   = funnelStepData.some((s: any) => s.hasUpsell);
    const hasDownsell = funnelStepData.some((s: any) => s.hasDownsell);
    const hasCheckout = funnelStepData.some((s: any) => s.hasCheckout);
    const hasLongCopy = funnelStepData.some((s: any) => s.hasLongCopy);
    const hasCTA      = funnelStepData.length > 0;

    const score = calculateScore({ hasVSL, hasQuiz, hasUpsell, hasDownsell, funnelSteps: funnelStepData.length, hasCTA, hasCheckout, hasLongCopy });
    const allFunnelText = funnelStepData.map((s: any) => s.rawText || '').join(' ');
    const cleanCopy     = funnelStepData[0]?.copy || '';
    const offerAnalysis = analyzeOffer(cleanCopy, allFunnelText);
    const platform      = funnelStepData[0]?.platform || detectPlatform(targetUrl, allFunnelText);
    const funnelType    = funnelStepData.map((s: any) => s.type).join(' → ');
    const domains       = [...new Set(funnelStepData.map((s: any) => s.domain))] as string[];
    const offerAngle    = detectOfferAngle(cleanCopy, allFunnelText);
    const creativeStyle = detectCreativeStyle(hasVSL, 0, cleanCopy);
    const rawOfferTitle = funnelStepData[0]?.offerTitle || '';
    const offerTitle    = rawOfferTitle || offerAnalysis.product;
    const priceNum      = extractPrice(allFunnelText);
    const price         = priceNum ? `R$ ${priceNum.toFixed(2)} ✅` : '💡 Não identificado';
    const mzTech        = MZ_TECH_PATTERNS.find(p => targetUrl.toLowerCase().includes(p) || allFunnelText.toLowerCase().includes(p)) || '';
    const mzCheckout    = detectMzCheckout(targetUrl, allFunnelText);

    const partial = { hasVSL, hasQuiz, hasUpsell, hasDownsell, funnelSteps: funnelStepData.length, domains, score, similarCount: 1, offerAnalysis };
    const funnelComplexity      = detectFunnelComplexity(partial);
    const performanceConfidence = detectPerformanceConfidence({ ...partial, funnelComplexity });

    const ad: ScoredAd = {
      advertiser: domains[0] || 'Manual',
      keyword: 'URL Manual',
      country: 'BR',
      score, price, priceNum,
      creativeType: hasVSL ? '🎥 Vídeo' : '🖼️ Imagem',
      dateText: null,
      hasVSL, hasQuiz, hasUpsell, hasDownsell, hasCheckout, hasLongCopy,
      funnelSteps: funnelStepData.length,
      funnelType, domains, platform,
      funnelUrl: targetUrl,
      landingDomain: domains[0] || '',
      cleanCopy, creativePath: null, creativeIsVideo: false,
      funnelStepData, offerAnalysis,
      similarCount: 1, offerAngle, creativeStyle,
      funnelComplexity, performanceConfidence,
      recommendationLevel: computeRecommendationLevel({ funnelComplexity, performanceConfidence } as ScoredAd),
      offerTitle,
      mzTech, mzCheckout,
    };

    await sendAdReport(ad, 1, true);
    appendDetailedHistory(ad, 'url_manual');
    await sendToTelegram(`✅ <b>Análise manual concluída e guardada no histórico.</b>`);

  } catch (err) {
    console.error('[analyzeUrlManual] error:', err);
    await sendToTelegram(`❌ <b>Erro ao analisar URL:</b> ${String(err).substring(0, 200)}`);
  } finally {
    await browser.close();
  }
}

// ─── Telegram Command Handlers ────────────────────────────────────────────────

function registerBotCommands() {
  // /Iniciar_ — start the autonomous cycle
  bot.onText(/\/Iniciar_/, async (tgMsg) => {
    if (String(tgMsg.chat.id) !== CHAT_ID) return;
    if (botRunning) {
      await bot.sendMessage(CHAT_ID, '⚠️ O robô já está em execução.');
      return;
    }

    // Plan today's categories and build full keyword list to show upfront
    const p0 = planTodayCategories(loadProgress());
    const isLast0 = isLastDayOfRotation(p0);
    const kwLines: string[] = [];
    for (const cat of p0.todayCategories) {
      const kws = KEYWORD_CATEGORIES[cat] || [];
      kwLines.push(`📂 <b>${cat}:</b>`);
      kws.forEach(k => kwLines.push(`  • ${k}`));
    }
    if (isLast0) {
      kwLines.push(`📂 <b>Black/PLR 🖤</b> (último dia da rotação):`);
      (BLACK_PLR_CATEGORIES['BlackPLR'] || []).forEach(k => kwLines.push(`  • ${k}`));
    }

    await bot.sendMessage(CHAT_ID,
      `🚀 <b>Robô iniciado!</b>\n\n` +
      `📋 <b>Palavras-chave a analisar hoje:</b>\n${kwLines.join('\n')}\n\n` +
      `⏱️ 15 min entre cada keyword. Iniciando agora...`,
      { parse_mode: 'HTML' }
    );

    botRunning = true;
    offersFoundToday = 0;
    runMainLoop().catch(async (err) => {
      console.error('[BOT] Main loop crashed:', err);
      botRunning = false;
      try { await sendToTelegram(`🚨 <b>Erro fatal no ciclo:</b> ${String(err).substring(0, 200)}`); } catch {}
    });
  });

  // /status — current state
  bot.onText(/\/status/, async (tgMsg) => {
    if (String(tgMsg.chat.id) !== CHAT_ID) return;
    let txt = botRunning ? '🟢 <b>Robô em execução</b>' : '🔴 <b>Robô parado</b> — use /Iniciar_ para começar';
    if (currentKeyword) txt += `\n🔎 <b>Keyword atual:</b> ${currentKeyword}`;
    txt += `\n📦 <b>Ofertas encontradas hoje:</b> ${offersFoundToday}`;
    if (waitUntilMs) {
      const remainingMs = Math.max(0, waitUntilMs - Date.now());
      const h = Math.floor(remainingMs / 3600000);
      const m = Math.floor((remainingMs % 3600000) / 60000);
      txt += `\n⏰ <b>Próxima execução em:</b> ${h}h ${m}m`;
    }
    await bot.sendMessage(CHAT_ID, txt, { parse_mode: 'HTML' });
  });

  // /proxima — skip wait and advance to next keyword
  bot.onText(/\/proxima/, async (tgMsg) => {
    if (String(tgMsg.chat.id) !== CHAT_ID) return;
    if (!botRunning) {
      await bot.sendMessage(CHAT_ID, '⚠️ O robô não está em execução.');
      return;
    }
    if (waitUntilMs) {
      // Bot is in overnight sleep — /proxima can't help here, suggest /proximodia
      await bot.sendMessage(CHAT_ID,
        `⏰ O robô está em pausa até às 05:00 UTC.\nUse <code>/proximodia</code> para avançar para o próximo dia agora.`,
        { parse_mode: 'HTML' }
      );
      return;
    }
    skipCurrentKeyword = true;
    const next = nextKeywordHint ? `<b>${nextKeywordHint}</b>` : 'próxima palavra-chave';
    await bot.sendMessage(CHAT_ID,
      `⏭️ <b>A avançar para a próxima palavra-chave:</b> ${next}`,
      { parse_mode: 'HTML' }
    );
  });

  // /historico — show analysis history
  bot.onText(/\/historico/, async (tgMsg) => {
    if (String(tgMsg.chat.id) !== CHAT_ID) return;
    const entries = loadDetailedHistory();
    if (entries.length === 0) {
      await bot.sendMessage(CHAT_ID, '📭 Nenhum histórico disponível ainda.');
      return;
    }

    const last10 = entries.slice(-10).reverse();
    const topByScore = [...entries].sort((a, b) => b.score - a.score).slice(0, 5);
    const lastKeywords = [...new Set(entries.slice(-20).map(e => e.keyword))].slice(0, 8);

    let histMsg = `📋 <b>HISTÓRICO DE ANÁLISES</b>\n`;
    histMsg += `📦 Total de entradas: <b>${entries.length}</b>\n\n`;

    histMsg += `🕐 <b>ÚLTIMAS ANÁLISES:</b>\n`;
    for (const e of last10) {
      histMsg += `• <b>${e.offerTitle.substring(0, 40)}</b>\n`;
      histMsg += `  ${e.date} | ${e.keyword} | Score ${e.score}/10 | ${e.platform}\n`;
      histMsg += `  ${e.funnelUrl !== 'N/A' ? e.funnelUrl.substring(0, 60) : 'N/A'}\n\n`;
    }

    histMsg += `\n🏆 <b>MELHORES SCORES:</b>\n`;
    for (const e of topByScore) {
      histMsg += `• <b>${e.offerTitle.substring(0, 40)}</b> — ${e.score}/10\n`;
      histMsg += `  ${e.advertiser} | ${e.platform} | ${e.offerAngle}\n\n`;
    }

    histMsg += `\n🔑 <b>ÚLTIMAS KEYWORDS:</b>\n${lastKeywords.map(k => `• ${k}`).join('\n')}`;

    // Send in chunks if too long
    const chunks = histMsg.match(/.{1,4000}/gs) || [histMsg];
    for (const chunk of chunks) {
      await bot.sendMessage(CHAT_ID, chunk, { parse_mode: 'HTML', disable_web_page_preview: true });
    }
  });

  // /analisar URL — manually analyze a specific funnel URL
  bot.onText(/\/analisar (.+)/, async (analisarMsg, match) => {
    if (String(analisarMsg.chat.id) !== CHAT_ID) return;
    const arg = (match?.[1] || '').trim();
    let force = false;
    let url = arg;
    if (arg.startsWith('-f ')) {
      force = true;
      url = arg.slice(3).trim();
    }
    analyzeUrlManual(url, force).catch(async (err) => {
      console.error('[/analisar] error:', err);
      try { await sendToTelegram(`❌ Erro inesperado: ${String(err).substring(0, 200)}`); } catch {}
    });
  });

  // /resetarsemana — wipe ALL history and restart completely from zero
  bot.onText(/\/resetarsemana/, async (resetMsg) => {
    if (String(resetMsg.chat.id) !== CHAT_ID) return;
    try {
      let detailedCount = 0;
      try { detailedCount = loadDetailedHistory().length; } catch {}

      // Clear in-memory dedup history IMMEDIATELY (affects running cycle now)
      globalHistory = {};

      // Also wipe files so next restart also starts clean
      if (fs.existsSync(HISTORY_FILE)) fs.unlinkSync(HISTORY_FILE);
      if (fs.existsSync(DETAILED_HISTORY_FILE)) fs.unlinkSync(DETAILED_HISTORY_FILE);

      // Reset today's metrics and progress (keep rotation index — don't lose place in rotation)
      offersFoundToday = 0;
      const p = loadProgress();
      p.completedToday = [];
      p.runDate = '';
      saveProgress(p);

      await bot.sendMessage(CHAT_ID,
        `♻️ <b>Histórico completamente apagado!</b>\n\n` +
        `• ✅ Memória em uso limpa imediatamente\n` +
        `• ✅ Ficheiro de deduplicação apagado\n` +
        `• ✅ ${detailedCount} análises detalhadas apagadas\n` +
        `• ✅ Métricas do dia reiniciadas\n\n` +
        `O robô já não se lembra de nenhum anúncio. A análise actual irá encontrar anúncios frescos.`,
        { parse_mode: 'HTML' }
      );
    } catch (err) {
      await bot.sendMessage(CHAT_ID, `❌ Erro ao reiniciar: ${String(err).substring(0, 200)}`);
    }
  });

  // /proximodia — force jump to next day's keywords immediately
  bot.onText(/\/proximodia/, async (proximoDiaMsg) => {
    if (String(proximoDiaMsg.chat.id) !== CHAT_ID) return;
    const p = loadProgress();
    const n = ALL_CATEGORY_NAMES.length;

    // The nextCategoryIndex was already advanced by planTodayCategories for this day,
    // so it already points to tomorrow's starting index
    const nextCats = Array.from({ length: CATEGORIES_PER_DAY }, (_, i) =>
      ALL_CATEGORY_NAMES[(p.nextCategoryIndex + i) % n]
    );

    // Build keyword preview for next day
    const nextKwLines: string[] = [];
    for (const cat of nextCats) {
      const kws = KEYWORD_CATEGORIES[cat] || [];
      nextKwLines.push(`📂 <b>${cat}:</b> ${kws.slice(0, 3).join(', ')}${kws.length > 3 ? ` +${kws.length - 3}` : ''}`);
    }

    // Mark current day as done and force re-plan
    p.completedToday = [...p.todayCategories];
    p.runDate = '';
    saveProgress(p);

    // Wake up from overnight wait and skip current keyword gap
    skipWaitUntilNextRun = true;
    skipCurrentKeyword = true;

    await bot.sendMessage(CHAT_ID,
      `⏭️ <b>A avançar para o próximo dia!</b>\n\n` +
      `📋 <b>Palavras-chave do dia seguinte:</b>\n${nextKwLines.join('\n')}\n\n` +
      `O ciclo recomeça em instantes...`,
      { parse_mode: 'HTML' }
    );
  });

  // /ajuda and /help — show all available commands
  const helpText =
`📖 <b>COMANDOS DISPONÍVEIS</b>

/Iniciar_ — Inicia o robô e o ciclo autónomo de análise

/status — Mostra o estado atual: keyword em curso, ofertas encontradas, tempo para próxima execução

/proxima — Avança para a próxima keyword, ignorando a espera de 15 min

/proximodia — Força a rotação para as keywords do próximo dia imediatamente

/historico — Mostra o histórico de análises com produtos reais, scores, links e plataformas

/analisar URL — Analisa um funil específico com o mesmo processo automático
  Ex: <code>/analisar https://exemplo.com/funil</code>
  Use <code>/analisar -f URL</code> para forçar re-análise (mesmo que já feita nos últimos 30 dias)

/resetarsemana — Limpa o histórico dos últimos 7 dias e reinicia as métricas

/ajuda ou /help — Mostra esta lista de comandos`;

  bot.onText(/\/ajuda/, async (ajudaMsg) => {
    if (String(ajudaMsg.chat.id) !== CHAT_ID) return;
    await bot.sendMessage(CHAT_ID, helpText, { parse_mode: 'HTML', disable_web_page_preview: true });
  });

  bot.onText(/\/help/, async (helpMsg) => {
    if (String(helpMsg.chat.id) !== CHAT_ID) return;
    await bot.sendMessage(CHAT_ID, helpText, { parse_mode: 'HTML', disable_web_page_preview: true });
  });

  console.log('[BOT] Commands registered: /Iniciar_ /status /proxima /proximodia /historico /analisar /resetarsemana /ajuda /help');
  console.log('[BOT] Polling active — listening for Telegram messages...');
}

// ─── Main loop (extracted so it can be called from /Iniciar_) ─────────────────

async function runMainLoop() {
  // Sync globalHistory from disk at loop start (respects 7-day auto-expire)
  globalHistory = loadHistory();

  while (botRunning) {
    const history  = globalHistory;
    let   progress = loadProgress();

    progress = planTodayCategories(progress);
    const isLastDay     = isLastDayOfRotation(progress);
    const todayCats     = progress.todayCategories;
    const remaining     = todayCats.filter(c => !progress.completedToday.includes(c));
    const historyAge    = (() => {
      try {
        const raw = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
        const age = Date.now() - (raw._meta?.createdAt ?? Date.now());
        return `${Math.round(age / 86400000)} dias`;
      } catch { return 'novo'; }
    })();

    const totalCats   = ALL_CATEGORY_NAMES.length;
    const doneOverall = progress.nextCategoryIndex;
    const rotation    = `${doneOverall % totalCats}/${totalCats}`;

    console.log(`\n═══════════ EXECUÇÃO DIÁRIA ${progress.runDate} ═══════════`);
    console.log(`Categorias de hoje: ${todayCats.join(', ')}`);
    console.log(`Já concluídas hoje: ${progress.completedToday.join(', ') || 'nenhuma'}`);
    console.log(`Restam: ${remaining.join(', ') || 'nenhuma'}`);
    if (isLastDay) console.log(`[LAST DAY] Black/PLR será executado após low-ticket`);

    if (remaining.length === 0 && !isLastDay) {
      await sendToTelegram(`✅ <b>Todas as categorias de hoje já foram analisadas.</b>\nAguardando próxima execução às 05:00 UTC.`);
      await waitUntilNextRun();
      continue;
    }

    // Build today's run list: low-ticket remaining + Black/PLR if last day
    const fullRunList = [...remaining];
    if (isLastDay && !progress.completedToday.includes('BlackPLR')) {
      fullRunList.push('BlackPLR');
    }

    if (fullRunList.length === 0) {
      await waitUntilNextRun();
      continue;
    }

    const allCatList = fullRunList.map((c) => {
      const done = progress.completedToday.includes(c);
      const cur  = fullRunList[0] === c && !done;
      const isBlack = !!BLACK_PLR_CATEGORIES[c];
      return `${done ? '✅' : cur ? '▶️' : '⏳'} ${c}${isBlack ? ' 🖤' : ''}`;
    }).join('\n');

    await sendToTelegram(
`🚀 <b>Agente v6 — Execução Diária</b>
📅 <b>${progress.runDate}</b> | 05:00 UTC (07:00 Moçambique)
🌍 Brasil 🇧🇷 ${isLastDay ? '+ Moçambique 🇲🇿 (Black/PLR)' : ''}

📂 <b>Categorias de hoje (${fullRunList.length} restante${fullRunList.length !== 1 ? 's' : ''}):</b>
${allCatList}

🔄 Rotação global: ${rotation} | 📋 Histórico: ${historyAge}
⏱️ 15 min entre keywords | 🔁 Deduplificação ativa${isLastDay ? '\n🖤 Último dia da rotação — Black/PLR após low-ticket' : ''}`
    );

    offersFoundToday = 0;
    const keywordScores = new Map<string, number[]>();
    const allAds: ScoredAd[] = [];

    try {
      await runCycle(history, keywordScores, allAds, fullRunList, (completedCat) => {
        progress.completedToday.push(completedCat);
        saveProgress(progress);
        console.log(`[PROGRESS] Category "${completedCat}" saved. Done today: ${progress.completedToday.join(', ')}`);
      });

      if (keywordScores.size > 0) await sendKeywordRanking(keywordScores);
      if (allAds.length >= 3)    await sendCompetitiveGapAnalysis(allAds);
      saveHistory(history);

      const nextCats = Array.from({ length: CATEGORIES_PER_DAY }, (_, i) =>
        ALL_CATEGORY_NAMES[(progress.nextCategoryIndex + i) % ALL_CATEGORY_NAMES.length]
      ).join(', ');

      await sendToTelegram(
`✅ <b>Análise do dia ${progress.runDate} concluída!</b>
📂 Categorias: ${todayCats.join(', ')}${isLastDay ? ' + Black/PLR 🖤' : ''}
📊 ${allAds.length} anúncio${allAds.length !== 1 ? 's' : ''} analisado${allAds.length !== 1 ? 's' : ''}
🔄 Próximas categorias: ${nextCats}`
      );

    } catch (err) {
      console.error('Daily run crashed:', err);
      saveHistory(history);
      await sendToTelegram(`⚠️ <b>Erro na execução diária. Retomando amanhã.</b>\n${String(err).substring(0, 200)}`);
    }

    await waitUntilNextRun();
  }

  botRunning = false;
}

// ─── Entry Point ──────────────────────────────────────────────────────────────

registerBotCommands();

// Auto-start the main loop on process start (same behaviour as before)
botRunning = true;
runMainLoop().catch(async (err) => {
  console.error('Fatal error:', err);
  botRunning = false;
  try { await sendToTelegram(`🚨 <b>Erro fatal — reiniciando em 2 min:</b> ${String(err).substring(0, 200)}`); } catch {}
  await delay(2 * 60 * 1000);
  botRunning = true;
  runMainLoop().catch(console.error);
});
