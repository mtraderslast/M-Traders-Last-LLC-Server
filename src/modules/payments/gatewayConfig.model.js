import mongoose from "mongoose";

const gatewayConfigSchema = new mongoose.Schema(
    {
        key: { type: String, required: true, unique: true, default: "default" },
        activeGateway: { type: String, required: true },
    },
    {
        timestamps: true,
        versionKey: false,
    }
);

const GatewayConfig = mongoose.model("GatewayConfig", gatewayConfigSchema);
export default GatewayConfig;
