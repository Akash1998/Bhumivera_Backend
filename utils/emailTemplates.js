const PALETTE_A_WRAP_OPEN = '<!DOCTYPE html>\n' +
'<html lang="en">\n' +
'<body style="margin: 0; padding: 40px 20px; background-color: #FAF8F5; font-family: \'Georgia\', \'Times New Roman\', serif; color: #1F2937; -webkit-font-smoothing: antialiased;">\n' +
'  <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border: 1px solid rgba(11,36,25,0.10); border-radius: 12px; overflow: hidden; box-shadow: 0 10px 40px rgba(11,36,25,0.08);">\n' +
'    <div style="padding: 28px 40px 16px 40px; text-align: center; background-color: #ffffff;">\n' +
'      <div style="font-family: \'Georgia\', \'Times New Roman\', serif; font-size: 26px; color: #0B2419; letter-spacing: 4px; font-weight: 700;">BHUMIVERA</div>\n' +
'      <div style="margin-top: 6px; font-size: 11px; color: #8B5A2B; letter-spacing: 1.5px; text-transform: uppercase; font-weight: 600;">Pure Botanical Science</div>\n' +
'    </div>\n' +
'    <div style="height: 3px; background-color: #D4AF37;"></div>\n' +
'    <div style="padding: 32px 40px;">\n';

const PALETTE_A_WRAP_CLOSE = '    </div>\n' +
'    <div style="background-color: #FAF8F5; padding: 28px 40px; border-top: 1px solid rgba(11,36,25,0.08);">\n' +
'      <div style="text-align: center;">\n' +
'        <div style="margin-bottom: 16px;">\n' +
'          <a href="https://www.bhumivera.com/legal#privacy" style="color: #9CA3AF; text-decoration: none; font-size: 13px; margin: 0 10px;">Privacy Policy</a>\n' +
'          <a href="https://www.bhumivera.com/legal#terms" style="color: #9CA3AF; text-decoration: none; font-size: 13px; margin: 0 10px;">Terms of Service</a>\n' +
'          <a href="mailto:support@bhumivera.com" style="color: #9CA3AF; text-decoration: none; font-size: 13px; margin: 0 10px;">Contact</a>\n' +
'        </div>\n' +
'        <div style="color: #9CA3AF; font-size: 12px; line-height: 1.6;">\n' +
'          This is an automated email. Please do not reply directly to this message. For assistance, reach out to <a href="mailto:support@bhumivera.com" style="color: #8B5A2B; text-decoration: none;">support@bhumivera.com</a>.\n' +
'        </div>\n' +
'        <div style="margin-top: 12px; color: #9CA3AF; font-size: 12px;">&copy; 2026 Bhumivera. All rights reserved.</div>\n' +
'      </div>\n' +
'    </div>\n' +
'  </div>\n' +
'</body>\n' +
'</html>';

const PALETTE_B_WRAP_OPEN = '<!DOCTYPE html>\n' +
'<html lang="en">\n' +
'<body style="margin: 0; padding: 40px 20px; background-color: #0A0F1E; font-family: \'Courier New\', Courier, monospace; color: #E2E8F0; -webkit-font-smoothing: antialiased;">\n' +
'  <div style="max-width: 600px; margin: 0 auto; background-color: #0F172A; border: 1px solid rgba(34,211,238,0.2); border-radius: 12px; overflow: hidden; box-shadow: 0 10px 40px rgba(34,211,238,0.1);">\n' +
'    <div style="padding: 28px 40px 16px 40px; text-align: center; background-color: #0F172A; border-bottom: 1px solid rgba(34,211,238,0.15);">\n' +
'      <div style="font-family: \'Courier New\', Courier, monospace; font-size: 26px; color: #22D3EE; letter-spacing: 3px; font-weight: 700; text-transform: uppercase;">BHUMIVERA</div>\n' +
'      <div style="margin-top: 8px; font-size: 11px; color: rgba(34,211,238,0.6); letter-spacing: 2px; text-transform: uppercase; font-weight: 600;">ADMIN CONTROL PANEL</div>\n' +
'    </div>\n' +
'    <div style="height: 2px; background-color: rgba(34,211,238,0.6);"></div>\n' +
'    <div style="padding: 32px 40px;">\n';

