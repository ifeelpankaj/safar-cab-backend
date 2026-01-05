import fs from 'fs'
import { generic_msg } from '../constants/res.message.js'
import CustomError from '../utils/customeError.js'
import cloudinary from '../config/cloudinary.js'
import logger from '../utils/logger.js'
import { User } from '../models/user.model.js'
import { Cab } from '../models/cab.model.js'
import { sendMailWithRetry } from '../services/email.service.js'
import { cab_emails } from '../constants/emails.js'
import httpResponse from '../utils/httpResponse.js'
import httpError from '../utils/httpError.js'

import config from '../config/config.js'
import mongoose from 'mongoose'

//New One
export const registerCabWithManulRollback = async (req, res, next) => {
    const tmpDir = './tmp'
    let uploadedImages = [] // Track uploaded images for rollback
    let createdCab = null // Track created cab for rollback
    let originalUserState = null // Track original user state
    let user = null // Define user in outer scope

    try {
        // Check if the user is either a driver or an admin
        if (req.user.role !== 'Driver' && req.user.role !== 'Admin') {
            throw new CustomError(generic_msg.unauthorized_access, 403)
        }

        // Ensure the tmp directory exists
        await fs.promises.mkdir(tmpDir, { recursive: true }).catch((error) => {
            logger.error(`Failed to create temp directory:`, { meta: { error } })
            throw new CustomError('Failed to create temp directory', 500)
        })

        // Find user and store original state
        user = await User.findById(req.user._id)
        if (!user) {
            throw new CustomError(generic_msg.resource_not_found('User'), 404)
        }

        // Store original user state for potential rollback
        originalUserState = {
            haveCab: user.haveCab
        }

        // Handle image uploads
        if (req.files && req.files.photos) {
            const photos = Array.isArray(req.files.photos) ? req.files.photos : [req.files.photos]

            const imagePromises = photos.map(async (image) => {
                try {
                    const myCloud = await cloudinary.v2.uploader.upload(image.tempFilePath, {
                        folder: 'TandT/Cars',
                        resource_type: 'image'
                    })

                    // Track uploaded image for potential rollback
                    const imageData = {
                        public_id: myCloud.public_id,
                        url: myCloud.secure_url
                    }
                    uploadedImages.push(myCloud.public_id) // Store public_id for cleanup

                    // Clean up temp file
                    try {
                        fs.unlinkSync(image.tempFilePath)
                    } catch (unlinkError) {
                        logger.warn(`Failed to delete temp file: ${image.tempFilePath}`, unlinkError)
                    }

                    return imageData
                } catch (uploadError) {
                    logger.error(`Cloudinary Error: Failed to upload image ${image.name}:`, { meta: { error: uploadError } })
                    throw new CustomError(generic_msg.file_uploading_error, 500)
                }
            })

            uploadedImages = await Promise.all(imagePromises)
        } else {
            throw new CustomError(generic_msg.invalid_input('Cab data'), 400)
        }
        let rate = 0
        const capacity = req.body.capacity.toString() // Ensure string comparison

        switch (capacity) {
            case '2':
                rate = Number(config.TWO_SEATER_RATE)
                break
            case '3':
                rate = Number(config.THREE_SEATER_RATE)
                break
            case '4':
                rate = Number(config.FOUR_SEATER_RATE)
                break
            case '5':
                rate = Number(config.FIVE_SEATER_RATE)
                break
            case '6':
                rate = Number(config.SIX_SEATER_RATE)
                break
            case '7':
                rate = Number(config.SEVEN_SEATER_RATE)
                break
            default:
                rate = 0
        }
        // Prepare cab data
        const carData = {
            modelName: req.body.modelName,
            feature: req.body.feature,
            capacity: req.body.capacity,
            belongsTo: req.user._id,
            cabNumber: req.body.cabNumber,
            rate,
            photos: uploadedImages.map((img) => ({
                public_id: img.public_id,
                url: img.url
            }))
        }

        // Create cab
        const cabArray = await Cab.create([carData])
        createdCab = cabArray[0] // Store reference for potential rollback

        // Update user's haveCab field
        user.haveCab = true
        await user.save()

        // Remove tmp directory after successful operations
        await fs.promises.rm(tmpDir, { recursive: true }).catch((error) => {
            logger.error(`Failed to remove temp directory:`, { meta: { error } })
        })

        // Send email notification (non-blocking)
        try {
            await sendMailWithRetry(user.email, cab_emails.cab_register_email_subject, cab_emails.cab_registration_email_success(user.username))
        } catch (emailError) {
            logger.error(generic_msg.email_sending_failed(user.email), { meta: { error: emailError } })
        }

        // Invalidate cache keys
        // Cachestorage.del(['all_cabs', 'all_cabs_user', 'driver_cabs']);

        httpResponse(req, res, 201, generic_msg.operation_success('Cab Registration'), createdCab, null)
    } catch (error) {
        // Manual rollback on error
        try {
            // Delete created cab if it exists
            if (createdCab && createdCab._id) {
                await Cab.findByIdAndDelete(createdCab._id).catch((deleteError) =>
                    logger.error('Failed to delete created cab during rollback:', deleteError)
                )
            }

            // Restore user's original state if user exists and was modified
            if (user && originalUserState) {
                user.haveCab = originalUserState.haveCab
                await user.save().catch((userError) => logger.error('Failed to restore user state during rollback:', userError))
            }

            // Delete uploaded images from Cloudinary
            if (uploadedImages.length > 0) {
                await Promise.all(
                    uploadedImages.map((publicId) =>
                        cloudinary.v2.uploader
                            .destroy(publicId)
                            .catch((deleteError) => logger.error('Failed to delete uploaded image during rollback:', deleteError))
                    )
                )
            }
        } catch (rollbackError) {
            logger.error('Rollback failed:', rollbackError)
        }

        logger.error(generic_msg.operation_failed('Cab registration'), { meta: { error } })
        httpError('CAB REGISTRATION', next, error, req, 500)
    } finally {
        // Clean up temp directory
        if (fs.existsSync(tmpDir)) {
            await fs.promises.rm(tmpDir, { recursive: true }).catch((error) => logger.error('Failed to clean up temp directory:', error))
        }
    }
}

