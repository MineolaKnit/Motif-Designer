/**
 * Biquette Custom Blanket Designer — Backend Server
 * =================================================
 * Receives design data from the frontend, saves files to
 * Google Drive (TIF + JPG), then injects the Drive URLs
 * as line-item properties into a Shopify cart.
 *
 * Stack: Node.js 18+, Express, googleapis, node-canvas
 * Deploy: any Node host (Railway, Render, Heroku, VPS)
 */

import express          from 'express';
import cors             from 'cors';
import dotenv           from 'dotenv';
import { google }       from 'googleapis';
import { Readable }     from 'stream';
import { createCanvas, loadImage } from 'canvas';
import fetch            from 'node-fetch';
import path             from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app       = express();

/* ── CORS ──────────────────────────────────────────────────────── */
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '*').split(',');
app.use(cors({
  origin: (origin, cb) => {
    if (allowedOrigins.includes('*') || !origin || allowedOrigins.includes(origin)) {
      cb(null, true);
    } else {
      cb(new Error('Not allowed by CORS'));
    }
  }
}));
app.use(express.json({ limit: '20mb' }));

/* ── SERVE STATIC DESIGNER ─────────────────────────────────────── */
app.use(express.static(__dirname));

/* ════════════════════════════════════════════════════════════════
   GOOGLE DRIVE CLIENT
   ════════════════════════════════════════════════════════════════ */
function getDriveClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      type:                        'service_account',
      project_id:                  process.env.GCP_PROJECT_ID,
      private_key_id:              process.env.GCP_PRIVATE_KEY_ID,
      private_key:                 process.env.GCP_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      client_email:                process.env.GCP_CLIENT_EMAIL,
      client_id:                   process.env.GCP_CLIENT_ID,
      auth_uri:                    'https://accounts.google.com/o/oauth2/auth',
      token_uri:                   'https://oauth2.googleapis.com/token',
    },
    scopes: ['https://www.googleapis.com/auth/drive.file'],
  });
  return google.drive({ version: 'v3', auth });
}

/**
 * Upload a Buffer to Google Drive and return the public URL.
 * The file is placed in the folder specified by GOOGLE_DRIVE_FOLDER_ID.
 * It is shared publicly so Shopify can display it.
 */
async function uploadToDrive(buffer, filename, mimeType) {
  const drive    = getDriveClient();
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;

  const fileStream = Readable.from(buffer);

  const file = await drive.files.create({
    requestBody: {
      name:    filename,
      parents: folderId ? [folderId] : [],
    },
    media: {
      mimeType,
      body: fileStream,
    },
    fields: 'id,webViewLink,webContentLink',
  });

  const fileId = file.data.id;

  // Make it publicly readable
  await drive.permissions.create({
    fileId,
    requestBody: { role: 'reader', type: 'anyone' },
  });

  // Direct download URL (works without sign-in)
  const directUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
  return { fileId, directUrl, webViewLink: file.data.webViewLink };
}

/* ════════════════════════════════════════════════════════════════
   IMAGE GENERATION
   Builds a 3600×3600 px canvas (print-quality) server-side.
   We produce a PNG and treat it as the "TIF equivalent" unless
   you install a native TIF encoder (e.g. utif / tiff).
   ════════════════════════════════════════════════════════════════ */
const PRINT_SIZE  = 3600; // px — 12 inch × 300 dpi
const CELL_PRINT  = PRINT_SIZE / 3;
const MOTIF_PRINT = 1100; // motif draw size on print canvas

/**
 * Build a high-resolution canvas from the design payload and return
 * { tifBuffer, jpgBuffer } as Buffers.
 */
async function renderDesign(design, bgColor) {
  const c   = createCanvas(PRINT_SIZE, PRINT_SIZE);
  const ctx = c.getContext('2d');

  // Background
  ctx.fillStyle = bgColor || '#FFFFFF';
  ctx.fillRect(0, 0, PRINT_SIZE, PRINT_SIZE);

  // Each motif
  const scale = PRINT_SIZE / 540; // map screen coords → print coords
  for (const item of design) {
    const svgColored = getSvgForMotif(item.motifId, item.color);
    const svgBuf     = Buffer.from(svgColored, 'utf8');
    const img        = await loadImage(svgBuf);
    const px         = item.x * scale;
    const py         = item.y * scale;
    ctx.drawImage(img, px - MOTIF_PRINT/2, py - MOTIF_PRINT/2, MOTIF_PRINT, MOTIF_PRINT);
  }

  const jpgBuffer = c.toBuffer('image/jpeg', { quality: 0.95 });
  // node-canvas doesn't natively output TIFF; output high-quality PNG
  // as the archival/TIF equivalent. Replace with utif library for true TIFF.
  const tifBuffer = c.toBuffer('image/png');

  return { tifBuffer, jpgBuffer };
}

