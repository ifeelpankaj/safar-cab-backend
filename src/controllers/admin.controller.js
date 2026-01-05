// @ts-nocheck
import { Cab } from '../models/cab.model.js'
import { Order } from '../models/order.model.js'
import { User } from '../models/user.model.js'
import CustomError from '../utils/customeError.js'
import { calculatePercentage } from '../utils/statistics.js'
import httpError from '../utils/httpError.js'
import httpResponse from '../utils/httpResponse.js'
import { EApplicationEnvironment } from '../constants/application.js'
import logger from '../utils/logger.js'
import { fundTransfer, setupRazorpayAccount } from '../services/payout.service.js'
import { sendMailWithRetry } from '../services/email.service.js'
import { driver_emails, transaction_emails } from '../constants/emails.js'
import date from '../utils/date.js'
import config from '../config/config.js'
import { Transaction } from '../models/transaction.model.js'
import { driver_msg, generic_msg } from '../constants/res.message.js'
import mongoose from 'mongoose'
// import mongoose from 'mongoose'

//New Ones
export const adminStats = async (req, res, next) => {
    try {
        if (req.user.role !== 'Admin') {
            throw new CustomError(generic_msg.unauthorized_access, 403)
        }

        let stats = {}
        const today = new Date()
        const sixMonthsAgo = new Date()
        sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6)

        const thisMonth = {
            start: new Date(today.getFullYear(), today.getMonth(), 1),
            end: today
        }

        const lastMonth = {
            start: new Date(today.getFullYear(), today.getMonth() - 1, 1),
            end: new Date(today.getFullYear(), today.getMonth(), 0)
        }

        // Fetch promises in parallel for efficiency
        const [
            thisMonthCabs,
            thisMonthUsers,
            thisMonthOrders,
            lastMonthCabs,
            lastMonthUsers,
            lastMonthOrders,
            cabCount,
            orderCount,
            userCount,
            lastSixMonthOrders,
            cabTypes, // Cab capacities
            userTypes,
            latestTransaction,
            passenger
        ] = await Promise.all([
            Cab.find({ createdAt: { $gte: thisMonth.start, $lte: thisMonth.end } }),
            User.find({ createdAt: { $gte: thisMonth.start, $lte: thisMonth.end } }),
            Order.find({ createdAt: { $gte: thisMonth.start, $lte: thisMonth.end } }),
            Cab.find({ createdAt: { $gte: lastMonth.start, $lte: lastMonth.end } }),
            User.find({ createdAt: { $gte: lastMonth.start, $lte: lastMonth.end } }),
            Order.find({ createdAt: { $gte: lastMonth.start, $lte: lastMonth.end } }),
            Cab.countDocuments(),
            Order.find({}).select('bookingAmount'),
            User.countDocuments(),
            Order.find({ createdAt: { $gte: sixMonthsAgo, $lte: today } }),
            Cab.distinct('capacity'),
            User.find({ role: 'Driver' }),

            Order.find({ bookingStatus: 'Pending' }).select(['bookingAmount', 'paymentMethod', 'bookingStatus', 'createdAt']).limit(2),
            User.find({ role: 'Passenger' })
        ])

        // Calculate monthly revenue and total order count
        const thisMonthRevenue = thisMonthOrders.reduce((total, order) => total + (order.bookingAmount || 0), 0)
        const lastMonthRevenue = lastMonthOrders.reduce((total, order) => total + (order.bookingAmount || 0), 0)
        const revenue = orderCount.reduce((total, order) => total + (order.bookingAmount || 0), 0)

        // Count summary
        const count = {
            revenue,
            users: userCount,
            cabs: cabCount,
            order: orderCount.length
        }

        // Calculate percentage change
        const changePercent = {
            revenue: calculatePercentage(thisMonthRevenue, lastMonthRevenue),
            cabs: calculatePercentage(thisMonthCabs.length, lastMonthCabs.length),
            user: calculatePercentage(thisMonthUsers.length, lastMonthUsers.length),
            order: calculatePercentage(thisMonthOrders.length, lastMonthOrders.length)
        }

        // Chart Data (last 6 months: total transactions and revenue per month)
        const orderMonthCounts = new Array(6).fill(0)
        const orderMonthlyRevenue = new Array(6).fill(0)

        lastSixMonthOrders.forEach((order) => {
            const monthDiff = (today.getMonth() - order.createdAt.getMonth() + 12) % 12
            if (monthDiff < 6) {
                orderMonthCounts[6 - monthDiff - 1] += 1
                orderMonthlyRevenue[6 - monthDiff - 1] += Math.round(order.bookingAmount * 0.1)
            }
        })

        // Type count (count cabs by capacity)
        const typeOfCabsCountPromise = cabTypes.map((capacity) => Cab.countDocuments({ capacity }))
        const typeOfCabsCount = await Promise.all(typeOfCabsCountPromise)

        const typeCount = cabTypes.map((capacity, i) => ({
            capacity,
            count: typeOfCabsCount[i]
        }))

        // User ratio (Passengers vs Drivers)
        const userRatio = {
            Admin: userCount - (passenger.length + userTypes.length),
            Passenger: passenger.length,
            Driver: userTypes.length
        }

        // Latest transactions with necessary fields
        const modifiedLatestTransaction = latestTransaction.map((txn) => ({
            _id: txn._id,
            bookingAmount: txn.bookingAmount,
            paymentMethod: txn.paymentMethod,
            bookingStatus: txn.bookingStatus,
            createdAt: txn.createdAt
        }))

        // Assemble final stats object
        stats = {
            typeCount,
            modifiedLatestTransaction,
            totalRevenue: Math.round(revenue),
            changePercent,
            count,
            userRatio,
            chart: {
                order: orderMonthCounts,
                revenue: orderMonthlyRevenue
            }
        }

        httpResponse(req, res, 200, generic_msg.operation_success('Stats'), stats, null, null)
    } catch (error) {
        httpError('ADMIN STATS', next, error, req, 500)
    }
}

export const verifyDriverWithRollback = async (req, res, next) => {
    let originalDriverState = null // Track original driver state
    let driver = null

    try {
        if (req.user.role !== 'Admin') {
            throw new CustomError(generic_msg.unauthorized_access, 403)
        }

        const { id } = req.params

        if (!id) {
            throw new CustomError(generic_msg.invalid_input('Id'), 400)
        }

        driver = await User.findOne({ _id: id, role: 'Driver' })

        if (!driver) {
            throw new CustomError(generic_msg.resource_not_found('Driver'), 404)
        }

        if (!driver.haveCab) {
            throw new CustomError(generic_msg.invalid_request, 400)
        }

        if (driver.driverDocuments.length <= 0) {
            throw new CustomError(driver_msg.invalid_doc_format, 400)
        }

        // Store original state for potential rollback
        originalDriverState = {
            isVerifiedDriver: driver.isVerifiedDriver
        }

        // Toggle the verification status (backend handles the logic)
        const newVerificationStatus = !driver.isVerifiedDriver

        // Update driver verification status
        const updatedDriver = await User.findByIdAndUpdate(id, { isVerifiedDriver: newVerificationStatus }, { new: true, runValidators: true })

        if (!updatedDriver) {
            throw new CustomError('Error in Updating Driver Docs', 400)
        }
        let message
        if (newVerificationStatus) {
            message = driver_msg.verification_complete
        } else {
            message = driver_msg.verification_revoked
        }

        // Send email notification (non-blocking)
        try {
            await sendMailWithRetry(
                driver.email,
                driver_emails.driver_verification_email_subject,
                newVerificationStatus
                    ? driver_emails.driver_verified_email(driver.username)
                    : driver_emails.driver_verification_revoked(driver.username)
            )
        } catch (emailError) {
            logger.error(generic_msg.email_sending_failed(driver.email), { meta: { error: emailError } })
            // Continue as the verification is successful
        }

        httpResponse(req, res, 200, message, null, null, null)
    } catch (error) {
        // Manual rollback on error
        if (originalDriverState && driver) {
            try {
                // Restore original driver state
                await User.findByIdAndUpdate(driver._id, { isVerifiedDriver: originalDriverState.isVerifiedDriver }).catch((rollbackError) =>
                    logger.error('Failed to rollback driver state:', rollbackError)
                )
            } catch (rollbackError) {
                logger.error('Rollback failed:', rollbackError)
            }
        }

        httpError('DRIVER VERIFICATION', next, error, req, 500)
    }
}
export const setRateForCab = async (req, res, next) => {
    try {
        if (req.user.role !== 'Admin') {
            throw new CustomError(generic_msg.unauthorized_access, 403)
        }

        const { rate } = req.body
        const cabId = req.params.id

        if (!cabId || !rate) {
            throw new CustomError(generic_msg.invalid_input('CabId or Rate'), 400)
        }

        if (isNaN(rate) || rate <= 0) {
            throw new CustomError(generic_msg.invalid_input('rate'), 400)
        }

        const updatedCab = await Cab.findById(cabId)

        if (!updatedCab) {
            throw new CustomError(generic_msg.resource_not_found('Cab'), 400)
        }
        if (rate === 1) {
            updatedCab.rate = rate
            updatedCab.isReady = false
            await updatedCab.save()
        } else {
            updatedCab.rate = rate
            updatedCab.isReady = true
            await updatedCab.save()
        }

        httpResponse(req, res, 200, generic_msg.operation_success('Set rate for cab'), updatedCab, null, null)
    } catch (error) {
        httpError(next, error, req, 500)
    }
}

export const assignBookingWithRollback = async (req, res, next) => {
    let originalOrderState = null // Track original order state
    let originalCabState = null // Track original cab state
    let order = null
    let cab = null
    let bookingAddedToCab = false // Track if booking was added to cab

    try {
        if (req.user.role !== 'Admin') {
            throw new CustomError(generic_msg.unauthorized_access, 403)
        }

        const { id } = req.params
        const { newCabId } = req.body

        if (!id || !newCabId) {
            throw new CustomError(generic_msg.invalid_input('Id or cabId'), 400)
        }

        // Fetch the order and populate user details
        order = await Order.findById(id).populate('userId', 'email username')
        if (!order) {
            throw new CustomError(generic_msg.resource_not_found('Booking'), 404)
        }

        // Store original order state for potential rollback
        originalOrderState = {
            driverId: order.driverId,
            bookedCab: order.bookedCab,
            bookingStatus: order.bookingStatus,
            driverShare: order.driverShare ? { ...order.driverShare } : null
        }

        // Fetch the cab and populate driver details
        cab = await Cab.findById(newCabId).populate('belongsTo', 'email username')
        if (!cab) {
            throw new CustomError(generic_msg.resource_not_found('Cab'), 404)
        }

        // Check for duplicate booking using the schema method
        // @ts-ignore
        if (cab.hasBooking(order._id)) {
            throw new CustomError('Booking is already assigned to this cab', 400)
        }

        // Store original cab state
        originalCabState = {
            bookings: [...cab.upcomingBookings]
        }

        // Check if driver is verified
        const driver = await User.findById(cab.belongsTo._id)
        if (!driver || !driver.isVerifiedDriver) {
            throw new CustomError('Cannot assign booking to unverified driver', 400)
        }

        // Calculate driver cut based on payment method
        let driverCut = order.bookingAmount // Full amount by default
        driverCut = order.bookingAmount - EApplicationEnvironment.HYBRID_PAYMENT_PERCENTAGE * order.bookingAmount

        // Update order details
        order.driverId = cab.belongsTo._id
        order.bookedCab = newCabId
        order.bookingStatus = 'Assigning'
        const pay = order.paymentMethod !== 'Online' ? 'Customer' : 'Us'

        // Assign the driver's share
        order.driverShare = {
            driverCut,
            Via: pay,
            status: null,
            paidAt: null
        }

        // Save the order
        await order.save()

        // Add booking to cab - the addBooking method now includes duplicate check
        // @ts-ignore
        await cab.addBooking(order._id, order.departureDate, order.dropOffDate)
        bookingAddedToCab = true

        // Prepare formatted dates for emails
        const formattedPickUpDate = date.formatShortDate(order.departureDate)
        const formattedDropOffDate = date.formatShortDate(order.dropOffDate)
        const location = order.exactLocation || order.pickupLocation

        // Send confirmation email to driver (non-blocking)
        try {
            await sendMailWithRetry(
                // @ts-ignore
                cab.belongsTo.email, // Driver's email
                driver_emails.driver_assignment_email_subject,
                driver_emails.driver_assignment_email(
                    // @ts-ignore
                    cab.belongsTo.username, // Driver's name
                    order._id.toString(),
                    formattedPickUpDate,
                    location,
                    formattedDropOffDate,
                    order.paymentMethod,
                    driverCut
                )
            )
        } catch (emailError) {
            // @ts-ignore
            logger.error(generic_msg.email_sending_failed(cab.belongsTo.email), { meta: { error: emailError } })
            // Continue as the assignment is successful
        }

        return httpResponse(req, res, 201, generic_msg.operation_success('Cab Assigned'), null, null, null)
    } catch (error) {
        // Manual rollback on error
        try {
            // Restore original order state
            if (order && originalOrderState) {
                // Handle driverId restoration - if original was null/undefined, unset the field
                if (originalOrderState.driverId) {
                    order.driverId = originalOrderState.driverId
                } else {
                    order.driverId = undefined // This will remove the field from MongoDB
                }

                order.bookedCab = originalOrderState.bookedCab
                order.bookingStatus = originalOrderState.bookingStatus
                order.driverShare = originalOrderState.driverShare

                await order.save().catch((rollbackError) => logger.error('Failed to restore order state during rollback:', rollbackError))
            }

            // Restore original cab state
            if (cab && originalCabState && bookingAddedToCab) {
                // Use the removeBooking method
                await cab
                    // @ts-ignore
                    .removeBooking(order._id)
                    .catch((rollbackError) => logger.error('Failed to remove booking from cab during rollback:', rollbackError))
            }
        } catch (rollbackError) {
            logger.error('Rollback failed:', rollbackError)
        }

        return httpError('ASSIGNING CAB', next, error, req, 500)
    }
}

