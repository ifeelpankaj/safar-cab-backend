import httpResponse from '../utils/httpResponse.js'
import { generic_msg, user_msg } from '../constants/res.message.js'
import httpError from '../utils/httpError.js'
import { User } from '../models/user.model.js'
import config from '../config/config.js'
import { generateNumericOTP } from '../utils/otherUtils.js'
import { user_emails } from '../constants/emails.js'
import { sendMailWithRetry } from '../services/email.service.js'
import logger from '../utils/logger.js'
import { sendToken } from '../services/token.service.js'
import cloudinary from '../config/cloudinary.js'
import fs from 'fs'
import CustomError from '../utils/customeError.js'
import { Cab } from '../models/cab.model.js'

export const register = async (req, res, next) => {
    try {
        const { username, email, password, phoneNumber, role } = req.body
        // Check if user already exists
        const existingUser = await User.findOne({ $or: [{ email }, { phoneNumber }] })

        if (existingUser) {
            throw new CustomError(user_msg.user_already_register, 409)
        }

        // Generate OTP
        const otp = generateNumericOTP(config.OTP_LENGTH)
        const otpExpireMinutes = parseInt(config.OTP_EXPIRE, 10)
        if (isNaN(otpExpireMinutes)) {
            throw new CustomError(user_msg.error_generating_otp, 500)
        }
        const otpExpiryDate = new Date(Date.now() + otpExpireMinutes * 60 * 1000)

        const user = await User.create({
            username,
            email,
            password,
            phoneNumber,
            role,
            otp,
            otp_attempt: 0,
            otp_expiry: otpExpiryDate
        })
        // Send verification email

        try {
            await sendMailWithRetry(email, user_emails.account_verification_subject, user_emails.registration_email(username, otp))
        } catch (email_error) {
            logger.error(generic_msg.email_sending_failed(email), email_error)

            return httpResponse(req, res, 503, generic_msg.email_sending_failed(email))
        }

        // Send response with token Okay
        return sendToken(req, res, user, 201, generic_msg.operation_success('Register User'))
    } catch (error) {
        // Log other errors
        return httpError('Register', next, error, req, 500)
    }
}

const MAX_OTP_ATTEMPTS = 5

export const verify = async (req, res, next) => {
    try {
        const { otp } = req.body
        // Input validation

        const numericOTP = Number(otp)

        const user = await User.findById(req.user._id)
        if (!user) {
            // return httpResponse(req, res, 404, responseMessage.USER_NOT_FOUND, null, null)
            throw new CustomError(generic_msg.resource_not_found('User'), 404)
        }
        // Check if user is already verified
        if (user.isVerified) {
            throw new CustomError(user_msg.user_already_register, 409)
        }
        // Check if user has exceeded maximum attempts
        if (user.otp_attempt >= MAX_OTP_ATTEMPTS) {
            throw new CustomError(generic_msg.too_many_attempts('otp'), 429)
        }
        // OTP validation
        if (user.otp !== numericOTP) {
            user.otp_attempt += 1
            await user.save()
            if (user.otp_attempt >= MAX_OTP_ATTEMPTS) {
                throw new CustomError(generic_msg.too_many_attempts('otp'), 429)
            }
            throw new CustomError(user_msg.incorrect_otp(MAX_OTP_ATTEMPTS - user.otp_attempt), 400)
        }
        // OTP expiration check
        if (user.otp_expiry.getTime() < Date.now()) {
            throw new CustomError(user_msg.opt_expire, 400)
        }
        // Update user
        user.isVerified = true
        user.otp = null
        user.otp_expiry = null
        user.otp_attempt = 0 // Reset attempts on successful verification
        await user.save()
        // Send email notification
        try {
            await sendMailWithRetry(
                user.email,
                user_emails.account_verification_success_subject(user.username),
                user_emails.verification_email_success(user.username)
            )
        } catch (email_error) {
            logger.error(generic_msg.email_sending_failed(user.email), { error: email_error })
            // Note: We're continuing even if email fails, as the verification was successful
        }
        // Send token and success response
        return sendToken(req, res, user, 200, user_msg.account_verified)
    } catch (error) {
        return httpError('Verify', next, error, req, 500)
    }
}

