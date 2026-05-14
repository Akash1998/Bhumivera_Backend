const https = require("https");
const util = require("util");

const getMailConfig = () => {
  return {
    public: process.env.MAILJET_API_KEY || process.env.MJ_APIKEY_PUBLIC || process.env.MAILJET_PUBLIC,
    private: process.env.MAILJET_API_SECRET || process.env.MJ_APIKEY_PRIVATE || process.env.MAILJET_PRIVATE,
    fromEmail: process.env.EMAIL_FROM || "support@bhumivera.com",
    fromName: process.env.EMAIL_FROM_NAME || "Bhumivera Concierge"
  };
};

let cachedMailjetClient = null;
let isClientInitialized = false;

function getMailjetClient() {
  if (isClientInitialized) return cachedMailjetClient;

  const config = getMailConfig();
  if (!config.public || !config.private) {
    console.warn("⚠️ MAILJET API keys not set in environment variables. Email functionality will fail.");
    isClientInitialized = true;
    return null;
  }

  try {
    const mj = require("node-mailjet");
    if (typeof mj === "function") {
      cachedMailjetClient = mj({ apiKey: config.public, apiSecret: config.private });
    } else if (mj && typeof mj.apiConnect === "function") {
      cachedMailjetClient = mj.apiConnect(config.public, config.private);
    } else if (mj && typeof mj.connect === "function") {
      cachedMailjetClient = mj.connect(config.public, config.private);
    }
  } catch (e) {
    console.warn("⚠️ Mailjet SDK not found; falling back to direct HTTPS calls.");
  }
  isClientInitialized = true;
  return cachedMailjetClient;
}

// --- UTILS ---
function normalizeRecipient(recipient) {
  if (!recipient) return [];
  if (Array.isArray(recipient)) return recipient.map(normalizeRecipient).flat();
  if (typeof recipient === "string") {
    const m = recipient.match(/^(.*)<(.+@.+)>$/);
    if (m) return [{ Email: m[2].trim(), Name: m[1].trim() }];
    return [{ Email: recipient.trim() }];
  }
  if (recipient && recipient.Email) return [recipient];
  return [];
}

function normalizeAttachments(attachments) {
  if (!attachments) return undefined;
  return attachments.map((a) => {
    let base64;
    if (Buffer.isBuffer(a.content)) base64 = a.content.toString("base64");
    else if (typeof a.content === "string") {
      const cleaned = a.content.replace(/\s/g, "");
      const looksBase64 = /^[A-Za-z0-9+/=]+$/.test(cleaned);
      base64 = looksBase64 ? cleaned : Buffer.from(a.content, "utf8").toString("base64");
    } else {
      throw new Error("Attachment content must be Buffer or string");
    }
    return {
      ContentType: a.contentType || a.type || "application/octet-stream",
      Filename: a.filename,
      Base64Content: base64,
    };
  });
}

function httpSendMail(payload) {
  return new Promise((resolve, reject) => {
    const config = getMailConfig();
    if (!config.public || !config.private) {
      return reject(new Error("FATAL: Mailjet API keys missing in environment variables."));
    }

    const auth = Buffer.from(`${config.public}:${config.private}`).toString("base64");
    const data = JSON.stringify(payload);
    const options = {
      hostname: "api.mailjet.com",
      path: "/v3.1/send",
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data, "utf8"),
      },
    };
    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk.toString()));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(body);
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed);
          else reject(new Error(`Mailjet HTTP ${res.statusCode}: ${body}`));
        } catch (e) {
          reject(new Error(`Response parse error. Raw: ${body}`));
        }
      });
    });
    req.on("error", (err) => reject(err));
    req.write(data);
    req.end();
  });
}

