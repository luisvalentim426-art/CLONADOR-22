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
    protocol.get(url, (response) => {
      response.pipe(file);
      file.on('finish', () => { file.close(); resolve(true); });
    }).on('error', () => { fs.unlink(dest, () => {}); resolve(false); });
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

function calculateScore(data: any): number {
  let score = 0;
  if (data.daysRunning > 30) score += 30;
  if (data.hasVSL) score += 20;
  if (data.hasUpsell || data.hasDownsell) score += 20;
  if (data.price) score += 15;
  if (data.hasQuiz) score += 10;
  if (data.isMultiDomain) score += 5;
  return score;
}

function classifyPage(text: string, hasVideo: boolean, radioInputs: number): string {
  const lower = text.toLowerCase();
  if (hasVideo) return 'VSL';
  if (radioInputs >= 2 || lower.includes('quiz') || lower.includes('próxima pergunta')) return 'QUIZ';
  if (lower.includes('checkout') || lower.includes('finalizar compra')) return 'CHECKOUT';
  if (lower.includes('upsell') || lower.includes('leve também')) return 'UPSELL';
  if (lower.includes('espera') || lower.includes('antes de sair')) return 'DOWNSELL';
  if (lower.includes('whatsapp') || lower.includes('wa.me')) return 'WHATSAPP';
  return 'LANDING';
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
      await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await delay(2000);

      const realUrl = page.url();
      const domain = new URL(realUrl).hostname;
      const screenshotPath = `step_${depth + 1}_${Date.now()}.png`;
      await page.screenshot({ path: screenshotPath, fullPage: false });

      const pageData = await page.evaluate(() => {
        const text = document.body.innerText || '';
        const hasVideo = !!(document.querySelector('video') || document.querySelector('iframe[src*="youtube"]') || document.querySelector('iframe[src*="vimeo"]'));
        const videoUrl = (document.querySelector('iframe[src*="youtube"]') as HTMLIFrameElement)?.src || (document.querySelector('video') as HTMLVideoElement)?.src || null;
        const radioInputs = document.querySelectorAll('input[type="radio"]').length;
        const hasUpsell = text.toLowerCase().includes('leve também') || text.toLowerCase().includes('adicione ao pedido') || text.toLowerCase().includes('aproveite também');
        const hasDownsell = text.toLowerCase().includes('espera') || text.toLowerCase().includes('antes de sair') || text.toLowerCase().includes('última chance');
        const isQuiz = radioInputs >= 2 || text.toLowerCase().includes('quiz');
        const ctaLinks = Array.from(document.querySelectorAll('a, button')).filter((el: any) => {
          const t = (el.innerText || '').toLowerCase();
          return ['saiba mais', 'comprar', 'baixe', 'quero', 'acessar', 'garantir', 'clique', 'próximo', 'continuar', 'sim', 'começar'].some(k => t.includes(k));
        }).map((el: any) => el.href || null).filter(Boolean);
        const waLinks = Array.from(document.querySelectorAll('a')).map((a: any) => a.href).filter((h: string) => h && (h.includes('wa.me') || h.includes('whatsapp.com/send')));
        const subdomains = [...new Set(Array.from(document.querySelectorAll('a')).map((a: any) => { try { return new URL(a.href).hostname; } catch { return ''; } }).filter(Boolean))];
        return { title: document.title, text: text.substring(0, 2000), hasVideo, videoUrl, radioInputs, hasUpsell, hasDownsell, isQuiz, ctaLinks: ctaLinks.slice(0, 3), waLinks: waLinks.slice(0, 2), subdomains: subdomains.slice(0, 5) };
      });

      const pageType = classifyPage(pageData.text, pageData.hasVideo, pageData.radioInputs);
      steps.push({ url: realUrl, domain, type: pageType, title: pageData.title, screenshotPath, videoUrl: pageData.videoUrl, hasUpsell: pageData.hasUpsell, hasDownsell: pageData.hasDownsell, isQuiz: pageData.isQuiz, copy: pageData.text.substring(0, 800), subdomains: pageData.subdomains });

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

    // Download criativo
    let creativePath: string | null = null;
    if (adData.videos.length > 0) {
      const p = `creative_${Date.now()}.mp4`;
      if (await downloadFile(adData.videos[0], p)) creativePath = p;
    } else if (adData.images.length > 0) {
      const p = `creative_${Date.now()}.jpg`;
      if (await downloadFile(adData.images[0], p)) creativePath = p;
    }

    // Obter URL do funil a partir dos links extraídos (sem facebook.com)
    const funnelUrl: string | null = (adData.ctaLinks && adData.ctaLinks[0]) || adData.links[0] || null;

    // Analisar funil
    let funnelSteps: any[] = [];
    let funnelReport = '';
    if (funnelUrl && !funnelUrl.includes('facebook.com')) {
      funnelSteps = await crawlFunnel(context, funnelUrl);
    }

    // Score
    const daysRunning = adData.dateText ? 30 : 0;
    const hasVSL = funnelSteps.some(s => s.type === 'VSL') || adData.hasVideo;
    const hasUpsell = funnelSteps.some(s => s.hasUpsell);
    const hasDownsell = funnelSteps.some(s => s.hasDownsell);
    const hasQuiz = funnelSteps.some(s => s.isQuiz);
    const isMultiDomain = funnelSteps.length > 0 && new Set(funnelSteps.map(s => s.domain)).size > 1;

    const score = calculateScore({ daysRunning, hasVSL, hasUpsell, hasDownsell, price, hasQuiz, isMultiDomain });

    categoryScores.push({ advertiser: adData.advertiser, keyword, score, price: priceLabel, creativeType: adData.hasVideo ? '🎥 Vídeo' : '🖼 Imagem', daysRunning, hasUpsell, hasDownsell, hasVSL, hasQuiz, funnelUrl: funnelUrl || 'N/A' });

    // Enviar header
    await sendToTelegram(`🎯 <b>OFERTA ${index + 1} | ${keyword} | ${countryName}</b>`);

    // Enviar criativo
    if (creativePath) {
      if (adData.hasVideo) await sendVideo(creativePath, `🎥 ${adData.advertiser}`);
      else await sendPhoto(creativePath, `🖼 ${adData.advertiser}`);
    }

    // Montar funil info
    if (funnelSteps.length > 0) {
      funnelReport = `\n📊 <b>FUNIL:</b> ${funnelSteps.map(s => s.type).join(' → ')}\n`;
      funnelReport += `⬆️ Upsell: ${hasUpsell ? '✅' : '❌'} | ⬇️ Downsell: ${hasDownsell ? '✅' : '❌'} | 🎯 Quiz: ${hasQuiz ? '✅' : '❌'}\n`;
      funnelReport += `🌐 Domínios: ${[...new Set(funnelSteps.map(s => s.domain))].join(', ')}\n`;
    }

    // Enviar detalhes
    await sendToTelegram(`
🏢 <b>Anunciante:</b> ${adData.advertiser}
💰 <b>Preço:</b> ${priceLabel}
🎨 <b>Criativo:</b> ${adData.hasVideo ? '🎥 Vídeo/VSL' : '🖼 Imagem'}
⭐ <b>Score:</b> ${score}/100
📅 <b>Data início:</b> ${adData.dateText || 'Desconhecida'}
${funnelReport}
📝 <b>COPY:</b>
${adData.text.substring(0, 500)}

🔗 <b>Funil:</b> ${funnelUrl || 'N/A'}`);

    // Enviar screenshots do funil
    for (let i = 0; i < funnelSteps.length; i++) {
      const step = funnelSteps[i];
      if (step.screenshotPath) await sendPhoto(step.screenshotPath, `📸 Etapa ${i + 1} — ${step.type} | ${step.domain}`);
      if (step.copy && i === 0) await sendToTelegram(`📝 <b>COPY DA PÁGINA:</b>\n${step.copy}`);
    }

    // Separador
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
    await delay(5000);
    await page.evaluate(() => window.scrollBy(0, 1500));
    await delay(2000);

    const libScreenshot = `lib_${Date.now()}.png`;
    await page.screenshot({ path: libScreenshot });
    await sendPhoto(libScreenshot, `🔍 ${keyword} — ${countryName}`);

    // Extract ads by finding elements with 'Patrocinado'/'Sponsored' text,
    // then walking up the DOM to get the real ad card container.
    const ads = await page.evaluate(() => {
      const isFbLink = (h: string) =>
        !h || h.includes('facebook.com') || h.includes('fb.com') || h.includes('fb.me') || !h.startsWith('http');

      // Find all leaf-level text nodes that say 'Patrocinado' or 'Sponsored'
      const sponsoredEls = Array.from(document.querySelectorAll('*')).filter(el => {
        const t = el.textContent?.trim();
        return (t === 'Patrocinado' || t === 'Sponsored') && el.children.length === 0;
      });

      return sponsoredEls.slice(0, 10).map(sponsoredEl => {
        // Walk up the DOM until we find a card-level container with meaningful content
        let card: Element | null = sponsoredEl;
        for (let i = 0; i < 8; i++) {
          if (!card?.parentElement) break;
          card = card.parentElement;
          const h = (card as HTMLElement).innerText || '';
          // Stop when card has enough content to be a full ad card
          if (h.length > 100) break;
        }
        if (!card) return null;

        const cardEl = card as HTMLElement;
        const text = cardEl.innerText || '';

        // Skip if this looks like navigation/header content
        if (
          text.includes('Biblioteca de Anúncios da Meta') ||
          text.includes('Relatório da Biblioteca') ||
          text.length < 30
        ) return null;

        const images = Array.from(cardEl.querySelectorAll('img'))
          .map((img: any) => img.src as string)
          .filter((src: string) => src && src.startsWith('http') && !src.includes('emoji') && !src.includes('static'));

        const videos = Array.from(cardEl.querySelectorAll('video'))
          .map((v: any) => v.src as string)
          .filter(Boolean);

        // Advertiser: first meaningful link text near the top of the card
        const advertiserEl = cardEl.querySelector('a[role="link"]') as HTMLElement | null;
        const advertiser = advertiserEl?.innerText?.trim() || 'Desconhecido';

        // CTA links — button/link text containing known CTA words, filtered to external URLs only
        const ctaKeywords = ['saiba mais', 'comprar', 'baixe', 'quero', 'acessar', 'garantir', 'clique', 'continuar', 'começar', 'ver mais', 'obter'];
        const ctaLinks = Array.from(cardEl.querySelectorAll('a, button'))
          .filter((el: any) => {
            const t = (el.innerText || '').toLowerCase();
            return ctaKeywords.some(k => t.includes(k));
          })
          .map((el: any) => el.href as string || null)
          .filter((h: string | null): h is string => !!h && !isFbLink(h));

        // All external links in the card (non-facebook)
        const allLinks = Array.from(cardEl.querySelectorAll('a'))
          .map((a: any) => a.href as string)
          .filter((h: string) => !isFbLink(h));

        // WhatsApp links
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
      }).filter(Boolean);
    });

    if (!ads || ads.length === 0) {
      await sendToTelegram(`⚠️ Nenhum anúncio para <b>${keyword}</b> em ${countryName}`);
      return;
    }

    await sendToTelegram(`✅ <b>${ads.length} anúncios encontrados</b>`);

    for (let i = 0; i < ads.length; i++) {
      await processAd(context, ads[i], i, keyword, country, categoryScores);
      await delay(3000);
    }

    await sendToTelegram(`✅ <b>CONCLUÍDO:</b> ${keyword} — ${ads.length} anúncios analisados`);

  } catch (err) {
    console.error(`Erro keyword "${keyword}":`, err);
  }
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
  });
  await sendToTelegram(`🚀 <b>Agente iniciado!</b>\n🌍 Brasil 🇧🇷 e Moçambique 🇲🇿\n💰 Faixa: R$9,99 — R$50`);

  for (const country of COUNTRIES) {
    for (const [category, keywords] of Object.entries(KEYWORD_CATEGORIES)) {
      const categoryScores: AdScore[] = [];
      await sendToTelegram(`\n📂 <b>CATEGORIA: ${category}</b> | ${country === 'BR' ? 'Brasil 🇧🇷' : 'Moçambique 🇲🇿'}`);

      const context = await browser.newContext({
        locale: country === 'BR' ? 'pt-BR' : 'pt-MZ',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        viewport: { width: 1280, height: 800 }
      });
      const page = await context.newPage();

      for (const keyword of keywords) {
        await scrapeKeyword(keyword, country, context, page, categoryScores);
        await delay(4000);
      }

      // Top 10 da categoria
      if (categoryScores.length > 0) {
        const top10 = categoryScores.sort((a, b) => b.score - a.score).slice(0, 10);
        let summary = `🏆 <b>TOP ${top10.length} MELHORES OFERTAS — ${category.toUpperCase()}</b>\n\n`;
        top10.forEach((ad, i) => {
          summary += `${i + 1}. <b>${ad.advertiser}</b>\n`;
          summary += `   ⭐ Score: ${ad.score}/100 | 💰 ${ad.price}\n`;
          summary += `   🎨 ${ad.creativeType} | ⬆️ ${ad.hasUpsell ? 'Upsell ✅' : ''} ${ad.hasDownsell ? 'Downsell ✅' : ''}\n\n`;
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
