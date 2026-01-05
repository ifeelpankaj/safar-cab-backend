import razorpayInstance from '../config/razorpay.js'
import { EApplicationEnvironment } from '../constants/application.js'
import { generic_msg, order_msg } from '../constants/res.message.js'
import { Order } from '../models/order.model.js'
import CustomError from '../utils/customeError.js'
import httpError from '../utils/httpError.js'
import httpResponse from '../utils/httpResponse.js'
import crypto from 'crypto'
import { generateNumericOTP } from '../utils/otherUtils.js'
import config from '../config/config.js'
import { Payment } from '../models/payment.model.js'
import logger from '../utils/logger.js'
import { sendMailWithRetry } from '../services/email.service.js'
import { order_emails } from '../constants/emails.js'
import date from '../utils/date.js'
import mongoose from 'mongoose'

export const bookCab = async (req, res, next) => {
    const cashOrderId = `Cash_${generateNumericOTP(9)}`

    try {
        const {
            bookingType,
            bookedCab,
            exactLocation,
            departureDate,
            dropOffDate,
            pickupLocation,
            destination,
            numberOfPassengers,
            bookingStatus,
            paymentMethod,
            passengers,
            bookingAmount
        } = req.body

        const userId = req.user._id
        let razorpayOrderId = ''
        let amountToPay = 0

        // Calculate the amount to be paid based on payment method
        if (paymentMethod === 'Hybrid') {
            amountToPay = Math.round(bookingAmount * EApplicationEnvironment.HYBRID_PAYMENT_PERCENTAGE * 100) // 10% of booking amount in paise
        } else if (paymentMethod === 'Online') {
            amountToPay = Math.round(bookingAmount * 100) // Full amount in paise
        }

        // Create a Razorpay order if needed
        if (paymentMethod === 'Hybrid' || paymentMethod === 'Online') {
            const options = {
                amount: amountToPay,
                currency: 'INR',
                receipt: `order_${new Date().getTime()}`
            }
            const razorpayOrder = await razorpayInstance.orders.create(options)
            razorpayOrderId = razorpayOrder.id
        } else if (paymentMethod === 'Cash') {
            razorpayOrderId = cashOrderId
        }

        // Determine order expiration date
        const expireMinutes = EApplicationEnvironment.ORDER_EXPIRE_MINUTES || 15 // Default to 15 minutes if not set
        const orderExpireDate = paymentMethod === 'Cash' ? null : new Date(Date.now() + expireMinutes * 60 * 1000)

        // Prepare order options
        const orderOptions = {
            userId,
            bookingType,
            bookedCab,
            exactLocation,
            departureDate,
            dropOffDate,
            pickupLocation,
            destination,
            numberOfPassengers,
            bookingStatus,
            paymentMethod,
            paymentStatus: 'Pending',
            passengers,
            bookingAmount,
            paidAmount: 0, // Initialize as 0, update after successful payment
            razorpayOrderId,
            order_expire: orderExpireDate
        }

        // Remove outdated cache entries

        // Create the order
        let order
        if (paymentMethod === 'Hybrid' || paymentMethod === 'Online') {
            order = await Order.create(orderOptions)
        } else if (paymentMethod === 'Cash') {
            order = await Order.create({ ...orderOptions, order_expire: null })
        }

        // Send response
        httpResponse(req, res, 201, generic_msg.operation_success('Order Creation'), { order, amountToPay: amountToPay / 100, razorpayOrderId }, null)
    } catch (error) {
        httpError('CAB BOOKING', next, error, req, 500)
    }
}

export const getMyBookings = async (req, res, next) => {
    try {
        const orders = await Order.find({ userId: req.user._id }).populate({ path: 'userId', select: 'name' }).select('-__v').sort({ createdAt: -1 })

        if (!orders) {
            throw new CustomError(generic_msg.resource_not_found('Order'), 404)
        }
        const leanOrders = orders.map((order) => order.toObject())

        return httpResponse(req, res, 200, generic_msg.operation_success('Get my bookings'), leanOrders, null)
    } catch (error) {
        return httpError('GET MY BOOKING', next, error, req, 500)
    }
}

export const getOrderDetailForCustomer = async (req, res, next) => {
    try {
        let order = null
        if (req.user.role === 'Passenger') {
            order = await Order.findById(req.params.id)
                .populate('driverId', 'username email phoneNumber avatar')
                .populate('bookedCab', 'availability cabNumber capacity feature photos')
            if (!order) {
                throw new CustomError(generic_msg.resource_not_found('Order details'), 404)
            }
        } else {
            order = await Order.findById(req.params.id)
                .populate('driverId', 'username email phoneNumber')
                .populate('bookedCab', 'availability cabNumber capacity feature rate upcomingBookings')
                .populate('userId', 'username email phoneNumber')
        }
        return httpResponse(req, res, 200, generic_msg.operation_success('Get order details for passanger'), order, null)
    } catch (error) {
        return httpError('GET ORDER DETAILS CUSTOMER', next, error, req, 500)
    }
}
export const getAllPendingOrder = async (req, res, next) => {
    try {
        if (req.user.role !== 'Driver' && req.user.role !== 'Admin') {
            throw new CustomError(generic_msg.unauthorized_access, 403)
        }

        const orders = await Order.find({ bookingStatus: 'Pending' }).select('-_v').lean()
        if (orders.length === 0) {
            return httpResponse(req, res, 200, generic_msg.resource_not_found('Order'), null, null, null)
        }

        // Cache the result for 10 minutes (600 seconds)

        return httpResponse(req, res, 200, generic_msg.operation_success('Get all pending Orders'), orders, null, null)
    } catch (error) {
        return httpError('GET ALL PENDING ORDER', next, error, req, 500)
    }
}