export const allCabsAdmin = async (req, res, next) => {
    try {
        // Ensure only admins can access this route
        if (req.user.role !== 'Admin') {
            throw new CustomError(generic_msg.unauthorized_access, 403)
        }

        // Validate pagination parameters
        const page = Number(req.query.page) || 1
        const limit = Number(req.query.limit) || 6

        if (page < 1 || limit < 1) {
            throw new CustomError('Pagination Error', 400)
        }

        const skip = (page - 1) * limit

        // Fetch cabs with populated belongsTo field
        const cabs = await Cab.find()
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .populate('belongsTo', 'username') // Populate belongsTo with user's name
            .lean()

        if (!cabs || cabs.length === 0) {
            return httpResponse(req, res, 404, generic_msg.resource_not_found('Cab'), null, null, null)
        }

        // Transform the data to replace belongsTo object with just the name
        const transformedCabs = cabs.map((cab) => ({
            ...cab,
            // @ts-ignore
            belongsTo: cab.belongsTo?.username || 'Unknown Owner' // Replace with name or fallback
        }))

        // Total number of cabs for pagination meta info
        const totalCabs = await Cab.countDocuments()

        const pagination = {
            currentPage: page,
            totalPages: Math.ceil(totalCabs / limit),
            totalItems: totalCabs
        }

        // Send response with transformed data
        return httpResponse(req, res, 200, generic_msg.operation_success('Get all Admin Cabs'), transformedCabs, null, pagination)
    } catch (error) {
        // Log the error and pass it to the error handler
        return httpError('ALL ADMIN CABS', next, error, req, 500)
    }
}

export const getCabBookings = async (req, res, next) => {
    try {
        const allowedRoles = ['Driver', 'Admin']
        if (!allowedRoles.includes(req.user.role)) {
            throw new CustomError(generic_msg.unauthorized_access, 403)
        }

        const { id } = req.params
        if (!id) {
            throw new CustomError(generic_msg.invalid_input('Id'), 400)
        }

        // Pagination setup
        const page = Number(req.query.page) || 1
        const limit = Number(req.query.limit) || 6

        if (page < 1 || limit < 1) {
            throw new CustomError('Pagination Error', 400)
        }

        const skip = (page - 1) * limit

        // Fetch bookings for the cab with pagination
        const bookings = await Order.find({
            bookedCab: id,
            bookingStatus: { $in: ['Cancelled', 'Completed'] }
        })
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean()

        if (!bookings || bookings.length === 0) {
            return httpResponse(req, res, 404, generic_msg.resource_not_found('Bookings'), null, null, null)
        }

        // Total bookings count for this cab
        const totalBookings = await Order.countDocuments({
            bookedCab: id,
            bookingStatus: { $in: ['Cancelled', 'Completed'] }
        })

        const pagination = {
            currentPage: page,
            totalPages: Math.ceil(totalBookings / limit),
            totalItems: totalBookings
        }

        return httpResponse(req, res, 200, generic_msg.operation_success('Admin Cab Bookings'), bookings, null, pagination)
    } catch (error) {
        return httpError('GET CAB BOOKINGS', next, error, req, 500)
    }
}

export const getCabUpcomingBookings = async (req, res, next) => {
    try {
        const allowedRoles = ['Driver', 'Admin']
        if (!allowedRoles.includes(req.user.role)) {
            throw new CustomError(generic_msg.unauthorized_access, 403)
        }

        const { id } = req.params
        if (!id) {
            throw new CustomError(generic_msg.invalid_input('Id'), 400)
        }

        // Pagination setup
        const page = Number(req.query.page) || 1
        const limit = Number(req.query.limit) || 6

        if (page < 1 || limit < 1) {
            throw new CustomError('Pagination Error', 400)
        }

        const skip = (page - 1) * limit

        // Fetch upcoming bookings for the cab with pagination
        const bookings = await Order.find({
            bookedCab: id,
            bookingStatus: { $in: ['Assigning', 'Confirmed'] },
            departureDate: { $gte: new Date() }
        })
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean()

        if (!bookings || bookings.length === 0) {
            return httpResponse(req, res, 200, generic_msg.resource_not_found('Upcoming Bookings'), null, null, null)
        }

        // Total upcoming bookings count for this cab
        const totalBookings = await Order.countDocuments({
            bookedCab: id,
            bookingStatus: { $in: ['Assigning', 'Confirmed'] },
            departureDate: { $gte: new Date() }
        })

        const pagination = {
            currentPage: page,
            totalPages: Math.ceil(totalBookings / limit),
            totalItems: totalBookings
        }

        return httpResponse(req, res, 200, generic_msg.operation_success('Admin Upcomming Booking'), bookings, null, pagination)
    } catch (error) {
        return httpError('GET CAB UPCOMING BOOKINGS', next, error, req, 500)
    }
}

export const getUserBooking = async (req, res, next) => {
    try {
        const allowedRoles = ['Admin']
        if (!allowedRoles.includes(req.user.role)) {
            throw new CustomError(generic_msg.unauthorized_access, 403)
        }

        const { id } = req.params
        if (!id) {
            throw new CustomError(generic_msg.invalid_input('Id'), 400)
        }

        const user = await User.findById(id)
        if (!user) {
            throw new CustomError(generic_msg.resource_not_found('User'), 404)
        }

        // Pagination setup
        const page = Number(req.query.page) || 1
        const limit = Number(req.query.limit) || 6

        if (page < 1 || limit < 1) {
            return next(new CustomError('Pagination Error', 400))
        }

        const skip = (page - 1) * limit
        const currentDate = new Date()

        // Build query based on the target user's role (not requesting user's role)
        const query = {
            dropOffDate: { $lt: currentDate } // Less than current date/time (completed bookings)
        }

        if (user.role === 'Driver') {
            // If the target user is a driver, find orders where driverId matches
            query.driverId = { $exists: true, $ne: null, $eq: id }
        } else {
            // If the target user is a passenger, find orders by userId
            query.userId = id
        }

        // Fetch bookings for the user/driver where dropOffDate is less than current date/time (completed bookings)
        const bookings = await Order.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean()

        if (!bookings || bookings.length === 0) {
            const bookingType = user.role === 'Driver' ? 'Completed Driver Bookings' : 'Completed Bookings'
            return httpResponse(req, res, 404, generic_msg.resource_not_found(bookingType), null, null, null)
        }

        // Count total completed bookings for pagination
        const totalBookings = await Order.countDocuments(query)

        const pagination = {
            currentPage: page,
            totalPages: Math.ceil(totalBookings / limit),
            totalItems: totalBookings
        }

        return httpResponse(req, res, 200, generic_msg.operation_success('Admin user Bookings'), bookings, null, pagination)
    } catch (error) {
        return httpError('GET USER BOOKINGS', next, error, req, 500)
    }
}

export const getUserUpcomingBookings = async (req, res, next) => {
    try {
        const allowedRoles = ['Admin']
        if (!allowedRoles.includes(req.user.role)) {
            throw new CustomError(generic_msg.unauthorized_access, 403)
        }

        const { id } = req.params
        if (!id) {
            return next(new CustomError(generic_msg.invalid_input('Id'), 400))
        }
        const user = await User.findById(id)
        if (!user) {
            throw new CustomError(generic_msg.resource_not_found('User'), 404)
        }
        // Pagination setup
        const page = Number(req.query.page) || 1
        const limit = Number(req.query.limit) || 6

        if (page < 1 || limit < 1) {
            return next(new CustomError('Pagination Error', 400))
        }

        const skip = (page - 1) * limit
        const currentDate = new Date()
        const query = {
            dropOffDate: { $gt: currentDate } // Less than current date/time (completed bookings)
        }
        if (user.role === 'Driver') {
            // If the target user is a driver, find orders where driverId matches
            query.driverId = { $exists: true, $ne: null, $eq: id }
        } else {
            // If the target user is a passenger, find orders by userId
            query.userId = id
        }
        // Fetch upcoming bookings where dropOffDate is greater than current date/time
        const bookings = await Order.find(query)
            .sort({ dropOffDate: 1 }) // Sort by dropOffDate ascending for upcoming bookings
            .skip(skip)
            .limit(limit)
            .lean()

        if (!bookings || bookings.length === 0) {
            return httpResponse(req, res, 200, generic_msg.resource_not_found('Upcoming Bookings'), null, null, null)
        }

        // Count total upcoming bookings for pagination
        const totalBookings = await Order.countDocuments(query)

        const pagination = {
            currentPage: page,
            totalPages: Math.ceil(totalBookings / limit),
            totalItems: totalBookings
        }

        return httpResponse(req, res, 200, generic_msg.OPERATION_SUCCESS, bookings, null, pagination)
    } catch (error) {
        return httpError('GET USER UPCOMING BOOKINGS', next, error, req, 500)
    }
}

export const allOrdersAdmin = async (req, res, next) => {
    try {
        if (req.user.role !== 'Admin') {
            throw new CustomError(generic_msg.unauthorized_access, 403)
        }

        // Validate pagination parameters
        const page = Number(req.query.page) || 1
        const limit = Number(req.query.limit) || 5

        if (page < 1 || limit < 1) {
            throw new CustomError('Pagination Error', 400)
        }

        const skip = (page - 1) * limit

        // Build filter object
        const filter = {}

        // Check for bookingStatus parameter - only filter if it exists and is not empty
        if (req.query.bookingStatus && req.query.bookingStatus.trim() !== '') {
            // Validate bookingStatus against allowed values
            const allowedStatuses = ['Pending', 'Assigning', 'Confirmed', 'Completed', 'Cancelled']

            if (!allowedStatuses.includes(req.query.bookingStatus)) {
                throw new CustomError('Invalid booking status. Allowed values: pending, confirmed, cancelled, completed, processing', 400)
            }

            filter.bookingStatus = req.query.bookingStatus
        }
        // If bookingStatus is not provided or empty, filter remains empty {} - showing all orders

        // Get total count for pagination (before applying skip/limit)
        const totalOrders = await Order.countDocuments(filter)

        // Fetch orders with filter
        const orders = await Order.find(filter)
            .sort({ createdAt: -1 }) // Changed to descending order (newest first)
            .skip(skip)
            .limit(limit)
            .populate('userId', 'username email')
            .lean()

        if (!orders || orders.length === 0) {
            return httpResponse(req, res, 204, generic_msg.resource_not_found('Orders'), null, null, null)
        }

        const pagination = {
            currentPage: page,
            totalPages: Math.ceil(totalOrders / limit),
            totalItems: totalOrders,
            hasNextPage: page < Math.ceil(totalOrders / limit),
            hasPrevPage: page > 1
        }

        return httpResponse(req, res, 200, generic_msg.operation_success('Admin all orders'), orders, null, pagination)
    } catch (error) {
        return httpError('ALL ADMIN ORDER', next, error, req, 500)
    }
}

