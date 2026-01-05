import { Router } from 'express'

import { isAuthenticated } from '../middlewares/auth.middleware.js'
import {
    getDriverCab,
    // deleteCab,
    getRateDefinedCab,
    getSingleCabs,
    makeCabReady,
    // registerCab,
    registerCabWithManulRollback,
    registerCabWithTransaction,
    // updateCab,
    updateCabWithManualRollback,
    updateCabWithTransaction
} from '../controllers/cab.api.controller.js'
import config from '../config/config.js'
import { EApplicationEnvironment } from '../constants/application.js'

const router = Router()

router.route('/cab/via/display').get(isAuthenticated, getRateDefinedCab)

router.route('/cab/via/:id').get(isAuthenticated, getSingleCabs)

// router.route('/driver-owned').get(isAuthenticated, getDriverOwnedCabs)

// router.route('/delete/:id').delete(isAuthenticated, deleteCab)

router.route('/make-cab/ready/:id').get(isAuthenticated, makeCabReady)
router.route('/cab/owned/by/driver').get(isAuthenticated, getDriverCab)

if (config.ENV !== EApplicationEnvironment.TESTING) {
    router.route('/cab/register').post(isAuthenticated, registerCabWithTransaction)

    router.route('/cab/update/:id').put(isAuthenticated, updateCabWithTransaction)
} else {
    router.route('/cab/register').post(isAuthenticated, registerCabWithManulRollback)

    router.route('/cab/update/:id').put(isAuthenticated, updateCabWithManualRollback)
}

export default router
