import mongoose from 'mongoose'
import config from '../config/config.js'
import logger from '../utils/logger.js'

const DbString = config.DB_URI || ''

class DatabaseManager {
    constructor() {
        this.connection = null
        this.isConnected = false
        this.reconnectAttempts = 0
        this.maxReconnectAttempts = 5
        this.reconnectInterval = 5000

        // Add connection state tracking
        this.connectionState = 'disconnected' // disconnected, connecting, connected, error
        this.lastConnectionError = null
        this.connectionPromise = null // To prevent multiple simultaneous connections

        this.connectionOptions = {
            dbName: config.DB_NAME || 'safar-cabs',
            maxPoolSize: 50,
            minPoolSize: 5,
            maxIdleTimeMS: 30000,
            serverSelectionTimeoutMS: 30000,
            socketTimeoutMS: 0,
            connectTimeoutMS: 30000,
            heartbeatFrequencyMS: 10000,
            bufferCommands: true,
            retryWrites: true,
            retryReads: true,
            writeConcern: {
                w: 'majority',
                j: true,
                wtimeout: 10000
            },
            readConcern: { level: 'majority' },
            readPreference: 'primary',
            compressors: ['zlib', 'snappy'],
            authSource: 'admin',
            appName: `${config.NODE_ENV || 'development'}-app`,
            serverApi: {
                version: '1',
                strict: false,
                deprecationErrors: false
            }
        }
        this.setupEventListeners()
    }

    setupEventListeners() {
        mongoose.connection.on('connected', () => {
            logger.info(' MongoDB connected successfully', {
                meta: {
                    host: mongoose.connection.host,
                    port: mongoose.connection.port,
                    db: mongoose.connection.name
                }
            })
            this.isConnected = true
            this.connectionState = 'connected'
            this.reconnectAttempts = 0
            this.lastConnectionError = null
        })

        mongoose.connection.on('error', (err) => {
            logger.error(' MongoDB error', {
                meta: {
                    message: err.message,
                    stack: err.stack,
                    connectionState: this.connectionState
                }
            })
            this.isConnected = false
            this.connectionState = 'error'
            this.lastConnectionError = err
        })

        mongoose.connection.on('disconnected', () => {
            logger.warn(' MongoDB disconnected', {
                meta: {
                    reconnectAttempts: this.reconnectAttempts,
                    maxReconnectAttempts: this.maxReconnectAttempts
                }
            })
            this.isConnected = false
            this.connectionState = 'disconnected'
            this.handleReconnection()
        })

        mongoose.connection.on('reconnected', () => {
            logger.info('MongoDB reconnected', {
                meta: {
                    attemptNumber: this.reconnectAttempts,
                    host: mongoose.connection.host,
                    db: mongoose.connection.name
                }
            })
            this.isConnected = true
            this.connectionState = 'connected'
            this.reconnectAttempts = 0
            this.lastConnectionError = null
        })

        process.on('SIGINT', this.gracefulShutdown.bind(this))
        process.on('SIGTERM', this.gracefulShutdown.bind(this))
    }

