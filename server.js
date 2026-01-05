import app from './app.js'
import config from './src/config/config.js'
import { initRateLimiter } from './src/config/rateLimiter.js'
import { EApplicationEnvironment } from './src/constants/application.js'
import databaseService from './src/services/database.service.js'
import logger from './src/utils/logger.js'

if (config.ENV === EApplicationEnvironment.TESTING) {
    const server = app.listen(config.PORT)

    ;(async () => {
        try {
            // Connect to the database
            const connection = await databaseService.connectLocally()

            // Log successful database connection
            logger.info('DATABASE CONNECTION = TRUE', {
                meta: { CONNECTION_NAME: connection.name }
            })

            initRateLimiter(connection)
            logger.info(`RATE_LIMITER_INITIATED`, {
                meta: {
                    Status: config.ENV !== EApplicationEnvironment.PRODUCTION ? 'Deactivated' : 'Activated'
                }
            })

            // Log application start
            logger.info('SERVER IS STARTED && HEALTHY = TRUE', {
                meta: { PORT: config.PORT }
            })
        } catch (error) {
            // Log application error
            logger.error('SERVER IS STARTED && HEALTHY != TRUE', {
                meta: {
                    message: error.message,
                    stack: error.stack
                }
            })

            // Attempt to close the server
            server.close((closeError) => {
                if (closeError) {
                    // Log server close error
                    logger.error('APPLICATION_ERROR', {
                        meta: {
                            message: closeError.message,
                            stack: closeError.stack
                        }
                    })
                }

                // Exit the process with failure status
                process.exit(1)
            })
        }
    })()
} else {
    ;(async () => {
        let server = null

        try {
            // 1. Connect to database FIRST
            logger.info('Starting application initialization...', {
                meta: {
                    environment: config.ENV,
                    nodeVersion: process.version,
                    port: config.PORT
                }
            })

            logger.info('Initializing database connection...')
            const connection = await databaseService.connect()

            // 2. Validate connection is ready
            const healthCheck = await databaseService.healthCheck()
            if (!healthCheck.healthy) {
                throw new Error(`Database health check failed: ${healthCheck.reason}`)
            }

            // 3. Test transaction support if needed (optional but recommended)
            const transactionTest = await databaseService.testTransactionSupport()
            logger.info('Transaction support test completed', {
                meta: {
                    success: transactionTest.success,
                    message: transactionTest.message,
                    results: transactionTest.results
                }
            })

            // 4. Log successful database connection with comprehensive details
            const connectionInfo = await databaseService.getConnectionInfo()
            logger.info('DATABASE CONNECTION = TRUE', {
                meta: {
                    CONNECTION_NAME: connection.name,
                    HOST: connectionInfo.host,
                    PORT: connectionInfo.port,
                    TRANSACTION_SUPPORT: connectionInfo.transactionSupport,
                    REPLICA_SET: connectionInfo.replicaSet?.name || 'None',
                    SERVER_VERSION: connectionInfo.server?.version,
                    POOL_SIZE: `${connectionInfo.pool.min}-${connectionInfo.pool.max}`,
                    CONNECTION_STATE: connectionInfo.connectionState,
                    DATABASE_STATS: connectionInfo.databaseStats
                }
            })

            // 5. Initialize rate limiter
            initRateLimiter(connection)
            logger.info('RATE_LIMITER_INITIATED', {
                meta: {
                    Status: config.ENV !== EApplicationEnvironment.PRODUCTION ? 'Deactivated' : 'Activated',
                    Environment: config.ENV
                }
            })

            // 6. Add health check endpoint BEFORE starting server
            app.get('/health', async (req, res) => {
                try {
                    const dbHealth = await databaseService.healthCheck()
                    const connectionInfo = await databaseService.getConnectionInfo()
                    const dbStats = await databaseService.getStats()

                    const health = {
                        status: dbHealth.healthy ? 'healthy' : 'unhealthy',
                        timestamp: new Date().toISOString(),
                        uptime: process.uptime(),
                        database: {
                            connected: connectionInfo.connected,
                            transactionSupport: connectionInfo.transactionSupport,
                            host: connectionInfo.host,
                            db: connectionInfo.db,
                            connectionState: connectionInfo.connectionState,
                            replicaSet: connectionInfo.replicaSet?.name,
                            stats: dbStats.error
                                ? { error: dbStats.error }
                                : {
                                      collections: dbStats.collections,
                                      objects: dbStats.objects
                                  }
                        },
                        application: {
                            environment: config.ENV,
                            nodeVersion: process.version,
                            memory: process.memoryUsage()
                        }
                    }

                    const statusCode = dbHealth.healthy ? 200 : 503
                    res.status(statusCode).json(health)

                    // Log health check access
                    logger.info('Health check accessed', {
                        meta: {
                            status: health.status,
                            ip: req.ip,
                            userAgent: req.get('User-Agent')
                        }
                    })
                } catch (error) {
                    logger.error('Health check endpoint error', {
                        meta: {
                            message: error.message,
                            stack: error.stack
                        }
                    })
                    res.status(503).json({
                        status: 'unhealthy',
                        error: error.message,
                        timestamp: new Date().toISOString()
                    })
                }
            })

            // 7. Add database readiness check endpoint
            app.get('/ready', async (req, res) => {
                try {
                    const isReady = databaseService.isReady()
                    const connectionInfo = await databaseService.getConnectionInfo()

                    const readiness = {
                        ready: isReady,
                        timestamp: new Date().toISOString(),
                        database: {
                            ready: isReady,
                            connectionState: connectionInfo.connectionState,
                            readyState: connectionInfo.readyState
                        }
                    }

                    res.status(isReady ? 200 : 503).json(readiness)
                } catch (error) {
                    logger.error('Readiness check endpoint error', {
                        meta: {
                            message: error.message,
                            stack: error.stack
                        }
                    })
                    res.status(503).json({
                        ready: false,
                        error: error.message,
                        timestamp: new Date().toISOString()
                    })
                }
            })

            // 8. ONLY NOW start the HTTP server
            server = app.listen(config.PORT, () => {
                logger.info('SERVER IS STARTED && HEALTHY = TRUE', {
                    meta: {
                        PORT: config.PORT,
                        ENVIRONMENT: config.ENV,
                        DATABASE_READY: databaseService.isReady(),
                        STARTUP_TIME: process.uptime()
                    }
                })
            })

            // 9. Handle server errors
            server.on('error', (error) => {
                logger.error('SERVER ERROR', {
                    meta: {
                        message: error.message,
                        stack: error.stack,
                        port: config.PORT
                    }
                })

                // Attempt graceful shutdown on server error
                gracefulShutdown(server, 'Server Error')
            })

            // 10. Handle server close event
            server.on('close', () => {
                logger.info('HTTP server closed')
            })

            // 11. Setup graceful shutdown handlers
            const gracefulShutdown = (server, reason) => {
                logger.info(`Initiating graceful shutdown: ${reason}`)

                server.close(async (closeError) => {
                    if (closeError) {
                        logger.error('SERVER CLOSE ERROR', {
                            meta: {
                                message: closeError.message,
                                stack: closeError.stack
                            }
                        })
                    }

                    try {
                        // Close database connection
                        if (databaseService.isReady()) {
                            logger.info('Closing database connection...')
                            await databaseService.manager.gracefulShutdown()
                        }

                        logger.info('Graceful shutdown completed')
                        process.exit(0)
                    } catch (shutdownError) {
                        logger.error('Error during graceful shutdown', {
                            meta: {
                                message: shutdownError.message,
                                stack: shutdownError.stack
                            }
                        })
                        process.exit(1)
                    }
                })
            }

            // Setup process signal handlers
            process.on('SIGTERM', () => gracefulShutdown(server, 'SIGTERM'))
            process.on('SIGINT', () => gracefulShutdown(server, 'SIGINT'))

            // Handle uncaught exceptions
            process.on('uncaughtException', (error) => {
                logger.error('UNCAUGHT EXCEPTION', {
                    meta: {
                        message: error.message,
                        stack: error.stack
                    }
                })
                gracefulShutdown(server, 'Uncaught Exception')
            })

            // Handle unhandled promise rejections
            process.on('unhandledRejection', (reason, promise) => {
                logger.error('UNHANDLED PROMISE REJECTION', {
                    meta: {
                        reason: reason instanceof Error ? reason.message : reason,
                        stack: reason instanceof Error ? reason.stack : undefined,
                        promise: promise.toString()
                    }
                })
                gracefulShutdown(server, 'Unhandled Promise Rejection')
            })
        } catch (error) {
            logger.error('STARTUP FAILED', {
                meta: {
                    message: error.message,
                    stack: error.stack,
                    phase: server ? 'server-start' : 'database-connection',
                    environment: config.ENV,
                    port: config.PORT
                }
            })

            // Close server if it was started
            if (server) {
                server.close((closeError) => {
                    if (closeError) {
                        logger.error('SERVER CLOSE ERROR DURING STARTUP FAILURE', {
                            meta: {
                                message: closeError.message,
                                stack: closeError.stack
                            }
                        })
                    }
                    process.exit(1)
                })
            } else {
                process.exit(1)
            }
        }
    })()
}
