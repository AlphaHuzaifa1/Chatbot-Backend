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

  // Build email body (HTML)
  const htmlBody = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background-color: #2563eb; color: white; padding: 20px; border-radius: 5px 5px 0 0; }
        .content { background-color: #f9fafb; padding: 20px; border: 1px solid #e5e7eb; }
        .section { margin-bottom: 20px; }
        .section-title { font-weight: bold; color: #1f2937; margin-bottom: 10px; font-size: 16px; }
        .detail-row { margin-bottom: 8px; }
        .detail-label { font-weight: bold; color: #4b5563; }
        .detail-value { color: #1f2937; }
        .badge { display: inline-block; padding: 4px 12px; border-radius: 12px; font-size: 12px; font-weight: bold; }
        .badge-urgent { background-color: #dc2626; color: white; }
        .badge-critical { background-color: #dc2626; color: white; }
        .badge-high { background-color: #ea580c; color: white; }
        .badge-medium { background-color: #f59e0b; color: white; }
        .badge-low { background-color: #10b981; color: white; }
        .key-details { background-color: white; padding: 15px; border-left: 4px solid #2563eb; margin-top: 10px; }
        .key-details ul { margin: 10px 0; padding-left: 20px; }
        .key-details li { margin-bottom: 5px; }
        .footer { margin-top: 20px; padding-top: 20px; border-top: 1px solid #e5e7eb; font-size: 12px; color: #6b7280; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h2 style="margin: 0;">Support Ticket - ${referenceId || ticketId}</h2>
        </div>
        <div class="content">
          <div class="section">
            <div class="section-title">Customer Information</div>
            <div class="detail-row">
              <span class="detail-label">Name:</span> <span class="detail-value">${customer.fullName || 'Not provided'}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Company:</span> <span class="detail-value">${customer.company || 'Not provided'}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Email:</span> <span class="detail-value">${customer.email || 'Not provided'}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Phone:</span> <span class="detail-value">${customer.phone || 'Not provided'}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">VSA Agent/Device:</span> <span class="detail-value">${customer.vsaAgentName || 'Not provided'}</span>
            </div>
          </div>

          <div class="section">
            <div class="section-title">Issue Details</div>
            <div class="detail-row">
              <span class="detail-label">Category:</span> <span class="detail-value">${category || 'Other'}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Urgency:</span> 
              <span class="badge badge-${urgency === 'critical' ? 'urgent' : (urgency || 'medium')}">${urgencyDisplay}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Impact:</span> <span class="detail-value">${impactDisplay}</span>
            </div>
          </div>

          <div class="section">
            <div class="section-title">Summary</div>
            <p>${safeSummary || 'No summary provided'}</p>
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
            <div class="detail-row">
              <span class="detail-label">Problem Description:</span>
              <p class="detail-value">${safeDetails.problemDescription || 'Not provided'}</p>
            </div>
            ${safeDetails.errorMessage && safeDetails.errorMessage !== 'No error message provided' ? `
            <div class="detail-row">
              <span class="detail-label">Error Message:</span>
              <p class="detail-value">${safeDetails.errorMessage}</p>
            </div>
            ` : ''}
            ${safeDetails.affectedSystem ? `
            <div class="detail-row">
              <span class="detail-label">Affected System:</span>
              <p class="detail-value">${safeDetails.affectedSystem}</p>
            </div>
            ` : ''}
            ${safeDetails.additionalContext ? `
            <div class="detail-row">
              <span class="detail-label">Additional Context:</span>
              <p class="detail-value">${safeDetails.additionalContext}</p>
            </div>
            ` : ''}
          </div>

          <div class="footer">
            <p><strong>Reference ID:</strong> ${referenceId || ticketId}</p>
            <p><strong>Submitted:</strong> ${new Date().toLocaleString()}</p>
            <p style="margin-top: 15px; color: #9ca3af;">
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
 */
export const sendTicketEmail = async (ticket) => {
  if (!EMAIL_ENABLED) {
    if (LOGGING_ENABLED) {
      console.log('Email sending is disabled (EMAIL_ENABLED=false)');
    }
    return { success: false, skipped: true, reason: 'EMAIL_ENABLED is false' };
  }

  if (TEST_MODE) {
    // In test mode, log the email instead of sending
    const emailContent = formatTicketEmail(ticket);
    
    if (LOGGING_ENABLED) {
      console.log('='.repeat(80));
      console.log('TEST MODE: Email would be sent to:', supportEmail);
      console.log('From:', `${fromName} <${fromEmail}>`);
      console.log('Subject:', emailContent.subject);
      console.log('-'.repeat(80));
      console.log('Email Body (Text):');
      console.log(emailContent.text);
      console.log('='.repeat(80));
    }
    
    return { success: true, testMode: true, emailContent };
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
      to: supportEmail,
      subject: emailContent.subject,
      text: emailContent.text,
      html: emailContent.html
    };

    const info = await transporter.sendMail(mailOptions);
    
    if (LOGGING_ENABLED) {
      console.log('Support ticket email sent successfully:', {
        messageId: info.messageId,
        to: supportEmail,
        referenceId: ticket.referenceId || ticket.ticketId
      });
    }
    
    return { 
      success: true, 
      messageId: info.messageId,
      to: supportEmail
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