export const allUpcommingBookingsAdmin = async (req, res, next) => {
    try {
        if (req.user.role !== 'Admin') {
            throw new CustomError(generic_msg.unauthorized_access, 403)
        }

        // Validate pagination parameters
        const page = Number(req.query.page) || 1
        const limit = Number(req.query.limit) || 5

        if (page < 1 || limit < 1) {
            throw new CustomError('Pagination Error', 400)
        }

        const skip = (page - 1) * limit

        // Filter for upcoming bookings - dropoffDate greater than current date
        const filter = {
            dropOffDate: { $gt: new Date() }
        }

        // Get total count for pagination (before applying skip/limit)
        const totalOrders = await Order.countDocuments(filter)

        // Fetch orders with filter
        const orders = await Order.find(filter)
            .sort({ dropoffDate: 1 }) // Sort by dropoffDate ascending (nearest upcoming first)
            .skip(skip)
            .limit(limit)
            .populate('userId', 'username email')
            .lean()

        if (!orders || orders.length === 0) {
            return httpResponse(req, res, 404, generic_msg.resource_not_found('Upcoming Orders'), null, null, null)
        }

        const pagination = {
            currentPage: page,
            totalPages: Math.ceil(totalOrders / limit),
            totalItems: totalOrders,
            hasNextPage: page < Math.ceil(totalOrders / limit),
            hasPrevPage: page > 1
        }

        return httpResponse(req, res, 200, generic_msg.operation_success('Admin All Upcomming Bookings'), orders, null, pagination)
    } catch (error) {
        return httpError('ALL UPCOMING BOOKINGS ADMIN', next, error, req, 500)
    }
}

export const modifyBookingAdmin = async (req, res, next) => {
    let originalData = null
    let bookingId = null
    let cabId = null
    let originalCabBookings = null

    try {
        const orderId = req.params.id
        const { pickupLocation, departureDate, dropOffDate, exactLocation, destination, numberOfPassengers, passengers } = req.body

        // Validation
        if (!orderId) {
            throw new CustomError(generic_msg.invalid_input('OrderId'), 400)
        }

        bookingId = orderId

        // Find the existing booking
        const existingBooking = await Order.findById(orderId)
        if (!existingBooking) {
            throw new CustomError(generic_msg.resource_not_found('Order'), 404)
        }

        // Get the cab to check capacity
        const cab = await Cab.findById(existingBooking.bookedCab)
        if (!cab) {
            throw new CustomError('Associated cab not found', 404)
        }

        // Store original data for rollback
        originalData = {
            pickupLocation: existingBooking.pickupLocation,
            departureDate: existingBooking.departureDate,
            dropOffDate: existingBooking.dropOffDate,
            exactLocation: existingBooking.exactLocation,
            destination: existingBooking.destination,
            numberOfPassengers: existingBooking.numberOfPassengers,
            passengers: existingBooking.passengers
        }

        // Store original cab bookings for rollback
        cabId = existingBooking.bookedCab
        originalCabBookings = [...cab.upcomingBookings]

        // Prepare update object with only provided fields
        const updateFields = {}

        if (pickupLocation !== undefined) {
            updateFields.pickupLocation = pickupLocation
        }

        if (departureDate !== undefined) {
            // Validate date format if provided
            const parsedDepartureDate = new Date(departureDate)
            if (isNaN(parsedDepartureDate.getTime())) {
                throw new CustomError('Invalid departureDate format', 400)
            }

            // Ensure departureDate is not in the past (allow some buffer for admin modifications)
            const now = new Date()
            if (parsedDepartureDate < now) {
                logger.warn(`Admin setting departure date in past for booking ${orderId}`)
            }

            updateFields.departureDate = parsedDepartureDate
        }

        if (dropOffDate !== undefined) {
            // Validate date format if provided
            const parsedDropOffDate = new Date(dropOffDate)
            if (isNaN(parsedDropOffDate.getTime())) {
                throw new CustomError('Invalid dropOffDate format', 400)
            }

            // Ensure dropOffDate is after departureDate (use updated or existing)
            const finalDepartureDate = updateFields.departureDate || existingBooking.departureDate
            if (parsedDropOffDate <= finalDepartureDate) {
                throw new CustomError('Drop off date must be after departure date', 400)
            }

            updateFields.dropOffDate = parsedDropOffDate
        }

        if (exactLocation !== undefined) {
            updateFields.exactLocation = exactLocation
        }

        if (destination !== undefined) {
            updateFields.destination = destination
        }

        // Handle passengers modification - allow adding passengers up to cab capacity
        if (passengers !== undefined) {
            // Validate passengers array
            if (!Array.isArray(passengers)) {
                throw new CustomError('Passengers must be an array', 400)
            }

            // Check if passengers array length exceeds cab capacity
            if (passengers.length > cab.capacity) {
                throw new CustomError(`Number of passengers (${passengers.length}) cannot exceed cab capacity (${cab.capacity})`, 400)
            }

            // Must have at least 1 passenger
            if (passengers.length < 1) {
                throw new CustomError('At least one passenger is required', 400)
            }

            // Validate each passenger object
            for (let i = 0; i < passengers.length; i++) {
                const passenger = passengers[i]
                if (!passenger.firstName || !passenger.lastName) {
                    throw new CustomError(`Passenger ${i + 1}: firstName and lastName are required`, 400)
                }

                if (passenger.age !== undefined && (!Number.isInteger(passenger.age) || passenger.age < 0)) {
                    throw new CustomError(`Passenger ${i + 1}: Age must be a non-negative integer`, 400)
                }

                // Optional: Validate gender if provided
                if (passenger.gender && !['Male', 'Female', 'Other'].includes(passenger.gender)) {
                    throw new CustomError(`Passenger ${i + 1}: Invalid gender value`, 400)
                }
            }

            updateFields.passengers = passengers
            // Auto-update numberOfPassengers to match passengers array length
            updateFields.numberOfPassengers = passengers.length
        }

        // Handle numberOfPassengers modification (only if passengers array is not provided)
        if (numberOfPassengers !== undefined && passengers === undefined) {
            if (!Number.isInteger(numberOfPassengers) || numberOfPassengers < 1) {
                throw new CustomError('Number of passengers must be a positive integer', 400)
            }

            // Check if numberOfPassengers exceeds cab capacity
            if (numberOfPassengers > cab.capacity) {
                throw new CustomError(`Number of passengers (${numberOfPassengers}) cannot exceed cab capacity (${cab.capacity})`, 400)
            }

            // If only numberOfPassengers is updated, we need to adjust the passengers array
            const currentPassengersLength = existingBooking.passengers.length

            if (numberOfPassengers > currentPassengersLength) {
                // Add placeholder passengers directly to the document
                const passengersToAdd = numberOfPassengers - currentPassengersLength
                for (let i = 0; i < passengersToAdd; i++) {
                    existingBooking.passengers.push({
                        firstName: `Passenger${currentPassengersLength + i + 1}`,
                        lastName: 'ToBeUpdated',
                        age: undefined,
                        gender: undefined
                    })
                }
            } else if (numberOfPassengers < currentPassengersLength) {
                // Remove excess passengers by splicing the array
                existingBooking.passengers.splice(numberOfPassengers)
            }

            updateFields.numberOfPassengers = numberOfPassengers
        }

        // Check if there are any fields to update
        if (Object.keys(updateFields).length === 0) {
            throw new CustomError('No valid fields provided for update', 400)
        }

        // Handle cab booking updates if booking is in Assigning or Confirmed status
        if (existingBooking.bookingStatus === 'Assigning' || existingBooking.bookingStatus === 'Confirmed') {
            // Remove the current booking from cab's upcoming bookings
            // @ts-ignore
            const removed = await cab.removeBooking(orderId)
            if (!removed) {
                throw new CustomError('Failed to remove existing booking from cab', 500)
            }

            // Determine the dates to use for re-adding the booking
            const newDepartureDate = updateFields.departureDate || existingBooking.departureDate
            const newDropOffDate = updateFields.dropOffDate || existingBooking.dropOffDate

            // Add the booking back with updated information
            // @ts-ignore
            await cab.addBooking(existingBooking._id, newDepartureDate, newDropOffDate)
        }

        // Perform the order update
        const updatedBooking = await Order.findByIdAndUpdate(
            orderId,
            { $set: updateFields },
            {
                new: true,
                runValidators: true
            }
        ).populate('userId bookedCab driverId')

        if (!updatedBooking) {
            // Manual rollback if update fails
            await performRollback(bookingId, originalData, cabId, originalCabBookings)
            throw new CustomError('Failed to update booking', 500)
        }

        // Log the modification for audit trail
        // Only log in development
        if (config.ENV === EApplicationEnvironment.DEVELOPMENT) {
            logger.info(`Booking ${orderId} modified by admin`, {
                meta: {
                    originalData,
                    updatedFields: updateFields,
                    adminAction: 'MODIFY_BOOKING',
                    passengerChange: {
                        from: originalData.numberOfPassengers,
                        to: updatedBooking.numberOfPassengers
                    }
                }
            })
        }

        const responseData = {
            booking: updatedBooking,
            modifiedFields: Object.keys(updateFields),
            rollbackData: originalData,
            cabData: {
                cabId,
                originalCabBookings
            },
            passengerInfo: {
                originalCount: originalData.numberOfPassengers,
                newCount: updatedBooking.numberOfPassengers,
                cabCapacity: cab.capacity,
                availableSlots: cab.capacity - updatedBooking.numberOfPassengers
            }
        }

        httpResponse(req, res, 200, generic_msg.operation_success('Admin Modify booking'), responseData)
    } catch (error) {
        logger.error('Error in modifyBookingAdmin:', {
            meta: {
                error: error.message,
                orderId: bookingId,
                stack: error.stack
            }
        })

        // Perform manual rollback if we have the data
        if (originalData && bookingId) {
            try {
                await performRollback(bookingId, originalData, cabId, originalCabBookings)
                logger.info(`Manual rollback completed for booking ${bookingId}`)
            } catch (rollbackError) {
                logger.error('Manual rollback failed:', {
                    meta: {
                        error: rollbackError.message,
                        orderId: bookingId
                    }
                })
            }
        }

        httpError('ADMIN UPDATE BOOKING', next, error, req, 500)
    }
}

// Enhanced manual rollback function
const performRollback = async (bookingId, originalData, cabId = null, originalCabBookings = null) => {
    try {
        logger.info(`Starting manual rollback for booking ${bookingId}`)

        // Rollback the order data
        const rolledBackOrder = await Order.findByIdAndUpdate(bookingId, { $set: originalData }, { runValidators: true, new: true })

        if (!rolledBackOrder) {
            throw new Error('Failed to rollback order data')
        }

        // Rollback cab bookings if needed
        if (cabId && originalCabBookings) {
            const rolledBackCab = await Cab.findByIdAndUpdate(
                cabId,
                { $set: { upcomingBookings: originalCabBookings } },
                { runValidators: true, new: true }
            )

            if (!rolledBackCab) {
                throw new Error('Failed to rollback cab bookings')
            }

            logger.info(`Successfully rolled back cab bookings for booking ${bookingId}`)
        }

        logger.info(`Manual rollback completed successfully for booking ${bookingId}`)
        return true
    } catch (error) {
        logger.error(`Manual rollback failed for booking ${bookingId}:`, {
            meta: { error: error.message }
        })
        throw error
    }
}

// Enhanced rollback endpoint with detailed validation
export const rollbackBookingModification = async (req, res, next) => {
    try {
        const { orderId, rollbackData, cabId, originalCabBookings } = req.body

        if (!orderId || !rollbackData) {
            throw new CustomError('Order ID and rollback data are required', 400)
        }

        // Verify booking exists
        const existingBooking = await Order.findById(orderId)
        if (!existingBooking) {
            throw new CustomError(generic_msg.resource_not_found('Order'), 404)
        }

        // Only allow rollback for certain statuses
        if (!['Pending', 'Assigning', 'Confirmed'].includes(existingBooking.bookingStatus)) {
            throw new CustomError(`Cannot rollback booking in ${existingBooking.bookingStatus} status`, 400)
        }

        // Validate rollback data structure
        const requiredFields = ['pickupLocation', 'destination', 'numberOfPassengers', 'passengers']
        const missingFields = requiredFields.filter((field) => !(field in rollbackData))

        if (missingFields.length > 0) {
            throw new CustomError(`Missing required rollback fields: ${missingFields.join(', ')}`, 400)
        }

        // If cab data is provided, validate it
        if (cabId && !originalCabBookings) {
            throw new CustomError('Original cab bookings data required when cab ID is provided', 400)
        }

        // Perform rollback
        await performRollback(orderId, rollbackData, cabId, originalCabBookings)

        // Fetch updated booking
        const rolledBackBooking = await Order.findById(orderId).populate('userId bookedCab driverId')

        const responseData = {
            booking: rolledBackBooking,
            message: 'Booking rolled back successfully',
            rollbackInfo: {
                rolledBackFields: Object.keys(rollbackData),
                passengerChange: {
                    from: existingBooking.numberOfPassengers,
                    to: rolledBackBooking.numberOfPassengers
                }
            }
        }

        httpResponse(req, res, 200, 'Booking rolled back successfully', responseData)
    } catch (error) {
        logger.error('Error in rollbackBookingModification:', {
            meta: { error: error.message }
        })
        httpError('ROLLBACK BOOKING MODIFICATION', next, error, req, 500)
    }
}

