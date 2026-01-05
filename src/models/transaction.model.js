import mongoose from 'mongoose'

const transactionSchema = new mongoose.Schema(
    {
        userId: {
            type: mongoose.Schema.ObjectId,
            ref: 'User',
            required: true
        },
        type: {
            type: String,
            enum: ['credit', 'debit'],
            required: true
        },
        amount: {
            type: Number,
            required: true
        },
        transactionDate: {
            type: Date,
            default: Date.now
        },
        description: String,
        isPending: {
            type: Boolean,
            default: false
        },
        payoutId: String,
        orderId: {
            type: mongoose.Schema.ObjectId,
            ref: 'Order',
            required: true
        }
    },
    {
        timestamps: true // This will add createdAt and updatedAt automatically
    }
)

// Add indexes for better query performance
transactionSchema.index({ userId: 1, transactionDate: -1 })
transactionSchema.index({ orderId: 1 })

export const Transaction = mongoose.model('Transaction', transactionSchema)