const PALETTE_B_WRAP_CLOSE = '    </div>\n' +
'    <div style="background-color: #0A0F1E; padding: 28px 40px; border-top: 1px solid rgba(34,211,238,0.15);">\n' +
'      <div style="text-align: center;">\n' +
'        <div style="color: rgba(148,163,184,0.8); font-size: 12px; line-height: 1.6;">\n' +
'          You are receiving this because your email is registered as an authorized admin account. If this was not you, immediately revoke all active sessions in the admin dashboard security tab.\n' +
'        </div>\n' +
'        <div style="margin-top: 12px; color: rgba(148,163,184,0.8); font-size: 12px;">&copy; 2026 Bhumivera. All rights reserved.</div>\n' +
'      </div>\n' +
'    </div>\n' +
'  </div>\n' +
'</body>\n' +
'</html>';

const CUSTOMER_CTA = (label, link, secondary) => {
  if (secondary) {
    return '<a href="' + link + '" style="display: inline-block; border: 2px solid #0B2419; background-color: transparent; color: #0B2419; text-decoration: none; padding: 14px 28px; border-radius: 6px; font-size: 15px; font-weight: bold; text-align: center; margin: 6px;">' + label + '</a>';
  }
  return '<a href="' + link + '" style="display: inline-block; background-color: #0B2419; color: #D4AF37; text-decoration: none; padding: 14px 28px; border-radius: 6px; font-size: 15px; font-weight: bold; text-align: center; margin: 6px;">' + label + '</a>';
};

const ADMIN_CTA = (label, link) => {
  return '<a href="' + link + '" style="display: inline-block; background-color: #22D3EE; color: #0A0F1E; text-decoration: none; padding: 12px 24px; border-radius: 4px; font-size: 14px; font-weight: bold; text-align: center;">' + label + '</a>';
};

const BIG_OTP_BLOCK_OPEN = '<div style="text-align: center; margin: 28px 0;">\n' +
'  <div style="display: inline-block; background: linear-gradient(135deg, #0B2419 0%, #1a3a2c 100%); border: 2px solid #D4AF37; border-radius: 10px; padding: 24px 48px;">\n' +
'    <div style="font-family: \'Courier New\', Courier, monospace; font-size: 42px; letter-spacing: 12px; color: #D4AF37; font-weight: 700;">';
const BIG_OTP_BLOCK_CLOSE = '</div>\n  </div>\n</div>';

const ADMIN_OTP_BLOCK_OPEN = '<div style="text-align: center; margin: 28px 0;">\n' +
'  <div style="display: inline-block; background-color: #020617; border: 1px solid rgba(34,211,238,0.3); border-radius: 6px; padding: 16px 32px;">\n' +
'    <code style="font-family: \'Courier New\', Courier, monospace; font-size: 28px; letter-spacing: 10px; color: #22D3EE; font-weight: 700;">';
const ADMIN_OTP_BLOCK_CLOSE = '</code>\n  </div>\n</div>';

const P = (text, color) => '<p style="color: ' + (color || '#1F2937') + '; font-size: 15px; line-height: 1.7; margin: 0 0 16px 0;">' + text + '</p>';
const GREET_OPEN = '<p style="color: #0B2419; font-size: 18px; line-height: 1.7; margin: 0 0 20px 0; font-weight: 600;">Dear ';
const GREET_CLOSE = ',</p>';
const WARN_OPEN = '<div style="background-color: #FEF3C7; border-left: 4px solid #D4AF37; padding: 16px 20px; border-radius: 0 6px 6px 0; margin: 20px 0;">\n' +
'  <p style="color: #78350F; font-size: 14px; line-height: 1.6; margin: 0;">';
const WARN_CLOSE = '</p>\n</div>';
const CARD_OPEN = '<div style="background-color: #F9FAFB; border: 1px solid rgba(11,36,25,0.10); border-radius: 8px; padding: 20px 24px; margin: 20px 0;">\n' +
'  <table style="width: 100%; border-collapse: collapse;">';
const CARD_CLOSE = '  </table>\n</div>';
const ROW = (label, value) => '<tr>\n' +
'  <td style="padding: 8px 0; color: #6B7280; font-size: 13px; text-transform: uppercase; letter-spacing: 0.5px; vertical-align: top; width: 40%;">' + label + '</td>\n' +
'  <td style="padding: 8px 0; color: #1F2937; font-size: 14px; line-height: 1.5; vertical-align: top; font-weight: 500;">' + value + '</td>\n' +
'</tr>';

