import httpResponse from '../utils/httpResponse.js'
import { generic_msg } from '../constants/res.message.js'
import httpError from '../utils/httpError.js'
import { getApplicationHealth, getSystemHealth } from '../utils/quicker.js'

import CustomError from '../utils/customeError.js'
import config from '../config/config.js'
import logger from '../utils/logger.js'
import axios from 'axios'
import { calculateRate } from '../services/rate.service.js'

export default {
    self: (req, res, next) => {
        try {
            httpResponse(req, res, 200, generic_msg.operation_success('Get system info '), null, null)
        } catch (err) {
            httpError('SELF', next, err, req, 500)
        }
    },
    health: (req, res, next) => {
        try {
            const healthData = {
                application: getApplicationHealth(),
                system: getSystemHealth(),
                timestamp: Date.now()
            }

            httpResponse(req, res, 200, generic_msg.operation_success('Get system health'), healthData)
        } catch (err) {
            httpError('HEALTH', next, err, req, 500)
        }
    },
    calculateDistance: async (req, res, next) => {
        try {
            const { origin, destination, startDate } = req.query
            let route_distance = null
            let route_duration = null

            if (!origin || !destination || !startDate) {
                throw new CustomError(generic_msg.invalid_input('Origin , destination & datetime'))
            }
            const apiKey = config.GOOGLE_MAPS_API_KEY

            if (!apiKey) {
                logger.error('Google Maps API key is missing from environment variables')
                throw new CustomError(generic_msg.something_went_wrong)
            }
            const response = await axios.get('https://maps.googleapis.com/maps/api/distancematrix/json', {
                params: {
                    origins: origin,
                    destinations: destination,
                    key: apiKey
                }
            })
            const { data } = response
            if (data.status === 'OK' && data.rows[0]?.elements[0]?.status === 'OK') {
                const distance = data.rows[0].elements[0].distance.text
                const duration = data.rows[0].elements[0].duration.text
                route_distance = distance
                route_duration = duration
            } else {
                // Handle case where Google API responds with non-OK status
                logger.warn('Unable to calculate distance: Invalid API response', { origin, destination, data })
                throw new CustomError('Unable to calculate distance', 400)
            }

            const res_data = await calculateRate(route_distance, route_duration, startDate)
            return httpResponse(req, res, 200, 'Distance and duration calculated successfully', res_data, null)
        } catch (error) {
            return httpError('CALCULATE DISTANCE & RATE', next, error, req, 500)
        }
    }
}