export const login = async (req, res, next) => {
    try {
        const { email, password } = req.body

        if (!email || !password) {
            throw new CustomError(generic_msg.invalid_input('Email or password'), 400)
        }

        const user = await User.findOne({ email }).select('+password')

        if (!user) {
            throw new CustomError(generic_msg.resource_not_found('User'), 401)
        }

        // @ts-ignore
        const isMatch = await user.verifyPassword(password)

        if (!isMatch) {
            throw new CustomError(user_msg.auth_failed, 401)
        }

        return sendToken(req, res, user, 201, user_msg.login_success)
    } catch (error) {
        return httpError('LOGIN', next, error, req, 500)
    }
}

export const logout = async (req, res, next) => {
    try {
        // Clear the authentication token and other related cookies
        res.cookie('token', '', {
            expires: new Date(Date.now()),
            httpOnly: true,
            secure: config.ENV === 'production', // Use secure cookies in production
            sameSite: 'strict' // Protect against CSRF attacks
        })
            .cookie('deletionToken', '', {
                expires: new Date(Date.now()),
                httpOnly: true,
                secure: config.ENV === 'production',
                sameSite: 'strict'
            })
            .clearCookie('auth_error') // Clear the error cookie if it exists

        // Send success response
        logger.info(`${req.user.username}  ${req.user._id} ${user_msg.logout_success}`)
        return httpResponse(req, res, 201, user_msg.logout_success, null, null)
    } catch (error) {
        return httpError(next, error, req, 500)
    }
}

export const updateProfile = async (req, res, next) => {
    try {
        const user = await User.findById(req.user._id)

        if (!user) {
            throw new CustomError(generic_msg.resource_not_found('User'), 400)
        }
        const { name, phoneNo } = req.body

        if (name) {
            user.username = name
        }
        if (phoneNo) {
            user.phoneNumber = phoneNo
        }

        if (req.files && req.files.avatar) {
            const { avatar } = req.files

            // Delete old avatar from cloudinary if it exists
            if (user.avatar && user.avatar.public_id) {
                await cloudinary.v2.uploader.destroy(user.avatar.public_id)
            }

            // Upload new avatar
            const myCloud = await cloudinary.v2.uploader.upload(avatar.tempFilePath, {
                folder: 'TandT',
                resource_type: 'image'
            })

            // Remove temporary file
            fs.unlinkSync(avatar.tempFilePath)

            user.avatar = {
                public_id: myCloud.public_id,
                url: myCloud.secure_url
            }
        }
        // Cachestorage.del(['all_user','all_drivers']);

        await user.save()

        return httpResponse(req, res, 201, generic_msg.resource_update_success('Profile'), user, null)
    } catch (error) {
        return httpError('Update profile', next, error, req, 500)
    }
}

export const updatePassword = async (req, res, next) => {
    try {
        const { oldPassword, newPassword } = req.body

        if (!oldPassword || !newPassword) {
            // return res
            //   .status(400)
            //   .json({ success: false, message: "Please enter all fields" });
            throw new CustomError(generic_msg.invalid_input('Password'), 400)
        }

        const user = await User.findById(req.user._id).select('+password')
        if (!user) {
            throw new CustomError(generic_msg.resource_not_found('User'), 400)
        }

        // @ts-ignore
        const isMatch = await user.verifyPassword(oldPassword)

        if (!isMatch) {
            throw new CustomError(user_msg.auth_failed, 400)
        }

        user.password = newPassword
        await user.save()
        // Send email notification
        try {
            await sendMailWithRetry(
                user.email,
                user_emails.password_reset_email_subject,
                user_emails.password_update_email(user.username),
                `Congratulations ${user.username}! Your account has been successfully verified.`
            )
        } catch (email_error) {
            logger.error(generic_msg.email_sending_failed(user.email), { error: email_error })
            // Note: We're continuing even if email fails, as the verification was successful
        }
        return httpResponse(req, res, 201, user_msg.password_change_success)
    } catch (error) {
        return httpError('Update Password', next, error, req, 500)
    }
}

