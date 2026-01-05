import { driver_msg, generic_msg } from '../constants/res.message.js'
import { User } from '../models/user.model.js'
import httpResponse from '../utils/httpResponse.js'
import fs from 'fs'
import logger from '../utils/logger.js'
import CustomError from '../utils/customeError.js'
import cloudinary from '../config/cloudinary.js'
import httpError from '../utils/httpError.js'
// import mongoose, { startSession } from 'mongoose'
import { Cab } from '../models/cab.model.js'
import { Order } from '../models/order.model.js'
import { sendMailWithRetry } from '../services/email.service.js'
import { driver_emails } from '../constants/emails.js'
import { Transaction } from '../models/transaction.model.js'
import mongoose from 'mongoose'

export const getDriverUpcommingBookings = async (req, res, next) => {
    try {
        // Ensure the user is authorized
        if (req.user.role !== 'Driver' && req.user.role !== 'Admin') {
            throw new CustomError(generic_msg.unauthorized_access, 403)
        }

        const driverId = req.user._id

        // Find the cabs that belong to the driver with optimized population
        const driverCabs = await Cab.find({ belongsTo: driverId })
            .populate({
                path: 'upcomingBookings',
                populate: {
                    path: 'orderId',
                    select: 'bookingType pickupLocation exactLocation destination driverShare'
                    // Removed userId population to exclude user information
                }
            })
            .select('_id upcomingBookings')
            .lean() // Add lean() for better performance

        // Arrays to hold filtered bookings
        const acceptedBookings = []
        const unacceptedBookings = []

        // Optimized loop with early continue
        for (const cab of driverCabs) {
            const { upcomingBookings } = cab

            if (!upcomingBookings?.length) {
                continue
            }

            for (const booking of upcomingBookings) {
                const bookingObject = {
                    cabId: cab._id,
                    ...booking // No need for toObject() since we're using lean()
                }

                if (booking.accepted) {
                    acceptedBookings.push(bookingObject)
                } else {
                    unacceptedBookings.push(bookingObject)
                }
            }
        }

        // Check if there are any bookings to return
        if (acceptedBookings.length === 0 && unacceptedBookings.length === 0) {
            return httpResponse(req, res, 200, generic_msg.resource_not_found('Bookings'), null, null)
        }

        // Return both accepted and unaccepted bookings with counts
        return httpResponse(
            req,
            res,
            200,
            generic_msg.operation_success('Get upcoming driver bookings'),
            {
                acceptedBookings,
                unacceptedBookings,
                totalAcceptedCount: acceptedBookings.length,
                totalUnacceptedCount: unacceptedBookings.length,
                totalBookings: acceptedBookings.length + unacceptedBookings.length
            },
            null
        )
    } catch (error) {
        return httpError('getDriverUpcomingBookings', next, error, req, 500)
    }
}
export const getDriverAllBookings = async (req, res, next) => {
    try {
        // Check user role
        if (req.user.role !== 'Driver' && req.user.role !== 'Admin') {
            throw new CustomError(generic_msg.unauthorized_access, 403)
        }

        // Pagination setup
        const page = Number(req.query.page) || 1
        const limit = Number(req.query.limit) || 5

        // Validation for pagination
        if (page < 1 || limit < 1) {
            throw new CustomError('Pagination Error', 400)
        }

        const skip = (page - 1) * limit
        const userId = req.user._id

        // Fetch driver orders
        const driverOrders = await Order.find({ driverId: userId, bookingStatus: 'Completed' }).sort({ createdAt: -1 }).skip(skip).limit(limit).lean()

        // If no orders found
        if (!driverOrders || driverOrders.length === 0) {
            return httpResponse(req, res, 404, generic_msg.resource_not_found('Orders for this driver'), null, null, null)
        }

        // Count total orders for pagination
        const totalDriverOrders = await Order.countDocuments({ driverId: userId })

        // Pagination info
        const pagination = {
            currentPage: page,
            totalPages: Math.ceil(totalDriverOrders / limit),
            totalItems: totalDriverOrders
        }

        // Successful response with orders and pagination info
        return httpResponse(req, res, 200, generic_msg.operation_success('Get driver all bookings'), driverOrders, null, pagination)
    } catch (error) {
        return httpError('GET ALL DRIVER BOOKING', next, error, req, 500)
    }
}
export const confirmBooking = async (req, res, next) => {
    // Store original states for rollback
    let originalOrder = null
    let originalCab = null
    let orderUpdated = false
    let cabUpdated = false
    // @ts-ignore
    let _emailSent = false
    let orderId = null

    try {
        // Authorization check
        if (req.user.role !== 'Driver' && req.user.role !== 'Admin') {
            throw new CustomError(generic_msg.unauthorized_access, 403)
        }

        ;({ orderId } = req.body)

        if (!orderId) {
            throw new CustomError('Order ID is required to confirm the booking', 400)
        }

        // Step 1: Find and store original order state
        const order = await Order.findById(orderId).populate({
            path: 'userId',
            select: 'username email phoneNumber'
        })

        if (!order) {
            throw new CustomError(generic_msg.resource_not_found('Order'), 404)
        }
        originalOrder = order

        // Step 2: Find and store original cab state
        const cab = await Cab.findOne({ 'upcomingBookings.orderId': orderId })

        if (!cab) {
            throw new CustomError('Cab with this booking not found', 404)
        }
        originalCab = cab

        const bookingIndex = originalCab.upcomingBookings.findIndex((booking) => booking.orderId.toString() === orderId.toString())

        if (bookingIndex === -1) {
            throw new CustomError(`Booking not found in cab's upcoming bookings`, 404)
        }

        // Step 3: Update order
        const updatedOrder = await Order.findByIdAndUpdate(orderId, { bookingStatus: 'Confirmed' }, { new: true, runValidators: true }).populate({
            path: 'userId',
            select: 'username email phoneNumber'
        })

        if (!updatedOrder) {
            throw new CustomError('Failed to update order', 500)
        }

        orderUpdated = true

        // Step 4: Update cab
        originalCab.upcomingBookings[bookingIndex].accepted = true
        await originalCab.save()
        cabUpdated = true

        // Step 5: Send email
        try {
            await sendMailWithRetry(
                updatedOrder.userId.email,
                driver_emails.booking_confirmed_email_subject,
                // @ts-ignore
                driver_emails.booking_confirmed_email(updatedOrder.userId.username)
            )
            _emailSent = true
        } catch (emailError) {
            logger.error(generic_msg.email_sending_failed(updatedOrder.userId.email), {
                error: emailError
            })
            // Continue even if email fails, but log the error
        }

        // Success response
        httpResponse(req, res, 200, generic_msg.operation_success('Confirm Booking'), null, null, null)
    } catch (error) {
        // Manual rollback process
        logger.error('Error in confirmBooking, starting rollback', { error: error.message })

        try {
            // Rollback order update
            if (orderUpdated && originalOrder) {
                await Order.findByIdAndUpdate(orderId, { bookingStatus: originalOrder.bookingStatus }, { runValidators: true })
                logger.info('Successfully rolled back order update')
            }

            // Rollback cab update
            if (cabUpdated && originalCab) {
                const bookingIndex = originalCab.upcomingBookings.findIndex((booking) => booking.orderId.toString() === orderId.toString())

                if (bookingIndex !== -1) {
                    // Restore original accepted status
                    const cabToUpdate = await Cab.findOne({ 'upcomingBookings.orderId': orderId })
                    if (cabToUpdate) {
                        const currentBookingIndex = cabToUpdate.upcomingBookings.findIndex(
                            (booking) => booking.orderId.toString() === orderId.toString()
                        )
                        if (currentBookingIndex !== -1) {
                            // Find original accepted status from originalCab
                            const originalAcceptedStatus = originalCab.upcomingBookings[bookingIndex].accepted
                            cabToUpdate.upcomingBookings[currentBookingIndex].accepted = originalAcceptedStatus
                            await cabToUpdate.save()
                            logger.info('Successfully rolled back cab update')
                        }
                    }
                }
            }

            // Note: We typically don't rollback email sends as they're external operations
            // and usually considered acceptable to have sent even if the transaction fails
        } catch (rollbackError) {
            // Log rollback failure but don't throw to avoid masking original error
            logger.error('Rollback failed', {
                originalError: error.message,
                rollbackError: rollbackError.message
            })
        }

        // Forward the original error
        httpError('CONFIRM BOOKING', next, error, req, 500)
    }
}
//New One
export const driverVerificationWithManualRollback = async (req, res, next) => {
    const tmpDir = './tmp'
    const uploadedFiles = [] // Track uploaded files for rollback
    let originalUser = null // Track original user state
    let user = null // Define user variable in outer scope

    try {
        if (req.user.role !== 'Driver') {
            throw new CustomError(generic_msg.unauthorized_access, 403)
        }

        user = await User.findById(req.user._id)
        if (!user) {
            throw new CustomError(generic_msg.resource_not_found('User'), 404)
        }

        // Store original user state for potential rollback
        originalUser = {
            driverDocuments: [...user.driverDocuments],
            isDocumentSubmited: user.isDocumentSubmited,
            wallet: user.wallet ? JSON.parse(JSON.stringify(user.wallet)) : null
        }

        await fs.promises.mkdir(tmpDir, { recursive: true }).catch((error) => {
            logger.error(`Failed to create temp directory:`, { meta: { error } })
            throw new CustomError('Failed to create temp directory', 500)
        })

        if (!req.files || !req.files.document) {
            throw new CustomError(driver_msg.invalid_doc_format, 400)
        }

        const documents = Array.isArray(req.files.document) ? req.files.document : [req.files.document]
        const docNames = Array.isArray(req.body['docName[]']) ? req.body['docName[]'] : [req.body['docName[]']]

        const allowedFormats = ['image/jpeg', 'image/png', 'application/pdf']
        documents.forEach((doc) => {
            if (!allowedFormats.includes(doc.mimetype)) {
                throw new CustomError(driver_msg.invalid_doc_format, 400)
            }
            if (doc.size > 2 * 1024 * 1024) {
                throw new CustomError(driver_msg.doc_too_large, 400)
            }
        })

        // Upload documents
        const uploadedDocuments = await Promise.all(
            documents.map(async (doc, index) => {
                try {
                    const uploadResult = await cloudinary.v2.uploader.upload(doc.tempFilePath, {
                        folder: 'TandT/DriverDocuments',
                        resource_type: 'auto'
                    })

                    // Track for potential rollback
                    uploadedFiles.push(uploadResult.public_id)

                    fs.unlinkSync(doc.tempFilePath)

                    return {
                        docName: docNames[index] || `Document ${index + 1}`,
                        public_id: uploadResult.public_id,
                        url: uploadResult.secure_url,
                        uploadedAt: new Date()
                    }
                } catch (uploadError) {
                    logger.error(`Document upload failed: ${doc.name}`, { meta: { error: uploadError } })
                    throw new CustomError(driver_msg.doc_upload_failure, 500)
                }
            })
        )

        // Validate bank details
        const accNo = req.body['bankDetails[accNo]']
        const accountHolderName = req.body['bankDetails[accountHolderName]']
        const ifsc = req.body['bankDetails[ifsc]']
        const bankName = req.body['bankDetails[bankName]']

        if (!accNo || !ifsc || !bankName || !accountHolderName) {
            throw new CustomError(driver_msg.missing_bank_details, 400)
        }

        if (!/^\d+$/.test(accNo) || !/^[A-Za-z]{4}[0-9]{7}$/.test(ifsc)) {
            throw new CustomError(driver_msg.invalid_bank_details, 400)
        }

        // Initialize wallet properly
        if (!user.wallet) {
            user.wallet = {
                balance: 0,
                currency: 'INR',
                bankDetails: {}
            }
        }

        if (typeof user.wallet.balance !== 'number') {
            user.wallet.balance = 0
        }
        if (!user.wallet.currency) {
            user.wallet.currency = 'INR'
        }
        if (!user.wallet.bankDetails) {
            user.wallet.bankDetails = {}
        }

        // Update user data
        user.wallet.bankDetails = {
            accountHolderName,
            accNo: Number(accNo),
            ifsc,
            bankName
        }

        user.driverDocuments.push(...uploadedDocuments)
        user.isDocumentSubmited = true

        // Save user
        await user.save()

        return httpResponse(req, res, 200, driver_msg.doc_upload_success, uploadedDocuments, null)
    } catch (error) {
        // Manual rollback on error - check if user and originalUser exist
        if (originalUser && user) {
            try {
                // Restore original user state
                user.driverDocuments.splice(0, user.driverDocuments.length, ...originalUser.driverDocuments)
                user.isDocumentSubmited = originalUser.isDocumentSubmited
                if (originalUser.wallet) {
                    user.wallet = originalUser.wallet
                }
                await user.save()

                // Delete uploaded files from Cloudinary
                if (uploadedFiles.length > 0) {
                    await Promise.all(
                        uploadedFiles.map((publicId) =>
                            cloudinary.v2.uploader.destroy(publicId).catch((err) => logger.error('Failed to delete uploaded file:', err))
                        )
                    )
                }
            } catch (rollbackError) {
                logger.error('Rollback failed:', rollbackError)
            }
        } else {
            // If user wasn't fetched but files were uploaded, still clean up uploaded files
            if (uploadedFiles.length > 0) {
                try {
                    await Promise.all(
                        uploadedFiles.map((publicId) =>
                            cloudinary.v2.uploader.destroy(publicId).catch((err) => logger.error('Failed to delete uploaded file:', err))
                        )
                    )
                } catch (cleanupError) {
                    logger.error('File cleanup failed:', cleanupError)
                }
            }
        }

        return httpError('DOCUMENT VERIFICATION', next, error, req, 500)
    } finally {
        if (fs.existsSync(tmpDir)) {
            await fs.promises.rm(tmpDir, { recursive: true })
        }
    }
}

