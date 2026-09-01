'use strict';

/**
 * email.service.js
 *
 * Reusable email sending service backed by Nodemailer.
 *
 * Transports supported via environment variables:
 *   - Mailtrap  (SMTP_HOST=sandbox.smtp.mailtrap.io, SMTP_PORT=2525)
 *   - Gmail     (SMTP_HOST=smtp.gmail.com, SMTP_PORT=587, app password required)
 *   - Any SMTP  (custom SMTP_HOST/PORT/USER/PASS)
 *
 * Environment:
 *   SMTP_HOST   - SMTP server hostname
 *   SMTP_PORT   - SMTP port (587 = STARTTLS, 465 = SSL, 2525 = Mailtrap)
 *   SMTP_USER   - Auth username
 *   SMTP_PASS   - Auth password / app password
 *   EMAIL_FROM  - Sender address (default: noreply@platform.com)
 *
 * In NODE_ENV=test all sends are silently skipped (no real email sent).
 */

const nodemailer = require('nodemailer');
const config = require('../config/config');

// ─── Transporter (lazy singleton) ─────────────────────────────────────────────

let _transporter = null;

const _getTransporter = () => {
    if (_transporter) return _transporter;

    _transporter = nodemailer.createTransport({
        host: config.email.host,
        port: config.email.port,
        secure: config.email.port === 465,   // true for port 465 (SSL), false for STARTTLS
        auth: {
            user: config.email.user,
            pass: config.email.pass,
        },
    });

    return _transporter;
};

// ─── Low-level send ───────────────────────────────────────────────────────────

/**
 * Send an email.
 *
 * @param {{ to: string, subject: string, html: string, text?: string }} options
 * @returns {Promise<void>}
 */
const sendEmail = async ({ to, subject, html, text }) => {
    // No-op in tests — avoids real SMTP calls and keeps tests fast
    if (config.env === 'test') return;

    const transporter = _getTransporter();

    await transporter.sendMail({
        from: `"N&A HUB" <${config.email.from}>`,
        to,
        subject,
        html,
        text: text ?? html.replace(/<[^>]+>/g, ''),   // strip HTML for text fallback
    });
};

// ─── Email Templates ──────────────────────────────────────────────────────────

/**
 * Build the verification email HTML.
 *
 * @param {{ name: string, verificationCode: string, expiresInMinutes: number }} params
 * @returns {string}
 */
const buildVerificationEmailTemplate = ({ name, verificationCode, expiresInMinutes }) => `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Verify Your Email</title>
</head>
<body style="margin:0;padding:0;background:#f4f7ff;font-family:'Segoe UI',Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f7ff;padding:40px 0;">
    <tr>
      <td align="center">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0"
               style="background:#ffffff;border-radius:12px;overflow:hidden;
                      box-shadow:0 4px 24px rgba(0,0,0,.08);">

          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,#4f46e5,#7c3aed);
                       padding:40px 48px;text-align:center;">
              <h1 style="margin:0;color:#fff;font-size:26px;font-weight:700;
                          letter-spacing:-0.5px;">N&amp;A HUB</h1>
              <p style="margin:8px 0 0;color:rgba(255,255,255,.75);font-size:14px;">
                Account Verification
              </p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:48px;">
              <p style="margin:0 0 16px;font-size:16px;color:#374151;">
                Hi <strong>${name}</strong>,
              </p>
              <p style="margin:0 0 32px;font-size:15px;color:#6b7280;line-height:1.6;">
                Use the verification code below to confirm your email address and activate your account.
                This code expires in <strong>${expiresInMinutes} minutes</strong>.
              </p>

              <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
                <tr>
                  <td align="center">
                    <div style="display:inline-block;background:#f9fafb;border:1px solid #e5e7eb;
                                color:#111827;font-size:32px;font-weight:700;letter-spacing:8px;
                                padding:18px 28px;border-radius:8px;">
                      ${verificationCode}
                    </div>
                  </td>
                </tr>
              </table>

              <p style="margin:28px 0 0;font-size:14px;color:#6b7280;line-height:1.6;text-align:center;">
                Enter this code on the N&amp;A HUB email verification page.
              </p>

              <p style="margin:32px 0 0;font-size:13px;color:#9ca3af;line-height:1.6;">
                If you didn't create an account, you can safely ignore this email.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#f9fafb;padding:24px 48px;border-top:1px solid #e5e7eb;
                       text-align:center;">
              <p style="margin:0;font-size:12px;color:#9ca3af;">
                &copy; ${new Date().getFullYear()} N&amp;A HUB. All rights reserved.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`;

