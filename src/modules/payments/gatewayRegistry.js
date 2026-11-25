import AppError from "../../utils/AppError.js";
import { normalizeGatewayName } from "./constants.js";

const registry = new Map();

export const registerGateway = (gateway) => {
    if (!gateway || typeof gateway.name !== "string" || !gateway.name.trim()) {
        throw new Error("A payment gateway must have a name.");
    }
    if (typeof gateway.createSession !== "function") {
        throw new Error(`Payment gateway ${gateway.name} must implement createSession.`);
    }

    const name = normalizeGatewayName(gateway.name);
    const record = { ...gateway, name };
    registry.set(name, record);
    return record;
};

export const getGateway = (name) => {
    const key = normalizeGatewayName(name);
    const gateway = registry.get(key);
    if (!gateway) {
        throw new AppError(400, `Unknown payment gateway: ${key || "empty"}.`);
    }
    return gateway;
};

export const listRegisteredGateways = () => Array.from(registry.keys());

export const isGatewayRegistered = (name) => registry.has(normalizeGatewayName(name));

export const describeGateways = () =>
    listRegisteredGateways().map((name) => {
        const gateway = registry.get(name);
        const configured = typeof gateway.isConfigured === "function"
            ? Boolean(gateway.isConfigured())
            : true;
        return {
            name: gateway.name,
            label: gateway.label || gateway.name,
            configured,
        };
    });
