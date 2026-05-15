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
  'PDF': ['PDF por apenas 9,99', 'PDF por apenas 10', 'PDF por apenas 17', 'PDF por apenas 27', 'PDF por apenas 37', 'PDF por apenas 47'],
  'Receitas': ['Receitas por apenas 9,99', 'Receitas por apenas 10', 'Receitas por apenas 17', 'Receitas por apenas 27', 'Receitas por apenas 37'],
  'Planner': ['Planner por apenas 9,99', 'Planner por apenas 10', 'Planner por apenas 17', 'Planner por apenas 27', 'Planner por apenas 37'],
  'Apostila': ['Apostila por apenas 9,99', 'Apostila por apenas 10', 'Apostila por apenas 17', 'Apostila por apenas 27'],
  'Moldes': ['Moldes por apenas 10', 'Moldes por apenas 17', 'Moldes por apenas 27'],
  'Kit': ['Kit completo por apenas 10', 'Kit completo por apenas 17', 'Kit completo por apenas 27', 'Kit completo por apenas 37'],
  'Aulas': ['Aulas prontas por apenas 17', 'Aulas prontas por apenas 27', 'Aulas prontas por apenas 37'],
  'Material': ['Material pronto por apenas 17', 'Material pronto por apenas 27'],
  'Pacote': ['Pacote por apenas 9,99', 'Pacote por apenas 10', 'Pacote por apenas 17', 'Pacote por apenas 27'],
  'Dinamicas': ['Dinâmicas por apenas 17', 'Dinâmicas por apenas 27'],
  'Baixe': ['Baixe agora por apenas 9,99', 'Baixe agora por apenas 10', 'Baixe agora por apenas 17']
};

const COUNTRIES = ['BR', 'MZ'];
const MAX_ADS_PER_KEYWORD = 10;
const MIN_QUALITY_SCORE = 7;

