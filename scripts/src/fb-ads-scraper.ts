import { chromium, Browser, BrowserContext, Page } from 'playwright';
import TelegramBot from 'node-telegram-bot-api';
import * as fs from 'fs';
import * as https from 'https';
import * as http from 'http';
import * as path from 'path';

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN!, { polling: false });
const CHAT_ID = process.env.TELEGRAM_CHAT_ID!;

const COUNTRIES = ['BR', 'MZ'];
const MIN_PRICE = 9.99;
const MAX_PRICE = 50;
const MAX_FUNNEL_DEPTH = 5;

interface AdCategory {
  name: string;
  keywords: string[];
}

const CATEGORIES: AdCategory[] = [
  { name: 'Moldes',         keywords: ['Moldes por apenas 10', 'Moldes por apenas 17', 'Moldes por apenas 27'] },
  { name: 'PDF',            keywords: ['PDF por apenas 9,99', 'PDF por apenas 10', 'PDF por apenas 17', 'PDF por apenas 27', 'PDF por apenas 37', 'PDF por apenas 47'] },
  { name: 'Receitas',       keywords: ['Receitas por apenas 9,99', 'Receitas por apenas 10', 'Receitas por apenas 17', 'Receitas por apenas 27', 'Receitas por apenas 37'] },
  { name: 'Planner',        keywords: ['Planner por apenas 9,99', 'Planner por apenas 10', 'Planner por apenas 17', 'Planner por apenas 27', 'Planner por apenas 37'] },
  { name: 'Apostila',       keywords: ['Apostila por apenas 9,99', 'Apostila por apenas 10', 'Apostila por apenas 17', 'Apostila por apenas 27'] },
  { name: 'Kit Completo',   keywords: ['Kit completo por apenas 10', 'Kit completo por apenas 17', 'Kit completo por apenas 27', 'Kit completo por apenas 37'] },
  { name: 'Aulas Prontas',  keywords: ['Aulas prontas por apenas 17', 'Aulas prontas por apenas 27', 'Aulas prontas por apenas 37'] },
  { name: 'Material Pronto',keywords: ['Material pronto por apenas 17', 'Material pronto por apenas 27'] },
  { name: 'Pacote',         keywords: ['Pacote por apenas 9,99', 'Pacote por apenas 10', 'Pacote por apenas 17', 'Pacote por apenas 27'] },
  { name: 'Dinâmicas',      keywords: ['Dinâmicas por apenas 17', 'Dinâmicas por apenas 27'] },
  { name: 'Baixe Agora',    keywords: ['Baixe agora por apenas 9,99', 'Baixe agora por apenas 10', 'Baixe agora por apenas 17'] },
];

const MAX_ADS_PER_KEYWORD = 10;

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36',
];

// ─── Types ────────────────────────────────────────────────────────────────────

type PageType =
  | 'LANDING'
  | 'QUIZ'
  | 'CHECKOUT'
  | 'UPSELL'
  | 'DOWNSELL'
  | 'VSL'
  | 'WHATSAPP'
  | 'UNKNOWN';

interface FunnelStep {
  url: string;
  domain: string;
  type: PageType;
  title: string;
  screenshotPath: string;
  videoUrl: string | null;
  hasUpsell: boolean;
  hasDownsell: boolean;
  isQuiz: boolean;
  copy: string;
  price: number | null;
  depth: number;
}

interface AdResult {
  entryUrl: string;
  text: string;
  hasVideo: boolean;
  advertiser: string;
  imageUrls: string[];
  videoUrls: string[];
  daysRunning: number | null;
}