export const forgetPassword = async (req, res, next) => {
    try {
        const { email } = req.body
        const user = await User.findOne({ email })

        if (!user) {
            throw new CustomError(generic_msg.resource_not_found('User'), 404)
        }
        if (!user.isVerified) {
            throw new CustomError(generic_msg.resource_not_found('User'), 404)
        }
        // Generate a random OTP
        const otp = generateNumericOTP(config.OTP_LENGTH)
        const otpExpireMinutes = parseInt(config.OTP_EXPIRE, 10)
        if (isNaN(otpExpireMinutes)) {
            throw new CustomError('Error Genrating OTP', 500)
        }

        // Set the OTP and its expiry in the user document
        user.resetPasswordOtp = otp

        user.resetPasswordOtpExpiry = new Date(Date.now() + otpExpireMinutes * 60 * 1000)

        // Save the user document
        await user.save()

        // Send the email containing the OTP
        try {
            await sendMailWithRetry(user.email, user_emails.verification_email_success, user_emails.forget_password_email(user.username, otp))
        } catch (emailError) {
            logger.error(generic_msg.email_sending_failed(user.email), { meta: { error: emailError } })

            return httpResponse(req, res, 503, generic_msg.email_sending_failed(email))
        }
        return httpResponse(req, res, 200, generic_msg.email_sending_success(user.email))
    } catch (error) {
        return httpError('Forget Password', next, error, req, 500)
    }
}

export const resetPassword = async (req, res, next) => {
    try {
        const { otp, newPassword } = req.body
        if (!otp || !newPassword) {
            throw new CustomError(generic_msg.invalid_input('OTP & Password'))
        }

        const user = await User.findOne({
            resetPasswordOtp: otp,
            resetPasswordOtpExpiry: { $gt: Date.now() }
        })

        if (!user) {
            throw new CustomError(generic_msg.resource_not_found('User'), 400)
        }

        // Set the new password and clear the OTP and its expiry
        user.password = newPassword
        user.resetPasswordOtp = null
        user.resetPasswordOtpExpiry = null

        // Save the updated user document
        await user.save()

        // Send email notification for successful password reset
        try {
            await sendMailWithRetry(user.email, user_emails.verify_account_email_subject, user_emails.password_update_email(user.username))
        } catch (emailError) {
            logger.error(generic_msg.email_sending_failed(user.email), { meta: { error: emailError } })
            // Note: We're continuing even if email fails, as the verification was successful
        }

        return httpResponse(req, res, 201, user_msg.password_change_success, user, null)
    } catch (error) {
        return httpError('Reset password', next, error, req, 500)
    }
}

export const getProfileById = async (req, res, next) => {
    try {
        // Extracting ID from request body
        const { id } = req.params

        // Ensure the ID is provided
        if (!id) {
            throw new CustomError(generic_msg.invalid_input('ID'), 400)
        }

        const user = await User.findById(id).lean()

        if (!user) {
            // Handle the case where no user is found
            throw new CustomError(generic_msg.resource_not_found('User'), 400)
        }

        if (user.role === 'Driver') {
            const cab = await Cab.findOne({ belongsTo: id })
            if (!cab) {
                throw new CustomError(generic_msg.resource_not_found('Cab'), 404)
            }

            // @ts-ignore
            cab.updateUpcomingBookings()
            await cab.save()
            const driverInfo = {
                ...user,
                cab: {
                    ...cab.toObject()
                }
            }

            return httpResponse(req, res, 200, generic_msg.operation_success('Get Profile'), driverInfo, null)
        }
        return httpResponse(req, res, 200, generic_msg.operation_success('Get Profile'), user, null)
    } catch (error) {
        return httpError('Profile By ID', next, error, req, 500)
    }
}

export const myProfile = async (req, res, next) => {
    try {
        const user = await User.findById(req.user._id)
        if (!user) {
            // Handle the case where no user is found
            throw new CustomError(generic_msg.resource_not_found('User'), 400)
        }
        return httpResponse(req, res, 200, generic_msg.operation_success('Get my profile'), user, null)
    } catch (error) {
        return httpError('My profile', next, error, req, 500)
    }
}