// Additional utility function to check passenger capacity
export const checkPassengerCapacity = async (req, res, next) => {
    try {
        const { orderId } = req.params

        const booking = await Order.findById(orderId).populate('bookedCab', 'capacity')
        if (!booking) {
            throw new CustomError(generic_msg.resource_not_found('Order'), 404)
        }

        const cab = booking.bookedCab
        const currentPassengers = booking.numberOfPassengers
        // @ts-ignore
        const availableSlots = cab.capacity - currentPassengers

        const responseData = {
            bookingId: orderId,
            currentPassengers,
            // @ts-ignore
            cabCapacity: cab.capacity,
            availableSlots,
            canAddPassengers: availableSlots > 0,
            // @ts-ignore
            maxPassengersAllowed: cab.capacity
        }

        httpResponse(req, res, 200, 'Passenger capacity info retrieved', responseData)
    } catch (error) {
        logger.error('Error in checkPassengerCapacity:', {
            meta: { error: error.message }
        })
        httpError('CHECK PASSENGER CAPACITY', next, error, req, 500)
    }
}

export const getAdminAvailableCabs = async (req, res, next) => {
    try {
        // Authorization check
        if (req.user.role !== 'Admin') {
            throw new CustomError(generic_msg.unauthorized_access, 403)
        }

        // Extract and validate query parameters
        const { capacity, departureDate, dropOffDate } = req.query
        const page = Math.max(1, Number(req.query.page) || 1)
        const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10))
        const skip = (page - 1) * limit

        // Validate required parameters
        if (!capacity || !departureDate || !dropOffDate) {
            throw new CustomError(generic_msg.invalid_input('Cab capacity or departure date or dropoffdate'), 400)
        }

        // Parse and validate departure date
        const requestedDepartureDate = new Date(departureDate)
        if (isNaN(requestedDepartureDate.getTime())) {
            throw new CustomError('Invalid departure date format', 400)
        }

        // Parse and validate drop-off date
        const requestedDropOffDate = new Date(dropOffDate)
        if (isNaN(requestedDropOffDate.getTime())) {
            throw new CustomError('Invalid drop-off date format', 400)
        }

        // Validate that drop-off date is after departure date
        if (requestedDropOffDate <= requestedDepartureDate) {
            throw new CustomError('Drop-off date must be after departure date', 400)
        }

        // Validate capacity
        const cabCapacity = Number(capacity)
        if (isNaN(cabCapacity) || cabCapacity <= 0) {
            throw new CustomError('Invalid capacity value', 400)
        }

        // Build aggregation pipeline to find available cabs
        const pipeline = [
            // Match cabs with required capacity
            {
                $match: {
                    capacity: cabCapacity
                }
            },

            // Lookup driver information
            {
                $lookup: {
                    from: 'users', // Assuming your driver collection is 'users'
                    localField: 'belongsTo',
                    foreignField: '_id',
                    as: 'driver'
                }
            },

            // Filter out cabs without verified drivers
            {
                $match: {
                    'driver.0.isVerifiedDriver': true
                }
            },

            // Check for conflicting bookings with the requested trip period
            {
                $addFields: {
                    isAvailable: {
                        $not: {
                            $anyElementTrue: {
                                $map: {
                                    input: { $ifNull: ['$upcomingBookings', []] },
                                    as: 'booking',
                                    in: {
                                        // Check if there's any overlap between requested period and existing bookings
                                        $or: [
                                            // Case 1: Existing booking starts during requested period
                                            {
                                                $and: [
                                                    { $gte: ['$booking.departureDate', requestedDepartureDate] },
                                                    { $lt: ['$booking.departureDate', requestedDropOffDate] }
                                                ]
                                            },
                                            // Case 2: Existing booking ends during requested period
                                            {
                                                $and: [
                                                    { $gt: ['$booking.dropOffDate', requestedDepartureDate] },
                                                    { $lte: ['$booking.dropOffDate', requestedDropOffDate] }
                                                ]
                                            },
                                            // Case 3: Existing booking completely encompasses requested period
                                            {
                                                $and: [
                                                    { $lte: ['$booking.departureDate', requestedDepartureDate] },
                                                    { $gte: ['$booking.dropOffDate', requestedDropOffDate] }
                                                ]
                                            },
                                            // Case 4: Requested period completely encompasses existing booking
                                            {
                                                $and: [
                                                    { $lte: [requestedDepartureDate, '$booking.departureDate'] },
                                                    { $gte: [requestedDropOffDate, '$booking.dropOffDate'] }
                                                ]
                                            }
                                        ]
                                    }
                                }
                            }
                        }
                    }
                }
            },

            // Filter only available cabs
            {
                $match: {
                    isAvailable: true
                }
            },

            // Project final fields
            {
                $project: {
                    cabId: '$_id',
                    modelName: 1,
                    type: 1,
                    photos: 1,
                    capacity: 1,
                    feature: 1,
                    cabNumber: 1,
                    rate: 1,
                    driver: {
                        name: { $arrayElemAt: ['$driver.username', 0] },
                        email: { $arrayElemAt: ['$driver.email', 0] },
                        phoneNumber: { $arrayElemAt: ['$driver.phoneNumber', 0] }
                    },
                    createdAt: 1
                }
            },

            // Sort by creation date (newest first)
            {
                $sort: { createdAt: -1 }
            }
        ]

        // Get total count of available cabs
        const totalCountPipeline = [...pipeline, { $count: 'total' }]

        // @ts-ignore
        const [countResult] = await Cab.aggregate(totalCountPipeline)
        const totalCabs = countResult?.total || 0

        // Get paginated results
        const paginatedPipeline = [...pipeline, { $skip: skip }, { $limit: limit }]

        // @ts-ignore
        const availableCabs = await Cab.aggregate(paginatedPipeline)

        // Prepare pagination metadata
        const pagination = {
            currentPage: page,
            totalPages: Math.ceil(totalCabs / limit),
            totalItems: totalCabs,
            hasNextPage: page < Math.ceil(totalCabs / limit),
            hasPrevPage: page > 1
        }

        return httpResponse(req, res, 200, generic_msg.operation_success('Get admin avaliable cab'), availableCabs, null, pagination)
    } catch (error) {
        return httpError('GET_AVAILABLE_CABS', next, error, req, 500)
    }
}

export const cancelAdminOrder = async (req, res, next) => {
    let originalOrderState = null // Track original order state
    let originalCabState = null // Track original cab state
    let order = null
    let cab = null
    let bookingRemovedFromCab = false // Track if booking was removed from cab

    try {
        if (req.user.role !== 'Admin') {
            throw new CustomError(generic_msg.unauthorized_access, 403)
        }

        const orderId = req.params.id
        if (!orderId) {
            throw new CustomError(generic_msg.invalid_input('orderId'), 400)
        }

        // Find the order
        order = await Order.findById(orderId)
        if (!order) {
            throw new CustomError(generic_msg.resource_not_found('Order'), 404)
        }

        // Check if order is already cancelled
        if (order.bookingStatus === 'Cancelled') {
            throw new CustomError('Order is already cancelled', 400)
        }

        // Store original order state for potential rollback
        originalOrderState = {
            driverId: order.driverId,
            bookedCab: order.bookedCab,
            bookingStatus: order.bookingStatus,
            driverShare: order.driverShare
                ? {
                      driverCut: order.driverShare.driverCut,
                      Via: order.driverShare.Via,
                      status: order.driverShare.status,
                      paidAt: order.driverShare.paidAt
                  }
                : null
        }

        // If order has a driver assigned, handle cab booking removal
        if (order.driverId && order.bookedCab) {
            cab = await Cab.findById(order.bookedCab)
            if (!cab) {
                throw new CustomError(generic_msg.resource_not_found('Cab'), 404)
            }

            // Store original cab state before modification
            originalCabState = {
                bookings: [...cab.upcomingBookings]
            }

            // Remove the booking from cab using the removeBooking method
            // @ts-ignore
            const bookingRemoved = await cab.removeBooking(orderId)
            if (!bookingRemoved) {
                throw new CustomError('Failed to remove booking from cab during cancellation', 500)
            }
            bookingRemovedFromCab = true
        }

        // Clear driver-related fields from order
        if (order.driverId) {
            order.driverId = undefined // Remove driver ID
        }

        // Reset driver share fields
        if (order.driverShare) {
            order.driverShare = {
                driverCut: 0,
                Via: 'Cancelled',
                status: 'Cancelled',
                paidAt: new Date()
            }
        }

        // Update booking status to cancelled
        order.bookingStatus = 'Cancelled'

        // Save the updated order
        await order.save()

        httpResponse(req, res, 200, generic_msg.operation_success('Cancel Admin order'), null)
    } catch (error) {
        // Manual rollback on error
        try {
            // Restore original order state
            if (order && originalOrderState) {
                // Restore driverId - handle both defined and undefined cases
                if (originalOrderState.driverId) {
                    order.driverId = originalOrderState.driverId
                } else {
                    order.driverId = undefined
                }

                // Restore other order fields
                order.bookedCab = originalOrderState.bookedCab
                order.bookingStatus = originalOrderState.bookingStatus

                // Restore driver share
                if (originalOrderState.driverShare) {
                    order.driverShare = {
                        driverCut: originalOrderState.driverShare.driverCut,
                        Via: originalOrderState.driverShare.Via,
                        status: originalOrderState.driverShare.status,
                        paidAt: originalOrderState.driverShare.paidAt
                    }
                } else {
                    order.driverShare = undefined
                }

                await order.save().catch((rollbackError) => logger.error('Failed to restore order state during rollback:', rollbackError))
            }

            // Restore original cab state if booking was removed
            if (cab && originalCabState && bookingRemovedFromCab) {
                // Manually restore the original bookings array
                cab.upcomingBookings.splice(0, cab.upcomingBookings.length, ...originalCabState.bookings)

                await cab.save().catch((rollbackError) => logger.error('Failed to restore cab bookings during rollback:', rollbackError))
            }
        } catch (rollbackError) {
            logger.error('Rollback failed during order cancellation:', rollbackError)
        }

        httpError('CANCEL ADMIN ORDER', next, error, req, 500)
    }
}

//Transaction
export const getAllTransactionAdmin = async (req, res, next) => {
    try {
        if (req.user.role !== 'Admin') {
            throw new CustomError(generic_msg.unauthorized_access, 403)
        }

        // Validate pagination parameters
        const page = Number(req.query.page) || 1
        const limit = Number(req.query.limit) || 6

        if (page < 1 || limit < 1) {
            throw new CustomError('Pagination Error', 400)
        }

        const skip = (page - 1) * limit

        // Build filter based on isPending query parameter
        const isPendingQuery = req.query.isPending
        const filter = {}

        // Handle isPending parameter
        if (isPendingQuery !== undefined) {
            if (isPendingQuery === 'true') {
                filter.isPending = true
            } else if (isPendingQuery === 'false') {
                filter.isPending = false
            }
            // If isPendingQuery is neither 'true' nor 'false', ignore the filter
        }

        const transaction = await Transaction.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .populate('userId', 'username')
            .populate('orderId', 'driverShare')
            .lean()

        if (!transaction || transaction.length === 0) {
            return httpResponse(req, res, 200, generic_msg.operation_success('Admin Get all transaction'), [], null, {
                currentPage: page,
                totalPages: 0,
                totalItems: 0,
                hasNextPage: false,
                hasPrevPage: false
            })
        }

        const totalTransaction = await Transaction.countDocuments(filter)

        const pagination = {
            currentPage: page,
            totalPages: Math.ceil(totalTransaction / limit),
            totalItems: totalTransaction,
            hasNextPage: page < Math.ceil(totalTransaction / limit),
            hasPrevPage: page > 1
        }

        return httpResponse(req, res, 200, generic_msg.operation_success('Admin get all transaction'), transaction, null, pagination)
    } catch (error) {
        return httpError('ALL ADMIN TRANSACTION', next, error, req, 500)
    }
}

export const getTransactionDetails = async (req, res, next) => {
    try {
        if (req.user.role !== 'Admin') {
            throw new CustomError(generic_msg.unauthorized_access, 403)
        }
        const { id } = req.params

        if (!id) {
            throw new CustomError(generic_msg.invalid_input('Id'), 400)
        }
        const transaction = await Transaction.findById(id)
            .lean()
            .populate('userId', 'username wallet')
            .populate('orderId', 'driverShare bookingAmount paidAmount')
        if (!transaction) {
            throw new CustomError(generic_msg.resource_not_found('Transaction'), 404)
        }
        httpResponse(req, res, 200, generic_msg.operation_success('Admin get transaction detial'), transaction, null)
    } catch (error) {
        httpError('GET SINGLE TRANSACTION', next, error, req, 500)
    }
}
class ManualRollbackManager {
    constructor() {
        this.rollbackLog = {
            payoutId: null,
            transactionId: null,
            userId: null,
            orderId: null,
            amount: 0,
            rollbackSteps: [],
            originalStates: {},
            completedSteps: [],
            timestamp: new Date(),
            status: 'INITIALIZED'
        }
    }