export const cancelBookingWithManualRollback = async (req, res, next) => {
    const maxRetries = 3
    let originalOrderState = null // Track original order state
    let originalCabState = null // Track original cab state
    let order = null
    let cab = null
    let bookingRemovedFromCab = false // Track if booking was removed from cab
    let Id = null
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            if (req.user.role !== 'Driver' && req.user.role !== 'Admin') {
                throw new CustomError(generic_msg.unauthorized_access, 403)
            }

            const { orderId } = req.body

            if (!orderId) {
                throw new CustomError('Order ID is required to cancel the booking', 400)
            }
            Id = orderId
            // Find the order
            order = await Order.findById(orderId)
            if (!order) {
                throw new CustomError(generic_msg.resource_not_found('Order'), 404)
            }

            // Store original order state for potential rollback
            originalOrderState = {
                bookingStatus: order.bookingStatus,
                driverId: order.driverId,
                driverShare: order.driverShare ? { ...order.driverShare } : undefined,
                driverCut: order.driverShare.driverCut,
                driverStatus: order.driverShare.status,
                bookedCab: order.bookedCab
            }

            // Find the cab associated with the order and remove the booking
            if (order.bookedCab) {
                cab = await Cab.findById(order.bookedCab)
                if (!cab) {
                    throw new CustomError(generic_msg.resource_not_found('Cab'), 404)
                }

                // Store original cab state (if cab has bookings)
                if (cab.upcomingBookings) {
                    originalCabState = {
                        bookings: [...cab.upcomingBookings]
                    }
                }

                // Remove booking from cab
                // @ts-ignore
                if (typeof cab.removeBooking === 'function') {
                    // @ts-ignore
                    cab.removeBooking(orderId)
                    await cab.save()
                    bookingRemovedFromCab = true
                } else if (cab.upcomingBookings && Array.isArray(cab.upcomingBookings)) {
                    // Manual removal if removeBooking method doesn't exist
                    const originalLength = cab.upcomingBookings.length
                    // @ts-ignore
                    cab.upcomingBookings = cab.upcomingBookings.filter(
                        (booking) => booking.orderId?.toString() !== orderId.toString() && booking._id?.toString() !== orderId.toString()
                    )

                    if (cab.upcomingBookings.length !== originalLength) {
                        await cab.save()
                        bookingRemovedFromCab = true
                    }
                }
            }

            // Update the order status and remove driver-related information
            // Keep the original bookedCab value to maintain the association
            const updateFields = {
                bookingStatus: 'Pending',
                driverId: null
                // Don't modify bookedCab - keep it as is
            }

            // Remove driver-related fields
            if (order.driverShare !== undefined) {
                order.driverShare = undefined
            }
            if (order.driverShare.driverCut !== undefined) {
                order.driverShare.driverCut = undefined
            }
            if (order.driverShare.status !== undefined) {
                order.driverShare.status = undefined
            }

            // Apply updates (bookedCab remains unchanged)
            Object.assign(order, updateFields)
            await order.save()

            return httpResponse(req, res, 201, generic_msg.operation_success('Cancel Booking by driver '), null, null, null)
        } catch (err) {
            // Manual rollback on error
            try {
                // Restore original order state
                if (order && originalOrderState) {
                    order.bookingStatus = originalOrderState.bookingStatus
                    order.driverId = originalOrderState.driverId
                    order.bookedCab = originalOrderState.bookedCab

                    if (originalOrderState.driverShare !== undefined) {
                        order.driverShare = originalOrderState.driverShare
                    }
                    if (originalOrderState.driverCut !== undefined) {
                        order.driverShare.driverCut = originalOrderState.driverCut
                    }
                    if (originalOrderState.driverStatus !== undefined) {
                        order.driverShare.status = originalOrderState.driverStatus
                    }

                    await order.save().catch((rollbackError) => logger.error('Failed to restore order state during rollback:', rollbackError))
                }

                // Restore original cab state
                if (cab && originalCabState && bookingRemovedFromCab) {
                    // @ts-ignore
                    if (typeof cab.addBooking === 'function' && originalOrderState.bookedCab) {
                        // If cab has addBooking method, re-add the booking
                        await cab
                            // @ts-ignore
                            .addBooking(Id, order.departureDate, order.dropOffDate)
                            .catch((rollbackError) => logger.error('Failed to re-add booking to cab during rollback:', rollbackError))
                    } else if (originalCabState.bookings) {
                        // Restore original bookings array

                        cab.upcomingBookings.splice(0, cab.upcomingBookings.length, ...originalCabState.bookings)
                        await cab.save().catch((rollbackError) => logger.error('Failed to restore cab bookings during rollback:', rollbackError))
                    }
                }
            } catch (rollbackError) {
                logger.error('Rollback failed during booking cancellation:', rollbackError)
            }

            // Handle write conflicts with exponential backoff
            if (err.message && err.message.includes('Write conflict')) {
                if (attempt < maxRetries) {
                    const delay = Math.pow(2, attempt) * 100 // Exponential backoff
                    logger.info(`Write conflict detected, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries + 1})`)
                    await new Promise((resolve) => setTimeout(resolve, delay))

                    // Reset state tracking variables for retry
                    originalOrderState = null
                    originalCabState = null
                    bookingRemovedFromCab = false

                    continue // Retry after the delay
                } else {
                    logger.error('Max retries exceeded for write conflict')
                    return httpError('CANCEL BOOKING', next, new CustomError(generic_msg.operation_failed('Cancel Booking by driver'), 409), req)
                }
            } else {
                // Handle other errors (validation, etc.)
                logger.error('Booking cancellation failed:', { meta: { error: err } })
                return httpError('CANCEL BOOKING', next, err, req, 500)
            }
        }
    }
    // If all attempts fail, return a generic error response
    return httpError('CANCEL BOOKING', next, new CustomError('Failed to cancel booking after multiple attempts', 500), req)
}