export const updateCabWithManualRollback = async (req, res, next) => {
    const tmpDir = './tmp'

    // Store rollback data
    const rollbackData = {
        originalCab: null,
        deletedImages: [],
        uploadedImages: [],
        needsRollback: false
    }

    try {
        // Check if the user is either a driver or an admin
        if (req.user.role !== 'Driver' && req.user.role !== 'Admin') {
            throw new CustomError(generic_msg.unauthorized_access, 403)
        }

        const cabId = req.params.id
        const cab = await Cab.findById(cabId)

        // Check if the cab exists
        if (!cab) {
            throw new CustomError(generic_msg.resource_not_found('Cab'), 404)
        }

        // Store original cab data for rollback
        rollbackData.originalCab = {
            _id: cab._id,
            modelName: cab.modelName,
            feature: cab.feature,
            capacity: cab.capacity,
            cabNumber: cab.cabNumber,
            photos: [...cab.photos], // Create a copy of photos array
            rate: cab.rate
        }

        // Check if the user is the owner of the cab OR is an admin
        if (cab.belongsTo.toString() !== req.user._id.toString() && req.user.role !== 'Admin') {
            throw new CustomError(generic_msg.unauthorized_access, 403)
        }

        // Ensure the tmp directory exists
        await fs.promises.mkdir(tmpDir, { recursive: true }).catch((error) => {
            logger.error(`Failed to create temp directory:`, { meta: { error } })
            throw new CustomError('Failed to create temp directory', 500)
        })

        let uploadedImages = []

        if (req.files && req.files.photos) {
            const photos = Array.isArray(req.files.photos) ? req.files.photos : [req.files.photos]

            // Store original images for potential rollback
            rollbackData.deletedImages = [...cab.photos]
            rollbackData.needsRollback = true

            // Delete existing images from Cloudinary
            const destroyPromises = cab.photos.map((photo) => cloudinary.v2.uploader.destroy(photo.public_id))
            await Promise.all(destroyPromises)

            try {
                // Upload new images to Cloudinary
                const imagePromises = photos.map(async (image) => {
                    const myCloud = await cloudinary.v2.uploader.upload(image.tempFilePath, {
                        folder: 'TandT/Cars',
                        resource_type: 'image'
                    })

                    return {
                        public_id: myCloud.public_id,
                        url: myCloud.secure_url
                    }
                })

                uploadedImages = await Promise.all(imagePromises)
                rollbackData.uploadedImages = [...uploadedImages]
            } catch (uploadError) {
                // If upload fails, try to restore original images
                logger.error('Image upload failed, attempting rollback:', { meta: { uploadError } })
                await rollbackImages(rollbackData)
                throw uploadError
            }
        } else {
            // If no new images are provided, retain the old ones
            uploadedImages = cab.photos
        }

        // Construct the updated cab data
        const cabData = {
            modelName: req.body.modelName || cab.modelName,
            feature: req.body.feature || cab.feature,
            capacity: req.body.capacity || cab.capacity,
            cabNumber: req.body.cabNumber || cab.cabNumber,
            photos: uploadedImages
        }

        // Only admin can update rate
        if (req.user.role === 'Admin') {
            cabData.rate = req.body.rate !== undefined ? req.body.rate : cab.rate
        }

        // Update the cab
        const updatedCab = await Cab.findByIdAndUpdate(cabId, cabData, {
            new: true,
            runValidators: true
        })

        if (!updatedCab) {
            // If update fails, rollback images
            await rollbackImages(rollbackData)
            throw new CustomError('Failed to update cab', 500)
        }

        // Remove tmp directory after successful operation
        await fs.promises.rm(tmpDir, { recursive: true }).catch((error) => {
            logger.error(`Failed to remove temp directory:`, { meta: { error } })
        })

        httpResponse(req, res, 200, generic_msg.operation_success('Cab Update'), updatedCab, null)
    } catch (error) {
        // Manual rollback on error
        if (rollbackData.needsRollback) {
            await performManualRollback(rollbackData)
        }

        httpError('UPDATE CAB', next, error, req, 500)
    } finally {
        // Cleanup tmp directory
        if (fs.existsSync(tmpDir)) {
            await fs.promises.rm(tmpDir, { recursive: true }).catch((error) => {
                logger.error(`Failed to cleanup temp directory:`, { meta: { error } })
            })
        }
    }
}