    // Initialize rollback log with original states
    async captureOriginalStates(transactionId, userId, orderId) {
        try {
            const transaction = await Transaction.findById(transactionId)
            const user = await User.findById(userId)
            const order = await Order.findById(orderId)

            this.rollbackLog.transactionId = transactionId
            this.rollbackLog.userId = userId
            this.rollbackLog.orderId = orderId

            this.rollbackLog.originalStates = {
                transaction: {
                    isPending: transaction?.isPending,
                    payoutId: transaction?.payoutId,
                    transactionDate: transaction?.transactionDate,
                    description: transaction?.description
                },
                user: {
                    walletBalance: user?.wallet?.balance || 0,
                    fundAccountId: user?.wallet?.bankDetails?.fundAcc || null
                },
                order: {
                    driverShareVia: order?.driverShare?.Via || null,
                    driverShareStatus: order?.driverShare?.status || null,
                    driverSharePaidAt: order?.driverShare?.paidAt || null
                }
            }

            logger.info('Original states captured for rollback', {
                transactionId,
                userId,
                orderId,
                originalStates: this.rollbackLog.originalStates
            })
        } catch (error) {
            logger.error('Failed to capture original states:', error)
            throw new CustomError('Failed to initialize rollback manager', 500)
        }
    }

    // Log each step as it's completed
    logCompletedStep(stepName, stepData) {
        this.rollbackLog.completedSteps.push({
            step: stepName,
            data: stepData,
            timestamp: new Date()
        })

        logger.info(`Payout step completed: ${stepName}`, { stepData })
    }

    // Generate rollback plan based on completed steps
    generateRollbackPlan() {
        const rollbackSteps = []

        // Reverse the order of completed steps for rollback
        for (let i = this.rollbackLog.completedSteps.length - 1; i >= 0; i--) {
            const completedStep = this.rollbackLog.completedSteps[i]

            switch (completedStep.step) {
                case 'ORDER_UPDATED':
                    rollbackSteps.push({
                        action: 'REVERT_ORDER_STATUS',
                        data: {
                            orderId: this.rollbackLog.orderId,
                            originalVia: this.rollbackLog.originalStates.order.driverShareVia,
                            originalStatus: this.rollbackLog.originalStates.order.driverShareStatus,
                            originalPaidAt: this.rollbackLog.originalStates.order.driverSharePaidAt
                        }
                    })
                    break

                case 'WALLET_UPDATED':
                    rollbackSteps.push({
                        action: 'REVERT_WALLET_BALANCE',
                        data: {
                            userId: this.rollbackLog.userId,
                            amount: this.rollbackLog.amount
                        }
                    })
                    break

                case 'TRANSACTION_UPDATED':
                    rollbackSteps.push({
                        action: 'REVERT_TRANSACTION_STATUS',
                        data: {
                            transactionId: this.rollbackLog.transactionId,
                            originalPending: this.rollbackLog.originalStates.transaction.isPending,
                            originalPayoutId: this.rollbackLog.originalStates.transaction.payoutId,
                            originalDate: this.rollbackLog.originalStates.transaction.transactionDate,
                            originalDescription: this.rollbackLog.originalStates.transaction.description
                        }
                    })
                    break

                case 'FUND_ACCOUNT_CREATED':
                    // Only remove fund account if it should be removed on rollback
                    // (i.e., if validation failed or if it was newly created but not validated)
                    if (!this.rollbackLog.originalStates.user.fundAccountId && !completedStep.data.shouldKeepOnRollback) {
                        rollbackSteps.push({
                            action: 'REMOVE_FUND_ACCOUNT',
                            data: {
                                userId: this.rollbackLog.userId
                            }
                        })
                    }
                    break

                default:
                    // Log unknown step type but continue processing
                    logger.warn(`Unknown step type encountered during rollback planning: ${completedStep.step}`, {
                        stepData: completedStep.data,
                        timestamp: completedStep.timestamp
                    })
                    break
            }
        }

        this.rollbackLog.rollbackSteps = rollbackSteps
        return rollbackSteps
    }

    // Execute manual rollback
    async executeManualRollback(reason = 'Automatic rollback due to error') {
        try {
            this.rollbackLog.status = 'ROLLING_BACK'
            this.rollbackLog.rollbackReason = reason

            const rollbackSteps = this.generateRollbackPlan()

            logger.warn('Executing manual rollback', {
                payoutId: this.rollbackLog.payoutId,
                stepsToRollback: rollbackSteps.length,
                reason
            })

            let rollbackSuccess = true

            for (const step of rollbackSteps) {
                try {
                    await this.executeRollbackStep(step)
                    logger.info(`Rollback step completed: ${step.action}`)
                } catch (error) {
                    logger.error(`Rollback step failed: ${step.action}`, {
                        error: error.message,
                        stepData: step.data
                    })
                    rollbackSuccess = false
                }
            }

            this.rollbackLog.status = rollbackSuccess ? 'ROLLBACK_COMPLETED' : 'ROLLBACK_PARTIAL'

            // Save rollback log to database for audit
            await this.saveRollbackLog()

            return {
                success: rollbackSuccess,
                rollbackLog: this.rollbackLog
            }
        } catch (error) {
            this.rollbackLog.status = 'ROLLBACK_FAILED'
            logger.error('Manual rollback execution failed:', error)
            await this.saveRollbackLog()
            throw error
        }
    }

    // Execute individual rollback step
    async executeRollbackStep(step) {
        switch (step.action) {
            case 'REVERT_ORDER_STATUS':
                await Order.updateOne(
                    { _id: step.data.orderId },
                    {
                        $set: {
                            'driverShare.Via': step.data.originalVia,
                            'driverShare.status': step.data.originalStatus,
                            'driverShare.paidAt': step.data.originalPaidAt
                        }
                    }
                )
                break

            case 'REVERT_WALLET_BALANCE':
                await User.updateOne({ _id: step.data.userId }, { $inc: { 'wallet.balance': step.data.amount } })
                break

            case 'REVERT_TRANSACTION_STATUS':
                await Transaction.updateOne(
                    { _id: step.data.transactionId },
                    {
                        $set: {
                            isPending: step.data.originalPending,
                            payoutId: step.data.originalPayoutId,
                            transactionDate: step.data.originalDate,
                            description: step.data.originalDescription
                        }
                    }
                )
                break

            case 'REMOVE_FUND_ACCOUNT':
                await User.updateOne({ _id: step.data.userId }, { $unset: { 'wallet.bankDetails.fundAcc': 1 } })
                break

            default:
                throw new CustomError(`Unknown rollback action: ${step.action}`, 500)
        }
    }

    // Save rollback log to database for audit purposes
    async saveRollbackLog() {
        try {
            // You can save this to a RollbackLog collection for audit purposes
            // For now, we'll just log it
            logger.info('Rollback log saved', {
                rollbackLog: this.rollbackLog
            })
        } catch (error) {
            logger.error('Failed to save rollback log:', error)
        }
    }
}
export const payoutController = async (req, res, next) => {
    const rollbackManager = new ManualRollbackManager()

    try {
        // Authorization check
        if (!req.user || req.user.role !== 'Admin') {
            throw new CustomError(generic_msg.unauthorized_access, 403)
        }

        // Enhanced input validation
        const { transactionId, amount, orderId } = req.body

        if (!transactionId || !amount || !orderId) {
            throw new CustomError(generic_msg.invalid_input('Amount or transactionId or orderId'), 400)
        }

        // Validate ObjectId format
        if (!mongoose.Types.ObjectId.isValid(transactionId) || !mongoose.Types.ObjectId.isValid(orderId)) {
            throw new CustomError('Invalid ID format', 400)
        }

        // Validate amount
        if (typeof amount !== 'number' || amount <= 0 || amount > 1000000) {
            throw new CustomError('Invalid amount. Must be a positive number less than 1,000,000', 400)
        }

        // Fetch and validate transaction
        const transaction = await Transaction.findById(transactionId)
        if (!transaction) {
            throw new CustomError(generic_msg.resource_not_found('Transaction'), 404)
        }

        // Validate transaction belongs to the order
        if (transaction.orderId.toString() !== orderId) {
            throw new CustomError('Transaction does not belong to the specified order', 400)
        }

        // Validate transaction amount matches requested amount
        if (transaction.amount !== amount) {
            throw new CustomError('Transaction amount mismatch', 400)
        }

        // Fetch user
        const user = await User.findById(transaction.userId)
        if (!user) {
            throw new CustomError(generic_msg.resource_not_found('User'), 404)
        }

        // Initialize rollback manager with original states
        await rollbackManager.captureOriginalStates(transactionId, user._id, orderId)
        rollbackManager.rollbackLog.amount = amount

        // Comprehensive validation checks
        if (!transaction.isPending) {
            throw new CustomError('Transaction is not in pending state', 400)
        }

        if (
            !user.wallet.bankDetails ||
            !user.wallet.bankDetails.accountHolderName ||
            !user.wallet.bankDetails.accNo ||
            !user.wallet.bankDetails.ifsc
        ) {
            throw new CustomError('Incomplete bank details', 400)
        }

        // Fetch and validate order
        const order = await Order.findById(orderId)
        if (!order) {
            throw new CustomError(generic_msg.resource_not_found('Order'), 404)
        }

        // Check if order is already paid
        if (order.driverShare && order.driverShare.status === 'Paid') {
            throw new CustomError('Order has already been paid', 400)
        }

        // STEP 1: Setup Razorpay account if needed
        let setupResult = null
        let fundAccountCreated = false
        if (!user.wallet.bankDetails.fundAcc) {
            try {
                logger.info('Setting up Razorpay account', {
                    userId: user._id,
                    orderId
                })

                setupResult = await setupRazorpayAccount(user, orderId)

                if (!setupResult) {
                    throw new CustomError('Failed to get setup result from Razorpay', 500)
                }

                // Check if fund account was created successfully
                if (setupResult.fundAccountId) {
                    fundAccountCreated = true

                    // Update user with fund account ID first
                    const userUpdateResult = await User.updateOne(
                        { _id: user._id },
                        { $set: { 'wallet.bankDetails.fundAcc': setupResult.fundAccountId } }
                    )

                    if (userUpdateResult.modifiedCount === 0) {
                        throw new CustomError('Failed to update user fund account', 500)
                    }

                    // Update local user object
                    user.wallet.bankDetails.fundAcc = setupResult.fundAccountId

                    logger.info('Fund account created and saved', {
                        fundAccountId: setupResult.fundAccountId
                    })
                }

                // Check validation status
                if (setupResult.validationStatus !== 'created') {
                    // If validation failed but fund account was created, remove it
                    if (fundAccountCreated) {
                        await User.updateOne({ _id: user._id }, { $unset: { 'wallet.bankDetails.fundAcc': 1 } })
                        logger.warn('Fund account validation failed, removed fund account', {
                            fundAccountId: setupResult.fundAccountId,
                            validationStatus: setupResult.validationStatus
                        })
                    }
                    throw new CustomError(`Fund account validation failed with status: ${setupResult.validationStatus}`, 400)
                }

                // Log completion for rollback tracking (only if validation succeeded)
                rollbackManager.logCompletedStep('FUND_ACCOUNT_CREATED', {
                    fundAccountId: setupResult.fundAccountId,
                    userId: user._id,
                    validationStatus: setupResult.validationStatus,
                    shouldKeepOnRollback: true // Don't remove on rollback since it's validated
                })

                logger.info('Razorpay account setup completed successfully', {
                    fundAccountId: setupResult.fundAccountId,
                    validationStatus: setupResult.validationStatus
                })
            } catch (error) {
                logger.error('Razorpay account setup failed:', error)

                // Only rollback if we haven't created a validated fund account
                if (!fundAccountCreated || (setupResult && setupResult.validationStatus !== 'created')) {
                    await rollbackManager.executeManualRollback('Razorpay account setup failed')
                }

                throw new CustomError(`Failed to set up Razorpay account: ${error.message}`, 500)
            }
        }

        // STEP 2: Execute fund transfer
        let transferResult
        try {
            logger.info('Initiating fund transfer', {
                fundAccountId: user.wallet.bankDetails.fundAcc,
                amount,
                userId: user._id
            })

            transferResult = await fundTransfer(user.wallet.bankDetails.fundAcc, amount, user, orderId)

            if (!transferResult || !transferResult.id) {
                throw new CustomError('Invalid transfer response', 500)
            }

            rollbackManager.rollbackLog.payoutId = transferResult.id

            logger.info('Fund transfer completed successfully', {
                payoutId: transferResult.id,
                mode: transferResult.mode
            })
        } catch (error) {
            logger.error('Fund transfer failed:', error)
            await rollbackManager.executeManualRollback('Fund transfer failed')
            throw new CustomError(`Failed to transfer funds: ${error.message}`, 500)
        }

        // STEP 3: Update transaction status
        try {
            const transactionUpdateResult = await Transaction.updateOne(
                { _id: transactionId },
                {
                    $set: {
                        isPending: false,
                        type: 'credit',
                        payoutId: transferResult.id,
                        transactionDate: new Date(),
                        description: `Payout via ${transferResult.mode}`
                    }
                }
            )

            if (transactionUpdateResult.modifiedCount === 0) {
                throw new CustomError('Failed to update transaction status', 500)
            }

            rollbackManager.logCompletedStep('TRANSACTION_UPDATED', {
                transactionId,
                payoutId: transferResult.id,
                mode: transferResult.mode
            })
        } catch (error) {
            logger.error('Transaction update failed:', error)
            await rollbackManager.executeManualRollback('Transaction update failed')
            throw new CustomError(`Failed to update transaction:   ${error.message}`, 500)
        }

        // STEP 4: Update user wallet balance
        try {
            const walletUpdateResult = await User.updateOne({ _id: user._id }, { $inc: { 'wallet.balance': -amount } })

            if (walletUpdateResult.modifiedCount === 0) {
                throw new CustomError('Failed to update wallet balance', 500)
            }

            rollbackManager.logCompletedStep('WALLET_UPDATED', {
                userId: user._id,
                amountDeducted: amount,
                newBalance: user.wallet.balance - amount
            })
        } catch (error) {
            logger.error('Wallet update failed:', error)
            await rollbackManager.executeManualRollback('Wallet update failed')
            throw new CustomError(`Failed to update wallet balance:  ${error.message}`, 500)
        }

        // STEP 5: Update order status
        try {
            const orderUpdateResult = await Order.updateOne(
                { _id: orderId },
                {
                    $set: {
                        'driverShare.Via': transferResult.mode,
                        'driverShare.status': 'Paid',
                        'driverShare.paidAt': new Date()
                    }
                }
            )

            if (orderUpdateResult.modifiedCount === 0) {
                throw new CustomError('Failed to update order status', 500)
            }

            rollbackManager.logCompletedStep('ORDER_UPDATED', {
                orderId,
                via: transferResult.mode,
                status: 'Paid',
                paidAt: new Date()
            })
        } catch (error) {
            logger.error('Order update failed:', error)
            await rollbackManager.executeManualRollback('Order update failed')
            throw new CustomError(`Failed to update order status:  ${error.message}`, 500)
        }

        // STEP 6: Send notification email (non-critical)
        try {
            await sendMailWithRetry(
                user.email,
                transaction_emails.payout_email_subject(orderId),
                transaction_emails.payout_email_success(user.username, amount, orderId)
            )
            logger.info(`Payout email sent successfully to user ${user.email}`)
        } catch (emailError) {
            logger.error(`Failed to send payout email to user ${user.email}:`, emailError)
            // Don't rollback for email failure - payout is still successful
        }

        // Mark rollback log as successful
        rollbackManager.rollbackLog.status = 'COMPLETED_SUCCESS'
        await rollbackManager.saveRollbackLog()

        // Prepare success response
        const responseData = {
            payoutId: transferResult.id,
            amount,
            mode: transferResult.mode,
            status: 'completed',
            transactionId,
            orderId,
            processedAt: new Date(),
            rollbackLogId: rollbackManager.rollbackLog.timestamp,
            ...(setupResult && {
                newFundAccount: {
                    contactId: setupResult.contactId,
                    fundAccountId: setupResult.fundAccountId
                }
            })
        }

        logger.info('Payout completed successfully', {
            payoutId: transferResult.id,
            userId: user._id,
            amount,
            orderId
        })

        httpResponse(req, res, 200, generic_msg.operation_success('Payment released for driver'), responseData, null, null)
    } catch (error) {
        logger.error('Payout controller error:', {
            error: error.message,
            stack: error.stack,
            transactionId: req.body?.transactionId,
            orderId: req.body?.orderId
        })

        // The rollback has already been executed in the individual steps
        // Just ensure we log the final failure
        rollbackManager.rollbackLog.status = 'FAILED'
        await rollbackManager.saveRollbackLog()

        httpError('PAYOUT_CONTROLLER', next, error, req, error.statusCode || 500)
    }
}

