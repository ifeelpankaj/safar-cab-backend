import { createTransport } from 'nodemailer'
import config from '../config/config.js'
import logger from '../utils/logger.js'

const smtpPort = Number(config.SMTP_PORT) || 587
const isSecure = smtpPort === 465

// Log SMTP configuration on startup (without sensitive data)
logger.info('SMTP Configuration', {
    host: config.SMTP_HOST,
    port: smtpPort,
    secure: isSecure,
    user: config.SMTP_USER ? `${config.SMTP_USER.substring(0, 3)}***` : 'NOT SET',
    fromEmail: config.FROM_EMAIL
})

const transporter = createTransport({
    host: config.SMTP_HOST,
    port: smtpPort,
    secure: isSecure, // true for 465, false for other ports (587 uses STARTTLS)
    auth: {
        user: config.SMTP_USER,
        pass: config.SMTP_PASS
    },
    // TLS configuration for cloud environments
    tls: {
        rejectUnauthorized: true, // Set to false only for debugging
        minVersion: 'TLSv1.2'
    },
    // Connection settings optimized for cloud
    connectionTimeout: 30000, // 30 seconds
    greetingTimeout: 30000,
    socketTimeout: 60000,
    // Pool settings
    pool: true,
    maxConnections: 3, // reduced for cloud environments
    maxMessages: 50,
    rateDelta: 1000,
    rateLimit: 3
})

// Verify transporter connection on startup
transporter.verify((error) => {
    if (error) {
        logger.error('SMTP connection verification failed', { meta: { error: error.message, code: error.name } })
    } else {
        logger.info('SMTP server is ready to send emails')
    }
})

export const sendMail = async (email, subject, htmlContent, text) => {
    const mailOptions = {
        from: `"${config.FROM_NAME}" <${config.FROM_EMAIL}>`,
        to: email,
        subject,
        html: htmlContent,
        text: text || htmlContent.replace(/<[^>]*>/g, ''), // Always include plain text version
        headers: {
            'X-Priority': '3', // Normal priority
            'X-Mailer': 'Safar Cabs Mailer',
            'MIME-Version': '1.0'
        },
        replyTo: config.FROM_EMAIL
    }
    try {
        logger.info(`Attempting to send email to ${email}`, { subject, host: config.SMTP_HOST, port: config.SMTP_PORT })
        const info = await transporter.sendMail(mailOptions)
        logger.info(`Email sent successfully to ${email}`, { meta: { messageId: info.messageId, response: info.response } })
        return info
    } catch (error) {
        logger.error(`Failed to send email to ${email}`, {
            meta: {
                error: error.message,
                code: error.code,
                command: error.command,
                responseCode: error.responseCode,
                stack: error.stack
            }
        })
        throw new Error(`Failed to send email: ${error.message}`)
    }
}
process.on('SIGTERM', () => {
    logger.info('SIGTERM received. Closing email transporter.')
    transporter.close()
})

export const sendMailWithRetry = async (email, subject, htmlContent, text, maxRetries = 3, delay = 1000) => {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await sendMail(email, subject, htmlContent, text)
        } catch (error) {
            if (attempt === maxRetries) {
                logger.error(`All retry attempts failed for sending email to ${email}`, { meta: { error: error.message } })
                throw new Error(`Failed to send email to ${email} after ${maxRetries} attempts: ${error.message}`)
            }
            logger.warn(`Attempt ${attempt} failed for sending email to ${email}. Retrying...`, { meta: { error: error.message } })
            await new Promise((resolve) => setTimeout(resolve, delay * attempt))
        }
    }

    // fallback (should never hit)
    throw new Error(`Unexpected error: retry loop exited without sending email to ${email}`)
}
