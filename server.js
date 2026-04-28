/**
 * Biquette Custom Blanket Designer — Backend Server
 * =================================================
 * Receives base64 image data from the frontend (no server-side
 * canvas rendering needed), saves files to Google Drive,
 * then creates a Shopify checkout with the Drive URLs attached.
 *
 * Stack: Node.js 18+, Express, googleapis
 * Deploy: Railway, Render, or any Node host
 */

import express           from 'express';
import cors              from 'cors';
import dotenv            from 'dotenv';
import { google }        from 'googleapis';
import { Readable }      from 'stream';
import fetch             from 'node-fetch';
import path              from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app       = express();

/* ── CORS ─────────────────────────────────────────────────────── */
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
app.use(express.json({ limit: '25mb' }));

/* ── SERVE STATIC DESIGNER ────────────────────────────────────── */
app.use(express.static(__dirname));

/* ════════════════════════════════════════════════════════════════
   GOOGLE DRIVE CLIENT
   ════════════════════════════════════════════════════════════════ */
function getDriveClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      type:            'service_account',
      project_id:      process.env.GCP_PROJECT_ID,
      private_key_id:  process.env.GCP_PRIVATE_KEY_ID,
      private_key:     process.env.GCP_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      client_email:    process.env.GCP_CLIENT_EMAIL,
      client_id:       process.env.GCP_CLIENT_ID,
      auth_uri:        'https://accounts.google.com/o/oauth2/auth',
      token_uri:       'https://oauth2.googleapis.com/token',
    },
    scopes: ['https://www.googleapis.com/auth/drive.file'],
  });
  return google.drive({ version: 'v3', auth });
}

/* Upload a Buffer to Google Drive and return public URL */
async function uploadToDrive(buffer, filename, mimeType) {
  const drive    = getDriveClient();
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;

  const file = await drive.files.create({
    requestBody: {
      name:    filename,
      parents: folderId ? [folderId] : [],
    },
    media: {
      mimeType,
      body: Readable.from(buffer),
    },
    fields: 'id,webViewLink',
  });

  const fileId = file.data.id;

  // Make publicly readable
  await drive.permissions.create({
    fileId,
    requestBody: { role: 'reader', type: 'anyone' },
  });

  const directUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
  return { fileId, directUrl, webViewLink: file.data.webViewLink };
}

/* ════════════════════════════════════════════════════════════════
   SHOPIFY — create checkout with design URLs as line-item properties
   ════════════════════════════════════════════════════════════════ */
async function createShopifyCheckout(shopifyDomain, variantId, tifUrl, jpgUrl) {
  const storefront = process.env.SHOPIFY_STOREFRONT_TOKEN;
  if (!storefront || !variantId) return { checkoutUrl: null };

  const endpoint = `https://${shopifyDomain}/api/2024-01/graphql.json`;
  const mutation = `
    mutation checkoutCreate($input: CheckoutCreateInput!) {
      checkoutCreate(input: $input) {
        checkout { id webUrl }
        checkoutUserErrors { message field }
      }
    }
  `;
  const variables = {
    input: {
      lineItems: [{
        variantId: `gid://shopify/ProductVariant/${variantId}`,
        quantity: 1,
        customAttributes: [
          { key: '_design_tif_url', value: tifUrl },
          { key: '_design_jpg_url', value: jpgUrl },
          { key: 'Custom Design',   value: 'Yes — see attached design files' },
        ],
      }],
    },
  };

  const res  = await fetch(endpoint, {
    method:  'POST',
    headers: {
      'Content-Type':                      'application/json',
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
   Expects JSON body:
     jpgData      — base64 data URL  (image/jpeg)
     pngData      — base64 data URL  (image/png)  used as TIF
     design       — array of {motifId, color, x, y}
     bgColor      — hex string
     variantId    — Shopify variant ID (optional)
     shopifyDomain— e.g. biquette.myshopify.com
   ════════════════════════════════════════════════════════════════ */
app.post('/api/submit-design', async (req, res) => {
  try {
    const { jpgData, pngData, design, bgColor, variantId, shopifyDomain } = req.body;

    if (!design || design.length !== 9) {
      return res.status(400).json({ error: 'Exactly 9 motifs required.' });
    }
    if (!jpgData || !pngData) {
      return res.status(400).json({ error: 'Image data missing.' });
    }

    const timestamp = Date.now();
    const basename  = `biquette-custom-${timestamp}`;

    // Convert base64 data URLs to Buffers
    const jpgBuffer = Buffer.from(jpgData.replace(/^data:image\/jpeg;base64,/, ''), 'base64');
    const pngBuffer = Buffer.from(pngData.replace(/^data:image\/png;base64,/,  ''), 'base64');

    console.log(`Uploading design ${basename} to Google Drive…`);

    // Upload both files to Google Drive in parallel
    const [tifResult, jpgResult] = await Promise.all([
      uploadToDrive(pngBuffer, `${basename}.png`, 'image/png'),
      uploadToDrive(jpgBuffer, `${basename}.jpg`, 'image/jpeg'),
    ]);

    console.log('PNG (TIF):', tifResult.directUrl);
    console.log('JPG:',       jpgResult.directUrl);

    // Create Shopify checkout if variant ID provided
    let checkoutUrl = null;
    if (variantId) {
      const domain = shopifyDomain || process.env.SHOPIFY_DOMAIN;
      console.log('Creating Shopify checkout…');
      const result = await createShopifyCheckout(domain, variantId, tifResult.directUrl, jpgResult.directUrl);
      checkoutUrl  = result.checkoutUrl;
    }

    res.json({
      success:   true,
      tifUrl:    tifResult.directUrl,
      jpgUrl:    jpgResult.directUrl,
      tifFileId: tifResult.fileId,
      jpgFileId: jpgResult.fileId,
      checkoutUrl,
    });

  } catch (err) {
    console.error('submit-design error:', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

/* ── HEALTH CHECK ────────────────────────────────────────────── */
app.get('/health', (_, res) => res.json({ status: 'ok', version: '1.1.0' }));

/* ── START ───────────────────────────────────────────────────── */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Biquette designer server running on port ${PORT}`));