async function sendMail({ to, cc, bcc, subject, html, text, from, attachments }) {
  if (!to) throw new Error("sendMail: 'to' is required");

  const config = getMailConfig();

  const From = (() => {
    if (!from) return { Email: config.fromEmail, Name: config.fromName };
    if (typeof from === "string") {
      const m = from.match(/^(.*)<(.+@.+)>$/);
      if (m) return { Email: m[2].trim(), Name: m[1].trim() };
      return { Email: from };
    }
    return { Email: from.Email, Name: from.Name || config.fromName };
  })();

  const message = {
    From,
    To: normalizeRecipient(to),
    Subject: subject || "(no subject)",
    Cc: cc ? normalizeRecipient(cc) : undefined,
    Bcc: bcc ? normalizeRecipient(bcc) : undefined,
    TextPart: text,
    HTMLPart: html,
    Attachments: attachments ? normalizeAttachments(attachments) : undefined,
  };

  const body = { Messages: [message] };
  const client = getMailjetClient();

  if (client && typeof client.post === "function") {
    try {
      const res = await client.post("send", { version: "v3.1" }).request(body);
      return res.body;
    } catch (err) {
      console.error("Mailjet SDK Error:", util.inspect(err.response?.body || err.message, { depth: 2 }));
      throw err;
    }
  }

  return httpSendMail(body);
}

