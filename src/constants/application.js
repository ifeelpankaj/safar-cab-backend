import config from '../config/config.js'

export const EApplicationEnvironment = {
    TESTING: 'testing',
    PRODUCTION: 'production',
    DEVELOPMENT: 'development',
    HYBRID_PAYMENT_PERCENTAGE: parseFloat(config.HYBRID_PAYMENT_PERCENTAGE) || 0.1,
    ORDER_EXPIRE_MINUTES: parseInt(config.ORDER_EXPIRE, 10) || 5,
    SITE_NAME: '4biddencoder', //TODO add a site name
    SITE_EMAIL: 'info@4biddencoder.tech' //TODO add a site email
}