export const confirmBookingWithManualRollback = async (req, res, next) => {
    let originalOrderState = null // Track original order state
    let originalCabState = null // Track original cab state
    let order = null
    let cab = null
    let bookingIndex = -1
    let orderUpdated = false
    let cabUpdated = false

    try {
        if (req.user.role !== 'Driver' && req.user.role !== 'Admin') {
            throw new CustomError(generic_msg.unauthorized_access, 403)
        }

        const { orderId } = req.body

        if (!orderId) {
            throw new CustomError('Order ID is required to confirm the booking', 400)
        }

        // Find the order first to store original state
        order = await Order.findById(orderId).populate({
            path: 'userId',
            select: 'username email phoneNumber'
        })

        if (!order) {
            throw new CustomError(generic_msg.resource_not_found('Order'), 404)
        }

        // Store original order state
        originalOrderState = {
            bookingStatus: order.bookingStatus
        }

        // Find the cab with this booking
        cab = await Cab.findOne({ 'upcomingBookings.orderId': orderId })
        if (!cab) {
            throw new CustomError('Cab with this booking not found', 404)
        }

        bookingIndex = cab.upcomingBookings.findIndex((booking) => booking.orderId.toString() === orderId)
        if (bookingIndex === -1) {
            throw new CustomError(`Booking not found in cab's upcoming bookings`, 404)
        }

        // Store original cab state
        originalCabState = {
            bookingAccepted: cab.upcomingBookings[bookingIndex].accepted
        }

        // Update order status
        order.bookingStatus = 'Confirmed'
        await order.save()
        orderUpdated = true

        // Update cab booking acceptance
        cab.upcomingBookings[bookingIndex].accepted = true
        await cab.save()
        cabUpdated = true

        // Send email notification (non-blocking)
        try {
            await sendMailWithRetry(
                order.userId.email,
                driver_emails.booking_confirmed_email_subject,
                // @ts-ignore
                driver_emails.booking_confirmed_email(order.userId.username)
            )
        } catch (emailError) {
            logger.error(generic_msg.email_sending_failed(order.userId.email), { error: emailError })
            // Continue even if email fails, but log the error
        }

        httpResponse(req, res, 200, generic_msg.operation_success('Confirmed Boooking'), null, null, null)
    } catch (error) {
        // Manual rollback on error
        try {
            // Restore original order state
            if (order && originalOrderState && orderUpdated) {
                order.bookingStatus = originalOrderState.bookingStatus
                await order.save().catch((rollbackError) => logger.error('Failed to restore order state during rollback:', rollbackError))
            }

            // Restore original cab state
            if (cab && originalCabState && cabUpdated && bookingIndex !== -1) {
                cab.upcomingBookings[bookingIndex].accepted = originalCabState.bookingAccepted
                await cab.save().catch((rollbackError) => logger.error('Failed to restore cab state during rollback:', rollbackError))
            }
        } catch (rollbackError) {
            logger.error('Rollback failed during booking confirmation:', rollbackError)
        }

        httpError('CONFIRM BOOKING', next, error, req, 500)
    }
}