/* ── SVG motifs (duplicated from frontend for server-side render) ─ */
const MOTIFS_SVG = {
  1:  (c) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 60"><circle cx="30" cy="30" r="12" fill="${c}"/><g stroke="${c}" stroke-width="2.5" stroke-linecap="round">${[0,45,90,135,180,225,270,315].map(a=>`<line x1="${30+18*Math.cos(a*Math.PI/180)}" y1="${30+18*Math.sin(a*Math.PI/180)}" x2="${30+24*Math.cos(a*Math.PI/180)}" y2="${30+24*Math.sin(a*Math.PI/180)}"/>`).join('')}</g></svg>`,
  2:  (c) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 60"><path d="M38,30 A14,14 0 1,1 24,16 A10,10 0 0,0 38,30Z" fill="${c}"/></svg>`,
  3:  (c) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 60"><polygon points="30,8 35,22 50,22 38,31 43,46 30,37 17,46 22,31 10,22 25,22" fill="${c}"/></svg>`,
  4:  (c) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 60">${[0,60,120,180,240,300].map(a=>`<ellipse cx="${30+12*Math.cos(a*Math.PI/180)}" cy="${30+12*Math.sin(a*Math.PI/180)}" rx="6" ry="10" transform="rotate(${a},${30+12*Math.cos(a*Math.PI/180)},${30+12*Math.sin(a*Math.PI/180)})" fill="${c}" opacity=".85"/>`).join('')}<circle cx="30" cy="30" r="7" fill="${c}"/></svg>`,
  5:  (c) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 60"><path d="M30,52 Q10,30 20,12 Q30,4 40,12 Q50,30 30,52Z" fill="${c}"/><line x1="30" y1="52" x2="30" y2="16" stroke="white" stroke-width="1.5"/></svg>`,
  6:  (c) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 60"><path d="M30,30 Q14,12 10,24 Q8,36 30,30Z" fill="${c}" opacity=".9"/><path d="M30,30 Q46,12 50,24 Q52,36 30,30Z" fill="${c}" opacity=".9"/><path d="M30,30 Q16,38 14,48 Q20,54 30,30Z" fill="${c}" opacity=".7"/><path d="M30,30 Q44,38 46,48 Q40,54 30,30Z" fill="${c}" opacity=".7"/><circle cx="30" cy="30" r="2" fill="${c}"/></svg>`,
  7:  (c) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 60"><path d="M10,30 Q20,20 30,28 Q40,20 50,30 Q40,26 30,32 Q20,26 10,30Z" fill="${c}"/><circle cx="32" cy="26" r="2" fill="white"/></svg>`,
  8:  (c) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 60"><path d="M30,48 Q10,34 10,22 A10,10 0 0,1 30,18 A10,10 0 0,1 50,22 Q50,34 30,48Z" fill="${c}"/></svg>`,
  9:  (c) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 60"><polygon points="30,8 52,28 30,52 8,28" fill="${c}"/></svg>`,
  10: (c) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 60"><g stroke="${c}" stroke-width="2.5" stroke-linecap="round">${[0,60,120].map(a=>`<line x1="${30+22*Math.cos(a*Math.PI/180)}" y1="${30+22*Math.sin(a*Math.PI/180)}" x2="${30-22*Math.cos(a*Math.PI/180)}" y2="${30-22*Math.sin(a*Math.PI/180)}"/>`).join('')}${[0,60,120].map(a=>`<line x1="${30+12*Math.cos((a+30)*Math.PI/180)}" y1="${30+12*Math.sin((a+30)*Math.PI/180)}" x2="${30+18*Math.cos(a*Math.PI/180)}" y2="${30+18*Math.sin(a*Math.PI/180)}"/><line x1="${30+12*Math.cos((a-30)*Math.PI/180)}" y1="${30+12*Math.sin((a-30)*Math.PI/180)}" x2="${30+18*Math.cos(a*Math.PI/180)}" y2="${30+18*Math.sin(a*Math.PI/180)}"/>`).join('')}</g></svg>`,
  11: (c) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 60"><polygon points="30,8 44,32 16,32" fill="${c}"/><polygon points="30,20 46,42 14,42" fill="${c}"/><rect x="26" y="42" width="8" height="10" fill="${c}"/></svg>`,
  12: (c) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 60"><path d="M14,34 Q14,16 30,14 Q46,16 46,34Z" fill="${c}"/><rect x="24" y="34" width="12" height="14" rx="3" fill="${c}" opacity=".75"/></svg>`,
  13: (c) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 60"><path d="M6,30 Q14,20 22,30 Q30,40 38,30 Q46,20 54,30" fill="none" stroke="${c}" stroke-width="4" stroke-linecap="round"/><path d="M6,38 Q14,28 22,38 Q30,48 38,38 Q46,28 54,38" fill="none" stroke="${c}" stroke-width="3" stroke-linecap="round" opacity=".5"/></svg>`,
  14: (c) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 60"><polygon points="30,10 54,50 6,50" fill="${c}"/><polygon points="20,50 38,20 56,50" fill="${c}" opacity=".55"/></svg>`,
  15: (c) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 60"><path d="M30,48 Q14,36 12,24 L20,28 Q22,14 30,18 Q38,14 40,28 L48,24 Q46,36 30,48Z" fill="${c}"/><circle cx="24" cy="28" r="2" fill="white"/><circle cx="36" cy="28" r="2" fill="white"/></svg>`,
  16: (c) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 60"><ellipse cx="30" cy="40" rx="10" ry="13" fill="${c}"/><circle cx="30" cy="24" r="7" fill="${c}"/><path d="M24,20 Q18,10 14,8 M24,18 Q20,12 22,8 M36,20 Q42,10 46,8 M36,18 Q40,12 38,8" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round"/><circle cx="28" cy="23" r="1.5" fill="white"/><circle cx="32" cy="23" r="1.5" fill="white"/></svg>`,
  17: (c) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 60"><path d="M32,52 Q14,40 18,16 Q30,8 44,22 Q50,36 32,52Z" fill="${c}" opacity=".85"/><line x1="32" y1="52" x2="26" y2="20" stroke="white" stroke-width="1.2"/></svg>`,
  18: (c) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 60"><polygon points="30,12 39,17 39,27 30,32 21,27 21,17" fill="${c}"/><polygon points="48,22 57,27 57,37 48,42 39,37 39,27" fill="${c}" opacity=".7"/><polygon points="12,22 21,27 21,37 12,42 3,37 3,27" fill="${c}" opacity=".7"/><polygon points="30,32 39,37 39,47 30,52 21,47 21,37" fill="${c}" opacity=".85"/></svg>`,
  19: (c) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 60"><path d="M30,30 Q30,20 38,22 Q46,24 44,34 Q42,44 30,44 Q16,44 14,30 Q12,16 30,14 Q48,12 50,32" fill="none" stroke="${c}" stroke-width="3" stroke-linecap="round"/></svg>`,
  20: (c) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 60"><path d="M10,30 L42,30 L32,20 M42,30 L32,40" fill="none" stroke="${c}" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  21: (c) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 60"><circle cx="30" cy="30" r="18" fill="none" stroke="${c}" stroke-width="5"/><circle cx="30" cy="30" r="8" fill="${c}"/></svg>`,
  22: (c) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 60"><rect x="26" y="10" width="8" height="40" rx="3" fill="${c}"/><rect x="10" y="26" width="40" height="8" rx="3" fill="${c}"/></svg>`,
  23: (c) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 60"><path d="M30,52 Q14,40 18,26 Q22,16 26,20 Q24,10 30,8 Q32,18 36,16 Q44,24 42,36 Q46,30 44,24 Q52,32 46,44 Q42,50 30,52Z" fill="${c}"/></svg>`,
  24: (c) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 60"><path d="M10,42 L10,28 L20,38 L30,14 L40,38 L50,28 L50,42 Z" fill="${c}"/><rect x="10" y="42" width="40" height="6" rx="2" fill="${c}"/></svg>`,
};