    async connect() {
        // Prevent multiple simultaneous connection attempts
        if (this.connectionPromise) {
            logger.info('Connection already in progress, waiting for existing attempt')
            return this.connectionPromise
        }

        if (this.isConnected && mongoose.connection.readyState === 1) {
            logger.info(' Already connected to MongoDB', {
                meta: {
                    host: mongoose.connection.host,
                    db: mongoose.connection.name,
                    readyState: mongoose.connection.readyState
                }
            })
            return mongoose.connection
        }

        this.connectionState = 'connecting'

        this.connectionPromise = this._performConnection()

        try {
            const result = await this.connectionPromise
            this.connectionState = 'connected'
            this.lastConnectionError = null
            return result
        } catch (error) {
            this.connectionState = 'error'
            this.lastConnectionError = error
            logger.error('Failed to establish MongoDB connection', {
                meta: {
                    message: error.message,
                    stack: error.stack,
                    connectionState: this.connectionState
                }
            })
            throw error
        } finally {
            this.connectionPromise = null
        }
    }
    async connectLocally() {
        try {
            await mongoose.connect(config.DB_URI)

            return mongoose.connection
        } catch (err) {
            //   console.error("Failed to connect to MongoDB", err);
            throw err
        }
    }
    async _performConnection() {
        try {
            logger.info(' Connecting to MongoDB...', {
                meta: {
                    dbUri: DbString.replace(/\/\/.*@/, '//***:***@'), // Mask credentials
                    options: {
                        maxPoolSize: this.connectionOptions.maxPoolSize,
                        minPoolSize: this.connectionOptions.minPoolSize,
                        serverSelectionTimeoutMS: this.connectionOptions.serverSelectionTimeoutMS
                    }
                }
            })

            // Add connection timeout
            const connectionTimeout = new Promise((_, reject) => {
                setTimeout(() => reject(new Error('Connection timeout after 30 seconds')), 30000)
            })

            // @ts-ignore
            const connection = mongoose.connect(DbString, this.connectionOptions)

            await Promise.race([connection, connectionTimeout])

            // Validate the connection
            await this._validateConnection()

            return mongoose.connection
        } catch (err) {
            logger.error('Failed to connect to MongoDB', {
                meta: {
                    message: err.message,
                    stack: err.stack,
                    connectionOptions: {
                        maxPoolSize: this.connectionOptions.maxPoolSize,
                        serverSelectionTimeoutMS: this.connectionOptions.serverSelectionTimeoutMS
                    }
                }
            })
            throw err
        }
    }

    async _validateConnection() {
        const admin = mongoose.connection.db.admin()

        // Test basic connectivity
        await admin.ping()
        logger.info('MongoDB ping successful')

        // Check replica set status
        const status = await admin.replSetGetStatus().catch(() => null)

        if (status) {
            const primaryMember = status.members.find((m) => m.state === 1)
            const healthyMembers = status.members.filter((m) => m.health === 1)

            logger.info('Connected with replica set support', {
                meta: {
                    replicaSet: status.set,
                    primary: primaryMember?.name || 'Unknown',
                    totalMembers: status.members.length,
                    healthyMembers: healthyMembers.length
                }
            })

            // Validate replica set health
            if (healthyMembers.length === 0) {
                throw new Error('No healthy replica set members found')
            }
        } else {
            logger.warn('⚠️ Connected, but no replica set detected (no transaction support)', {
                meta: {
                    transactionSupport: false,
                    host: mongoose.connection.host,
                    port: mongoose.connection.port
                }
            })
        }
    }

    // Add a method to wait for connection
    async waitForConnection(timeoutMs = 30000) {
        const startTime = Date.now()

        logger.info('Waiting for MongoDB connection', {
            meta: {
                timeoutMs,
                currentState: this.connectionState
            }
        })

        while (!this.isConnected && Date.now() - startTime < timeoutMs) {
            if (this.connectionState === 'error') {
                const error = this.lastConnectionError || new Error('Connection failed')
                logger.error('Connection wait failed due to error state', {
                    meta: {
                        error: error.message,
                        waitTime: Date.now() - startTime
                    }
                })
                throw error
            }

            await new Promise((resolve) => setTimeout(resolve, 100))
        }

        if (!this.isConnected) {
            logger.error('Connection wait timeout exceeded', {
                meta: {
                    timeoutMs,
                    actualWaitTime: Date.now() - startTime,
                    finalState: this.connectionState
                }
            })
            throw new Error('Connection timeout')
        }

        logger.info('MongoDB connection established successfully', {
            meta: {
                waitTime: Date.now() - startTime,
                host: mongoose.connection.host,
                db: mongoose.connection.name
            }
        })

        return mongoose.connection
    }

