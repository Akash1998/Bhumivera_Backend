const https = require("https");

const getMailConfig = () => {
  const getEnv = (key) => (process.env[key] ? String(process.env[key]).trim() : null);
  return {
    apiKey: getEnv("MAILERLITE_API_KEY") || getEnv("MAILERSEND_API_KEY"),
    fromEmail: getEnv("EMAIL_FROM") || "support@bhumivera.com",
    fromName: getEnv("EMAIL_FROM_NAME") || "Bhumivera Concierge"
  };
};

function normalizeRecipients(recipient) {
  if (!recipient) return [];
  if (Array.isArray(recipient)) {
    return recipient.map(normalizeRecipients).flat();
  }
  
  if (typeof recipient === "string") {
    const m = recipient.match(/^(.*)<(.+@.+)>$/);
    if (m) {
      return [{ email: m[2].trim(), name: m[1].trim() }];
    }
    return [{ email: recipient.trim() }];
  }
  
  if (recipient && (recipient.email || recipient.Email)) {
    return [{
      email: (recipient.email || recipient.Email).trim(),
      name: recipient.name || recipient.Name || undefined
    }];
  }
  
  return [];
}

function normalizeAttachments(attachments) {
  if (!attachments || !Array.isArray(attachments)) return undefined;
  return attachments.map((a) => {
    let base64;
    if (Buffer.isBuffer(a.content)) {
      base64 = a.content.toString("base64");
    } else if (typeof a.content === "string") {
      const cleaned = a.content.replace(/\s/g, "");
      const looksBase64 = /^[A-Za-z0-9+/=]+$/.test(cleaned);
      base64 = looksBase64 ? cleaned : Buffer.from(a.content, "utf8").toString("base64");
    } else {
      throw new Error("Attachment content must be a Buffer or base64/utf8 string");
    }
    return {
      content: base64,
      filename: a.filename || a.Filename || "attachment.dat"
    };
  });
}

/**
 * Native Transactional HTTPS Client for MailerSend API
 */