// Manual rollback endpoint for admin use
export const manualRollbackController = async (req, res, next) => {
    try {
        // Authorization check
        if (!req.user || req.user.role !== 'Admin') {
            throw new CustomError(generic_msg.unauthorized_access, 403)
        }

        const { payoutId, reason, transactionId } = req.body

        if (!payoutId && !transactionId) {
            throw new CustomError('Either payoutId or transactionId is required', 400)
        }

        // Find the transaction
        let transaction
        if (payoutId) {
            transaction = await Transaction.findOne({ payoutId })
        } else {
            transaction = await Transaction.findById(transactionId)
        }

        if (!transaction) {
            throw new CustomError('Transaction not found', 404)
        }

        if (transaction.isPending) {
            throw new CustomError('Transaction is still pending, cannot rollback', 400)
        }

        // Fetch related user and order
        const user = await User.findById(transaction.userId)
        const order = await Order.findById(transaction.orderId)

        if (!user || !order) {
            throw new CustomError('Related user or order not found', 404)
        }

        // Initialize rollback manager for manual rollback
        const rollbackManager = new ManualRollbackManager()

        // Manually set the current states as original states (since we're rolling back)
        rollbackManager.rollbackLog = {
            payoutId: transaction.payoutId,
            transactionId: transaction._id,
            userId: user._id,
            orderId: order._id,
            amount: transaction.amount,
            rollbackSteps: [],
            originalStates: {
                transaction: {
                    isPending: true, // What it should be after rollback
                    payoutId: null,
                    transactionDate: null,
                    description: `Rolled back: ${transaction.description} - Reason: ${reason || 'Manual rollback'}`
                },
                user: {
                    walletBalance: user.wallet.balance + transaction.amount // Add back the amount
                },
                order: {
                    driverShareVia: null,
                    driverShareStatus: 'Pending',
                    driverSharePaidAt: null
                }
            },
            completedSteps: [{ step: 'ORDER_UPDATED' }, { step: 'WALLET_UPDATED' }, { step: 'TRANSACTION_UPDATED' }],
            timestamp: new Date(),
            status: 'MANUAL_ROLLBACK_INITIATED'
        }

        // Execute the rollback
        const rollbackResult = await rollbackManager.executeManualRollback(reason || 'Manual admin rollback')

        logger.info('Manual rollback completed', {
            payoutId: transaction.payoutId,
            transactionId: transaction._id,
            amount: transaction.amount,
            reason,
            success: rollbackResult.success
        })

        httpResponse(req, res, 200, 'Manual rollback completed', {
            transactionId: transaction._id,
            payoutId: transaction.payoutId,
            amount: transaction.amount,
            rollbackSuccess: rollbackResult.success,
            rollbackDetails: rollbackResult.rollbackLog,
            rolledBackAt: new Date()
        })
    } catch (error) {
        logger.error('Manual rollback failed:', error)
        httpError('MANUAL_ROLLBACK', next, error, req, error.statusCode || 500)
    }
}

// Get rollback history endpoint
export const getRollbackHistoryController = async (req, res, next) => {
    try {
        // Authorization check
        if (!req.user || req.user.role !== 'Admin') {
            throw new CustomError(generic_msg.unauthorized_access, 403)
        }

        // @ts-ignore
        const { transactionId, payoutId, userId } = req.query

        // This would query a RollbackLog collection if you create one
        // For now, return a placeholder response
        const rollbackHistory = {
            message: 'Rollback history is logged in application logs',
            searchParams: { transactionId, payoutId, userId },
            note: 'Consider implementing a RollbackLog collection for persistent storage'
        }

        httpResponse(req, res, 200, 'Rollback history retrieved', rollbackHistory)
    } catch (error) {
        logger.error('Get rollback history failed:', error)
        httpError('GET_ROLLBACK_HISTORY', next, error, req, error.statusCode || 500)
    }
}

export const allUserAdmin = async (req, res, next) => {
    try {
        if (req.user.role !== 'Admin') {
            throw new CustomError(generic_msg.unauthorized_access, 403)
        }

        // Validate pagination parameters
        const page = Number(req.query.page) || 1
        const limit = Number(req.query.limit) || 6

        if (page < 1 || limit < 1) {
            throw new CustomError('Pagination Error', 400)
        }

        const skip = (page - 1) * limit

        // Build filter object
        const filter = {}
        if (req.query.role && req.query.role.trim() !== '') {
            // Validate bookingStatus against allowed values
            const allowerdRole = ['Passenger', 'Driver', 'Admin', '']

            if (!allowerdRole.includes(req.query.role)) {
                throw new CustomError('Invalid User role. Allowed values: pending, confirmed, cancelled, completed, processing', 400)
            }

            filter.role = req.query.role
        }
        const users = await User.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean()

        if (!users || users.length === 0) {
            throw new CustomError(generic_msg.resource_not_found('Users'), 404)
        }

        // Count the total number of users with role 'Passenger'
        const totalUsers = await User.countDocuments(filter)

        const pagination = {
            currentPage: page,
            totalPages: Math.ceil(totalUsers / limit),
            totalItems: totalUsers,
            hasNextPage: page < Math.ceil(totalUsers / limit),
            hasPrevPage: page > 1
        }

        // setCache(cacheKey, users, 3600) // Cache for 1 hour
        // Send response
        return httpResponse(req, res, 200, generic_msg.operation_success('Admin all users'), users, null, pagination)
    } catch (error) {
        return httpError('ALL ADMIN USER', next, error, req, 500)
    }
}

