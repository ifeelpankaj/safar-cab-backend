import { Router } from 'express'
import { isAuthenticated } from '../middlewares/auth.middleware.js'
import {
    // cancelBooking,
    cancelBookingWithManualRollback,
    cancelBookingWithTransaction,
    // completeBooking,
    completeBookingWithManualRollback,
    completeBookingWithTransaction,
    confirmBooking,
    confirmBookingWithTransaction,
    // driverVerification,
    driverVerificationWithManualRollback,
    getDriverAllBookings,
    getDriverAllTransaction,
    getDriverUpcommingBookings,
    getDriverWalletBalance
} from '../controllers/driver.controller.js'
import config from '../config/config.js'
import { EApplicationEnvironment } from '../constants/application.js'

const router = Router()

router.route('/doc/verification').put(isAuthenticated, driverVerificationWithManualRollback)

router.route('/get/upcoming/bookings').get(isAuthenticated, getDriverUpcommingBookings)

router.route('/all/bookings').get(isAuthenticated, getDriverAllBookings)

router.route('/wallet-balance').get(isAuthenticated, getDriverWalletBalance)

router.route('/get-all-transaction').get(isAuthenticated, getDriverAllTransaction)

if (config.ENV !== EApplicationEnvironment.TESTING) {
    router.route('/confirm-driver-booking').put(isAuthenticated, confirmBookingWithTransaction)

    router.route('/cancel-driver-booking').put(isAuthenticated, cancelBookingWithTransaction)

    router.route('/complete-driver-booking').put(isAuthenticated, completeBookingWithTransaction)
} else {
    router.route('/confirm-driver-booking').put(isAuthenticated, confirmBooking)

    router.route('/cancel-driver-booking').put(isAuthenticated, cancelBookingWithManualRollback)

    router.route('/complete-driver-booking').put(isAuthenticated, completeBookingWithManualRollback)
}

export default router