function httpSendMail(payload) {
  return new Promise((resolve, reject) => {
    const config = getMailConfig();
    if (!config.apiKey) {
      return reject(new Error("FATAL: MailerSend/MailerLite API key missing in environment variables."));
    }

    const data = JSON.stringify(payload);
    const options = {
      hostname: "api.mailersend.com",
      path: "/v1/email",
      method: "POST",
      headers: {
        "Authorization": `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        "X-Requested-With": "XMLHttpRequest",
        "Content-Length": Buffer.byteLength(data, "utf8"),
      },
    };

    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk.toString()));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(body || "{}");
          // MailerSend passes a 202 Accepted for successful queuing
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            reject(new Error(`MailerSend HTTP ${res.statusCode}: ${body}`));
          }
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

/**
 * Primary Core Email Dispatcher
 */
async function sendMail({ to, cc, bcc, subject, html, text, from, attachments }) {
  if (!to) throw new Error("sendMail: 'to' is required");
  const config = getMailConfig();

  // Normalize Sender
  const fromNormalized = (() => {
    if (!from) return { email: config.fromEmail, name: config.fromName };
    if (typeof from === "string") {
      const m = from.match(/^(.*)<(.+@.+)>$/);
      if (m) return { email: m[2].trim(), name: m[1].trim() };
      return { email: from.trim() };
    }
    return { 
      email: from.email || from.Email || config.fromEmail, 
      name: from.name || from.Name || config.fromName 
    };
  })();

  // Build MailerSend Payload Schema
  const payload = {
    from: fromNormalized,
    to: normalizeRecipients(to),
    subject: subject || "(no subject)",
    text: text || "",
    html: html || ""
  };

  // Append context optionals if they exist
  const normalizedCc = cc ? normalizeRecipients(cc) : [];
  if (normalizedCc.length > 0) payload.cc = normalizedCc;

  const normalizedBcc = bcc ? normalizeRecipients(bcc) : [];
  if (normalizedBcc.length > 0) payload.bcc = normalizedBcc;

  const normalizedAttachments = attachments ? normalizeAttachments(attachments) : undefined;
  if (normalizedAttachments) payload.attachments = normalizedAttachments;

  return httpSendMail(payload);
}

/**
 * Luxury Cyber-Lab Brand Notification Builder
 */
const sendOrderStatusEmail = async (email, name, orderId, status, trackingNumber = null, courier = null) => {
  const formattedId = String(orderId).padStart(10, '0');
  
  const statusConfig = {
    pending: { 
      color: '#10b981', 
      title: 'Botanical Sequence Initialized', 
      quote: '"Purity requires patience; perfection requires precision."',
      msg: 'Your acquisition has been logged into our central ledger. Our Asansol Eco-Lab has received your request and is preparing the extraction protocols.' 
    },
    processing: { 
      color: '#10b981', 
      title: 'QA & Curing Verification', 
      quote: '"We do not rush nature; we engineer its delivery."',
      msg: 'Your batch is currently undergoing our rigorous SOP-104 inspection. Our lab technicians are ensuring the crystalline structure of the minerals meet tolerances.' 
    },
    shipped: { 
      color: '#10b981', 
      title: 'Dispatched from Asansol Eco-Lab', 
      quote: '"The earth provides the formula; we provide the transit."',
      msg: 'The zero-footprint transit sequence has begun. Your parcel has left our facility and is now navigating the logistics matrix.' 
    },
    delivered: { 
      color: '#10b981', 
      title: 'Arrival Protocol Complete', 
      quote: '"Your skin\'s new architecture has arrived."',
      msg: 'Your Bhumivera formulation has been successfully delivered. Please ensure the hygiene seals are intact.' 
    },
    cancelled: { 
      color: '#ef4444', 
      title: 'Transaction Voided', 
      quote: '"Integrity means knowing when to halt the process."',
      msg: 'Your order has been formally rescinded from our system.' 
    },
    returned: { 
      color: '#f59e0b', 
      title: 'Reclamation Sequence Activated', 
      quote: '"A return is not an end, but a refinement of our data."',
      msg: 'We have received your returned physical asset. Our QA team is processing the item to finalize the resolution logic.' 
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
    </head>
    <body style="margin: 0; padding: 40px 20px; background-color: #020202; font-family: sans-serif;">
      <div style="max-width: 600px; margin: 0 auto; background-color: #0a0a0a; border: 1px solid rgba(255, 255, 255, 0.05); overflow: hidden;">
        <div style="padding: 40px; text-align: center; border-bottom: 1px solid rgba(255, 255, 255, 0.05);">
          <div style="width: 40px; height: 40px; background-color: #10b981; margin: 0 auto 20px auto;"></div>
          <h1 style="width: 100%; color: #ffffff; margin: 0; font-size: 14px; letter-spacing: 6px; font-weight: 300; text-transform: uppercase;">Bhumivera Eco-Labs</h1>
        </div>
        <div style="padding: 40px 40px 10px 40px; text-align: center;">
          <p style="color: #a3a3a3; font-style: italic; font-size: 18px; line-height: 1.6; font-weight: 300;">${config.quote}</p>
        </div>
        <div style="padding: 30px 40px;">
          <p style="color: ${config.color}; font-size: 10px; text-transform: uppercase; letter-spacing: 2px; font-family: monospace; margin-bottom: 10px;">Ledger ID: #${formattedId}</p>
          <h2 style="color: #ffffff; margin-top: 0; font-size: 24px; font-weight: 300; letter-spacing: -0.5px;">${config.title}</h2>
          <p style="color: #e5e5e5; font-size: 15px; margin-top: 30px;">Salutations, ${name}.</p>
          <p style="color: #a3a3a3; font-size: 14px; line-height: 1.8;">${config.msg}</p>
          ${trackingHtml}
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
    throw error;
  }
};

async function verifyTransport() {
  const config = getMailConfig();
  if (!config.apiKey) throw new Error("MailerSend API key not set");
  
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: "api.mailersend.com",
      path: "/v1/activity", // Quick status check query
      method: "GET",
      headers: { Authorization: `Bearer ${config.apiKey}` },
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