/**
 * Build the two-factor authentication OTP email HTML.
 *
 * @param {{ name: string, otp: string }} params
 * @returns {string}
 */
const _twoFactorOtpTemplate = ({ name, otp }) => `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Your 2FA Code</title>
</head>
<body style="margin:0;padding:0;background:#f4f7ff;font-family:'Segoe UI',Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f7ff;padding:40px 0;">
    <tr>
      <td align="center">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0"
               style="background:#ffffff;border-radius:12px;overflow:hidden;
                      box-shadow:0 4px 24px rgba(0,0,0,.08);">

          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,#4f46e5,#7c3aed);
                       padding:40px 48px;text-align:center;">
              <h1 style="margin:0;color:#fff;font-size:26px;font-weight:700;
                          letter-spacing:-0.5px;">N&amp;A HUB</h1>
              <p style="margin:8px 0 0;color:rgba(255,255,255,.75);font-size:14px;">
                Two-Factor Authentication
              </p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:48px;">
              <p style="margin:0 0 16px;font-size:16px;color:#374151;">
                Hi <strong>${name}</strong>,
              </p>
              <p style="margin:0 0 28px;font-size:15px;color:#6b7280;line-height:1.6;">
                Use the verification code below to finish signing in. This code expires in
                <strong>5 minutes</strong>.
              </p>

              <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
                <tr>
                  <td align="center">
                    <div style="display:inline-block;background:#f9fafb;border:1px solid #e5e7eb;
                                color:#111827;font-size:32px;font-weight:700;letter-spacing:8px;
                                padding:18px 28px;border-radius:8px;">
                      ${otp}
                    </div>
                  </td>
                </tr>
              </table>

              <p style="margin:32px 0 0;font-size:13px;color:#9ca3af;line-height:1.6;">
                If you did not try to sign in, please change your password or contact support.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#f9fafb;padding:24px 48px;border-top:1px solid #e5e7eb;
                       text-align:center;">
              <p style="margin:0;font-size:12px;color:#9ca3af;">
                &copy; ${new Date().getFullYear()} N&amp;A HUB. All rights reserved.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Send an account verification email containing a one-time code.
 *
 * @param {{ name: string, email: string }} user
 * @param {string} verificationCode - one-time code, never persisted raw
 * @param {number} expiresInMinutes
 * @returns {Promise<void>}
 */
const sendVerificationEmail = async (user, verificationCode, expiresInMinutes) => {
    await sendEmail({
        to: user.email,
        subject: 'Your N&A HUB email verification code',
        html: buildVerificationEmailTemplate({ name: user.name, verificationCode, expiresInMinutes }),
    });
};

/**
 * Send a two-factor authentication email containing a one-time code.
 *
 * @param {{ name: string, email: string }} user
 * @param {string} otp
 * @returns {Promise<void>}
 */
const sendTwoFactorOtpEmail = async (user, otp) => {
    await sendEmail({
        to: user.email,
        subject: 'Your N&A HUB 2FA code',
        html: _twoFactorOtpTemplate({ name: user.name, otp }),
    });
};

module.exports = {
    sendEmail,
    sendVerificationEmail,
    sendTwoFactorOtpEmail,
    buildVerificationEmailTemplate,
};
