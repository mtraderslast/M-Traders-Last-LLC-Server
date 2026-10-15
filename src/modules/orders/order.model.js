import mongoose from 'mongoose';

const orderSchema = new mongoose.Schema(
    {
        orderId: { type: String, required: true, unique: true },
        packageId: { type: mongoose.Schema.Types.ObjectId, ref: 'Package', required: true },
        title: { type: String, required: true },
        image: { type: String },
        category: { type: String, default: 'General' },
        price: { type: Number, required: true },
        deliveryTime: { type: String },
        deliveryDate: { type: Date },
        userId: { type: String, default: null },
        userName: { type: String, default: 'Customer' },
        userEmail: { type: String, default: '' },
        status: {
            type: String,
            enum: ['pending', 'processing', 'completed', 'cancelled'],
            default: 'pending'
        },
        paymentStatus: {
            type: String,
            enum: ['pending', 'paid', 'failed'],
            default: 'pending'
        },
        paymentGateway: { type: String, default: 'allpaypayz' },
        gatewayOrderId: { type: String, default: '' },
        paymentEventId: { type: String, default: '' },
        paymentFailureReason: { type: String, default: '' },
        // গেটওয়ে যে পরিমাণ আসলে confirm করেছে (minor unit) এবং তা অর্ডারের দামের সাথে না মিললে true
        paidAmountMinor: { type: Number, default: null },
        amountMismatch: { type: Boolean, default: false },
    },
    {
        timestamps: true,
        versionKey: false,
    }
);

const Order = mongoose.model("Order", orderSchema);
export default Order;