export const completeBookingWithManualRollback = async (req, res, next) => {
    const maxRetries = 3
    let originalOrderId = null
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        // Track operations and their rollback data
        const operations = {
            cabBookingRemoved: { done: false, rollbackData: null },
            transactionCreated: { done: false, rollbackData: null },
            orderUpdated: { done: false, rollbackData: null }
        }

        try {
            const { role } = req.user
            const { orderId } = req.body

            // Validation code... (same as before)
            if (!['Driver', 'Admin'].includes(role)) {
                throw new CustomError(generic_msg.unauthorized_access, 403)
            }
            if (!orderId) {
                throw new CustomError(generic_msg.invalid_input('Order id'), 400)
            }
            originalOrderId = orderId
            // Fetch fresh documents for each attempt
            const order = await Order.findById(orderId)
            if (!order) {
                throw new CustomError(generic_msg.resource_not_found('Order'), 404)
            }

            // Store original states BEFORE any modifications
            const originalOrderState = {
                bookingStatus: order.bookingStatus,
                paidAmount: order.paidAmount,
                driverCut: order.driverShare?.driverCut,
                status: order.driverShare?.status,
                paidAt: order.driverShare?.paidAt,
                via: order.driverShare?.Via
            }
            const today = new Date()
            const dropOffDate = new Date(order.dropOffDate)

            if (dropOffDate >= today) {
                throw new CustomError('Booking can only be completed after the drop-off date has passed', 400)
            }
            const cab = await Cab.findById(order.bookedCab)
            if (!cab) {
                throw new CustomError(generic_msg.resource_not_found('Cab'), 404)
            }

            const bookingIndex = cab.upcomingBookings.findIndex((booking) => booking.orderId.toString() === orderId.toString())
            if (bookingIndex === -1) {
                throw new CustomError('Booking not found in cab reservations', 404)
            }

            // Store booking details for rollback
            const originalBookingDetail = {
                orderId,
                departureDate: order.departureDate,
                dropOffDate: order.dropOffDate,
                bookingIndex
            }

            const driver = await User.findById(cab.belongsTo)
            if (!driver) {
                throw new CustomError(generic_msg.resource_not_found('Driver'), 404)
            }

            // Validation logic... (same as before)
            const driverCut = order.driverShare?.driverCut || 0
            if (driverCut < 0) {
                throw new CustomError('Invalid driver cut amount', 400)
            }

            const existingTransaction = await Transaction.findOne({ orderId: order._id })
            if (existingTransaction) {
                throw new CustomError('Transaction already exists for this order', 400)
            }

            // Operation 1: Remove booking from cab
            try {
                // @ts-ignore
                cab.removeBooking(orderId)
                await cab.save()
                operations.cabBookingRemoved.done = true
                operations.cabBookingRemoved.rollbackData = originalBookingDetail
            } catch (error) {
                throw new Error(`Failed to remove booking from cab: ${error.message}`)
            }

            // Operation 2: Create transaction
            let newTransaction
            try {
                const transactionData = {
                    userId: driver._id,
                    type: 'credit', // Fixed transaction type
                    amount: driverCut,
                    description: order.paymentMethod === 'Online' ? 'You will get paid by us' : 'You have been paid by the passenger',
                    isPending: order.paymentMethod === 'Online',
                    orderId: order._id,
                    createdAt: new Date()
                }
                if (order.paymentMethod !== 'Hybrid') {
                    transactionData.type = 'debit'
                }
                newTransaction = new Transaction(transactionData)
                await newTransaction.save()
                operations.transactionCreated.done = true
                operations.transactionCreated.rollbackData = newTransaction._id
            } catch (error) {
                throw new Error(`Failed to create transaction: ${error.message}`)
            }

            // Operation 3: Update order
            try {
                order.bookingStatus = 'Completed'
                order.paidAmount = order.bookingAmount

                if (order.paymentMethod === 'Hybrid') {
                    order.driverShare = {
                        ...order.driverShare,
                        Via: 'Customer',
                        status: 'Paid',
                        paidAt: new Date()
                    }
                }

                await order.save()
                operations.orderUpdated.done = true
                operations.orderUpdated.rollbackData = originalOrderState
            } catch (error) {
                throw new Error(`Failed to update order: ${error.message}`)
            }

            return httpResponse(req, res, 200, generic_msg.operation_success('Booking completed by driver'), null, null, null)
        } catch (err) {
            // Perform rollback in reverse order
            await performRollback(operations, originalOrderId)

            // Handle retries for write conflicts
            if (err.message && err.message.includes('Write conflict')) {
                if (attempt < maxRetries) {
                    const delay = Math.pow(2, attempt) * 100
                    logger.info(`Write conflict detected, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries + 1})`)
                    await new Promise((resolve) => setTimeout(resolve, delay))
                    continue
                } else {
                    logger.error('Max retries exceeded for write conflict')
                    return httpError('COMPLETE BOOKING', next, new CustomError('Server Down', 409), req)
                }
            } else {
                logger.error('Booking completion failed:', { meta: { error: err } })
                return httpError('COMPLETE BOOKING', next, err, req, 500)
            }
        }
    }

    return httpError('Complete Booking', next, new CustomError('Failed to complete booking after multiple attempts', 500), req)
}

