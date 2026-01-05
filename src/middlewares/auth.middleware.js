// @ts-nocheck
import jwt from 'jsonwebtoken'
import config from '../config/config.js'
import httpResponse from '../utils/httpResponse.js'
import { generic_msg, user_msg } from '../constants/res.message.js'
import { User } from '../models/user.model.js'
import httpError from '../utils/httpError.js'
import CustomError from '../utils/customeError.js'

export const isAuthenticated = async (req, res, next) => {
    try {
        // Extract token from cookies
        const { token } = req.cookies

        if (!token) {
            // Handle missing token case
            throw new CustomError(generic_msg.resource_not_found('! Account'), 401)
        }

        // Verify the token
        const decoded = jwt.verify(token, config.JWT_SECRET)

        if (!decoded || !decoded._id) {
            // Handle invalid token case
            throw new CustomError(user_msg.token_invalid, 401)
        }

        // Fetch user from the decoded token
        const user = await User.findById(decoded._id).select('-password')
        if (!user) {
            // Handle user not found
            throw new CustomError(generic_msg.resource_not_found('User'), 401)
        }

        // Attach user to request object
        req.user = user
        return next()
    } catch (err) {
        // Handle token expiration error
        if (err instanceof jwt.TokenExpiredError) {
            return httpResponse(req, res, 401, user_msg.token_expired, null, null)
        }

        // Handle invalid JWT error
        if (err instanceof jwt.JsonWebTokenError) {
            return httpResponse(req, res, 401, user_msg.token_invalid, null, null)
        }

        // General error handling
        return httpError('Authentication Error', next, err, req, 500)
    }
}