function getSvgForMotif(motifId, color) {
  const fn = MOTIFS_SVG[motifId];
  return fn ? fn(color || '#5C3317') : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 60"><rect width="60" height="60" fill="${color}"/></svg>`;
}

/* ════════════════════════════════════════════════════════════════
   SHOPIFY — add design URLs as cart line-item properties
   ════════════════════════════════════════════════════════════════ */
async function addToShopifyCart(shopifyDomain, variantId, tifUrl, jpgUrl) {
  const storefront = process.env.SHOPIFY_STOREFRONT_TOKEN;
  const adminToken = process.env.SHOPIFY_ADMIN_TOKEN;

  if (!storefront && !adminToken) {
    // Return a mock checkout URL for development
    console.warn('No Shopify tokens set — skipping cart update');
    return { checkoutUrl: null };
  }

  // Using Storefront API to create a checkout with line-item custom attributes
  const endpoint = `https://${shopifyDomain}/api/2024-01/graphql.json`;
  const mutation = `
    mutation checkoutCreate($input: CheckoutCreateInput!) {
      checkoutCreate(input: $input) {
        checkout {
          id
          webUrl
        }
        checkoutUserErrors {
          message
          field
        }
      }
    }
  `;
  const variables = {
    input: {
      lineItems: [
        {
          variantId: `gid://shopify/ProductVariant/${variantId}`,
          quantity:  1,
          customAttributes: [
            { key: '_design_tif_url', value: tifUrl },
            { key: '_design_jpg_url', value: jpgUrl },
            { key: 'Custom Design',   value: 'Yes — see attached design files' },
          ],
        },
      ],
    },
  };

  const res  = await fetch(endpoint, {
    method:  'POST',
    headers: {
      'Content-Type':                     'application/json',
      'X-Shopify-Storefront-Access-Token': storefront,
    },
    body: JSON.stringify({ query: mutation, variables }),
  });
  const json = await res.json();
  const checkout = json?.data?.checkoutCreate?.checkout;
  return { checkoutUrl: checkout?.webUrl || null };
}

