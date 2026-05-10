const https = require("https");
const util = require("util");

const MJ_PUBLIC =
  process.env.MAILJET_API_KEY ||
  process.env.MJ_APIKEY_PUBLIC ||
  process.env.MAILJET_PUBLIC;
const MJ_PRIVATE =
  process.env.MAILJET_API_SECRET ||
  process.env.MJ_APIKEY_PRIVATE ||
  process.env.MAILJET_PRIVATE;
const EMAIL_FROM = process.env.EMAIL_FROM || "no-reply@yourdomain.com";
const EMAIL_FROM_NAME = process.env.EMAIL_FROM_NAME || "Bhumivera Logistics";

if (!MJ_PUBLIC || !MJ_PRIVATE) {
  console.warn(
    "⚠️ MAILJET API keys not set. Email functionality will be disabled or fail."
  );
}

let mailjetClient = null;
try {
  const mj = require("node-mailjet");
  if (typeof mj === "function") {
    mailjetClient = mj({ apiKey: MJ_PUBLIC, apiSecret: MJ_PRIVATE });
  } else if (mj && typeof mj.apiConnect === "function") {
    mailjetClient = mj.apiConnect(MJ_PUBLIC, MJ_PRIVATE);
  } else if (mj && typeof mj.connect === "function") {
    mailjetClient = mj.connect(MJ_PUBLIC, MJ_PRIVATE);
  }
} catch (e) {
  console.warn("⚠️ Mailjet SDK not found; falling back to direct HTTPS calls.");
}

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
      base64 = looksBase64
        ? cleaned
        : Buffer.from(a.content, "utf8").toString("base64");
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
    const auth = Buffer.from(`${MJ_PUBLIC}:${MJ_PRIVATE}`).toString("base64");
    const data = JSON.stringify(payload);
    const options = {
      hostname: "api.mailjet.com",
      path: "/v3.1/send",
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
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

async function sendMail({
  to,
  cc,
  bcc,
  subject,
  html,
  text,
  from,
  attachments,
}) {
  if (!to) throw new Error("sendMail: 'to' is required");

  const From = (() => {
    if (!from) return { Email: EMAIL_FROM, Name: EMAIL_FROM_NAME };
    if (typeof from === "string") {
      const m = from.match(/^(.*)<(.+@.+)>$/);
      if (m) return { Email: m[2].trim(), Name: m[1].trim() };
      return { Email: from };
    }
    return { Email: from.Email, Name: from.Name || EMAIL_FROM_NAME };
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

  if (mailjetClient && typeof mailjetClient.post === "function") {
    try {
      const res = await mailjetClient.post("send", { version: "v3.1" }).request(body);
      return res.body;
    } catch (err) {
      console.error("Mailjet SDK Error:", util.inspect(err.response?.body || err.message, { depth: 2 }));
      throw err;
    }
  }

  return httpSendMail(body);
}

const sendOrderStatusEmail = async (email, name, orderId, status, trackingNumber = null, courier = null) => {
  const formattedId = String(orderId).padStart(10, '0');
  
  const statusConfig = {
    pending: { color: '#f59e0b', text: 'Pending Confirmation', msg: 'We have received your order and are currently reviewing it. We will notify you once it has been processed.' },
    processing: { color: '#3b82f6', text: 'Processing Order', msg: 'Your order has been confirmed and our warehouse team is currently prepping it for dispatch.' },
    shipped: { color: '#6366f1', text: 'Shipped / In Transit', msg: 'Great news! Your order has been dispatched and is currently on its way to your destination.' },
    delivered: { color: '#10b981', text: 'Delivered', msg: 'Your package has been successfully delivered. We hope you enjoy your purchase!' },
    cancelled: { color: '#ef4444', text: 'Order Cancelled', msg: 'Your order has been cancelled. Any applicable refunds will be processed shortly to your original payment method.' },
    returned: { color: '#64748b', text: 'Return Processed', msg: 'We have received and processed your return request.' }
  };

  const config = statusConfig[status.toLowerCase()] || statusConfig.pending;
  
  let trackingHtml = '';
  if (trackingNumber && courier) {
    trackingHtml = `
      <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 20px; margin-top: 20px;">
        <h3 style="margin-top: 0; color: #0f172a; font-size: 16px;">Tracking Information</h3>
        <p style="margin: 0; color: #475569; font-size: 14px;"><strong>Courier:</strong> ${courier}</p>
        <p style="margin: 5px 0 15px 0; color: #475569; font-size: 14px;"><strong>Tracking ID:</strong> ${trackingNumber}</p>
        <a href="https://www.google.com/search?q=${trackingNumber}+${courier}+tracking" style="display: inline-block; background-color: #0f172a; color: #ffffff; text-decoration: none; padding: 10px 20px; border-radius: 6px; font-weight: bold; font-size: 14px;">Track Package</a>
      </div>
    `;
  }

  const htmlTemplate = `
    <div style="font-family: 'Inter', Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.05);">
      <div style="background-color: #0f172a; padding: 30px 20px; text-align: center;">
        <h1 style="color: #ffffff; margin: 0; font-size: 24px; letter-spacing: -0.5px;">Bhumivera STORE</h1>
      </div>
      <div style="padding: 40px 30px;">
        <p style="color: #64748b; font-size: 14px; text-transform: uppercase; letter-spacing: 1px; font-weight: bold; margin-bottom: 5px;">Order #${formattedId}</p>
        <h2 style="color: ${config.color}; margin-top: 0; font-size: 28px; letter-spacing: -0.5px;">${config.text}</h2>
        <p style="color: #334155; font-size: 16px; line-height: 1.6;">Hello ${name},</p>
        <p style="color: #475569; font-size: 16px; line-height: 1.6;">${config.msg}</p>
        ${trackingHtml}
        <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 30px 0;" />
        <p style="color: #64748b; font-size: 14px; text-align: center; margin: 0;">
          Need help? <a href="https://Bhumivera.com/support" style="color: #3b82f6; text-decoration: none;">Contact our Support Team</a>
        </p>
      </div>
      <div style="background-color: #f8fafc; padding: 20px; text-align: center; border-top: 1px solid #e2e8f0;">
        <p style="color: #94a3b8; font-size: 12px; margin: 0;">&copy; ${new Date().getFullYear()} Bhumivera. All rights reserved.</p>
      </div>
    </div>
  `;

  try {
    return await sendMail({
      to: email,
      subject: `Order Update: #${formattedId} is ${config.text}`,
      html: htmlTemplate
    });
  } catch (error) {
    console.error("Failed to send high-end status email:", error);
  }
};

async function verifyTransport() {
  if (!MJ_PUBLIC || !MJ_PRIVATE) throw new Error("Mailjet API keys not set");
  const auth = Buffer.from(`${MJ_PUBLIC}:${MJ_PRIVATE}`).toString("base64");
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
