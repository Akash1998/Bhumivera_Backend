const PALETTE_A_WRAP = (content) => `<!DOCTYPE html>
<html lang="en">
<body style="margin: 0; padding: 40px 20px; background-color: #FAF8F5; font-family: 'Georgia', 'Times New Roman', serif; color: #1F2937; -webkit-font-smoothing: antialiased;">
  <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border: 1px solid rgba(11,36,25,0.10); border-radius: 12px; overflow: hidden; box-shadow: 0 10px 40px rgba(11,36,25,0.08);">
    <div style="padding: 28px 40px 16px 40px; text-align: center; background-color: #ffffff;">
      <div style="font-family: 'Georgia', 'Times New Roman', serif; font-size: 26px; color: #0B2419; letter-spacing: 4px; font-weight: 700;">BHUMIVERA</div>
      <div style="margin-top: 6px; font-size: 11px; color: #8B5A2B; letter-spacing: 1.5px; text-transform: uppercase; font-weight: 600;">Pure Botanical Science</div>
    </div>
    <div style="height: 3px; background-color: #D4AF37;"></div>
    <div style="padding: 32px 40px;">
${content}
    </div>
    <div style="background-color: #FAF8F5; padding: 28px 40px; border-top: 1px solid rgba(11,36,25,0.08);">
      <div style="text-align: center;">
        <div style="margin-bottom: 16px;">
          <a href="https://www.bhumivera.com/legal#privacy" style="color: #9CA3AF; text-decoration: none; font-size: 13px; margin: 0 10px;">Privacy Policy</a>
          <a href="https://www.bhumivera.com/legal#terms" style="color: #9CA3AF; text-decoration: none; font-size: 13px; margin: 0 10px;">Terms of Service</a>
          <a href="mailto:support@bhumivera.com" style="color: #9CA3AF; text-decoration: none; font-size: 13px; margin: 0 10px;">Contact</a>
        </div>
        <div style="color: #9CA3AF; font-size: 12px; line-height: 1.6;">
          This is an automated email. Please do not reply directly to this message. For assistance, reach out to <a href="mailto:support@bhumivera.com" style="color: #8B5A2B; text-decoration: none;">support@bhumivera.com</a>.
        </div>
        <div style="margin-top: 12px; color: #9CA3AF; font-size: 12px;">&copy; 2026 Bhumivera. All rights reserved.</div>
      </div>
    </div>
  </div>
</body>
</html>`;

const PALETTE_B_WRAP = (content) => `<!DOCTYPE html>
<html lang="en">
<body style="margin: 0; padding: 40px 20px; background-color: #0A0F1E; font-family: 'Courier New', Courier, monospace; color: #E2E8F0; -webkit-font-smoothing: antialiased;">
  <div style="max-width: 600px; margin: 0 auto; background-color: #0F172A; border: 1px solid rgba(34,211,238,0.2); border-radius: 12px; overflow: hidden; box-shadow: 0 10px 40px rgba(34,211,238,0.1);">
    <div style="padding: 28px 40px 16px 40px; text-align: center; background-color: #0F172A; border-bottom: 1px solid rgba(34,211,238,0.15);">
      <div style="font-family: 'Courier New', Courier, monospace; font-size: 26px; color: #22D3EE; letter-spacing: 3px; font-weight: 700; text-transform: uppercase;">BHUMIVERA</div>
      <div style="margin-top: 8px; font-size: 11px; color: rgba(34,211,238,0.6); letter-spacing: 2px; text-transform: uppercase; font-weight: 600;">ADMIN CONTROL PANEL</div>
    </div>
    <div style="height: 2px; background-color: rgba(34,211,238,0.6);"></div>
    <div style="padding: 32px 40px;">
${content}
    </div>
    <div style="background-color: #0A0F1E; padding: 28px 40px; border-top: 1px solid rgba(34,211,238,0.15);">
      <div style="text-align: center;">
        <div style="color: rgba(148,163,184,0.8); font-size: 12px; line-height: 1.6;">
          You are receiving this because your email is registered as an authorized admin account. If this was not you, immediately revoke all active sessions in the admin dashboard security tab.
        </div>
        <div style="margin-top: 12px; color: rgba(148,163,184,0.8); font-size: 12px;">&copy; 2026 Bhumivera. All rights reserved.</div>
      </div>
    </div>
  </div>
</body>
</html>`;

