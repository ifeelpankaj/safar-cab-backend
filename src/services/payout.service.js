import axios from 'axios'
import config from '../config/config.js'
import CustomError from '../utils/customeError.js'
import logger from '../utils/logger.js'
import { EApplicationEnvironment } from '../constants/application.js'
//TODO After adding site name add here

export const setupRazorpayAccount = async (user, orderId) => {
    let contactId = null
    let fundAccountId = null
    let validationStatus = null

    try {
        // Input validation
        if (!user || !user._id || !user.username || !user.email || !user.phoneNumber) {
            throw new CustomError('Invalid user data for Razorpay account setup', 400)
        }

        if (!user.wallet?.bankDetails?.accountHolderName || !user.wallet?.bankDetails?.ifsc || !user.wallet?.bankDetails?.accNo) {
            throw new CustomError('Incomplete bank details for Razorpay account setup', 400)
        }

        // Step 1: Create Contact
        logger.info('Creating Razorpay contact', { meta: { userId: user._id, orderId } })

        const contactData = {
            name: user.username.trim(),
            email: user.email.trim(),
            contact: user.phoneNumber.toString(),
            type: 'Drivers',
            reference_id: user._id.toString(),
            notes: {
                notes_key_1: `Payout for ${orderId}`,
                created_at: new Date().toISOString()
            }
        }

        const contactResponse = await makeRazorpayRequest('contacts', contactData)

        if (!contactResponse || !contactResponse.id) {
            throw new CustomError('Invalid contact creation response from Razorpay', 500)
        }

        contactId = contactResponse.id
        logger.info('Razorpay contact created successfully', {
            contactId,
            userId: user._id
        })

        // Step 2: Create Fund Account
        logger.info('Creating Razorpay fund account', { meta: { contactId, userId: user._id } })

        const fundAccountData = {
            contact_id: contactId,
            account_type: 'bank_account',
            bank_account: {
                name: user.wallet.bankDetails.accountHolderName.trim(),
                ifsc: user.wallet.bankDetails.ifsc.trim().toUpperCase(),
                account_number: user.wallet.bankDetails.accNo.toString()
            }
        }

        const fundAccountResponse = await makeRazorpayRequest('fund_accounts', fundAccountData)

        if (!fundAccountResponse || !fundAccountResponse.id) {
            throw new CustomError('Invalid fund account creation response from Razorpay', 500)
        }

        fundAccountId = fundAccountResponse.id
        logger.info('Razorpay fund account created successfully', {
            meta: {
                fundAccountId,
                contactId,
                userId: user._id
            }
        })

        // Step 3: Validate Fund Account
        logger.info('Validating Razorpay fund account', { fundAccountId, userId: user._id })

        if (!config.RAZORPAY_ACCOUNT_NUMBER) {
            throw new CustomError('Razorpay account number not configured', 500)
        }

        const validationData = {
            account_number: config.RAZORPAY_ACCOUNT_NUMBER,
            fund_account: {
                id: fundAccountId
            },
            amount: 100, // Validation amount in paise (₹1)
            currency: 'INR',
            notes: {
                description: `Account validation for ${EApplicationEnvironment.SITE_NAME || 'Platform'}`,
                user_id: user._id.toString(),
                order_id: orderId.toString(),
                validation_time: new Date().toISOString()
            }
        }

        const validationResponse = await makeRazorpayRequest('fund_accounts/validations', validationData)

        if (!validationResponse) {
            throw new CustomError('Invalid validation response from Razorpay', 500)
        }

        validationStatus = validationResponse.status
        logger.info('Razorpay fund account validation completed', {
            fundAccountId,
            validationStatus,
            validationId: validationResponse.id,
            userId: user._id
        })

        // Return comprehensive result
        return {
            contactId,
            fundAccountId,
            validationStatus,
            validationId: validationResponse.id,
            validationAmount: 100,
            createdAt: new Date(),
            userReference: user._id,
            orderReference: orderId
        }
    } catch (error) {
        logger.error('Razorpay account setup failed', {
            error: error.message,
            userId: user._id,
            orderId,
            contactId,
            fundAccountId,
            validationStatus,
            step: !contactId ? 'contact_creation' : !fundAccountId ? 'fund_account_creation' : 'fund_account_validation'
        })

        // Re-throw with context
        throw new CustomError(
            `Razorpay account setup failed at ${
                !contactId ? 'contact creation' : !fundAccountId ? 'fund account creation' : 'fund account validation'
            }: ${error.message}`,
            error.statusCode || 500
        )
    }
}

