import Stripe from "stripe";
import mongoose from "mongoose";
import catchAsync from "../../utils/catchAsync.js";
import Order from "./order.model.js";
import Package from "../services-packages/package.model.js";
import AppError from "../../utils/AppError.js";
import { sendOrderConfirmationEmail } from "./sendOrderEmail.js";


export const createPendingOrder = catchAsync(async (req, res) => {
    const { orderId, packageId, title, price, image, userId, userName, userEmail } = req.body;

    const targetPackage = await Package.findById(packageId).lean();

    // Calculate Delivery Date
    const daysMatch = targetPackage?.deliveryTime?.match(/\d+/);
    const deliveryDays = daysMatch ? parseInt(daysMatch[0]) : 7;
    const calculatedDeliveryDate = new Date();
    calculatedDeliveryDate.setDate(calculatedDeliveryDate.getDate() + deliveryDays);

    // Validate ObjectIds safely
    const validUserId = (userId && mongoose.Types.ObjectId.isValid(userId))
        ? new mongoose.Types.ObjectId(userId)
        : null;

    const validPackageId = (packageId && mongoose.Types.ObjectId.isValid(packageId))
        ? new mongoose.Types.ObjectId(packageId)
        : packageId;

    // Create Order with default 'pending' status
    const newOrder = await Order.create({
        orderId,
        packageId: validPackageId,
        title: title || targetPackage?.title || "Service Package",
        image: image || targetPackage?.image?.[0] || "",
        category: targetPackage?.serviceCategory || "General",
        price: Number(price),
        deliveryTime: targetPackage?.deliveryTime || `${deliveryDays} Days`,
        deliveryDate: calculatedDeliveryDate,
        userId: validUserId,
        userName: userName || "Customer",
        userEmail: userEmail || "",
        status: "pending",
        paymentStatus: "pending"
    });

    return res.status(201).json({
        success: true,
        data: newOrder
    });
});

export const handleStripeWebhook = catchAsync(async (req, res) => {
    const sig = req.headers["stripe-signature"];
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    let event;

    try {
        event = stripe.webhooks.constructEvent(
            req.body, // This MUST be raw buffer
            sig,
            process.env.STRIPE_WEBHOOK_SECRET
        );
    } catch (err) {
        console.error("Webhook Signature Verification Failed:", err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
        const session = event.data.object;
        console.log("Stripe Session Completed for ID:", session.id);

        const { orderId } = session.metadata || {};
        const stripeSessionId = session.id;
        const paymentIntentId = session.payment_intent;
        const customerEmail = session.customer_details?.email || session.customer_email;
        const customerName = session.customer_details?.name;

        if (!orderId) {
            console.error("Missing orderId in session metadata");
            return res.status(400).send("Missing orderId");
        }

        // Find the pending order
        const existingOrder = await Order.findOne({ orderId });
        if (!existingOrder) {
            console.error(`Pending order not found with ID: ${orderId}`);
            return res.status(404).send("Order not found");
        }


        existingOrder.paymentStatus = "paid";
        existingOrder.status = "processing";
        existingOrder.stripeSessionId = stripeSessionId;
        existingOrder.paymentIntentId = String(paymentIntentId || "");

        if (!existingOrder.userEmail && customerEmail) {
            existingOrder.userEmail = customerEmail;
        }
        if (existingOrder.userName === "Customer" && customerName) {
            existingOrder.userName = customerName;
        }

        await existingOrder.save();
        console.log("Order successfully updated to PAID! DB ID:", existingOrder._id);
    }

    res.status(200).json({
        success: true,
        message: "Webhook event processed and order status updated successfully",
    });
});

export const getMyOrders = catchAsync(async (req, res) => {
    const userEmail = req.user.email; // userId এর পরিবর্তে userEmail
    const { page = 1, limit = 10 } = req.query;

    const pageNumber = Math.max(1, parseInt(page));
    const limitNumber = Math.max(1, parseInt(limit));
    const skip = (pageNumber - 1) * limitNumber;

    const [orders, totalOrders] = await Promise.all([
        Order.find({ userEmail })
            .select("_id title price status deliveryDate createdAt category image packageId")
            .populate("packageId", "name features type")
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limitNumber)
            .lean(),
        Order.countDocuments({ userEmail }),
    ]);

    return res.status(200).json({
        success: true,
        message: "Your orders fetched successfully",
        meta: {
            totalOrders,
            totalPages: Math.ceil(totalOrders / limitNumber),
            currentPage: pageNumber,
            limit: limitNumber,
        },
        data: orders,
    });
});

