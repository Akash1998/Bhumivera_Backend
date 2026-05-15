const https = require("https");
const nodemailer = require("nodemailer");

const getMailConfig = () => {
  // Safe helper to trim environment variables to prevent 401/403 errors
  const getEnv = (key) => (process.env[key] ? String(process.env[key]).trim() : null);
  
  // Extract API keys and support comma-separated multiple keys for automatic limits rotation
  const rawKeys = getEnv("MAILERSEND_API_KEY") || getEnv("MAILERLITE_API_KEY") || "";
  const apiKeys = rawKeys.split(",").map(k => k.trim()).filter(k => k.length > 0);

  return {
    apiKeys,
    fromEmail: getEnv("EMAIL_FROM") || "support@bhumivera.com",
    fromName: getEnv("EMAIL_FROM_NAME") || "Bhumivera Concierge",
    // SMTP Fallback for MailerLite or Generic SMTP delivery (Late OTP Support)
    smtpHost: getEnv("SMTP_HOST") || "smtp.mailerlite.com",
    smtpPort: parseInt(getEnv("SMTP_PORT") || "587", 10),
    smtpUser: getEnv("SMTP_USER"),
    smtpPass: getEnv("SMTP_PASS")
  };
};

/**
 * Isolated HTTPS dispatcher to support looping over multiple API Keys
 */
function httpSendMail(payload, apiKey) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const options = {
      hostname: "api.mailersend.com",
      path: "/v1/email",
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "X-Requested-With": "XMLHttpRequest",
        "Content-Length": Buffer.byteLength(data, "utf8"),
      },
    };

    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk.toString()));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          let parsed = {};
          try {
            parsed = body ? JSON.parse(body) : {};
          } catch (e) {
            console.warn("MailerSend Success (Non-JSON body returned):", body);
          }
          resolve(parsed);
        } else {
          reject(new Error(`MailerSend Service Error [${res.statusCode}]: ${body}`));
        }
      });
    });

    req.on("error", (err) => reject(err));
    req.write(data);
    req.end();
  });
}

/**
 * Primary dispatch function for OTPs and notifications.
 */
async function sendMail({ to, subject, html, text, from }) {
  if (!to) throw new Error("sendMail: 'to' recipient is required");
  
  const config = getMailConfig();

  // Map to recipient format
  const recipients = Array.isArray(to) 
    ? to.map(email => ({ email: typeof email === 'string' ? email.trim() : (email.Email || email.email) })) 
    : [{ email: to.trim() }];

  // ---------------------------------------------------------
  // STRATEGY 1: MailerLite / Standard SMTP (Late OTP bypass)
  // ---------------------------------------------------------
  if (config.smtpUser && config.smtpPass) {
    try {
      const transporter = nodemailer.createTransport({
        host: config.smtpHost,
        port: config.smtpPort,
        secure: config.smtpPort === 465,
        auth: {
          user: config.smtpUser,
          pass: config.smtpPass,
        },
      });

      const mailOptions = {
        from: `"${from?.name || config.fromName}" <${from?.email || config.fromEmail}>`,
        to: recipients.map(r => r.email).join(", "),
        subject: subject || "(no subject)",
        text: text,
        html: html
      };

      const info = await transporter.sendMail(mailOptions);
      return info;
    } catch (error) {
      console.warn(`SMTP Delivery failed: ${error.message}. Falling back to API rotation...`);
    }
  }

  // ---------------------------------------------------------
  // STRATEGY 2: API Keys with Multi-Key Rotation
  // ---------------------------------------------------------
  if (config.apiKeys.length === 0) {
    throw new Error("FATAL: No SMTP credentials and no API keys found in Railway variables.");
  }

  const payload = {
    from: {
      email: from?.email || config.fromEmail,
      name: from?.name || config.fromName
    },
    to: recipients,
    subject: subject || "(no subject)"
  };

  if (text && String(text).trim().length > 0) payload.text = text;
  if (html && String(html).trim().length > 0) payload.html = html;

  let lastError;

  // Loop through available keys. If one fails (e.g. 422 Limit), seamlessly try the next
  for (const apiKey of config.apiKeys) {
    try {
      const result = await httpSendMail(payload, apiKey);
      return result; // Success, exit function
    } catch (err) {
      lastError = err;
      console.warn(`API Key Failed (Possible 422 Limit). Trying next key... Error details: ${err.message}`);
    }
  }

  throw new Error(`All available email APIs and SMTP fallbacks were exhausted. Last Error: ${lastError.message}`);
}

