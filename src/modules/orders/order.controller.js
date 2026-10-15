import crypto from 'crypto';
import mongoose from 'mongoose';
import { fromNodeHeaders } from "better-auth/node";
import catchAsync from "../../utils/catchAsync.js";
import Order from "./order.model.js";
import Package from "../services-packages/package.model.js";
import AppError from "../../utils/AppError.js";
import {
    createHostedPayment,
    findPaymentByReference,
    parseGatewayError,
} from "./allpaypayz.service.js";
import { publish, subscribe, unsubscribe, sendEvent } from "./paymentEvents.js";


// Helpers
const getOptionalUser = async (req) => {
    try {
        const auth = req.app.get("auth");
        if (!auth) return null;
        const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
        return session?.user || null;
    } catch {
        return null;
    }
};

const isPublicUrl = (url) =>
    /^https:\/\//i.test(url) && !/localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(url);

// Allpaypayz স্ট্যাটাস 
const toOutcome = (gatewayStatus) => {
    if (gatewayStatus === 'succeeded') return 'paid';
    if (['failed', 'cancelled', 'expired'].includes(gatewayStatus)) return 'failed';
    return null;
};


const buildStatusPayload = (order) => ({
    orderId: order.orderId,
    title: order.title,
    price: order.price,
    paymentStatus: order.paymentStatus,
    status: order.status,
    failureReason: order.paymentFailureReason || '',
});


const applyOutcome = async (order, outcome, { gatewayId, eventId, amount, reason } = {}) => {
    if (outcome === 'paid') {
        if (order.paymentStatus === 'paid') return false; // ইতিমধ্যে প্রসেসড


        if (amount) {
            const expectedMinor = Math.round(Number(order.price) * 100);
            order.paidAmountMinor = Number(amount.amount_minor);
            if (Number(amount.amount_minor) !== expectedMinor || amount.currency !== 'USD') {
                order.amountMismatch = true;
                console.warn(
                    `⚠️ Amount mismatch for ${order.orderId}: gateway=${amount.amount_minor} ${amount.currency}, order=${expectedMinor} USD. Order still marked as paid.`
                );
            }
        }

        order.paymentStatus = 'paid';
        order.paymentFailureReason = '';
        if (order.status === 'pending' || order.status === 'cancelled') order.status = 'processing';
    } else if (outcome === 'failed') {
        if (order.paymentStatus === 'paid') return false; // পেইড অর্ডার ডাউনগ্রেড করা যাবে না
        order.paymentStatus = 'failed';
        order.status = 'cancelled';
        if (reason) order.paymentFailureReason = reason;
    } else {
        return false;
    }

    if (gatewayId) order.gatewayOrderId = gatewayId;
    if (eventId) order.paymentEventId = eventId;
    await order.save();

    publish(order.orderId, buildStatusPayload(order));
    return true;
};

const describeFailure = (payment) => {
    const reason = payment?.status_reason || '';
    const text = payment?.status_message || '';
    return [reason, text].filter(Boolean).join(': ');
};


const syncOrderWithGateway = async (order) => {
    if (order.paymentStatus !== 'pending') return;
    try {
        const payment = await findPaymentByReference(order.orderId);
        const outcome = toOutcome(payment?.status);
        if (outcome) {
            await applyOutcome(order, outcome, {
                gatewayId: payment?.id,
                amount: payment?.amount,
                reason: describeFailure(payment),
            });
        }
    } catch (err) {
        const { status, message } = parseGatewayError(err);
        console.warn(`Payment status lookup failed for ${order.orderId}:`, status, message);
    }
};

