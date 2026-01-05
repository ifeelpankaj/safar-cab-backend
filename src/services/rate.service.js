import config from '../config/config.js'

export const calculateRate = async (distance, duration, startDateTime) => {
    function parseDistance(distanceInput) {
        if (typeof distanceInput === 'number') {
            return distanceInput
        }
        const distanceStr = distanceInput.toString().toLowerCase()
        const match = distanceStr.match(/(\d+(?:\.\d+)?)/)
        return match ? parseFloat(match[1]) : 0
    }

    // Parse duration from various formats
    function parseDurationToHours(durationStr) {
        const str = durationStr.toLowerCase().trim()
        let totalHours = 0

        // Extract numbers and units
        const patterns = [
            { regex: /(\d+(?:\.\d+)?)\s*(?:days?|d)\b/g, multiplier: 24 },
            { regex: /(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b/g, multiplier: 1 },
            { regex: /(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|m)\b/g, multiplier: 1 / 60 }
        ]

        patterns.forEach((pattern) => {
            let match
            while ((match = pattern.regex.exec(str)) !== null) {
                totalHours += parseFloat(match[1]) * pattern.multiplier
            }
        })

        // If no pattern matched, try to extract just the first number and assume hours
        if (totalHours === 0) {
            const numberMatch = str.match(/(\d+(?:\.\d+)?)/)
            if (numberMatch) {
                totalHours = parseFloat(numberMatch[1])
            }
        }

        return totalHours
    }

    const parsedDistance = parseDistance(distance)
    const durationHours = parseDurationToHours(duration)

    // Convert start time to India timezone
    const startTime = new Date(startDateTime)
    const indiaStartTime = new Date(
        startTime.toLocaleString('en-US', {
            timeZone: 'Asia/Kolkata'
        })
    )

    // Calculate end time
    const endTime = new Date(indiaStartTime.getTime() + durationHours * 60 * 60 * 1000)

    // Night time is from 10 PM to 6 AM (22:00 to 06:00)
    function isNightHour(hour) {
        return hour >= 22 || hour < 6
    }

    // Calculate what portion of the journey is during night time
    let nightHours = 0
    const totalHours = durationHours

    // Check each hour of the journey
    for (let i = 0; i < Math.ceil(durationHours * 4); i++) {
        // Check every 15 minutes
        const checkTime = new Date(indiaStartTime.getTime() + i * 15 * 60 * 1000)
        const hour = checkTime.getHours()

        if (isNightHour(hour)) {
            nightHours += 0.25 // 15 minutes = 0.25 hours
        }

        // Stop when we've covered the full duration
        if ((i + 1) * 0.25 >= durationHours) {
            if (durationHours % 0.25 !== 0) {
                // Adjust the last partial interval
                const lastInterval = durationHours % 0.25
                if (isNightHour(hour)) {
                    nightHours = nightHours - 0.25 + lastInterval
                }
            }
            break
        }
    }

    // Calculate distance covered during night time
    const nightDistance = (nightHours / totalHours) * parsedDistance

    // Calculate night charge: Rs 125 per 40 km (only for night portion)
    const nightCharge = nightHours > 0 ? nightHours * Number(config.NIGHT_CHARGE) : 0

    // Calculate toll tax: Rs 25 per 50 km (always applies for total distance)
    const tollTax = Math.ceil(parsedDistance / 50) * Number(config.TOLL_TAX)

    return {
        distance,
        parsedDistance,
        duration,
        startDateTime,
        endDateTime: endTime.toLocaleString(),
        indiaStartTime: indiaStartTime.toLocaleString(),
        indiaEndTime: endTime.toLocaleString(),
        totalHours,
        nightDistance: parseFloat(nightDistance.toFixed(2)),
        dayDistance: parseFloat((parsedDistance - nightDistance).toFixed(2)),
        nightCharge: Math.round(nightCharge),
        tollTax,
        totalCharges: Math.round(nightCharge + tollTax),
        breakdown: {
            nightPercentage: `${parseFloat(((nightHours / totalHours) * 100).toFixed(1))}%`,
            dayPercentage: `${parseFloat((((totalHours - nightHours) / totalHours) * 100).toFixed(1))}%`
        }
    }
}