/* ════════════════════════════════════════════════════════════════
   MAIN ENDPOINT: POST /api/submit-design
   ════════════════════════════════════════════════════════════════ */
app.post('/api/submit-design', async (req, res) => {
  try {
    const { jpgData, pngData, design, bgColor, variantId, shopifyDomain } = req.body;

    if (!design || design.length !== 9) {
      return res.status(400).json({ error: 'Exactly 9 motifs required.' });
    }

    const timestamp = Date.now();
    const basename  = `biquette-custom-${timestamp}`;

    // ── Build print-resolution images server-side ──────────────
    console.log('Rendering print-quality design…');
    const { tifBuffer, jpgBuffer } = await renderDesign(design, bgColor);

    // ── Upload to Google Drive ─────────────────────────────────
    console.log('Uploading to Google Drive…');
    const [tifResult, jpgResult] = await Promise.all([
      uploadToDrive(tifBuffer, `${basename}.png`, 'image/png'),   // PNG = archival quality
      uploadToDrive(jpgBuffer, `${basename}.jpg`, 'image/jpeg'),
    ]);

    console.log('TIF (PNG):', tifResult.directUrl);
    console.log('JPG:',       jpgResult.directUrl);

    // ── Add to Shopify cart ────────────────────────────────────
    let checkoutUrl = null;
    if (variantId) {
      console.log('Creating Shopify checkout…');
      const domain = shopifyDomain || process.env.SHOPIFY_DOMAIN;
      const result = await addToShopifyCart(domain, variantId, tifResult.directUrl, jpgResult.directUrl);
      checkoutUrl  = result.checkoutUrl;
    }

    res.json({
      success:     true,
      tifUrl:      tifResult.directUrl,
      jpgUrl:      jpgResult.directUrl,
      tifFileId:   tifResult.fileId,
      jpgFileId:   jpgResult.fileId,
      checkoutUrl,
    });

  } catch (err) {
    console.error('submit-design error:', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

/* ── HEALTH CHECK ────────────────────────────────────────────── */
app.get('/health', (_, res) => res.json({ status: 'ok', version: '1.0.0' }));

/* ── START ───────────────────────────────────────────────────── */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Biquette designer server running on port ${PORT}`));