const CUSTOMER_CTA = (label, link, secondary = false) => {
  if (secondary) {
    return `<a href="${link}" style="display: inline-block; border: 2px solid #0B2419; background-color: transparent; color: #0B2419; text-decoration: none; padding: 14px 28px; border-radius: 6px; font-size: 15px; font-weight: bold; text-align: center; margin: 6px;">${label}</a>`;
  }
  return `<a href="${link}" style="display: inline-block; background-color: #0B2419; color: #D4AF37; text-decoration: none; padding: 14px 28px; border-radius: 6px; font-size: 15px; font-weight: bold; text-align: center; margin: 6px;">${label}</a>`;
};

const ADMIN_CTA = (label, link) => `<a href="${link}" style="display: inline-block; background-color: #22D3EE; color: #0A0F1E; text-decoration: none; padding: 12px 24px; border-radius: 4px; font-size: 14px; font-weight: bold; text-align: center;">${label}</a>`;

const BIG_OTP_BLOCK = (otp) => `<div style="text-align: center; margin: 28px 0;">
  <div style="display: inline-block; background: linear-gradient(135deg, #0B2419 0%, #1a3a2c 100%); border: 2px solid #D4AF37; border-radius: 10px; padding: 24px 48px;">
    <div style="font-family: 'Courier New', Courier, monospace; font-size: 42px; letter-spacing: 12px; color: #D4AF37; font-weight: 700;">${otp}</div>
  </div>
</div>`;

const ADMIN_OTP_BLOCK = (otp) => `<div style="text-align: center; margin: 28px 0;">
  <div style="display: inline-block; background-color: #020617; border: 1px solid rgba(34,211,238,0.3); border-radius: 6px; padding: 16px 32px;">
    <code style="font-family: 'Courier New', Courier, monospace; font-size: 28px; letter-spacing: 10px; color: #22D3EE; font-weight: 700;">${otp}</code>
  </div>
</div>`;

const PARA = (text) => `<p style="color: #1F2937; font-size: 15px; line-height: 1.7; margin: 0 0 16px 0;">${text}</p>`;
const PARA_ADMIN = (text, secondary = false) => `<p style="color: ${secondary ? '#94A3B8' : '#E2E8F0'}; font-size: 15px; line-height: 1.7; margin: 0 0 16px 0;">${text}</p>`;
const GREETING = (name) => `<p style="color: #0B2419; font-size: 18px; line-height: 1.7; margin: 0 0 20px 0; font-weight: 600;">Dear ${name},</p>`;
const WARNING = (text) => `<div style="background-color: #FEF3C7; border-left: 4px solid #D4AF37; padding: 16px 20px; border-radius: 0 6px 6px 0; margin: 20px 0;">
  <p style="color: #78350F; font-size: 14px; line-height: 1.6; margin: 0;">${text}</p>
</div>`;
const INFO_CARD = (rows) => `<div style="background-color: #F9FAFB; border: 1px solid rgba(11,36,25,0.10); border-radius: 8px; padding: 20px 24px; margin: 20px 0;">
  <table style="width: 100%; border-collapse: collapse;">
    ${rows}
  </table>
</div>`;
const INFO_ROW = (label, value) => `<tr>
  <td style="padding: 8px 0; color: #6B7280; font-size: 13px; text-transform: uppercase; letter-spacing: 0.5px; vertical-align: top; width: 40%;">${label}</td>
  <td style="padding: 8px 0; color: #1F2937; font-size: 14px; line-height: 1.5; vertical-align: top; font-weight: 500;">${value}</td>
</tr>`;