const sendOrderStatusEmail = async (email, name, orderId, status, trackingNumber = null, courier = null) => {
  const formattedId = String(orderId).padStart(10, '0');
  
  // Professional, customer-focused status messaging suitable for a premium brand
  const statusConfig = {
    pending: { 
      color: '#10b981', 
      title: 'Order Confirmation', 
      quote: '"Bringing the purity of nature to your doorstep."', 
      msg: 'Thank you for choosing Bhumivera. We have successfully received your order and our fulfillment team is currently preparing your natural formulations. We will notify you via email once your package is dispatched.' 
    },
    processing: { 
      color: '#3b82f6', 
      title: 'Order Processing', 
      quote: '"Carefully curating your botanical essentials."', 
      msg: 'Your order is currently processing. Our quality assurance team is performing final checks and securely packaging your items to ensure they arrive in pristine condition.' 
    },
    shipped: { 
      color: '#f59e0b', 
      title: 'Order Dispatched', 
      quote: '"Your journey to natural wellness is on its way."', 
      msg: 'Great news! Your Bhumivera package has been dispatched from our central fulfillment center and is now with our logistics partners. You can track the transit status using the details provided below.' 
    },
    delivered: { 
      color: '#10b981', 
      title: 'Order Delivered', 
      quote: '"Experience the essence of earth, delivered."', 
      msg: 'Your order has been officially marked as delivered. We hope you enjoy your Bhumivera formulations. Please ensure all safety seals are intact before use. If you have any questions, our support team is always here to help.' 
    },
    cancelled: { 
      color: '#ef4444', 
      title: 'Order Cancelled', 
      quote: '"Your transaction has been formally voided."', 
      msg: 'As requested, or due to a payment processing issue, your order has been cancelled. Any authorized charges will be reversed and returned to your original payment method according to your bank\'s standard processing times.' 
    },
    returned: { 
      color: '#8b5cf6', 
      title: 'Return Received', 
      quote: '"Processing your returned items."', 
      msg: 'We have successfully received your returned items at our facility. Our quality assurance team is currently inspecting the package and will process your refund or replacement shortly based on our return policy.' 
    }
  };

  const config = statusConfig[status.toLowerCase()] || statusConfig.pending;
  
  const trackingHtml = (trackingNumber && courier) ? `
      <div style="background-color: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 6px; padding: 20px; margin-top: 30px;">
        <h4 style="margin: 0 0 10px 0; color: #166534; font-size: 14px; text-transform: uppercase; letter-spacing: 1px;">Tracking Information</h4>
        <p style="margin: 0 0 5px 0; color: #374151; font-size: 15px;"><strong>Courier:</strong> ${courier}</p>
        <p style="margin: 0 0 20px 0; color: #374151; font-size: 15px;"><strong>Tracking Number:</strong> <span style="font-family: monospace; background: #e2e8f0; padding: 3px 8px; border-radius: 4px;">${trackingNumber}</span></p>
        <a href="https://www.google.com/search?q=${trackingNumber}+${courier}+tracking" style="display: inline-block; background-color: #10b981; color: #ffffff; text-decoration: none; padding: 12px 24px; border-radius: 4px; font-size: 13px; font-weight: bold; text-align: center;">Track Your Package</a>
      </div>` : '';

  const htmlTemplate = `
    <!DOCTYPE html>
    <html lang="en">
    <body style="margin: 0; padding: 40px 20px; background-color: #f4f7f6; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; color: #333333; -webkit-font-smoothing: antialiased;">
      <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.05);">
        
        <div style="padding: 30px; text-align: center; border-bottom: 3px solid #10b981; background-color: #ffffff;">
          <h1 style="color: #064e3b; margin: 0; font-size: 26px; letter-spacing: 2px; font-weight: 700; text-transform: uppercase;">BHUMIVERA</h1>
          <p style="color: #10b981; margin: 5px 0 0 0; font-size: 12px; letter-spacing: 1.5px; text-transform: uppercase; font-weight: 600;">Pure Botanical Science</p>
        </div>

        <div style="padding: 30px 40px 10px 40px; text-align: center;">
          <p style="color: #4b5563; font-style: italic; font-size: 18px; line-height: 1.6; font-weight: 300;">${config.quote}</p>
        </div>

        <div style="padding: 20px 40px 40px 40px;">
          <h2 style="color: ${config.color}; margin-top: 0; font-size: 22px; font-weight: 600;">${config.title}</h2>
          <p style="color: #6b7280; font-size: 13px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 25px;">Order ID: <strong style="color: #111827;">#${formattedId}</strong></p>

          <p style="font-size: 16px; margin-bottom: 20px; color: #1f2937;">Dear ${name},</p>
          <p style="font-size: 15px; line-height: 1.7; color: #4b5563; margin-bottom: 30px;">${config.msg}</p>

          ${trackingHtml}
        </div>

        <div style="background-color: #f8fafc; padding: 30px 40px; border-top: 1px solid #e2e8f0;">
          <h3 style="margin: 0 0 10px 0; font-size: 14px; color: #1e293b; text-transform: uppercase; letter-spacing: 0.5px;">Need Assistance?</h3>
          <p style="margin: 0 0 25px 0; font-size: 14px; color: #64748b; line-height: 1.6;">Our customer concierge team is available to assist you with your order. Contact us anytime at <a href="mailto:support@bhumivera.com" style="color: #10b981; text-decoration: none; font-weight: 600;">support@bhumivera.com</a>.</p>

          <div style="background-color: #fffbeb; border-left: 4px solid #f59e0b; padding: 16px; margin-bottom: 25px; border-radius: 0 4px 4px 0;">
            <p style="margin: 0; font-size: 12px; color: #92400e; line-height: 1.6;">
              <strong style="text-transform: uppercase; font-size: 11px; letter-spacing: 0.5px;">Security Advisory:</strong><br/>
              Bhumivera will never ask for your account password, full credit card details, or sensitive OTPs via email. If you receive a suspicious message claiming to be from us, do not click any links and report it to our security team immediately.
            </p>
          </div>

          <div style="text-align: center; border-top: 1px solid #e2e8f0; padding-top: 20px;">
            <p style="margin: 0; font-size: 11px; color: #94a3b8; line-height: 1.6; text-transform: uppercase; letter-spacing: 0.5px;">
              &copy; ${new Date().getFullYear()} Bhumivera Science. All rights reserved.<br/>
              Asansol, West Bengal, India
            </p>
          </div>
        </div>
      </div>
    </body>
    </html>`;

  try {
    return await sendMail({
      to: email,
      subject: `[Bhumivera] Update on Order #${formattedId}`,
      html: htmlTemplate
    });
  } catch (error) {
    console.error("Mailer Error (Order Status):", error);
  }
};

module.exports = { sendMail, sendOrderStatusEmail };
