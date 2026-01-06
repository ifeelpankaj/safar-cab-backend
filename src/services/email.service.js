import { createTransport } from 'nodemailer'
import config from '../config/config.js'
import logger from '../utils/logger.js'

const transporter = createTransport({
    // @ts-ignore
    host: config.SMTP_HOST,
    port: Number(config.SMTP_PORT),
    secure: config.SMTP_PORT === '465', // true for 465, false for other ports
    auth: {
        user: config.SMTP_USER,
        pass: config.SMTP_PASS
    },
    pool: true, // use pooled connections
    maxConnections: 5, // limit to 5 concurrent connections
    maxMessages: 100, // limit to 100 messages per connection
    rateDelta: 1000, // limit to 1 message per second
    rateLimit: 5 // limit to 5 messages per rate Delta
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
        logger.info(`Sending email to ${email}`, { subject })
        const info = await transporter.sendMail(mailOptions)
        logger.info(`Email sent successfully to ${email}`, { meta: { messageId: info.messageId } })
        return info
    } catch (error) {
        logger.error(`Failed to send email to ${email}`, { meta: { error: error.message, stack: error.stack } })
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