// Separate rollback function for better organization
async function performRollback(operations, orderId) {
    try {
        // Rollback Order (Operation 3) - if it was updated
        if (operations.orderUpdated.done) {
            try {
                const freshOrder = await Order.findById(orderId)
                if (freshOrder && operations.orderUpdated.rollbackData) {
                    const { rollbackData } = operations.orderUpdated
                    freshOrder.bookingStatus = rollbackData.bookingStatus
                    freshOrder.paidAmount = rollbackData.paidAmount

                    if (rollbackData.driverCut !== undefined) {
                        freshOrder.driverShare.driverCut = rollbackData.driverCut
                        freshOrder.driverShare.status = rollbackData.status
                        freshOrder.driverShare.paidAt = rollbackData.paidAt
                        freshOrder.driverShare.Via = rollbackData.via
                    }

                    await freshOrder.save()
                    logger.info('✅ Order rollback completed')
                }
            } catch (error) {
                logger.error('❌ Failed to rollback order:', error)
            }
        }

        // Rollback Transaction (Operation 2) - if it was created
        if (operations.transactionCreated.done && operations.transactionCreated.rollbackData) {
            try {
                await Transaction.findByIdAndDelete(operations.transactionCreated.rollbackData)
                logger.info('✅ Transaction rollback completed')
            } catch (error) {
                logger.error('❌ Failed to rollback transaction:', error)
            }
        }

        // Rollback Cab Booking (Operation 1) - if it was removed
        if (operations.cabBookingRemoved.done && operations.cabBookingRemoved.rollbackData) {
            try {
                const { rollbackData } = operations.cabBookingRemoved
                const freshCab = await Cab.findById(rollbackData.cabId || (await Order.findById(orderId)).bookedCab)

                if (freshCab) {
                    // @ts-ignore
                    freshCab.addBooking(rollbackData.orderId, rollbackData.departureDate, rollbackData.dropOffDate)
                    await freshCab.save()
                    logger.info('✅ Cab booking rollback completed')
                }
            } catch (error) {
                logger.error('❌ Failed to rollback cab booking:', error)
            }
        }
    } catch (rollbackError) {
        logger.error('❌ Critical rollback failure:', rollbackError)
    }
}
export const getDriverWalletBalance = async (req, res, next) => {
    try {
        // Check authorization
        if (req.user.role !== 'Driver' && req.user.role !== 'Admin') {
            throw new CustomError(generic_msg.unauthorized_access, 403)
        }

        // Use aggregation pipeline for better performance
        const result = await Transaction.aggregate([
            {
                $match: {
                    userId: req.user._id,
                    isPending: true
                }
            },
            {
                $group: {
                    _id: null,
                    totalBalance: { $sum: '$amount' },
                    transactionCount: { $sum: 1 }
                }
            }
        ])

        const balance = result.length > 0 ? result[0].totalBalance : 0
        const transactionCount = result.length > 0 ? result[0].transactionCount : 0

        // Return the balance

        const message = 'Wallet balance retrieved successfully'
        const data = {
            name: req.user.username,
            memberSince: req.user.createdAt,
            balance,
            currency: 'INR',
            pendingTransactions: transactionCount
        }
        return httpResponse(req, res, 200, message, data)
    } catch (error) {
        return httpError('Get Driver Wallet Balance', next, error, req, 500)
    }
}

