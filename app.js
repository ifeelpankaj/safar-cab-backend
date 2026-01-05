import express from 'express'
import path from 'path'
import router from './src/routes/system.api.routes.js'
import globalErrorHandler from './src/middlewares/globalErrorHandler.js'
import httpError from './src/utils/httpError.js'

import { fileURLToPath } from 'url'
import helmet from 'helmet'
import corsOptions from './src/middlewares/cors.middleware.js'
import cookieParser from 'cookie-parser'
import fileUpload from 'express-fileupload'
import config from './src/config/config.js'
import { EApplicationEnvironment } from './src/constants/application.js'
import session from 'express-session'
import MongoStore from 'connect-mongo'

//Routes
import userRoute from './src/routes/user.api.routes.js'
import cabRoute from './src/routes/cab.api.routes.js'
import driverRoute from './src/routes/driver.api.routes.js'
import orderRoute from './src/routes/order.api.routes.js'
import adminRoute from './src/routes/admin.api.routes.js'
import { generic_msg } from './src/constants/res.message.js'
// import advertismentRoute from './src/routes/advertismentRoute.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const app = express()

//Middleware
app.use(helmet())

app.use(corsOptions)

app.use(cookieParser())
app.use(express.json({ limit: '50mb' }))
app.use(express.urlencoded({ limit: '50mb', extended: true }))
app.use(
    fileUpload({
        limits: { fileSize: 50 * 1024 * 1024 },
        useTempFiles: true
    })
)
app.use(express.static(path.join(__dirname, 'public')))
//Not using Session for now as implemented JWT //

app.use(
    session({
        store: MongoStore.create({
            mongoUrl: config.DB_URI, // MongoDB connection URL
            ttl: 14 * 24 * 60 * 60 // Sessions expire in 14 days
        }),
        secret: config.SESSION_SECRET || 'temporary',
        resave: false,
        saveUninitialized: false,

        cookie: {
            maxAge: 1000 * 60 * 60 * 2, // 1000ms * 60s * 60min * 2hrs
            secure: config.ENV !== EApplicationEnvironment.PRODUCTION ? false : true,
            httpOnly: config.ENV !== EApplicationEnvironment.PRODUCTION ? false : true,
            sameSite: config.ENV !== EApplicationEnvironment.PRODUCTION ? false : 'none'
        }
    })
)

app.use('/api/v1/system', router)
app.use('/api/v1/user', userRoute)
app.use('/api/v1', cabRoute)
app.use('/api/v1/driver', driverRoute)
app.use('/api/v1/booking', orderRoute)
app.use('/api/v1', adminRoute)
// app.use('/api/v1', advertismentRoute)

// 404 Error handler
app.use((req, res, next) => {
    try {
        throw new Error(generic_msg.resource_not_found('Route'))
    } catch (err) {
        httpError('404', next, err, req, 404)
    }
})

app.use(globalErrorHandler)

export default app
