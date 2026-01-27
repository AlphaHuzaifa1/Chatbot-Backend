import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Email Service
 * Handles sending support ticket emails with TEST_MODE support
 */

const TEST_MODE = process.env.TEST_MODE === 'true';
const EMAIL_ENABLED = process.env.EMAIL_ENABLED !== 'false'; // Default to enabled
const LOGGING_ENABLED = process.env.LOGGING_ENABLED !== 'false'; // Default to enabled

// Email configuration from environment variables
const emailConfig = {
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: process.env.SMTP_SECURE === 'true', // true for 465, false for other ports
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASSWORD
  }
};

const supportEmail = process.env.SUPPORT_EMAIL || 'support@example.com';
const fromEmail = process.env.EMAIL_FROM || emailConfig.auth?.user || 'noreply@example.com';
const fromName = process.env.EMAIL_FROM_NAME || 'Support ChatBot';

// Create transporter (only if email is enabled and not in test mode)
let transporter = null;

if (EMAIL_ENABLED && !TEST_MODE) {
  if (!emailConfig.auth.user || !emailConfig.auth.pass) {
    console.warn('SMTP credentials not configured. Email sending will be disabled.');
  } else {
    transporter = nodemailer.createTransport({
      host: emailConfig.host,
      port: emailConfig.port,
      secure: emailConfig.secure,
      auth: emailConfig.auth
    });
  }
}

/**
 * Filter sensitive information from text
 */
const filterSensitiveData = (text) => {
  if (!text) return text;
  
  // Common patterns for sensitive data
  const sensitivePatterns = [
    /password\s*[:=]\s*\S+/gi,
    /mfa\s*(?:code|token)?\s*[:=]\s*\S+/gi,
    /auth\s*(?:code|token)?\s*[:=]\s*\S+/gi,
    /secret\s*[:=]\s*\S+/gi,
    /api[_-]?key\s*[:=]\s*\S+/gi,
    /token\s*[:=]\s*\S+/gi,
    /\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}/g, // Credit card patterns
  ];
  
  let filtered = text;
  sensitivePatterns.forEach(pattern => {
    filtered = filtered.replace(pattern, '[REDACTED]');
  });
  
  return filtered;
};

/**
 * Format email content from ticket payload
 */