const TEMPLATES = {
  registration_otp: {
    subject: "Verify your email to join the Bhumivera registry",
    html: PALETTE_A_WRAP_OPEN +
      GREET_OPEN + "${name||'Valued Guest'}" + GREET_CLOSE +
      P("We received a request to create a Bhumivera account using <strong>${email}</strong>. To complete your registration, please use the one-time verification code below.") +
      BIG_OTP_BLOCK_OPEN + "${otp}" + BIG_OTP_BLOCK_CLOSE +
      P("Or verify via secure link:") +
      '<div style="text-align: center; margin: 16px 0;">\n' +
      '${verifyLink ? \'<a href="\' + verifyLink + \'" style="display: inline-block; background-color: #0B2419; color: #D4AF37; text-decoration: none; padding: 14px 28px; border-radius: 6px; font-size: 15px; font-weight: bold; text-align: center; margin: 6px;">Or verify via secure link</a>\' : ""}' +
      '\n</div>\n' +
      WARN_OPEN + "This code will expire in 10 minutes." + WARN_CLOSE +
      PALETTE_A_WRAP_CLOSE,
    text: "Your Bhumivera registration OTP is: ${otp}. It expires in 10 minutes. Verify link: ${verifyLink}",
    palette: 'customer'
  },

  welcome: {
    subject: "Welcome to Bhumivera, ${name||'friend'} \u{1F33F}",
    html: PALETTE_A_WRAP_OPEN +
      '<div style="text-align: center; margin-bottom: 24px;">\n  <div style="font-size: 48px; margin-bottom: 16px;">\u{1F33F}</div>\n</div>\n' +
      GREET_OPEN + "${name||'friend'}" + GREET_CLOSE +
      P("On behalf of the entire Bhumivera team, welcome to our community of botanical enthusiasts. We are thrilled to have you join us on this journey toward pure, science-backed natural wellness.") +
      P("Your account has been successfully created. Here is what you can do next:") +
      '<ul style="color: #1F2937; font-size: 15px; line-height: 2; margin: 16px 0 24px 20px; padding: 0;">\n' +
      '  <li>Browse our curated collection of premium botanical formulations</li>\n' +
      '  <li>Save favorites to your wishlist for quick access</li>\n' +
      '  <li>Track orders and manage your profile from one central dashboard</li>\n' +
      '</ul>\n' +
      '<div style="text-align: center; margin: 28px 0;">\n' +
      '  ' + CUSTOMER_CTA('Start Shopping', 'https://www.bhumivera.com/shop', false) + '\n' +
      '  ' + CUSTOMER_CTA('Your Account', 'https://www.bhumivera.com/profile', true) + '\n' +
      '</div>\n' +
      P("If you have any questions along the way, our concierge team is always here to help.") +
      PALETTE_A_WRAP_CLOSE,
    text: "Welcome to Bhumivera, ${name||'friend'}! Start shopping at https://www.bhumivera.com/shop or visit your account at https://www.bhumivera.com/profile.",
    palette: 'customer'
  },

  login_otp_admin: {
    subject: "[Bhumivera Admin] One-Time Login Code",
    html: PALETTE_B_WRAP_OPEN +
      '<p style="color: #E2E8F0; font-size: 15px; line-height: 1.7; margin: 0 0 16px 0;">A login request was initiated for the Bhumivera Admin Control Panel using the following account:</p>\n' +
      '<div style="background-color: #020617; border: 1px solid rgba(34,211,238,0.2); border-radius: 6px; padding: 16px 20px; margin: 20px 0;">\n' +
      '  <div style="color: rgba(34,211,238,0.7); font-size: 12px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px;">Account Email</div>\n' +
      '  <div style="color: #E2E8F0; font-size: 16px; font-family: \'Courier New\', Courier, monospace;">${email}</div>\n' +
      '  ${name ? \'<div style="margin-top: 12px; color: rgba(34,211,238,0.7); font-size: 12px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px;">Admin Name</div><div style="color: #E2E8F0; font-size: 16px;">\' + name + \'</div>\' : ""}\n' +
      '</div>\n' +
      '<p style="color: #E2E8F0; font-size: 15px; line-height: 1.7; margin: 0 0 16px 0;">Please use the following one-time verification code to complete your authentication:</p>\n' +
      ADMIN_OTP_BLOCK_OPEN + "${otp}" + ADMIN_OTP_BLOCK_CLOSE +
      '<p style="color: #94A3B8; font-size: 15px; line-height: 1.7; margin: 0 0 16px 0;">This code is single-use and will expire in 10 minutes.</p>\n' +
      PALETTE_B_WRAP_CLOSE,
    text: "[Bhumivera Admin] One-Time Login Code for ${email}: ${otp}. Expires in 10 minutes.",
    palette: 'admin'
  },

  new_login_alert: {
    subject: "New login to your Bhumivera account",
    html: PALETTE_A_WRAP_OPEN +
      '<div style="background-color: #FEF3C7; border-left: 4px solid #D4AF37; padding: 16px 20px; border-radius: 0 6px 6px 0; margin-bottom: 24px;">\n' +
      '  <p style="color: #78350F; font-size: 14px; font-weight: 600; line-height: 1.6; margin: 0;">\u{1F512} SECURITY ALERT</p>\n' +
      '</div>\n' +
      GREET_OPEN + "${name||'Valued Guest'}" + GREET_CLOSE +
      P("A new sign-in to <strong>${email}</strong> was just recorded. Below are the details of this login event:") +
      CARD_OPEN +
      ROW('IP Address', "${ip||'unknown'}") +
      '${city ? \'' + ROW('Approx. Location', "' + city + '") + '\' : ""}' +
      ROW('Device', "${deviceName||'Unknown'}") +
      ROW('Browser / OS', "${userAgentSummary||'Unknown'}") +
      ROW('Time', "${occurredAt||new Date().toLocaleString()}") +
      CARD_CLOSE +
      WARN_OPEN + "If this was you, no action is needed. If this was NOT you, please secure your account immediately by reviewing active sessions and changing your password." + WARN_CLOSE +
      '<div style="text-align: center; margin: 24px 0;">\n' +
      '  ' + CUSTOMER_CTA('Review & Sign Out of All Sessions', 'https://www.bhumivera.com/profile?tab=security', false) + '\n' +
      '</div>\n' +
      PALETTE_A_WRAP_CLOSE,
    text: "New login to your Bhumivera account (${email}). IP: ${ip||'unknown'}, Device: ${deviceName||'Unknown'}, Browser/OS: ${userAgentSummary||'Unknown'}, Time: ${occurredAt||new Date().toLocaleString()}. Review sessions: https://www.bhumivera.com/profile?tab=security",
    palette: 'customer'
  },

  new_device_challenge: {
    subject: "Verify your new sign-in device",
    html: PALETTE_A_WRAP_OPEN +
      '<div style="background-color: #EFF6FF; border-left: 4px solid #0B2419; padding: 16px 20px; border-radius: 0 6px 6px 0; margin-bottom: 24px;">\n' +
      '  <p style="color: #0B2419; font-size: 14px; font-weight: 600; line-height: 1.6; margin: 0;">\u{1F4E1} NEW DEVICE DETECTED</p>\n' +
      '</div>\n' +
      GREET_OPEN + "${name||'Valued Guest'}" + GREET_CLOSE +
      P("We noticed a sign-in attempt from a new device or location. To keep your account secure, please verify this was you.") +
      CARD_OPEN +
      ROW('IP Address', "${ip||'unknown'}") +
      ROW('Browser / Device', "${userAgentSummary||'Unknown'}") +
      CARD_CLOSE +
      P("Please enter the 6-digit verification code below OR click the one-click link:") +
      BIG_OTP_BLOCK_OPEN + "${code}" + BIG_OTP_BLOCK_CLOSE +
      '<div style="text-align: center; margin: 20px 0;">\n' +
      '${oneClickLink ? \'<a href="\' + oneClickLink + \'" style="display: inline-block; background-color: #0B2419; color: #D4AF37; text-decoration: none; padding: 14px 28px; border-radius: 6px; font-size: 15px; font-weight: bold; text-align: center; margin: 6px;">Yes, this was me</a>\' : ""}' +
      '\n</div>\n' +
      PALETTE_A_WRAP_CLOSE,
    text: "New device sign-in challenge. Verification code: ${code}. One-click link: ${oneClickLink}. IP: ${ip||'unknown'}, Browser: ${userAgentSummary||'Unknown'}",
    palette: 'customer'
  },

  password_reset_otp: {
    subject: "Bhumivera \u2014 Password Reset Code",
    html: PALETTE_A_WRAP_OPEN +
      GREET_OPEN + "${name||'Valued Guest'}" + GREET_CLOSE +
      P("You requested to reset the password for <strong>${email}</strong>. Use this 6-digit code in the reset form.") +
      BIG_OTP_BLOCK_OPEN + "${otp}" + BIG_OTP_BLOCK_CLOSE +
      '${resetLink ? \'<div style="text-align: center; margin: 16px 0;"><a href="\' + resetLink + \'" style="display: inline-block; background-color: #0B2419; color: #D4AF37; text-decoration: none; padding: 14px 28px; border-radius: 6px; font-size: 15px; font-weight: bold; text-align: center; margin: 6px;">Reset via secure link</a></div>\' : ""}' +
      WARN_OPEN + "This code will expire in 10 minutes. If you did not request this, please disregard \u2014 your password remains unchanged." + WARN_CLOSE +
      PALETTE_A_WRAP_CLOSE,
    text: "Bhumivera password reset OTP for ${email}: ${otp}. Expires in 10 minutes. Reset link: ${resetLink}. If you did not request this, your password remains unchanged.",
    palette: 'customer'
  },

  password_changed_confirmation: {
    subject: "Your Bhumivera password was just changed",
    html: PALETTE_A_WRAP_OPEN +
      '<div style="background-color: #DCFCE7; border-left: 4px solid #16A34A; padding: 16px 20px; border-radius: 0 6px 6px 0; margin-bottom: 24px;">\n' +
      '  <p style="color: #14532D; font-size: 14px; font-weight: 600; line-height: 1.6; margin: 0;">\u2705 PASSWORD CHANGED SUCCESSFULLY</p>\n' +
      '</div>\n' +
      GREET_OPEN + "${name||'Valued Guest'}" + GREET_CLOSE +
      P("Your account password was successfully changed. Below are the details of this event:") +
      CARD_OPEN +
      ROW('Time', "${occurredAt}") +
      ROW('IP Address', "${ip}") +
      ROW('Browser / Device', "${userAgentSummary||'Unknown browser'}") +
      CARD_CLOSE +
      WARN_OPEN + "If this was NOT you, reset your password immediately and revoke all active sessions in your account security settings." + WARN_CLOSE +
      '<div style="text-align: center; margin: 24px 0;">\n' +
      '  ' + CUSTOMER_CTA('Review Sessions', 'https://www.bhumivera.com/profile?tab=security', false) + '\n' +
      '</div>\n' +
      PALETTE_A_WRAP_CLOSE,
    text: "Your Bhumivera password was changed at ${occurredAt} from IP ${ip} (${userAgentSummary||'Unknown browser'}). If this was NOT you, reset your password and review sessions at https://www.bhumivera.com/profile?tab=security",
    palette: 'customer'
  },

  magic_link: {
    subject: "Your Bhumivera sign-in link",
    html: PALETTE_A_WRAP_OPEN +
      GREET_OPEN + "${name||'friend'}" + GREET_CLOSE +
      P("Click the button below to sign in to your Bhumivera account securely.") +
      '<div style="text-align: center; margin: 32px 0;">\n' +
      '  <a href="${magicLink}" style="display: inline-block; background-color: #0B2419; color: #D4AF37; text-decoration: none; padding: 20px 48px; border-radius: 8px; font-size: 18px; font-weight: bold; text-align: center; letter-spacing: 1px;">Sign In Securely</a>\n' +
      '</div>\n' +
      WARN_OPEN + "This link is single-use and expires in 15 minutes. If you didn\u2019t request this, ignore this email and your account will remain secure." + WARN_CLOSE +
      PALETTE_A_WRAP_CLOSE,
    text: "Your Bhumivera sign-in link (single-use, expires in 15 minutes): ${magicLink}. If you didn't request this, ignore this email.",
    palette: 'customer'
  },

  admin_forgot_otp: {
    subject: "[Bhumivera Admin] Password Reset OTP",
    html: PALETTE_B_WRAP_OPEN +
      '<p style="color: #E2E8F0; font-size: 15px; line-height: 1.7; margin: 0 0 16px 0;">An admin password reset request was submitted for the following account:</p>\n' +
      '<div style="background-color: #020617; border: 1px solid rgba(34,211,238,0.2); border-radius: 6px; padding: 16px 20px; margin: 20px 0;">\n' +
      '  <div style="color: rgba(34,211,238,0.7); font-size: 12px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px;">Admin Email</div>\n' +
      '  <div style="color: #E2E8F0; font-size: 16px; font-family: \'Courier New\', Courier, monospace;">${email}</div>\n' +
      '</div>\n' +
      '<p style="color: #E2E8F0; font-size: 15px; line-height: 1.7; margin: 0 0 16px 0;">Use this 6-digit code in the admin reset form to proceed:</p>\n' +
      ADMIN_OTP_BLOCK_OPEN + "${otp}" + ADMIN_OTP_BLOCK_CLOSE +
      '<p style="color: #94A3B8; font-size: 15px; line-height: 1.7; margin: 0 0 16px 0;">This code will expire in 10 minutes. If you did not initiate this request, no further action is required.</p>\n' +
      PALETTE_B_WRAP_CLOSE,
    text: "[Bhumivera Admin] Password reset OTP for ${email}: ${otp}. Expires in 10 minutes.",
    palette: 'admin'
  },

  account_locked: {
    subject: "Security alert: your Bhumivera account has been temporarily locked",
    html: PALETTE_A_WRAP_OPEN +
      '<div style="background-color: #FEE2E2; border-left: 4px solid #DC2626; padding: 16px 20px; border-radius: 0 6px 6px 0; margin-bottom: 24px;">\n' +
      '  <p style="color: #991B1B; font-size: 14px; font-weight: 600; line-height: 1.6; margin: 0;">\u{1F510} ACCOUNT TEMPORARILY LOCKED</p>\n' +
      '</div>\n' +
      GREET_OPEN + "${name||'Valued Guest'}" + GREET_CLOSE +
      P("After <strong>${attemptsCount||6}</strong> failed sign-in attempts, your account <strong>${email}</strong> has been locked as a security precaution to protect you from brute-force attacks.") +
      CARD_OPEN +
      ROW('Locked Until', "${unlockTimeIso ? unlockTimeIso : '~' + Math.ceil((unlockEpochSec||0)/60) + ' minutes from now'}") +
      ROW('Failed Attempts', "${attemptsCount||6}") +
      CARD_CLOSE +
      P("To regain access immediately, please reset your password via the forgot-password flow. Your account will automatically unlock once the lock period expires.") +
      '<div style="text-align: center; margin: 24px 0;">\n' +
      '  ' + CUSTOMER_CTA('Reset Password Now', 'https://www.bhumivera.com/forgot-password', false) + '\n' +
      '</div>\n' +
      PALETTE_A_WRAP_CLOSE,
    text: "Security alert: your Bhumivera account (${email}) has been temporarily locked after ${attemptsCount||6} failed attempts. Locked until: ${unlockTimeIso ? unlockTimeIso : '~' + Math.ceil((unlockEpochSec||0)/60) + ' minutes from now'}. Reset password at https://www.bhumivera.com/forgot-password",
    palette: 'customer'
  },

  google_account_linked: {
    subject: "Google sign-in linked to your Bhumivera account",
    html: PALETTE_A_WRAP_OPEN +
      '<div style="text-align: center; margin-bottom: 24px;">\n  <div style="font-size: 48px; margin-bottom: 16px;">\u{1F517}</div>\n</div>\n' +
      GREET_OPEN + "${name||'Valued Guest'}" + GREET_CLOSE +
      '${newAccount ? \'' + P("Your Bhumivera account has been created using your Google account <strong>${email}</strong> ${googleDisplayName ? \'(\' + \'<strong>\' + googleDisplayName + \'</strong>\' + \')\' : \'\'}. Welcome to the Bhumivera community!") + '\' : \'' + P("Your existing Bhumivera account (<strong>${email}</strong>) was just successfully linked to your Google account (<strong>${googleDisplayName||email}</strong>).") + '\'}' +
      '${newAccount ? "" : \'' + P("Going forward, you can use either your Bhumivera credentials or Google sign-in to access your account.") + '\'}' +
      '<div style="text-align: center; margin: 24px 0;">\n' +
      '  ' + CUSTOMER_CTA('Visit Your Profile', 'https://www.bhumivera.com/profile', false) + '\n' +
      '</div>\n' +
      PALETTE_A_WRAP_CLOSE,
    text: "Google sign-in linked to your Bhumivera account. ${newAccount ? 'Account created using Google: ' : 'Linked to Google: '}${email} (${googleDisplayName||email}). Visit: https://www.bhumivera.com/profile",
    palette: 'customer'
  }
};