// Helper function to perform complete manual rollback
async function performManualRollback(rollbackData) {
    try {
        logger.info('Performing manual rollback...')

        // Rollback database changes
        if (rollbackData.originalCab) {
            await Cab.findByIdAndUpdate(rollbackData.originalCab._id, {
                modelName: rollbackData.originalCab.modelName,
                feature: rollbackData.originalCab.feature,
                capacity: rollbackData.originalCab.capacity,
                cabNumber: rollbackData.originalCab.cabNumber,
                photos: rollbackData.originalCab.photos,
                rate: rollbackData.originalCab.rate
            })
        }

        // Rollback image changes
        await rollbackImages(rollbackData)

        logger.info('Manual rollback completed')
    } catch (rollbackError) {
        logger.error('Manual rollback failed:', { meta: { rollbackError } })
        // In a production environment, you might want to send alerts here
        // or add the failed rollback to a queue for manual intervention
    }
}

export const getSingleCabs = async (req, res, next) => {
    try {
        const { id } = req.params

        // Ensure the ID is provided
        if (!id) {
            throw new CustomError(generic_msg.invalid_input('ID'), 400)
        }
        const cab = await Cab.findById(id).lean().populate('belongsTo', 'username role')
        if (!cab) {
            throw new CustomError(generic_msg.resource_not_found('Cab'), 404)
        }

        // Return the response with the data
        return httpResponse(req, res, 200, generic_msg.operation_success('Get Single Cab'), cab, null)
    } catch (error) {
        return httpError('GET SINGLE CAB', next, error, req, 500)
    }
}

export const makeCabReady = async (req, res, next) => {
    try {
        const { id: cabId } = req.params

        // Validate input
        if (!cabId) {
            return next(new CustomError(generic_msg.invalid_input('ID'), 400))
        }

        // Authorization check (only Admin allowed)
        if (req.user.role !== 'Admin') {
            return next(new CustomError(generic_msg.unauthorized_access, 403))
        }

        // Find the cab first
        const cab = await Cab.findById(cabId)
        if (!cab) {
            return next(new CustomError(generic_msg.resource_not_found('Cab'), 404))
        }

        // Toggle isReady status automatically
        const updatedCab = await Cab.findByIdAndUpdate(cabId, { isReady: !cab.isReady }, { new: true, runValidators: true })

        // Generate professional message based on new status
        const message = updatedCab.isReady
            ? 'Cab has been successfully activated and is now visible to users for booking.'
            : 'Cab has been successfully deactivated and is now hidden from user display.'

        return httpResponse(req, res, 200, message, updatedCab, null)
    } catch (error) {
        return httpError('MAKE CAB READY', next, error, req, 500)
    }
}