export const allAdminDriver = async (req, res, next) => {
    try {
        if (req.user.role !== 'Admin') {
            throw new CustomError(generic_msg.unauthorized_access, 403)
        }

        // Pagination setup
        const page = Number(req.query.page) || 1
        const limit = Number(req.query.limit) || 6

        if (page < 1 || limit < 1) {
            throw new CustomError('Pagination Error', 400)
        }

        const skip = (page - 1) * limit

        // Build filter based on query
        const isVerifiedQuery = req.query.verified

        // Base filter for drivers
        const filter = {
            role: 'Driver'
        }

        // Handle verified parameter more explicitly
        if (isVerifiedQuery !== undefined) {
            if (isVerifiedQuery === 'true') {
                filter.isVerifiedDriver = true
            } else if (isVerifiedQuery === 'false') {
                filter.isVerifiedDriver = false
            }
            // If isVerifiedQuery is neither 'true' nor 'false', ignore the filter
        }

        // Fetch filtered drivers
        const drivers = await User.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean()

        if (!drivers || drivers.length === 0) {
            return httpResponse(req, res, 200, generic_msg.operation_success('Admin all drivers'), drivers)
        }

        const totalDriver = await User.countDocuments(filter)

        const pagination = {
            currentPage: page,
            totalPages: Math.ceil(totalDriver / limit),
            totalItems: totalDriver,
            hasNextPage: page < Math.ceil(totalDriver / limit),
            hasPrevPage: page > 1
        }

        // Send response
        return httpResponse(req, res, 200, generic_msg.operation_success('Admin all drivers'), drivers, null, pagination)
    } catch (error) {
        return httpError('ALL ADMIN DRIVER', next, error, req, 500)
    }
}
//New route with transaction
export const assignBookingWithTransaction = async (req, res, next) => {
    // Start a session for the transaction
    const session = await mongoose.startSession()

    try {
        // Authorization check (done outside transaction for early exit)
        if (req.user.role !== 'Admin') {
            throw new CustomError(generic_msg.unauthorized_access, 403)
        }

        const { id } = req.params
        const { newCabId } = req.body

        // Input validation (done outside transaction for early exit)
        if (!id || !newCabId) {
            throw new CustomError(generic_msg.invalid_input('Id or cabId'), 400)
        }

        // Validate ObjectId format
        if (!mongoose.Types.ObjectId.isValid(id) || !mongoose.Types.ObjectId.isValid(newCabId)) {
            throw new CustomError(generic_msg.invalid_input('Invalid ID format'), 400)
        }

        let result

        // Execute all database operations within a transaction
        await session.withTransaction(
            async () => {
                // Fetch the order (no population inside transaction for better performance)
                const order = await Order.findById(id).session(session)

                if (!order) {
                    throw new CustomError(generic_msg.resource_not_found('Booking'), 404)
                }

                // Check if booking is in a valid state for assignment
                if (order.bookingStatus === 'Completed' || order.bookingStatus === 'Cancelled') {
                    throw new CustomError('Cannot reassign completed or cancelled booking', 400)
                }

                // Fetch the cab (no population inside transaction)
                const cab = await Cab.findById(newCabId).session(session)

                if (!cab) {
                    throw new CustomError(generic_msg.resource_not_found('Cab'), 404)
                }

                // Check for duplicate booking using the schema method
                // @ts-ignore
                if (cab.hasBooking(order._id)) {
                    throw new CustomError('Booking is already assigned to this cab', 400)
                }

                // Fetch and validate driver
                const driver = await User.findById(cab.belongsTo).session(session)
                if (!driver || !driver.isVerifiedDriver) {
                    throw new CustomError('Cannot assign booking to unverified driver', 400)
                }

                // Remove booking from previous cab if it was assigned to one
                if (order.bookedCab && order.bookedCab.toString() !== newCabId) {
                    const previousCab = await Cab.findById(order.bookedCab).session(session)
                    if (previousCab) {
                        // Pass session as parameter to removeBooking
                        // @ts-ignore
                        const removeResult = await previousCab.removeBooking(order._id, session)
                        if (!removeResult) {
                            throw new CustomError('Failed to remove booking from previous cab', 500)
                        }
                    }
                }

                // Calculate driver cut based on payment method
                let driverCut = order.bookingAmount // Full amount by default
                if (order.paymentMethod === 'Online') {
                    driverCut = order.bookingAmount - EApplicationEnvironment.HYBRID_PAYMENT_PERCENTAGE * order.bookingAmount
                }

                // Update order details atomically
                const updatedOrder = await Order.findByIdAndUpdate(
                    order._id,
                    {
                        driverId: cab.belongsTo,
                        bookedCab: newCabId,
                        bookingStatus: 'Assigning',
                        driverShare: {
                            driverCut,
                            Via: order.paymentMethod !== 'Online' ? 'Customer' : 'Us',
                            paidAt: null
                        },
                        assignedAt: new Date(),
                        lastModified: new Date()
                    },
                    {
                        new: true,
                        session,
                        runValidators: true // Ensure schema validation runs
                    }
                )

                if (!updatedOrder) {
                    throw new CustomError('Failed to update booking', 500)
                }

                // Add booking to new cab using direct database operation for transaction safety
                const addBookingResult = await Cab.findOneAndUpdate(
                    {
                        _id: newCabId,
                        'upcomingBookings.orderId': { $ne: order._id } // Prevent duplicates
                    },
                    {
                        $push: {
                            upcomingBookings: {
                                orderId: order._id,
                                departureDate: order.departureDate,
                                dropOffDate: order.dropOffDate,
                                status: 'Upcoming'
                            }
                        }
                    },
                    {
                        new: true,
                        session,
                        runValidators: true
                    }
                )

                if (!addBookingResult) {
                    throw new CustomError('Failed to add booking to cab or booking already exists', 500)
                }

                result = {
                    order: updatedOrder,
                    cab: addBookingResult,
                    driver,
                    driverCut
                }
            },
            {
                readPreference: 'primary',
                readConcern: { level: 'local' },
                writeConcern: { w: 'majority' },
                maxTimeMS: 30000 // 30 second timeout
            }
        )

        // Fetch populated data outside transaction for response
        // eslint-disable-next-line no-unused-vars
        const [populatedOrder, populatedCab] = await Promise.all([
            Order.findById(result.order._id).populate('userId', 'email username'),
            Cab.findById(newCabId).populate('belongsTo', 'email username')
        ])

        // Extract only needed data for email to prevent memory leaks
        const emailData = {
            driverEmail: populatedCab.belongsTo.email,
            driverUsername: populatedCab.belongsTo.username,
            orderId: result.order._id.toString(),
            departureDate: result.order.departureDate,
            dropOffDate: result.order.dropOffDate,
            location: result.order.exactLocation || result.order.pickupLocation,
            paymentMethod: result.order.paymentMethod,
            driverCut: result.driverCut
        }

        // Send confirmation email to driver (outside transaction to avoid blocking)
        setImmediate(async () => {
            try {
                // @ts-ignore
                const formattedPickUpDate = date.formatShortDate(emailData.departureDate)
                // @ts-ignore
                const formattedDropOffDate = date.formatShortDate(emailData.dropOffDate)

                await sendMailWithRetry(
                    emailData.driverEmail,
                    driver_emails.driver_assignment_email_subject,
                    driver_emails.driver_assignment_email(
                        emailData.driverUsername,
                        emailData.orderId,
                        formattedPickUpDate,
                        emailData.location,
                        formattedDropOffDate,
                        emailData.paymentMethod,
                        emailData.driverCut
                    )
                )
            } catch (emailError) {
                logger.error(generic_msg.email_sending_failed(emailData.driverEmail), {
                    meta: { error: emailError, orderId: emailData.orderId }
                })
            }
        })

        // Log successful assignment
        logger.info('Booking assigned successfully', {
            meta: {
                orderId: result.order._id,
                cabId: newCabId,
                driverId: result.driver._id,
                assignedBy: req.user.id
            }
        })

        return httpResponse(req, res, 200, generic_msg.operation_success('Cab Assigned'), {
            orderId: result.order._id,
            cabId: newCabId,
            driverName: populatedCab.belongsTo.username,
            assignedAt: new Date()
        })
    } catch (error) {
        // Log the error with context
        logger.error('Booking assignment failed:', {
            meta: {
                error: error.message,
                stack: error.stack,
                orderId: req.params.id,
                newCabId: req.body.newCabId
            }
        })

        // Transaction will be automatically rolled back due to error
        return httpError('ASSIGNING CAB', next, error, req, error.statusCode || 500)
    } finally {
        // Always end the session
        await session.endSession()
    }
}

export const cancelAdminOrderExplicit = async (req, res, next) => {
    const session = await mongoose.startSession()

    try {
        // Check authorization first (before starting transaction)
        if (req.user.role !== 'Admin') {
            throw new CustomError(generic_msg.unauthorized_access, 403)
        }

        const orderId = req.params.id
        if (!orderId) {
            throw new CustomError(generic_msg.invalid_input('orderId'), 400)
        }

        // Start transaction explicitly
        session.startTransaction()

        // Find the order within the transaction
        const order = await Order.findById(orderId).session(session)
        if (!order) {
            throw new CustomError(generic_msg.resource_not_found('Order'), 404)
        }

        // Check if order is already cancelled
        if (order.bookingStatus === 'Cancelled') {
            throw new CustomError('Order is already cancelled', 400)
        }

        // If order has a driver assigned, handle cab booking removal
        if (order.driverId && order.bookedCab) {
            const cab = await Cab.findById(order.bookedCab).session(session)
            if (!cab) {
                throw new CustomError(generic_msg.resource_not_found('Cab'), 404)
            }

            // Remove the booking from cab
            // @ts-ignore
            const bookingRemoved = await cab.removeBooking(orderId, session)
            if (!bookingRemoved) {
                throw new CustomError('Failed to remove booking from cab during cancellation', 500)
            }
        }

        // Update order fields
        if (order.driverId) {
            order.driverId = undefined
        }

        // Reset driver share fields
        if (order.driverShare) {
            order.driverShare = {
                driverCut: 0,
                Via: 'Cancelled',
                status: 'Cancelled',
                paidAt: new Date()
            }
        }

        // Update booking status to cancelled
        order.bookingStatus = 'Cancelled'

        // Save the updated order within the transaction
        await order.save({ session })

        // Commit the transaction
        await session.commitTransaction()

        httpResponse(req, res, 200, generic_msg.operation_success('Cancel Admin order'), null)
    } catch (error) {
        // Abort the transaction on error
        await session.abortTransaction()
        httpError('CANCEL ADMIN ORDER', next, error, req, 500)
    } finally {
        // Always end the session
        await session.endSession()
    }
}

export const payoutControllerWithTransactions = async (req, res, next) => {
    // Start a MongoDB session for transaction
    const session = await mongoose.startSession()

    try {
        // Authorization check
        if (!req.user || req.user.role !== 'Admin') {
            throw new CustomError(generic_msg.unauthorized_access, 403)
        }

        // Enhanced input validation
        const { transactionId, amount, orderId } = req.body

        if (!transactionId || !amount || !orderId) {
            throw new CustomError(generic_msg.invalid_input('Amount or transactionId or orderId'), 400)
        }

        // Validate ObjectId format
        if (!mongoose.Types.ObjectId.isValid(transactionId) || !mongoose.Types.ObjectId.isValid(orderId)) {
            throw new CustomError('Invalid ID format', 400)
        }

        // Validate amount
        if (typeof amount !== 'number' || amount <= 0 || amount > 1000000) {
            throw new CustomError('Invalid amount. Must be a positive number less than 1,000,000', 400)
        }

        // Start transaction
        await session.withTransaction(async () => {
            // Fetch and validate transaction
            const transaction = await Transaction.findById(transactionId).session(session)
            if (!transaction) {
                throw new CustomError(generic_msg.resource_not_found('Transaction'), 404)
            }

            // Validate transaction belongs to the order
            if (transaction.orderId.toString() !== orderId) {
                throw new CustomError('Transaction does not belong to the specified order', 400)
            }

            // Validate transaction amount matches requested amount
            if (transaction.amount !== amount) {
                throw new CustomError('Transaction amount mismatch', 400)
            }

            // Fetch user
            const user = await User.findById(transaction.userId).session(session)
            if (!user) {
                throw new CustomError(generic_msg.resource_not_found('User'), 404)
            }

            // Comprehensive validation checks
            if (!transaction.isPending) {
                throw new CustomError('Transaction is not in pending state', 400)
            }

            if (
                !user.wallet.bankDetails ||
                !user.wallet.bankDetails.accountHolderName ||
                !user.wallet.bankDetails.accNo ||
                !user.wallet.bankDetails.ifsc
            ) {
                throw new CustomError('Incomplete bank details', 400)
            }

            // Fetch and validate order
            const order = await Order.findById(orderId).session(session)
            if (!order) {
                throw new CustomError(generic_msg.resource_not_found('Order'), 404)
            }

            // Check if order is already paid
            if (order.driverShare && order.driverShare.status === 'Paid') {
                throw new CustomError('Order has already been paid', 400)
            }

            // STEP 1: Setup Razorpay account if needed
            let setupResult = null
            if (!user.wallet.bankDetails.fundAcc) {
                try {
                    logger.info('Setting up Razorpay account', {
                        userId: user._id,
                        orderId
                    })

                    setupResult = await setupRazorpayAccount(user, orderId)

                    if (!setupResult) {
                        throw new CustomError('Failed to get setup result from Razorpay', 500)
                    }

                    // Check if fund account was created successfully
                    if (setupResult.fundAccountId) {
                        // Update user with fund account ID within transaction
                        const userUpdateResult = await User.updateOne(
                            { _id: user._id },
                            { $set: { 'wallet.bankDetails.fundAcc': setupResult.fundAccountId } },
                            { session }
                        )

                        if (userUpdateResult.modifiedCount === 0) {
                            throw new CustomError('Failed to update user fund account', 500)
                        }

                        // Update local user object
                        user.wallet.bankDetails.fundAcc = setupResult.fundAccountId

                        logger.info('Fund account created and saved', {
                            fundAccountId: setupResult.fundAccountId
                        })
                    }

                    // Check validation status
                    if (setupResult.validationStatus !== 'created') {
                        throw new CustomError(`Fund account validation failed with status: ${setupResult.validationStatus}`, 400)
                    }

                    logger.info('Razorpay account setup completed successfully', {
                        fundAccountId: setupResult.fundAccountId,
                        validationStatus: setupResult.validationStatus
                    })
                } catch (error) {
                    logger.error('Razorpay account setup failed:', error)
                    throw new CustomError(`Failed to set up Razorpay account: ${error.message}`, 500)
                }
            }

            // STEP 2: Execute fund transfer
            let transferResult
            try {
                logger.info('Initiating fund transfer', {
                    fundAccountId: user.wallet.bankDetails.fundAcc,
                    amount,
                    userId: user._id
                })

                transferResult = await fundTransfer(user.wallet.bankDetails.fundAcc, amount, user, orderId)

                if (!transferResult || !transferResult.id) {
                    throw new CustomError('Invalid transfer response', 500)
                }

                logger.info('Fund transfer completed successfully', {
                    payoutId: transferResult.id,
                    mode: transferResult.mode
                })
            } catch (error) {
                logger.error('Fund transfer failed:', error)
                throw new CustomError(`Failed to transfer funds: ${error.message}`, 500)
            }

            // STEP 3: Update transaction status within transaction
            const transactionUpdateResult = await Transaction.updateOne(
                { _id: transactionId },
                {
                    $set: {
                        isPending: false,
                        type: 'credit',
                        payoutId: transferResult.id,
                        transactionDate: new Date(),
                        description: `Payout via ${transferResult.mode}`
                    }
                },
                { session }
            )

            if (transactionUpdateResult.modifiedCount === 0) {
                throw new CustomError('Failed to update transaction status', 500)
            }

            // STEP 4: Update user wallet balance within transaction
            const walletUpdateResult = await User.updateOne({ _id: user._id }, { $inc: { 'wallet.balance': amount } }, { session })

            if (walletUpdateResult.modifiedCount === 0) {
                throw new CustomError('Failed to update wallet balance', 500)
            }

            // STEP 5: Update order status within transaction
            const orderUpdateResult = await Order.updateOne(
                { _id: orderId },
                {
                    $set: {
                        'driverShare.Via': transferResult.mode,
                        'driverShare.status': 'Paid',
                        'driverShare.paidAt': new Date()
                    }
                },
                { session }
            )

            if (orderUpdateResult.modifiedCount === 0) {
                throw new CustomError('Failed to update order status', 500)
            }

            // Store transferResult for later use outside transaction
            req.transferResult = transferResult
            req.processedUser = user
            req.processedOrder = { orderId, setupResult }
        })

        // STEP 6: Send notification email (outside transaction - non-critical)
        try {
            await sendMailWithRetry(
                req.processedUser.email,
                transaction_emails.payout_email_subject(orderId),
                transaction_emails.payout_email_success(req.processedUser.username, amount, orderId)
            )
            logger.info(`Payout email sent successfully to user ${req.processedUser.email}`)
        } catch (emailError) {
            logger.error(`Failed to send payout email to user ${req.processedUser.email}:`, emailError)
            // Don't fail the entire operation for email failure
        }

        // Prepare success response
        const responseData = {
            payoutId: req.transferResult.id,
            amount,
            mode: req.transferResult.mode,
            status: 'completed',
            transactionId,
            orderId,
            processedAt: new Date(),
            ...(req.processedOrder.setupResult && {
                newFundAccount: {
                    contactId: req.processedOrder.setupResult.contactId,
                    fundAccountId: req.processedOrder.setupResult.fundAccountId
                }
            })
        }

        logger.info('Payout completed successfully', {
            payoutId: req.transferResult.id,
            userId: req.processedUser._id,
            amount,
            orderId
        })

        httpResponse(req, res, 200, generic_msg.operation_success('Payment released for driver'), responseData, null, null)
    } catch (error) {
        logger.error('Payout controller error:', {
            error: error.message,
            stack: error.stack,
            transactionId: req.body?.transactionId,
            orderId: req.body?.orderId
        })

        httpError('PAYOUT_CONTROLLER', next, error, req, error.statusCode || 500)
    } finally {
        // End the session
        await session.endSession()
    }
}