    async handleReconnection() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            logger.error(' Max reconnection attempts reached', {
                meta: {
                    maxAttempts: this.maxReconnectAttempts,
                    totalAttempts: this.reconnectAttempts,
                    lastError: this.lastConnectionError?.message
                }
            })
            this.connectionState = 'error'
            return
        }

        this.reconnectAttempts++
        this.connectionState = 'connecting'

        // Exponential backoff for reconnection
        const backoffTime = this.reconnectInterval * Math.pow(2, this.reconnectAttempts - 1)
        const cappedBackoffTime = Math.min(backoffTime, 30000) // Cap at 30 seconds

        logger.info(` Scheduling reconnection attempt`, {
            meta: {
                attemptNumber: this.reconnectAttempts,
                maxAttempts: this.maxReconnectAttempts,
                backoffTimeMs: cappedBackoffTime,
                nextAttemptAt: new Date(Date.now() + cappedBackoffTime).toISOString()
            }
        })

        setTimeout(async () => {
            try {
                logger.info(`Executing reconnection attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts}`)
                await this.connect()
            } catch (err) {
                logger.error(' Reconnection attempt failed', {
                    meta: {
                        attemptNumber: this.reconnectAttempts,
                        message: err.message,
                        stack: err.stack
                    }
                })
                this.connectionState = 'error'
                this.lastConnectionError = err
            }
        }, cappedBackoffTime)
    }

    async gracefulShutdown() {
        logger.info(' Gracefully shutting down MongoDB connection...')
        try {
            if (mongoose.connection.readyState !== 0) {
                await mongoose.connection.close()
                logger.info('MongoDB connection closed successfully')
            } else {
                logger.info('MongoDB connection was already closed')
            }
            process.exit(0)
        } catch (err) {
            logger.error('Error during MongoDB shutdown', {
                meta: {
                    message: err.message,
                    stack: err.stack
                }
            })
            process.exit(1)
        }
    }

    async testTransactionSupport() {
        if (!this.isConnected) {
            logger.warn('Cannot test transaction support - not connected')
            return { success: false, message: 'Not connected' }
        }

        try {
            logger.info('Testing MongoDB transaction support...')
            const session = await mongoose.startSession()
            const testId = `test_${Date.now()}`
            const testCollection = mongoose.connection.db.collection('_tx_test')

            let results = {}

            await session.withTransaction(async () => {
                const insert = await testCollection.insertMany(
                    [
                        { testId, op: '1' },
                        { testId, op: '2' }
                    ],
                    { session }
                )

                const update = await testCollection.updateOne({ testId, op: '1' }, { $set: { updated: true } }, { session })

                const count = await testCollection.countDocuments({ testId }, { session })

                await testCollection.deleteMany({ testId }, { session })

                results = {
                    inserted: insert.insertedCount,
                    updated: update.modifiedCount,
                    count
                }
            })

            await session.endSession()

            logger.info('Transaction support test successful', {
                meta: { results }
            })

            return { success: true, message: 'Transaction succeeded', results }
        } catch (err) {
            logger.error('Transaction support test failed', {
                meta: {
                    message: err.message,
                    stack: err.stack
                }
            })
            return { success: false, message: 'Transaction failed', error: err.message }
        }
    }

    async getConnectionInfo() {
        try {
            if (!this.isConnected || mongoose.connection.readyState !== 1) {
                return {
                    connected: false,
                    message: 'Not connected',
                    readyState: mongoose.connection.readyState,
                    connectionState: this.connectionState
                }
            }

            const admin = mongoose.connection.db.admin()
            const [serverStatus, replSetStatus, dbStats] = await Promise.allSettled([
                admin.serverStatus(),
                admin.replSetGetStatus(),
                mongoose.connection.db.stats()
            ])

            const info = {
                connected: true,
                host: mongoose.connection.host,
                port: mongoose.connection.port,
                db: mongoose.connection.name,
                readyState: mongoose.connection.readyState,
                connectionState: this.connectionState,
                pool: {
                    min: this.connectionOptions.minPoolSize,
                    max: this.connectionOptions.maxPoolSize,
                    current: mongoose.connections.length
                },
                env: process.env.NODE_ENV || 'development'
            }

            if (serverStatus.status === 'fulfilled') {
                info.server = {
                    version: serverStatus.value.version,
                    uptime: serverStatus.value.uptime
                }
            }

            if (replSetStatus.status === 'fulfilled') {
                const rs = replSetStatus.value
                info.replicaSet = {
                    name: rs.set,
                    primary: rs.members.find((m) => m.state === 1)?.name,
                    members: rs.members.length,
                    healthy: rs.members.filter((m) => m.health === 1).length
                }
                info.transactionSupport = true
            } else {
                info.transactionSupport = false
            }

            if (dbStats.status === 'fulfilled') {
                info.databaseStats = {
                    collections: dbStats.value.collections,
                    dataSizeMB: Math.round((dbStats.value.dataSize / 1024 / 1024) * 100) / 100,
                    indexSizeMB: Math.round((dbStats.value.indexSize / 1024 / 1024) * 100) / 100
                }
            }

            return info
        } catch (err) {
            logger.error('Failed to get connection info', {
                meta: {
                    message: err.message,
                    stack: err.stack
                }
            })
            return { connected: false, error: err.message }
        }
    }

    // Improved health check with more details
    async healthCheck() {
        try {
            if (!this.isConnected) {
                return {
                    healthy: false,
                    reason: 'Not connected',
                    connectionState: this.connectionState,
                    lastError: this.lastConnectionError?.message
                }
            }

            // Test database ping
            await mongoose.connection.db.admin().ping()

            // Check connection pool
            const poolStats = {
                available: mongoose.connection.readyState === 1,
                readyState: mongoose.connection.readyState,
                host: mongoose.connection.host,
                port: mongoose.connection.port
            }

            return {
                healthy: true,
                timestamp: new Date().toISOString(),
                connectionState: this.connectionState,
                pool: poolStats
            }
        } catch (err) {
            logger.error('Health check failed', {
                meta: {
                    message: err.message,
                    connectionState: this.connectionState
                }
            })
            return {
                healthy: false,
                reason: err.message,
                connectionState: this.connectionState,
                timestamp: new Date().toISOString()
            }
        }
    }

    // Add method to check if ready for operations
    isReady() {
        const ready = this.isConnected && mongoose.connection.readyState === 1 && this.connectionState === 'connected'

        if (!ready) {
            logger.debug('Database not ready for operations', {
                meta: {
                    isConnected: this.isConnected,
                    readyState: mongoose.connection.readyState,
                    connectionState: this.connectionState
                }
            })
        }

        return ready
    }

    async getStats() {
        try {
            if (!this.isConnected) {
                return { error: 'Not connected to database' }
            }

            const stats = await mongoose.connection.db.stats()

            logger.info('Retrieved database statistics', {
                meta: {
                    collections: stats.collections,
                    objects: stats.objects,
                    dataSizeMB: Math.round((stats.dataSize / 1024 / 1024) * 100) / 100
                }
            })

            return {
                collections: stats.collections,
                objects: stats.objects,
                dataSize: stats.dataSize,
                storageSize: stats.storageSize,
                indexSize: stats.indexSize
            }
        } catch (err) {
            logger.error('Failed to get database statistics', {
                meta: {
                    message: err.message,
                    stack: err.stack
                }
            })
            return { error: err.message }
        }
    }
}

const databaseManager = new DatabaseManager()

// Enhanced export with additional utility methods
export default {
    connect: () => databaseManager.connect(),
    connectLocally: () => databaseManager.connectLocally(),
    waitForConnection: (timeout) => databaseManager.waitForConnection(timeout),
    testTransactionSupport: () => databaseManager.testTransactionSupport(),
    getConnectionInfo: () => databaseManager.getConnectionInfo(),
    healthCheck: () => databaseManager.healthCheck(),
    getStats: () => databaseManager.getStats(),
    isReady: () => databaseManager.isReady(),
    manager: databaseManager
}