interface ScoredAd {
  advertiser: string;
  score: number;
  priceLabel: string;
  creativeType: string;
  daysRunning: number | null;
  keyword: string;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function randomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseDaysRunning(cardText: string): number | null {
  const ptMonths: Record<string, number> = {
    'janeiro': 0, 'fevereiro': 1, 'março': 2, 'abril': 3, 'maio': 4, 'junho': 5,
    'julho': 6, 'agosto': 7, 'setembro': 8, 'outubro': 9, 'novembro': 10, 'dezembro': 11,
  };
  const ptMatch = cardText.match(/ativo desde\s+(\d+)\s+de\s+(\w+)\s+de\s+(\d{4})/i);
  if (ptMatch) {
    const day = parseInt(ptMatch[1]);
    const month = ptMonths[ptMatch[2].toLowerCase()];
    const year = parseInt(ptMatch[3]);
    if (month !== undefined) {
      const diff = Date.now() - new Date(year, month, day).getTime();
      return Math.floor(diff / 86400000);
    }
  }
  const enMonths: Record<string, number> = {
    'january': 0, 'february': 1, 'march': 2, 'april': 3, 'may': 4, 'june': 5,
    'july': 6, 'august': 7, 'september': 8, 'october': 9, 'november': 10, 'december': 11,
  };
  const enMatch = cardText.match(/started running on\s+([A-Za-z]+)\s+(\d+),?\s+(\d{4})/i);
  if (enMatch) {
    const month = enMonths[enMatch[1].toLowerCase()];
    const day = parseInt(enMatch[2]);
    const year = parseInt(enMatch[3]);
    if (month !== undefined) {
      const diff = Date.now() - new Date(year, month, day).getTime();
      return Math.floor(diff / 86400000);
    }
  }
  return null;
}

function scoreAd(ad: AdResult, steps: FunnelStep[]): number {
  let score = 0;
  if (ad.daysRunning !== null && ad.daysRunning > 30) score += 30;
  const hasVsl = steps.some(s => s.type === 'VSL') || ad.hasVideo || ad.videoUrls.length > 0;
  if (hasVsl) score += 20;
  if (steps.some(s => s.hasUpsell || s.hasDownsell)) score += 20;
  if (/R\$\s*\d+|\d+[,\.]\d{2}/.test(ad.text)) score += 15;
  if (steps.some(s => s.isQuiz || s.type === 'QUIZ')) score += 10;
  if (new Set(steps.map(s => s.domain)).size > 1) score += 5;
  return Math.min(score, 100);
}

async function sendCategorySummary(categoryName: string, results: ScoredAd[], country: string): Promise<void> {
  if (results.length === 0) return;
  const countryName = country === 'BR' ? 'Brasil 🇧🇷' : 'Moçambique 🇲🇿';
  const sorted = [...results].sort((a, b) => b.score - a.score).slice(0, 10);
  let text = `🏆 <b>TOP ${sorted.length} MELHORES OFERTAS — ${categoryName.toUpperCase()} | ${countryName}</b>\n\n`;
  sorted.forEach((r, i) => {
    const days = r.daysRunning !== null ? `${r.daysRunning} dias rodando` : 'tempo desconhecido';
    text += `${i + 1}. <b>${r.advertiser}</b> — Score: ${r.score}/100 — ${r.priceLabel} — ${r.creativeType} — ${days} — <i>${r.keyword}</i>\n`;
  });
  if (sorted.length >= 2) {
    text += `\n💡 <b>Recomendação:</b> Clonar ofertas 1 e 2`;
  } else if (sorted.length === 1) {
    text += `\n💡 <b>Recomendação:</b> Clonar oferta 1`;
  }
  await sendToTelegram(text);
}

/**
 * Decode Facebook redirect links (l.facebook.com and lm.facebook.com).
 * Returns null if the URL is unparseable or has no real destination.
 */
function cleanFacebookLink(url: string): string | null {
  try {
    const u = new URL(url);
    if (
      u.hostname === 'l.facebook.com' ||
      u.hostname === 'lm.facebook.com' ||
      u.hostname.endsWith('.l.facebook.com') ||
      u.hostname.endsWith('.lm.facebook.com')
    ) {
      const real = u.searchParams.get('u');
      if (!real) return null;
      return decodeURIComponent(real);
    }
    return url;
  } catch {
    return null;
  }
}

function extractDomain(url: string): string {
  try { return new URL(url).hostname; } catch { return ''; }
}

function extractPrice(text: string): number | null {
  const patterns = [
    /R\$\s*(\d+[.,]\d{0,2})/gi,
    /por apenas\s*R?\$?\s*(\d+[.,]\d{0,2})/gi,
    /apenas\s*R?\$?\s*(\d+[.,]\d{0,2})/gi,
    /(\d+[.,]\d{0,2})\s*reais/gi,
  ];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    const match = pattern.exec(text);
    if (match) {
      const price = parseFloat(match[1].replace(',', '.'));
      if (price >= MIN_PRICE && price <= MAX_PRICE) return price;
    }
  }
  return null;
}

