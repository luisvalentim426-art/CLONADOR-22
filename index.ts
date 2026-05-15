import { chromium, BrowserContext, Page } from 'playwright';
import TelegramBot from 'node-telegram-bot-api';
import * as fs from 'fs';
import * as https from 'https';
import * as http from 'http';
import * as dotenv from 'dotenv';

dotenv.config();

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN!, { polling: false });
const CHAT_ID = process.env.TELEGRAM_CHAT_ID!;

const KEYWORD_CATEGORIES: { [key: string]: string[] } = {
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

const COUNTRIES = ['BR', 'MZ'];
const MAX_ADS_PER_KEYWORD = 10;   // max ads to collect per keyword
const MAX_SEND_PER_KEYWORD = 10;  // max to send after ranking

// ─── Types ────────────────────────────────────────────────────────────────────

interface ScoredAd {
  advertiser: string;
  keyword: string;
  country: string;
  score: number;                // 1–10
  price: string;
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
  cleanCopy: string;
  creativePath: string | null;
  creativeIsVideo: boolean;
  funnelStepData: any[];
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function sendToTelegram(message: string) {
  try {
    await bot.sendMessage(CHAT_ID, message, { parse_mode: 'HTML', disable_web_page_preview: true });
  } catch (err) {
    console.error('Telegram send error:', err);
  }
}

async function sendPhoto(filePath: string, caption: string) {
  try {
    if (!fs.existsSync(filePath)) return;
    await bot.sendPhoto(CHAT_ID, filePath, { caption: caption.substring(0, 1024) });
    fs.unlinkSync(filePath);
  } catch (err) {
    console.error('Photo error:', err);
  }
}

async function sendVideo(filePath: string, caption: string) {
  try {
    if (!fs.existsSync(filePath)) return;
    await bot.sendVideo(CHAT_ID, filePath, { caption: caption.substring(0, 1024) });
    fs.unlinkSync(filePath);
  } catch (err) {
    console.error('Video error:', err);
  }
}

function downloadFile(url: string, dest: string): Promise<boolean> {
  return new Promise((resolve) => {
    const file = fs.createWriteStream(dest);
    const protocol = url.startsWith('https') ? https : http;
    const req = protocol.get(url, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        file.close();
        fs.unlink(dest, () => {});
        downloadFile(response.headers.location!, dest).then(resolve);
        return;
      }
      response.pipe(file);
      file.on('finish', () => { file.close(); resolve(true); });
    });
    req.on('error', () => { fs.unlink(dest, () => {}); resolve(false); });
    req.setTimeout(30000, () => { req.destroy(); fs.unlink(dest, () => {}); resolve(false); });
  });
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
      if (price >= 9.99 && price <= 50) return price;
    }
  }
  return null;
}

// ─── Scoring (1–10) ───────────────────────────────────────────────────────────

function calculateScore(data: {
  hasVSL: boolean;
  hasQuiz: boolean;
  hasUpsell: boolean;
  hasDownsell: boolean;
  funnelSteps: number;
  hasCTA: boolean;
  hasCheckout: boolean;
  hasLongCopy: boolean;
}): number {
  let score = 0;
  if (data.hasVSL)                    score += 2;
  if (data.hasQuiz)                   score += 2;
  if (data.hasUpsell || data.hasDownsell) score += 2;
  if (data.funnelSteps > 1)           score += 1;
  if (data.hasCTA)                    score += 1;
  if (data.hasCheckout)               score += 1;
  if (data.hasLongCopy)               score += 1;
  return Math.max(1, Math.min(score, 10));  // floor 1, ceiling 10
}

// ─── Platform Detection ───────────────────────────────────────────────────────