const registration_otp = {
  subject: "Verify your email to join the Bhumivera registry",
  html: PALETTE_A_WRAP(`${GREETING('${name||\'Valued Guest\'}')}
${PARA('We received a request to create a Bhumivera account using <strong>${email}</strong>. To complete your registration, please use the one-time verification code below.')}
${BIG_OTP_BLOCK('${otp}')}
${PARA('Or verify via secure link:')}
<div style="text-align: center; margin: 16px 0;">
  ${'${verifyLink ? CUSTOMER_CTA("Or verify via secure link", verifyLink) : ""}'.replace(/^"|"$/g, '')}
</div>
${WARNING('This code will expire in 10 minutes.')}
`),
  text: "Your Bhumivera registration OTP is: ${otp}. It expires in 10 minutes. Verify link: ${verifyLink}",
  palette: 'customer'
};

const welcome = {
  subject: "Welcome to Bhumivera, ${name||'friend'} \u{1F33F}",
  html: PALETTE_A_WRAP(`
<div style="text-align: center; margin-bottom: 24px;">
  <div style="font-size: 48px; margin-bottom: 16px;">\u{1F33F}</div>
</div>
${GREETING('${name||\'friend\'}')}
${PARA('On behalf of the entire Bhumivera team, welcome to our community of botanical enthusiasts. We are thrilled to have you join us on this journey toward pure, science-backed natural wellness.')}
${PARA('Your account has been successfully created. Here is what you can do next:')}
<ul style="color: #1F2937; font-size: 15px; line-height: 2; margin: 16px 0 24px 20px; padding: 0;">
  <li>Browse our curated collection of premium botanical formulations</li>
  <li>Save favorites to your wishlist for quick access</li>
  <li>Track orders and manage your profile from one central dashboard</li>
</ul>
<div style="text-align: center; margin: 28px 0;">
  ${CUSTOMER_CTA('Start Shopping', 'https://www.bhumivera.com/shop', false)}
  ${CUSTOMER_CTA('Your Account', 'https://www.bhumivera.com/profile', true)}
</div>
${PARA('If you have any questions along the way, our concierge team is always here to help.')}
`),
  text: "Welcome to Bhumivera, ${name||'friend'}! Start shopping at https://www.bhumivera.com/shop or visit your account at https://www.bhumivera.com/profile.",
  palette: 'customer'
};

const login_otp_admin = {
  subject: "[Bhumivera Admin] One-Time Login Code",
  html: PALETTE_B_WRAP(`${PARA_ADMIN('A login request was initiated for the Bhumivera Admin Control Panel using the following account:')}
<div style="background-color: #020617; border: 1px solid rgba(34,211,238,0.2); border-radius: 6px; padding: 16px 20px; margin: 20px 0;">
  <div style="color: rgba(34,211,238,0.7); font-size: 12px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px;">Account Email</div>
  <div style="color: #E2E8F0; font-size: 16px; font-family: 'Courier New', Courier, monospace;">${email}</div>
  ${'${name ? `<div style="margin-top: 12px; color: rgba(34,211,238,0.7); font-size: 12px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px;">Admin Name</div><div style="color: #E2E8F0; font-size: 16px;">${name}</div>` : ""}'}
</div>
${PARA_ADMIN('Please use the following one-time verification code to complete your authentication:')}
${ADMIN_OTP_BLOCK('${otp}')}
${PARA_ADMIN('This code is single-use and will expire in 10 minutes.', true)}
${WARNING ? '' : ''}
`),
  text: "[Bhumivera Admin] One-Time Login Code for ${email}: ${otp}. Expires in 10 minutes.",
  palette: 'admin'
};