//New One
export const paymentVerificationWithManualRollback = async (req, res, next) => {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body
    let originalOrderState = null // Track original order state
    let createdPayment = null // Track created payment for rollback
    let order = null // Define order in outer scope

    try {
        // Log the start of the verification process
        logger.info(`Verifying payment for order ID: ${razorpay_order_id}, payment ID: ${razorpay_payment_id}`)

        // Find the corresponding order in the database
        order = await Order.findOne({ razorpayOrderId: razorpay_order_id })
        if (!order) {
            throw new CustomError(generic_msg.resource_not_found('Order'), 404)
        }

        // Store original order state for potential rollback
        originalOrderState = {
            paidAmount: order.paidAmount,
            paymentStatus: order.paymentStatus,
            order_expire: order.order_expire
        }

        // Verify if payment already exists (Idempotency check)
        const paymentExists = await Payment.findOne({ razorpay_payment_id })
        if (paymentExists) {
            httpResponse(req, res, 200, 'Payment already verified', order, null)
            return
        }

        // Create HMAC to verify the signature
        const hmac = crypto.createHmac('sha256', config.RAZORPAY_API_SECRET)
        hmac.update(`${razorpay_order_id}|${razorpay_payment_id}`)
        const expectedSignature = hmac.digest('hex')

        // Use timingSafeEqual to prevent timing attacks
        const expectedSignatureBuffer = Buffer.from(expectedSignature, 'utf-8')
        const razorpaySignatureBuffer = Buffer.from(razorpay_signature, 'utf-8')
        const isAuthentic = crypto.timingSafeEqual(expectedSignatureBuffer, razorpaySignatureBuffer)

        // Check if the payment is authentic
        if (isAuthentic) {
            // Create payment record
            const paymentArray = await Payment.create([
                {
                    order: order._id,
                    razorpay_order_id,
                    razorpay_payment_id,
                    razorpay_signature
                }
            ])
            createdPayment = paymentArray[0] // Store reference for potential rollback

            // Update the order payment status based on payment method
            if (order.paymentMethod === 'Hybrid') {
                order.paidAmount = Math.round(order.bookingAmount * EApplicationEnvironment.HYBRID_PAYMENT_PERCENTAGE) // 10% paid in Hybrid
                order.paymentStatus = 'Partially-Paid'
                order.order_expire = null // Remove expiry for partially paid orders
            } else if (order.paymentMethod === 'Online') {
                order.paidAmount = order.bookingAmount // Full payment
                order.paymentStatus = 'Paid'
                order.order_expire = null // No expiry for fully paid orders
            }

            // Save the updated order
            await order.save()

            // Send confirmation email (non-blocking)
            try {
                const formattedPickUpDate = date.formatShortDate(order.departureDate)
                const formattedDropOffDate = date.formatShortDate(order.dropOffDate)
                const location = order.exactLocation || order.pickupLocation

                await sendMailWithRetry(
                    req.user.email,
                    order_emails.order_creation_email_subject,
                    order_emails.order_creation_email_success(
                        req.user.username,
                        formattedPickUpDate,
                        order._id.toString(),
                        location,
                        formattedDropOffDate,
                        order.paymentMethod,
                        order.paidAmount,
                        order.bookingAmount
                    )
                )
            } catch (emailError) {
                logger.error(generic_msg.email_sending_failed(req.user.email), { meta: { error: emailError } })
                // Continue as the payment is successful
            }

            // Respond with success
            httpResponse(req, res, 200, order_msg.payment_verification_success, { order, paymentId: razorpay_payment_id }, null)
        } else {
            throw new CustomError(order_msg.payment_verification_fail(razorpay_order_id), 400)
        }
    } catch (error) {
        // Manual rollback on error
        try {
            // Delete created payment if it exists
            if (createdPayment && createdPayment._id) {
                await Payment.findByIdAndDelete(createdPayment._id).catch((deleteError) =>
                    logger.error('Failed to delete created payment during rollback:', deleteError)
                )
            }

            // Restore original order state if order exists and was modified
            if (order && originalOrderState) {
                order.paidAmount = originalOrderState.paidAmount
                order.paymentStatus = originalOrderState.paymentStatus
                order.order_expire = originalOrderState.order_expire

                await order.save().catch((rollbackError) => logger.error('Failed to restore order state during rollback:', rollbackError))
            }
        } catch (rollbackError) {
            logger.error('Rollback failed:', rollbackError)
        }

        logger.error(`Payment verification failed for order ID: ${razorpay_order_id}`, { meta: { error } })
        httpError('PAYMENT VERIFICATION', next, error, req, 500)
    }
}