export const getRateDefinedCab = async (req, res, next) => {
    try {
        // If not in cache, fetch from database
        const cabs = await Cab.find({ isReady: true }).populate('belongsTo', 'username role').select('-__v')

        if (cabs.length === 0) {
            throw new CustomError(generic_msg.resource_not_found('Cab'), 404)
        }

        // Return the response with the data
        httpResponse(req, res, 200, generic_msg.operation_success('Get Display Cab'), cabs, null)
    } catch (error) {
        httpError('GET RATE DEFINED CABS', next, error, req, 500)
    }
}

//New  with transaction enable
export const registerCabWithTransaction = async (req, res, next) => {
    const tmpDir = './tmp'
    let uploadedImages = [] // Track uploaded images for rollback
    let session = null

    try {
        // Check if the user is either a driver or an admin
        if (req.user.role !== 'Driver' && req.user.role !== 'Admin') {
            throw new CustomError(generic_msg.unauthorized_access, 403)
        }

        // Ensure the tmp directory exists
        await fs.promises.mkdir(tmpDir, { recursive: true }).catch((error) => {
            logger.error(`Failed to create temp directory:`, { meta: { error } })
            throw new CustomError('Failed to create temp directory', 500)
        })

        // Handle image uploads first (before transaction)
        if (req.files && req.files.photos) {
            const photos = Array.isArray(req.files.photos) ? req.files.photos : [req.files.photos]

            const imagePromises = photos.map(async (image) => {
                try {
                    const myCloud = await cloudinary.v2.uploader.upload(image.tempFilePath, {
                        folder: 'TandT/Cars',
                        resource_type: 'image'
                    })

                    // Track uploaded image for potential rollback
                    const imageData = {
                        public_id: myCloud.public_id,
                        url: myCloud.secure_url
                    }
                    uploadedImages.push(myCloud.public_id) // Store public_id for cleanup

                    // Clean up temp file
                    try {
                        fs.unlinkSync(image.tempFilePath)
                    } catch (unlinkError) {
                        logger.warn(`Failed to delete temp file: ${image.tempFilePath}`, unlinkError)
                    }

                    return imageData
                } catch (uploadError) {
                    logger.error(`Cloudinary Error: Failed to upload image ${image.name}:`, { meta: { error: uploadError } })
                    throw new CustomError(generic_msg.file_uploading_error, 500)
                }
            })

            uploadedImages = await Promise.all(imagePromises)
        } else {
            throw new CustomError(generic_msg.invalid_input('Cab data'), 400)
        }

        // Calculate rate based on capacity
        let rate = 0
        const capacity = req.body.capacity.toString() // Ensure string comparison

        switch (capacity) {
            case '2':
                rate = Number(config.TWO_SEATER_RATE)
                break
            case '3':
                rate = Number(config.THREE_SEATER_RATE)
                break
            case '4':
                rate = Number(config.FOUR_SEATER_RATE)
                break
            case '5':
                rate = Number(config.FIVE_SEATER_RATE)
                break
            case '6':
                rate = Number(config.SIX_SEATER_RATE)
                break
            case '7':
                rate = Number(config.SEVEN_SEATER_RATE)
                break
            default:
                rate = 0
        }

        // Start database transaction
        session = await mongoose.startSession()

        let createdCab = null
        let user = null

        await session.withTransaction(
            async () => {
                // Find user within transaction
                user = await User.findById(req.user._id).session(session)
                if (!user) {
                    throw new CustomError(generic_msg.resource_not_found('User'), 404)
                }

                // Check if user already has a cab

                if (user.haveCab && req.user.role !== 'Admin') {
                    throw new CustomError('User already has a registered cab', 400)
                }

                // Prepare cab data
                const carData = {
                    modelName: req.body.modelName,
                    feature: req.body.feature,
                    capacity: req.body.capacity,
                    belongsTo: req.user._id,
                    cabNumber: req.body.cabNumber,
                    rate,
                    photos: uploadedImages.map((img) => ({
                        public_id: img.public_id,
                        url: img.url
                    }))
                }

                // Create cab within transaction
                const cabArray = await Cab.create([carData], { session })
                createdCab = cabArray[0]

                // Update user's haveCab field within transaction
                user.haveCab = true
                await user.save({ session })

                // If we reach here, transaction will be committed automatically
            },
            {
                // Transaction options
                readPreference: 'primary',
                readConcern: { level: 'local' },
                writeConcern: { w: 'majority' }
            }
        )

        // Remove tmp directory after successful operations
        await fs.promises.rm(tmpDir, { recursive: true }).catch((error) => {
            logger.error(`Failed to remove temp directory:`, { meta: { error } })
        })

        // Send email notification (non-blocking, after transaction)
        try {
            // @ts-ignore
            await sendMailWithRetry(user.email, cab_emails.cab_register_email_subject, cab_emails.cab_registration_email_success(user.username))
        } catch (emailError) {
            // @ts-ignore
            logger.error(generic_msg.email_sending_failed(user.email), { meta: { error: emailError } })
        }

        // Invalidate cache keys
        // Cachestorage.del(['all_cabs', 'all_cabs_user', 'driver_cabs']);

        httpResponse(req, res, 201, generic_msg.operation_success('Cab Registration'), createdCab, null)
    } catch (error) {
        // If transaction fails, MongoDB automatically rolls back database changes
        // We only need to clean up external resources (uploaded images)

        // Delete uploaded images from Cloudinary
        if (uploadedImages.length > 0) {
            try {
                await Promise.all(
                    uploadedImages.map((publicId) =>
                        cloudinary.v2.uploader
                            .destroy(publicId)
                            .catch((deleteError) => logger.error('Failed to delete uploaded image during rollback:', deleteError))
                    )
                )
            } catch (rollbackError) {
                logger.error('Image cleanup failed:', rollbackError)
            }
        }

        logger.error(generic_msg.operation_failed('Cab registration'), { meta: { error } })
        httpError('CAB REGISTRATION', next, error, req, 500)
    } finally {
        // End session
        if (session) {
            await session.endSession()
        }

        // Clean up temp directory
        if (fs.existsSync(tmpDir)) {
            await fs.promises.rm(tmpDir, { recursive: true }).catch((error) => logger.error('Failed to clean up temp directory:', error))
        }
    }
}