const new_login_alert = {
  subject: "New login to your Bhumivera account",
  html: PALETTE_A_WRAP(`
<div style="background-color: #FEF3C7; border-left: 4px solid #D4AF37; padding: 16px 20px; border-radius: 0 6px 6px 0; margin-bottom: 24px;">
  <p style="color: #78350F; font-size: 14px; font-weight: 600; line-height: 1.6; margin: 0;">\u{1F512} SECURITY ALERT</p>
</div>
${GREETING('${name||\'Valued Guest\'}')}
${PARA('A new sign-in to <strong>${email}</strong> was just recorded. Below are the details of this login event:')}
${INFO_CARD(`${INFO_ROW('IP Address', '${ip||\'unknown\'}')}
${'${city ? INFO_ROW("Approx. Location", city) : ""}'.replace(/^"|"$/g, '')}
${INFO_ROW('Device', '${deviceName||\'Unknown\'}')}
${INFO_ROW('Browser / OS', '${userAgentSummary||\'Unknown\'}')}
${INFO_ROW('Time', '${occurredAt||new Date().toLocaleString()}')}
`)}
${WARNING('If this was you, no action is needed. If this was NOT you, please secure your account immediately by reviewing active sessions and changing your password.')}
<div style="text-align: center; margin: 24px 0;">
  ${CUSTOMER_CTA('Review & Sign Out of All Sessions', 'https://www.bhumivera.com/profile?tab=security', false)}
</div>
`),
  text: "New login to your Bhumivera account (${email}). IP: ${ip||'unknown'}, Device: ${deviceName||'Unknown'}, Browser/OS: ${userAgentSummary||'Unknown'}, Time: ${occurredAt||new Date().toLocaleString()}. Review sessions: https://www.bhumivera.com/profile?tab=security",
  palette: 'customer'
};

const new_device_challenge = {
  subject: "Verify your new sign-in device",
  html: PALETTE_A_WRAP(`
<div style="background-color: #EFF6FF; border-left: 4px solid #0B2419; padding: 16px 20px; border-radius: 0 6px 6px 0; margin-bottom: 24px;">
  <p style="color: #0B2419; font-size: 14px; font-weight: 600; line-height: 1.6; margin: 0;">\u{1F4E1} NEW DEVICE DETECTED</p>
</div>
${GREETING('${name||\'Valued Guest\'}')}
${PARA('We noticed a sign-in attempt from a new device or location. To keep your account secure, please verify this was you.')}
${INFO_CARD(`${INFO_ROW('IP Address', '${ip||\'unknown\'}')}
${INFO_ROW('Browser / Device', '${userAgentSummary||\'Unknown\'}')}
`)}
${PARA('Please enter the 6-digit verification code below OR click the one-click link:')}
${BIG_OTP_BLOCK('${code}')}
<div style="text-align: center; margin: 20px 0;">
  ${'${oneClickLink ? CUSTOMER_CTA("Yes, this was me", oneClickLink) : ""}'.replace(/^"|"$/g, '')}
</div>
`),
  text: "New device sign-in challenge. Verification code: ${code}. One-click link: ${oneClickLink}. IP: ${ip||'unknown'}, Browser: ${userAgentSummary||'Unknown'}",
  palette: 'customer'
};

const password_reset_otp = {
  subject: "Bhumivera — Password Reset Code",
  html: PALETTE_A_WRAP(`${GREETING('${name||\'Valued Guest\'}')}
${PARA('You requested to reset the password for <strong>${email}</strong>. Use this 6-digit code in the reset form.')}
${BIG_OTP_BLOCK('${otp}')}
${'${resetLink ? `<div style="text-align: center; margin: 16px 0;">${CUSTOMER_CTA("Reset via secure link", resetLink, false)}</div>` : ""}'.replace(/^"|"$/g, '')}
${WARNING('This code will expire in 10 minutes. If you did not request this, please disregard — your password remains unchanged.')}
`),
  text: "Bhumivera password reset OTP for ${email}: ${otp}. Expires in 10 minutes. Reset link: ${resetLink}. If you did not request this, your password remains unchanged.",
  palette: 'customer'
};