const makeRazorpayRequest = async (endpoint, data) => {
    try {
        const response = await axios.post(`https://api.razorpay.com/v1/${endpoint}`, data, {
            auth: {
                username: config.RAZORPAY_API_KEY,
                password: config.RAZORPAY_API_SECRET
            },
            headers: {
                'Content-Type': 'application/json'
            },
            timeout: 30000 // 30 seconds timeout
        })
        return response.data
    } catch (error) {
        logger.error(`Error in Razorpay API call to ${endpoint}:`, {
            meta: {
                error: error.response?.data || error.message,
                status: error.response?.status,
                endpoint,
                requestData: data
            }
        })

        // Handle specific Razorpay errors
        if (error.response?.data?.error) {
            const razorpayError = error.response.data.error
            throw new CustomError(razorpayError.description || razorpayError.reason || error.message, error.response.status || 500)
        }

        throw new CustomError(error.message || 'Razorpay API request failed', error.response?.status || 500)
    }
}

export const fundTransfer = async (fundAccountId, amount, user, orderId) => {
    try {
        // Input validation
        if (!fundAccountId) {
            throw new CustomError('Fund account ID is required for transfer', 400)
        }

        if (!amount || typeof amount !== 'number' || amount <= 0) {
            throw new CustomError('Valid amount is required for transfer', 400)
        }

        if (amount > 1000000) {
            throw new CustomError('Transfer amount exceeds maximum limit', 400)
        }

        if (!user || !user._id) {
            throw new CustomError('Valid user data is required for transfer', 400)
        }

        if (!orderId) {
            throw new CustomError('Order ID is required for transfer', 400)
        }

        if (!config.RAZORPAY_ACCOUNT_NUMBER) {
            throw new CustomError('Razorpay account number not configured', 500)
        }

        logger.info('Initiating Razorpay fund transfer', {
            fundAccountId,
            amount,
            userId: user._id,
            orderId
        })

        const payoutData = {
            account_number: config.RAZORPAY_ACCOUNT_NUMBER,
            fund_account_id: fundAccountId,
            amount: Math.round(amount * 100), // Convert to paise and ensure integer
            currency: 'INR',
            mode: 'NEFT',
            purpose: 'payout',
            queue_if_low_balance: true,
            reference_id: user._id.toString(),
            narration: `Payout from ${EApplicationEnvironment.SITE_NAME || 'Platform'}`,
            notes: {
                payout_for: `Order ${orderId}`,
                user_id: user._id.toString(),
                driver_name: user.username || 'Driver',
                transfer_time: new Date().toISOString(),
                amount_inr: amount.toString()
            }
        }

        const response = await makeRazorpayRequest('payouts', payoutData)

        if (!response || !response.id) {
            throw new CustomError('Invalid payout response from Razorpay', 500)
        }

        // Validate response structure
        if (!response.status) {
            logger.warn('Payout response missing status', {
                payoutId: response.id,
                response
            })
        }

        logger.info('Razorpay fund transfer completed successfully', {
            payoutId: response.id,
            status: response.status,
            mode: response.mode,
            amount: response.amount,
            userId: user._id,
            orderId
        })

        return {
            id: response.id,
            status: response.status || 'processing',
            mode: response.mode || 'NEFT',
            amount: response.amount ? response.amount / 100 : amount, // Convert back to rupees
            currency: response.currency || 'INR',
            reference_id: response.reference_id,
            fund_account_id: response.fund_account_id,
            created_at: response.created_at,
            fees: response.fees || 0,
            tax: response.tax || 0,
            utr: response.utr || null,
            failure_reason: response.failure_reason || null
        }
    } catch (error) {
        logger.error('Razorpay fund transfer failed', {
            error: error.message,
            fundAccountId,
            amount,
            userId: user?._id,
            orderId,
            stack: error.stack
        })

        // Re-throw with context
        throw new CustomError(`Fund transfer failed: ${error.message}`, error.statusCode || 500)
    }
}