export const modifyBookingAdminWithTransaction = async (req, res, next) => {
    // Start a session for the transaction
    const session = await mongoose.startSession()

    // Declare auditData outside the transaction
    let auditData = null

    try {
        const orderId = req.params.id
        const { pickupLocation, departureDate, dropOffDate, exactLocation, destination, numberOfPassengers, passengers } = req.body

        // Validation
        if (!orderId) {
            throw new CustomError(generic_msg.invalid_input('OrderId'), 400)
        }

        // Start transaction
        await session.withTransaction(
            async () => {
                // Find the existing booking within transaction
                const existingBooking = await Order.findById(orderId).session(session)
                if (!existingBooking) {
                    throw new CustomError(generic_msg.resource_not_found('Order'), 404)
                }

                // Get the cab to check capacity within transaction
                const cab = await Cab.findById(existingBooking.bookedCab).session(session)
                if (!cab) {
                    throw new CustomError('Associated cab not found', 404)
                }

                // Store original data for logging
                const originalData = {
                    pickupLocation: existingBooking.pickupLocation,
                    departureDate: existingBooking.departureDate,
                    dropOffDate: existingBooking.dropOffDate,
                    exactLocation: existingBooking.exactLocation,
                    destination: existingBooking.destination,
                    numberOfPassengers: existingBooking.numberOfPassengers,
                    passengers: existingBooking.passengers
                }

                // Prepare update object with only provided fields
                const updateFields = {}

                if (pickupLocation !== undefined) {
                    updateFields.pickupLocation = pickupLocation
                }

                if (departureDate !== undefined) {
                    // Validate date format if provided
                    const parsedDepartureDate = new Date(departureDate)
                    if (isNaN(parsedDepartureDate.getTime())) {
                        throw new CustomError('Invalid departureDate format', 400)
                    }

                    // Ensure departureDate is not in the past (allow some buffer for admin modifications)
                    const now = new Date()
                    if (parsedDepartureDate < now) {
                        logger.warn(`Admin setting departure date in past for booking ${orderId}`)
                    }

                    updateFields.departureDate = parsedDepartureDate
                }

                if (dropOffDate !== undefined) {
                    // Validate date format if provided
                    const parsedDropOffDate = new Date(dropOffDate)
                    if (isNaN(parsedDropOffDate.getTime())) {
                        throw new CustomError('Invalid dropOffDate format', 400)
                    }

                    // Ensure dropOffDate is after departureDate (use updated or existing)
                    const finalDepartureDate = updateFields.departureDate || existingBooking.departureDate
                    if (parsedDropOffDate <= finalDepartureDate) {
                        throw new CustomError('Drop off date must be after departure date', 400)
                    }

                    updateFields.dropOffDate = parsedDropOffDate
                }

                if (exactLocation !== undefined) {
                    updateFields.exactLocation = exactLocation
                }

                if (destination !== undefined) {
                    updateFields.destination = destination
                }

                // Handle passengers modification - allow adding passengers up to cab capacity
                if (passengers !== undefined) {
                    // Validate passengers array
                    if (!Array.isArray(passengers)) {
                        throw new CustomError('Passengers must be an array', 400)
                    }

                    // Check if passengers array length exceeds cab capacity
                    if (passengers.length > cab.capacity) {
                        throw new CustomError(`Number of passengers (${passengers.length}) cannot exceed cab capacity (${cab.capacity})`, 400)
                    }

                    // Must have at least 1 passenger
                    if (passengers.length < 1) {
                        throw new CustomError('At least one passenger is required', 400)
                    }

                    // Validate each passenger object
                    for (let i = 0; i < passengers.length; i++) {
                        const passenger = passengers[i]
                        if (!passenger.firstName || !passenger.lastName) {
                            throw new CustomError(`Passenger ${i + 1}: firstName and lastName are required`, 400)
                        }

                        if (passenger.age !== undefined && (!Number.isInteger(passenger.age) || passenger.age < 0)) {
                            throw new CustomError(`Passenger ${i + 1}: Age must be a non-negative integer`, 400)
                        }

                        // Optional: Validate gender if provided
                        if (passenger.gender && !['Male', 'Female', 'Other'].includes(passenger.gender)) {
                            throw new CustomError(`Passenger ${i + 1}: Invalid gender value`, 400)
                        }
                    }

                    updateFields.passengers = passengers
                    // Auto-update numberOfPassengers to match passengers array length
                    updateFields.numberOfPassengers = passengers.length
                }

                // Handle numberOfPassengers modification (only if passengers array is not provided)
                if (numberOfPassengers !== undefined && passengers === undefined) {
                    if (!Number.isInteger(numberOfPassengers) || numberOfPassengers < 1) {
                        throw new CustomError('Number of passengers must be a positive integer', 400)
                    }

                    // Check if numberOfPassengers exceeds cab capacity
                    if (numberOfPassengers > cab.capacity) {
                        throw new CustomError(`Number of passengers (${numberOfPassengers}) cannot exceed cab capacity (${cab.capacity})`, 400)
                    }

                    // Adjust the passengers array based on numberOfPassengers
                    const currentPassengersLength = existingBooking.passengers.length

                    if (numberOfPassengers > currentPassengersLength) {
                        // Convert existing passengers to plain objects and add placeholder passengers
                        const passengersToAdd = numberOfPassengers - currentPassengersLength
                        const newPassengers = existingBooking.passengers.map((p) => p.toObject())

                        for (let i = 0; i < passengersToAdd; i++) {
                            newPassengers.push({
                                firstName: `Passenger${currentPassengersLength + i + 1}`,
                                lastName: 'ToBeUpdated',
                                age: undefined,
                                gender: undefined
                            })
                        }
                        updateFields.passengers = newPassengers
                    } else if (numberOfPassengers < currentPassengersLength) {
                        // Remove excess passengers and convert to plain objects
                        updateFields.passengers = existingBooking.passengers.slice(0, numberOfPassengers).map((p) => p.toObject())
                    }

                    updateFields.numberOfPassengers = numberOfPassengers
                }

                // Check if there are any fields to update
                if (Object.keys(updateFields).length === 0) {
                    throw new CustomError('No valid fields provided for update', 400)
                }

                // Handle cab booking updates if booking is in Assigning or Confirmed status
                if (existingBooking.bookingStatus === 'Assigning' || existingBooking.bookingStatus === 'Confirmed') {
                    // Remove the current booking from cab's upcoming bookings within transaction
                    const cabUpdateResult = await Cab.findByIdAndUpdate(
                        existingBooking.bookedCab,
                        { $pull: { upcomingBookings: { bookingId: orderId } } },
                        { session, new: true }
                    )

                    if (!cabUpdateResult) {
                        throw new CustomError('Failed to remove existing booking from cab', 500)
                    }

                    // Determine the dates to use for re-adding the booking
                    const newDepartureDate = updateFields.departureDate || existingBooking.departureDate
                    const newDropOffDate = updateFields.dropOffDate || existingBooking.dropOffDate

                    // Add the booking back with updated information within transaction
                    const cabAddResult = await Cab.findByIdAndUpdate(
                        existingBooking.bookedCab,
                        {
                            $push: {
                                upcomingBookings: {
                                    bookingId: existingBooking._id,
                                    departureDate: newDepartureDate,
                                    dropOffDate: newDropOffDate
                                }
                            }
                        },
                        { session, new: true }
                    )

                    if (!cabAddResult) {
                        throw new CustomError('Failed to add updated booking to cab', 500)
                    }
                }

                // Perform the order update within transaction
                const updatedBooking = await Order.findByIdAndUpdate(
                    orderId,
                    { $set: updateFields },
                    {
                        new: true,
                        runValidators: true,
                        session
                    }
                ).populate('userId bookedCab driverId')

                if (!updatedBooking) {
                    throw new CustomError('Failed to update booking', 500)
                }

                // Store data for logging after transaction commits
                auditData = {
                    orderId,
                    originalData,
                    updateFields,
                    updatedBooking,
                    cab
                }

                return updatedBooking
            },
            {
                // Transaction options
                readPreference: 'primary',
                readConcern: { level: 'local' },
                writeConcern: { w: 'majority' }
            }
        )

        // Transaction completed successfully, now log the audit data
        if (config.ENV !== EApplicationEnvironment.PRODUCTION && auditData) {
            logger.info(`Booking ${auditData.orderId} modified by admin`, {
                meta: {
                    originalData: auditData.originalData,
                    updatedFields: auditData.updateFields,
                    adminAction: 'MODIFY_BOOKING',
                    passengerChange: {
                        from: auditData.originalData.numberOfPassengers,
                        to: auditData.updatedBooking.numberOfPassengers
                    }
                }
            })
        }

        // Get the final updated booking data (re-fetch to ensure consistency)
        const finalBooking = await Order.findById(orderId).populate('userId bookedCab driverId')
        const cab = await Cab.findById(finalBooking.bookedCab)

        const responseData = {
            booking: finalBooking,
            modifiedFields: Object.keys(auditData?.updateFields || {}),
            passengerInfo: {
                originalCount: auditData?.originalData.numberOfPassengers,
                newCount: finalBooking.numberOfPassengers,
                cabCapacity: cab.capacity,
                availableSlots: cab.capacity - finalBooking.numberOfPassengers
            }
        }

        httpResponse(req, res, 200, generic_msg.operation_success('Admin Modify booking'), responseData)
    } catch (error) {
        logger.error('Error in modifyBookingAdmin:', {
            meta: {
                error: error.message,
                orderId: req.params.id,
                stack: error.stack
            }
        })

        // No manual rollback needed - transaction will automatically rollback on error
        httpError('ADMIN UPDATE BOOKING', next, error, req, 500)
    } finally {
        // Always end the session
        await session.endSession()
    }
}