function classifyPageType(text: string, hasVideo: boolean, radioInputs: number): PageType {
  const lower = text.toLowerCase();
  if (lower.includes('whatsapp') || lower.includes('wa.me')) return 'WHATSAPP';
  if (lower.includes('checkout') || lower.includes('finalizar compra') || lower.includes('cartão de crédito') || lower.includes('boleto') || lower.includes('pix')) return 'CHECKOUT';
  if (lower.includes('upsell') || lower.includes('leve também') || lower.includes('adicione ao seu pedido') || lower.includes('aproveite também')) return 'UPSELL';
  if (lower.includes('espera') || lower.includes('antes de sair') || lower.includes('última chance') || lower.includes('não vá embora')) return 'DOWNSELL';
  if (radioInputs >= 2 || lower.includes('quiz') || lower.includes('próxima pergunta') || lower.includes('responda')) return 'QUIZ';
  if (hasVideo && (lower.includes('assista') || lower.includes('vídeo') || lower.includes('apresentação') || lower.includes('vsl'))) return 'VSL';
  if (hasVideo) return 'VSL';
  return 'LANDING';
}

function pageTypeEmoji(type: PageType): string {
  const map: Record<PageType, string> = {
    LANDING:   '🏠 Landing Page',
    QUIZ:      '🎯 Quiz',
    CHECKOUT:  '🛒 Checkout',
    UPSELL:    '⬆️ Upsell',
    DOWNSELL:  '⬇️ Downsell',
    VSL:       '🎥 VSL',
    WHATSAPP:  '💬 WhatsApp',
    UNKNOWN:   '❓ Desconhecido',
  };
  return map[type];
}

/** Returns true if the link should be followed as a funnel step. */
function isFunnelLink(href: string): boolean {
  if (!href.startsWith('http')) return false;
  const BLOCKED = [
    'facebook.com', 'l.facebook.com', 'lm.facebook.com',
    'instagram.com', 'twitter.com', 'youtube.com',
    'google.com', 'linkedin.com', 'tiktok.com',
    'metastatus.com', 'fb.me', 'apple.com', 'microsoft.com',
    'amazon.com', 'aws.amazon.com',
  ];
  return !BLOCKED.some(b => extractDomain(href).includes(b));
}

/** Returns true if the URL is a tracking passthrough that should be skipped. */
function isTrackingUrl(href: string): boolean {
  const patterns = ['/cs/c/', 'hubspot', 'hsutk=', 'hsfp=', '__hstc'];
  return patterns.some(p => href.includes(p));
}

/** Returns true if the URL points directly to a downloadable file (not a web page). */
function isDownloadUrl(href: string): boolean {
  const ext = href.split('?')[0].split('#')[0].toLowerCase();
  return /\.(pdf|zip|docx?|xlsx?|pptx?|mp4|mp3|avi|mov|rar|7z|tar|gz)$/.test(ext);
}

/** Returns true if the URL is a WhatsApp link — valid as funnel endpoint but not as entry. */
function isWhatsAppUrl(href: string): boolean {
  return href.includes('wa.me') || href.includes('api.whatsapp.com') || href.includes('web.whatsapp.com');
}

// ─── File & Creative Helpers ──────────────────────────────────────────────────

function downloadFile(url: string, dest: string): Promise<boolean> {
  return new Promise(resolve => {
    const file = fs.createWriteStream(dest);
    const protocol = url.startsWith('https') ? https : http;
    protocol.get(url, response => {
      response.pipe(file);
      file.on('finish', () => { file.close(); resolve(true); });
    }).on('error', () => {
      try { fs.unlinkSync(dest); } catch {}
      resolve(false);
    });
  });
}

// ─── Browser ──────────────────────────────────────────────────────────────────

async function launchBrowser(): Promise<Browser> {
  return chromium.launch({
    headless: true,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--disable-dev-shm-usage', '--disable-gpu',
      '--single-process', '--no-zygote',
      '--memory-pressure-off',
    ],
  });
}

async function createContext(browser: Browser, country: string): Promise<BrowserContext> {
  const context = await browser.newContext({
    userAgent: randomUserAgent(),
    locale: country === 'BR' ? 'pt-BR' : 'pt-MZ',
    viewport: { width: 1280, height: 800 },
    extraHTTPHeaders: {
      'Accept-Language': country === 'BR' ? 'pt-BR,pt;q=0.9,en;q=0.8' : 'pt-MZ,pt;q=0.9,en;q=0.8',
    },
  });
  await context.addInitScript(`
    Object.defineProperty(navigator, 'webdriver', { get: function(){ return false; } });
    Object.defineProperty(navigator, 'plugins',   { get: function(){ return [1,2,3]; } });
  `);
  return context;
}