function detectPlatform(url: string, text: string): string {
  const u = url.toLowerCase();
  const t = text.toLowerCase();
  if (u.includes('hotmart.com') || u.includes('hotmart.product') || t.includes('hotmart')) return 'Hotmart';
  if (u.includes('kiwify.com.br') || u.includes('kiwify.app') || t.includes('kiwify'))    return 'Kiwify';
  if (u.includes('eduzz.com') || u.includes('sun.eduzz') || t.includes('eduzz'))           return 'Eduzz';
  if (u.includes('monetizze.com.br') || t.includes('monetizze'))                           return 'Monetizze';
  if (u.includes('pepper.com.br') || t.includes('pepper'))                                 return 'Pepper';
  if (u.includes('braip.com') || t.includes('braip'))                                       return 'Braip';
  if (u.includes('wa.me') || u.includes('whatsapp'))                                       return 'WhatsApp';
  if (u.includes('/checkout') || u.includes('pay.'))                                       return 'Checkout direto';
  return 'Direto';
}

// ─── Page Classifier ──────────────────────────────────────────────────────────

function classifyPage(text: string, hasVideo: boolean, radioInputs: number): string {
  const lower = text.toLowerCase();
  if (hasVideo) return 'VSL';
  if (radioInputs >= 2 || lower.includes('quiz') || lower.includes('próxima pergunta')) return 'QUIZ';
  if (lower.includes('checkout') || lower.includes('finalizar compra') || lower.includes('dados do cartão')) return 'CHECKOUT';
  if (lower.includes('upsell') || lower.includes('leve também') || lower.includes('adicione ao pedido')) return 'UPSELL';
  if (lower.includes('espera') || lower.includes('antes de sair') || lower.includes('última chance')) return 'DOWNSELL';
  if (lower.includes('whatsapp') || lower.includes('wa.me')) return 'WHATSAPP';
  return 'LANDING';
}

// ─── Copy Cleaner ─────────────────────────────────────────────────────────────
// Strips advertiser names, numeric IDs, nav noise — returns natural sales copy

function extractSalesCopy(rawText: string, advertiserName?: string): string {
  const lines = rawText.split('\n').map(l => l.trim()).filter(Boolean);

  const skipPatterns: RegExp[] = [
    /^\d{5,}$/,                                          // pure numeric IDs (5+ digits)
    /^[\d\s\-_|•·]{3,}$/,                               // lines of only numbers/symbols
    /^(ac|al|am|ap|ba|ce|df|es|go|ma|mg|ms|mt|pa|pb|pe|pi|pr|rj|rn|ro|rr|rs|sc|se|sp|to)$/i,
    /^(home|menu|início|sobre|contato|política|privacidade|termos|copyright|©|\d{4})/i,
    /^(carrinho|minha conta|entrar|sair|cadastro|login|buscar|pesquisar|fechar|voltar)$/i,
    /^(aceitar|cookies|ok|sim|não|próximo|anterior)$/i,
    /^(facebook|instagram|youtube|twitter|tiktok|whatsapp|telegram)$/i,
    /^patrocinado$/i,
    /^sponsored$/i,
    /^ver mais$/i,
    /^.{1,12}$/,                                         // too short to be copy
    /^[^a-záàâãéêíóôõúç]*$/,                            // no Portuguese letters at all
    /página de facebook/i,
    /biblioteca de anúncios/i,
    /relatório da biblioteca/i,
  ];

  // Also skip the advertiser name line if provided
  if (advertiserName) {
    const escapedName = advertiserName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    skipPatterns.push(new RegExp(`^${escapedName}$`, 'i'));
  }

  const salesIndicators = [
    /apenas|por apenas|somente|desconto|oferta|promoção|grátis|bônus|exclusiv/i,
    /aprenda|descubra|transforme|conquiste|garanta|acesse|baixe|receba/i,
    /método|técnica|estratégia|passo a passo|guia|manual|curso|treinamento/i,
    /resultado|comprovado|garantido|testado|funciona|eficaz/i,
    /R\$|\d+\s*(reais|dias|horas|semanas|meses|anos)/i,
    /clique|acesse|compre|inscreva|cadastre|garanta|quero|começar/i,
    /você|seu|sua|nosso|nossa|aproveite|não perca|última/i,
  ];

  const seen = new Set<string>();
  const cleaned: string[] = [];

  for (const line of lines) {
    if (seen.has(line)) continue;
    seen.add(line);
    if (skipPatterns.some(p => p.test(line))) continue;

    const hasSalesContent = salesIndicators.some(p => p.test(line));
    if (hasSalesContent || line.length > 40) {
      cleaned.push(line);
    }
  }

  return cleaned.slice(0, 18).join('\n');
}

