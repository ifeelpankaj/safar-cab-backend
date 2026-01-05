import config from '../config/config.js'
import { EApplicationEnvironment } from '../constants/application.js'
import { rateLimiterMongo } from '../config/rateLimiter.js'
import httpError from '../utils/httpError.js'
import { generic_msg } from '../constants/res.message.js'

// eslint-disable-next-line consistent-return
export default (req, _res, next) => {
    if (config.ENV !== EApplicationEnvironment.PRODUCTION) {
        return next()
    }

    if (rateLimiterMongo) {
        rateLimiterMongo
            .consume(req.ip, 1)
            .then(() => {
                next()
            })
            .catch(() => {
                httpError(next, new Error(generic_msg.too_manay_request), req, 429)
            })
    }
}