// ─── Funnel Crawler ───────────────────────────────────────────────────────────

async function crawlFunnel(
  context: BrowserContext,
  startUrl: string,
  funnelId: string,
): Promise<FunnelStep[]> {
  const steps: FunnelStep[] = [];
  const visited = new Set<string>();
  let currentUrl = startUrl;
  let depth = 0;

  while (currentUrl && depth < MAX_FUNNEL_DEPTH && !visited.has(currentUrl)) {
    visited.add(currentUrl);
    const page = await context.newPage();

    try {
      console.log(`\n  📄 Step ${depth + 1}: ${currentUrl}`);
      await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await sleep(2500 + Math.random() * 1000);
      await page.evaluate('window.scrollBy(0, 600)');
      await sleep(800);

      const screenshotPath = path.join(
        process.cwd(),
        `funnel_${funnelId}_step${depth + 1}.png`
      );
      await page.screenshot({ path: screenshotPath, fullPage: false });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pageData: any = await page.evaluate(`(() => {
        var text = document.body ? document.body.innerText : '';
        var lower = text.toLowerCase();

        var hasVideo = !!(
          document.querySelector('video') ||
          document.querySelector('iframe[src*="youtube"]') ||
          document.querySelector('iframe[src*="vimeo"]') ||
          document.querySelector('iframe[src*="play"]') ||
          document.querySelector('iframe[src*="wistia"]') ||
          document.querySelector('iframe[src*="panda"]')
        );
        var videoEl = document.querySelector('iframe[src*="youtube"]')
                   || document.querySelector('iframe[src*="vimeo"]')
                   || document.querySelector('video');
        var videoUrl = videoEl ? (videoEl.src || null) : null;

        var radioInputs = document.querySelectorAll('input[type="radio"]').length;
        var hasUpsell   = lower.includes('upsell') || lower.includes('leve tambem') || lower.includes('adicione ao pedido') || lower.includes('aproveite tambem');
        var hasDownsell = lower.includes('espera') || lower.includes('antes de sair') || lower.includes('ultima chance');
        var isQuiz      = radioInputs >= 2 || lower.includes('quiz');

        var ctaKeywords = ['saiba mais','comprar','compre','baixe','quero','acessar','garantir','clique','proximo','continuar','sim','comecar','obter','assinar','iniciar','adquirir'];
        var allAs = Array.from(document.querySelectorAll('a'));
        var ctaLinks = allAs.filter(function(el) {
          var t = (el.innerText || el.textContent || '').toLowerCase();
          return ctaKeywords.some(function(k){ return t.includes(k); }) && el.href && el.href.startsWith('http');
        }).map(function(el){ return el.href; });

        var waLinks = allAs.map(function(a){ return a.href; })
          .filter(function(h){ return h.includes('wa.me') || h.includes('whatsapp'); });

        return {
          title: document.title,
          text: text.substring(0, 2000),
          hasVideo: hasVideo,
          videoUrl: videoUrl,
          radioInputs: radioInputs,
          hasUpsell: hasUpsell,
          hasDownsell: hasDownsell,
          isQuiz: isQuiz,
          ctaLinks: ctaLinks.slice(0, 5),
          waLinks: waLinks.slice(0, 2)
        };
      })()`);

      const realUrl = page.url();
      const domain = extractDomain(realUrl);
      const type = classifyPageType(pageData.text, pageData.hasVideo, pageData.radioInputs);
      const price = extractPrice(pageData.text);

      steps.push({
        url: realUrl,
        domain,
        type,
        title: pageData.title,
        screenshotPath,
        videoUrl: pageData.videoUrl as string | null,
        hasUpsell: pageData.hasUpsell as boolean,
        hasDownsell: pageData.hasDownsell as boolean,
        isQuiz: pageData.isQuiz as boolean,
        copy: (pageData.text as string).substring(0, 800),
        price,
        depth: depth + 1,
      });

      console.log(`  ✅ Tipo: ${type} | Domínio: ${domain}`);

      // Determine next URL
      const isTerminal = type === 'CHECKOUT' || type === 'WHATSAPP';
      let nextUrl: string | null = null;

      if (!isTerminal) {
        if ((pageData.waLinks as string[]).length > 0) {
          nextUrl = (pageData.waLinks as string[])[0];
        } else {
          const candidate = (pageData.ctaLinks as string[]).find(
            l => !visited.has(l) && isFunnelLink(l) && !isTrackingUrl(l)
          );
          nextUrl = candidate ?? null;
        }
      }

      if (nextUrl && !visited.has(nextUrl)) {
        console.log('FUNNEL LINK ESCOLHIDO:', nextUrl);
        currentUrl = nextUrl;
      } else {
        break;
      }

      depth++;
    } catch (err) {
      console.error(`  ⚠️ Erro no step ${depth + 1}:`, (err as Error).message);
      break;
    } finally {
      try { await page.close(); } catch {}
    }
  }

  return steps;
}

