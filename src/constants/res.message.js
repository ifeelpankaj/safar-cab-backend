export const generic_msg = {
    email_sending_failed: (email) => `Failed to send email to ${email}. Please try again later.`,
    email_sending_success: (email) => `Email has been sent successfully to ${email}`,
    operation_success: (name) => `${name} Success! Your request was completed without a hitch.`,
    operation_failed: (name) => `${name} Failed! Sorry we are unable to complete your request`,
    resource_not_found: (entity) => `Sorry we are unable to found this ${entity} in our system.Please check and try again.`,
    too_many_attempts: (entity) => `Too many incorrect ${entity} attempts. Please try again after sometime.`,
    invalid_input: (entity) => `${entity} is not valid. kindly check your ${entity} and resubmit.`,
    resource_update_success: (entity) => ` ${entity} updated successfully. You’re all set!`,
    unauthorized_access: `Permission Denied`,
    file_uploading_error: `Cannot able to upload your files`,
    too_manay_request: ` Too many requests in a short time. Please slow down and try again later.`,
    something_went_wrong: `Opps! Something went wrong`
}
export const user_msg = {
    user_already_register: `This account is already registered. Please log in.`,
    error_generating_otp: `There is some error generating otp. Kindly try after sometime.`,
    incorrect_otp: (attempts) => ` Incorrect OTP. You have ${attempts} attempts left.`,
    opt_expire: `OTP expired. Request a new one.`,
    account_verified: `Your account has been verified! Let’s get started.`,
    auth_failed: `Incorrect email or password. Please try again.`,
    login_success: `Welcome back! You’ve logged in successfully.`,
    logout_success: `You’ve logged out. We look forward to seeing you again.`,
    password_change_success: `Password changed. Security first!`,
    token_created: (userId) => `🔑 Token generated for user: ${userId}.`,
    token_invalid: `Invalid token. Please log in again.`,
    token_expired: `Token expired. Please log in again.`,
    invalid_request: `Invalid request. Please review and try again.`
}

export const cab_msg = {}
export const order_msg = {
    payment_verification_success: `Payment successfully verified.`,
    payment_verification_fail: (orderId) =>
        `Payment verification failed for order ${orderId}. If charged, your amount will be refunded within 2-3 business days.`
}
export const driver_msg = {
    doc_upload_success: ' Documents uploaded successfully.', // 200
    doc_upload_failure: ' Document upload failed. Please try again.', // 500
    invalid_doc_format: ' Unsupported file format. Only JPEG, PNG, and PDF are allowed.', // 400
    doc_too_large: 'Document size exceeds the maximum limit of 5MB.', // 400
    invalid_bank_details: 'Invalid bank details',
    missing_bank_details: 'Bank details are missing',
    verification_complete: 'Driver is verified and now we can assign bookings to this driver.',
    verification_revoked: 'Driver verification has been revoked you cannot assign his booking untill he is verified.'
}