// ─── Funnel Crawler ───────────────────────────────────────────────────────────

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
      const domain = new URL(realUrl).hostname;

      const screenshotPath = `step_${depth + 1}_${Date.now()}.png`;
      await page.screenshot({ path: screenshotPath, fullPage: true });

      const pageData = await page.evaluate(() => {
        const skip = new Set<Node>();
        ['nav', 'footer', 'aside', 'header', '[aria-hidden="true"]',
         '[class*="cookie"]', '[class*="nav"]', '[class*="footer"]',
         '[class*="menu"]', '[class*="header"]', 'script', 'style', 'noscript',
        ].forEach(sel => {
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
          let node: Node | null;
          while ((node = walker.nextNode())) {
            const t = (node.textContent || '').trim();
            if (t.length > 2) parts.push(t);
          }
          return parts.join('\n');
        }

        const mainEl = document.querySelector('main, article, [role="main"], .main, #main, section') || document.body;
        const rawText = getVisibleText(mainEl as Element);

        const hasVideo = !!(
          document.querySelector('video') ||
          document.querySelector('iframe[src*="youtube"]') ||
          document.querySelector('iframe[src*="vimeo"]') ||
          document.querySelector('iframe[src*="wistia"]') ||
          document.querySelector('iframe[src*="panda"]')
        );

        const videoSrc =
          (document.querySelector('video source') as HTMLSourceElement)?.src ||
          (document.querySelector('video') as HTMLVideoElement)?.src ||
          (document.querySelector('iframe[src*="youtube"]') as HTMLIFrameElement)?.src ||
          (document.querySelector('iframe[src*="vimeo"]') as HTMLIFrameElement)?.src ||
          (document.querySelector('iframe[src*="wistia"]') as HTMLIFrameElement)?.src ||
          (document.querySelector('iframe[src*="panda"]') as HTMLIFrameElement)?.src || null;

        const radioInputs = document.querySelectorAll('input[type="radio"]').length;
        const fullText = document.body.innerText || '';
        const lower = fullText.toLowerCase();

        const hasUpsell   = lower.includes('leve também') || lower.includes('adicione ao pedido') || lower.includes('aproveite também') || lower.includes('oferta especial');
        const hasDownsell = (lower.includes('espera') && (lower.includes('sair') || lower.includes('chance'))) || lower.includes('última chance');
        const hasCheckout = lower.includes('checkout') || lower.includes('finalizar compra') || lower.includes('dados do cartão') || lower.includes('cartão de crédito');
        const isQuiz      = radioInputs >= 2 || lower.includes('quiz') || lower.includes('próxima pergunta');
        const hasLongCopy = rawText.length > 500;

        const ctaKeywords = ['saiba mais', 'comprar', 'baixe', 'quero', 'acessar', 'garantir', 'clique', 'próximo', 'continuar', 'começar', 'inscrever'];
        const ctaLinks = Array.from(document.querySelectorAll('a, button'))
          .filter((el: any) => { const t = (el.innerText || '').toLowerCase(); return ctaKeywords.some(k => t.includes(k)); })
          .map((el: any) => el.href || null)
          .filter((h: string | null): h is string => !!h && !h.includes('javascript:'));

        const waLinks = Array.from(document.querySelectorAll('a'))
          .map((a: any) => a.href as string)
          .filter((h: string) => h && (h.includes('wa.me') || h.includes('whatsapp.com/send')));

        const subdomains = [...new Set(
          Array.from(document.querySelectorAll('a'))
            .map((a: any) => { try { return new URL(a.href).hostname; } catch { return ''; } })
            .filter(Boolean)
        )];

        return { title: document.title, rawText: rawText.substring(0, 3000), hasVideo, videoSrc, radioInputs, hasUpsell, hasDownsell, hasCheckout, isQuiz, hasLongCopy, ctaLinks: ctaLinks.slice(0, 3), waLinks: waLinks.slice(0, 2), subdomains: subdomains.slice(0, 5) };
      });

      const pageType  = classifyPage(pageData.rawText, pageData.hasVideo, pageData.radioInputs);
      const cleanCopy = extractSalesCopy(pageData.rawText);
      const platform  = detectPlatform(realUrl, pageData.rawText);

      steps.push({ url: realUrl, domain, type: pageType, title: pageData.title, screenshotPath, videoSrc: pageData.videoSrc, hasVideo: pageData.hasVideo, hasUpsell: pageData.hasUpsell, hasDownsell: pageData.hasDownsell, hasCheckout: pageData.hasCheckout, isQuiz: pageData.isQuiz, hasLongCopy: pageData.hasLongCopy, copy: cleanCopy, subdomains: pageData.subdomains, platform });

      let nextUrl: string | null = null;
      if (pageData.waLinks.length > 0)  nextUrl = pageData.waLinks[0];
      else if (pageData.ctaLinks.length > 0) nextUrl = pageData.ctaLinks[0];

      if (nextUrl && !visited.has(nextUrl) && !nextUrl.includes('facebook.com')) currentUrl = nextUrl;
      else break;

      depth++;
    } catch { break; }
    finally { await page.close(); }
  }
  return steps;
}

