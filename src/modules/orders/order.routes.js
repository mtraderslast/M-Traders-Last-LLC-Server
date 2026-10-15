import express from "express";
import { verifyToken } from "../../middleware/authMiddleware.js";
import protectRoute from "../../middleware/protectRoute.js";
import { ROLES } from "../../utils/roles.js";
import { cancelOrder, initiateOrderAndPayment, getAllOrders, getMyOrders, getOrderDetails, getPaymentStatus, handlePaycoreWebhook, streamPaymentStatus, updateOrderStatus } from "./order.controller.js";

const router = express.Router();


router.post("/allpaypayz-webhook", express.raw({ type: "*/*" }), handlePaycoreWebhook);

router.use(express.json());

router.post('/initiate-payment', initiateOrderAndPayment);
router.get('/payment-status/:orderId', getPaymentStatus);
router.get('/payment-events/:orderId', streamPaymentStatus);

router.get("/my-orders", verifyToken, protectRoute(ROLES.USER), getMyOrders);
router.get("/order-details/:id", verifyToken, getOrderDetails);
router.get("/get-allOrders", verifyToken, protectRoute(ROLES.ADMIN), getAllOrders);
router.patch("/update-order/:id", verifyToken, protectRoute(ROLES.ADMIN), updateOrderStatus);
router.delete("/cancel-order/:id", verifyToken, protectRoute(ROLES.USER), cancelOrder);

export default router;