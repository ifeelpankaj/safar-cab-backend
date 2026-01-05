import { Router } from 'express'
import { isAuthenticated } from '../middlewares/auth.middleware.js'
import {
    bookCab,
    getAllPendingOrder,
    getMyBookings,
    getOrderDetail,
    getOrderDetailForCustomer,
    // paymentVerification,
    paymentVerificationWithManualRollback,
    paymentVerificationWithTransaction
} from '../controllers/order.api.controller.js'
import config from '../config/config.js'
import { EApplicationEnvironment } from '../constants/application.js'

const router = Router()

router.route('/place').post(isAuthenticated, bookCab)

router.route('/my').get(isAuthenticated, getMyBookings)

router.route('/customer/:id').get(isAuthenticated, getOrderDetailForCustomer)

router.route('/:id').get(isAuthenticated, getOrderDetail)

router.route('/pending').get(isAuthenticated, getAllPendingOrder)

// Environment-specific payment verification route
if (config.ENV !== EApplicationEnvironment.TESTING) {
    router.route('/payment/verification').post(isAuthenticated, paymentVerificationWithTransaction)
} else {
    router.route('/payment/verification').post(isAuthenticated, paymentVerificationWithManualRollback)
}

export default router
