import catchAsync from "../../utils/catchAsync.js";
import Order from "./order.model.js";
import AppError from "../../utils/AppError.js";
import { subscribe, unsubscribe, sendEvent } from "./paymentEvents.js";
import { buildStatusPayload, syncPendingPayment } from "../payments/paymentManager.js";


export const streamPaymentStatus = catchAsync(async (req, res) => {
    const { orderId } = req.params;

    const order = await Order.findOne({ orderId });
    if (!order) {
        throw new AppError(404, "Order not found");
    }


    await syncPendingPayment(order, { silent: true });

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no', // Nginx বাফারিং বন্ধ
    });

    // আগে সাবস্ক্রাইব, তারপর বর্তমান অবস্থা পড়া — যাতে মাঝখানে আসা webhook মিস না হয়
    subscribe(orderId, res);
    req.on('close', () => unsubscribe(orderId, res));

    const fresh = (await Order.findOne({ orderId })) || order;
    if (res.writableEnded) return; // ইতিমধ্যে webhook এসে চূড়ান্ত ফলাফল পাঠিয়ে দিয়েছে

    const current = buildStatusPayload(fresh);
    sendEvent(res, current);

    // ইতিমধ্যে চূড়ান্ত হয়ে থাকলে আর খোলা রাখার দরকার নেই
    if (current.paymentStatus !== 'pending') {
        unsubscribe(orderId, res);
        res.end();
    }
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