//New One
export const getOrderDetail = async (req, res, next) => {
    try {
        const order = await Order.findById(req.params.id)
            .populate({
                path: 'bookedCab', // First populate bookedCab
                populate: {
                    path: 'belongsTo',
                    select: 'username email phoneNumber' // Select specific fields
                }
            })
            .populate({
                path: 'driverId', // Populate the driverId in the Order schema
                select: 'avatar username email phoneNumber ' // Select specific fields
            })
            .populate({
                path: 'userId',
                select: 'avatar username email phoneNumber'
            })
            .lean()
        if (!order) {
            throw new CustomError(generic_msg.resource_not_found('Order Details'), 404)
        }
        return httpResponse(req, res, 200, generic_msg.operation_success('Get order details'), order, null)
    } catch (error) {
        return httpError('GET ORDER DETAILS', next, error, req, 500)
    }
}

///Transaction Enable route
export const paymentVerificationWithTransaction = async (req, res, next) => {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body

    // @ts-ignore
    const session = await mongoose.startSession()
    session.startTransaction()

    try {
        logger.info(`Verifying payment for order ID: ${razorpay_order_id}, payment ID: ${razorpay_payment_id}`)

        // Find the corresponding order in the database
        const order = await Order.findOne({ razorpayOrderId: razorpay_order_id }).session(session)
        if (!order) {
            throw new CustomError(generic_msg.resource_not_found('Order'), 404)
        }

        // Verify if payment already exists (Idempotency check)
        const paymentExists = await Payment.findOne({ razorpay_payment_id }).session(session)
        if (paymentExists) {
            await session.commitTransaction()
            httpResponse(req, res, 200, 'Payment already verified', order, null)
            return
        }

        // Create HMAC to verify the signature
        const hmac = crypto.createHmac('sha256', config.RAZORPAY_API_SECRET)
        hmac.update(`${razorpay_order_id}|${razorpay_payment_id}`)
        const expectedSignature = hmac.digest('hex')

        // Use timingSafeEqual to prevent timing attacks
        const expectedSignatureBuffer = Buffer.from(expectedSignature, 'utf-8')
        const razorpaySignatureBuffer = Buffer.from(razorpay_signature, 'utf-8')
        const isAuthentic = crypto.timingSafeEqual(expectedSignatureBuffer, razorpaySignatureBuffer)

        if (!isAuthentic) {
            throw new CustomError(order_msg.payment_verification_fail(razorpay_order_id), 400)
        }

        // Create payment record within transaction
        // ✅ CORRECT - Wrap the document in an array
        const createdPaymentArray = await Payment.create(
            [
                {
                    order: order._id,
                    razorpay_order_id,
                    razorpay_payment_id,
                    razorpay_signature
                }
            ],
            { session }
        )

        const createdPayment = createdPaymentArray[0]
        if (
            !createdPayment ||
            // @ts-ignore
            !createdPayment._id ||
            // @ts-ignore
            createdPayment.razorpay_payment_id !== razorpay_payment_id ||
            // @ts-ignore
            createdPayment.razorpay_order_id !== razorpay_order_id
        ) {
            throw new CustomError('Payment record creation failed or data mismatch', 500)
        }
        // Update order payment status
        if (order.paymentMethod === 'Hybrid') {
            order.paidAmount = Math.round(order.bookingAmount * EApplicationEnvironment.HYBRID_PAYMENT_PERCENTAGE)
            order.paymentStatus = 'Partially-Paid'
            order.order_expire = null
        } else if (order.paymentMethod === 'Online') {
            order.paidAmount = order.bookingAmount
            order.paymentStatus = 'Paid'
            order.order_expire = null
        }

        await order.save({ session })

        // Commit the transaction
        await session.commitTransaction()

        // Send email after successful transaction (non-blocking)
        setImmediate(async () => {
            try {
                const formattedPickUpDate = date.formatShortDate(order.departureDate)
                const formattedDropOffDate = date.formatShortDate(order.dropOffDate)
                const location = order.exactLocation || order.pickupLocation

                await sendMailWithRetry(
                    req.user.email,
                    order_emails.order_creation_email_subject,
                    order_emails.order_creation_email_success(
                        req.user.username,
                        formattedPickUpDate,
                        order._id.toString(),
                        location,
                        formattedDropOffDate,
                        order.paymentMethod,
                        order.paidAmount,
                        order.bookingAmount
                    )
                )
            } catch (emailError) {
                logger.error(generic_msg.email_sending_failed(req.user.email), { meta: { error: emailError } })
            }
        })

        logger.info(`Payment verification successful for order ID: ${razorpay_order_id}`)
        httpResponse(req, res, 200, order_msg.payment_verification_success, { order: order.toObject(), paymentId: razorpay_payment_id }, null)
    } catch (error) {
        // Rollback transaction on error
        await session.abortTransaction()
        logger.error(`Payment verification failed for order ID: ${razorpay_order_id}`, { meta: { error } })
        httpError('PAYMENT VERIFICATION', next, error, req, 500)
    } finally {
        await session.endSession()
    }
}