export const updateCabWithTransaction = async (req, res, next) => {
    const tmpDir = './tmp'

    // Store image rollback data (still needed for Cloudinary operations)
    const imageRollbackData = {
        deletedImages: [],
        uploadedImages: [],
        needsImageRollback: false
    }

    // Start a MongoDB session for transaction
    const session = await mongoose.startSession()

    try {
        // Check if the user is either a driver or an admin
        if (req.user.role !== 'Driver' && req.user.role !== 'Admin') {
            throw new CustomError(generic_msg.unauthorized_access, 403)
        }

        const cabId = req.params.id

        // Start transaction
        await session.withTransaction(async () => {
            // Find cab within transaction
            const cab = await Cab.findById(cabId).session(session)

            // Check if the cab exists
            if (!cab) {
                throw new CustomError(generic_msg.resource_not_found('Cab'), 404)
            }

            // Check if the user is the owner of the cab OR is an admin
            if (cab.belongsTo.toString() !== req.user._id.toString() && req.user.role !== 'Admin') {
                throw new CustomError(generic_msg.unauthorized_access, 403)
            }

            // Ensure the tmp directory exists
            await fs.promises.mkdir(tmpDir, { recursive: true }).catch((error) => {
                logger.error(`Failed to create temp directory:`, { meta: { error } })
                throw new CustomError('Failed to create temp directory', 500)
            })

            let uploadedImages = []

            if (req.files && req.files.photos) {
                const photos = Array.isArray(req.files.photos) ? req.files.photos : [req.files.photos]

                // Store original images for potential rollback (Cloudinary only)
                // Deep copy to avoid any reference issues
                imageRollbackData.deletedImages = cab.photos.map((photo) => ({
                    public_id: photo.public_id,
                    url: photo.url
                }))
                imageRollbackData.needsImageRollback = true

                // Delete existing images from Cloudinary
                const destroyPromises = cab.photos.map((photo) => cloudinary.v2.uploader.destroy(photo.public_id))
                await Promise.all(destroyPromises)

                try {
                    // Upload new images to Cloudinary
                    const imagePromises = photos.map(async (image) => {
                        const myCloud = await cloudinary.v2.uploader.upload(image.tempFilePath, {
                            folder: 'TandT/Cars',
                            resource_type: 'image'
                        })

                        return {
                            public_id: myCloud.public_id,
                            url: myCloud.secure_url
                        }
                    })

                    uploadedImages = await Promise.all(imagePromises)
                    imageRollbackData.uploadedImages = [...uploadedImages]
                } catch (uploadError) {
                    // If upload fails, try to restore original images
                    logger.error('Image upload failed, attempting image rollback:', { meta: { uploadError } })
                    await rollbackImages(imageRollbackData)
                    throw uploadError
                }
            } else {
                // If no new images are provided, retain the old ones
                uploadedImages = cab.photos
            }

            // Construct the updated cab data
            const cabData = {
                modelName: req.body.modelName || cab.modelName,
                feature: req.body.feature || cab.feature,
                capacity: req.body.capacity || cab.capacity,
                cabNumber: req.body.cabNumber || cab.cabNumber,
                photos: uploadedImages
            }

            // Only admin can update rate
            if (req.user.role === 'Admin') {
                cabData.rate = req.body.rate !== undefined ? req.body.rate : cab.rate
            }

            // Update the cab within transaction
            const updatedCab = await Cab.findByIdAndUpdate(cabId, cabData, {
                new: true,
                runValidators: true,
                session
            })

            if (!updatedCab) {
                throw new CustomError('Failed to update cab', 500)
            }

            // Store the updated cab for response (will be available after transaction commits)
            req.updatedCab = updatedCab
        })

        // Transaction completed successfully
        // Remove tmp directory after successful operation
        await fs.promises.rm(tmpDir, { recursive: true }).catch((error) => {
            logger.error(`Failed to remove temp directory:`, { meta: { error } })
        })

        httpResponse(req, res, 200, generic_msg.operation_success('Cab Update'), req.updatedCab, null)
    } catch (error) {
        // Only rollback images if needed (database will be automatically rolled back by transaction)
        if (imageRollbackData.needsImageRollback) {
            await rollbackImages(imageRollbackData)
        }

        httpError('UPDATE CAB', next, error, req, 500)
    } finally {
        // End the session
        await session.endSession()

        // Cleanup tmp directory
        if (fs.existsSync(tmpDir)) {
            await fs.promises.rm(tmpDir, { recursive: true }).catch((error) => {
                logger.error(`Failed to cleanup temp directory:`, { meta: { error } })
            })
        }
    }
}