export const getDriverAllTransaction = async (req, res, next) => {
    try {
        if (req.user.role !== 'Driver' && req.user.role !== 'Admin') {
            throw new CustomError(generic_msg.unauthorized_access, 403)
        }

        const page = Number(req.query.page) || 1
        const limit = Number(req.query.limit) || 6
        const skip = (page - 1) * limit

        const filters = {
            userId: req.user._id
        }
        if (req.query.isPending !== undefined) {
            filters.isPending = req.query.isPending === 'true'
        }
        const transactions = await Transaction.find(filters).sort({ createdAt: -1 }).skip(skip).limit(limit).lean()

        if (!transactions || transactions.length === 0) {
            return httpResponse(req, res, 200, generic_msg.operation_success('All  driver transaction'), [], null, {
                currentPage: page,
                totalPages: 0,
                totalItems: 0,
                hasNextPage: false,
                hasPrevPage: false
            })
        }
        const totalTransactions = await Transaction.countDocuments(filters)

        const pagination = {
            currentPage: page,
            totalPages: Math.ceil(totalTransactions / limit),
            totalItems: totalTransactions,
            hasNextPage: page < Math.ceil(totalTransactions / limit),
            hasPrevPage: page > 1
        }
        return httpResponse(req, res, 200, generic_msg.operation_success('Get all transaction for driver'), transactions, null, pagination)
    } catch (error) {
        return httpError('Get all transaction for driver', next, error, req, 500)
    }
}

//New route with transaction