const password_changed_confirmation = {
  subject: "Your Bhumivera password was just changed",
  html: PALETTE_A_WRAP(`
<div style="background-color: #DCFCE7; border-left: 4px solid #16A34A; padding: 16px 20px; border-radius: 0 6px 6px 0; margin-bottom: 24px;">
  <p style="color: #14532D; font-size: 14px; font-weight: 600; line-height: 1.6; margin: 0;">\u2705 PASSWORD CHANGED SUCCESSFULLY</p>
</div>
${GREETING('${name||\'Valued Guest\'}')}
${PARA('Your account password was successfully changed. Below are the details of this event:')}
${INFO_CARD(`${INFO_ROW('Time', '${occurredAt}')}
${INFO_ROW('IP Address', '${ip}')}
${INFO_ROW('Browser / Device', '${userAgentSummary||\'Unknown browser\'}')}
`)}
${WARNING('If this was NOT you, reset your password immediately and revoke all active sessions in your account security settings.')}
<div style="text-align: center; margin: 24px 0;">
  ${CUSTOMER_CTA('Review Sessions', 'https://www.bhumivera.com/profile?tab=security', false)}
</div>
`),
  text: "Your Bhumivera password was changed at ${occurredAt} from IP ${ip} (${userAgentSummary||'Unknown browser'}). If this was NOT you, reset your password and review sessions at https://www.bhumivera.com/profile?tab=security",
  palette: 'customer'
};

const magic_link = {
  subject: "Your Bhumivera sign-in link",
  html: PALETTE_A_WRAP(`${GREETING('${name||\'friend\'}')}
${PARA('Click the button below to sign in to your Bhumivera account securely.')}
<div style="text-align: center; margin: 32px 0;">
  <a href="${magicLink}" style="display: inline-block; background-color: #0B2419; color: #D4AF37; text-decoration: none; padding: 20px 48px; border-radius: 8px; font-size: 18px; font-weight: bold; text-align: center; letter-spacing: 1px;">Sign In Securely</a>
</div>
${WARNING('This link is single-use and expires in 15 minutes. If you didn\'t request this, ignore this email and your account will remain secure.')}
`),
  text: "Your Bhumivera sign-in link (single-use, expires in 15 minutes): ${magicLink}. If you didn't request this, ignore this email.",
  palette: 'customer'
};

const admin_forgot_otp = {
  subject: "[Bhumivera Admin] Password Reset OTP",
  html: PALETTE_B_WRAP(`${PARA_ADMIN('An admin password reset request was submitted for the following account:')}
<div style="background-color: #020617; border: 1px solid rgba(34,211,238,0.2); border-radius: 6px; padding: 16px 20px; margin: 20px 0;">
  <div style="color: rgba(34,211,238,0.7); font-size: 12px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px;">Admin Email</div>
  <div style="color: #E2E8F0; font-size: 16px; font-family: 'Courier New', Courier, monospace;">${email}</div>
</div>
${PARA_ADMIN('Use this 6-digit code in the admin reset form to proceed:')}
${ADMIN_OTP_BLOCK('${otp}')}
${PARA_ADMIN('This code will expire in 10 minutes. If you did not initiate this request, no further action is required.', true)}
`),
  text: "[Bhumivera Admin] Password reset OTP for ${email}: ${otp}. Expires in 10 minutes.",
  palette: 'admin'
};

const account_locked = {
  subject: "Security alert: your Bhumivera account has been temporarily locked",
  html: PALETTE_A_WRAP(`
<div style="background-color: #FEE2E2; border-left: 4px solid #DC2626; padding: 16px 20px; border-radius: 0 6px 6px 0; margin-bottom: 24px;">
  <p style="color: #991B1B; font-size: 14px; font-weight: 600; line-height: 1.6; margin: 0;">\u{1F510} ACCOUNT TEMPORARILY LOCKED</p>
</div>
${GREETING('${name||\'Valued Guest\'}')}
${PARA('After <strong>${attemptsCount||6}</strong> failed sign-in attempts, your account <strong>${email}</strong> has been locked as a security precaution to protect you from brute-force attacks.')}
${INFO_CARD(`${INFO_ROW('Locked Until', '${unlockTimeIso || `~${Math.ceil((unlockEpochSec||0)/60)} minutes from now`}'.replace(/^"|"$/g, ''))}
${INFO_ROW('Failed Attempts', '${attemptsCount||6}')}
`)}
${PARA('To regain access immediately, please reset your password via the forgot-password flow. Your account will automatically unlock once the lock period expires.')}
<div style="text-align: center; margin: 24px 0;">
  ${CUSTOMER_CTA('Reset Password Now', 'https://www.bhumivera.com/forgot-password', false)}
</div>
`),
  text: "Security alert: your Bhumivera account (${email}) has been temporarily locked after ${attemptsCount||6} failed attempts. Locked until: ${unlockTimeIso || `~${Math.ceil((unlockEpochSec||0)/60)} minutes from now`}. Reset password at https://www.bhumivera.com/forgot-password",
  palette: 'customer'
};