interface AdScore {
  advertiser: string;
  keyword: string;
  score: number;
  price: string;
  creativeType: string;
  daysRunning: number;
  hasUpsell: boolean;
  hasDownsell: boolean;
  hasVSL: boolean;
  hasQuiz: boolean;
  funnelUrl: string;
}

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function sendToTelegram(message: string) {
  try {
    await bot.sendMessage(CHAT_ID, message, { parse_mode: 'HTML', disable_web_page_preview: true });
  } catch (err) {
    console.error('Telegram error:', err);
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

// 0-10 quality score
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
  if (data.hasVSL) score += 2;
  if (data.hasQuiz) score += 2;
  if (data.hasUpsell || data.hasDownsell) score += 2;
  if (data.funnelSteps > 1) score += 1;
  if (data.hasCTA) score += 1;
  if (data.hasCheckout) score += 1;
  if (data.hasLongCopy) score += 1;
  return Math.min(score, 10);
}

function detectPlatform(url: string, text: string): string {
  if (url.includes('hotmart.com') || url.includes('hotmart.product')) return 'Hotmart';
  if (url.includes('kiwify.com.br') || url.includes('kiwify.app')) return 'Kiwify';
  if (url.includes('eduzz.com') || url.includes('sun.eduzz.com')) return 'Eduzz';
  if (url.includes('monetizze.com.br')) return 'Monetizze';
  if (url.includes('pepper.com.br')) return 'Pepper';
  if (url.includes('braip.com')) return 'Braip';
  if (url.includes('pay.') || url.includes('/checkout')) return 'Checkout';
  if (url.includes('wa.me') || url.includes('whatsapp')) return 'WhatsApp';
  if (text.toLowerCase().includes('hotmart')) return 'Hotmart';
  if (text.toLowerCase().includes('kiwify')) return 'Kiwify';
  return 'Direto';
}

function classifyPage(text: string, hasVideo: boolean, radioInputs: number): string {
  const lower = text.toLowerCase();
  if (hasVideo && (lower.includes('assista') || lower.includes('vídeo') || lower.includes('video') || lower.includes('assista até o fim'))) return 'VSL';
  if (hasVideo) return 'VSL';
  if (radioInputs >= 2 || lower.includes('quiz') || lower.includes('próxima pergunta')) return 'QUIZ';
  if (lower.includes('checkout') || lower.includes('finalizar compra') || lower.includes('dados do cartão')) return 'CHECKOUT';
  if (lower.includes('upsell') || lower.includes('leve também') || lower.includes('adicione ao pedido')) return 'UPSELL';
  if (lower.includes('espera') || lower.includes('antes de sair') || lower.includes('última chance')) return 'DOWNSELL';
  if (lower.includes('whatsapp') || lower.includes('wa.me')) return 'WHATSAPP';
  return 'LANDING';
}

// Extract clean sales copy, ignoring nav/footer/UI noise
function extractSalesCopy(rawText: string): string {
  const lines = rawText.split('\n').map(l => l.trim()).filter(Boolean);

  const ignorePatterns = [
    /^(ac|al|am|ap|ba|ce|df|es|go|ma|mg|ms|mt|pa|pb|pe|pi|pr|rj|rn|ro|rr|rs|sc|se|sp|to)$/i,
    /^[a-záàâãéêíóôõúç]{2,20}(,\s*[a-záàâãéêíóôõúç]{2,20}){2,}$/i,
    /^(home|menu|início|sobre|contato|política|privacidade|termos|copyright|todos os direitos|©|\d{4})/i,
    /^(carrinho|minha conta|entrar|sair|cadastro|login|buscar|pesquisar)$/i,
    /^(aceitar cookies|cookies|fechar|ok|sim|não|voltar|próximo|anterior)$/i,
    /^(facebook|instagram|youtube|twitter|tiktok|whatsapp)$/i,
    /^.{1,15}$/, // very short fragments
    /^(\d+)$/, // pure numbers
    /^[^a-záàâãéêíóôõúç]*$/, // no actual words
  ];

  const salesIndicators = [
    /apenas|por apenas|somente|desconto|oferta|promoção|grátis|bônus/i,
    /aprenda|descubra|transforme|conquiste|garanta|acesse|baixe/i,
    /método|técnica|estratégia|passo a passo|guia|manual|curso/i,
    /resultado|comprovado|garantido|testado|funciona/i,
    /R\$|\d+\s*(reais|dias|horas|semanas|meses)/i,
    /clique|acesse|compre|inscreva|cadastre|garanta/i,
  ];

  const cleaned: string[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    if (seen.has(line)) continue;
    seen.add(line);

    if (ignorePatterns.some(p => p.test(line))) continue;

    // Prioritize lines with sales indicators
    const hasSalesContent = salesIndicators.some(p => p.test(line));
    if (hasSalesContent || line.length > 40) {
      cleaned.push(line);
    }
  }

  return cleaned.slice(0, 20).join('\n');
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

      // Wait for content to settle
      try { await page.waitForLoadState('networkidle', { timeout: 8000 }); } catch {}
      await delay(2500);

      const realUrl = page.url();
      const domain = new URL(realUrl).hostname;

      // High-quality full-page screenshot
      const screenshotPath = `step_${depth + 1}_${Date.now()}.png`;
      await page.screenshot({ path: screenshotPath, fullPage: true });

      const pageData = await page.evaluate(() => {
        // Clean copy: skip nav, footer, aside, hidden elements
        const skip = new Set<Node>();
        ['nav', 'footer', 'aside', 'header', '[aria-hidden="true"]', '.cookie', '#cookie',
         '[class*="cookie"]', '[class*="nav"]', '[class*="footer"]', '[class*="menu"]',
         '[class*="header"]', 'script', 'style', 'noscript'].forEach(sel => {
          try { document.querySelectorAll(sel).forEach(el => skip.add(el)); } catch {}
        });

        function getVisibleText(root: Element): string {
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
              let el = node.parentElement;
              while (el) {
                if (skip.has(el)) return NodeFilter.FILTER_REJECT;
                const style = window.getComputedStyle(el);
                if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return NodeFilter.FILTER_REJECT;
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

        // Try to get actual video source
        const videoSrc = (document.querySelector('video source') as HTMLSourceElement)?.src ||
          (document.querySelector('video') as HTMLVideoElement)?.src ||
          (document.querySelector('iframe[src*="youtube"]') as HTMLIFrameElement)?.src ||
          (document.querySelector('iframe[src*="vimeo"]') as HTMLIFrameElement)?.src ||
          (document.querySelector('iframe[src*="wistia"]') as HTMLIFrameElement)?.src ||
          (document.querySelector('iframe[src*="panda"]') as HTMLIFrameElement)?.src || null;

        const radioInputs = document.querySelectorAll('input[type="radio"]').length;
        const fullText = document.body.innerText || '';
        const lower = fullText.toLowerCase();

        const hasUpsell = lower.includes('leve também') || lower.includes('adicione ao pedido') || lower.includes('aproveite também') || lower.includes('oferta especial');
        const hasDownsell = lower.includes('espera') && (lower.includes('sair') || lower.includes('chance')) || lower.includes('última chance');
        const hasCheckout = lower.includes('checkout') || lower.includes('finalizar compra') || lower.includes('dados do cartão') || lower.includes('cartão de crédito');
        const isQuiz = radioInputs >= 2 || lower.includes('quiz') || lower.includes('próxima pergunta');
        const hasLongCopy = rawText.length > 500;

        const ctaKeywords = ['saiba mais', 'comprar', 'baixe', 'quero', 'acessar', 'garantir', 'clique', 'próximo', 'continuar', 'sim', 'começar', 'inscrever'];
        const ctaLinks = Array.from(document.querySelectorAll('a, button'))
          .filter((el: any) => {
            const t = (el.innerText || '').toLowerCase();
            return ctaKeywords.some(k => t.includes(k));
          })
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

        return {
          title: document.title,
          rawText: rawText.substring(0, 3000),
          hasVideo,
          videoSrc,
          radioInputs,
          hasUpsell,
          hasDownsell,
          hasCheckout,
          isQuiz,
          hasLongCopy,
          ctaLinks: ctaLinks.slice(0, 3),
          waLinks: waLinks.slice(0, 2),
          subdomains: subdomains.slice(0, 5)
        };
      });

      const pageType = classifyPage(pageData.rawText, pageData.hasVideo, pageData.radioInputs);
      const cleanCopy = extractSalesCopy(pageData.rawText);
      const platform = detectPlatform(realUrl, pageData.rawText);

      steps.push({
        url: realUrl,
        domain,
        type: pageType,
        title: pageData.title,
        screenshotPath,
        videoSrc: pageData.videoSrc,
        hasVideo: pageData.hasVideo,
        hasUpsell: pageData.hasUpsell,
        hasDownsell: pageData.hasDownsell,
        hasCheckout: pageData.hasCheckout,
        isQuiz: pageData.isQuiz,
        hasLongCopy: pageData.hasLongCopy,
        copy: cleanCopy,
        subdomains: pageData.subdomains,
        platform,
      });

      let nextUrl: string | null = null;
      if (pageData.waLinks.length > 0) nextUrl = pageData.waLinks[0];
      else if (pageData.ctaLinks.length > 0) nextUrl = pageData.ctaLinks[0];

      if (nextUrl && !visited.has(nextUrl) && !nextUrl.includes('facebook.com')) {
        currentUrl = nextUrl;
      } else break;

      depth++;
    } catch (err) {
      break;
    } finally {
      await page.close();
    }
  }
  return steps;
}

async function processAd(context: BrowserContext, adData: any, index: number, keyword: string, country: string, categoryScores: AdScore[]) {
  const countryName = country === 'BR' ? 'Brasil 🇧🇷' : 'Moçambique 🇲🇿';

  try {
    if (!adData) return;

    const price = extractPrice(adData.text);
    const priceLabel = price ? `R$ ${price.toFixed(2)} ✅` : '💡 Não identificado';

    // Download ad creative
    let creativePath: string | null = null;
    if (adData.videos.length > 0) {
      const p = `creative_${Date.now()}.mp4`;
      if (await downloadFile(adData.videos[0], p)) creativePath = p;
    } else if (adData.images.length > 0) {
      const p = `creative_${Date.now()}.jpg`;
      if (await downloadFile(adData.images[0], p)) creativePath = p;
    }

    // Get funnel URL from pre-extracted links
    const funnelUrl: string | null = (adData.ctaLinks && adData.ctaLinks[0]) || adData.links[0] || null;

    // Crawl funnel
    let funnelSteps: any[] = [];
    if (funnelUrl && !funnelUrl.includes('facebook.com')) {
      funnelSteps = await crawlFunnel(context, funnelUrl);
    }

    // Compute quality signals
    const hasVSL = funnelSteps.some(s => s.type === 'VSL') || adData.hasVideo;
    const hasQuiz = funnelSteps.some(s => s.isQuiz);
    const hasUpsell = funnelSteps.some(s => s.hasUpsell);
    const hasDownsell = funnelSteps.some(s => s.hasDownsell);
    const hasCheckout = funnelSteps.some(s => s.hasCheckout);
    const hasLongCopy = funnelSteps.some(s => s.hasLongCopy) || (adData.text.length > 300);
    const hasCTA = (adData.ctaLinks?.length > 0) || funnelSteps.length > 0;
    const isMultiDomain = funnelSteps.length > 0 && new Set(funnelSteps.map(s => s.domain)).size > 1;

    // 0-10 quality score
    const score = calculateScore({ hasVSL, hasQuiz, hasUpsell, hasDownsell, funnelSteps: funnelSteps.length, hasCTA, hasCheckout, hasLongCopy });

    const daysRunning = adData.dateText ? 30 : 0;
    categoryScores.push({ advertiser: adData.advertiser, keyword, score, price: priceLabel, creativeType: adData.hasVideo ? '🎥 Vídeo' : '🖼 Imagem', daysRunning, hasUpsell, hasDownsell, hasVSL, hasQuiz, funnelUrl: funnelUrl || 'N/A' });

    // FILTER: only send high-quality ads to Telegram
    if (score < MIN_QUALITY_SCORE) {
      console.log(`[SKIP] Score ${score}/10 < ${MIN_QUALITY_SCORE} — ${adData.advertiser}`);
      return;
    }

    // Detect platform and domains
    const domains = [...new Set(funnelSteps.map(s => s.domain))];
    const platform = funnelSteps.length > 0 ? (funnelSteps[0].platform || 'Direto') : 'N/A';
    const funnelType = funnelSteps.length > 0 ? funnelSteps.map(s => s.type).join(' → ') : 'Direto';

    // Send header
    await sendToTelegram(`🎯 <b>OFERTA ${index + 1} | ${keyword} | ${countryName}</b>`);

    // Send ad creative
    if (creativePath) {
      if (adData.hasVideo) await sendVideo(creativePath, `🎥 ${adData.advertiser}`);
      else await sendPhoto(creativePath, `🖼 ${adData.advertiser}`);
    }

    // Build clean ad copy (no nav noise)
    const cleanAdCopy = extractSalesCopy(adData.text);

    // Full funnel intelligence report
    await sendToTelegram(`
⭐ <b>SCORE: ${score}/10</b>
🏢 <b>Anunciante:</b> ${adData.advertiser}
💰 <b>Preço:</b> ${priceLabel}
🎨 <b>Criativo:</b> ${adData.hasVideo ? '🎥 Vídeo/VSL' : '🖼 Imagem'}
🏪 <b>Plataforma:</b> ${platform}
📅 <b>Data início:</b> ${adData.dateText || 'Desconhecida'}

📊 <b>FUNIL (${funnelSteps.length} etapas):</b> ${funnelType}
🎬 VSL: ${hasVSL ? '✅' : '❌'} | 🧩 Quiz: ${hasQuiz ? '✅' : '❌'}
⬆️ Upsell: ${hasUpsell ? '✅' : '❌'} | ⬇️ Downsell: ${hasDownsell ? '✅' : '❌'}
🛒 Checkout: ${hasCheckout ? '✅' : '❌'} | 📝 Copy longa: ${hasLongCopy ? '✅' : '❌'}
🌐 Domínios: ${domains.length > 0 ? domains.join(', ') : 'N/A'}

📝 <b>COPY DO ANÚNCIO:</b>
${cleanAdCopy.substring(0, 400)}

🔗 <b>Funil:</b> ${funnelUrl || 'N/A'}`);

    // Send funnel screenshots + VSL video + clean copy for each step
    for (let i = 0; i < funnelSteps.length; i++) {
      const step = funnelSteps[i];

      // If VSL — try to download and send the actual video file
      if (step.type === 'VSL' && step.videoSrc && step.videoSrc.startsWith('http')) {
        const ext = step.videoSrc.includes('.mp4') ? 'mp4' : 'mp4';
        const vslPath = `vsl_${Date.now()}.${ext}`;
        const downloaded = await downloadFile(step.videoSrc, vslPath);
        if (downloaded && fs.existsSync(vslPath)) {
          await sendVideo(vslPath, `🎬 VSL — Etapa ${i + 1} | ${step.domain}`);
        } else {
          // Fallback to screenshot
          if (step.screenshotPath) await sendPhoto(step.screenshotPath, `📸 VSL — Etapa ${i + 1} | ${step.domain}`);
        }
      } else {
        if (step.screenshotPath) await sendPhoto(step.screenshotPath, `📸 Etapa ${i + 1} — ${step.type} | ${step.domain}`);
      }

      // Send clean page copy (first step only to avoid spam)
      if (step.copy && step.copy.length > 30 && i === 0) {
        await sendToTelegram(`📝 <b>COPY DA PÁGINA (${step.type}):</b>\n${step.copy.substring(0, 600)}`);
      }
    }

    await sendToTelegram('━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    await delay(2000);

  } catch (err) {
    console.error(`Erro anúncio ${index}:`, err);
  }
}

async function scrapeKeyword(keyword: string, country: string, context: BrowserContext, page: Page, categoryScores: AdScore[]) {
  const countryName = country === 'BR' ? 'Brasil 🇧🇷' : 'Moçambique 🇲🇿';
  const searchUrl = `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=${country}&q=${encodeURIComponent(keyword)}&search_type=keyword_unordered`;

  try {
    await sendToTelegram(`🔎 <b>PESQUISANDO:</b> ${keyword} — ${countryName}`);
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await delay(4000);
    await page.evaluate(() => window.scrollBy(0, 800));
    await delay(3000);

    const libScreenshot = `lib_${Date.now()}.png`;
    await page.screenshot({ path: libScreenshot });
    await sendPhoto(libScreenshot, `🔍 ${keyword} — ${countryName}`);

    // Use Playwright's exact text locator to find "Patrocinado" labels inside actual ad cards
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

    await sendToTelegram(`✅ <b>${count} anúncios encontrados</b> (filtrando score ≥ ${MIN_QUALITY_SCORE}/10)`);

    for (let i = 0; i < count; i++) {
      try {
        const sponsoredEl = sponsoredLocator.nth(i);

        // XPath: closest ancestor div with an a[role="link"] inside = the ad card
        const cardLocator = sponsoredEl.locator('xpath=ancestor::div[.//a[@role="link"]][1]');

        const adData = await cardLocator.evaluate((cardEl: HTMLElement) => {
          function extractRealUrl(href: string): string | null {
            if (!href) return null;
            if (href.includes('l.facebook.com/l.php') || href.includes('lm.facebook.com')) {
              try {
                const u = new URL(href).searchParams.get('u');
                if (u) return decodeURIComponent(u);
              } catch {}
              return null;
            }
            if (
              href.startsWith('http') &&
              !href.includes('facebook.com') &&
              !href.includes('fb.com') &&
              !href.includes('fb.me') &&
              !href.includes('instagram.com')
            ) return href;
            return null;
          }

          const text = cardEl.innerText || '';

          const images = Array.from(cardEl.querySelectorAll('img'))
            .map((img: any) => img.src as string)
            .filter((src: string) => src && src.startsWith('https://') && src.includes('fbcdn') && !src.includes('emoji'));

          const videos = Array.from(cardEl.querySelectorAll('video'))
            .map((v: any) => v.src as string)
            .filter(Boolean);

          const advertiserEl = cardEl.querySelector('a[role="link"]') as HTMLElement | null;
          const advertiser = advertiserEl?.innerText?.trim() || 'Desconhecido';

          const ctaKeywords = ['saiba mais', 'comprar', 'baixe', 'quero', 'acessar', 'garantir', 'clique', 'continuar', 'começar', 'ver mais', 'obter', 'inscrever', 'assinar'];

          const ctaLinks = Array.from(cardEl.querySelectorAll('a'))
            .filter((a: any) => {
              const t = (a.innerText || '').toLowerCase();
              return ctaKeywords.some(k => t.includes(k));
            })
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

        // Skip nav/header content
        if (
          adData.text.includes('Biblioteca de Anúncios da Meta') ||
          adData.text.includes('Relatório da Biblioteca') ||
          adData.text.includes('Sobre a Biblioteca') ||
          adData.text.length < 30
        ) continue;

        await processAd(context, adData, i, keyword, country, categoryScores);
        await delay(3000);
      } catch (err) {
        console.error(`Erro ao processar anúncio ${i}:`, err);
      }
    }

    await sendToTelegram(`✅ <b>CONCLUÍDO:</b> ${keyword} — ${count} anúncios analisados`);

  } catch (err) {
    console.error(`Erro keyword "${keyword}":`, err);
  }
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
  });
  await sendToTelegram(`🚀 <b>Agente v2 iniciado!</b>\n🌍 Brasil 🇧🇷 e Moçambique 🇲🇿\n💰 Faixa: R$9,99 — R$50\n⭐ Filtro: Score ≥ ${MIN_QUALITY_SCORE}/10`);

  for (const country of COUNTRIES) {
    for (const [category, keywords] of Object.entries(KEYWORD_CATEGORIES)) {
      const categoryScores: AdScore[] = [];
      await sendToTelegram(`\n📂 <b>CATEGORIA: ${category}</b> | ${country === 'BR' ? 'Brasil 🇧🇷' : 'Moçambique 🇲🇿'}`);

      const context = await browser.newContext({
        locale: country === 'BR' ? 'pt-BR' : 'pt-MZ',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        viewport: { width: 1920, height: 1080 },
      });
      const page = await context.newPage();

      for (const keyword of keywords) {
        await scrapeKeyword(keyword, country, context, page, categoryScores);
        await delay(4000);
      }

      // Top 10 da categoria — only scored ads
      const highQuality = categoryScores.filter(a => a.score >= MIN_QUALITY_SCORE);
      if (highQuality.length > 0) {
        const top10 = highQuality.sort((a, b) => b.score - a.score).slice(0, 10);
        let summary = `🏆 <b>TOP ${top10.length} MELHORES — ${category.toUpperCase()}</b>\n\n`;
        top10.forEach((ad, i) => {
          summary += `${i + 1}. <b>${ad.advertiser}</b>\n`;
          summary += `   ⭐ Score: ${ad.score}/10 | 💰 ${ad.price}\n`;
          summary += `   🎬 VSL: ${ad.hasVSL ? '✅' : '❌'} | ⬆️ ${ad.hasUpsell ? 'Upsell ✅' : ''} ${ad.hasDownsell ? 'Downsell ✅' : ''}\n`;
          summary += `   🔗 ${ad.funnelUrl !== 'N/A' ? ad.funnelUrl.substring(0, 60) : 'N/A'}\n\n`;
        });
        summary += `\n💡 <b>Recomendação:</b> Clonar ofertas 1 e 2`;
        await sendToTelegram(summary);
      }

      await context.close();
    }
  }

  await browser.close();
  await sendToTelegram(`✅ <b>Pesquisa completa!</b> Todas as categorias analisadas.`);
}

main().catch(console.error);