// ─── Collect + Score a single ad (no Telegram yet) ───────────────────────────

async function collectAd(context: BrowserContext, rawCard: any, keyword: string, country: string): Promise<ScoredAd | null> {
  try {
    if (!rawCard) return null;
    if (rawCard.text.includes('Biblioteca de Anúncios da Meta') || rawCard.text.length < 30) return null;

    const price     = extractPrice(rawCard.text);
    const priceLabel = price ? `R$ ${price.toFixed(2)} ✅` : '💡 Não identificado';

    // Download ad creative
    let creativePath: string | null = null;
    let creativeIsVideo = false;
    if (rawCard.videos.length > 0) {
      const p = `creative_${Date.now()}.mp4`;
      if (await downloadFile(rawCard.videos[0], p)) { creativePath = p; creativeIsVideo = true; }
    } else if (rawCard.images.length > 0) {
      const p = `creative_${Date.now()}.jpg`;
      if (await downloadFile(rawCard.images[0], p)) creativePath = p;
    }

    const funnelUrl: string | null = (rawCard.ctaLinks && rawCard.ctaLinks[0]) || rawCard.links[0] || null;

    let funnelStepData: any[] = [];
    if (funnelUrl && !funnelUrl.includes('facebook.com')) {
      funnelStepData = await crawlFunnel(context, funnelUrl);
    }

    const hasVSL      = funnelStepData.some(s => s.type === 'VSL') || rawCard.hasVideo;
    const hasQuiz     = funnelStepData.some(s => s.isQuiz);
    const hasUpsell   = funnelStepData.some(s => s.hasUpsell);
    const hasDownsell = funnelStepData.some(s => s.hasDownsell);
    const hasCheckout = funnelStepData.some(s => s.hasCheckout);
    const hasLongCopy = funnelStepData.some(s => s.hasLongCopy) || rawCard.text.length > 300;
    const hasCTA      = (rawCard.ctaLinks?.length > 0) || funnelStepData.length > 0;

    const score     = calculateScore({ hasVSL, hasQuiz, hasUpsell, hasDownsell, funnelSteps: funnelStepData.length, hasCTA, hasCheckout, hasLongCopy });
    const domains   = [...new Set(funnelStepData.map((s: any) => s.domain))] as string[];
    const platform  = funnelStepData.length > 0 ? (funnelStepData[0].platform || 'Direto') : detectPlatform(funnelUrl || '', rawCard.text);
    const funnelType = funnelStepData.length > 0 ? funnelStepData.map((s: any) => s.type).join(' → ') : 'Direto';

    // Clean copy — strip advertiser ID/name from card text
    const cleanCopy = extractSalesCopy(rawCard.text, rawCard.advertiser);

    return {
      advertiser: rawCard.advertiser,
      keyword,
      country,
      score,
      price: priceLabel,
      creativeType: rawCard.hasVideo ? '🎥 Vídeo' : '🖼 Imagem',
      dateText: rawCard.dateText,
      hasVSL,
      hasQuiz,
      hasUpsell,
      hasDownsell,
      hasCheckout,
      hasLongCopy,
      funnelSteps: funnelStepData.length,
      funnelType,
      domains,
      platform,
      funnelUrl: funnelUrl || 'N/A',
      cleanCopy,
      creativePath,
      creativeIsVideo,
      funnelStepData,
    };
  } catch (err) {
    console.error('collectAd error:', err);
    return null;
  }
}