const google_account_linked = {
  subject: "Google sign-in linked to your Bhumivera account",
  html: PALETTE_A_WRAP(`
<div style="text-align: center; margin-bottom: 24px;">
  <div style="font-size: 48px; margin-bottom: 16px;">\u{1F517}</div>
</div>
${GREETING('${name||\'Valued Guest\'}')}
${'${newAccount ? PARA(`Your Bhumivera account has been created using your Google account <strong>${email}</strong> ${googleDisplayName ? `(<strong>${googleDisplayName}</strong>)` : ""}. Welcome to the Bhumivera community!`) : PARA(`Your existing Bhumivera account (<strong>${email}</strong>) was just successfully linked to your Google account (<strong>${googleDisplayName||email}</strong>).`)}'.replace(/^"|"$/g, '')}
${newAccount ? '' : PARA('Going forward, you can use either your Bhumivera credentials or Google sign-in to access your account.')}
<div style="text-align: center; margin: 24px 0;">
  ${CUSTOMER_CTA('Visit Your Profile', 'https://www.bhumivera.com/profile', false)}
</div>
`),
  text: "Google sign-in linked to your Bhumivera account. ${newAccount ? 'Account created using Google: ' : 'Linked to Google: '}${email} (${googleDisplayName||email}). Visit: https://www.bhumivera.com/profile",
  palette: 'customer'
};

const TEMPLATES = {
  registration_otp,
  welcome,
  login_otp_admin,
  new_login_alert,
  new_device_challenge,
  password_reset_otp,
  password_changed_confirmation,
  magic_link,
  admin_forgot_otp,
  account_locked,
  google_account_linked
};

function substitute(str, vars) {
  if (typeof str !== 'string') return str;
  return str.replace(/\$\{\s*([A-Za-z0-9_$.|?:]+)\s*\}/g, (m, expr) => {
    try {
      const keys = Object.keys(vars);
      const values = Object.values(vars);
      return new Function(...keys, `"use strict"; return (${expr});`)(...values) ?? '';
    } catch (e) { return ''; }
  });
}

function renderTemplate(name, vars = {}) {
  const raw = TEMPLATES[name];
  if (!raw) throw new Error(`Unknown email template: ${name}`);
  return {
    subject: substitute(raw.subject, vars),
    html: substitute(raw.html, vars),
    text: substitute(raw.text, vars),
    palette: raw.palette
  };
}

async function sendTemplate({ to, template, vars = {}, from }) {
  if (!TEMPLATES[template]) throw new Error(`Unknown email template: ${template}`);
  const { subject, html, text } = renderTemplate(template, vars);
  try {
    const { sendMail } = require('./mail');
    return await sendMail({ to, subject, html, text, from });
  } catch (err) {
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[sendTemplate] Mail transport unavailable; would send ${template} to ${to}: subject=${subject}\nHTML preview 200 chars: ${html.slice(0, 200)}\nTEXT: ${text.slice(0, 200)}\nRaw error: ${err && err.message}`);
    }
    if (process.env.FORCE_MAIL_FAIL !== '1') {
      return Promise.resolve({ devMode: true, success: true, reason: 'Mail transport missing; logged to console.' });
    }
    throw err;
  }
}

function renderAllForInspection() {
  return Object.keys(TEMPLATES).map((name) => {
    const t = TEMPLATES[name];
    const rendered = renderTemplate(name, {});
    return {
      name,
      palette: t.palette,
      subject: rendered.subject,
      htmlLen: rendered.html.length,
      textLen: rendered.text.length
    };
  });
}

module.exports = {
  TEMPLATES,
  substitute,
  renderTemplate,
  sendTemplate,
  renderAllForInspection
};