function substitute(str, vars) {
  if (typeof str !== 'string') return str;
  return str.replace(/\$\{\s*([\s\S]*?)\s*\}/g, (m, expr) => {
    try {
      const keys = Object.keys(vars);
      const values = Object.values(vars);
      return new Function(...keys, "\"use strict\"; return (" + expr + ");")(...values) ?? '';
    } catch (e) { return ''; }
  });
}

function renderTemplate(name, vars) {
  vars = vars || {};
  const raw = TEMPLATES[name];
  if (!raw) throw new Error("Unknown email template: " + name);
  return {
    subject: substitute(raw.subject, vars),
    html: substitute(raw.html, vars),
    text: substitute(raw.text, vars),
    palette: raw.palette
  };
}

async function sendTemplate(opts) {
  const to = opts.to;
  const template = opts.template;
  const vars = opts.vars || {};
  const from = opts.from;
  if (!TEMPLATES[template]) throw new Error("Unknown email template: " + template);
  const rendered = renderTemplate(template, vars);
  const subject = rendered.subject;
  const html = rendered.html;
  const text = rendered.text;
  try {
    const { sendMail } = require('./mail');
    return await sendMail({ to: to, subject: subject, html: html, text: text, from: from });
  } catch (err) {
    if (process.env.NODE_ENV !== 'production') {
      console.log("[sendTemplate] Mail transport unavailable; would send " + template + " to " + to + ": subject=" + subject + "\nHTML preview 200 chars: " + html.slice(0, 200) + "\nTEXT: " + text.slice(0, 200) + "\nRaw error: " + (err && err.message));
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
      name: name,
      palette: t.palette,
      subject: rendered.subject,
      htmlLen: rendered.html.length,
      textLen: rendered.text.length
    };
  });
}

module.exports = {
  TEMPLATES: TEMPLATES,
  substitute: substitute,
  renderTemplate: renderTemplate,
  sendTemplate: sendTemplate,
  renderAllForInspection: renderAllForInspection
};
