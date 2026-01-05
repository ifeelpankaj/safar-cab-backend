import { Router } from 'express'
import {
    forgetPassword,
    getProfileById,
    login,
    logout,
    myProfile,
    register,
    resetPassword,
    updatePassword,
    updateProfile,
    verify
} from '../controllers/user.api.controller.js'
import { isAuthenticated } from '../middlewares/auth.middleware.js'

const router = Router()

router.route('/register').post(register)
router.route('/verify').post(isAuthenticated, verify)
router.route('/login').post(login)
router.route('/logout').get(isAuthenticated, logout)
router.route('/logout').get(isAuthenticated, logout)
router.route('/modify').put(isAuthenticated, updateProfile)
router.route('/modify/password').put(isAuthenticated, updatePassword)
router.route('/forget/password').post(forgetPassword)

router.route('/reset/password').put(resetPassword)
router.route('/me').get(isAuthenticated, myProfile)

router.route('/via/:id').get(isAuthenticated, getProfileById)

export default router