// --- THE LUXURY ORDER STATUS MATRIX ---
const sendOrderStatusEmail = async (email, name, orderId, status, trackingNumber = null, courier = null) => {
  const formattedId = String(orderId).padStart(10, '0');
  
  const statusConfig = {
    pending: { 
      color: '#10b981', // Emerald
      title: 'Botanical Sequence Initialized', 
      quote: '"Purity requires patience; perfection requires precision."',
      msg: 'Your acquisition has been logged into our central ledger. Our Asansol Eco-Lab has received your request and is preparing the extraction protocols. We are verifying the botanical integrity of your selected batch before it proceeds to processing.' 
    },
    processing: { 
      color: '#10b981', 
      title: 'QA & Curing Verification', 
      quote: '"We do not rush nature; we engineer its delivery."',
      msg: 'Your batch is currently undergoing our rigorous SOP-104 inspection. Our lab technicians are ensuring the crystalline structure of the minerals and the pH balance (5.5) of your formulation meet the strictest Bhumivera Science tolerances. Your parcel is being packed in our tamper-evident, climate-controlled packaging.' 
    },
    shipped: { 
      color: '#10b981', 
      title: 'Dispatched from Asansol Eco-Lab', 
      quote: '"The earth provides the formula; we provide the transit."',
      msg: 'The zero-footprint transit sequence has begun. Your parcel has left our facility and is now navigating the logistics matrix. Below you will find the cryptographic transit ID required to monitor its movement in real-time.' 
    },
    delivered: { 
      color: '#10b981', 
      title: 'Arrival Protocol Complete', 
      quote: '"Your skin\'s new architecture has arrived."',
      msg: 'Your Bhumivera formulation has been successfully delivered. Please ensure the hygiene seals are intact. **Important:** Before your first application, locate the SNA-2 Serial Code on your packaging and synchronize it within the Bhumivera Somatic Registry to unlock your specific batch instructions and biological warranty.' 
    },
    cancelled: { 
      color: '#ef4444', 
      title: 'Transaction Voided', 
      quote: '"Integrity means knowing when to halt the process."',
      msg: 'Your order has been formally rescinded from our system. Any financial allocations reserved for this transaction are currently being reversed through our encrypted payment gateway back to your original source.' 
    },
    returned: { 
      color: '#f59e0b', 
      title: 'Reclamation Sequence Activated', 
      quote: '"A return is not an end, but a refinement of our data."',
      msg: 'We have received your returned physical asset. Our QA team is processing the item to finalize the resolution logic. We utilize return data to continually calibrate our botanical formulas. Your financial reconciliation will complete shortly.' 
    }
  };

  const config = statusConfig[status.toLowerCase()] || statusConfig.pending;
  
  let trackingHtml = '';
  if (trackingNumber && courier) {
    trackingHtml = `
      <div style="background-color: rgba(16, 185, 129, 0.05); border-left: 2px solid #10b981; padding: 20px; margin-top: 30px;">
        <p style="margin: 0; color: #a3a3a3; font-size: 10px; text-transform: uppercase; letter-spacing: 2px; font-family: monospace;">Transit Node</p>
        <p style="margin: 5px 0 15px 0; color: #ffffff; font-size: 16px;"><strong>Courier:</strong> ${courier}<br/><strong>Crypto-ID:</strong> <span style="font-family: monospace; color: #10b981;">${trackingNumber}</span></p>
        <a href="https://www.google.com/search?q=${trackingNumber}+${courier}+tracking" style="display: inline-block; background-color: #10b981; color: #000000; text-decoration: none; padding: 12px 24px; font-size: 10px; text-transform: uppercase; letter-spacing: 3px; font-weight: bold;">Trace Parcel Location</a>
      </div>
    `;
  }

  const htmlTemplate = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;700&family=JetBrains+Mono:wght@400;700&display=swap');
      </style>
    </head>
    <body style="margin: 0; padding: 40px 20px; background-color: #020202; font-family: 'Inter', sans-serif;">
      
      <div style="max-width: 600px; margin: 0 auto; background-color: #0a0a0a; border: 1px solid rgba(255, 255, 255, 0.05); overflow: hidden;">
        
        <div style="padding: 40px; text-align: center; border-bottom: 1px solid rgba(255, 255, 255, 0.05);">
          <div style="width: 40px; height: 40px; background-color: #10b981; margin: 0 auto 20px auto;"></div>
          <h1 style="color: #ffffff; margin: 0; font-size: 14px; letter-spacing: 6px; font-weight: 300; text-transform: uppercase;">Bhumivera Eco-Labs</h1>
        </div>

        <div style="padding: 40px 40px 10px 40px; text-align: center;">
          <p style="color: #a3a3a3; font-style: italic; font-size: 18px; line-height: 1.6; font-weight: 300;">
            ${config.quote}
          </p>
        </div>

        <div style="padding: 30px 40px;">
          <p style="color: #10b981; font-size: 10px; text-transform: uppercase; letter-spacing: 2px; font-family: monospace; margin-bottom: 10px;">Ledger ID: #${formattedId}</p>
          <h2 style="color: #ffffff; margin-top: 0; font-size: 24px; font-weight: 300; letter-spacing: -0.5px;">${config.title}</h2>
          
          <p style="color: #e5e5e5; font-size: 15px; margin-top: 30px;">Salutations, ${name}.</p>
          <p style="color: #a3a3a3; font-size: 14px; line-height: 1.8;">${config.msg}</p>
          
          ${trackingHtml}
          
          <div style="margin-top: 40px; padding-top: 30px; border-top: 1px solid rgba(255,255,255,0.05);">
            <p style="color: #737373; font-size: 12px; line-height: 1.6;">
              Should you detect any logical errors in your order routing, our digital concierge is available. Reply directly to this transmission or visit the <a href="https://bhumivera.com/support" style="color: #10b981; text-decoration: none;">Support Node</a>.
            </p>
          </div>
        </div>

        <div style="background-color: #050505; padding: 30px; text-align: center; border-top: 1px solid rgba(255, 255, 255, 0.05);">
          <p style="color: #525252; font-size: 9px; font-family: monospace; letter-spacing: 2px; text-transform: uppercase; margin: 0;">
            Zero Logic Deletion • Zero Heat Damage<br/><br/>
            &copy; ${new Date().getFullYear()} Bhumivera Science. Asansol, India.
          </p>
        </div>

      </div>

    </body>
    </html>
  `;

  try {
    return await sendMail({
      to: email,
      subject: `[BHUMIVERA] Update on Order #${formattedId}`,
      html: htmlTemplate
    });
  } catch (error) {
    console.error("Failed to send high-end status email:", error);
  }
};

async function verifyTransport() {
  const config = getMailConfig();
  if (!config.public || !config.private) throw new Error("Mailjet API keys not set");
  const auth = Buffer.from(`${config.public}:${config.private}`).toString("base64");
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: "api.mailjet.com",
      path: "/v3/REST/contact",
      method: "GET",
      headers: { Authorization: `Basic ${auth}` },
    };
    const req = https.request(opts, (res) => {
      if (res.statusCode >= 200 && res.statusCode < 300) resolve({ ok: true });
      else resolve({ ok: false, statusCode: res.statusCode });
    });
    req.on("error", (err) => reject(err));
    req.end();
  });
}

module.exports = { sendMail, sendOrderStatusEmail, verifyTransport };