// ─── Telegram ─────────────────────────────────────────────────────────────────

async function sendToTelegram(message: string): Promise<void> {
  try {
    await bot.sendMessage(CHAT_ID, message, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
  } catch (e) {
    console.error('Erro Telegram msg:', (e as Error).message);
  }
}

async function sendPhotoToTelegram(imagePath: string, caption: string): Promise<void> {
  try {
    if (fs.existsSync(imagePath)) {
      await bot.sendPhoto(CHAT_ID, imagePath, { caption: caption.substring(0, 1024) });
    }
  } catch (e) {
    console.error('Erro Telegram foto:', (e as Error).message);
  } finally {
    try { if (fs.existsSync(imagePath)) fs.unlinkSync(imagePath); } catch {}
  }
}

async function sendVideoToTelegram(videoPath: string, caption: string): Promise<void> {
  try {
    if (fs.existsSync(videoPath)) {
      await bot.sendVideo(CHAT_ID, videoPath, { caption: caption.substring(0, 1024) });
    }
  } catch (e) {
    console.error('Erro Telegram vídeo:', (e as Error).message);
  } finally {
    try { if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath); } catch {}
  }
}

async function sendCreative(ad: AdResult): Promise<void> {
  if (ad.videoUrls.length > 0) {
    const dest = `creative_${Date.now()}.mp4`;
    const ok = await downloadFile(ad.videoUrls[0], dest);
    if (ok) { await sendVideoToTelegram(dest, '🎥 Criativo'); return; }
  }
  if (ad.imageUrls.length > 0) {
    const dest = `creative_${Date.now()}.jpg`;
    const ok = await downloadFile(ad.imageUrls[0], dest);
    if (ok) { await sendPhotoToTelegram(dest, '🖼 Criativo'); return; }
  }
}

async function sendFunnelReport(
  ad: AdResult,
  steps: FunnelStep[],
  keyword: string,
  country: string,
  score: number,
): Promise<void> {
  const countryName = country === 'BR' ? 'Brasil 🇧🇷' : 'Moçambique 🇲🇿';
  const domains = [...new Set(steps.map(s => s.domain))];
  const prices = steps.map(s => s.price).filter((p): p is number => p !== null);
  const priceLabel = prices.length > 0 ? `R$ ${prices[0].toFixed(2)} ✅` : '💡 Não identificado';
  const creativeType = ad.hasVideo || ad.videoUrls.length > 0 ? '🎥 Vídeo/VSL' : '🖼 Imagem';
  const daysLabel = ad.daysRunning !== null ? `${ad.daysRunning} dias` : 'desconhecido';

  const stepsText = steps
    .map((s, i) => {
      let line = `  <b>${i + 1}.</b> ${pageTypeEmoji(s.type)} — <code>${s.domain}</code>`;
      if (s.hasUpsell)   line += ' ⬆️';
      if (s.hasDownsell) line += ' ⬇️';
      if (s.isQuiz)      line += ' 🎯';
      if (s.videoUrl)    line += ' 🎥';
      return line;
    })
    .join('\n');

  const summary = steps.map(s => s.type).join(' → ');

  // Full ad details block
  const details = `⭐ <b>Score: ${score}/100</b> | ${countryName}
<b>🏢 Anunciante:</b> ${ad.advertiser}
<b>🎨 Criativo:</b> ${creativeType}
<b>💰 Preço:</b> ${priceLabel}
<b>📅 Rodando há:</b> ${daysLabel}
<b>🌐 Domínios:</b> ${domains.join(', ')}
<b>🔗 Multi-domínio:</b> ${domains.length > 1 ? '✅ Sim' : '❌ Não'}
<b>🔀 Funil:</b> ${summary}
<b>⬆️ Upsell:</b> ${steps.some(s => s.hasUpsell) ? '✅ Sim' : '❌ Não'}
<b>⬇️ Downsell:</b> ${steps.some(s => s.hasDownsell) ? '✅ Sim' : '❌ Não'}

<b>📊 Etapas (${steps.length}):</b>
${stepsText}

<b>🔗 Entrada:</b> ${steps[0]?.url || 'N/A'}

<b>📝 COPY:</b>
${(steps[0]?.copy ?? ad.text).substring(0, 800)}`;

  await sendToTelegram(details);

  // Screenshot per funnel step
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const caption = `📸 Etapa ${i + 1}/${steps.length} | ${pageTypeEmoji(step.type)}\n${step.title.substring(0, 100)}\n${step.url.substring(0, 100)}`;
    await sendPhotoToTelegram(step.screenshotPath, caption);
    await sleep(500);
  }
}