export const driverVerificationWithTransaction = async (req, res, next) => {
    const tmpDir = './tmp'
    const uploadedFiles = [] // Track uploaded files for cleanup
    let session = null

    try {
        if (req.user.role !== 'Driver') {
            throw new CustomError(generic_msg.unauthorized_access, 403)
        }

        // Start database transaction
        session = await mongoose.startSession()
        session.startTransaction()

        const user = await User.findById(req.user._id).session(session)
        if (!user) {
            throw new CustomError(generic_msg.resource_not_found('User'), 404)
        }

        await fs.promises.mkdir(tmpDir, { recursive: true }).catch((error) => {
            logger.error(`Failed to create temp directory:`, { meta: { error } })
            throw new CustomError('Failed to create temp directory', 500)
        })

        if (!req.files || !req.files.document) {
            throw new CustomError(driver_msg.invalid_doc_format, 400)
        }

        const documents = Array.isArray(req.files.document) ? req.files.document : [req.files.document]
        const docNames = [].concat(req.body['docName[]'] || [])

        const allowedFormats = ['image/jpeg', 'image/png', 'application/pdf']
        documents.forEach((doc) => {
            if (!allowedFormats.includes(doc.mimetype)) {
                throw new CustomError(driver_msg.invalid_doc_format, 400)
            }
            if (doc.size > 2 * 1024 * 1024) {
                throw new CustomError(driver_msg.doc_too_large, 400)
            }
        })

        // Upload documents to Cloudinary
        const uploadedDocuments = await Promise.all(
            documents.map(async (doc, index) => {
                try {
                    const uploadResult = await cloudinary.v2.uploader.upload(doc.tempFilePath, {
                        folder: 'TandT/DriverDocuments',
                        resource_type: 'auto'
                    })

                    // Track for potential cleanup
                    uploadedFiles.push(uploadResult.public_id)

                    fs.unlinkSync(doc.tempFilePath)

                    return {
                        docName: docNames[index] || `Document ${index + 1}`,
                        public_id: uploadResult.public_id,
                        url: uploadResult.secure_url,
                        uploadedAt: new Date()
                    }
                } catch (uploadError) {
                    logger.error(`Document upload failed: ${doc.name}`, { meta: { error: uploadError } })
                    throw new CustomError(driver_msg.doc_upload_failure, 500)
                }
            })
        )

        // Validate bank details
        const accNo = req.body['bankDetails[accNo]']
        const accountHolderName = req.body['bankDetails[accountHolderName]']
        const ifsc = req.body['bankDetails[ifsc]']
        const bankName = req.body['bankDetails[bankName]']

        if (!accNo || !ifsc || !bankName || !accountHolderName) {
            throw new CustomError(driver_msg.missing_bank_details, 400)
        }

        if (!/^\d+$/.test(accNo) || !/^[A-Za-z]{4}[0-9]{7}$/.test(ifsc)) {
            throw new CustomError(driver_msg.invalid_bank_details, 400)
        }

        // Initialize wallet properly
        if (!user.wallet) {
            user.wallet = {
                balance: 0,
                currency: 'INR',
                bankDetails: {}
            }
        }

        if (typeof user.wallet.balance !== 'number') {
            user.wallet.balance = 0
        }
        if (!user.wallet.currency) {
            user.wallet.currency = 'INR'
        }
        if (!user.wallet.bankDetails) {
            user.wallet.bankDetails = {}
        }

        // Update user data within transaction
        user.wallet.bankDetails = {
            accountHolderName,
            accNo: Number(accNo),
            ifsc,
            bankName
        }

        user.driverDocuments.push(...uploadedDocuments)
        user.isDocumentSubmited = true

        // Save user within transaction
        await user.save({ session })

        // Commit transaction - database changes are now permanent
        await session.commitTransaction()

        return httpResponse(req, res, 200, driver_msg.doc_upload_success, uploadedDocuments, null)
    } catch (error) {
        // Rollback database transaction
        if (session) {
            try {
                await session.abortTransaction()
            } catch (rollbackError) {
                logger.error('Transaction rollback failed:', rollbackError)
            }
        }

        // Clean up uploaded files from Cloudinary (external service cleanup)
        if (uploadedFiles.length > 0) {
            try {
                await Promise.all(
                    uploadedFiles.map((publicId) =>
                        cloudinary.v2.uploader.destroy(publicId).catch((err) => logger.error('Failed to delete uploaded file:', err))
                    )
                )
            } catch (cleanupError) {
                logger.error('File cleanup failed:', cleanupError)
            }
        }

        return httpError('DOCUMENT VERIFICATION', next, error, req, 500)
    } finally {
        // End session
        if (session) {
            await session.endSession()
        }

        // Clean up temporary directory
        if (fs.existsSync(tmpDir)) {
            await fs.promises.rm(tmpDir, { recursive: true })
        }
    }
}
export const cancelBookingWithTransaction = async (req, res, next) => {
    const maxRetries = 3

    // Authorization check - done once outside the retry loop for efficiency
    if (req.user.role !== 'Driver' && req.user.role !== 'Admin') {
        throw new CustomError(generic_msg.unauthorized_access, 403)
    }

    const { orderId } = req.body

    if (!orderId) {
        throw new CustomError('Order ID is required to cancel the booking', 400)
    }

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        // Declare session in loop scope to avoid unsafe references
        let currentSession = null

        try {
            // Start a new database session for transaction
            // This ensures all operations are atomic - either all succeed or all fail
            currentSession = await mongoose.startSession()

            // Begin transaction with read concern 'snapshot' and write concern 'majority'
            // This provides strong consistency and durability guarantees
            await currentSession.withTransaction(
                async () => {
                    // Find the order within the transaction
                    // Using currentSession ensures this read is part of the transaction
                    const order = await Order.findById(orderId).session(currentSession)
                    if (!order) {
                        throw new CustomError(generic_msg.resource_not_found('Order'), 404)
                    }

                    let cab = null

                    // Handle cab booking removal if order has a booked cab
                    if (order.bookedCab) {
                        // Find cab within the same transaction to maintain consistency
                        cab = await Cab.findById(order.bookedCab).session(currentSession)
                        if (!cab) {
                            throw new CustomError(generic_msg.resource_not_found('Cab'), 404)
                        }

                        // Remove booking from cab's upcoming bookings array
                        if (cab.upcomingBookings && Array.isArray(cab.upcomingBookings)) {
                            const originalLength = cab.upcomingBookings.length

                            // Filter out the booking by comparing both orderId and _id
                            // This handles different booking storage formats
                            // @ts-ignore
                            cab.upcomingBookings = cab.upcomingBookings.filter(
                                (booking) => booking.orderId?.toString() !== orderId.toString() && booking._id?.toString() !== orderId.toString()
                            )

                            // Only save if we actually removed something
                            if (cab.upcomingBookings.length !== originalLength) {
                                await cab.save({ session: currentSession })
                            }
                        }

                        // Handle custom removeBooking method if it exists
                        // Note: Custom methods need to be transaction-aware
                        // @ts-ignore
                        if (typeof cab.removeBooking === 'function') {
                            // Most custom methods don't support sessions, so we handle this carefully
                            // If the method doesn't accept session, it won't be part of the transaction
                            try {
                                // @ts-ignore
                                await cab.removeBooking(orderId, { session: currentSession })
                            } catch {
                                // Fallback: if method doesn't support session, use manual removal above
                                // The manual removal already happened, so we just log the fallback
                                logger.warn('removeBooking method may not support transactions, using manual removal')
                            }
                        }
                    }

                    // Update order fields within the transaction
                    // Reset booking status to 'Pending' and remove driver assignment
                    order.bookingStatus = 'Pending'
                    order.driverId = null

                    // Clean up driver-related fields
                    // Check if driverShare exists before trying to modify it
                    if (order.driverShare) {
                        // Set the entire driverShare object to undefined
                        // This removes all driver-related financial information
                        order.driverShare = undefined
                    }

                    // Note: We intentionally keep bookedCab unchanged
                    // This maintains the cab-order association even after driver cancellation
                    // This allows the booking to be reassigned to another driver for the same cab

                    // Save order changes within the transaction
                    await order.save({ session: currentSession })
                },
                {
                    // Transaction options for better reliability
                    readConcern: { level: 'snapshot' }, // Ensures consistent reads
                    writeConcern: { w: 'majority' }, // Ensures writes are acknowledged by majority of replica set
                    readPreference: 'primary' // Always read from primary to avoid stale data
                }
            )

            // If we reach here, transaction was successful
            // currentSession will be automatically ended when it goes out of scope
            return httpResponse(req, res, 201, generic_msg.operation_success('Cancel Booking by driver'), null, null, null)
        } catch (err) {
            // Transaction automatically rolls back on any error
            // No manual rollback needed - this is the key advantage of transactions

            // Handle MongoDB write conflicts with exponential backoff retry
            if (err.message && err.message.includes('Write conflict')) {
                if (attempt < maxRetries) {
                    const delay = Math.pow(2, attempt) * 100 // Exponential backoff: 100ms, 200ms, 400ms
                    logger.info(`Write conflict detected, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries + 1})`)

                    // Wait before retry to allow conflicting operations to complete
                    await new Promise((resolve) => setTimeout(resolve, delay))
                    continue // Retry the entire operation
                } else {
                    logger.error('Max retries exceeded for write conflict')
                    return httpError('CANCEL BOOKING', next, new CustomError(generic_msg.operation_failed('Cancel Booking by driver'), 409), req)
                }
            } else {
                // Handle all other errors (validation, network, business logic, etc.)
                logger.error('Booking cancellation failed:', { meta: { error: err } })
                return httpError('CANCEL BOOKING', next, err, req, 500)
            }
        } finally {
            // Cleanup: End session if it exists
            // This ensures proper resource cleanup even if errors occur
            if (currentSession) {
                await currentSession.endSession()
            }
        }
    }

    // Fallback error if all retry attempts are exhausted
    // This should rarely be reached due to the error handling above
    return httpError('CANCEL BOOKING', next, new CustomError('Failed to cancel booking after multiple attempts', 500), req)
}
export const confirmBookingWithTransaction = async (req, res, next) => {
    // Start a session for the transaction
    const session = await mongoose.startSession()

    try {
        // Check authorization
        if (req.user.role !== 'Driver' && req.user.role !== 'Admin') {
            throw new CustomError(generic_msg.unauthorized_access, 403)
        }

        const { orderId } = req.body

        if (!orderId) {
            throw new CustomError('Order ID is required to confirm the booking', 400)
        }

        // Start transaction
        const result = await session.withTransaction(
            async () => {
                // Find the order within transaction
                const order = await Order.findById(orderId)
                    .populate({
                        path: 'userId',
                        select: 'username email phoneNumber'
                    })
                    .session(session)

                if (!order) {
                    throw new CustomError(generic_msg.resource_not_found('Order'), 404)
                }

                // Find the cab with this booking within transaction
                const cab = await Cab.findOne({ 'upcomingBookings.orderId': orderId }).session(session)

                if (!cab) {
                    throw new CustomError('Cab with this booking not found', 404)
                }

                const bookingIndex = cab.upcomingBookings.findIndex((booking) => booking.orderId.toString() === orderId)

                if (bookingIndex === -1) {
                    throw new CustomError(`Booking not found in cab's upcoming bookings`, 404)
                }

                // Update order status within transaction
                order.bookingStatus = 'Confirmed'
                await order.save({ session })

                // Update cab booking acceptance within transaction
                cab.upcomingBookings[bookingIndex].accepted = true
                await cab.save({ session })

                // Return data needed for email notification
                return {
                    userEmail: order.userId.email,
                    username: order.userId.username
                }
            },
            {
                // Transaction options
                readPreference: 'primary',
                readConcern: { level: 'local' },
                writeConcern: { w: 'majority' }
            }
        )

        // Send email notification after successful transaction (non-blocking)
        // This is outside the transaction to avoid blocking the transaction for external service calls
        if (result) {
            setImmediate(async () => {
                try {
                    await sendMailWithRetry(
                        result.userEmail,
                        driver_emails.booking_confirmed_email_subject,
                        driver_emails.booking_confirmed_email(result.username)
                    )
                } catch (emailError) {
                    logger.error(generic_msg.email_sending_failed(result.userEmail), {
                        error: emailError
                    })
                }
            })
        }

        httpResponse(req, res, 200, generic_msg.operation_success('Confirmed Booking'), null, null, null)
    } catch (error) {
        // Transaction will automatically rollback on error
        logger.error('Booking confirmation failed:', error)
        httpError('CONFIRM BOOKING', next, error, req, 500)
    } finally {
        // Always end the session
        await session.endSession()
    }
}
export const completeBookingWithTransaction = async (req, res, next) => {
    const maxRetries = 3

    const bookingOperation = async (session) => {
        const { role } = req.user
        const { orderId } = req.body

        // Validation
        if (!['Driver', 'Admin'].includes(role)) {
            throw new CustomError(generic_msg.unauthorized_access, 403)
        }
        if (!orderId) {
            throw new CustomError(generic_msg.invalid_input('Order id'), 400)
        }

        // Fetch documents within transaction
        const order = await Order.findById(orderId).session(session)
        if (!order) {
            throw new CustomError(generic_msg.resource_not_found('Order'), 404)
        }
        const today = new Date()
        const dropOffDate = new Date(order.dropOffDate)

        if (dropOffDate >= today) {
            throw new CustomError('Booking can only be completed after the drop-off date has passed', 400)
        }
        const cab = await Cab.findById(order.bookedCab).session(session)
        if (!cab) {
            throw new CustomError(generic_msg.resource_not_found('Cab'), 404)
        }

        const bookingIndex = cab.upcomingBookings.findIndex((booking) => booking.orderId.toString() === orderId.toString())
        if (bookingIndex === -1) {
            throw new CustomError('Booking not found in cab reservations', 404)
        }

        const driver = await User.findById(cab.belongsTo).session(session)
        if (!driver) {
            throw new CustomError(generic_msg.resource_not_found('Driver'), 404)
        }

        // Business logic validation
        const driverCut = order.driverShare?.driverCut || 0
        if (driverCut < 0) {
            throw new CustomError('Invalid driver cut amount', 400)
        }

        const existingTransaction = await Transaction.findOne({ orderId: order._id }).session(session)
        if (existingTransaction) {
            throw new CustomError('Transaction already exists for this order', 400)
        }

        // Perform all operations
        // @ts-ignore
        cab.removeBooking(orderId, session)
        await cab.save({ session })

        const transactionData = {
            userId: driver._id,
            type: order.paymentMethod === 'Hybrid' ? 'credit' : 'debit',
            amount: driverCut,
            description: order.paymentMethod === 'Online' ? 'You will get paid by us' : 'You have been paid by the passenger',
            isPending: order.paymentMethod === 'Online',
            orderId: order._id,
            createdAt: new Date()
        }

        const newTransaction = new Transaction(transactionData)
        await newTransaction.save({ session })

        order.bookingStatus = 'Completed'
        order.paidAmount = order.bookingAmount

        if (order.paymentMethod === 'Hybrid') {
            order.driverShare = {
                ...order.driverShare,
                Via: 'Customer',
                status: 'Paid',
                paidAt: new Date()
            }
        }

        await order.save({ session })

        return { orderId, message: 'Booking completed successfully' }
    }

    try {
        const result = await withTransaction(bookingOperation, maxRetries)

        logger.info(' Booking completed successfully', { orderId: result.orderId })

        return httpResponse(req, res, 200, generic_msg.operation_success('Booking completed by driver'), null, null, null)
    } catch (err) {
        logger.error('Booking completion failed:', {
            meta: {
                error: err.message,
                stack: err.stack
            }
        })
        return httpError('COMPLETE BOOKING', next, err, req, 500)
    }
}

// Reusable transaction wrapper utility
async function withTransaction(operation, maxRetries = 3) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const session = await mongoose.startSession()

        try {
            await session.startTransaction()

            const result = await operation(session)

            await session.commitTransaction()
            return result
        } catch (err) {
            await session.abortTransaction()

            // Retry logic for transient errors
            const shouldRetry =
                err.message?.includes('Write conflict') || (err.name === 'MongoServerError' && err.hasErrorLabel('TransientTransactionError'))

            if (shouldRetry && attempt < maxRetries) {
                const delay = Math.pow(2, attempt) * 100
                logger.info(`Transaction error, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries + 1})`)
                await new Promise((resolve) => setTimeout(resolve, delay))
                continue
            }

            throw err
        } finally {
            await session.endSession()
        }
    }

    throw new Error('Transaction failed after maximum retries')
}