export const initiateOrderAndPayment = catchAsync(async (req, res) => {
    const { packageId, userName, userEmail } = req.body;

    if (!packageId || !mongoose.Types.ObjectId.isValid(packageId)) {
        throw new AppError(400, "A valid Package ID is required.");
    }

    // দাম সবসময় ডাটাবেজ থেকে — ক্লায়েন্টের পাঠানো দাম বিশ্বাসযোগ্য নয়
    const targetPackage = await Package.findById(packageId).lean();
    if (!targetPackage) {
        throw new AppError(404, "Package not found.");
    }

    const price = Number(targetPackage.price);
    if (!Number.isFinite(price) || price <= 0) {
        throw new AppError(400, "This package has an invalid price.");
    }


    const sessionUser = await getOptionalUser(req);
    const customerName = userName?.trim() || sessionUser?.name || "Customer";
    const customerEmail = sessionUser?.email || userEmail?.trim() || "";

    // ডেলিভারি তারিখ হিসাব
    const daysMatch = targetPackage.deliveryTime?.match(/\d+/);
    const deliveryDays = daysMatch ? parseInt(daysMatch[0]) : 7;
    const calculatedDeliveryDate = new Date();
    calculatedDeliveryDate.setDate(calculatedDeliveryDate.getDate() + deliveryDays);

    // merchant_reference টার্মিনালে ইউনিক হতে হবে
    const customOrderId = `ORD_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;

    const newOrder = await Order.create({
        orderId: customOrderId,
        packageId: targetPackage._id,
        title: targetPackage.title || "Service Package",
        image: targetPackage.image?.[0] || "",
        category: targetPackage.serviceCategory || "General",
        price,
        deliveryTime: targetPackage.deliveryTime || `${deliveryDays} Days`,
        deliveryDate: calculatedDeliveryDate,
        userId: sessionUser?.id || null,
        userName: customerName,
        userEmail: customerEmail,
        status: "pending",
        paymentStatus: "pending",
        paymentGateway: "allpaypayz"
    });

    const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
    const backendUrl = (process.env.BACKEND_URL || '').replace(/\/$/, '');

    const urls = {
        success: `${frontendUrl}/success?orderId=${customOrderId}`,
        error: `${frontendUrl}/canceled?orderId=${customOrderId}`,
        back: `${frontendUrl}/checkout/${targetPackage._id}`,
    };

    // Callback শুধু পাবলিক HTTPS URL হলেই পাঠানো যায় (localhost এ গেটওয়ে পৌঁছাতে পারে না)
    if (isPublicUrl(backendUrl)) {
        urls.callback = `${backendUrl}/api/order/allpaypayz-webhook`;
    } else {
        console.warn("⚠️ BACKEND_URL is not a public HTTPS URL. Webhook callback skipped (use ngrok in development). Payment status will be verified via polling on the success page.");
    }

    const payload = {
        merchant_reference: customOrderId,
        amount: {
            amount_minor: Math.round(price * 100), // $1 = 100 minor units
            currency: "USD"
        },
        description: `Order: ${newOrder.title}`.slice(0, 200),
        customer: {
            name: customerName,
            email: customerEmail || "customer@example.com"
        },
        // Allpaypayz টার্মিনালে চালু মেথডের নাম (সাপোর্ট: staging এ "card-eu")
        payment_method: process.env.ALLPAYPAYZ_PAYMENT_METHOD || "card-eu",
        urls
    };

    let gatewayData;
    try {
        const gatewayResponse = await createHostedPayment(payload);
        gatewayData = gatewayResponse?.data;
    } catch (apiError) {
        const { status, code, message, requestId } = parseGatewayError(apiError);
        console.error("--- Allpaypayz API Error ---");
        console.error("HTTP Status:", status, "| Code:", code, "| Request ID:", requestId);
        console.error("Message:", message);
        if (code === "cloudflare.challenge") {
            console.error("Blocked by Cloudflare challenge (403) on the gateway host. Ask Allpaypayz to allowlist this server's outbound IP (cf-ray: " + requestId + ").");
        } else {
            console.error("Body:", apiError.response?.data || apiError.message);
        }
        console.error("----------------------------");

        // গেটওয়ে ফেইল করলে অর্ডার পেন্ডিং ফেলে না রেখে ফেইলড মার্ক করা
        newOrder.paymentStatus = 'failed';
        newOrder.status = 'cancelled';
        await newOrder.save().catch(() => { });

        throw new AppError(502, message);
    }

    const paymentRedirectUrl = gatewayData?.redirect_url;

    if (paymentRedirectUrl) {
        newOrder.gatewayOrderId = gatewayData?.id || '';
        await newOrder.save();

        return res.status(200).json({
            success: true,
            url: paymentRedirectUrl,
            orderId: customOrderId
        });
    }

    // redirect_url নেই: পেমেন্ট সঙ্গে সঙ্গেই failed/cancelled হয়েছে (যেমন staging এ নাম "refused"/"cancelled")
    const immediateOutcome = toOutcome(gatewayData?.status);
    if (immediateOutcome === 'failed') {
        const reason = describeFailure(gatewayData) || gatewayData?.status;
        await applyOutcome(newOrder, 'failed', { gatewayId: gatewayData?.id, reason });
        console.warn(`Allpaypayz payment ${gatewayData?.id} ended immediately: ${reason}`);
        throw new AppError(
            402,
            gatewayData.status === 'cancelled'
                ? "The payment was cancelled."
                : `The payment was declined${reason ? ` (${reason})` : ""}. Please try another card.`
        );
    }

    console.error("Allpaypayz: redirect_url missing in response:", gatewayData);
    newOrder.paymentStatus = 'failed';
    newOrder.status = 'cancelled';
    await newOrder.save().catch(() => { });
    throw new AppError(502, "Payment page could not be created. Please try again.");
});

// ২. Allpaypayz Webhook হ্যান্ডলার (পেমেন্ট ভেরিফিকেশন)
export const handlePaycoreWebhook = catchAsync(async (req, res) => {
    const SIGNING_SECRET = process.env.ALLPAYPAYZ_SECRET_KEY;
    const TOLERANCE_SECONDS = 300;

    if (!SIGNING_SECRET) {
        console.error("ALLPAYPAYZ_SECRET_KEY is not set");
        return res.status(500).send("Webhook not configured");
    }

    if (!Buffer.isBuffer(req.body)) {
        return res.status(400).send("Invalid body");
    }

    const sig = (req.headers['callback-signature'] || '').trim();
    const m = sig.match(/^t=(\d+),v1=([0-9a-f]+)$/i);

    if (!m) {
        console.error("Missing or invalid callback-signature header");
        return res.status(400).send("Invalid signature header");
    }

    const [, ts, v1] = m;

    // HMAC-SHA256( "<t>." + rawBody, signKey )
    const expected = crypto
        .createHmac('sha256', SIGNING_SECRET)
        .update(`${ts}.`)
        .update(req.body)
        .digest('hex');

    const ok = v1.length === expected.length &&
        crypto.timingSafeEqual(Buffer.from(v1.toLowerCase()), Buffer.from(expected));

    if (!ok) {
        console.error("Webhook signature mismatch!");
        return res.status(400).send("Signature verification failed");
    }

    if (Math.abs(Date.now() / 1000 - Number(ts)) > TOLERANCE_SECONDS) {
        console.error("Expired webhook call");
        return res.status(400).send("Stale webhook request");
    }

    let payload;
    try {
        payload = JSON.parse(req.body.toString('utf8'));
    } catch {
        return res.status(400).send("Invalid JSON");
    }

    const event = payload?.event;
    const eventType = event?.type;
    const eventId = event?.id;
    const resource = event?.resource;

    console.log(`Received Allpaypayz Event: ${eventType} (ID: ${eventId})`);

    const outcome =
        ['payment.succeeded', 'order.completed'].includes(eventType) ? 'paid' :
        ['payment.failed', 'payment.cancelled', 'order.cancelled', 'order.expired'].includes(eventType) ? 'failed' :
        null;

    if (outcome) {
        const orderId = resource?.merchant_reference;
        if (!orderId) {
            return res.status(400).send("Missing merchant_reference");
        }

        const existingOrder = await Order.findOne({ orderId });
        if (!existingOrder) {
            return res.status(404).send("Order not found");
        }

        const changed = await applyOutcome(existingOrder, outcome, {
            gatewayId: resource?.id,
            eventId,
            amount: resource?.amount,
            reason: describeFailure(resource),
        });
        console.log(changed
            ? `Order ${orderId} marked as ${outcome.toUpperCase()}`
            : `Order ${orderId}: event ignored (already processed)`);
    }

    // সবসময় 2xx — না হলে গেটওয়ে রিট্রাই করতে থাকবে
    return res.status(200).json({ success: true });
});


export const getPaymentStatus = catchAsync(async (req, res) => {
    const { orderId } = req.params;

    const order = await Order.findOne({ orderId });
    if (!order) {
        throw new AppError(404, "Order not found");
    }

    await syncOrderWithGateway(order);

    return res.status(200).json({
        success: true,
        data: buildStatusPayload(order),
    });
});


export const streamPaymentStatus = catchAsync(async (req, res) => {
    const { orderId } = req.params;

    const order = await Order.findOne({ orderId });
    if (!order) {
        throw new AppError(404, "Order not found");
    }


    await syncOrderWithGateway(order);

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