// ─── Send a single scored ad to Telegram ──────────────────────────────────────

async function sendAdReport(ad: ScoredAd, rank: number, isBestToClone: boolean) {
  const countryName = ad.country === 'BR' ? 'Brasil 🇧🇷' : 'Moçambique 🇲🇿';
  const cloneTag    = isBestToClone ? '\n\n🏆 <b>MELHOR OPÇÃO PARA CLONAR</b>' : '';

  // 1. Creative (image or video)
  if (ad.creativePath) {
    const creativeCaption = `${isBestToClone ? '🏆 ' : ''}#${rank} | ${ad.advertiser} | ${ad.keyword}`;
    if (ad.creativeIsVideo) await sendVideo(ad.creativePath, creativeCaption);
    else                    await sendPhoto(ad.creativePath, creativeCaption);
  }

  // 2. Main report card
  await sendToTelegram(`\
🎯 <b>#${rank} | ${ad.keyword} | ${countryName}</b>${cloneTag}

⭐ <b>Score: ${ad.score}/10</b>
🏢 <b>Anunciante:</b> ${ad.advertiser}
💰 <b>Preço:</b> ${ad.price}
🎨 <b>Criativo:</b> ${ad.creativeType}
🏪 <b>Plataforma:</b> ${ad.platform}
📅 <b>Data início:</b> ${ad.dateText || 'Desconhecida'}

📊 <b>Funil (${ad.funnelSteps} etapas):</b> ${ad.funnelType}
🎬 VSL: ${ad.hasVSL ? '✅' : '❌'} | 🧩 Quiz: ${ad.hasQuiz ? '✅' : '❌'}
⬆️ Upsell: ${ad.hasUpsell ? '✅' : '❌'} | ⬇️ Downsell: ${ad.hasDownsell ? '✅' : '❌'}
🛒 Checkout: ${ad.hasCheckout ? '✅' : '❌'} | 📝 Copy longa: ${ad.hasLongCopy ? '✅' : '❌'}
🌐 <b>Domínios:</b> ${ad.domains.length > 0 ? ad.domains.join(', ') : 'N/A'}
🔗 <b>Funil:</b> ${ad.funnelUrl}`);

  // 3. Ad copy (clean)
  if (ad.cleanCopy.length > 20) {
    await sendToTelegram(`📝 <b>COPY DO ANÚNCIO:</b>\n${ad.cleanCopy.substring(0, 600)}`);
  }

  // 4. Funnel step screenshots + VSL video + page copy
  for (let i = 0; i < ad.funnelStepData.length; i++) {
    const step = ad.funnelStepData[i];

    if (step.type === 'VSL' && step.videoSrc && step.videoSrc.startsWith('http')) {
      const vslPath = `vsl_${Date.now()}.mp4`;
      const ok = await downloadFile(step.videoSrc, vslPath);
      if (ok && fs.existsSync(vslPath)) {
        await sendVideo(vslPath, `🎬 VSL — Etapa ${i + 1} | ${step.domain}`);
      } else {
        if (step.screenshotPath) await sendPhoto(step.screenshotPath, `📸 VSL — Etapa ${i + 1} | ${step.domain}`);
      }
    } else {
      if (step.screenshotPath) await sendPhoto(step.screenshotPath, `📸 Etapa ${i + 1} — ${step.type} | ${step.domain}`);
    }

    // Send page copy for first step only
    if (i === 0 && step.copy && step.copy.length > 30) {
      await sendToTelegram(`📝 <b>COPY DA PÁGINA (${step.type}):</b>\n${step.copy.substring(0, 600)}`);
    }
  }

  await sendToTelegram('━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  await delay(1500);
}

// ─── Scrape one keyword: collect all → rank → send top N ─────────────────────

async function scrapeKeyword(keyword: string, country: string, context: BrowserContext, page: Page) {
  const countryName = country === 'BR' ? 'Brasil 🇧🇷' : 'Moçambique 🇲🇿';
  const searchUrl = `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=${country}&q=${encodeURIComponent(keyword)}&search_type=keyword_unordered`;

  try {
    await sendToTelegram(`🔎 <b>PESQUISANDO:</b> ${keyword} — ${countryName}`);
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await delay(4000);
    await page.evaluate(() => window.scrollBy(0, 800));
    await delay(3000);

    // Screenshot of the results page
    const libScreenshot = `lib_${Date.now()}.png`;
    await page.screenshot({ path: libScreenshot });
    await sendPhoto(libScreenshot, `🔍 ${keyword} — ${countryName}`);

    // Locate ad cards via "Patrocinado" label
    const sponsoredLocator = page.getByText('Patrocinado', { exact: true });
    let count = 0;
    try {
      await sponsoredLocator.first().waitFor({ timeout: 12000 });
      count = Math.min(await sponsoredLocator.count(), MAX_ADS_PER_KEYWORD);
    } catch {
      const engLocator = page.getByText('Sponsored', { exact: true });
      try {
        await engLocator.first().waitFor({ timeout: 5000 });
        count = Math.min(await engLocator.count(), MAX_ADS_PER_KEYWORD);
      } catch { /* no ads */ }
    }

    if (count === 0) {
      await sendToTelegram(`⚠️ Nenhum anúncio para <b>${keyword}</b> em ${countryName}`);
      return;
    }

    await sendToTelegram(`⏳ <b>${count} anúncios encontrados.</b> Analisando e rankeando...`);

    // ── Step 1: extract raw card data from the page ──────────────────────────
    const rawCards: any[] = [];
    for (let i = 0; i < count; i++) {
      try {
        const sponsoredEl = sponsoredLocator.nth(i);
        const cardLocator = sponsoredEl.locator('xpath=ancestor::div[.//a[@role="link"]][1]');

        const raw = await cardLocator.evaluate((cardEl: HTMLElement) => {
          function extractRealUrl(href: string): string | null {
            if (!href) return null;
            if (href.includes('l.facebook.com/l.php') || href.includes('lm.facebook.com')) {
              try {
                const u = new URL(href).searchParams.get('u');
                if (u) return decodeURIComponent(u);
              } catch {}
              return null;
            }
            if (href.startsWith('http') && !href.includes('facebook.com') && !href.includes('fb.com') && !href.includes('fb.me') && !href.includes('instagram.com')) return href;
            return null;
          }

          const advertiserEl = cardEl.querySelector('a[role="link"]') as HTMLElement | null;
          const advertiser = advertiserEl?.innerText?.trim() || 'Desconhecido';

          // Get text EXCLUDING the advertiser name element to avoid ID bleed
          let text = '';
          cardEl.childNodes.forEach(node => {
            if (node !== advertiserEl && !(node as HTMLElement).contains?.(advertiserEl)) {
              text += (node as HTMLElement).innerText || (node.textContent || '');
            }
          });
          // Fallback: use all innerText but strip the advertiser name from start
          if (!text.trim()) {
            text = cardEl.innerText || '';
            if (advertiser && text.startsWith(advertiser)) text = text.slice(advertiser.length);
          }

          const images = Array.from(cardEl.querySelectorAll('img'))
            .map((img: any) => img.src as string)
            .filter((src: string) => src && src.startsWith('https://') && src.includes('fbcdn') && !src.includes('emoji'));

          const videos = Array.from(cardEl.querySelectorAll('video'))
            .map((v: any) => v.src as string)
            .filter(Boolean);

          const ctaKeywords = ['saiba mais', 'comprar', 'baixe', 'quero', 'acessar', 'garantir', 'clique', 'continuar', 'começar', 'ver mais', 'obter', 'inscrever', 'assinar'];
          const ctaLinks = Array.from(cardEl.querySelectorAll('a'))
            .filter((a: any) => { const t = (a.innerText || '').toLowerCase(); return ctaKeywords.some(k => t.includes(k)); })
            .map((a: any) => extractRealUrl(a.href))
            .filter((h: string | null): h is string => h !== null);

          const allLinks = Array.from(cardEl.querySelectorAll('a'))
            .map((a: any) => extractRealUrl(a.href))
            .filter((h: string | null): h is string => h !== null);

          const waLinks = Array.from(cardEl.querySelectorAll('a'))
            .map((a: any) => a.href as string)
            .filter((h: string) => h && (h.includes('wa.me') || h.includes('whatsapp.com/send')));

          const dateMatch = text.match(/(\d+)\s*de\s*(jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)/i);

          return {
            text: text.substring(0, 1000),
            images: images.slice(0, 2),
            videos: videos.slice(0, 1),
            hasVideo: videos.length > 0,
            advertiser,
            dateText: dateMatch ? dateMatch[0] : null,
            ctaLinks: ctaLinks.slice(0, 3),
            links: allLinks.slice(0, 3),
            waLinks: waLinks.slice(0, 2),
          };
        });

        rawCards.push(raw);
      } catch (err) {
        console.error(`Erro ao ler card ${i}:`, err);
      }
    }

    // ── Step 2: crawl each funnel + score ────────────────────────────────────
    const scored: ScoredAd[] = [];
    for (const raw of rawCards) {
      const result = await collectAd(context, raw, keyword, country);
      if (result) scored.push(result);
      await delay(1500);
    }

    if (scored.length === 0) {
      await sendToTelegram(`⚠️ Nenhum anúncio válido para <b>${keyword}</b>`);
      return;
    }

    // ── Step 3: rank by score descending, take top N ─────────────────────────
    scored.sort((a, b) => b.score - a.score);
    const topAds = scored.slice(0, MAX_SEND_PER_KEYWORD);

    await sendToTelegram(`📊 <b>RANKING — ${keyword} | ${countryName}</b>\n${topAds.map((a, i) => `${i + 1}. ${a.advertiser} — Score: ${a.score}/10`).join('\n')}\n\n🏆 Melhor para clonar: <b>${topAds[0].advertiser}</b>`);

    // ── Step 4: send each ad report ──────────────────────────────────────────
    for (let i = 0; i < topAds.length; i++) {
      await sendAdReport(topAds[i], i + 1, i === 0);
    }

    await sendToTelegram(`✅ <b>CONCLUÍDO:</b> ${keyword} — ${topAds.length} ads enviados (${scored.length} analisados)`);

  } catch (err) {
    console.error(`Erro keyword "${keyword}":`, err);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
  });

  await sendToTelegram(`🚀 <b>Agente v3 iniciado!</b>\n🌍 Brasil 🇧🇷 + Moçambique 🇲🇿\n💡 Lógica: coleta todos os ads → ranqueia → envia Top ${MAX_SEND_PER_KEYWORD} por keyword`);

  for (const country of COUNTRIES) {
    for (const [category, keywords] of Object.entries(KEYWORD_CATEGORIES)) {
      await sendToTelegram(`\n📂 <b>CATEGORIA: ${category}</b> | ${country === 'BR' ? 'Brasil 🇧🇷' : 'Moçambique 🇲🇿'}`);

      const context = await browser.newContext({
        locale: country === 'BR' ? 'pt-BR' : 'pt-MZ',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        viewport: { width: 1920, height: 1080 },
      });
      const page = await context.newPage();

      for (const keyword of keywords) {
        await scrapeKeyword(keyword, country, context, page);
        await delay(4000);
      }

      await context.close();
    }
  }

  await browser.close();
  await sendToTelegram(`✅ <b>Pesquisa completa!</b> Todas as categorias analisadas.`);
}

main().catch(console.error);