export const getOrderDetails = catchAsync(async (req, res) => {
    const { id } = req.params;
    const userEmail = req.user.email;
    const userRole = req.user.role;

    let query = { _id: id };

    if (userRole !== 'admin') {
        query.userEmail = userEmail;
    }

    const order = await Order.findOne(query)
        .populate("packageId", "name features type")
        .lean();

    if (!order) {
        throw new AppError(404, "Order not found or you don't have permission to view it");
    }

    return res.status(200).json({
        success: true,
        message: "Order details fetched successfully",
        data: order,
    });
});

export const getAllOrders = catchAsync(async (req, res) => {
    const { status, page = 1, limit = 10 } = req.query;

    const queryConditions = {};
    if (status) {
        queryConditions.status = status;
    }

    const pageNumber = Math.max(1, parseInt(page));
    const limitNumber = Math.max(1, parseInt(limit));
    const skip = (pageNumber - 1) * limitNumber;

    const [orders, totalOrders] = await Promise.all([
        Order.find(queryConditions)
            .select("_id title price userName userEmail status deliveryDate createdAt category packageId")
            .populate("packageId", "name features")
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limitNumber)
            .lean(),
        Order.countDocuments(queryConditions),
    ]);

    const totalPages = Math.ceil(totalOrders / limitNumber);

    return res.status(200).json({
        success: true,
        message: "All orders fetched successfully",
        meta: {
            totalOrders,
            totalPages,
            currentPage: pageNumber,
            limit: limitNumber,
        },
        data: orders,
    });
});

export const updateOrderStatus = catchAsync(async (req, res) => {
    const { id } = req.params;
    const { status, deliveryDate } = req.body;

    const order = await Order.findById(id);
    if (!order) {
        throw new AppError(404, "Order not found");
    }

    if (status) {
        order.status = status;
    }

    if (deliveryDate) {
        order.deliveryDate = new Date(deliveryDate);
    }

    await order.save();

    return res.status(200).json({
        success: true,
        message: "Order progress updated successfully",
        data: order,
    });
});

export const cancelOrder = catchAsync(async (req, res) => {
    const { id } = req.params;
    const userEmail = req.user.email;

    const order = await Order.findOne({ _id: id, userEmail });
    if (!order) {
        throw new AppError(404, "Order not found or you don't have permission to cancel it");
    }

    if (order.status === 'cancelled') {
        throw new AppError(400, "This order has already been cancelled");
    }

    const currentDate = new Date();
    const deliveryDate = new Date(order.deliveryDate);

    if (currentDate <= deliveryDate) {
        throw new AppError(
            400,
            "You cannot cancel the order before the delivery date has passed"
        );
    }

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

    const session = await stripe.checkout.sessions.retrieve(order.stripeSessionId);

    if (!session || !session.payment_intent) {
        throw new AppError(400, "No valid payment intent found for this order to issue a refund");
    }

    await stripe.refunds.create({
        payment_intent: session.payment_intent,
        reason: 'requested_by_customer'
    });

    order.status = 'cancelled';
    order.paymentStatus = 'refunded';

    await order.save();

    res.status(200).json({
        success: true,
        message: "Order cancelled and refunded successfully",
        data: order
    });
});