export const formatTicketEmail = (ticket) => {
  const {
    referenceId,
    ticketId,
    customer,
    category,
    urgency,
    impact,
    summary,
    details,
    keyDetails
  } = ticket;

  // Filter sensitive data from summary and details
  const safeSummary = filterSensitiveData(summary);
  const safeDetails = {
    ...details,
    problemDescription: filterSensitiveData(details.problemDescription),
    followUpDetails: filterSensitiveData(details.followUpDetails),
    errorMessage: filterSensitiveData(details.errorMessage),
    additionalContext: details.additionalContext ? filterSensitiveData(details.additionalContext) : null
  };

  const safeKeyDetails = keyDetails.map(detail => filterSensitiveData(detail));

  // Format urgency and impact for display
  const urgencyDisplay = urgency ? urgency.charAt(0).toUpperCase() + urgency.slice(1) : 'Not specified';
  const impactDisplay = impact === 'blocked' ? 'Blocked/Critical' : 
                        impact === 'single_user' ? 'Single User' : 
                        'Unknown';

  // Build email subject
  const subject = `[${referenceId || ticketId}] Support Request - ${category || 'General'}`;

  // Build email body (HTML) - Professional styled template
  const htmlBody = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; 
          line-height: 1.6; 
          color: #333333; 
          background-color: #f5f5f5;
          padding: 20px;
        }
        .email-wrapper { 
          max-width: 700px; 
          margin: 0 auto; 
          background-color: #ffffff;
          border-radius: 8px;
          overflow: hidden;
          box-shadow: 0 2px 8px rgba(0,0,0,0.1);
        }
        .header { 
          background: linear-gradient(135deg, #7c3aed 0%, #9333ea 100%);
          color: #ffffff; 
          padding: 30px 40px; 
          text-align: center;
        }
        .header h1 { 
          margin: 0; 
          font-size: 24px; 
          font-weight: 700;
          letter-spacing: 0.5px;
        }
        .header .reference-id {
          margin-top: 8px;
          font-size: 16px;
          opacity: 0.95;
          font-weight: 500;
        }
        .content { 
          padding: 40px; 
          background-color: #ffffff;
        }
        .section { 
          margin-bottom: 30px; 
          background-color: #ffffff;
        }
        .section:last-child {
          margin-bottom: 0;
        }
        .section-title { 
          font-weight: 700; 
          color: #1f2937; 
          margin-bottom: 20px; 
          font-size: 18px;
          padding-bottom: 10px;
          border-bottom: 2px solid #e5e7eb;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }
        .info-table {
          width: 100%;
          border-collapse: collapse;
          margin-bottom: 20px;
        }
        .info-table td {
          padding: 12px 16px;
          border-bottom: 1px solid #f3f4f6;
          vertical-align: top;
        }
        .info-table tr:last-child td {
          border-bottom: none;
        }
        .info-table .label { 
          font-weight: 600; 
          color: #4b5563; 
          width: 180px;
          background-color: #f9fafb;
        }
        .info-table .value { 
          color: #1f2937; 
        }
        .info-table .value a {
          color: #7c3aed;
          text-decoration: none;
        }
        .info-table .value a:hover {
          text-decoration: underline;
        }
        .badge { 
          display: inline-block; 
          padding: 6px 14px; 
          border-radius: 20px; 
          font-size: 13px; 
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }
        .badge-blocked { background-color: #dc2626; color: white; }
        .badge-critical { background-color: #dc2626; color: white; }
        .badge-high { background-color: #ea580c; color: white; }
        .badge-medium { background-color: #f59e0b; color: white; }
        .badge-low { background-color: #10b981; color: white; }
        .summary-box {
          background-color: #f9fafb;
          padding: 20px;
          border-radius: 6px;
          border-left: 4px solid #7c3aed;
          margin-top: 10px;
        }
        .summary-box p {
          margin: 0;
          color: #374151;
          line-height: 1.7;
        }
        .key-details { 
          background-color: #f9fafb; 
          padding: 20px; 
          border-left: 4px solid #7c3aed; 
          border-radius: 6px;
          margin-top: 10px; 
        }
        .key-details ul { 
          margin: 0; 
          padding-left: 20px; 
          list-style: none;
        }
        .key-details li { 
          margin-bottom: 10px; 
          padding-left: 20px;
          position: relative;
          color: #374151;
        }
        .key-details li:before {
          content: "•";
          position: absolute;
          left: 0;
          color: #7c3aed;
          font-weight: bold;
          font-size: 18px;
        }
        .key-details li:last-child {
          margin-bottom: 0;
        }
        .details-section {
          background-color: #f9fafb;
          padding: 20px;
          border-radius: 6px;
          margin-top: 10px;
        }
        .details-section p {
          margin: 8px 0;
          color: #374151;
          line-height: 1.7;
        }
        .footer { 
          margin-top: 30px; 
          padding-top: 25px; 
          border-top: 2px solid #e5e7eb; 
          font-size: 13px; 
          color: #6b7280;
          text-align: center;
        }
        .footer p {
          margin: 5px 0;
        }
        .footer .reference {
          font-weight: 600;
          color: #7c3aed;
        }
        @media only screen and (max-width: 600px) {
          .content { padding: 20px; }
          .header { padding: 20px; }
          .info-table .label { width: 120px; }
        }
      </style>
    </head>
    <body>
      <div class="email-wrapper">
        <div class="header">
          <h1>Support Ticket</h1>
          <div class="reference-id">${referenceId || ticketId}</div>
        </div>
        <div class="content">
          <div class="section">
            <div class="section-title">Customer Information</div>
            <table class="info-table">
              <tr>
                <td class="label">Name:</td>
                <td class="value">${customer.fullName || 'Not provided'}</td>
              </tr>
              <tr>
                <td class="label">Company:</td>
                <td class="value">${customer.company || 'Not provided'}</td>
              </tr>
              <tr>
                <td class="label">Email:</td>
                <td class="value"><a href="mailto:${customer.email || ''}">${customer.email || 'Not provided'}</a></td>
              </tr>
              <tr>
                <td class="label">Phone:</td>
                <td class="value">${customer.phone || 'Not provided'}</td>
              </tr>
              <tr>
                <td class="label">VSA Agent/Device:</td>
                <td class="value">${customer.vsaAgentName || 'Not provided'}</td>
              </tr>
            </table>
          </div>

          <div class="section">
            <div class="section-title">Issue Details</div>
            <table class="info-table">
              <tr>
                <td class="label">Category:</td>
                <td class="value">${category ? category.charAt(0).toUpperCase() + category.slice(1) : 'Other'}</td>
              </tr>
              <tr>
                <td class="label">Urgency:</td>
                <td class="value">
                  <span class="badge badge-${urgency === 'blocked' || urgency === 'critical' ? 'critical' : (urgency === 'high' ? 'high' : (urgency === 'low' ? 'low' : 'medium'))}">${urgencyDisplay}</span>
                </td>
              </tr>
              <tr>
                <td class="label">Impact:</td>
                <td class="value">${impactDisplay}</td>
              </tr>
            </table>
          </div>

          <div class="section">
            <div class="section-title">Summary</div>
            <div class="summary-box">
              <p>${safeSummary || 'No summary provided'}</p>
            </div>
          </div>

          ${safeKeyDetails.length > 0 ? `
          <div class="section">
            <div class="section-title">Key Details</div>
            <div class="key-details">
              <ul>
                ${safeKeyDetails.map(detail => `<li>${detail}</li>`).join('')}
              </ul>
            </div>
          </div>
          ` : ''}

          <div class="section">
            <div class="section-title">Additional Information</div>
            <div class="details-section">
              ${safeDetails.problemDescription ? `
              <p><strong>Problem Description:</strong><br>${safeDetails.problemDescription}</p>
              ` : ''}
              ${safeDetails.errorMessage && safeDetails.errorMessage !== 'No error message provided' ? `
              <p><strong>Error Message:</strong><br>${safeDetails.errorMessage}</p>
              ` : ''}
              ${safeDetails.affectedSystem ? `
              <p><strong>Affected System:</strong><br>${safeDetails.affectedSystem}</p>
              ` : ''}
              ${safeDetails.additionalContext ? `
              <p><strong>Additional Context:</strong><br>${safeDetails.additionalContext}</p>
              ` : ''}
            </div>
          </div>

          <div class="footer">
            <p><span class="reference">Reference ID:</span> ${referenceId || ticketId}</p>
            <p><strong>Submitted:</strong> ${new Date().toLocaleString()}</p>
            <p style="margin-top: 15px;">
              This is an automated support ticket generated by the Support ChatBot system.
            </p>
          </div>
        </div>
      </div>
    </body>
    </html>
  `;

  // Plain text version
  const textBody = `
SUPPORT TICKET - ${referenceId || ticketId}

CUSTOMER INFORMATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Name: ${customer.fullName || 'Not provided'}
Company: ${customer.company || 'Not provided'}
Email: ${customer.email || 'Not provided'}
Phone: ${customer.phone || 'Not provided'}
VSA Agent/Device: ${customer.vsaAgentName || 'Not provided'}

ISSUE DETAILS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Category: ${category || 'Other'}
Urgency: ${urgencyDisplay}
Impact: ${impactDisplay}

SUMMARY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${safeSummary || 'No summary provided'}

${safeKeyDetails.length > 0 ? `
KEY DETAILS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${safeKeyDetails.map(detail => `• ${detail}`).join('\n')}

` : ''}
ADDITIONAL INFORMATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Problem Description: ${safeDetails.problemDescription || 'Not provided'}
${safeDetails.errorMessage && safeDetails.errorMessage !== 'No error message provided' ? `Error Message: ${safeDetails.errorMessage}\n` : ''}${safeDetails.affectedSystem ? `Affected System: ${safeDetails.affectedSystem}\n` : ''}${safeDetails.additionalContext ? `Additional Context: ${safeDetails.additionalContext}\n` : ''}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Reference ID: ${referenceId || ticketId}
Submitted: ${new Date().toLocaleString()}

This is an automated support ticket generated by the Support ChatBot system.
  `.trim();

  return {
    subject,
    html: htmlBody,
    text: textBody
  };
};

/**
 * Send support ticket email
 * Sends to the logged-in user's email instead of support email
 */
export const sendTicketEmail = async (ticket) => {
  if (!EMAIL_ENABLED) {
    if (LOGGING_ENABLED) {
      console.log('Email sending is disabled (EMAIL_ENABLED=false)');
    }
    return { success: false, skipped: true, reason: 'EMAIL_ENABLED is false' };
  }

  // Get recipient email from ticket customer info (logged-in user)
  const recipientEmail = ticket.customer?.email || ticket.customerEmail;
  
  // Validate recipient email
  if (!recipientEmail || recipientEmail === 'Not provided' || !recipientEmail.includes('@')) {
    const error = 'Recipient email not available or invalid';
    if (LOGGING_ENABLED) {
      console.error('Email send failed:', error, {
        recipientEmail,
        hasCustomer: !!ticket.customer
      });
    }
    return { success: false, error };
  }

  if (TEST_MODE) {
    // In test mode, log the email instead of sending
    const emailContent = formatTicketEmail(ticket);
    
    if (LOGGING_ENABLED) {
      console.log('='.repeat(80));
      console.log('TEST MODE: Email would be sent to:', recipientEmail);
      console.log('From:', `${fromName} <${fromEmail}>`);
      console.log('Subject:', emailContent.subject);
      console.log('-'.repeat(80));
      console.log('Email Body (Text):');
      console.log(emailContent.text);
      console.log('='.repeat(80));
    }
    
    return { success: true, testMode: true, emailContent, to: recipientEmail };
  }

  if (!transporter) {
    const error = 'SMTP transporter not configured. Check SMTP credentials.';
    if (LOGGING_ENABLED) {
      console.error('Email send failed:', error);
    }
    return { success: false, error };
  }

  try {
    const emailContent = formatTicketEmail(ticket);
    
    const mailOptions = {
      from: `"${fromName}" <${fromEmail}>`,
      to: recipientEmail,
      subject: emailContent.subject,
      text: emailContent.text,
      html: emailContent.html
    };

    const info = await transporter.sendMail(mailOptions);
    
    if (LOGGING_ENABLED) {
      console.log('Support ticket email sent successfully:', {
        messageId: info.messageId,
        to: recipientEmail,
        referenceId: ticket.referenceId || ticket.ticketId
      });
    }
    
    return { 
      success: true, 
      messageId: info.messageId,
      to: recipientEmail
    };
  } catch (error) {
    if (LOGGING_ENABLED) {
      console.error('Failed to send support ticket email:', error.message);
    }
    return { 
      success: false, 
      error: error.message 
    };
  }
};

export default {
  sendTicketEmail,
  formatTicketEmail
};
