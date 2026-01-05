import dotenvFlow from 'dotenv-flow'

dotenvFlow.config()

export default {
    // General
    ENV: process.env.ENV,
    PORT: process.env.PORT,
    DB_URI: process.env.DATABASE_URI,
    DB_NAME: process.env.DATABASE_NAME,
    SESSION_SECRET: process.env.SESSION_SECRET,
    ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS,
    FROM_NAME: process.env.FROM_NAME,
    //auth
    OTP_LENGTH: process.env.OTP_LENGTH,
    OTP_EXPIRE: process.env.OTP_EXPIRE,

    //smtp
    SMTP_HOST: process.env.SMTP_HOST,
    SMTP_PORT: process.env.SMTP_PORT,
    SMTP_USER: process.env.SMTP_USER,
    SMTP_PASS: process.env.SMTP_PASS,

    JWT_COOKIE_EXPIRE: process.env.JWT_COOKIE_EXPIRE,
    JWT_SECRET: process.env.JWT_SECRET,

    //cloudinary configuration
    CLOUDINARY_NAME: process.env.CLOUDINARY_NAME,
    CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET,
    CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY,

    //razorpay configuration
    RAZORPAY_API_KEY: process.env.RAZORPAY_API_KEY,
    RAZORPAY_API_SECRET: process.env.RAZORPAY_API_SECRET,
    RAZORPAY_ACCOUNT_NUMBER: process.env.RAZORPAY_ACCOUNT_NUMBER,

    //google map api key
    GOOGLE_MAPS_API_KEY: process.env.GOOGLE_MAPS_API_KEY,

    //order
    HYBRID_PAYMENT_PERCENTAGE: process.env.HYBRID_PAYMENT_PERCENTAGE,

    //cab-rate
    TWO_SEATER_RATE: process.env.TWO_SEATER_RATE,
    THREE_SEATER_RATE: process.env.THREE_SEATER_RATE,
    FOUR_SEATER_RATE: process.env.FOUR_SEATER_RATE,
    FIVE_SEATER_RATE: process.env.FIVE_SEATER_RATE,
    SIX_SEATER_RATE: process.env.SIX_SEATER_RATE,
    SEVEN_SEATER_RATE: process.env.SEVEN_SEATER_RATE,

    //RATE
    NIGHT_CHARGE: process.env.NIGHT_CHARGE,
    TOLL_TAX: process.env.TOLL_TAX
}