// ─── Ads Library Scraper ──────────────────────────────────────────────────────

/**
 * Extract ads from the Facebook Ads Library page.
 *
 * All real ad destinations are wrapped in l.facebook.com/l.php?u=<encoded-url>
 * or lm.facebook.com/l.php?u=<encoded-url>. We collect ONLY those links,
 * decode in Node.js, filter noise, then deduplicate by landing domain.
 * We also collect image/video URLs from the card for creative download.
 */
async function extractAdsFromPage(page: Page): Promise<AdResult[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw: any[] = await page.evaluate(`(() => {
    var results = [];
    var sel1 = document.querySelectorAll('a[href*="l.facebook.com/l.php"]');
    var sel2 = document.querySelectorAll('a[href*="lm.facebook.com/l.php"]');
    var allAnchors = Array.from(sel1).concat(Array.from(sel2));

    var seen = {};
    for (var i = 0; i < allAnchors.length; i++) {
      var a = allAnchors[i];
      var href = a.href;
      if (seen[href]) continue;
      seen[href] = true;

      // Walk up DOM to find the nearest ad card container
      var el = a.parentElement;
      var walks = 0;
      while (el && walks < 12) {
        if ((el.innerText || '').trim().length > 80) break;
        el = el.parentElement;
        walks++;
      }

      var cardText = el ? (el.innerText || '').substring(0, 1000) : '';
      var hasVideo = el ? el.querySelectorAll('video').length > 0 : false;

      // Collect image and video URLs from the card
      var imageUrls = [];
      var videoUrls = [];
      if (el) {
        var imgs = Array.from(el.querySelectorAll('img'));
        for (var ii = 0; ii < imgs.length; ii++) {
          var src = imgs[ii].src;
          if (src && src.startsWith('http') && !src.includes('emoji') && !src.includes('static')) {
            imageUrls.push(src);
          }
        }
        var vids = Array.from(el.querySelectorAll('video'));
        for (var vi = 0; vi < vids.length; vi++) {
          var vsrc = vids[vi].src;
          if (vsrc && vsrc.startsWith('http')) videoUrls.push(vsrc);
        }
      }

      // Advertiser name
      var advEl = null;
      if (el) {
        advEl = el.querySelector('a[role="link"] h2')
             || el.querySelector('a[role="link"] h3')
             || el.querySelector('h2 a')
             || el.querySelector('h3 a')
             || el.querySelector('strong a')
             || el.querySelector('h2')
             || el.querySelector('h3')
             || el.querySelector('strong');
      }
      var advertiser = advEl ? (advEl.innerText || '').trim() : 'Desconhecido';

      results.push({
        rawHref: href,
        text: cardText,
        hasVideo: hasVideo,
        advertiser: advertiser,
        imageUrls: imageUrls.slice(0, 3),
        videoUrls: videoUrls.slice(0, 2),
      });
    }

    return results;
  })()`) as any[];

  if (raw.length === 0) return [];

  const BLOCKED_DOMAINS = [
    // Facebook/Meta properties
    'facebook.com', 'l.facebook.com', 'lm.facebook.com',
    'instagram.com', 'fb.me', 'metastatus.com',
    // Social & search
    'twitter.com', 'linkedin.com', 'google.com', 'tiktok.com', 'youtube.com',
    // Big tech
    'apple.com', 'microsoft.com', 'amazon.com', 'aws.amazon.com',
    // Large Brazilian retailers / news / off-topic brands that appear on generic keywords
    'shopee.com.br', 'americanas.com.br', 'mercadolivre.com.br', 'magazineluiza.com.br',
    'friboi.com.br', 'globo.com', 'uol.com.br', 'terra.com.br', 'r7.com',
    'agenciabrasil.ebc.com.br', 'ebc.com.br', 'sbim.org.br',
    'sbsaude.org.br', 'ministeriodasaude.gov.br',
    // Generic SaaS tools unlikely to be digital product funnels
    'zapsign.com.br', 'turboscribe.ai', 'canva.com', 'notion.so',
  ];

  const seenDomains = new Set<string>();
  const ads: AdResult[] = [];

  for (const item of raw) {
    const decoded = cleanFacebookLink(item.rawHref as string);
    if (!decoded) continue;
    if (!decoded.startsWith('http')) continue;
    if (BLOCKED_DOMAINS.some(d => extractDomain(decoded).includes(d))) continue;
    if (isTrackingUrl(decoded)) continue;
    // Bug fix #1: wa.me links crash the browser — they're endpoints, not entry pages
    if (isWhatsAppUrl(decoded)) continue;
    // Bug fix #3: direct file downloads crash Playwright (no DOM to render)
    if (isDownloadUrl(decoded)) continue;

    const domain = extractDomain(decoded);
    if (!domain || seenDomains.has(domain)) continue;
    seenDomains.add(domain);

    ads.push({
      entryUrl: decoded,
      text: item.text as string,
      hasVideo: item.hasVideo as boolean,
      advertiser: item.advertiser as string,
      imageUrls: item.imageUrls as string[],
      videoUrls: item.videoUrls as string[],
      daysRunning: parseDaysRunning(item.text as string),
    });

    if (ads.length >= MAX_ADS_PER_KEYWORD) break;
  }

  return ads;
}

