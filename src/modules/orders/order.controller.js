import crypto, { randomUUID } from 'crypto';
import mongoose from 'mongoose';
import axios from 'axios';
import catchAsync from "../../utils/catchAsync.js";
import Order from "./order.model.js";
import Package from "../services-packages/package.model.js";
import AppError from "../../utils/AppError.js";

export const initiateOrderAndPayment = catchAsync(async (req, res) => {
    const { packageId, title, price, image, userId, userName, userEmail } = req.body;

    if (!packageId || !price) {
        throw new AppError(400, "Package ID and Price are required.");
    }

    const targetPackage = await Package.findById(packageId).lean();

    const daysMatch = targetPackage?.deliveryTime?.match(/\d+/);
    const deliveryDays = daysMatch ? parseInt(daysMatch[0]) : 7;
    const calculatedDeliveryDate = new Date();
    calculatedDeliveryDate.setDate(calculatedDeliveryDate.getDate() + deliveryDays);

    const validUserId = (userId && mongoose.Types.ObjectId.isValid(userId))
        ? new mongoose.Types.ObjectId(userId)
        : null;

    const validPackageId = (packageId && mongoose.Types.ObjectId.isValid(packageId))
        ? new mongoose.Types.ObjectId(packageId)
        : packageId;

    const customOrderId = `ORD_${Date.now()}`;

    const newOrder = await Order.create({
        orderId: customOrderId,
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
        paymentStatus: "pending",
        paymentGateway: "allpaypayz"
    });

    const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
    const backendUrl = (process.env.BACKEND_URL || 'http://localhost:5000').replace(/\/$/, '');

    const amountMinor = Math.round(Number(price) * 100);

    const paycorePayload = {
        merchant_reference: customOrderId,
        amount: {
            amount_minor: amountMinor,
            currency: "USD"
        },
        description: `Order: ${title || 'Service Package'}`,
        customer: {
            name: userName || "Customer",
            email: userEmail || "customer@example.com"
        },
        payment_method: "card",
        urls: {
            success: `${frontendUrl}/success?orderId=${customOrderId}`,
            error: `${frontendUrl}/canceled`,
            callback: `${backendUrl}/api/order/allpaypayz-webhook`
        }
    };

    try {
        const response = await axios.post(
            'https://api.paycore.cloud/v4/payments/redirect',
            paycorePayload,
            {
                headers: {
                    'Authorization': `Bearer ${process.env.ALLPAYPAYZ_API_KEY}`,
                    'Content-Type': 'application/json',
                    'Idempotency-Key': randomUUID(),
                }
            }
        );

        const gatewayData = response.data;
        const paymentRedirectUrl = gatewayData.redirect_url || gatewayData.url || gatewayData?.data?.redirect_url;

        if (!paymentRedirectUrl) {
            console.error("Payment Gateway did not return a valid redirect URL:", gatewayData);
            throw new AppError(500, "Failed to retrieve payment redirect URL from gateway.");
        }

        return res.status(200).json({
            success: true,
            url: paymentRedirectUrl,
            orderId: customOrderId
        });

    } catch (apiError) {
        console.error("Allpaypayz API Error:", apiError.response?.data || apiError.message);
        throw new AppError(
            apiError.response?.status || 500,
            apiError.response?.data?.message || "Failed to initiate payment gateway."
        );
    }
});

export const handlePaycoreWebhook = catchAsync(async (req, res) => {
    const SIGNING_SECRET = process.env.ALLPAYPAYZ_SECRET_KEY;
    const TOLERANCE_SECONDS = 300;

    const sig = req.headers['callback-signature'] || '';
    const m = sig.match(/^t=(\d+),v1=([0-9a-f]+)/);

    if (!m) {
        console.error("Missing or invalid callback-signature header");
        return res.status(400).send("Invalid signature header");
    }

    const [, ts, v1] = m;

    const expected = crypto
        .createHmac('sha256', SIGNING_SECRET)
        .update(`${ts}.`)
        .update(req.body) // raw buffer
        .digest('hex');

    const ok = v1.length === expected.length &&
        crypto.timingSafeEqual(Buffer.from(v1), Buffer.from(expected));

    if (!ok) {
        console.error("Webhook signature mismatch!");
        return res.status(400).send("Signature verification failed");
    }

    if (Math.abs(Date.now() / 1000 - Number(ts)) > TOLERANCE_SECONDS) {
        console.error("Expired webhook call");
        return res.status(400).send("Stale webhook request");
    }

    const payload = JSON.parse(req.body.toString('utf8'));
    const eventType = payload?.event?.type;
    const eventId = payload?.event?.id;
    const resource = payload?.event?.resource;

    console.log(`Received Paycore Event: ${eventType} (ID: ${eventId})`);

    if (eventType === 'payment.succeeded' || eventType === 'order.completed') {
        const orderId = resource?.merchant_reference;

        if (!orderId) {
            return res.status(400).send("Missing merchant_reference");
        }

        const existingOrder = await Order.findOne({ orderId });
        if (!existingOrder) {
            return res.status(404).send("Order not found");
        }

        if (existingOrder.paymentEventId === eventId && existingOrder.paymentStatus === 'paid') {
            return res.status(200).json({ success: true, message: "Already processed" });
        }

        existingOrder.paymentStatus = 'paid';
        existingOrder.status = 'processing';
        existingOrder.gatewayOrderId = resource?.id || '';
        existingOrder.paymentEventId = eventId || '';

        await existingOrder.save();
        console.log(`Order ${orderId} successfully marked as PAID!`);
    }

    return res.status(200).json({ success: true });
});

export const cancelOrder = catchAsync(async (req, res) => {
    const { id } = req.params;
    const userEmail = req.user.email;

    const order = await Order.findOne({ _id: id, userEmail });
    if (!order) {
        throw new AppError(404, "Order not found or unauthorized");
    }

    if (order.status === 'cancelled') {
        throw new AppError(400, "This order has already been cancelled");
    }

    const currentDate = new Date();
    const deliveryDate = new Date(order.deliveryDate);

    if (currentDate <= deliveryDate) {
        throw new AppError(400, "You cannot cancel the order before delivery date passes");
    }

    order.status = 'cancelled';
    order.paymentStatus = 'failed';
    await order.save();

    return res.status(200).json({
        success: true,
        message: "Order cancelled successfully",
        data: order
    });
});

export const getMyOrders = catchAsync(async (req, res) => {
    const userEmail = req.user.email;
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

    const order = await Order.findOne(query).populate("packageId", "name features type").lean();
    if (!order) {
        throw new AppError(404, "Order not found");
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
    if (status) queryConditions.status = status;

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

    return res.status(200).json({
        success: true,
        message: "All orders fetched successfully",
        meta: {
            totalOrders,
            totalPages: Math.ceil(totalOrders / limitNumber),
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

    if (status) order.status = status;
    if (deliveryDate) order.deliveryDate = new Date(deliveryDate);

    await order.save();

    return res.status(200).json({
        success: true,
        message: "Order updated successfully",
        data: order,
    });
});