// Simplified helper function - only handles Cloudinary image rollback
async function rollbackImages(imageRollbackData) {
    try {
        // Delete newly uploaded images from Cloudinary
        if (imageRollbackData.uploadedImages.length > 0) {
            const deletePromises = imageRollbackData.uploadedImages.map((image) => cloudinary.v2.uploader.destroy(image.public_id))
            await Promise.all(deletePromises)
        }

        // Note: We cannot restore the originally deleted images from Cloudinary
        // as they are permanently deleted. Consider implementing a backup strategy
        // or using a soft delete mechanism for critical applications

        logger.warn('Images rollback completed. Original images cannot be restored from Cloudinary.')
    } catch (rollbackError) {
        logger.error('Failed to rollback images:', { meta: { rollbackError } })
    }
}

export const getDriverCab = async (req, res, next) => {
    try {
        if (req.user.role !== 'Driver' && req.user.role !== 'Admin') {
            throw new CustomError(generic_msg.unauthorized_access, 403)
        }

        const cab = await Cab.find({ belongsTo: req.user._id }).lean()

        if (!cab || cab.length === 0) {
            throw new CustomError(generic_msg.resource_not_found('User cab'), 404)
        }

        httpResponse(req, res, 200, generic_msg.operation_success('Cab found'), cab)
    } catch (error) {
        httpError('Get Driver Cab', next, error, req, 500)
    }
}