async function scrapeKeyword(
  browser: Browser,
  keyword: string,
  country: string,
  categoryResults: ScoredAd[],
): Promise<void> {
  const countryName = country === 'BR' ? 'Brasil 🇧🇷' : 'Moçambique 🇲🇿';
  const searchUrl = `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=${country}&q=${encodeURIComponent(keyword)}&search_type=keyword_unordered`;

  let context: BrowserContext | null = null;
  let page: Page | null = null;

  try {
    context = await createContext(browser, country);
    page = await context.newPage();

    console.log(`  → Abrindo Ads Library: ${keyword} (${country})`);
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(4000 + Math.random() * 2000);

    await page.evaluate('window.scrollBy(0, 2000)');
    await sleep(2000);
    await page.evaluate('window.scrollBy(0, 2000)');
    await sleep(1500);

    const debugPath = `debug_${country}_${Date.now()}.png`;
    await page.screenshot({ path: debugPath });
    console.log(`  📸 Debug screenshot: ${debugPath}`);

    const ads = await extractAdsFromPage(page);

    if (ads.length === 0) {
      console.log(`  ⚠️ Nenhum link de destino encontrado para "${keyword}" em ${countryName}`);
      return;
    }

    console.log(`  ✅ ${ads.length} funil(is) encontrado(s) para "${keyword}" em ${countryName}`);

    // Close Ads Library page before crawling to free resources under --single-process
    try { await page.close(); page = null; } catch {}

    for (let i = 0; i < ads.length; i++) {
      const ad = ads[i];
      const funnelId = `${country}_${Date.now()}_${i}`;
      console.log(`\n  🔗 [${i + 1}/${ads.length}] Crawleando funil: ${ad.entryUrl}`);

      // Bug fix #2: if the context died in a previous funnel, recreate it before continuing
      if (!context) {
        console.log('  ♻️ Recriando contexto após crash...');
        try {
          context = await createContext(browser, country);
        } catch {
          // Browser itself is dead — break out so main() restarts it for the next keyword
          console.log('  💀 Browser morreu — encerrando keyword, próxima reiniciará com browser novo');
          break;
        }
      }

      // 1. Header (score computed after crawl; send placeholder now, score goes in details)
      await sendToTelegram(`🎯 <b>OFERTA ${i + 1}</b> | ${keyword} | ${countryName}`);

      // 2. Creative (image or video)
      await sendCreative(ad);

      // Crawl the funnel
      let steps: FunnelStep[] = [];
      try {
        steps = await crawlFunnel(context, ad.entryUrl, funnelId);
      } catch (funnelErr) {
        const msg = (funnelErr as Error).message ?? '';
        const isDead = msg.includes('Target page, context or browser has been closed')
                    || msg.includes('browserContext.newPage');
        console.error(`  ⚠️ Funil ${i + 1} falhou:`, msg);
        if (isDead) {
          try { await context.close(); } catch {}
          context = null;
        }
      }

      if (steps.length === 0) {
        console.log(`  ⚠️ Nenhum passo capturado para o funil ${i + 1}`);
        await sendToTelegram('━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        continue;
      }

      // Score this ad and accumulate for category summary
      const score = scoreAd(ad, steps);
      const prices = steps.map(s => s.price).filter((p): p is number => p !== null);
      const priceLabel = prices.length > 0 ? `R$ ${prices[0].toFixed(2)}` : 'Preço não identificado';
      const creativeType = ad.hasVideo || ad.videoUrls.length > 0 ? '🎥 Vídeo/VSL' : '🖼 Imagem';
      categoryResults.push({
        advertiser: ad.advertiser,
        score,
        priceLabel,
        creativeType,
        daysRunning: ad.daysRunning,
        keyword,
      });
      console.log(`  ⭐ Score: ${score}/100 | ${ad.advertiser}`);

      // 3. Full ad details + screenshots (includes score)
      await sendFunnelReport(ad, steps, keyword, country, score);

      // 4. Separator — always sent last, after everything for this ad is complete
      await sendToTelegram('━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      await sleep(2000 + Math.random() * 1000);
    }

  } catch (e) {
    console.error(`Erro em "${keyword}" ${country}:`, e);
  } finally {
    try { await page?.close(); } catch {}
    try { await context?.close(); } catch {}
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!process.env.TELEGRAM_TOKEN) throw new Error('TELEGRAM_TOKEN is required');
  if (!process.env.TELEGRAM_CHAT_ID) throw new Error('TELEGRAM_CHAT_ID is required');

  const totalKeywords = CATEGORIES.reduce((sum, c) => sum + c.keywords.length, 0);
  await sendToTelegram(
    `🚀 <b>Funil Crawler iniciado!</b>\n📂 ${CATEGORIES.length} categorias | 📋 ${totalKeywords} keywords\n🌍 Brasil 🇧🇷 e Moçambique 🇲🇿\n💰 Faixa: R$${MIN_PRICE} — R$${MAX_PRICE}\n🔍 Profundidade máxima: ${MAX_FUNNEL_DEPTH} | Máx. ${MAX_ADS_PER_KEYWORD} anúncios/keyword`
  );

  for (const country of COUNTRIES) {
    for (const category of CATEGORIES) {
      console.log(`\n📂 Categoria: ${category.name} — ${country}`);
      await sendToTelegram(`\n📂 <b>CATEGORIA: ${category.name.toUpperCase()}</b> | ${country === 'BR' ? 'Brasil 🇧🇷' : 'Moçambique 🇲🇿'}\n${category.keywords.length} keywords`);

      // Accumulate scored ads across all keywords in this category
      const categoryResults: ScoredAd[] = [];

      for (const keyword of category.keywords) {
        console.log(`\n🔍 Keyword: "${keyword}" — ${country}`);

        let success = false;
        let attempts = 0;

        while (!success && attempts < 3) {
          attempts++;
          let browser: Browser | null = null;
          try {
            browser = await launchBrowser();
            await scrapeKeyword(browser, keyword, country, categoryResults);
            success = true;
          } catch (e) {
            console.error(`Tentativa ${attempts} falhou:`, (e as Error).message);
            if (attempts < 3) await sleep(3000);
          } finally {
            try { await browser?.close(); } catch {}
          }
        }

        await sleep(3000 + Math.random() * 2000);
      }

      // After all keywords in category, send top 10 summary
      await sendCategorySummary(category.name, categoryResults, country);
    }
  }

  await sendToTelegram(`✅ <b>Crawling completo!</b>\nTodas as categorias, keywords e funis analisados.`);
}

main().catch(console.error);
